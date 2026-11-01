#!/usr/bin/env node
// Slack-Brücke für die Rezepte: Links und Fotos im Kanal → Agent „rezepte“ legt einen Entwurf an.
// Antwort im Thread eines Vorschlags → Agent überarbeitet den Entwurf. Knöpfe → übernehmen/verwerfen (ohne Claude).
// Freigabe: nur Nachrichten aus SLACK_CHANNEL; wer im Kanal ist, darf schicken und bestätigen.
// Autor: SebastianInTheWild · MIT-Lizenz

import "./lib/umgebung.mjs"; // zuerst: Einstellungen aus der Weboberfläche in process.env
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, readStatus, requestStart, hasStartRequest } from "./run-agent.mjs";
import { slack, socket, post, update, react, unreact, download, linksIn, plain, link, esc, respond } from "./lib/slack.mjs";
import { syncManifest, manifestSyncReady } from "./lib/manifest.mjs";
import { neurons, neuronsText, googleReady, googleModel, googlePrice } from "./lib/bild.mjs";
import { REZEPTE, CHANNEL, proposalByThread, applyProposal, rejectProposal, loadStore, cleanup, stats, statsMessage, pending, perDay, setPerDay, addToday, openProposals, findRecipes, recipesWithoutImage, postWithoutImage, generateRecipeImage, noImageMessage, allRecipeIds, resolveRecipe } from "./lib/rezepte.mjs";

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
  if (a.action_id === "rz_image") return onImage(payload, a.value, user);
  if (a.action_id.startsWith("rz_all_")) return onAllAction(payload, a, user);
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

// Knopf „Bild erzeugen“ an einer Nachricht aus /ohne-bild
const imageBusy = new Set();
async function onImage(payload, id, user) {
  const channel = payload.channel.id;
  const { ts, text, blocks = [] } = payload.message;
  const status = (t, keepButtons = false) => update(channel, ts, text, [...blocks.filter((b) => keepButtons || b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text: t }] }]);
  if (imageBusy.has(id)) return;
  imageBusy.add(id);
  try {
    await status(`⏳ <@${user}>: Bild wird erzeugt …`);
    const r = await generateRecipeImage(Number(id));
    const m = noImageMessage({ id, name: r.name, url: r.url }, [`🎨 von <@${user}> mit KI erzeugt und in Tandoor gespeichert`, r.info].filter(Boolean).join(" · "));
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
const usd = (n) => `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const costText = (n) => (googlePrice() ? `ca. ${usd(n * googlePrice())}` : "Preis für dieses Modell unbekannt");
const button = (text, action_id, value, style) => ({ type: "button", text: { type: "plain_text", text }, action_id, value, ...(style ? { style } : {}) });
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text } });
const allRunning = () => ["running", "paused"].includes(loadAll()?.status);

function allProgress(j) {
  const done = j.ok + j.failed.length + j.skipped.length;
  const state = { running: "⏳ läuft", paused: "⏸️ angehalten", stopped: "⏹️ abgebrochen", done: "✅ fertig" }[j.status];
  const lines = [
    `🎨 *Alle Bilder erneuern* (${j.model}) · ${state} · gestartet von <@${j.user}>`,
    `${done} von ${j.ids.length} · ${j.ok} neu${j.skipped.length ? ` · ${j.skipped.length} übersprungen` : ""}${j.failed.length ? ` · ${j.failed.length} Fehler` : ""}`,
  ];
  if (j.note) lines.push(`⚠️ ${esc(j.note)}`);
  const problems = [...j.skipped, ...j.failed].slice(-5);
  if (problems.length) lines.push(...problems.map((p) => `• ${esc(p.name)}: ${esc(p.error)}`));
  if (j.status === "done") lines.push("Die alten Bilder liegen 180 Tage in daten/rezepte/sicherungen.");
  const blocks = [section(lines.join("\n"))];
  if (j.status === "running") blocks.push({ type: "actions", elements: [button("⏹️ Anhalten", "rz_all_stop", "x", "danger")] });
  if (j.status === "paused") blocks.push({ type: "actions", elements: [button("▶️ Weitermachen", "rz_all_resume", "x", "primary"), button("⏹️ Beenden", "rz_all_stop", "x")] });
  return { text: `Alle Bilder erneuern: ${done}/${j.ids.length}`, blocks };
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
        const skip = /sichern|Entwurf|404/.test(e.message);
        (skip ? j.skipped : j.failed).push({ id, name, error: e.message.slice(0, 150) });
        if (!skip && ++fails >= 3) {
          j.status = "paused";
          j.note = `3 Fehler hintereinander – angehalten. Letzter Fehler: ${e.message.slice(0, 150)}`;
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
  const starter = a.value.split(":")[0];
  if (["yes1", "yes2"].includes(step) && user !== starter) return; // nur wer gefragt hat, bestätigt
  if (step === "no") return update(channel, ts, "Abgebrochen", [section(`❎ <@${user}> hat abgebrochen – kein Bild wurde geändert.`)]);
  if (step === "yes1") {
    const n = Number(a.value.split(":")[1]);
    return update(channel, ts, "Wirklich alle Bilder erneuern?", [
      section(`⚠️ *Wirklich sicher, <@${user}>?*\nDann bekommen *alle ${rezepte(n)}* ein neues KI-Bild von Google (${googleModel()}), auch die mit eigenem Foto. Kosten ${costText(n)}.\nDie alten Bilder werden vorher gesichert (180 Tage in daten/rezepte/sicherungen). Rezepte, deren Bild sich nicht sichern lässt, bleiben unverändert.`),
      { type: "actions", elements: [button(`Ja, wirklich alle ${n} erneuern`, "rz_all_yes2", `${user}:${n}`, "danger"), button("Abbrechen", "rz_all_no", user)] },
    ]);
  }
  if (step === "yes2") {
    if (allRunning()) return update(channel, ts, "Läuft schon", [section("⏳ Es läuft schon ein Auftrag „Alle Bilder erneuern“.")]);
    const ids = await allRecipeIds();
    const j = { status: "running", user, channel, ts, model: googleModel(), started: new Date().toISOString(), ids, next: 0, ok: 0, skipped: [], failed: [] };
    saveAll(j);
    await showAll(j);
    log(`/bild-alle gestartet von ${user}: ${ids.length} Rezepte`);
    return runAll();
  }
  const j = loadAll();
  if (!j) return;
  if (step === "stop") Object.assign(j, { status: "stopped", note: `beendet von <@${user}>` });
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
const COMMANDS = [
  ["/statistik", "Rezept-Statistik: gesamt, geprüft, offen, noch zu prüfen"],
  ["/offen", "Vorschläge, die auf deine Entscheidung warten – mit Link"],
  ["/rezept <Name>", "Rezept in Tandoor suchen, mit Status"],
  ["/ohne-bild [Anzahl | Name]", "Rezepte ohne Bild als einzelne Nachrichten im Kanal, mit Knopf für ein KI-Foto (Standard 5)"],
  ["/bild-neu <Name | ID>", "Neues KI-Bild mit Google für ein Rezept (ersetzt das alte, das vorher gesichert wird)"],
  ["/bild-alle", "Alle Rezeptbilder mit Google neu erzeugen – mit doppelter Rückfrage, läuft im Hintergrund"],
  ["/pruefen [Anzahl]", "Qualitätsprüfung jetzt starten (mit Anzahl: heute so viele Rezepte zusätzlich zum Tageswert)"],
  ["/pro-tag [Anzahl]", "Wie viele Rezepte täglich geprüft werden – anzeigen oder ändern"],
  ["/neuronen", "Heute noch freie Cloudflare-Neuronen für KI-Fotos"],
  ["/hilfe", "Diese Übersicht"],
];
const helpText = () => [`*Rezept-Helfer* – ${HELP}`, "", ...COMMANDS.map(([c, d]) => `• \`${c}\` – ${d}`)].join("\n");

// Das Free-Kontingent beginnt um 00:00 UTC neu – hier in Ortszeit
const resetTime = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toLocaleTimeString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
};
const ago = (iso) => {
  const h = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000);
  const d = Math.floor(h / 24);
  return h < 1 ? "gerade eben" : h < 24 ? `vor ${h} Std.` : `vor ${d} ${d === 1 ? "Tag" : "Tagen"}`;
};
const permalink = (p) =>
  p?.slack ? slack("chat.getPermalink", { channel: p.slack.channel, message_ts: p.slack.last_ts || p.slack.thread_ts }).then((r) => r.permalink, () => "") : Promise.resolve("");
const inChannel = (c) => c.channel_id === CHANNEL();
const notInChannel = () => `Das geht nur im Rezept-Kanal <#${CHANNEL()}>.`;
const NO_IMAGE_MAX = 20;
const rezepte = (n) => `${n} ${n === 1 ? "Rezept" : "Rezepte"}`;

const commands = {
  "/hilfe": async () => helpText(),
  "/statistik": async () => statsMessage(await stats()),
  "/neuronen": async () => neurons().then((n) => `🧠 Cloudflare Workers AI: ${neuronsText(n)}. Das Kontingent beginnt um ${resetTime()} Uhr neu.`, (e) => `Neuronen nicht abrufbar: ${e.message}`),

  "/offen": async () => {
    const list = openProposals();
    if (!list.length) return "✅ Keine offenen Vorschläge – alles entschieden.";
    const shown = list.slice(0, 20);
    const links = await Promise.all(shown.map(permalink));
    const lines = shown.map((p, i) => `• ${links[i] ? link(links[i], p.name) : esc(p.name)} · ${p.kind === "quality" ? "Qualität" : "Import"} · ${ago(p.created)}`);
    if (list.length > shown.length) lines.push(`… und ${list.length - shown.length} weitere`);
    return [`⏳ *${list.length} ${list.length === 1 ? "Vorschlag wartet" : "Vorschläge warten"} auf dich*`, ...lines].join("\n");
  },

  "/rezept": async (c) => {
    const q = c.text.trim();
    if (!q) return "Wonach soll ich suchen? Beispiel: `/rezept Rahmwirsing`";
    const hits = await findRecipes(q);
    if (!hits.length) return `Kein Rezept zu „${esc(q)}“ gefunden.`;
    const icon = { "geprüft": "✅", "nicht bearbeiten": "🚫", "Vorschlag offen": "⏳", "noch nicht geprüft": "📝" };
    const links = await Promise.all(hits.map((h) => permalink(h.proposal)));
    const lines = hits.map((h, i) => `• ${icon[h.status]} ${link(h.url, h.name)} · ${h.status}${links[i] ? ` · ${link(links[i], "zum Vorschlag")}` : ""}`);
    return [`🔎 *${hits.length} Treffer* zu „${esc(q)}“`, ...lines].join("\n");
  },

  "/ohne-bild": async (c) => {
    if (!inChannel(c)) return notInChannel();
    const arg = c.text.trim();
    const count = /^\d+$/.test(arg) ? Number(arg) : arg ? NO_IMAGE_MAX : 5;
    if (count < 1 || count > NO_IMAGE_MAX) return `Bitte eine Anzahl von 1 bis ${NO_IMAGE_MAX} angeben, z. B. \`/ohne-bild 5\`.`;
    const name = /^\d+$/.test(arg) ? "" : arg;
    const r = await recipesWithoutImage(name);
    if (!r.total) return name ? `Kein Rezept ohne Bild zu „${esc(name)}“ gefunden.` : "🎉 Alle Rezepte haben ein Bild.";
    if (!r.list.length) return `🖼️ ${rezepte(r.total)} ohne Bild – alle wurden in den letzten 7 Tagen schon gezeigt. Gezielt suchen: \`/ohne-bild <Name>\``;
    const shown = r.list.slice(0, count);
    await postWithoutImage(shown, c.channel_id);
    log(`/ohne-bild ${arg} von ${c.user_id} → ${shown.length} Nachrichten`);
    const rest = r.list.length - shown.length;
    return [
      `🖼️ *${rezepte(r.total)} ohne Bild*${name ? ` zu „${esc(name)}“` : ""} – ${shown.length === 1 ? "eins steht" : `${shown.length} stehen`} jetzt als eigene Nachricht im Kanal.`,
      rest ? (name ? `Noch ${rest} weitere – bitte genauer suchen.` : `Noch ${rest} weitere: \`/ohne-bild ${Math.min(rest, NO_IMAGE_MAX)}\``) : "",
      r.shown_recently ? `${r.shown_recently} davon wurden in den letzten 7 Tagen schon gezeigt und kommen nicht nochmal.` : "",
    ].filter(Boolean).join("\n");
  },

  "/bild-neu": async (c) => {
    if (!inChannel(c)) return notInChannel();
    if (!googleReady()) return "Google ist nicht eingerichtet – `GEMINI_API_KEY` fehlt.";
    const q = c.text.trim();
    if (!q) return "Für welches Rezept? Beispiel: `/bild-neu Rahmwirsing` oder `/bild-neu 149567`";
    const { hit, hits } = await resolveRecipe(q);
    if (!hit) {
      if (!hits.length) return `Kein Rezept zu „${esc(q)}“ gefunden.`;
      return [`🔎 Mehrere Treffer zu „${esc(q)}“ – bitte genauer, oder mit ID:`, ...hits.map((h) => `• ${link(h.url, h.name)} · \`/bild-neu ${h.id}\``)].join("\n");
    }
    const r = await generateRecipeImage(hit.id, { replace: true });
    const m = noImageMessage({ id: r.id, name: r.name, url: r.url }, [`🎨 neues Bild für <@${c.user_id}>`, r.info, r.backup ? "altes Bild gesichert" : ""].filter(Boolean).join(" · "));
    await post(c.channel_id, m.text, m.blocks);
    log(`/bild-neu ${hit.id} von ${c.user_id}`);
    return `✅ Neues Bild für ${link(r.url, r.name)} ist da (Nachricht im Kanal).`;
  },

  "/bild-alle": async (c) => {
    if (!inChannel(c)) return notInChannel();
    if (!googleReady()) return "Google ist nicht eingerichtet – `GEMINI_API_KEY` fehlt.";
    const run = loadAll();
    if (allRunning()) return `⏳ Läuft schon: ${run.next} von ${run.ids.length} erledigt (${run.status === "paused" ? "angehalten" : "läuft"}). Anhalten oder weitermachen mit den Knöpfen an der Nachricht im Kanal.`;
    const n = (await allRecipeIds()).length;
    if (!n) return "Es gibt keine Rezepte.";
    await post(c.channel_id, "Alle Bilder erneuern?", [
      section(`🎨 <@${c.user_id}> möchte *alle ${rezepte(n)}* mit einem neuen KI-Bild von Google (${googleModel()}) versehen – auch die mit eigenem Foto. Kosten ${costText(n)}.\nSoll ich wirklich alle Bilder erneuern?`),
      { type: "actions", elements: [button(`Ja, alle ${n} Bilder erneuern`, "rz_all_yes1", `${c.user_id}:${n}`, "primary"), button("Abbrechen", "rz_all_no", c.user_id)] },
    ]);
    return "Die Rückfrage steht im Kanal – nur du kannst sie bestätigen.";
  },

  "/pro-tag": async (c) => {
    const arg = c.text.trim();
    if (!arg) {
      const p = perDay();
      return `📅 Rezept-Qualität prüft *${rezepte(p.value)}* pro Tag${p.source === "Weboberfläche" ? "" : ` (${p.source})`}. Ändern: \`/pro-tag 8\``;
    }
    if (!inChannel(c)) return notInChannel();
    if (!/^\d+$/.test(arg)) return "Bitte nur eine Zahl angeben, z. B. `/pro-tag 8`.";
    setPerDay(Number(arg));
    log(`/pro-tag ${arg} von ${c.user_id}`);
    return `📅 Ab jetzt prüft Rezept-Qualität *${rezepte(Number(arg))}* pro Tag.`;
  },

  "/pruefen": async (c) => {
    if (!inChannel(c)) return notInChannel();
    const arg = c.text.trim();
    if (arg && !/^\d+$/.test(arg)) return "Bitte nur eine Zahl angeben, z. B. `/pruefen 3`.";
    if (readStatus(QUALITY, "status.json")?.running) return "⏳ Die Qualitätsprüfung läuft gerade schon.";
    if (hasStartRequest(QUALITY)) return "⏳ Die Qualitätsprüfung startet gleich schon.";
    if (arg) addToday(Number(arg));
    const p = await pending();
    if (!p.batch.length) {
      if (!p.total) return "🎉 Es gibt gerade nichts zu prüfen.";
      if (!p.free) return `⏳ Es warten schon ${p.open_quality} Qualitäts-Vorschläge auf dich. Entscheide erst ein paar (\`/offen\`), dann geht es weiter.`;
      return "📅 Das Tageslimit ist erreicht. Mit `/pruefen 3` prüft der Agent jetzt noch 3 weitere Rezepte.";
    }
    requestStart(QUALITY, "slack");
    log(`/pruefen ${arg} von ${c.user_id} → ${p.batch.length} Rezepte`);
    return `🔍 Die Qualitätsprüfung startet in spätestens 30 Sekunden mit ${rezepte(p.batch.length)}. Die Vorschläge erscheinen im Kanal.`;
  },
};

async function onCommand(c) {
  const run = commands[c.command];
  if (!run) return respond(c.response_url, `Unbekannter Befehl ${c.command}. \`/hilfe\` zeigt alle Befehle.`);
  const text = await run({ ...c, text: c.text || "" }).catch((e) => `⚠️ ${e.message}`);
  await respond(c.response_url, text);
  if (!["/pro-tag", "/pruefen", "/ohne-bild"].includes(c.command)) log(`${c.command} von ${c.user_id}`);
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
        ? "🔄 Die Slack-App wurde aktualisiert und braucht *neue Berechtigungen*: bitte unter api.slack.com/apps → Rezept-Helfer → „Install App“ neu installieren."
        : "🔄 Die Slack-App wurde aktualisiert (z. B. neue Befehle) – `/hilfe` zeigt alle.");
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
