// Google Gemini als KI-Anbieter: als Ersatz am Claude-Limit oder als erste Wahl (KI_ANBIETER) – Import, Antwort ohne Rezept,
// Qualitätsprüfung, Wochenplan, Reihenfolge
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, json, png } from "./helpers.mjs";

const { data } = setupEnv({ REZEPT_VORLAGE: "1", GEMINI_API_KEY: "g", REZEPT_BATCH: "5", BILD_ANBIETER: "google" });
// Nachgebautes „claude“, das immer am Limit scheitert (ausführbares Skript – nur unter Linux, z. B. in GitHub Actions)
const bin = join(data, "fake-claude");
writeFileSync(bin, `#!/usr/bin/env node\nconsole.log("You've hit your limit · resets 3pm (Europe/Berlin)");\nprocess.exit(1);\n`);
chmodSync(bin, 0o755);
process.env.CLAUDE_BIN = bin;
const LINUX = { skip: process.platform === "win32" && "braucht ein ausführbares Skript (läuft in GitHub Actions unter Linux)" };
const agents = join(data, "agents");
const LIMIT = "Anweisungen des Agenten";
for (const [id, fallback] of [["rezepte", "rezepte"], ["rezept-qualitaet", "qualitaet"], ["wochenplan", "wochenplan"], ["ohne-ersatz", undefined]]) {
  mkdirSync(join(agents, id), { recursive: true });
  writeFileSync(join(agents, id, "agent.json"), JSON.stringify({ name: id, ...(fallback ? { fallback } : {}) }));
  writeFileSync(join(agents, id, "prompt.md"), LIMIT);
}
process.env.AGENTS_DIR = agents;

const step = { name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [] };
const tandoor = fakeTandoor([
  { id: 1, name: "Rahmwirsing", steps: [step], servings: 4, keywords: [{ name: "geprüft" }] },
  { id: 2, name: "Linsensuppe", steps: [step], servings: 4, keywords: [] },
]);
// Gemini: Textanfragen (Ersatz) aus einer Warteschlange, Bildanfragen liefern ein PNG
const answers = [];
const asked = [];
installFetch([
  [TANDOOR, tandoor.handle],
  [
    "https://generativelanguage.googleapis.com/",
    async (url, init) => {
      if (!url.includes("gemini-flash-latest")) return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png().toString("base64") } }] } }] });
      asked.push(JSON.parse(init.body));
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answers.shift()) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } });
    },
  ],
]);
const { runAgent, readStatus, pendingRetry, loadAgent } = await import(APP("run-agent.mjs"));
const { runFallback, providerOrder } = await import(APP("lib/ersatz.mjs"));
const log = () => {};
const rez = await import(APP("lib/rezepte.mjs"));

const draft = (extra = {}) => ({
  name: "Gnocchi-Pfanne",
  description: "Gnocchi mit Spinat.",
  servings: 2,
  working_time: 20,
  waiting_time: 0,
  keywords: ["Einfach"],
  devices: ["Pfanne"],
  image_prompt: "Gnocchi in der Pfanne",
  steps: [{ instruction: "Gnocchi anbraten.", time: 8, ingredients: [{ amount: 400, unit: "g", food: "Gnocchi" }] }],
  changes: ["Aus Text übernommen"],
  ...extra,
});
const jobFile = (name, job) => {
  const f = join(data, `${name}.json`);
  writeFileSync(f, JSON.stringify({ kind: "import", urls: [], images: [], channel: "C1", ts: "1.0", user: "U1", ...job }));
  return f;
};

test("Import: Gemini legt den Vorschlag an und korrigiert Prüffehler", async () => {
  process.env.REZEPT_JOB = jobFile("auftrag1", { text: "Gnocchi-Pfanne: 400 g Gnocchi anbraten, Spinat dazu." });
  const bad = draft();
  bad.steps[0].ingredients[0].unit = "Tasse"; // gibt es nicht → propose meldet einen Fehler
  answers.push({ action: "propose", draft: bad }, { action: "propose", draft: draft() });
  const r = await runFallback(loadAgent("rezepte"), { log });
  assert.equal(r.ok, true, r.note);
  const job = JSON.parse(readFileSync(process.env.REZEPT_JOB, "utf8"));
  assert.ok(job.result, "Vorschlag im Auftrag vermerkt");
  const p = rez.loadStore().proposals[job.result];
  assert.equal(p.kind, "import");
  assert.ok(p.changes.some((c) => /Google Gemini \(gemini-flash-latest\).*Claude-Limit/.test(c)), "Hinweis im Vorschlag");
  assert.equal(p.changes.filter((c) => /Google Gemini/.test(c)).length, 1, "Hinweis nur einmal");
  assert.equal(asked.length, 2, "eine Korrektur");
  assert.match(asked[1].contents.at(-1).parts[0].text, /Einheit „Tasse“ gibt es nicht/);
  const first = asked[0].contents[0].parts.map((x) => x.text || "").join("\n");
  assert.match(first, /keine Werkzeuge/);
  assert.match(first, /Anweisungen des Agenten/, "Anweisungen aus prompt.md");
  assert.match(first, /Gnocchi-Pfanne: 400 g Gnocchi/, "Auftrag in den Daten");
  assert.equal(asked[0].generationConfig.responseMimeType, "application/json");
  const usage = JSON.parse(readFileSync(join(data, "rezepte", "google-nutzung.json"), "utf8"));
  assert.equal(Object.values(usage.months)[0].texts, 2, "Kosten mitgezählt");
  // Schon erledigt (z. B. Claude war vor dem Limit fertig) → kein zweiter Vorschlag
  const n = asked.length;
  assert.equal((await runFallback(loadAgent("rezepte"), { log })).ok, true);
  assert.equal(asked.length, n);
});

test("Foto im Auftrag geht als Bild an Gemini", async () => {
  const photo = join(data, "rezepte", "inbox", "kochbuch.png");
  mkdirSync(join(data, "rezepte", "inbox"), { recursive: true });
  writeFileSync(photo, png(1, 2, 3));
  process.env.REZEPT_JOB = jobFile("auftrag-foto", { ts: "3.0", text: "", images: [photo] });
  answers.push({ action: "propose", draft: draft({ name: "Kochbuch-Gnocchi" }) });
  assert.equal((await runFallback(loadAgent("rezepte"), { log })).ok, true);
  const parts = asked.at(-1).contents[0].parts;
  assert.equal(parts.at(-1).inline_data.mime_type, "image/png");
  assert.match(parts[1].text, /attached_images/);
});

test("Kein Rezept im Auftrag: Gemini antwortet statt eines Entwurfs", async () => {
  process.env.REZEPT_JOB = jobFile("auftrag2", { ts: "2.0", text: "Wie wird das Wetter morgen?" });
  answers.push({ action: "reply", text: "Darin steht kein Rezept." });
  assert.equal((await runFallback(loadAgent("rezepte"), { log })).ok, true);
  const job = JSON.parse(readFileSync(process.env.REZEPT_JOB, "utf8"));
  assert.equal(job.replied, true);
  assert.ok(!job.result);
});

test("Qualitätsprüfung: Gemini schlägt Verbesserungen vor, je Rezept eine Anfrage", async () => {
  delete process.env.REZEPT_JOB;
  answers.push({ action: "propose", draft: draft({ original_id: 2, name: "Linsensuppe", changes: ["Schritte vereinfacht"] }) });
  const r = await runFallback(loadAgent("rezept-qualitaet"), { log });
  assert.equal(r.ok, true, r.note);
  const p = Object.values(rez.loadStore().proposals).find((x) => x.original_id === 2);
  assert.equal(p.kind, "quality");
  assert.match(asked.at(-1).contents[0].parts[1].text, /"name": "Linsensuppe"/);
  assert.equal((await runFallback(loadAgent("rezept-qualitaet"), { log })).note, "nichts zu tun", "offener Vorschlag → nicht noch einmal");
});

test("Wochenplan: Gemini wählt die Rezepte, Hinweis in der Zusammenfassung", async () => {
  delete process.env.REZEPT_JOB;
  answers.push({ action: "propose", draft: { days: [{ date: "2026-11-10", recipe_id: 2, note: "warm" }], summary: "Eine Suppe." } });
  const r = await runFallback(loadAgent("wochenplan"), { log, reason: "primary" });
  assert.equal(r.ok, true, r.note);
  const plan = Object.values(rez.loadStore().plans).at(-1);
  assert.equal(plan.days[0].name, "Linsensuppe");
  assert.match(plan.summary, /^Eine Suppe\. \(Erstellt mit Google Gemini \(gemini-flash-latest\)\)$/, "ohne Limit-Hinweis, wenn Gemini erste Wahl ist");
  const sent = asked.at(-1).contents[0].parts[1].text;
  assert.match(sent, /"dates"/);
  assert.match(sent, /"name": "Linsensuppe"/);
});

test("Reihenfolge KI_ANBIETER: Standard Claude → Gemini, ohne Google-Schlüssel nur Claude", () => {
  assert.deepEqual(providerOrder(), ["claude", "google"]);
  process.env.KI_ANBIETER = "google, claude";
  assert.deepEqual(providerOrder(), ["google", "claude"]);
  process.env.KI_ANBIETER = "google";
  assert.deepEqual(providerOrder(), ["google"]);
  process.env.KI_ANBIETER = "unsinn";
  assert.deepEqual(providerOrder(), ["claude", "google"]);
  delete process.env.GEMINI_API_KEY;
  process.env.KI_ANBIETER = "google";
  assert.deepEqual(providerOrder(), ["claude"], "Gemini ohne Schlüssel geht nicht");
  process.env.GEMINI_API_KEY = "g";
  delete process.env.KI_ANBIETER;
});

test("KI_ANBIETER=google: Claude startet gar nicht, Gemini legt den Vorschlag an (ohne Limit-Hinweis)", async () => {
  process.env.KI_ANBIETER = "google";
  process.env.CLAUDE_BIN = "/gibt/es/nicht/claude";
  process.env.REZEPT_JOB = jobFile("auftrag-google", { ts: "5.0", text: "Gnocchi-Pfanne: 400 g Gnocchi anbraten." });
  answers.push({ action: "propose", draft: draft({ name: "Gnocchi-Pfanne Google" }) });
  assert.equal(await runAgent("rezepte", { by: "slack" }), 0);
  const last = readStatus("rezepte", "last-run.json");
  assert.equal(last.provider, "google");
  assert.equal(last.result, "ok");
  const p = rez.loadStore().proposals[JSON.parse(readFileSync(process.env.REZEPT_JOB, "utf8")).result];
  assert.ok(p.changes.includes("Erstellt mit Google Gemini (gemini-flash-latest)"));
  // Gemini scheitert und Claude ist nicht vorgesehen → Fehler, kein Limit
  process.env.REZEPT_JOB = jobFile("auftrag-google-2", { ts: "6.0", text: "Gnocchi-Pfanne: 400 g Gnocchi anbraten." });
  const bad = draft();
  bad.steps[0].ingredients[0].unit = "Tasse";
  answers.push({ action: "propose", draft: bad }, { action: "propose", draft: bad }, { action: "propose", draft: bad });
  assert.equal(await runAgent("rezepte", { by: "slack" }), 1);
  const failed = readStatus("rezepte", "last-run.json");
  assert.equal(failed.result, "fehler");
  assert.ok(!failed.limit);
  process.env.CLAUDE_BIN = bin;
  delete process.env.KI_ANBIETER;
});

test("Lauf am Claude-Limit: Gemini springt ein, Ergebnis ok, keine Wiederholung; nur Claude wie bisher", LINUX, async () => {
  process.env.REZEPT_JOB = jobFile("auftrag3", { ts: "4.0", text: "Gnocchi-Pfanne: 400 g Gnocchi anbraten." });
  answers.push({ action: "propose", draft: draft({ name: "Gnocchi-Pfanne 2" }) });
  assert.equal(await runAgent("rezepte", { by: "slack" }), 0);
  const last = readStatus("rezepte", "last-run.json");
  assert.equal(last.result, "ok");
  assert.equal(last.provider, "google");
  assert.ok(!last.limit);
  assert.ok(JSON.parse(readFileSync(process.env.REZEPT_JOB, "utf8")).result);

  delete process.env.REZEPT_JOB;
  const before = asked.length;
  process.env.KI_ANBIETER = "claude";
  assert.equal(await runAgent("rezept-qualitaet", { by: "zeitplan" }), 1);
  assert.equal(readStatus("rezept-qualitaet", "last-run.json").limit, true);
  assert.ok(pendingRetry("rezept-qualitaet"), "später erneut mit Claude");
  delete process.env.KI_ANBIETER;
  assert.equal(await runAgent("ohne-ersatz", { by: "slack" }), 1, "Agent ohne fallback");
  assert.equal(asked.length, before, "Gemini nicht gefragt");
});

test("google,claude: Gemini scheitert → Claude übernimmt (hier am Limit → später erneut)", LINUX, async () => {
  process.env.KI_ANBIETER = "google,claude";
  process.env.REZEPT_JOB = jobFile("auftrag4", { ts: "7.0", text: "Gnocchi-Pfanne: 400 g Gnocchi anbraten." });
  const bad = draft();
  bad.steps[0].ingredients[0].unit = "Tasse";
  answers.push({ action: "propose", draft: bad }, { action: "propose", draft: bad }, { action: "propose", draft: bad });
  assert.equal(await runAgent("rezepte", { by: "slack" }), 1);
  const last = readStatus("rezepte", "last-run.json");
  assert.equal(last.limit, true, "Claude lief nach Gemini und scheiterte am Limit");
  delete process.env.KI_ANBIETER;
});