# Our recipe standard

The template is **Rahmwirsing** (creamed savoy cabbage, in `context` under `reference`; it may still be in German). This is how all recipes should look – in English.

## Language
- **Everything in English:** name, description, equipment, steps, notes, foods and keywords. Recipes in other languages (German, French, Italian …), whether link, video or photo, are translated completely, not partly.
- Use common English names ("spring onion", "cornflour", "double cream" or "heavy cream" – pick one and stay consistent with `foods`). Dishes with an established proper name keep it ("Tiramisu", "Pad Thai", "Rahmwirsing" may become "Creamed savoy cabbage"), with an English description.
- Convert US/imperial measures: cups, oz, lb, fl oz, sticks to g/ml; °F to °C (350 °F = 175 °C, 400 °F = 200 °C). Mention it in `changes`: "Translated from German", "Cups converted to g/ml".

## Structure
- **Name:** short and factual, no advertising ("The best … ever"), no blog or brand names, no "recipe" in the name. Additions in brackets only if they distinguish ("Pasta salad with pesto" instead of "Tortellini salad with pesto (quick recipe)"). Grandma's recipes may be called "… (Grandma's recipe)".
- **Description:** one factual sentence about what it is, e.g. "Creamy savoy cabbage with vegetable stock, cream and butter." No blog text.
- **Servings:** `servings` is the number, the unit is always "servings". For cakes, cookies and tray bakes the number of pieces counts as servings.
- **Times:** `working_time` = active work, `waiting_time` = baking, cooling, resting, braising (minutes).
- **Equipment:** `devices` = everything you need: bowls, knife, chopping board, pot, pan, baking tin with size ("Springform tin 26 cm"), hand mixer, stick blender, oven. Tandoor shows it as the first step "Required equipment".

## Steps
- One task per step. Split long paragraphs, combine tiny steps. Usually 3–8 steps.
- Imperative, short and simple: "Peel the onions and dice finely." No "Now …", "Then …", no first person, no blog tips inside the step.
- Temperatures in °C with the mode: "at 180 °C top/bottom heat" or "fan".
- **Step time:** `time` = minutes the step takes when it involves waiting, baking, cooking or chilling (Tandoor shows a timer). Pure handling without waiting: 0.
- **Ingredients per step:** each ingredient belongs to the step where it is first needed. No ingredient twice, none missing.

## Ingredients
- Amount, unit and food separately. Properties and preparation in `note`: "finely chopped", "softened", "juice", "optional", "a little", "to taste".
- **Units** only from the list in `context` (`units`), metric with English names: g, kg, ml, l, tbsp, tsp, pinch, piece, clove, bunch, can, pack, jar, slice … No cups – convert (1 cup ≈ 240 ml; flour ≈ 125 g, sugar ≈ 200 g). Whole items (egg, onion, apple) with "piece".
- **Foods:** use an existing one from `foods` if it is English; singular, without additions ("onion", not "onions" or "red onion, diced"). New only if it really is something different.
- Salt, pepper, water to taste without amount: `no_amount: true` (no unit), note e.g. "to taste".
- Ingredients you buy need an amount so the shopping list works. If missing, estimate sensibly and say so in `changes`.
- One ingredient = one food. "Salt, pepper" becomes two ingredients. "Butter or margarine" → "butter" with note "or margarine".

## Keywords (`keywords`)
Use existing ones (see `context`) if they are English, otherwise English ones. Every recipe gets:
- **Effort:** exactly one of Easy, Medium, Advanced
- **Taste:** Sweet or Savory
- **Type:** e.g. Main course, Starter, Salad, Soup, Sauce, Dip, Dessert, Cake, Tart, Tray bake, Pastry, Cookies, Baking, Drink
- **Main ingredients:** 1–3, e.g. Potatoes, Minced meat, Cream, Onion
- "Nutrition estimated" when you estimated the nutrition (see below); stays if it was already there (also as „Nährwerte geschätzt“).
The tool sets the status keywords (geprüft, vorschlag-offen, nicht-bearbeiten) and ki-bild itself – never add them yourself; they stay German on purpose.

## Nutrition
- Every recipe has nutrition **per serving** as `nutrition`: calories (kcal), proteins, fats, carbohydrates (g). Estimated from ingredients and amounts and sensibly rounded (kcal to 10, grams to whole numbers). If the source has nutrition values, use those.