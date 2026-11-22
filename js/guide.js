// Lexique + petit cours. Définitions en français et en anglais (le persan affiche l'anglais).
// Chaque terme peut être touché dans l'appli (span.term[data-term]) pour afficher sa définition.

export const TERMS = {
  // --- portefeuille ---
  avgCost: { fr: ["PRU (prix de revient unitaire)", "Le prix moyen payé par action, frais compris."], en: ["Average cost", "The average price paid per share, fees included."] },
  posValue: { fr: ["Valeur", "Quantité × cours actuel : ce que vaut votre ligne aujourd'hui."], en: ["Value", "Quantity × current price: what your position is worth today."] },
  unrealized: { fr: ["Plus-value latente", "Gain ou perte « sur le papier ». Il ne devient réel que si vous vendez."], en: ["Unrealized gain/loss", "Gain or loss \"on paper\". It only becomes real when you sell."] },
  cash: { fr: ["Liquidités", "Argent non investi sur votre compte."], en: ["Cash", "Money in your account that is not invested."] },
  totalValue: { fr: ["Valeur totale", "Valeur de toutes vos actions + vos liquidités, dans votre devise de base."], en: ["Total value", "Value of all your shares + your cash, in your base currency."] },
  quantity: { fr: ["Quantité", "Nombre d'actions que vous possédez (peut être fractionnaire, ex. 1,04)."], en: ["Quantity", "Number of shares you own (can be fractional, e.g. 1.04)."] },
  // --- graphique ---
  price: { fr: ["Cours", "Prix de l'action (ligne blanche). Sur le graphique : prix de clôture de chaque jour."], en: ["Price", "The share price (white line). On the chart: each day's closing price."] },
  ma50: { fr: ["MM50 (moyenne mobile 50 jours)", "Moyenne des clôtures des 50 derniers jours (ligne bleue) : tendance des 2-3 derniers mois. Cours au-dessus = plutôt bon signe."], en: ["MA50 (50-day moving average)", "Average close of the last 50 days (blue line): trend of the last 2-3 months. Price above it = rather good sign."] },
  ma200: { fr: ["MM200 (moyenne mobile 200 jours)", "Moyenne des clôtures des 200 derniers jours (ligne jaune) : tendance de fond (~10 mois). Cours en dessous = tendance baissière."], en: ["MA200 (200-day moving average)", "Average close of the last 200 days (yellow line): long-term trend (~10 months). Price below it = downtrend."] },
  stop: { fr: ["Stop (stop suiveur)", "Prix plancher : s'il est franchi, l'appli conseille de vendre. Il monte avec le cours mais ne redescend jamais, pour protéger vos gains."], en: ["Stop (trailing stop)", "Floor price: if crossed, the app advises selling. It rises with the price but never goes down, to protect your gains."] },
  buySell: { fr: ["Points Achat / Vente", "Point vert = un de vos achats, point rouge = une de vos ventes. Touchez la courbe pour voir le détail."], en: ["Buy / Sell dots", "Green dot = one of your buys, red dot = one of your sells. Touch the chart to see details."] },
  // --- conseils ---
  score: { fr: ["Score (−100 à +100)", "Note globale calculée par l'appli en additionnant les signaux. Positif = plutôt achat, négatif = plutôt vente. Le stop passe avant le score."], en: ["Score (−100 to +100)", "Overall grade computed by adding up the signals. Positive = rather buy, negative = rather sell. The stop overrides the score."] },
  target: { fr: ["Objectif", "Prix où l'appli conseille d'encaisser une partie du gain."], en: ["Target", "Price at which the app advises taking part of the profit."] },
  buyZone: { fr: ["Zone d'achat", "Prix jugé intéressant pour acheter. « — » = ce n'est pas le moment."], en: ["Buy zone", "Price considered attractive for buying. \"—\" = not the right time."] },
  actions: { fr: ["Acheter, Renforcer, Conserver, Alléger, Vendre tout", "Acheter = 1re fois ; Renforcer = en racheter ; Conserver / Attendre = ne rien faire ; Alléger = vendre une partie ; Vendre tout = la totalité."], en: ["Buy, Add, Hold, Trim, Sell all", "Buy = first time; Add = buy more; Hold / Wait = do nothing; Trim = sell part; Sell all = everything."] },
  // --- indicateurs ---
  rsi: { fr: ["RSI 14", "Note de 0 à 100 sur 14 jours : l'action a-t-elle trop monté ou trop baissé ? Plus de 70 = surachat (risque de baisse) ; moins de 30 = survente (rebond possible). Survendu ne veut pas dire « pas cher »."], en: ["RSI 14", "0-100 score over 14 days: has the stock risen or fallen too much? Above 70 = overbought (may drop); below 30 = oversold (may rebound). Oversold doesn't mean cheap."] },
  atr: { fr: ["ATR 14", "Variation moyenne du prix en une journée (sur 14 jours). Ex. ATR 10,7 = l'action bouge d'environ 10,7 $ par jour. Sert à placer le stop."], en: ["ATR 14", "Average daily price move (over 14 days). E.g. ATR 10.7 = the stock moves about $10.7 per day. Used to place the stop."] },
  macd: { fr: ["MACD", "Compare une moyenne rapide (12 j) et lente (26 j). Positif = élan haussier, négatif = baissier. « Vient de croiser » = la tendance change de sens."], en: ["MACD", "Compares a fast (12-day) and slow (26-day) average. Positive = upward momentum, negative = downward. \"Just crossed\" = trend changing direction."] },
  bollinger: { fr: ["Bandes de Bollinger", "Couloir habituel du prix (≈ 95 % du temps). Sous la bande basse = anormalement bas ; au-dessus de la haute = anormalement haut."], en: ["Bollinger bands", "Usual price corridor (≈ 95% of the time). Below the lower band = unusually low; above the upper = unusually high."] },
  high52: { fr: ["Haut 52 s", "Prix le plus haut des 52 dernières semaines (1 an)."], en: ["52-week high", "Highest price of the last 52 weeks (1 year)."] },
  low52: { fr: ["Bas 52 s", "Prix le plus bas des 52 dernières semaines (1 an)."], en: ["52-week low", "Lowest price of the last 52 weeks (1 year)."] },
  perf: { fr: ["1 mois / 1 an", "Variation du cours sur 1 mois / sur 1 an."], en: ["1 month / 1 year", "Price change over 1 month / 1 year."] },
  volatility: { fr: ["Volatilité", "Ampleur des variations sur un an, en %. Plus elle est élevée, plus c'est risqué (ETF ≈ 15 %, petite société > 80 %)."], en: ["Volatility", "Size of price swings over a year, in %. Higher = riskier (ETF ≈ 15%, small company > 80%)."] },
  news: { fr: ["Actus +3 / −1", "Nombre d'actualités récentes jugées positives / négatives sur l'entreprise."], en: ["News +3 / −1", "Number of recent news items judged positive / negative about the company."] },
};

export const SECTIONS = [
  { fr: "Votre portefeuille", en: "Your portfolio", keys: ["avgCost", "posValue", "quantity", "unrealized", "cash", "totalValue"] },
  { fr: "Le graphique", en: "The chart", keys: ["price", "ma50", "ma200", "stop", "buySell"] },
  { fr: "Les conseils", en: "The advice", keys: ["score", "target", "buyZone", "actions"] },
  { fr: "Les indicateurs", en: "The indicators", keys: ["rsi", "atr", "macd", "bollinger", "high52", "low52", "perf", "volatility", "news"] },
];

export const COURSE = {
  fr: `
<h4>1. L'analyse technique</h4>
<p>L'<b>analyse fondamentale</b> étudie l'entreprise (bénéfices, dettes, produits) : « est-ce une bonne entreprise ? ». L'<b>analyse technique</b> étudie seulement la courbe du prix : « est-ce le bon moment ? ». L'appli fait surtout de l'analyse technique. Aucun indicateur ne prédit l'avenir : ce sont des probabilités.</p>
<h4>2. Moyennes mobiles : la tendance</h4>
<p>Chaque jour, on fait la moyenne des 50 (ou 200) dernières clôtures : une ligne lissée. Cours <b>au-dessus</b> de la MM200 = tendance haussière ; <b>en dessous</b> = baissière. <b>Croisement haussier</b> : la MM50 passe au-dessus de la MM200 (bon signe) ; <b>croisement baissier</b> : l'inverse.</p>
<h4>3. RSI : trop monté ou trop baissé ?</h4>
<p>Compare la force des jours de hausse et de baisse sur 14 jours (0 à 100). <b>&gt; 70</b> surachat, les acheteurs s'essoufflent ; <b>&lt; 30</b> survente, rebond possible. En tendance baissière, une action peut rester survendue longtemps.</p>
<h4>4. MACD : l'élan</h4>
<p>Moyenne rapide (12 j) contre lente (26 j). Les moyennes mobiles disent <i>dans quelle direction</i> roule la voiture ; le MACD dit si elle <i>accélère ou freine</i>. Un croisement signale souvent un changement de direction.</p>
<h4>5. Bandes de Bollinger : le couloir</h4>
<p>Autour de la moyenne 20 jours, une bande haute et une basse où le prix reste ≈ 95 % du temps. En dehors : situation inhabituelle, souvent suivie d'un retour vers le milieu. Bandes serrées = calme avant un gros mouvement.</p>
<h4>6. ATR et volatilité : le risque</h4>
<p>L'ATR est la variation moyenne en une journée. L'appli place le stop à 2,5 × ATR sous le plus haut, pour qu'une secousse normale ne le déclenche pas. La volatilité dit la même chose sur un an, en %.</p>
<h4>7. Le stop suiveur : protéger son argent</h4>
<p>Achat à 100 $, stop à 90 $. L'action monte à 150 $ → le stop monte à 135 $. Elle redescend à 135 $ → vous vendez avec +35 % au lieu de tout reperdre. Règle d'or : <b>couper vite les pertes, laisser courir les gains</b>.</p>
<h4>8. Le score</h4>
<p>L'appli additionne des points pour chaque signal (ex. sous la MM200 −20, MACD négatif −8, sous Bollinger +8…). Au-dessus du score d'achat (35 par défaut) → acheter ; sous le score de vente (−35) → alléger. Si le stop est touché, il passe avant tout.</p>
<h4>À retenir</h4>
<p>Moyennes = direction · MACD = accélération · RSI et Bollinger = excès · ATR et volatilité = risque · Stop = protection. Aucun indicateur ne suffit seul : on regarde quand plusieurs vont dans le même sens.</p>`,
  en: `
<h4>1. Technical analysis</h4>
<p><b>Fundamental analysis</b> studies the company (profits, debt, products): "is it a good company?". <b>Technical analysis</b> studies only the price chart: "is it the right time?". The app mostly does technical analysis. No indicator predicts the future: these are probabilities.</p>
<h4>2. Moving averages: the trend</h4>
<p>Each day, average the last 50 (or 200) closes: a smoothed line. Price <b>above</b> the MA200 = uptrend; <b>below</b> = downtrend. <b>Golden cross</b>: MA50 crosses above MA200 (good sign); <b>death cross</b>: the opposite.</p>
<h4>3. RSI: risen or fallen too much?</h4>
<p>Compares the strength of up and down days over 14 days (0 to 100). <b>&gt; 70</b> overbought, buyers running out of steam; <b>&lt; 30</b> oversold, rebound possible. In a downtrend a stock can stay oversold for a long time.</p>
<h4>4. MACD: momentum</h4>
<p>Fast (12-day) vs slow (26-day) average. Moving averages tell <i>which direction</i> the car is going; MACD tells whether it is <i>speeding up or braking</i>. A crossover often signals a change of direction.</p>
<h4>5. Bollinger bands: the corridor</h4>
<p>Around the 20-day average, an upper and lower band where the price stays ≈ 95% of the time. Outside: unusual, often followed by a move back to the middle. Tight bands = calm before a big move.</p>
<h4>6. ATR and volatility: the risk</h4>
<p>ATR is the average daily move. The app places the stop 2.5 × ATR below the high, so normal noise doesn't trigger it. Volatility says the same over a year, in %.</p>
<h4>7. Trailing stop: protect your money</h4>
<p>Buy at $100, stop at $90. The stock rises to $150 → stop rises to $135. It falls back to $135 → you sell at +35% instead of losing it all. Golden rule: <b>cut losses fast, let gains run</b>.</p>
<h4>8. The score</h4>
<p>The app adds points for each signal (e.g. below MA200 −20, negative MACD −8, below Bollinger +8…). Above the buy score (35 by default) → buy; below the sell score (−35) → trim. If the stop is hit, it overrides everything.</p>
<h4>Key takeaways</h4>
<p>Averages = direction · MACD = acceleration · RSI and Bollinger = excess · ATR and volatility = risk · Stop = protection. No indicator is enough alone: look for several pointing the same way.</p>`,
};
