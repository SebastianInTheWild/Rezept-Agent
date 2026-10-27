// Startet einen Agenten: Vorprüfung, dann Claude Code ohne Bildschirm mit den Werkzeugen aus agent.json.
// Autor: SebastianInTheWild · MIT-Lizenz

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { post, slackReady } from "./lib/slack.mjs";

const APP = dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR = process.env.AGENTS_DIR || join(APP, "..", "agents");
const DATA_DIR = process.env.DATA_DIR || "/data";

export function loadAgent(id) {
  const dir = join(AGENTS_DIR, id);
  const cfg = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"));
  const prompt = readFileSync(join(dir, cfg.prompt || "prompt.md"), "utf8");
  return { id, dir, ...cfg, promptText: prompt };
}

// Status je Agent für die Weboberfläche: status.json (läuft gerade), last-run.json (letzter echter Lauf),
// last-check.json (letzte Vorprüfung ohne Arbeit bei quiet-Agenten)
const statusFile = (id, name) => join(DATA_DIR, id, name);
export const readStatus = (id, name) => {
  try {
    return JSON.parse(readFileSync(statusFile(id, name), "utf8"));
  } catch {
    return null;
  }
};
const writeStatus = (id, name, data) => {
  try {
    writeFileSync(statusFile(id, name), JSON.stringify(data));
  } catch {}
};
/** Läuft-Markierungen von einem abgebrochenen Prozess entfernen (beim Start des Schedulers). */
export function clearRunning(ids) {
  for (const id of ids) rmSync(statusFile(id, "status.json"), { force: true });
}

// quiet: „Nichts zu tun“ nicht protokollieren (für Agenten, die alle paar Minuten prüfen)
// by: wer den Lauf ausgelöst hat (zeitplan, von Hand, slack …) – nur für die Anzeige
export async function runAgent(id, { quiet = false, by = "direkt" } = {}) {
  const started = Date.now();
  let r;
  try {
    r = await run(id, quiet, by);
  } catch (e) {
    r = { result: "fehler", note: e.message };
    throw e;
  } finally {
    rmSync(statusFile(id, "status.json"), { force: true });
    const entry = { at: new Date(started).toISOString(), by, result: r?.result || "fehler", note: r?.note || "", duration_s: Math.round((Date.now() - started) / 1000) };
    // Leere Vorprüfungen alle paar Minuten überschreiben nicht den letzten echten Lauf
    if (quiet && entry.result === "nichts zu tun") writeStatus(id, "last-check.json", entry);
    else if (existsSync(join(DATA_DIR, id))) writeStatus(id, "last-run.json", entry);
  }
  return r.code;
}

async function run(id, quiet, by) {
  const agent = loadAgent(id);
  const data = join(DATA_DIR, id);
  mkdirSync(join(data, "logs"), { recursive: true });
  const logFile = join(data, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
  const log = (line) => {
    const msg = `[${new Date().toLocaleString("de-DE")}] [${id}] ${line}`;
    console.log(msg);
    appendFileSync(logFile, msg + "\n");
  };
  const env = { ...process.env, ...(agent.env || {}), AGENT_DATA: data, AGENT_ID: id };

  // Einmalige Einrichtung (z. B. vorhandene Automationen als bearbeitet merken)
  if (agent.init && !existsSync(join(data, ".initialized"))) {
    const r = spawnSync("sh", ["-c", agent.init], { cwd: APP, env, encoding: "utf8" });
    log(`Einrichtung: ${(r.stdout || r.stderr).trim()}`);
    if (r.status !== 0) return log("Einrichtung fehlgeschlagen – Abbruch"), { result: "fehler", note: "Einrichtung fehlgeschlagen" };
    appendFileSync(join(data, ".initialized"), new Date().toISOString());
  }

  // Vorprüfung: Gibt sie „0“ aus, gibt es nichts zu tun und Claude wird gar nicht erst gestartet.
  // Gibt sie eine Anzahl aus und hat agent.json „maxTurnsPerItem“, wachsen die erlaubten Schritte mit der Anzahl.
  let maxTurns = agent.maxTurns || 30;
  if (agent.precheck) {
    const r = spawnSync("sh", ["-c", agent.precheck], { cwd: APP, env, encoding: "utf8" });
    const res = (r.stdout || "").trim();
    if (r.status !== 0) {
      log(`Vorprüfung fehlgeschlagen: ${(r.stderr || res).trim()}`);
      return { result: "fehler", note: `Vorprüfung fehlgeschlagen: ${(r.stderr || res).trim().slice(0, 200)}` };
    }
    if (res === "0") {
      if (!quiet) log("Nichts zu tun");
      return { result: "nichts zu tun" };
    }
    log(`Vorprüfung: ${res}`);
    if (agent.maxTurnsPerItem && /^\d+$/.test(res)) maxTurns += Number(res) * agent.maxTurnsPerItem;
  }

  // {{DATA}} in Anweisung und Rechten = Datenordner des Agenten (dort darf er z. B. seinen Plan ablegen)
  const fill = (s) => s.replaceAll("{{DATA}}", data);
  const args = ["-p", fill(agent.promptText), "--output-format", "text", "--max-turns", String(maxTurns), "--add-dir", data];
  if (agent.allowedTools?.length) args.push("--allowedTools", ...agent.allowedTools.map(fill));
  if (agent.model || process.env.CLAUDE_MODEL) args.push("--model", agent.model || process.env.CLAUDE_MODEL);
  log(`Claude startet${by !== "direkt" ? ` (${by})` : ""}`);
  writeStatus(id, "status.json", { running: true, since: new Date().toISOString(), by });
  const code = await new Promise((resolve) => {
    const p = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => appendFileSync(logFile, d));
    p.stderr.on("data", (d) => appendFileSync(logFile, d));
    p.on("close", resolve);
    p.on("error", (e) => {
      log(`Claude nicht startbar: ${e.message}`);
      resolve(-1);
    });
  });
  log(`Claude beendet (Code ${code})`);
  if (code !== 0) {
    // Fehlermeldung in den Slack-Kanal (SLACK_CHANNEL), falls Slack eingerichtet ist
    if (slackReady() && process.env.SLACK_CHANNEL) {
      await post(process.env.SLACK_CHANNEL, `⚠️ Agent „${agent.name || id}“: Der Lauf ist fehlgeschlagen (Code ${code}). Details im Log ${logFile}.`).catch(() => {});
    }
  }
  return { code, result: code === 0 ? "ok" : "fehler", note: code === 0 ? "" : `Claude beendet mit Code ${code}` };
}
