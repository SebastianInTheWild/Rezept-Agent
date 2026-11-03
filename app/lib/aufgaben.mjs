// Feste Aufgaben der Slack-Brücke (keine Agenten): Uhrzeit aus zeitplan.conf („koch-frage = 20:30“,
// „wochenrueckblick = So 19:30“, mit Wochentagen „Mo,Mi 19:00“, „aus“ schaltet ab), sonst der Standard.
// Läuft höchstens einmal pro Tag; war die Brücke zur Uhrzeit aus, wird am selben Tag nachgeholt.
// Stand in daten/rezepte/aufgaben.json: { <id>: "<letzter Tag>" }
// Autor: SebastianInTheWild · MIT-Lizenz

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE = () => join(DATA_DIR, "rezepte", "aufgaben.json");
const SCHEDULE_FILE = () => process.env.SCHEDULE_FILE || join(process.env.AGENTS_DIR || "/data/agents", "..", "zeitplan.conf");
export const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const tz = () => process.env.TZ || "Europe/Berlin";

/** { days, time } bzw. { off } oder { error } für einen Eintrag in zeitplan.conf */
export function planOf(id, fallback) {
  // Vorgabe auch als Umgebungsvariable: koch-frage → KOCH_FRAGE (z. B. „aus“), zeitplan.conf hat Vorrang
  const envKey = id.toUpperCase().replace(/-/g, "_");
  const fromEnv = (process.env[envKey] || "").trim();
  let raw = fromEnv || fallback;
  let source = fromEnv ? envKey : "Standard";
  try {
    const re = new RegExp(`^${id.replace(/[.-]/g, "\\$&")}\\s*[=:]`);
    const line = readFileSync(SCHEDULE_FILE(), "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).find((l) => re.test(l));
    if (line) [raw, source] = [line.replace(re, "").trim(), "zeitplan.conf"];
  } catch {}
  if (/^(aus|off|-)?$/i.test(raw)) return { off: true, raw: "aus", source };
  const m = /^(?:([A-Za-z,]+)\s+)?(\d{1,2}:\d{2})$/.exec(raw);
  const days = m?.[1] ? m[1].split(",").map((d) => d.trim()) : WEEKDAYS;
  if (!m || !days.every((d) => WEEKDAYS.includes(d))) return { error: `„${raw}“ nicht verstanden (Beispiel: ${id} = ${fallback})`, raw, source };
  return { days, time: m[2].padStart(5, "0"), raw, source };
}

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE(), "utf8"));
  } catch {
    return {};
  }
};

/** Ist die Aufgabe jetzt fällig? Dann gleich als erledigt für heute vermerken (kein doppelter Lauf). */
export function takeDue(id, fallback, now = new Date()) {
  const plan = planOf(id, fallback);
  if (plan.off || plan.error) return { due: false, plan };
  const today = now.toLocaleDateString("sv-SE", { timeZone: tz() });
  const hhmm = now.toLocaleTimeString("de-DE", { timeZone: tz(), hour: "2-digit", minute: "2-digit" });
  const weekday = now.toLocaleDateString("de-DE", { timeZone: tz(), weekday: "short" }).replace(".", "");
  const state = readState();
  if (state[id] === today || !plan.days.includes(weekday) || hhmm < plan.time) return { due: false, plan };
  state[id] = today;
  mkdirSync(dirname(STATE()), { recursive: true });
  writeFileSync(STATE(), JSON.stringify(state, null, 1));
  return { due: true, plan };
}

/** Jede Minute prüfen und fn() ausführen, wenn fällig. log meldet geänderte Einstellungen und Fehler. */
export function every(id, fallback, fn, log) {
  let last = "";
  const tick = async () => {
    const { due, plan } = takeDue(id, fallback);
    const desc = plan.off ? "aus" : plan.error || `${plan.raw} (${plan.source})`;
    if (desc !== last) log(`${id}: ${desc}`);
    last = desc;
    if (due) await Promise.resolve(fn()).catch((e) => log(`${id} fehlgeschlagen: ${e.message}`));
  };
  tick();
  return setInterval(tick, 60_000);
}
