"""Bileşenleri tek bir 0-100 skora çevirir ve güvenlik filtrelerini uygular."""
from dataclasses import dataclass, field
from typing import List, Optional

import pandas as pd

from . import detectors as D


@dataclass
class Signal:
    symbol: str
    score: float
    price: float
    atr: float
    components: List[D.Component] = field(default_factory=list)
    blocked_by: List[str] = field(default_factory=list)
    deep: bool = False

    @property
    def actionable(self) -> bool:
        return not self.blocked_by

    def summary(self) -> str:
        lines = [f"{self.symbol}  skor={self.score:.0f}/100  fiyat={self.price:.6g}"]
        for c in self.components:
            arrow = {1: "▲", -1: "▼", 0: "•"}[c.direction]
            lines.append(f"  {arrow} {c.name:<13} {c.score:4.2f}  {c.detail}")
        if self.blocked_by:
            lines.append("  ⛔ engellendi: " + "; ".join(self.blocked_by))
        return "\n".join(lines)


def combine(components: List[D.Component], cfg: dict) -> float:
    """Long-only skor: alış yönlü bileşenler ekler, satış yönlü bileşenler yarı ağırlıkla düşer.
    Sadece hesaplanan bileşenlerin ağırlıklarına göre normalize edilir."""
    weights = cfg["detectors"]
    total_w, s = 0.0, 0.0
    for c in components:
        w = weights[c.name]["weight"]
        total_w += w
        if c.direction > 0:
            s += w * c.score
        elif c.direction < 0:
            s -= 0.5 * w * c.score
    if total_w == 0:
        return 0.0
    return max(0.0, min(100.0, 100 * s / total_w))


def cheap_components(row: pd.Series, cfg: dict) -> List[D.Component]:
    d = cfg["detectors"]
    return [
        D.volume_spike(row, d["volume_spike"]),
        D.money_flow(row, d["money_flow"]),
        D.breakout(row, d["breakout"]),
    ]


def apply_filters(sig: Signal, row: pd.Series, cfg: dict, spread_pct: Optional[float] = None) -> None:
    f = cfg["filters"]
    if row.get("rsi", 50) > f["max_rsi"]:
        sig.blocked_by.append(f"RSI {row['rsi']:.0f} > {f['max_rsi']}")
    ext = row.get("vwap_ext_atr", 0)
    if pd.notna(ext) and ext > f["max_vwap_extension_atr"]:
        sig.blocked_by.append(f"VWAP'tan {ext:.1f} ATR uzak (kovalama)")
    if spread_pct is not None and spread_pct > f["max_spread_pct"]:
        sig.blocked_by.append(f"spread %{spread_pct:.2f} çok geniş")
    if not pd.notna(row.get("atr")) or row["atr"] <= 0:
        sig.blocked_by.append("ATR yok")
