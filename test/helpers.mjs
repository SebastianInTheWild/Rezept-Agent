// Gemeinsame Hilfen für die Tests: Umgebung, nachgebautes Tandoor/Slack/Google und ein fetch, das sie verteilt.
// Jede Testdatei läuft in einem eigenen Prozess (node --test). Umgebung vor dem ersten Import der App setzen!
// Autor: SebastianInTheWild · MIT-Lizenz

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APP = (path) => new URL(`../app/${path}`, import.meta.url).href;
export const TANDOOR = "http://tandoor.test";

/** Frischer Datenordner und Grundeinstellungen; extra überschreibt einzelne Werte. */
export function setupEnv(extra = {}) {
  const data = mkdtempSync(join(tmpdir(), "rezept-test-"));
  mkdirSync(join(data, "rezepte"), { recursive: true });
  for (const k of Object.keys(process.env)) if (/^(SLACK_|GEMINI_|CF_|OPENAI_|BILD_|GOOGLE_|SPRACHE|WEB_|BACKUP_|GITHUB_)/.test(k)) delete process.env[k];
  Object.assign(process.env, {
    DATA_DIR: data,
    AGENTS_DIR: join(ROOT, "agents"),
    SCHEDULE_FILE: join(data, "zeitplan.conf"),
    TANDOOR_URL: TANDOOR,
    TANDOOR_TOKEN: "test-token",
    TZ: "Europe/Berlin",
    REZEPT_STATISTIK: "aus",
    AGENTS_SYNC: "aus",
    APP_SYNC: "aus",
    ...extra,
  });
  return { data, cleanup: () => rmSync(data, { recursive: true, force: true }) };
}

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Kleines einfarbiges PNG (für Bild-Tests) */
export function png(r = 200, g = 80, b = 60, w = 8, h = 6) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w * 3 }, (_, i) => [r, g, b][i % 3]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Nachgebautes Tandoor (nur was die App benutzt): Rezepte, Bilder, Schlüsselwörter, Einheiten, Lebensmittel,
 * Essensplan und Einkaufsliste. calls protokolliert schreibende Aufrufe.
 */
export function fakeTandoor(recipes = []) {
  const t = {
    recipes: new Map(recipes.map((r) => [r.id, { keywords: [], steps: [], image: null, updated_at: "2026-01-01T00:00:00Z", ...r }])),
    images: new Map(),
    nextId: 1000,
    calls: [],
    mealPlans: [],
    mealTypes: [{ id: 1, name: "Abendessen", order: 0 }],
    // wie die Open-Data-Typen einer neuen Tandoor-Instanz (Fett und Kalorien vorhanden, der Rest fehlt)
    propertyTypes: [{ id: 1, name: "Fat", unit: "g", open_data_slug: "property-fat" }, { id: 2, name: "Calories", unit: "kcal", open_data_slug: "property-calories" }, { id: 3, name: "Saturated Fat", unit: "g" }],
    shopping: [],
    units: ["g", "kg", "ml", "l", "EL", "TL", "Prise", "Stück", "Zehe", "Bund"].map((name, id) => ({ id, name })),
    foods: ["Wirsing", "Speck", "Sahne", "Salz", "Pfeffer", "Zwiebel", "Spaghetti"].map((name, id) => ({ id, name })),
    keywords: ["Einfach", "Herzhaft", "Hauptgericht", "geprüft"].map((name, id) => ({ id, name })),
  };
  // Eigenschaften wie Tandoor speichern: eigene id, vollständiger Typ
  let propId = 100;
  t.props = (list) => list.map((p) => ({ id: p.id ?? propId++, property_amount: p.property_amount, property_type: t.propertyTypes.find((x) => x.id === p.property_type.id) || p.property_type }));
  t.handle = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = (init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    if (method !== "GET") t.calls.push({ method, path, body: body instanceof FormData ? "[form]" : body });
    const page = (list) => json({ count: list.length, next: null, previous: null, results: list });
    let m;
    if (path.startsWith("/media/")) {
      const id = Number(path.match(/(\d+)/)[1]);
      return t.images.has(id) ? new Response(t.images.get(id), { headers: { "Content-Type": "image/png" } }) : new Response("", { status: 404 });
    }
    if ((m = /^\/api\/recipe\/(\d+)\/image\/$/.exec(path)) && method === "PUT") {
      const id = Number(m[1]);
      const r = t.recipes.get(id);
      if (body instanceof FormData) t.images.set(id, Buffer.from(await body.get("image").arrayBuffer()));
      else if (body?.image_url) t.images.set(id, png(1, 2, 3));
      r.image = `${TANDOOR}/media/recipes/${id}.png?sig=${Date.now()}`;
      r.updated_at = new Date().toISOString();
      return json({});
    }
    if ((m = /^\/api\/recipe\/(\d+)\/$/.exec(path))) {
      const id = Number(m[1]);
      const r = t.recipes.get(id);
      if (!r) return json({ detail: "Not found." }, 404);
      if (method === "GET") return json(r);
      if (method === "PATCH") {
        Object.assign(r, body, body.keywords ? { keywords: body.keywords.map((k, i) => ({ id: i, name: k.name, label: k.name })) } : {}, body.properties ? { properties: t.props(body.properties) } : {});
        r.updated_at = new Date().toISOString();
        return json(r);
      }
      if (method === "DELETE") return t.recipes.delete(id), new Response(null, { status: 204 });
    }
    if (path === "/api/recipe/" && method === "POST") {
      const id = t.nextId++;
      const r = { ...body, properties: t.props(body.properties || []), id, image: null, keywords: (body.keywords || []).map((k, i) => ({ id: i, name: k.name })), steps: (body.steps || []).map((s, i) => ({ ...s, id: i, ingredients: (s.ingredients || []).map((x, k) => ({ ...x, id: k, food: x.food, unit: x.unit })) })), updated_at: new Date().toISOString() };
      t.recipes.set(id, r);
      return json(r, 201);
    }
    if (path === "/api/recipe/") {
      const q = (u.searchParams.get("query") || "").toLowerCase();
      // foods=<id>: nur Rezepte mit diesem Lebensmittel (wie Tandoor)
      const food = u.searchParams.get("foods") && t.foods.find((f) => String(f.id) === u.searchParams.get("foods"))?.name;
      const hasFood = (r) => (r.steps || []).some((s) => (s.ingredients || []).some((i) => (i.food?.name ?? i.food) === food));
      return page([...t.recipes.values()].filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!u.searchParams.get("foods") || (food && hasFood(r)))));
    }
    if (path === "/api/unit/") return page(t.units);
    if (path === "/api/food/") {
      const q = (u.searchParams.get("query") || "").toLowerCase();
      return page(t.foods.filter((f) => !q || f.name.toLowerCase().includes(q)));
    }
    if (path === "/api/keyword/") return page(t.keywords);
    if (path === "/api/property-type/" && method === "POST") {
      const pt = { id: t.propertyTypes.length + 1, ...body };
      t.propertyTypes.push(pt);
      return json(pt, 201);
    }
    if (path === "/api/property-type/") return page(t.propertyTypes);
    if (path === "/api/meal-type/") return page(t.mealTypes);
    if (path === "/api/meal-plan/" && method === "POST") {
      const plan = { ...body, id: t.mealPlans.length + 1 };
      t.mealPlans.push(plan);
      return json(plan, 201);
    }
    if (path === "/api/meal-plan/") return page(t.mealPlans);
    if ((m = /^\/api\/recipe\/(\d+)\/shopping\/$/.exec(path))) {
      t.shopping.push({ recipe: Number(m[1]), ...body });
      return json({});
    }
    return json({ detail: `fake tandoor: ${method} ${path}` }, 404);
  };
  return t;
}

/** Nachgebautes Slack: zeichnet Nachrichten und Antworten auf Befehle auf. */
export function fakeSlack() {
  const s = { posts: [], updates: [], responses: [], ts: 1 };
  s.handle = async (url, init = {}) => {
    const method = url.split("/").pop();
    if (url.startsWith("https://slack.test/response")) {
      s.responses.push(JSON.parse(init.body).text);
      return json({ ok: true });
    }
    if (method === "apps.connections.open") return json({ ok: true, url: "wss://slack.test" });
    const body = init.body && init.headers?.["Content-Type"]?.includes("json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body || ""));
    if (method === "chat.postMessage") s.posts.push(body);
    if (method === "chat.update") s.updates.push(body);
    if (method === "chat.getPermalink") return json({ ok: true, permalink: "https://slack.test/p" });
    return json({ ok: true, ts: `${s.ts++}.000` });
  };
  return s;
}

/**
 * Nachgebautes GitHub-Repo (nur die Git-Data- und Contents-API, die die Sicherung benutzt).
 * Startet leer wie ein frisch angelegtes Repo; files() liefert den aktuellen Stand (Pfad → Buffer).
 */
export function fakeGitHub(repo = "test/sicherung") {
  const g = { blobs: new Map(), trees: new Map(), commits: new Map(), ref: null, commitsMade: [], blobPosts: 0 };
  let n = 0;
  const id = (p) => `${p}${(++n).toString(16).padStart(39, "0")}`;
  const addBlob = (buf) => {
    const sha = (globalThis.__blobSha || ((b) => b))(buf);
    g.blobs.set(sha, buf);
    return sha;
  };
  const treeFiles = (treeSha) => new Map(g.trees.get(treeSha) || []);
  g.files = () => new Map([...treeFiles(g.commits.get(g.ref)?.tree)].map(([p, sha]) => [p, g.blobs.get(sha)]));
  g.handle = async (url, init = {}) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(`/repos/${repo}`, ""));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === "/git/ref/heads/main") return g.ref ? json({ object: { sha: g.ref } }) : json({ message: "Git Repository is empty." }, 409);
    if (path === "/contents/README.md" && method === "PUT") {
      const blob = addBlob(Buffer.from(body.content, "base64"));
      const tree = id("t");
      g.trees.set(tree, [["README.md", blob]]);
      const c = id("c");
      g.commits.set(c, { tree, parents: [], message: body.message });
      g.ref = c;
      return json({ commit: { sha: c } }, 201);
    }
    let m;
    if ((m = /^\/git\/commits\/(\w+)$/.exec(path))) return json({ sha: m[1], tree: { sha: g.commits.get(m[1]).tree } });
    if ((m = /^\/git\/trees\/(\w+)$/.exec(path)) && method === "GET") return json({ sha: m[1], truncated: false, tree: [...treeFiles(m[1])].map(([p, sha]) => ({ path: p, sha, type: "blob", mode: "100644" })) });
    if (path === "/git/blobs" && method === "POST") return g.blobPosts++, json({ sha: addBlob(Buffer.from(body.content, "base64")) }, 201);
    if (path === "/git/trees" && method === "POST") {
      const files = treeFiles(body.base_tree);
      for (const e of body.tree) e.sha === null ? files.delete(e.path) : files.set(e.path, e.sha);
      const t = id("t");
      g.trees.set(t, [...files]);
      return json({ sha: t }, 201);
    }
    if (path === "/git/commits" && method === "POST") {
      const c = id("c");
      g.commits.set(c, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha: c }, 201);
    }
    if (path === "/git/refs/heads/main" && method === "PATCH") {
      g.ref = body.sha;
      g.commitsMade.push(g.commits.get(body.sha).message);
      return json({ object: { sha: body.sha } });
    }
    if ((m = /^\/contents\/(.+)$/.exec(path)) && method === "GET") {
      const buf = g.files().get(m[1]);
      return buf ? new Response(buf) : json({ message: "Not Found" }, 404);
    }
    return json({ message: `fake github: ${method} ${path}` }, 404);
  };
  return g;
}

/** fetch durch die nachgebauten Dienste leiten; unbekannte Adressen schlagen fehl (kein echtes Netz im Test). */
export function installFetch(handlers) {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    seen.push(url);
    for (const [prefix, handler] of handlers) if (url.startsWith(prefix)) return handler(url, init);
    throw new TypeError(`fetch failed (kein Netz im Test): ${url}`);
  };
  return seen;
}

/** WebSocket für die Slack-Brücke nachbauen; liefert eine Funktion, die Ereignisse einspielt. */
export function fakeSocket() {
  let ws;
  globalThis.WebSocket = class {
    constructor() {
      ws = this;
    }
    send() {}
    close() {}
  };
  return {
    send: (msg) => ws.onmessage({ data: JSON.stringify(msg) }),
    ready: () => Boolean(ws?.onmessage),
  };
}

export const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(10);
  }
  return false;
}
