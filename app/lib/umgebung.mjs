// Einstellungen aus der Weboberfläche: überschreiben die Umgebungsvariablen aus Portainer/.env.
// Gespeichert in daten/umgebung.json (nur für den Container-Benutzer lesbar). Wird als ERSTER Import in scheduler.mjs und
// slack-bridge.mjs geladen, damit alle anderen Module die Werte schon sehen. Agenten erben sie über process.env.
// Leerer Wert in der Oberfläche = Eintrag löschen, dann gilt wieder die Umgebungsvariable.
// Änderungen gelten nach einem Neustart (Knopf in der Oberfläche).
// Autor: SebastianInTheWild · MIT-Lizenz

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = join(process.env.DATA_DIR || "/data", "umgebung.json");

// Was in der Oberfläche einstellbar ist. Bewusst nicht dabei: WEB_PASSWORT (sonst kann man sich aussperren) und Pfade.
export const FIELDS = [
  { group: "Claude", key: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude-Token", secret: true, hint: "auf einem PC mit Claude Code „claude setup-token“ ausführen" },
  { group: "Claude", key: "CLAUDE_MODEL", label: "Claude-Modell", hint: "leer = Standard von Claude Code" },
  { group: "Tandoor", key: "TANDOOR_URL", label: "Tandoor-Adresse", hint: "z. B. https://app.tandoor.dev" },
  { group: "Tandoor", key: "TANDOOR_TOKEN", label: "Tandoor-Token", secret: true, hint: "Tandoor → Einstellungen → API, Scope „read write“" },
  { group: "Slack", key: "SLACK_BOT_TOKEN", label: "Bot-Token", secret: true, hint: "xoxb-…" },
  { group: "Slack", key: "SLACK_APP_TOKEN", label: "App-Token (Socket Mode)", secret: true, hint: "xapp-…" },
  { group: "Slack", key: "SLACK_CHANNEL", label: "Rezept-Kanal", hint: "Kanal-ID, z. B. C0123ABCD" },
  { group: "Slack", key: "SLACK_APP_ID", label: "App-ID (für das Manifest)", hint: "A0…, unter api.slack.com/apps → Basic Information" },
  { group: "Slack", key: "SLACK_CONFIG_TOKEN", label: "Refresh-Token der App-Konfiguration", secret: true, hint: "xoxe-1-…, unter api.slack.com/apps → „Your App Configuration Tokens“" },
  { group: "KI-Fotos", key: "BILD_ANBIETER", label: "Anbieter", options: ["", "google", "cloudflare", "openai"], hint: "leer = automatisch: Google vor Cloudflare vor OpenAI" },
  { group: "KI-Fotos", key: "BILD_EINHEITLICH", label: "Einheitlicher Bildstil", options: ["", "an", "aus"], hint: "leer = an: neue Rezepte bekommen immer ein KI-Foto im Stil aus agents/bild-stil.md; aus = Foto der Quelle nehmen, wenn vorhanden" },
  { group: "KI-Fotos", key: "GEMINI_API_KEY", label: "Google-API-Schlüssel", secret: true, hint: "aistudio.google.com → „Get API key“" },
  { group: "KI-Fotos", key: "GOOGLE_BILD_MODELL", label: "Google-Modell", options: ["", "gemini-nano-banana-2.1", "gemini-2.5-flash-image", "gemini-3-pro-image"], hint: "leer = gemini-nano-banana-2.1" },
  { group: "KI-Fotos", key: "CF_ACCOUNT_ID", label: "Cloudflare-Account-ID" },
  { group: "KI-Fotos", key: "CF_AI_TOKEN", label: "Cloudflare-Token", secret: true, hint: "Vorlage „Workers AI“, für die Neuronen-Anzeige zusätzlich „Account Analytics: Read“" },
  { group: "KI-Fotos", key: "OPENAI_API_KEY", label: "OpenAI-API-Schlüssel", secret: true },
  { group: "KI-Fotos", key: "BILD_PRO_TAG", label: "Höchstens Bilder pro Tag", pattern: "^\\d*$", hint: "leer = 10; gilt nicht für /bild-neu und /bild-alle" },
  { group: "Videos (Reels, Shorts)", key: "GEMINI_VIDEO_MODELL", label: "Gemini-Modell für Videos", hint: "leer = gemini-flash-latest (immer das aktuelle Flash-Modell); nutzt den Google-API-Schlüssel von oben" },
  { group: "Videos (Reels, Shorts)", key: "VIDEO_MAX_SEKUNDEN", label: "Längstes Video in Sekunden", pattern: "^\\d*$", hint: "leer = 600; längere Videos: nur die Beschreibung" },
  { group: "Abgleich", key: "AGENTS_SYNC", label: "agents/ aus GitHub holen alle … Minuten", pattern: "^(\\d*|aus)$", hint: "leer = 10, „aus“ = nie" },
];
const KEYS = new Set(FIELDS.map((f) => f.key));

// Umgebung vor dem Überschreiben merken (für die Anzeige „aus Portainer“ und zum Zurückfallen)
const ORIGINAL = Object.fromEntries(FIELDS.map((f) => [f.key, process.env[f.key] ?? ""]));

const readFile = () => {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
};

// Beim Import anwenden
const saved = readFile();
for (const [k, v] of Object.entries(saved)) if (KEYS.has(k) && v !== "") process.env[k] = String(v);

const mask = (v) => (v.length > 8 ? `••••${v.slice(-4)}` : "••••");

/** Für die Oberfläche: Werte und Herkunft, Geheimnisse nur maskiert. */
export function envOverview() {
  const file = readFile();
  return FIELDS.map((f) => {
    const own = file[f.key] ?? "";
    const env = ORIGINAL[f.key];
    const value = own || env;
    return {
      ...f,
      source: own ? "Weboberfläche" : env ? "Umgebung" : "",
      value: f.secret ? "" : own,
      shown: value ? (f.secret ? mask(value) : value) : "",
      env: f.secret ? (env ? mask(env) : "") : env,
      // Ungespeicherte Änderung: Datei weicht vom laufenden Prozess ab → Neustart nötig
      pending: (own || env) !== (process.env[f.key] ?? ""),
    };
  });
}

/** Werte setzen: { KEY: "wert" } – "" löscht den Eintrag (dann gilt wieder die Umgebungsvariable). */
export function setEnvValues(changes) {
  const file = readFile();
  for (const [k, raw] of Object.entries(changes || {})) {
    const f = FIELDS.find((x) => x.key === k);
    if (!f) throw new Error(`${k} ist nicht einstellbar`);
    const v = String(raw ?? "").trim();
    if (/[\r\n]/.test(v) || v.length > 2000) throw new Error(`${f.label}: ungültiger Wert`);
    if (v && f.options && !f.options.includes(v)) throw new Error(`${f.label}: erlaubt sind ${f.options.filter(Boolean).join(", ")}`);
    if (v && f.pattern && !new RegExp(f.pattern).test(v)) throw new Error(`${f.label}: ungültiger Wert`);
    if (v) file[k] = v;
    else delete file[k];
  }
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
  try {
    chmodSync(FILE, 0o600);
  } catch {}
}

export const envFileExists = () => existsSync(FILE);
