// Couche IA (Claude d'Anthropic, ou OpenAI au choix) — appelée UNIQUEMENT quand vous appuyez sur un bouton « Avis IA ».
// Économie de tokens :
//   • on envoie un résumé chiffré déjà calculé localement (indicateurs, verdict des règles), pas l'historique brut ;
//   • au plus 8 titres d'actualité, tronqués ;
//   • effort de réflexion « low » et réponse JSON courte ;
//   • résultat mis en cache (12 h par défaut) : même question = 0 token ;
//   • plafond mensuel de tokens réglable : au-delà, l'IA est bloquée.
import { getState, update, cacheGet, cacheSet, AI_MODELS, aiMissing, activeModel } from "./store.js";
import { t, langInfo, locale } from "./i18n.js";

// SDK Anthropic chargé seulement si on l'utilise
let Anthropic = null;
async function anthropicSdk() {
  if (!Anthropic) Anthropic = (await import("https://esm.sh/@anthropic-ai/sdk@1.12.0")).default;
  return Anthropic;
}

const PRICES = Object.fromEntries(AI_MODELS.map((m) => [m.id, m.price]));
// Modèles pour lesquels on active le repli serveur en cas de refus de sécurité
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

const SYSTEM = `Tu es un analyste actions prudent qui conseille un investisseur particulier français.
On te fournit un résumé chiffré déjà calculé (indicateurs techniques, position, verdict d'un moteur de règles) et quelques titres d'actualité.
Ta valeur ajoutée : interpréter les actualités et nuancer ou contredire le moteur de règles quand c'est justifié.
Règles : sois concis et concret ; ne promets jamais de gain ; si les données sont insuffisantes, dis-le et recommande d'attendre ;
la quantité proposée doit respecter les liquidités et le poids maximum fournis ; 0 si aucune transaction.
Écris tous les textes de ta réponse en {LANGUE} (les valeurs de "decision" restent les codes imposés).`;
const systemPrompt = () => SYSTEM.replace("{LANGUE}", langInfo().aiName);

const ASSET_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["ACHETER", "RENFORCER", "CONSERVER", "ALLEGER", "VENDRE_TOUT", "ATTENDRE"] },
    quantite: { type: "integer", description: "Nombre de titres à acheter ou vendre, 0 si aucun" },
    prix_limite: { type: "number", description: "Prix limite conseillé pour l'ordre, 0 si sans objet" },
    stop: { type: "number", description: "Stop de protection conseillé, 0 si sans objet" },
    objectif: { type: "number", description: "Objectif de cours, 0 si sans objet" },
    confiance: { type: "integer", description: "0 à 100" },
    accord_avec_regles: { type: "boolean" },
    resume: { type: "string", description: "2 phrases maximum" },
    points_cles: { type: "array", items: { type: "string" }, description: "3 points maximum" },
    risques: { type: "array", items: { type: "string" }, description: "3 risques maximum" },
  },
  required: ["decision", "quantite", "prix_limite", "stop", "objectif", "confiance", "accord_avec_regles", "resume", "points_cles", "risques"],
  additionalProperties: false,
};

const PORTFOLIO_SCHEMA = {
  type: "object",
  properties: {
    synthese: { type: "string", description: "3 phrases maximum sur l'état du portefeuille" },
    priorites: {
      type: "array",
      description: "Actions à mener, la plus importante d'abord, 5 maximum",
      items: {
        type: "object",
        properties: {
          symbole: { type: "string" },
          decision: { type: "string", enum: ["ACHETER", "RENFORCER", "CONSERVER", "ALLEGER", "VENDRE_TOUT", "ATTENDRE"] },
          quantite: { type: "integer" },
          raison: { type: "string" },
        },
        required: ["symbole", "decision", "quantite", "raison"],
        additionalProperties: false,
      },
    },
    diversification: { type: "string", description: "1 à 2 phrases" },
  },
  required: ["synthese", "priorites", "diversification"],
  additionalProperties: false,
};

function monthKey() { return new Date().toISOString().slice(0, 7); }

export function usage() {
  const s = getState();
  const u = s.aiUsage.month === monthKey() ? s.aiUsage : { month: monthKey(), input: 0, output: 0, calls: 0 };
  const price = s.settings.aiProvider === "openai" ? null : PRICES[s.settings.aiModel];
  const estCostUsd = price ? (u.input * price[0] + u.output * price[1]) / 1e6 : null; // inconnu pour OpenAI
  return { ...u, total: u.input + u.output, budget: s.settings.aiMonthlyTokenBudget, estCostUsd };
}

function record(u) {
  update((s) => {
    if (s.aiUsage.month !== monthKey()) s.aiUsage = { month: monthKey(), input: 0, output: 0, calls: 0 };
    s.aiUsage.input += u.input_tokens || 0;
    s.aiUsage.output += u.output_tokens || 0;
    s.aiUsage.calls += 1;
  });
}

// Petite empreinte stable pour la clé de cache
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---- Claude (SDK officiel Anthropic) ----
async function askAnthropic(settings, userContent, schema) {
  const Sdk = await anthropicSdk();
  const client = new Sdk({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
  const base = {
    model: settings.aiModel,
    max_tokens: 8000, // la réflexion compte dans ce plafond ; la dépense réelle reste faible (effort low, JSON court)
    system: systemPrompt(),
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: userContent }],
  };
  let response;
  try {
    response = FALLBACK_MODELS.has(settings.aiModel)
      ? await client.beta.messages.create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(base);
  } catch (error) {
    if (error instanceof Sdk.AuthenticationError) throw new Error(t("aiBadKey", { p: "Anthropic" }));
    if (error instanceof Sdk.RateLimitError) throw new Error(t("aiRateLimit"));
    if (error instanceof Sdk.BadRequestError) throw new Error(t("aiError", { s: 400, m: error.message }));
    if (error instanceof Sdk.APIError) throw new Error(t("aiError", { s: error.status ?? "", m: error.message }));
    throw error;
  }
  const usage = { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 };
  if (response.stop_reason === "refusal") return { usage, error: t("aiRefused") };
  if (response.stop_reason === "max_tokens") return { usage, error: t("aiTruncated") };
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { usage, text, model: response.model };
}

// ---- OpenAI (API Chat Completions, appel HTTP direct) ----
const OPENAI = "https://api.openai.com/v1";
async function openaiFetch(path, key, body) {
  let r;
  try {
    r = await fetch(OPENAI + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(t("cannotReach", { h: "api.openai.com" }));
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || `HTTP ${r.status}`;
    const err = new Error(
      r.status === 401 ? t("aiBadKey", { p: "OpenAI" })
      : r.status === 429 ? t("aiNoCredit", { p: "OpenAI", m: msg })
      : t("aiError", { s: r.status, m: msg }),
    );
    err.status = r.status;
    err.param = j.error?.param;
    err.raw = msg;
    throw err;
  }
  return j;
}

async function askOpenAI(settings, userContent, schema) {
  const body = {
    model: settings.openaiModel,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_schema", json_schema: { name: "avis", strict: true, schema } },
    max_completion_tokens: 8000,
    reasoning_effort: "low", // économise des tokens sur les modèles qui réfléchissent
  };
  let j;
  try {
    j = await openaiFetch("/chat/completions", settings.openaiKey, body);
  } catch (e) {
    // certains modèles n'acceptent pas reasoning_effort : on réessaie sans
    if (e.status === 400 && (e.param === "reasoning_effort" || /reasoning/i.test(e.raw || ""))) {
      delete body.reasoning_effort;
      j = await openaiFetch("/chat/completions", settings.openaiKey, body);
    } else throw e;
  }
  const usage = { input: j.usage?.prompt_tokens || 0, output: j.usage?.completion_tokens || 0 };
  const choice = j.choices?.[0];
  if (choice?.message?.refusal) return { usage, error: t("aiRefused") };
  if (choice?.finish_reason === "length") return { usage, error: t("aiTruncated") };
  return { usage, text: choice?.message?.content || "", model: j.model };
}

// Liste des modèles de texte disponibles sur le compte OpenAI (les plus récents d'abord)
export async function listOpenAIModels(key) {
  const j = await openaiFetch("/models", key);
  return (j.data || [])
    .filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id))
    .filter((m) => !/(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|codex)/i.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map((m) => m.id);
}

async function ask(userContent, schema, cacheKey) {
  const { settings } = getState();
  const hit = cacheGet(cacheKey, settings.aiCacheHours * 3600000);
  if (hit?.v) return { ...hit.v, _cached: true, _at: hit.t };

  const missing = aiMissing(settings);
  if (missing) throw new Error(t(missing));
  const u = usage();
  if (u.total >= u.budget) throw new Error(t("aiBudget", { n: u.total.toLocaleString(locale()) }));

  const res = settings.aiProvider === "openai"
    ? await askOpenAI(settings, userContent, schema)
    : await askAnthropic(settings, userContent, schema);
  record({ input_tokens: res.usage.input, output_tokens: res.usage.output });
  if (res.error) throw new Error(res.error);

  let parsed;
  try { parsed = JSON.parse(res.text); } catch { throw new Error(t("aiUnreadable")); }
  const result = { ...parsed, _model: res.model, _tokens: res.usage.input + res.usage.output };
  cacheSet(cacheKey, result);
  return { ...result, _cached: false, _at: Date.now() };
}

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);

// Avis IA sur une ligne. `a` = résultat de advise(), asset, position, news
export async function adviseAsset({ asset, a, position, news, portfolioValue, cash, settings, force = false }) {
  const ind = a.ind || {};
  const payload = {
    titre: `${asset.symbol} — ${asset.name}`,
    devise: asset.currency,
    date: ind.date,
    cours: r2(ind.price),
    indicateurs: {
      mm20: r2(ind.sma20), mm50: r2(ind.sma50), mm200: r2(ind.sma200), rsi14: r2(ind.rsi14),
      macd_hist: r2(ind.macdHist), atr14: r2(ind.atr14), plus_haut_52s: r2(ind.high52), plus_bas_52s: r2(ind.low52),
      perf_1s_pct: pct(ind.perf1w), perf_1m_pct: pct(ind.perf1m), perf_3m_pct: pct(ind.perf3m), perf_1a_pct: pct(ind.perf1y),
      volatilite_annuelle_pct: pct(ind.volatility),
    },
    position: position?.qty ? { quantite: position.qty, pru: r2(position.avgPrice), plus_value_pct: pct(ind.price / position.avgPrice - 1) } : null,
    portefeuille: { valeur_totale: r2(portfolioValue), liquidites: r2(cash), poids_max_pct: settings.maxPositionPct, poids_cible_pct: settings.targetPositionPct },
    moteur_de_regles: {
      verdict: a.action, quantite: a.qty, score: a.score, stop: a.levels.stop, objectif: a.levels.target, zone_achat: a.levels.buyZone,
      raisons: a.reasons.slice(0, 6).map((r) => r.txt),
    },
    actualites: (news || []).slice(0, 8).map((n) => `${new Date(n.datetime).toISOString().slice(0, 10)} ${String(n.title).slice(0, 140)}`),
  };
  const content = `Donne ton avis sur cette ligne.\n${JSON.stringify(payload)}`;
  const key = `ai:${asset.id}:${settings.aiProvider}:${activeModel(settings)}:${langInfo().id}:${hash(content)}`;
  if (force) cacheSet(key, null);
  return ask(content, ASSET_SCHEMA, key);
}

// Bilan IA du portefeuille complet : une seule requête pour toutes les lignes.
export async function reviewPortfolio({ rows, portfolioValue, cash, settings }) {
  const payload = {
    valeur_totale: r2(portfolioValue),
    liquidites: r2(cash),
    poids_max_pct: settings.maxPositionPct,
    lignes: rows.map(({ asset, a, position }) => ({
      s: asset.symbol,
      nom: asset.name?.slice(0, 40),
      pays: asset.country,
      qte: position?.qty || 0,
      pru: r2(position?.avgPrice),
      cours: r2(a.price),
      poids_pct: position?.qty ? pct((position.qty * a.price) / portfolioValue) : 0,
      score: a.score,
      regle: a.action,
      rsi: r2(a.ind?.rsi14),
      perf_3m_pct: pct(a.ind?.perf3m),
      actus: a.sentiment?.count ? `${a.sentiment.pos}+/${a.sentiment.neg}-` : "",
    })),
  };
  const content = `Fais le bilan de ce portefeuille et donne les priorités.\n${JSON.stringify(payload)}`;
  return ask(content, PORTFOLIO_SCHEMA, `aiport:${settings.aiProvider}:${activeModel(settings)}:${langInfo().id}:${hash(content)}`);
}
