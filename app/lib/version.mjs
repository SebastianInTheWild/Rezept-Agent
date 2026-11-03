// Programmversion: Zeitpunkt des Commits auf main, aus dem das Image gebaut wurde – „2026-11-03 10-11“ (Zeitzone
// Europe/Berlin). Jeder gemergte Pull Request ergibt so automatisch eine neue Version; der wöchentliche Neubau desselben
// Stands behält sie. GitHub Actions setzt APP_RELEASE (Version) und APP_VERSION (Commit) beim Bau, lokal gebaut: „dev“.
// Autor: SebastianInTheWild · MIT-Lizenz

/** „2026-11-03 10-11“ bzw. „dev“ */
export const release = () => (process.env.APP_RELEASE || "").trim() || "dev";
/** Commit, aus dem das Image gebaut wurde (leer, wenn unbekannt) */
export const commit = () => {
  const c = (process.env.APP_VERSION || "").trim();
  return /^[0-9a-f]{7,40}$/.test(c) ? c : "";
};
/** „2026-11-03 10-11 (4ecc18d)“ */
export const versionText = () => (commit() ? `${release()} (${commit().slice(0, 7)})` : release());
/** Link zum Commit auf GitHub */
export const commitUrl = (c = commit()) => (c ? `https://github.com/SebastianInTheWild/Rezept-Agent/commit/${c}` : "");
