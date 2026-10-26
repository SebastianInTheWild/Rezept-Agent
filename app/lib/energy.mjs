// Energie-Coach: Wochendaten aus dem HA-Energie-Dashboard (Statistiken) kompakt für den Agenten.
// Autor: SebastianInTheWild · MIT-Lizenz

import { out, readReport, sendReport } from "./report.mjs";

const TZ = process.env.TZ || "Europe/Berlin";
const r2 = (x) => Math.round(x * 100) / 100;

// Datum/Stunde in Ortszeit
function local(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("de-DE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hour12: false })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday.replace(".", ""), hour: Number(p.hour) % 24 };
}

// Mitternacht (Ortszeit) vor n Tagen als UTC-Zeitpunkt
function midnight(daysAgo) {
  const now = Date.now();
  let t = now - daysAgo * 86400000;
  const { hour } = local(t);
  t -= hour * 3600000;
  t -= new Date(t).getUTCMinutes() * 60000 + new Date(t).getUTCSeconds() * 1000 + new Date(t).getUTCMilliseconds();
  return t;
}

async function stats(call, ids, start, end, period) {
  if (!ids.length) return {};
  return call({
    type: "recorder/statistics_during_period",
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    statistic_ids: ids,
    period,
    types: ["change"],
  });
}

const sumBy = (rows, key) => {
  const res = {};
  for (const r of rows || []) {
    const k = key(r.start);
    res[k] = (res[k] || 0) + (r.change || 0);
  }
  return res;
};

async function week(call) {
  const prefs = await call({ type: "energy/get_prefs" });
  const src = {};
  for (const s of prefs.energy_sources) {
    if (s.type === "grid") {
      src.grid_in = [s.stat_energy_from, ...(s.flow_from || []).map((f) => f.stat_energy_from)].filter(Boolean);
      src.grid_out = [s.stat_energy_to, ...(s.flow_to || []).map((f) => f.stat_energy_to)].filter(Boolean);
      src.price = s.entity_energy_price || s.number_energy_price;
      src.price_export = s.entity_energy_price_export || s.number_energy_price_export;
    }
    if (s.type === "solar") (src.solar ||= []).push(s.stat_energy_from);
    if (s.type === "battery") {
      (src.batt_out ||= []).push(s.stat_energy_from);
      (src.batt_in ||= []).push(s.stat_energy_to);
    }
  }
  const devices = prefs.device_consumption.map((d) => ({ id: d.stat_consumption, name: d.name }));
  const flows = ["grid_in", "grid_out", "solar", "batt_out", "batt_in"].filter((k) => src[k]?.length);
  const allIds = [...new Set([...flows.flatMap((k) => src[k]), ...devices.map((d) => d.id)])];

  // Die letzten 7 vollen Tage (heute zählt nicht mit) und die 7 Tage davor zum Vergleich
  const start = midnight(7);
  const prevStart = midnight(14);
  const now = midnight(0);
  const hourly = await stats(call, allIds, start, now, "hour");
  // Nur Tage vor Wochenbeginn (die API liefert auch den Tag, der genau am Ende beginnt)
  const prevDaily = Object.fromEntries(Object.entries(await stats(call, allIds, prevStart, start, "day")).map(([id, rows]) => [id, rows.filter((r) => r.start < start)]));

  const flowHourly = (k) => {
    const res = {};
    for (const id of src[k] || []) for (const [h, v] of Object.entries(sumBy(hourly[id], (ms) => `${local(ms).day} ${local(ms).hour}`))) res[h] = (res[h] || 0) + v;
    return res;
  };
  const fh = Object.fromEntries(flows.map((k) => [k, flowHourly(k)]));
  const days = [...new Set(Object.keys(fh.grid_in || fh.solar || {}).map((h) => h.split(" ")[0]))].sort();

  const dayRows = days.map((day) => {
    const tot = (k) => r2(Object.entries(fh[k] || {}).filter(([h]) => h.startsWith(day)).reduce((s, [, v]) => s + v, 0));
    const t = Object.fromEntries(flows.map((k) => [k, tot(k)]));
    const consumption = r2((t.grid_in || 0) + (t.solar || 0) + (t.batt_out || 0) - (t.grid_out || 0) - (t.batt_in || 0));
    const hours = (k) => Array.from({ length: 24 }, (_, h) => r2(fh[k]?.[`${day} ${h}`] || 0));
    return {
      day,
      weekday: local(new Date(`${day}T12:00:00Z`).getTime()).weekday,
      kwh: { ...t, consumption },
      autarky_pct: consumption > 0 ? Math.round(100 * (1 - (t.grid_in || 0) / consumption)) : null,
      hourly_grid_in: hours("grid_in"),
      hourly_solar: hours("solar"),
      hourly_grid_out: hours("grid_out"),
    };
  });

  const deviceRows = devices.map((d) => {
    const byHour = sumBy(hourly[d.id], (ms) => `${local(ms).day} ${local(ms).hour}`);
    const perDay = Object.fromEntries(days.map((day) => [day, r2(Object.entries(byHour).filter(([h]) => h.startsWith(day)).reduce((s, [, v]) => s + v, 0))]));
    // Stunden mit nennenswertem Verbrauch (> 0,1 kWh), damit der Agent Zeitpunkte mit PV/Netz vergleichen kann
    const active = Object.entries(byHour).filter(([, v]) => v > 0.1).map(([h, v]) => `${h}h ${r2(v)}`);
    return { name: d.name, statistic: d.id, kwh_week: r2(Object.values(perDay).reduce((s, v) => s + v, 0)), per_day: perDay, active_hours: active };
  });

  const prevTot = (k) => r2((src[k] || []).reduce((s, id) => s + (prevDaily[id] || []).reduce((a, r) => a + (r.change || 0), 0), 0));
  const prev = Object.fromEntries(flows.map((k) => [k, prevTot(k)]));
  prev.consumption = r2((prev.grid_in || 0) + (prev.solar || 0) + (prev.batt_out || 0) - (prev.grid_out || 0) - (prev.batt_in || 0));
  // Tageswerte der Vorwoche: 0 kWh und danach ein Sprung deuten auf Datenlücken (Zähler offline) hin
  const prevDays = {};
  for (const k of flows) for (const id of src[k] || []) for (const r of prevDaily[id] || []) {
    const day = local(r.start).day;
    (prevDays[day] ||= {})[k] = r2((prevDays[day][k] || 0) + (r.change || 0));
  }

  // Laufzeiten von Geräten ohne eigenen Zähler (z. B. Trockner läuft), Liste in ENERGY_ACTIVITY
  const activityIds = (process.env.ENERGY_ACTIVITY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const activity = {};
  if (activityIds.length) {
    const hist = await call({
      type: "history/history_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(now).toISOString(),
      entity_ids: activityIds,
      minimal_response: true,
      no_attributes: true,
    });
    const ON = /^(on|run|running|läuft|laufend|aktiv)$/i;
    for (const id of activityIds) {
      const rows = hist[id] || [];
      const runs = [];
      for (let i = 0; i < rows.length; i++) {
        if (!ON.test(rows[i].s)) continue;
        const from = rows[i].lu * 1000;
        const to = rows[i + 1] ? rows[i + 1].lu * 1000 : now;
        if (to - from < 5 * 60000) continue;
        const a = local(from);
        runs.push(`${a.day} ${a.weekday} ${a.hour}h ${Math.round((to - from) / 60000)} min`);
      }
      activity[id] = runs;
    }
  }

  const priceState = src.price && typeof src.price === "string" ? await call({ type: "get_states" }).then((s) => s.find((x) => x.entity_id === src.price)?.state) : src.price;
  return {
    period: { from: days[0], to: days.at(-1), timezone: TZ },
    price_eur_per_kwh: { import: priceState != null ? Number(priceState) : null, export: src.price_export ?? null },
    week_kwh: Object.fromEntries([...flows, "consumption"].map((k) => [k, r2(dayRows.reduce((s, d) => s + (d.kwh[k] || 0), 0))])),
    previous_week_kwh: prev,
    previous_week_days: prevDays,
    days: dayRows,
    devices: deviceRows,
    activity,
  };
}

export async function energy(call, cmd) {
  if (cmd === "week") return out(await week(call));
  if (cmd === "report") {
    const r = readReport();
    if (!r.ok) return out(r);
    const res = await sendReport(call, r);
    // Zusätzlich auf die Energie-Seite des Dashboards: Sensor „Energie-Coach“ der Integration Unser Zuhause
    let dashboard = "übersprungen (DRY)";
    if (!res.dry && r.report.message?.trim()) {
      dashboard = await call({
        type: "call_service",
        domain: "unser_zuhause",
        service: "set_report",
        service_data: { report: "energy_coach", title: r.report.title.trim(), message: r.report.message.trim() },
      }).then(() => "ok", (e) => `fehlgeschlagen: ${e.message}`);
    }
    return out({ ok: true, ...res, dashboard });
  }
  throw new Error(`Unbekannter Befehl: energy ${cmd}`);
}
