/* FlowBot pump.fun canlı sayfası: PumpPortal WebSocket + DexScreener + Binance SOL fiyatı. */
(() => {
  "use strict";
  const PC = window.PumpCore;
  const PUMP_WS = "wss://pumpportal.fun/api/data";
  const DEX = "https://api.dexscreener.com";
  const BINANCE = [
    { rest: "https://api.binance.com", ws: "wss://stream.binance.com:9443" },
    { rest: "https://data-api.binance.vision", ws: "wss://data-stream.binance.vision" },
  ];

  const S = {
    sol: NaN,
    tokens: new Map(),        // mint -> token durumu
    newTimes: [],             // yeni token zaman damgaları (hız hesabı)
    migrations: [],           // {t, mint}
    selected: null,
    paused: false,
    ws: null, wsReady: false,
    subQueue: new Set(), unsubQueue: new Set(),
    dexRows: [], dexSort: { key: "score", asc: false },
    scores: new Map(),
  };

  // ------------------------------------------------------------------ yardımcılar
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fin = (x) => typeof x === "number" && isFinite(x);
  const usdOf = (sol) => (fin(sol) && fin(S.sol) ? sol * S.sol : NaN);
  function fmtUsd(x) {
    if (!fin(x)) return "—";
    if (x >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return "$" + (x / 1e6).toFixed(2) + "M";
    if (x >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
    return "$" + x.toFixed(0);
  }
  const fmtMcap = (sol) => (fin(S.sol) ? fmtUsd(usdOf(sol)) : fin(sol) ? sol.toFixed(1) + " SOL" : "—");
  const fmtSol = (x, d = 2) => (fin(x) ? x.toFixed(d) + " SOL" : "—");
  function fmtPrice(x) {
    if (!fin(x)) return "—";
    if (x >= 1) return "$" + x.toFixed(4);
    const s = x.toPrecision(3);
    return "$" + (x < 0.0001 ? Number(s).toExponential(2) : s);
  }
  const fmtPct = (x) => (fin(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) + "%" : "—");
  function age(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "sn";
    if (s < 3600) return Math.floor(s / 60) + "dk";
    if (s < 86400) return Math.floor(s / 3600) + "sa";
    return Math.floor(s / 86400) + "g";
  }
  const hhmm = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const short = (a) => (a && a.length > 10 ? a.slice(0, 4) + "…" + a.slice(-4) : a || "");
  const scoreCls = (s) => (s >= 60 ? "hi" : s >= 35 ? "mid" : "");
  function avatar(sym, mint) {
    let h = 0; for (const c of mint || sym) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="av" style="background:hsl(${h % 360} 55% 32%)">${esc((sym || "?").slice(0, 2).toUpperCase())}</span>`;
  }
  const links = (mint) => `<a href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener">pump.fun</a>
    · <a href="https://dexscreener.com/solana/${encodeURIComponent(mint)}" target="_blank" rel="noopener">DexScreener</a>
    · <a href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener">Solscan</a>`;
  function toast(html, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind; el.innerHTML = html;
    $("#toasts").appendChild(el); setTimeout(() => el.remove(), 6000);
  }
  function setConn(state, txt) { const el = $("#conn"); el.className = "pill " + state; el.querySelector("span").textContent = txt; }
  function prepend(feedSel, html, max = 60) {
    const feed = $(feedSel);
    if (feed.firstElementChild && feed.firstElementChild.classList.contains("empty")) feed.innerHTML = "";
    feed.insertAdjacentHTML("afterbegin", html);
    while (feed.children.length > max) feed.lastElementChild.remove();
  }

  // ------------------------------------------------------------------ SOL fiyatı (Binance)
  async function startSol() {
    for (const ep of BINANCE) {
      try {
        const r = await fetch(ep.rest + "/api/v3/ticker/price?symbol=SOLUSDT");
        if (!r.ok) continue;
        S.sol = +(await r.json()).price;
        renderSol();
        const open = () => {
          const ws = new WebSocket(ep.ws + "/ws/solusdt@miniTicker");
          ws.onmessage = (e) => { try { S.sol = +JSON.parse(e.data).c; renderSol(); } catch (x) { /* */ } };
          ws.onclose = () => setTimeout(open, 5000);
        };
        open();
        return;
      } catch (e) { /* sonraki */ }
    }
    $("#solPill").textContent = "SOL fiyatı yok";
  }
  let solShown = 0;
  function renderSol() {
    if (Date.now() - solShown < 1000) return;
    solShown = Date.now();
    $("#solPill").textContent = "SOL $" + S.sol.toFixed(2);
  }

  // ------------------------------------------------------------------ PumpPortal WebSocket (tek bağlantı)
  let retry = 0;
  function connectPump() {
    setConn("", "pump.fun bağlanıyor…");
    const ws = new WebSocket(PUMP_WS);
    S.ws = ws;
    ws.onopen = () => {
      retry = 0; S.wsReady = true;
      setConn("ok", "pump.fun canlı");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      const keys = [...S.tokens.keys()];
      if (keys.length) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys }));
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onPumpMessage(m); };
    ws.onclose = () => {
      S.wsReady = false;
      setConn("bad", "yeniden bağlanıyor…");
      // PumpPortal tek bağlantı ister; hızlı yeniden bağlanma döngüsüne girmemek için en az 5 sn bekle
      setTimeout(connectPump, Math.min(60000, 5000 * 2 ** retry++));
    };
    ws.onerror = () => ws.close();
  }

  function flushSubs() {
    if (!S.wsReady || !S.ws) return;
    if (S.subQueue.size) { S.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [...S.subQueue] })); S.subQueue.clear(); }
    if (S.unsubQueue.size) { S.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [...S.unsubQueue] })); S.unsubQueue.clear(); }
  }

  function track(tok) {
    S.tokens.set(tok.mint, tok);
    S.unsubQueue.delete(tok.mint);
    S.subQueue.add(tok.mint);
  }
  function untrack(mint) {
    S.tokens.delete(mint);
    S.scores.delete(mint);
    S.subQueue.delete(mint);
    S.unsubQueue.add(mint);
  }

  function onPumpMessage(m) {
    const ev = PC.parseMessage(m);
    if (!ev) return;
    if (ev.kind === "create") {
      S.newTimes.push(ev.t);
      const tok = PC.newToken(ev);
      track(tok);
      if (!S.paused) addNew(tok);
    } else if (ev.kind === "buy" || ev.kind === "sell") {
      const tok = S.tokens.get(ev.mint);
      if (!tok) return;
      PC.applyTrade(tok, ev);
      if (ev.kind === "buy" && fin(ev.sol) && ev.sol >= PC.P.bigBuySol && !S.paused) addBig(tok, ev);
      if (ev.kind === "sell" && ev.trader && ev.trader === tok.creator && !tok._devToast) {
        tok._devToast = true;
        if (S.scores.get(tok.mint) >= 35) toast(`⚠️ <b>${esc(tok.symbol)}</b>: geliştirici satış yaptı`, "bad");
      }
      if (S.selected === tok.mint) scheduleDetail();
    } else if (ev.kind === "migrate") {
      S.migrations.push({ t: ev.t, mint: ev.mint });
      const tok = S.tokens.get(ev.mint);
      if (tok) { tok.migrated = true; tok.progress = 1; }
      addMigration(ev.mint, tok);
    }
  }

  // ------------------------------------------------------------------ akış listeleri
  function addNew(tok) {
    const dev = tok.devBuySol > 0 ? `dev ${tok.devBuySol.toFixed(2)} SOL` : "dev alımı yok";
    prepend("#newFeed", `<div class="fi" data-mint="${esc(tok.mint)}">${avatar(tok.symbol, tok.mint)}
      <div class="fi-main"><b>${esc(tok.symbol)}</b> <span class="hint">${esc(tok.name)}</span><br><small class="hint">${hhmm(tok.createdAt)} · ${dev}</small></div>
      <div class="fi-r">${fmtMcap(tok.mcapSol)}</div></div>`, 50);
  }
  function addBig(tok, ev) {
    prepend("#bigFeed", `<div class="wf" data-mint="${esc(tok.mint)}"><span class="t">${hhmm(ev.t)}</span><b>${esc(tok.symbol)}</b>
      <span class="up">ALIŞ ▲ ${short(ev.trader)}</span><span class="usd up">${ev.sol.toFixed(2)} SOL</span></div>`, 60);
  }
  async function addMigration(mint, tok) {
    const id = "mig-" + mint.replace(/[^A-Za-z0-9]/g, "");
    prepend("#migFeed", `<div class="fi" id="${id}" data-mint="${esc(mint)}">${avatar(tok ? tok.symbol : "?", mint)}
      <div class="fi-main"><b>${esc(tok ? tok.symbol : short(mint))}</b> <span class="hint">${esc(tok ? tok.name : "")}</span><br>
      <small class="hint">${hhmm(Date.now())} · DEX'e geçti${tok ? " · " + age(Date.now() - tok.createdAt) + "'da" : ""}</small></div>
      <div class="fi-r"><span class="tag buy">🎓</span></div></div>`, 40);
    toast(`🎓 <b>${esc(tok ? tok.symbol : short(mint))}</b> bonding curve'ü tamamladı, DEX'e geçti`, "good");
    // DexScreener'da çift oluşunca istatistik ekle
    setTimeout(async () => {
      const pairs = await dexTokens([mint]).catch(() => []);
      const p = pairs[0], el = document.getElementById(id);
      if (p && el) el.querySelector(".fi-r").innerHTML = `${fmtUsd(p.marketCap || p.fdv)}<br><small class="hint">lik. ${fmtUsd(p.liquidity && p.liquidity.usd)}</small>`;
    }, 45000);
  }

  // ------------------------------------------------------------------ periyodik: skor, izleme temizliği, tablolar
  function recompute() {
    const now = Date.now();
    const rows = [];
    for (const tok of S.tokens.values()) {
      const sc = PC.score(tok, now);
      S.scores.set(tok.mint, sc.score);
      if (!PC.keepTracking(tok, now, sc)) { untrack(tok.mint); continue; }
      rows.push({ tok, sc });
    }
    // izleme sınırı: en düşük skorlu ve en eski olanları bırak
    if (S.tokens.size > PC.P.maxTracked) {
      rows.sort((a, b) => a.sc.score - b.sc.score || a.tok.lastTradeAt - b.tok.lastTradeAt);
      while (S.tokens.size > PC.P.maxTracked && rows.length) { const r = rows.shift(); if (r.tok.mint !== S.selected) untrack(r.tok.mint); }
    }
    flushSubs();
    if (S.paused) return;
    rows.sort((a, b) => b.sc.score - a.sc.score);
    renderHot(rows, now);
    renderGrad(rows);
    renderStats(rows, now);
    if (S.selected) renderDetail();
  }

  function flagHtml(flags) {
    return flags.map((f) => `<span class="tag ${f.bad ? "block" : "deep"}">${esc(f.txt)}</span>`).join(" ");
  }
  function progBar(p) {
    const v = fin(p) ? Math.round(p * 100) : 0;
    return `<div class="prog" title="bonding curve ≈%${v}"><i style="width:${v}%"></i><span>${fin(p) ? v + "%" : "—"}</span></div>`;
  }

  function renderHot(rows, now) {
    const list = rows.filter((r) => r.tok.buys + r.tok.sells > 0).slice(0, 25);
    $("#hotTable tbody").innerHTML = list.length ? list.map(({ tok, sc }) => {
      const w = sc.w;
      return `<tr data-mint="${esc(tok.mint)}" class="${tok.mint === S.selected ? "sel" : ""}">
        <td class="tok">${avatar(tok.symbol, tok.mint)}<div><b>${esc(tok.symbol)}</b><br><small class="hint">${esc(tok.name)}</small></div></td>
        <td class="r"><span class="chip ${scoreCls(sc.score)}">${sc.score.toFixed(0)}</span></td>
        <td class="r">${fmtMcap(tok.mcapSol)}</td>
        <td>${progBar(tok.progress)}</td>
        <td class="r"><span class="up">${w.buys}</span>/<span class="down">${w.sells}</span></td>
        <td class="r ${w.net >= 0 ? "up" : "down"}">${(w.net >= 0 ? "+" : "") + w.net.toFixed(2)}</td>
        <td class="r">${w.uniqueBuyers}</td>
        <td class="r hint">${age(now - tok.createdAt)}</td>
        <td class="flags">${flagHtml(sc.flags.filter((f) => f.k !== "new"))}</td></tr>`;
    }).join("") : `<tr><td colspan="9" class="empty">Yeni tokenlerde işlem bekleniyor… (ilk sonuçlar 1-2 dakika içinde gelir)</td></tr>`;
  }

  function renderGrad(rows) {
    const list = rows.filter((r) => fin(r.tok.progress) && r.tok.progress >= 0.6).sort((a, b) => b.tok.progress - a.tok.progress).slice(0, 10);
    $("#gradList").innerHTML = list.length ? list.map(({ tok, sc }) => `<div class="gl" data-mint="${esc(tok.mint)}">
      ${avatar(tok.symbol, tok.mint)}<div class="gl-main"><b>${esc(tok.symbol)}</b> <span class="hint">${fmtMcap(tok.mcapSol)}</span>${progBar(tok.progress)}</div>
      <span class="chip ${scoreCls(sc.score)}">${sc.score.toFixed(0)}</span></div>`).join("")
      : `<div class="empty">Eğrisi %60'ı geçen izlenen token yok</div>`;
  }

  function renderStats(rows, now) {
    S.newTimes = S.newTimes.filter((t) => t > now - 300_000);
    const mins = Math.min(5, Math.max(1, (now - startedAt) / 60000));
    $("#stRate").textContent = (S.newTimes.length / mins).toFixed(1);
    S.migrations = S.migrations.filter((m) => m.t > now - 3600_000);
    $("#stMig").textContent = S.migrations.length;
    $("#stTracked").textContent = S.tokens.size;
    let vol = 0;
    for (const tok of S.tokens.values()) for (const tr of tok.trades) if (tr.buy && tr.t > now - 300_000) vol += tr.sol;
    $("#stVol").textContent = fmtSol(vol, 1);
    $("#stVolSub").textContent = fin(S.sol) ? "≈ " + fmtUsd(vol * S.sol) + " · izlenen tokenlerde" : "izlenen tokenlerde";
    const top = rows[0];
    if (top && top.sc.score > 0) { $("#stHot").textContent = top.tok.symbol; $("#stHotSub").textContent = `skor ${top.sc.score.toFixed(0)} · ${fmtMcap(top.tok.mcapSol)}`; }
  }

  // ------------------------------------------------------------------ detay paneli
  let detailTimer = 0;
  function scheduleDetail() { if (!detailTimer) detailTimer = setTimeout(() => { detailTimer = 0; renderDetail(); }, 500); }

  function sparkline(hist) {
    if (!hist || hist.length < 2) return `<div class="spark empty">Fiyat geçmişi birikiyor…</div>`;
    const W = 420, H = 110, xs = hist.map((h) => h[0]), ys = hist.map((h) => h[1]).filter(fin);
    if (ys.length < 2) return `<div class="spark empty">Fiyat geçmişi birikiyor…</div>`;
    const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1, y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pts = hist.filter((h) => fin(h[1])).map((h) => [((h[0] - x0) / Math.max(1, x1 - x0)) * W, H - 6 - ((h[1] - y0) / Math.max(1e-9, y1 - y0)) * (H - 12)]);
    const up = ys[ys.length - 1] >= ys[0], col = up ? "var(--green)" : "var(--red)";
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="piyasa değeri grafiği">
      <path d="${d} L ${W} ${H} L 0 ${H} Z" fill="${col}" opacity=".12"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderDetail() {
    const tok = S.tokens.get(S.selected);
    if (!tok) {
      if (S.selected) { $("#detail").innerHTML = `<div class="empty">Bu token artık izlenmiyor (işlem yok).<br>${links(S.selected)}</div>`; }
      return;
    }
    const now = Date.now(), sc = PC.score(tok, now), w = sc.w;
    $("#dTitle").innerHTML = `${avatar(tok.symbol, tok.mint)} ${esc(tok.symbol)} <span class="hint" style="font-weight:400">${esc(tok.name)}</span>`;
    $("#dHint").textContent = age(now - tok.createdAt) + " önce oluşturuldu";
    const chg = fin(tok.mcapSol0) && tok.mcapSol0 > 0 ? (tok.mcapSol / tok.mcapSol0 - 1) * 100 : NaN;
    const PART = { flow: "Net alım akışı", buyers: "Tekil alıcı", ratio: "Alış oranı", velocity: "Eğri hızı", whale: "Balina alımı" };
    const recent = tok.trades.slice(-12).reverse();
    $("#detail").innerHTML = `
      <div class="d-top">
        <div><label>Piyasa değeri</label><b>${fmtMcap(tok.mcapSol)}</b><small class="${chg >= 0 ? "up" : "down"}">${fmtPct(chg)} başlangıçtan</small></div>
        <div><label>Momentum</label><b><span class="chip ${scoreCls(sc.score)}">${sc.score.toFixed(0)}</span></b><small>0-100</small></div>
        <div><label>Toplam al/sat</label><b><span class="up">${tok.buys}</span>/<span class="down">${tok.sells}</span></b><small>${fmtSol(tok.buySol, 1)} / ${fmtSol(tok.sellSol, 1)}</small></div>
        <div><label>Tekil alıcı</label><b>${tok.buyers.size}</b><small>son 2 dk: ${w.uniqueBuyers}</small></div>
      </div>
      <div class="d-prog"><label>Bonding curve ilerlemesi (≈)</label>${progBar(tok.progress)}</div>
      ${sparkline(tok.history)}
      <div class="d-parts">${Object.entries(sc.parts).map(([k, v]) => `<div class="comp"><span class="up">▲</span><span class="nm">${PART[k]}</span><div class="bar"><i class="${v > 0 ? "p" : "z"}" style="width:${Math.round(v * 100)}%"></i><span>${Math.round(v * 100)}%</span></div></div>`).join("")}</div>
      ${sc.flags.length ? `<div class="d-flags">${flagHtml(sc.flags)}</div>` : ""}
      <div class="d-meta"><span class="hint">Kontrat:</span> <code>${esc(tok.mint)}</code> <button class="btn small" data-copy="${esc(tok.mint)}">Kopyala</button><br>
        <span class="hint">Geliştirici:</span> <code>${esc(short(tok.creator))}</code> · ilk alım ${fmtSol(tok.devBuySol)}${tok.devSold ? ` · <span class="down">${fmtSol(tok.devSoldSol)} sattı</span>` : ""}<br>${links(tok.mint)}</div>
      <h3>Son işlemler</h3>
      <div class="feed mono small">${recent.length ? recent.map((t) => `<div class="wf"><span class="t">${hhmm(t.t)}</span><span class="${t.buy ? "up" : "down"}">${t.buy ? "ALIŞ" : "SATIŞ"}</span><span>${esc(short(t.trader))}${t.trader === tok.creator ? ' <span class="tag block">DEV</span>' : ""}</span><span class="usd ${t.buy ? "up" : "down"}">${t.sol.toFixed(3)} SOL</span></div>`).join("") : '<div class="empty">Henüz işlem yok</div>'}</div>`;
  }

  // ------------------------------------------------------------------ DexScreener
  async function dexJSON(path) {
    const r = await fetch(DEX + path);
    if (!r.ok) throw new Error("DexScreener HTTP " + r.status);
    return r.json();
  }
  async function dexTokens(addrs) {
    const out = [];
    for (let i = 0; i < addrs.length; i += 30) {
      const pairs = await dexJSON("/tokens/v1/solana/" + addrs.slice(i, i + 30).join(","));
      if (Array.isArray(pairs)) out.push(...pairs);
    }
    // token başına en likit çifti tut
    const best = new Map();
    for (const p of out) {
      const a = p.baseToken && p.baseToken.address; if (!a) continue;
      const cur = best.get(a);
      if (!cur || ((p.liquidity && p.liquidity.usd) || 0) > ((cur.liquidity && cur.liquidity.usd) || 0)) best.set(a, p);
    }
    return [...best.values()];
  }
  const isPumpAddr = (a) => typeof a === "string" && /pump$/i.test(a);

  async function loadDex() {
    try {
      const lists = await Promise.allSettled([
        dexJSON("/token-boosts/top/v1"), dexJSON("/token-boosts/latest/v1"), dexJSON("/token-profiles/latest/v1"),
      ]);
      const addrs = new Set();
      for (const l of lists) if (l.status === "fulfilled" && Array.isArray(l.value))
        for (const x of l.value) if (x.chainId === "solana" && isPumpAddr(x.tokenAddress)) addrs.add(x.tokenAddress);
      // izlediğimiz ve DEX'e geçmiş tokenleri de ekle
      for (const m of S.migrations) addrs.add(m.mint);
      const pairs = await dexTokens([...addrs].slice(0, 90));
      S.dexRows = pairs.map((p) => ({ p, ds: PC.dexScore(p) }));
      renderDex();
      $("#dexHint").textContent = `DexScreener · ${S.dexRows.length} pump.fun tokeni · son güncelleme ${hhmm(Date.now())}`;
    } catch (e) {
      console.error(e);
      $("#dexHint").textContent = "DexScreener'a ulaşılamadı, tekrar denenecek";
    }
  }

  function dexVal(r, k) {
    const p = r.p;
    switch (k) {
      case "name": return (p.baseToken && p.baseToken.symbol || "").toLowerCase();
      case "score": return r.ds.score;
      case "price": return +p.priceUsd || 0;
      case "m5": return (p.priceChange && p.priceChange.m5) || 0;
      case "h1": return (p.priceChange && p.priceChange.h1) || 0;
      case "h24": return (p.priceChange && p.priceChange.h24) || 0;
      case "vol": return (p.volume && p.volume.h1) || 0;
      case "liq": return (p.liquidity && p.liquidity.usd) || 0;
      case "mcap": return p.marketCap || p.fdv || 0;
      case "tx": { const t = (p.txns && p.txns.h1) || {}; return (t.buys || 0) + (t.sells || 0); }
      case "age": return -(p.pairCreatedAt || 0);
    }
    return 0;
  }

  function renderDex() {
    const { key, asc } = S.dexSort, now = Date.now();
    const rows = [...S.dexRows].sort((a, b) => { const x = dexVal(a, key), y = dexVal(b, key); return (typeof x === "string" ? x.localeCompare(y) : x - y) * (asc ? 1 : -1); });
    document.querySelectorAll("#dexTable th[data-dsort]").forEach((th) => { th.classList.toggle("sorted", th.dataset.dsort === key); th.classList.toggle("asc", th.dataset.dsort === key && asc); });
    const pc = (x) => `<td class="r ${x >= 0 ? "up" : "down"}">${fmtPct(x)}</td>`;
    $("#dexTable tbody").innerHTML = rows.length ? rows.slice(0, 60).map(({ p, ds }) => {
      const t = (p.txns && p.txns.h1) || {}, ch = p.priceChange || {}, bt = p.baseToken || {};
      const img = p.info && p.info.imageUrl ? `<img class="av" src="${esc(p.info.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : avatar(bt.symbol || "?", bt.address);
      return `<tr>
        <td class="tok">${img}<div><b>${esc(bt.symbol || "?")}</b><br><small class="hint">${esc((bt.name || "").slice(0, 28))} · ${esc(p.dexId || "")}</small></div></td>
        <td class="r"><span class="chip ${scoreCls(ds.score)}">${ds.score.toFixed(0)}</span></td>
        <td class="r">${fmtPrice(+p.priceUsd)}</td>${pc(ch.m5)}${pc(ch.h1)}${pc(ch.h24)}
        <td class="r">${fmtUsd(p.volume && p.volume.h1)}</td><td class="r">${fmtUsd(p.liquidity && p.liquidity.usd)}</td>
        <td class="r">${fmtUsd(p.marketCap || p.fdv)}</td>
        <td class="r"><span class="up">${t.buys || 0}</span>/<span class="down">${t.sells || 0}</span></td>
        <td class="r hint">${p.pairCreatedAt ? age(now - p.pairCreatedAt) : "—"}</td>
        <td><a href="${esc(p.url || "https://dexscreener.com/solana/" + bt.address)}" target="_blank" rel="noopener">aç ↗</a>${ds.flags.length ? " " + ds.flags.map((f) => `<span class="tag block">${esc(f)}</span>`).join(" ") : ""}</td></tr>`;
    }).join("") : `<tr><td colspan="12" class="empty">Şu an listelenecek pump.fun tokeni yok</td></tr>`;
  }

  // ------------------------------------------------------------------ olaylar
  function bind() {
    document.addEventListener("click", (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) { navigator.clipboard && navigator.clipboard.writeText(cp.dataset.copy).then(() => toast("Kontrat adresi kopyalandı")); return; }
      if (e.target.closest("a")) return;
      const th = e.target.closest("th[data-dsort]");
      if (th) { const k = th.dataset.dsort; S.dexSort = { key: k, asc: S.dexSort.key === k ? !S.dexSort.asc : k === "name" }; renderDex(); return; }
      const row = e.target.closest("[data-mint]");
      if (row) {
        S.selected = row.dataset.mint;
        document.querySelectorAll("#hotTable tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.mint === S.selected));
        renderDetail();
        if (window.innerWidth < 860) $(".detail").scrollIntoView({ behavior: "smooth" });
      }
    });
    $("#pauseBtn").addEventListener("click", () => {
      S.paused = !S.paused;
      $("#pauseBtn").textContent = S.paused ? "▶ Devam" : "⏸ Duraklat";
      $("#pauseBtn").classList.toggle("primary", S.paused);
      if (!S.paused) recompute();
    });
  }

  const startedAt = Date.now();
  function start() {
    bind();
    startSol();
    connectPump();
    setInterval(recompute, 2000);
    setInterval(flushSubs, 1500);
    loadDex();
    setInterval(loadDex, 60_000);
  }
  start();
  window.PumpApp = S; // hata ayıklama
})();
