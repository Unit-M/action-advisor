// Évolution du portefeuille jour par jour (2 ans max, limite des cours journaliers en cache).
// Tout est converti dans la devise de base au taux du jour concerné (taux historique si disponible).
// Pour chaque jour : value = Σ quantité × clôture × taux ; cost = coût d'achat des titres détenus (au taux du jour d'achat) ;
// realized = gains réalisés cumulés ; pnl = value − cost + realized (profit total, hors apports d'argent).

export function portfolioHistory({ transactions, assets, candlesById, fxRate }) {
  const txs = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!txs.length) return [];
  const first = txs[0].date;
  // jours de cotation : union des dates de toutes les séries
  const daySet = new Set();
  const closeIdx = {};
  for (const [id, c] of Object.entries(candlesById)) {
    if (!c?.length) continue;
    closeIdx[id] = c;
    for (const x of c) if (x.date >= first) daySet.add(x.date);
  }
  const days = [...daySet].sort();
  if (!days.length) return [];
  const ptr = {}, last = {}; // dernière clôture connue par titre (avance avec les jours)
  const pos = {}; // id -> {qty, cost (devise base)}
  let realized = 0, ti = 0;
  // opérations antérieures au premier jour couvert : appliquées d'emblée
  const out = [];
  for (const d of days) {
    while (ti < txs.length && txs[ti].date <= d) {
      const x = txs[ti++];
      const cur = assets[x.assetId]?.currency;
      const fx = fxRate(cur, x.date) ?? 1;
      const p = (pos[x.assetId] ||= { qty: 0, cost: 0 });
      const fees = (Number(x.fees) || 0) * fx;
      if (x.type === "BUY") { p.qty += x.qty; p.cost += x.qty * x.price * fx + fees; }
      else if (x.type === "SELL" && p.qty > 0) {
        const q = Math.min(x.qty, p.qty), share = p.cost * (q / p.qty);
        realized += q * x.price * fx - fees - share;
        p.cost -= share; p.qty -= q;
        if (p.qty <= 1e-9) { p.qty = 0; p.cost = 0; }
      }
    }
    let value = 0, cost = 0;
    for (const [id, p] of Object.entries(pos)) {
      if (!(p.qty > 0)) continue;
      const c = closeIdx[id];
      if (c) {
        let i = ptr[id] ?? 0;
        while (i < c.length && c[i].date <= d) { last[id] = c[i].close; i++; }
        ptr[id] = i;
      }
      const px = last[id];
      const fx = fxRate(assets[id]?.currency, d) ?? 1;
      cost += p.cost;
      value += px != null ? p.qty * px * fx : p.cost; // pas encore de cours : on compte le prix payé
    }
    out.push({ date: d, value, cost, realized, pnl: value - cost + realized });
  }
  return out;
}

// Résumé sur une fenêtre : variation de valeur, profit (réalisé / latent) et performance
export function summarize(points) {
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  const pnl = b.pnl - a.pnl;
  const realized = b.realized - a.realized;
  // performance : profit de la période / capital investi moyen sur la période
  const avgCost = points.reduce((s, p) => s + p.cost, 0) / points.length;
  return { value: b.value, valueChange: b.value - a.value, pnl, realized, unrealized: pnl - realized, perf: avgCost > 0 ? pnl / avgCost : null };
}
