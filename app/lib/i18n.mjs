// Sprache für Rezepte, Slack-Nachrichten und Weboberfläche: SPRACHE = de (Standard) | en.
// Einstellbar in der Weboberfläche unter Einstellungen (gilt nach dem Neustart). Logs bleiben deutsch.
// Language for recipes, Slack messages and the web UI: SPRACHE = de (default) | en.
// Autor: SebastianInTheWild · MIT-Lizenz

export const lang = () => (/^en/i.test((process.env.SPRACHE || "").trim()) ? "en" : "de");
/** Text in der eingestellten Sprache: L("Deutsch", "English") */
export const L = (de, en) => (lang() === "en" ? en : de);
export const locale = () => L("de-DE", "en-GB");
/** „1 Rezept“ / „3 Rezepte“ – „1 recipe“ / „3 recipes“ */
export const recipes = (n) => `${n} ${n === 1 ? L("Rezept", "recipe") : L("Rezepte", "recipes")}`;

// Slack-Befehle: deutsche Namen (im Manifest) und englische Namen (bei SPRACHE=en im Manifest). Beide funktionieren immer.
export const COMMAND_NAMES = {
  "/statistik": "/stats",
  "/offen": "/open",
  "/rezept": "/recipe",
  "/ohne-bild": "/no-image",
  "/bild-neu": "/new-image",
  "/bild-alle": "/all-images",
  "/pruefen": "/check",
  "/pro-tag": "/per-day",
  "/wochenplan": "/meal-plan",
  "/was-kochen": "/what-to-cook",
  "/neuronen": "/neurons",
  "/hilfe": "/help",
};
const GERMAN = Object.fromEntries(Object.entries(COMMAND_NAMES).map(([de, en]) => [en, de]));
/** Interner (deutscher) Befehl zu einem eingegebenen Befehl */
export const canonicalCommand = (c) => GERMAN[c] || c;
/** Befehl so, wie er in der eingestellten Sprache heißt */
export const cmd = (de) => (lang() === "en" ? COMMAND_NAMES[de] || de : de);
