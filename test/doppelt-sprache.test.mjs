// Doppelte Rezepte (Hinweis + „Als Verbesserung für …“) und Sprachnachrichten/Video-Dateien (fetch-media)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, json } from "./helpers.mjs";

const { data } = setupEnv({ REZEPT_VORLAGE: "1", AGENT_DATA: "", GEMINI_API_KEY: "g", BILD_ANBIETER: "keiner" });
process.env.AGENT_DATA = join(data, "rezepte");
const step = { name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [] };
const tandoor = fakeTandoor([
  { id: 1, name: "Rahmwirsing", steps: [step], servings: 4, keywords: [{ name: "geprüft" }] },
  { id: 2, name: "Lasagne Bolognese", steps: [step], servings: 4, keywords: [] },
]);
const gemini = [];
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://generativelanguage.googleapis.com/", async (url, init) => (gemini.push(JSON.parse(init.body)), json({ candidates: [{ content: { parts: [{ text: "TITEL: Omas Kartoffelsalat\nZUTATEN:\n- 1 kg Kartoffeln\nGESPROCHEN: Also, man nimmt ein Kilo Kartoffeln …" }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 } }))],
]);
const job = join(data, "auftrag.json");
process.env.REZEPT_JOB = job;
const rez = await import(APP("lib/rezepte.mjs"));
const video = await import(APP("lib/video.mjs"));
const entwurf = (name) => ({ name, description: "x", servings: 2, keywords: ["Einfach"], steps: [{ instruction: "Kochen.", ingredients: [{ amount: 200, unit: "g", food: "Wirsing" }] }], changes: ["Aus Text übernommen"] });

test("Ähnliche Namen: gleich, ohne Satzzeichen/Klammern, oder ganz enthalten (ab 6 Zeichen)", () => {
  assert.equal(rez.similarName("Rahmwirsing", "rahmwirsing!"), true);
  assert.equal(rez.similarName("Rahmwirsing (Omas Rezept)", "Rahmwirsing"), true);
  assert.equal(rez.similarName("Lasagne", "Lasagne Bolognese"), true);
  assert.equal(rez.similarName("Reis", "Reis mit Gemüse"), false, "zu kurz für „enthalten“");
  assert.equal(rez.similarName("Linsensuppe", "Rahmwirsing"), false);
});

test("Neues Rezept, das es schon gibt: Hinweis und Knopf im Vorschlag", async () => {
  writeFileSync(job, JSON.stringify({ kind: "import", urls: [], images: [], text: "Rahmwirsing", ts: "1.0", channel: "C1", user: "U1" }));
  writeFileSync(rez.DRAFT_FILE(), JSON.stringify(entwurf("Rahmwirsing")));
  const r = await rez.propose();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p = rez.loadStore().proposals[r.proposal];
  assert.deepEqual(p.duplicates, [{ id: 1, name: "Rahmwirsing" }]);
  const msg = rez.proposalMessage(p, entwurf("Rahmwirsing"), { kind: "import" });
  assert.match(JSON.stringify(msg.blocks), /Gibt es vielleicht schon/);
  const btn = msg.blocks.find((b) => b.type === "actions").elements.find((b) => b.action_id === "rz_merge");
  assert.equal(btn.value, `${p.id}:1`);
  assert.match(btn.text.text, /Als Verbesserung für „Rahmwirsing“/);
});

test("„Als Verbesserung für …“: wird zum Verbesserungsvorschlag, Übernehmen ersetzt das vorhandene Rezept (mit Sicherung)", async () => {
  const p = Object.values(rez.loadStore().proposals).find((x) => x.duplicates);
  const draftId = p.draft_id;
  const r = await rez.proposalAsImprovement(p.id, 1);
  assert.equal(r.original, "Rahmwirsing");
  const q = rez.loadStore().proposals[p.id];
  assert.equal(q.kind, "quality");
  assert.equal(q.original_id, 1);
  assert.equal(q.duplicates, undefined);
  assert.ok(q.changes.at(-1).includes("Als Verbesserung für das vorhandene Rezept"));
  await assert.rejects(rez.proposalAsImprovement(p.id, 1), /nur bei neuen Rezepten/);
  await rez.applyProposal(p.id, "U1");
  assert.equal(tandoor.recipes.get(1).name, "Rahmwirsing");
  assert.equal(tandoor.recipes.get(1).servings, 2, "Inhalt aus dem Entwurf");
  assert.ok(!tandoor.recipes.has(draftId), "Entwurf gelöscht – kein zweites Rezept");
  assert.ok(readdirSync(join(data, "rezepte", "sicherungen")).some((f) => f.startsWith("1-")), "alte Fassung gesichert");
});

test("Ohne Doppelte: kein Hinweis, kein Knopf", async () => {
  writeFileSync(job, JSON.stringify({ kind: "import", urls: [], images: [], text: "x", ts: "2.0", channel: "C1", user: "U1" }));
  writeFileSync(rez.DRAFT_FILE(), JSON.stringify(entwurf("Linsensuppe")));
  const r = await rez.propose();
  const p = rez.loadStore().proposals[r.proposal];
  assert.equal(p.duplicates, undefined);
  const msg = rez.proposalMessage(p, entwurf("Linsensuppe"), { kind: "import" });
  assert.ok(!JSON.stringify(msg.blocks).includes("rz_merge"));
});

test("Sprachnachricht: Gemini bekommt die Aufnahme als Audio und schreibt das Rezept heraus", async () => {
  const inbox = join(data, "rezepte", "inbox");
  mkdirSync(inbox, { recursive: true });
  const voice = join(inbox, "3-0-a1.m4a");
  writeFileSync(voice, Buffer.from("AUDIO"));
  writeFileSync(job, JSON.stringify({ kind: "import", urls: [], images: [], media: [voice], text: "", ts: "3.0", channel: "C1", user: "U1" }));
  const r = await rez.fetchMedia();
  assert.equal(r.media.length, 1);
  assert.equal(r.media[0].ok, true);
  assert.equal(r.media[0].kind, "audio");
  assert.match(r.media[0].text, /Omas Kartoffelsalat/);
  const part = gemini.at(-1).contents[0].parts;
  assert.equal(part[0].inline_data.mime_type, "audio/mp4");
  assert.equal(part[0].inline_data.data, Buffer.from("AUDIO").toString("base64"));
  assert.match(part[1].text, /Sprachnachricht/);
});

test("fetch-media: nur Dateien aus dem Auftrag im Eingang; Dateitypen", async () => {
  writeFileSync(job, JSON.stringify({ kind: "import", urls: [], images: [], media: [join(data, "geheim.m4a")], text: "", ts: "4.0" }));
  await assert.rejects(rez.fetchMedia(), /keine Sprachnachricht/);
  assert.equal(video.mediaMime("x.mp3"), "audio/mpeg");
  assert.equal(video.mediaMime("x.mov"), "video/quicktime");
  assert.equal(video.isMediaFile("x.webm"), true);
  assert.equal(video.isMediaFile("x.jpg"), false);
  delete process.env.GEMINI_API_KEY;
  const r = await video.analyzeMedia(join(data, "rezepte", "inbox", "3-0-a1.m4a"), join(data, "rezepte", "inbox"));
  assert.equal(r.ok, false);
  assert.match(r.msg, /Google-API-Schlüssel/);
  process.env.GEMINI_API_KEY = "g";
});
