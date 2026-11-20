#!/usr/bin/env python3
"""FlowBot komut satırı.

  python main.py once                      # tek tarama yap, sonuçları yazdır
  python main.py scan                      # sürekli tara + Telegram uyarısı (işlem yok)
  python main.py paper                     # sanal parayla otomatik al-sat
  python main.py live --i-understand-the-risk   # GERÇEK PARA
  python main.py backtest --symbols BTC/USDT SOL/USDT --days 90
  python main.py backtest --csv veri.csv --symbol XYZ/USDT
"""
import argparse
import logging
import os
import sys

import pandas as pd

from flowbot.config import load_config


def setup_logging(verbose: bool):
    os.makedirs("data", exist_ok=True)
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler("data/flowbot.log", encoding="utf-8")],
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def main():
    ap = argparse.ArgumentParser(description="FlowBot - kripto para akışı tarayıcı / bot")
    ap.add_argument("mode", choices=["once", "scan", "paper", "live", "backtest"])
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--symbols", nargs="*", help="backtest pariteleri (boşsa evrenin ilk 10'u)")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--csv", help="backtest için OHLCV csv (ts/time,open,high,low,close,volume)")
    ap.add_argument("--symbol", default="CSV/USDT")
    ap.add_argument("--i-understand-the-risk", action="store_true", dest="confirm")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    setup_logging(args.verbose)
    cfg = load_config(args.config)

    from flowbot.notifier import Notifier
    from flowbot.storage import Storage

    if args.mode == "backtest":
        from flowbot.backtest import print_report, run_backtest
        results = []
        if args.csv:
            df = pd.read_csv(args.csv)
            tcol = "time" if "time" in df.columns else "ts"
            df.index = pd.to_datetime(df[tcol], unit="ms" if tcol == "ts" else None, utc=True)
            results.append(run_backtest(df, args.symbol, cfg))
        else:
            from flowbot.exchange import Exchange
            ex = Exchange(cfg)
            symbols = args.symbols or ex.top_symbols()[:10]
            since = ex.x.milliseconds() - args.days * 86400_000
            for s in symbols:
                print(f"{s} indiriliyor...")
                df = ex.ohlcv_history(s, cfg["timeframe"], since)
                results.append(run_backtest(df, s, cfg))
        print_report(results)
        os.makedirs("data", exist_ok=True)
        allt = pd.concat([r.trades.assign(symbol=r.symbol) for r in results], ignore_index=True)
        allt.to_csv("data/backtest_trades.csv", index=False)
        print("İşlem listesi: data/backtest_trades.csv")
        return

    from flowbot.broker import LiveBroker, PaperBroker
    from flowbot.engine import Engine
    from flowbot.exchange import Exchange

    store = Storage(cfg["storage"]["db_path"])
    notifier = Notifier(cfg)

    if args.mode == "live":
        if not args.confirm:
            sys.exit("Canlı mod gerçek para kullanır. Emin iseniz --i-understand-the-risk ekleyin.")
        ex = Exchange(cfg, authenticated=True)
        broker = LiveBroker(cfg, ex, store, notifier)
        notifier.send(f"⚠️ FlowBot CANLI modda başladı. Bakiye: {broker.cash:.2f} {cfg['universe']['quote']}")
    else:
        ex = Exchange(cfg)
        broker = PaperBroker(cfg, store, notifier) if args.mode == "paper" else None

    engine = Engine(cfg, ex, broker, store, notifier)
    if args.mode == "once":
        engine.refresh_universe(force=True)
        engine.step(trade=False)
        return
    try:
        engine.run(trade=args.mode in ("paper", "live"))
    except KeyboardInterrupt:
        print("\nDurduruldu. Açık pozisyonlar state dosyasında saklandı.")


if __name__ == "__main__":
    main()
