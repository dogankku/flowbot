"""JavaScript motoru (assets/flow.js) Python ile aynı sonucu veriyor mu? (node yoksa atlanır)"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flowbot.config import load_config  # noqa: E402
from flowbot.indicators import compute_features  # noqa: E402
from flowbot.scorer import cheap_components, combine  # noqa: E402
from tests.test_flowbot import synthetic  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLS = ["vol_z", "rel_vol", "accumulation", "mfi", "obv_flow", "atr", "rsi", "vwap", "hh", "ll", "price_chg_atr"]

JS = r"""
const F = require(process.argv[1] + '/assets/flow.js');
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const cfg = F.DEFAULTS;
const rows = F.computeFeatures(data, cfg);
const out = rows.map(r => {
  const o = {}; for (const k of %s) o[k] = Number.isFinite(r[k]) ? r[k] : null;
  o.score = F.combine(F.cheapComponents(r, cfg), cfg); return o; });
process.stdout.write(JSON.stringify(out));
""" % json.dumps(COLS)


@pytest.mark.skipif(not shutil.which("node"), reason="node yok")
@pytest.mark.parametrize("seed,pump", [(1, None), (3, 250), (7, 300)])
def test_js_matches_python(seed, pump):
    cfg = load_config(os.path.join(ROOT, "config.yaml"))
    df = synthetic(n=400, seed=seed, pump_at=pump)
    f = compute_features(df, cfg)
    candles = [{"t": i, "o": r.open, "h": r.high, "l": r.low, "c": r.close, "v": r.volume}
               for i, r in enumerate(df.itertuples())]
    res = subprocess.run(["node", "-e", JS, ROOT], input=json.dumps(candles), capture_output=True, text=True, check=True)
    js = json.loads(res.stdout)
    for i in range(120, len(df)):
        row = f.iloc[i]
        for k in COLS:
            pv, jv = row[k], js[i][k]
            if np.isnan(pv):
                assert jv is None, (i, k, jv)
            else:
                assert jv == pytest.approx(pv, rel=1e-6, abs=1e-9), (i, k, pv, jv)
        assert js[i]["score"] == pytest.approx(combine(cheap_components(row, cfg), cfg), abs=1e-6), i
