/* FlowBot canlı panel: Binance herkese açık verisi + Flow motoru + tarayıcıda paper bot. */
(() => {
  "use strict";
  const F = window.Flow;
  const CFG = JSON.parse(JSON.stringify(F.DEFAULTS));
  const STORE_KEY = "flowbot.paper.v1";
  const ENDPOINTS = [
    { rest: "https://api.binance.com", ws: "wss://stream.binance.com:9443" },
    { rest: "https://data-api.binance.vision", ws: "wss://data-stream.binance.vision" },
  ];
  const SCAN_EVERY_MS = 60_000;
  const UNIVERSE_EVERY_MS = 10 * 60_000;
  const WHALE_SYMBOLS = 20;
  const COMP_LABEL = {
    volume_spike: "Hacim patlaması", money_flow: "Para akışı", breakout: "Kırılım",
    whale_trades: "Balina", taker_flow: "Alıcı baskısı", orderbook: "Emir defteri",
  };
  const REASON = {
    stop_loss: "stop", trailing_stop: "iz süren stop", breakeven_stop: "başabaş stop",
    take_profit: "kâr al (yarısı)", time_exit: "süre doldu", manual: "elle kapatıldı",
  };

  // ------------------------------------------------------------------ durum
  const S = {
    ep: null,
    tickers: new Map(),     // SYMBOL -> {sym, base, price, open, chg, qv}
    universe: [],           // ["BTCUSDT", ...]
    lastUniverse: 0,
    signals: [],
    scoreBySym: new Map(),
    atrBySym: new Map(),
    flow5m: new Map(),      // SYMBOL -> [{t, buy, cost}] son 5dk tüm işlemler
    whaleNet: new Map(),    // SYMBOL -> [{t, signed}] son 15dk balina işlemleri
    selected: "BTCUSDT",
    sort: { key: "qv", asc: false },
    scanning: false,
    nextScanAt: 0,
    bot: loadBot(),
  };

  // ------------------------------------------------------------------ yardımcılar
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pretty = (sym) => sym.replace(/USDT$/, "/USDT");
  const base = (sym) => sym.replace(/USDT$/, "");
  function fmtPx(x) {
    if (!isFinite(x)) return "—";
    const a = Math.abs(x);
    const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : a >= 0.0001 ? 7 : 9;
    return x.toLocaleString("en-US", { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  }
  const fmtUsd = (x, d = 2) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtSigned = (x) => (x >= 0 ? "+" : "-") + "$" + Math.abs(x).toFixed(2);
  function fmtBig(x) {
    if (x >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
    if (x >= 1e3) return "$" + (x / 1e3).toFixed(0) + "K";
    return "$" + x.toFixed(0);
  }
  const fmtPct = (x) => (x >= 0 ? "+" : "") + x.toFixed(2) + "%";
  const hhmm = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const scoreCls = (s) => (s >= CFG.filters.min_score ? "hi" : s >= CFG.filters.min_score * 0.6 ? "mid" : "");

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  async function fetchJSON(path, timeout = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(S.ep.rest + path, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } }
    });
    await Promise.all(workers);
    return out;
  }

  function setConn(state, text) {
    const el = $("#conn");
    el.className = "pill " + state;
    el.querySelector("span").textContent = text;
  }

  // ------------------------------------------------------------------ bağlantı
  async function pickEndpoint() {
    for (const ep of ENDPOINTS) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(ep.rest + "/api/v3/ping", { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) return ep;
      } catch (e) { /* sonraki */ }
    }
    throw new Error("Binance'e ulaşılamadı");
  }

  async function loadUniverse() {
    const all = await fetchJSON("/api/v3/ticker/24hr?type=MINI", 20000).catch(() => fetchJSON("/api/v3/ticker/24hr", 20000));
    for (const t of all) {
      if (!t.symbol.endsWith("USDT")) continue;
      const price = +t.lastPrice, open = +t.openPrice;
      S.tickers.set(t.symbol, { sym: t.symbol, base: base(t.symbol), price, open, chg: open ? (price / open - 1) * 100 : 0, qv: +t.quoteVolume });
    }
    S.universe = [...S.tickers.values()]
      .filter((t) => t.qv >= CFG.minQuoteVol && t.price > 0 && F.isTradableBase(t.base, CFG))
      .sort((a, b) => b.qv - a.qv).slice(0, CFG.topN).map((t) => t.sym);
    S.lastUniverse = Date.now();
    $("#uniCount").textContent = S.universe.length;
    buildMarketTable();
    renderStrip();
    connectWhales();
  }

  // ------------------------------------------------------------------ WebSocket'ler
  function openWS(path, onMsg, name) {
    let ws, retry = 0, closedByUs = false;
    const connect = () => {
      ws = new WebSocket(S.ep.ws + path);
      ws.onopen = () => { retry = 0; if (name === "ticker") setConn("ok", "canlı"); };
      ws.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch (e) { /* yoksay */ } };
      ws.onclose = () => {
        if (closedByUs) return;
        if (name === "ticker") setConn("bad", "yeniden bağlanıyor…");
        setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return { close: () => { closedByUs = true; ws && ws.close(); } };
  }

  let lastManage = 0;
  function onMiniTickers(arr) {
    const data = Array.isArray(arr) ? arr : arr.data;
    if (!Array.isArray(data)) return;
    const now = Date.now();
    for (const m of data) {
      if (!m.s.endsWith("USDT")) continue;
      const price = +m.c, open = +m.o;
      const prev = S.tickers.get(m.s);
      const t = { sym: m.s, base: base(m.s), price, open, chg: open ? (price / open - 1) * 100 : 0, qv: +m.q };
      S.tickers.set(m.s, t);
      if (prev) updateMarketRow(t, prev.price);
    }
    renderStrip();
    if (now - lastManage > 1000) { lastManage = now; manageBot(); renderBot(); }
  }

  let whaleWS = null;
  function connectWhales() {
    if (whaleWS) whaleWS.close();
    const syms = S.universe.slice(0, WHALE_SYMBOLS);
    if (!syms.length) return;
    const streams = syms.map((s) => s.toLowerCase() + "@aggTrade").join("/");
    whaleWS = openWS("/stream?streams=" + streams, (msg) => onAggTrade(msg.data || msg), "whale");
  }

  function whaleThreshold(sym) {
    const t = S.tickers.get(sym);
    return Math.max(25000, (t ? t.qv : 0) * 4e-5);
  }

  function onAggTrade(d) {
    if (!d || !d.s) return;
    const px = +d.p, cost = px * +d.q, buy = !d.m, now = d.T || Date.now();
    // son 5 dk alıcı oranı
    let f = S.flow5m.get(d.s); if (!f) S.flow5m.set(d.s, (f = []));
    f.push({ t: now, buy, cost });
    while (f.length && f[0].t < now - 300_000) f.shift();
    if (cost < whaleThreshold(d.s)) return;
    let w = S.whaleNet.get(d.s); if (!w) S.whaleNet.set(d.s, (w = []));
    w.push({ t: now, signed: buy ? cost : -cost });
    addWhale(d.s, buy, px, cost, now);
  }

  const buyRatio = (sym) => {
    const f = S.flow5m.get(sym);
    if (!f || f.length < 10) return NaN;
    let b = 0, t = 0;
    for (const x of f) { t += x.cost; if (x.buy) b += x.cost; }
    return t ? (b / t) * 100 : NaN;
  };

  // ------------------------------------------------------------------ tarama
  const parseKlines = (raw) => {
    const now = Date.now();
    const rows = raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] }));
    if (rows.length && rows[rows.length - 1].ct > now) rows.pop(); // kapanmamış mum
    return rows;
  };

  async function scan() {
    if (S.scanning || !S.universe.length) return;
    S.scanning = true;
    $("#scanNow").disabled = true;
    const t0 = performance.now();
    try {
      if (Date.now() - S.lastUniverse > UNIVERSE_EVERY_MS) await loadUniverse();
      const d = CFG.detectors;
      let done = 0;
      const res = await pool(S.universe, 8, async (sym) => {
        const raw = await fetchJSON(`/api/v3/klines?symbol=${sym}&interval=${CFG.timeframe}&limit=${CFG.historyBars + 1}`);
        $("#scanInfo").textContent = `taranıyor ${++done}/${S.universe.length}`;
        const candles = parseKlines(raw);
        if (candles.length < d.volume_spike.lookback + 5) return null;
        const rows = F.computeFeatures(candles, CFG);
        const row = rows[rows.length - 1];
        const comps = F.cheapComponents(row, CFG);
        S.atrBySym.set(sym, row.atr);
        return { sym, row, comps, score: F.combine(comps, CFG), deep: false, blocked: [] };
      });
      const cands = res.filter(Boolean).sort((a, b) => b.score - a.score);

      // derin analiz: en iyi K aday
      const top = cands.slice(0, d.deep_check_top_k).filter((c) => c.score > 15);
      await pool(top, 4, async (c) => {
        const [trades, ob] = await Promise.all([
          fetchJSON(`/api/v3/trades?symbol=${c.sym}&limit=${d.whale_trades.trades_limit}`),
          fetchJSON(`/api/v3/depth?symbol=${c.sym}&limit=${d.orderbook.limit}`),
        ]);
        const tr = trades.map((t) => ({ side: t.isBuyerMaker ? "sell" : "buy", cost: +t.quoteQty || +t.price * +t.qty }));
        const obc = F.orderbook(ob, d.orderbook);
        c.comps.push(F.whaleTrades(tr, d.whale_trades), F.takerFlow(tr, d.taker_flow), obc);
        c.score = F.combine(c.comps, CFG);
        c.deep = true;
        c.spread = obc.data.spread_pct;
      });
      for (const c of cands) c.blocked = F.applyFilters(c.row, CFG, c.deep ? c.spread : null);
      cands.sort((a, b) => b.score - a.score);
      S.signals = cands;
      S.scoreBySym = new Map(cands.map((c) => [c.sym, c.score]));
      renderSignals();
      refreshScores();
      notifyNewSignals(cands);
      if (S.bot.running) botEnter(cands);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      $("#scanInfo").textContent = `son tarama ${hhmm(Date.now())} · ${secs}sn`;
    } catch (e) {
      console.error(e);
      $("#scanInfo").textContent = "tarama hatası, tekrar denenecek";
    } finally {
      S.scanning = false;
      $("#scanNow").disabled = false;
      S.nextScanAt = Date.now() + SCAN_EVERY_MS;
    }
  }

  const alerted = new Map();
  function notifyNewSignals(cands) {
    const now = Date.now();
    for (const c of cands) {
      if (c.score < CFG.filters.min_score || c.blocked.length) continue;
      if (now - (alerted.get(c.sym) || 0) < 3600_000) continue;
      alerted.set(c.sym, now);
      toast(`🚨 <b>${pretty(c.sym)}</b> para akışı sinyali · skor <b>${c.score.toFixed(0)}</b>`, "good");
      if (window.Notification && Notification.permission === "granted") {
        try { new Notification(`FlowBot: ${pretty(c.sym)} skor ${c.score.toFixed(0)}`, { body: c.comps.filter((x) => x.direction > 0).map((x) => COMP_LABEL[x.name]).join(", ") }); } catch (e) { /* */ }
      }
    }
  }

  // ------------------------------------------------------------------ render: sinyaller
  function renderSignals() {
    const list = S.signals.filter((s) => s.score >= 20).slice(0, 12);
    const el = $("#signals");
    if (!list.length) {
      el.innerHTML = `<div class="empty">Şu an güçlü para girişi yok. Piyasa sakin — bot bekliyor.<br><small>Her dakika yeniden taranıyor.</small></div>`;
      return;
    }
    el.innerHTML = list.map((s) => {
      const actionable = s.score >= CFG.filters.min_score && !s.blocked.length;
      const comps = s.comps.map((c) => {
        const w = Math.round(c.score * 100);
        const cls = c.direction > 0 ? "p" : c.direction < 0 ? "n" : "z";
        const arrow = c.direction > 0 ? '<span class="up">▲</span>' : c.direction < 0 ? '<span class="down">▼</span>' : '<span class="hint">•</span>';
        return `<div class="comp">${arrow}<span class="nm">${COMP_LABEL[c.name]}</span><div class="bar" title="${esc(c.detail)}"><i class="${cls}" style="width:${w}%"></i><span>${esc(c.detail)}</span></div></div>`;
      }).join("");
      const t = S.tickers.get(s.sym);
      return `<div class="sig ${actionable ? "buy" : ""}" data-sym="${s.sym}">
        <div class="sig-h">
          <span class="sym">${pretty(s.sym)}</span>
          <span class="px">${fmtPx(t ? t.price : s.row.close)}${t ? ` · <span class="${t.chg >= 0 ? "up" : "down"}">${fmtPct(t.chg)}</span>` : ""}</span>
          ${actionable ? '<span class="tag buy">AL</span>' : ""}${s.blocked.length ? '<span class="tag block">filtre</span>' : ""}${s.deep ? '<span class="tag deep">derin</span>' : ""}
          <span class="score ${scoreCls(s.score)}">${s.score.toFixed(0)}</span>
        </div>
        ${comps}
        ${s.blocked.length ? `<div class="blocked">⛔ ${esc(s.blocked.join(" · "))}</div>` : ""}
      </div>`;
    }).join("");
  }

  // ------------------------------------------------------------------ render: piyasa tablosu
  function marketVal(t, key) {
    switch (key) {
      case "sym": return t.sym;
      case "price": return t.price;
      case "chg": return t.chg;
      case "qv": return t.qv;
      case "buy": return num(buyRatio(t.sym), -1);
      case "score": return num(S.scoreBySym.get(t.sym), -1);
    }
  }
  const num = (x, d) => (isFinite(x) ? x : d);

  function buildMarketTable() {
    const q = $("#search").value.trim().toUpperCase();
    const rows = S.universe.map((s) => S.tickers.get(s)).filter((t) => t && (!q || t.sym.includes(q)));
    const { key, asc } = S.sort;
    rows.sort((a, b) => {
      const x = marketVal(a, key), y = marketVal(b, key);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * (asc ? 1 : -1);
    });
    document.querySelectorAll("#marketTable th").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === key);
      th.classList.toggle("asc", th.dataset.sort === key && asc);
    });
    $("#marketTable tbody").innerHTML = rows.map((t) => {
      const sc = S.scoreBySym.get(t.sym), br = buyRatio(t.sym);
      return `<tr data-sym="${t.sym}" class="${t.sym === S.selected ? "sel" : ""}">
        <td><b>${t.base}</b><span class="hint">/USDT</span></td>
        <td class="r" data-f="price">${fmtPx(t.price)}</td>
        <td class="r ${t.chg >= 0 ? "up" : "down"}" data-f="chg">${fmtPct(t.chg)}</td>
        <td class="r" data-f="qv">${fmtBig(t.qv)}</td>
        <td class="r ${br >= 55 ? "up" : br <= 45 ? "down" : ""}" data-f="buy">${isFinite(br) ? br.toFixed(0) + "%" : "—"}</td>
        <td class="r" data-f="score">${sc != null ? `<span class="chip ${scoreCls(sc)}">${sc.toFixed(0)}</span>` : "—"}</td>
      </tr>`;
    }).join("");
  }

  function updateMarketRow(t, prevPrice) {
    const tr = document.querySelector(`#marketTable tr[data-sym="${t.sym}"]`);
    if (!tr) return;
    const p = tr.querySelector('[data-f="price"]');
    if (t.price !== prevPrice) {
      p.textContent = fmtPx(t.price);
      p.classList.remove("flash-up", "flash-down");
      void p.offsetWidth;
      p.classList.add(t.price > prevPrice ? "flash-up" : "flash-down");
    }
    const c = tr.querySelector('[data-f="chg"]');
    c.textContent = fmtPct(t.chg);
    c.className = "r " + (t.chg >= 0 ? "up" : "down");
    tr.querySelector('[data-f="qv"]').textContent = fmtBig(t.qv);
    const br = buyRatio(t.sym), b = tr.querySelector('[data-f="buy"]');
    b.textContent = isFinite(br) ? br.toFixed(0) + "%" : "—";
    b.className = "r " + (br >= 55 ? "up" : br <= 45 ? "down" : "");
  }
  const refreshScores = () => buildMarketTable();

  function renderStrip() {
    const now = Date.now();
    if (renderStrip.last && now - renderStrip.last < 1000) return;
    renderStrip.last = now;
    const pick = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
    const movers = S.universe.map((s) => S.tickers.get(s)).filter(Boolean).sort((a, b) => b.chg - a.chg);
    const items = [...pick.map((s) => S.tickers.get(s)).filter(Boolean), ...movers.slice(0, 4), ...movers.slice(-3)];
    const seen = new Set();
    $("#strip").innerHTML = items.filter((t) => !seen.has(t.sym) && seen.add(t.sym)).map((t) =>
      `<div class="strip-item" data-sym="${t.sym}"><b>${t.base}</b><span>${fmtPx(t.price)}</span><span class="${t.chg >= 0 ? "up" : "down"}">${fmtPct(t.chg)}</span></div>`
    ).join("");
  }

  // ------------------------------------------------------------------ render: balinalar
  function addWhale(sym, buy, px, cost, t) {
    const feed = $("#whaleFeed");
    if (feed.firstElementChild && feed.firstElementChild.classList.contains("empty")) feed.innerHTML = "";
    const el = document.createElement("div");
    el.className = "wf" + (cost >= 250000 ? " big" : "");
    el.dataset.sym = sym;
    el.innerHTML = `<span class="t">${hhmm(t)}</span><b>${base(sym)}</b><span class="${buy ? "up" : "down"}">${buy ? "ALIŞ ▲" : "SATIŞ ▼"} @ ${fmtPx(px)}</span><span class="usd ${buy ? "up" : "down"}">${fmtBig(cost)}</span>`;
    feed.prepend(el);
    while (feed.children.length > 80) feed.lastElementChild.remove();
    renderWhaleBoard();
  }

  function renderWhaleBoard() {
    const now = Date.now();
    if (renderWhaleBoard.last && now - renderWhaleBoard.last < 1500) return;
    renderWhaleBoard.last = now;
    const rows = [];
    for (const [sym, arr] of S.whaleNet) {
      while (arr.length && arr[0].t < now - 900_000) arr.shift();
      if (!arr.length) continue;
      let net = 0, gross = 0;
      for (const x of arr) { net += x.signed; gross += Math.abs(x.signed); }
      rows.push({ sym, net, gross });
    }
    rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    const top = rows.slice(0, 6);
    const max = Math.max(1, ...top.map((r) => Math.abs(r.net)));
    $("#whaleBoard").innerHTML = top.length
      ? `<div class="hint" style="margin-bottom:2px">Son 15 dk balina net akışı</div>` + top.map((r) => {
          const w = (Math.abs(r.net) / max) * 50;
          return `<div class="wb-row" data-sym="${r.sym}"><b>${base(r.sym)}</b><div class="wb-bar"><i class="${r.net >= 0 ? "b" : "s"}" style="width:${w}%"></i></div><span class="r ${r.net >= 0 ? "up" : "down"}">${r.net >= 0 ? "+" : "-"}${fmtBig(Math.abs(r.net))}</span></div>`;
        }).join("")
      : "";
  }

  // ------------------------------------------------------------------ grafik
  let chart, candleSeries, volSeries, klineWS, priceLines = [];
  function initChart() {
    if (!window.LightweightCharts) { $("#chart").innerHTML = '<div class="empty">Grafik kütüphanesi yüklenemedi</div>'; return; }
    chart = LightweightCharts.createChart($("#chart"), {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#7d8a99", fontSize: 11 },
      grid: { vertLines: { color: "#161e28" }, horzLines: { color: "#161e28" } },
      rightPriceScale: { borderColor: "#1e2834" },
      timeScale: { borderColor: "#1e2834", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { locale: "tr-TR" },
    });
    candleSeries = chart.addCandlestickSeries({ upColor: "#22d3a6", downColor: "#f6465d", wickUpColor: "#22d3a6", wickDownColor: "#f6465d", borderVisible: false });
    volSeries = chart.addHistogramSeries({ priceScaleId: "", priceFormat: { type: "volume" } });
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  }

  async function selectSymbol(sym) {
    S.selected = sym;
    document.querySelectorAll("#marketTable tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.sym === sym));
    $("#chartTitle").textContent = pretty(sym);
    const sig = S.signals.find((s) => s.sym === sym);
    $("#chartHint").textContent = sig ? `akış skoru ${sig.score.toFixed(0)} · 15dk` : "15dk mumlar";
    if (!chart) return;
    try {
      const raw = await fetchJSON(`/api/v3/klines?symbol=${sym}&interval=${CFG.timeframe}&limit=300`);
      if (S.selected !== sym) return;
      const rows = raw.map((k) => ({ t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      candleSeries.setData(rows.map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c })));
      volSeries.setData(rows.map((r) => ({ time: r.t, value: r.v * r.c, color: r.c >= r.o ? "rgba(34,211,166,.35)" : "rgba(246,70,93,.35)" })));
      const p = rows.length ? rows[rows.length - 1].c : 1;
      const prec = p >= 1000 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 8;
      candleSeries.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
      chart.timeScale().fitContent();
      drawPositionLines();
    } catch (e) { console.error(e); }
    if (klineWS) klineWS.close();
    klineWS = openWS(`/ws/${sym.toLowerCase()}@kline_${CFG.timeframe}`, (m) => {
      const k = m.k; if (!k || m.s !== S.selected) return;
      const t = k.t / 1000;
      candleSeries.update({ time: t, open: +k.o, high: +k.h, low: +k.l, close: +k.c });
      volSeries.update({ time: t, value: +k.q, color: +k.c >= +k.o ? "rgba(34,211,166,.35)" : "rgba(246,70,93,.35)" });
    }, "kline");
  }

  function drawPositionLines() {
    if (!candleSeries) return;
    priceLines.forEach((l) => candleSeries.removePriceLine(l));
    priceLines = [];
    const pos = S.bot.positions[S.selected];
    if (!pos) return;
    const add = (price, color, title) => priceLines.push(candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    add(pos.entry, "#4f9cff", "Giriş");
    add(pos.stop, "#f6465d", "Stop");
    if (!pos.tp_hit) add(pos.take_profit, "#22d3a6", "Hedef");
  }

  // ------------------------------------------------------------------ paper bot
  function freshBot(settings) {
    const st = settings || { min_score: 60, risk_pct: 1, equity: 1000, max_pos: 4 };
    return { running: false, cash: st.equity, positions: {}, history: [], lastExit: {}, dayKey: "", dayStart: st.equity, realized: 0, wins: 0, losses: 0, settings: st };
  }
  function loadBot() {
    try { const b = JSON.parse(localStorage.getItem(STORE_KEY)); if (b && b.settings) return b; } catch (e) { /* */ }
    return freshBot();
  }
  function saveBot() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S.bot)); } catch (e) { /* */ } }
  function applySettings() {
    const st = S.bot.settings;
    CFG.filters.min_score = st.min_score;
    CFG.risk.risk_per_trade_pct = st.risk_pct;
    CFG.risk.max_open_positions = st.max_pos;
    $("#minScoreLbl").textContent = st.min_score;
    $("#stBotSub").textContent = `sinyal eşiği ${st.min_score} · risk %${st.risk_pct}`;
    $("#stOpenSub").textContent = `max ${st.max_pos}`;
    $("#setMinScore").value = st.min_score; $("#setRisk").value = st.risk_pct;
    $("#setEquity").value = st.equity; $("#setMaxPos").value = st.max_pos;
  }
  const priceOf = (sym) => (S.tickers.get(sym) || {}).price;
  function equity() {
    let e = S.bot.cash;
    for (const [s, p] of Object.entries(S.bot.positions)) e += p.qty * (priceOf(s) || p.entry);
    return e;
  }
  const dayKey = () => new Date().toISOString().slice(0, 10);

  function botEnter(cands) {
    const b = S.bot, now = Date.now() / 1000;
    const eq = equity();
    if (b.dayKey !== dayKey()) { b.dayKey = dayKey(); b.dayStart = eq; }
    for (const c of cands) {
      if (c.score < CFG.filters.min_score || c.blocked.length) continue;
      const [ok, why] = F.canOpen(CFG, Object.keys(b.positions).length, !!b.positions[c.sym], b.lastExit[c.sym], now, eq, b.dayStart);
      if (!ok) continue;
      const live = priceOf(c.sym) || c.row.close;
      if (live > c.row.close + c.row.atr) { continue; } // sinyalden sonra fazla kaçmış
      const { stop, tp } = F.planLevels(live, c.row.atr, CFG.risk);
      const [qty] = F.positionSize(CFG, eq, b.cash, live, stop);
      if (qty <= 0) continue;
      const px = live * (1 + CFG.fees.slippage_pct / 100);
      const fee = px * qty * CFG.fees.taker_pct / 100;
      b.cash -= px * qty + fee;
      b.positions[c.sym] = { symbol: c.sym, entry: px, qty, initial_qty: qty, stop, initial_stop: stop, take_profit: tp, atr: c.row.atr, opened_at: now, highest: px, tp_hit: false, fees: fee, score: c.score, realized: 0 };
      b.history.unshift({ t: Date.now(), sym: c.sym, side: "AL", px, qty, pnl: null, reason: `skor ${c.score.toFixed(0)}` });
      toast(`🟢 Bot <b>${pretty(c.sym)}</b> aldı @ ${fmtPx(px)} · stop ${fmtPx(stop)} · hedef ${fmtPx(tp)}`, "good");
    }
    trimHistory(); saveBot(); renderBot(); drawPositionLines();
  }

  function botClose(sym, fraction, refPx, reason) {
    const b = S.bot, pos = b.positions[sym];
    if (!pos) return;
    const qty = fraction >= 1 ? pos.qty : pos.qty * fraction;
    const px = refPx * (1 - CFG.fees.slippage_pct / 100);
    const fee = px * qty * CFG.fees.taker_pct / 100;
    const pnl = (px - pos.entry) * qty - fee - pos.fees * (qty / pos.initial_qty);
    b.cash += px * qty - fee;
    pos.qty -= qty; pos.realized += pnl;
    b.realized += pnl;
    b.history.unshift({ t: Date.now(), sym, side: "SAT", px, qty, pnl, reason: REASON[reason] || reason });
    if (fraction >= 1 || pos.qty * px < 1) {
      if (pos.realized > 0) b.wins++; else b.losses++;
      delete b.positions[sym];
      b.lastExit[sym] = Date.now() / 1000;
    }
    toast(`${pnl >= 0 ? "✅" : "🔴"} Bot <b>${pretty(sym)}</b> sattı (${REASON[reason] || reason}) ${fmtSigned(pnl)}`, pnl >= 0 ? "good" : "bad");
    trimHistory(); saveBot(); drawPositionLines();
  }
  const trimHistory = () => { if (S.bot.history.length > 200) S.bot.history.length = 200; };

  function manageBot() {
    const b = S.bot, now = Date.now() / 1000;
    for (const sym of Object.keys(b.positions)) {
      const pos = b.positions[sym], p = priceOf(sym);
      if (!p) continue;
      const atrNow = S.atrBySym.get(sym) || pos.atr;
      const acts = F.manage(pos, p, p, p, p, atrNow, now, CFG.risk);
      for (const [kind, , reason] of acts) {
        if (!b.positions[sym]) break;
        botClose(sym, kind === "partial" ? CFG.risk.partial_tp_fraction : 1, p, reason);
      }
    }
    saveBot();
  }

  function renderBot() {
    const b = S.bot, eq = equity();
    const total = eq - b.settings.equity;
    const day = b.dayStart ? eq - b.dayStart : 0;
    $("#stEquity").textContent = fmtUsd(eq);
    $("#stEquitySub").textContent = `nakit ${fmtUsd(b.cash)}`;
    const setPnl = (el, v) => { el.textContent = fmtSigned(v); el.className = v > 0 ? "up" : v < 0 ? "down" : ""; };
    setPnl($("#stDay"), day);
    $("#stDaySub").textContent = b.dayStart ? fmtPct((day / b.dayStart) * 100) : " ";
    setPnl($("#stTotal"), total);
    const n = b.wins + b.losses;
    $("#stWin").textContent = n ? `${n} işlem · kazanma %${((b.wins / n) * 100).toFixed(0)}` : "henüz kapanan işlem yok";
    $("#stOpen").textContent = Object.keys(b.positions).length;
    $("#stBot").textContent = b.running ? "Çalışıyor" : "Kapalı";
    $("#stBot").className = b.running ? "up" : "";
    const btn = $("#botToggle");
    btn.textContent = b.running ? "■ Botu Durdur" : "▶ Botu Başlat";
    btn.classList.toggle("running", b.running);

    const pos = Object.values(b.positions);
    $("#posTable tbody").innerHTML = pos.length ? pos.map((p) => {
      const px = priceOf(p.symbol) || p.entry;
      const upnl = (px - p.entry) * p.qty;
      const pct = (px / p.entry - 1) * 100;
      return `<tr data-sym="${p.symbol}"><td><b>${base(p.symbol)}</b></td><td class="r">${fmtPx(p.entry)}</td><td class="r">${fmtPx(px)}</td>
        <td class="r down">${fmtPx(p.stop)}</td><td class="r up">${p.tp_hit ? "iz süren" : fmtPx(p.take_profit)}</td>
        <td class="r ${upnl >= 0 ? "up" : "down"}">${fmtSigned(upnl)} <small>(${fmtPct(pct)})</small></td>
        <td class="r"><button class="btn small" data-close="${p.symbol}">Kapat</button></td></tr>`;
    }).join("") : `<tr><td colspan="7" class="hint" style="text-align:center;padding:14px">${b.running ? "Sinyal bekleniyor…" : "Bot kapalı. Başlatınca skor eşiğini geçen coinlerde sanal pozisyon açar."}</td></tr>`;

    $("#histTable tbody").innerHTML = b.history.length ? b.history.slice(0, 60).map((h) => `<tr data-sym="${h.sym}">
      <td class="hint">${new Date(h.t).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
      <td><b>${base(h.sym)}</b></td><td class="${h.side === "AL" ? "up" : "down"}">${h.side}</td><td class="r">${fmtPx(h.px)}</td>
      <td class="r ${h.pnl == null ? "" : h.pnl >= 0 ? "up" : "down"}">${h.pnl == null ? "" : fmtSigned(h.pnl)}</td><td class="hint">${esc(h.reason)}</td></tr>`).join("")
      : `<tr><td colspan="6" class="hint" style="text-align:center;padding:14px">Henüz işlem yok</td></tr>`;
  }

  // ------------------------------------------------------------------ olaylar
  function bindEvents() {
    document.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close]");
      if (close) { e.stopPropagation(); const s = close.dataset.close; const p = priceOf(s); if (p) { botClose(s, 1, p, "manual"); renderBot(); } return; }
      const th = e.target.closest("th[data-sort]");
      if (th) {
        const k = th.dataset.sort;
        S.sort = { key: k, asc: S.sort.key === k ? !S.sort.asc : k === "sym" };
        buildMarketTable(); return;
      }
      const row = e.target.closest("[data-sym]");
      if (row) selectSymbol(row.dataset.sym);
    });
    $("#search").addEventListener("input", buildMarketTable);
    $("#scanNow").addEventListener("click", () => scan());
    $("#botToggle").addEventListener("click", () => {
      S.bot.running = !S.bot.running;
      if (S.bot.running && !S.bot.dayKey) { S.bot.dayKey = dayKey(); S.bot.dayStart = equity(); }
      saveBot(); renderBot();
      toast(S.bot.running ? "▶ Paper bot başladı. Skor eşiğini geçen ve filtrelere takılmayan coinlerde sanal pozisyon açacak." : "■ Bot durduruldu. Açık pozisyonlar korunuyor, stop/hedef takibi devam ediyor.");
      if (S.bot.running) {
        if (window.Notification && Notification.permission === "default") Notification.requestPermission();
        if (S.signals.length) botEnter(S.signals);
      }
    });
    $("#saveSettings").addEventListener("click", () => {
      const st = S.bot.settings;
      st.min_score = Math.min(95, Math.max(20, +$("#setMinScore").value || 60));
      st.risk_pct = Math.min(5, Math.max(0.1, +$("#setRisk").value || 1));
      st.max_pos = Math.min(10, Math.max(1, Math.round(+$("#setMaxPos").value || 4)));
      const newEq = Math.max(50, +$("#setEquity").value || 1000);
      if (newEq !== st.equity && !Object.keys(S.bot.positions).length && !S.bot.history.length) { st.equity = newEq; S.bot.cash = newEq; S.bot.dayStart = newEq; }
      saveBot(); applySettings(); renderSignals(); buildMarketTable(); renderBot();
      toast("Ayarlar kaydedildi");
    });
    $("#resetBot").addEventListener("click", () => {
      if (!confirm("Paper hesap, açık pozisyonlar ve geçmiş silinecek. Emin misin?")) return;
      const st = S.bot.settings;
      st.equity = Math.max(50, +$("#setEquity").value || st.equity);
      S.bot = freshBot(st);
      saveBot(); applySettings(); renderBot(); drawPositionLines();
      toast("Paper hesap sıfırlandı");
    });
  }

  function tick() {
    if (!S.scanning && S.nextScanAt && Date.now() >= S.nextScanAt) scan();
    if (!S.scanning && S.nextScanAt) {
      const s = Math.max(0, Math.round((S.nextScanAt - Date.now()) / 1000));
      const el = $("#scanInfo");
      el.textContent = el.textContent.replace(/ · sonraki \d+sn$/, "") + ` · sonraki ${s}sn`;
    }
  }

  // ------------------------------------------------------------------ başlat
  function start() {
    applySettings();
    renderBot();
    bindEvents();
    initChart();
    connect();
  }
  async function connect() {
    try {
      S.ep = await pickEndpoint();
      setConn("", "veri yükleniyor…");
      await loadUniverse();
      openWS("/ws/!miniTicker@arr", onMiniTickers, "ticker");
      selectSymbol(S.selected);
      await scan();
      setInterval(tick, 1000);
    } catch (e) {
      console.error(e);
      setConn("bad", "bağlantı yok");
      $("#signals").innerHTML = `<div class="empty">Binance verisine ulaşılamadı.<br><small>${esc(e.message)}. Ağınız Binance'i engelliyor olabilir; VPN deneyin veya sayfayı yenileyin.</small></div>`;
      setTimeout(connect, 30000);
    }
  }
  start();
  window.FlowBotApp = S; // hata ayıklama için (konsoldan durum incelenebilir)
  S._debug = { CFG, botEnter, manageBot, renderBot, scan };
})();
