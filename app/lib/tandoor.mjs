// Tandoor-API und Umwandlung zwischen Tandoor-Rezepten und dem einfachen Rezeptformat der Agenten.
// Autor: SebastianInTheWild · MIT-Lizenz

import { imageType } from "./bild.mjs";
import { L } from "./i18n.mjs";

export const base = () => (process.env.TANDOOR_URL || "https://app.tandoor.dev").replace(/\/$/, "");
export const recipeUrl = (id) => `${base()}/recipe/${id}`;

// Status-Schlagwörter und Hausstil
export const KW = { checked: "geprüft", open: "vorschlag-offen", skip: "nicht-bearbeiten" };
export const STATUS_KW = Object.values(KW);
// Merkmal „Bild mit KI erzeugt“ – setzt und entfernt nur das Werkzeug (wie die Status-Schlagwörter, bleibt deutsch)
export const AI_KW = "ki-bild";
// Schlagwörter, die der Agent nicht selbst vergibt und die nicht in der Auswahl für ihn stehen
export const SYSTEM_KW = [...STATUS_KW, AI_KW];
// Entwürfe tragen den Präfix in der eingestellten Sprache; erkannt werden beide
export const DRAFT_PREFIXES = ["⏳ Entwurf: ", "⏳ Draft: "];
export const DRAFT_PREFIX = DRAFT_PREFIXES[0];
export const draftPrefix = () => L(DRAFT_PREFIXES[0], DRAFT_PREFIXES[1]);
export const isDraft = (name = "") => DRAFT_PREFIXES.some((p) => name.startsWith(p));
// Hausstil in der eingestellten Sprache; den Geräte-Schritt erkennen wir in beiden Sprachen
export const DEVICES_STEPS = ["Benötigte Küchengeräte", "Required equipment"];
export const devicesStep = () => L(DEVICES_STEPS[0], DEVICES_STEPS[1]);
export const servingsText = () => L("Portionen", "servings");
export const SERVINGS_TEXT = "Portionen";

export async function api(method, path, body) {
  const token = process.env.TANDOOR_TOKEN;
  if (!token) throw new Error("TANDOOR_TOKEN fehlt (Umgebungsvariable)");
  const r = await fetch(path.startsWith("http") ? path : base() + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Tandoor ${method} ${path} → ${r.status}: ${t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

export async function all(path) {
  let out = [];
  let next = `${base()}${path}${path.includes("?") ? "&" : "?"}page_size=100`;
  while (next) {
    const j = await api("GET", next);
    out = out.concat(j.results ?? j);
    next = j.next;
  }
  return out;
}

export const getRecipe = (id) => api("GET", `/api/recipe/${id}/`);

// Bild als Datei hochladen (z. B. ein erzeugtes Foto)
export async function uploadImage(id, buffer, name = "bild") {
  const t = imageType(buffer);
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: t.mime }), `${name.replace(/\.\w+$/, "")}.${t.ext}`);
  const r = await fetch(`${base()}/api/recipe/${id}/image/`, { method: "PUT", headers: { Authorization: `Bearer ${process.env.TANDOOR_TOKEN}`, Accept: "application/json" }, body: form });
  if (!r.ok) throw new Error(`Tandoor Bild-Upload → ${r.status}: ${(await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
}
const num = (x) => (x === null || x === undefined || x === "" ? 0 : Number(x));

// ---------- Nährwerte (Tandoor-„Eigenschaften“ am Rezept, pro Portion) ----------
// Tandoor 2.x zeigt Nährwerte über properties (property_type + property_amount pro Portion); das alte Feld
// „nutrition“ erscheint nicht mehr. Die vier Typen werden über Namen/open_data_slug gefunden oder angelegt.
export const NUTRIENTS = {
  calories: { de: "Kalorien", en: "Calories", unit: "kcal", match: /calor|kalor|energ|kcal/i },
  proteins: { de: "Eiweiß", en: "Proteins", unit: "g", match: /prote|eiwei/i },
  fats: { de: "Fett", en: "Fat", unit: "g", match: /(^|[\s_-])(fats?|fett)($|[\s_-])/i },
  carbohydrates: { de: "Kohlenhydrate", en: "Carbohydrates", unit: "g", match: /carb|kohlenhydrat/i },
};
// Typ → Nährwert-Schlüssel; Energie in kJ und Unterarten („Gesättigte Fettsäuren“, „davon Zucker“) zählen nicht
const nutrientOf = (type) => {
  const text = `${type?.open_data_slug || ""} ${type?.name || ""}`.trim();
  if (/kj/i.test(type?.unit || "") || /säur|acid|zucker|sugar|satur|gesättigt/i.test(text)) return undefined;
  return Object.keys(NUTRIENTS).find((k) => NUTRIENTS[k].match.test(text));
};

/** Nährwerte pro Portion aus den Eigenschaften eines Rezepts (oder null) */
export function nutritionOf(r) {
  const out = {};
  for (const p of r.properties || []) {
    const k = nutrientOf(p.property_type);
    if (k && p.property_amount !== null && p.property_amount !== undefined) out[k] = num(p.property_amount);
  }
  return Object.keys(out).length ? out : null;
}

let typeCache = null;
/** Eigenschafts-Typen für die vier Nährwerte (vorhandene nutzen, fehlende anlegen) */
async function nutrientTypes() {
  if (typeCache) return typeCache;
  const existing = await all("/api/property-type/").catch(() => []);
  const types = {};
  for (const [k, n] of Object.entries(NUTRIENTS)) {
    types[k] = existing.find((t) => nutrientOf(t) === k) || (await api("POST", "/api/property-type/", { name: L(n.de, n.en), unit: n.unit }));
  }
  return (typeCache = types);
}

/**
 * Eigenschaften für ein Rezept: Nährwerte setzen, andere Eigenschaften (z. B. selbst angelegte) behalten.
 * existing = bisherige properties des Rezepts (mit id), damit Tandoor sie aktualisiert statt doppelt anlegt.
 */
export async function nutritionProperties(nutrition, existing = []) {
  const types = await nutrientTypes();
  const others = existing.filter((p) => !nutrientOf(p.property_type)).map((p) => ({ id: p.id, property_amount: p.property_amount, property_type: { id: p.property_type.id, name: p.property_type.name } }));
  const mine = Object.entries(nutrition || {})
    .filter(([k, v]) => NUTRIENTS[k] && Number.isFinite(Number(v)))
    .map(([k, v]) => {
      const old = existing.find((p) => nutrientOf(p.property_type) === k);
      return { ...(old ? { id: old.id } : {}), property_amount: Math.round(Number(v) * 10) / 10, property_type: { id: types[k].id, name: types[k].name } };
    });
  return [...others, ...mine];
}

// Tandoor → einfaches Format (für Claude lesbar, ohne IDs)
export function simplify(r) {
  const steps = [...r.steps].sort((a, b) => a.order - b.order);
  const dev = steps.find((s) => DEVICES_STEPS.includes(s.name) && !s.ingredients.length);
  return {
    id: r.id,
    name: r.name,
    description: r.description || "",
    servings: r.servings,
    servings_text: r.servings_text,
    working_time: r.working_time,
    waiting_time: r.waiting_time,
    source_url: r.source_url || "",
    keywords: r.keywords.map((k) => k.name),
    // Nährwerte pro Portion (kcal, g) – fehlt das Feld, hat das Rezept noch keine
    ...(nutritionOf(r) ? { nutrition: nutritionOf(r) } : {}),
    has_image: Boolean(r.image),
    updated_at: r.updated_at,
    devices: dev ? dev.instruction.split("\n").map((l) => l.replace(/^\s*[•\-*]\s*/, "").trim()).filter(Boolean) : [],
    steps: steps
      .filter((s) => s !== dev)
      .map((s) => ({
        name: s.name || "",
        time: s.time || 0,
        instruction: s.instruction || "",
        ingredients: [...s.ingredients]
          .sort((a, b) => a.order - b.order)
          .map((i) =>
            i.is_header
              ? { header: i.note || i.food?.name || "" }
              : { amount: i.no_amount ? null : num(i.amount), unit: i.unit?.name || null, food: i.food?.name || "", note: i.note || "", ...(i.no_amount ? { no_amount: true } : {}) },
          ),
      })),
  };
}

// Einfaches Format → Tandoor-Rezept (Hausstil: Geräte-Schritt zuerst, dann „Schritt 1 … n“, Portionen)
export function toTandoor(d, { name, keywords, privateRecipe }) {
  const steps = [];
  if (d.devices?.length) steps.push({ name: devicesStep(), instruction: d.devices.map((x) => `• ${x}`).join("\n"), time: 0, order: 0, ingredients: [] });
  d.steps.forEach((s, n) =>
    steps.push({
      name: `${L("Schritt", "Step")} ${n + 1}`,
      instruction: s.instruction.trim(),
      time: Math.round(num(s.time)),
      order: steps.length,
      ingredients: (s.ingredients || []).map((i, k) => ({
        food: { name: i.food.trim() },
        unit: i.unit ? { name: i.unit } : null,
        amount: i.no_amount || i.amount === null || i.amount === undefined ? 0 : num(i.amount),
        no_amount: Boolean(i.no_amount || i.amount === null || i.amount === undefined),
        note: (i.note || "").trim(),
        order: k,
        is_header: false,
      })),
    }),
  );
  return {
    name,
    description: (d.description || "").trim(),
    servings: Math.max(1, Math.round(num(d.servings) || 1)),
    servings_text: servingsText(),
    working_time: Math.round(num(d.working_time)),
    waiting_time: Math.round(num(d.waiting_time)),
    source_url: d.source_url || "",
    internal: true,
    private: Boolean(privateRecipe),
    keywords: keywords.map((k) => ({ name: k })),
    steps,
  };
}

// Kurzform einer Zutat für Vergleiche und Nachrichten
export const ingText = (i) => [i.no_amount || i.amount === null ? "" : String(+num(i.amount).toFixed(3)).replace(".", ","), i.unit || "", i.food, i.note ? `(${i.note})` : ""].filter(Boolean).join(" ");
