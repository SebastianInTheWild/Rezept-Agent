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
// en = [Gruppe, Beschriftung, Hinweis] auf Englisch (die Oberfläche zeigt die Sprache aus SPRACHE)
export const FIELDS = [
  { group: "Allgemein", key: "SPRACHE", label: "Sprache", options: ["", "de", "en"], hint: "Sprache für neue Rezepte, Slack-Nachrichten und diese Oberfläche (leer = Deutsch). Gilt nach dem Neustart.", en: ["General", "Language", "Language for new recipes, Slack messages and this page (empty = German). Takes effect after the restart."] },
  { group: "Claude", key: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude-Token", secret: true, hint: "auf einem PC mit Claude Code „claude setup-token“ ausführen", en: ["Claude", "Claude token", "run “claude setup-token” on a computer with Claude Code"] },
  { group: "Claude", key: "CLAUDE_MODEL", label: "Claude-Modell", hint: "leer = Standard von Claude Code", en: ["Claude", "Claude model", "empty = Claude Code default"] },
  { group: "Tandoor", key: "TANDOOR_URL", label: "Tandoor-Adresse", hint: "z. B. https://app.tandoor.dev", en: ["Tandoor", "Tandoor address", "e.g. https://app.tandoor.dev"] },
  { group: "Tandoor", key: "TANDOOR_TOKEN", label: "Tandoor-Token", secret: true, hint: "Tandoor → Einstellungen → API, Scope „read write“", en: ["Tandoor", "Tandoor token", "Tandoor → Settings → API, scope “read write”"] },
  { group: "Slack", key: "SLACK_BOT_TOKEN", label: "Bot-Token", secret: true, hint: "xoxb-…", en: ["Slack", "Bot token", "xoxb-…"] },
  { group: "Slack", key: "SLACK_APP_TOKEN", label: "App-Token (Socket Mode)", secret: true, hint: "xapp-…", en: ["Slack", "App token (Socket Mode)", "xapp-…"] },
  { group: "Slack", key: "SLACK_CHANNEL", label: "Rezept-Kanal", hint: "Kanal-ID, z. B. C0123ABCD", en: ["Slack", "Recipe channel", "channel ID, e.g. C0123ABCD"] },
  { group: "Slack", key: "SLACK_APP_ID", label: "App-ID (für das Manifest)", hint: "A0…, unter api.slack.com/apps → Basic Information", en: ["Slack", "App ID (for the manifest)", "A0…, under api.slack.com/apps → Basic Information"] },
  { group: "Slack", key: "SLACK_CONFIG_TOKEN", label: "Refresh-Token der App-Konfiguration", secret: true, hint: "xoxe-1-…, unter api.slack.com/apps → „Your App Configuration Tokens“", en: ["Slack", "App configuration refresh token", "xoxe-1-…, under api.slack.com/apps → “Your App Configuration Tokens”"] },
  { group: "Slack", key: "NEUSTART_MELDUNG", label: "Meldung nach Neustart", options: ["", "an", "aus"], hint: "leer = an: Nach jedem Start des Containers (Update, Neustart, Server-Neustart) schreibt der Agent in den Kanal, dass er wieder läuft – mit Version", en: ["Slack", "Message after restart", "empty = on (an): after every container start (update, restart, server reboot) the agent posts to the channel that it is running again – with version; off = aus"] },
  { group: "KI-Fotos", key: "BILD_ANBIETER", label: "Anbieter", options: ["", "google", "cloudflare", "openai"], hint: "leer = automatisch: Google vor Cloudflare vor OpenAI", en: ["AI photos", "Provider", "empty = automatic: Google before Cloudflare before OpenAI"] },
  { group: "KI-Fotos", key: "BILD_EINHEITLICH", label: "Einheitlicher Bildstil", options: ["", "an", "aus"], hint: "leer = an: neue Rezepte bekommen immer ein KI-Foto im Stil aus agents/bild-stil.md; aus = Foto der Quelle nehmen, wenn vorhanden", en: ["AI photos", "Uniform picture style", "empty = on (an): new recipes always get an AI photo in the style from agents/bild-stil.md; off (aus) = use the source photo if there is one"] },
  { group: "KI-Fotos", key: "GEMINI_API_KEY", label: "Google-API-Schlüssel", secret: true, hint: "aistudio.google.com → „Get API key“", en: ["AI photos", "Google API key", "aistudio.google.com → “Get API key”"] },
  { group: "KI-Fotos", key: "GOOGLE_BILD_MODELL", label: "Google-Modell", options: ["", "gemini-nano-banana-2.1", "gemini-2.5-flash-image", "gemini-3-pro-image"], hint: "leer = gemini-nano-banana-2.1", en: ["AI photos", "Google model", "empty = gemini-nano-banana-2.1"] },
  { group: "KI-Fotos", key: "GOOGLE_GUTHABEN", label: "Google-Guthaben pro Monat (Dollar)", pattern: "^(\\d+([.,]\\d+)?)?$", hint: "z. B. 10 aus Google AI Pro – dann zeigt /google den Rest und warnt bei 80 %; leer = nur Verbrauch anzeigen", en: ["AI photos", "Google credit per month (dollars)", "e.g. 10 from Google AI Pro – then /google shows what's left and warns at 80 %; empty = show usage only"] },
  { group: "KI-Fotos", key: "GOOGLE_PREIS_BILD", label: "Preis pro Google-Bild (Dollar)", pattern: "^(\\d+([.,]\\d+)?)?$", hint: "leer = nach Modell (Nano Banana 2.1: 0,034 · 2.5 Flash Image: 0,039 · 3 Pro Image: 0,134); nur für die Schätzung", en: ["AI photos", "Price per Google picture (dollars)", "empty = by model (Nano Banana 2.1: 0.034 · 2.5 Flash Image: 0.039 · 3 Pro Image: 0.134); estimate only"] },
  { group: "Videos (Reels, Shorts)", key: "GEMINI_PREIS_EINGABE", label: "Preis Eingabe-Tokens (Dollar pro 1 Mio.)", pattern: "^(\\d+([.,]\\d+)?)?$", hint: "leer = 0,75; nur für die Schätzung bei /google", en: ["Videos (reels, shorts)", "Price input tokens (dollars per 1M)", "empty = 0.75; estimate for /google only"] },
  { group: "Videos (Reels, Shorts)", key: "GEMINI_PREIS_AUSGABE", label: "Preis Ausgabe-Tokens (Dollar pro 1 Mio.)", pattern: "^(\\d+([.,]\\d+)?)?$", hint: "leer = 3,75; nur für die Schätzung bei /google", en: ["Videos (reels, shorts)", "Price output tokens (dollars per 1M)", "empty = 3.75; estimate for /google only"] },
  { group: "KI-Fotos", key: "CF_ACCOUNT_ID", label: "Cloudflare-Account-ID", en: ["AI photos", "Cloudflare account ID", ""] },
  { group: "KI-Fotos", key: "CF_AI_TOKEN", label: "Cloudflare-Token", secret: true, hint: "Vorlage „Workers AI“, für die Neuronen-Anzeige zusätzlich „Account Analytics: Read“", en: ["AI photos", "Cloudflare token", "template “Workers AI”, plus “Account Analytics: Read” for the neuron display"] },
  { group: "KI-Fotos", key: "OPENAI_API_KEY", label: "OpenAI-API-Schlüssel", secret: true, en: ["AI photos", "OpenAI API key", ""] },
  { group: "KI-Fotos", key: "BILD_PRO_TAG", label: "Höchstens Bilder pro Tag", pattern: "^\\d*$", hint: "leer = unbegrenzt; gilt nicht für /bild-neu und /bild-alle", en: ["AI photos", "Maximum pictures per day", "empty = unlimited; does not apply to /new-image and /all-images"] },
  { group: "Videos (Reels, Shorts)", key: "GEMINI_VIDEO_MODELL", label: "Gemini-Modell für Videos", hint: "leer = gemini-flash-latest (immer das aktuelle Flash-Modell); nutzt den Google-API-Schlüssel von oben", en: ["Videos (reels, shorts)", "Gemini model for videos", "empty = gemini-flash-latest (always the current Flash model); uses the Google API key above"] },
  { group: "Videos (Reels, Shorts)", key: "VIDEO_MAX_SEKUNDEN", label: "Längstes Video in Sekunden", pattern: "^\\d*$", hint: "leer = 600; längere Videos: nur die Beschreibung", en: ["Videos (reels, shorts)", "Longest video in seconds", "empty = 600; longer videos: description only"] },
  { group: "Wochenplan", key: "WOCHENPLAN_PORTIONEN", label: "Portionen", pattern: "^\\d*$", hint: "leer = 2", en: ["Meal plan", "Servings", "empty = 2"] },
  { group: "Wochenplan", key: "WOCHENPLAN_MAHLZEIT", label: "Mahlzeit in Tandoor", hint: "Name des Mahlzeit-Typs im Tandoor-Essensplan; leer = Abendessen", en: ["Meal plan", "Meal type in Tandoor", "name of the meal type in the Tandoor meal plan; empty = Dinner"] },
  { group: "GitHub-Sicherung", key: "BACKUP_REPO", label: "Privates Repo (besitzer/name)", hint: "z. B. SebastianInTheWild/rezepte-sicherung – vorher auf GitHub als privates, leeres Repo anlegen", en: ["GitHub backup", "Private repo (owner/name)", "e.g. SebastianInTheWild/recipe-backup – create it on GitHub first as a private, empty repo"] },
  { group: "GitHub-Sicherung", key: "BACKUP_TOKEN", label: "GitHub-Token", secret: true, hint: "Fine-grained Token, nur dieses Repo, Berechtigung „Contents: Read and write“", en: ["GitHub backup", "GitHub token", "fine-grained token, only this repo, permission “Contents: Read and write”"] },
  { group: "GitHub-Sicherung", key: "BACKUP_BRANCH", label: "Branch", hint: "leer = main", en: ["GitHub backup", "Branch", "empty = main"] },
  { group: "Abgleich", key: "AGENTS_SYNC", label: "agents/ aus GitHub holen alle … Minuten", pattern: "^(\\d*|aus)$", hint: "leer = 10, „aus“ = nie", en: ["Sync", "Fetch agents/ from GitHub every … minutes", "empty = 10, “aus” = never"] },
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

// Fehlermeldungen in der eingestellten Sprache (ohne i18n.mjs, damit dieses Modul keine Abhängigkeiten hat)
const tr = (de, en) => (/^en/i.test(process.env.SPRACHE || "") ? en : de);
const mask = (v) => (v.length > 8 ? `••••${v.slice(-4)}` : "••••");

/** Für die Oberfläche: Werte und Herkunft, Geheimnisse nur maskiert. */
export function envOverview() {
  const file = readFile();
  const en = /^en/i.test(process.env.SPRACHE || "");
  return FIELDS.map(({ en: tr, ...f }) => {
    if (en && tr) Object.assign(f, { group: tr[0], label: tr[1], hint: tr[2] || f.hint || "" });
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
    if (!f) throw new Error(tr(`${k} ist nicht einstellbar`, `${k} can't be set here`));
    const v = String(raw ?? "").trim();
    if (/[\r\n]/.test(v) || v.length > 2000) throw new Error(`${f.label}: ${tr("ungültiger Wert", "invalid value")}`);
    if (v && f.options && !f.options.includes(v)) throw new Error(`${f.label}: ${tr("erlaubt sind", "allowed are")} ${f.options.filter(Boolean).join(", ")}`);
    if (v && f.pattern && !new RegExp(f.pattern).test(v)) throw new Error(`${f.label}: ${tr("ungültiger Wert", "invalid value")}`);
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
