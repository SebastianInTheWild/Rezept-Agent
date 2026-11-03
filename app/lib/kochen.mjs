// „Wie war's?“ nach dem Kochen: Abends fragt die Slack-Brücke zu jedem Gericht, das heute im Tandoor-Essensplan steht,
// wie es geschmeckt hat (⭐1–5 oder „Nicht gekocht“). Die Antwort landet als Eintrag im Tandoor-Kochprotokoll
// (Bewertung, Portionen, Datum) – daraus berechnet Tandoor „Bewertung“ und „zuletzt gekocht“, nach denen der
// Wochenplan auswählt. Uhrzeit: zeitplan.conf „koch-frage = 20:30“ (Standard), „aus“ schaltet ab.
// Gemerkt in vorschlaege.json → cooked: { <Essensplan-ID>: { date, recipe_id, name, servings, slack, answer, by, at } }
// Autor: SebastianInTheWild · MIT-Lizenz

import { all, api, recipeUrl } from "./tandoor.mjs";
import { post, slackReady, link, esc } from "./slack.mjs";
import { L, locale } from "./i18n.mjs";
import { loadStore, saveStore, CHANNEL } from "./rezepte.mjs";

export const COOK_ID = "koch-frage";
export const COOK_DEFAULT = "20:30";
const tz = () => process.env.TZ || "Europe/Berlin";
const isoDay = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: tz() });
const stars = (n) => "⭐".repeat(n);

// Essensplan-Einträge eines Tages (Tandoor 1.x liefert „2026-11-03“, 2.x „2026-11-03T00:00:00+01:00“)
async function plannedOn(day) {
  const list = await all(`/api/meal-plan/?from_date=${day}&to_date=${day}`);
  return list
    .filter((p) => String(p.from_date || "").slice(0, 10) === day)
    .map((p) => ({ id: p.id, recipe_id: p.recipe?.id ?? (typeof p.recipe === "number" ? p.recipe : null), name: p.recipe?.name || p.recipe_name || p.title || "", servings: Number(p.servings) || 1 }))
    .filter((p) => p.recipe_id);
}

/** Nachricht für einen Eintrag – mit Knöpfen, solange nicht beantwortet */
export function cookMessage(e) {
  const name = link(recipeUrl(e.recipe_id), e.name);
  if (e.answer === undefined) {
    const btn = (text, action_id, style) => ({ type: "button", text: { type: "plain_text", text }, action_id, value: String(e.id), ...(style ? { style } : {}) });
    return {
      text: L(`Wie war ${e.name}?`, `How was ${e.name}?`),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: L(`🍽️ Heute stand *${name}* auf dem Essensplan. Wie war's?`, `🍽️ *${name}* was on the meal plan today. How was it?`) } },
        { type: "actions", block_id: `rzcook:${e.id}`, elements: [1, 2, 3, 4, 5].map((n) => btn(stars(n), `rz_cook_${n}`, n === 5 ? "primary" : undefined)).concat(btn(L("Nicht gekocht", "Not cooked"), "rz_cook_no")) },
        { type: "context", elements: [{ type: "mrkdwn", text: L("Die Bewertung kommt ins Kochprotokoll in Tandoor – der Wochenplan bevorzugt dann gut bewertete Rezepte.", "The rating goes into the cook log in Tandoor – the meal plan then prefers well-rated recipes.") }] },
      ],
    };
  }
  const text = e.answer === null ? L(`🍽️ *${name}*: nicht gekocht (<@${e.by}>)`, `🍽️ *${name}*: not cooked (<@${e.by}>)`) : L(`🍽️ *${name}*: ${stars(e.answer)} von <@${e.by}> – im Kochprotokoll`, `🍽️ *${name}*: ${stars(e.answer)} by <@${e.by}> – in the cook log`);
  return { text: e.name, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/** Heute geplante Gerichte abfragen (je Essensplan-Eintrag nur einmal). Liefert die Anzahl gestellter Fragen. */
export async function askCooked(now = new Date(), channel = CHANNEL()) {
  if (!slackReady() || !channel) return 0;
  const day = isoDay(now);
  const planned = await plannedOn(day);
  const store = loadStore();
  store.cooked ||= {};
  let n = 0;
  for (const p of planned) {
    if (store.cooked[p.id]) continue;
    const e = { ...p, date: day };
    const r = await post(channel, ...Object.values(cookMessage(e)));
    store.cooked[p.id] = { ...e, slack: { channel, ts: r.ts }, asked: new Date().toISOString() };
    saveStore(store);
    n++;
  }
  return n;
}

/** Antwort auf einen Knopf: rating 1–5 → Kochprotokoll in Tandoor, null = nicht gekocht. Liefert die neue Nachricht. */
export async function answerCook(planId, rating, user) {
  const store = loadStore();
  const e = store.cooked?.[planId];
  if (!e) throw new Error(L("Diese Frage kenne ich nicht mehr", "I don't know this question any more"));
  if (e.answer !== undefined) return cookMessage(e); // schon beantwortet – nichts doppelt eintragen
  if (rating !== null) {
    if (!(rating >= 1 && rating <= 5)) throw new Error("Bewertung 1–5");
    // Uhrzeit egal, aber am richtigen Tag (Mittag in UTC, damit die Zeitzone den Tag nicht verschiebt)
    const log = await api("POST", "/api/cook-log/", { recipe: e.recipe_id, servings: e.servings, rating, comment: "", created_at: `${e.date}T12:00:00Z` });
    e.cook_log = log?.id ?? null;
  }
  Object.assign(e, { answer: rating, by: user, at: new Date().toISOString() });
  saveStore(store);
  return cookMessage(e);
}

/** Antworten der letzten Tage (für den Wochenrückblick) */
export function cookedSince(sinceIso) {
  return Object.values(loadStore().cooked || {}).filter((e) => e.date >= sinceIso.slice(0, 10));
}
export const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale(), { weekday: "short", timeZone: "UTC" });
