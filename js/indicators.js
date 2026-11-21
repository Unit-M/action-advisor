// Indicateurs techniques — calcul local, 0 token IA.
// Toutes les fonctions renvoient un tableau aligné sur l'entrée (null tant que la fenêtre n'est pas remplie).

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI de Wilder
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const sig = new Array(closes.length).fill(null);
  if (start >= 0) {
    const s = ema(line.slice(start), signal);
    for (let i = 0; i < s.length; i++) sig[start + i] = s[i];
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

// ATR de Wilder
export function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const w = closes.slice(i - period + 1, i + 1);
    const m = mid[i];
    const sd = Math.sqrt(w.reduce((a, v) => a + (v - m) ** 2, 0) / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const prevOf = (arr) => { let seen = false; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) { if (seen) return arr[i]; seen = true; } return null; };

// Résumé compact de tous les indicateurs sur des bougies [{date, open, high, low, close, volume}] (ordre chronologique).
export function summarize(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const m = macd(closes);
  const bb = bollinger(closes);
  const price = closes[closes.length - 1];
  const yearSlice = closes.slice(-252);
  const ret = (days) => (closes.length > days ? price / closes[closes.length - 1 - days] - 1 : null);
  const dailyRets = closes.slice(-61).map((c, i, a) => (i ? Math.log(c / a[i - 1]) : null)).filter((v) => v != null);
  const meanR = dailyRets.reduce((a, b) => a + b, 0) / (dailyRets.length || 1);
  const vol = Math.sqrt(dailyRets.reduce((a, r) => a + (r - meanR) ** 2, 0) / Math.max(dailyRets.length - 1, 1)) * Math.sqrt(252);
  return {
    price,
    date: candles[candles.length - 1]?.date,
    sma20: last(sma(closes, 20)),
    sma50: last(sma(closes, 50)),
    sma200: last(sma(closes, 200)),
    rsi14: last(rsi(closes, 14)),
    macdHist: last(m.hist),
    macdHistPrev: prevOf(m.hist),
    atr14: last(atr(highs, lows, closes, 14)),
    bbUpper: last(bb.upper),
    bbLower: last(bb.lower),
    high52: Math.max(...yearSlice),
    low52: Math.min(...yearSlice),
    perf1w: ret(5),
    perf1m: ret(21),
    perf3m: ret(63),
    perf1y: ret(252),
    volatility: dailyRets.length > 10 ? vol : null,
  };
}
