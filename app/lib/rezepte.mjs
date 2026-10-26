// Rezept-Vorschläge: Entwurf in Tandoor anlegen, in Slack zeigen, nach Bestätigung übernehmen oder verwerfen.
// Gemeinsam genutzt vom Werkzeug tandoor.mjs (Agenten) und der Slack-Brücke (Knöpfe).
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { all, api, getRecipe, uploadImage, simplify, toTandoor, ingText, recipeUrl, KW, STATUS_KW, DRAFT_PREFIX, SERVINGS_TEXT } from "./tandoor.mjs";
import { generateImage, imageReady, imageSetupHint, imageType } from "./bild.mjs";
import { post, slackReady, link, esc } from "./slack.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || "/data";
export const REZEPTE = join(DATA_DIR, "rezepte"); // gemeinsamer Ordner (= Datenordner des Agenten „rezepte“)
const STORE = join(REZEPTE, "vorschlaege.json");
const AGENT_DATA = () => process.env.AGENT_DATA || REZEPTE;
export const DRAFT_FILE = () => join(AGENT_DATA(), "entwurf.json");
const STANDARD = () => join(process.env.AGENTS_DIR || join(APP, "..", "agents"), "rezept-standard.md");
const REFERENCE = Number(process.env.REZEPT_VORLAGE || 149567); // Rahmwirsing
const BATCH = Number(process.env.REZEPT_BATCH || 3);
const MAX_OPEN = Number(process.env.REZEPT_MAX_OFFEN || 6);
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
  const free = Math.max(0, MAX_OPEN - open.filter((p) => p.kind === "quality").length);
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
  return { total: list.length, open_proposals: open.length, batch: list.slice(0, Math.min(BATCH, free)) };
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
  const day = now.toLocaleDateString("sv-SE", { timeZone: process.env.TZ || "Europe/Berlin" });
  const sameDay = (iso) => iso && new Date(iso).toLocaleDateString("sv-SE", { timeZone: process.env.TZ || "Europe/Berlin" }) === day;
  return {
    total: recipes.length,
    checked,
    open,
    skipped,
    todo,
    batch: BATCH,
    days_left: BATCH > 0 ? Math.ceil(todo / BATCH) : null,
    today: {
      proposed: Object.values(store.proposals).filter((p) => p.kind === "quality" && sameDay(p.created)).length,
      applied: Object.values(store.proposals).filter((p) => p.status === "applied" && sameDay(p.decided)).length,
      rejected: Object.values(store.proposals).filter((p) => ["rejected", "skipped"].includes(p.status) && sameDay(p.decided)).length,
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
    `• 📝 noch zu prüfen: *${s.todo}*` + (s.todo && s.days_left ? ` – bei ${s.batch} pro Tag noch etwa ${s.days_left} ${s.days_left === 1 ? "Tag" : "Tage"}` : ""),
  ];
  const t = s.today;
  if (t.proposed || t.applied || t.rejected) lines.push(`• Heute: ${t.proposed} neu vorgeschlagen · ${t.applied} übernommen · ${t.rejected} verworfen`);
  if (!s.todo && !s.open) lines.push("🎉 Alle Rezepte sind geprüft.");
  return lines.join("\n");
}

export async function search(q) {
  const j = await api("GET", `/api/recipe/?query=${encodeURIComponent(q)}&page_size=10`);
  return j.results.map((r) => ({ id: r.id, name: r.name, url: recipeUrl(r.id) }));
}

// Link über Tandoors eigenen Import auslesen (nur Links aus dem aktuellen Auftrag)
export async function fetchUrl(url) {
  const job = loadJob();
  const allowed = job?.urls || [];
  if (!url) url = allowed[0];
  if (!url || !allowed.includes(url)) throw new Error(`Nur Links aus dem Auftrag sind erlaubt: ${allowed.join(", ") || "keine"}`);
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
    // Bild: von der Quelle bzw. vom Original übernehmen, sonst mit KI erzeugen
    let hasImage = false;
    const image = d.image_url || orig?.image;
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
          d.changes = [...d.changes, "Foto mit KI erzeugt (es gab kein Bild)"];
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
const KEEP = { bilder: 30, inbox: 30, auftraege: 30, sicherungen: 180 };
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
