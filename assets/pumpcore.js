/* FlowBot pump.fun motoru: bonding curve ilerlemesi, momentum skoru, risk bayrakları.
 * Ağ erişimi yok, sadece hesaplama. Tarayıcıda window.PumpCore, Node'da module.exports. */
(function (root) {
  "use strict";

  // pump.fun bonding curve sabitleri (klasik eğri): 1.073B sanal token ile başlar,
  // 793.1M gerçek token satılınca eğri tamamlanır ve token DEX'e (PumpSwap) geçer.
  const CURVE = { V_TOKENS_START: 1_073_000_000, REAL_TOKENS: 793_100_000, V_SOL_START: 30, SOL_TO_COMPLETE: 85 };

  const P = {
    windowSec: 120,         // momentum penceresi
    bigBuySol: 2,           // "balina" alımı eşiği (SOL)
    trackMinutes: 15,       // yeni token kaç dakika izlenir
    maxTracked: 120,
    weights: { flow: 30, buyers: 20, ratio: 15, velocity: 20, whale: 15 },
  };

  const fin = (x) => typeof x === "number" && isFinite(x);
  const clip01 = (x) => (fin(x) ? Math.min(1, Math.max(0, x)) : 0);
  const n = (x) => { const v = typeof x === "string" ? parseFloat(x) : x; return fin(v) ? v : NaN; };

  /** Bonding curve ilerlemesi 0..1 (yaklaşık). Önce sanal token rezervinden, yoksa sanal SOL'den. */
  function curveProgress(vTokens, vSol) {
    vTokens = n(vTokens); vSol = n(vSol);
    if (fin(vTokens) && vTokens > 0) return clip01((CURVE.V_TOKENS_START - vTokens) / CURVE.REAL_TOKENS);
    if (fin(vSol) && vSol > 0) return clip01((vSol - CURVE.V_SOL_START) / CURVE.SOL_TO_COMPLETE);
    return NaN;
  }

  /** PumpPortal mesajını normalize eder. Bilinmeyen/eksik alanlara karşı toleranslı. */
  function parseMessage(m) {
    if (!m || typeof m !== "object" || !m.mint) return null;
    const type = String(m.txType || "").toLowerCase();
    const base = {
      mint: m.mint, sig: m.signature || "", trader: m.traderPublicKey || m.user || "",
      vTokens: n(m.vTokensInBondingCurve), vSol: n(m.vSolInBondingCurve), mcapSol: n(m.marketCapSol),
      pool: m.pool || "", t: Date.now(),
    };
    base.progress = curveProgress(base.vTokens, base.vSol);
    if (type === "create") {
      return { ...base, kind: "create", name: String(m.name || "?").slice(0, 40), symbol: String(m.symbol || "?").slice(0, 16),
        uri: m.uri || "", devBuyTokens: n(m.initialBuy), devBuySol: n(m.solAmount) };
    }
    if (type === "buy" || type === "sell") {
      return { ...base, kind: type, sol: n(m.solAmount), tokens: n(m.tokenAmount) };
    }
    if (type === "migrate" || type === "migration" || m.method === "migrate") return { ...base, kind: "migrate" };
    return null;
  }

  /** Yeni izlenen token için durum nesnesi. */
  function newToken(ev) {
    return {
      mint: ev.mint, name: ev.name || "?", symbol: ev.symbol || "?", uri: ev.uri || "", creator: ev.trader,
      createdAt: ev.t, devBuySol: fin(ev.devBuySol) ? ev.devBuySol : 0,
      mcapSol0: ev.mcapSol, mcapSol: ev.mcapSol, progress: ev.progress, athMcapSol: ev.mcapSol,
      trades: [],                // {t, buy, sol, trader, mcapSol, progress}
      buys: 0, sells: 0, buySol: 0, sellSol: 0, buyers: new Set(),
      devSold: false, devSoldSol: 0, migrated: false, lastTradeAt: ev.t,
      history: [[ev.t, ev.mcapSol]],
    };
  }

  /** İşlemi token durumuna uygular. */
  function applyTrade(tok, ev) {
    const buy = ev.kind === "buy";
    const sol = fin(ev.sol) ? ev.sol : 0;
    tok.trades.push({ t: ev.t, buy, sol, trader: ev.trader, mcapSol: ev.mcapSol, progress: ev.progress });
    if (tok.trades.length > 400) tok.trades.splice(0, tok.trades.length - 400);
    if (buy) { tok.buys++; tok.buySol += sol; if (ev.trader) tok.buyers.add(ev.trader); }
    else { tok.sells++; tok.sellSol += sol; if (ev.trader && ev.trader === tok.creator) { tok.devSold = true; tok.devSoldSol += sol; } }
    if (fin(ev.mcapSol)) {
      tok.mcapSol = ev.mcapSol;
      if (!fin(tok.athMcapSol) || ev.mcapSol > tok.athMcapSol) tok.athMcapSol = ev.mcapSol;
      const last = tok.history[tok.history.length - 1];
      if (!last || ev.t - last[0] > 2000) tok.history.push([ev.t, ev.mcapSol]); else last[1] = ev.mcapSol;
      if (tok.history.length > 300) tok.history.shift();
    }
    if (fin(ev.progress)) tok.progress = ev.progress;
    tok.lastTradeAt = ev.t;
  }

  /** Son `windowSec` saniyenin istatistikleri. */
  function windowStats(tok, now, windowSec = P.windowSec) {
    const from = now - windowSec * 1000;
    let buys = 0, sells = 0, buySol = 0, sellSol = 0, bigBuySol = 0, bigBuys = 0;
    const buyers = new Map();
    let firstProg = NaN;
    for (const tr of tok.trades) {
      if (tr.t < from) continue;
      if (!fin(firstProg) && fin(tr.progress)) firstProg = tr.progress;
      if (tr.buy) {
        buys++; buySol += tr.sol;
        if (tr.trader) buyers.set(tr.trader, (buyers.get(tr.trader) || 0) + tr.sol);
        if (tr.sol >= P.bigBuySol) { bigBuys++; bigBuySol += tr.sol; }
      } else { sells++; sellSol += tr.sol; }
    }
    // pencere öncesi son ilerleme değeri (velocity için taban)
    let baseProg = NaN;
    for (let i = tok.trades.length - 1; i >= 0; i--) if (tok.trades[i].t < from && fin(tok.trades[i].progress)) { baseProg = tok.trades[i].progress; break; }
    if (!fin(baseProg)) baseProg = fin(firstProg) ? firstProg : tok.progress;
    if (tok.createdAt >= from) baseProg = 0; // pencere içinde doğduysa sıfırdan say
    const topBuyer = buyers.size ? Math.max(...buyers.values()) : 0;
    return {
      buys, sells, buySol, sellSol, net: buySol - sellSol, uniqueBuyers: buyers.size, bigBuys, bigBuySol,
      topBuyerShare: buySol > 0 ? topBuyer / buySol : 0,
      velocity: fin(tok.progress) && fin(baseProg) ? tok.progress - baseProg : 0,
    };
  }

  /** Momentum skoru 0..100 + bileşenler + risk bayrakları. */
  function score(tok, now) {
    const w = windowStats(tok, now);
    const gross = w.buySol + w.sellSol;
    const parts = {
      flow: gross > 0 ? clip01(w.net / gross) * clip01(w.buySol / 10) : 0,
      buyers: clip01(w.uniqueBuyers / 25),
      ratio: w.buys + w.sells >= 3 ? clip01((w.buys / (w.buys + w.sells) - 0.5) / 0.3) : 0,
      velocity: clip01(w.velocity / 0.15),
      whale: clip01(w.bigBuySol / 10),
    };
    let s = 0, tw = 0;
    for (const k in P.weights) { s += P.weights[k] * parts[k]; tw += P.weights[k]; }
    s = (100 * s) / tw;

    const flags = [];
    if (tok.devSold) { flags.push({ k: "dev", txt: "geliştirici sattı", bad: true }); s *= 0.4; }
    if (w.buySol >= 1 && w.topBuyerShare > 0.4) { flags.push({ k: "conc", txt: `tek cüzdan %${Math.round(w.topBuyerShare * 100)}`, bad: true }); s *= 0.75; }
    if (tok.devBuySol >= 5) flags.push({ k: "devbuy", txt: `dev ilk alım ${tok.devBuySol.toFixed(1)} SOL`, bad: false });
    if (fin(tok.athMcapSol) && fin(tok.mcapSol) && tok.athMcapSol > 0 && tok.mcapSol < tok.athMcapSol * 0.6) { flags.push({ k: "dump", txt: "zirveden -%" + Math.round((1 - tok.mcapSol / tok.athMcapSol) * 100), bad: true }); s *= 0.7; }
    if (now - tok.createdAt < 30_000) flags.push({ k: "new", txt: "çok yeni", bad: false });
    if (tok.migrated) flags.push({ k: "mig", txt: "DEX'e geçti", bad: false });
    return { score: Math.max(0, Math.min(100, s)), parts, w, flags };
  }

  /** İzlemeye devam edilsin mi? */
  function keepTracking(tok, now, sc) {
    if (tok.migrated) return now - tok.lastTradeAt < 10 * 60_000;
    if (now - tok.createdAt < P.trackMinutes * 60_000) return true;
    if (fin(tok.progress) && tok.progress >= 0.5) return now - tok.lastTradeAt < 10 * 60_000;
    return (sc ? sc.score : 0) >= 30 && now - tok.lastTradeAt < 5 * 60_000;
  }

  /** DexScreener çifti için basit momentum skoru (0..100) ve bayraklar. */
  function dexScore(p) {
    const tx = (p.txns && p.txns.h1) || {}, b = tx.buys || 0, s = tx.sells || 0;
    const vol1h = (p.volume && p.volume.h1) || 0, liq = (p.liquidity && p.liquidity.usd) || 0;
    const ch5 = (p.priceChange && p.priceChange.m5) || 0, ch1 = (p.priceChange && p.priceChange.h1) || 0;
    const parts = {
      ratio: b + s >= 10 ? clip01((b / (b + s) - 0.5) / 0.25) : 0,
      turnover: liq > 0 ? clip01(vol1h / liq / 2) : 0,
      m5: clip01(ch5 / 10),
      h1: clip01(ch1 / 50),
      activity: clip01((b + s) / 500),
    };
    const sc = 30 * parts.ratio + 20 * parts.turnover + 20 * parts.m5 + 15 * parts.h1 + 15 * parts.activity;
    const flags = [];
    if (liq > 0 && liq < 10000) flags.push("düşük likidite");
    if (ch1 < -30) flags.push("sert düşüş");
    return { score: sc, parts, flags };
  }

  const api = { CURVE, P, curveProgress, parseMessage, newToken, applyTrade, windowStats, score, keepTracking, dexScore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PumpCore = api;
})(typeof window !== "undefined" ? window : globalThis);
