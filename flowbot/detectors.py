"""Para akışı dedektörleri.

Her dedektör bir `Component` döndürür:
  score     : 0..1 sinyal gücü
  direction : +1 (alıcı/boğa), -1 (satıcı/ayı), 0 (nötr)
  detail    : insanın okuyacağı açıklama

Ucuz dedektörler (sadece OHLCV):     volume_spike, money_flow, breakout
Pahalı dedektörler (ek API çağrısı): whale_trades, taker_flow, orderbook
"""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class Component:
    name: str
    score: float
    direction: int
    detail: str
    data: dict = field(default_factory=dict)


def _clip01(x: float) -> float:
    if x is None or not np.isfinite(x):
        return 0.0
    return float(min(1.0, max(0.0, x)))


def _num(x, default=0.0) -> float:
    try:
        v = float(x)
        return v if np.isfinite(v) else default
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------------ OHLCV tabanlı

def volume_spike(row: pd.Series, p: dict) -> Component:
    """Son kapanmış mumun hacmi, son 24 saatin normalinden kaç robust-sigma yukarıda?"""
    z = _num(row.get("vol_z"))
    thr = p["z_threshold"]
    score = 0.0 if z < thr * 0.5 else _clip01(z / (thr * 1.5))
    bullish = row["close"] > row["open"] and _num(row.get("clv")) > 0
    direction = (1 if bullish else -1) if score > 0 else 0
    return Component(
        "volume_spike", score, direction,
        f"hacim z={z:.1f} ({'yeşil' if bullish else 'kırmızı'} mum, {_num(row.get('rel_vol')):.1f}x ort.)",
        {"z": z},
    )


def money_flow(row: pd.Series, p: dict) -> Component:
    """Sessiz birikim: hacim mumların üst kısmında kapanıyor, OBV yükseliyor, fiyat henüz kaçmamış."""
    acc = _num(row.get("accumulation"))          # -1..1
    m = _num(row.get("mfi"), 50)
    obv_flow = _num(row.get("obv_flow"))         # -1..1
    price_move = abs(_num(row.get("price_chg_atr")))

    s_acc = _clip01(acc / 0.3)
    s_mfi = _clip01((m - 50) / 30)
    s_obv = _clip01(obv_flow / 0.3)
    # OBV yükselirken fiyat yatay => klasik birikim (diverjans) bonusu
    stealth = 1.0 if (obv_flow > 0.15 and price_move < 1.5) else 0.0
    score = 0.4 * s_acc + 0.25 * s_mfi + 0.2 * s_obv + 0.15 * stealth
    direction = 1 if acc > 0.05 else (-1 if acc < -0.05 else 0)
    if direction < 0:
        score = _clip01(-acc / 0.3)
    return Component(
        "money_flow", score, direction,
        f"birikim={acc:+.2f} MFI={m:.0f} OBV akışı={obv_flow:+.2f}" + (" [gizli birikim]" if stealth else ""),
    )


def breakout(row: pd.Series, p: dict) -> Component:
    """Hacimle onaylanmış direnç kırılımı."""
    close, hh, ll = _num(row["close"]), _num(row.get("hh"), np.nan), _num(row.get("ll"), np.nan)
    a = _num(row.get("atr"), np.nan)
    rv = _num(row.get("rel_vol"), 1.0)
    if not np.isfinite(hh) or not np.isfinite(a) or a <= 0:
        return Component("breakout", 0.0, 0, "veri yetersiz")
    if close > hh:
        score = _clip01(0.45 + 0.2 * (rv - 1))
        return Component("breakout", score, 1, f"{p['lookback']} bar zirvesi kırıldı ({rv:.1f}x hacim)")
    if np.isfinite(ll) and close < ll:
        return Component("breakout", _clip01(0.45 + 0.2 * (rv - 1)), -1, "destek kırıldı")
    if hh - close < 0.5 * a:
        return Component("breakout", 0.2, 1, "dirence yakın")
    return Component("breakout", 0.0, 0, "kırılım yok")


# ------------------------------------------------------------------ işlem / emir defteri tabanlı

def whale_trades(trades: pd.DataFrame, p: dict) -> Component:
    """Son işlemler içinde büyük tekil (balina) emirler hangi yönde?"""
    if trades is None or len(trades) < 20:
        return Component("whale_trades", 0.0, 0, "işlem verisi yok")
    cost = trades["cost"]
    thr = max(float(np.percentile(cost, p["percentile"])), float(p["min_usd"]))
    w = trades[cost >= thr]
    if w.empty:
        return Component("whale_trades", 0.0, 0, f"balina yok (eşik ${thr:,.0f})", {"threshold": thr})
    buy = w.loc[w["side"] == "buy", "cost"].sum()
    sell = w.loc[w["side"] == "sell", "cost"].sum()
    net = (buy - sell) / (buy + sell)
    share = w["cost"].sum() / cost.sum()
    score = _clip01(abs(net)) * _clip01(0.4 + len(w) / 10) * _clip01(0.5 + share * 2)
    direction = 1 if net > 0.1 else (-1 if net < -0.1 else 0)
    return Component(
        "whale_trades", score, direction,
        f"{len(w)} balina işlemi: alış ${buy:,.0f} / satış ${sell:,.0f} (eşik ${thr:,.0f}, hacmin %{share*100:.0f}'i)",
        {"buy_usd": buy, "sell_usd": sell, "threshold": thr},
    )


def taker_flow(trades: pd.DataFrame, p: dict) -> Component:
    """Agresif (piyasa emriyle) alanların oranı ve hızlanıp hızlanmadığı (CVD)."""
    if trades is None or len(trades) < 20:
        return Component("taker_flow", 0.0, 0, "işlem verisi yok")
    signed = np.where(trades["side"] == "buy", trades["cost"], -trades["cost"])
    total = trades["cost"].sum()
    ratio = trades.loc[trades["side"] == "buy", "cost"].sum() / total
    half = len(signed) // 2
    tot1, tot2 = trades["cost"].iloc[:half].sum(), trades["cost"].iloc[half:].sum()
    early = signed[:half].sum() / tot1 if tot1 else 0
    late = signed[half:].sum() / tot2 if tot2 else 0
    accel = late - early
    score = _clip01(abs(ratio - 0.5) / 0.2) * (1.0 if np.sign(accel) == np.sign(ratio - 0.5) else 0.7)
    direction = 1 if ratio > 0.55 else (-1 if ratio < 0.45 else 0)
    return Component(
        "taker_flow", score, direction,
        f"agresif alıcı oranı %{ratio*100:.0f}, CVD ivmesi {accel:+.2f}",
        {"buy_ratio": ratio, "cvd": float(signed.sum())},
    )


def orderbook(ob: dict, p: dict) -> Component:
    """Fiyatın +/- depth_pct% aralığındaki alış vs satış derinliği ve büyük duvarlar.
    UYARI: emir defteri spoofing'e açıktır, bu yüzden ağırlığı tek başına belirleyici değildir."""
    bids, asks = ob.get("bids") or [], ob.get("asks") or []
    if not bids or not asks:
        return Component("orderbook", 0.0, 0, "emir defteri yok", {"spread_pct": 99})
    best_bid, best_ask = bids[0][0], asks[0][0]
    mid = (best_bid + best_ask) / 2
    spread_pct = (best_ask - best_bid) / mid * 100
    lo, hi = mid * (1 - p["depth_pct"] / 100), mid * (1 + p["depth_pct"] / 100)
    b = [(px, px * q) for px, q, *_ in bids if px >= lo]
    a = [(px, px * q) for px, q, *_ in asks if px <= hi]
    bv, av = sum(c for _, c in b), sum(c for _, c in a)
    if bv + av == 0:
        return Component("orderbook", 0.0, 0, "derinlik yok", {"spread_pct": spread_pct})
    imb = (bv - av) / (bv + av)
    levels = [c for _, c in b + a]
    med = float(np.median(levels)) if levels else 0
    bid_wall = max(b, key=lambda x: x[1]) if b else None
    ask_wall = max(a, key=lambda x: x[1]) if a else None
    walls = []
    if bid_wall and med and bid_wall[1] > 8 * med:
        walls.append(f"alış duvarı {bid_wall[0]:.6g} (${bid_wall[1]:,.0f})")
    if ask_wall and med and ask_wall[1] > 8 * med:
        walls.append(f"satış duvarı {ask_wall[0]:.6g} (${ask_wall[1]:,.0f})")
    score = _clip01(abs(imb) / 0.4)
    direction = 1 if imb > 0.1 else (-1 if imb < -0.1 else 0)
    return Component(
        "orderbook", score, direction,
        f"defter dengesizliği {imb:+.2f} (alış ${bv:,.0f} / satış ${av:,.0f}), spread %{spread_pct:.3f}"
        + (" | " + ", ".join(walls) if walls else ""),
        {"imbalance": imb, "spread_pct": spread_pct},
    )
