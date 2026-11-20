"""Pozisyon büyüklüğü ve hesap koruma kuralları."""
import datetime as dt
from typing import Optional, Tuple


class RiskManager:
    def __init__(self, cfg: dict):
        self.r = cfg["risk"]
        self.fee = cfg["fees"]["taker_pct"] / 100

    def size(self, equity: float, cash: float, entry: float, stop: float,
             min_amount: float = 0, min_cost: float = 0) -> Tuple[float, str]:
        """Sabit-risk pozisyon büyüklüğü: stop olursa sermayenin risk_per_trade_pct'i kadar kayıp."""
        per_unit_risk = entry - stop + entry * self.fee * 2
        if per_unit_risk <= 0:
            return 0.0, "geçersiz stop"
        risk_usd = equity * self.r["risk_per_trade_pct"] / 100
        qty = risk_usd / per_unit_risk
        max_notional = min(equity * self.r["max_position_pct"] / 100, cash * 0.98)
        qty = min(qty, max_notional / entry)
        if qty <= 0:
            return 0.0, "nakit yok"
        if qty < min_amount or qty * entry < max(min_cost, 5):
            return 0.0, f"min emir altında (${qty*entry:.2f})"
        return qty, ""

    def can_open(self, n_open: int, symbol: str, has_position: bool, last_exit_ts: Optional[float],
                 now: float, equity: float, day_start_equity: float) -> Tuple[bool, str]:
        if has_position:
            return False, "zaten pozisyonda"
        if n_open >= self.r["max_open_positions"]:
            return False, "max pozisyon sayısı"
        if last_exit_ts and now - last_exit_ts < self.r["symbol_cooldown_minutes"] * 60:
            return False, "bekleme süresi (cooldown)"
        if day_start_equity and equity < day_start_equity * (1 - self.r["max_daily_loss_pct"] / 100):
            return False, "günlük kayıp limiti doldu"
        return True, ""

    @staticmethod
    def day_key(ts: float) -> str:
        return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")
