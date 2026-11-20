"""SQLite kayıt: tüm sinyaller ve işlemler (sonradan analiz / optimizasyon için)."""
import json
import os
import sqlite3
import time


class Storage:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS signals(
                ts REAL, symbol TEXT, score REAL, price REAL, actionable INTEGER,
                deep INTEGER, components TEXT, blocked TEXT);
            CREATE TABLE IF NOT EXISTS trades(
                ts REAL, mode TEXT, symbol TEXT, side TEXT, qty REAL, price REAL,
                fee REAL, pnl REAL, reason TEXT, equity REAL);
            CREATE INDEX IF NOT EXISTS ix_sig ON signals(symbol, ts);
            """
        )

    def log_signal(self, sig) -> None:
        comps = [{"name": c.name, "score": round(c.score, 3), "dir": c.direction, "detail": c.detail}
                 for c in sig.components]
        self.db.execute(
            "INSERT INTO signals VALUES(?,?,?,?,?,?,?,?)",
            (time.time(), sig.symbol, sig.score, sig.price, int(sig.actionable), int(sig.deep),
             json.dumps(comps, ensure_ascii=False), "; ".join(sig.blocked_by)),
        )
        self.db.commit()

    def log_trade(self, mode, symbol, side, qty, price, fee, pnl, reason, equity) -> None:
        self.db.execute(
            "INSERT INTO trades VALUES(?,?,?,?,?,?,?,?,?,?)",
            (time.time(), mode, symbol, side, qty, price, fee, pnl, reason, equity),
        )
        self.db.commit()
