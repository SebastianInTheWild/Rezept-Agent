// Google-Gemini-Nutzung mitzählen (Bilder und Video-Auswertung) und Kosten schätzen – für Slack „/google“.
// Google liefert den Kontostand nicht über den API-Schlüssel; deshalb zählt der Agent jeden eigenen Aufruf mit
// (Tokens aus usageMetadata der Antwort) und rechnet mit den Preisen unten. Verbindlich ist die Google-Cloud-Abrechnung.
// Gespeichert in daten/rezepte/google-nutzung.json, je Kalendermonat (Zeitzone TZ) und Tag.
// Einstellungen: GOOGLE_GUTHABEN (Dollar pro Monat, z. B. 10 aus Google AI Pro) → Rest und Warnung bei 80 %;
// GOOGLE_PREIS_BILD (Dollar pro Bild, sonst nach Modell), GEMINI_PREIS_EINGABE / GEMINI_PREIS_AUSGABE (Dollar pro 1 Mio. Tokens, Videos).
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { L, locale } from "./i18n.mjs";
import { post, slackReady } from "./slack.mjs";

const FILE = () => join(process.env.DATA_DIR || "/data", "rezepte", "google-nutzung.json");
const tz = () => process.env.TZ || "Europe/Berlin";
const day = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: tz() }); // 2026-11-02
const month = (d = new Date()) => day(d).slice(0, 7); // 2026-11

// Ungefähre Preise in US-Dollar (Stand 11/2026, ohne Gewähr) – in den Einstellungen überschreibbar
const IMAGE_PRICE = { "gemini-nano-banana-2.1": 0.034, "gemini-2.5-flash-image": 0.039, "gemini-3-pro-image": 0.134, "gemini-3-pro-image-preview": 0.134 };
const num = (v, fallback) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};
export const imagePriceFor = (model) => num(process.env.GOOGLE_PREIS_BILD, IMAGE_PRICE[model] ?? null);
const tokenPrice = () => ({ input: num(process.env.GEMINI_PREIS_EINGABE, 0.75), output: num(process.env.GEMINI_PREIS_AUSGABE, 3.75) });
export const budget = () => num(process.env.GOOGLE_GUTHABEN, null);

const read = () => {
  try {
    return JSON.parse(readFileSync(FILE(), "utf8"));
  } catch {
    return { months: {} };
  }
};
const write = (data) => {
  mkdirSync(dirname(FILE()), { recursive: true });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, FILE());
};

/** Tokens aus der Antwort von Google */
export const usageOf = (j) => ({ input: j?.usageMetadata?.promptTokenCount || 0, output: (j?.usageMetadata?.candidatesTokenCount || 0) + (j?.usageMetadata?.thoughtsTokenCount || 0) });

/**
 * Einen Aufruf verbuchen. kind = "bild" | "video". Bilder kosten pauschal pro Bild (nach Modell),
 * Videos nach Tokens. Liefert die geschätzten Kosten des Aufrufs.
 */
export function record(kind, model, usage = {}) {
  const p = tokenPrice();
  const cost = kind === "bild" ? imagePriceFor(model) ?? ((usage.input || 0) * p.input + (usage.output || 0) * p.output) / 1e6 : ((usage.input || 0) * p.input + (usage.output || 0) * p.output) / 1e6;
  try {
    const data = read();
    const m = (data.months[month()] ||= { images: 0, videos: 0, input: 0, output: 0, image_cost: 0, video_cost: 0, days: {}, models: {} });
    if (kind === "bild") (m.images++, (m.image_cost += cost));
    else (m.videos++, (m.video_cost += cost), (m.video_tokens = (m.video_tokens || 0) + (usage.input || 0) + (usage.output || 0)));
    m.input += usage.input || 0;
    m.output += usage.output || 0;
    m.days[day()] = (m.days[day()] || 0) + cost;
    if (kind === "bild") m.models[model] = (m.models[model] || 0) + 1;
    write(data);
    warnIfNeeded(data, m);
  } catch (e) {
    console.error(`[google] Nutzung nicht gespeichert: ${e.message}`);
  }
  return cost;
}

// Einmal pro Monat warnen, wenn 80 % des Guthabens verbraucht sind
function warnIfNeeded(data, m) {
  const b = budget();
  const used = m.image_cost + m.video_cost;
  if (!b || m.warned || used < 0.8 * b || !slackReady() || !process.env.SLACK_CHANNEL) return;
  m.warned = new Date().toISOString();
  write(data);
  post(process.env.SLACK_CHANNEL, L(`⚠️ *Google-Guthaben fast aufgebraucht:* diesen Monat ca. ${usd(used)} von ${usd(b)} verbraucht (${Math.round((100 * used) / b)} %). \`/google\` zeigt Details.`, `⚠️ *Google credit almost used up:* about ${usd(used)} of ${usd(b)} used this month (${Math.round((100 * used) / b)} %). \`/google\` shows details.`)).catch(() => {});
}

const usd = (n) => L(`${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`, `$${n.toFixed(2)}`);
const tokens = (n) => n.toLocaleString(locale());

/** Text für Slack „/google“ */
export function usageMessage(now = new Date()) {
  const data = read();
  const m = data.months[month(now)];
  const name = now.toLocaleDateString(locale(), { timeZone: tz(), month: "long", year: "numeric" });
  const b = budget();
  const lines = [`💳 *Google Gemini* · ${name}`];
  if (!m) {
    lines.push(L("Diesen Monat noch keine Aufrufe gezählt.", "No calls counted this month yet."));
  } else {
    const used = m.image_cost + m.video_cost;
    const models = Object.entries(m.models)
      .map(([k, v]) => `${k} ×${v}`)
      .join(", ");
    lines.push(L(`• Bilder: *${m.images}* · ca. ${usd(m.image_cost)}`, `• Pictures: *${m.images}* · about ${usd(m.image_cost)}`) + (models ? ` (${models})` : ""));
    if (m.videos) lines.push(L(`• Videos: *${m.videos}* ausgewertet · ${tokens(m.video_tokens || 0)} Tokens · ca. ${usd(m.video_cost)}`, `• Videos: *${m.videos}* analysed · ${tokens(m.video_tokens || 0)} tokens · about ${usd(m.video_cost)}`));
    lines.push(L(`• Zusammen: *ca. ${usd(used)}* – davon heute ${usd(m.days[day(now)] || 0)}`, `• Total: *about ${usd(used)}* – today ${usd(m.days[day(now)] || 0)}`));
    if (b) lines.push(L(`• Guthaben: ca. *${usd(Math.max(0, b - used))}* von ${usd(b)} übrig (${Math.round((100 * used) / b)} % verbraucht)`, `• Credit: about *${usd(Math.max(0, b - used))}* of ${usd(b)} left (${Math.round((100 * used) / b)} % used)`));
  }
  const prev = data.months[month(new Date(now.getFullYear(), now.getMonth() - 1, 15))];
  if (prev) lines.push(L(`• Vormonat: ca. ${usd(prev.image_cost + prev.video_cost)} (${prev.images} Bilder, ${prev.videos} Videos)`, `• Last month: about ${usd(prev.image_cost + prev.video_cost)} (${prev.images} pictures, ${prev.videos} videos)`));
  if (!b) lines.push(L("_Monatliches Guthaben eintragen (Einstellungen → KI-Fotos), dann zeige ich auch den Rest._", "_Enter your monthly credit (Settings → AI photos) and I'll show what's left._"));
  lines.push(L("_Geschätzt aus den eigenen Aufrufen des Agenten – verbindlich ist die Google-Cloud-Abrechnung._", "_Estimated from the agent's own calls – the Google Cloud billing is what counts._"));
  return lines.join("\n");
}

export const hasUsage = () => existsSync(FILE());
