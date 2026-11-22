// Verpasste Slack-Nachrichten nachholen und Selbstheilung (lib/verpasst.mjs, Slack-Brücke)
// Autor: SebastianInTheWild · MIT-Lizenz

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, fakeSlack, fakeSocket, until, json } from "./helpers.mjs";

const { data } = setupEnv({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test", SLACK_CHANNEL: "C1", CLAUDE_BIN: "/gibt/es/nicht", NEUSTART_MELDUNG: "aus" });
const v = await import(APP("lib/verpasst.mjs"));
const dir = join(data, "rezepte");
const now = Date.parse("2026-11-22T12:00:00Z");
const ts = (hoursAgo) => ((now - hoursAgo * 3_600_000) / 1000).toFixed(6);

test("missedMessages: nur Menschen, nach dem Merkpunkt, ohne Thread-Antworten, höchstens 3 Tage, ohne bekannte", () => {
  const since = ts(100);
  const msgs = [
    { ts: ts(2), user: "U1", text: "neu" },
    { ts: ts(3), user: "U1", text: "Datei", subtype: "file_share", files: [{}] },
    { ts: ts(1), bot_id: "B1", text: "Bot" },
    { ts: ts(1), user: "U1", subtype: "channel_join" },
    { ts: ts(1), user: "U1", thread_ts: ts(5), text: "Antwort im Thread" },
    { ts: ts(80), user: "U1", text: "zu alt" },
    { ts: ts(4), user: "U1", text: "schon bearbeitet" },
  ];
  const got = v.missedMessages(msgs, { since, now, known: (t) => t === ts(4) });
  assert.deepEqual(got.map((m) => m.text), ["Datei", "neu"]);
  assert.deepEqual(v.missedMessages(msgs, { since: ts(2.5), now }).map((m) => m.text), ["neu"]);
});

test("markSeen geht nur vorwärts", () => {
  v.markSeen(dir, "200.000001");
  v.markSeen(dir, "100.000001");
  assert.equal(v.lastSeen(dir), "200.000001");
});

test("Vorschau: eine Zeile, gekürzt; nur Datei → 📎", () => {
  assert.equal(v.preview({ text: "a\n b" }), "a b");
  assert.equal(v.preview({ text: "x".repeat(100) }, 10), "xxxxxxxxx…");
  assert.equal(v.preview({ files: [{}, {}] }), "📎 2 Dateien");
});

test("Selbstheilung: erst nach 30 min, dann höchstens alle 6 Stunden, „aus“ schaltet ab", () => {
  const env = {};
  assert.equal(v.shouldHeal(dir, 29 * 60_000, now, env), false);
  assert.equal(v.shouldHeal(dir, 31 * 60_000, now, env), true);
  v.markHealed(dir, 31 * 60_000, now);
  assert.equal(v.shouldHeal(dir, 120 * 60_000, now + 3_600_000, env), false);
  assert.equal(v.shouldHeal(dir, 120 * 60_000, now + 7 * 3_600_000, env), true);
  assert.equal(v.shouldHeal(dir, 999 * 60_000, now + 7 * 3_600_000, { SELBSTHEILUNG_MIN: "aus" }), false);
  assert.equal(v.healMinutes({ SELBSTHEILUNG_MIN: "10" }), 10);
});

test("Brücke: nach dem Verbinden Rückfrage zu verpassten Nachrichten, „Nachholen“ verarbeitet sie", async () => {
  writeFileSync(join(dir, "eingang.json"), JSON.stringify({ ts: "1000.000000" }));
  const recent = (Date.now() / 1000 - 3600).toFixed(6);
  const slack = fakeSlack();
  const history = [
    { type: "message", ts: recent, user: "U1", text: "<https://example.com/rezept|Rezept>" },
    { type: "message", ts: (Number(recent) + 1).toFixed(6), bot_id: "B1", text: "Bot" },
  ];
  installFetch([
    [TANDOOR, fakeTandoor([]).handle],
    ["https://slack.com/api/conversations.history", async () => json({ ok: true, messages: history })],
    ["https://slack.com/api/", slack.handle],
    ["https://example.com/", async () => new Response("<html></html>")],
  ]);
  const socket = fakeSocket();
  await import(APP("slack-bridge.mjs"));
  assert.ok(await until(socket.ready));
  socket.open();
  assert.ok(await until(() => slack.posts.some((p) => /verpasst/.test(p.text))), "Rückfrage im Kanal");
  const ask = slack.posts.find((p) => /verpasst/.test(p.text));
  assert.match(ask.text, /eine Nachricht/);
  const id = ask.blocks.at(-1).elements[0].value;
  assert.equal(v.lastSeen(dir), (Number(recent) + 1).toFixed(6), "Merkpunkt auf die neueste Nachricht");

  // Erneutes Verbinden fragt nicht noch einmal
  socket.open();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(slack.posts.filter((p) => /verpasst/.test(p.text)).length, 1);

  socket.send({ type: "interactive", payload: { type: "block_actions", user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "9.0", text: ask.text, blocks: ask.blocks }, actions: [{ action_id: "rz_missed_yes", value: id }] } });
  const job = join(dir, "auftraege", `${recent.replace(".", "-")}.json`);
  assert.ok(await until(() => existsSync(job)), "Auftrag aus der verpassten Nachricht");
  assert.equal(JSON.parse(readFileSync(job, "utf8")).kind, "import");
  assert.equal(v.loadMissed(dir)[id].status, "nachgeholt");
  assert.ok(slack.updates.some((u) => /holt die Nachricht nach/.test(JSON.stringify(u.blocks))));
});
