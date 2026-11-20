"""ccxt üzerinden borsa erişimi (veri + emir)."""
import logging
import time
from typing import List, Optional

import ccxt
import pandas as pd

log = logging.getLogger("flowbot.exchange")

LEVERAGED_SUFFIXES = ("UP", "DOWN", "BULL", "BEAR", "3L", "3S", "5L", "5S")


class Exchange:
    def __init__(self, cfg: dict, authenticated: bool = False):
        ec = cfg["exchange"]
        klass = getattr(ccxt, ec["name"])
        params = {"enableRateLimit": True, "options": {"defaultType": ec.get("market_type", "spot")}}
        if authenticated:
            if not ec.get("api_key") or not ec.get("api_secret"):
                raise RuntimeError("Canlı mod için .env içinde EXCHANGE_API_KEY / EXCHANGE_API_SECRET gerekli")
            params.update(apiKey=ec["api_key"], secret=ec["api_secret"])
            if ec.get("password"):
                params["password"] = ec["password"]
        self.x = klass(params)
        if ec.get("sandbox"):
            self.x.set_sandbox_mode(True)
        self.cfg = cfg
        self.markets = self._retry(self.x.load_markets)

    # ---------------------------------------------------------------- yardımcılar
    def _retry(self, fn, *a, tries: int = 3, **kw):
        for i in range(tries):
            try:
                return fn(*a, **kw)
            except (ccxt.NetworkError, ccxt.ExchangeNotAvailable, ccxt.RequestTimeout) as e:
                if i == tries - 1:
                    raise
                wait = 2 ** i
                log.warning("Ağ hatası (%s), %ss sonra tekrar: %s", fn.__name__, wait, e)
                time.sleep(wait)

    def tf_ms(self, tf: str) -> int:
        return self.x.parse_timeframe(tf) * 1000

    # ---------------------------------------------------------------- evren
    def top_symbols(self) -> List[str]:
        u = self.cfg["universe"]
        tickers = self._retry(self.x.fetch_tickers)
        rows = []
        for sym, t in tickers.items():
            m = self.markets.get(sym)
            if not m or not m.get("active", True) or not m.get("spot", True):
                continue
            if m.get("quote") != u["quote"]:
                continue
            base = m.get("base", "")
            if base in u.get("exclude_bases", []) or base.endswith(LEVERAGED_SUFFIXES):
                continue
            qv = t.get("quoteVolume") or 0
            if qv < u["min_quote_volume_24h"]:
                continue
            rows.append((sym, qv))
        rows.sort(key=lambda r: r[1], reverse=True)
        return [s for s, _ in rows[: u["top_n"]]]

    # ---------------------------------------------------------------- veri
    def ohlcv(self, symbol: str, timeframe: str, limit: int, drop_open_candle: bool = True) -> pd.DataFrame:
        raw = self._retry(self.x.fetch_ohlcv, symbol, timeframe, limit=limit + 1)
        df = pd.DataFrame(raw, columns=["ts", "open", "high", "low", "close", "volume"])
        if drop_open_candle and len(df):
            now = self.x.milliseconds()
            if df["ts"].iloc[-1] + self.tf_ms(timeframe) > now:
                df = df.iloc[:-1]  # henüz kapanmamış mumu at
        df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        return df.set_index("time")

    def ohlcv_history(self, symbol: str, timeframe: str, since_ms: int, until_ms: Optional[int] = None) -> pd.DataFrame:
        """Backtest için sayfalı geçmiş veri indirme."""
        until_ms = until_ms or self.x.milliseconds()
        out, cursor, step = [], since_ms, self.tf_ms(timeframe)
        while cursor < until_ms:
            batch = self._retry(self.x.fetch_ohlcv, symbol, timeframe, since=cursor, limit=1000)
            if not batch:
                break
            out.extend(batch)
            nxt = batch[-1][0] + step
            if nxt <= cursor:
                break
            cursor = nxt
        df = pd.DataFrame(out, columns=["ts", "open", "high", "low", "close", "volume"]).drop_duplicates("ts")
        df = df[df["ts"] < until_ms]
        df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        return df.set_index("time")

    def trades(self, symbol: str, limit: int = 1000) -> list:
        return self._retry(self.x.fetch_trades, symbol, limit=limit)

    def order_book(self, symbol: str, limit: int = 100) -> dict:
        return self._retry(self.x.fetch_order_book, symbol, limit=limit)

    def tickers(self, symbols: List[str]) -> dict:
        if not symbols:
            return {}
        try:
            return self._retry(self.x.fetch_tickers, symbols)
        except ccxt.BaseError:
            return {s: self._retry(self.x.fetch_ticker, s) for s in symbols}

    # ---------------------------------------------------------------- emir (canlı)
    def market_limits(self, symbol: str) -> dict:
        m = self.markets[symbol]
        lim = m.get("limits", {})
        return {
            "min_amount": (lim.get("amount") or {}).get("min") or 0,
            "min_cost": (lim.get("cost") or {}).get("min") or 0,
        }

    def amount_precision(self, symbol: str, amount: float) -> float:
        return float(self.x.amount_to_precision(symbol, amount))

    def free_balance(self, asset: str) -> float:
        bal = self._retry(self.x.fetch_balance)
        return float((bal.get("free") or {}).get(asset) or 0)

    def market_buy(self, symbol: str, amount: float) -> dict:
        return self.x.create_market_buy_order(symbol, amount)  # emirlerde otomatik tekrar YOK (çift emir riski)

    def market_sell(self, symbol: str, amount: float) -> dict:
        return self.x.create_market_sell_order(symbol, amount)

    def fetch_order(self, order_id: str, symbol: str) -> dict:
        return self._retry(self.x.fetch_order, order_id, symbol)
