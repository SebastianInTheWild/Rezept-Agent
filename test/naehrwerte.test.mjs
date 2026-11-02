// Nährwerte: als Tandoor-Eigenschaften (pro Portion) lesen, anlegen, beim Übernehmen zusammenführen
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, APP, TANDOOR, installFetch, fakeTandoor } from "./helpers.mjs";

const { data } = setupEnv();
const step = { name: "Schritt 1", instruction: "Kochen.", time: 5, order: 0, ingredients: [{ food: { name: "Wirsing" }, unit: { name: "g" }, amount: 450, note: "", order: 0, is_header: false, no_amount: false }] };
const tandoor = fakeTandoor([
  // Original mit einer selbst angelegten Eigenschaft (muss erhalten bleiben)
  { id: 2, name: "Rahmwirsing", steps: [step], servings: 4, keywords: [], properties: [{ id: 7, property_amount: 3, property_type: { id: 99, name: "Ballaststoffe", unit: "g" } }] },
]);
tandoor.propertyTypes.push({ id: 99, name: "Ballaststoffe", unit: "g" });
installFetch([[TANDOOR, tandoor.handle]]);
const t = await import(APP("lib/tandoor.mjs"));
const rez = await import(APP("lib/rezepte.mjs"));

test("Nährwert-Typen: vorhandene erkennen (auch Open Data), fehlende anlegen, kJ/Fettsäuren nicht verwechseln", async () => {
  const props = await t.nutritionProperties({ calories: 412.34, proteins: 9, fats: 34, carbohydrates: 18 });
  const byType = Object.fromEntries(props.map((p) => [p.property_type.name, p.property_amount]));
  assert.equal(byType.Calories, 412.3, "vorhandener Typ, auf eine Nachkommastelle");
  assert.equal(byType.Fat, 34, "„Fat“, nicht „Saturated Fat“");
  assert.equal(byType["Eiweiß"], 9, "fehlender Typ angelegt");
  assert.equal(byType.Kohlenhydrate, 18);
  assert.equal(tandoor.propertyTypes.length, 6, "nur zwei neue Typen");
});

test("simplify liest Nährwerte aus den Eigenschaften", () => {
  const r = { ...tandoor.recipes.get(2), properties: tandoor.props([{ property_amount: 500, property_type: { id: 2 } }, { property_amount: 20, property_type: { id: 1 } }]) };
  assert.deepEqual(t.simplify(r).nutrition, { calories: 500, fats: 20 });
  assert.equal(t.simplify(tandoor.recipes.get(2)).nutrition, undefined, "ohne Nährwerte kein Feld");
});

test("Prüfung: unplausible oder unbekannte Werte werden abgelehnt", () => {
  const ctx = { units: ["g"], foods: ["Wirsing"], keywords: [] };
  const base = { name: "X", servings: 2, steps: [{ instruction: "a", ingredients: [] }], keywords: [], changes: ["x"] };
  assert.deepEqual(rez.validate({ ...base, nutrition: { calories: 650, proteins: 25 } }, ctx).errors, []);
  assert.match(rez.validate({ ...base, nutrition: { calories: 9000 } }, ctx).errors.join(), /unplausibel/);
  assert.match(rez.validate({ ...base, nutrition: { zucker: 3 } }, ctx).errors.join(), /gibt es nicht/);
});

test("Text für Slack", () => {
  assert.equal(rez.nutritionText({ calories: 650, proteins: 25, fats: 30, carbohydrates: 60 }), "Pro Portion: 650 kcal · 25 g Eiweiß · 30 g Fett · 60 g Kohlenhydrate");
});

test("Verbesserungsvorschlag übernehmen: Nährwerte kommen ins Original, eigene Eigenschaften bleiben", async () => {
  // Entwurf mit Nährwerten (wie ihn propose() anlegt)
  tandoor.recipes.set(60, { id: 60, name: "⏳ Entwurf: Rahmwirsing", steps: [step], servings: 4, keywords: [{ name: "vorschlag-offen" }, { name: "Nährwerte geschätzt" }], properties: tandoor.props(await t.nutritionProperties({ calories: 420, proteins: 9, fats: 34, carbohydrates: 18 })), private: true, updated_at: "x" });
  writeFileSync(join(data, "rezepte", "vorschlaege.json"), JSON.stringify({ proposals: { q1: { id: "q1", kind: "quality", draft_id: 60, original_id: 2, name: "Rahmwirsing", status: "open" } }, checked: {}, rejected: {} }));
  await rez.applyProposal("q1", "U1");
  const orig = tandoor.recipes.get(2);
  assert.deepEqual(t.simplify(orig).nutrition, { calories: 420, proteins: 9, fats: 34, carbohydrates: 18 });
  assert.ok(orig.properties.some((p) => p.id === 7 && p.property_type.name === "Ballaststoffe"), "Ballaststoffe bleiben");
  assert.ok(orig.keywords.some((k) => k.name === "Nährwerte geschätzt") && orig.keywords.some((k) => k.name === "geprüft"));
  assert.ok(!tandoor.recipes.has(60), "Entwurf gelöscht");
});
