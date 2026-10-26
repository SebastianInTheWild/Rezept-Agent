// Automations-Doktor: sammelt Auffälligkeiten aller Automationen und schreibt den Befund in ein eigenes
// Dashboard („Automations-Doktor“, nur Admins) statt eine Benachrichtigung zu schicken.
// Autor: SebastianInTheWild · MIT-Lizenz

import { join } from "node:path";
import { SEVERITIES, agentData, loadJson, oneLine as md, out, saveDashboard, saveJson, stamp as nowText } from "./report.mjs";
import { rest } from "./ha.mjs";
import { applyOps, approvals, configHash, doctorData, ensureTodo, fixId, itemText, loadFixes, saveFixes } from "./fixes.mjs";

const DASHBOARD = process.env.DOCTOR_DASHBOARD || "automations-doktor";
const DAYS_QUIET = Number(process.env.DOCTOR_QUIET_DAYS || 60);
const reportFile = () => join(agentData(), "report.json");
const lastReportFile = () => join(doctorData(), "last-report.json");

/** Prüfdaten je Automation: Zustand, fehlende/ausgefallene Entitäten, Fehler in den letzten Läufen. */
export async function health(call, reg) {
  const services = await call({ type: "get_services" });
  const domains = new Set(Object.keys(reg.st).map((id) => id.split(".")[0]));
  const traces = await call({ type: "trace/list", domain: "automation" }).catch(() => []);
  const byItem = {};
  for (const t of traces) (byItem[t.item_id] ||= []).push(t);

  const res = [];
  for (const a of reg.automations) {
    const issues = [];
    if (!a.id) issues.push("in YAML definiert, nicht im Editor änderbar");
    if (a.state === "unavailable") issues.push("Automation ist nicht verfügbar (Konfiguration fehlerhaft)");
    let cfg = {};
    if (a.id) cfg = await rest("GET", `config/automation/config/${a.id}`).catch(() => ({}));
    let checkCfg = cfg;
    if (cfg.use_blueprint) {
      checkCfg = await call({ type: "blueprint/substitute", domain: "automation", path: cfg.use_blueprint.path, input: cfg.use_blueprint.input || {} })
        .then((r) => r.substituted_config)
        .catch((e) => {
          issues.push(`Blueprint lässt sich nicht auflösen: ${e.message}`);
          return cfg;
        });
    }
    // Erwähnte Entitäten: nur Domains, die es gibt, ohne Aktionen (light.turn_on) und Template-Variablen.
    // Werte von trigger/condition/action/platform sind Bausteine wie media_player.turned_on oder sun.is_up, keine Entitäten.
    const texts = [];
    const walk = (node, key) => {
      if (typeof node === "string") {
        if (!["trigger", "condition", "action", "service", "platform"].includes(key)) texts.push(node);
      } else if (Array.isArray(node)) node.forEach((x) => walk(x, key));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, k);
    };
    walk(checkCfg);
    const ids = new Set(texts.join(" ").match(/\b[a-z_]+\.[a-z0-9_]+\b/g) || []);
    const missing = [];
    const down = [];
    for (const id of ids) {
      const [domain, obj] = id.split(".");
      if (!domains.has(domain) || services[domain]?.[obj]) continue;
      const s = reg.st[id];
      if (!s) {
        const e = reg.ent[id];
        missing.push(e?.disabled_by ? `${id} (deaktiviert)` : id);
      } else if (["unavailable", "unknown"].includes(s.state)) down.push(`${id} (${s.state})`);
    }
    if (missing.length) issues.push(`fehlende Entitäten: ${missing.join(", ")}`);
    if (down.length) issues.push(`Entitäten nicht verfügbar: ${down.join(", ")}`);

    const runs = (byItem[a.id] || []).sort((x, y) => (y.timestamp?.start || "").localeCompare(x.timestamp?.start || ""));
    const errors = runs.filter((t) => t.error || t.script_execution === "error").map((t) => `${t.timestamp?.start?.slice(0, 16)}: ${t.error || "Fehler"}`);
    if (errors.length) issues.push(`Fehler in ${errors.length} von ${runs.length} gespeicherten Läufen: ${errors.slice(0, 3).join(" | ")}`);

    const last = a.last_triggered ? new Date(a.last_triggered) : null;
    const quietDays = last ? Math.floor((Date.now() - last) / 86400000) : null;
    if (a.state === "on" && !last) issues.push("noch nie ausgelöst");
    else if (a.state === "on" && quietDays > DAYS_QUIET) issues.push(`seit ${quietDays} Tagen nicht ausgelöst`);

    res.push({
      entity_id: a.entity_id,
      id: a.id,
      name: a.name,
      state: a.state,
      category: a.category,
      labels: a.labels,
      description: cfg.description || "",
      last_triggered: a.last_triggered,
      issues,
      config: issues.length ? checkCfg : undefined,
      // Bei Blueprints beziehen sich Pfade in fix.ops auf raw_config (use_blueprint), sonst auf config
      raw_config: issues.length && cfg.use_blueprint ? cfg : undefined,
    });
  }
  return res;
}

const STATUS = {
  umgesetzt: "✅ Umgesetzt",
  abgelehnt: "❌ Nicht umgesetzt",
  fehlgeschlagen: "⚠️ Fehlgeschlagen",
};

function dashboardConfig(report, checked, store = { fixes: {} }, approved = new Set(), todo) {
  const findings = [...(report.findings || [])].sort((a, b) => Object.keys(SEVERITIES).indexOf(a.severity) - Object.keys(SEVERITIES).indexOf(b.severity));
  const stamp = report.stamp || nowText();
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const summary = {
    type: "markdown",
    content:
      `## 🩺 Automations-Doktor\n**Stand:** ${stamp} · ${checked} Automationen geprüft · ` +
      (findings.length ? Object.entries(SEVERITIES).map(([s, i]) => `${i} ${count(s)} ${s}`).join(" · ") : "✅ keine Befunde") +
      (report.summary ? `\n\n${report.summary}` : ""),
  };
  const overview = [{ type: "heading", heading: "Übersicht", icon: "mdi:stethoscope" }, summary];
  if (todo) {
    overview.push(
      { type: "heading", heading: "Freigaben", icon: "mdi:check-decagram-outline", heading_style: "subtitle" },
      { type: "todo-list", entity: todo, hide_create: true },
    );
  }
  const sections = [{ type: "grid", cards: overview }];
  for (const [sev, icon] of Object.entries(SEVERITIES)) {
    const list = findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    const cards = [{ type: "heading", heading: `${icon} Dringlichkeit ${sev}` }];
    for (const f of list) {
      const fix = f.fid ? store.fixes[f.fid] : undefined;
      let fixText = "";
      if (fix) {
        const when = fix.at ? ` am ${new Date(fix.at).toLocaleString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin", dateStyle: "short", timeStyle: "short" })}` : "";
        const state =
          STATUS[fix.status] ? `${STATUS[fix.status]}${when}${fix.status !== "umgesetzt" && fix.note ? `: ${md(fix.note)}` : ""}`
          : approved.has(fix.fid) ? "⏳ Freigegeben – der Umsetzer prüft und übernimmt die Änderung in Kürze."
          : "";
        fixText =
          `\n\n**Empfehlung:** ${md(fix.summary)}\n` +
          (fix.changes || []).map((c) => `- ${md(c)}`).join("\n") +
          (state ? `\n\n${state}` : "");
      }
      cards.push({ type: "tile", entity: f.entity_id, features_position: "bottom", vertical: false });
      cards.push({
        type: "markdown",
        content:
          `**Problem:** ${md(f.problem)}\n\n**Vorschlag:** ${md(f.suggestion)}` + fixText +
          (f.id ? `\n\n[In der Automation öffnen](/config/automation/edit/${f.id})` : ""),
      });
      // Knopf: Freigabe = Eintrag in der To-do-Liste; HA fragt vorher nach
      if (fix && todo && fix.status === "offen" && !approved.has(fix.fid)) {
        cards.push({
          type: "button",
          name: "Empfehlung übernehmen",
          icon: "mdi:check-decagram-outline",
          icon_height: "28px",
          show_state: false,
          tap_action: {
            action: "perform-action",
            perform_action: "todo.add_item",
            target: { entity_id: todo },
            data: { item: itemText(fix) },
            confirmation: { text: `„${fix.summary}“ freigeben? Der Umsetzer prüft die Änderung und übernimmt sie dann in die Automation (mit Sicherung).` },
          },
          grid_options: { columns: "full", rows: 1 },
        });
      }
    }
    sections.push({ type: "grid", cards });
  }
  return { title: "Automations-Doktor", views: [{ title: "Befund", path: "befund", icon: "mdi:stethoscope", type: "sections", max_columns: 3, sections }] };
}

/** Zeichnet das Dashboard aus dem letzten Befund neu (Status der Empfehlungen, Freigaben). */
export async function refreshDashboard(call) {
  const report = loadJson(lastReportFile(), null);
  if (!report) return false;
  const todo = await ensureTodo(call);
  const store = loadFixes();
  const approved = new Set((await approvals(call, todo)).map((a) => a.fid));
  const config = dashboardConfig(report, report.checked || 0, store, approved, todo);
  if (process.env.DRY === "1") return config;
  await saveDashboard(call, { url: DASHBOARD, title: "Automations-Doktor", icon: "mdi:stethoscope" }, config);
  return true;
}

export async function doctor(call, reg, cmd, args) {
  if (cmd === "health") {
    const list = await health(call, reg);
    const problems = list.filter((a) => a.issues.length);
    if (args.includes("--count")) return console.log(problems.length);
    return out({ checked: list.length, quiet_days: DAYS_QUIET, severities: Object.keys(SEVERITIES), problems, ok: list.filter((a) => !a.issues.length).map((a) => a.name) });
  }
  if (cmd === "report") {
    // report.json: {summary, findings: [{entity_id, severity: hoch|mittel|niedrig, problem, suggestion}]}
    const report = loadJson(reportFile(), null);
    if (!report) return out({ ok: false, errors: [`Kein Bericht: ${reportFile()} fehlt`] });
    const known = new Map(reg.automations.map((a) => [a.entity_id, a]));
    const errors = [];
    const store = loadFixes();
    const seen = new Set();
    for (const f of report.findings || []) {
      if (!known.has(f.entity_id)) errors.push(`${f.entity_id}: unbekannte Automation`);
      if (!SEVERITIES[f.severity]) errors.push(`${f.entity_id}: severity muss ${Object.keys(SEVERITIES).join("/")} sein`);
      if (!f.problem?.trim() || !f.suggestion?.trim()) errors.push(`${f.entity_id}: problem und suggestion nötig`);
      f.id = known.get(f.entity_id)?.id;
      if (!f.fix) continue;
      // Empfehlung: Schritte jetzt auf den aktuellen Stand anwenden – was hier nicht geht, wird nicht angeboten
      const where = `${f.entity_id} fix`;
      if (!f.id) {
        errors.push(`${where}: Automation ist in YAML definiert – keine Empfehlung möglich, fix weglassen`);
        continue;
      }
      if (!f.fix.summary?.trim()) errors.push(`${where}: summary fehlt (ein Satz, was die Änderung bewirkt)`);
      const raw = await rest("GET", `config/automation/config/${f.id}`).catch(() => null);
      if (!raw) {
        errors.push(`${where}: Konfiguration nicht lesbar`);
        continue;
      }
      const res = applyOps(raw, f.fix.ops, reg.st);
      if (res.errors.length) {
        errors.push(...res.errors.map((e) => `${where}: ${e}`));
        continue;
      }
      const fid = fixId(f.entity_id, f.fix.ops);
      f.fid = fid;
      seen.add(fid);
      const old = store.fixes[fid];
      store.fixes[fid] = {
        // Erneut empfohlen nach Ablehnung/Fehlschlag: wieder anbieten
        ...(old?.status === "offen" ? old : { status: "offen", created: new Date().toISOString() }),
        fid, entity_id: f.entity_id, automation_id: f.id, name: known.get(f.entity_id).name,
        summary: f.fix.summary.trim(), problem: f.problem, ops: f.fix.ops, changes: res.changes,
        // Stand beim Befund; ältere Freigaben behalten ihren Stand nur, solange sie noch offen sind
        hash: configHash(raw),
        seen: new Date().toISOString(),
      };
    }
    if (errors.length) return out({ ok: false, errors });
    // Nicht mehr empfohlene, nie umgesetzte Empfehlungen vergessen; erledigte behalten (höchstens 50)
    for (const [fid, x] of Object.entries(store.fixes)) if (!seen.has(fid) && x.status === "offen") delete store.fixes[fid];
    const done = Object.values(store.fixes).filter((x) => x.status !== "offen").sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    for (const x of done.slice(50)) delete store.fixes[x.fid];
    const todo = await ensureTodo(call);
    const approved = new Set((await approvals(call, todo)).map((a) => a.fid));
    const full = { at: new Date().toISOString(), stamp: nowText(), checked: reg.automations.length, ...report };
    const config = dashboardConfig(full, reg.automations.length, store, approved, todo);
    if (process.env.DRY === "1") return out({ ok: true, dry: true, findings: (report.findings || []).length, fixes: seen.size, config });
    saveFixes(store);
    const created = await saveDashboard(call, { url: DASHBOARD, title: "Automations-Doktor", icon: "mdi:stethoscope" }, config);
    saveJson(lastReportFile(), full);
    return out({ ok: true, dashboard: `/${DASHBOARD}/befund`, created, findings: (report.findings || []).length, fixes: seen.size });
  }
  throw new Error(`Unbekannter Befehl: automations ${cmd}`);
}
