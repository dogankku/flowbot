// node --test tests/pumpcore.test.js
const test = require("node:test");
const assert = require("node:assert");
const PC = require("../assets/pumpcore.js");

const create = (o = {}) => PC.parseMessage({ txType: "create", mint: "M1pump", traderPublicKey: "DEV", name: "Test", symbol: "TST",
  initialBuy: 3e7, solAmount: 1, vTokensInBondingCurve: 1_043_000_000, vSolInBondingCurve: 31, marketCapSol: 29.7, ...o });
const trade = (type, sol, trader, vT, t) => ({ ...PC.parseMessage({ txType: type, mint: "M1pump", traderPublicKey: trader, solAmount: sol,
  tokenAmount: 1e6, vTokensInBondingCurve: vT, vSolInBondingCurve: 40, marketCapSol: 40 }), t });

test("bonding curve ilerlemesi", () => {
  assert.strictEqual(PC.curveProgress(1_073_000_000), 0);
  assert.strictEqual(PC.curveProgress(279_900_000), 1);
  assert.ok(Math.abs(PC.curveProgress(676_450_000) - 0.5) < 1e-9);
  assert.ok(Math.abs(PC.curveProgress(undefined, 72.5) - 0.5) < 1e-9); // SOL'den yedek hesap
  assert.ok(Number.isNaN(PC.curveProgress(undefined, undefined)));
  assert.strictEqual(PC.curveProgress("279900000"), 1); // string alanlar
});

test("mesaj ayrıştırma toleranslı", () => {
  assert.strictEqual(PC.parseMessage({ message: "Successfully subscribed" }), null);
  assert.strictEqual(PC.parseMessage(null), null);
  const c = create();
  assert.strictEqual(c.kind, "create");
  assert.strictEqual(c.symbol, "TST");
  assert.strictEqual(PC.parseMessage({ txType: "migrate", mint: "X" }).kind, "migrate");
  assert.strictEqual(PC.parseMessage({ txType: "sell", mint: "X", solAmount: "0.5" }).sol, 0.5);
});

test("güçlü alım akışı yüksek skor, dev satışı cezalandırılır", () => {
  const t0 = 1_000_000;
  const c = { ...create(), t: t0 };
  const tok = PC.newToken(c);
  let vT = 1_043_000_000;
  for (let i = 0; i < 30; i++) { vT -= 6_000_000; PC.applyTrade(tok, trade("buy", i % 6 === 0 ? 3 : 0.6, "W" + i, vT, t0 + 40_000 + i * 2000)); }
  PC.applyTrade(tok, trade("sell", 0.2, "W1", vT, t0 + 110_000));
  const now = t0 + 115_000;
  const s = PC.score(tok, now);
  assert.ok(s.score > 70, "skor " + s.score);
  assert.ok(s.w.uniqueBuyers >= 25 && s.w.bigBuys === 5);
  assert.ok(s.flags.every((f) => !f.bad));
  PC.applyTrade(tok, trade("sell", 1, "DEV", vT, now));
  const s2 = PC.score(tok, now + 1);
  assert.ok(tok.devSold && s2.score < s.score * 0.5);
  assert.ok(s2.flags.some((f) => f.k === "dev"));
});

test("tek cüzdan yoğunlaşması ve sakin token", () => {
  const t0 = 5_000_000, tok = PC.newToken({ ...create(), t: t0 });
  for (let i = 0; i < 5; i++) PC.applyTrade(tok, trade("buy", 2, "SAME", 1_000_000_000 - i * 1e7, t0 + 60_000 + i * 1000));
  const s = PC.score(tok, t0 + 70_000);
  assert.ok(s.flags.some((f) => f.k === "conc"));
  const quiet = PC.newToken({ ...create(), t: t0 });
  assert.ok(PC.score(quiet, t0 + 300_000).score === 0);
  assert.strictEqual(PC.keepTracking(quiet, t0 + 20 * 60_000, { score: 0 }), false);
  assert.strictEqual(PC.keepTracking(quiet, t0 + 5 * 60_000, { score: 0 }), true);
});

test("DexScreener skoru", () => {
  const hot = { txns: { h1: { buys: 600, sells: 250 } }, volume: { h1: 400000 }, liquidity: { usd: 120000 }, priceChange: { m5: 8, h1: 60 } };
  const cold = { txns: { h1: { buys: 20, sells: 60 } }, volume: { h1: 2000 }, liquidity: { usd: 5000 }, priceChange: { m5: -3, h1: -40 } };
  assert.ok(PC.dexScore(hot).score > 75);
  const c = PC.dexScore(cold);
  assert.ok(c.score < 10 && c.flags.includes("düşük likidite") && c.flags.includes("sert düşüş"));
});
