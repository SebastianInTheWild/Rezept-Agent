// Vorschlag anlegen (wie der Agent über „node tandoor.mjs propose“) und überarbeiten – inklusive Nährwerte
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor } from "./helpers.mjs";

const { data } = setupEnv({ REZEPT_VORLAGE: "1", AGENT_DATA: "" });
process.env.AGENT_DATA = join(data, "rezepte");
const step = { name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [] };
const tandoor = fakeTandoor([{ id: 1, name: "Rahmwirsing", steps: [step], servings: 4, keywords: [{ name: "geprüft" }] }]);
installFetch([[TANDOOR, tandoor.handle]]);
const job = join(data, "auftrag.json");
writeFileSync(job, JSON.stringify({ kind: "import", urls: [], images: [], text: "Rezept", ts: "1.0", channel: "C1", user: "U1" }));
process.env.REZEPT_JOB = job;
const rez = await import(APP("lib/rezepte.mjs"));
const draftFile = rez.DRAFT_FILE();

const entwurf = {
  name: "Gnocchi-Pfanne",
  description: "Schnelle Gnocchi-Pfanne mit Spinat.",
  servings: 2,
  working_time: 20,
  waiting_time: 0,
  keywords: ["Einfach", "Hauptgericht", "Nährwerte geschätzt"],
  devices: ["Pfanne"],
  steps: [{ instruction: "Gnocchi anbraten.", time: 8, ingredients: [{ amount: 400, unit: "g", food: "Gnocchi" }, { food: "Salz", no_amount: true, note: "nach Geschmack" }] }],
  nutrition: { calories: 620, proteins: 14, fats: 22, carbohydrates: 88 },
  image_prompt: "goldbraune Gnocchi in einer Pfanne",
  changes: ["Aus Text übernommen", "Nährwerte pro Portion geschätzt"],
};

test("Neues Rezept: Entwurf in Tandoor mit Hausstil, Status-Schlagwort und Nährwerten", async () => {
  writeFileSync(draftFile, JSON.stringify(entwurf));
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const draft = [...tandoor.recipes.values()].find((x) => x.name === "⏳ Entwurf: Gnocchi-Pfanne");
  assert.ok(draft, "Entwurf angelegt");
  assert.equal(draft.private, true);
  assert.deepEqual(draft.steps.map((s) => s.name), ["Benötigte Küchengeräte", "Schritt 1"]);
  assert.ok(draft.keywords.some((k) => k.name === "vorschlag-offen"));
  const t = await import(APP("lib/tandoor.mjs"));
  assert.deepEqual(t.simplify(draft).nutrition, entwurf.nutrition);
  assert.ok(r.warnings.some((w) => /Neue Lebensmittel: Gnocchi/.test(w)));
  const store = rez.loadStore();
  assert.equal(Object.values(store.proposals)[0].status, "open");
});

test("Fehlerhafter Entwurf wird mit Hinweisen abgelehnt (nichts angelegt)", async () => {
  const before = tandoor.recipes.size;
  writeFileSync(draftFile, JSON.stringify({ ...entwurf, servings: 0, nutrition: { calories: 99999 } }));
  const r = await rez.propose();
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /servings/);
  assert.match(r.errors.join(), /unplausibel/);
  assert.equal(tandoor.recipes.size, before);
});

test("Überarbeiten: derselbe Entwurf wird geändert, Nährwerte aktualisiert", async () => {
  const p = Object.values(rez.loadStore().proposals)[0];
  writeFileSync(job, JSON.stringify({ kind: "revise", proposal: p.id, text: "4 Portionen", ts: "2.0", thread_ts: "1.0", channel: "C1", user: "U1" }));
  writeFileSync(draftFile, JSON.stringify({ ...entwurf, servings: 4, nutrition: { calories: 600, proteins: 13, fats: 20, carbohydrates: 85 }, changes: ["Auf 4 Portionen geändert"] }));
  const before = tandoor.recipes.size;
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(tandoor.recipes.size, before, "kein neues Rezept");
  const draft = tandoor.recipes.get(p.draft_id);
  assert.equal(draft.servings, 4);
  const t = await import(APP("lib/tandoor.mjs"));
  assert.equal(t.simplify(draft).nutrition.calories, 600);
  assert.equal(draft.properties.filter((x) => /calor/i.test(x.property_type.name)).length, 1, "Kalorien nicht doppelt");
});
