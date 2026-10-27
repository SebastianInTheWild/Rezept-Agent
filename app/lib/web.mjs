// Weboberfläche „Zeitplan“: zeigt alle Agenten aus agents/ mit Zeitplan, letztem und nächstem Lauf
// und schreibt Änderungen nach zeitplan.conf (Kommentare und Reihenfolge bleiben erhalten). Knopf „Jetzt starten“ je Agent, „Jetzt senden“ für die Statistik.
// Beim Qualitäts-Agenten zusätzlich: wie viele Rezepte er pro Tag prüft (daten/rezepte/einstellungen.json).
// Der Zeitplan liest die Datei alle 30 s, die Slack-Brücke jede Minute – ein Neustart ist nicht nötig.
// Port: WEB_PORT (Standard 8080, „aus“ = keine Oberfläche). Passwort: WEB_PASSWORT (optional, HTTP-Anmeldung).
// Autor: SebastianInTheWild · MIT-Lizenz

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENTS_DIR, loadAgent, readStatus } from "../run-agent.mjs";
import { perDay, setPerDay, PER_DAY_MAX } from "./rezepte.mjs";

const SCHEDULE_FILE = process.env.SCHEDULE_FILE || join(AGENTS_DIR, "..", "zeitplan.conf");
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const STATS_ID = "rezept-statistik";
const QUALITY_ID = "rezept-qualitaet";
const HTML = join(dirname(fileURLToPath(import.meta.url)), "web.html");

// ---------- zeitplan.conf ----------

function readPlan() {
  const lines = existsSync(SCHEDULE_FILE) ? readFileSync(SCHEDULE_FILE, "utf8").split(/\r?\n/) : [];
  const plan = {};
  for (const raw of lines) {
    const m = /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(raw.replace(/#.*/, "").trim());
    if (m) plan[m[1]] = m[2].trim();
  }
  return { lines, plan };
}

const slotsOf = (v) => (/^(aus|off|-)?$/i.test(v) ? [] : v.split(";").map((s) => s.trim()).filter(Boolean));

/** Prüft einen Eintrag; gibt die Fehlermeldung zurück oder null. */
export function checkSlot(slot, { allowInterval = true } = {}) {
  const iv = /^alle\s+(\d+)\s*min$/i.exec(slot);
  if (iv) return allowInterval && Number(iv[1]) >= 1 ? null : "Abstände sind hier nicht möglich";
  const m = /^(?:([A-Za-z,]+)\s+)?(\d{2}):(\d{2})$/.exec(slot);
  if (!m) return `„${slot}“ ist keine gültige Zeit (Beispiele: 08:00, So 18:00, Mo,Mi 07:30, alle 5 min)`;
  if (Number(m[2]) > 23 || Number(m[3]) > 59) return `„${slot}“ ist keine gültige Uhrzeit`;
  const days = m[1] ? m[1].split(",") : [];
  if (!days.every((d) => WEEKDAYS.includes(d))) return `Unbekannter Wochentag in „${slot}“ (Mo Di Mi Do Fr Sa So)`;
  return null;
}

/** Schreibt den Eintrag für id (value = null → Zeile entfernen, d. h. Standard aus agent.json). */
function writeEntry(id, value) {
  const { lines } = readPlan();
  const re = new RegExp(`^\\s*${id.replace(/[.-]/g, "\\$&")}\\s*[=:]`);
  const idx = lines.findIndex((l) => re.test(l));
  const width = Math.max(18, ...lines.map((l) => (/^([\w.-]+)\s*=/.exec(l) || [, ""])[1].length));
  const line = `${id.padEnd(width)} = ${value}`;
  if (value === null) {
    if (idx >= 0) lines.splice(idx, 1);
  } else if (idx >= 0) {
    const comment = /\s#.*$/.exec(lines[idx]);
    lines[idx] = line + (comment ? `   ${comment[0].trim()}` : "");
  } else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line);
  }
  const tmp = `${SCHEDULE_FILE}.tmp`;
  writeFileSync(tmp, lines.join("\n").replace(/\n*$/, "\n"));
  renameSync(tmp, SCHEDULE_FILE);
}

// ---------- Daten für die Oberfläche ----------

/** Nächster Lauf als Text aus den Zeitplan-Einträgen („08:00“, „So 18:00“, „alle 5 min“). */
function nextRunText(agent, nowDate = new Date()) {
  if (agent.enabled === false) return "nur von Hand";
  const slots = [].concat(agent.schedule || []);
  const every = slots.map((s) => /^alle\s+(\d+)\s*min$/i.exec(String(s).trim())).find(Boolean);
  if (every) return `alle ${every[1]} min`;
  const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("de-DE", { timeZone: process.env.TZ || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const nowP = parts(nowDate);
  const nowTime = `${nowP.hour}:${nowP.minute}`;
  for (let add = 0; add < 8; add++) {
    const d = new Date(nowDate.getTime() + add * 86400000);
    const p = parts(d);
    const wd = p.weekday.replace(".", "");
    const times = slots
      .map((s) => /^(?:([A-Za-z,]+)\s+)?(\d{2}:\d{2})$/.exec(String(s).trim()))
      .filter(Boolean)
      .filter((m) => (m[1] ? m[1].split(",").map((x) => x.trim()) : WEEKDAYS).includes(wd))
      .map((m) => m[2])
      .filter((t) => add > 0 || t > nowTime)
      .sort();
    if (times.length) return `${add === 0 ? "heute" : add === 1 ? "morgen" : `${wd} ${p.day}.${p.month}.`} ${times[0]}`;
  }
  return slots.length ? "–" : "nur von Hand";
}

// Statistik von Hand („Jetzt senden“): direkt aus der Weboberfläche, unabhängig vom täglichen Versand der Slack-Brücke
let statsSending = false;
async function sendStats() {
  const { stats, statsMessage, CHANNEL } = await import("./rezepte.mjs");
  const { post, slackReady } = await import("./slack.mjs");
  if (!slackReady() || !CHANNEL()) throw new Error("Slack ist nicht eingerichtet (SLACK_BOT_TOKEN/SLACK_CHANNEL)");
  statsSending = true;
  try {
    const s = await stats();
    await post(CHANNEL(), statsMessage(s));
    console.log(`[web] Statistik von Hand gesendet: ${s.checked}/${s.total} geprüft, ${s.todo} noch zu prüfen`);
  } finally {
    statsSending = false;
  }
}

// Von Hand angeforderte Agenten (Knopf „Jetzt starten“); der Zeitplan startet sie nacheinander
const queued = [];
export const takeQueued = () => queued.shift();

function agentIds() {
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(AGENTS_DIR, d.name, "agent.json")))
    .map((d) => d.name)
    .sort();
}

function overview() {
  const { plan } = readPlan();
  const items = [];
  for (const id of agentIds()) {
    let a;
    try {
      a = loadAgent(id);
    } catch (e) {
      items.push({ id, name: id, error: `agent.json fehlerhaft: ${e.message}` });
      continue;
    }
    const fromFile = id in plan;
    const schedule = fromFile ? slotsOf(plan[id]) : [].concat(a.schedule || []);
    const enabled = fromFile ? schedule.length > 0 : a.enabled !== false;
    const status = readStatus(id, "status.json");
    const last = readStatus(id, "last-run.json");
    const check = readStatus(id, "last-check.json");
    items.push({
      id,
      kind: "agent",
      name: a.name || id,
      description: a.description || "",
      schedule,
      enabled,
      source: fromFile ? "zeitplan.conf" : "agent.json",
      default: { schedule: [].concat(a.schedule || []), enabled: a.enabled !== false },
      next: nextRunText({ schedule, enabled }),
      running: Boolean(status?.running),
      since: status?.since || null,
      last: last ? { at: last.at, result: last.result, by: last.by, note: last.note || "" } : null,
      check: check ? { at: check.at, result: check.result } : null,
      manual: a.manual !== false,
      queued: queued.includes(id),
      ...(id === QUALITY_ID ? { perDay: { ...perDay(), max: PER_DAY_MAX } } : {}),
    });
  }
  // Sonderfall: tägliche Rezept-Statistik der Slack-Brücke (kein Agent, nur eine Uhrzeit)
  const envStats = (process.env.REZEPT_STATISTIK || "").trim();
  const statsRaw = plan[STATS_ID] ?? (envStats || "19:00");
  const statsSlots = slotsOf(statsRaw);
  items.push({
    id: STATS_ID,
    kind: "statistik",
    name: "Rezept-Statistik",
    description: "Schickt täglich die Zahlen zu den Rezepten (gesamt, geprüft, noch offen) in den Slack-Kanal. Kein Agent – das macht die Slack-Brücke.",
    schedule: statsSlots,
    enabled: statsSlots.length > 0,
    source: STATS_ID in plan ? "zeitplan.conf" : envStats ? "REZEPT_STATISTIK" : "Standard",
    default: { schedule: [envStats || "19:00"], enabled: true },
    next: nextRunText({ schedule: statsSlots, enabled: statsSlots.length > 0 }),
    manual: true,
    running: statsSending,
  });
  return { file: SCHEDULE_FILE, tz: process.env.TZ || "UTC", items };
}

// ---------- HTTP ----------

const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

function authorized(req) {
  const pw = process.env.WEB_PASSWORT;
  if (!pw) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const given = Buffer.from(Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":"));
  const want = Buffer.from(pw);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error("zu groß");
  }
  return JSON.parse(data || "{}");
}

export function startWeb() {
  const port = (process.env.WEB_PORT || "8080").trim();
  if (/^(aus|off)$/i.test(port)) return null;
  const server = createServer(async (req, res) => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Agenten", charset="UTF-8"' });
        return res.end("Anmeldung nötig");
      }
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, readFileSync(HTML, "utf8"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/plan") return send(res, 200, overview());
      const m = /^\/api\/plan\/([\w.-]+)$/.exec(url.pathname);
      if (req.method === "PUT" && m) {
        // Schutz gegen Formular-Angriffe von fremden Seiten: nur JSON von dieser Seite
        if (!/^application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, { error: "JSON erwartet" });
        const id = m[1];
        const isStats = id === STATS_ID;
        if (!isStats && !agentIds().includes(id)) return send(res, 404, { error: `Agent „${id}“ gibt es nicht` });
        const { mode, slots = [] } = await body(req);
        if (mode === "default") {
          writeEntry(id, null);
        } else if (mode === "off") {
          writeEntry(id, "aus");
        } else if (mode === "slots") {
          const list = [...new Set(slots.map((s) => String(s).trim()).filter(Boolean))];
          if (!list.length) return send(res, 400, { error: "Mindestens eine Zeit angeben – oder „Pausieren“ wählen" });
          if (isStats && list.length > 1) return send(res, 400, { error: "Die Statistik kann nur eine Uhrzeit haben" });
          for (const s of list) {
            const err = checkSlot(s, { allowInterval: !isStats });
            if (err) return send(res, 400, { error: err });
          }
          if (list.some((s) => /^alle/i.test(s)) && list.length > 1) return send(res, 400, { error: "Abstand und feste Zeiten bitte nicht mischen" });
          writeEntry(id, list.join("; "));
        } else return send(res, 400, { error: "Unbekannte Aktion" });
        console.log(`[web] Zeitplan ${id} → ${mode === "slots" ? slots.join("; ") : mode}`);
        return send(res, 200, overview());
      }
      if (req.method === "PUT" && url.pathname === "/api/pro-tag") {
        if (!/^application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, { error: "JSON erwartet" });
        const { value } = await body(req);
        try {
          setPerDay(value);
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
        console.log(`[web] Rezept-Qualität: ${value} Rezepte pro Tag`);
        return send(res, 200, overview());
      }
      const run = /^\/api\/run\/([\w.-]+)$/.exec(url.pathname);
      if (req.method === "POST" && run) {
        if (!/^application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, { error: "JSON erwartet" });
        const id = run[1];
        if (id === STATS_ID) {
          if (statsSending) return send(res, 409, { error: "Die Statistik wird gerade gesendet" });
          await sendStats();
          return send(res, 200, overview());
        }
        if (!agentIds().includes(id)) return send(res, 404, { error: `Agent „${id}“ gibt es nicht` });
        if (loadAgent(id).manual === false) return send(res, 400, { error: "Dieser Agent startet nicht von Hand" });
        if (!queued.includes(id) && !readStatus(id, "status.json")?.running) queued.push(id);
        console.log(`[web] ${id} von Hand angefordert`);
        return send(res, 200, overview());
      }
      send(res, 404, { error: "Nicht gefunden" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
  server.listen(Number(port), () => console.log(`Weboberfläche „Zeitplan“ auf Port ${port}${process.env.WEB_PASSWORT ? " (mit Passwort)" : " (ohne Passwort – Umgebungsvariable WEB_PASSWORT setzen)"}`));
  server.on("error", (e) => console.error(`Weboberfläche: ${e.message}`));
  return server;
}
