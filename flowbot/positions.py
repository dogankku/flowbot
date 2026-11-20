"""Pozisyon modeli ve çıkış kuralları (canlı, paper ve backtest aynı kodu kullanır)."""
from dataclasses import dataclass, asdict
from typing import List, Tuple


@dataclass
class Position:
    symbol: str
    entry: float
    qty: float
    initial_qty: float
    stop: float
    initial_stop: float
    take_profit: float
    atr: float
    opened_at: float          # epoch saniye
    highest: float
    tp_hit: bool = False
    realized_pnl: float = 0.0
    fees: float = 0.0
    score: float = 0.0

    @property
    def r(self) -> float:
        """1R = giriş ile ilk stop arası mesafe."""
        return max(self.entry - self.initial_stop, 1e-12)

    def to_dict(self) -> dict:
        return asdict(self)


def plan_levels(entry: float, atr: float, risk: dict) -> Tuple[float, float]:
    stop = entry - risk["stop_atr_mult"] * atr
    tp = entry + risk["take_profit_r"] * (entry - stop)
    return stop, tp


def manage(pos: Position, o: float, h: float, l: float, c: float, atr_now: float, now: float,
           risk: dict) -> List[Tuple[str, float, str]]:
    """Bir bar / fiyat güncellemesi için çıkış aksiyonlarını döndürür.
    Dönüş: [("partial"|"all", fiyat, sebep), ...]  — miktarı çağıran taraf uygular.
    Not: muhafazakâr sıra — önce stop kontrol edilir."""
    # 1) Stop (gap varsa açılış fiyatından çıkılır)
    if l <= pos.stop:
        reason = "trailing_stop" if pos.stop > pos.initial_stop else "stop_loss"
        if pos.stop >= pos.entry and not pos.tp_hit and reason == "trailing_stop":
            reason = "breakeven_stop"
        return [("all", min(pos.stop, o), reason)]

    actions: List[Tuple[str, float, str]] = []

    # 2) Kısmi kâr al
    if not pos.tp_hit and h >= pos.take_profit:
        actions.append(("partial", max(pos.take_profit, o), "take_profit"))
        pos.tp_hit = True

    # 3) Stop'ları güncelle (bir sonraki bar için geçerli)
    pos.highest = max(pos.highest, h)
    if pos.highest - pos.entry >= risk["breakeven_at_r"] * pos.r:
        pos.stop = max(pos.stop, pos.entry * 1.002)  # komisyonu karşılayacak kadar üstü
    if pos.tp_hit and atr_now and atr_now > 0:
        pos.stop = max(pos.stop, pos.highest - risk["trailing_atr_mult"] * atr_now)

    # 4) Zaman stopu
    if now - pos.opened_at >= risk["max_hold_hours"] * 3600:
        actions.append(("all", c, "time_exit"))
    return actions
