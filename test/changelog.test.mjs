// CHANGELOG: „Unveröffentlicht“ wird nach dem Image-Bau zur Version mit PR und Image-Tag (.github/changelog-version.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

const { release, NOTE } = await import(new URL("../.github/changelog-version.mjs", import.meta.url).href);

const before = `# Changelog

Einleitung.

## Unveröffentlicht

${NOTE}

### Neu
- **Versionsnummer** sichtbar.

### Behoben
- Ein Fehler.

## 2026-11-03 10-11 · [PR #16](https://github.com/SebastianInTheWild/Rezept-Agent/pull/16) · Image-Tag \`sha-4ecc18d\`

### Neu
- Altes.
`;

test("Unveröffentlicht → Version mit PR-Link und Tag, darüber ein leerer Abschnitt", () => {
  const out = release(before, { version: "2026-11-04 09-12", tag: "2026-11-04_09-12", pr: "17" });
  const heads = out.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(heads, [
    "## Unveröffentlicht",
    "## 2026-11-04 09-12 · [PR #17](https://github.com/SebastianInTheWild/Rezept-Agent/pull/17) · Image-Tag `2026-11-04_09-12`",
    "## 2026-11-03 10-11 · [PR #16](https://github.com/SebastianInTheWild/Rezept-Agent/pull/16) · Image-Tag `sha-4ecc18d`",
  ]);
  const section = out.split("## 2026-11-04 09-12")[1].split("## 2026-11-03")[0];
  assert.match(section, /### Neu\n- \*\*Versionsnummer\*\* sichtbar\.\n\n### Behoben\n- Ein Fehler\./);
  assert.ok(!section.includes(NOTE), "Hinweis bleibt nur beim leeren Abschnitt");
  assert.match(out.split("## 2026-11-04")[0], /_Noch nichts\._/);
  assert.match(out, /^Einleitung\.$/m);
  assert.ok(!/\n{3,}/.test(out), "keine doppelten Leerzeilen");
});

test("Nichts zu tun: leerer Abschnitt, Version schon da, keine Überschrift", () => {
  const once = release(before, { version: "2026-11-04 09-12", tag: "2026-11-04_09-12", pr: "17" });
  assert.equal(release(once, { version: "2026-11-05 08-00", tag: "2026-11-05_08-00" }), null, "Unveröffentlicht ist leer");
  assert.equal(release(before, { version: "2026-11-03 10-11", tag: "x" }), null, "Version schon eingetragen");
  assert.equal(release("# Changelog\n", { version: "v", tag: "t" }), null);
});

test("Ohne PR-Nummer (z. B. direkter Push): nur Version und Tag", () => {
  const out = release(before, { version: "2026-11-04 09-12", tag: "2026-11-04_09-12", pr: "" });
  assert.match(out, /^## 2026-11-04 09-12 · Image-Tag `2026-11-04_09-12`$/m);
});

test("Das echte CHANGELOG hat den Abschnitt „Unveröffentlicht“ mit dem Hinweis und Tags in jeder Version", () => {
  const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  assert.ok(text.includes(`## Unveröffentlicht\n\n${NOTE}`));
  const versions = text.split("\n").filter((l) => l.startsWith("## ") && l !== "## Unveröffentlicht");
  assert.ok(versions.length > 5);
  for (const v of versions) assert.match(v, /`sha-[0-9a-f]{7}`|`\d{4}-\d{2}-\d{2}_\d{2}-\d{2}`/, v);
});
