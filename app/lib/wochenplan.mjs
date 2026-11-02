// Wochenplan und „Was koche ich?“
// - /wochenplan [Tage] [Wünsche]: Der Agent „wochenplan“ wählt passende Rezepte aus Tandoor (abwechslungsreich,
//   saisonal, gut bewertet, nicht kürzlich gekocht) und schlägt sie in Slack vor. Mit einem Klick landen sie im
//   Tandoor-Essensplan, auf Wunsch samt Zutaten auf der Einkaufsliste. Antwort im Thread → Plan überarbeiten.
// - /was-kochen <Zutaten>: Rezepte, die diese Zutaten enthalten (ohne Claude, direkt aus Tandoor).
// Einstellungen: WOCHENPLAN_PORTIONEN (Standard 2), WOCHENPLAN_MAHLZEIT (Mahlzeit-Typ, Standard „Abendessen“/„Dinner“).
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, api, isDraft, recipeUrl } from "./tandoor.mjs";
import { post, slackReady, link, esc } from "./slack.mjs";
import { L, locale } from "./i18n.mjs";
import { loadStore, saveStore, loadJob, saveJob, CHANNEL } from "./rezepte.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
export const PLAN_FILE = () => join(process.env.AGENT_DATA || join(DATA_DIR, "wochenplan"), "wochenplan.json");
export const MAX_DAYS = 14;
const tz = () => process.env.TZ || "Europe/Berlin";
const isoDay = (d) => d.toLocaleDateString("sv-SE", { timeZone: tz() });
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const servingsDefault = () => Math.max(1, Number(process.env.WOCHENPLAN_PORTIONEN) || 2);
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale(), { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });

/** Mahlzeit-Typ für den Plan: WOCHENPLAN_MAHLZEIT, sonst „Abendessen“/„Dinner“, sonst der erste */
async function mealType() {
  const types = await all("/api/meal-type/");
  const wanted = (process.env.WOCHENPLAN_MAHLZEIT || "").trim().toLowerCase();
  const t = (wanted && types.find((x) => x.name.toLowerCase() === wanted)) || types.find((x) => /abend|dinner/i.test(x.name)) || types[0];
  if (t) return t;
  // Noch kein Mahlzeit-Typ in Tandoor: einen anlegen
  return api("POST", "/api/meal-type/", { name: L("Abendessen", "Dinner"), order: 0 });
}

/**
 * Für den Agenten: Auftrag (Tage, Startdatum, Wünsche), alle Rezepte kompakt, was zuletzt geplant war.
 * Ohne Auftrag (Zeitplan, „Jetzt starten“): 7 Tage ab morgen.
 */
export async function planContext() {
  const job = loadJob() || {};
  const today = isoDay(new Date());
  const start = job.start || addDays(today, 1);
  const days = Math.min(MAX_DAYS, Math.max(1, Number(job.days) || 7));
  const recipes = (await all("/api/recipe/"))
    .filter((r) => !isDraft(r.name))
    .map((r) => ({
      id: r.id,
      name: r.name,
      keywords: (r.keywords || []).map((k) => k.name ?? k.label).filter((k) => !/^(geprüft|vorschlag-offen|nicht-bearbeiten|ki-bild)$/.test(k)),
      working_time: r.working_time || 0,
      waiting_time: r.waiting_time || 0,
      rating: r.rating ?? null,
      last_cooked: r.last_cooked ? String(r.last_cooked).slice(0, 10) : null,
    }));
  // Was in den letzten drei Wochen und schon im Zeitraum geplant ist – nicht doppelt vorschlagen
  const plans = await all(`/api/meal-plan/?from_date=${addDays(today, -21)}&to_date=${addDays(start, days)}`).catch(() => []);
  const planned = plans.map((p) => ({ date: String(p.from_date).slice(0, 10), recipe_id: p.recipe?.id ?? null, name: p.recipe?.name || p.title || "" }));
  const store = loadStore();
  const current = job.kind === "plan-revise" ? store.plans?.[job.plan] : null;
  return {
    language: (process.env.SPRACHE || "de").startsWith("en") ? "en" : "de",
    today,
    start,
    days,
    dates: Array.from({ length: days }, (_, i) => addDays(start, i)),
    servings: job.servings || servingsDefault(),
    wishes: job.text || "",
    ...(current ? { current_plan: current.days, change_request: job.text } : {}),
    planned,
    recipes,
    plan_file: PLAN_FILE(),
  };
}

const buttons = (id) => ({
  type: "actions",
  block_id: `rzplan:${id}`,
  elements: [
    { type: "button", style: "primary", text: { type: "plain_text", text: L("🛒 In Essensplan + Einkaufsliste", "🛒 To meal plan + shopping list") }, action_id: "rz_plan_shop", value: id },
    { type: "button", text: { type: "plain_text", text: L("📅 Nur Essensplan", "📅 Meal plan only") }, action_id: "rz_plan_only", value: id },
    { type: "button", style: "danger", text: { type: "plain_text", text: L("Verwerfen", "Discard") }, action_id: "rz_plan_no", value: id },
  ],
});

/** Slack-Nachricht für einen Wochenplan */
export function planMessage(plan) {
  const lines = plan.days.map((d) => `• *${weekday(d.date)}* – ${link(recipeUrl(d.recipe_id), d.name)}${d.servings !== plan.servings ? ` (${d.servings} ${L("Portionen", "servings")})` : ""}${d.note ? ` – _${esc(d.note)}_` : ""}`);
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `🗓️ *${L("Wochenplan", "Meal plan")}* · ${weekday(plan.days[0].date)} – ${weekday(plan.days.at(-1).date)} · ${plan.servings} ${L("Portionen", "servings")}` } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n").slice(0, 2900) } },
  ];
  if (plan.summary) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: esc(plan.summary).slice(0, 2900) }] });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: L("Antworte im Thread, wenn ich etwas tauschen soll (z. B. „Mittwoch lieber vegetarisch“).", "Reply in the thread if I should swap something (e.g. “Wednesday vegetarian please”).") }] });
  blocks.push(buttons(plan.id));
  return { text: `${L("Wochenplan", "Meal plan")}: ${plan.days.map((d) => d.name).join(", ")}`.slice(0, 300), blocks };
}

/**
 * Plan aus wochenplan.json prüfen und in Slack vorschlagen (bzw. den offenen Plan ersetzen).
 * Datei: { "days": [{ "date": "2026-11-03", "recipe_id": 12, "servings": 2, "note": "…" }], "summary": "…" }
 */
export async function proposePlan() {
  const job = loadJob() || {};
  const path = PLAN_FILE();
  if (!existsSync(path)) throw new Error(`${path} fehlt`);
  let d;
  try {
    d = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`wochenplan.json ist kein gültiges JSON: ${e.message}`] };
  }
  const recipes = new Map((await all("/api/recipe/")).filter((r) => !isDraft(r.name)).map((r) => [r.id, r]));
  const errors = [];
  if (!Array.isArray(d.days) || !d.days.length) errors.push("days fehlt (Liste mit date und recipe_id)");
  if (d.days?.length > MAX_DAYS) errors.push(`Höchstens ${MAX_DAYS} Tage`);
  const servings = Number(job.servings) || servingsDefault();
  const seen = new Set();
  const days = (d.days || []).map((x, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date))) errors.push(`Tag ${i + 1}: date muss JJJJ-MM-TT sein`);
    const r = recipes.get(Number(x.recipe_id));
    if (!r) errors.push(`Tag ${i + 1}: Rezept ${x.recipe_id} gibt es nicht`);
    if (seen.has(Number(x.recipe_id))) errors.push(`Tag ${i + 1}: Rezept ${x.recipe_id} kommt doppelt vor`);
    seen.add(Number(x.recipe_id));
    const s = x.servings === undefined ? servings : Number(x.servings);
    if (!(s >= 1 && s <= 50)) errors.push(`Tag ${i + 1}: servings muss 1–50 sein`);
    return { date: x.date, recipe_id: Number(x.recipe_id), name: r?.name || "?", servings: s, note: String(x.note || "").slice(0, 200) };
  });
  if (errors.length) return { ok: false, errors };
  days.sort((a, b) => a.date.localeCompare(b.date));

  const store = loadStore();
  store.plans ||= {};
  const revising = job.kind === "plan-revise" && store.plans[job.plan]?.status === "open";
  const id = revising ? job.plan : `w${Date.now().toString(36)}`;
  const plan = { ...(revising ? store.plans[id] : {}), id, status: "open", days, servings, summary: String(d.summary || "").slice(0, 500), created: revising ? store.plans[id].created : new Date().toISOString(), updated: new Date().toISOString(), by: job.user || "zeitplan" };
  const msg = planMessage(plan);
  if (slackReady() && CHANNEL()) {
    const channel = plan.slack?.channel || job.channel || CHANNEL();
    const thread = plan.slack?.thread_ts || job.thread_ts || job.ts;
    const r = await post(channel, msg.text, msg.blocks, thread);
    plan.slack = { channel, thread_ts: thread || r.ts, last_ts: r.ts };
  }
  store.plans[id] = plan;
  saveStore(store);
  writeFileSync(path, "{}");
  if (job.kind) saveJob({ ...job, result: id });
  return { ok: true, plan: id, days: days.map((x) => `${x.date}: ${x.name}`) };
}

export const planByThread = (ts) => Object.values(loadStore().plans || {}).find((p) => p.slack && (p.slack.thread_ts === ts || p.slack.last_ts === ts));

/** Plan in den Tandoor-Essensplan übernehmen; shopping = Zutaten auf die Einkaufsliste */
export async function applyPlan(id, user, { shopping = true } = {}) {
  const store = loadStore();
  const plan = store.plans?.[id];
  if (!plan) throw new Error(L("Plan unbekannt", "Unknown plan"));
  if (plan.status !== "open") throw new Error(L(`Plan ist schon erledigt (${plan.status})`, `Plan already decided (${plan.status})`));
  const type = await mealType();
  const created = [];
  for (const d of plan.days) {
    const r = await api("POST", "/api/meal-plan/", {
      title: "",
      recipe: { id: d.recipe_id, name: d.name, keywords: [] },
      servings: d.servings,
      note: d.note || "",
      from_date: `${d.date}T00:00:00`,
      meal_type: { id: type.id, name: type.name },
      addshopping: shopping,
    });
    created.push(r.id);
  }
  Object.assign(plan, { status: shopping ? "applied" : "applied-no-shopping", decided_by: user, decided: new Date().toISOString(), meal_plans: created, meal_type: type.name });
  saveStore(store);
  return { ok: true, count: created.length, meal_type: type.name };
}

export function rejectPlan(id, user) {
  const store = loadStore();
  const plan = store.plans?.[id];
  if (!plan) throw new Error(L("Plan unbekannt", "Unknown plan"));
  if (plan.status !== "open") throw new Error(L(`Plan ist schon erledigt (${plan.status})`, `Plan already decided (${plan.status})`));
  Object.assign(plan, { status: "rejected", decided_by: user, decided: new Date().toISOString() });
  saveStore(store);
  return { ok: true };
}

/**
 * „Was koche ich?“: Rezepte, die möglichst viele der genannten Zutaten enthalten (Tandoor-Lebensmittel, nicht nur Namen).
 * Liefert { found: [Lebensmittel], missing: [Begriffe], hits: [{ id, name, url, matches, rating }] }
 */
export async function findByIngredients(text) {
  const terms = [...new Set(String(text).split(/[,;\n]| und | and /i).map((s) => s.trim()).filter(Boolean))].slice(0, 8);
  const found = [];
  const missing = [];
  for (const term of terms) {
    const foods = (await api("GET", `/api/food/?query=${encodeURIComponent(term)}&page_size=10`)).results || [];
    // genauer Treffer vor Teiltreffer („Zwiebel“ vor „Frühlingszwiebel“)
    const f = foods.find((x) => x.name.toLowerCase() === term.toLowerCase()) || foods.find((x) => x.name.toLowerCase().startsWith(term.toLowerCase())) || foods[0];
    if (f) found.push({ term, id: f.id, name: f.name });
    else missing.push(term);
  }
  const count = new Map();
  for (const f of found) {
    const list = await all(`/api/recipe/?foods=${f.id}`).catch(() => []);
    for (const r of list) {
      if (isDraft(r.name)) continue;
      const e = count.get(r.id) || { id: r.id, name: r.name, url: recipeUrl(r.id), matches: [], rating: r.rating ?? null, working_time: r.working_time || 0 };
      e.matches.push(f.name);
      count.set(r.id, e);
    }
  }
  const hits = [...count.values()].sort((a, b) => b.matches.length - a.matches.length || (b.rating || 0) - (a.rating || 0) || a.working_time - b.working_time).slice(0, 10);
  return { found, missing, hits };
}
