// Bausteine ohne Netz: Sprache, Rezeptstruktur, Bildprompt, Limit-Erkennung, Slack-Manifest
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, ROOT } from "./helpers.mjs";

setupEnv();
const i18n = await import(APP("lib/i18n.mjs"));
const tandoor = await import(APP("lib/tandoor.mjs"));
const bild = await import(APP("lib/bild.mjs"));
const runAgent = await import(APP("run-agent.mjs"));
const manifest = await import(APP("lib/manifest.mjs"));

const withLang = (l, fn) => {
  const old = process.env.SPRACHE;
  process.env.SPRACHE = l;
  try {
    return fn();
  } finally {
    process.env.SPRACHE = old ?? "";
  }
};

test("Sprache: L() und Befehlsnamen", () => {
  assert.equal(withLang("", () => i18n.L("Hallo", "Hello")), "Hallo");
  assert.equal(withLang("en", () => i18n.L("Hallo", "Hello")), "Hello");
  assert.equal(i18n.canonicalCommand("/stats"), "/statistik");
  assert.equal(i18n.canonicalCommand("/statistik"), "/statistik");
  assert.equal(withLang("en", () => i18n.cmd("/ohne-bild")), "/no-image");
  assert.equal(withLang("en", () => i18n.recipes(1)), "1 recipe");
  assert.equal(withLang("de", () => i18n.recipes(3)), "3 Rezepte");
});

test("Rezeptstruktur: Hausstil auf Deutsch und Englisch, Rückweg über simplify", () => {
  const d = { name: "Rahmwirsing", servings: 4, devices: ["Topf"], steps: [{ instruction: "Kochen.", time: 5, ingredients: [{ amount: 450, unit: "g", food: "Wirsing" }, { food: "Salz", no_amount: true, note: "nach Geschmack" }] }] };
  const de = withLang("de", () => tandoor.toTandoor(d, { name: tandoor.draftPrefix() + d.name, keywords: ["Einfach"], privateRecipe: true }));
  assert.equal(de.name, "⏳ Entwurf: Rahmwirsing");
  assert.deepEqual(de.steps.map((s) => s.name), ["Benötigte Küchengeräte", "Schritt 1"]);
  assert.equal(de.servings_text, "Portionen");
  assert.equal(de.steps[1].ingredients[1].no_amount, true);
  const en = withLang("en", () => tandoor.toTandoor(d, { name: tandoor.draftPrefix() + d.name, keywords: [], privateRecipe: true }));
  assert.equal(en.name, "⏳ Draft: Rahmwirsing");
  assert.deepEqual(en.steps.map((s) => s.name), ["Required equipment", "Step 1"]);
  // Entwürfe und Geräte-Schritt werden in beiden Sprachen erkannt
  assert.ok(tandoor.isDraft("⏳ Draft: X") && tandoor.isDraft("⏳ Entwurf: X") && !tandoor.isDraft("Lasagne"));
  const back = tandoor.simplify({ ...en, keywords: [], steps: en.steps.map((s) => ({ ...s, ingredients: s.ingredients.map((i) => ({ ...i, food: { name: i.food.name }, unit: i.unit })) })) });
  assert.deepEqual(back.devices, ["Topf"]);
  assert.equal(back.steps.length, 1);
  assert.equal(back.steps[0].ingredients[0].food, "Wirsing");
});

test("Bildprompt: einheitlicher Stil aus agents/bild-stil.md mit Platzhaltern", () => {
  const p = bild.imagePrompt({ name: "Rahmwirsing", image_prompt: "hellgrüner Wirsing in einer Schüssel", steps: [{ ingredients: [{ amount: 1, food: "Wirsing" }, { food: "Salz", no_amount: true }] }] });
  assert.match(p, /"Rahmwirsing"/);
  assert.match(p, /hellgrüner Wirsing/);
  assert.match(p, /made from: Wirsing\./);
  assert.doesNotMatch(p, /\{\{|<!--/);
  assert.equal(bild.styleId().length, 8);
});

test("Bildformat am Inhalt erkennen", () => {
  assert.equal(bild.imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47])).ext, "png");
  assert.equal(bild.imageType(Buffer.from([0xff, 0xd8, 0xff])).ext, "jpg");
});

test("Bilder für Sicherungen verkleinern: ohne ffmpeg, ausgeschaltet oder kein Gewinn → Original", async () => {
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5000, 7)]);
  const old = process.env.FFMPEG;
  process.env.FFMPEG = "/gibt/es/nicht/ffmpeg";
  try {
    assert.equal(await bild.compressImage(big), big, "ohne ffmpeg");
  } finally {
    if (old === undefined) delete process.env.FFMPEG;
    else process.env.FFMPEG = old;
  }
  process.env.SICHERUNG_BILDER_KOMPRIMIEREN = "aus";
  assert.equal(bild.backupCompression(), false);
  assert.equal(await bild.compressImage(big), big, "ausgeschaltet");
  delete process.env.SICHERUNG_BILDER_KOMPRIMIEREN;
  assert.equal(bild.backupCompression(), true, "Standard an");
});

test("Bilder für Sicherungen verkleinern mit ffmpeg: großes PNG → kleineres JPEG, höchstens 1600 px", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    return t.skip("ffmpeg nicht installiert (im Docker-Image vorhanden)");
  }
  const dir = mkdtempSync(join(tmpdir(), "bild-test-"));
  try {
    const src = join(dir, "gross.png");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=2400x1600", "-frames:v", "1", src]);
    const big = readFileSync(src);
    const small = await bild.compressImage(big);
    assert.equal(bild.imageType(small).ext, "jpg");
    assert.ok(small.length < big.length * 0.9, `${small.length} < ${big.length}`);
    // JPEG-Größe aus dem SOF0/SOF2-Block lesen
    let w = 0;
    for (let i = 2; i < small.length - 9; i++) if (small[i] === 0xff && (small[i + 1] === 0xc0 || small[i + 1] === 0xc2)) (w = small.readUInt16BE(i + 7)), (i = small.length);
    assert.equal(w, 1600);
    assert.ok((await bild.compressImage(big)).equals(small), "gleiche Eingabe → gleiche Datei (kein erneutes Hochladen)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude-Limit erkennen", () => {
  for (const s of ["Claude AI usage limit reached|1730000000", "You've hit your limit · resets 3pm (Europe/Berlin)", "API Error: 429 rate_limit_error", "Error: Overloaded"]) assert.ok(runAgent.isLimitError(s), s);
  for (const s of ["Error: tool failed", "", "propose: ok"]) assert.ok(!runAgent.isLimitError(s), s);
});

test("Slack-Manifest: YAML lesbar, alle Befehle der Brücke eingetragen", () => {
  const m = manifest.parseYaml(readFileSync(join(ROOT, "slack-app-manifest.yml"), "utf8"));
  const cmds = m.features.slash_commands.map((c) => c.command);
  for (const c of Object.keys(i18n.COMMAND_NAMES)) assert.ok(cmds.includes(c), `${c} fehlt im Manifest`);
  assert.ok(m.oauth_config.scopes.bot.includes("commands"));
  assert.equal(m.settings.socket_mode_enabled, true);
});
