// Relais Yahoo Finance pour Action Advisor — à déployer GRATUITEMENT sur Cloudflare Workers.
// Yahoo n'autorise pas les appels directs depuis une page web (CORS) : ce relais ajoute l'en-tête manquant.
// Il ne relaie QUE les deux adresses utiles (cours et recherche/actus), rien d'autre.
//
// Déploiement (5 minutes) :
//   1. Créer un compte gratuit sur https://dash.cloudflare.com → Workers & Pages → Create → Worker.
//   2. Remplacer le code par ce fichier → Deploy.
//   3. Copier l'adresse (https://xxx.workers.dev) dans Action Advisor → Réglages → « Adresse du relais ».
//   4. (Conseillé) mettre l'adresse de votre app dans ALLOWED_ORIGIN pour que personne d'autre ne l'utilise.

const ALLOWED_ORIGIN = "*"; // ex. "https://votre-pseudo.github.io"
const ALLOWED_PATHS = [/^\/v8\/finance\/chart\/[^/]+$/, /^\/v1\/finance\/search$/];

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("Méthode non autorisée", { status: 405, headers: cors });

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.some((re) => re.test(url.pathname))) {
      return new Response("Chemin non autorisé", { status: 403, headers: cors });
    }
    const upstream = await fetch(`https://query1.finance.yahoo.com${url.pathname}${url.search}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      cf: { cacheTtl: 120, cacheEverything: true }, // petit cache côté Cloudflare
    });
    const headers = new Headers({ ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json" });
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
