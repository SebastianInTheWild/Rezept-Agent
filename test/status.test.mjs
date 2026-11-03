// Status der Verbindungen und Warnung vor ablaufenden Tokens (lib/status.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, fakeSlack, json } from "./helpers.mjs";

const DAY = 86_400_000;
const { data } = setupEnv({
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_CHANNEL: "C1",
  TANDOOR_TOKEN: "tda_abcdef_123456_xyz9",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
  CLAUDE_BIN: process.execPath, // „claude --version“ → Node-Version
  GEMINI_API_KEY: "g",
  BACKUP_TOKEN: "github_pat_test",
  BACKUP_REPO: "test/sicherung",
  CF_ACCOUNT_ID: "acc",
  CF_AI_TOKEN: "cf",
});
const tandoor = fakeTandoor([{ id: 1, name: "Linsensuppe" }]);
tandoor.accessTokens.push({ id: 1, token: "tda_abcd****xyz9", expires: new Date(Date.now() + 10.5 * DAY).toISOString(), scope: "read write" }, { id: 2, token: "tda_ffff****0000", expires: new Date(Date.now() + 300 * DAY).toISOString() });
const slack = fakeSlack();
let githubExpires = new Date(Date.now() + 2.5 * DAY);
let googleOk = true;
const ghDate = (d) => `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://slack.com/api/", slack.handle],
  ["https://generativelanguage.googleapis.com/", async () => (googleOk ? json({ models: [] }) : json({ error: { message: "API key not valid" } }, 400))],
  ["https://api.github.com/", async () => json({ full_name: "test/sicherung", permissions: { push: true } }, 200, { "github-authentication-token-expiration": ghDate(githubExpires) })],
  ["https://api.cloudflare.com/", async () => json({ success: true, result: { status: "active", expires_on: new Date(Date.now() + 100 * DAY).toISOString() } })],
]);
const status = await import(APP("lib/status.mjs"));
const byKey = (r) => Object.fromEntries(r.items.map((x) => [x.key, x]));

test("Alle Dienste geprüft, Ablaufdaten aus GitHub, Tandoor, Cloudflare und geschätzt für Claude", async () => {
  const r = byKey(await status.checkAll({ fresh: true }));
  assert.equal(r.tandoor.ok, true);
  assert.equal(r.tandoor.days_left, 10, "Token über Anfang und Ende erkannt");
  assert.equal(r.tandoor.warn, true, "≤ 14 Tage");
  assert.equal(r.slack.ok, true);
  assert.equal(r.claude.ok, true);
  assert.match(r.claude.detail, /Claude Code v\d+/);
  assert.ok(r.claude.days_left >= 364 && r.claude.days_left <= 365, "geschätzt 365 Tage ab erstem Sehen");
  assert.match(r.claude.expires_note, /geschätzt/);
  assert.equal(r.google.ok, true);
  assert.equal(r.google.expires, undefined, "Google-Schlüssel laufen nicht ab");
  assert.equal(r.github.days_left, 2);
  assert.equal(r.cloudflare.days_left, 99);
  assert.equal(r.cloudflare.warn, false);
  assert.equal(r.openai.configured, false);
  // Tokens selbst stehen nirgends, nur Fingerabdrücke
  const saved = readFileSync(join(data, "token-status.json"), "utf8");
  assert.ok(!saved.includes("github_pat_test") && !saved.includes("tda_abcdef"));
});

test("Claude: festes Ablaufdatum aus CLAUDE_TOKEN_ABLAUF", async () => {
  process.env.CLAUDE_TOKEN_ABLAUF = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
  const r = byKey(await status.checkAll({ fresh: true }));
  assert.ok(r.claude.days_left >= 4 && r.claude.days_left <= 5);
  assert.equal(r.claude.expires_note, "");
  delete process.env.CLAUDE_TOKEN_ABLAUF;
});

test("Warnungen: einmal je Stufe in Slack (14 Tage, 3 Tage, abgelaufen), Fehler einmal", async () => {
  const before = slack.posts.length;
  const first = await status.warnTokens("C1");
  assert.equal(first.length, 2, "Tandoor (10 Tage) und GitHub (2 Tage)");
  assert.match(first.join("\n"), /GitHub-Sicherung\*: Der Token läuft in 2 Tagen ab/);
  assert.match(first.join("\n"), /Fine-grained tokens/);
  assert.equal(slack.posts.length, before + 1, "eine Nachricht");
  assert.deepEqual(await status.warnTokens("C1"), [], "nicht noch einmal");
  githubExpires = new Date(Date.now() - 1.5 * DAY);
  const expired = await status.warnTokens("C1");
  assert.equal(expired.length, 1);
  assert.match(expired[0], /abgelaufen/);
  googleOk = false;
  const broken = await status.warnTokens("C1");
  assert.match(broken[0], /Google Gemini\*: Die Verbindung klappt nicht \(API key not valid\)/);
  assert.deepEqual(await status.warnTokens("C1"), [], "Fehler nur einmal");
  googleOk = true;
  await status.warnTokens("C1");
  googleOk = false;
  assert.equal((await status.warnTokens("C1")).length, 1, "nach Erholung wieder melden");
  googleOk = true;
});

test("Neuer Token → Warnungen von vorn, Schätzung ab heute", async () => {
  process.env.BACKUP_TOKEN = "github_pat_neu";
  githubExpires = new Date(Date.now() + 200 * DAY);
  const r = byKey(await status.checkAll({ fresh: true }));
  assert.equal(r.github.warn, false);
  const state = JSON.parse(readFileSync(join(data, "token-status.json"), "utf8"));
  assert.deepEqual(state.github.warned, {});
});
