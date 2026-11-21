// Score de sentiment des titres d'actualité par lexique FR/EN — 0 token IA.
// Ce n'est pas aussi fin qu'un LLM, mais c'est gratuit, instantané et suffisant pour repérer
// une vague de mauvaises (ou bonnes) nouvelles. L'IA n'est appelée que si vous le demandez.

const POS = {
  // EN
  beat: 2, beats: 2, surge: 2, surges: 2, soar: 2, soars: 2, record: 1, upgrade: 2, upgraded: 2, outperform: 2,
  growth: 1, profit: 1, profits: 1, raises: 1, raised: 1, strong: 1, rally: 1, rallies: 1, buyback: 2, dividend: 1,
  partnership: 1, approval: 2, approved: 2, wins: 1, win: 1, contract: 1, jump: 1, jumps: 1, gain: 1, gains: 1,
  bullish: 2, exceeds: 2, tops: 1, expands: 1, breakthrough: 2,
  // FR
  hausse: 1, bondit: 2, bond: 1, envol: 2, "s'envole": 2, relève: 2, releve: 2, rachat: 1, dividende: 1,
  bénéfice: 1, benefice: 1, croissance: 1, contrat: 1, partenariat: 1, autorisation: 1, succès: 1, succes: 1,
  progresse: 1, progression: 1, rebond: 1, rebondit: 1, surperforme: 2, dépasse: 2, depasse: 2, solide: 1,
  "relèvement": 2, acquisition: 1, optimiste: 1, achat: 1, "relève ses objectifs": 3,
};

const NEG = {
  // EN
  miss: 2, misses: 2, plunge: 2, plunges: 2, sink: 2, sinks: 2, downgrade: 2, downgraded: 2, underperform: 2,
  loss: 1, losses: 1, cuts: 1, cut: 1, weak: 1, lawsuit: 2, probe: 2, investigation: 2, fraud: 3, recall: 2,
  layoffs: 1, layoff: 1, bankruptcy: 3, default: 2, warning: 2, warns: 2, slump: 2, fall: 1, falls: 1, drop: 1,
  drops: 1, bearish: 2, fine: 1, fined: 2, delay: 1, delays: 1, halt: 2, scandal: 3, decline: 1, declines: 1,
  // FR
  baisse: 1, chute: 2, plonge: 2, recul: 1, recule: 1, abaisse: 2, dégradation: 2, degradation: 2, perte: 1,
  pertes: 1, avertissement: 2, enquête: 2, enquete: 2, fraude: 3, rappel: 1, licenciements: 1, faillite: 3,
  amende: 2, retard: 1, suspension: 2, scandale: 3, déçoit: 2, decoit: 2, "sous-performe": 2, dégringole: 2,
  degringole: 2, effondrement: 3, "s'effondre": 3, inquiétude: 1, inquietude: 1, menace: 1, procès: 2, proces: 2,
  "abaisse ses objectifs": 3, vente: 1,
};

const NEGATORS = new Set(["not", "no", "pas", "ne", "sans", "never", "jamais"]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[«»"“”,.;:!?()[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Renvoie un score entre -1 (très négatif) et +1 (très positif).
export function scoreHeadline(title) {
  if (!title) return 0;
  const lower = title.toLowerCase();
  let score = 0;
  // expressions multi-mots
  for (const [k, w] of Object.entries(POS)) if (k.includes(" ") && lower.includes(k)) score += w;
  for (const [k, w] of Object.entries(NEG)) if (k.includes(" ") && lower.includes(k)) score -= w;
  const toks = tokenize(title);
  toks.forEach((t, i) => {
    const neg = i > 0 && NEGATORS.has(toks[i - 1]);
    const p = Object.hasOwn(POS, t) ? POS[t] : 0;
    const n = Object.hasOwn(NEG, t) ? NEG[t] : 0;
    const v = p - n;
    score += neg ? -v : v;
  });
  return Math.max(-1, Math.min(1, score / 3));
}

// Agrège une liste d'articles [{title, datetime}] en un score -1..1, pondéré par la fraîcheur.
export function aggregateSentiment(articles, now = Date.now()) {
  if (!articles?.length) return { score: 0, count: 0, pos: 0, neg: 0 };
  let sum = 0, wsum = 0, pos = 0, neg = 0;
  for (const a of articles) {
    const s = a.sentiment ?? scoreHeadline(a.title);
    const ageDays = Math.max(0, (now - (a.datetime || now)) / 86400000);
    const w = Math.exp(-ageDays / 3); // demi-vie ≈ 2 jours
    sum += s * w; wsum += w;
    if (s > 0.15) pos++; else if (s < -0.15) neg++;
  }
  return { score: wsum ? sum / wsum : 0, count: articles.length, pos, neg };
}
