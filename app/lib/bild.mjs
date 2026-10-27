// Rezeptfoto mit KI erzeugen, wenn ein Rezept kein Bild hat.
// Standard: Cloudflare Workers AI (kostenlos im Free-Plan, 10.000 Neurons/Tag) mit FLUX.2 Klein 9B, Ersatz FLUX.1 Schnell.
// Optional: OpenAI (kostenpflichtig) mit BILD_ANBIETER=openai.
// Umgebungsvariablen: CF_ACCOUNT_ID, CF_AI_TOKEN | OPENAI_API_KEY; optional BILD_ANBIETER, BILD_MODELL, BILD_QUALITAET, BILD_PRO_TAG (Standard 10).
// Verbrauchte Neuronen: Cloudflare-GraphQL (Token braucht zusätzlich „Account Analytics: Read“), Kontingent CF_NEURONEN_PRO_TAG (Standard 10.000).
// Autor: SebastianInTheWild · MIT-Lizenz

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cloudflareReady = () => Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_AI_TOKEN);
const provider = () => process.env.BILD_ANBIETER || (cloudflareReady() ? "cloudflare" : process.env.OPENAI_API_KEY ? "openai" : "");
export const imageReady = () => (provider() === "openai" ? Boolean(process.env.OPENAI_API_KEY) : provider() === "cloudflare" && cloudflareReady());
export const imageSetupHint = "für KI-Fotos CF_ACCOUNT_ID und CF_AI_TOKEN (Cloudflare Workers AI) als Umgebungsvariablen setzen";

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

async function cloudflare(prompt) {
  const headers = { Authorization: `Bearer ${process.env.CF_AI_TOKEN}` };
  const model = process.env.BILD_MODELL || "@cf/black-forest-labs/flux-2-klein-9b";
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

export async function generateImage(d, dir) {
  if (!imageReady()) throw new Error(`kein Bild-Anbieter eingerichtet – ${imageSetupHint}`);
  mkdirSync(dir, { recursive: true });
  const limit = Number(process.env.BILD_PRO_TAG || 10);
  const cnt = countToday(dir);
  if (cnt.n >= limit) throw new Error(`Tageslimit von ${limit} Bildern erreicht (BILD_PRO_TAG)`);
  const prompt = imagePrompt(d);
  const img = provider() === "openai" ? await openai(prompt) : await cloudflare(prompt);
  writeFileSync(cnt.file, JSON.stringify({ day: cnt.day, n: cnt.n + 1 }));
  return img;
}

// Bildformat an den ersten Bytes erkennen (FLUX liefert je nach Modell JPEG oder PNG)
export const imageType = (buf) =>
  buf[0] === 0x89 && buf[1] === 0x50 ? { mime: "image/png", ext: "png" } : buf[0] === 0x52 && buf[8] === 0x57 ? { mime: "image/webp", ext: "webp" } : { mime: "image/jpeg", ext: "jpg" };
