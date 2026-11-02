// Sicherung in ein privates GitHub-Repo: alle Rezepte (JSON + Bild), gelöschte Rezepte und die Bild-Sicherungen.
// Über die GitHub-API (kein git im Container nötig). Einstellungen: BACKUP_REPO (besitzer/name), BACKUP_TOKEN
// (Fine-grained Token, nur dieses Repo, „Contents: Read and write“), BACKUP_BRANCH (Standard main).
//
// Aufbau im Repo:
//   rezepte/<id>/rezept.json      aktueller Stand aus Tandoor (Verlauf = Git-Historie)
//   rezepte/<id>/bild.<ext>       aktuelles Rezeptbild
//   geloescht/<id>/…              in Tandoor gelöschte Rezepte (wie oben, plus geloescht.json mit Datum)
//   sicherungen/<datei>           alles aus daten/rezepte/sicherungen (bleibt hier dauerhaft)
//   index.json                    Übersicht: id, Name, Stand, Pfad – für die Weboberfläche
//
// Der Abgleich läuft täglich (zeitplan.conf: rezept-sicherung = 03:30) und auf Knopfdruck in der Weboberfläche.
// Er überträgt nur Geändertes. Fehlt plötzlich mehr als die Hälfte der Rezepte, bricht er ab (Schutz vor Fehlalarm).
// Autor: SebastianInTheWild · MIT-Lizenz

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, api as tandoorApi, base, getRecipe, isDraft, simplify, toTandoor, uploadImage, recipeUrl, SYSTEM_KW } from "./tandoor.mjs";
import { imageType } from "./bild.mjs";
import { L } from "./i18n.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE = () => join(DATA_DIR, "github-sicherung.json");
const LOCAL_BACKUPS = () => join(DATA_DIR, "rezepte", "sicherungen");
const BACKUP_FILE = /^\d+-(bild-)?\d{4}-\d{2}-\d{2}T[\d-]+Z\.(jpg|png|webp|json)$/;

export const backupReady = () => Boolean(repo() && process.env.BACKUP_TOKEN);
const repo = () => (process.env.BACKUP_REPO || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
const branch = () => (process.env.BACKUP_BRANCH || "").trim() || "main";
export const repoUrl = () => (repo() ? `https://github.com/${repo()}` : "");

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE(), "utf8"));
  } catch {
    return {};
  }
};
const writeState = (s) => (mkdirSync(DATA_DIR, { recursive: true }), writeFileSync(STATE(), JSON.stringify(s, null, 1)));
export const backupStatus = () => readState().last || null;

// ---------- GitHub-API ----------

async function gh(method, path, body, { raw = false } = {}) {
  const r = await fetch(`https://api.github.com/repos/${repo()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.BACKUP_TOKEN}`,
      Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "rezept-agent",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw && r.ok) return Buffer.from(await r.arrayBuffer());
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`GitHub ${method} ${path} → ${r.status}: ${j.message || ""}`), { status: r.status });
  return j;
}

// Git-Blob-Kennung lokal berechnen – so lassen sich unveränderte Dateien erkennen, ohne sie hochzuladen
const blobSha = (buf) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Aktueller Stand des Branches: Commit und alle Dateien (Pfad → sha). Leeres Repo wird mit einer README angelegt. */
async function head() {
  let ref;
  try {
    ref = await gh("GET", `/git/ref/heads/${branch()}`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
    // Leeres Repo: erste Datei über die Contents-API, das legt den Branch an
    await gh("PUT", "/contents/README.md", { message: "Rezept-Sicherung angelegt", content: Buffer.from(README).toString("base64"), branch: branch() });
    ref = await gh("GET", `/git/ref/heads/${branch()}`);
  }
  const commit = await gh("GET", `/git/commits/${ref.object.sha}`);
  const tree = await gh("GET", `/git/trees/${commit.tree.sha}?recursive=1`);
  const files = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  return { commit: ref.object.sha, tree: commit.tree.sha, files };
}

/** Änderungen als ein Commit: changes = [{ path, content (Buffer) } | { path, sha } | { path, delete: true }] */
async function commit(h, changes, message) {
  if (!changes.length) return null;
  const entries = [];
  for (const c of changes) {
    if (c.delete) entries.push({ path: c.path, mode: "100644", type: "blob", sha: null });
    else if (c.sha) entries.push({ path: c.path, mode: "100644", type: "blob", sha: c.sha });
    else {
      const blob = await gh("POST", "/git/blobs", { content: c.content.toString("base64"), encoding: "base64" });
      entries.push({ path: c.path, mode: "100644", type: "blob", sha: blob.sha });
      await pause(Number(process.env.BACKUP_PAUSE_MS ?? 750)); // GitHub begrenzt Inhalte pro Minute
    }
  }
  const tree = await gh("POST", "/git/trees", { base_tree: h.tree, tree: entries });
  const c = await gh("POST", "/git/commits", { message, tree: tree.sha, parents: [h.commit] });
  await gh("PATCH", `/git/refs/heads/${branch()}`, { sha: c.sha });
  return c.sha;
}

/** Datei aus dem Repo lesen */
export const readRepoFile = (path) => gh("GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch())}`, null, { raw: true });

// ---------- Rezepte aufbereiten ----------

// Signierte Bildadressen (S3) ändern sich bei jedem Abruf – ohne Signatur speichern, sonst gäbe es täglich Änderungen
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stable(v)]));
  if (typeof value === "string" && /^https?:\/\/\S+\?\S*(Signature|X-Amz|sig=|Expires)/i.test(value)) return value.split("?")[0];
  return value;
}
const recipeJson = (r) => Buffer.from(JSON.stringify(stable(r), null, 1) + "\n");

async function recipeImage(r) {
  if (!r.image) return null;
  const url = /^https?:/.test(r.image) ? r.image : base() + r.image;
  let res = await fetch(url);
  if (res.status === 401 || res.status === 403) res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TANDOOR_TOKEN}` } });
  if (!res.ok) throw new Error(`Bild HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const README = `# Rezept-Sicherung

Automatisch angelegt vom Rezept-Agent (Tandoor). Bitte nicht von Hand ändern – der tägliche Abgleich überschreibt Änderungen.

- \`rezepte/<id>/rezept.json\`, \`bild.*\` – aktueller Stand jedes Rezepts (ältere Stände in der Git-Historie)
- \`geloescht/<id>/\` – in Tandoor gelöschte Rezepte, wiederherstellbar in der Weboberfläche unter „Sicherungen“
- \`sicherungen/\` – Bilder vor dem Ersetzen und Rezepte vor übernommenen Verbesserungen
- \`index.json\` – Übersicht
`;

// ---------- Abgleich ----------

let running = false;
export const backupRunning = () => running;

/**
 * Täglicher Abgleich. Liefert { changed, deleted: [{id,name}], uploaded, unchanged } und merkt sich das Ergebnis.
 * force: auch unveränderte Rezepte neu holen (z. B. nach einem Fehler).
 */
export async function syncBackup({ force = false, log = console.log } = {}) {
  if (!backupReady()) throw new Error(L("GitHub-Sicherung ist nicht eingerichtet (BACKUP_REPO, BACKUP_TOKEN)", "GitHub backup is not set up (BACKUP_REPO, BACKUP_TOKEN)"));
  if (running) throw new Error(L("Die Sicherung läuft gerade schon", "The backup is already running"));
  running = true;
  const started = new Date().toISOString();
  const state = readState();
  try {
    const h = await head();
    const list = (await all("/api/recipe/")).filter((r) => !isDraft(r.name));
    const inRepo = new Set([...h.files.keys()].map((p) => /^rezepte\/(\d+)\//.exec(p)?.[1]).filter(Boolean));
    const now = new Set(list.map((r) => String(r.id)));
    const missing = [...inRepo].filter((id) => !now.has(id));
    // Schutz: Tandoor nicht erreichbar oder leer zurückgegeben → nichts als gelöscht markieren
    if ((inRepo.size && !list.length) || (inRepo.size >= 4 && missing.length > inRepo.size / 2))
      throw new Error(L(`${missing.length} von ${inRepo.size} Rezepten fehlen in Tandoor – zur Sicherheit abgebrochen. Ist Tandoor erreichbar?`, `${missing.length} of ${inRepo.size} recipes are missing in Tandoor – stopped for safety. Is Tandoor reachable?`));

    const changes = [];
    const known = (state.recipes ||= {});
    let updated = 0;
    let unchanged = 0;
    for (const o of list) {
      const id = String(o.id);
      const dir = `rezepte/${id}`;
      const hasJson = h.files.has(`${dir}/rezept.json`);
      if (!force && hasJson && known[id] === o.updated_at) {
        unchanged++;
        continue;
      }
      const r = await getRecipe(o.id);
      const jsonBuf = recipeJson(r);
      if (h.files.get(`${dir}/rezept.json`) !== blobSha(jsonBuf)) changes.push({ path: `${dir}/rezept.json`, content: jsonBuf });
      // Bild: nur hochladen, wenn es sich geändert hat; alte Bilddateien mit anderer Endung entfernen
      const img = await recipeImage(r).catch((e) => (log(`[sicherung] ${r.name}: ${e.message}`), undefined));
      const oldImages = [...h.files.keys()].filter((p) => p.startsWith(`${dir}/bild.`));
      if (img) {
        const path = `${dir}/bild.${imageType(img).ext}`;
        if (h.files.get(path) !== blobSha(img)) changes.push({ path, content: img });
        for (const p of oldImages) if (p !== path) changes.push({ path: p, delete: true });
      } else if (img === null) for (const p of oldImages) changes.push({ path: p, delete: true }); // Bild in Tandoor entfernt
      known[id] = o.updated_at;
      updated++;
    }

    // Gelöschte Rezepte nach geloescht/<id>/ verschieben (gleiche Inhalte, kein erneutes Hochladen)
    const deleted = [];
    for (const id of missing) {
      const files = [...h.files].filter(([p]) => p.startsWith(`rezepte/${id}/`));
      let name = `#${id}`;
      try {
        name = JSON.parse(await readRepoFile(`rezepte/${id}/rezept.json`)).name || name;
      } catch {}
      for (const [p, sha] of files) {
        changes.push({ path: p.replace(/^rezepte\//, "geloescht/"), sha });
        changes.push({ path: p, delete: true });
      }
      changes.push({ path: `geloescht/${id}/geloescht.json`, content: Buffer.from(JSON.stringify({ id: Number(id), name, deleted: started }, null, 1) + "\n") });
      delete known[id];
      deleted.push({ id: Number(id), name });
    }

    // Bild- und Rezept-Sicherungen spiegeln (nur neue Dateien)
    let mirrored = 0;
    const local = existsSync(LOCAL_BACKUPS()) ? readdirSync(LOCAL_BACKUPS()).filter((f) => BACKUP_FILE.test(f)) : [];
    for (const f of local) {
      if (h.files.has(`sicherungen/${f}`)) continue;
      changes.push({ path: `sicherungen/${f}`, content: readFileSync(join(LOCAL_BACKUPS(), f)) });
      mirrored++;
    }

    // Übersicht für die Weboberfläche
    const deletedIndex = [...h.files.keys()].filter((p) => /^geloescht\/\d+\/geloescht\.json$/.test(p)).map((p) => Number(p.split("/")[1]));
    const index = {
      updated: started,
      recipes: list.map((r) => ({ id: r.id, name: r.name, updated_at: r.updated_at })).sort((a, b) => a.name.localeCompare(b.name, "de")),
      deleted: [...new Set([...deletedIndex.filter((id) => !now.has(String(id))), ...deleted.map((d) => d.id)])],
    };
    const indexBuf = Buffer.from(JSON.stringify(index, null, 1) + "\n");
    if (changes.length && h.files.get("index.json") !== blobSha(indexBuf)) changes.push({ path: "index.json", content: indexBuf });
    if (!h.files.has("README.md")) changes.push({ path: "README.md", content: Buffer.from(README) });

    const message = [`Sicherung ${started.slice(0, 10)}: ${updated} geprüft`, deleted.length ? `${deleted.length} gelöscht (${deleted.map((d) => d.name).join(", ")})` : "", mirrored ? `${mirrored} Sicherungen` : ""].filter(Boolean).join(", ");
    const sha = await commit(h, changes, message);
    const result = { at: started, result: "ok", files: changes.length, checked: updated, unchanged, deleted, mirrored, commit: sha };
    writeState({ ...state, recipes: known, last: result });
    log(`[sicherung] ${changes.length ? `${changes.length} Dateien in ${repo()} (${message})` : "keine Änderungen"}`);
    return result;
  } catch (e) {
    writeState({ ...state, last: { at: started, result: "fehler", note: e.message.slice(0, 300) } });
    throw e;
  } finally {
    running = false;
  }
}

// ---------- Täglicher Lauf ----------

export const BACKUP_ID = "rezept-sicherung";
export const BACKUP_DEFAULT = "03:30";
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Uhrzeit aus zeitplan.conf („rezept-sicherung = 03:30“, „Mo,Do 03:30“ oder „aus“), sonst 03:30 */
export function backupPlan() {
  let raw = BACKUP_DEFAULT;
  try {
    const file = process.env.SCHEDULE_FILE || join(process.env.AGENTS_DIR || "/data/agents", "..", "zeitplan.conf");
    const line = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).find((l) => new RegExp(`^${BACKUP_ID}\\s*[=:]`).test(l));
    if (line) raw = line.replace(/^[^=:]+[=:]\s*/, "").trim();
  } catch {}
  if (/^(aus|off|-)?$/i.test(raw)) return { off: true, raw: "aus" };
  const m = /^(?:([A-Za-z,]+)\s+)?(\d{1,2}:\d{2})$/.exec(raw);
  if (!m) return { error: `„${raw}“`, raw };
  return { raw, days: m[1] ? m[1].split(",") : WEEKDAYS, time: m[2].padStart(5, "0") };
}

/**
 * Prüft jede Minute, ob die Sicherung heute fällig ist (holt einen verpassten Lauf am selben Tag nach).
 * notify(text) meldet gelöschte Rezepte und Fehler (z. B. in Slack).
 */
export function startBackupSchedule({ log = console.log, notify = async () => {} } = {}) {
  const tz = process.env.TZ || "Europe/Berlin";
  const tick = async () => {
    if (!backupReady() || running) return;
    const plan = backupPlan();
    if (plan.off || plan.error) return;
    const now = new Date();
    const today = now.toLocaleDateString("sv-SE", { timeZone: tz });
    const hhmm = now.toLocaleTimeString("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    const weekday = now.toLocaleDateString("de-DE", { timeZone: tz, weekday: "short" }).replace(".", "");
    const state = readState();
    if (state.day === today || !plan.days.includes(weekday) || hhmm < plan.time) return;
    writeState({ ...state, day: today });
    try {
      const r = await syncBackup({ log });
      if (r.deleted.length)
        await notify(
          L(
            `🗑️ In Tandoor gelöscht: ${r.deleted.map((d) => `„${d.name}“`).join(", ")}. Die Rezepte liegen in der GitHub-Sicherung und lassen sich in der Weboberfläche unter „Sicherungen“ wiederherstellen.`,
            `🗑️ Deleted in Tandoor: ${r.deleted.map((d) => `“${d.name}”`).join(", ")}. The recipes are in the GitHub backup and can be restored in the web UI under “Backups”.`,
          ),
        );
    } catch (e) {
      log(`[sicherung] fehlgeschlagen: ${e.message}`);
      await notify(L(`⚠️ GitHub-Sicherung fehlgeschlagen: ${e.message}`, `⚠️ GitHub backup failed: ${e.message}`));
    }
  };
  log(`[sicherung] ${backupReady() ? `GitHub-Sicherung nach ${repo()} (${backupPlan().raw})` : "GitHub-Sicherung aus (BACKUP_REPO/BACKUP_TOKEN fehlen)"}`);
  setTimeout(tick, 20_000);
  return setInterval(tick, 60_000);
}

// ---------- Für die Weboberfläche ----------

/** Gelöschte Rezepte und Bild-Sicherungen, die in GitHub liegen */
export async function repoOverview() {
  const h = await head();
  const deleted = [];
  for (const p of h.files.keys()) {
    const m = /^geloescht\/(\d+)\/geloescht\.json$/.exec(p);
    if (!m) continue;
    let info = { id: Number(m[1]), name: `#${m[1]}`, deleted: null };
    try {
      info = { ...info, ...JSON.parse(await readRepoFile(p)) };
    } catch {}
    deleted.push({ ...info, image: [...h.files.keys()].find((f) => f.startsWith(`geloescht/${m[1]}/bild.`)) || null });
  }
  const backups = [...h.files.keys()].filter((p) => p.startsWith("sicherungen/")).map((p) => p.slice("sicherungen/".length)).filter((f) => BACKUP_FILE.test(f));
  return { repo: repoUrl(), deleted: deleted.sort((a, b) => String(b.deleted).localeCompare(String(a.deleted))), backups };
}

/** Sicherung aus GitHub lesen (nur Dateinamen im erwarteten Format) */
export async function readBackupFromRepo(file) {
  if (!BACKUP_FILE.test(String(file || ""))) throw new Error(L("Unbekannte Sicherung", "Unknown backup"));
  return readRepoFile(`sicherungen/${file}`);
}

/** Bild-Sicherung aus GitHub holen und lokal ablegen (zum Wiederherstellen) */
export async function fetchBackupFromRepo(file) {
  const buf = await readBackupFromRepo(file);
  mkdirSync(LOCAL_BACKUPS(), { recursive: true });
  writeFileSync(join(LOCAL_BACKUPS(), file), buf);
  return buf;
}

/** Gelöschtes Rezept aus GitHub in Tandoor neu anlegen (mit Bild); danach aus geloescht/ entfernen. */
export async function restoreDeleted(id) {
  if (!/^\d+$/.test(String(id))) throw new Error(L("Unbekanntes Rezept", "Unknown recipe"));
  const h = await head();
  const dir = `geloescht/${id}`;
  if (!h.files.has(`${dir}/rezept.json`)) throw new Error(L("Dieses Rezept liegt nicht unter „gelöscht“", "This recipe is not among the deleted ones"));
  const saved = JSON.parse(await readRepoFile(`${dir}/rezept.json`));
  const d = simplify(saved);
  const keywords = d.keywords.filter((k) => !SYSTEM_KW.includes(k) || k === "geprüft");
  const payload = { ...toTandoor(d, { name: saved.name, keywords, privateRecipe: Boolean(saved.private) }), servings_text: saved.servings_text || undefined };
  const created = await tandoorApi("POST", "/api/recipe/", payload);
  const imgPath = [...h.files.keys()].find((p) => p.startsWith(`${dir}/bild.`));
  if (imgPath) await uploadImage(created.id, await readRepoFile(imgPath), `${created.id}`).catch(() => {});
  // Aus geloescht/ entfernen; der nächste Abgleich legt es unter rezepte/<neue id>/ ab
  const changes = [...h.files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((path) => ({ path, delete: true }));
  await commit(h, changes, `Wiederhergestellt: ${saved.name} (alt ${id} → neu ${created.id})`);
  return { ok: true, id: created.id, name: saved.name, url: recipeUrl(created.id) };
}
