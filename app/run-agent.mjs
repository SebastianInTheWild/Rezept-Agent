// Startet einen Agenten: Vorprüfung, dann Claude Code ohne Bildschirm mit den Werkzeugen aus agent.json.
// Autor: SebastianInTheWild · MIT-Lizenz

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { post, slackReady } from "./lib/slack.mjs";
import { L } from "./lib/i18n.mjs";
import { stamp } from "./lib/protokoll.mjs";

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
// Startwunsch aus einem anderen Prozess (Slack-Brücke „/pruefen“): Datei im Datenordner, der Zeitplan startet den Agenten
export const requestStart = (id, by) => {
  mkdirSync(join(DATA_DIR, id), { recursive: true });
  writeFileSync(statusFile(id, "start-anfrage.json"), JSON.stringify({ at: new Date().toISOString(), by }));
};
// ---------- Wiederholung, wenn ein Lauf am Claude-Limit scheitert ----------
// retry.json je Agent: { first, next, attempts, by } – der Zeitplan startet den Agenten ab „next“ erneut,
// alle CLAUDE_WIEDERHOLEN_MIN Minuten (Standard 30), höchstens 24 Stunden lang.
const RETRY_HOURS = 24;
export const retryMinutes = () => Math.max(5, Number(process.env.CLAUDE_WIEDERHOLEN_MIN) || 30);
/** Erkennt die Limit-Meldungen von Claude Code („usage limit reached“, „You've hit your limit · resets …“, Rate-Limit). */
export const isLimitError = (text = "") => /usage limit|hit your (usage )?limit|limit reached|rate.?limit|out of (extra )?usage|\b429\b|overloaded/i.test(text);
export const pendingRetry = (id) => readStatus(id, "retry.json");
export const clearRetry = (id) => rmSync(statusFile(id, "retry.json"), { force: true });
function scheduleRetry(id, by) {
  const old = pendingRetry(id);
  const first = old?.first || new Date().toISOString();
  if (Date.now() - Date.parse(first) > RETRY_HOURS * 3_600_000) {
    clearRetry(id);
    return null;
  }
  const next = new Date(Date.now() + retryMinutes() * 60_000).toISOString();
  const entry = { first, next, attempts: (old?.attempts || 0) + 1, by: old?.by || by };
  writeStatus(id, "retry.json", entry);
  return entry;
}

export const hasStartRequest = (id) => existsSync(statusFile(id, "start-anfrage.json"));
export const takeStartRequest = (id) => {
  if (!hasStartRequest(id)) return false;
  rmSync(statusFile(id, "start-anfrage.json"), { force: true });
  return true;
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
    const entry = { at: new Date(started).toISOString(), by, result: r?.result || "fehler", note: r?.note || "", duration_s: Math.round((Date.now() - started) / 1000), ...(r?.limit ? { limit: true } : {}), ...(r?.provider ? { provider: r.provider } : {}) };
    // Am Claude-Limit gescheitert: später erneut (Läufe aus Slack wiederholt die Slack-Brücke selbst, mit ihrem Auftrag)
    if (r?.limit && by !== "slack") entry.retry = scheduleRetry(id, by)?.next || null;
    else if (r && r.result !== "fehler") clearRetry(id);
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
    const msg = `[${stamp()}] [${id}] ${line}`;
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

  // KI-Anbieter in der eingestellten Reihenfolge (KI_ANBIETER, nur für Agenten mit „fallback“ in agent.json):
  // Claude als Agent mit Werkzeugen, Google Gemini in einer Anfrage (lib/ersatz.mjs). Claude → Gemini nur am Claude-Limit,
  // Gemini → Claude bei jedem Fehler.
  const order = agent.fallback ? (await import("./lib/ersatz.mjs")).providerOrder() : ["claude"];
  let claude = null; // { code, limit } des Claude-Laufs
  let googleNote = "";
  for (const provider of order) {
    if (provider === "google") {
      const { fallbackModel, runFallback } = await import("./lib/ersatz.mjs");
      const reason = claude?.limit ? "limit" : "primary";
      log(reason === "limit" ? `Claude-Limit erreicht – Google Gemini (${fallbackModel()}) springt ein` : `Google Gemini (${fallbackModel()}) startet${by !== "direkt" ? ` (${by})` : ""}`);
      writeStatus(id, "status.json", { running: true, since: new Date().toISOString(), by });
      const f = await runFallback(agent, { log, reason }).catch((e) => ({ ok: false, note: e.message }));
      log(`Gemini: ${f.note}`);
      if (f.ok) return { code: 0, limit: false, result: "ok", note: f.note, provider: "google" };
      googleNote = f.note;
      if (claude) break; // Claude war schon dran – dessen Ergebnis zählt
      continue;
    }
    claude = await runClaude();
    if (claude.code === 0 || !claude.limit) break; // Erfolg oder echter Fehler: kein Wechsel zu Gemini
  }
  if (!claude) {
    // Nur Gemini eingestellt und gescheitert
    const name = L(agent.name || id, agent.name_en || agent.name || id);
    if (by !== "slack" && slackReady() && process.env.SLACK_CHANNEL) await post(process.env.SLACK_CHANNEL, L(`⚠️ Agent „${name}“: Google Gemini hat es nicht geschafft (${googleNote}). Details im Log ${logFile}.`, `⚠️ Agent “${name}”: Google Gemini didn't manage (${googleNote}). Details in the log ${logFile}.`)).catch(() => {});
    return { code: 1, limit: false, result: "fehler", note: `Gemini: ${googleNote}`, provider: "google" };
  }
  const { code, limit } = claude;

  async function runClaude() {
    // {{DATA}} in Anweisung und Rechten = Datenordner des Agenten (dort darf er z. B. seinen Plan ablegen)
    const fill = (s) => s.replaceAll("{{DATA}}", data);
    const args = ["-p", fill(agent.promptText), "--output-format", "text", "--max-turns", String(maxTurns), "--add-dir", data];
    if (agent.allowedTools?.length) args.push("--allowedTools", ...agent.allowedTools.map(fill));
    if (agent.model || process.env.CLAUDE_MODEL) args.push("--model", agent.model || process.env.CLAUDE_MODEL);
    log(`Claude startet${by !== "direkt" ? ` (${by})` : ""}`);
    writeStatus(id, "status.json", { running: true, since: new Date().toISOString(), by });
    let tail = ""; // Ende der Ausgabe – daran erkennen wir das Claude-Limit
    const keep = (d) => {
      appendFileSync(logFile, d);
      tail = (tail + d).slice(-4000);
    };
    const code = await new Promise((resolve) => {
      const p = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", keep);
      p.stderr.on("data", keep);
      p.on("close", resolve);
      p.on("error", (e) => {
        log(`Claude nicht startbar: ${e.message}`);
        resolve(-1);
      });
    });
    log(`Claude beendet (Code ${code})`);
    return { code, limit: code !== 0 && isLimitError(tail) };
  }
  if (code !== 0) {
    const name = L(agent.name || id, agent.name_en || agent.name || id);
    const msg = limit
      ? by === "slack"
        ? null // die Slack-Brücke meldet sich im Thread des Auftrags
        : L(
            `⏳ Agent „${name}“: Das Claude-Limit ist erreicht. Ich versuche es alle ${retryMinutes()} Minuten erneut, bis es wieder geht.`,
            `⏳ Agent “${name}”: the Claude limit is reached. I'll retry every ${retryMinutes()} minutes until it works again.`,
          )
      : L(`⚠️ Agent „${name}“: Der Lauf ist fehlgeschlagen (Code ${code}). Details im Log ${logFile}.`, `⚠️ Agent “${name}”: the run failed (code ${code}). Details in the log ${logFile}.`);
    // Fehlermeldung in den Slack-Kanal (SLACK_CHANNEL), falls Slack eingerichtet ist – bei Wiederholungen nicht jedes Mal
    if (msg && !(limit && pendingRetry(id)) && slackReady() && process.env.SLACK_CHANNEL) await post(process.env.SLACK_CHANNEL, msg).catch(() => {});
    if (limit) log(`Claude-Limit erreicht${by === "slack" ? "" : ` – neuer Versuch in ${retryMinutes()} min`}`);
  } else if (pendingRetry(id) && slackReady() && process.env.SLACK_CHANNEL) {
    const name = L(agent.name || id, agent.name_en || agent.name || id);
    await post(process.env.SLACK_CHANNEL, L(`✅ Agent „${name}“: Der nachgeholte Lauf hat geklappt.`, `✅ Agent “${name}”: the retried run worked.`)).catch(() => {});
  }
  return { code, limit, result: code === 0 ? "ok" : "fehler", note: code === 0 ? "" : limit ? L("Claude-Limit erreicht", "Claude limit reached") : `Claude beendet mit Code ${code}` };
}
