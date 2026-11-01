// Holt agents/ aus GitHub: neue oder geänderte Agenten im Repo landen ohne Neustart im Container.
// Prüft alle AGENTS_SYNC Minuten (Standard 10, „aus“ = nie) den letzten Commit, der agents/ geändert hat (AGENTS_REPO, AGENTS_BRANCH).
// Nur bei neuem Commit wird das Archiv geladen und agents/ überschrieben. Ordner, die aus GitHub kamen und dort gelöscht wurden,
// verschwinden auch hier. Agenten, die nur auf dem Host liegen, bleiben unangetastet.
// Zusätzlich (APP_SYNC, Standard an, nur wenn app/ beschreibbar ist – also in der Ordner-Variante): app/ und slack-app-manifest.yml.
// Neuer Code wird vorher mit „node --check“ geprüft; danach startet der Container neu, sobald kein Agent läuft
// (restart: unless-stopped). Das Slack-Manifest spielt die Slack-Brücke selbst ein (lib/manifest.mjs).
// Autor: SebastianInTheWild · MIT-Lizenz

import { spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_DIR, readStatus } from "../run-agent.mjs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_FILE = () => process.env.SLACK_MANIFEST || join(APP_DIR, "..", "slack-app-manifest.yml");

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = join(DATA_DIR, "agents-sync.json");
const TMP = join(DATA_DIR, ".agents-sync");
const REPO = () => (process.env.AGENTS_REPO || "SebastianInTheWild/Rezept-Agent").trim();
const BRANCH = () => (process.env.AGENTS_BRANCH || "main").trim();
const log = (msg) => console.log(`[sync] ${msg}`);

const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};

async function github(url) {
  const headers = { "User-Agent": "rezept-agent" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${r.statusText} (${url})`);
  return r;
}

/** Einmal abgleichen; liefert true, wenn agents/ aktualisiert wurde. */
export async function syncAgents() {
  const state = loadState();
  const commits = await (await github(`https://api.github.com/repos/${REPO()}/commits?sha=${encodeURIComponent(BRANCH())}&path=agents&per_page=1`)).json();
  const sha = commits[0]?.sha;
  if (!sha) throw new Error(`kein Commit mit agents/ in ${REPO()}@${BRANCH()}`);
  if (sha === state.sha) return false;

  const archive = Buffer.from(await (await github(`https://codeload.github.com/${REPO()}/tar.gz/${sha}`)).arrayBuffer());
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", "-", "-C", TMP, "--strip-components=1", "--wildcards", "*/agents/*"], { input: archive });
  if (tar.status !== 0) throw new Error(`Entpacken fehlgeschlagen: ${tar.stderr?.toString().trim() || tar.error?.message}`);
  const src = join(TMP, "agents");
  if (!existsSync(src)) throw new Error("agents/ fehlt im Archiv");

  const entries = readdirSync(src);
  for (const name of entries) cpSync(join(src, name), join(AGENTS_DIR, name), { recursive: true, force: true });
  const removed = (state.entries || []).filter((name) => !entries.includes(name));
  for (const name of removed) rmSync(join(AGENTS_DIR, name), { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });

  writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), sha, entries, at: new Date().toISOString() }, null, 1));
  log(`agents/ auf ${sha.slice(0, 7)} aktualisiert${removed.length ? `, entfernt: ${removed.join(", ")}` : ""}`);
  return true;
}

// ---------- app/ und Slack-Manifest ----------

const lastSha = async (path) => (await (await github(`https://api.github.com/repos/${REPO()}/commits?sha=${encodeURIComponent(BRANCH())}&path=${path}&per_page=1`)).json())[0]?.sha || null;
const filesIn = (dir) => readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile());
const writable = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
export const appSyncOn = () => !/^(aus|off|0)$/i.test((process.env.APP_SYNC || "an").trim()) && writable(APP_DIR);
let restartPending = false;

/** Einmal abgleichen; liefert { app, manifest } – was aktualisiert wurde. */
export async function syncApp() {
  const state = loadState();
  const [app, manifest] = await Promise.all([lastSha("app"), lastSha("slack-app-manifest.yml")]);
  if (!app) throw new Error(`kein Commit mit app/ in ${REPO()}@${BRANCH()}`);
  const changed = { app: app !== state.app_sha, manifest: Boolean(manifest) && manifest !== state.manifest_sha };
  if (!changed.app && !changed.manifest) return changed;

  // Archiv vom neuesten Stand des Branches – enthält dann app/ und Manifest in ihrer aktuellen Fassung
  const head = (await (await github(`https://api.github.com/repos/${REPO()}/commits?sha=${encodeURIComponent(BRANCH())}&per_page=1`)).json())[0]?.sha;
  const archive = Buffer.from(await (await github(`https://codeload.github.com/${REPO()}/tar.gz/${head}`)).arrayBuffer());
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", "-", "-C", TMP, "--strip-components=1", "--wildcards", "*/app/*", "*/slack-app-manifest.yml"], { input: archive });
  if (tar.status !== 0) throw new Error(`Entpacken fehlgeschlagen: ${tar.stderr?.toString().trim() || tar.error?.message}`);

  const next = { ...state };
  if (changed.app) {
    const src = join(TMP, "app");
    if (!existsSync(src)) throw new Error("app/ fehlt im Archiv");
    // Kaputter Code soll den Container nicht lahmlegen: erst prüfen, dann einspielen
    const files = filesIn(src);
    const bad = files.filter((f) => f.endsWith(".mjs")).find((f) => spawnSync(process.execPath, ["--check", join(src, f)]).status !== 0);
    if (bad) throw new Error(`app/${bad} hat einen Syntaxfehler – Code bleibt auf dem alten Stand (${(state.app_sha || "?").slice(0, 7)})`);
    cpSync(src, APP_DIR, { recursive: true, force: true });
    for (const f of (state.app_files || []).filter((f) => !files.includes(f))) rmSync(join(APP_DIR, f), { force: true });
    Object.assign(next, { app_sha: app, app_files: files, app_at: new Date().toISOString() });
    log(`app/ auf ${app.slice(0, 7)} aktualisiert – Neustart, sobald kein Agent läuft`);
  }
  if (changed.manifest && existsSync(join(TMP, "slack-app-manifest.yml"))) {
    cpSync(join(TMP, "slack-app-manifest.yml"), MANIFEST_FILE());
    next.manifest_sha = manifest;
    log(`slack-app-manifest.yml auf ${manifest.slice(0, 7)} aktualisiert`);
  }
  rmSync(TMP, { recursive: true, force: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 1));
  if (changed.app) restartWhenIdle();
  return changed;
}

// Neustart erst, wenn kein Agent mehr läuft (Status-Dateien je Agent); Docker startet den Container neu
function restartWhenIdle() {
  if (restartPending) return;
  restartPending = true;
  const check = () => {
    const ids = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR).filter((d) => !d.startsWith("_")) : [];
    const busy = ids.filter((id) => readStatus(id, "status.json")?.running);
    if (busy.length) return setTimeout(check, 60_000);
    log("Neustart für den neuen Code");
    process.exit(0);
  };
  setTimeout(check, 5_000);
}

export function startSync() {
  const raw = (process.env.AGENTS_SYNC || "10").trim();
  if (/^(aus|off|0)$/i.test(raw)) return log("Abgleich mit GitHub aus (AGENTS_SYNC)");
  const minutes = Math.max(1, Number(raw) || 10);
  log(`agents/ wird alle ${minutes} min mit ${REPO()}@${BRANCH()} abgeglichen`);
  let lastError = "";
  const run = () =>
    syncAgents()
      .then(() => (lastError = ""))
      .catch((e) => {
        // Gleichen Fehler nur einmal melden (z. B. GitHub nicht erreichbar oder agents/ schreibgeschützt)
        if (e.message !== lastError) console.error(`[sync] ${e.message}`);
        lastError = e.message;
      });
  const runApp = () =>
    syncApp()
      .then(() => (lastAppError = ""))
      .catch((e) => {
        if (e.message !== lastAppError) console.error(`[sync] ${e.message}`);
        lastAppError = e.message;
      });
  let lastAppError = "";
  const appOn = appSyncOn();
  log(appOn ? `app/ und slack-app-manifest.yml werden mit abgeglichen (APP_SYNC)` : "app/ wird nicht abgeglichen (APP_SYNC aus oder app/ schreibgeschützt)");
  run();
  if (appOn) runApp();
  setInterval(() => {
    run();
    if (appOn) runApp();
  }, minutes * 60_000);
}
