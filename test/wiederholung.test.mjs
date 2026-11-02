// Agenten-Lauf am Claude-Limit: vormerken, später nachholen, nach Erfolg aufräumen
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP } from "./helpers.mjs";

const { data } = setupEnv();
// Nachgebautes „claude“: Verhalten über eine Datei steuerbar (limit | ok)
const bin = join(data, "fake-claude");
const mode = join(data, "mode");
writeFileSync(bin, `#!/usr/bin/env node\nconst m = require("fs").readFileSync(${JSON.stringify(mode)}, "utf8");\nif (m === "limit") { console.log("You've hit your limit · resets 3pm (Europe/Berlin)"); process.exit(1); }\nconsole.log("fertig");\n`);
chmodSync(bin, 0o755);
process.env.CLAUDE_BIN = bin;
// Kleiner Test-Agent ohne Vorprüfung
const agents = join(data, "agents");
mkdirSync(join(agents, "test-agent"), { recursive: true });
writeFileSync(join(agents, "test-agent", "agent.json"), JSON.stringify({ name: "Test", schedule: ["12:00"] }));
writeFileSync(join(agents, "test-agent", "prompt.md"), "Test");
process.env.AGENTS_DIR = agents;
const { runAgent, pendingRetry, readStatus } = await import(APP("run-agent.mjs"));

test("Limit → Wiederholung vorgemerkt, Erfolg → Vormerkung weg", { skip: process.platform === "win32" && "braucht ein ausführbares Skript (läuft in GitHub Actions unter Linux)" }, async () => {
  writeFileSync(mode, "limit");
  assert.equal(await runAgent("test-agent", { by: "zeitplan" }), 1);
  const retry = pendingRetry("test-agent");
  assert.ok(retry, "retry.json angelegt");
  assert.equal(retry.attempts, 1);
  assert.ok(Date.parse(retry.next) > Date.now() + 25 * 60_000, "frühestens in 30 Minuten");
  const last = readStatus("test-agent", "last-run.json");
  assert.equal(last.limit, true);

  await runAgent("test-agent", { by: "wiederholung" });
  assert.equal(pendingRetry("test-agent").attempts, 2, "weiter vorgemerkt, Zähler hoch");

  writeFileSync(mode, "ok");
  assert.equal(await runAgent("test-agent", { by: "wiederholung" }), 0);
  assert.equal(pendingRetry("test-agent"), null);
  assert.equal(readStatus("test-agent", "last-run.json").result, "ok");
});

test("Läufe aus Slack merkt der Zeitplan nicht vor (das macht die Slack-Brücke)", { skip: process.platform === "win32" && "braucht ein ausführbares Skript" }, async () => {
  writeFileSync(mode, "limit");
  await runAgent("test-agent", { by: "slack" });
  assert.equal(pendingRetry("test-agent"), null);
  assert.equal(readStatus("test-agent", "last-run.json").limit, true);
});
