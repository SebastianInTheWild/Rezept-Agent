#!/usr/bin/env node
// Slack-Brücke für die Rezepte: Links und Fotos im Kanal → Agent „rezepte“ legt einen Entwurf an.
// Antwort im Thread eines Vorschlags → Agent überarbeitet den Entwurf. Knöpfe → übernehmen/verwerfen (ohne Claude).
// Freigabe: nur Nachrichten aus SLACK_CHANNEL; wer im Kanal ist, darf schicken und bestätigen.
// Autor: SebastianInTheWild · MIT-Lizenz

import "./lib/umgebung.mjs"; // zuerst: Einstellungen aus der Weboberfläche in process.env
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent, readStatus, requestStart, hasStartRequest, retryMinutes } from "./run-agent.mjs";
import { slack, socket, post, update, react, unreact, download, linksIn, plain, link, esc, respond } from "./lib/slack.mjs";
import { syncManifest, manifestSyncReady } from "./lib/manifest.mjs";
import { neurons, neuronsText, googleReady, googleModel, googlePrice } from "./lib/bild.mjs";
import { usageMessage } from "./lib/google-nutzung.mjs";
import { L, locale, recipes as rezepte, cmd, canonicalCommand } from "./lib/i18n.mjs";
import { planByThread, openPlans, resendPlan, applyPlan, rejectPlan, findByIngredients, servingsDefault, MAX_DAYS } from "./lib/wochenplan.mjs";
import { REZEPTE, CHANNEL, proposalByThread, applyProposal, rejectProposal, regenerateDraftImage, resendProposal, loadStore, cleanup, stats, statsMessage, pending, perDay, setPerDay, addToday, openProposals, findRecipes, recipesWithoutImage, postWithoutImage, generateRecipeImage, noImageMessage, allRecipeIds, resolveRecipe, reconcileAiImages } from "./lib/rezepte.mjs";

const AGENT = process.env.REZEPT_AGENT || "rezepte";
const PLAN_AGENT = process.env.WOCHENPLAN_AGENT || "wochenplan";
const JOBS = join(REZEPTE, "auftraege");
const INBOX = join(REZEPTE, "inbox");
const log = (m) => console.log(`[${new Date().toLocaleString("de-DE")}] [slack] ${m}`);
const HELP = () =>
  L(
    "Schick mir einen Link zu einem Rezept (auch HelloFresh), ein Instagram-Reel oder YouTube-Short, ein Foto (Kochbuchseite, Screenshot, Zettel) oder den Rezepttext selbst. Ich lege daraus einen Entwurf in Tandoor an, und du entscheidest mit den Knöpfen.",
    "Send me a link to a recipe (HelloFresh too), an Instagram reel or YouTube short, a photo (cookbook page, screenshot, note) or the recipe text itself. I'll create a draft in Tandoor, and you decide with the buttons.",
  );
// Reiner Text gilt als Rezept, wenn er lang genug ist (z. B. eine kopierte Bildunterschrift) – kurze Nachrichten bekommen die Hilfe
const looksLikeRecipe = (t) => t.length >= 80 || t.split("\n").filter((l) => l.trim()).length >= 3;

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
    if (!p) {
      // Antwort auf einen Wochenplan: Plan überarbeiten
      const plan = planByThread(e.thread_ts);
      if (!plan) return;
      if (plan.status !== "open") return post(e.channel, L("Dieser Plan ist schon erledigt. Einen neuen gibt es mit /wochenplan.", "This plan has already been decided. Get a new one with /meal-plan."), undefined, e.thread_ts);
      return enqueue({ kind: "plan-revise", agent: PLAN_AGENT, plan: plan.id, servings: plan.servings, text: plain(text), channel: e.channel, ts: e.ts, thread_ts: e.thread_ts, user: e.user });
    }
    if (p.status !== "open") return post(e.channel, L("Dieser Vorschlag ist schon erledigt. Für Neues schick mir einfach einen Link oder ein Foto im Kanal.", "This proposal has already been decided. For something new, just send me a link or a photo in the channel."), undefined, e.thread_ts);
    return enqueue({ kind: "revise", proposal: p.id, text: plain(text), channel: e.channel, ts: e.ts, thread_ts: e.thread_ts, user: e.user });
  }

  const urls = linksIn(text);
  const files = (e.files || []).filter((f) => /^image\//.test(f.mimetype || ""));
  if (!urls.length && !files.length && !looksLikeRecipe(plain(text))) return post(e.channel, HELP(), undefined, e.ts);
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
      const agent = job.agent || AGENT;
      const code = await runAgent(agent, { by: "slack" }).catch((e) => (log(e.stack || e), -1));
      delete process.env.REZEPT_JOB;
      const done = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      // Am Claude-Limit gescheitert: Auftrag später noch einmal (höchstens 24 Stunden lang), Hinweis im Thread
      const last = readStatus(agent, "last-run.json");
      if (!done.result && !done.replied && last?.limit) {
        const tries = (job.tries || 0) + 1;
        if (tries * retryMinutes() <= 24 * 60) {
          const at = new Date(Date.now() + retryMinutes() * 60_000);
          const when = at.toLocaleTimeString(locale(), { timeZone: process.env.TZ || "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
          if (tries === 1) await post(job.channel, L(`⏳ Das Claude-Limit ist gerade erreicht. Ich versuche es um ${when} noch einmal – du musst nichts tun.`, `⏳ The Claude limit is reached right now. I'll try again at ${when} – nothing to do for you.`), undefined, job.thread_ts || job.ts);
          log(`Claude-Limit – Auftrag ${job.kind} wird um ${when} wiederholt (Versuch ${tries + 1})`);
          setTimeout(() => (queue.push({ file, job: { ...job, tries } }), work()), at - Date.now());
          continue;
        }
      }
      await unreact(job.channel, job.ts, "eyes");
      if (done.result) await react(job.channel, job.ts, "white_check_mark");
      else {
        await react(job.channel, job.ts, "x");
        if (!done.replied) await post(job.channel, L(`Das hat leider nicht geklappt${code ? ` (Code ${code})` : ""}. Details stehen im Log unter daten/${agent}/logs.`, `Sorry, that didn't work${code ? ` (code ${code})` : ""}. Details are in the log under daten/${agent}/logs.`), undefined, job.thread_ts || job.ts);
      }
    }
  } finally {
    working = false;
  }
}

// Knöpfe an einem Wochenplan: übernehmen (mit/ohne Einkaufsliste) oder verwerfen
async function onPlanAction(payload, a, user) {
  const channel = payload.channel.id;
  const { ts, text, blocks = [] } = payload.message;
  const status = (t, keepButtons = false) => update(channel, ts, text, [...blocks.filter((b) => keepButtons || b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text: t }] }]);
  await status(L("⏳ Einen Moment …", "⏳ One moment …"));
  try {
    if (a.action_id === "rz_plan_no") {
      rejectPlan(a.value, user);
      await status(L(`🗑️ Verworfen von <@${user}>.`, `🗑️ Discarded by <@${user}>.`));
    } else {
      const shopping = a.action_id === "rz_plan_shop";
      const r = await applyPlan(a.value, user, { shopping });
      const where = shopping ? L("im Essensplan und auf der Einkaufsliste", "in the meal plan and on the shopping list") : L("im Essensplan", "in the meal plan");
      await status(L(`✅ <@${user}>: ${r.count} Gerichte ${where} (${r.meal_type}).`, `✅ <@${user}>: ${r.count} dishes ${where} (${r.meal_type}).`));
    }
    log(`${a.action_id} ${a.value} von ${user}`);
  } catch (e) {
    await status(`⚠️ ${esc(e.message)}`, loadStore().plans?.[a.value]?.status === "open");
    log(`Fehler bei ${a.action_id} ${a.value}: ${e.message}`);
  }
}

// Knopf „🎨 Neues Bild“ an einem Vorschlag: KI-Bild für den Entwurf (neu) erzeugen; die Knöpfe bleiben
async function onDraftImage(payload, id, user) {
  const channel = payload.channel.id;
  const { ts, text, blocks = [] } = payload.message;
  const STATUS = "rzimgstatus";
  const status = (t) => update(channel, ts, text, [...blocks.filter((b) => b.block_id !== STATUS && b.type !== "actions"), { type: "context", block_id: STATUS, elements: [{ type: "mrkdwn", text: t }] }, ...blocks.filter((b) => b.type === "actions")]);
  if (imageBusy.has(`p:${id}`)) return;
  imageBusy.add(`p:${id}`);
  try {
    await status(L(`⏳ <@${user}>: Bild wird erzeugt …`, `⏳ <@${user}>: creating picture …`));
    const r = await regenerateDraftImage(id);
    const extra = r.replacesOld ? L(" Beim Übernehmen ersetzt es das Bild des Rezepts – das alte wird vorher gesichert.", " When applied it replaces the recipe's picture – the old one is backed up first.") : "";
    await status(L(`🎨 Neues KI-Bild von <@${user}> im ${link(r.url, "Entwurf")} · ${r.info}.${extra}`, `🎨 New AI picture by <@${user}> in the ${link(r.url, "draft")} · ${r.info}.${extra}`));
    log(`rz_draft_image ${id} von ${user}`);
  } catch (e) {
    await status(`⚠️ ${esc(e.message)}`);
    log(`Fehler bei rz_draft_image ${id}: ${e.message}`);
  } finally {
    imageBusy.delete(`p:${id}`);
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
  if (a.action_id === "rz_image") return onImage(payload, a.value, user);
  if (a.action_id.startsWith("rz_all_")) return onAllAction(payload, a, user);
  if (a.action_id.startsWith("rz_plan_")) return onPlanAction(payload, a, user);
  if (a.action_id === "rz_draft_image") return onDraftImage(payload, a.value, user);
  const { ts, blocks = [] } = payload.message;
  const withStatus = (text, keepButtons) => [...blocks.filter((b) => keepButtons || b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text }] }];
  await update(channel, ts, payload.message.text, withStatus(L("⏳ Einen Moment …", "⏳ One moment …"), false));
  try {
    let text;
    if (a.action_id === "rz_apply") {
      const r = await applyProposal(a.value, user);
      text = L(`✅ Übernommen von <@${user}> → ${link(r.url, r.name)}`, `✅ Applied by <@${user}> → ${link(r.url, r.name)}`) + (r.note ? ` · ${esc(r.note)}` : "");
    } else {
      const skip = a.action_id === "rz_skip";
      await rejectProposal(a.value, user, { skip });
      text = skip ? L(`🚫 <@${user}>: nicht bearbeiten – das Rezept bleibt, wie es ist.`, `🚫 <@${user}>: leave as is – the recipe stays unchanged.`) : L(`🗑️ Verworfen von <@${user}> – Entwurf gelöscht.`, `🗑️ Discarded by <@${user}> – draft deleted.`);
    }
    await update(channel, ts, payload.message.text, withStatus(text, false));
    log(`${a.action_id} ${a.value} von ${user}`);
  } catch (e) {
    const stillOpen = loadStore().proposals[a.value]?.status === "open";
    await update(channel, ts, payload.message.text, withStatus(`⚠️ ${e.message}`, stillOpen));
    log(`Fehler bei ${a.action_id} ${a.value}: ${e.message}`);
  }
}

// Knopf „Bild erzeugen“ an einer Nachricht aus /ohne-bild
const imageBusy = new Set();
async function onImage(payload, id, user) {
  const channel = payload.channel.id;
  const { ts, text, blocks = [] } = payload.message;
  const status = (t, keepButtons = false) => update(channel, ts, text, [...blocks.filter((b) => keepButtons || b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text: t }] }]);
  if (imageBusy.has(id)) return;
  imageBusy.add(id);
  try {
    await status(L(`⏳ <@${user}>: Bild wird erzeugt …`, `⏳ <@${user}>: creating picture …`));
    const r = await generateRecipeImage(Number(id));
    const m = noImageMessage({ id, name: r.name, url: r.url }, [L(`🎨 von <@${user}> mit KI erzeugt und in Tandoor gespeichert`, `🎨 created with AI by <@${user}> and saved in Tandoor`), r.info].filter(Boolean).join(" · "));
    await update(channel, ts, m.text, m.blocks);
    log(`rz_image ${id} von ${user}`);
  } catch (e) {
    await status(`⚠️ ${esc(e.message)}`, true);
    log(`Fehler bei rz_image ${id}: ${e.message}`);
  } finally {
    imageBusy.delete(id);
  }
}

// ---------- /bild-alle: alle Bilder mit Google neu erzeugen (zweimal bestätigen, läuft im Hintergrund) ----------
// Stand in daten/rezepte/bilder-alle.json – nach einem Neustart geht es dort weiter, wo es aufgehört hat.
const ALL_FILE = join(REZEPTE, "bilder-alle.json");
const loadAll = () => (existsSync(ALL_FILE) ? JSON.parse(readFileSync(ALL_FILE, "utf8")) : null);
const saveAll = (j) => writeFileSync(ALL_FILE, JSON.stringify(j, null, 1));
const usd = (n) => L(`${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`, `$${n.toFixed(2)}`);
const costText = (n) => (googlePrice() ? `${L("ca.", "about")} ${usd(n * googlePrice())}` : L("Preis für dieses Modell unbekannt", "price for this model unknown"));
const button = (text, action_id, value, style) => ({ type: "button", text: { type: "plain_text", text }, action_id, value, ...(style ? { style } : {}) });
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text } });
const allRunning = () => ["running", "paused"].includes(loadAll()?.status);

function allProgress(j) {
  const done = j.ok + j.failed.length + j.skipped.length;
  const state = { running: L("⏳ läuft", "⏳ running"), paused: L("⏸️ angehalten", "⏸️ paused"), stopped: L("⏹️ abgebrochen", "⏹️ stopped"), done: L("✅ fertig", "✅ done") }[j.status];
  const lines = [
    `🎨 *${L("Alle Bilder erneuern", "Renew all pictures")}* (${j.model}) · ${state} · ${L("gestartet von", "started by")} <@${j.user}>`,
    `${done} ${L("von", "of")} ${j.ids.length} · ${j.ok} ${L("neu", "new")}${j.skipped.length ? ` · ${j.skipped.length} ${L("übersprungen", "skipped")}` : ""}${j.failed.length ? ` · ${j.failed.length} ${L("Fehler", "errors")}` : ""}`,
  ];
  if (j.note) lines.push(`⚠️ ${esc(j.note)}`);
  const problems = [...j.skipped, ...j.failed].slice(-5);
  if (problems.length) lines.push(...problems.map((p) => `• ${esc(p.name)}: ${esc(p.error)}`));
  if (j.status === "done") lines.push(L("Die alten Bilder liegen 180 Tage in daten/rezepte/sicherungen.", "The old pictures are kept for 180 days in daten/rezepte/sicherungen."));
  const blocks = [section(lines.join("\n"))];
  if (j.status === "running") blocks.push({ type: "actions", elements: [button(L("⏹️ Anhalten", "⏹️ Pause"), "rz_all_stop", "x", "danger")] });
  if (j.status === "paused") blocks.push({ type: "actions", elements: [button(L("▶️ Weitermachen", "▶️ Continue"), "rz_all_resume", "x", "primary"), button(L("⏹️ Beenden", "⏹️ Stop"), "rz_all_stop", "x")] });
  return { text: `${L("Alle Bilder erneuern", "Renew all pictures")}: ${done}/${j.ids.length}`, blocks };
}
const showAll = (j) => update(j.channel, j.ts, ...Object.values(allProgress(j))).catch((e) => log(`Fortschritt nicht aktualisiert: ${e.message}`));

let allWorking = false;
async function runAll() {
  if (allWorking) return;
  allWorking = true;
  try {
    let j = loadAll();
    let fails = 0;
    while (j?.status === "running" && j.next < j.ids.length) {
      const { id, name } = j.ids[j.next];
      try {
        await generateRecipeImage(id, { replace: true });
        j = loadAll();
        j.ok++;
        fails = 0;
      } catch (e) {
        j = loadAll();
        // Nicht sicherbar oder Entwurf: überspringen; sonst Fehler zählen (Google-Kontingent, Netz …)
        const skip = Boolean(e.skip);
        (skip ? j.skipped : j.failed).push({ id, name, error: e.message.slice(0, 150) });
        if (!skip && ++fails >= 3) {
          j.status = "paused";
          j.note = L(`3 Fehler hintereinander – angehalten. Letzter Fehler: ${e.message.slice(0, 150)}`, `3 errors in a row – paused. Last error: ${e.message.slice(0, 150)}`);
        }
        log(`/bild-alle ${name}: ${e.message}`);
      }
      j.next++;
      if (j.next >= j.ids.length) j.status = "done";
      saveAll(j);
      if (j.status !== "running" || j.next % 5 === 0) await showAll(j);
      if (j.status === "running") await new Promise((r) => setTimeout(r, 2_000)); // sanft zur Google-API
      j = loadAll();
    }
    if (j && j.status !== "running") {
      await showAll(j);
      log(`/bild-alle ${j.status}: ${j.ok} neu, ${j.skipped.length} übersprungen, ${j.failed.length} Fehler`);
    }
  } finally {
    allWorking = false;
  }
}

async function onAllAction(payload, a, user) {
  const channel = payload.channel.id;
  const { ts } = payload.message;
  const [, , step] = a.action_id.split("_"); // rz_all_<schritt>
  // Wert: „<wer>:<auswahl>:<anzahl>“ (ältere Nachrichten: „<wer>:<anzahl>“ = alle)
  const parts = a.value.split(":");
  const [starter, mode, n] = parts.length === 3 ? [parts[0], parts[1], Number(parts[2])] : [parts[0], "all", Number(parts[1])];
  if (["yes1", "yes2"].includes(step) && user !== starter) return; // nur wer gefragt hat, bestätigt
  if (step === "no") return update(channel, ts, L("Abgebrochen", "Cancelled"), [section(L(`❎ <@${user}> hat abgebrochen – kein Bild wurde geändert.`, `❎ <@${user}> cancelled – no picture was changed.`))]);
  if (step === "yes1") {
    const what = {
      all: L(`*alle ${rezepte(n)}* ein neues KI-Bild von Google (${googleModel()}), auch die mit eigenem Foto`, `*all ${rezepte(n)}* get a new AI picture from Google (${googleModel()}), including those with their own photo`),
      missing: L(`*${rezepte(n)} ohne KI-Bild* (eigene Fotos und Rezepte ohne Bild) ein neues KI-Bild von Google (${googleModel()})`, `*${rezepte(n)} without an AI picture* (own photos and recipes without a picture) get a new AI picture from Google (${googleModel()})`),
      old: L(`*${rezepte(n)} mit KI-Bild in einem älteren Stil* ein neues KI-Bild im aktuellen Stil`, `*${rezepte(n)} with an AI picture in an older style* get a new AI picture in the current style`),
    }[mode];
    return update(channel, ts, L("Wirklich Bilder erneuern?", "Really renew pictures?"), [
      section(
        L(
          `⚠️ *Wirklich sicher, <@${user}>?*\nDann bekommen ${what}. Kosten ${costText(n)}.\nDie alten Bilder werden vorher gesichert (180 Tage in daten/rezepte/sicherungen). Rezepte, deren Bild sich nicht sichern lässt, bleiben unverändert.`,
          `⚠️ *Are you sure, <@${user}>?*\nThen ${what}. Cost ${costText(n)}.\nThe old pictures are backed up first (180 days in daten/rezepte/sicherungen). Recipes whose picture can't be backed up stay unchanged.`,
        ),
      ),
      { type: "actions", elements: [button(L(`Ja, wirklich ${n} erneuern`, `Yes, really renew ${n}`), "rz_all_yes2", `${user}:${mode}:${n}`, "danger"), button(L("Abbrechen", "Cancel"), "rz_all_no", user)] },
    ]);
  }
  if (step === "yes2") {
    if (allRunning()) return update(channel, ts, L("Läuft schon", "Already running"), [section(L("⏳ Es läuft schon ein Auftrag „Alle Bilder erneuern“.", "⏳ A “renew all pictures” job is already running."))]);
    const ids = await allRecipeIds(mode);
    const j = { status: "running", user, channel, ts, model: googleModel(), started: new Date().toISOString(), ids, next: 0, ok: 0, skipped: [], failed: [] };
    saveAll(j);
    await showAll(j);
    log(`/bild-alle gestartet von ${user}: ${ids.length} Rezepte`);
    return runAll();
  }
  const j = loadAll();
  if (!j) return;
  if (step === "stop") Object.assign(j, { status: "stopped", note: L(`beendet von <@${user}>`, `stopped by <@${user}>`) });
  if (step === "resume" && j.status === "paused") Object.assign(j, { status: "running", note: "" });
  saveAll(j);
  await showAll(j);
  if (j.status === "running") runAll();
}

if (!process.env.SLACK_APP_TOKEN || !process.env.SLACK_BOT_TOKEN) {
  // Nicht beenden (sonst startet start.sh die Brücke alle 15 s neu): warten, bis die Tokens eingetragen sind und neu gestartet wird
  log("SLACK_APP_TOKEN/SLACK_BOT_TOKEN fehlen – Slack-Brücke wartet (in der Weboberfläche unter Einstellungen eintragen)");
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
log(`Slack-Brücke startet (Kanal ${CHANNEL() || "noch nicht freigegeben"}, Agent ${AGENT})`);
// Slash-Befehle (im Manifest angelegt). Antworten sind nur für den Fragenden sichtbar.
// Ändernde Befehle (/pruefen, /pro-tag mit Zahl) nur im Rezept-Kanal – wer dort ist, darf auch bestätigen.
const QUALITY = process.env.REZEPT_QUALITAET_AGENT || "rezept-qualitaet";
const COMMANDS = () => [
  ["/statistik", "", L("Rezept-Statistik: gesamt, geprüft, offen, noch zu prüfen", "Recipe statistics: total, checked, open, still to check")],
  ["/offen", L("[neu]", "[resend]"), L("Vorschläge, die auf deine Entscheidung warten – mit Link; mit `neu` werden alle noch einmal mit den aktuellen Knöpfen in den Kanal geschickt", "Proposals waiting for your decision – with link; with `resend` they are all posted to the channel again with the current buttons")],
  ["/rezept", L("<Name>", "<name>"), L("Rezept in Tandoor suchen, mit Status", "Search a recipe in Tandoor, with status")],
  ["/ohne-bild", L("[Anzahl | Name]", "[count | name]"), L("Rezepte ohne Bild als einzelne Nachrichten im Kanal, mit Knopf für ein KI-Foto (Standard 5)", "Recipes without a picture as single messages in the channel, with a button for an AI photo (default 5)")],
  ["/bild-neu", L("<Name | ID>", "<name | ID>"), L("Neues KI-Bild mit Google für ein Rezept (ersetzt das alte, das vorher gesichert wird)", "New AI picture from Google for one recipe (replaces the old one, which is backed up first)")],
  ["/bild-alle", "", L("Alle Rezeptbilder mit Google neu erzeugen – mit doppelter Rückfrage, läuft im Hintergrund", "Recreate all recipe pictures with Google – asks twice, runs in the background")],
  ["/pruefen", L("[Anzahl]", "[count]"), L("Qualitätsprüfung jetzt starten (mit Anzahl: heute so viele Rezepte zusätzlich zum Tageswert)", "Start the quality check now (with a count: that many recipes on top of today's amount)")],
  ["/wochenplan", L("[Tage] [Wünsche]", "[days] [wishes]"), L("Essensplan aus euren Rezepten vorschlagen, z. B. `/wochenplan 5 vegetarisch, schnell` – mit einem Klick in Tandoor-Essensplan und Einkaufsliste", "Suggest a meal plan from your recipes, e.g. `/meal-plan 5 vegetarian, quick` – one click into the Tandoor meal plan and shopping list")],
  ["/was-kochen", L("<Zutaten>", "<ingredients>"), L("Rezepte mit diesen Zutaten finden, z. B. `/was-kochen Zucchini, Feta`", "Find recipes with these ingredients, e.g. `/what-to-cook zucchini, feta`")],
  ["/pro-tag", L("[Anzahl]", "[count]"), L("Wie viele Rezepte täglich geprüft werden – anzeigen oder ändern", "How many recipes are checked per day – show or change")],
  ["/neuronen", "", L("Heute noch freie Cloudflare-Neuronen für KI-Fotos", "Cloudflare neurons left today for AI photos")],
  ["/google", "", L("Google-Nutzung diesen Monat: Bilder, Videos, geschätzte Kosten und Rest-Guthaben", "Google usage this month: pictures, videos, estimated cost and remaining credit")],
  ["/hilfe", "", L("Diese Übersicht", "This overview")],
];
const helpText = () => [`*${L("Rezept-Helfer", "Recipe helper")}* – ${HELP()}`, "", ...COMMANDS().map(([c, a, d]) => `• \`${cmd(c)}${a ? " " + a : ""}\` – ${d}`)].join("\n");

// Das Free-Kontingent beginnt um 00:00 UTC neu – hier in Ortszeit
const resetTime = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toLocaleTimeString(locale(), { timeZone: process.env.TZ || "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
};
const ago = (iso) => {
  const h = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000);
  const d = Math.floor(h / 24);
  return h < 1 ? L("gerade eben", "just now") : h < 24 ? L(`vor ${h} Std.`, `${h} h ago`) : L(`vor ${d} ${d === 1 ? "Tag" : "Tagen"}`, `${d} ${d === 1 ? "day" : "days"} ago`);
};
const permalink = (p) =>
  p?.slack ? slack("chat.getPermalink", { channel: p.slack.channel, message_ts: p.slack.last_ts || p.slack.thread_ts }).then((r) => r.permalink, () => "") : Promise.resolve("");
const inChannel = (c) => c.channel_id === CHANNEL();
const notInChannel = () => L(`Das geht nur im Rezept-Kanal <#${CHANNEL()}>.`, `This only works in the recipe channel <#${CHANNEL()}>.`);
const NO_IMAGE_MAX = 20;

// „/offen neu“: alle offenen Vorschläge und Wochenpläne noch einmal in den Kanal schicken (älteste zuerst)
async function resendOpen(c) {
  if (!inChannel(c)) return notInChannel();
  const items = [...openProposals().map((p) => ({ name: p.name, run: () => resendProposal(p.id) })), ...openPlans().map((p) => ({ name: L("Wochenplan", "Meal plan"), run: () => resendPlan(p.id) }))];
  if (!items.length) return L("✅ Keine offenen Vorschläge – alles entschieden.", "✅ No open proposals – everything decided.");
  const failed = [];
  for (const it of items)
    await it.run().catch((e) => {
      log(`Neu schicken fehlgeschlagen (${it.name}): ${e.message}`);
      failed.push(`${esc(it.name)} (${esc(e.message.slice(0, 120))})`);
    });
  const sent = items.length - failed.length;
  return [L(`🔁 ${sent} von ${items.length} offenen Vorschlägen neu geschickt.`, `🔁 Sent ${sent} of ${items.length} open proposals again.`), ...failed.map((f) => `⚠️ ${f}`)].join("\n");
}

const commands = {
  "/hilfe": async () => helpText(),
  "/statistik": async () => statsMessage(await stats()),
  "/google": async () => usageMessage(),
  "/neuronen": async () => neurons().then((n) => `🧠 Cloudflare Workers AI: ${neuronsText(n)}. ${L(`Das Kontingent beginnt um ${resetTime()} Uhr neu.`, `The quota resets at ${resetTime()}.`)}`, (e) => `${L("Neuronen nicht abrufbar", "Neurons not available")}: ${e.message}`),

  "/offen": async (c) => {
    if (/^(neu|nochmal|erneut|new|resend|again)$/i.test(c.text.trim())) return resendOpen(c);
    const list = openProposals();
    if (!list.length) return L("✅ Keine offenen Vorschläge – alles entschieden.", "✅ No open proposals – everything decided.");
    const shown = list.slice(0, 20);
    const links = await Promise.all(shown.map(permalink));
    const lines = shown.map((p, i) => `• ${links[i] ? link(links[i], p.name) : esc(p.name)} · ${p.kind === "quality" ? L("Qualität", "quality") : "Import"} · ${ago(p.created)}`);
    if (list.length > shown.length) lines.push(L(`… und ${list.length - shown.length} weitere`, `… and ${list.length - shown.length} more`));
    lines.push(L(`_\`${cmd("/offen")} neu\` schickt alle noch einmal in den Kanal, mit den aktuellen Knöpfen._`, `_\`${cmd("/offen")} resend\` posts them all to the channel again, with the current buttons._`));
    return [`⏳ *${list.length} ${list.length === 1 ? L("Vorschlag wartet", "proposal waiting") : L("Vorschläge warten", "proposals waiting")} ${L("auf dich", "for you")}*`, ...lines].join("\n");
  },

  "/rezept": async (c) => {
    const q = c.text.trim();
    if (!q) return L("Wonach soll ich suchen? Beispiel: `/rezept Rahmwirsing`", "What should I search for? Example: `/recipe lasagna`");
    const hits = await findRecipes(q);
    if (!hits.length) return L(`Kein Rezept zu „${esc(q)}“ gefunden.`, `No recipe found for “${esc(q)}”.`);
    const icon = { checked: "✅", skip: "🚫", open: "⏳", todo: "📝" };
    const links = await Promise.all(hits.map((h) => permalink(h.proposal)));
    const aiText = (ai) => {
      if (!ai) return "";
      const when = ai.at ? new Date(ai.at).toLocaleDateString(locale(), { timeZone: process.env.TZ || "Europe/Berlin", day: "2-digit", month: "2-digit" }) : "";
      return ` · 🎨 ${L("KI-Bild", "AI picture")}${ai.model && ai.model !== "?" ? ` (${ai.model}${when ? `, ${when}` : ""})` : ""}${ai.oldStyle ? L(" · alter Stil", " · old style") : ""}`;
    };
    const lines = hits.map((h, i) => `• ${icon[h.state]} ${link(h.url, h.name)} · ${h.status}${aiText(h.ai)}${links[i] ? ` · ${link(links[i], L("zum Vorschlag", "to the proposal"))}` : ""}`);
    return [L(`🔎 *${hits.length} Treffer* zu „${esc(q)}“`, `🔎 *${hits.length} ${hits.length === 1 ? "hit" : "hits"}* for “${esc(q)}”`), ...lines].join("\n");
  },

  "/ohne-bild": async (c) => {
    if (!inChannel(c)) return notInChannel();
    const arg = c.text.trim();
    const count = /^\d+$/.test(arg) ? Number(arg) : arg ? NO_IMAGE_MAX : 5;
    if (count < 1 || count > NO_IMAGE_MAX) return L(`Bitte eine Anzahl von 1 bis ${NO_IMAGE_MAX} angeben, z. B. \`/ohne-bild 5\`.`, `Please give a count from 1 to ${NO_IMAGE_MAX}, e.g. \`/no-image 5\`.`);
    const name = /^\d+$/.test(arg) ? "" : arg;
    const r = await recipesWithoutImage(name);
    if (!r.total) return name ? L(`Kein Rezept ohne Bild zu „${esc(name)}“ gefunden.`, `No recipe without a picture found for “${esc(name)}”.`) : L("🎉 Alle Rezepte haben ein Bild.", "🎉 All recipes have a picture.");
    if (!r.list.length) return L(`🖼️ ${rezepte(r.total)} ohne Bild – alle wurden in den letzten 7 Tagen schon gezeigt. Gezielt suchen: \`/ohne-bild <Name>\``, `🖼️ ${rezepte(r.total)} without a picture – all were already shown in the last 7 days. Search specifically: \`/no-image <name>\``);
    const shown = r.list.slice(0, count);
    await postWithoutImage(shown, c.channel_id);
    log(`/ohne-bild ${arg} von ${c.user_id} → ${shown.length} Nachrichten`);
    const rest = r.list.length - shown.length;
    return [
      L(`🖼️ *${rezepte(r.total)} ohne Bild*${name ? ` zu „${esc(name)}“` : ""} – ${shown.length === 1 ? "eins steht" : `${shown.length} stehen`} jetzt als eigene Nachricht im Kanal.`, `🖼️ *${rezepte(r.total)} without a picture*${name ? ` for “${esc(name)}”` : ""} – ${shown.length === 1 ? "one is" : `${shown.length} are`} now in the channel as separate messages.`),
      rest ? (name ? L(`Noch ${rest} weitere – bitte genauer suchen.`, `${rest} more – please search more specifically.`) : L(`Noch ${rest} weitere: \`/ohne-bild ${Math.min(rest, NO_IMAGE_MAX)}\``, `${rest} more: \`/no-image ${Math.min(rest, NO_IMAGE_MAX)}\``)) : "",
      r.shown_recently ? L(`${r.shown_recently} davon wurden in den letzten 7 Tagen schon gezeigt und kommen nicht nochmal.`, `${r.shown_recently} of them were already shown in the last 7 days and won't be repeated.`) : "",
    ].filter(Boolean).join("\n");
  },

  "/bild-neu": async (c) => {
    if (!inChannel(c)) return notInChannel();
    if (!googleReady()) return L("Google ist nicht eingerichtet – `GEMINI_API_KEY` fehlt.", "Google is not set up – `GEMINI_API_KEY` is missing.");
    const q = c.text.trim();
    if (!q) return L("Für welches Rezept? Beispiel: `/bild-neu Rahmwirsing` oder `/bild-neu 149567`", "For which recipe? Example: `/new-image lasagna` or `/new-image 149567`");
    const { hit, hits } = await resolveRecipe(q);
    if (!hit) {
      if (!hits.length) return L(`Kein Rezept zu „${esc(q)}“ gefunden.`, `No recipe found for “${esc(q)}”.`);
      return [L(`🔎 Mehrere Treffer zu „${esc(q)}“ – bitte genauer, oder mit ID:`, `🔎 Several hits for “${esc(q)}” – please be more specific, or use the ID:`), ...hits.map((h) => `• ${link(h.url, h.name)} · \`${cmd("/bild-neu")} ${h.id}\``)].join("\n");
    }
    const r = await generateRecipeImage(hit.id, { replace: true });
    const m = noImageMessage({ id: r.id, name: r.name, url: r.url }, [L(`🎨 neues Bild für <@${c.user_id}>`, `🎨 new picture for <@${c.user_id}>`), r.info, r.backup ? L("altes Bild gesichert", "old picture backed up") : ""].filter(Boolean).join(" · "));
    await post(c.channel_id, m.text, m.blocks);
    log(`/bild-neu ${hit.id} von ${c.user_id}`);
    return L(`✅ Neues Bild für ${link(r.url, r.name)} ist da (Nachricht im Kanal).`, `✅ New picture for ${link(r.url, r.name)} is ready (message in the channel).`);
  },

  "/bild-alle": async (c) => {
    if (!inChannel(c)) return notInChannel();
    if (!googleReady()) return L("Google ist nicht eingerichtet – `GEMINI_API_KEY` fehlt.", "Google is not set up – `GEMINI_API_KEY` is missing.");
    const run = loadAll();
    if (allRunning()) return L(`⏳ Läuft schon: ${run.next} von ${run.ids.length} erledigt (${run.status === "paused" ? "angehalten" : "läuft"}). Anhalten oder weitermachen mit den Knöpfen an der Nachricht im Kanal.`, `⏳ Already running: ${run.next} of ${run.ids.length} done (${run.status === "paused" ? "paused" : "running"}). Pause or continue with the buttons on the message in the channel.`);
    const [n, missing, old] = await Promise.all(["all", "missing", "old"].map((m) => allRecipeIds(m).then((l) => l.length)));
    if (!n) return L("Es gibt keine Rezepte.", "There are no recipes.");
    const choices = [button(L(`Alle ${n}`, `All ${n}`), "rz_all_yes1", `${c.user_id}:all:${n}`, "primary")];
    if (missing) choices.push(button(L(`Nur ohne KI-Bild (${missing})`, `Only without AI picture (${missing})`), "rz_all_yes1", `${c.user_id}:missing:${missing}`));
    if (old) choices.push(button(L(`Nur alter Stil (${old})`, `Only old style (${old})`), "rz_all_yes1", `${c.user_id}:old:${old}`));
    choices.push(button(L("Abbrechen", "Cancel"), "rz_all_no", c.user_id));
    await post(c.channel_id, L("Bilder erneuern?", "Renew pictures?"), [
      section(
        L(
          `🎨 <@${c.user_id}> möchte Rezeptbilder mit Google (${googleModel()}) neu erzeugen. Welche?\n• *Alle ${rezepte(n)}* – auch eigene Fotos · ${costText(n)}\n• *Nur ohne KI-Bild:* ${rezepte(missing)} (eigene Fotos und Rezepte ohne Bild) · ${costText(missing)}\n• *Nur alter Stil:* ${rezepte(old)} mit KI-Bild in einem älteren Stil · ${costText(old)}`,
          `🎨 <@${c.user_id}> wants to recreate recipe pictures with Google (${googleModel()}). Which ones?\n• *All ${rezepte(n)}* – including own photos · ${costText(n)}\n• *Only without AI picture:* ${rezepte(missing)} (own photos and recipes without a picture) · ${costText(missing)}\n• *Only old style:* ${rezepte(old)} with an AI picture in an older style · ${costText(old)}`,
        ),
      ),
      { type: "actions", elements: choices },
    ]);
    return L("Die Rückfrage steht im Kanal – nur du kannst sie bestätigen.", "The confirmation is in the channel – only you can confirm it.");
  },

  "/wochenplan": async (c) => {
    if (!inChannel(c)) return notInChannel();
    // „/wochenplan 5 vegetarisch, schnell“ → 5 Tage ab morgen, Wünsche als Text
    const m = /^\s*(\d{1,2})\b\s*(.*)$/s.exec(c.text);
    const days = m ? Number(m[1]) : 7;
    if (days < 1 || days > MAX_DAYS) return L(`Bitte 1 bis ${MAX_DAYS} Tage, z. B. \`/wochenplan 5\`.`, `Please 1 to ${MAX_DAYS} days, e.g. \`/meal-plan 5\`.`);
    const wishes = (m ? m[2] : c.text).trim();
    const r = await post(c.channel_id, L(`🗓️ <@${c.user_id}> wünscht sich einen Plan für ${days} Tage${wishes ? ` („${esc(wishes)}“)` : ""} – ich stelle ihn zusammen …`, `🗓️ <@${c.user_id}> asked for a ${days}-day plan${wishes ? ` (“${esc(wishes)}”)` : ""} – putting it together …`));
    enqueue({ kind: "plan", agent: PLAN_AGENT, days, text: wishes, servings: servingsDefault(), channel: c.channel_id, ts: r.ts, user: c.user_id });
    return L("Der Plan kommt gleich im Kanal (dauert etwa eine Minute).", "The plan will appear in the channel shortly (takes about a minute).");
  },

  "/was-kochen": async (c) => {
    const q = c.text.trim();
    if (!q) return L("Was hast du da? Beispiel: `/was-kochen Zucchini, Feta`", "What do you have? Example: `/what-to-cook zucchini, feta`");
    const r = await findByIngredients(q);
    if (!r.found.length) return L(`Keine dieser Zutaten kenne ich aus euren Rezepten: ${esc(r.missing.join(", "))}.`, `None of these ingredients appear in your recipes: ${esc(r.missing.join(", "))}.`);
    if (!r.hits.length) return L(`Kein Rezept mit ${esc(r.found.map((f) => f.name).join(", "))} gefunden.`, `No recipe with ${esc(r.found.map((f) => f.name).join(", "))} found.`);
    const all = r.found.length;
    const lines = r.hits.map((h) => `• ${h.matches.length === all && all > 1 ? "⭐ " : ""}${link(h.url, h.name)} · ${esc(h.matches.join(", "))}${h.working_time ? ` · ${h.working_time} min` : ""}`);
    return [
      L(`🍳 *${r.hits.length} Rezepte* mit ${esc(r.found.map((f) => f.name).join(", "))}`, `🍳 *${r.hits.length} recipes* with ${esc(r.found.map((f) => f.name).join(", "))}`),
      ...lines,
      r.missing.length ? L(`_Nicht gefunden: ${esc(r.missing.join(", "))}_`, `_Not found: ${esc(r.missing.join(", "))}_`) : "",
    ].filter(Boolean).join("\n");
  },

  "/pro-tag": async (c) => {
    const arg = c.text.trim();
    if (!arg) {
      const p = perDay();
      return L(`📅 Rezept-Qualität prüft *${rezepte(p.value)}* pro Tag${p.source === "Weboberfläche" ? "" : ` (${p.source})`}. Ändern: \`/pro-tag 8\``, `📅 Recipe quality checks *${rezepte(p.value)}* per day${p.source === "Weboberfläche" ? "" : ` (${p.source})`}. Change: \`/per-day 8\``);
    }
    if (!inChannel(c)) return notInChannel();
    if (!/^\d+$/.test(arg)) return L("Bitte nur eine Zahl angeben, z. B. `/pro-tag 8`.", "Please give just a number, e.g. `/per-day 8`.");
    setPerDay(Number(arg));
    log(`/pro-tag ${arg} von ${c.user_id}`);
    return L(`📅 Ab jetzt prüft Rezept-Qualität *${rezepte(Number(arg))}* pro Tag.`, `📅 From now on recipe quality checks *${rezepte(Number(arg))}* per day.`);
  },

  "/pruefen": async (c) => {
    if (!inChannel(c)) return notInChannel();
    const arg = c.text.trim();
    if (arg && !/^\d+$/.test(arg)) return L("Bitte nur eine Zahl angeben, z. B. `/pruefen 3`.", "Please give just a number, e.g. `/check 3`.");
    if (readStatus(QUALITY, "status.json")?.running) return L("⏳ Die Qualitätsprüfung läuft gerade schon.", "⏳ The quality check is already running.");
    if (hasStartRequest(QUALITY)) return L("⏳ Die Qualitätsprüfung startet gleich schon.", "⏳ The quality check is about to start.");
    if (arg) addToday(Number(arg));
    const p = await pending();
    if (!p.batch.length) {
      if (!p.total) return L("🎉 Es gibt gerade nichts zu prüfen.", "🎉 There is nothing to check right now.");
      if (!p.free) return L(`⏳ Es warten schon ${p.open_quality} Qualitäts-Vorschläge auf dich. Entscheide erst ein paar (\`/offen\`), dann geht es weiter.`, `⏳ ${p.open_quality} quality proposals are already waiting for you. Decide some first (\`/open\`), then it continues.`);
      return L("📅 Das Tageslimit ist erreicht. Mit `/pruefen 3` prüft der Agent jetzt noch 3 weitere Rezepte.", "📅 The daily limit is reached. With `/check 3` the agent checks 3 more recipes now.");
    }
    requestStart(QUALITY, "slack");
    log(`/pruefen ${arg} von ${c.user_id} → ${p.batch.length} Rezepte`);
    return L(`🔍 Die Qualitätsprüfung startet in spätestens 30 Sekunden mit ${rezepte(p.batch.length)}. Die Vorschläge erscheinen im Kanal.`, `🔍 The quality check starts within 30 seconds with ${rezepte(p.batch.length)}. The proposals appear in the channel.`);
  },
};

async function onCommand(c) {
  // Deutsche und englische Befehlsnamen (/statistik = /stats …) führen zum selben Befehl
  const name = canonicalCommand(c.command);
  const run = commands[name];
  if (!run) return respond(c.response_url, L(`Unbekannter Befehl ${c.command}. \`/hilfe\` zeigt alle Befehle.`, `Unknown command ${c.command}. \`/help\` shows all commands.`));
  const text = await run({ ...c, command: name, text: c.text || "" }).catch((e) => `⚠️ ${e.message}`);
  await respond(c.response_url, text);
  if (!["/pro-tag", "/pruefen", "/ohne-bild"].includes(name)) log(`${c.command} von ${c.user_id}`);
}

socket({ onEvent, onAction, onCommand, log });
// Slack-Manifest (neue Befehle usw.) selbst einspielen – beim Start und alle 10 Minuten, nur wenn sich die Datei geändert hat
let manifestError = "";
async function manifestCheck() {
  try {
    const r = await syncManifest();
    manifestError = "";
    if (!r) return;
    log(`Slack-Manifest eingespielt${r.permissions_updated ? " – neue Berechtigungen, App muss neu installiert werden" : ""}`);
    if (CHANNEL())
      await post(CHANNEL(), r.permissions_updated
        ? L("🔄 Die Slack-App wurde aktualisiert und braucht *neue Berechtigungen*: bitte unter api.slack.com/apps → Rezept-Helfer → „Install App“ neu installieren.", "🔄 The Slack app was updated and needs *new permissions*: please reinstall it under api.slack.com/apps → your app → “Install App”.")
        : L("🔄 Die Slack-App wurde aktualisiert (z. B. neue Befehle) – `/hilfe` zeigt alle.", "🔄 The Slack app was updated (e.g. new commands) – `/help` shows them all."));
  } catch (e) {
    if (e.message !== manifestError) log(`Slack-Manifest nicht eingespielt: ${e.message}`);
    manifestError = e.message;
  }
}
if (manifestSyncReady()) {
  manifestCheck();
  setInterval(manifestCheck, 10 * 60_000);
} else log("Slack-Manifest wird nicht automatisch eingespielt (SLACK_APP_ID/SLACK_CONFIG_TOKEN fehlen)");

// Nach einem Neustart: laufendes „Alle Bilder erneuern“ fortsetzen
if (loadAll()?.status === "running") setTimeout(runAll, 10_000);

// Neustart-Meldung: einmal pro Containerstart (start.sh schreibt die Startzeit), nicht wenn nur die Brücke neu startet.
// Mit Version (Commit aus dem Image) und ob es ein Update war. Abschalten: NEUSTART_MELDUNG=aus.
const START_FILE = join(tmpdir(), "rezepte-containerstart"); // im Container /tmp
const ANNOUNCED_FILE = join(tmpdir(), "rezepte-start-gemeldet");
const VERSION_FILE = join(REZEPTE, "version.json"); // zuletzt gemeldete Version (bleibt über Updates erhalten)
async function announceStart() {
  if (/^(aus|off|nein|0)$/i.test((process.env.NEUSTART_MELDUNG || "").trim()) || !CHANNEL()) return;
  const started = existsSync(START_FILE) ? readFileSync(START_FILE, "utf8").trim() : "";
  if (!started || (existsSync(ANNOUNCED_FILE) && readFileSync(ANNOUNCED_FILE, "utf8").trim() === started)) return;
  writeFileSync(ANNOUNCED_FILE, started);
  const version = (process.env.APP_VERSION || "dev").trim();
  const short = version.slice(0, 7);
  const before = existsSync(VERSION_FILE) ? JSON.parse(readFileSync(VERSION_FILE, "utf8")).version : null;
  writeFileSync(VERSION_FILE, JSON.stringify({ version, at: new Date().toISOString() }));
  const commit = (v) => (/^[0-9a-f]{7,40}$/.test(v) ? link(`https://github.com/SebastianInTheWild/Rezept-Agent/commit/${v}`, v.slice(0, 7)) : v.slice(0, 7));
  const built = process.env.APP_BUILD ? new Date(process.env.APP_BUILD).toLocaleString(locale(), { timeZone: process.env.TZ || "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  const kind =
    before && before !== version
      ? L(`⬆️ *Update* von ${commit(before)} auf ${commit(version)}`, `⬆️ *Update* from ${commit(before)} to ${commit(version)}`)
      : L(`🔄 Neustart · Version ${commit(version)}`, `🔄 Restart · version ${commit(version)}`);
  const text = [L("✅ *Rezept-Helfer läuft wieder*", "✅ *Recipe helper is running again*"), kind, built ? L(`Image vom ${built}`, `image built ${built}`) : ""].filter(Boolean).join(" · ");
  await post(CHANNEL(), text).then(() => log(`Neustart gemeldet (${short}${before && before !== version ? `, vorher ${before.slice(0, 7)}` : ""})`), (e) => log(`Neustart-Meldung fehlgeschlagen: ${e.message}`));
}
announceStart();

// Einmal täglich alte Dateien wegräumen (Fotos, Eingänge, Aufträge nach 30 Tagen, Sicherungen nach 180 Tagen)
// Dabei auch das Merkmal ki-bild abgleichen (Bild in Tandoor ersetzt/gelöscht → Schlagwort weg; fehlt es → setzen)
const tidy = async () => {
  try {
    const r = cleanup();
    if (Object.keys(r).length) log(`Aufgeräumt: ${Object.entries(r).map(([d, n]) => `${n} in ${d}`).join(", ")}`);
  } catch (e) {
    log(`Aufräumen fehlgeschlagen: ${e.message}`);
  }
  try {
    const k = await reconcileAiImages();
    if (k.added || k.removed) log(`ki-bild abgeglichen: ${k.added} gesetzt, ${k.removed} entfernt`);
  } catch (e) {
    log(`ki-bild-Abgleich fehlgeschlagen: ${e.message}`);
  }
};
setTimeout(tidy, 60_000); // nach dem Start kurz warten, dann täglich
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
