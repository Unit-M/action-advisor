# Action Advisor

Application iPhone (PWA) pour suivre ses actions, lire les actualités et recevoir des conseils d'achat / vente :
**quoi faire, combien de titres, à quel prix (stop, objectif, zone d'achat)**.

## Principe : l'IA seulement quand elle apporte quelque chose

| Tâche | Comment | Coût en tokens |
|---|---|---|
| Cours, historique, taux de change | Yahoo Finance via votre relais gratuit, ou Twelve Data (US) — mis en cache | 0 |
| Positions, PRU, plus-values | Calcul local à partir de vos transactions | 0 |
| Indicateurs (MM50/200, RSI, MACD, ATR, Bollinger, volatilité) | Calcul local (`js/indicators.js`) | 0 |
| Sentiment des actualités | Lexique FR/EN local (`js/sentiment.js`) | 0 |
| Conseil Acheter / Renforcer / Conserver / Alléger / Vendre + quantité | Moteur de règles (`js/advisor.js`) | 0 |
| Stop suiveur, objectif, alertes de prix | Règles locales | 0 |
| **Avis IA** sur une ligne ou **bilan IA** du portefeuille | Claude, uniquement quand vous appuyez sur le bouton ✦ | quelques centaines à ~2 000 tokens |

Économies côté IA : résumé chiffré envoyé au lieu de l'historique brut, 8 titres d'actualité max, effort de réflexion `low`,
réponse JSON courte, **avis réutilisé pendant 12 h** (0 token), et **plafond mensuel** de tokens réglable.

## Règles du moteur (réglables dans Réglages)

- **Score −100 à +100** : tendance (cours vs MM200, MM50 vs MM200), momentum (MACD), survente/surachat (RSI, Bollinger), actualités.
  La survente ne compte comme opportunité que si la tendance de fond est haussière.
- **Vendre tout** si le cours casse le stop suiveur (plus haut depuis l'achat − 2,5 × ATR).
- **Alléger** si la ligne dépasse le poids maximum (20 %), si +25 % et surachat (vente d'un tiers), ou si le score ≤ −35 (vente de la moitié).
- **Acheter / Renforcer** si le score ≥ +35. Quantité = (1 % du portefeuille) ÷ (distance au stop), plafonnée par le poids visé (10 %) et vos liquidités.

## Installation sur l'iPhone

L'application doit être servie en HTTPS. Le plus simple, gratuit :

1. **GitHub Pages** : créer un dépôt, y pousser ce dossier, activer *Settings → Pages*.
   (ou **Netlify Drop** : glisser le dossier sur https://app.netlify.com/drop)
2. Sur l'iPhone, ouvrir l'URL dans **Safari** → bouton Partager → **Sur l'écran d'accueil**.
3. Dans l'app, onglet **Réglages** :
   - **source des cours** :
     - *Yahoo Finance via mon relais* (recommandé : Paris, Europe, US, + actualités) : déployer `proxy/worker.js`
       sur Cloudflare Workers (gratuit, 5 min, instructions en tête du fichier) et coller son adresse ;
     - ou *Twelve Data* (clé gratuite https://twelvedata.com/pricing) : **le plan gratuit ne couvre que les actions US**.
   - clé **Finnhub** (facultative, actus des actions US) : https://finnhub.io/register
   - clé **Anthropic** (facultative, pour les avis IA) : https://console.anthropic.com/settings/keys
   - vos **liquidités** disponibles.
4. **+** → rechercher une action (ex. « Airbus », « LVMH », « AAPL ») → « J'ai acheté » ou « Surveiller ».

Test sur ordinateur : `python3 -m http.server 8000` dans ce dossier, puis http://localhost:8000
(et http://localhost:8000/tests.html pour les tests de la logique).

## Choix de l'IA

Réglages → **Fournisseur IA** : Anthropic (Claude) ou OpenAI.
- OpenAI : clé sur https://platform.openai.com/api-keys (crédit sur https://platform.openai.com/settings/organization/billing),
  puis « Charger la liste » pour choisir un modèle disponible sur votre compte (les « mini » sont les moins chers).
  Un abonnement ChatGPT Plus ne donne pas accès à l'API.

### Modèles Claude

Par défaut **Claude Opus 5.5** (le plus fiable). Dans Réglages vous pouvez passer à **Claude Haiku 5.5**,
environ 40 fois moins cher, suffisant pour la plupart des avis. Pour Opus et Sonnet, le repli automatique côté serveur
(`fallbacks: "default"`) est activé : si le modèle refuse une requête, l'API la relance sur un autre modèle.

## Limites à connaître

- **Pas un conseiller financier.** Les signaux sont des aides à la décision, vous restez seul décideur.
- Yahoo Finance n'a pas d'API officielle : l'accès peut changer sans préavis. Twelve Data sert alors de solution de secours (US).
- Quotas gratuits Twelve Data : 8 requêtes/minute, 800/jour. Le cache (30 min par défaut) les ménage ; avec beaucoup de lignes la mise à jour prend plus d'une minute.
- Actualités des actions européennes : GDELT (gratuit, limité à 1 requête toutes les 5 s, parfois indisponible). Finnhub ne couvre que les actions US en gratuit.
- Pas de notifications en arrière-plan : iOS n'en permet aux PWA qu'avec un serveur de push. Les alertes s'affichent à l'ouverture de l'app.
- Les clés API et les données sont stockées dans Safari, sur l'iPhone. Exportez régulièrement une sauvegarde (Réglages → Exporter).
  Mettez une limite de dépense sur votre clé Anthropic dans la console.
  La sauvegarde exportée ne contient pas vos clés API.
- Sur iPhone, l'app de l'écran d'accueil a un stockage séparé de Safari : configurez-la après l'avoir ajoutée à l'écran d'accueil
  (ou passez par Exporter / Importer).

## Outils existants envisagés

- **Ghostfolio**, **Wealthfolio** (suivi de portefeuille open source) : très complets mais sans moteur de conseils,
  et Ghostfolio demande un serveur (Docker + PostgreSQL). Gardés comme pistes d'import/export plus tard.
- Bibliothèques d'indicateurs (`technicalindicators`, `trading-signals`) : les 6 indicateurs utiles tiennent en ~100 lignes
  testées ici, sans dépendance à télécharger ni à mettre en cache hors ligne.
- Réutilisés : Yahoo Finance / Twelve Data (cours), Finnhub et GDELT (actualités), SDK officiel Anthropic (IA).

## Fichiers

```
index.html, css/app.css      interface
js/app.js                    écrans et interactions
js/store.js                  stockage local, positions (PRU)
js/data.js                   cours, actus, change (avec cache et limite de débit)
js/indicators.js             indicateurs techniques
js/sentiment.js              sentiment des titres d'actu (lexique)
js/advisor.js                moteur de conseils par règles
js/ai.js                     avis IA (Claude), budget et cache
proxy/worker.js              relais Yahoo Finance pour Cloudflare Workers (gratuit)
sw.js, manifest.webmanifest  installation et hors-ligne
tests.html                   tests de la logique dans le navigateur
```
