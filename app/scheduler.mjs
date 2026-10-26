#!/usr/bin/env node
// Zeitplan für alle Agenten unter agents/<id>/agent.json. Neue oder geänderte Agenten werden ohne Neustart erkannt.
// Autor: SebastianInTheWild · MIT-Lizenz
//
//   node scheduler.mjs           Dauerbetrieb (Standard im Container)
//   node scheduler.mjs list      Agenten und Zeiten anzeigen
//   node scheduler.mjs run <id>  Agent sofort einmal starten

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, clearRunning, loadAgent, readStatus, runAgent } from "./run-agent.mjs";
import { startControl } from "./lib/control.mjs";
import { startWeb } from "./lib/web.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const RUNS_FILE = join(DATA_DIR, "runs.json");
const SCHEDULE_FILE = process.env.SCHEDULE_FILE || join(AGENTS_DIR, "..", "zeitplan.conf");

// zeitplan.conf: eine Zeile je Agent, z. B. „log-detektiv = 07:30“, „energie-coach = So 18:00“,
// mehrere Zeiten mit „;“ („automationen = 08:00; 20:00“), „alle 5 min“ = in Abständen, „aus“ pausiert. Hat Vorrang vor schedule/enabled in agent.json.
let warned = "";
function loadSchedule() {
  if (!existsSync(SCHEDULE_FILE)) return {};
  const out = {};
  const bad = [];
  readFileSync(SCHEDULE_FILE, "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/#.*/, "").trim();
      if (!line) return;
      const m = /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(line);
      if (!m) return bad.push(`Zeile ${i + 1}: „${raw.trim()}“`);
      const v = m[2].trim();
      out[m[1]] = /^(aus|off|-)?$/i.test(v) ? [] : v.split(";").map((s) => s.trim()).filter(Boolean);
    });
  const msg = bad.join(", ");
  if (msg && msg !== warned) console.error(`zeitplan.conf: nicht verstanden – ${msg} (Beispiel: log-detektiv = 07:30)`);
  warned = msg;
  return out;
}

function agents() {
  const plan = loadSchedule();
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(AGENTS_DIR, d.name, "agent.json")))
    .map((d) => {
      try {
        const a = loadAgent(d.name);
        if (a.id in plan) Object.assign(a, { schedule: plan[a.id], enabled: plan[a.id].length > 0, fromFile: true });
        return a;
      } catch (e) {
        console.error(`[${d.name}] agent.json fehlerhaft: ${e.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

// Ortszeit über TZ (z. B. Europe/Berlin)
function now() {
  const d = new Date();
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("de-DE", { timeZone: process.env.TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday.replace(".", "") };
}

// Zeitplan-Eintrag: „08:00“ (täglich), mit Wochentagen „So 18:00“ / „Mo,Mi,Fr 07:30“ oder Abstand „alle 5 min“
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const intervalOf = (slot) => {
  const m = /^alle\s+(\d+)\s*min$/i.exec(String(slot).trim());
  return m && Number(m[1]) >= 1 ? Number(m[1]) : null;
};
function parseSlot(slot) {
  if (intervalOf(slot)) return { interval: intervalOf(slot) };
  const m = /^(?:([A-Za-z,]+)\s+)?(\d{2}:\d{2})$/.exec(String(slot).trim());
  if (!m) return null;
  const days = m[1] ? m[1].split(",").map((s) => s.trim()) : WEEKDAYS;
  return days.every((d) => WEEKDAYS.includes(d)) ? { days, time: m[2] } : null;
}
const due = (slot, n) => {
  const s = parseSlot(slot);
  return Boolean(s && !s.interval && s.days.includes(n.weekday) && n.time >= s.time);
};

const loadRuns = () => (existsSync(RUNS_FILE) ? JSON.parse(readFileSync(RUNS_FILE, "utf8")) : {});

const summary = (list) => list.map((a) => `${a.id} ${a.enabled === false ? "aus" : [].concat(a.schedule || []).join("/") || "–"}`).join(", ") || "keine";

async function loop() {
  console.log(`Zeitplan läuft (TZ ${process.env.TZ || "UTC"}, Datei ${SCHEDULE_FILE}${existsSync(SCHEDULE_FILE) ? "" : " fehlt – Zeiten aus agent.json"})`);
  let last = "";
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const n = now();
      const runs = loadRuns();
      const list = agents();
      const s = summary(list);
      if (s !== last) console.log(`${last ? "Zeitplan geändert" : "Agenten"}: ${s}`);
      last = s;
      for (const a of list) {
        if (a.enabled === false) continue;
        for (const slot of [].concat(a.schedule || [])) {
          if (!parseSlot(slot)) {
            console.error(`[${a.id}] Zeitplan „${slot}“ ungültig (Beispiele: 08:00, So 18:00, Mo,Mi 07:30, alle 5 min)`);
            continue;
          }
          const key = `${a.id}@${slot}`;
          // Abstand: läuft, wenn seit dem letzten Lauf genug Minuten vergangen sind (Zeitstempel statt Tag)
          const every = intervalOf(slot);
          if (every) {
            const lastRun = Date.parse(runs[key] || 0) || 0;
            if (Date.now() - lastRun >= every * 60_000) {
              runs[key] = new Date().toISOString();
              writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 1));
              await runAgent(a.id, { quiet: true, by: "zeitplan" }).catch((e) => console.error(`[${a.id}] ${e.stack || e}`));
            }
            continue;
          }
          // Neu eingetragene Zeit, die heute schon vorbei ist: erst ab morgen (sonst liefe der Agent sofort nach dem Speichern)
          if (!known.has(key)) {
            known.add(key);
            if (due(slot, n) && runs[key] !== n.day) {
              runs[key] = n.day;
              writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 1));
              continue;
            }
          }
          // Fällige Zeit heute erreicht und noch nicht gelaufen (holt auch einen verpassten Lauf am selben Tag nach)
          if (due(slot, n) && runs[key] !== n.day) {
            runs[key] = n.day;
            writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 1));
            await runAgent(a.id, { by: "zeitplan" }).catch((e) => console.error(`[${a.id}] ${e.stack || e}`));
          }
        }
      }
      // Von Hand angeforderte Agenten (Knopf im Dashboard „Agenten“), nacheinander
      for (let id = control?.takeQueued(); id; id = control?.takeQueued()) {
        if (!list.some((a) => a.id === id)) continue;
        control.refresh();
        await runAgent(id, { by: "von Hand" }).catch((e) => console.error(`[${id}] ${e.stack || e}`));
        control.refresh();
      }
    } finally {
      busy = false;
    }
  };
  // Läuft-Markierungen eines abgebrochenen Laufs entfernen; Steuerung über HA (CONTROL=off schaltet sie ab)
  clearRunning(agents().map((a) => a.id));
  const control = process.env.CONTROL === "off" || !process.env.HA_TOKEN ? null : startControl({ agents, readStatus });
  // Weboberfläche „Zeitplan“ (WEB_PORT, Standard 8080; „aus“ = keine)
  startWeb();
  // Beim ersten Start keine alten Zeiten von heute nachholen
  const n0 = now();
  const runs = loadRuns();
  const known = new Set();
  for (const a of agents())
    for (const slot of [].concat(a.schedule || [])) {
      known.add(`${a.id}@${slot}`);
      if (due(slot, n0) && !runs[`${a.id}@${slot}`]) runs[`${a.id}@${slot}`] = n0.day;
    }
  writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 1));
  await tick();
  setInterval(tick, 30_000);
}

const [cmd, id] = process.argv.slice(2);
if (cmd === "list") {
  for (const a of agents()) console.log(`${a.enabled === false ? "⏸" : "▶"} ${a.id} – ${a.name || ""} – ${[].concat(a.schedule || []).join(", ") || "ohne Zeitplan"}${a.fromFile ? " (zeitplan.conf)" : ""}`);
} else if (cmd === "run") {
  if (!id) {
    console.error("Aufruf: run <agent-id>");
    process.exit(2);
  }
  process.exit((await runAgent(id)) || 0);
} else {
  await loop();
}
