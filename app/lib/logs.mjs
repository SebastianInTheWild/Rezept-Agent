// Log-Detektiv: neue Fehler aus dem HA-Protokoll (system_log), bekannte und harmlose werden gemerkt.
// Autor: SebastianInTheWild · MIT-Lizenz

import { createHash } from "node:crypto";
import { join } from "node:path";
import { SEVERITIES, agentData, loadJson, oneLine, out, readReport, saveDashboard, saveJson, sendReport, stamp } from "./report.mjs";

const LEVELS = (process.env.LOG_LEVELS || "ERROR,CRITICAL").split(",").map((s) => s.trim().toUpperCase());
const stateFile = () => join(agentData(), "logs-state.json");
const DASHBOARD = process.env.LOG_DASHBOARD || "log-detektiv";
const HISTORY = 14; // so viele Berichte zeigt das Dashboard im Verlauf

function dashboardConfig(state) {
  const [last, ...older] = state.reports || [];
  const findings = [...(last?.findings || [])].sort((a, b) => Object.keys(SEVERITIES).indexOf(a.severity) - Object.keys(SEVERITIES).indexOf(b.severity));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const sections = [
    {
      type: "grid",
      cards: [
        { type: "heading", heading: "Übersicht", icon: "mdi:text-search" },
        {
          type: "markdown",
          content:
            `## 🔎 Log-Detektiv\n**Letzter Bericht:** ${last ? last.when : "noch keiner"}` +
            (last ? ` · ${findings.length ? Object.entries(SEVERITIES).map(([s, i]) => `${i} ${count(s)} ${s}`).join(" · ") : "✅ nichts Wichtiges"}` : "") +
            ` · ${Object.keys(state.harmless || {}).length} Meldungen als harmlos bekannt` +
            (last?.summary ? `\n\n${last.summary}` : ""),
        },
      ],
    },
  ];
  for (const [sev, icon] of Object.entries(SEVERITIES)) {
    const list = findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    sections.push({
      type: "grid",
      cards: [
        { type: "heading", heading: `${icon} Dringlichkeit ${sev}` },
        ...list.map((f) => ({
          type: "markdown",
          content:
            `### ${oneLine(f.title)}\n` +
            (f.count ? `*${oneLine(f.count)}*\n\n` : "") +
            `**Ursache:** ${oneLine(f.cause)}\n\n**Was tun:** ${oneLine(f.action)}`,
        })),
      ],
    });
  }
  if (older.length) {
    sections.push({
      type: "grid",
      cards: [
        { type: "heading", heading: "Verlauf", icon: "mdi:history" },
        {
          type: "markdown",
          content: older
            .map((r) => `**${r.when}** – ${r.findings?.length ? r.findings.map((f) => `${SEVERITIES[f.severity] || ""} ${oneLine(f.title)}`).join(", ") : "nichts Wichtiges"}`)
            .join("\n\n"),
        },
      ],
    });
  }
  const harmless = Object.values(state.harmless || {}).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  if (harmless.length) {
    sections.push({
      type: "grid",
      cards: [
        { type: "heading", heading: "Als harmlos bekannt", icon: "mdi:check-decagram-outline" },
        {
          type: "markdown",
          content:
            "Diese Meldungen werden nicht mehr gemeldet.\n\n| Quelle | Meldung | Grund |\n|---|---|---|\n" +
            harmless.map((h) => `| ${oneLine(h.logger).replace(/^homeassistant\.components\./, "").replace(/\|/g, "/")} | ${oneLine(h.text).slice(0, 80).replace(/\|/g, "/")} | ${oneLine(h.reason).replace(/\|/g, "/")} |`).join("\n"),
        },
      ],
    });
  }
  return { title: "Log-Detektiv", views: [{ title: "Bericht", path: "bericht", icon: "mdi:text-search", type: "sections", max_columns: 3, sections }] };
}

// Gleiche Meldung = gleiche Quelle + gleicher Text ohne Zahlen, IDs und Adressen (die ändern sich bei jedem Auftreten)
function keyOf(e) {
  const text = String(e.message?.[0] || "")
    .replace(/0x[0-9a-f]+/gi, "#")
    .replace(/\b\d+(\.\d+)*\b/g, "#")
    .replace(/[0-9a-f]{8,}/gi, "#")
    .slice(0, 200);
  return createHash("sha1").update(`${e.name}|${(e.source || []).join(":")}|${text}`).digest("hex").slice(0, 12);
}

async function newEntries(call) {
  const state = loadJson(stateFile(), { seen: {}, harmless: {} });
  const entries = await call({ type: "system_log/list" });
  return entries
    .filter((e) => LEVELS.includes(String(e.level).toUpperCase()))
    .map((e) => ({ ...e, key: keyOf(e) }))
    .filter((e) => !state.seen[e.key] && !state.harmless[e.key])
    .map((e) => ({
      key: e.key,
      level: e.level,
      logger: e.name,
      source: (e.source || []).join(":"),
      count: e.count,
      first: new Date(e.first_occurred * 1000).toISOString(),
      last: new Date(e.timestamp * 1000).toISOString(),
      message: (e.message || []).slice(0, 3).map((m) => String(m).slice(0, 600)),
      exception: e.exception ? String(e.exception).slice(-1500) : undefined,
    }));
}

export async function logs(call, cmd, args) {
  if (cmd === "pending") {
    const list = await newEntries(call);
    return args.includes("--count") ? console.log(list.length) : out(list);
  }
  if (cmd === "harmless") {
    const state = loadJson(stateFile(), { seen: {}, harmless: {} });
    return out(Object.entries(state.harmless).map(([key, v]) => ({ key, ...v })));
  }
  if (cmd === "report") {
    // report.json: {title, message, summary, findings: [{severity, title, count, cause, action}], harmless: [{key, reason}]}
    const r = readReport();
    if (!r.ok) return out(r);
    const findings = r.report.findings || [];
    const ferr = [];
    for (const f of findings) {
      if (!SEVERITIES[f.severity]) ferr.push(`findings: severity muss ${Object.keys(SEVERITIES).join("/")} sein`);
      if (!f.title?.trim() || !f.cause?.trim() || !f.action?.trim()) ferr.push("findings: title, cause und action nötig");
    }
    if (ferr.length) return out({ ok: false, errors: [...new Set(ferr)] });
    const list = await newEntries(call);
    const known = new Map(list.map((e) => [e.key, e]));
    const harmless = r.report.harmless || [];
    const bad = harmless.filter((h) => !known.has(h.key)).map((h) => h.key);
    if (bad.length) return out({ ok: false, errors: [`Unbekannte keys in harmless: ${bad.join(", ")}`] });
    const res = await sendReport(call, r);
    const state = loadJson(stateFile(), { seen: {}, harmless: {} });
    const now = new Date().toISOString();
    for (const e of list) state.seen[e.key] = { at: now, logger: e.logger, text: e.message[0]?.slice(0, 120) };
    for (const h of harmless) state.harmless[h.key] = { at: now, logger: known.get(h.key).logger, text: known.get(h.key).message[0]?.slice(0, 120), reason: h.reason || "" };
    state.reports = [{ at: now, when: stamp(), summary: r.report.summary || "", findings }, ...(state.reports || [])].slice(0, HISTORY);
    const config = dashboardConfig(state);
    if (res.dry) return out({ ok: true, ...res, marked_seen: list.length, harmless: harmless.length, dashboard: config });
    saveJson(stateFile(), state);
    const created = await saveDashboard(call, { url: DASHBOARD, title: "Log-Detektiv", icon: "mdi:text-search" }, config);
    return out({ ok: true, ...res, marked_seen: list.length, harmless: harmless.length, dashboard: `/${DASHBOARD}/bericht`, created });
  }
  throw new Error(`Unbekannter Befehl: logs ${cmd}`);
}
