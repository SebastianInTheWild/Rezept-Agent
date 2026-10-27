#!/usr/bin/env node
// Slack-Brücke für die Rezepte: Links und Fotos im Kanal → Agent „rezepte“ legt einen Entwurf an.
// Antwort im Thread eines Vorschlags → Agent überarbeitet den Entwurf. Knöpfe → übernehmen/verwerfen (ohne Claude).
// Freigabe: nur Nachrichten aus SLACK_CHANNEL; wer im Kanal ist, darf schicken und bestätigen.
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "./run-agent.mjs";
import { socket, post, update, react, unreact, download, linksIn, plain, link, respond } from "./lib/slack.mjs";
import { neurons, neuronsText } from "./lib/bild.mjs";
import { REZEPTE, CHANNEL, proposalByThread, applyProposal, rejectProposal, loadStore, cleanup, stats, statsMessage } from "./lib/rezepte.mjs";

const AGENT = process.env.REZEPT_AGENT || "rezepte";
const JOBS = join(REZEPTE, "auftraege");
const INBOX = join(REZEPTE, "inbox");
const log = (m) => console.log(`[${new Date().toLocaleString("de-DE")}] [slack] ${m}`);
const HELP = "Schick mir einen Link zu einem Rezept oder ein Foto (Kochbuchseite, Screenshot, Zettel). Ich lege daraus einen Entwurf in Tandoor an, und du entscheidest mit den Knöpfen.";

mkdirSync(JOBS, { recursive: true });
mkdirSync(INBOX, { recursive: true });

const seen = new Set();
const queue = [];
let working = false;
let warnedChannel = "";

async function onEvent(e) {
  if (e.type !== "message" && e.type !== "app_mention") return;
  if (e.bot_id || !e.user || (e.subtype && e.subtype !== "file_share")) return;
  if (seen.has(e.ts)) return; // Erwähnungen kommen als message und app_mention
  seen.add(e.ts);
  if (seen.size > 500) seen.delete(seen.values().next().value);

  if (!CHANNEL()) {
    if (warnedChannel !== e.channel) log(`Nachricht aus Kanal ${e.channel} – zum Freigeben Umgebungsvariable SLACK_CHANNEL=${e.channel} setzen und Container neu starten`);
    warnedChannel = e.channel;
    return;
  }
  if (e.channel !== CHANNEL()) return;
  const text = e.text || "";

  // Antwort in einem Thread: Änderungswunsch zu einem Vorschlag
  if (e.thread_ts && e.thread_ts !== e.ts) {
    const p = proposalByThread(e.thread_ts);
    if (!p) return;
    if (p.status !== "open") return post(e.channel, "Dieser Vorschlag ist schon erledigt. Für Neues schick mir einfach einen Link oder ein Foto im Kanal.", undefined, e.thread_ts);
    return enqueue({ kind: "revise", proposal: p.id, text: plain(text), channel: e.channel, ts: e.ts, thread_ts: e.thread_ts, user: e.user });
  }

  const urls = linksIn(text);
  const files = (e.files || []).filter((f) => /^image\//.test(f.mimetype || ""));
  if (!urls.length && !files.length) return post(e.channel, HELP, undefined, e.ts);
  const images = [];
  for (const [n, f] of files.entries()) {
    const path = join(INBOX, `${e.ts.replace(".", "-")}-${n + 1}.${(f.filetype || "jpg").replace(/[^a-z0-9]/gi, "")}`);
    writeFileSync(path, await download(f.url_private_download || f.url_private));
    images.push(path);
  }
  enqueue({ kind: "import", urls, images, text: plain(text), channel: e.channel, ts: e.ts, user: e.user });
}

function enqueue(job) {
  const file = join(JOBS, `${job.ts.replace(".", "-")}.json`);
  writeFileSync(file, JSON.stringify({ ...job, created: new Date().toISOString() }, null, 1));
  queue.push({ file, job });
  react(job.channel, job.ts, "eyes");
  log(`Auftrag ${job.kind} von ${job.user}${queue.length > 1 ? ` (Warteschlange: ${queue.length})` : ""}`);
  work();
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const { file, job } = queue.shift();
      process.env.REZEPT_JOB = file;
      const code = await runAgent(AGENT, { by: "slack" }).catch((e) => (log(e.stack || e), -1));
      delete process.env.REZEPT_JOB;
      const done = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      await unreact(job.channel, job.ts, "eyes");
      if (done.result) await react(job.channel, job.ts, "white_check_mark");
      else {
        await react(job.channel, job.ts, "x");
        if (!done.replied) await post(job.channel, `Das hat leider nicht geklappt${code ? ` (Code ${code})` : ""}. Details stehen im Log unter daten/${AGENT}/logs.`, undefined, job.thread_ts || job.ts);
      }
    }
  } finally {
    working = false;
  }
}

// Knöpfe an einem Vorschlag
async function onAction(payload) {
  if (payload.type !== "block_actions") return;
  const a = payload.actions?.[0];
  if (!a?.action_id?.startsWith("rz_")) return;
  const channel = payload.channel?.id;
  if (channel !== CHANNEL()) return;
  const user = payload.user?.id;
  const { ts, blocks = [] } = payload.message;
  const withStatus = (text, keepButtons) => [...blocks.filter((b) => keepButtons || b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text }] }];
  await update(channel, ts, payload.message.text, withStatus("⏳ Einen Moment …", false));
  try {
    let text;
    if (a.action_id === "rz_apply") {
      const r = await applyProposal(a.value, user);
      text = `✅ Übernommen von <@${user}> → ${link(r.url, r.name)}`;
    } else {
      const skip = a.action_id === "rz_skip";
      await rejectProposal(a.value, user, { skip });
      text = skip ? `🚫 <@${user}>: nicht bearbeiten – das Rezept bleibt, wie es ist.` : `🗑️ Verworfen von <@${user}> – Entwurf gelöscht.`;
    }
    await update(channel, ts, payload.message.text, withStatus(text, false));
    log(`${a.action_id} ${a.value} von ${user}`);
  } catch (e) {
    const stillOpen = loadStore().proposals[a.value]?.status === "open";
    await update(channel, ts, payload.message.text, withStatus(`⚠️ ${e.message}`, stillOpen));
    log(`Fehler bei ${a.action_id} ${a.value}: ${e.message}`);
  }
}

if (!process.env.SLACK_APP_TOKEN || !process.env.SLACK_BOT_TOKEN) {
  log("SLACK_APP_TOKEN/SLACK_BOT_TOKEN fehlen – Slack-Brücke startet nicht");
  process.exit(0);
}
log(`Slack-Brücke startet (Kanal ${CHANNEL() || "noch nicht freigegeben"}, Agent ${AGENT})`);
// Slash-Befehle (im Manifest angelegt): /neuronen = heute noch freie Cloudflare-Neuronen für KI-Fotos
// Das Free-Kontingent beginnt um 00:00 UTC neu – hier in Ortszeit
const resetTime = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toLocaleTimeString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
};
async function onCommand(c) {
  if (c.command !== "/neuronen") return respond(c.response_url, `Unbekannter Befehl ${c.command}`);
  const text = await neurons().then((n) => `🧠 Cloudflare Workers AI: ${neuronsText(n)}. Das Kontingent beginnt um ${resetTime()} Uhr neu.`, (e) => `Neuronen nicht abrufbar: ${e.message}`);
  await respond(c.response_url, text);
  log(`/neuronen von ${c.user_id}`);
}

socket({ onEvent, onAction, onCommand, log });

// Einmal täglich alte Dateien wegräumen (Fotos, Eingänge, Aufträge nach 30 Tagen, Sicherungen nach 180 Tagen)
const tidy = () => {
  try {
    const r = cleanup();
    if (Object.keys(r).length) log(`Aufgeräumt: ${Object.entries(r).map(([d, n]) => `${n} in ${d}`).join(", ")}`);
  } catch (e) {
    log(`Aufräumen fehlgeschlagen: ${e.message}`);
  }
};
tidy();
setInterval(tidy, 86_400_000);

// Einmal täglich die Rezept-Statistik in den Kanal. Uhrzeit aus zeitplan.conf („rezept-statistik = 19:00“,
// auch mit Wochentagen „Mo,Mi,Fr 19:00“ oder „aus“), sonst REZEPT_STATISTIK, sonst 19:00. Die Datei wird jede Minute
// neu gelesen, Änderungen gelten also ohne Neustart. Lief die Brücke zur Uhrzeit nicht, wird am selben Tag nachgeholt.
const STATS_FILE = join(REZEPTE, "statistik.json");
const SCHEDULE_FILE = process.env.SCHEDULE_FILE || join(process.env.AGENTS_DIR || "/data/agents", "..", "zeitplan.conf");
const tz = process.env.TZ || "Europe/Berlin";
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
let lastPlan = "";

function statsPlan() {
  let raw = (process.env.REZEPT_STATISTIK || "19:00").trim();
  let source = process.env.REZEPT_STATISTIK ? "REZEPT_STATISTIK" : "Standard";
  try {
    const line = readFileSync(SCHEDULE_FILE, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).find((l) => /^rezept-statistik\s*[=:]/.test(l));
    if (line) [raw, source] = [line.replace(/^rezept-statistik\s*[=:]\s*/, "").trim(), "zeitplan.conf"];
  } catch {}
  if (/^(aus|off|-)?$/i.test(raw)) return { off: true, raw: "aus", source };
  const m = /^(?:([A-Za-z,]+)\s+)?(\d{1,2}:\d{2})$/.exec(raw);
  const days = m?.[1] ? m[1].split(",").map((d) => d.trim()) : WEEKDAYS;
  if (!m || !days.every((d) => WEEKDAYS.includes(d))) return { error: `„${raw}“ nicht verstanden (Beispiel: rezept-statistik = 19:00)`, raw, source };
  return { days, time: m[2].padStart(5, "0"), raw, source };
}

async function dailyStats() {
  const plan = statsPlan();
  const desc = plan.off ? "aus" : plan.error || `${plan.raw} (${plan.source})`;
  if (desc !== lastPlan) log(`Rezept-Statistik: ${desc}`);
  lastPlan = desc;
  if (plan.off || plan.error || !CHANNEL()) return;
  const now = new Date();
  const today = now.toLocaleDateString("sv-SE", { timeZone: tz });
  const hhmm = now.toLocaleTimeString("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const weekday = now.toLocaleDateString("de-DE", { timeZone: tz, weekday: "short" }).replace(".", "");
  const last = existsSync(STATS_FILE) ? JSON.parse(readFileSync(STATS_FILE, "utf8")).last : "";
  if (last === today || !plan.days.includes(weekday) || hhmm < plan.time) return;
  writeFileSync(STATS_FILE, JSON.stringify({ last: today }));
  try {
    const s = await stats(now);
    await post(CHANNEL(), statsMessage(s, now));
    log(`Statistik gesendet: ${s.checked}/${s.total} geprüft, ${s.todo} noch zu prüfen`);
  } catch (e) {
    log(`Statistik fehlgeschlagen: ${e.message}`);
  }
}
dailyStats();
setInterval(dailyStats, 60_000);
