// Verpasste Slack-Nachrichten und Selbstheilung, wenn Slack nicht erreichbar ist.
// Autor: SebastianInTheWild · MIT-Lizenz
//
// Verpasst: Socket Mode stellt Nachrichten nur zu, solange die Brücke verbunden ist. Die Brücke merkt sich deshalb die
// letzte Nachricht im Kanal (eingang.json) und sieht nach jedem Verbinden im Verlauf nach, was seitdem kam. Gibt es
// etwas, fragt sie im Kanal mit „Nachholen“ / „Verwerfen“ (verpasst.json). Nur Nachrichten im Kanal, keine Thread-Antworten.
//
// Selbstheilung: Scheitert die Verbindung zu Slack länger als SELBSTHEILUNG_MIN Minuten (Standard 30, „aus“ = nie),
// fordert die Brücke einen Neustart des Containers an (holt u. a. den aktuellen DNS-Server des Hosts).
// Höchstens einmal in SELBSTHEILUNG_PAUSE_H Stunden (Standard 6), damit ein echter Ausfall keine Neustart-Schleife wird.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Nachrichten, die älter sind, werden nicht mehr zum Nachholen angeboten. */
export const MISSED_DAYS = 3;

const read = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const seenFile = (dir) => join(dir, "eingang.json");
/** Zeitstempel (Slack-ts) der letzten Nachricht im Kanal, die die Brücke gesehen hat; null = noch nie. */
export const lastSeen = (dir) => read(seenFile(dir), null)?.ts || null;
/** Nur vorwärts: ein älterer ts überschreibt einen neueren nicht. */
export function markSeen(dir, ts) {
  const last = lastSeen(dir);
  if (last && Number(last) >= Number(ts)) return;
  writeFileSync(seenFile(dir), JSON.stringify({ ts, at: new Date().toISOString() }));
}

/** Nachrichten von Menschen, wie onEvent sie annimmt (ohne Bots, ohne Systemmeldungen, Dateien erlaubt). */
const fromPerson = (m) => m.user && !m.bot_id && (!m.subtype || m.subtype === "file_share");

/**
 * Verpasste Nachrichten aus conversations.history: nach `since`, von Menschen, keine Thread-Antworten,
 * höchstens MISSED_DAYS alt, ohne die schon bekannten (known: ts mit Auftragsdatei o. Ä.). Älteste zuerst.
 */
export function missedMessages(messages = [], { since, now = Date.now(), known = () => false } = {}) {
  const oldest = now / 1000 - MISSED_DAYS * 86_400;
  return messages
    .filter((m) => fromPerson(m) && Number(m.ts) > Number(since) && Number(m.ts) >= oldest)
    .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
    .filter((m) => !known(m.ts))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** Kurzer Text für die Liste im Kanal: Text ohne Zeilenumbrüche, sonst „📎 Datei“. */
export function preview(m, max = 80) {
  const text = String(m.text || "").replace(/\s+/g, " ").trim();
  if (!text) return m.files?.length ? `📎 ${m.files.length === 1 ? "Datei" : `${m.files.length} Dateien`}` : "…";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

// Offene Rückfragen „Nachholen?“: { [id]: { status, messages, at } }
const missedFile = (dir) => join(dir, "verpasst.json");
export const loadMissed = (dir) => read(missedFile(dir), {});
export const saveMissed = (dir, all) => writeFileSync(missedFile(dir), JSON.stringify(all, null, 1));

// ---------- Selbstheilung ----------
const healFile = (dir) => join(dir, "selbstheilung.json");
/** Minuten ohne Verbindung bis zum Neustart; null = aus. */
export function healMinutes(env = process.env) {
  const raw = String(env.SELBSTHEILUNG_MIN ?? "").trim();
  if (/^(aus|off|nein|0)$/i.test(raw)) return null;
  return Math.max(5, Number(raw) || 30);
}
export const healPauseHours = (env = process.env) => Math.max(1, Number(env.SELBSTHEILUNG_PAUSE_H) || 6);

/** Soll jetzt ein Neustart angefordert werden? down = ms seit dem ersten Fehlschlag in Folge. */
export function shouldHeal(dir, down, now = Date.now(), env = process.env) {
  const min = healMinutes(env);
  if (min === null || down < min * 60_000) return false;
  const last = Date.parse(read(healFile(dir), {}).at || 0) || 0;
  return now - last >= healPauseHours(env) * 3_600_000;
}
export const markHealed = (dir, down, now = Date.now()) => writeFileSync(healFile(dir), JSON.stringify({ at: new Date(now).toISOString(), down_min: Math.round(down / 60_000) }));
export const healedBefore = (dir) => existsSync(healFile(dir)) && read(healFile(dir), null);
