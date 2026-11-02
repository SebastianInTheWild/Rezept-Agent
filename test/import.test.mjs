// Importe und KI-Bilder: HelloFresh-Leser, Video-Links, Google Nano Banana mit Cloudflare als Ersatz
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupEnv, APP, installFetch, json, png } from "./helpers.mjs";

const { data } = setupEnv({ GEMINI_API_KEY: "g", CF_ACCOUNT_ID: "a", CF_AI_TOKEN: "c" });
const { fetchHelloFresh, isHelloFresh, minutes } = await import(APP("lib/hellofresh.mjs"));
const { isVideoUrl } = await import(APP("lib/video.mjs"));
const bild = await import(APP("lib/bild.mjs"));

// Ausschnitt einer echten HelloFresh-Seite (Aufbau wie hellofresh.de, Stand 11/2026)
const recipe = {
  name: "Elsässer Flammkuchen mit Bacon",
  headline: "Nur 10 Minuten aktive Kochzeit",
  descriptionHTML: "<p>Schnell, einfach und lecker!</p>",
  prepTime: "PT30M",
  totalTime: "PT15M",
  imagePath: "/image/flammkuchen.jpg",
  ingredients: [
    { id: "a", name: "frischer Flammkuchenteig", shipped: true },
    { id: "b", name: "Schmand", shipped: true },
    { id: "s", name: "Salz", shipped: false },
  ],
  yields: [
    { yields: 2, ingredients: [{ id: "a", amount: 1, unit: "Packung" }, { id: "b", amount: 150, unit: "g" }, { id: "s", amount: 0, unit: "nach Geschmack" }] },
    { yields: 4, ingredients: [{ id: "a", amount: 2, unit: "Packung" }] },
  ],
  steps: [
    { index: 2, instructionsHTML: "<p>Mit ein wenig Salz* würzen und 13 – 15 Min. backen.</p>", instructionsMarkdown: "Mit ein wenig Salz\\* würzen" },
    { index: 1, instructionsHTML: "<p>Ofen auf 220 °C vorheizen.</p>" },
  ],
  utensils: [{ name: "Backblech" }],
  tags: [{ name: "Wenig Aufwand" }],
  cuisines: [{ name: "Deutsch" }],
  allergens: [{ name: "Milch" }],
};
const page = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { ssrPayload: { recipe } } } })}</script></html>`;

const google = [];
let googleFails = false;
installFetch([
  ["https://www.hellofresh.de/recipes/flammkuchen", async () => new Response(page)],
  ["https://www.hellofresh.de/recipes/blockiert", async () => new Response("", { status: 403 })],
  ["https://img.hellofresh.com/", async () => new Response(png())],
  [
    "https://generativelanguage.googleapis.com/",
    async (url, init) => {
      google.push({ url, body: JSON.parse(init.body) });
      if (googleFails) return json({ error: { message: "quota exceeded" } }, 429);
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png().toString("base64") } }] } }], usageMetadata: { promptTokenCount: 10 } });
    },
  ],
  ["https://api.cloudflare.com/", async (url) => (url.includes("graphql") ? json({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } } }) : json({ result: { image: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") } }))],
]);

test("HelloFresh: Rezept aus den Seitendaten", async () => {
  assert.ok(isHelloFresh("https://www.hellofresh.de/recipes/x-123") && isHelloFresh("https://hellofresh.at/recipes/x") && !isHelloFresh("https://www.chefkoch.de/x"));
  assert.equal(minutes("PT1H15M"), 75);
  const r = await fetchHelloFresh("https://www.hellofresh.de/recipes/flammkuchen", `${data}/inbox`);
  assert.equal(r.ok, true);
  const x = r.recipe;
  assert.equal(x.name, "Elsässer Flammkuchen mit Bacon", "ohne Werbe-Untertitel");
  assert.equal(x.description, "Schnell, einfach und lecker!");
  assert.deepEqual(x.servings_options, [2, 4]);
  assert.equal(x.waiting_time, 0, "Gesamtzeit kleiner als Arbeitszeit → keine negative Wartezeit");
  assert.deepEqual(x.devices, ["Backblech"]);
  assert.equal(x.steps[0].instruction, "Ofen auf 220 °C vorheizen.", "nach index sortiert");
  assert.match(x.steps[1].instruction, /Salz würzen/, "Sternchen entfernt");
  const salt = x.yields[0].ingredients.find((i) => i.food === "Salz");
  assert.deepEqual([salt.amount, salt.unit, salt.note, salt.pantry], [null, null, "nach Geschmack", true]);
  assert.ok(x.image_file, "Foto für den Agenten abgelegt");
});

test("HelloFresh: blockiert → verständliche Meldung", async () => {
  const r = await fetchHelloFresh("https://www.hellofresh.de/recipes/blockiert");
  assert.equal(r.ok, false);
  assert.match(r.msg, /403/);
});

test("Video-Links erkennen", () => {
  for (const u of ["https://www.instagram.com/reel/abc123/?igsh=x", "https://youtube.com/shorts/xyz", "https://youtu.be/xyz", "https://www.tiktok.com/@a/video/1"]) assert.ok(isVideoUrl(u), u);
  assert.ok(!isVideoUrl("https://www.hellofresh.de/recipes/x"));
});

test("KI-Bild: Google mit dem eingestellten Modell, bei Fehler Cloudflare", async () => {
  const d = { name: "Test", steps: [{ ingredients: [{ amount: 1, food: "Wirsing" }] }] };
  const img = await bild.generateImage(d, `${data}/rezepte`);
  assert.equal(bild.imageType(img).ext, "png");
  assert.match(google.at(-1).url, /gemini-nano-banana-2\.1:generateContent/);
  assert.equal(google.at(-1).body.generationConfig.imageConfig.aspectRatio, "3:2");
  assert.equal(bild.lastImageInfo().provider, "google");

  googleFails = true;
  const img2 = await bild.generateImage(d, `${data}/rezepte`);
  assert.equal(bild.imageType(img2).ext, "jpg", "Cloudflare springt ein");
  assert.equal(bild.lastImageInfo().provider, "cloudflare");
  // „nur Google“ (/bild-neu, /bild-alle) springt nicht auf Cloudflare um
  await assert.rejects(bild.generateImage(d, `${data}/rezepte`, { only: "google", noLimit: true }), /quota/);
  googleFails = false;
});

test("KI-Bild: Tageslimit BILD_PRO_TAG", async () => {
  process.env.BILD_PRO_TAG = "1";
  const d = { name: "Limit", steps: [] };
  await assert.rejects(bild.generateImage(d, `${data}/rezepte`), /Tageslimit|Daily limit/);
  // ausdrücklich bestätigte Aufträge zählen nicht gegen das Limit
  await bild.generateImage(d, `${data}/rezepte`, { only: "google", noLimit: true });
  delete process.env.BILD_PRO_TAG;
});
