// Steuerung über Home Assistant: je Agent ein Knopf (input_button „Agent …“) und ein Status-Sensor
// (sensor.agent_<id>), dazu ein eigenes Dashboard „Agenten“. Läuft im Scheduler neben dem Zeitplan:
// - drückst du einen Knopf, kommt der Agent in die Warteschlange und startet beim nächsten Durchlauf
// - Status (läuft, letzter Lauf, nächster Lauf, Protokoll) schreibt die Steuerung als Sensor nach HA
// Kein offener Port: der Container fragt HA, die Anmeldung läuft über HA.
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, rest } from "./ha.mjs";
import { saveDashboard } from "./report.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = join(DATA_DIR, "control.json");
const DASHBOARD = process.env.CONTROL_DASHBOARD || "dashboard-agenten"; // HA verlangt einen Bindestrich
const PREFIX = process.env.CONTROL_PREFIX || "Agent";
const REFRESH_MS = 5 * 60_000; // Sensoren spätestens so oft neu schreiben (über die API gesetzte Zustände überleben keinen HA-Neustart)

const TZ = process.env.TZ || "Europe/Berlin";
const DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
// „Mo 19.10. 12:51“
const fmt = (iso) => {
  if (!iso) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday.replace(".", "")} ${p.day}.${p.month}. ${p.hour}:${p.minute}`;
};
const duration = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
export const sensorId = (id) => `sensor.agent_${id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;

const load = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { buttons: {}, pressed: {}, dashboard: "" };
  }
};
const save = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));

/** Nächster Lauf als Text aus den Zeitplan-Einträgen („08:00“, „So 18:00“, „alle 5 min“). */
export function nextRunText(agent, nowDate = new Date()) {
  if (agent.enabled === false) return "nur von Hand";
  const slots = [].concat(agent.schedule || []);
  const every = slots.map((s) => /^alle\s+(\d+)\s*min$/i.exec(String(s).trim())).find(Boolean);
  if (every) return `alle ${every[1]} min`;
  const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const nowP = parts(nowDate);
  const nowTime = `${nowP.hour}:${nowP.minute}`;
  for (let add = 0; add < 8; add++) {
    const d = new Date(nowDate.getTime() + add * 86400000);
    const p = parts(d);
    const wd = p.weekday.replace(".", "");
    const times = slots
      .map((s) => /^(?:([A-Za-z,]+)\s+)?(\d{2}:\d{2})$/.exec(String(s).trim()))
      .filter(Boolean)
      .filter((m) => (m[1] ? m[1].split(",").map((x) => x.trim()) : DAYS).includes(wd))
      .map((m) => m[2])
      .filter((t) => add > 0 || t > nowTime)
      .sort();
    if (times.length) return `${add === 0 ? "heute" : add === 1 ? "morgen" : `${wd} ${p.day}.${p.month}.`} ${times[0]}`;
  }
  return slots.length ? "–" : "nur von Hand";
}

// Letzte Protokollzeilen (nur Zeilen des Programms, ohne die Ausgabe von Claude), höchstens 6
function logTail(id) {
  const dir = join(DATA_DIR, id, "logs");
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
  for (const f of files.reverse()) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => /^\[\d/.test(l));
    if (lines.length) return lines.slice(-6).map((l) => l.replace(/^\[([^\]]+)\] \[[^\]]+\] /, "$1 · ")).join("\n").slice(-1200);
  }
  return "";
}

const RESULT = {
  ok: { text: "erfolgreich", icon: "mdi:check-circle-outline" },
  fehler: { text: "fehlgeschlagen", icon: "mdi:alert-circle-outline" },
  "nichts zu tun": { text: "nichts zu tun", icon: "mdi:sleep" },
};

/** Zustand eines Agenten für den Sensor. */
export function agentState(agent, { status, lastRun, lastCheck, queued, button }) {
  const last = lastRun || lastCheck;
  const state = status?.running ? "läuft" : queued ? "wartet" : last ? RESULT[last.result]?.text || last.result : "noch nie gelaufen";
  const icon = status?.running ? "mdi:play-circle" : queued ? "mdi:timer-sand" : RESULT[last?.result]?.icon || "mdi:robot-outline";
  return {
    state,
    attributes: {
      friendly_name: `${PREFIX} ${agent.name || agent.id}`,
      icon,
      agent_id: agent.id,
      description: agent.description || "",
      schedule: agent.enabled === false ? "aus" : [].concat(agent.schedule || []).join(", ") || "keiner",
      next_run: nextRunText(agent),
      running_since: status?.running ? fmt(status.since) : "",
      last_run: lastRun ? fmt(lastRun.at) : "",
      last_by: lastRun?.by || "",
      last_result: lastRun ? RESULT[lastRun.result]?.text || lastRun.result : "",
      last_note: lastRun?.note || "",
      last_duration: lastRun ? duration(lastRun.duration_s) : "",
      last_check: lastCheck ? fmt(lastCheck.at) : "",
      log: logTail(agent.id),
      button: button || "",
    },
  };
}

function dashboardConfig(list, buttons) {
  const sections = [{
    type: "grid",
    column_span: 3,
    cards: [
      { type: "heading", heading: "Agenten", icon: "mdi:robot-outline" },
      {
        type: "markdown",
        content:
          "Hier startest du die KI-Agenten von Hand. Ein Druck auf **Jetzt starten** reiht den Agenten ein. Er startet innerhalb von etwa 30 Sekunden, " +
          "sobald kein anderer Agent läuft. Die Agenten laufen nacheinander, nie gleichzeitig. Gibt es laut Vorprüfung nichts zu tun, startet Claude gar nicht erst.",
      },
    ],
  }];
  for (const a of list) {
    const s = sensorId(a.id);
    const t = (k) => `{{ state_attr('${s}', '${k}') }}`;
    const cards = [
      { type: "heading", heading: a.name || a.id, icon: a.icon || "mdi:robot", heading_style: "title" },
      { type: "tile", entity: s, name: "Status", vertical: false, grid_options: { columns: "full" } },
      {
        type: "markdown",
        content:
          `${a.description || ""}\n\n` +
          `**Zeitplan:** ${t("schedule")} · **Nächster Lauf:** ${t("next_run")}\n\n` +
          `{% if state_attr('${s}', 'running_since') %}**Läuft seit:** ${t("running_since")}\n\n{% endif %}` +
          `**Letzter Lauf:** {% if state_attr('${s}', 'last_run') %}${t("last_run")} · ${t("last_result")} · ${t("last_duration")}` +
          `{% if state_attr('${s}', 'last_by') %} ({{ state_attr('${s}', 'last_by') }}){% endif %}{% else %}noch nie{% endif %}` +
          `{% if state_attr('${s}', 'last_note') %}\n\n⚠️ ${t("last_note")}{% endif %}` +
          `{% if state_attr('${s}', 'last_check') %}\n\n**Zuletzt geprüft:** ${t("last_check")} (nichts zu tun){% endif %}` +
          `{% if state_attr('${s}', 'log') %}\n\n<details><summary>Protokoll</summary>\n\n\`\`\`\n${t("log")}\n\`\`\`\n</details>{% endif %}`,
      },
    ];
    if (buttons[a.id]) {
      cards.push({
        type: "button",
        entity: buttons[a.id],
        name: "Jetzt starten",
        icon: "mdi:play-circle-outline",
        icon_height: "28px",
        show_state: false,
        tap_action: {
          action: "perform-action",
          perform_action: "input_button.press",
          target: { entity_id: buttons[a.id] },
          confirmation: { text: `„${a.name || a.id}“ jetzt starten?` },
        },
        grid_options: { columns: "full", rows: 1 },
      });
    }
    sections.push({ type: "grid", cards });
  }
  return { title: "Agenten", views: [{ title: "Agenten", path: "agenten", icon: "mdi:robot-outline", type: "sections", max_columns: 3, sections }] };
}

/**
 * Steuerung starten. agents(): aktuelle Agentenliste (wie im Scheduler), readStatus(id, datei): Statusdateien.
 * Gibt { takeQueued() } zurück: der Scheduler holt sich damit die angeforderten Agenten.
 */
export function startControl({ agents, readStatus }) {
  const st = load();
  const queue = [];
  let lastPublished = {};
  let lastFull = 0;
  let setupSig = "";
  let busy = false;
  let warned = "";

  const manual = (a) => a.manual !== false;

  // Knöpfe anlegen (je Agent einer, Name „Agent <Name>“) und Dashboard schreiben – nur wenn sich etwas geändert hat
  async function setup(list) {
    const sig = JSON.stringify(list.map((a) => [a.id, a.name, a.icon, a.description, manual(a)]));
    if (sig === setupSig) return;
    const call = await connect();
    try {
      const items = await call({ type: "input_button/list" });
      const states = await rest("GET", "states");
      const entityOf = (item) => states.find((s) => s.entity_id === `input_button.${item.id}`)?.entity_id || `input_button.${item.id}`;
      for (const a of list.filter(manual)) {
        const name = `${PREFIX} ${a.name || a.id}`;
        let item = items.find((i) => i.id === st.buttons[a.id]?.item) || items.find((i) => i.name === name);
        if (!item) item = await call({ type: "input_button/create", name, icon: "mdi:play-circle-outline" });
        st.buttons[a.id] = { item: item.id, entity: entityOf(item) };
      }
      const buttons = Object.fromEntries(list.filter(manual).map((a) => [a.id, st.buttons[a.id]?.entity]));
      const dashSig = JSON.stringify([sig, buttons]);
      if (dashSig !== st.dashboard) {
        await saveDashboard(call, { url: DASHBOARD, title: "Agenten", icon: "mdi:robot-outline" }, dashboardConfig(list, buttons));
        st.dashboard = dashSig;
      }
      save(st);
      setupSig = sig;
    } finally {
      call.close();
    }
  }

  // Knöpfe abfragen: neuer Zeitstempel = gedrückt
  async function poll(list) {
    for (const a of list.filter(manual)) {
      const ent = st.buttons[a.id]?.entity;
      if (!ent) continue;
      const s = await rest("GET", `states/${ent}`).catch(() => null);
      const pressed = s?.state && s.state !== "unknown" && s.state !== "unavailable" ? s.state : "";
      if (!(a.id in st.pressed)) st.pressed[a.id] = pressed; // erster Blick: nur merken
      else if (pressed && pressed !== st.pressed[a.id]) {
        st.pressed[a.id] = pressed;
        if (!queue.includes(a.id)) {
          queue.push(a.id);
          console.log(`[${a.id}] von Hand angefordert (Dashboard „Agenten“)`);
        }
      }
    }
    save(st);
  }

  async function publish(list) {
    const full = Date.now() - lastFull > REFRESH_MS;
    for (const a of list) {
      const s = agentState(a, {
        status: readStatus(a.id, "status.json"),
        lastRun: readStatus(a.id, "last-run.json"),
        lastCheck: readStatus(a.id, "last-check.json"),
        queued: queue.includes(a.id),
        button: st.buttons[a.id]?.entity,
      });
      const key = JSON.stringify(s);
      if (!full && lastPublished[a.id] === key) continue;
      await rest("POST", `states/${sensorId(a.id)}`, s);
      lastPublished[a.id] = key;
    }
    if (full) lastFull = Date.now();
  }

  async function cycle() {
    if (busy) return;
    busy = true;
    try {
      const list = agents();
      await setup(list);
      await poll(list);
      await publish(list);
      warned = "";
    } catch (e) {
      // HA nicht erreichbar o. Ä.: Zeitplan läuft weiter, Meldung nur einmal
      if (e.message !== warned) console.error(`Steuerung (Dashboard „Agenten“): ${e.message}`);
      warned = e.message;
    } finally {
      busy = false;
    }
  }

  cycle();
  setInterval(cycle, 15_000);
  return {
    takeQueued: () => queue.shift(),
    refresh: () => cycle(),
  };
}
