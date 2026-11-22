// Wöchentlicher Neustart und offene Aufträge nach einem Neustart.
// Autor: SebastianInTheWild · MIT-Lizenz
//
// Warum ein Neustart: Docker übernimmt den DNS-Server des Hosts nur beim Containerstart. Ändert sich das Heimnetz
// (neuer Router, neue Adressen), scheitern sonst alle Verbindungen nach außen („fetch failed“), bis jemand neu startet.
// zeitplan.conf: „neustart = So 04:00“ (Standard), andere Tage/Zeiten wie bei den Agenten, „aus“ schaltet ab.
// Der Neustart wartet, bis kein Agent mehr läuft, auch keiner aus Slack.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESTART_ID = "neustart";
export const RESTART_DEFAULT = "So 04:00";
/** Aufträge, die älter sind, setzt die Slack-Brücke nach einem Neustart nicht mehr fort. */
export const RESUME_HOURS = 24;
/** So oft wird ein Auftrag nach einem Neustart höchstens neu begonnen (falls er selbst den Absturz auslöst). */
export const RESUME_MAX = 2;

// Neustart von Hand (Slack „/neustart“): die Brücke legt eine Anfrage ab, der Zeitplan startet neu, sobald kein Agent läuft.
// Die Brücke kann den Container nicht selbst beenden – ihr Ende startet nur die Brücke neu (start.sh).
const requestFile = () => join(process.env.DATA_DIR || "/data", "neustart-anfrage.json");
export const requestRestart = (by) => writeFileSync(requestFile(), JSON.stringify({ at: new Date().toISOString(), by }));
export const restartRequest = () => {
  try {
    return JSON.parse(readFileSync(requestFile(), "utf8"));
  } catch {
    return null;
  }
};
export const clearRestartRequest = () => rmSync(requestFile(), { force: true });

/** Zeiten des Neustarts aus dem geparsten Zeitplan ({ id: [slots] }); [] = aus. */
export const restartSlots = (plan = {}) => (RESTART_ID in plan ? plan[RESTART_ID] : [RESTART_DEFAULT]);

/** Ein Auftrag ist offen, wenn der Agent weder ein Ergebnis noch eine Antwort eingetragen hat. */
const isOpen = (job) => !job.result && !job.replied;

/**
 * Offene Aufträge aus daten/rezepte/auftraege, die nach einem Neustart fortgesetzt werden sollen:
 * ohne Ergebnis, höchstens RESUME_HOURS alt und noch nicht RESUME_MAX-mal neu begonnen. Älteste zuerst.
 */
export function openJobs(dir, now = Date.now()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const file = join(dir, f);
      try {
        return { file, job: JSON.parse(readFileSync(file, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.job.ts && x.job.channel && isOpen(x.job))
    .filter(({ job }) => now - (Date.parse(job.created) || 0) <= RESUME_HOURS * 3_600_000)
    .filter(({ job }) => (job.resumed || 0) < RESUME_MAX)
    .sort((a, b) => (Date.parse(a.job.created) || 0) - (Date.parse(b.job.created) || 0));
}

/** Zählt den Neubeginn im Auftrag mit (damit ein Auftrag, der jedes Mal abstürzt, nicht endlos wiederholt wird). */
export function markResumed(file, job) {
  const next = { ...job, resumed: (job.resumed || 0) + 1 };
  writeFileSync(file, JSON.stringify(next, null, 1));
  return next;
}
