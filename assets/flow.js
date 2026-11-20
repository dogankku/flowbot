/* FlowBot - para akışı motoru (Python flowbot/ paketinin birebir JavaScript karşılığı).
 * Tarayıcıda window.Flow, Node'da module.exports olarak kullanılır. Ağ erişimi yoktur; sadece hesaplama. */
(function (root) {
  "use strict";

  const DEFAULTS = {
    timeframe: "15m",
    historyBars: 300,
    topN: 60,
    minQuoteVol: 5e6,
    excludeBases: ["USDC", "FDUSD", "TUSD", "DAI", "BUSD", "USDP", "EUR", "TRY", "PAXG", "WBTC", "USD1", "USDE", "AEUR", "EURI", "XUSD", "BFUSD"],
    detectors: {
      volume_spike: { lookback: 96, z_threshold: 3.0, weight: 25 },
      money_flow: { lookback: 20, weight: 15 },
      breakout: { lookback: 48, weight: 15 },
      whale_trades: { trades_limit: 1000, percentile: 99, min_usd: 20000, weight: 20 },
      taker_flow: { weight: 10 },
      orderbook: { depth_pct: 1.0, limit: 100, weight: 15 },
      deep_check_top_k: 8,
    },
    filters: { max_spread_pct: 0.15, max_rsi: 82, max_vwap_extension_atr: 5.0, min_score: 60 },
    risk: {
      starting_equity: 1000, risk_per_trade_pct: 1.0, max_position_pct: 20, max_open_positions: 4,
      atr_period: 14, stop_atr_mult: 2.0, take_profit_r: 2.0, partial_tp_fraction: 0.5,
      breakeven_at_r: 1.0, trailing_atr_mult: 2.5, max_daily_loss_pct: 4.0,
      symbol_cooldown_minutes: 120, max_hold_hours: 24,
    },
    fees: { taker_pct: 0.1, slippage_pct: 0.05 },
  };

  const LEVERAGED = ["DOWN", "BULL", "BEAR", "3L", "3S", "5L", "5S"];
  // "UP" eki sadece bilinen kaldıraçlı tokenlerde (BTCUP...) — JUP, SYRUP gibi normal coinler elenmesin
  const UP_PREFIXES = ["BTC", "ETH", "BNB", "XRP", "ADA", "DOT", "LINK", "LTC", "TRX", "XLM", "EOS", "FIL", "SXP", "YFI", "UNI", "AAVE", "SUSHI", "1INCH", "XTZ", "BCH"];

  // ------------------------------------------------------------------ yardımcılar
  const fin = (x) => typeof x === "number" && isFinite(x);
  const num = (x, d = 0) => (fin(x) ? x : d);
  const clip01 = (x) => (fin(x) ? Math.min(1, Math.max(0, x)) : 0);
  function median(a) {
    const s = Float64Array.from(a).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function percentile(a, p) {
    const s = Float64Array.from(a).sort();
    const idx = ((s.length - 1) * p) / 100;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }
  function wilder(arr, n) {
    const out = new Array(arr.length).fill(NaN);
    let prev = NaN;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!fin(v)) { out[i] = prev; continue; }
      prev = fin(prev) ? prev + (v - prev) / n : v;
      out[i] = prev;
    }
    return out;
  }

  // ------------------------------------------------------------------ göstergeler
  // candles: [{t,o,h,l,c,v}]
  function computeFeatures(candles, cfg) {
    const d = cfg.detectors, r = cfg.risk;
    const vsN = d.volume_spike.lookback, mfN = d.money_flow.lookback, boN = d.breakout.lookback;
    const n = candles.length;
    const o = candles.map((k) => k.o), h = candles.map((k) => k.h), l = candles.map((k) => k.l);
    const c = candles.map((k) => k.c), v = candles.map((k) => k.v);
    const qv = c.map((x, i) => x * v[i]);
    const logqv = qv.map((x) => Math.log1p(x));

    // ATR
    const tr = c.map((_, i) => i === 0 ? h[i] - l[i]
      : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    const atr = wilder(tr, r.atr_period);

    // RSI(14)
    const up = c.map((x, i) => (i === 0 ? NaN : Math.max(0, x - c[i - 1])));
    const dn = c.map((x, i) => (i === 0 ? NaN : Math.max(0, c[i - 1] - x)));
    const au = wilder(up, 14), ad = wilder(dn, 14);
    const rsi = au.map((u, i) => {
      const dd = ad[i];
      if (!fin(u) || !fin(dd)) return 50;
      if (dd > 0) return 100 - 100 / (1 + u / dd);
      return u > 0 ? 100 : 50;
    });

    // CLV, OBV, MFI
    const clv = c.map((x, i) => { const rg = h[i] - l[i]; return rg > 0 ? ((x - l[i]) - (h[i] - x)) / rg : 0; });
    const obv = new Array(n); obv[0] = 0;
    for (let i = 1; i < n; i++) obv[i] = obv[i - 1] + Math.sign(c[i] - c[i - 1]) * v[i];
    const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
    const mfi = new Array(n).fill(50);
    for (let i = 13; i < n; i++) {
      let pos = 0, neg = 0;
      for (let j = i - 13; j <= i; j++) {
        if (j === 0) continue;
        const raw = tp[j] * v[j];
        if (tp[j] > tp[j - 1]) pos += raw; else if (tp[j] < tp[j - 1]) neg += raw;
      }
      mfi[i] = neg > 0 ? 100 - 100 / (1 + pos / neg) : pos > 0 ? 100 : 50;
    }

    const rows = new Array(n);
    const mp = Math.max(10, vsN >> 1);
    let vwNum = 0, vwDen = 0;
    for (let i = 0; i < n; i++) {
      // rolling VWAP (vsN, min_periods=1)
      vwNum += tp[i] * v[i]; vwDen += v[i];
      if (i >= vsN) { vwNum -= tp[i - vsN] * v[i - vsN]; vwDen -= v[i - vsN]; }
      const vwap = vwDen > 0 ? vwNum / vwDen : c[i];

      // robust z (önceki pencere, mevcut bar hariç)
      let volZ = NaN;
      const start = Math.max(0, i - vsN);
      if (i - start >= mp) {
        const w = logqv.slice(start, i);
        const med = median(w);
        const mad = median(w.map((x) => Math.abs(x - med)));
        volZ = mad > 0 ? (logqv[i] - med) / (1.4826 * mad) : NaN;
      }
      // rel_vol (önceki boN bar ortalaması, min 10)
      let relVol = NaN;
      const s2 = Math.max(0, i - boN);
      if (i - s2 >= 10) { let s = 0; for (let j = s2; j < i; j++) s += qv[j]; relVol = qv[i] / (s / (i - s2)); }
      // birikim + OBV akışı
      let acc = NaN, obvFlow = NaN, priceChg = NaN;
      if (i >= mfN - 1) {
        let a = 0, b = 0;
        for (let j = i - mfN + 1; j <= i; j++) { a += clv[j] * qv[j]; b += qv[j]; }
        acc = b > 0 ? a / b : NaN;
      }
      if (i >= mfN) {
        let vs = 0; for (let j = i - mfN + 1; j <= i; j++) vs += v[j];
        obvFlow = vs > 0 ? (obv[i] - obv[i - mfN]) / vs : NaN;
        priceChg = (c[i] - c[i - mfN]) / atr[i];
      }
      let hh = NaN, ll = NaN;
      if (i >= boN) { hh = -Infinity; ll = Infinity; for (let j = i - boN; j < i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; } }

      rows[i] = {
        t: candles[i].t, open: o[i], high: h[i], low: l[i], close: c[i], quote_vol: qv[i],
        vol_z: volZ, rel_vol: relVol, clv: clv[i], accumulation: acc, mfi: mfi[i], obv_flow: obvFlow,
        atr: atr[i], rsi: rsi[i], vwap, vwap_ext_atr: (c[i] - vwap) / atr[i], price_chg_atr: priceChg, hh, ll,
      };
    }
    return rows;
  }

  // ------------------------------------------------------------------ dedektörler
  const comp = (name, score, direction, detail, data = {}) => ({ name, score, direction, detail, data });
  const usd = (x) => "$" + Math.round(x).toLocaleString("en-US");

  function volumeSpike(row, p) {
    const z = num(row.vol_z), thr = p.z_threshold;
    const score = z < thr * 0.5 ? 0 : clip01(z / (thr * 1.5));
    const bullish = row.close > row.open && num(row.clv) > 0;
    const dir = score > 0 ? (bullish ? 1 : -1) : 0;
    return comp("volume_spike", score, dir,
      `hacim z=${z.toFixed(1)} (${bullish ? "yeşil" : "kırmızı"} mum, ${num(row.rel_vol).toFixed(1)}x ort.)`, { z });
  }

  function moneyFlow(row) {
    const acc = num(row.accumulation), m = num(row.mfi, 50), of = num(row.obv_flow);
    const pm = Math.abs(num(row.price_chg_atr));
    const stealth = of > 0.15 && pm < 1.5 ? 1 : 0;
    let score = 0.4 * clip01(acc / 0.3) + 0.25 * clip01((m - 50) / 30) + 0.2 * clip01(of / 0.3) + 0.15 * stealth;
    const dir = acc > 0.05 ? 1 : acc < -0.05 ? -1 : 0;
    if (dir < 0) score = clip01(-acc / 0.3);
    return comp("money_flow", score, dir,
      `birikim=${acc >= 0 ? "+" : ""}${acc.toFixed(2)} MFI=${m.toFixed(0)} OBV=${of >= 0 ? "+" : ""}${of.toFixed(2)}${stealth ? " [gizli birikim]" : ""}`);
  }

  function breakout(row, p) {
    const c = row.close, hh = row.hh, ll = row.ll, a = row.atr, rv = num(row.rel_vol, 1);
    if (!fin(hh) || !fin(a) || a <= 0) return comp("breakout", 0, 0, "veri yetersiz");
    if (c > hh) return comp("breakout", clip01(0.45 + 0.2 * (rv - 1)), 1, `${p.lookback} bar zirvesi kırıldı (${rv.toFixed(1)}x hacim)`);
    if (fin(ll) && c < ll) return comp("breakout", clip01(0.45 + 0.2 * (rv - 1)), -1, "destek kırıldı");
    if (hh - c < 0.5 * a) return comp("breakout", 0.2, 1, "dirence yakın");
    return comp("breakout", 0, 0, "kırılım yok");
  }

  // trades: [{side:'buy'|'sell', cost}]
  function whaleTrades(trades, p) {
    if (!trades || trades.length < 20) return comp("whale_trades", 0, 0, "işlem verisi yok");
    const costs = trades.map((t) => t.cost);
    const thr = Math.max(percentile(costs, p.percentile), p.min_usd);
    const w = trades.filter((t) => t.cost >= thr);
    if (!w.length) return comp("whale_trades", 0, 0, `balina yok (eşik ${usd(thr)})`, { threshold: thr });
    let buy = 0, sell = 0, wsum = 0;
    for (const t of w) { wsum += t.cost; if (t.side === "buy") buy += t.cost; else sell += t.cost; }
    const total = costs.reduce((a, b) => a + b, 0);
    const net = (buy - sell) / (buy + sell), share = wsum / total;
    const score = clip01(Math.abs(net)) * clip01(0.4 + w.length / 10) * clip01(0.5 + share * 2);
    const dir = net > 0.1 ? 1 : net < -0.1 ? -1 : 0;
    return comp("whale_trades", score, dir,
      `${w.length} balina: alış ${usd(buy)} / satış ${usd(sell)} (eşik ${usd(thr)}, hacmin %${(share * 100).toFixed(0)}'i)`,
      { buy_usd: buy, sell_usd: sell, threshold: thr });
  }

  function takerFlow(trades) {
    if (!trades || trades.length < 20) return comp("taker_flow", 0, 0, "işlem verisi yok");
    const signed = trades.map((t) => (t.side === "buy" ? t.cost : -t.cost));
    let total = 0, buy = 0;
    for (const t of trades) { total += t.cost; if (t.side === "buy") buy += t.cost; }
    const ratio = buy / total, half = signed.length >> 1;
    const sum = (a, s, e) => { let x = 0; for (let i = s; i < e; i++) x += a[i]; return x; };
    const tot1 = sum(trades.map((t) => t.cost), 0, half), tot2 = total - tot1;
    const early = tot1 ? sum(signed, 0, half) / tot1 : 0, late = tot2 ? sum(signed, half, signed.length) / tot2 : 0;
    const accel = late - early;
    const score = clip01(Math.abs(ratio - 0.5) / 0.2) * (Math.sign(accel) === Math.sign(ratio - 0.5) ? 1 : 0.7);
    const dir = ratio > 0.55 ? 1 : ratio < 0.45 ? -1 : 0;
    return comp("taker_flow", score, dir, `agresif alıcı %${(ratio * 100).toFixed(0)}, CVD ivmesi ${accel >= 0 ? "+" : ""}${accel.toFixed(2)}`,
      { buy_ratio: ratio });
  }

  // ob: {bids:[[price, qty]], asks:[[price, qty]]}
  function orderbook(ob, p) {
    const bids = (ob && ob.bids) || [], asks = (ob && ob.asks) || [];
    if (!bids.length || !asks.length) return comp("orderbook", 0, 0, "emir defteri yok", { spread_pct: 99 });
    const bb = +bids[0][0], ba = +asks[0][0], mid = (bb + ba) / 2;
    const spread = ((ba - bb) / mid) * 100;
    const lo = mid * (1 - p.depth_pct / 100), hi = mid * (1 + p.depth_pct / 100);
    const b = bids.map(([px, q]) => [+px, +px * +q]).filter(([px]) => px >= lo);
    const a = asks.map(([px, q]) => [+px, +px * +q]).filter(([px]) => px <= hi);
    const bv = b.reduce((s, x) => s + x[1], 0), av = a.reduce((s, x) => s + x[1], 0);
    if (bv + av === 0) return comp("orderbook", 0, 0, "derinlik yok", { spread_pct: spread });
    const imb = (bv - av) / (bv + av);
    const levels = b.concat(a).map((x) => x[1]);
    const med = levels.length ? median(levels) : 0;
    const walls = [];
    const bw = b.reduce((m, x) => (!m || x[1] > m[1] ? x : m), null);
    const aw = a.reduce((m, x) => (!m || x[1] > m[1] ? x : m), null);
    if (bw && med && bw[1] > 8 * med) walls.push(`alış duvarı ${bw[0]} (${usd(bw[1])})`);
    if (aw && med && aw[1] > 8 * med) walls.push(`satış duvarı ${aw[0]} (${usd(aw[1])})`);
    const dir = imb > 0.1 ? 1 : imb < -0.1 ? -1 : 0;
    return comp("orderbook", clip01(Math.abs(imb) / 0.4), dir,
      `defter ${imb >= 0 ? "+" : ""}${imb.toFixed(2)} (alış ${usd(bv)} / satış ${usd(av)}), spread %${spread.toFixed(3)}${walls.length ? " | " + walls.join(", ") : ""}`,
      { imbalance: imb, spread_pct: spread });
  }

  // ------------------------------------------------------------------ skor + filtre
  function combine(components, cfg) {
    let tw = 0, s = 0;
    for (const c of components) {
      const w = cfg.detectors[c.name].weight;
      tw += w;
      if (c.direction > 0) s += w * c.score; else if (c.direction < 0) s -= 0.5 * w * c.score;
    }
    return tw ? Math.max(0, Math.min(100, (100 * s) / tw)) : 0;
  }
  function cheapComponents(row, cfg) {
    const d = cfg.detectors;
    return [volumeSpike(row, d.volume_spike), moneyFlow(row, d.money_flow), breakout(row, d.breakout)];
  }
  function applyFilters(row, cfg, spreadPct) {
    const f = cfg.filters, out = [];
    if (row.rsi > f.max_rsi) out.push(`RSI ${row.rsi.toFixed(0)} > ${f.max_rsi}`);
    if (fin(row.vwap_ext_atr) && row.vwap_ext_atr > f.max_vwap_extension_atr) out.push(`VWAP'tan ${row.vwap_ext_atr.toFixed(1)} ATR uzak (kovalama)`);
    if (spreadPct != null && spreadPct > f.max_spread_pct) out.push(`spread %${spreadPct.toFixed(2)} çok geniş`);
    if (!fin(row.atr) || row.atr <= 0) out.push("ATR yok");
    return out;
  }

  // ------------------------------------------------------------------ pozisyon + risk
  function planLevels(entry, atr, risk) {
    const stop = entry - risk.stop_atr_mult * atr;
    return { stop, tp: entry + risk.take_profit_r * (entry - stop) };
  }
  // pos: {entry, stop, initial_stop, take_profit, highest, tp_hit, opened_at(sn)}
  function manage(pos, o, h, l, c, atrNow, now, risk) {
    const R = Math.max(pos.entry - pos.initial_stop, 1e-12);
    if (l <= pos.stop) {
      let reason = pos.stop > pos.initial_stop ? "trailing_stop" : "stop_loss";
      if (reason === "trailing_stop" && pos.stop >= pos.entry && !pos.tp_hit) reason = "breakeven_stop";
      return [["all", Math.min(pos.stop, o), reason]];
    }
    const acts = [];
    if (!pos.tp_hit && h >= pos.take_profit) { acts.push(["partial", Math.max(pos.take_profit, o), "take_profit"]); pos.tp_hit = true; }
    pos.highest = Math.max(pos.highest, h);
    if (pos.highest - pos.entry >= risk.breakeven_at_r * R) pos.stop = Math.max(pos.stop, pos.entry * 1.002);
    if (pos.tp_hit && atrNow > 0) pos.stop = Math.max(pos.stop, pos.highest - risk.trailing_atr_mult * atrNow);
    if (now - pos.opened_at >= risk.max_hold_hours * 3600) acts.push(["all", c, "time_exit"]);
    return acts;
  }
  function positionSize(cfg, equity, cash, entry, stop, minCost = 5) {
    const fee = cfg.fees.taker_pct / 100, r = cfg.risk;
    const perUnit = entry - stop + entry * fee * 2;
    if (perUnit <= 0) return [0, "geçersiz stop"];
    let qty = (equity * r.risk_per_trade_pct / 100) / perUnit;
    qty = Math.min(qty, Math.min(equity * r.max_position_pct / 100, cash * 0.98) / entry);
    if (qty <= 0) return [0, "nakit yok"];
    if (qty * entry < minCost) return [0, `min emir altında ($${(qty * entry).toFixed(2)})`];
    return [qty, ""];
  }
  function canOpen(cfg, nOpen, hasPos, lastExit, now, equity, dayStartEquity) {
    const r = cfg.risk;
    if (hasPos) return [false, "zaten pozisyonda"];
    if (nOpen >= r.max_open_positions) return [false, "max pozisyon sayısı"];
    if (lastExit && now - lastExit < r.symbol_cooldown_minutes * 60) return [false, "bekleme süresi"];
    if (dayStartEquity && equity < dayStartEquity * (1 - r.max_daily_loss_pct / 100)) return [false, "günlük kayıp limiti"];
    return [true, ""];
  }

  function isTradableBase(base, cfg) {
    if (!base || cfg.excludeBases.includes(base)) return false;
    if (LEVERAGED.some((s) => base.endsWith(s) && base.length > s.length + 1)) return false;
    if (base.endsWith("UP") && UP_PREFIXES.includes(base.slice(0, -2))) return false;
    return true;
  }

  const api = {
    DEFAULTS, computeFeatures, volumeSpike, moneyFlow, breakout, whaleTrades, takerFlow, orderbook,
    combine, cheapComponents, applyFilters, planLevels, manage, positionSize, canOpen, isTradableBase,
    percentile, median,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Flow = api;
})(typeof window !== "undefined" ? window : globalThis);
