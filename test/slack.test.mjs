// Slack-Brücke: Befehle (deutsch und englisch), Hilfe, Knöpfe an Vorschlägen
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  for (const c of ["/statistik", "/offen", "/rezept", "/ohne-bild", "/bild-neu", "/bild-alle", "/pruefen", "/pruefen-rezept", "/pro-tag", "/wochenplan", "/was-kochen", "/hilfe"]) assert.ok(r.includes(c), c);
});

test("/was-kochen findet Rezepte über Tandoor-Lebensmittel", async () => {
  tandoor.recipes.get(2).steps = [{ name: "Schritt 1", order: 0, ingredients: [{ food: { name: "Wirsing" }, order: 0 }, { food: { name: "Sahne" }, order: 1 }] }];
  const r = await command("/was-kochen", "Wirsing, Sahne");
  assert.match(r, /1 Rezepte\* mit Wirsing, Sahne/);
  assert.match(r, /⭐ <.*\|Rahmwirsing>/);
  assert.match(await command("/what-to-cook", "Einhorn"), /Keine dieser Zutaten|None of these/);
});

test("/pruefen-rezept merkt ein schon geprüftes Rezept vor und startet die Prüfung", async () => {
  const r = await command("/pruefen-rezept", "Lasagne");
  assert.match(r, /Lasagne.*wird in spätestens 30 Sekunden geprüft/);
  const settings = JSON.parse(readFileSync(join(data, "rezepte", "einstellungen.json"), "utf8"));
  assert.deepEqual(settings.einzeln.map((x) => x.id), [1]);
  assert.ok(existsSync(join(data, "rezept-qualitaet", "start-anfrage.json")), "Start angefragt");
  assert.match(await command("/check-recipe", "gibtsnicht"), /Kein Rezept|No recipe/);
  assert.match(await command("/pruefen-rezept", "50"), /Kein Rezept|No recipe/, "Entwürfe nicht");
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

test("Knopf „🎨 Neues Bild“: Rückmeldung am Vorschlag, die übrigen Knöpfe bleiben", async () => {
  const store = JSON.parse((await import("node:fs")).readFileSync(join(data, "rezepte", "vorschlaege.json"), "utf8"));
  tandoor.recipes.set(51, { id: 51, name: "⏳ Entwurf: Curry-Hack-Nudeln", keywords: [{ name: "vorschlag-offen" }], steps: [] });
  store.proposals.p2 = { id: "p2", kind: "quality", draft_id: 51, original_id: 2, name: "Curry-Hack-Nudeln", status: "open" };
  writeFileSync(join(data, "rezepte", "vorschlaege.json"), JSON.stringify(store));
  const buttons = { type: "actions", elements: [{ action_id: "rz_apply" }, { action_id: "rz_draft_image" }] };
  const before = slack.updates.length;
  socket.send({ type: "interactive", payload: { type: "block_actions", user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "8.0", text: "Vorschlag", blocks: [{ type: "section" }, buttons] }, actions: [{ action_id: "rz_draft_image", value: "p2" }] } });
  // Ohne Bild-Anbieter im Test: Fehlermeldung statt Bild – entscheidend ist, dass die Knöpfe stehen bleiben
  assert.ok(await until(() => slack.updates.length >= before + 2));
  const last = slack.updates.at(-1);
  assert.ok(last.blocks.some((b) => b.type === "actions"), "Knöpfe bleiben");
  assert.equal(last.blocks.filter((b) => b.block_id === "rzimgstatus").length, 1, "genau eine Statuszeile");
});

test("Knopf „🎨 Neues Bild“ mit trigger_id: Dialog mit optionalem Wunsch, Absenden erzeugt das Bild", async () => {
  const buttons = { type: "actions", elements: [{ action_id: "rz_apply" }, { action_id: "rz_draft_image" }] };
  const views = slack.views.length;
  socket.send({ type: "interactive", payload: { type: "block_actions", trigger_id: "t1", user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "8.0", text: "Vorschlag", blocks: [{ type: "section" }, buttons] }, actions: [{ action_id: "rz_draft_image", value: "p2" }] } });
  assert.ok(await until(() => slack.views.length > views), "Dialog geöffnet");
  const view = slack.views.at(-1).view;
  assert.equal(view.callback_id, "rz_image_wish");
  assert.equal(view.blocks[0].optional, true, "Wunsch ist optional");
  const before = slack.updates.length;
  socket.send({ type: "interactive", payload: { type: "view_submission", user: { id: "U2" }, view: { callback_id: "rz_image_wish", private_metadata: view.private_metadata, state: { values: { wish: { text: { value: "  mehr Soße  " } } } } } } });
  // Ohne Bild-Anbieter im Test: Fehlermeldung – entscheidend ist, dass der Vorschlag nach dem Absenden bearbeitet wird
  assert.ok(await until(() => slack.updates.length >= before + 2), "Status am Vorschlag");
  assert.ok(slack.updates.at(-1).blocks.some((b) => b.type === "actions"), "Knöpfe bleiben");
  // Gleicher Schlüssel ein zweites Mal: nichts passiert
  const after = slack.updates.length;
  socket.send({ type: "interactive", payload: { type: "view_submission", user: { id: "U2" }, view: { callback_id: "rz_image_wish", private_metadata: view.private_metadata, state: { values: {} } } } });
  await wait(100);
  assert.equal(slack.updates.length, after);
});

test("/offen neu schickt offene Vorschläge und Pläne mit aktuellen Knöpfen neu", async () => {
  const { readFileSync } = await import("node:fs");
  const file = join(data, "rezepte", "vorschlaege.json");
  const store = JSON.parse(readFileSync(file, "utf8"));
  store.proposals.p2.slack = { channel: "C1", thread_ts: "8.0", last_ts: "8.0" };
  store.proposals.p2.changes = ["Mengen ergänzt"];
  store.plans = { w1: { id: "w1", status: "open", servings: 2, summary: "", days: [{ date: "2026-11-03", recipe_id: 1, name: "Lasagne", servings: 2 }], slack: { channel: "C1", thread_ts: "9.0", last_ts: "9.0" } } };
  writeFileSync(file, JSON.stringify(store));

  // Nur im Rezept-Kanal
  const outside = slack.responses.length;
  socket.send({ type: "slash_commands", payload: { command: "/offen", text: "neu", user_id: "U1", channel_id: "C-fremd", response_url: "https://slack.test/response" } });
  assert.ok(await until(() => slack.responses.length > outside));
  assert.match(slack.responses.at(-1), /nur im Rezept-Kanal/);

  const posts = slack.posts.length;
  const updates = slack.updates.length;
  assert.match(await command("/offen", "neu"), /2 von 2 offenen Vorschlägen neu geschickt/);
  const sent = slack.posts.slice(posts).map((p) => JSON.stringify(p.blocks));
  assert.ok(sent.some((b) => b.includes("rz_draft_image") && b.includes("Mengen ergänzt") && b.includes("Neu geschickt")), "Vorschlag mit „🎨 Neues Bild“");
  assert.ok(sent.some((b) => b.includes("rz_plan_shop")), "Wochenplan");
  // Alte Nachrichten werden zum Verweis ohne Knöpfe
  const old = slack.updates.slice(updates).filter((u) => u.ts === "8.0" || u.ts === "9.0");
  assert.equal(old.length, 2);
  assert.ok(old.every((u) => !JSON.stringify(u.blocks).includes("actions")));
  // Antworten im alten Thread gehören weiter zum Vorschlag
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(after.proposals.p2.slack.old_ts.includes("8.0"));
  assert.notEqual(after.proposals.p2.slack.last_ts, "8.0");
  const { proposalByThread } = await import(APP("lib/rezepte.mjs"));
  assert.equal(proposalByThread("8.0")?.id, "p2");
});

test("Knöpfe aus fremden Kanälen werden ignoriert", async () => {
  const before = slack.updates.length;
  socket.send({ type: "interactive", payload: { type: "block_actions", user: { id: "U3" }, channel: { id: "C-fremd" }, message: { ts: "1.0", text: "x", blocks: [] }, actions: [{ action_id: "rz_apply", value: "p1" }] } });
  await wait(100);
  assert.equal(slack.updates.length, before);
});
