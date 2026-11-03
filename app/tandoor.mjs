#!/usr/bin/env node
// Werkzeug für die Rezept-Agenten: liest Tandoor und legt nur Entwürfe an. Übernehmen/Verwerfen geht nur über die Knöpfe in Slack.
// Autor: SebastianInTheWild · MIT-Lizenz
//
//   node tandoor.mjs context              Standard, Vorlage (Rahmwirsing), Einheiten, Schlagwörter, Lebensmittel
//   node tandoor.mjs job                  Aktueller Auftrag aus Slack (Link, Foto oder Änderungswunsch)
//   node tandoor.mjs fetch-url [url]      Link aus dem Auftrag über Tandoors Import auslesen
//   node tandoor.mjs fetch-video [url]    Reel/Short aus dem Auftrag: Beschreibung, Text aus dem Video (Gemini), Standbilder
//   node tandoor.mjs fetch-media          Sprachnachrichten/Video-Dateien aus dem Auftrag: was gesagt (und gezeigt) wird, Standbilder
//   node tandoor.mjs search "<name>"      Rezepte mit ähnlichem Namen (Doppelte erkennen)
//   node tandoor.mjs recipe <id>          Ein Rezept im einfachen Format
//   node tandoor.mjs pending [--count]    Rezepte, die geprüft werden sollen (Qualitäts-Agent)
//   node tandoor.mjs propose              <AGENT_DATA>/entwurf.json prüfen, als Entwurf anlegen und in Slack zeigen (DRY=1: nur zeigen)
//   node tandoor.mjs stats [--text] [--post] Statistik: gesamt, geprüft, offen, noch zu prüfen (--post: in den Slack-Kanal)
//   node tandoor.mjs reply "<text>"       Antwort im Slack-Thread des Auftrags (z. B. wenn kein Rezept zu finden war)
//   node tandoor.mjs plan-context         Wochenplan: Auftrag, Zeitraum, alle Rezepte kompakt, zuletzt Geplantes
//   node tandoor.mjs plan-propose         <AGENT_DATA>/wochenplan.json prüfen und in Slack vorschlagen

import "./lib/umgebung.mjs"; // Einstellungen aus der Weboberfläche (auch beim Aufruf von Hand)
import { existsSync, writeFileSync } from "node:fs";
import { getRecipe, simplify } from "./lib/tandoor.mjs";
import { context, pending, search, fetchUrl, fetchVideo, fetchMedia, propose, stats, statsMessage, loadJob, saveJob, loadStore, DRAFT_FILE, CHANNEL } from "./lib/rezepte.mjs";
import { post, slackReady } from "./lib/slack.mjs";
import { planContext, proposePlan, PLAN_FILE } from "./lib/wochenplan.mjs";

const out = (x) => console.log(JSON.stringify(x, null, 1));
const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case "context":
      out(await context());
      break;
    case "job": {
      const job = loadJob();
      if (!job) {
        out({ job: null, hint: "Kein Auftrag – dieser Lauf kommt nicht aus Slack." });
        break;
      }
      if (!existsSync(DRAFT_FILE())) writeFileSync(DRAFT_FILE(), "{}");
      const extra = {};
      if (job.kind === "revise") {
        const p = loadStore().proposals[job.proposal];
        extra.proposal = p;
        extra.current_draft = p && simplify(await getRecipe(p.draft_id));
        if (p?.original_id) extra.original_id = p.original_id;
      }
      out({ job, ...extra, draft_file: DRAFT_FILE() });
      break;
    }
    case "fetch-url":
      out(await fetchUrl(args[0]));
      break;
    case "fetch-video":
      out(await fetchVideo(args[0]));
      break;
    case "fetch-media":
      out(await fetchMedia());
      break;
    case "search":
      out(await search(args.join(" ")));
      break;
    case "recipe":
      out(simplify(await getRecipe(Number(args[0]))));
      break;
    case "pending": {
      const p = await pending();
      if (args.includes("--count")) console.log(p.batch.length);
      else {
        if (!existsSync(DRAFT_FILE())) writeFileSync(DRAFT_FILE(), "{}");
        out({ total: p.total, open_proposals: p.open_proposals, draft_file: DRAFT_FILE(), recipes: await Promise.all(p.batch.map(async (r) => simplify(await getRecipe(r.id)))) });
      }
      break;
    }
    case "stats": {
      const s = await stats();
      if (args.includes("--post")) {
        if (!slackReady() || !CHANNEL()) throw new Error("Slack ist nicht eingerichtet (SLACK_BOT_TOKEN/SLACK_CHANNEL)");
        if (process.env.DRY !== "1") await post(CHANNEL(), statsMessage(s));
      }
      out(args.includes("--text") ? { ...s, text: statsMessage(s) } : s);
      break;
    }
    case "propose": {
      const r = await propose();
      out(r);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case "plan-context":
      if (!existsSync(PLAN_FILE())) writeFileSync(PLAN_FILE(), "{}");
      out(await planContext());
      break;
    case "plan-propose": {
      const r = await proposePlan();
      out(r);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case "reply": {
      const job = loadJob();
      const text = args.join(" ").trim();
      if (!job || !text) throw new Error("reply braucht einen Auftrag und einen Text");
      if (process.env.DRY === "1") {
        out({ ok: true, dry: true, text });
        break;
      }
      if (slackReady()) await post(job.channel || CHANNEL(), text, undefined, job.thread_ts || job.ts);
      saveJob({ ...job, replied: true });
      out({ ok: true });
      break;
    }
    default:
      console.error("Befehle: context | job | plan-context | plan-propose | fetch-url [url] | fetch-video [url] | fetch-media | search <name> | recipe <id> | pending [--count] | propose | stats [--text] [--post] | reply <text>");
      process.exitCode = 2;
  }
} catch (e) {
  out({ ok: false, error: e.message });
  process.exitCode = 1;
}
