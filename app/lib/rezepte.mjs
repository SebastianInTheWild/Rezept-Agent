// Rezept-Vorschläge: Entwurf in Tandoor anlegen, in Slack zeigen, nach Bestätigung übernehmen oder verwerfen.
// Gemeinsam genutzt vom Werkzeug tandoor.mjs (Agenten) und der Slack-Brücke (Knöpfe).
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { all, api, base, getRecipe, uploadImage, simplify, toTandoor, ingText, recipeUrl, KW, STATUS_KW, DRAFT_PREFIX, SERVINGS_TEXT } from "./tandoor.mjs";
import { generateImage, imageReady, imageSetupHint, imageType, lastImageNote } from "./bild.mjs";
import { post, slackReady, link, esc } from "./slack.mjs";
import { analyzeVideo, isVideoUrl } from "./video.mjs";
import { fetchHelloFresh, isHelloFresh } from "./hellofresh.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || "/data";
export const REZEPTE = join(DATA_DIR, "rezepte"); // gemeinsamer Ordner (= Datenordner des Agenten „rezepte“)
const STORE = join(REZEPTE, "vorschlaege.json");
const AGENT_DATA = () => process.env.AGENT_DATA || REZEPTE;
export const DRAFT_FILE = () => join(AGENT_DATA(), "entwurf.json");
const STANDARD = () => join(process.env.AGENTS_DIR || join(APP, "..", "agents"), "rezept-standard.md");
const REFERENCE = Number(process.env.REZEPT_VORLAGE || 149567); // Rahmwirsing
const SETTINGS = join(REZEPTE, "einstellungen.json");
const DRY = process.env.DRY === "1";
export const CHANNEL = () => process.env.SLACK_CHANNEL || "";

export function loadStore() {
  return existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { proposals: {}, checked: {}, rejected: {} };
}
export function saveStore(s) {
  mkdirSync(REZEPTE, { recursive: true });
  writeFileSync(STORE, JSON.stringify(s, null, 1));
}
export const loadJob = () => (process.env.REZEPT_JOB && existsSync(process.env.REZEPT_JOB) ? JSON.parse(readFileSync(process.env.REZEPT_JOB, "utf8")) : null);
export const saveJob = (job) => process.env.REZEPT_JOB && writeFileSync(process.env.REZEPT_JOB, JSON.stringify(job, null, 1));
const stripDraft = (n) => n.replace(DRAFT_PREFIX, "").trim();
const kwNames = (r) => (r.keywords || []).map((k) => k.name ?? k.label);
const uniq = (a) => [...new Set(a)];

// ---------- Einstellungen (Weboberfläche) ----------

export const PER_DAY_MAX = 50;
const readSettings = () => {
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    return {};
  }
};
/** Wie viele Rezepte der Qualitäts-Agent pro Tag prüft: einstellungen.json (Weboberfläche) > REZEPT_BATCH > 5. */
export function perDay() {
  const raw = readSettings().pro_tag;
  const fromFile = raw == null || raw === "" ? NaN : Number(raw);
  if (Number.isInteger(fromFile) && fromFile >= 0) return { value: fromFile, source: "Weboberfläche" };
  const env = (process.env.REZEPT_BATCH || "").trim() ? Number(process.env.REZEPT_BATCH) : NaN;
  return Number.isInteger(env) && env >= 0 ? { value: env, source: "REZEPT_BATCH" } : { value: 5, source: "Standard" };
}
export function setPerDay(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > PER_DAY_MAX) throw new Error(`Bitte eine ganze Zahl von 0 bis ${PER_DAY_MAX}`);
  mkdirSync(REZEPTE, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify({ ...readSettings(), pro_tag: n }, null, 1));
}
// Zusätzliche Rezepte nur für heute (Slack „/pruefen <Anzahl>“): { extra: { tag: "2026-10-27", anzahl: 3 } }
const extraToday = () => {
  const e = readSettings().extra;
  return e && e.tag === today() ? Number(e.anzahl) || 0 : 0;
};
/** Erlaubt heute n Rezepte zusätzlich zum Tageswert. */
export function addToday(n) {
  if (!Number.isInteger(n) || n < 1 || n > PER_DAY_MAX) throw new Error(`Bitte eine ganze Zahl von 1 bis ${PER_DAY_MAX}`);
  const anzahl = Math.min(PER_DAY_MAX, extraToday() + n);
  mkdirSync(REZEPTE, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify({ ...readSettings(), extra: { tag: today(), anzahl } }, null, 1));
}
// Höchstens so viele Qualitäts-Vorschläge gleichzeitig offen in Slack (Standard: zwei Tagesportionen)
const maxOpen = () => Number(process.env.REZEPT_MAX_OFFEN) || Math.max(1, 2 * (perDay().value + extraToday()));

const today = (now = new Date()) => now.toLocaleDateString("sv-SE", { timeZone: process.env.TZ || "Europe/Berlin" });
const sameDay = (iso, now) => Boolean(iso) && today(new Date(iso)) === today(now);
const proposedToday = (store, now) => Object.values(store.proposals).filter((p) => p.kind === "quality" && sameDay(p.created, now)).length;

// ---------- Lesen ----------

export async function context() {
  const [units, keywords, foods, recipes] = await Promise.all([all("/api/unit/"), all("/api/keyword/"), all("/api/food/"), all("/api/recipe/")]);
  const count = {};
  recipes.forEach((r) => kwNames(r).forEach((k) => (count[k] = (count[k] || 0) + 1)));
  return {
    standard: existsSync(STANDARD()) ? readFileSync(STANDARD(), "utf8") : "",
    units: units.map((u) => u.name).sort((a, b) => a.localeCompare(b, "de")),
    keywords: keywords
      .filter((k) => !STATUS_KW.includes(k.name))
      .map((k) => ({ name: k.name, recipes: count[k.name] || 0 }))
      .sort((a, b) => b.recipes - a.recipes),
    foods: foods.map((f) => f.name).sort((a, b) => a.localeCompare(b, "de")),
    reference: simplify(await getRecipe(REFERENCE)),
  };
}

// Rezepte, die der Qualitäts-Agent prüfen soll: ohne Status-Schlagwort, oder geprüft und danach geändert
export async function pending() {
  const store = loadStore();
  const open = Object.values(store.proposals).filter((p) => p.status === "open");
  const busy = new Set(open.map((p) => p.original_id).filter(Boolean));
  // Tageslimit gilt über alle Läufe eines Tages (Zeitplan und „Jetzt starten“ zusammen)
  const leftToday = Math.max(0, perDay().value + extraToday() - proposedToday(store));
  const openQuality = open.filter((p) => p.kind === "quality").length;
  const free = Math.max(0, maxOpen() - openQuality);
  const later = (a, b) => b && Date.parse(a) - Date.parse(b) > 120_000;
  const list = (await all("/api/recipe/"))
    .filter((r) => !r.name.startsWith(DRAFT_PREFIX) && !busy.has(r.id))
    .filter((r) => {
      const k = kwNames(r);
      if (k.includes(KW.skip) || k.includes(KW.open)) return false;
      if (store.rejected[r.id] && !later(r.updated_at, store.rejected[r.id])) return false;
      if (k.includes(KW.checked)) return later(r.updated_at, store.checked[r.id]);
      return true;
    })
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return { total: list.length, open_proposals: open.length, open_quality: openQuality, left_today: leftToday, free, batch: list.slice(0, Math.min(leftToday, free)) };
}

// Statistik über alle Rezepte (ohne Entwürfe) nach Status-Schlagwort, dazu was heute entschieden wurde
export async function stats(now = new Date()) {
  const store = loadStore();
  const recipes = (await all("/api/recipe/")).filter((r) => !r.name.startsWith(DRAFT_PREFIX));
  const has = (r, kw) => kwNames(r).includes(kw);
  const checked = recipes.filter((r) => has(r, KW.checked)).length;
  const open = recipes.filter((r) => has(r, KW.open)).length;
  const skipped = recipes.filter((r) => has(r, KW.skip)).length;
  const todo = recipes.length - checked - open - skipped;
  const batch = perDay().value;
  return {
    total: recipes.length,
    checked,
    open,
    skipped,
    todo,
    no_image: recipes.filter((r) => !r.image).length,
    batch,
    days_left: batch > 0 ? Math.ceil(todo / batch) : null,
    today: {
      proposed: proposedToday(store, now),
      applied: Object.values(store.proposals).filter((p) => p.status === "applied" && sameDay(p.decided, now)).length,
      rejected: Object.values(store.proposals).filter((p) => ["rejected", "skipped"].includes(p.status) && sameDay(p.decided, now)).length,
    },
  };
}

export function statsMessage(s, date = new Date()) {
  const pct = (n) => (s.total ? Math.round((100 * n) / s.total) : 0);
  const when = date.toLocaleDateString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit" });
  const lines = [
    `📊 *Rezept-Statistik* · ${when}`,
    `• Rezepte insgesamt: *${s.total}*`,
    `• ✅ geprüft: *${s.checked}* (${pct(s.checked)} %)`,
    `• ⏳ Vorschlag wartet auf dich: *${s.open}*`,
    `• 🚫 nicht bearbeiten: ${s.skipped}`,
    `• 📝 noch zu prüfen: *${s.todo}*` + (s.todo && s.days_left ? ` – bei ${s.batch} pro Tag noch etwa ${s.days_left} ${s.days_left === 1 ? "Tag" : "Tage"}` : s.todo && !s.batch ? " – tägliche Prüfung ist auf 0 gestellt" : ""),
  ];
  if (s.no_image !== undefined) lines.push(`• 🖼️ ohne Bild: *${s.no_image}*` + (s.no_image ? " – `/ohne-bild` zeigt sie mit Knopf für ein KI-Foto" : ""));
  const t = s.today;
  if (t.proposed || t.applied || t.rejected) lines.push(`• Heute: ${t.proposed} neu vorgeschlagen · ${t.applied} übernommen · ${t.rejected} verworfen`);
  if (!s.todo && !s.open) lines.push("🎉 Alle Rezepte sind geprüft.");
  return lines.join("\n");
}

// Für Slack „/offen“: Vorschläge, die auf eine Entscheidung warten (älteste zuerst)
export const openProposals = () =>
  Object.values(loadStore().proposals)
    .filter((p) => p.status === "open")
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

// Für Slack „/rezept <Name>“: Treffer mit Status aus den Schlagwörtern
export async function findRecipes(q) {
  const j = await api("GET", `/api/recipe/?query=${encodeURIComponent(q)}&page_size=10`);
  const open = new Map(openProposals().filter((p) => p.original_id).map((p) => [p.original_id, p]));
  return j.results
    .filter((r) => !r.name.startsWith(DRAFT_PREFIX))
    .map((r) => {
      const k = kwNames(r);
      const status = k.includes(KW.checked) ? "geprüft" : k.includes(KW.skip) ? "nicht bearbeiten" : k.includes(KW.open) || open.has(r.id) ? "Vorschlag offen" : "noch nicht geprüft";
      return { id: r.id, name: r.name, url: recipeUrl(r.id), status, proposal: open.get(r.id) || null };
    });
}

// ---------- Rezepte ohne Bild (Slack „/ohne-bild“) ----------

// Gepostete Nachrichten je Rezept: store.no_image[id] = { channel, ts, posted, generated }
const NO_IMAGE_REPEAT = 7 * 86_400_000; // gleiches Rezept frühestens nach 7 Tagen wieder von selbst zeigen

/** Rezepte ohne Bild (ohne Entwürfe), optional nach Name gefiltert. Mit Suchbegriff auch schon gezeigte. */
export async function recipesWithoutImage(q = "") {
  const posted = loadStore().no_image || {};
  const term = q.trim().toLowerCase();
  const list = (await all("/api/recipe/"))
    .filter((r) => !r.name.startsWith(DRAFT_PREFIX) && !r.image && !kwNames(r).includes(KW.open))
    .filter((r) => !term || r.name.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .map((r) => ({ id: r.id, name: r.name, url: recipeUrl(r.id), posted: posted[r.id]?.posted || null }));
  const fresh = term ? list : list.filter((r) => !r.posted || Date.now() - Date.parse(r.posted) > NO_IMAGE_REPEAT);
  return { total: list.length, shown_recently: list.length - fresh.length, list: fresh };
}

const imageButton = (id, again) => ({
  type: "actions",
  block_id: `rzimg:${id}`,
  elements: [{ type: "button", ...(again ? {} : { style: "primary" }), text: { type: "plain_text", text: again ? "🔄 Anderes Bild erzeugen" : "🎨 Bild erzeugen" }, action_id: "rz_image", value: String(id) }],
});

/** Slack-Nachricht für ein Rezept ohne Bild (bzw. nach dem Erzeugen mit Knopf für ein anderes). */
export function noImageMessage(r, status) {
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: `🖼️ *${status ? "Bild erzeugt" : "Ohne Bild"}:* ${link(r.url, r.name)}` } }];
  if (status) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: status }] });
  blocks.push(imageButton(r.id, Boolean(status)));
  return { text: `${status ? "Bild erzeugt" : "Rezept ohne Bild"}: ${r.name}`, blocks };
}

/** Postet je Rezept eine eigene Nachricht in den Kanal und merkt sie sich. */
export async function postWithoutImage(recipes, channel = CHANNEL()) {
  const store = loadStore();
  store.no_image ||= {};
  for (const r of recipes) {
    const m = noImageMessage(r);
    const res = await post(channel, m.text, m.blocks);
    store.no_image[r.id] = { ...store.no_image[r.id], channel, ts: res.ts, posted: new Date().toISOString() };
  }
  saveStore(store);
}

// Altes Bild vor dem Ersetzen sichern (daten/rezepte/sicherungen, wird nach 180 Tagen aufgeräumt)
async function backupImage(r) {
  const url = /^https?:/.test(r.image) ? r.image : base() + r.image;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TANDOOR_TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("leer");
  mkdirSync(join(REZEPTE, "sicherungen"), { recursive: true });
  const file = join(REZEPTE, "sicherungen", `${r.id}-bild-${new Date().toISOString().replace(/[:.]/g, "-")}.${imageType(buf).ext}`);
  writeFileSync(file, buf);
  return file;
}

/**
 * KI-Foto für ein bestehendes Rezept erzeugen und in Tandoor hochladen.
 * Ohne replace wird ein eigenes Foto nie ersetzt. Mit replace (/bild-neu, /bild-alle) nur mit Google und erst,
 * nachdem das alte Bild gesichert ist – klappt die Sicherung nicht, bleibt das alte Bild.
 */
export async function generateRecipeImage(id, { replace = false } = {}) {
  if (!replace && !imageReady()) throw new Error(`Kein Bild-Anbieter eingerichtet – ${imageSetupHint}`);
  const r = await getRecipe(id);
  if (r.name.startsWith(DRAFT_PREFIX)) throw new Error("Das ist ein Entwurf – das Bild kommt mit dem Vorschlag");
  const entry = loadStore().no_image?.[id];
  if (r.image && !entry?.generated && !replace) throw new Error("Das Rezept hat inzwischen ein eigenes Bild – das ersetze ich nicht");
  let backup = null;
  if (r.image && replace && !DRY)
    backup = await backupImage(r).catch((e) => {
      throw new Error(`Altes Bild ließ sich nicht sichern (${e.message}) – es bleibt unverändert`);
    });
  const jpg = await generateImage(simplify(r), REZEPTE, replace ? { only: "google", noLimit: true } : {});
  if (DRY) return { ok: true, dry: true, name: r.name, url: recipeUrl(r.id) };
  await uploadImage(r.id, jpg, String(r.id));
  // Der Upload ändert updated_at – geprüfte bzw. abgelehnte Rezepte sollen deshalb nicht erneut in die Prüfung
  const store = loadStore();
  const after = await getRecipe(r.id);
  if (store.checked[r.id]) store.checked[r.id] = after.updated_at;
  if (store.rejected[r.id]) store.rejected[r.id] = after.updated_at;
  store.no_image ||= {};
  store.no_image[r.id] = { ...store.no_image[r.id], generated: new Date().toISOString() };
  saveStore(store);
  return { ok: true, id: r.id, name: r.name, url: recipeUrl(r.id), info: await lastImageNote(), backup };
}

/** Alle Rezepte (ohne Entwürfe) für /bild-alle, nach Name sortiert. */
export const allRecipeIds = async () =>
  (await all("/api/recipe/"))
    .filter((r) => !r.name.startsWith(DRAFT_PREFIX))
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .map((r) => ({ id: r.id, name: r.name }));

/** Für /bild-neu: Rezept per ID, exaktem Namen oder eindeutigem Suchtreffer. */
export async function resolveRecipe(q) {
  q = q.trim();
  if (/^\d+$/.test(q)) {
    const r = await getRecipe(Number(q)).catch(() => null);
    return r && !r.name.startsWith(DRAFT_PREFIX) ? { hit: { id: r.id, name: r.name, url: recipeUrl(r.id) }, hits: [] } : { hit: null, hits: [] };
  }
  const hits = (await search(q)).filter((r) => !r.name.startsWith(DRAFT_PREFIX));
  const exact = hits.filter((r) => r.name.toLowerCase() === q.toLowerCase());
  return { hit: exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null, hits };
}

export async function search(q) {
  const j = await api("GET", `/api/recipe/?query=${encodeURIComponent(q)}&page_size=10`);
  return j.results.map((r) => ({ id: r.id, name: r.name, url: recipeUrl(r.id) }));
}

// Link über Tandoors eigenen Import auslesen (nur Links aus dem aktuellen Auftrag bzw. aus der Beschreibung eines Videos daraus)
export async function fetchUrl(url) {
  const job = loadJob();
  const allowed = [...(job?.urls || []), ...(job?.extra_urls || [])];
  if (!url) url = allowed[0];
  if (!url || !allowed.includes(url)) throw new Error(`Nur Links aus dem Auftrag sind erlaubt: ${allowed.join(", ") || "keine"}`);
  // HelloFresh kann Tandoors Import nicht lesen – eigener Leser
  if (isHelloFresh(url)) return fetchHelloFresh(url, join(REZEPTE, "inbox"));
  const r = await api("POST", "/api/recipe-from-source/", { url });
  if (r.error) return { ok: false, msg: r.msg };
  const rec = r.recipe || {};
  return {
    ok: true,
    duplicates: (r.duplicates || []).map((d) => ({ id: d.id, name: d.name })),
    images: (r.images || []).slice(0, 5),
    recipe: {
      name: rec.name,
      description: rec.description,
      servings: rec.servings,
      servings_text: rec.servings_text,
      working_time: rec.working_time,
      waiting_time: rec.waiting_time,
      source_url: rec.source_url || url,
      image_url: rec.image_url,
      keywords: (rec.keywords || []).map((k) => k.label || k.name),
      steps: (rec.steps || []).map((s) => ({
        instruction: s.instruction,
        ingredients: (s.ingredients || []).map((i) => ({ amount: i.amount, unit: i.unit?.name || null, food: i.food?.name || "", note: i.note || "", original_text: i.original_text || "" })),
      })),
    },
  };
}

// Video (Reel, Short) aus dem Auftrag auswerten: Beschreibung, Text aus dem Video (Gemini), Standbilder.
// Links aus der Beschreibung (z. B. zum Blog mit dem ganzen Rezept) darf der Agent danach mit fetch-url lesen.
export async function fetchVideo(url) {
  const job = loadJob();
  const allowed = (job?.urls || []).filter(isVideoUrl);
  if (!url) url = allowed[0];
  if (!url || !allowed.includes(url)) throw new Error(`Nur Video-Links aus dem Auftrag sind erlaubt: ${allowed.join(", ") || "keine"}`);
  const r = await analyzeVideo(url, join(REZEPTE, "inbox"));
  if (job && r.links?.length) saveJob({ ...job, extra_urls: [...new Set([...(job.extra_urls || []), ...r.links])] });
  return r;
}

// ---------- Prüfen ----------

export function validate(d, ctx) {
  const errors = [];
  const warnings = [];
  if (!d || typeof d !== "object") return { errors: ["entwurf.json ist leer oder kein JSON-Objekt"], warnings };
  if (!d.name?.trim()) errors.push("name fehlt");
  if (!Number.isFinite(Number(d.servings)) || Number(d.servings) < 1) errors.push("servings muss eine Zahl ≥ 1 sein");
  for (const f of ["working_time", "waiting_time"]) if (d[f] !== undefined && !(Number(d[f]) >= 0)) errors.push(`${f} muss Minuten ≥ 0 sein`);
  if (!Array.isArray(d.steps) || !d.steps.length) errors.push("steps fehlt");
  if (d.devices !== undefined && !Array.isArray(d.devices)) errors.push("devices muss eine Liste sein");
  if (!Array.isArray(d.keywords)) errors.push("keywords muss eine Liste sein");
  if (!Array.isArray(d.changes) || !d.changes.length) errors.push("changes fehlt (kurze Liste, was du gemacht hast)");
  const units = new Set(ctx.units);
  const foods = new Set(ctx.foods.map((f) => f.toLowerCase()));
  const newFoods = [];
  (d.steps || []).forEach((s, n) => {
    if (!s.instruction?.trim()) errors.push(`Schritt ${n + 1}: instruction fehlt`);
    if (s.time !== undefined && !(Number(s.time) >= 0)) errors.push(`Schritt ${n + 1}: time muss Minuten ≥ 0 sein`);
    (s.ingredients || []).forEach((i) => {
      if (!i.food?.trim()) return errors.push(`Schritt ${n + 1}: Zutat ohne food`);
      if (i.unit && !units.has(i.unit)) errors.push(`Schritt ${n + 1}: Einheit „${i.unit}“ gibt es nicht (erlaubt: ${ctx.units.join(", ")})`);
      const noAmount = i.no_amount || i.amount === null || i.amount === undefined;
      if (!noAmount && !(Number(i.amount) > 0)) errors.push(`Schritt ${n + 1}: ${i.food}: amount muss > 0 sein oder no_amount: true`);
      if (noAmount && i.unit) errors.push(`Schritt ${n + 1}: ${i.food}: Einheit ohne Menge`);
      if (!foods.has(i.food.trim().toLowerCase())) newFoods.push(i.food.trim());
    });
  });
  const known = new Set(ctx.keywords.map((k) => k.name));
  const newKw = (d.keywords || []).filter((k) => !known.has(k) && !STATUS_KW.includes(k));
  if (newKw.length > 2) errors.push(`Höchstens 2 neue Schlagwörter, du hast: ${newKw.join(", ")}`);
  if (uniq(newFoods).length) warnings.push(`Neue Lebensmittel: ${uniq(newFoods).join(", ")}`);
  if (newKw.length) warnings.push(`Neue Schlagwörter: ${newKw.join(", ")}`);
  return { errors, warnings };
}

// Zutaten vorher/nachher (vom Werkzeug berechnet, damit niemand sich auf die Zusammenfassung verlassen muss)
export function diff(before, after) {
  const flat = (r) => r.steps.flatMap((s) => s.ingredients.filter((i) => !i.header));
  const a = flat(before);
  const b = flat(after);
  const key = (i) => i.food.toLowerCase();
  const lines = [];
  const left = [...b];
  for (const i of a) {
    const k = left.findIndex((j) => key(j) === key(i));
    if (k < 0) {
      lines.push(`➖ ${ingText(i)}`);
      continue;
    }
    const j = left.splice(k, 1)[0];
    if (ingText(i) !== ingText(j)) lines.push(`✏️ ${ingText(i)} → ${ingText(j)}`);
  }
  left.forEach((j) => lines.push(`➕ ${ingText(j)}`));
  const removed = lines.filter((l) => l.startsWith("➖")).length;
  return { lines, removed, steps: `${before.steps.length} → ${after.steps.length}` };
}

// ---------- Vorschlag anlegen ----------

export async function propose() {
  const job = loadJob();
  const path = DRAFT_FILE();
  if (!existsSync(path)) throw new Error(`${path} fehlt`);
  let d;
  try {
    d = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`entwurf.json ist kein gültiges JSON: ${e.message}`] };
  }
  const ctx = await context();
  const { errors, warnings } = validate(d, ctx);
  if (errors.length) return { ok: false, errors };

  const store = loadStore();
  const kind = job?.kind === "revise" ? "revise" : d.original_id ? "quality" : "import";
  const keywords = uniq([...d.keywords.filter((k) => !STATUS_KW.includes(k)), KW.open]);
  const payload = toTandoor(d, { name: DRAFT_PREFIX + d.name.trim(), keywords, privateRecipe: true });
  let p;
  let before = null;

  if (kind === "revise") {
    p = store.proposals[job.proposal];
    if (!p || p.status !== "open") return { ok: false, errors: ["Der Vorschlag ist nicht mehr offen"] };
    before = simplify(await getRecipe(p.draft_id));
    if (DRY) return { ok: true, dry: true, payload, warnings, diff: diff(before, d) };
    await api("PATCH", `/api/recipe/${p.draft_id}/`, payload);
  } else {
    let orig = null;
    if (kind === "quality") {
      orig = await getRecipe(d.original_id);
      if (orig.name.startsWith(DRAFT_PREFIX)) return { ok: false, errors: ["original_id ist selbst ein Entwurf"] };
      if (Object.values(store.proposals).some((x) => x.status === "open" && x.original_id === orig.id)) return { ok: false, errors: ["Für dieses Rezept gibt es schon einen offenen Vorschlag"] };
      before = simplify(orig);
    } else {
      const dup = (await search(d.name.trim())).filter((r) => r.name.toLowerCase() === d.name.trim().toLowerCase());
      if (dup.length) warnings.push(`Gibt es schon: ${dup.map((r) => r.name).join(", ")}`);
    }
    if (DRY) return { ok: true, dry: true, kind, payload, warnings, diff: before && diff(before, d) };
    const draft = await api("POST", "/api/recipe/", payload);
    const id = `p${Date.now().toString(36)}`;
    p = store.proposals[id] = { id, kind, draft_id: draft.id, original_id: kind === "quality" ? d.original_id : null, name: d.name.trim(), status: "open", created: new Date().toISOString(), by: job?.user || "agent" };
    // Bild: einheitlicher KI-Stil (BILD_EINHEITLICH, Standard an) – neue Rezepte bekommen immer ein KI-Foto,
    // Verbesserungsvorschläge behalten das Foto des Originals. Mit BILD_EINHEITLICH=aus: Foto der Quelle bzw. Standbild aus dem Video.
    const uniform = !/^(aus|nein|off|0)$/i.test((process.env.BILD_EINHEITLICH || "an").trim());
    if (uniform && kind === "import") delete d.image_file, delete d.image_url;
    let hasImage = false;
    if (d.image_file) {
      const inbox = resolve(REZEPTE, "inbox");
      const file = resolve(d.image_file);
      if (!file.startsWith(inbox + "/") || !existsSync(file)) warnings.push("image_file muss ein Bild aus daten/rezepte/inbox sein – ignoriert");
      else await uploadImage(draft.id, readFileSync(file), id).then(() => (hasImage = true), (e) => warnings.push(`Standbild nicht übernommen (${e.message.slice(0, 80)})`));
    }
    const image = !hasImage && (d.image_url || orig?.image);
    if (image) await api("PUT", `/api/recipe/${draft.id}/image/`, { image_url: image }).then(() => (hasImage = true), (e) => warnings.push(`Bild nicht übernommen (${e.message.slice(0, 80)})`));
    if (!hasImage) {
      if (!imageReady()) warnings.push(`Kein Bild – ${imageSetupHint}`);
      else
        try {
          const jpg = await generateImage(d, REZEPTE);
          await uploadImage(draft.id, jpg, id);
          mkdirSync(join(REZEPTE, "bilder"), { recursive: true });
          p.generated_image = join(REZEPTE, "bilder", `${id}.${imageType(jpg).ext}`);
          writeFileSync(p.generated_image, jpg);
          d.changes = [...d.changes, `Foto mit KI erzeugt (es gab kein Bild) · ${await lastImageNote()}`];
        } catch (e) {
          warnings.push(`Kein Bild erzeugt: ${e.message.slice(0, 120)}`);
        }
    }
  }

  const dif = before ? diff(before, d) : null;
  const msg = proposalMessage(p, d, { kind, warnings, dif });
  if (slackReady() && CHANNEL()) {
    const thread = kind === "quality" ? undefined : p.slack?.thread_ts || job?.ts;
    const channel = p.slack?.channel || job?.channel || CHANNEL();
    const r = await post(channel, msg.text, msg.blocks, thread);
    p.slack = { channel, thread_ts: thread || r.ts, last_ts: r.ts };
  } else warnings.push("Slack nicht eingerichtet – Vorschlag nur in Tandoor");
  store.proposals[p.id] = { ...p, name: d.name.trim(), updated: new Date().toISOString() };
  saveStore(store);
  writeFileSync(path, "{}");
  if (job) saveJob({ ...job, result: p.id });
  return { ok: true, proposal: p.id, draft_url: recipeUrl(p.draft_id), warnings, diff: dif?.lines };
}

export function proposalMessage(p, d, { kind, warnings = [], dif }) {
  const draftLink = link(recipeUrl(p.draft_id), "Entwurf ansehen");
  const head = {
    import: `📥 *Neues Rezept:* ${link(recipeUrl(p.draft_id), d.name)}${d.source_url ? `\nQuelle: ${d.source_url}` : ""}`,
    quality: `🔍 *Verbesserungsvorschlag:* ${link(recipeUrl(p.original_id), d.name)}`,
    revise: `✏️ *Überarbeitet:* ${link(recipeUrl(p.draft_id), d.name)}`,
  }[kind];
  const cut = (s) => (s.length > 2900 ? s.slice(0, 2900) + " …" : s);
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: head } },
    { type: "section", text: { type: "mrkdwn", text: cut(`*Was ich gemacht habe*\n${d.changes.map((c) => `• ${esc(c)}`).join("\n")}`) } },
  ];
  if (dif?.lines.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: cut(`*Zutaten* (Schritte ${dif.steps})\n${dif.lines.slice(0, 25).map(esc).join("\n")}${dif.lines.length > 25 ? `\n… und ${dif.lines.length - 25} weitere` : ""}`) } });
  if (dif?.removed) warnings = [`${dif.removed} Zutat(en) entfernt – bitte prüfen`, ...warnings];
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: cut([...warnings.map((w) => `⚠️ ${esc(w)}`), `${draftLink} · Antworte im Thread, wenn ich etwas ändern soll.`].join("\n")) }] });
  blocks.push(actions(p));
  return { text: `${{ import: "Neues Rezept", quality: "Vorschlag", revise: "Überarbeitet" }[kind]}: ${d.name}`, blocks };
}

const actions = (p) => ({
  type: "actions",
  block_id: `rz:${p.id}`,
  elements: [
    { type: "button", style: "primary", text: { type: "plain_text", text: "✅ Übernehmen" }, action_id: "rz_apply", value: p.id },
    { type: "button", style: "danger", text: { type: "plain_text", text: "Verwerfen" }, action_id: "rz_reject", value: p.id },
    ...(p.kind === "quality" ? [{ type: "button", text: { type: "plain_text", text: "Nicht bearbeiten" }, action_id: "rz_skip", value: p.id }] : []),
  ],
});

// ---------- Entscheidungen (Knöpfe) ----------

function openProposal(id) {
  const store = loadStore();
  const p = store.proposals[id];
  if (!p) throw new Error("Vorschlag unbekannt");
  if (p.status !== "open") throw new Error(`Vorschlag ist schon erledigt (${p.status})`);
  return { store, p };
}

// Nur echte Entwürfe dieses Werkzeugs dürfen gelöscht werden
async function deleteDraft(p) {
  const r = await getRecipe(p.draft_id).catch(() => null);
  if (!r) return;
  if (!r.name.startsWith(DRAFT_PREFIX) || !kwNames(r).includes(KW.open)) throw new Error(`Rezept ${p.draft_id} ist kein Entwurf – wird nicht gelöscht`);
  await api("DELETE", `/api/recipe/${p.draft_id}/`);
}

export async function applyProposal(id, user) {
  const { store, p } = openProposal(id);
  const draft = await getRecipe(p.draft_id);
  const keywords = uniq([...kwNames(draft).filter((k) => !STATUS_KW.includes(k)), KW.checked]).map((name) => ({ name }));
  let target;
  if (p.kind === "import") {
    const r = await api("PATCH", `/api/recipe/${p.draft_id}/`, { name: stripDraft(draft.name), private: false, keywords });
    target = p.draft_id;
    store.checked[target] = r.updated_at;
  } else {
    const orig = await getRecipe(p.original_id);
    mkdirSync(join(REZEPTE, "sicherungen"), { recursive: true });
    writeFileSync(join(REZEPTE, "sicherungen", `${orig.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(orig));
    const d = simplify(draft);
    const payload = toTandoor(d, { name: stripDraft(draft.name), keywords: keywords.map((k) => k.name), privateRecipe: orig.private });
    await api("PATCH", `/api/recipe/${orig.id}/`, payload);
    const after = simplify(await getRecipe(orig.id));
    const left = diff(d, after);
    if (left.lines.length || after.steps.length !== d.steps.length) {
      p.status = "error";
      saveStore(store);
      throw new Error(`Nach dem Speichern weicht das Rezept vom Entwurf ab (${left.lines.slice(0, 3).join("; ")}). Entwurf bleibt, Sicherung liegt in daten/rezepte/sicherungen.`);
    }
    // Erzeugtes Foto nur übernehmen, wenn das Original noch keins hat
    if (p.generated_image && !orig.image && existsSync(p.generated_image)) await uploadImage(orig.id, readFileSync(p.generated_image), String(orig.id));
    await deleteDraft(p);
    target = orig.id;
    store.checked[target] = after.updated_at;
  }
  dropImage(p);
  Object.assign(p, { status: "applied", decided_by: user, decided: new Date().toISOString(), recipe_id: target });
  saveStore(store);
  return { ok: true, url: recipeUrl(target), name: p.name };
}

export async function rejectProposal(id, user, { skip = false } = {}) {
  const { store, p } = openProposal(id);
  await deleteDraft(p);
  if (p.kind !== "import" && p.original_id) {
    const orig = await getRecipe(p.original_id);
    if (skip) {
      const keywords = uniq([...kwNames(orig).filter((k) => k !== KW.open), KW.skip]).map((name) => ({ name }));
      const r = await api("PATCH", `/api/recipe/${orig.id}/`, { keywords });
      store.rejected[orig.id] = r.updated_at;
    } else store.rejected[orig.id] = orig.updated_at;
  }
  dropImage(p);
  Object.assign(p, { status: skip ? "skipped" : "rejected", decided_by: user, decided: new Date().toISOString() });
  saveStore(store);
  return { ok: true, name: p.name };
}

// Erzeugtes Foto wird nach der Entscheidung nicht mehr gebraucht (es liegt dann in Tandoor oder ist verworfen)
function dropImage(p) {
  if (p.generated_image) rmSync(p.generated_image, { force: true });
  p.generated_image = null;
}

// Aufräumen: alte Fotos, Eingänge, Aufträge und Sicherungen löschen (Tage je Ordner)
const KEEP = { bilder: 30, inbox: 30, auftraege: 30, sicherungen: 180, videos: 1 };
export function cleanup() {
  const removed = {};
  for (const [dir, days] of Object.entries(KEEP)) {
    const path = join(REZEPTE, dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      const st = statSync(file);
      if (st.isFile() && Date.now() - st.mtimeMs > days * 86_400_000) {
        rmSync(file, { force: true });
        removed[dir] = (removed[dir] || 0) + 1;
      }
    }
  }
  return removed;
}

export const proposalByThread = (ts) => Object.values(loadStore().proposals).find((p) => p.slack && (p.slack.thread_ts === ts || p.slack.last_ts === ts));
export { SERVINGS_TEXT };
