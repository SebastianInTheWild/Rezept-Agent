// Einheitliche Zeitstempel im Container-Log: [TT.MM.JJJJ hh:mm:ss] vor jeder Zeile (Zeitzone aus TZ).
// Wird von scheduler.mjs und slack-bridge.mjs geladen – nicht von tandoor.mjs, dessen Ausgabe JSON bleiben muss.
// Autor: SebastianInTheWild · MIT-Lizenz

/** „02.11.2026 13:27:30“ */
export function stamp(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("de-DE", { timeZone: process.env.TZ || "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

const STAMPED = /^\[\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}\]/;

// console.log/warn/error: Zeitstempel ergänzen, wenn die Zeile noch keinen hat
if (!globalThis.__protokoll) {
  globalThis.__protokoll = true;
  for (const name of ["log", "info", "warn", "error"]) {
    const orig = console[name].bind(console);
    console[name] = (first, ...rest) => (typeof first === "string" && STAMPED.test(first) ? orig(first, ...rest) : typeof first === "string" ? orig(`[${stamp()}] ${first}`, ...rest) : orig(`[${stamp()}]`, first, ...rest));
  }
}
