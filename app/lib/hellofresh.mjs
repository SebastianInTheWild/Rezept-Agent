// HelloFresh-Rezepte lesen – Tandoors eigener Import scheitert an diesen Seiten.
// Die Seite enthält das komplette Rezept als JSON (<script id="__NEXT_DATA__">, props.pageProps.ssrPayload.recipe):
// Zutaten (Namen) + yields (Mengen je Portionszahl), Schritte, Utensilien, Zeiten, Nährwerte, Bild.
// Reserve: schema.org-Daten (ld+json) der Seite. Alle Länderseiten (hellofresh.de/.at/.ch/.com …).
// Autor: SebastianInTheWild · MIT-Lizenz

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { L } from "./i18n.mjs";

export const isHelloFresh = (url) => /^https?:\/\/(www\.)?hellofresh\.[a-z.]+\//i.test(url);
const IMG = "https://img.hellofresh.com/f_jpg,fl_lossy,q_auto,w_1200/hellofresh_s3";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const text = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // Markdown-Reste und HelloFresh-Sternchen („Salz*“ = Vorratszutat, nicht in der Box)
    .replace(/\\([*_#])/g, "$1")
    .replace(/(\S)\*+/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

// „PT1H15M“ → 75
export const minutes = (iso) => {
  const m = /^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?$/i.exec(String(iso || "").trim());
  return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
};
const image = (path) => (!path ? "" : /^https?:/.test(path) ? path : `${IMG}${path.startsWith("/") ? "" : "/"}${path}`);

function fromNextData(r, url) {
  const byId = new Map((r.ingredients || []).map((i) => [i.id, i]));
  const yields = (r.yields || []).map((y) => ({
    servings: y.yields,
    ingredients: (y.ingredients || []).map((yi) => {
      // „0 nach Geschmack“ → ohne Menge; Vorratszutaten (nicht in der Box) kennzeichnen
      const toTaste = !yi.amount || /nach Geschmack|to taste|au goût/i.test(yi.unit || "");
      const info = byId.get(yi.id);
      return {
        id: yi.id,
        amount: toTaste ? null : yi.amount,
        unit: toTaste ? null : yi.unit || null,
        food: info?.name || "?",
        ...(toTaste ? { note: yi.unit || "nach Geschmack" } : {}),
        ...(info?.shipped === false ? { pantry: true } : {}),
      };
    }),
  }));
  const names = new Map([...byId].map(([id, i]) => [id, i.name]));
  const steps = [...(r.steps || [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((s) => ({
      instruction: text(s.instructionsHTML || s.instructions || s.instructionsMarkdown),
      ingredients: (s.ingredients || []).map((id) => names.get(id?.id || id)).filter(Boolean),
      utensils: (s.utensils || []).map((u) => u.name || byId.get(u)?.name).filter(Boolean),
      timers: (s.timers || []).map((t) => t.name || t.duration).filter(Boolean),
    }));
  return {
    name: r.name || "",
    title: r.name || "",
    headline: r.headline || "",
    description: text(r.descriptionHTML || r.description || r.descriptionMarkdown),
    servings_options: yields.map((y) => y.servings),
    yields,
    steps,
    devices: (r.utensils || []).map((u) => u.name).filter(Boolean),
    working_time: minutes(r.prepTime),
    total_time: minutes(r.totalTime),
    // HelloFresh gibt manchmal eine Gesamtzeit kleiner als die Arbeitszeit an – Wartezeit nie negativ
    waiting_time: Math.max(0, (minutes(r.totalTime) ?? 0) - (minutes(r.prepTime) ?? 0)),
    keywords: [...(r.tags || []), ...(r.cuisines || []), ...(r.categories || [])].map((t) => t.name).filter(Boolean),
    allergens: (r.allergens || []).map((a) => a.name).filter(Boolean),
    nutrition: (r.nutrition || []).map((n) => `${n.name}: ${n.amount} ${n.unit}`),
    difficulty: r.difficulty ?? null,
    image_url: image(r.imagePath),
    source_url: r.websiteUrl || url,
  };
}

function fromLdJson(html, url) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let j;
    try {
      j = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const r = [].concat(j["@graph"] || j).find((x) => [].concat(x["@type"]).includes("Recipe"));
    if (!r) continue;
    return {
      name: r.name || "",
      description: text(r.description),
      servings_options: [parseInt(r.recipeYield, 10) || null].filter(Boolean),
      yields: [{ servings: parseInt(r.recipeYield, 10) || null, ingredients_text: r.recipeIngredient || [] }],
      steps: [].concat(r.recipeInstructions || []).map((s) => ({ instruction: text(s.text || s) })),
      working_time: minutes(r.prepTime),
      total_time: minutes(r.totalTime),
      keywords: String(r.keywords || "").split(",").map((k) => k.trim()).filter(Boolean),
      image_url: [].concat(r.image || [])[0]?.url || [].concat(r.image || [])[0] || "",
      source_url: url,
      note: "Nur die schema.org-Daten der Seite gefunden – Mengen gelten laut HelloFresh-Erfahrungen nicht immer für die angegebene Portionszahl, bitte plausibel prüfen.",
    };
  }
  return null;
}

/** Rezept von einer HelloFresh-Seite. dir = Ordner für das Rezeptfoto (damit der Agent es ansehen kann). */
export async function fetchHelloFresh(url, dir) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9", Accept: "text/html" }, redirect: "follow" });
  } catch (e) {
    return { ok: false, msg: `${L("HelloFresh nicht erreichbar", "HelloFresh not reachable")}: ${e.message}` };
  }
  if (!res.ok) return { ok: false, msg: L(`HelloFresh antwortet mit HTTP ${res.status}${res.status === 403 ? " (Abruf blockiert)" : ""} – schick mir einen Screenshot der Rezeptkarte oder den Text.`, `HelloFresh answers with HTTP ${res.status}${res.status === 403 ? " (blocked)" : ""} – send me a screenshot of the recipe card or the text.`) };
  const html = await res.text();
  let recipe = null;
  const next = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (next) {
    try {
      const r = JSON.parse(next[1])?.props?.pageProps?.ssrPayload?.recipe;
      if (r?.name) recipe = fromNextData(r, url);
    } catch {}
  }
  recipe ||= fromLdJson(html, url);
  if (!recipe) return { ok: false, msg: L("Auf der HelloFresh-Seite habe ich kein Rezept gefunden (Seitenaufbau geändert?) – schick mir einen Screenshot der Rezeptkarte oder den Text.", "I found no recipe on the HelloFresh page (layout changed?) – send me a screenshot of the recipe card or the text.") };

  // Foto lokal ablegen, damit der Agent das Gericht für das KI-Foto beschreiben kann
  if (recipe.image_url && dir) {
    try {
      const img = await fetch(recipe.image_url, { headers: { "User-Agent": UA } });
      if (img.ok) {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `hellofresh-${Date.now().toString(36)}.jpg`);
        writeFileSync(file, Buffer.from(await img.arrayBuffer()));
        recipe.image_file = file;
      }
    } catch {}
  }
  return { ok: true, source: "HelloFresh", recipe };
}
