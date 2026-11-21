#!/usr/bin/env bash
# Déploie proxy/worker.js sur Cloudflare Workers (gratuit) via l'API Cloudflare, sans rien installer.
#
# Prérequis : un compte Cloudflare gratuit + un jeton API :
#   https://dash.cloudflare.com/profile/api-tokens → Create Token → modèle « Edit Cloudflare Workers »
#
# Utilisation (dans votre terminal, pour que le jeton n'apparaisse nulle part ailleurs) :
#   read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # collez le jeton puis Entrée
#   bash proxy/deploy.sh
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Définissez CLOUDFLARE_API_TOKEN (voir en-tête du script)}"
NAME="${WORKER_NAME:-action-advisor-relais}"
API="https://api.cloudflare.com/client/v4"
DIR="$(cd "$(dirname "$0")" && pwd)"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
check() { python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else (print('Erreur Cloudflare :', d.get('errors')) or 1))"; }

echo "→ Vérification du jeton…"
curl -fsS "${AUTH[@]}" "$API/user/tokens/verify" | check

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(curl -fsS "${AUTH[@]}" "$API/accounts" | json "print(d['result'][0]['id'])")}"
echo "→ Compte : $ACCOUNT_ID"

echo "→ Envoi du relais « $NAME »…"
curl -fsS -X PUT "${AUTH[@]}" "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME" \
  -F 'metadata={"main_module":"worker.js","compatibility_date":"2026-11-01"};type=application/json' \
  -F "worker.js=@$DIR/worker.js;type=application/javascript+module" | check

echo "→ Activation de l'adresse workers.dev…"
SUB="$(curl -sS "${AUTH[@]}" "$API/accounts/$ACCOUNT_ID/workers/subdomain" | json "print((d.get('result') or {}).get('subdomain') or '')")"
if [ -z "$SUB" ]; then
  SUB="aa-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
  curl -fsS -X PUT "${AUTH[@]}" -H "Content-Type: application/json" \
    "$API/accounts/$ACCOUNT_ID/workers/subdomain" -d "{\"subdomain\":\"$SUB\"}" | check
fi
curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME/subdomain" -d '{"enabled":true}' | check

URL="https://$NAME.$SUB.workers.dev"
echo "→ Test (la première activation peut prendre ~1 min)…"
for i in $(seq 1 12); do
  if curl -fsS -m 10 "$URL/v8/finance/chart/NVDA?range=5d&interval=1d" | grep -q '"regularMarketPrice"'; then
    echo
    echo "✅ Relais opérationnel : $URL"
    echo "   Collez cette adresse dans Action Advisor → Réglages → « Adresse du relais Yahoo »."
    exit 0
  fi
  sleep 5
done
echo "⚠️  Relais déployé à $URL mais le test ne répond pas encore. Réessayez dans quelques minutes :"
echo "   curl \"$URL/v8/finance/chart/NVDA?range=5d&interval=1d\""
