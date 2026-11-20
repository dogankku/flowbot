"""Teknik göstergeler ve özellik (feature) üretimi.

Tüm hesaplamalar NEDENSEL'dir (sadece geçmiş veriyi kullanır), böylece aynı fonksiyon
hem canlı taramada (son satır) hem backtest'te (her satır) kullanılabilir.
"""
import numpy as np
import pandas as pd


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    out = out.where(dn > 0, np.where(up > 0, 100.0, 50.0))  # hiç düşüş yoksa 100, hareket yoksa 50
    return out.fillna(50)


def clv(df: pd.DataFrame) -> pd.Series:
    """Close Location Value: kapanış mumun neresinde? +1 tepede (alıcı baskın), -1 dipte."""
    rng = (df["high"] - df["low"]).replace(0, np.nan)
    return (((df["close"] - df["low"]) - (df["high"] - df["close"])) / rng).fillna(0.0)


def obv(df: pd.DataFrame) -> pd.Series:
    direction = np.sign(df["close"].diff()).fillna(0)
    return (direction * df["volume"]).cumsum()


def mfi(df: pd.DataFrame, n: int = 14) -> pd.Series:
    tp = (df["high"] + df["low"] + df["close"]) / 3
    raw = tp * df["volume"]
    pos = raw.where(tp > tp.shift(1), 0.0).rolling(n).sum()
    neg = raw.where(tp < tp.shift(1), 0.0).rolling(n).sum()
    ratio = pos / neg.replace(0, np.nan)
    out = 100 - 100 / (1 + ratio)
    out = out.where(neg > 0, np.where(pos > 0, 100.0, 50.0))
    return out.where(pos.notna(), np.nan).fillna(50)


def rolling_vwap(df: pd.DataFrame, n: int) -> pd.Series:
    tp = (df["high"] + df["low"] + df["close"]) / 3
    return (tp * df["volume"]).rolling(n, min_periods=1).sum() / df["volume"].rolling(n, min_periods=1).sum()


def robust_z(series: pd.Series, lookback: int) -> pd.Series:
    """Medyan/MAD tabanlı z-skoru. Mevcut bar, kendi referans penceresine dahil edilmez.
    Normal z-skoruna göre tekil uç değerlerden çok daha az etkilenir."""
    prev = series.shift(1)
    mp = max(10, lookback // 2)
    med = prev.rolling(lookback, min_periods=mp).median()
    mad = prev.rolling(lookback, min_periods=mp).apply(
        lambda x: np.median(np.abs(x - np.median(x))), raw=True
    )
    return (series - med) / (1.4826 * mad).replace(0, np.nan)


def compute_features(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """OHLCV -> dedektörlerin kullandığı tüm özellikler."""
    d = cfg["detectors"]
    r = cfg["risk"]
    vs_n = d["volume_spike"]["lookback"]
    mf_n = d["money_flow"]["lookback"]
    bo_n = d["breakout"]["lookback"]

    f = pd.DataFrame(index=df.index)
    f["open"], f["high"], f["low"], f["close"] = df["open"], df["high"], df["low"], df["close"]
    qv = df["volume"] * df["close"]  # quote (USDT) hacmi
    f["quote_vol"] = qv

    # Hacim patlaması
    f["vol_z"] = robust_z(np.log1p(qv), vs_n)
    f["rel_vol"] = qv / qv.shift(1).rolling(bo_n, min_periods=10).mean()

    # Para akışı / birikim
    f["clv"] = clv(df)
    f["accumulation"] = (f["clv"] * qv).rolling(mf_n).sum() / qv.rolling(mf_n).sum()
    f["mfi"] = mfi(df, 14)
    o = obv(df)
    f["obv_flow"] = (o - o.shift(mf_n)) / df["volume"].rolling(mf_n).sum()  # [-1, 1]

    # Volatilite / konum
    f["atr"] = atr(df, r["atr_period"])
    f["rsi"] = rsi(df["close"], 14)
    f["vwap"] = rolling_vwap(df, vs_n)
    f["vwap_ext_atr"] = (df["close"] - f["vwap"]) / f["atr"]
    f["price_chg_atr"] = (df["close"] - df["close"].shift(mf_n)) / f["atr"]

    # Kırılım seviyeleri
    f["hh"] = df["high"].shift(1).rolling(bo_n).max()
    f["ll"] = df["low"].shift(1).rolling(bo_n).min()
    return f


def trades_to_df(trades: list) -> pd.DataFrame:
    """ccxt fetch_trades çıktısını DataFrame'e çevirir. side = taker (agresör) yönü."""
    if not trades:
        return pd.DataFrame(columns=["timestamp", "side", "price", "amount", "cost"])
    df = pd.DataFrame(
        [
            {
                "timestamp": t.get("timestamp"),
                "side": t.get("side"),
                "price": float(t.get("price") or 0),
                "amount": float(t.get("amount") or 0),
                "cost": float(t.get("cost") or (t.get("price") or 0) * (t.get("amount") or 0)),
            }
            for t in trades
        ]
    )
    return df.sort_values("timestamp").reset_index(drop=True)
