// Holt agents/ aus GitHub: neue oder geänderte Agenten im Repo landen ohne Neustart im Container.
// Prüft alle AGENTS_SYNC Minuten (Standard 10, „aus“ = nie) den letzten Commit, der agents/ geändert hat (AGENTS_REPO, AGENTS_BRANCH).
// Nur bei neuem Commit wird das Archiv geladen und agents/ überschrieben. Ordner, die aus GitHub kamen und dort gelöscht wurden,
// verschwinden auch hier. Agenten, die nur auf dem Host liegen, bleiben unangetastet.
// Autor: SebastianInTheWild · MIT-Lizenz

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "../run-agent.mjs";

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

  writeFileSync(STATE_FILE, JSON.stringify({ sha, entries, at: new Date().toISOString() }, null, 1));
  log(`agents/ auf ${sha.slice(0, 7)} aktualisiert${removed.length ? `, entfernt: ${removed.join(", ")}` : ""}`);
  return true;
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
  run();
  setInterval(run, minutes * 60_000);
}
