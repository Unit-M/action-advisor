import { getState, update, onChange, uid, upsertAsset, computePositions, exportJSON, importJSON, purgeCache, DEFAULT_SETTINGS, AI_MODELS, aiMissing } from "./store.js";
import { searchSymbols, getCandles, getNews, cachedCandles, cachedNews, getFx, cachedFx, dataReady, getSeries, PERIODS, getFxSeries, cachedFxSeries } from "./data.js";
import { portfolioHistory, summarize } from "./history.js";
import { advise, ACTIONS } from "./advisor.js";
import { scoreHeadline } from "./sentiment.js";
import { sma } from "./indicators.js";
import { t, LANGS, locale, applyDocumentLang, lang } from "./i18n.js";
import { TERMS, SECTIONS, COURSE } from "./guide.js";

// ---------- utilitaires ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (x, d = 2) => (x == null || !isFinite(x) ? "—" : x.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }));
// quantités : au plus 2 décimales (1,04 ; 9 ; 11,67)
const qtyTxt = (x) => (x == null || !isFinite(x) ? "—" : x.toLocaleString(locale(), { maximumFractionDigits: 2 }));
const money = (x, cur = "EUR") => {
  if (x == null || !isFinite(x)) return "—";
  try { return x.toLocaleString(locale(), { style: "currency", currency: cur || "EUR", maximumFractionDigits: 2 }); } catch { return num(x) + " " + (cur || ""); }
};
const pctTxt = (x) => (x == null || !isFinite(x) ? "—" : (x >= 0 ? "+" : "") + num(x * 100, 1) + " %");
const tone = (x) => (x > 0 ? "good" : x < 0 ? "bad" : "neutral");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return t("now");
  if (m < 60) return t("agoMin", { n: m });
  const h = Math.round(m / 60);
  return h < 48 ? t("agoH", { n: h }) : t("agoD", { n: Math.round(h / 24) });
};
const actLabel = (action) => t("act_" + action);
const decLabel = (d) => (d ? t("dec_" + d) : "");

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  // une boîte de dialogue ouverte passe au-dessus de tout : on y place alors le message
  const dlg = [...document.querySelectorAll("dialog[open]")].pop();
  let host = $("#toasts");
  if (dlg) {
    host = dlg.querySelector(".toasts");
    if (!host) { host = document.createElement("div"); host.className = "toasts"; dlg.append(host); }
  }
  host.append(el);
  setTimeout(() => el.remove(), 4500);
}

// Charge cours (+ devise) et actus d'une ligne
const loadErrors = {}; // id -> dernière erreur de chargement des cours (affichée sur la fiche)
async function loadAsset(asset, force = false) {
  let res;
  try {
    res = await getCandles(asset, { force });
    if (res.error) loadErrors[asset.id] = res.error; else delete loadErrors[asset.id];
  } catch (e) {
    loadErrors[asset.id] = e.message;
    throw e;
  }
  if (res.currency && res.currency !== asset.currency) {
    update((s) => { if (s.assets[asset.id]) s.assets[asset.id].currency = res.currency; });
    asset = getState().assets[asset.id];
    await getFx(asset.currency, getState().settings.baseCurrency);
  }
  // actualités en arrière-plan (GDELT est lent : 1 requête / 5 s), sans bloquer l'affichage
  getNews(getState().assets[asset.id] || asset).then(() => render()).catch(() => {});
  return res;
}

// ---------- calcul du tableau de bord (100 % local) ----------
let view = { tab: "portfolio", detail: null, chartPeriod: "6M", pfPeriod: "1M" };
let busy = false;

// ---------- comptes (Revolut, PEA…) ----------
const accounts = () => getState().accounts;
const accName = (a) => a?.name || t("mainAccount");
const acctOf = (x) => x.accountId || accounts()[0].id;
const viewAcc = () => { const v = getState().settings.viewAccount; return v && accounts().some((a) => a.id === v) ? v : "all"; };
const visibleTx = () => { const v = viewAcc(); return v === "all" ? getState().transactions : getState().transactions.filter((x) => acctOf(x) === v); };
const viewCash = () => { const v = viewAcc(); return accounts().filter((a) => v === "all" || a.id === v).reduce((n, a) => n + (Number(a.cash) || 0), 0); };
const syncCash = (s) => { s.settings.cash = Math.round(s.accounts.reduce((n, a) => n + (Number(a.cash) || 0), 0) * 100) / 100; };
function applyAccFields(s, f) {
  // le 1er compte garde son id : les anciennes opérations sans compte lui restent rattachées
  for (const a of s.accounts) {
    const n = f.get("accname:" + a.id), c = f.get("acccash:" + a.id);
    if (n != null) a.name = String(n).trim();
    if (c != null && c !== "") a.cash = Math.max(0, +c || 0);
  }
  syncCash(s);
}
function accFilter() {
  if (accounts().length < 2) return "";
  const v = viewAcc();
  return `<div class="accfilter">${[{ id: "all", name: t("allAccounts") }, ...accounts()].map((a) =>
    `<button type="button" class="period ${a.id === v ? "active" : ""}" data-acc="${esc(a.id)}">${esc(a.id === "all" ? a.name : accName(a))}</button>`).join("")}</div>`;
}

function compute() {
  const s = getState();
  const st = s.settings;
  const positions = computePositions(visibleTx());
  const ids = new Set([...Object.values(positions).filter((p) => p.qty > 0).map((p) => p.assetId), ...s.watch]);
  const rows = [];
  let totalBase = viewCash(), investedBase = 0, missingFx = false;

  for (const id of ids) {
    const asset = s.assets[id];
    if (!asset) continue;
    const candles = cachedCandles(asset);
    const position = positions[id]?.qty > 0 ? positions[id] : null;
    const fx = cachedFx(asset.currency, st.baseCurrency);
    if (fx == null) missingFx = true;
    const price = candles?.length ? candles[candles.length - 1].close : null;
    if (position && price != null) {
      totalBase += position.qty * price * (fx ?? 1);
      investedBase += position.cost * (fx ?? 1);
    }
    rows.push({ id, asset, candles, position, fx: fx ?? 1, price });
  }
  for (const r of rows) {
    // l'advisor raisonne dans la devise du titre
    r.a = advise({
      candles: r.candles,
      news: cachedNews(r.asset),
      position: r.position,
      portfolioValue: totalBase / r.fx,
      cash: viewCash() / r.fx,
      settings: st,
      alert: s.alerts[r.id],
    });
  }
  rows.sort((x, y) => (y.a.urgent - x.a.urgent) || (ACTIONS[x.a.action].rank - ACTIONS[y.a.action].rank) || Math.abs(y.a.score) - Math.abs(x.a.score));
  return { rows, positions, totalBase, investedBase, missingFx };
}

// ---------- rafraîchissement réseau ----------
async function refreshAll(force = false) {
  if (busy) return;
  const s = getState();
  if (!dataReady()) { toast(t("configureSource"), "warn"); return; }
  busy = true;
  render();
  const { rows } = compute();
  const currencies = [...new Set(rows.map((r) => r.asset.currency).filter(Boolean))];
  let done = 0, errors = 0;
  const progress = () => { const el = $("#progress"); if (el) el.textContent = t("updating", { done, total: rows.length }); };
  progress();
  try {
    await Promise.all(currencies.map((c) => getFx(c, s.settings.baseCurrency)));
    await Promise.all(rows.map(async (r) => {
      try {
        const res = await loadAsset(r.asset, force);
        if (res.error) errors++;
      } catch (e) {
        errors++;
        console.warn(r.asset.symbol, e);
        toast(`${r.asset.symbol} : ${e.message}`, "bad");
      }
      done++;
      progress();
    }));
  } finally {
    busy = false;
    update((st) => { st.lastRefresh = Date.now(); });
    if (!errors) toast(t("dataUpToDate"), "good");
  }
}

// ---------- rendu ----------
function renderChrome() {
  applyDocumentLang();
  document.title = "Action Advisor";
  const navs = { portfolio: ["◧", "navPortfolio"], signals: ["⚑", "navSignals"], news: ["☰", "navNews"], guide: ["?", "navGuide"], settings: ["⚙", "navSettings"] };
  document.querySelectorAll("nav button").forEach((b) => {
    const [icon, key] = navs[b.dataset.tab];
    b.innerHTML = `<span>${icon}</span>${esc(t(key))}`;
    b.classList.toggle("active", b.dataset.tab === view.tab);
  });
  $("#refresh").setAttribute("aria-label", t("refresh"));
  $("#add-btn").setAttribute("aria-label", t("add"));
}

function render() {
  const s = getState();
  const data = compute();
  const app = $("#app");
  renderChrome();
  const gain = data.totalBase - viewCash() - data.investedBase;
  $("#summary").innerHTML = `${accFilter()}
    <div class="kpi"><span>${term("totalValue", t("totalValue"))}</span><b>${money(data.totalBase, s.settings.baseCurrency)}</b></div>
    <div class="kpi"><span>${term("unrealized", t("unrealized"))}</span><b class="${tone(gain)}">${money(gain, s.settings.baseCurrency)}</b></div>
    <div class="kpi"><span>${term("cash", t("cash"))}</span><b>${money(viewCash(), s.settings.baseCurrency)}</b></div>
    <div class="status">${busy ? `<span id="progress">${t("updatingShort")}</span>` : s.lastRefresh ? t("refreshedAgo", { ago: ago(s.lastRefresh) }) : t("neverRefreshed")}
      ${data.missingFx ? " · " + t("fxMissing") : ""}</div>`;
  $("#refresh").disabled = busy;

  if (view.tab === "portfolio") { app.innerHTML = renderPortfolio(data); drawPortfolio(); }
  else if (view.tab === "signals") app.innerHTML = renderSignals(data);
  else if (view.tab === "news") app.innerHTML = renderNews(data);
  else if (view.tab === "guide") app.innerHTML = renderGuide();
  else if (view.tab === "settings" && !$("#settings")?.dataset.dirty) app.innerHTML = renderSettings();
  // on ne reconstruit pas une fiche dont le formulaire est en cours de saisie
  if (view.detail && !$("#alert-form")?.dataset.dirty) openDetail(view.detail, data, true);
}

// ---------- logos d'entreprise ----------
// Logo par symbole (financialmodelingprep, sans clé). Absent ou trop petit (flou) → logo par défaut : initiale sur rond coloré.
const LOGO_FAIL_KEY = "aa:logofail";
let logoFail = new Set();
const LOGO_BAD = ["WGS"]; // logos connus comme faux ou moches → logo par défaut
try { logoFail = new Set(JSON.parse(localStorage.getItem(LOGO_FAIL_KEY) || "[]")); } catch {}
function logo(asset, cls = "") {
  const sym = String(asset?.symbol || "?").toUpperCase();
  let h = 0; for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const img = logoFail.has(sym) || LOGO_BAD.includes(sym) ? "" : `<img class="logo-img" alt="" loading="lazy" data-sym="${esc(sym)}" src="https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png">`;
  return `<span class="logo ${cls}" style="--h:${h}" aria-hidden="true"><i>${esc(sym.replace(/[^A-Z0-9]/g, "").charAt(0) || "?")}</i>${img}</span>`;
}
const markLogoFail = (img) => {
  img.remove();
  logoFail.add(img.dataset.sym);
  try { localStorage.setItem(LOGO_FAIL_KEY, JSON.stringify([...logoFail].slice(-500))); } catch {}
};
document.addEventListener("load", (e) => {
  const img = e.target;
  if (!img.classList?.contains("logo-img")) return;
  if (img.naturalWidth < 64) markLogoFail(img); else img.classList.add("ok");
}, true);
document.addEventListener("error", (e) => { if (e.target.classList?.contains("logo-img")) markLogoFail(e.target); }, true);

function badge(a) {
  const A = ACTIONS[a.action];
  const q = a.qty ? ` ${qtyTxt(a.qty)}` : "";
  return `<span class="badge ${A.tone}">${esc(actLabel(a.action))}${q}</span>`;
}

function sparkline(candles, w = 90, h = 30) {
  if (!candles?.length) return `<span class="spark"></span>`;
  const c = candles.slice(-60).map((x) => x.close);
  const min = Math.min(...c), max = Math.max(...c), span = max - min || 1;
  const pts = c.map((v, i) => `${((i / (c.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(" ");
  const up = c[c.length - 1] >= c[0];
  return `<svg class="spark ${up ? "good" : "bad"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function renderPortfolio({ rows }) {
  const held = rows.filter((r) => r.position);
  const watched = rows.filter((r) => !r.position);
  if (!held.length && !watched.length) {
    return `<div class="empty"><h2>${t("noStock")}</h2><p>${t("tapPlus")}</p>
      ${dataReady() ? "" : `<p>${t("startSettings")}</p>`}</div>`;
  }
  const heldHtml = held.map((r) => {
    const p = r.position, price = r.price;
    const g = price != null ? price / p.avgPrice - 1 : null;
    const val = price != null ? p.qty * price : null, base = getState().settings.baseCurrency;
    return `<li class="card" data-open="${esc(r.id)}">
      <div class="row1">${logo(r.asset)}<b>${esc(r.asset.symbol)}</b><span class="muted name">${esc(r.asset.name)}</span>${badge(r.a)}</div>
      <div class="info"><span class="muted">${qtyTxt(p.qty)} × ${term("avgCost", t("avgCost"))}</span> ${money(p.avgPrice, r.asset.currency)}</div>
      ${val != null ? `<div class="info"><span class="muted">${term("posValue", t("posValue"))}</span> <b>${money(val, r.asset.currency)}</b>${base !== r.asset.currency ? ` <span class="muted">(${money(val * r.fx, base)})</span>` : ""}
        · <span class="${tone(val - p.cost)}">${val - p.cost >= 0 ? "+" : ""}${money(val - p.cost, r.asset.currency)}</span></div>` : ""}
      <div class="chartrow">${sparkline(r.candles)}<div class="end"><b>${money(price, r.asset.currency)}</b><br><span class="${tone(g)}">${pctTxt(g)}</span></div></div>
      ${r.a.urgent ? `<div class="alert">${esc(r.a.reasons[0]?.txt)}${r.a.alerts.map((x) => " · " + esc(x)).join("")}</div>` : ""}
    </li>`;
  }).join("");
  const watchHtml = watched.map((r) => {
    const m = r.a.ind?.perf1m;
    return `<li class="card" data-open="${esc(r.id)}">
      <div class="row1">${logo(r.asset)}<b>${esc(r.asset.symbol)}</b><span class="muted name">${esc(r.asset.name)}</span>${badge(r.a)}</div>
      <div class="info muted small">${r.candles?.length ? `${t("oneMonth")} : <span class="${tone(m)}">${pctTxt(m)}</span>` : t("pricesNotLoaded")}</div>
      <div class="chartrow">${sparkline(r.candles)}<div class="end"><b>${money(r.price, r.asset.currency)}</b></div></div>
      ${r.a.urgent ? `<div class="alert">${r.a.alerts.map(esc).join(" · ")}</div>` : ""}
    </li>`;
  }).join("");
  return `${visibleTx().length ? pfShell() : ""}${held.length ? `<h3>${t("myPositions")}</h3><ul class="list">${heldHtml}</ul>` : `<p class="muted">${t("noPositionYet")}</p>`}
    ${watched.length ? `<h3>${t("watchlist")}</h3><ul class="list">${watchHtml}</ul>` : ""}`;
}

function renderSignals({ rows }) {
  if (!rows.length) return `<div class="empty"><p>${t("nothingToAnalyze")}</p></div>`;
  return `<div class="toolbar"><button class="btn ai" id="ai-portfolio">${t("aiPortfolioBtn")}</button></div>
    <div id="ai-portfolio-out">${renderAIPortfolio(view.aiPortfolio)}</div>
    <ul class="list">${rows.map((r) => `
      <li class="card" data-open="${esc(r.id)}">
        <div class="row1">${logo(r.asset)}<b>${esc(r.asset.symbol)}</b><span class="muted name">${esc(r.asset.name)}</span>${badge(r.a)}</div>
        <div class="row2 small">
          <span>${term("score", t("score"))} <b class="${tone(r.a.score)}">${r.a.score > 0 ? "+" : ""}${r.a.score}</b></span>
          <span>${t("stop")} ${num(r.a.levels.stop)}</span>
          <span>${t("target")} ${num(r.a.levels.target)}</span>
          ${r.a.levels.buyZone ? `<span>${t("buyZone")} ${num(r.a.levels.buyZone)}</span>` : ""}
        </div>
        <div class="muted small">${esc(r.a.reasons[0]?.txt || "")}</div>
      </li>`).join("")}</ul>
    <p class="disclaimer">${t("disclaimer")}</p>`;
}

// ---------- guide / lexique ----------
const gl = () => (["fr", "en", "fa"].includes(lang()) ? lang() : "en");
// libellé touchable : affiche la définition du terme
const term = (key, label) => `<span class="term" data-term="${key}">${label}</span>`;
function renderGuide() {
  const L = gl();
  return `<section class="guide">
    ${SECTIONS.map((sec) => `<h3>${esc(sec[L])}</h3>
      <table class="gloss">${sec.keys.map((k) => `<tr><th>${esc(TERMS[k][L][0])}</th><td>${esc(TERMS[k][L][1])}</td></tr>`).join("")}</table>`).join("")}
    <h3>${{ fr: "Petit cours : comprendre les indicateurs", en: "Mini course: understanding the indicators", fa: "درس کوتاه: آشنایی با شاخص‌ها" }[L]}</h3>
    <div class="course card">${COURSE[L]}</div>
  </section>`;
}
function showTerm(key) {
  const d = TERMS[key];
  if (!d) return;
  const [name, def] = d[gl()];
  let dlg = $("#term-dlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "term-dlg"; document.body.appendChild(dlg); dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); }
  dlg.innerHTML = `<div class="term-box"><b>${esc(name)}</b><p>${esc(def)}</p>
    <div class="actions"><button class="btn" data-term-guide>${esc(t("navGuide"))}</button><button class="btn primary" data-term-close>OK</button></div></div>`;
  if (!dlg.open) dlg.showModal();
}

function renderNews({ rows }) {
  const items = [];
  for (const r of rows) for (const n of cachedNews(r.asset).slice(0, 10)) items.push({ ...n, sym: r.asset.symbol, s: scoreHeadline(n.title) });
  items.sort((a, b) => b.datetime - a.datetime);
  if (!items.length) return `<div class="empty"><p>${t("noNews")}</p></div>`;
  return `<ul class="list news">${items.slice(0, 80).map((n) => `
    <li><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">
      <span class="dot ${n.s > 0.15 ? "good" : n.s < -0.15 ? "bad" : "neutral"}"></span>
      <span class="sym">${esc(n.sym)}</span> <bdi>${esc(n.title)}</bdi>
      <span class="muted small"> — ${esc(n.source)} · ${ago(n.datetime)}</span></a></li>`).join("")}</ul>`;
}

function field(key, label, type = "number", extra = "") {
  const v = getState().settings[key];
  return `<label>${label}<input name="${key}" type="${type}" value="${esc(v)}" ${extra}></label>`;
}
const getLink = (url) => ` <a href="${url}" target="_blank" rel="noopener">${t("get")}</a>`;

function renderSettings() {
  const st = getState().settings;
  const u = aiUsageSafe();
  return `<form id="settings" class="settings" autocomplete="off">
    <h3>${t("language")}</h3>
    <label>${t("language")}<select name="lang">${LANGS.map((l) => `<option value="${l.id}" ${l.id === (st.lang || "fr") ? "selected" : ""}>${l.label}</option>`).join("")}</select></label>

    <h3>${t("money")}</h3>
    <h4>${t("accountsTitle")}</h4>
    <p class="muted small">${t("accountsHelp")}</p>
    ${accounts().map((a) => `<div class="accrow">
      <label>${t("accountName")}<input name="accname:${esc(a.id)}" value="${esc(a.name || "")}" placeholder="${esc(t("mainAccount"))}"></label>
      <label>${t("availableCash")}<input name="acccash:${esc(a.id)}" type="number" step="0.01" min="0" value="${esc(a.cash ?? 0)}"></label>
      ${accounts().length > 1 ? `<button type="button" class="btn small" data-delacc="${esc(a.id)}" aria-label="${esc(t("delete"))}">✕</button>` : ""}
    </div>`).join("")}
    <button type="button" class="btn" id="add-acc">${t("addAccount")}</button>
    <label>${t("baseCurrency")}<select name="baseCurrency">${["EUR", "USD", "GBP", "CHF"].map((c) => `<option ${c === st.baseCurrency ? "selected" : ""}>${c}</option>`).join("")}</select></label>

    <h3>${t("riskRules")}</h3>
    ${field("riskPerTradePct", t("riskPerTrade"), "number", 'step="0.1" min="0.1"')}
    ${field("targetPositionPct", t("targetWeight"), "number", 'step="1" min="1"')}
    ${field("maxPositionPct", t("maxWeight"), "number", 'step="1" min="1"')}
    ${field("stopAtrMult", t("trailingStop"), "number", 'step="0.1" min="0.5"')}
    ${field("takeProfitPct", t("takeProfit"), "number", 'step="1" min="1"')}
    ${field("buyScore", t("buyScoreL"), "number", 'step="1"')}
    ${field("sellScore", t("sellScoreL"), "number", 'step="1"')}

    <h3>${t("marketData")}</h3>
    <label>${t("priceSource")}<select name="dataProvider">
      <option value="yahoo" ${st.dataProvider === "yahoo" ? "selected" : ""}>${t("srcYahoo")}</option>
      <option value="twelvedata" ${st.dataProvider === "twelvedata" ? "selected" : ""}>${t("srcTd")}</option>
    </select></label>
    ${field("proxyUrl", t("relayUrl"), "url", 'placeholder="https://…workers.dev" dir="ltr"')}
    ${field("twelveDataKey", t("tdKey") + getLink("https://twelvedata.com/pricing"), "password", 'dir="ltr"')}
    ${field("finnhubKey", t("fhKey") + getLink("https://finnhub.io/register"), "password", 'dir="ltr"')}
    ${field("priceRefreshMinutes", t("priceCache"), "number", 'min="5"')}
    ${field("newsRefreshMinutes", t("newsCache"), "number", 'min="15"')}

    <h3>${t("aiSection")}</h3>
    <label>${t("aiProvider")}<select name="aiProvider">
      <option value="anthropic" ${st.aiProvider !== "openai" ? "selected" : ""}>Anthropic (Claude)</option>
      <option value="openai" ${st.aiProvider === "openai" ? "selected" : ""}>OpenAI</option>
    </select></label>
    <fieldset class="ai-group" data-provider="anthropic" ${st.aiProvider === "openai" ? "hidden" : ""}>
      ${field("anthropicKey", t("anthropicKey") + getLink("https://console.anthropic.com/settings/keys"), "password", 'dir="ltr"')}
      <label>${t("claudeModel")}<select name="aiModel">${AI_MODELS.map((m) => `<option value="${m.id}" ${m.id === st.aiModel ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>
    </fieldset>
    <fieldset class="ai-group" data-provider="openai" ${st.aiProvider === "openai" ? "" : "hidden"}>
      ${field("openaiKey", t("openaiKey") + getLink("https://platform.openai.com/api-keys"), "password", 'dir="ltr"')}
      <label>${t("openaiModel")}
        <span class="inline-row"><input name="openaiModel" list="oai-models" value="${esc(st.openaiModel)}" placeholder="${esc(t("loadListPh"))}" autocomplete="off" dir="ltr">
        <button type="button" class="btn" id="oai-load">${t("loadList")}</button></span>
      </label>
      <datalist id="oai-models"></datalist>
      <p class="muted small" id="oai-hint">${t("oaiHint")}</p>
    </fieldset>
    ${field("aiMonthlyTokenBudget", t("monthlyBudget"), "number", 'step="10000" min="0"')}
    ${field("aiCacheHours", t("aiCacheHours"), "number", 'min="1"')}
    <p class="muted small">${t("usageLine", { calls: u.calls, total: u.total.toLocaleString(locale()), budget: u.budget.toLocaleString(locale()) })}${u.estCostUsd != null ? ` (≈ ${u.estCostUsd.toFixed(3)} $)` : " — " + t("usageCostOpenai")}.</p>

    <div class="actions">
      <button type="submit" class="btn primary">${t("save")}</button>
      <button type="button" class="btn" id="export">${t("export")}</button>
      <label class="btn">${t("import")}<input type="file" id="import" accept="application/json" hidden></label>
      <button type="button" class="btn" id="purge">${t("purge")}</button>
      <button type="button" class="btn" id="reset-rules">${t("resetRules")}</button>
    </div>
    <p class="muted small">${t("localData")}</p>
    <h3>${t("shareTitle")}</h3>
    <button type="button" class="btn primary" id="share-app">${t("shareBtn")}</button>
  </form>`;
}

// ---------- partager l'appli ----------
const APP_URL = "https://unit-m.github.io/action-advisor/";
const shareText = () => t("shareMsg", { url: APP_URL });
function openShare() {
  let dlg = $("#term-dlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "term-dlg"; document.body.appendChild(dlg); dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); }
  dlg.innerHTML = `<div class="term-box"><b>${esc(t("shareBtn"))}</b>
    <p class="share-text">${esc(shareText())}</p>
    <div class="actions"><button class="btn" data-share-copy>${esc(t("copy"))}</button>${navigator.share ? `<button class="btn primary" data-share-send>${esc(t("send"))}</button>` : ""}<button class="btn" data-term-close>OK</button></div></div>`;
  if (!dlg.open) dlg.showModal();
}

let aiMod = null;
async function loadAI() {
  if (!aiMod) aiMod = await import("./ai.js");
  return aiMod;
}
function aiUsageSafe() {
  if (aiMod) return aiMod.usage();
  const s = getState();
  const cur = s.aiUsage.month === new Date().toISOString().slice(0, 7) ? s.aiUsage : { input: 0, output: 0, calls: 0 };
  const [pi, po] = AI_MODELS.find((m) => m.id === s.settings.aiModel)?.price || [0, 0];
  const est = s.settings.aiProvider === "openai" ? null : ((cur.input || 0) * pi + (cur.output || 0) * po) / 1e6;
  return { calls: cur.calls || 0, total: (cur.input || 0) + (cur.output || 0), budget: s.settings.aiMonthlyTokenBudget, estCostUsd: est };
}

// ---------- courbe interactive ----------
const PERIOD_LABEL = {
  fr: { "1D": "1J", "1W": "1S", "1M": "1M", "6M": "6M", "1Y": "1A", "2Y": "2A", "5Y": "5A", ALL: "Tout" },
  en: { "1D": "1D", "1W": "1W", "1M": "1M", "6M": "6M", "1Y": "1Y", "2Y": "2Y", "5Y": "5Y", ALL: "All" },
  fa: { "1D": "۱ روز", "1W": "۱ هفته", "1M": "۱ ماه", "6M": "۶ ماه", "1Y": "۱ سال", "2Y": "۲ سال", "5Y": "۵ سال", ALL: "همه" },
};
const periodLabel = (p) => (PERIOD_LABEL[getState().settings.lang] || PERIOD_LABEL.fr)[p];
let chartToken = 0;

// ---------- évolution du portefeuille (toutes les actions) ----------
const PF_DAYS = { "1W": 6, "1M": 22, "6M": 127, "1Y": 253, "2Y": 100000 };
const pfTried = new Set();
let pfLoading = false;
function pfShell() {
  return `<section class="chart-box pf" id="pf-box">
    <div class="pf-title"><b>${t("pfTitle")}</b></div>
    <div class="periods">${Object.keys(PF_DAYS).map((p) => `<button type="button" class="period ${p === view.pfPeriod ? "active" : ""}" data-pfperiod="${p}">${esc(periodLabel(p))}</button>`).join("")}</div>
    <div class="chart-head"><b id="pf-val"></b> <span id="pf-chg"></span> <span class="muted small" id="pf-date"></span></div>
    <div id="pf-area" class="chart-area"><div class="chart-msg muted">${t("loading")}</div></div>
    <div class="legend small"><span class="l price">${term("posValue", t("posValue"))}</span><span class="l inv">${term("invested", t("invested"))}</span></div>
    <div class="grid2" id="pf-kpis"></div>
  </section>`;
}
// taux de change du jour d (ou du dernier jour connu avant)
const fxIdx = {};
function fxRateAt(cur, d) {
  const base = getState().settings.baseCurrency;
  if (!cur || cur === base) return 1;
  const ser = cachedFxSeries(cur, base);
  if (!ser) return cachedFx(cur, base);
  const k = cur + base;
  if (!fxIdx[k] || fxIdx[k].ser !== ser) fxIdx[k] = { ser, keys: Object.keys(ser).sort() };
  const keys = fxIdx[k].keys;
  let lo = 0, hi = keys.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= d) { best = keys[m]; lo = m + 1; } else hi = m - 1; }
  return ser[best ?? keys[0]];
}
async function loadPortfolioHistory(ids, currencies) {
  if (pfLoading || !dataReady()) return;
  pfLoading = true;
  const base = getState().settings.baseCurrency;
  try {
    await Promise.all([
      ...currencies.map((c) => getFxSeries(c, base).catch(() => null)),
      ...ids.map((id) => getCandles(getState().assets[id]).catch(() => null)),
    ]);
  } finally {
    pfLoading = false;
    if (view.tab === "portfolio") render();
  }
}
function drawPortfolio() {
  const box = $("#pf-box");
  if (!box) return;
  const s = getState(), base = s.settings.baseCurrency;
  const txAll = visibleTx();
  const ids = [...new Set(txAll.map((x) => x.assetId))].filter((id) => s.assets[id]);
  const candlesById = {};
  const missing = [];
  for (const id of ids) {
    const c = cachedCandles(s.assets[id]);
    if (c?.length) candlesById[id] = c;
    else if (!pfTried.has(id)) { pfTried.add(id); missing.push(id); }
  }
  const curs = [...new Set(ids.map((id) => s.assets[id].currency).filter((c) => c && c !== base))];
  const missingFx = curs.filter((c) => !cachedFxSeries(c, base) && !pfTried.has("fx:" + c));
  missingFx.forEach((c) => pfTried.add("fx:" + c));
  if (missing.length || missingFx.length) loadPortfolioHistory(missing, missingFx);

  const all = portfolioHistory({ transactions: txAll, assets: s.assets, candlesById, fxRate: fxRateAt });
  const pts = all.slice(-(PF_DAYS[view.pfPeriod] || 22));
  const area = $("#pf-area");
  if (pts.length < 2) { area.innerHTML = `<div class="chart-msg muted">${t(pfLoading ? "loading" : "pricesNotLoaded")}</div>`; return; }
  const sum = summarize(pts);
  const W = 340, H = 150, n = pts.length;
  const vals = pts.flatMap((p) => [p.value, p.cost]);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const X = (i) => (i / (n - 1)) * W, Y = (v) => H - 6 - ((v - min) / span) * (H - 12);
  const line = (key) => pts.map((p, i) => `${X(i).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(" ");
  const up = sum.pnl >= 0;
  const fill = `M0,${H} ` + pts.map((p, i) => `L${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ") + ` L${W},${H} Z`;
  area.innerHTML = `<svg class="chart ${up ? "up" : "down"}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path class="fill" d="${fill}"/><polyline class="inv" points="${line("cost")}"/><polyline class="price" points="${line("value")}"/>
      <line class="cross" id="pf-cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/></svg><div class="cross-dot" id="pf-dot" hidden></div>`;
  const sign = (v) => (v >= 0 ? "+" : "");
  const show = (i) => {
    const p = pts[i], d = p.pnl - pts[0].pnl;
    $("#pf-val").textContent = money(p.value, base);
    const c = $("#pf-chg"); c.textContent = `${sign(d)}${money(d, base)}`; c.className = tone(d);
    $("#pf-date").textContent = new Date(p.date + "T12:00:00").toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
  };
  show(n - 1);
  $("#pf-kpis").innerHTML = `
    <div class="kpi"><span>${term("perfPf", t("performance"))}</span><b class="${tone(sum.perf)}">${pctTxt(sum.perf)}</b></div>
    <div class="kpi"><span>${term("pnl", t("pnl"))}</span><b class="${tone(sum.pnl)}">${sign(sum.pnl)}${money(sum.pnl, base)}</b>
      <small class="muted">${money(sum.realized, base)} ${t("realizedW")} · ${money(sum.unrealized, base)} ${t("unrealizedW")}</small></div>`;
  const svg = area.querySelector("svg"), cross = $("#pf-cross"), dot = $("#pf-dot");
  const onMove = (ev) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - r.left) / r.width) * (n - 1))));
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    dot.style.left = `${(X(i) / W) * 100}%`; dot.style.top = `${(Y(pts[i].value) / H) * 100}%`; dot.hidden = false;
    show(i);
  };
  const onLeave = () => { cross.setAttribute("visibility", "hidden"); dot.hidden = true; show(n - 1); };
  svg.addEventListener("pointerdown", (ev) => { svg.setPointerCapture?.(ev.pointerId); onMove(ev); });
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onLeave);
  svg.addEventListener("pointerleave", onLeave);
  svg.addEventListener("pointercancel", onLeave);
}
function clearChartHead() {
  for (const id of ["chart-val", "chart-chg", "chart-date", "chart-legend"]) { const el = $("#" + id); if (el) el.textContent = ""; }
}

function chartShell() {
  return `<div class="chart-box">
    <div class="periods" role="tablist">${PERIODS.map((p) => `<button type="button" class="period ${p === view.chartPeriod ? "active" : ""}" data-period="${p}" role="tab" aria-selected="${p === view.chartPeriod}">${esc(periodLabel(p))}</button>`).join("")}</div>
    <div class="chart-head"><b id="chart-val"></b> <span id="chart-chg"></span> <span class="muted small" id="chart-date"></span></div>
    <div id="chart-area" class="chart-area"><div class="chart-msg muted">${t("loading")}</div></div>
    <div class="legend small" id="chart-legend"></div>
  </div>`;
}

// Dessine la courbe de la durée choisie et branche l'interaction (toucher / survoler = prix à cette date)
async function drawChart(r) {
  const my = ++chartToken;
  const area = $("#chart-area");
  if (!area) return;
  let series;
  try {
    series = await getSeries(r.asset, view.chartPeriod);
  } catch (e) {
    if (my === chartToken && $("#chart-area")) { clearChartHead(); $("#chart-area").innerHTML = `<div class="chart-msg muted">${esc(e.message)}</div>`; }
    return;
  }
  if (my !== chartToken || !$("#chart-area")) return; // une autre durée a été choisie entre-temps
  const pts = series.points;
  if (pts.length < 2) { clearChartHead(); $("#chart-area").innerHTML = `<div class="chart-msg muted">${t("pricesNotLoaded")}</div>`; return; }

  const W = 340, H = 180, cur = r.asset.currency;
  const closes = pts.map((p) => p.close);
  // moyennes mobiles et stop : seulement sur les durées en données journalières
  let m50 = [], m200 = [];
  const stopLvl = series.daily ? r.a.levels.stop : null;
  if (series.daily && series.candles?.length) {
    const all = series.candles.map((c) => c.close);
    m50 = sma(all, 50).slice(-pts.length);
    m200 = sma(all, 200).slice(-pts.length);
  }
  // achats / ventes de ce titre sur la période affichée
  const n = pts.length;
  const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
  const firstDay = dayOf(pts[0].t);
  const txs = visibleTx().filter((x) => x.assetId === r.asset.id && x.date >= firstDay);
  const txAt = {};
  for (const x of txs) {
    let i = pts.findIndex((p) => dayOf(p.t) >= x.date);
    if (i < 0) i = n - 1;
    (txAt[i] ||= []).push(x);
  }
  const vals = [...closes, ...m50, ...m200, stopLvl].filter((v) => v != null && isFinite(v));
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const X = (i) => (i / (n - 1)) * W;
  const Y = (v) => H - 6 - ((v - min) / span) * (H - 12);
  const line = (arr, cls) => {
    const p = arr.map((v, i) => (v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).filter(Boolean).join(" ");
    return p ? `<polyline class="${cls}" points="${p}"/>` : "";
  };
  const first = series.base || closes[0], lastV = closes[n - 1];
  const up = lastV >= first;
  const areaPath = `M0,${H} ` + closes.map((v, i) => `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ") + ` L${W},${H} Z`;
  $("#chart-area").innerHTML = `<svg class="chart ${up ? "up" : "down"}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t("chartLabel", { n }))}">
      <path class="fill" d="${areaPath}"/>
      ${stopLvl ? `<line class="stop" x1="0" x2="${W}" y1="${Y(stopLvl).toFixed(1)}" y2="${Y(stopLvl).toFixed(1)}"/>` : ""}
      ${line(m200, "m200")}${line(m50, "m50")}${line(closes, "price")}
      <line class="cross" id="cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
    </svg>${Object.entries(txAt).flatMap(([i, list]) => list.map((x) =>
      `<div class="tx-dot ${x.type === "BUY" ? "buy" : "sell"}" style="left:${(X(+i) / W) * 100}%;top:${(Y(closes[+i]) / H) * 100}%"></div>`)).join("")}<div class="cross-dot" id="cross-dot" hidden></div>`;
  $("#chart-legend").innerHTML = `<span class="l price" data-term="price">${t("legendPrice")}</span>${txs.length ? `<span class="l txl buy" data-term="buySell">${t("buy")}</span><span class="l txl sell" data-term="buySell">${t("sell")}</span>` : ""}${m50.some((v) => v != null) ? `<span class="l m50" data-term="ma50">${t("ma50")}</span><span class="l m200" data-term="ma200">${t("ma200")}</span>` : ""}${stopLvl ? `<span class="l stop" data-term="stop">${t("stop")}</span>` : ""}`;

  const fmtDate = (ts) => new Date(ts).toLocaleString(locale(), series.intraday
    ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", year: "numeric" });
  const show = (i) => {
    const v = closes[i], chg = v / first - 1;
    $("#chart-val").textContent = money(v, cur);
    const c = $("#chart-chg");
    c.textContent = pctTxt(chg);
    c.className = tone(chg);
    const near = [i, i - 1, i + 1].find((k) => txAt[k]);
    const txt = near != null ? " · " + txAt[near].map((x) => `${x.type === "BUY" ? t("buy") : t("sell")} ${qtyTxt(x.qty)} × ${money(x.price, cur)}`).join(", ") : "";
    $("#chart-date").textContent = fmtDate(pts[i].t) + txt;
  };
  show(n - 1);

  const svg = $("#chart-area svg");
  const cross = $("#cross"), dot = $("#cross-dot");
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - rect.left) / rect.width) * (n - 1))));
    const x = X(i), y = Y(closes[i]);
    cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
    dot.style.left = `${(x / W) * 100}%`; dot.style.top = `${(y / H) * 100}%`; dot.hidden = false;
    show(i);
  };
  const onLeave = () => { cross.setAttribute("visibility", "hidden"); dot.hidden = true; show(n - 1); };
  svg.addEventListener("pointerdown", (ev) => { svg.setPointerCapture?.(ev.pointerId); onMove(ev); });
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onLeave);
  svg.addEventListener("pointerleave", onLeave);
  svg.addEventListener("pointercancel", onLeave);
}

// ---------- fiche détaillée ----------
function openDetail(id, data = compute(), silent = false) {
  view.detail = id;
  const s = getState();
  const r = data.rows.find((x) => x.id === id) || { id, asset: s.assets[id], fx: 1, a: advise({ settings: s.settings }), candles: s.assets[id] ? cachedCandles(s.assets[id]) : null };
  if (!r.asset) { view.detail = null; return; }
  const a = r.a, ind = a.ind || {}, cur = r.asset.currency;
  const tx = visibleTx().filter((x) => x.assetId === id).sort((x, y) => (x.date < y.date ? 1 : -1));
  const alert = s.alerts[id] || {};
  const news = cachedNews(r.asset).slice(0, 8);
  const dlg = $("#detail");
  const chartKey = `${id}|${view.chartPeriod}|${r.candles?.at(-1)?.date}|${r.candles?.at(-1)?.close}|${getState().settings.lang}`;
  const oldChart = dlg.querySelector(".chart-box");
  const keepChart = silent && oldChart && oldChart.dataset.key === chartKey && $("#chart-val")?.textContent;
  dlg.innerHTML = `<div class="sheet">
    <header><button class="close" data-close aria-label="${t("close")}">✕</button>
      ${logo(r.asset, "big")}<div><h2>${esc(r.asset.symbol)} ${badge(a)}</h2><div class="muted small">${esc(r.asset.name)} · ${esc(r.asset.exchange || "")} · ${esc(cur || "")}</div></div></header>
    ${r.candles?.length ? "" : `<div class="alert">
      <b>${t("pricesNotLoadedTitle")}</b><br>
      ${!dataReady()
        ? (getState().settings.dataProvider === "yahoo" ? t("relayEmpty") : t("tdKeyNeeded"))
        : esc(t("reason", { r: loadErrors[id] || t("notTriedYet") }))}
      <div class="actions"><button class="btn" id="retry-load">${t("retry")}</button><button class="btn" data-tab="settings">${t("navSettings")}</button></div>
    </div>`}
    ${r.candles?.length ? chartShell() : ""}
    ${r.position ? `<div class="grid3">
        <div><span class="muted small">${term("quantity", t("quantity"))}</span><b>${qtyTxt(r.position.qty)}</b></div>
        <div><span class="muted small">${term("avgCost", t("avgCost"))}</span><b>${money(r.position.avgPrice, cur)}</b></div>
        <div><span class="muted small">${term("unrealized", t("unrealizedShort"))}</span><b class="${tone(ind.price - r.position.avgPrice)}">${pctTxt(ind.price / r.position.avgPrice - 1)}</b></div>
      </div>` : ""}

    <section class="advice">
      <h3>${t("adviceRules")}</h3>
      <p><b>${esc(actLabel(a.action))}${a.qty ? " " + t("shares", { n: qtyTxt(a.qty) }) : ""}</b> — ${term("score", t("score"))} ${a.score > 0 ? "+" : ""}${a.score}/100</p>
      <div class="grid3">
        <div><span class="muted small">${term("stop", t("stop"))}</span><b>${num(a.levels.stop)}</b></div>
        <div><span class="muted small">${term("target", t("target"))}</span><b>${num(a.levels.target)}</b></div>
        <div><span class="muted small">${term("buyZone", t("buyZone"))}</span><b>${num(a.levels.buyZone)}</b></div>
      </div>
      <ul class="reasons">${a.reasons.map((x) => `<li class="${x.key ? "key" : tone(x.pts)}">${x.pts ? `<b>${x.pts > 0 ? "+" : ""}${x.pts}</b> ` : ""}${esc(x.txt)}</li>`).join("")}</ul>
      ${a.alerts?.length ? `<div class="alert">${a.alerts.map(esc).join("<br>")}</div>` : ""}
    </section>

    <section>
      <button class="btn ai" id="ai-asset">${esc(t("aiOn", { s: r.asset.symbol }))}</button>
      <div id="ai-asset-out"></div>
    </section>

    <section>
      <h3>${t("indicators")}</h3>
      <table class="ind">
        <tr><td>${term("rsi", "RSI 14")}</td><td>${num(ind.rsi14, 0)}</td><td>${term("atr", "ATR 14")}</td><td>${num(ind.atr14)}</td></tr>
        <tr><td>${term("ma50", t("ma50"))}</td><td>${num(ind.sma50)}</td><td>${term("ma200", t("ma200"))}</td><td>${num(ind.sma200)}</td></tr>
        <tr><td>${term("high52", t("high52"))}</td><td>${num(ind.high52)}</td><td>${term("low52", t("low52"))}</td><td>${num(ind.low52)}</td></tr>
        <tr><td>${term("perf", t("oneMonth"))}</td><td class="${tone(ind.perf1m)}">${pctTxt(ind.perf1m)}</td><td>${term("perf", t("oneYear"))}</td><td class="${tone(ind.perf1y)}">${pctTxt(ind.perf1y)}</td></tr>
        <tr><td>${term("volatility", t("volatility"))}</td><td>${ind.volatility != null ? num(ind.volatility * 100, 0) + " %" : "—"}</td><td>${term("news", t("newsShort"))}</td><td>${a.sentiment?.count ? `${a.sentiment.pos}+ / ${a.sentiment.neg}−` : "—"}</td></tr>
      </table>
    </section>

    <section>
      <h3>${t("priceAlerts")}</h3>
      <form id="alert-form" class="inline">
        <label>${t("ifBelow")}<input name="below" type="number" step="0.01" value="${esc(alert.below ?? "")}"></label>
        <label>${t("ifAbove")}<input name="above" type="number" step="0.01" value="${esc(alert.above ?? "")}"></label>
        <button class="btn">OK</button>
      </form>
    </section>

    ${news.length ? `<section><h3>${t("news")}</h3><ul class="list news">${news.map((n) => {
      const sc = scoreHeadline(n.title);
      return `<li><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer"><span class="dot ${sc > 0.15 ? "good" : sc < -0.15 ? "bad" : "neutral"}"></span><bdi>${esc(n.title)}</bdi> <span class="muted small">— ${esc(n.source)} · ${ago(n.datetime)}</span></a></li>`;
    }).join("")}</ul></section>` : ""}

    <section>
      <h3>${t("transactions")}</h3>
      <div class="actions"><button class="btn good" data-tx="BUY">${t("buyBtn")}</button><button class="btn bad" data-tx="SELL" ${r.position ? "" : "disabled"}>${t("sellBtn")}</button>
        ${s.watch.includes(id) ? `<button class="btn" id="unwatch">${t("unwatch")}</button>` : r.position ? "" : `<button class="btn" id="watch">${t("watch")}</button>`}</div>
      <ul class="tx">${tx.map((x) => `<li><span class="${x.type === "BUY" ? "good" : "bad"}">${x.type === "BUY" ? t("buy") : t("sell")}</span> ${x.date} · ${qtyTxt(x.qty)} × ${money(x.price, cur)}${x.fees ? ` (+${money(x.fees, cur)} ${t("fees")})` : ""}
        <button class="link" data-deltx="${esc(x.id)}">${t("delete")}</button></li>`).join("") || `<li class="muted">${t("none")}</li>`}</ul>
    </section>
  </div>`;
  if (!dlg.open) dlg.showModal();
  if (!silent) dlg.scrollTop = 0;
  if (r.candles?.length) {
    const box = dlg.querySelector(".chart-box");
    if (keepChart) box.replaceWith(oldChart); else { box.dataset.key = chartKey; drawChart(r); }
    dlg.querySelectorAll("[data-period]").forEach((b) => (b.onclick = () => {
      view.chartPeriod = b.dataset.period;
      const cb = dlg.querySelector(".chart-box");
      if (cb) cb.dataset.key = `${id}|${view.chartPeriod}|${r.candles?.at(-1)?.date}|${r.candles?.at(-1)?.close}|${getState().settings.lang}`;
      dlg.querySelectorAll("[data-period]").forEach((x) => {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-selected", x === b);
      });
      clearChartHead();
      $("#chart-area").innerHTML = `<div class="chart-msg muted">${t("loading")}</div>`;
      drawChart(r);
    }));
  }
  const prevAI = view.aiAsset?.[id];
  if (prevAI) {
    $("#ai-asset-out").innerHTML = renderAIAsset(prevAI, cur);
    const f = $("#ai-asset-force");
    if (f) f.onclick = () => runAIAsset(r, data, true);
  }

  // gestionnaires
  $("#ai-asset").onclick = () => runAIAsset(r, data);
  const retry = $("#retry-load");
  if (retry) retry.onclick = async () => {
    retry.disabled = true;
    retry.textContent = t("loading");
    try { await loadAsset(r.asset, true); toast(t("pricesLoaded"), "good"); } catch (e) { toast(e.message, "bad"); }
    render();
  };
  $("#alert-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const below = parseFloat(f.get("below")), above = parseFloat(f.get("above"));
    delete e.target.dataset.dirty;
    update((st) => { st.alerts[id] = { below: isFinite(below) ? below : null, above: isFinite(above) ? above : null }; });
    toast(t("alertSaved"), "good");
  };
  dlg.querySelectorAll("[data-tx]").forEach((b) => (b.onclick = () => openTxForm(r.asset, b.dataset.tx, a)));
  dlg.querySelectorAll("[data-deltx]").forEach((b) => (b.onclick = () => {
    if (!confirm(t("deleteTxConfirm"))) return;
    update((st) => { st.transactions = st.transactions.filter((x) => x.id !== b.dataset.deltx); });
  }));
  const w = $("#watch"), uw = $("#unwatch");
  if (w) w.onclick = () => update((st) => { if (!st.watch.includes(id)) st.watch.push(id); });
  if (uw) uw.onclick = () => { update((st) => { st.watch = st.watch.filter((x) => x !== id); }); };
}

function renderAIAsset(x, cur) {
  if (x.error) return `<div class="alert">${esc(x.error)}</div>`;
  return `<div class="ai-box">
    <p><b>${esc(decLabel(x.decision))}${x.quantite ? " " + t("shares", { n: qtyTxt(+x.quantite) }) : ""}</b> · ${t("confidence", { n: x.confiance })}
      · ${x.accord_avec_regles ? t("agreesRules") : `<b>${t("disagreesRules")}</b>`}</p>
    <p>${esc(x.resume)}</p>
    <div class="grid3">
      <div><span class="muted small">${t("limitPrice")}</span><b>${x.prix_limite ? money(x.prix_limite, cur) : "—"}</b></div>
      <div><span class="muted small">${t("stop")}</span><b>${x.stop ? money(x.stop, cur) : "—"}</b></div>
      <div><span class="muted small">${t("target")}</span><b>${x.objectif ? money(x.objectif, cur) : "—"}</b></div>
    </div>
    ${x.points_cles?.length ? `<h4>${t("keyPoints")}</h4><ul>${x.points_cles.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    ${x.risques?.length ? `<h4>${t("risks")}</h4><ul>${x.risques.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    <p class="muted small">${x._cached ? t("cachedOpinion", { ago: ago(x._at) }) : t("tokens", { n: x._tokens })} · ${esc(x._model || "")}
      ${x._cached ? ` · <button class="link" id="ai-asset-force">${t("askAgain")}</button>` : ""}</p>
  </div>`;
}

async function runAIAsset(r, data, force = false) {
  const out = $("#ai-asset-out");
  const missing = aiMissing(getState().settings);
  if (missing) { out.innerHTML = `<div class="alert">${esc(t(missing))}</div>`; return; }
  out.innerHTML = `<p class="muted">${t("aiRunning")}</p>`;
  try {
    const ai = await loadAI();
    const s = getState();
    const news = cachedNews(r.asset).length ? cachedNews(r.asset) : await getNews(r.asset).catch(() => []);
    const res = await ai.adviseAsset({
      asset: r.asset, a: r.a, position: r.position, news,
      portfolioValue: data.totalBase / r.fx, cash: viewCash() / r.fx, settings: s.settings, force,
    });
    (view.aiAsset ||= {})[r.id] = res;
  } catch (e) {
    (view.aiAsset ||= {})[r.id] = { error: e.message };
  }
  if (view.detail === r.id) {
    $("#ai-asset-out").innerHTML = renderAIAsset(view.aiAsset[r.id], r.asset.currency);
    const f = $("#ai-asset-force");
    if (f) f.onclick = () => runAIAsset(r, data, true);
  }
}

function renderAIPortfolio(x) {
  if (!x) return "";
  if (x.pending) return `<p class="muted">${t("aiReviewRunning")}</p>`;
  if (x.error) return `<div class="alert">${esc(x.error)}</div>`;
  return `<div class="ai-box"><p>${esc(x.synthese)}</p>
    <ol>${(x.priorites || []).map((p) => `<li><b>${esc(p.symbole)}</b> — ${esc(decLabel(p.decision))}${p.quantite ? ` ${p.quantite}` : ""} : ${esc(p.raison)}</li>`).join("")}</ol>
    <p><i>${esc(x.diversification)}</i></p>
    <p class="muted small">${x._cached ? t("cached", { ago: ago(x._at) }) : t("tokens", { n: x._tokens })}</p></div>`;
}

// Le résultat est gardé dans `view` : un rafraîchissement de l'écran pendant l'appel ne le perd pas.
async function runAIPortfolio() {
  const missing = aiMissing(getState().settings);
  if (missing) { view.aiPortfolio = { error: t(missing) }; render(); return; }
  view.aiPortfolio = { pending: true };
  render();
  try {
    const ai = await loadAI();
    const s = getState();
    const data = compute();
    view.aiPortfolio = await ai.reviewPortfolio({ rows: data.rows.filter((r) => r.a.ind), portfolioValue: data.totalBase, cash: viewCash(), settings: s.settings });
  } catch (e) {
    view.aiPortfolio = { error: e.message };
  }
  render();
}

// ---------- ajout / transaction ----------
function openAdd() {
  const dlg = $("#add");
  dlg.innerHTML = `<div class="sheet">
    <header><button class="close" data-close aria-label="${t("close")}">✕</button><h2>${t("addStock")}</h2></header>
    <input id="q" type="search" placeholder="${esc(t("searchPh"))}" autocomplete="off" autocapitalize="characters" autofocus>
    <ul id="results" class="list results"></ul>
  </div>`;
  dlg.showModal();
  const q = $("#q");
  let timer;
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const res = $("#results");
      if (!q.value.trim()) { res.innerHTML = ""; return; }
      res.innerHTML = `<li class="muted">${t("searching")}</li>`;
      try {
        const { items, note } = await searchSymbols(q.value.trim());
        res.innerHTML = (note ? `<li class="alert">${esc(note)}</li>` : "") + items.map((it, i) => `<li class="card" data-i="${i}">${logo(it)}<b>${esc(it.symbol)}</b> <span class="muted">${esc(it.exchange)}${it.currency ? " · " + esc(it.currency) : ""}${it.type && it.type !== "Action" && it.type !== "Common Stock" ? " · " + esc(it.type) : ""}</span><br><span class="small">${esc(it.name)}</span></li>`).join("") || `<li class="muted">${esc(t("noResult", { q: q.value.trim() }))}</li>`;
        res.querySelectorAll("[data-i]").forEach((li) => (li.onclick = () => {
          const it = items[+li.dataset.i];
          const id = upsertAsset(it);
          dlg.close();
          chooseAddMode(getState().assets[id]);
        }));
      } catch (e) {
        res.innerHTML = `<li class="alert">${esc(e.message)}</li>`;
      }
    }, 350);
  };
}

function chooseAddMode(asset) {
  const dlg = $("#add");
  dlg.innerHTML = `<div class="sheet">
    <header><button class="close" data-close aria-label="${t("close")}">✕</button><h2>${logo(asset)}${esc(asset.symbol)}</h2></header>
    <p class="muted">${esc(asset.name)}</p>
    <div class="actions"><button class="btn good" id="m-buy">${t("iBought")}</button><button class="btn" id="m-watch">${t("watchOnly")}</button></div>
  </div>`;
  dlg.showModal();
  $("#m-buy").onclick = async () => {
    $("#m-buy").disabled = true;
    // on charge d'abord le cours (et la devise) pour pré-remplir le formulaire
    try { await loadAsset(asset); } catch (e) { toast(e.message, "warn"); }
    dlg.close();
    openTxForm(getState().assets[asset.id], "BUY");
  };
  $("#m-watch").onclick = () => {
    update((s) => { if (!s.watch.includes(asset.id)) s.watch.push(asset.id); });
    dlg.close();
    loadAsset(asset).then(render).catch((e) => toast(e.message, "bad"));
    toast(t("addedToWatch", { s: asset.symbol }), "good");
  };
}

function openTxForm(asset, type, a = null) {
  const dlg = $("#add");
  const last = cachedCandles(asset)?.at(-1)?.close;
  const v = viewAcc();
  const lastTx = [...getState().transactions].reverse().find((x) => x.assetId === asset.id);
  const defAcc = v !== "all" ? v : lastTx ? acctOf(lastTx) : accounts()[0].id;
  const txOfAcc = (acc) => getState().transactions.filter((x) => acctOf(x) === acc);
  const pos = computePositions(txOfAcc(defAcc))[asset.id];
  const suggestedQty = a && ((type === "BUY" && a.action.startsWith("BUY")) || (type === "SELL" && a.action.startsWith("SELL"))) ? a.qty : "";
  dlg.innerHTML = `<div class="sheet">
    <header><button class="close" data-close aria-label="${t("close")}">✕</button><h2>${type === "BUY" ? t("buy") : t("sell")} ${esc(asset.symbol)}</h2></header>
    <form id="tx-form" class="settings">
      <label>${t("quantity")}<input name="qty" type="number" step="any" min="0" required value="${suggestedQty}" ${type === "SELL" && pos ? `max="${pos.qty}"` : ""}></label>
      <label>${t("unitPrice", { c: esc(asset.currency || "") })}<input name="price" type="number" step="any" min="0" required value="${last ?? ""}"></label>
      <label>${t("feesLabel")}<input name="fees" type="number" step="any" min="0" value="0"></label>
      <label>${t("date")}<input name="date" type="date" required value="${today()}"></label>
      ${accounts().length > 1 ? `<label>${t("account")}<select name="account">${accounts().map((a) => `<option value="${esc(a.id)}" ${a.id === defAcc ? "selected" : ""}>${esc(accName(a))}</option>`).join("")}</select></label>` : ""}
      <label class="check"><input name="cash" type="checkbox" checked> ${t("updateCash")}</label>
      <button class="btn primary">${t("save")}</button>
    </form></div>`;
  if (!dlg.open) dlg.showModal();
  $("#tx-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const acc = f.get("account") || defAcc;
    const tr = { id: uid(), assetId: asset.id, accountId: acc, type, qty: +f.get("qty"), price: +f.get("price"), fees: +f.get("fees") || 0, date: f.get("date") };
    if (!(tr.qty > 0) || !(tr.price > 0)) { toast(t("qtyPriceRequired"), "bad"); return; }
    if (type === "SELL") {
      // quantité détenue à la date de la vente ET aujourd'hui (une vente antidatée ne peut pas vendre des titres achetés après)
      const all = txOfAcc(acc);
      const held = Math.min(computePositions(all, tr.date)[asset.id]?.qty || 0, computePositions(all)[asset.id]?.qty || 0);
      if (tr.qty > held + 1e-9) { toast(t("heldOnly", { n: num(held, 0) }), "bad"); return; }
    }
    const fx = cachedFx(asset.currency, getState().settings.baseCurrency) ?? 1;
    update((s) => {
      s.transactions.push(tr);
      s.watch = s.watch.filter((x) => x !== asset.id || type === "SELL");
      // ligne entièrement vendue : on continue de la surveiller
      const left = computePositions(s.transactions)[asset.id]?.qty || 0;
      if (type === "SELL" && left <= 1e-9 && !s.watch.includes(asset.id)) s.watch.push(asset.id);
      if (f.get("cash")) {
        const amount = (tr.qty * tr.price + (type === "BUY" ? tr.fees : -tr.fees)) * fx;
        const A = s.accounts.find((x) => x.id === acc) || s.accounts[0];
        A.cash = Math.max(0, Math.round(((Number(A.cash) || 0) + (type === "BUY" ? -amount : amount)) * 100) / 100);
        syncCash(s);
      }
    });
    dlg.close();
    toast(t("txSaved"), "good");
    loadAsset(asset).then(render).catch((err) => toast(err.message, "bad"));
  };
}

// ---------- événements globaux ----------
document.addEventListener("click", (e) => {
  const accb = e.target.closest("[data-acc]");
  if (accb) { update((s) => { s.settings.viewAccount = accb.dataset.acc; }); return; }
  if (e.target.closest("#add-acc")) {
    const form = $("#settings");
    const f = form ? new FormData(form) : null;
    update((s) => { if (f) applyAccFields(s, f); s.accounts.push({ id: uid(), name: "", cash: 0 }); });
    if (form) delete $("#settings").dataset.dirty;
    render();
    return;
  }
  const dacc = e.target.closest("[data-delacc]");
  if (dacc) {
    const id = dacc.dataset.delacc;
    if (getState().transactions.some((x) => acctOf(x) === id)) { toast(t("accountHasTx"), "bad"); return; }
    if (!confirm(t("deleteAccountConfirm"))) return;
    update((s) => { s.accounts = s.accounts.filter((a) => a.id !== id); syncCash(s); });
    const form = $("#settings"); if (form) delete form.dataset.dirty;
    render();
    return;
  }
  const pfp = e.target.closest("[data-pfperiod]");
  if (pfp) { view.pfPeriod = pfp.dataset.pfperiod; document.querySelectorAll("[data-pfperiod]").forEach((b) => b.classList.toggle("active", b === pfp)); drawPortfolio(); return; }
  const tm = e.target.closest("[data-term]");
  if (tm) { e.preventDefault(); e.stopPropagation(); showTerm(tm.dataset.term); return; }
  if (e.target.closest("[data-share-copy]")) {
    navigator.clipboard?.writeText(shareText()).then(() => toast(t("copied"), "good"), () => toast(t("copyFail"), "bad"));
    return;
  }
  if (e.target.closest("[data-share-send]")) { navigator.share({ text: shareText() }).catch(() => {}); return; }
  if (e.target.closest("#share-app")) { e.preventDefault(); openShare(); return; }
  if (e.target.closest("[data-term-close]")) { $("#term-dlg")?.close(); return; }
  if (e.target.closest("[data-term-guide]")) { $("#term-dlg")?.close(); document.querySelectorAll("dialog[open]").forEach((d) => d.close()); view.tab = "guide"; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest("[data-tab],[data-open],[data-close],#refresh,#add-btn,#ai-portfolio,#export,#purge,#reset-rules");
  if (!el) return;
  if (el.dataset.tab) { e.preventDefault(); el.closest("dialog")?.close(); view.tab = el.dataset.tab; render(); return; }
  if (el.dataset.open) { openDetail(el.dataset.open); return; }
  if (el.hasAttribute("data-close")) { el.closest("dialog").close(); return; }
  if (el.id === "refresh") refreshAll(true); // force les cours ; les actus gardent leur cache
  if (el.id === "add-btn") openAdd();
  if (el.id === "ai-portfolio") runAIPortfolio();
  if (el.id === "export") {
    const name = `action-advisor-${today()}.json`;
    const file = new File([exportJSON()], name, { type: "application/json" });
    // Sur iPhone (app écran d'accueil), le menu Partager permet d'enregistrer dans Fichiers
    if (navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(() => {});
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  if (el.id === "purge") { purgeCache(); toast(t("cacheCleared")); render(); }
  if (el.id === "reset-rules") {
    const keep = ["lang", "dataProvider", "proxyUrl", "twelveDataKey", "finnhubKey", "anthropicKey", "openaiKey", "openaiModel", "aiProvider", "cash", "baseCurrency", "aiModel", "aiMonthlyTokenBudget"];
    update((s) => { for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!keep.includes(k)) s.settings[k] = v; });
    toast(t("rulesReset"));
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "settings") return;
  e.preventDefault();
  const f = new FormData(e.target);
  update((s) => {
    applyAccFields(s, f);
    for (const [k, v] of f.entries()) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      s.settings[k] = typeof DEFAULT_SETTINGS[k] === "number" ? (v === "" ? DEFAULT_SETTINGS[k] : +v) : String(v).trim();
    }
  });
  delete e.target.dataset.dirty;
  toast(t("settingsSaved"), "good");
  render();
});

document.addEventListener("change", (e) => {
  // Langue : appliquée immédiatement, sans attendre « Enregistrer »
  if (e.target.name === "lang") {
    const form = $("#settings");
    // on garde ce qui a été tapé mais pas encore enregistré, puis on réaffiche dans la nouvelle langue
    const pending = form ? Object.fromEntries(new FormData(form).entries()) : {};
    if (form) delete form.dataset.dirty;
    update((s) => { s.settings.lang = e.target.value; });
    const nf = $("#settings");
    if (nf) {
      for (const [k, v] of Object.entries(pending)) if (nf.elements[k] && k !== "lang") nf.elements[k].value = v;
      const changed = Object.entries(pending).some(([k, val]) => k !== "lang" && String(getState().settings[k] ?? "") !== String(val));
      if (changed) nf.dataset.dirty = "1";
    }
    return;
  }
  // Réglages IA : afficher les champs du fournisseur choisi
  if (e.target.name === "aiProvider") {
    document.querySelectorAll(".ai-group").forEach((g) => { g.hidden = g.dataset.provider !== e.target.value; });
  }
});

// Réglages IA : charger la liste des modèles du compte OpenAI
document.addEventListener("click", async (e) => {
  if (e.target.id !== "oai-load") return;
  const form = $("#settings");
  const key = form.elements.openaiKey.value.trim();
  const hint = $("#oai-hint");
  if (!key) { hint.textContent = t("oaiPasteFirst"); return; }
  e.target.disabled = true;
  hint.textContent = t("loading");
  try {
    const ai = await import("./ai.js");
    const models = await ai.listOpenAIModels(key);
    $("#oai-models").innerHTML = models.map((m) => `<option value="${esc(m)}">`).join("");
    const cheap = models.find((m) => /(mini|nano|luna)/i.test(m));
    if (!form.elements.openaiModel.value && (cheap || models[0])) form.elements.openaiModel.value = cheap || models[0];
    form.dataset.dirty = "1";
    hint.textContent = t("oaiFound", { n: models.length });
  } catch (err) {
    hint.textContent = err.message;
  }
  e.target.disabled = false;
});

// formulaire modifié mais pas encore enregistré : on évite de l'écraser lors d'un rafraîchissement
document.addEventListener("input", (e) => {
  const f = e.target.closest("#settings, #alert-form");
  if (f) f.dataset.dirty = "1";
});

document.addEventListener("change", async (e) => {
  if (e.target.id !== "import" || !e.target.files[0]) return;
  try { importJSON(await e.target.files[0].text()); toast(t("backupImported"), "good"); } catch (err) { toast(err.message, "bad"); }
});

document.querySelectorAll("dialog").forEach((d) => d.addEventListener("close", () => { if (d.id === "detail") { view.detail = null; chartToken++; } }));

onChange(() => render());
render();

// Au démarrage : rafraîchissement automatique si les données sont anciennes (le cache évite les appels inutiles)
const s0 = getState();
if (dataReady() && (!s0.lastRefresh || Date.now() - s0.lastRefresh > s0.settings.priceRefreshMinutes * 60000)) refreshAll(false);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

// pas de zoom (pincement / double-tap) : Safari iOS ignore parfois user-scalable=no
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => { const now = Date.now(); if (now - lastTouchEnd < 300) e.preventDefault(); lastTouchEnd = now; }, { passive: false });
