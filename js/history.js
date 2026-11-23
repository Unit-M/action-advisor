// Évolution du portefeuille jour par jour.
// Tout est converti dans la devise de base au taux du jour concerné (taux historique si disponible).
//
// Deux sortes de comptes :
//  • compte « suivi » (des versements / retraits sont saisis) : comme Revolut, la valeur = actions + espèces,
//    et la ligne « investi » = argent versé (versements − retraits). Acheter ou vendre ne fait pas bouger la courbe.
//  • compte « simple » (aucun versement saisi) : valeur = actions seulement, « investi » = prix payé des actions détenues.
// pnl = profit total (hors apports d'argent), cohérent dans les deux cas.

export function portfolioHistory({ transactions, assets, candlesById, fxRate, cashFlows = [], tracked = new Set(), acctOf = (x) => x.accountId }) {
  const txs = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const flows = [...cashFlows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const firstDates = [txs[0]?.date, flows[0]?.date].filter(Boolean).sort();
  if (!firstDates.length) return [];
  const first = firstDates[0];
  // jours couverts : union des dates de toutes les séries de cours
  const daySet = new Set();
  const closeIdx = {};
  for (const [id, c] of Object.entries(candlesById)) {
    if (!c?.length) continue;
    closeIdx[id] = c;
    for (const x of c) if (x.date >= first) daySet.add(x.date);
  }
  const days = [...daySet].sort();
  if (!days.length) return [];
  const ptr = {}, last = {};
  const pos = {}; // id -> {qty, cost (devise base)} — comptes simples et suivis confondus (le coût sert aux comptes simples)
  const cash = {}; // espèces des comptes suivis, par devise
  let realizedU = 0, realizedT = 0, contrib = 0, gainsT = 0; // réalisé (comptes simples), argent versé, dividendes/intérêts (comptes suivis)
  let ti = 0, fi = 0;
  const out = [];
  for (const d of days) {
    while (fi < flows.length && flows[fi].date <= d) {
      const f = flows[fi++];
      cash[f.currency] = (cash[f.currency] || 0) + f.amount;
      const v = f.amount * (fxRate(f.currency, f.date) ?? 1);
      if (f.kind === "DIV") gainsT += v; else contrib += v;
    }
    while (ti < txs.length && txs[ti].date <= d) {
      const x = txs[ti++];
      const cur = assets[x.assetId]?.currency;
      const isT = tracked.has(acctOf(x));
      const fx = fxRate(cur, x.date) ?? 1;
      const key = (isT ? "T:" : "U:") + x.assetId;
      const p = (pos[key] ||= { id: x.assetId, qty: 0, cost: 0, t: isT });
      const fees = Number(x.fees) || 0;
      if (x.type === "BUY") {
        p.qty += x.qty; p.cost += (x.qty * x.price + fees) * fx;
        if (isT) cash[cur] = (cash[cur] || 0) - (x.qty * x.price + fees);
      } else if (x.type === "SELL" && p.qty > 0) {
        const q = Math.min(x.qty, p.qty), share = p.cost * (q / p.qty);
        if (isT) { cash[cur] = (cash[cur] || 0) + q * x.price - fees; realizedT += (q * x.price - fees) * fx - share; }
        else realizedU += (q * x.price - fees) * fx - share;
        p.cost -= share; p.qty -= q;
        if (p.qty <= 1e-9) { p.qty = 0; p.cost = 0; }
      }
    }
    let stocksT = 0, stocksU = 0, costU = 0;
    for (const p of Object.values(pos)) {
      if (!(p.qty > 0)) continue;
      const c = closeIdx[p.id];
      if (c) {
        let i = ptr[p.id] ?? 0;
        while (i < c.length && c[i].date <= d) { last[p.id] = c[i].close; i++; }
        ptr[p.id] = i;
      }
      const px = last[p.id];
      const fx = fxRate(assets[p.id]?.currency, d) ?? 1;
      const v = px != null ? p.qty * px * fx : p.cost; // pas encore de cours : on compte le prix payé
      if (p.t) stocksT += v; else { stocksU += v; costU += p.cost; }
    }
    let cashT = 0;
    for (const [cur, amt] of Object.entries(cash)) cashT += amt * (fxRate(cur, d) ?? 1);
    const value = stocksT + cashT + stocksU;
    const cost = contrib + costU; // ligne « investi »
    const pnl = (stocksT + cashT - contrib) + (stocksU - costU + realizedU);
    out.push({ date: d, value, cost, realized: realizedU + realizedT + gainsT, pnl });
  }
  return out;
}

// Résumé sur une fenêtre : variation de valeur, profit et performance
export function summarize(points) {
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  const pnl = b.pnl - a.pnl;
  const realized = b.realized - a.realized;
  // performance : profit de la période / capital investi moyen sur la période
  const avgCost = points.reduce((s, p) => s + p.cost, 0) / points.length;
  return { value: b.value, valueChange: b.value - a.value, pnl, realized, unrealized: pnl - realized, perf: avgCost > 0 ? pnl / avgCost : null };
}
