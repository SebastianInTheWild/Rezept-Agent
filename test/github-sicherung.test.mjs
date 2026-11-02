// GitHub-Sicherung: Rezepte mit Bild sichern, nur Geändertes übertragen, Gelöschtes verschieben, wiederherstellen
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, fakeGitHub, png } from "./helpers.mjs";

const { data } = setupEnv({ BACKUP_REPO: "test/sicherung", BACKUP_TOKEN: "ghp_test", BACKUP_PAUSE_MS: "0" });
// Das nachgebaute GitHub vergibt Blob-Kennungen wie echtes Git – sonst ließe sich „unverändert“ nicht prüfen
globalThis.__blobSha = (buf) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
const step = { name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [{ food: { name: "Wirsing" }, unit: { name: "g" }, amount: 450, note: "", order: 0, is_header: false, no_amount: false }] };
const tandoor = fakeTandoor([
  { id: 1, name: "Flammkuchen", image: `${TANDOOR}/media/1.png?X-Amz-Signature=abc`, steps: [step], servings: 2, keywords: [{ name: "Einfach" }, { name: "geprüft" }] },
  { id: 2, name: "Rahmwirsing", steps: [step], servings: 4 },
  { id: 3, name: "Gulasch", steps: [step], servings: 4 },
  { id: 4, name: "Pfannkuchen", steps: [step], servings: 2 },
  { id: 50, name: "⏳ Entwurf: Wird nicht gesichert", steps: [step] },
]);
tandoor.images.set(1, png(10, 20, 30));
const github = fakeGitHub();
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://api.github.com/repos/test/sicherung", github.handle],
]);
mkdirSync(join(data, "rezepte", "sicherungen"), { recursive: true });
writeFileSync(join(data, "rezepte", "sicherungen", "1-bild-2026-10-30T08-00-00-000Z.png"), png(200, 1, 1));

const gs = await import(APP("lib/github-sicherung.mjs"));

test("Erster Lauf: leeres Repo anlegen, alle Rezepte mit Bild, Sicherungen spiegeln", async () => {
  const lines = [];
  const r = await gs.syncBackup({ log: (m) => lines.push(m), by: "von Hand" });
  // Log: Start, Umfang, Hochladen, Ergebnis mit Dauer
  assert.match(lines[0], /^\[sicherung\] Start \(von Hand\) → test\/sicherung$/);
  assert.ok(lines.includes("[sicherung] 4 Rezepte in Tandoor, 0 in der Sicherung"));
  assert.ok(lines.some((l) => /Dateien werden hochgeladen/.test(l)));
  assert.match(lines.at(-1), /^\[sicherung\] fertig nach \d+ s: \d+ Dateien in test\/sicherung .*Commit [0-9a-f]{7}$/);
  const files = github.files();
  assert.ok(files.has("README.md") && files.has("index.json"));
  for (const dir of ["1 - Flammkuchen", "2 - Rahmwirsing", "3 - Gulasch", "4 - Pfannkuchen"]) assert.ok(files.has(`rezepte/${dir}/rezept.json`), dir);
  assert.ok(![...files.keys()].some((p) => p.startsWith("rezepte/50")), "Entwürfe werden nicht gesichert");
  assert.ok(files.has("rezepte/1 - Flammkuchen/bild.png"));
  assert.ok(files.has("sicherungen/1-bild-2026-10-30T08-00-00-000Z.png"));
  // Signierte Bildadressen ohne Signatur, damit nicht jeden Tag eine Änderung entsteht
  assert.doesNotMatch(files.get("rezepte/1 - Flammkuchen/rezept.json").toString(), /X-Amz-Signature/);
  assert.equal(r.checked, 4);
  assert.equal(github.commitsMade.length, 1);
});

test("Zweiter Lauf ohne Änderungen: kein Commit, nichts hochgeladen", async () => {
  const before = github.blobPosts;
  const lines = [];
  const r = await gs.syncBackup({ log: (m) => lines.push(m) });
  assert.match(lines.at(-1), /keine Änderungen \(4 Rezepte unverändert\)/);
  assert.equal(r.files, 0);
  assert.equal(r.unchanged, 4);
  assert.equal(github.blobPosts, before);
  assert.equal(github.commitsMade.length, 1);
});

test("Geändertes Rezept: nur dieses wird neu übertragen", async () => {
  Object.assign(tandoor.recipes.get(2), { servings: 6, updated_at: "2026-11-02T10:00:00Z" });
  const r = await gs.syncBackup();
  assert.equal(r.checked, 1);
  assert.match(github.files().get("rezepte/2 - Rahmwirsing/rezept.json").toString(), /"servings": 6/);
});

test("Ordnername folgt dem Rezeptnamen; alte Ordner <id>/ werden umbenannt, ohne neu hochzuladen", async () => {
  assert.equal(gs.folderName(7, "Käse: Spätzle / \"Omas\" Art?"), "7 - Käse Spätzle Omas Art");
  assert.equal(gs.folderName(8, "  "), "8");
  Object.assign(tandoor.recipes.get(3), { name: "Rindergulasch", updated_at: "2026-11-02T11:00:00Z" });
  await gs.syncBackup();
  let files = github.files();
  assert.ok(files.has("rezepte/3 - Rindergulasch/rezept.json"));
  assert.ok(![...files.keys()].some((p) => p.startsWith("rezepte/3 - Gulasch/")), "alter Ordner weg");
  // Altes Format aus einer früheren Version: rezepte/4/ → rezepte/4 - Pfannkuchen/
  const sha = (b) => globalThis.__blobSha(b);
  const old = files.get("rezepte/4 - Pfannkuchen/rezept.json");
  const tree = [...github.trees.get(github.commits.get(github.ref).tree)].filter(([p]) => !p.startsWith("rezepte/4 - ")).concat([["rezepte/4/rezept.json", sha(old)]]);
  const t = "talt";
  github.trees.set(t, tree);
  github.commits.set("calt", { tree: t, parents: [github.ref], message: "alt" });
  github.ref = "calt";
  const blobs = github.blobPosts;
  const r = await gs.syncBackup();
  files = github.files();
  assert.ok(files.has("rezepte/4 - Pfannkuchen/rezept.json") && !files.has("rezepte/4/rezept.json"));
  assert.ok(github.blobPosts - blobs <= 1, "Rezept nur verschoben, höchstens die Übersicht neu hochgeladen");
  assert.equal(r.unchanged, 4);
});

test("Gelöschtes Rezept wandert nach geloescht/ und ist wiederherstellbar", async () => {
  tandoor.recipes.delete(1);
  const lines = [];
  const r = await gs.syncBackup({ log: (m) => lines.push(m) });
  assert.ok(lines.some((l) => l.includes("in Tandoor gelöscht: „Flammkuchen“ (#1)")));
  assert.deepEqual(r.deleted, [{ id: 1, name: "Flammkuchen" }]);
  const files = github.files();
  assert.ok(![...files.keys()].some((p) => p.startsWith("rezepte/1 - ")));
  assert.ok(files.has("geloescht/1 - Flammkuchen/rezept.json") && files.has("geloescht/1 - Flammkuchen/bild.png") && files.has("geloescht/1 - Flammkuchen/geloescht.json"));
  assert.deepEqual(JSON.parse(files.get("index.json")).deleted, [1]);

  const ov = await gs.repoOverview();
  assert.equal(ov.deleted[0].name, "Flammkuchen");
  assert.equal(ov.deleted[0].image, "geloescht/1 - Flammkuchen/bild.png");

  const back = await gs.restoreDeleted(1);
  const created = tandoor.recipes.get(back.id);
  assert.equal(created.name, "Flammkuchen");
  assert.equal(created.steps[0].ingredients[0].food.name, "Wirsing");
  assert.ok(created.keywords.some((k) => k.name === "Einfach"));
  assert.ok(tandoor.images.has(back.id), "Bild wieder hochgeladen");
  assert.ok(![...github.files().keys()].some((p) => p.startsWith("geloescht/1")), "aus geloescht/ entfernt");
});

test("Schutz: fehlt mehr als die Hälfte der Rezepte, wird nichts als gelöscht markiert", async () => {
  const saved = new Map(tandoor.recipes);
  for (const id of [...tandoor.recipes.keys()]) tandoor.recipes.delete(id);
  const lines = [];
  await assert.rejects(gs.syncBackup({ log: (m) => lines.push(m) }), /zur Sicherheit abgebrochen/);
  assert.match(lines.at(-1), /^\[sicherung\] fehlgeschlagen: .*zur Sicherheit abgebrochen/);
  assert.ok(github.files().has("rezepte/2 - Rahmwirsing/rezept.json"));
  assert.equal(gs.backupStatus().result, "fehler");
  for (const [k, v] of saved) tandoor.recipes.set(k, v);
});

test("Log: Zeitstempel immer TT.MM.JJJJ hh:mm:ss", async () => {
  const { stamp } = await import(APP("lib/protokoll.mjs"));
  assert.equal(stamp(new Date("2026-03-05T08:04:09Z")), "05.03.2026 09:04:09");
  assert.equal(stamp(new Date("2026-11-02T23:30:00Z")), "03.11.2026 00:30:00");
});

test("Zeitplan: Uhrzeit aus zeitplan.conf, „aus“ schaltet ab", () => {
  assert.equal(gs.backupPlan().time, "03:30");
  writeFileSync(process.env.SCHEDULE_FILE, "rezept-sicherung = Mo,Do 02:15\n");
  assert.deepEqual([gs.backupPlan().time, gs.backupPlan().days], ["02:15", ["Mo", "Do"]]);
  writeFileSync(process.env.SCHEDULE_FILE, "rezept-sicherung = aus\n");
  assert.equal(gs.backupPlan().off, true);
});
