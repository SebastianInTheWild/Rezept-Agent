// „Wie war's?“ (Kochprotokoll), Wochenrückblick und die festen Aufgaben der Slack-Brücke (Uhrzeit aus zeitplan.conf)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, fakeSlack } from "./helpers.mjs";

const { data } = setupEnv({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C1" });
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
const tandoor = fakeTandoor([
  { id: 1, name: "Linsensuppe", keywords: [{ name: "geprüft" }], created_at: new Date().toISOString() },
  { id: 2, name: "Gnocchi-Pfanne", keywords: [], created_at: "2026-01-01T00:00:00Z" },
]);
tandoor.mealPlans.push(
  { id: 11, recipe: { id: 1, name: "Linsensuppe" }, servings: 3, from_date: `${today}T00:00:00+01:00` },
  { id: 12, recipe: { id: 2, name: "Gnocchi-Pfanne" }, servings: 2, from_date: today },
  { id: 13, recipe: { id: 2, name: "Gnocchi-Pfanne" }, servings: 2, from_date: "2026-01-02" }, // anderer Tag
  { id: 14, recipe: null, title: "Essen gehen", servings: 2, from_date: today }, // ohne Rezept
);
const slack = fakeSlack();
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://slack.com/api/", slack.handle],
]);
const kochen = await import(APP("lib/kochen.mjs"));
const rueckblick = await import(APP("lib/rueckblick.mjs"));
const aufgaben = await import(APP("lib/aufgaben.mjs"));
const rez = await import(APP("lib/rezepte.mjs"));

test("Wie war's?: je heute geplantem Rezept eine Frage mit ⭐1–5 und „Nicht gekocht“, nur einmal", async () => {
  assert.equal(await kochen.askCooked(), 2);
  const asks = slack.posts.slice(-2);
  assert.match(asks[0].text, /Linsensuppe/);
  const buttons = asks[0].blocks.find((b) => b.type === "actions").elements;
  assert.deepEqual(buttons.map((b) => b.action_id), ["rz_cook_1", "rz_cook_2", "rz_cook_3", "rz_cook_4", "rz_cook_5", "rz_cook_no"]);
  assert.equal(new Set(buttons.map((b) => b.action_id)).size, 6, "action_id je Nachricht eindeutig");
  assert.equal(await kochen.askCooked(), 0, "kein zweites Mal");
});

test("Bewertung → Kochprotokoll in Tandoor (Rezept, Portionen, Tag), doppelter Klick trägt nichts doppelt ein", async () => {
  const m = await kochen.answerCook("11", 4, "U1");
  assert.equal(tandoor.cookLogs.length, 1);
  assert.deepEqual(tandoor.cookLogs[0], { recipe: 1, servings: 3, rating: 4, comment: "", created_at: `${today}T12:00:00Z`, id: 1 });
  assert.match(m.blocks[0].text.text, /⭐⭐⭐⭐ von <@U1>/);
  assert.ok(!m.blocks.some((b) => b.type === "actions"), "Knöpfe weg");
  await kochen.answerCook("11", 2, "U2");
  assert.equal(tandoor.cookLogs.length, 1);
  const no = await kochen.answerCook("12", null, "U1");
  assert.match(no.blocks[0].text.text, /nicht gekocht/);
  assert.equal(tandoor.cookLogs.length, 1, "nicht gekocht → kein Eintrag");
  await assert.rejects(kochen.answerCook("99", 3, "U1"), /kenne ich nicht/);
});

test("Wochenrückblick: neue Rezepte, Vorschläge, Bewertungen, Bestand und Google-Kosten", async () => {
  const store = rez.loadStore();
  const now = new Date().toISOString();
  store.proposals = {
    a: { id: "a", kind: "import", status: "applied", decided: now, draft_id: 2, recipe_id: 2 },
    b: { id: "b", kind: "quality", status: "applied", decided: now, original_id: 1 },
    c: { id: "c", kind: "quality", status: "rejected", decided: now },
    d: { id: "d", kind: "import", status: "open" },
    e: { id: "e", kind: "quality", status: "applied", decided: "2026-01-01T10:00:00Z" }, // zu alt
  };
  rez.saveStore({ ...store, cooked: rez.loadStore().cooked });
  const month = today.slice(0, 7);
  writeFileSync(join(data, "rezepte", "google-nutzung.json"), JSON.stringify({ months: { [month]: { images: 1, videos: 0, input: 0, output: 0, image_cost: 0.5, video_cost: 0, days: { [today]: 0.5, "2026-01-01": 9 }, models: {} } } }));
  const w = await rueckblick.weekData();
  assert.deepEqual(w.added.map((r) => r.name).sort(), ["Gnocchi-Pfanne", "Linsensuppe"], "created_at und übernommener Import");
  assert.equal(w.applied_new, 1);
  assert.equal(w.applied_better, 1);
  assert.equal(w.rejected, 1);
  assert.equal(w.open, 1);
  assert.deepEqual(w.cooked.map((c) => [c.name, c.rating]), [["Linsensuppe", 4]], "nur Bewertete");
  assert.equal(w.google, 0.5, "nur die letzten 7 Tage");
  const text = rueckblick.digestMessage(w).blocks[0].text.text;
  assert.match(text, /Wochenrückblick/);
  assert.match(text, /2 übernommen \(1 neu, 1 verbessert\), 1 verworfen · noch offen: \*1\*/);
  assert.match(text, /am besten: <[^|]+\|Linsensuppe> ⭐⭐⭐⭐/);
  assert.match(text, /Google-Kosten \(geschätzt\): 0,50 \$/);
  const before = slack.posts.length;
  await rueckblick.sendDigest();
  assert.equal(slack.posts.length, before + 1);
});

test("Feste Aufgaben: Uhrzeit aus zeitplan.conf, Umgebungsvariable oder Standard; einmal pro Tag", () => {
  const conf = join(data, "zeitplan.conf");
  mkdirSync(data, { recursive: true });
  writeFileSync(conf, "koch-frage = 18:15\nwochenrueckblick = aus\n");
  assert.deepEqual(aufgaben.planOf("koch-frage", "20:30").time, "18:15");
  assert.equal(aufgaben.planOf("wochenrueckblick", "So 19:30").off, true);
  delete process.env.TOKEN_PRUEFUNG;
  assert.deepEqual(aufgaben.planOf("token-pruefung", "09:05"), { days: aufgaben.WEEKDAYS, time: "09:05", raw: "09:05", source: "Standard" });
  process.env.TOKEN_PRUEFUNG = "Mo 07:00";
  assert.equal(aufgaben.planOf("token-pruefung", "09:05").source, "TOKEN_PRUEFUNG");
  assert.match(aufgaben.planOf("x-test", "25 Uhr").error, /nicht verstanden/);
  // Montag 2026-11-02, 07:30 Berlin: fällig, danach nicht noch einmal; Dienstag nicht (nur Mo)
  const monday = new Date("2026-11-02T06:30:00Z");
  assert.equal(aufgaben.takeDue("token-pruefung", "09:05", monday).due, true);
  assert.equal(aufgaben.takeDue("token-pruefung", "09:05", monday).due, false, "heute schon gelaufen");
  assert.equal(aufgaben.takeDue("token-pruefung", "09:05", new Date("2026-11-03T06:30:00Z")).due, false, "Dienstag");
  assert.equal(aufgaben.takeDue("koch-frage", "20:30", new Date("2026-11-02T16:00:00Z")).due, false, "17:00 < 18:15");
  assert.equal(aufgaben.takeDue("koch-frage", "20:30", new Date("2026-11-02T18:00:00Z")).due, true, "19:00 ≥ 18:15");
  process.env.TOKEN_PRUEFUNG = "aus";
});
