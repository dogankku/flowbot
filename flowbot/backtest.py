"""Geçmiş veri üzerinde strateji testi.

Not: Geçmiş tekil işlemler ve emir defteri ücretsiz API'den alınamadığı için backtest
sadece OHLCV dedektörlerini (hacim patlaması, para akışı, kırılım) kullanır.
Canlıda balina/defter verisi ek bir filtre olarak çalışır.
"""
from dataclasses import dataclass, field
from typing import List

import numpy as np
import pandas as pd

from .broker import PaperBroker
from .indicators import compute_features
from .positions import manage, plan_levels
from .risk import RiskManager
from .scorer import Signal, apply_filters, cheap_components, combine


@dataclass
class BacktestResult:
    symbol: str
    trades: pd.DataFrame
    equity: pd.Series
    stats: dict = field(default_factory=dict)


def _stats(trades: pd.DataFrame, equity: pd.Series, start: float) -> dict:
    sells = trades[trades["side"] == "SELL"] if len(trades) else trades
    # pozisyon bazında PnL (kısmi satışlar birleştirilir)
    by_pos = sells.groupby("pos_id")["pnl"].sum() if len(sells) else pd.Series(dtype=float)
    wins, losses = by_pos[by_pos > 0], by_pos[by_pos <= 0]
    dd = (equity / equity.cummax() - 1).min() if len(equity) else 0
    rets = equity.pct_change().dropna()
    bars_per_year = 365 * 24 * 4  # 15dk varsayımı, kaba
    sharpe = (rets.mean() / rets.std() * np.sqrt(bars_per_year)) if rets.std() > 0 else 0
    return {
        "işlem": int(len(by_pos)),
        "kazanma_%": round(100 * len(wins) / len(by_pos), 1) if len(by_pos) else 0,
        "profit_factor": round(wins.sum() / -losses.sum(), 2) if losses.sum() < 0 else float("inf") if len(wins) else 0,
        "ort_kazanç_$": round(wins.mean(), 2) if len(wins) else 0,
        "ort_kayıp_$": round(losses.mean(), 2) if len(losses) else 0,
        "net_kâr_$": round(equity.iloc[-1] - start, 2) if len(equity) else 0,
        "getiri_%": round(100 * (equity.iloc[-1] / start - 1), 2) if len(equity) else 0,
        "max_düşüş_%": round(100 * dd, 2),
        "sharpe": round(float(sharpe), 2),
    }


def run_backtest(df: pd.DataFrame, symbol: str, cfg: dict) -> BacktestResult:
    risk_cfg, min_score = cfg["risk"], cfg["filters"]["min_score"]
    rm = RiskManager(cfg)
    broker = PaperBroker(cfg, persist=False)
    feats = compute_features(df, cfg)
    warmup = max(cfg["detectors"]["volume_spike"]["lookback"], cfg["detectors"]["breakout"]["lookback"]) + 5

    log_rows, eq_curve, pos_id = [], [], 0
    ts_index = df.index
    pending = None  # sinyal bar kapanışında oluşur, bir sonraki barın açılışında girilir (look-ahead yok)

    for i in range(warmup, len(df)):
        row = feats.iloc[i]
        now = ts_index[i].timestamp() if hasattr(ts_index[i], "timestamp") else float(i * 900)
        o, h, l, c = row["open"], row["high"], row["low"], row["close"]

        # 1) Bekleyen girişi bu barın açılışında yap
        if pending is not None and symbol not in broker.positions:
            sig = pending
            equity = broker.equity({symbol: o})
            broker.roll_day(rm.day_key(now), equity)
            ok, _ = rm.can_open(len(broker.positions), symbol, False, broker.last_exit.get(symbol),
                                now, equity, broker.day_start_equity)
            if ok:
                stop, tp = plan_levels(o, sig.atr, risk_cfg)
                qty, _ = rm.size(equity, broker.cash, o, stop)
                if qty > 0:
                    pos_id += 1
                    p = broker.open(symbol, qty, o, stop, tp, sig.atr, now, sig.score)
                    log_rows.append({"time": ts_index[i], "side": "BUY", "price": p.entry, "qty": p.qty,
                                     "pnl": 0.0, "reason": f"skor {sig.score:.0f}", "pos_id": pos_id})
        pending = None

        # 2) Açık pozisyonu bu barın H/L'si ile yönet
        if symbol in broker.positions:
            pos = broker.positions[symbol]
            for kind, px, reason in manage(pos, o, h, l, c, row["atr"], now, risk_cfg):
                if symbol not in broker.positions:
                    break
                frac = risk_cfg["partial_tp_fraction"] if kind == "partial" else 1.0
                qty_before = broker.positions[symbol].qty
                pnl = broker.close(symbol, frac, px, reason, now)
                log_rows.append({"time": ts_index[i], "side": "SELL", "price": px,
                                 "qty": qty_before * (frac if frac < 1 else 1), "pnl": pnl,
                                 "reason": reason, "pos_id": pos_id})

        # 3) Bar kapanışında sinyal üret
        if symbol not in broker.positions:
            comps = cheap_components(row, cfg)
            sig = Signal(symbol, combine(comps, cfg), c, row["atr"], comps)
            apply_filters(sig, row, cfg)
            if sig.score >= min_score and sig.actionable:
                pending = sig

        eq_curve.append((ts_index[i], broker.equity({symbol: c})))

    equity = pd.Series([e for _, e in eq_curve], index=[t for t, _ in eq_curve], dtype=float)
    trades = pd.DataFrame(log_rows, columns=["time", "side", "price", "qty", "pnl", "reason", "pos_id"])
    return BacktestResult(symbol, trades, equity, _stats(trades, equity, risk_cfg["starting_equity"]))


def print_report(results: List[BacktestResult]) -> None:
    rows = [{"parite": r.symbol, **r.stats} for r in results]
    table = pd.DataFrame(rows)
    with pd.option_context("display.max_columns", 20, "display.width", 200):
        print(table.to_string(index=False))
    if len(results) > 1 and len(table):
        print(f"\nToplam net kâr: ${table['net_kâr_$'].sum():,.2f}  |  toplam işlem: {table['işlem'].sum()}")
