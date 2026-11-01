// Rezeptfoto mit KI erzeugen, wenn ein Rezept kein Bild hat.
// Anbieter (BILD_ANBIETER, sonst automatisch in dieser Reihenfolge):
//   google     – Google Gemini „Nano Banana“ (kostenpflichtig, sehr realistisch), GEMINI_API_KEY, Modell GOOGLE_BILD_MODELL (Standard gemini-nano-banana-2.1)
//   cloudflare – Cloudflare Workers AI (kostenlos im Free-Plan, 10.000 Neurons/Tag) mit FLUX.2 Klein 9B, Ersatz FLUX.1 Schnell; CF_ACCOUNT_ID, CF_AI_TOKEN
//   openai     – OpenAI GPT Image (kostenpflichtig), OPENAI_API_KEY
// Schlägt der gewählte Anbieter fehl, springt Cloudflare ein (wenn eingerichtet).
// Optional: BILD_MODELL (Modell des gewählten Anbieters), BILD_QUALITAET (OpenAI), BILD_PRO_TAG (Standard 10).
// Verbrauchte Neuronen: Cloudflare-GraphQL (Token braucht zusätzlich „Account Analytics: Read“), Kontingent CF_NEURONEN_PRO_TAG (Standard 10.000).
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const READY = {
  google: () => Boolean(process.env.GEMINI_API_KEY),
  cloudflare: () => Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_AI_TOKEN),
  openai: () => Boolean(process.env.OPENAI_API_KEY),
};
const cloudflareReady = READY.cloudflare;
export const provider = () => (process.env.BILD_ANBIETER || Object.keys(READY).find((p) => READY[p]()) || "").toLowerCase();
export const imageReady = () => Boolean(READY[provider()]?.());
export const imageSetupHint = "für KI-Fotos GEMINI_API_KEY (Google) oder CF_ACCOUNT_ID und CF_AI_TOKEN (Cloudflare, kostenlos) als Umgebungsvariablen setzen";
const NAMES = { google: "Google Nano Banana", cloudflare: "Cloudflare FLUX", openai: "OpenAI GPT Image" };
let lastProvider = "";

// Bildbeschreibung aus dem Rezept: der Agent kann mit image_prompt nachhelfen (wie das fertige Gericht angerichtet aussieht)
export function imagePrompt(d) {
  const main = d.steps.flatMap((s) => s.ingredients || []).filter((i) => !i.no_amount).slice(0, 8).map((i) => i.food);
  return [
    `Appetizing, realistic food photograph of the finished dish "${d.name}".`,
    d.image_prompt ? `The dish: ${d.image_prompt}.` : d.description ? `Description (German): ${d.description}` : "",
    main.length ? `Main ingredients (German): ${main.join(", ")}.` : "",
    "Home-cooked style, served on a plain plate or in a baking dish on a wooden kitchen table, soft natural daylight, shallow depth of field, slightly from above.",
    "No text, no letters, no watermark, no hands, no people.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000);
}

// Tageslimit gegen unerwartete Kosten bzw. ein leeres Kontingent
function countToday(dir) {
  const file = join(dir, "bilder-zaehler.json");
  const day = new Date().toISOString().slice(0, 10);
  const c = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return { file, day, n: c.day === day ? c.n : 0 };
}

const cfUrl = (model) => `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`;
async function cfResult(r) {
  const j = await r.json().catch(() => ({}));
  const img = j.result?.image;
  if (!r.ok || !img) throw new Error(j.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`);
  return Buffer.from(img, "base64");
}

async function cloudflare(prompt, model = "@cf/black-forest-labs/flux-2-klein-9b") {
  const headers = { Authorization: `Bearer ${process.env.CF_AI_TOKEN}` };
  try {
    // FLUX.2-Modelle erwarten ein Formular
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", "1280");
    form.append("height", "832");
    return await cfResult(await fetch(cfUrl(model), { method: "POST", headers, body: form }));
  } catch (e) {
    // Ersatz: FLUX.1 Schnell (JSON, sehr sparsam)
    try {
      return await cfResult(await fetch(cfUrl("@cf/black-forest-labs/flux-1-schnell"), { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ prompt, steps: 8 }) }));
    } catch (e2) {
      throw new Error(`Cloudflare: ${e.message} / Ersatz: ${e2.message}`);
    }
  }
}

// Heute verbrauchte Neuronen laut Cloudflare (das Free-Kontingent zählt ab 00:00 UTC; die Zahlen kommen mit etwa einer Minute Verzug)
export async function neurons() {
  if (!cloudflareReady()) throw new Error("Cloudflare ist nicht eingerichtet (CF_ACCOUNT_ID, CF_AI_TOKEN)");
  const query = "query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:100,filter:{date_geq:$d}){sum{totalNeurons} count}}}}";
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CF_AI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { a: process.env.CF_ACCOUNT_ID, d: new Date().toISOString().slice(0, 10) } }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errors?.length || !j.data) {
    const msg = j.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`;
    throw new Error(/not authorized/i.test(msg) ? "der Cloudflare-Token darf die Nutzung nicht lesen – Berechtigung „Account Analytics: Read“ ergänzen" : `Cloudflare: ${msg}`);
  }
  const groups = j.data.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
  const used = Math.round(groups.reduce((n, g) => n + (g.sum?.totalNeurons || 0), 0));
  const limit = Number(process.env.CF_NEURONEN_PRO_TAG || 10_000);
  return { used, limit, free: Math.max(0, limit - used), requests: groups.reduce((n, g) => n + (g.count || 0), 0) };
}

const num = (n) => n.toLocaleString("de-DE");
export const neuronsText = (n) => `heute noch ${num(n.free)} von ${num(n.limit)} Neuronen frei (${num(n.used)} verbraucht)`;

// Google Gemini API (Nano Banana): Bild kommt als base64 in candidates[].content.parts[].inlineData
async function google(prompt, model = "gemini-nano-banana-2.1") {
  // Das ältere gemini-2.5-flash-image kennt keine Bildgröße, nur das Seitenverhältnis
  const imageConfig = { aspectRatio: "3:2", ...(/2\.5-flash-image/.test(model) ? {} : { imageSize: "1K" }) };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig } }),
  });
  const j = await r.json().catch(() => ({}));
  const cand = j.candidates?.[0];
  const img = cand?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!r.ok || !img) {
    const why = j.error?.message || j.promptFeedback?.blockReason || cand?.finishReason || `HTTP ${r.status}`;
    throw new Error(`Google (${model}): ${String(why).slice(0, 200)}`);
  }
  return Buffer.from((img.inlineData || img.inline_data).data, "base64");
}

async function openai(prompt) {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.BILD_MODELL || "gpt-image-2", prompt, size: "1536x1024", quality: process.env.BILD_QUALITAET || "medium", output_format: "jpeg", output_compression: 85, n: 1 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data?.[0]?.b64_json) throw new Error(`OpenAI: ${j.error?.message || r.status}`);
  return Buffer.from(j.data[0].b64_json, "base64");
}

const RUN = {
  google: (prompt) => google(prompt, (process.env.GOOGLE_BILD_MODELL || process.env.BILD_MODELL || "").trim() || undefined),
  cloudflare: (prompt) => cloudflare(prompt, process.env.BILD_MODELL || undefined),
  openai,
};

export async function generateImage(d, dir) {
  if (!imageReady()) throw new Error(`kein Bild-Anbieter eingerichtet – ${imageSetupHint}`);
  mkdirSync(dir, { recursive: true });
  const limit = Number(process.env.BILD_PRO_TAG || 10);
  const cnt = countToday(dir);
  if (cnt.n >= limit) throw new Error(`Tageslimit von ${limit} Bildern erreicht (BILD_PRO_TAG)`);
  const prompt = imagePrompt(d);
  const main = provider();
  let img;
  try {
    img = await RUN[main](prompt);
    lastProvider = main;
  } catch (e) {
    // Ersatz: Cloudflare mit seinem Standardmodell (BILD_MODELL gilt nur für den gewählten Anbieter)
    if (main === "cloudflare" || !cloudflareReady()) throw e;
    try {
      img = await cloudflare(prompt);
      lastProvider = "cloudflare";
    } catch (e2) {
      throw new Error(`${e.message} / Ersatz ${e2.message}`);
    }
  }
  writeFileSync(cnt.file, JSON.stringify({ day: cnt.day, n: cnt.n + 1 }));
  return img;
}

/** Kurzer Hinweis, womit das letzte Bild erzeugt wurde (bei Cloudflare mit den freien Neuronen). */
export async function lastImageNote() {
  const name = NAMES[lastProvider] || lastProvider;
  if (lastProvider !== "cloudflare") return name;
  const n = await neurons().then(neuronsText, (e) => `Neuronen unbekannt: ${e.message}`);
  return `${name}${provider() !== "cloudflare" ? " (Ersatz)" : ""} · ${n}`;
}

// Bildformat an den ersten Bytes erkennen (FLUX liefert je nach Modell JPEG oder PNG)
export const imageType = (buf) =>
  buf[0] === 0x89 && buf[1] === 0x50 ? { mime: "image/png", ext: "png" } : buf[0] === 0x52 && buf[8] === 0x57 ? { mime: "image/webp", ext: "webp" } : { mime: "image/jpeg", ext: "jpg" };
