// Wochenrückblick in Slack: neue Rezepte, entschiedene und offene Vorschläge, was gekocht und wie bewertet wurde,
// der Bestand und die geschätzten Google-Kosten der letzten sieben Tage. Uhrzeit: zeitplan.conf
// „wochenrueckblick = So 19:30“ (Standard), „aus“ schaltet ab; „Jetzt senden“ in der Weboberfläche.
// Autor: SebastianInTheWild · MIT-Lizenz

import { all, isDraft, recipeUrl } from "./tandoor.mjs";
import { post, slackReady, link } from "./slack.mjs";
import { L, locale } from "./i18n.mjs";
import { loadStore, stats, CHANNEL } from "./rezepte.mjs";
import { cookedSince } from "./kochen.mjs";
import { costBetween, formatUsd, hasUsage } from "./google-nutzung.mjs";

export const DIGEST_ID = "wochenrueckblick";
export const DIGEST_DEFAULT = "So 19:30";
const tz = () => process.env.TZ || "Europe/Berlin";
const isoDay = (d) => d.toLocaleDateString("sv-SE", { timeZone: tz() });
const short = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const names = (list, max = 6) => list.slice(0, max).join(", ") + (list.length > max ? ` ${L("und", "and")} ${list.length - max} ${L("weitere", "more")}` : "");

/** Zahlen der letzten 7 Tage (bis einschließlich heute) */
export async function weekData(now = new Date()) {
  const to = isoDay(now);
  const from = isoDay(new Date(now.getTime() - 6 * 86_400_000));
  const inWeek = (iso) => Boolean(iso) && isoDay(new Date(iso)) >= from && isoDay(new Date(iso)) <= to;
  const store = loadStore();
  const props = Object.values(store.proposals || {});
  const decided = props.filter((p) => inWeek(p.decided));
  // Neue Rezepte: in Tandoor angelegt (created_at) oder über einen übernommenen Import-Vorschlag
  const recipes = (await all("/api/recipe/")).filter((r) => !isDraft(r.name));
  const fromImports = new Set(decided.filter((p) => p.status === "applied" && p.kind === "import").map((p) => p.recipe_id ?? p.draft_id));
  const added = recipes.filter((r) => inWeek(r.created_at) || fromImports.has(r.id));
  const cooked = cookedSince(from).filter((e) => e.date <= to && e.answer !== undefined && e.answer !== null);
  const s = await stats(now);
  return {
    from,
    to,
    added: added.map((r) => ({ id: r.id, name: r.name })),
    applied_new: decided.filter((p) => p.status === "applied" && p.kind === "import").length,
    applied_better: decided.filter((p) => p.status === "applied" && p.kind !== "import").length,
    rejected: decided.filter((p) => ["rejected", "skipped"].includes(p.status)).length,
    open: props.filter((p) => p.status === "open").length,
    cooked: cooked.map((e) => ({ id: e.recipe_id, name: e.name, rating: e.answer, date: e.date })),
    stats: { total: s.total, checked: s.checked, todo: s.todo, no_image: s.no_image },
    google: hasUsage() ? costBetween(from, to) : null,
  };
}

export function digestMessage(w) {
  const num = (n) => n.toLocaleString(locale());
  const lines = [`📊 *${L("Wochenrückblick", "Weekly review")}* · ${short(w.from)} – ${short(w.to)}`];
  lines.push(
    w.added.length
      ? `• ${L("Neu in Tandoor", "New in Tandoor")}: *${w.added.length}* – ${names(w.added.map((r) => link(recipeUrl(r.id), r.name)))}`
      : `• ${L("Keine neuen Rezepte", "No new recipes")}`,
  );
  const dec = w.applied_new + w.applied_better + w.rejected;
  lines.push(
    `• ${L("Vorschläge", "Proposals")}: ${dec ? L(`${w.applied_new + w.applied_better} übernommen (${w.applied_new} neu, ${w.applied_better} verbessert), ${w.rejected} verworfen`, `${w.applied_new + w.applied_better} applied (${w.applied_new} new, ${w.applied_better} improved), ${w.rejected} discarded`) : L("keine entschieden", "none decided")} · ${L("noch offen", "still open")}: *${w.open}*`,
  );
  if (w.cooked.length) {
    const avg = w.cooked.reduce((a, e) => a + e.rating, 0) / w.cooked.length;
    const best = [...w.cooked].sort((a, b) => b.rating - a.rating)[0];
    lines.push(`• ${L("Gekocht und bewertet", "Cooked and rated")}: *${w.cooked.length}* · ${L("im Schnitt", "average")} ${avg.toLocaleString(locale(), { maximumFractionDigits: 1 })} ⭐ · ${L("am besten", "best")}: ${link(recipeUrl(best.id), best.name)} ${"⭐".repeat(best.rating)}`);
  } else lines.push(`• ${L("Gekocht: keine Bewertungen diese Woche", "Cooked: no ratings this week")}`);
  lines.push(`• ${L("Bestand", "Collection")}: ${num(w.stats.total)} ${L("Rezepte", "recipes")}, ${num(w.stats.checked)} ${L("geprüft", "checked")}, ${num(w.stats.todo)} ${L("noch zu prüfen", "to check")}, ${num(w.stats.no_image)} ${L("ohne Bild", "without picture")}`);
  if (w.google !== null) lines.push(`• ${L("Google-Kosten (geschätzt)", "Google cost (estimated)")}: ${formatUsd(w.google)} ${L("diese Woche", "this week")}`);
  return { text: L("Wochenrückblick", "Weekly review"), blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n").slice(0, 2900) } }] };
}

/** Rückblick in den Kanal schicken */
export async function sendDigest(now = new Date(), channel = CHANNEL()) {
  if (!slackReady() || !channel) throw new Error("Slack ist nicht eingerichtet (SLACK_BOT_TOKEN/SLACK_CHANNEL)");
  const w = await weekData(now);
  const m = digestMessage(w);
  await post(channel, m.text, m.blocks);
  return w;
}
