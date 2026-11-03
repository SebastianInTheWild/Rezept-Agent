// Google Gemini als KI-Anbieter für die Rezept-Agenten – statt Claude oder als Ersatz, wenn Claude am Nutzungslimit scheitert.
// Gemini arbeitet ohne Werkzeuge in einer Anfrage: Es bekommt dieselben Anweisungen wie der Agent (prompt.md) und alle Daten,
// die der Agent sonst selbst holen würde (Auftrag, Standard, Einheiten, Link-/Video-Auslese, Fotos, Rezepte, Wochenplan-Daten).
// Das Ergebnis läuft durch dieselbe Prüfung (propose bzw. plan-propose); bei Fehlern darf Gemini bis zu zweimal korrigieren.
// Jeder Vorschlag sagt, dass er von Gemini kommt.
//   KI_ANBIETER          Reihenfolge, z. B. „claude,google“ (Standard: Claude, beim Claude-Limit Gemini), „google,claude“
//                        (Gemini zuerst, bei Fehlern Claude), „google“ oder „claude“ (nur dieser). Gemini braucht GEMINI_API_KEY.
//   GEMINI_TEXT_MODELL   leer = gemini-flash-latest
// Abgedeckt (agent.json → "fallback"): „rezepte“ (Import aus Link, HelloFresh, Reel/Short, Foto, Text; Änderungswünsche),
// „qualitaet“ (Verbesserungsvorschläge), „wochenplan“ (Plan und Änderungswünsche).
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getRecipe, simplify } from "./tandoor.mjs";
import { context, pending, search, fetchUrl, fetchVideo, propose, loadJob, saveJob, loadStore, DRAFT_FILE, CHANNEL } from "./rezepte.mjs";
import { planContext, proposePlan, PLAN_FILE } from "./wochenplan.mjs";
import { isVideoUrl } from "./video.mjs";
import { imageType } from "./bild.mjs";
import { record, usageOf } from "./google-nutzung.mjs";
import { post, slackReady } from "./slack.mjs";
import { L } from "./i18n.mjs";

const GEMINI = "https://generativelanguage.googleapis.com";
export const fallbackModel = () => (process.env.GEMINI_TEXT_MODELL || "").trim() || "gemini-flash-latest";
export const PROVIDERS = ["claude", "google"];
/**
 * Reihenfolge der KI-Anbieter für Agenten mit „fallback“ (KI_ANBIETER). Ohne Angabe Claude, danach Gemini (nur am Limit).
 * Gemini fällt weg, wenn kein GEMINI_API_KEY eingetragen ist; bleibt nichts übrig, Claude.
 */
export function providerOrder() {
  const wanted = (process.env.KI_ANBIETER || "")
    .toLowerCase()
    .split(/[\s,;>]+/)
    .filter((p) => PROVIDERS.includes(p));
  const list = [...new Set(wanted.length ? wanted : ["claude", "google"])].filter((p) => p !== "google" || Boolean(process.env.GEMINI_API_KEY));
  return list.length ? list : ["claude"];
}
const MAX_FIXES = 2;
const MAX_IMAGES = 6;

// ---------- Gemini ----------

async function gemini(contents) {
  const body = JSON.stringify({ contents, generationConfig: { responseMimeType: "application/json", temperature: 0.2 } });
  let r, j;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${GEMINI}/v1beta/models/${encodeURIComponent(fallbackModel())}:generateContent`, { method: "POST", headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" }, body });
    j = await r.json().catch(() => ({}));
    if (![500, 502, 503, 504].includes(r.status) || attempt >= 2) break;
    await new Promise((res) => setTimeout(res, (attempt + 1) * 10_000));
  }
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!r.ok || !text) throw new Error(`Gemini (${fallbackModel()}): ${String(j.error?.message || j.promptFeedback?.blockReason || j.candidates?.[0]?.finishReason || `HTTP ${r.status}`).slice(0, 200)}`);
  record("text", fallbackModel(), usageOf(j));
  return text;
}

/** JSON aus der Antwort lesen (auch mit ```json … ``` drumherum) */
export function parseAnswer(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(t);
}

const imagePart = (file) => {
  try {
    const buf = readFileSync(file);
    return { inline_data: { mime_type: imageType(buf).mime, data: buf.toString("base64") } };
  } catch {
    return null;
  }
};

const FRAME = `
## So arbeitest du jetzt (statt mit Werkzeugen)
Du vertrittst den Agenten. Du hast **keine Werkzeuge**: Alle Schritte mit \`node tandoor.mjs …\`, Read und Edit sind schon erledigt – ihre Ergebnisse stehen unten unter „DATEN“, Fotos und Standbilder hängen an (in der Reihenfolge der Liste \`attached_images\`).
Antworte ausschließlich mit **einem JSON-Objekt**, ohne Text drumherum:
- \`{"action": "propose", "draft": { … }}\` – \`draft\` ist genau der Inhalt, den der Agent in seine Datei (entwurf.json bzw. wochenplan.json) schreiben würde (Format oben).
- \`{"action": "reply", "text": "…"}\` – nur wenn es nichts vorzuschlagen gibt (wie \`node tandoor.mjs reply\`).
Bei mehreren Rezepten (Qualitätsprüfung) bekommst du sie einzeln, je eine Anfrage.`;

const instructions = (agent) => `${agent.promptText.replaceAll("{{DATA}}", "<daten>")}\n${FRAME}`;

/**
 * Eine Anfrage an Gemini; den Entwurf schreibt write(d) in die Datei des Agenten, check() prüft und schlägt vor
 * (propose/proposePlan → { ok, errors }). Bei Prüffehlern bis zu MAX_FIXES Korrekturen.
 */
async function askAndCheck(agent, data, images, { write, check, log }) {
  const parts = [{ text: instructions(agent) }, { text: `DATEN:\n${JSON.stringify(data, null, 1)}` }, ...images.map((f) => imagePart(f)).filter(Boolean)];
  const contents = [{ role: "user", parts }];
  for (let round = 0; round <= MAX_FIXES; round++) {
    const raw = await gemini(contents);
    let answer;
    try {
      answer = parseAnswer(raw);
    } catch (e) {
      contents.push({ role: "model", parts: [{ text: raw }] }, { role: "user", parts: [{ text: `Das war kein gültiges JSON (${e.message}). Antworte nur mit dem JSON-Objekt.` }] });
      continue;
    }
    if (answer.action === "reply") return { reply: String(answer.text || "").slice(0, 2000) };
    const d = answer.draft || answer.plan || answer;
    if (!d || typeof d !== "object") return { error: "Antwort ohne Entwurf" };
    write(structuredClone(d));
    const r = await check();
    if (r.ok) return { ok: true, result: r, draft: d };
    log(`Gemini-Entwurf abgelehnt (${round + 1}/${MAX_FIXES + 1}): ${r.errors.join("; ").slice(0, 300)}`);
    contents.push({ role: "model", parts: [{ text: JSON.stringify(answer) }] }, { role: "user", parts: [{ text: `Die Prüfung meldet ok: false mit diesen Fehlern – korrigiere und antworte wieder nur mit dem JSON-Objekt:\n${r.errors.join("\n")}` }] });
  }
  return { error: L("Gemini hat keinen gültigen Entwurf geliefert", "Gemini did not deliver a valid draft") };
}

// Hinweis im Vorschlag: woher er kommt (und warum, wenn Gemini nur eingesprungen ist)
const note = (reason) =>
  reason === "limit"
    ? L(`Erstellt mit Google Gemini (${fallbackModel()}), weil das Claude-Limit erreicht war – bitte genauer ansehen`, `Created with Google Gemini (${fallbackModel()}) because the Claude limit was reached – please check carefully`)
    : L(`Erstellt mit Google Gemini (${fallbackModel()})`, `Created with Google Gemini (${fallbackModel()})`);

// Entwurf mit Hinweis in „changes“ in entwurf.json schreiben
const writeDraft = (reason) => (d) => {
  d.changes = [...(Array.isArray(d.changes) ? d.changes : []), note(reason)];
  mkdirSync(dirname(DRAFT_FILE()), { recursive: true });
  writeFileSync(DRAFT_FILE(), JSON.stringify(d, null, 1));
};

async function replyInThread(job, text) {
  if (slackReady()) await post(job.channel || CHANNEL(), text, undefined, job.thread_ts || job.ts);
  saveJob({ ...loadJob(), replied: true });
}

// ---------- Agent „rezepte“: Auftrag aus Slack ----------

async function importJob(agent, log, reason) {
  const job = loadJob();
  if (!job) return { ok: false, note: "kein Auftrag" };
  if (job.result || job.replied) return { ok: true, note: L("Auftrag war schon erledigt", "Job was already done") };
  if (!existsSync(DRAFT_FILE())) writeFileSync(DRAFT_FILE(), "{}");
  const data = { job, context: await context() };
  const images = [...(job.images || [])];
  if (job.kind === "revise") {
    const p = loadStore().proposals[job.proposal];
    data.proposal = p;
    data.current_draft = p && simplify(await getRecipe(p.draft_id));
    if (p?.original_id) data.original_id = p.original_id;
  } else {
    // Links und Videos so auslesen, wie es der Agent mit fetch-url / fetch-video täte
    data.sources = [];
    for (const url of job.urls || []) {
      if (isVideoUrl(url)) {
        log(`Gemini: Video ${url} auswerten`);
        const v = await fetchVideo(url).catch((e) => ({ ok: false, msg: e.message }));
        data.sources.push({ url, type: "video", ...v });
        const frames = v.frames || [];
        images.push(...frames.filter((f) => /-fertig\.jpe?g$/.test(f.file)).map((f) => f.file), ...frames.filter((f) => !/-fertig\./.test(f.file)).slice(0, 3).map((f) => f.file));
        // Link aus der Beschreibung zum ganzen Rezept (Blog) – den ersten mitlesen
        const blog = (v.links || [])[0];
        if (blog) data.sources.push({ url: blog, type: "link aus der Videobeschreibung", ...(await fetchUrl(blog).catch((e) => ({ ok: false, msg: e.message }))) });
      } else {
        const s = await fetchUrl(url).catch((e) => ({ ok: false, msg: e.message }));
        data.sources.push({ url, type: "link", ...s });
        if (s.image_file) images.push(s.image_file);
      }
    }
  }
  const shown = images.filter((f) => existsSync(f)).slice(0, MAX_IMAGES);
  data.attached_images = shown;
  const r = await askAndCheck(agent, data, shown, { write: writeDraft(reason), check: propose, log });
  if (r.reply) {
    await replyInThread(job, r.reply);
    return { ok: true, note: L("Gemini: nichts angelegt (Antwort im Thread)", "Gemini: nothing created (reply in thread)") };
  }
  if (r.error) return { ok: false, note: r.error };
  // Doppelte erkennen wie der Agent mit „search“ – als Hinweis im Log (der Vorschlag steht schon)
  const dup = (await search(r.draft.name).catch(() => [])).filter((x) => x.name.toLowerCase() === String(r.draft.name).toLowerCase());
  if (dup.length) log(`Gemini: „${r.draft.name}“ gibt es schon (#${dup.map((x) => x.id).join(", #")})`);
  return { ok: true, note: L(`Gemini: Vorschlag „${r.draft.name}“`, `Gemini: proposal “${r.draft.name}”`) };
}

// ---------- Agent „rezept-qualitaet“: Verbesserungsvorschläge ----------

async function qualityRun(agent, log, reason) {
  const p = await pending();
  if (!p.batch.length) return { ok: true, note: "nichts zu tun" };
  const ctx = await context();
  if (!existsSync(DRAFT_FILE())) writeFileSync(DRAFT_FILE(), "{}");
  const done = [];
  const failed = [];
  for (const item of p.batch) {
    const recipe = simplify(await getRecipe(item.id));
    try {
      const r = await askAndCheck(agent, { context: ctx, recipes: [recipe], hint: `Prüfe dieses eine Rezept; original_id = ${recipe.id}.` }, [], { write: writeDraft(reason), check: propose, log });
      if (r.ok) done.push(recipe.name);
      else failed.push(`${recipe.name}: ${r.error || r.reply || "?"}`);
    } catch (e) {
      failed.push(`${recipe.name}: ${e.message}`);
      if (/quota|429|API key/i.test(e.message)) break; // Google selbst am Limit – nicht weiter versuchen
    }
  }
  if (failed.length) log(`Gemini: nicht geklappt – ${failed.join(" · ").slice(0, 500)}`);
  return { ok: done.length > 0, note: L(`Gemini: ${done.length} von ${p.batch.length} geprüft`, `Gemini: ${done.length} of ${p.batch.length} checked`), count: done.length };
}

// ---------- Agent „wochenplan“ ----------

async function planRun(agent, log, reason) {
  const job = loadJob();
  if (job?.result || job?.replied) return { ok: true, note: L("Auftrag war schon erledigt", "Job was already done") };
  const data = await planContext();
  const write = (d) => {
    const by = note(reason);
    d.summary = [String(d.summary || "").trim(), `(${by})`].filter(Boolean).join(" ");
    mkdirSync(dirname(PLAN_FILE()), { recursive: true });
    writeFileSync(PLAN_FILE(), JSON.stringify(d, null, 1));
  };
  const r = await askAndCheck(agent, data, [], { write, check: proposePlan, log });
  if (r.reply) {
    if (job) await replyInThread(job, r.reply);
    else if (slackReady() && CHANNEL()) await post(CHANNEL(), r.reply);
    return { ok: true, note: L("Gemini: kein Plan (Antwort im Thread)", "Gemini: no plan (reply in thread)") };
  }
  if (r.error) return { ok: false, note: r.error };
  return { ok: true, note: L(`Gemini: Wochenplan mit ${r.result.days.length} Tagen`, `Gemini: meal plan with ${r.result.days.length} days`) };
}

/**
 * Agent mit Gemini ausführen. agent = loadAgent(id) mit agent.fallback ("rezepte" | "qualitaet" | "wochenplan");
 * reason = "limit" (Claude am Limit) oder "primary" (Gemini ist als Anbieter eingestellt).
 */
export async function runFallback(agent, { log = console.log, reason = "limit" } = {}) {
  if (!process.env.GEMINI_API_KEY) return { ok: false, note: "GEMINI_API_KEY fehlt" };
  if (agent.fallback === "rezepte") return importJob(agent, log, reason);
  if (agent.fallback === "qualitaet") return qualityRun(agent, log, reason);
  if (agent.fallback === "wochenplan") return planRun(agent, log, reason);
  return { ok: false, note: `kein Gemini-Weg für ${agent.fallback}` };
}
