// Bilder bei Vorschlägen: einheitlicher Stil auch beim Prüfen, altes Bild sichern, „🎨 Neues Bild“, Tageslimit
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, json, png } from "./helpers.mjs";

const { data } = setupEnv({ REZEPT_VORLAGE: "1", GEMINI_API_KEY: "g" });
process.env.AGENT_DATA = join(data, "rezepte");
const step = { name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [{ food: { name: "Wirsing" }, unit: { name: "g" }, amount: 450, note: "", order: 0, is_header: false, no_amount: false }] };
const tandoor = fakeTandoor([
  { id: 1, name: "Rahmwirsing", steps: [step], servings: 4, keywords: [], image: `${TANDOOR}/media/1.png?X-Amz-Signature=x` },
  { id: 2, name: "Curry-Hack-Nudeln", steps: [step], servings: 4, keywords: [], image: `${TANDOOR}/media/2.png?X-Amz-Signature=y` },
]);
const oldPhoto = png(9, 9, 9);
tandoor.images.set(1, oldPhoto);
tandoor.images.set(2, png(8, 8, 8));
let googleCalls = 0;
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://generativelanguage.googleapis.com/", async () => (googleCalls++, json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png(200, 100, 50).toString("base64") } }] } }] }))],
]);
const job = join(data, "auftrag.json");
process.env.REZEPT_JOB = job;
const rez = await import(APP("lib/rezepte.mjs"));
const bild = await import(APP("lib/bild.mjs"));
const draftFile = rez.DRAFT_FILE();
const entwurf = (original_id) => ({ original_id, name: tandoor.recipes.get(original_id).name, servings: 4, keywords: ["Einfach"], steps: [{ instruction: "Kochen.", ingredients: [{ amount: 450, unit: "g", food: "Wirsing" }] }], image_prompt: "Wirsing in einer Schüssel", changes: ["Form verbessert"] });
const proposals = () => Object.values(rez.loadStore().proposals);

test("Prüfen: altes Foto → neues KI-Bild im Entwurf, beim Übernehmen altes Bild gesichert und ersetzt", async () => {
  writeFileSync(job, JSON.stringify({}));
  writeFileSync(draftFile, JSON.stringify(entwurf(1)));
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p = proposals().find((x) => x.original_id === 1);
  assert.equal(p.replace_image, true);
  assert.ok(tandoor.images.has(p.draft_id), "Entwurf hat das neue Bild");
  assert.equal(p.image_prompt, "Wirsing in einer Schüssel");

  const a = await rez.applyProposal(p.id, "U1");
  assert.match(a.note, /altes Bild gesichert/);
  const backups = readdirSync(join(data, "rezepte", "sicherungen")).filter((f) => f.startsWith("1-bild-"));
  assert.equal(backups.length, 1, "altes Bild gesichert");
  assert.ok(!tandoor.images.get(1).equals(oldPhoto), "Bild des Originals ersetzt");
  assert.ok(tandoor.recipes.get(1).keywords.some((k) => k.name === "ki-bild"));
});

test("Prüfen: Original hat schon ein KI-Bild im aktuellen Stil → wird übernommen, nichts Neues erzeugt", async () => {
  const before = googleCalls;
  const store = rez.loadStore();
  const path = String(tandoor.recipes.get(1).image).split("?")[0];
  store.ai_images[1] = { ...store.ai_images[1], style: bild.styleId(), image: path };
  rez.saveStore(store);
  writeFileSync(draftFile, JSON.stringify(entwurf(1)));
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p = proposals().find((x) => x.original_id === 1 && x.status === "open");
  assert.equal(googleCalls, before, "kein neues Bild");
  assert.ok(!p.replace_image);
  assert.ok(tandoor.images.has(p.draft_id), "Bild des Originals in den Entwurf kopiert");
  await rez.rejectProposal(p.id, "U1");
});

test("„🎨 Neues Bild“ am Vorschlag: Bild nachträglich erzeugen, ersetzt beim Übernehmen das alte (gesichert)", async () => {
  writeFileSync(draftFile, JSON.stringify(entwurf(2)));
  // Wie bei den Curry-Hack-Nudeln: Google ist beim Anlegen nicht erreichbar → Vorschlag ohne Bild
  delete process.env.GEMINI_API_KEY;
  await rez.propose();
  process.env.GEMINI_API_KEY = "g";
  const p = proposals().find((x) => x.original_id === 2 && x.status === "open");
  assert.ok(!p.generated_image);
  const r = await rez.regenerateDraftImage(p.id);
  assert.equal(r.replacesOld, true);
  assert.ok(tandoor.images.has(p.draft_id));
  const a = await rez.applyProposal(p.id, "U1");
  assert.match(a.note, /altes Bild gesichert/);
  assert.ok(readdirSync(join(data, "rezepte", "sicherungen")).some((f) => f.startsWith("2-bild-")));
});

test("„🎨 Neues Bild“ nur an offenen Vorschlägen", async () => {
  const done = proposals().find((x) => x.status === "applied");
  await assert.rejects(rez.regenerateDraftImage(done.id), /schon erledigt/);
});

test("Tageslimit: leer = unbegrenzt, Zahl = Grenze", async () => {
  delete process.env.BILD_PRO_TAG;
  const d = { name: "X", steps: [] };
  for (let i = 0; i < 12; i++) await bild.generateImage(d, join(data, "rezepte"));
  process.env.BILD_PRO_TAG = "3";
  await assert.rejects(bild.generateImage(d, join(data, "rezepte")), /Tageslimit/);
  delete process.env.BILD_PRO_TAG;
  assert.ok(existsSync(join(data, "rezepte", "bilder-zaehler.json")));
});
