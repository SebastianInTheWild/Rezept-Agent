// Weboberfläche: Seite, Zeitplan, Einstellungen (Geheimnisse gesperrt ohne Passwort), Sicherungen
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, png } from "./helpers.mjs";

const port = 20000 + (process.pid % 10000);
const { data, cleanup } = setupEnv({ WEB_PORT: String(port) });
const tandoor = fakeTandoor([
  { id: 1, name: "Flammkuchen", image: `${TANDOOR}/media/1.png`, keywords: [{ name: "ki-bild" }] },
  { id: 2, name: "Rahmwirsing", image: null },
]);
tandoor.images.set(1, png(10, 20, 30));
const bak = join(data, "rezepte", "sicherungen");
mkdirSync(bak, { recursive: true });
writeFileSync(join(bak, "1-bild-2026-10-30T08-00-00-000Z.png"), png(200, 80, 60));
writeFileSync(join(bak, "2-2026-10-28T10-00-00-000Z.json"), JSON.stringify({ id: 2 }));
writeFileSync(join(bak, "fremd.txt"), "x");
writeFileSync(join(data, "rezepte", "vorschlaege.json"), JSON.stringify({ proposals: {}, checked: {}, rejected: {}, ai_images: { 1: { provider: "google", image: "/media/1.png" } } }));

// Die Weboberfläche ruft sich nicht selbst über fetch auf; das nachgebaute Tandoor reicht. Lokale Aufrufe gehen ans echte Netz.
const realFetch = globalThis.fetch;
installFetch([[TANDOOR, tandoor.handle]]);
const local = (path, init) => realFetch(`http://127.0.0.1:${port}${path}`, init);
const post = (path, body) => local(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

await import(APP("lib/umgebung.mjs"));
const { startWeb } = await import(APP("lib/web.mjs"));
const server = startWeb();
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
after(() => (server.close(), cleanup()));

test("Seite und Zeitplan", async () => {
  const html = await (await local("/")).text();
  assert.match(html, /id="tab-bak"/);
  const plan = await (await local("/api/plan")).json();
  assert.ok(plan.items.some((i) => i.id === "rezept-qualitaet"));
  assert.ok(plan.items.some((i) => i.id === "rezept-statistik"));
  assert.equal(plan.version, "dev", "ohne Version aus dem Image");
  assert.match(html, /id="version"/, "Version in der Leiste");
});

test("Zeitplan: „Wie war's?“ und Wochenrückblick als eigene Einträge, Uhrzeit änderbar, Jetzt senden ohne Slack → Fehler", async () => {
  const plan = await (await local("/api/plan")).json();
  const cook = plan.items.find((i) => i.id === "koch-frage");
  const digest = plan.items.find((i) => i.id === "wochenrueckblick");
  assert.equal(cook.kind, "statistik");
  assert.deepEqual(cook.schedule, [], "in den Tests per KOCH_FRAGE=aus abgeschaltet");
  assert.equal(cook.source, "KOCH_FRAGE");
  assert.match(cook.confirm, /heute geplanten Gerichten/);
  assert.ok(digest);
  const put = await local("/api/plan/wochenrueckblick", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "slots", slots: ["So 18:45"] }) });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).items.find((i) => i.id === "wochenrueckblick").schedule, ["So 18:45"]);
  const two = await local("/api/plan/koch-frage", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "slots", slots: ["18:00", "20:00"] }) });
  assert.equal(two.status, 400, "nur eine Uhrzeit");
  const run = await post("/api/run/wochenrueckblick", {});
  assert.equal(run.status, 400);
  assert.match((await run.json()).error, /Slack ist nicht eingerichtet/);
});

test("Status: alle Dienste mit Zustand, nicht eingerichtete als solche", async () => {
  const s = await (await local("/api/status?neu")).json();
  const byKey = Object.fromEntries(s.items.map((x) => [x.key, x]));
  assert.equal(byKey.tandoor.ok, true, "nachgebautes Tandoor erreichbar");
  assert.equal(byKey.slack.configured, false);
  assert.equal(byKey.github.configured, false);
  assert.equal(s.warn_days, 14);
  const html = await (await local("/")).text();
  assert.match(html, /id="tab-status"/);
});

test("Einstellungen: Geheimnisse ohne WEB_PASSWORT gesperrt, normale Werte speicherbar", async () => {
  const locked = await local("/api/umgebung", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: { TANDOOR_TOKEN: "neu" } }) });
  assert.equal(locked.status, 403);
  const ok = await local("/api/umgebung", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: { BILD_PRO_TAG: "7" } }) });
  assert.equal(ok.status, 200);
  const field = (await ok.json()).fields.find((f) => f.key === "BILD_PRO_TAG");
  assert.equal(field.value, "7");
  assert.equal(field.pending, true, "gilt erst nach dem Neustart");
  // Formular-Angriffe von fremden Seiten: nur JSON
  assert.equal((await local("/api/umgebung", { method: "PUT", body: "values=x" })).status, 415);
});

test("Ohne Passwort: Schalter WEB_ZUGANGSDATEN_OHNE_PASSWORT gibt Zugangsdaten frei – aber nur aus Portainer, nicht über die Seite", async () => {
  const put = (values) => local("/api/umgebung", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
  // Über die Seite lässt sich der Schalter nicht setzen (sonst könnte jeder die Sperre aufheben)
  assert.equal((await put({ WEB_ZUGANGSDATEN_OHNE_PASSWORT: "an" })).status, 400);
  assert.equal((await (await local("/api/umgebung")).json()).secrets, false);
  process.env.WEB_ZUGANGSDATEN_OHNE_PASSWORT = "an";
  try {
    const state = await (await local("/api/umgebung")).json();
    assert.deepEqual([state.secrets, state.open], [true, true]);
    assert.equal((await put({ TANDOOR_TOKEN: "neuer-token-1234" })).status, 200);
    const field = (await (await local("/api/umgebung")).json()).fields.find((f) => f.key === "TANDOOR_TOKEN");
    assert.equal(field.shown, "••••1234", "Geheimnis nur gekürzt angezeigt");
  } finally {
    delete process.env.WEB_ZUGANGSDATEN_OHNE_PASSWORT;
  }
});

test("Sicherungen: Liste nach Rezept, Bilder und JSON getrennt", async () => {
  const list = await (await local("/api/sicherungen")).json();
  const flamm = list.items.find((g) => g.id === 1);
  assert.equal(flamm.name, "Flammkuchen");
  assert.equal(flamm.ai, true);
  assert.equal(flamm.images.length, 1);
  assert.equal(list.items.find((g) => g.id === 2).recipes.length, 1);
  const img = await local("/api/sicherungen/datei/1-bild-2026-10-30T08-00-00-000Z.png");
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await local("/api/sicherungen/aktuell/1")).status, 200);
});

test("Sicherungen: kein Zugriff auf andere Dateien", async () => {
  assert.equal((await local("/api/sicherungen/datei/fremd.txt")).status, 404);
  assert.equal((await local("/api/sicherungen/datei/..%2Fvorschlaege.json")).status, 404);
  assert.equal((await post("/api/sicherungen/loeschen", { file: "../vorschlaege.json" })).status, 400);
  assert.ok(existsSync(join(data, "rezepte", "vorschlaege.json")));
});

test("Sicherungen: wiederherstellen sichert erst das aktuelle Bild und entfernt ki-bild", async () => {
  const r = await post("/api/sicherungen/wiederherstellen", { file: "1-bild-2026-10-30T08-00-00-000Z.png" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.backup, /^1-bild-/);
  assert.equal(readdirSync(bak).filter((f) => f.startsWith("1-bild-")).length, 2);
  assert.ok(!tandoor.recipes.get(1).keywords.some((k) => k.name === "ki-bild"));
  assert.equal(j.items.find((g) => g.id === 1).ai, false);
  // JSON-Sicherungen lassen sich nur herunterladen
  assert.equal((await post("/api/sicherungen/wiederherstellen", { file: "2-2026-10-28T10-00-00-000Z.json" })).status, 400);
});

test("Sicherungen: löschen", async () => {
  const r = await post("/api/sicherungen/loeschen", { file: "2-2026-10-28T10-00-00-000Z.json" });
  assert.equal(r.status, 200);
  assert.ok(!existsSync(join(bak, "2-2026-10-28T10-00-00-000Z.json")));
});
