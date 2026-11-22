// Wöchentlicher Neustart und offene Aufträge nach einem Neustart (lib/neustart.mjs)
// Autor: SebastianInTheWild · MIT-Lizenz

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP } from "./helpers.mjs";

const { data, cleanup } = setupEnv();
const { openJobs, markResumed, restartSlots, RESTART_DEFAULT } = await import(APP("lib/neustart.mjs"));
const dir = join(data, "rezepte", "auftraege");
mkdirSync(dir, { recursive: true });
const now = Date.parse("2026-11-22T12:00:00Z");
const ago = (h) => new Date(now - h * 3_600_000).toISOString();
const write = (name, job) => writeFileSync(join(dir, `${name}.json`), JSON.stringify({ channel: "C1", ts: name.replace("-", "."), ...job }));

test("Neustart: Standard So 04:00, „aus“ (leere Liste) schaltet ab, eigene Zeiten gelten", () => {
  assert.deepEqual(restartSlots({}), [RESTART_DEFAULT]);
  assert.deepEqual(restartSlots({ neustart: [] }), []);
  assert.deepEqual(restartSlots({ neustart: ["Mi 03:00"] }), ["Mi 03:00"]);
});

test("Offene Aufträge: ohne Ergebnis, jung genug, älteste zuerst; erledigte, alte und kaputte bleiben liegen", () => {
  write("1-2", { kind: "import", created: ago(2) });
  write("1-1", { kind: "import", created: ago(5) });
  write("2-1", { kind: "import", created: ago(1), result: "ok" });
  write("2-2", { kind: "import", created: ago(1), replied: true });
  write("3-1", { kind: "import", created: ago(30) });
  writeFileSync(join(dir, "kaputt.json"), "{");
  assert.deepEqual(openJobs(dir, now).map((x) => x.job.ts), ["1.1", "1.2"]);
});

test("Ein Auftrag wird höchstens zweimal neu begonnen", () => {
  const [first] = openJobs(dir, now);
  let job = markResumed(first.file, first.job);
  assert.equal(JSON.parse(readFileSync(first.file, "utf8")).resumed, 1);
  job = markResumed(first.file, job);
  assert.equal(job.resumed, 2);
  assert.deepEqual(openJobs(dir, now).map((x) => x.job.ts), ["1.2"]);
});

test("Fehlender Ordner: keine Aufträge", () => {
  assert.deepEqual(openJobs(join(data, "gibtsnicht"), now), []);
  cleanup();
});
