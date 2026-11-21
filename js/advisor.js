// Moteur de conseils par règles — 0 token IA.
// Combine tendance, momentum, survente/surachat, actualités et gestion du risque
// pour proposer : quoi faire, combien de titres, et à quel prix (stop / objectif / zone d'achat).
import { summarize } from "./indicators.js";
import { aggregateSentiment } from "./sentiment.js";
import { t } from "./i18n.js";

export const ACTIONS = {
  SELL_ALL: { tone: "bad", rank: 0 }, // libellés : i18n act_*
  SELL_PART: { tone: "warn", rank: 1 },
  HOLD: { tone: "neutral", rank: 3 },
  WAIT: { tone: "neutral", rank: 4 },
  BUY_MORE: { tone: "good", rank: 2 },
  BUY: { tone: "good", rank: 2 },
};

// Score technique + actualités entre -100 et +100, avec la liste des raisons (en français).
export function scoreAsset(ind, news) {
  const reasons = [];
  let s = 0;
  const add = (pts, txt) => { s += pts; reasons.push({ pts, txt }); };
  const p = ind.price;

  if (ind.sma200 != null) {
    if (p > ind.sma200) add(20, t("r_above200"));
    else add(-20, t("r_below200"));
  }
  if (ind.sma50 != null && ind.sma200 != null) {
    if (ind.sma50 > ind.sma200) add(10, t("r_goldenIn"));
    else add(-10, t("r_deathIn"));
  }
  if (ind.sma50 != null) {
    if (p > ind.sma50) add(10, t("r_above50"));
    else add(-10, t("r_below50"));
  }
  if (ind.macdHist != null) {
    if (ind.macdHist > 0) add(8, t("r_macdPos"));
    else add(-8, t("r_macdNeg"));
    if (ind.macdHistPrev != null) {
      if (ind.macdHistPrev <= 0 && ind.macdHist > 0) add(10, t("r_macdUp"));
      if (ind.macdHistPrev >= 0 && ind.macdHist < 0) add(-10, t("r_macdDown"));
    }
  }
  if (ind.rsi14 != null) {
    const uptrend = ind.sma200 == null || p > ind.sma200;
    if (ind.rsi14 < 30) {
      // Survente : opportunité seulement si la tendance de fond reste haussière (sinon « couteau qui tombe »)
      if (uptrend) add(18, t("r_rsiDip", { rsi: ind.rsi14.toFixed(0) }));
      else reasons.push({ pts: 0, txt: t("r_rsiKnife", { rsi: ind.rsi14.toFixed(0) }) });
    } else if (ind.rsi14 > 75) add(-12, t("r_rsiStrongOb", { rsi: ind.rsi14.toFixed(0) }));
    else if (ind.rsi14 > 70) add(-6, t("r_rsiOb", { rsi: ind.rsi14.toFixed(0) }));
  }
  if (ind.bbLower != null && p < ind.bbLower) add(8, t("r_belowBB"));
  if (ind.bbUpper != null && p > ind.bbUpper) add(-8, t("r_aboveBB"));
  if (ind.high52 && p >= ind.high52 * 0.98) add(5, t("r_nearHigh"));

  const sent = aggregateSentiment(news);
  if (sent.count) {
    const pts = Math.round(sent.score * 20);
    if (pts !== 0) add(pts, t(pts > 0 ? "r_newsPos" : "r_newsNeg", { pos: sent.pos, neg: sent.neg, count: sent.count }));
  }
  return { score: Math.max(-100, Math.min(100, s)), reasons, sentiment: sent };
}

const floor = (x) => Math.max(0, Math.floor(x + 1e-9));
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Conseil pour une ligne (détenue ou surveillée).
 * @param {object} o
 *   candles, news, position {qty, avgPrice, firstBuy} | null, portfolioValue, cash, settings, alert {below, above}
 */
export function advise({ candles, news = [], position = null, portfolioValue = 0, cash = 0, settings, alert = null }) {
  const lastPrice = candles?.length ? candles[candles.length - 1].close : null;
  const alerts = [];
  if (lastPrice != null && alert?.below && lastPrice <= alert.below) alerts.push(t("al_below", { v: alert.below }));
  if (lastPrice != null && alert?.above && lastPrice >= alert.above) alerts.push(t("al_above", { v: alert.above }));
  if (!candles || candles.length < 30) {
    return { action: "WAIT", qty: 0, score: 0, reasons: [{ pts: 0, txt: candles?.length ? t("k_shortHist", { n: candles.length }) : t("k_noPrices") }], ind: null, levels: {}, price: lastPrice, alerts, urgent: alerts.length > 0 };
  }
  const ind = summarize(candles);
  const { score, reasons, sentiment } = scoreAsset(ind, news);
  const price = ind.price;
  const atrv = ind.atr14 || price * 0.02;
  const held = position && position.qty > 0;
  const total = Math.max(portfolioValue, 1);

  // Niveaux de prix
  let highSince = price;
  if (held && position.firstBuy) {
    const after = candles.filter((c) => c.date >= position.firstBuy);
    if (after.length) highSince = Math.max(...after.map((c) => c.close));
  }
  const trailingStop = highSince - settings.stopAtrMult * atrv;
  const entryStop = price - settings.stopAtrMult * atrv;
  const target = price + 2 * settings.stopAtrMult * atrv; // ratio gain/risque 2:1
  const buyZone = [ind.bbLower, ind.sma50].filter((v) => v != null && v < price).sort((a, b) => b - a)[0] ?? null;
  const levels = {
    stop: round2(held ? trailingStop : entryStop),
    target: round2(target),
    buyZone: buyZone != null ? round2(buyZone) : null,
  };

  // Taille d'un achat : risque fixe en % du portefeuille / distance au stop, plafonnée par poids max et cash
  const sizeBuy = (currentValue) => {
    const riskAmount = (total * settings.riskPerTradePct) / 100;
    const perShareRisk = settings.stopAtrMult * atrv;
    let q = floor(riskAmount / perShareRisk);
    const room = (total * Math.min(settings.targetPositionPct, settings.maxPositionPct)) / 100 - currentValue;
    q = Math.min(q, floor(room / price));
    q = Math.min(q, floor(cash / price));
    return Math.max(0, q);
  };

  const out = (action, qty, why) => {
    if (why) reasons.unshift({ pts: 0, txt: why, key: true });
    return { action, qty, score, reasons, ind, levels, sentiment, price };
  };


  let res;
  if (held) {
    const value = position.qty * price;
    const weight = value / total;
    const gain = position.avgPrice ? price / position.avgPrice - 1 : 0;

    if (price < trailingStop) {
      res = out("SELL_ALL", position.qty, t("k_stopHit", { stop: levels.stop }));
    } else if (weight > settings.maxPositionPct / 100) {
      const excess = value - (total * settings.targetPositionPct) / 100;
      res = out("SELL_PART", Math.min(position.qty, Math.ceil(excess / price)),
        t("k_overweight", { w: (weight * 100).toFixed(0), max: settings.maxPositionPct }));
    } else if (gain * 100 >= settings.takeProfitPct && (ind.rsi14 ?? 50) > 68) {
      res = out("SELL_PART", Math.min(position.qty, Math.max(1, floor(position.qty / 3))),
        t("k_takeProfit", { g: (gain * 100).toFixed(0) }));
    } else if (score <= settings.sellScore) {
      res = out("SELL_PART", Math.min(position.qty, Math.max(1, floor(position.qty / 2))), t("k_negSignals", { score }));
    } else if (score >= settings.buyScore) {
      const q = sizeBuy(value);
      res = q > 0
        ? out("BUY_MORE", q, t("k_posRoom", { score }))
        : out("HOLD", 0, t("k_posFull", { score }));
    } else {
      res = out("HOLD", 0, t("k_hold"));
    }
  } else {
    if (score >= settings.buyScore) {
      const q = sizeBuy(0);
      res = q > 0
        ? out("BUY", q, t("k_buy", { score }))
        : out("WAIT", 0, t("k_buyNoCash", { score }));
    } else if (buyZone && score > settings.sellScore) {
      res = out("WAIT", 0, t("k_neutralZone", { zone: levels.buyZone }));
    } else {
      res = out("WAIT", 0, score <= settings.sellScore ? t("k_avoid") : t("k_noBuy"));
    }
  }
  res.alerts = alerts;
  res.urgent = res.action === "SELL_ALL" || alerts.length > 0;
  return res;
}
