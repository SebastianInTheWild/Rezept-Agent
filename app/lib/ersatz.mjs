// Ersatz-KI: Scheitert Claude am Nutzungslimit, übernimmt Google Gemini die Rezept-Arbeit – ohne Werkzeuge, in einer Anfrage.
// Gemini bekommt dieselben Anweisungen wie der Agent (prompt.md) und alle Daten, die der Agent sonst selbst holen würde
// (Auftrag, Standard, Einheiten, Link-/Video-Auslese, Fotos, Rezepte). Das Ergebnis läuft durch dieselbe Prüfung (propose);
// bei Fehlern darf Gemini bis zu zweimal korrigieren. Jeder Vorschlag sagt in „changes“, dass er von Gemini kommt.
//   ERSATZ_KI         leer = an, wenn GEMINI_API_KEY gesetzt ist; aus = nie (dann wie bisher alle 30 Minuten erneut versuchen)
//   ERSATZ_KI_MODELL  leer = gemini-flash-latest
// Abgedeckt: Agent „rezepte“ (Import aus Link, HelloFresh, Reel/Short, Foto, Text; Änderungswünsche im Thread) und
// „rezept-qualitaet“ (Verbesserungsvorschläge). Der Wochenplan wartet weiter auf Claude.
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getRecipe, simplify } from "./tandoor.mjs";
import { context, pending, search, fetchUrl, fetchVideo, propose, loadJob, saveJob, loadStore, DRAFT_FILE, CHANNEL } from "./rezepte.mjs";
import { isVideoUrl } from "./video.mjs";
import { imageType } from "./bild.mjs";
import { record, usageOf } from "./google-nutzung.mjs";
import { post, slackReady } from "./slack.mjs";
import { L } from "./i18n.mjs";

const GEMINI = "https://generativelanguage.googleapis.com";
export const fallbackModel = () => (process.env.ERSATZ_KI_MODELL || "").trim() || "gemini-flash-latest";
export const fallbackOn = () => Boolean(process.env.GEMINI_API_KEY) && !/^(aus|nein|off|0)$/i.test((process.env.ERSATZ_KI || "").trim());
/** Welche Agenten Gemini vertreten kann (agent.json → "fallback") */
export const FALLBACKS = ["rezepte", "qualitaet"];
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
Claude ist gerade nicht verfügbar, du vertrittst den Agenten. Du hast **keine Werkzeuge**: Alle Schritte mit \`node tandoor.mjs …\`, Read und Edit sind schon erledigt – ihre Ergebnisse stehen unten unter „DATEN“, Fotos und Standbilder hängen an (in der Reihenfolge der Liste \`attached_images\`).
Antworte ausschließlich mit **einem JSON-Objekt**, ohne Text drumherum:
- \`{"action": "propose", "draft": { … }}\` – \`draft\` ist genau der Inhalt, den der Agent in entwurf.json schreiben würde (Format oben).
- \`{"action": "reply", "text": "…"}\` – nur wenn es kein Rezept gibt (wie \`node tandoor.mjs reply\`).
Bei mehreren Rezepten (Qualitätsprüfung) bekommst du sie einzeln, je eine Anfrage.`;

const instructions = (agent) => `${agent.promptText.replaceAll("{{DATA}}", "<daten>")}\n${FRAME}`;

/** Eine Anfrage an Gemini, Ergebnis durch propose; bei Prüffehlern bis zu MAX_FIXES Korrekturen. */
async function draftAndPropose(agent, data, images, extraChange, log) {
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
    const d = answer.draft || answer;
    if (!d || typeof d !== "object") return { error: "Antwort ohne Entwurf" };
    if (Array.isArray(d.changes)) d.changes.push(extraChange);
    else d.changes = [extraChange];
    writeFileSync(DRAFT_FILE(), JSON.stringify(d, null, 1));
    const r = await propose();
    if (r.ok) return { proposal: r.proposal, name: d.name };
    log(`Gemini-Entwurf abgelehnt (${round + 1}/${MAX_FIXES + 1}): ${r.errors.join("; ").slice(0, 300)}`);
    d.changes = d.changes.filter((c) => c !== extraChange);
    contents.push({ role: "model", parts: [{ text: JSON.stringify(answer) }] }, { role: "user", parts: [{ text: `propose meldet ok: false mit diesen Fehlern – korrigiere den Entwurf und antworte wieder nur mit dem JSON-Objekt:\n${r.errors.join("\n")}` }] });
  }
  return { error: L("Gemini hat keinen gültigen Entwurf geliefert", "Gemini did not deliver a valid draft") };
}

const note = () => L(`Erstellt mit Google Gemini (${fallbackModel()}), weil das Claude-Limit erreicht war – bitte genauer ansehen`, `Created with Google Gemini (${fallbackModel()}) because the Claude limit was reached – please check carefully`);

// ---------- Agent „rezepte“: Auftrag aus Slack ----------

async function importJob(agent, log) {
  const job = loadJob();
  if (!job) return { ok: false, note: "kein Auftrag" };
  if (job.result || job.replied) return { ok: true, note: L("Claude war vor dem Limit schon fertig", "Claude had already finished before the limit") };
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
        log(`Gemini-Ersatz: Video ${url} auswerten`);
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
  const r = await draftAndPropose(agent, data, shown, note(), log);
  if (r.reply) {
    if (slackReady()) await post(job.channel || CHANNEL(), r.reply, undefined, job.thread_ts || job.ts);
    saveJob({ ...loadJob(), replied: true });
    return { ok: true, note: L("Gemini: kein Rezept gefunden (Antwort im Thread)", "Gemini: no recipe found (reply in thread)") };
  }
  if (r.error) return { ok: false, note: r.error };
  // Doppelte erkennen wie der Agent mit „search“ – als Hinweis im Log (der Vorschlag steht schon)
  const dup = (await search(r.name).catch(() => [])).filter((x) => x.name.toLowerCase() === r.name.toLowerCase());
  if (dup.length) log(`Gemini-Ersatz: „${r.name}“ gibt es schon (#${dup.map((x) => x.id).join(", #")})`);
  return { ok: true, note: L(`Gemini-Ersatz: Vorschlag „${r.name}“`, `Gemini fallback: proposal “${r.name}”`) };
}

// ---------- Agent „rezept-qualitaet“: Verbesserungsvorschläge ----------

async function qualityRun(agent, log) {
  const p = await pending();
  if (!p.batch.length) return { ok: true, note: "nichts zu tun" };
  const ctx = await context();
  if (!existsSync(DRAFT_FILE())) writeFileSync(DRAFT_FILE(), "{}");
  const done = [];
  const failed = [];
  for (const item of p.batch) {
    const recipe = simplify(await getRecipe(item.id));
    try {
      const r = await draftAndPropose(agent, { context: ctx, recipes: [recipe], hint: `Prüfe dieses eine Rezept; original_id = ${recipe.id}.` }, [], note(), log);
      if (r.proposal) done.push(recipe.name);
      else failed.push(`${recipe.name}: ${r.error || r.reply || "?"}`);
    } catch (e) {
      failed.push(`${recipe.name}: ${e.message}`);
      if (/quota|429|API key/i.test(e.message)) break; // Google selbst am Limit – nicht weiter versuchen
    }
  }
  if (failed.length) log(`Gemini-Ersatz: nicht geklappt – ${failed.join(" · ").slice(0, 500)}`);
  return { ok: done.length > 0, note: L(`Gemini-Ersatz: ${done.length} von ${p.batch.length} geprüft`, `Gemini fallback: ${done.length} of ${p.batch.length} checked`), count: done.length };
}

/** Agent vertreten. agent = loadAgent(id) mit agent.fallback ("rezepte" | "qualitaet"). */
export async function runFallback(agent, { log = console.log } = {}) {
  if (!fallbackOn()) return { ok: false, note: "Ersatz-KI aus" };
  if (agent.fallback === "rezepte") return importJob(agent, log);
  if (agent.fallback === "qualitaet") return qualityRun(agent, log);
  return { ok: false, note: `kein Ersatz für ${agent.fallback}` };
}
