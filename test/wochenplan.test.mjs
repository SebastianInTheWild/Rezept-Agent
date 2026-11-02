// Wochenplan: Kontext für den Agenten, Plan prüfen und in Slack vorschlagen, in Tandoor übernehmen; „Was koche ich?“
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, fakeSlack } from "./helpers.mjs";

const { data } = setupEnv({ SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C1" });
process.env.AGENT_DATA = join(data, "wochenplan");
mkdirSync(process.env.AGENT_DATA, { recursive: true });
const ing = (...foods) => [{ name: "Schritt 1", instruction: "x", order: 0, ingredients: foods.map((f, i) => ({ food: { name: f }, unit: null, amount: 1, order: i })) }];
const tandoor = fakeTandoor([
  { id: 1, name: "Zucchini-Feta-Pfanne", keywords: [{ name: "Hauptgericht" }, { name: "geprüft" }], working_time: 20, rating: 4, steps: ing("Zucchini", "Feta", "Zwiebel") },
  { id: 2, name: "Zucchinisuppe", keywords: [{ name: "Suppe" }], working_time: 30, steps: ing("Zucchini", "Sahne") },
  { id: 3, name: "Rahmwirsing", keywords: [{ name: "Beilage" }], steps: ing("Wirsing", "Sahne") },
  { id: 4, name: "⏳ Entwurf: Feta-Nudeln", steps: ing("Feta") },
]);
tandoor.foods.push({ id: 50, name: "Zucchini" }, { id: 51, name: "Feta" });
tandoor.mealPlans.push({ id: 9, from_date: "2026-11-01T18:00:00", recipe: { id: 3, name: "Rahmwirsing" } });
const slack = fakeSlack();
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://slack.com/api/", slack.handle],
]);
const job = join(data, "auftrag.json");
writeFileSync(job, JSON.stringify({ kind: "plan", agent: "wochenplan", days: 2, text: "vegetarisch", servings: 3, channel: "C1", ts: "100.0", user: "U1" }));
process.env.REZEPT_JOB = job;
const wp = await import(APP("lib/wochenplan.mjs"));
const rez = await import(APP("lib/rezepte.mjs"));

test("Kontext: Zeitraum, Wünsche, Rezepte ohne Entwürfe und Status-Schlagwörter, bisher Geplantes", async () => {
  const c = await wp.planContext();
  assert.equal(c.days, 2);
  assert.equal(c.dates.length, 2);
  assert.equal(c.wishes, "vegetarisch");
  assert.equal(c.servings, 3);
  assert.ok(!c.recipes.some((r) => r.name.startsWith("⏳")), "keine Entwürfe");
  assert.deepEqual(c.recipes.find((r) => r.id === 1).keywords, ["Hauptgericht"], "ohne Status-Schlagwörter");
  assert.deepEqual(c.planned.map((p) => p.recipe_id), [3]);
});

test("Plan prüfen: unbekannte oder doppelte Rezepte werden abgelehnt", async () => {
  writeFileSync(wp.PLAN_FILE(), JSON.stringify({ days: [{ date: "2026-11-03", recipe_id: 1 }, { date: "2026-11-04", recipe_id: 1 }, { date: "morgen", recipe_id: 999 }] }));
  const r = await wp.proposePlan();
  assert.equal(r.ok, false);
  const e = r.errors.join(" | ");
  assert.match(e, /doppelt/);
  assert.match(e, /999 gibt es nicht/);
  assert.match(e, /JJJJ-MM-TT/);
});

test("Plan vorschlagen: Slack-Nachricht im Thread des Auftrags mit Knöpfen", async () => {
  writeFileSync(wp.PLAN_FILE(), JSON.stringify({ days: [{ date: "2026-11-04", recipe_id: 2, note: "warm" }, { date: "2026-11-03", recipe_id: 1 }], summary: "Zwei vegetarische Tage." }));
  const r = await wp.proposePlan();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const msg = slack.posts.at(-1);
  assert.equal(msg.thread_ts, "100.0");
  const text = JSON.stringify(msg.blocks);
  assert.match(text, /Zucchini-Feta-Pfanne.*Zucchinisuppe/, "nach Datum sortiert");
  assert.match(text, /rz_plan_shop/);
  assert.match(text, /3 Portionen/);
  const plan = rez.loadStore().plans[r.plan];
  assert.equal(plan.status, "open");
  assert.equal(wp.planByThread("100.0").id, r.plan);
});

test("Plan übernehmen: Essensplan mit Mahlzeit-Typ, Portionen und Einkaufsliste", async () => {
  const id = Object.keys(rez.loadStore().plans)[0];
  const r = await wp.applyPlan(id, "U2", { shopping: true });
  assert.equal(r.count, 2);
  const created = tandoor.mealPlans.filter((p) => p.id !== 9);
  assert.deepEqual(created.map((p) => [p.recipe.id, p.from_date, p.servings, p.addshopping, p.meal_type.name]), [
    [1, "2026-11-03T00:00:00", 3, true, "Abendessen"],
    [2, "2026-11-04T00:00:00", 3, true, "Abendessen"],
  ]);
  assert.equal(rez.loadStore().plans[id].status, "applied");
  await assert.rejects(wp.applyPlan(id, "U2"), /schon erledigt/);
});

test("Was koche ich? Rezepte mit den meisten passenden Zutaten zuerst", async () => {
  const r = await wp.findByIngredients("Zucchini, Feta, Drachenfrucht");
  assert.deepEqual(r.found.map((f) => f.name), ["Zucchini", "Feta"]);
  assert.deepEqual(r.missing, ["Drachenfrucht"]);
  assert.deepEqual(r.hits.map((h) => [h.name, h.matches.length]), [["Zucchini-Feta-Pfanne", 2], ["Zucchinisuppe", 1]]);
  assert.ok(!r.hits.some((h) => h.name.startsWith("⏳")), "keine Entwürfe");
});
