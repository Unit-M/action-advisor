// Stockage local (sur l'iPhone uniquement). Aucune donnée n'est envoyée à un serveur à nous.

const KEY = "aa:v1";

export const DEFAULT_SETTINGS = {
  dataProvider: "yahoo", // "yahoo" (via relais, couvre Paris) ou "twelvedata" (US seulement en gratuit)
  proxyUrl: "https://action-advisor-relais.aa-094c4ab5.workers.dev", // votre relais Cloudflare (proxy/worker.js)
  twelveDataKey: "",
  finnhubKey: "",
  aiProvider: "anthropic", // "anthropic" (Claude) ou "openai"
  anthropicKey: "",
  aiModel: "claude-opus-5-5", // modèle Claude
  openaiKey: "",
  openaiModel: "", // choisi dans la liste chargée depuis votre compte OpenAI
  aiMonthlyTokenBudget: 300000, // plafond mensuel (entrée + sortie)
  aiCacheHours: 12,
  priceRefreshMinutes: 30,
  newsRefreshMinutes: 120,
  lang: "fr", // langue de l'interface : fr, en, fa
  baseCurrency: "EUR",
  cash: 0, // liquidités disponibles pour acheter (en devise de base)
  riskPerTradePct: 1, // % du portefeuille risqué par achat (distance au stop)
  targetPositionPct: 10, // poids visé par ligne
  maxPositionPct: 20, // poids maximum par ligne
  stopAtrMult: 2.5, // stop suiveur = plus haut depuis l'achat − k × ATR
  takeProfitPct: 25, // prise de bénéfice partielle au-delà de +x %
  buyScore: 35, // score minimum pour un signal d'achat
  sellScore: -35, // score maximum avant un signal d'allègement
};

function blank() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    assets: {}, // id -> {id, symbol, mic, name, exchange, currency, country}
    transactions: [], // {id, assetId, accountId, type:'BUY'|'SELL', qty, price, fees, date}
    accounts: [{ id: "main", name: "", cash: 0 }], // comptes (courtiers) : chacun ses liquidités
    cashFlows: [], // versements / retraits / dividendes par compte : {id, accountId, date, kind:'DEP'|'WD'|'DIV', amount (signé), currency}
    manualPrices: {}, // placements sans cotation (FCPE…) : id -> [{date, close}] saisis à la main
    watch: [], // ids suivis sans position
    alerts: {}, // id -> {below, above}
    aiUsage: { month: "", input: 0, output: 0, calls: 0 },
  };
}

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const s = JSON.parse(raw);
    const b = blank();
    const st = { ...b.settings, ...(s.settings || {}) };
    if (!st.proxyUrl) st.proxyUrl = DEFAULT_SETTINGS.proxyUrl; // relais vide enregistré avant sa création
    return migrate({ ...b, ...s, settings: st });
  } catch {
    return blank();
  }
}

// anciennes sauvegardes : un seul compte, qui reprend les liquidités globales
function migrate(s) {
  if (!Array.isArray(s.accounts) || !s.accounts.length) s.accounts = [{ id: "main", name: "", cash: Number(s.settings?.cash) || 0 }];
  if (!s.manualPrices || typeof s.manualPrices !== "object") s.manualPrices = {};
  if (!Array.isArray(s.cashFlows)) s.cashFlows = [];
  return s;
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn("save failed", e); }
  listeners.forEach((fn) => fn(state));
}

export const getState = () => state;
export const onChange = (fn) => listeners.add(fn);

export function update(mutator) {
  mutator(state);
  save();
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function assetId(symbol, mic) {
  return `${symbol}${mic ? ":" + mic : ""}`.toUpperCase();
}

export function upsertAsset(a) {
  const id = assetId(a.symbol, a.mic);
  // on n'écrase jamais une valeur connue (ex. devise) par une valeur vide
  const clean = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== "" && v != null));
  update((s) => { s.assets[id] = { ...(s.assets[id] || {}), ...clean, id }; });
  return id;
}

// ---- Export / import (sauvegarde manuelle) ----
const SECRET_KEYS = ["anthropicKey", "openaiKey", "twelveDataKey", "finnhubKey"];
// La sauvegarde n'inclut PAS les clés API (fichier potentiellement partagé / stocké dans le cloud)
export function exportJSON() {
  const settings = { ...state.settings };
  SECRET_KEYS.forEach((k) => delete settings[k]);
  return JSON.stringify({ ...state, settings }, null, 2);
}
export function importJSON(text) {
  const s = JSON.parse(text);
  // fichier « versements » (ex. extrait d'un relevé) : AJOUTÉ au compte du même nom, sans rien remplacer
  if (s?.type === "aa-cashflows" && Array.isArray(s.flows)) {
    const name = String(s.account || "").trim();
    let acc = state.accounts.find((a) => (a.name || "").toLowerCase() === name.toLowerCase())
      || (state.accounts.length === 1 ? state.accounts[0] : null);
    if (!acc) { acc = { id: uid(), name, cash: 0 }; state.accounts.push(acc); }
    const key = (f) => [f.date, f.kind, f.amount, f.currency].join("|");
    const have = new Set(state.cashFlows.filter((f) => f.accountId === acc.id).map(key));
    let n = 0;
    for (const f of s.flows) {
      if (!f.date || !isFinite(f.amount) || have.has(key(f))) continue;
      state.cashFlows.push({ id: uid(), accountId: acc.id, date: f.date, kind: f.kind || (f.amount < 0 ? "WD" : "DEP"), amount: +f.amount, currency: f.currency || state.settings.baseCurrency });
      n++;
    }
    save();
    return { flows: n, account: acc.name || "" };
  }
  if (!s || typeof s !== "object" || !s.assets || !Array.isArray(s.transactions)) throw new Error("Fichier invalide");
  const b = blank();
  const keys = Object.fromEntries(SECRET_KEYS.map((k) => [k, state.settings[k]]));
  state = migrate({ ...b, ...s, settings: { ...b.settings, ...keys, ...(s.settings || {}) } });
  save();
}

// ---- Cache générique avec durée de vie ----
export function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem("aa:c:" + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (maxAgeMs != null && Date.now() - t > maxAgeMs) return null;
    return { t, v };
  } catch { return null; }
}
export function cacheSet(key, v) {
  try { localStorage.setItem("aa:c:" + key, JSON.stringify({ t: Date.now(), v })); } catch (e) {
    // quota plein : on purge les caches et on réessaie une fois
    purgeCache();
    try { localStorage.setItem("aa:c:" + key, JSON.stringify({ t: Date.now(), v })); } catch {}
  }
}
export function purgeCache() {
  Object.keys(localStorage).filter((k) => k.startsWith("aa:c:")).forEach((k) => localStorage.removeItem(k));
}

// ---- Positions calculées à partir des transactions (méthode du PRU / coût moyen pondéré) ----
// Modèles IA proposés (ici et non dans ai.js pour afficher les Réglages sans télécharger le SDK)
export const AI_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — le plus fiable ($4 / $20 par M tokens)", price: [4, 20] },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — intermédiaire ($2 / $10)", price: [2, 10] },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 — le moins cher ($0.10 / $0.50)", price: [0.1, 0.5] },
];

// IA configurée ? Renvoie "" si oui, sinon la clé de traduction du message (i18n.js).
export function aiMissing(st) {
  if (st.aiProvider === "openai") {
    if (!st.openaiKey) return "aiNoOpenaiKey";
    if (!st.openaiModel) return "aiNoOpenaiModel";
    return "";
  }
  return st.anthropicKey ? "" : "aiNoAnthropicKey";
}
export const activeModel = (st) => (st.aiProvider === "openai" ? st.openaiModel : st.aiModel);

export function computePositions(transactions, asOf = null) {
  if (asOf) transactions = transactions.filter((t) => t.date <= asOf);
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const pos = {};
  for (const t of sorted) {
    const p = (pos[t.assetId] ||= { assetId: t.assetId, qty: 0, cost: 0, realized: 0, firstBuy: null, fees: 0 });
    const fees = Number(t.fees) || 0;
    p.fees += fees;
    if (t.type === "BUY") {
      p.cost += t.qty * t.price + fees;
      p.qty += t.qty;
      if (!p.firstBuy || p.qty === t.qty) p.firstBuy = t.date; // nouvelle ligne si on était à 0
    } else if (t.type === "SELL") {
      const q = Math.min(t.qty, p.qty);
      const avg = p.qty ? p.cost / p.qty : 0;
      p.realized += q * t.price - fees - q * avg;
      p.cost -= q * avg;
      p.qty -= q;
      if (p.qty <= 1e-9) { p.qty = 0; p.cost = 0; p.firstBuy = null; }
    }
  }
  for (const p of Object.values(pos)) p.avgPrice = p.qty ? p.cost / p.qty : 0;
  return pos;
}
