// Nach dem Image-Bau (GitHub Actions): Abschnitt „## Unveröffentlicht“ im CHANGELOG zur gebauten Version machen –
// Überschrift mit Version, Pull Request und Image-Tag – und darüber einen leeren „Unveröffentlicht“-Abschnitt anlegen.
// Aufruf: node .github/changelog-version.mjs CHANGELOG.md "2026-11-03 10-11" "2026-11-03_10-11" [PR-Nummer]
// Ändert nichts, wenn „Unveröffentlicht“ leer ist oder die Version schon eingetragen ist.
// Autor: SebastianInTheWild · MIT-Lizenz

import { readFileSync, writeFileSync } from "node:fs";

const HEADING = "## Unveröffentlicht";
export const NOTE = "_Kommt mit dem nächsten Merge auf `main`. Sobald das Image gebaut ist, ersetzt GitHub Actions diese Überschrift durch die Version und den Image-Tag._";
const EMPTY = "_Noch nichts._";

/** Liefert den neuen Text oder null, wenn nichts zu tun ist. */
export function release(text, { version, tag, pr = "", repo = "SebastianInTheWild/Rezept-Agent" }) {
  const lines = text.split("\n");
  const start = lines.indexOf(HEADING);
  if (start < 0 || lines.some((l) => l.startsWith(`## ${version} `) || l === `## ${version}`)) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).filter((l) => l !== NOTE && l !== EMPTY);
  if (!body.some((l) => l.trim())) return null; // nichts Neues
  const prText = /^\d+$/.test(String(pr)) ? ` · [PR #${pr}](https://github.com/${repo}/pull/${pr})` : "";
  const section = [`## ${version}${prText} · Image-Tag \`${tag}\``, ...trim(body)];
  const out = [...lines.slice(0, start), HEADING, "", NOTE, "", EMPTY, "", ...section, "", ...lines.slice(end)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
const trim = (a) => {
  const b = [...a];
  while (b.length && !b.at(-1).trim()) b.pop();
  while (b.length && !b[0].trim()) b.shift();
  return ["", ...b];
};

if (process.argv[1]?.endsWith("changelog-version.mjs")) {
  const [file, version, tag, pr] = process.argv.slice(2);
  if (!file || !version || !tag) {
    console.error('Aufruf: node .github/changelog-version.mjs CHANGELOG.md "<Version>" "<Tag>" [PR]');
    process.exit(2);
  }
  const next = release(readFileSync(file, "utf8"), { version, tag, pr });
  if (next) writeFileSync(file, next);
  console.log(next ? `CHANGELOG: Version ${version} (Tag ${tag}) eingetragen` : "CHANGELOG: nichts einzutragen");
}
