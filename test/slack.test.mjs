// Slack-Brücke: Befehle (deutsch und englisch), Hilfe, Knöpfe an Vorschlägen
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor, fakeSlack, fakeSocket, until, wait } from "./helpers.mjs";

const { data } = setupEnv({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test", SLACK_CHANNEL: "C1", CLAUDE_BIN: "/gibt/es/nicht" });
const tandoor = fakeTandoor([
  { id: 1, name: "Lasagne", keywords: [{ name: "geprüft" }], image: `${TANDOOR}/media/1.png` },
  { id: 2, name: "Rahmwirsing", keywords: [] },
  { id: 50, name: "⏳ Entwurf: Gnocchi-Pfanne", keywords: [{ name: "vorschlag-offen" }, { name: "Einfach" }] },
]);
const slack = fakeSlack();
installFetch([
  [TANDOOR, tandoor.handle],
  ["https://slack.com/api/", slack.handle],
  ["https://slack.test/", slack.handle],
]);
const socket = fakeSocket();

// Ein offener Import-Vorschlag für den Entwurf 50
writeFileSync(
  join(data, "rezepte", "vorschlaege.json"),
  JSON.stringify({ proposals: { p1: { id: "p1", kind: "import", draft_id: 50, original_id: null, name: "Gnocchi-Pfanne", status: "open", created: new Date().toISOString(), slack: { channel: "C1", thread_ts: "5.0", last_ts: "6.0" } } }, checked: {}, rejected: {} }),
);

await import(APP("slack-bridge.mjs"));
assert.ok(await until(socket.ready), "Brücke verbindet sich mit Slack");

async function command(name, text = "") {
  const before = slack.responses.length;
  socket.send({ type: "slash_commands", payload: { command: name, text, user_id: "U1", channel_id: "C1", response_url: "https://slack.test/response" } });
  assert.ok(await until(() => slack.responses.length > before), `Antwort auf ${name}`);
  return slack.responses.at(-1);
}

test("/statistik zählt Rezepte ohne Entwürfe", async () => {
  const r = await command("/statistik");
  assert.match(r, /Rezept-Statistik/);
  assert.match(r, /Rezepte insgesamt: \*2\*/);
  assert.match(r, /geprüft: \*1\*/);
});

test("Englische Befehle führen zum selben Befehl, Antwort in der eingestellten Sprache", async () => {
  process.env.SPRACHE = "en";
  try {
    assert.match(await command("/stats"), /Recipes in total: \*2\*/);
    assert.match(await command("/statistik"), /Recipe statistics/);
    const help = await command("/help");
    assert.match(help, /`\/no-image/);
    assert.match(await command("/unsinn"), /Unknown command/);
  } finally {
    process.env.SPRACHE = "";
  }
});

test("/rezept sucht mit Status", async () => {
  const r = await command("/rezept", "lasa");
  assert.match(r, /1 Treffer/);
  assert.match(r, /Lasagne.*geprüft/);
  assert.match(await command("/rezept", "gibtsnicht"), /Kein Rezept/);
});

test("/hilfe listet alle Befehle", async () => {
  const r = await command("/hilfe");
  for (const c of ["/statistik", "/offen", "/rezept", "/ohne-bild", "/bild-neu", "/bild-alle", "/pruefen", "/pro-tag", "/wochenplan", "/was-kochen", "/hilfe"]) assert.ok(r.includes(c), c);
});

test("/was-kochen findet Rezepte über Tandoor-Lebensmittel", async () => {
  tandoor.recipes.get(2).steps = [{ name: "Schritt 1", order: 0, ingredients: [{ food: { name: "Wirsing" }, order: 0 }, { food: { name: "Sahne" }, order: 1 }] }];
  const r = await command("/was-kochen", "Wirsing, Sahne");
  assert.match(r, /1 Rezepte\* mit Wirsing, Sahne/);
  assert.match(r, /⭐ <.*\|Rahmwirsing>/);
  assert.match(await command("/what-to-cook", "Einhorn"), /Keine dieser Zutaten|None of these/);
});

test("/wochenplan startet den Agenten mit Tagen und Wünschen", async () => {
  const before = slack.posts.length;
  const r = await command("/wochenplan", "5 vegetarisch, schnell");
  assert.match(r, /Der Plan kommt gleich/);
  assert.ok(await until(() => slack.posts.slice(before).some((p) => /Plan für 5 Tage \(„vegetarisch, schnell“\)/.test(p.text))));
  assert.match(await command("/wochenplan", "40"), /1 bis 14 Tage/);
});

test("Kurze Nachricht im Kanal → Hilfe statt Auftrag", async () => {
  const before = slack.posts.length;
  socket.send({ type: "events_api", payload: { event: { type: "message", user: "U1", channel: "C1", ts: "7.0", text: "hi" } } });
  assert.ok(await until(() => slack.posts.length > before));
  assert.match(slack.posts.at(-1).text, /Schick mir einen Link/);
});

test("Knopf „Übernehmen“: Entwurf wird zum Rezept mit Schlagwort geprüft", async () => {
  socket.send({ type: "interactive", payload: { type: "block_actions", user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "6.0", text: "Neues Rezept", blocks: [] }, actions: [{ action_id: "rz_apply", value: "p1" }] } });
  assert.ok(await until(() => tandoor.recipes.get(50).name === "Gnocchi-Pfanne"), "Entwurfs-Präfix entfernt");
  const kws = tandoor.recipes.get(50).keywords.map((k) => k.name);
  assert.ok(kws.includes("geprüft") && kws.includes("Einfach") && !kws.includes("vorschlag-offen"));
  assert.ok(await until(() => slack.updates.some((u) => JSON.stringify(u.blocks).includes("Übernommen von <@U2>"))));
  // Zweiter Klick: schon erledigt
  socket.send({ type: "interactive", payload: { type: "block_actions", user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "6.0", text: "x", blocks: [] }, actions: [{ action_id: "rz_apply", value: "p1" }] } });
  assert.ok(await until(() => slack.updates.some((u) => JSON.stringify(u.blocks).includes("schon erledigt"))));
});

test("Knöpfe aus fremden Kanälen werden ignoriert", async () => {
  const before = slack.updates.length;
  socket.send({ type: "interactive", payload: { type: "block_actions", user: { id: "U3" }, channel: { id: "C-fremd" }, message: { ts: "1.0", text: "x", blocks: [] }, actions: [{ action_id: "rz_apply", value: "p1" }] } });
  await wait(100);
  assert.equal(slack.updates.length, before);
});
