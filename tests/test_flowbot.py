"""Ağ bağlantısı gerektirmeyen testler (sentetik veri)."""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flowbot import detectors as D  # noqa: E402
from flowbot.backtest import run_backtest  # noqa: E402
from flowbot.broker import PaperBroker  # noqa: E402
from flowbot.config import load_config  # noqa: E402
from flowbot.indicators import compute_features, trades_to_df  # noqa: E402
from flowbot.positions import Position, manage  # noqa: E402
from flowbot.scorer import cheap_components, combine  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def cfg():
    return load_config(os.path.join(ROOT, "config.yaml"))


def synthetic(n=400, seed=1, pump_at=None):
    """Rastgele yürüyüş + isteğe bağlı 'balina birikimi ve pump' senaryosu."""
    rng = np.random.default_rng(seed)
    ret = rng.normal(0, 0.003, n)
    vol = rng.lognormal(10, 0.3, n)
    if pump_at:
        ret[pump_at - 15:pump_at] = np.abs(ret[pump_at - 15:pump_at]) * 0.3   # sessiz birikim
        vol[pump_at - 15:pump_at] *= 1.8
        ret[pump_at] = 0.008                                                # patlama mumu (erken evre)
        vol[pump_at] *= 12
        ret[pump_at + 1:pump_at + 30] = 0.004                               # devam eden yükseliş
    close = 100 * np.exp(np.cumsum(ret))
    open_ = np.r_[close[0], close[:-1]]
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.001, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.001, n)))
    if pump_at:
        high[pump_at] = close[pump_at] * 1.0005  # kapanış tepeye yakın
    idx = pd.date_range("2026-01-01", periods=n, freq="15min", tz="UTC")
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": vol}, index=idx)


def test_features_no_lookahead(cfg):
    df = synthetic()
    full = compute_features(df, cfg)
    part = compute_features(df.iloc[:300], cfg)
    cols = ["vol_z", "accumulation", "atr", "rsi", "hh"]
    pd.testing.assert_frame_equal(full[cols].iloc[:300], part[cols], check_exact=False)


def test_pump_detected(cfg):
    df = synthetic(pump_at=300)
    f = compute_features(df, cfg)
    row = f.iloc[300]
    comps = cheap_components(row, cfg)
    vs = next(c for c in comps if c.name == "volume_spike")
    assert vs.direction == 1 and vs.score > 0.8
    assert combine(comps, cfg) >= cfg["filters"]["min_score"]
    # sakin bir barda skor düşük olmalı
    quiet = combine(cheap_components(f.iloc[200], cfg), cfg)
    assert quiet < 40


def test_whale_and_taker(cfg):
    rng = np.random.default_rng(0)
    trades = [{"timestamp": i, "side": "buy" if rng.random() < 0.5 else "sell",
               "price": 10.0, "amount": float(rng.uniform(1, 50))} for i in range(500)]
    trades += [{"timestamp": 600 + i, "side": "buy", "price": 10.0, "amount": 8000.0} for i in range(6)]
    tdf = trades_to_df(trades)
    w = D.whale_trades(tdf, cfg["detectors"]["whale_trades"])
    assert w.direction == 1 and w.score > 0.5
    t = D.taker_flow(tdf, cfg["detectors"]["taker_flow"])
    assert t.direction == 1


def test_orderbook(cfg):
    ob = {"bids": [[99.9, 500], [99.5, 400], [99.2, 300]], "asks": [[100.1, 50], [100.5, 40], [100.8, 30]]}
    c = D.orderbook(ob, cfg["detectors"]["orderbook"])
    assert c.direction == 1 and c.score == 1.0
    assert c.data["spread_pct"] < 0.25


def test_position_rules(cfg):
    r = cfg["risk"]
    p = Position("X/USDT", 100, 10, 10, 96, 96, 108, 2, 0, 100)
    assert manage(p, 100, 104.5, 99, 104, 2, 60, r) == []
    assert p.stop >= 100.2  # 1R sonrası başabaş
    acts = manage(p, 104, 109, 103, 108, 2, 120, r)
    assert acts and acts[0][0] == "partial" and p.tp_hit
    assert p.stop >= 109 - r["trailing_atr_mult"] * 2
    acts = manage(p, 104, 104, 100, 101, 2, 180, r)
    assert acts[0][0] == "all" and acts[0][2] == "trailing_stop"


def test_paper_broker_accounting(cfg):
    b = PaperBroker(cfg, persist=False)
    start = b.cash
    b.open("X/USDT", 1.0, 100, 95, 110, 2, 0)
    pnl = b.close("X/USDT", 1.0, 100, "test", 10)
    assert pnl < 0 and abs(b.cash - (start + pnl)) < 1e-6  # sadece komisyon + slipaj kaybı


def test_backtest_runs(cfg):
    df = synthetic(n=600, pump_at=350)
    res = run_backtest(df, "SYN/USDT", cfg)
    assert len(res.equity) > 0
    assert res.stats["işlem"] >= 1
    first_buy = res.trades[res.trades.side == "BUY"].iloc[0]
    assert first_buy["time"] == df.index[351]  # sinyalden sonraki barda giriş


class FakeExchange:
    """Ağ olmadan Engine'i uçtan uca test etmek için sahte borsa."""

    def __init__(self, frames):
        self.frames = frames
        self.markets = {s: {"base": s.split("/")[0]} for s in frames}

    def top_symbols(self):
        return list(self.frames)

    def ohlcv(self, s, tf, limit):
        return self.frames[s].iloc[-limit:]

    def trades(self, s, limit):
        px = float(self.frames[s]["close"].iloc[-1])
        return [{"timestamp": i, "side": "buy" if i % 3 else "sell", "price": px,
                 "amount": 300.0 if i > 590 else 2.0} for i in range(600)]

    def order_book(self, s, limit):
        px = float(self.frames[s]["close"].iloc[-1])
        return {"bids": [[px * 0.9995, 900], [px * 0.998, 800]], "asks": [[px * 1.0005, 200], [px * 1.002, 150]]}

    def tickers(self, syms):
        return {s: {"last": float(self.frames[s]["close"].iloc[-1]) * 0.9} for s in syms}  # -%10 -> stop

    def market_limits(self, s):
        return {"min_amount": 0, "min_cost": 5}


def test_engine_end_to_end(cfg, tmp_path):
    from flowbot.engine import Engine
    from flowbot.storage import Storage
    cfg["filters"].update(max_rsi=100, max_vwap_extension_atr=99)  # filtreler ayrı test ediliyor
    pump = synthetic(n=301, seed=3, pump_at=300)
    calm = synthetic(n=301, seed=4)
    ex = FakeExchange({"PUMP/USDT": pump, "CALM/USDT": calm})
    broker = PaperBroker(cfg, persist=False)
    eng = Engine(cfg, ex, broker, Storage(str(tmp_path / "t.db")))
    signals = eng.step(trade=True)
    assert signals[0].symbol == "PUMP/USDT" and signals[0].deep
    assert "PUMP/USDT" in broker.positions and "CALM/USDT" not in broker.positions
    # risk: stop olursa kayıp ~ sermayenin %1'i
    pos = broker.positions["PUMP/USDT"]
    loss_at_stop = (pos.entry - pos.stop) * pos.qty
    assert loss_at_stop <= cfg["risk"]["starting_equity"] * 0.011
    # fiyat %10 düşünce stop çalışmalı
    eng.manage_positions(now=1e10)
    assert "PUMP/USDT" not in broker.positions


def test_chase_filter_blocks(cfg):
    from flowbot.scorer import Signal, apply_filters
    row = pd.Series({"rsi": 90, "vwap_ext_atr": 8, "atr": 1.0})
    s = Signal("X", 90, 1, 1)
    apply_filters(s, row, cfg, spread_pct=0.5)
    assert len(s.blocked_by) == 3 and not s.actionable
