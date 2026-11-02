// „/pruefen-rezept“: einzelne Rezepte gezielt prüfen – kommen zuerst dran, auch wenn schon geprüft, ohne Tageslimit
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor } from "./helpers.mjs";

const { data } = setupEnv({ REZEPT_VORLAGE: "1", REZEPT_BATCH: "0", AGENT_DATA: "" });
process.env.AGENT_DATA = join(data, "rezepte");
const step = { name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [] };
const tandoor = fakeTandoor([
  { id: 1, name: "Rahmwirsing", steps: [step], servings: 4, keywords: [{ name: "geprüft" }] },
  { id: 2, name: "Lasagne", steps: [step], servings: 4 },
  { id: 3, name: "Omas Kuchen", steps: [step], servings: 12, keywords: [{ name: "nicht-bearbeiten" }] },
]);
installFetch([[TANDOOR, tandoor.handle]]);
const rez = await import(APP("lib/rezepte.mjs"));
const ids = (p) => p.batch.map((r) => r.id);

test("Tageswert 0: ohne Anfrage nichts zu prüfen", async () => {
  assert.deepEqual(ids(await rez.pending()), []);
});

test("Gezielt angefragt: geprüftes und „nicht bearbeiten“-Rezept kommen trotz Tageswert 0 dran", async () => {
  assert.equal(rez.addSingle(1), true);
  assert.equal(rez.addSingle(1), false, "doppelt vorgemerkt");
  rez.addSingle(3);
  const p = await rez.pending();
  assert.deepEqual(ids(p), [1, 3]);
  assert.equal(p.single, 2);
});

test("Vorschlag erledigt die Anfrage und zählt nicht zum Tageswert", async () => {
  writeFileSync(rez.DRAFT_FILE(), JSON.stringify({ original_id: 1, name: "Rahmwirsing", description: "Cremiger Wirsing.", servings: 4, working_time: 20, waiting_time: 0, keywords: ["Einfach"], devices: ["Topf"], steps: [{ instruction: "Kochen.", time: 5, ingredients: [] }], changes: ["Schritte vereinfacht"] }));
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const prop = Object.values(rez.loadStore().proposals).find((x) => x.original_id === 1);
  assert.equal(prop.single, true);
  assert.equal(rez.openProposalFor(1)?.id, prop.id);
  const p = await rez.pending();
  assert.deepEqual(ids(p), [3], "Rezept 1 hat jetzt einen offenen Vorschlag, Rezept 3 wartet noch");
  assert.equal(p.left_today, 0);
});
