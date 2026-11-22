// Récupération des cours et actualités. Tout est mis en cache pour économiser les quotas gratuits.
// Deux fournisseurs de cours au choix (Réglages) :
//  - « yahoo »      : Yahoo Finance via VOTRE relais Cloudflare (gratuit, voir proxy/worker.js).
//                     Couvre Paris, Europe, US… + actualités. Recommandé pour les actions françaises.
//  - « twelvedata » : Twelve Data (clé gratuite, 8 req/min, 800/jour) — le plan gratuit ne couvre que les actions US.
// Actualités : Finnhub (US, clé gratuite) → Yahoo (si relais) → GDELT (gratuit, sans clé, 1 req / 5 s).
import { getState, cacheGet, cacheSet, DEFAULT_SETTINGS } from "./store.js";
import { t } from "./i18n.js";

const TD = "https://api.twelvedata.com";
const FH = "https://finnhub.io/api/v1";
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";

// File d'attente limitant le débit (n requêtes par fenêtre de w ms)
function limiter(n, w) {
  const stamps = [];
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      let now = Date.now();
      while (stamps.length && now - stamps[0] > w) stamps.shift();
      if (stamps.length >= n) {
        await new Promise((r) => setTimeout(r, w - (now - stamps[0]) + 50));
        now = Date.now();
        while (stamps.length && now - stamps[0] > w) stamps.shift();
      }
      stamps.push(Date.now());
    });
    chain = run.catch(() => {});
    return run.then(fn);
  };
}
const tdQueue = limiter(8, 61000);
const yahooQueue = limiter(4, 1000);
const gdeltQueue = limiter(1, 5500);

async function getJSON(url) {
  let r;
  try {
    r = await fetch(url);
  } catch {
    // erreur réseau brute (« NetworkError », « Load failed »…) → message compréhensible
    throw new Error(t("cannotReach", { h: new URL(url).hostname }));
  }
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(text.slice(0, 160) || `HTTP ${r.status}`); }
  if (!r.ok) throw new Error(j?.message || j?.error || j?.chart?.error?.description || `HTTP ${r.status}`);
  return j;
}

const settings = () => getState().settings;
// champ vide → relais par défaut (celui déployé pour vous)
const proxyBase = () => ((settings().proxyUrl || "").trim() || DEFAULT_SETTINGS.proxyUrl).replace(/\/+$/, "");
const providerOf = (asset) => asset.provider || (asset.mic ? "twelvedata" : "yahoo");

export function dataReady() {
  const st = settings();
  return st.dataProvider === "yahoo" ? !!proxyBase() : !!st.twelveDataKey;
}

// ---------- Yahoo (via relais) ----------
async function yahoo(path, params) {
  const base = proxyBase();
  if (!base) throw new Error(t("relayMissing"));
  return yahooQueue(() => getJSON(`${base}${path}?${new URLSearchParams(params)}`));
}

const YAHOO_TYPES = { EQUITY: "Action", ETF: "ETF", MUTUALFUND: "Fonds", INDEX: "Indice" };

// ---------- Recherche de titres ----------
// Suffixes Yahoo par place de cotation (code MIC)
const MIC_TO_YAHOO = {
  XPAR: ".PA", XAMS: ".AS", XBRU: ".BR", XLIS: ".LS", XETR: ".DE", XFRA: ".F", XMIL: ".MI", XMAD: ".MC",
  XLON: ".L", XSWX: ".SW", XSTO: ".ST", XHEL: ".HE", XCSE: ".CO", XOSL: ".OL", XWBO: ".VI", XDUB: ".IR", XTSE: ".TO",
  XNAS: "", XNYS: "", XNGS: "", XNMS: "", XNCM: "", ARCX: "", BATS: "", XASE: "",
};
const COUNTRY_RANK = { France: 0, "United States": 1, Germany: 2, Netherlands: 2, Belgium: 2, Italy: 3, Spain: 3, Switzerland: 3, "United Kingdom": 3 };
const TYPE_RANK = { "Common Stock": 0, ETF: 1, "Preferred Stock": 2, "Depositary Receipt": 3, "American Depositary Receipt": 3 };

// Recherche Twelve Data (gratuite, sans clé). En mode Yahoo, on convertit le résultat en symbole Yahoo (AIR + XPAR → AIR.PA).
async function twelveSearch(query, toYahoo) {
  const j = await getJSON(`${TD}/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=30`);
  const seen = new Set();
  return (j.data || [])
    .filter((d) => TYPE_RANK[d.instrument_type] != null)
    .filter((d) => !toYahoo || MIC_TO_YAHOO[d.mic_code] != null)
    .sort((a, b) => (COUNTRY_RANK[a.country] ?? 9) - (COUNTRY_RANK[b.country] ?? 9) || TYPE_RANK[a.instrument_type] - TYPE_RANK[b.instrument_type])
    .map((d) => ({
      provider: toYahoo ? "yahoo" : "twelvedata",
      symbol: toYahoo ? d.symbol + MIC_TO_YAHOO[d.mic_code] : d.symbol,
      mic: toYahoo ? "" : d.mic_code,
      name: d.instrument_name,
      exchange: d.exchange,
      currency: d.currency,
      country: d.country,
      type: d.instrument_type,
    }))
    .filter((d) => { const k = d.symbol + d.mic; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function yahooSearch(query) {
  const j = await yahoo("/v1/finance/search", { q: query, quotesCount: "15", newsCount: "0" });
  return (j.quotes || [])
    .filter((q) => q.symbol && YAHOO_TYPES[q.quoteType])
    .sort((a, b) => (a.quoteType === "EQUITY" ? 0 : 1) - (b.quoteType === "EQUITY" ? 0 : 1))
    .map((q) => ({
      provider: "yahoo",
      symbol: q.symbol,
      mic: "",
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchDisp || q.exchange,
      currency: "", // connue au premier chargement des cours
      country: /\.PA$/.test(q.symbol) ? "France" : /\./.test(q.symbol) ? "" : "United States",
      type: YAHOO_TYPES[q.quoteType],
    }));
}

// Renvoie { items, note } — note = message à afficher (ex. relais non configuré)
export async function searchSymbols(query) {
  query = (query || "").trim();
  if (!query) return { items: [], note: "" };
  if (settings().dataProvider !== "yahoo") return { items: await twelveSearch(query, false), note: "" };
  if (proxyBase()) {
    try {
      const items = await yahooSearch(query);
      if (items.length) return { items, note: "" };
    } catch (e) {
      const items = await twelveSearch(query, true);
      return { items, note: t("searchRelayDown", { m: e.message }) };
    }
    return { items: await twelveSearch(query, true), note: "" };
  }
  return {
    items: await twelveSearch(query, true),
    note: t("searchNoRelay"),
  };
}

// ---------- Bougies journalières ----------
async function yahooCandles(asset) {
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(asset.symbol)}`, { range: "2y", interval: "1d" });
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(j.chart?.error?.description || t("noPriceData"));
  const q = res.indicators?.quote?.[0] || {};
  const candles = [];
  (res.timestamp || []).forEach((t, i) => {
    if (q.close?.[i] == null) return; // séances sans cotation
    candles.push({
      date: new Date((t + (res.meta?.gmtoffset || 0)) * 1000).toISOString().slice(0, 10),
      open: q.open[i] ?? q.close[i],
      high: q.high[i] ?? q.close[i],
      low: q.low[i] ?? q.close[i],
      close: q.close[i],
      volume: q.volume?.[i] || 0,
    });
  });
  // le dernier cours connu (séance en cours) remplace la clôture du jour
  const live = res.meta?.regularMarketPrice;
  if (live && candles.length) candles[candles.length - 1].close = live;
  // Londres (GBp), Johannesburg (ZAc), Tel-Aviv (ILA) cotent en centièmes : on convertit en unités
  let currency = res.meta?.currency;
  const SUB = { GBp: "GBP", GBX: "GBP", ZAc: "ZAR", ILA: "ILS" };
  if (SUB[currency]) {
    currency = SUB[currency];
    for (const c of candles) for (const k of ["open", "high", "low", "close"]) c[k] /= 100;
  }
  return { candles, currency };
}

async function twelveCandles(asset) {
  const key = settings().twelveDataKey;
  if (!key) throw new Error(t("tdKeyMissing"));
  const params = new URLSearchParams({ symbol: asset.symbol, interval: "1day", outputsize: "300", apikey: key });
  if (asset.mic) params.set("mic_code", asset.mic);
  const j = await tdQueue(() => getJSON(`${TD}/time_series?${params}`));
  if (j.status === "error") throw new Error(j.message);
  const candles = (j.values || [])
    .map((v) => ({ date: v.datetime, open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +v.volume || 0 }))
    .reverse();
  return { candles, currency: j.meta?.currency };
}

// Renvoie {candles, currency?, fromCache, at, stale?, error?}
export async function getCandles(asset, { force = false } = {}) {
  const key = `candles:${asset.id}`;
  const maxAge = settings().priceRefreshMinutes * 60000;
  const cached = cacheGet(key, null);
  if (!force && cached && Date.now() - cached.t < maxAge) return { candles: cached.v, fromCache: true, at: cached.t };
  try {
    const { candles, currency } = providerOf(asset) === "yahoo" ? await yahooCandles(asset) : await twelveCandles(asset);
    if (!candles.length) throw new Error(t("noPriceData"));
    cacheSet(key, candles);
    return { candles, currency, fromCache: false, at: Date.now() };
  } catch (e) {
    if (cached) return { candles: cached.v, fromCache: true, at: cached.t, stale: true, error: e.message };
    throw e;
  }
}

// ---------- Actualités ----------
const US_MICS = new Set(["XNAS", "XNYS", "XNGS", "XNMS", "XNCM", "ARCX", "BATS", "XASE"]);
const isUS = (a) => US_MICS.has(a.mic) || a.country === "United States";
const isFR = (a) => a.country === "France" || a.mic === "XPAR" || /\.PA$/.test(a.symbol);

function cleanName(name = "") {
  return name
    .replace(/\(.*?\)/g, "")
    .replace(/[–—].*$/, "")
    .replace(/[,.]/g, " ")
    .replace(/\b(SE|SA|S A|AG|NV|N V|PLC|Inc|Corp|Corporation|Ltd|Company|Co|Group|Holding|Holdings|Société Européenne|Class [A-C]|Common Stock)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function finnhubNews(asset, key) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const j = await getJSON(`${FH}/company-news?symbol=${encodeURIComponent(asset.symbol)}&from=${iso(new Date(Date.now() - 10 * 86400000))}&to=${iso(new Date())}&token=${key}`);
  return (Array.isArray(j) ? j : []).slice(0, 25).map((n) => ({ title: n.headline, url: n.url, source: n.source, datetime: n.datetime * 1000 }));
}

async function yahooNews(asset) {
  const j = await yahoo("/v1/finance/search", { q: asset.symbol, quotesCount: "0", newsCount: "15" });
  return (j.news || []).map((n) => ({ title: n.title, url: n.link, source: n.publisher, datetime: (n.providerPublishTime || 0) * 1000 }));
}

async function gdeltNews(asset) {
  const name = cleanName(asset.name) || asset.symbol;
  const term = name.includes(" ") ? `"${name}"` : name;
  const params = new URLSearchParams({
    query: `${term} sourcelang:${isFR(asset) ? "french" : "english"}`,
    mode: "artlist",
    format: "json",
    maxrecords: "25",
    timespan: "7d",
    sort: "datedesc",
  });
  const j = await gdeltQueue(() => getJSON(`${GDELT}?${params}`));
  return (j.articles || []).map((a) => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate || "");
    return { title: a.title, url: a.url, source: a.domain, datetime: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.now() };
  });
}

export async function getNews(asset, { force = false } = {}) {
  const st = settings();
  const key = `news:${asset.id}`;
  const cached = cacheGet(key, null);
  if (!force && cached && Date.now() - cached.t < st.newsRefreshMinutes * 60000) return cached.v;
  // ordre des sources selon le titre ; on s'arrête à la première qui répond avec des articles
  const sources = [];
  if (isUS(asset) && st.finnhubKey) sources.push(() => finnhubNews(asset, st.finnhubKey));
  if (isFR(asset)) sources.push(() => gdeltNews(asset));
  if (proxyBase()) sources.push(() => yahooNews(asset));
  if (!isFR(asset)) sources.push(() => gdeltNews(asset));
  let items = [], lastErr = null;
  for (const src of sources) {
    try { items = await src(); } catch (e) { lastErr = e; }
    if (items.length) break;
  }
  if (!items.length && cached) return cached.v;
  if (!items.length && lastErr) throw lastErr;
  const seen = new Set();
  items = items.filter((n) => n.title && !seen.has(n.title.toLowerCase()) && seen.add(n.title.toLowerCase()));
  items.sort((a, b) => b.datetime - a.datetime);
  cacheSet(key, items);
  return items;
}

export const cachedNews = (asset) => cacheGet(`news:${asset.id}`, null)?.v || [];
export const cachedCandles = (asset) => cacheGet(`candles:${asset.id}`, null)?.v || null;

// ---------- Taux de change (pour additionner des lignes en devises différentes) ----------
export async function getFx(from, to) {
  if (!from || !to || from === to) return 1;
  const key = `fx:${from}/${to}`;
  const cached = cacheGet(key, 12 * 3600000);
  if (cached) return cached.v;
  try {
    let rate;
    if (proxyBase()) {
      const j = await yahoo(`/v8/finance/chart/${from}${to}=X`, { range: "5d", interval: "1d" });
      rate = j.chart?.result?.[0]?.meta?.regularMarketPrice;
    } else if (settings().twelveDataKey) {
      const j = await tdQueue(() => getJSON(`${TD}/exchange_rate?symbol=${from}/${to}&apikey=${settings().twelveDataKey}`));
      rate = j.rate;
    }
    if (!(rate > 0)) throw new Error("taux indisponible");
    cacheSet(key, +rate);
    return +rate;
  } catch {
    return cacheGet(key, null)?.v ?? null;
  }
}
// Taux de change jour par jour sur 2 ans (pour l'historique du portefeuille) : { "AAAA-MM-JJ": taux }
export async function getFxSeries(from, to) {
  if (!from || !to || from === to || !proxyBase()) return null;
  const key = `fxs:${from}/${to}`;
  const cached = cacheGet(key, 12 * 3600000);
  if (cached) return cached.v;
  try {
    const j = await yahoo(`/v8/finance/chart/${from}${to}=X`, { range: "2y", interval: "1d" });
    const res = j.chart?.result?.[0];
    const closes = res?.indicators?.quote?.[0]?.close || [];
    const map = {};
    (res?.timestamp || []).forEach((ts, i) => { if (closes[i] > 0) map[new Date(ts * 1000).toISOString().slice(0, 10)] = +closes[i].toFixed(5); });
    if (!Object.keys(map).length) throw new Error("fx");
    cacheSet(key, map);
    return map;
  } catch {
    return cacheGet(key, null)?.v ?? null;
  }
}
export const cachedFxSeries = (from, to) => (from === to ? null : cacheGet(`fxs:${from}/${to}`, null)?.v ?? null);
export function cachedFx(from, to) {
  if (!from || !to || from === to) return 1;
  return cacheGet(`fx:${from}/${to}`, null)?.v ?? null;
}

// ---------- Séries pour la courbe interactive (durées 1J … Tout) ----------
// 1M / 6M / 1A utilisent les bougies journalières déjà en cache (0 requête en plus).
// 1J, 1S, 5A et Tout sont chargés à la demande puis mis en cache.
export const PERIODS = ["1D", "1W", "1M", "6M", "1Y", "5Y", "ALL"];
const SPEC = {
  "1D": { yr: "1d", yi: "5m", ti: "5min", tn: 100, ttl: 5, intraday: true },
  "1W": { yr: "5d", yi: "30m", ti: "30min", tn: 80, ttl: 30, intraday: true },
  "5Y": { yr: "5y", yi: "1wk", ti: "1week", tn: 262, ttl: 1440 },
  ALL: { yr: "max", yi: "1mo", ti: "1month", tn: 600, ttl: 1440 },
};
const DAILY = { "1M": 22, "6M": 126, "1Y": 252 };

// Renvoie { points: [{t (ms), close}], intraday, daily } ; daily = true → les moyennes mobiles s'appliquent
export async function getSeries(asset, period) {
  if (DAILY[period]) {
    const c = cachedCandles(asset) || [];
    const pts = c.slice(-DAILY[period]).map((x) => ({ t: Date.parse(x.date + "T12:00:00"), close: x.close }));
    return { points: pts, daily: true, candles: c };
  }
  const sp = SPEC[period];
  const key = `series:${asset.id}:${period}`;
  const cached = cacheGet(key, sp.ttl * 60000);
  if (cached) return { points: cached.v.points || cached.v, base: cached.v.base, intraday: !!sp.intraday };
  let points = [], base = null;
  try {
    if (providerOf(asset) === "yahoo") {
      const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(asset.symbol)}`, { range: sp.yr, interval: sp.yi });
      const res = j.chart?.result?.[0];
      const closes = res?.indicators?.quote?.[0]?.close || [];
      const SUB = { GBp: 100, GBX: 100, ZAc: 100, ILA: 100 };
      const div = SUB[res?.meta?.currency] || 1;
      points = (res?.timestamp || []).map((ts, i) => ({ t: ts * 1000, close: closes[i] == null ? null : closes[i] / div })).filter((p) => p.close != null);
      if (period === "1D" && res?.meta?.chartPreviousClose) base = res.meta.chartPreviousClose / div; // variation vs clôture de la veille
    } else {
      const k = settings().twelveDataKey;
      if (!k) throw new Error(t("tdKeyMissing"));
      const params = new URLSearchParams({ symbol: asset.symbol, interval: sp.ti, outputsize: String(sp.tn), apikey: k, timezone: "UTC" });
      if (asset.mic) params.set("mic_code", asset.mic);
      const j = await tdQueue(() => getJSON(`${TD}/time_series?${params}`));
      if (j.status === "error") throw new Error(j.message);
      points = (j.values || []).map((v) => ({ t: Date.parse(v.datetime.length > 10 ? v.datetime.replace(" ", "T") + "Z" : v.datetime + "T12:00:00Z"), close: +v.close })).reverse();
    }
  } catch (e) {
    const old = cacheGet(key, null);
    if (old) return { points: old.v.points || old.v, base: old.v.base, intraday: !!sp.intraday, stale: true };
    throw e;
  }
  if (!points.length) throw new Error(t("noPriceData"));
  cacheSet(key, { points, base });
  return { points, base, intraday: !!sp.intraday };
}
