// Gemeinsame Hilfen für Agenten, die einen Bericht schicken: Der Agent schreibt <AGENT_DATA>/report.json,
// das Werkzeug prüft ihn und schickt den Push. So muss kein Text mit Sonderzeichen über die Kommandozeile.
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notify } from "./ha.mjs";

export const agentData = () => process.env.AGENT_DATA || join(process.env.DATA_DIR || "/data", process.env.AGENT_ID || "agent");
export const out = (x) => console.log(JSON.stringify(x, null, 1));

export function loadJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

export function saveJson(file, data) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
}

/** Liest report.json: {title, message, ...}. message leer = nichts zu melden (kein Push). */
export function readReport() {
  const file = join(agentData(), "report.json");
  if (!existsSync(file)) return { ok: false, errors: [`Kein Bericht: ${file} fehlt`] };
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`report.json ist kein gültiges JSON: ${e.message}`] };
  }
  const errors = [];
  if (report.message && !report.title?.trim()) errors.push("title fehlt");
  if ((report.message || "").length > 3500) errors.push("message ist zu lang (höchstens 3500 Zeichen)");
  return errors.length ? { ok: false, errors } : { ok: true, report, file };
}

/** Legt ein Dashboard (nur Admins, in der Seitenleiste) bei Bedarf an und speichert seine Konfiguration. */
export async function saveDashboard(call, { url, title, icon }, config) {
  const list = await call({ type: "lovelace/dashboards/list" });
  const created = !list.some((d) => d.url_path === url);
  if (created) await call({ type: "lovelace/dashboards/create", url_path: url, title, icon, show_in_sidebar: true, require_admin: true, mode: "storage" });
  await call({ type: "lovelace/config/save", url_path: url, config });
  return created;
}

export const stamp = () => new Date().toLocaleString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });
export const SEVERITIES = { hoch: "🔴", mittel: "🟠", niedrig: "🟡" };
export const oneLine = (s) => String(s ?? "").replace(/\n/g, " ").trim();

/** Schickt den Bericht als Push (außer bei DRY=1) und löscht report.json. */
export async function sendReport(call, { report, file }) {
  const dry = process.env.DRY === "1";
  if (report.message?.trim() && !dry) await notify(call, report.title.trim(), report.message.trim());
  if (!dry) rmSync(file, { force: true });
  return { sent: Boolean(report.message?.trim()) && !dry, dry };
}
