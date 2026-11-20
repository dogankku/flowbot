"""Ana döngü: evreni tara -> skorla -> (paper/live) pozisyon aç/yönet."""
import logging
import time
from typing import List

import ccxt

from . import detectors as D
from .indicators import compute_features, trades_to_df
from .positions import manage, plan_levels
from .risk import RiskManager
from .scorer import Signal, apply_filters, cheap_components, combine

log = logging.getLogger("flowbot.engine")


class Engine:
    def __init__(self, cfg: dict, exchange, broker=None, store=None, notifier=None):
        self.cfg, self.ex, self.broker = cfg, exchange, broker
        self.store, self.notifier = store, notifier
        self.risk = RiskManager(cfg)
        self.universe: List[str] = []
        self._universe_ts = 0.0
        self._last_alert: dict = {}

    # ---------------------------------------------------------------- evren
    def refresh_universe(self, force=False):
        if force or time.time() - self._universe_ts > self.cfg["universe"]["refresh_minutes"] * 60:
            self.universe = self.ex.top_symbols()
            self._universe_ts = time.time()
            log.info("Evren güncellendi: %d parite", len(self.universe))

    # ---------------------------------------------------------------- tarama
    def scan(self) -> List[Signal]:
        cfg, d = self.cfg, self.cfg["detectors"]
        candidates = []
        for sym in self.universe:
            try:
                df = self.ex.ohlcv(sym, cfg["timeframe"], cfg["history_bars"])
                if len(df) < d["volume_spike"]["lookback"] + 5:
                    continue
                feats = compute_features(df, cfg)
                row = feats.iloc[-1]
                comps = cheap_components(row, cfg)
                sig = Signal(sym, combine(comps, cfg), float(row["close"]), float(row["atr"]), comps)
                candidates.append((sig, row))
            except ccxt.BaseError as e:
                log.warning("%s OHLCV hatası: %s", sym, e)

        # En güçlü K adayı derin analize al (işlemler + emir defteri)
        candidates.sort(key=lambda x: x[0].score, reverse=True)
        results = []
        for i, (sig, row) in enumerate(candidates):
            spread = None
            if i < d["deep_check_top_k"] and sig.score > 15:
                try:
                    tdf = trades_to_df(self.ex.trades(sig.symbol, d["whale_trades"]["trades_limit"]))
                    ob = self.ex.order_book(sig.symbol, d["orderbook"]["limit"])
                    obc = D.orderbook(ob, d["orderbook"])
                    sig.components += [D.whale_trades(tdf, d["whale_trades"]), D.taker_flow(tdf, d["taker_flow"]), obc]
                    sig.score = combine(sig.components, cfg)
                    sig.deep = True
                    spread = obc.data.get("spread_pct")
                except ccxt.BaseError as e:
                    log.warning("%s derin analiz hatası: %s", sig.symbol, e)
            apply_filters(sig, row, cfg, spread)
            results.append(sig)
        results.sort(key=lambda s: s.score, reverse=True)
        return results

    # ---------------------------------------------------------------- pozisyon yönetimi
    def manage_positions(self, now: float):
        if not self.broker or not self.broker.positions:
            return
        syms = list(self.broker.positions)
        tickers = self.ex.tickers(syms)
        for sym in syms:
            t = tickers.get(sym) or {}
            last = t.get("last") or t.get("close")
            if not last:
                continue
            pos = self.broker.positions[sym]
            # güncel ATR (iz süren stop için)
            atr_now = pos.atr
            try:
                df = self.ex.ohlcv(sym, self.cfg["timeframe"], self.cfg["history_bars"])
                atr_now = float(compute_features(df, self.cfg)["atr"].iloc[-1])
            except Exception:  # noqa: BLE001 - ATR alınamazsa eskisiyle devam
                pass
            for kind, px, reason in manage(pos, last, last, last, last, atr_now, now, self.cfg["risk"]):
                if sym not in self.broker.positions:
                    break
                frac = self.cfg["risk"]["partial_tp_fraction"] if kind == "partial" else 1.0
                self.broker.close(sym, frac, last, reason, now)

    def try_open(self, sig: Signal, now: float, equity: float):
        b, cfg = self.broker, self.cfg
        if sig.score < cfg["filters"]["min_score"] or not sig.actionable:
            return
        ok, why = self.risk.can_open(len(b.positions), sig.symbol, sig.symbol in b.positions,
                                     b.last_exit.get(sig.symbol), now, equity, b.day_start_equity)
        if not ok:
            log.info("%s açılmadı: %s", sig.symbol, why)
            return
        stop, tp = plan_levels(sig.price, sig.atr, cfg["risk"])
        lim = self.ex.market_limits(sig.symbol)
        qty, why = self.risk.size(equity, b.cash, sig.price, stop, lim["min_amount"], lim["min_cost"])
        if qty <= 0:
            log.info("%s açılmadı: %s", sig.symbol, why)
            return
        b.open(sig.symbol, qty, sig.price, stop, tp, sig.atr, now, sig.score)

    # ---------------------------------------------------------------- döngü
    def step(self, trade: bool):
        now = time.time()
        self.refresh_universe()
        if trade:
            self.manage_positions(now)
        signals = self.scan()
        min_score = self.cfg["filters"]["min_score"]

        top = [s for s in signals if s.score >= min_score * 0.75][:10]
        log.info("Tarama bitti: %d parite, %d güçlü aday", len(signals), len(top))
        for s in top:
            print(s.summary(), "\n")
            if self.store:
                self.store.log_signal(s)
            if s.score >= min_score and s.actionable and self.notifier:
                if now - self._last_alert.get(s.symbol, 0) > 3600:
                    self.notifier.send("🚨 Para akışı sinyali\n" + s.summary())
                    self._last_alert[s.symbol] = now

        if trade and self.broker:
            prices = {s.symbol: s.price for s in signals}
            equity = self.broker.equity(prices)
            self.broker.roll_day(self.risk.day_key(now), equity)
            for s in signals:
                self.try_open(s, now, equity)
            log.info("Özkaynak $%.2f | nakit $%.2f | açık: %s", self.broker.equity(prices),
                     self.broker.cash, ", ".join(self.broker.positions) or "-")
        return signals

    def run(self, trade: bool):
        self.refresh_universe(force=True)
        while True:
            t0 = time.time()
            try:
                self.step(trade)
            except ccxt.BaseError as e:
                log.error("Borsa hatası: %s", e)
            except KeyboardInterrupt:
                raise
            except Exception:  # noqa: BLE001
                log.exception("Beklenmeyen hata, döngü devam ediyor")
            time.sleep(max(5, self.cfg["loop_seconds"] - (time.time() - t0)))
