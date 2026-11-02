// Tandoor-API und Umwandlung zwischen Tandoor-Rezepten und dem einfachen Rezeptformat der Agenten.
// Autor: SebastianInTheWild · MIT-Lizenz

import { imageType } from "./bild.mjs";
import { L } from "./i18n.mjs";

export const base = () => (process.env.TANDOOR_URL || "https://app.tandoor.dev").replace(/\/$/, "");
export const recipeUrl = (id) => `${base()}/recipe/${id}`;

// Status-Schlagwörter und Hausstil
export const KW = { checked: "geprüft", open: "vorschlag-offen", skip: "nicht-bearbeiten" };
export const STATUS_KW = Object.values(KW);
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
