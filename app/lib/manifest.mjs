// Slack-Manifest automatisch einspielen: slack-app-manifest.yml → Slack (apps.manifest.update), nur wenn sich die Datei geändert hat.
// Braucht SLACK_APP_ID (A0…, unter api.slack.com/apps → Basic Information) und SLACK_CONFIG_TOKEN: den *Refresh*-Token
// (xoxe-1-…) aus api.slack.com/apps → „Your App Configuration Tokens“ → Generate Token. Der Zugangs-Token gilt nur 12 Stunden;
// er wird mit dem Refresh-Token erneuert. Slack gibt dabei jedes Mal einen neuen Refresh-Token aus, der alte verfällt –
// der jeweils neueste liegt deshalb in daten/slack-config-token.json (hat Vorrang vor der Umgebungsvariable).
// Autor: SebastianInTheWild · MIT-Lizenz

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE } from "./sync.mjs";
import { lang, COMMAND_NAMES } from "./i18n.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const TOKEN_FILE = join(DATA_DIR, "slack-config-token.json");
const STATE_FILE = join(DATA_DIR, "slack-manifest.json");
const read = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
};
const write = (f, j) => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(f, JSON.stringify(j, null, 1));
};

// ---------- YAML (nur was das Manifest braucht: Einrückung, Listen, Kommentare, einfache Werte) ----------

const stripComment = (line) => {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q && line[i - 1] !== "\\") q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};
const scalar = (v) => {
  v = v.trim();
  if (/^".*"$/.test(v)) return JSON.parse(v);
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (v === "true" || v === "false") return v === "true";
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
};
const KEY = /^([A-Za-z0-9_.\-/]+):(?:\s+(.*))?$/;

export function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => stripComment(raw).replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  const block = (indent) => (lines[i].text.startsWith("-") ? list(indent) : map(indent));
  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const m = KEY.exec(lines[i].text);
      if (!m) throw new Error(`YAML Zeile „${lines[i].text}“ nicht verstanden`);
      i++;
      if (m[2] !== undefined && m[2] !== "") out[m[1]] = scalar(m[2]);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith("- ")))) out[m[1]] = block(lines[i].indent);
      else out[m[1]] = null;
    }
    return out;
  }
  function list(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && /^-(\s|$)/.test(lines[i].text)) {
      const rest = lines[i].text.slice(1).trim();
      if (!rest) {
        i++;
        out.push(block(lines[i].indent));
      } else if (KEY.test(rest)) {
        // „- key: wert“ = Objekt; die erste Zeile wird wie eine eingerückte Zeile gelesen
        lines[i] = { indent: indent + 2, text: rest };
        out.push(map(indent + 2));
      } else {
        out.push(scalar(rest));
        i++;
      }
    }
    return out;
  }
  const out = lines.length ? block(lines[0].indent) : {};
  if (i < lines.length) throw new Error(`YAML Zeile „${lines[i].text}“ passt nicht zur Einrückung`);
  return out;
}

// ---------- Slack ----------

async function call(method, params) {
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) {
    const details = (j.errors || []).map((e) => `${e.pointer || ""} ${e.message}`.trim()).join("; ");
    throw new Error(`Slack ${method}: ${j.error}${details ? ` (${details})` : ""}`);
  }
  return j;
}

// Gültigen Zugangs-Token holen: gespeicherten nutzen, sonst mit dem neuesten Refresh-Token erneuern
async function configToken() {
  const saved = read(TOKEN_FILE);
  if (saved.token && saved.exp * 1000 > Date.now() + 5 * 60_000) return saved.token;
  const candidates = [...new Set([saved.refresh_token, process.env.SLACK_CONFIG_TOKEN].filter(Boolean))];
  let last;
  for (const refresh_token of candidates) {
    try {
      const j = await call("tooling.tokens.rotate", { refresh_token });
      write(TOKEN_FILE, { token: j.token, refresh_token: j.refresh_token, exp: j.exp, at: new Date().toISOString() });
      return j.token;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`${last?.message || "kein Token"} – in api.slack.com/apps → „Your App Configuration Tokens“ einen neuen erzeugen und den Refresh-Token als SLACK_CONFIG_TOKEN eintragen`);
}

// Bei SPRACHE=en: englische Befehlsnamen (/stats, /recipe …) und Texte. Die deutschen Namen funktionieren in der Brücke
// trotzdem weiter. Die Datei slack-app-manifest.yml bleibt deutsch und kann so auch von Hand eingefügt werden.
const EN = {
  description: "Imports recipes into Tandoor and brings them up to our standard.",
  commands: {
    "/neuronen": ["Cloudflare neurons left today for AI photos"],
    "/statistik": ["Recipe statistics – total, checked, open, still to check"],
    "/offen": ["Proposals waiting for your decision (“resend” posts them all again)", "[resend]"],
    "/rezept": ["Search a recipe in Tandoor, with status", "<name>"],
    "/ohne-bild": ["Show recipes without a picture, with a button for an AI photo", "[count | name]"],
    "/bild-neu": ["New AI picture from Google for one recipe", "<name | ID>"],
    "/bild-alle": ["Recreate all recipe pictures with Google (asks first)"],
    "/pruefen": ["Start the quality check now", "[count]"],
    "/pruefen-rezept": ["Check one recipe again", "<name | ID>"],
    "/pro-tag": ["How many recipes are checked per day", "[count]"],
    "/wochenplan": ["Suggest a meal plan from your recipes", "[days] [wishes]"],
    "/was-kochen": ["Find recipes with these ingredients", "<ingredients>"],
    "/hilfe": ["What the recipe helper can do"],
    "/google": ["Google usage and estimated cost this month"],
  },
};
function localize(m) {
  if (lang() !== "en") return m;
  const out = structuredClone(m);
  if (out.display_information) out.display_information.description = EN.description;
  for (const c of out.features?.slash_commands || []) {
    const [description, hint] = EN.commands[c.command] || [];
    if (description) c.description = description;
    if (hint && c.usage_hint) c.usage_hint = hint;
    c.command = COMMAND_NAMES[c.command] || c.command;
  }
  return out;
}

export const manifestSyncReady = () => Boolean(process.env.SLACK_APP_ID && (process.env.SLACK_CONFIG_TOKEN || read(TOKEN_FILE).refresh_token));

/**
 * Manifest einspielen, wenn es sich seit dem letzten Mal geändert hat.
 * Liefert null (nichts zu tun) oder { updated: true, permissions_updated } – bei neuen Berechtigungen muss die App neu installiert werden.
 */
export async function syncManifest() {
  if (!manifestSyncReady() || !existsSync(MANIFEST_FILE())) return null;
  const manifest = JSON.stringify(localize(parseYaml(readFileSync(MANIFEST_FILE(), "utf8"))));
  const hash = createHash("sha256").update(manifest).digest("hex");
  const state = read(STATE_FILE);
  if (state.hash === hash && state.app_id === process.env.SLACK_APP_ID) return null;
  const token = await configToken();
  const app_id = process.env.SLACK_APP_ID;
  await call("apps.manifest.validate", { token, app_id, manifest });
  const r = await call("apps.manifest.update", { token, app_id, manifest });
  write(STATE_FILE, { hash, app_id, at: new Date().toISOString(), permissions_updated: Boolean(r.permissions_updated) });
  return { updated: true, permissions_updated: Boolean(r.permissions_updated) };
}
