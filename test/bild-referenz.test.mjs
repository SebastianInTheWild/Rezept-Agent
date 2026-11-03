// Video-Import: das Standbild vom fertigen Gericht geht als Vorlage ans KI-Bild (Google), Fotos aus Slack nicht
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, json, png } from "./helpers.mjs";

const { data } = setupEnv({ REZEPT_VORLAGE: "1", GEMINI_API_KEY: "g" });
process.env.AGENT_DATA = join(data, "rezepte");
const tandoor = fakeTandoor([{ id: 1, name: "Rahmwirsing", steps: [{ name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [] }], servings: 4 }]);
const google = [];
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://generativelanguage.googleapis.com/", async (url, init) => (google.push(JSON.parse(init.body)), json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png(200, 100, 50).toString("base64") } }] } }] }))],
]);
const job = join(data, "auftrag.json");
writeFileSync(job, JSON.stringify({ kind: "import", urls: ["https://www.instagram.com/reel/abc/"], images: [], text: "", ts: "1.0", channel: "C1", user: "U1" }));
process.env.REZEPT_JOB = job;
const rez = await import(APP("lib/rezepte.mjs"));
const inbox = join(data, "rezepte", "inbox");
mkdirSync(inbox, { recursive: true });
const frame = join(inbox, "video-abc-fertig.jpg");
const still = png(10, 200, 10);
writeFileSync(frame, still);
const photo = join(inbox, "slack-kochbuch.jpg");
writeFileSync(photo, png(1, 1, 1));

const entwurf = (name, image_file) => ({ name, servings: 2, keywords: ["Einfach"], steps: [{ instruction: "Kochen.", ingredients: [{ amount: 200, unit: "g", food: "Nudeln" }] }], image_prompt: "Nudeln mit Tomatensoße", image_file, changes: ["Aus einem Instagram-Reel"] });
const proposal = (name) => Object.values(rez.loadStore().proposals).find((p) => p.name === name);

test("Standbild aus dem Video → als Vorlage an Google, Stil bleibt, Hinweis im Vorschlag", async () => {
  writeFileSync(rez.DRAFT_FILE(), JSON.stringify(entwurf("Reel-Nudeln", frame)));
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const parts = google.at(-1).contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].inlineData.data, still.toString("base64"), "Standbild mitgeschickt");
  assert.equal(parts[0].inlineData.mimeType, "image/png");
  assert.match(parts[1].text, /Reel-Nudeln/);
  assert.match(parts[1].text, /Use it only as a reference for what the food itself looks like/);
  const p = proposal("Reel-Nudeln");
  assert.equal(p.image_reference, frame);
  assert.equal(p.generated_info.reference, true);
  assert.ok(p.changes.some((c) => /fertigen Gericht aus dem Video als Vorlage/.test(c)));
});

test("„🎨 Neues Bild“ erzeugt normal, ohne Vorlage", async () => {
  const p = proposal("Reel-Nudeln");
  await rez.regenerateDraftImage(p.id);
  const parts = google.at(-1).contents[0].parts;
  assert.equal(parts.length, 1);
  assert.ok(!/still frame/.test(parts[0].text));
  assert.equal(proposal("Reel-Nudeln").generated_info.reference, undefined);
});

test("„🎨 Neues Bild“ mit Wunsch: Wunsch steht im Prompt und hat Vorrang", async () => {
  const p = proposal("Reel-Nudeln");
  await rez.regenerateDraftImage(p.id, { wish: "von oben fotografiert,\n mit   mehr Parmesan" });
  const text = google.at(-1).contents[0].parts[0].text;
  assert.match(text, /Follow it, even where it differs from the description above: von oben fotografiert, mit mehr Parmesan$/);
  await rez.regenerateDraftImage(p.id, { wish: "   " });
  assert.ok(!/Special request/.test(google.at(-1).contents[0].parts[0].text), "leerer Wunsch = normales Bild");
});

test("Foto aus Slack (keine Video-Datei) → keine Vorlage, nur Text", async () => {
  writeFileSync(rez.DRAFT_FILE(), JSON.stringify(entwurf("Kochbuch-Nudeln", photo)));
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const parts = google.at(-1).contents[0].parts;
  assert.equal(parts.length, 1);
  assert.ok(parts[0].text && !/still frame/.test(parts[0].text));
  assert.equal(proposal("Kochbuch-Nudeln").image_reference, undefined);
});
