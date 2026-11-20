"""Emir yürütme: PaperBroker (sanal para) ve LiveBroker (gerçek borsa).
İkisi de aynı arayüzü kullanır; durum (açık pozisyonlar) JSON dosyasında saklanır,
bot yeniden başlatılınca pozisyonlar kaybolmaz."""
import json
import logging
import os
from typing import Dict, Optional, Tuple

from .positions import Position

log = logging.getLogger("flowbot.broker")


class BaseBroker:
    mode = "base"

    def __init__(self, cfg: dict, store=None, notifier=None):
        self.cfg = cfg
        self.fee = cfg["fees"]["taker_pct"] / 100
        self.slip = cfg["fees"]["slippage_pct"] / 100
        self.store, self.notifier = store, notifier
        self.state_path = cfg["storage"]["state_path"].replace(".json", f"_{self.mode}.json")
        self.positions: Dict[str, Position] = {}
        self.cash = float(cfg["risk"]["starting_equity"])
        self.last_exit: Dict[str, float] = {}
        self.day_key: str = ""
        self.day_start_equity: float = 0.0
        self.closed_pnl: float = 0.0
        self.load_state()

    # ---------------------------------------------------------------- alt sınıfın uygulayacağı
    def _buy(self, symbol: str, qty: float, ref_price: float) -> Tuple[float, float, float]:
        raise NotImplementedError

    def _sell(self, symbol: str, qty: float, ref_price: float) -> Tuple[float, float, float]:
        raise NotImplementedError

    # ---------------------------------------------------------------- genel
    def equity(self, prices: Dict[str, float]) -> float:
        return self.cash + sum(p.qty * prices.get(s, p.entry) for s, p in self.positions.items())

    def open(self, symbol, qty, ref_price, stop, tp, atr, now, score=0.0) -> Optional[Position]:
        px, filled, fee = self._buy(symbol, qty, ref_price)
        if filled <= 0:
            return None
        pos = Position(symbol, px, filled, filled, stop, stop, tp, atr, now, px, fees=fee, score=score)
        self.positions[symbol] = pos
        self._record(symbol, "BUY", filled, px, fee, 0.0, f"skor {score:.0f}")
        self.save_state()
        return pos

    def close(self, symbol: str, fraction: float, ref_price: float, reason: str, now: float) -> float:
        pos = self.positions.get(symbol)
        if not pos:
            return 0.0
        qty = pos.qty if fraction >= 1 else pos.qty * fraction
        px, filled, fee = self._sell(symbol, qty, ref_price)
        if filled <= 0:
            return 0.0
        entry_fee_share = pos.fees * (filled / pos.initial_qty)
        pnl = (px - pos.entry) * filled - fee - entry_fee_share
        pos.qty -= filled
        pos.realized_pnl += pnl
        self.closed_pnl += pnl
        self._record(symbol, "SELL", filled, px, fee, pnl, reason)
        if fraction >= 1 or pos.qty * px < 1:
            del self.positions[symbol]
            self.last_exit[symbol] = now
        self.save_state()
        return pnl

    def _record(self, symbol, side, qty, px, fee, pnl, reason):
        eq = self.equity({symbol: px})
        if self.store:
            self.store.log_trade(self.mode, symbol, side, qty, px, fee, pnl, reason, eq)
        if self.notifier:
            icon = "🟢" if side == "BUY" else ("✅" if pnl > 0 else "🔴")
            extra = f" PnL ${pnl:+.2f}" if side == "SELL" else ""
            self.notifier.send(f"{icon} [{self.mode}] {side} {symbol} {qty:.6g} @ {px:.6g}{extra} ({reason}) | özkaynak ${eq:,.2f}")

    def roll_day(self, day: str, equity: float) -> None:
        if day != self.day_key:
            self.day_key, self.day_start_equity = day, equity
            self.save_state()

    # ---------------------------------------------------------------- kalıcılık
    def save_state(self) -> None:
        os.makedirs(os.path.dirname(self.state_path) or ".", exist_ok=True)
        data = {
            "cash": self.cash, "positions": {s: p.to_dict() for s, p in self.positions.items()},
            "last_exit": self.last_exit, "day_key": self.day_key,
            "day_start_equity": self.day_start_equity, "closed_pnl": self.closed_pnl,
        }
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.state_path)

    def load_state(self) -> None:
        if not os.path.exists(self.state_path):
            return
        with open(self.state_path, encoding="utf-8") as f:
            d = json.load(f)
        self.cash = d.get("cash", self.cash)
        self.positions = {s: Position(**p) for s, p in d.get("positions", {}).items()}
        self.last_exit = d.get("last_exit", {})
        self.day_key = d.get("day_key", "")
        self.day_start_equity = d.get("day_start_equity", 0.0)
        self.closed_pnl = d.get("closed_pnl", 0.0)
        log.info("Durum yüklendi: %d açık pozisyon, nakit $%.2f", len(self.positions), self.cash)


class PaperBroker(BaseBroker):
    """Sanal para ile gerçekçi simülasyon (komisyon + slipaj dahil)."""
    mode = "paper"

    def __init__(self, cfg, store=None, notifier=None, persist: bool = True):
        self.persist = persist
        super().__init__(cfg, store, notifier)

    def save_state(self):
        if self.persist:
            super().save_state()

    def load_state(self):
        if self.persist:
            super().load_state()

    def _buy(self, symbol, qty, ref_price):
        px = ref_price * (1 + self.slip)
        cost = px * qty
        fee = cost * self.fee
        if cost + fee > self.cash:
            qty = self.cash / (px * (1 + self.fee))
            cost, fee = px * qty, px * qty * self.fee
        self.cash -= cost + fee
        return px, qty, fee

    def _sell(self, symbol, qty, ref_price):
        px = ref_price * (1 - self.slip)
        proceeds = px * qty
        fee = proceeds * self.fee
        self.cash += proceeds - fee
        return px, qty, fee


class LiveBroker(BaseBroker):
    """GERÇEK PARA. Piyasa emri gönderir. Stop'lar bot tarafından yönetilir (yazılımsal stop):
    bot kapalıyken stop çalışmaz! Bu yüzden botu sunucuda (VPS) 7/24 çalıştırın."""
    mode = "live"

    def __init__(self, cfg, exchange, store=None, notifier=None):
        self.ex = exchange
        super().__init__(cfg, store, notifier)
        self.quote = cfg["universe"]["quote"]
        self.sync_cash()

    def sync_cash(self):
        self.cash = self.ex.free_balance(self.quote)

    @staticmethod
    def _fill(order: dict, ref_price: float) -> Tuple[float, float]:
        filled = float(order.get("filled") or order.get("amount") or 0)
        avg = order.get("average")
        if not avg and order.get("cost") and filled:
            avg = float(order["cost"]) / filled
        return float(avg or ref_price), filled

    def _buy(self, symbol, qty, ref_price):
        qty = self.ex.amount_precision(symbol, qty)
        order = self.ex.market_buy(symbol, qty)
        if order.get("status") != "closed" and order.get("id"):
            order = self.ex.fetch_order(order["id"], symbol)
        px, filled = self._fill(order, ref_price)
        fee = px * filled * self.fee
        # Komisyon base coin'den kesilmiş olabilir -> gerçek bakiyeyi kullan
        base = self.ex.markets[symbol]["base"]
        held = self.ex.free_balance(base)
        filled = min(filled, held) if held > 0 else filled
        self.sync_cash()
        return px, filled, fee

    def _sell(self, symbol, qty, ref_price):
        base = self.ex.markets[symbol]["base"]
        qty = self.ex.amount_precision(symbol, min(qty, self.ex.free_balance(base)))
        if qty <= 0:
            log.error("%s satılacak bakiye yok", symbol)
            return ref_price, 0.0, 0.0
        order = self.ex.market_sell(symbol, qty)
        if order.get("status") != "closed" and order.get("id"):
            order = self.ex.fetch_order(order["id"], symbol)
        px, filled = self._fill(order, ref_price)
        self.sync_cash()
        return px, filled, px * filled * self.fee
