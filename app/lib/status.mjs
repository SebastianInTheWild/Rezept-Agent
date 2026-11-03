// Status der Verbindungen (Weboberfläche → Status) und Warnung vor ablaufenden Tokens (Slack).
// Prüft je Dienst, ob er erreichbar ist und die Zugangsdaten gelten, und wann der Token abläuft – soweit der Dienst
// das verrät: GitHub (Header github-authentication-token-expiration), Cloudflare (tokens/verify → expires_on),
// Tandoor (/api/access-token/ → expires). Beim Claude-Token (claude setup-token) sagt es niemand: angenommen wird
// CLAUDE_TOKEN_GUELTIG_TAGE (Standard 365) ab dem Tag, an dem der Agent den Token zum ersten Mal gesehen hat,
// oder genau CLAUDE_TOKEN_ABLAUF (JJJJ-MM-TT). Slack-Bot-Tokens und Google-API-Schlüssel laufen nicht ab.
// Tägliche Prüfung (zeitplan.conf „token-pruefung = 09:05“): Meldung im Kanal TOKEN_WARNUNG_TAGE (Standard 14) Tage
// vorher, noch einmal 3 Tage vorher und am Ablauftag – und wenn Zugangsdaten nicht (mehr) funktionieren.
// Gemerkt in daten/token-status.json: je Dienst Fingerabdruck des Tokens (kein Token selbst), erstes Sehen, Warnungen.
// Autor: SebastianInTheWild · MIT-Lizenz

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { api, base } from "./tandoor.mjs";
import { slack, slackReady, post } from "./slack.mjs";
import { L, locale } from "./i18n.mjs";

export const TOKEN_CHECK_ID = "token-pruefung";
export const TOKEN_CHECK_DEFAULT = "09:05";
const FILE = () => join(process.env.DATA_DIR || "/data", "token-status.json");
const DAY = 86_400_000;
const warnDays = () => Math.max(1, Number(process.env.TOKEN_WARNUNG_TAGE) || 14);
const claudeDays = () => Math.max(1, Number(process.env.CLAUDE_TOKEN_GUELTIG_TAGE) || 365);

const readState = () => {
  try {
    return JSON.parse(readFileSync(FILE(), "utf8"));
  } catch {
    return {};
  }
};
const writeState = (s) => {
  mkdirSync(dirname(FILE()), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(s, null, 1));
};
const fingerprint = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 16);

/** Eintrag zum aktuellen Token (neuer Token → neuer Eintrag, alte Warnungen vergessen) */
function seen(state, key, value) {
  const fp = fingerprint(value);
  if (state[key]?.fp !== fp) state[key] = { fp, first_seen: new Date().toISOString(), warned: {} };
  return state[key];
}

const timeout = (ms) => AbortSignal.timeout(ms);
const getJson = async (url, init = {}) => {
  const r = await fetch(url, { ...init, signal: timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  return { r, j };
};
const validDate = (d) => (d && !Number.isNaN(Date.parse(d)) ? new Date(d).toISOString() : null);

// ---------- Prüfungen je Dienst ----------
// Jede liefert { ok, detail, expires?, expires_note? }; fehlt die Einstellung, ist der Dienst nicht eingerichtet.

const CHECKS = [
  {
    key: "tandoor",
    name: "Tandoor",
    env: ["TANDOOR_TOKEN"],
    where: () => L("Einstellungen → Tandoor", "Settings → Tandoor"),
    renew: () => L("In Tandoor unter Einstellungen → API einen neuen Token anlegen", "Create a new token in Tandoor under Settings → API"),
    async run() {
      const j = await api("GET", "/api/recipe/?page_size=1");
      const out = { ok: true, detail: L(`${base()} · ${j.count ?? "?"} Rezepte`, `${base()} · ${j.count ?? "?"} recipes`) };
      // Ablauf des eigenen Tokens: Tandoor zeigt ihn gekürzt – passt Anfang und Ende, oder gibt es nur einen
      const tokens = await api("GET", "/api/access-token/").then((x) => x.results || x, () => []);
      if (Array.isArray(tokens) && tokens.length) {
        const mine = process.env.TANDOOR_TOKEN;
        const visible = (t) => String(t.token || "").replace(/\*+/g, "*");
        const match = tokens.find((t) => t.token === mine) || tokens.find((t) => { const [a, b = ""] = visible(t).split("*"); return a.length >= 4 && mine.startsWith(a) && mine.endsWith(b); }) || (tokens.length === 1 ? tokens[0] : null);
        if (match?.expires) Object.assign(out, { expires: validDate(match.expires), expires_note: tokens.length === 1 || match.token === mine ? "" : L("vermutlich dieser Token", "probably this token") });
      }
      return out;
    },
  },
  {
    key: "slack",
    name: "Slack",
    env: ["SLACK_BOT_TOKEN"],
    where: () => L("Einstellungen → Slack", "Settings → Slack"),
    renew: () => L("In der Slack-App unter OAuth & Permissions den Bot-Token kopieren", "Copy the bot token in the Slack app under OAuth & Permissions"),
    async run() {
      const j = await slack("auth.test");
      return { ok: true, never: true, detail: `${j.team || "?"} · @${j.user || "?"}${process.env.SLACK_CHANNEL ? "" : L(" · SLACK_CHANNEL fehlt", " · SLACK_CHANNEL missing")}` };
    },
  },
  {
    key: "claude",
    name: "Claude",
    env: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    where: () => L("Einstellungen → Claude", "Settings → Claude"),
    renew: () => L("Auf einem PC mit Claude Code „claude setup-token“ ausführen", "Run “claude setup-token” on a computer with Claude Code"),
    async run(entry) {
      const version = await new Promise((res) => execFile(process.env.CLAUDE_BIN || "claude", ["--version"], { timeout: 10_000 }, (e, out) => res(e ? null : String(out).trim())));
      const oauth = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
      const out = { ok: Boolean(version), never: !oauth, detail: `${version ? `Claude Code ${version}` : L("Claude Code nicht gefunden", "Claude Code not found")} · ${oauth ? L("Abo-Token", "subscription token") : L("API-Schlüssel", "API key")}` };
      if (oauth) {
        const fixed = validDate((process.env.CLAUDE_TOKEN_ABLAUF || "").trim() && `${process.env.CLAUDE_TOKEN_ABLAUF.trim()}T12:00:00Z`);
        out.expires = fixed || new Date(Date.parse(entry.first_seen) + claudeDays() * DAY).toISOString();
        out.expires_note = fixed ? "" : L(`geschätzt: ${claudeDays()} Tage ab erstem Einsatz – genaues Datum unter CLAUDE_TOKEN_ABLAUF eintragen`, `estimated: ${claudeDays()} days from first use – enter the exact date as CLAUDE_TOKEN_ABLAUF`);
      }
      return out;
    },
  },
  {
    key: "google",
    name: "Google Gemini",
    env: ["GEMINI_API_KEY"],
    where: () => L("Einstellungen → KI-Fotos", "Settings → AI photos"),
    renew: () => L("In Google AI Studio einen neuen API-Schlüssel anlegen", "Create a new API key in Google AI Studio"),
    async run() {
      const { r, j } = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      return { ok: true, never: true, detail: L("Schlüssel gültig", "key valid") };
    },
  },
  {
    key: "github",
    name: () => L("GitHub-Sicherung", "GitHub backup"),
    env: ["BACKUP_TOKEN"],
    where: () => L("Einstellungen → GitHub-Sicherung", "Settings → GitHub backup"),
    renew: () => L("Auf GitHub unter Settings → Developer settings → Fine-grained tokens den Token neu erzeugen (Regenerate)", "Regenerate the token on GitHub under Settings → Developer settings → Fine-grained tokens"),
    async run() {
      const repo = (process.env.BACKUP_REPO || "").trim();
      const { r, j } = await getJson(`https://api.github.com/${repo ? `repos/${repo}` : "user"}`, { headers: { Authorization: `Bearer ${process.env.BACKUP_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rezept-agent" } });
      if (!r.ok) throw new Error(`${j.message || `HTTP ${r.status}`}${repo ? ` (${repo})` : ""}`);
      // „2026-12-01 12:00:00 UTC“ bzw. „… +0100“
      const exp = (r.headers.get("github-authentication-token-expiration") || "").trim().replace(" UTC", "Z").replace(/^(\S+) (\S+) ?/, "$1T$2");
      const push = j.permissions ? j.permissions.push : null;
      return { ok: push !== false, detail: repo ? `${repo}${push === false ? L(" · Token darf nicht schreiben", " · token can't write") : ""}` : L("BACKUP_REPO fehlt", "BACKUP_REPO missing"), expires: validDate(exp) };
    },
  },
  {
    key: "cloudflare",
    name: "Cloudflare Workers AI",
    env: ["CF_AI_TOKEN"],
    where: () => L("Einstellungen → KI-Fotos", "Settings → AI photos"),
    renew: () => L("Im Cloudflare-Dashboard unter My Profile → API Tokens verlängern oder neu anlegen", "Extend or create it in the Cloudflare dashboard under My Profile → API Tokens"),
    async run() {
      const auth = { headers: { Authorization: `Bearer ${process.env.CF_AI_TOKEN}` } };
      let { r, j } = await getJson(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/tokens/verify`, auth);
      if (!r.ok || !j.success) ({ r, j } = await getJson("https://api.cloudflare.com/client/v4/user/tokens/verify", auth));
      if (!r.ok || !j.success) throw new Error(j.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`);
      return { ok: j.result?.status === "active", detail: `Token ${j.result?.status || "?"}`, expires: validDate(j.result?.expires_on) };
    },
  },
  {
    key: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    where: () => L("Einstellungen → KI-Fotos", "Settings → AI photos"),
    renew: () => L("Unter platform.openai.com einen neuen Schlüssel anlegen", "Create a new key at platform.openai.com"),
    async run() {
      const { r, j } = await getJson("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      return { ok: true, never: true, detail: L("Schlüssel gültig", "key valid") };
    },
  },
];

const daysLeft = (iso, now = Date.now()) => (iso ? Math.floor((Date.parse(iso) - now) / DAY) : null);
const fmtDate = (iso) => new Date(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: process.env.TZ || "Europe/Berlin" });

let cache = null;
/** Alle Dienste prüfen (Ergebnis 60 s zwischengespeichert, fresh = neu prüfen) */
export async function checkAll({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.result;
  const state = readState();
  const items = await Promise.all(
    CHECKS.map(async (c) => {
      const value = c.env.map((k) => process.env[k]).find(Boolean);
      const info = { key: c.key, name: typeof c.name === "function" ? c.name() : c.name, where: c.where(), renew: c.renew() };
      if (!value) return { ...info, configured: false, ok: null, detail: L(`Eintragen unter ${info.where}`, `Set it up under ${info.where}`) };
      const entry = seen(state, c.key, value);
      try {
        const r = await c.run(entry);
        const left = daysLeft(r.expires);
        return { ...info, configured: true, ...r, days_left: left, warn: r.ok === false || (left !== null && left <= warnDays()) };
      } catch (e) {
        return { ...info, configured: true, ok: false, detail: String(e.message).slice(0, 200), warn: true };
      }
    }),
  );
  writeState(state);
  const result = { at: new Date().toISOString(), warn_days: warnDays(), items };
  cache = { at: Date.now(), result };
  return result;
}

/** Text für eine Warnung (Ablauf bzw. Fehler) – oder null */
export function warningText(it) {
  if (it.ok === false) return L(`🔑 *${it.name}*: Die Verbindung klappt nicht (${it.detail}). Bitte die Zugangsdaten prüfen – ${it.renew} und unter ${it.where} eintragen.`, `🔑 *${it.name}*: the connection doesn't work (${it.detail}). Please check the credentials – ${it.renew} and enter it under ${it.where}.`);
  if (it.days_left === null || it.days_left === undefined || it.days_left > warnDays()) return null;
  const when = fmtDate(it.expires);
  const note = it.expires_note ? ` _(${it.expires_note})_` : "";
  if (it.days_left < 0) return L(`🔑 *${it.name}*: Der Token ist am ${when} abgelaufen.${note} ${it.renew} und unter ${it.where} eintragen.`, `🔑 *${it.name}*: the token expired on ${when}.${note} ${it.renew} and enter it under ${it.where}.`);
  const inDays = it.days_left === 0 ? L("heute", "today") : L(`in ${it.days_left} ${it.days_left === 1 ? "Tag" : "Tagen"}`, `in ${it.days_left} ${it.days_left === 1 ? "day" : "days"}`);
  return L(`🔑 *${it.name}*: Der Token läuft ${inDays} ab (${when}).${note} Rechtzeitig erneuern: ${it.renew} und unter ${it.where} eintragen.`, `🔑 *${it.name}*: the token expires ${inDays} (${when}).${note} Renew it in time: ${it.renew} and enter it under ${it.where}.`);
}

// Stufe der Warnung: einmal bei TOKEN_WARNUNG_TAGE, einmal 3 Tage vorher, einmal am Ablauf; Fehler einmal je Token
const stage = (it) => (it.ok === false ? "fehler" : it.days_left < 0 ? "abgelaufen" : it.days_left <= 3 ? "3" : it.days_left <= warnDays() ? String(warnDays()) : null);

/** Tägliche Prüfung: neue Warnungen in den Kanal. Liefert die gesendeten Texte. */
export async function warnTokens(channel = process.env.SLACK_CHANNEL) {
  const { items } = await checkAll({ fresh: true });
  const state = readState();
  const sent = [];
  for (const it of items.filter((x) => x.configured)) {
    const entry = state[it.key];
    if (!entry) continue;
    if (it.ok !== false) delete entry.warned.fehler; // geht wieder → beim nächsten Fehler wieder melden
    const s = stage(it);
    const text = s && warningText(it);
    if (!text || entry.warned[s]) continue;
    entry.warned[s] = new Date().toISOString();
    sent.push(text);
  }
  writeState(state);
  if (sent.length && slackReady() && channel) await post(channel, sent.join("\n\n"));
  return sent;
}
