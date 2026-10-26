#!/usr/bin/env node
// Werkzeug für die Rezept-Agenten: liest Tandoor und legt nur Entwürfe an. Übernehmen/Verwerfen geht nur über die Knöpfe in Slack.
// Autor: SebastianInTheWild · MIT-Lizenz
//
//   node tandoor.mjs context              Standard, Vorlage (Rahmwirsing), Einheiten, Schlagwörter, Lebensmittel
//   node tandoor.mjs job                  Aktueller Auftrag aus Slack (Link, Foto oder Änderungswunsch)
//   node tandoor.mjs fetch-url [url]      Link aus dem Auftrag über Tandoors Import auslesen
//   node tandoor.mjs search "<name>"      Rezepte mit ähnlichem Namen (Doppelte erkennen)
//   node tandoor.mjs recipe <id>          Ein Rezept im einfachen Format
//   node tandoor.mjs pending [--count]    Rezepte, die geprüft werden sollen (Qualitäts-Agent)
//   node tandoor.mjs propose              <AGENT_DATA>/entwurf.json prüfen, als Entwurf anlegen und in Slack zeigen (DRY=1: nur zeigen)
//   node tandoor.mjs reply "<text>"       Antwort im Slack-Thread des Auftrags (z. B. wenn kein Rezept zu finden war)

import { existsSync, writeFileSync } from "node:fs";
import { getRecipe, simplify } from "./lib/tandoor.mjs";
import { context, pending, search, fetchUrl, propose, loadJob, saveJob, loadStore, DRAFT_FILE, CHANNEL } from "./lib/rezepte.mjs";
import { post, slackReady } from "./lib/slack.mjs";

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
    case "propose": {
      const r = await propose();
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
      console.error("Befehle: context | job | fetch-url [url] | search <name> | recipe <id> | pending [--count] | propose | reply <text>");
      process.exitCode = 2;
  }
} catch (e) {
  out({ ok: false, error: e.message });
  process.exitCode = 1;
}
