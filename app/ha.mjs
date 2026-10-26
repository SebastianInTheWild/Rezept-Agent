#!/usr/bin/env node
// Werkzeug für die Agenten: liest Home Assistant und ändert nur, was ausdrücklich erlaubt ist.
// Autor: SebastianInTheWild · MIT-Lizenz
//
//   node ha.mjs states [präfix]               Zustände (nur lesen)
//   node ha.mjs notify "<titel>" "<text>"      Push an NOTIFY_PERSONS
//   node ha.mjs automations context           Kategorien, Labels und bereits sortierte Automationen (Stilvorlage)
//   node ha.mjs automations pending [--count] Noch nicht bearbeitete Automationen mit Inhalt
//   node ha.mjs automations apply             Plan aus <AGENT_DATA>/plan.json anwenden (DRY=1: nur zeigen)
//   node ha.mjs automations init              Alle vorhandenen Automationen als bearbeitet merken
//   node ha.mjs automations health [--count]  Auffälligkeiten aller Automationen (Automations-Doktor)
//   node ha.mjs automations report            Befund aus <AGENT_DATA>/report.json ins Dashboard schreiben
//   node ha.mjs logs pending|harmless|report  Neue Fehler im HA-Protokoll (Log-Detektiv)
//   node ha.mjs energy week|report            Energiedaten der letzten 7 Tage (Energie-Coach)
//   node ha.mjs fixes pending [--count]       Freigegebene Empfehlungen des Doktors mit Prüfergebnis (Doktor-Umsetzer)
//   node ha.mjs fixes apply <id>              Freigegebene Empfehlung anwenden (mit Sicherung; DRY=1: nur zeigen)
//   node ha.mjs fixes reject <id> "<grund>"   Freigegebene Empfehlung nicht umsetzen
//   node ha.mjs fixes finish                  Push mit den Ergebnissen dieses Laufs

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect, notify, rest } from "./lib/ha.mjs";
import { doctor } from "./lib/doctor.mjs";
import { energy } from "./lib/energy.mjs";
import { logs } from "./lib/logs.mjs";
import { fixes } from "./lib/fixes.mjs";

const DRY = process.env.DRY === "1";
const DATA = process.env.AGENT_DATA || join(process.env.DATA_DIR || "/data", "automationen");
const STATE_FILE = join(DATA, "state.json");
const PLAN_FILE = join(DATA, "plan.json");
const TEST_LABEL = (process.env.SKIP_LABEL || "Test").toLowerCase();
// Zum Ausprobieren: diese Automationen gelten als unbearbeitet (kommagetrennte entity_ids)
const FORCE = (process.env.FORCE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

const out = (x) => console.log(JSON.stringify(x, null, 1));
const loadState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { processed: {} });
const saveState = (s) => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
};
const readStdin = async () => {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
};

async function registries(call) {
  const [states, entities, devices, areas, labels, categories] = await Promise.all([
    call({ type: "get_states" }),
    call({ type: "config/entity_registry/list" }),
    call({ type: "config/device_registry/list" }),
    call({ type: "config/area_registry/list" }),
    call({ type: "config/label_registry/list" }),
    call({ type: "config/category_registry/list", scope: "automation" }),
  ]);
  const ent = Object.fromEntries(entities.map((e) => [e.entity_id, e]));
  const dev = Object.fromEntries(devices.map((d) => [d.id, d]));
  const area = Object.fromEntries(areas.map((a) => [a.area_id, a.name]));
  const st = Object.fromEntries(states.map((s) => [s.entity_id, s]));
  const labelName = Object.fromEntries(labels.map((l) => [l.label_id, l.name]));
  const catName = Object.fromEntries(categories.map((c) => [c.category_id, c.name]));
  const areaOf = (eid) => {
    const e = ent[eid];
    return area[e?.area_id] || area[dev[e?.device_id]?.area_id] || null;
  };
  const automations = states
    .filter((s) => s.entity_id.startsWith("automation."))
    .map((s) => {
      const e = ent[s.entity_id] || {};
      return {
        entity_id: s.entity_id,
        id: s.attributes.id,
        name: s.attributes.friendly_name,
        state: s.state,
        last_triggered: s.attributes.last_triggered,
        category: catName[e.categories?.automation] || null,
        labels: (e.labels || []).map((l) => labelName[l]).filter(Boolean),
      };
    });
  // Zur Auswahl stehen nur Kategorien und Labels, die schon an Automationen hängen (so bleibt der Stil einheitlich;
  // eine neue Kategorie oder ein neues Label wird verfügbar, sobald du es einmal selbst vergibst)
  const usedLabels = new Set(automations.flatMap((a) => a.labels).filter((l) => l.toLowerCase() !== TEST_LABEL));
  const usedCats = new Set(automations.map((a) => a.category).filter(Boolean));
  return {
    st, ent, areaOf, automations,
    allLabels: labels,
    allCategories: categories,
    labels: labels.filter((l) => usedLabels.has(l.name)),
    categories: categories.filter((c) => usedCats.has(c.name)),
  };
}

async function pendingList(call, reg) {
  const state = loadState();
  return reg.automations.filter(
    (a) =>
      a.id &&
      (FORCE.includes(a.entity_id) ||
        (!state.processed[a.id] && !a.labels.some((l) => l.toLowerCase() === TEST_LABEL))),
  );
}

function entityRefs(cfg, reg) {
  const ids = new Set(JSON.stringify(cfg).match(/\b[a-z_]+\.[a-z0-9_]+\b/g) || []);
  const refs = {};
  for (const id of ids) {
    const s = reg.st[id];
    if (!s) continue;
    refs[id] = { name: s.attributes.friendly_name, area: reg.areaOf(id), state: s.state };
  }
  return refs;
}

// Farben, die Home Assistant für Labels kennt
const LABEL_COLORS = ["primary", "accent", "red", "pink", "purple", "deep-purple", "indigo", "blue", "light-blue", "cyan", "teal", "green", "light-green", "lime", "yellow", "amber", "orange", "deep-orange", "brown", "light-grey", "grey", "dark-grey", "blue-grey", "black", "white"];
// Höchstens so viele neue Kategorien bzw. Labels pro Lauf
const MAX_NEW = Number(process.env.MAX_NEW || 2);

const contentOf = (cfg) => JSON.stringify([cfg.triggers ?? cfg.trigger, cfg.conditions ?? cfg.condition, cfg.actions ?? cfg.action, cfg.use_blueprint]);

async function automations(cmd, args) {
  const call = await connect();
  try {
    const reg = await registries(call);
    if (cmd === "health" || cmd === "report") return await doctor(call, reg, cmd, args);
    if (cmd === "context") {
      const state = loadState();
      const examples = [];
      for (const a of reg.automations.filter((x) => x.id && state.processed[x.id])) {
        const cfg = await rest("GET", `config/automation/config/${a.id}`).catch(() => ({}));
        examples.push({ name: a.name, description: cfg.description || "", category: a.category, labels: a.labels });
      }
      return out({
        categories: reg.categories.map((c) => c.name),
        labels: reg.labels.map((l) => ({ name: l.name, description: l.description || "" })),
        skip_label: TEST_LABEL,
        label_colors: LABEL_COLORS,
        limits: { new_categories: MAX_NEW, new_labels: MAX_NEW },
        examples,
      });
    }
    if (cmd === "pending") {
      const list = await pendingList(call, reg);
      if (args.includes("--count")) return console.log(list.length);
      const res = [];
      for (const a of list) {
        const cfg = await rest("GET", `config/automation/config/${a.id}`);
        let blueprint;
        if (cfg.use_blueprint) {
          blueprint = await call({
            type: "blueprint/substitute",
            domain: "automation",
            path: cfg.use_blueprint.path,
            input: cfg.use_blueprint.input || {},
          })
            .then((r) => ({ path: cfg.use_blueprint.path, resolved: r.substituted_config }))
            .catch((e) => ({ path: cfg.use_blueprint.path, error: e.message }));
        }
        res.push({ ...a, description: cfg.description || "", config: cfg, blueprint, entities: entityRefs(blueprint?.resolved || cfg, reg) });
      }
      return out(res);
    }
    if (cmd === "init") {
      const state = loadState();
      let n = 0;
      for (const a of reg.automations) {
        if (!a.id || state.processed[a.id]) continue;
        state.processed[a.id] = { at: new Date().toISOString(), name: a.name, by: "init" };
        n++;
      }
      saveState(state);
      return out({ marked: n, file: STATE_FILE });
    }
    if (cmd === "apply") {
      // Plan als Datei (der Agent schreibt sie mit seinem Write-Werkzeug), mit "-" von stdin
      const raw = args[0] === "-" ? await readStdin() : existsSync(PLAN_FILE) ? readFileSync(PLAN_FILE, "utf8") : "";
      if (!raw.trim()) return out({ ok: false, errors: [`Kein Plan: ${PLAN_FILE} fehlt oder ist leer`] });
      let plan;
      try {
        plan = JSON.parse(raw);
      } catch (e) {
        return out({ ok: false, errors: [`plan.json ist kein gültiges JSON: ${e.message}`] });
      }
      const items = Array.isArray(plan) ? plan : plan.items;
      const res = await apply(call, reg, items, plan.create || {});
      if (res.ok && !DRY) rmSync(PLAN_FILE, { force: true });
      return out(res);
    }
    throw new Error(`Unbekannter Befehl: automations ${cmd}`);
  } finally {
    call.close();
  }
}

async function apply(call, reg, items, create) {
  const pending = new Map((await pendingList(call, reg)).map((a) => [a.entity_id, a]));
  const catId = Object.fromEntries(reg.categories.map((c) => [c.name.toLowerCase(), c.category_id]));
  const labelId = Object.fromEntries(reg.labels.map((l) => [l.name.toLowerCase(), l.label_id]));
  // Erst alles prüfen, dann ändern – ein fehlerhafter Plan ändert nichts
  const errors = [];

  // Neue Kategorien/Labels: gibt es den Namen in HA schon (nur an keiner Automation), wird er wiederverwendet
  const newCats = (create.categories || []).map((c) => (typeof c === "string" ? { name: c } : c));
  const newLabels = (create.labels || []).map((l) => (typeof l === "string" ? { name: l } : l));
  if (newCats.length > MAX_NEW) errors.push(`Höchstens ${MAX_NEW} neue Kategorien pro Lauf`);
  if (newLabels.length > MAX_NEW) errors.push(`Höchstens ${MAX_NEW} neue Labels pro Lauf`);
  const toCreate = { categories: [], labels: [], reused: [] };
  for (const c of newCats) {
    const n = c.name?.trim();
    if (!n) {
      errors.push("Neue Kategorie ohne Namen");
      continue;
    }
    if (catId[n.toLowerCase()]) {
      errors.push(`Kategorie „${n}“ gibt es schon – einfach verwenden`);
      continue;
    }
    if (n.toLowerCase() === TEST_LABEL) {
      errors.push(`„${n}“ ist reserviert`);
      continue;
    }
    const existing = reg.allCategories.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      catId[n.toLowerCase()] = existing.category_id;
      toCreate.reused.push(`Kategorie ${existing.name}`);
      continue;
    }
    if (c.icon && !/^mdi:[a-z0-9-]+$/.test(c.icon)) errors.push(`Kategorie „${n}“: icon muss wie mdi:name aussehen`);
    catId[n.toLowerCase()] = `new:${n}`;
    toCreate.categories.push({ name: n, icon: c.icon || null });
  }
  for (const l of newLabels) {
    const n = l.name?.trim();
    if (!n) {
      errors.push("Neues Label ohne Namen");
      continue;
    }
    if (labelId[n.toLowerCase()]) {
      errors.push(`Label „${n}“ gibt es schon – einfach verwenden`);
      continue;
    }
    if (n.toLowerCase() === TEST_LABEL) {
      errors.push(`„${n}“ ist reserviert`);
      continue;
    }
    const existing = reg.allLabels.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      labelId[n.toLowerCase()] = existing.label_id;
      toCreate.reused.push(`Label ${existing.name}`);
      continue;
    }
    if (!l.description?.trim()) errors.push(`Label „${n}“: description fehlt (wofür steht es?)`);
    if (l.icon && !/^mdi:[a-z0-9-]+$/.test(l.icon)) errors.push(`Label „${n}“: icon muss wie mdi:name aussehen`);
    if (l.color && !LABEL_COLORS.includes(l.color)) errors.push(`Label „${n}“: Farbe „${l.color}“ unbekannt`);
    labelId[n.toLowerCase()] = `new:${n}`;
    toCreate.labels.push({ name: n, icon: l.icon || null, color: l.color || null, description: l.description?.trim() || "" });
  }

  for (const it of items) {
    if (!pending.has(it.entity_id)) errors.push(`${it.entity_id}: nicht in der Liste der unbearbeiteten Automationen`);
    if (it.skip) continue;
    if (!it.name?.trim()) errors.push(`${it.entity_id}: name fehlt`);
    if (!it.description?.trim()) errors.push(`${it.entity_id}: description fehlt`);
    if (it.category && !catId[it.category.toLowerCase()]) errors.push(`${it.entity_id}: Kategorie „${it.category}“ gibt es nicht`);
    for (const l of it.labels || []) if (!labelId[l.toLowerCase()]) errors.push(`${it.entity_id}: Label „${l}“ gibt es nicht`);
  }
  if (errors.length) return { ok: false, errors, hint: "Vorhandene Kategorien und Labels verwenden; neue nur über create anlegen (automations context)." };
  const used = new Set(items.flatMap((it) => [it.category, ...(it.labels || [])]).filter(Boolean).map((x) => x.toLowerCase()));
  for (const c of toCreate.categories) if (!used.has(c.name.toLowerCase())) return { ok: false, errors: [`Neue Kategorie „${c.name}“ wird von keiner Automation benutzt`] };
  for (const l of toCreate.labels) if (!used.has(l.name.toLowerCase())) return { ok: false, errors: [`Neues Label „${l.name}“ wird von keiner Automation benutzt`] };

  if (!DRY) {
    for (const c of toCreate.categories) {
      const r = await call({ type: "config/category_registry/create", scope: "automation", name: c.name, icon: c.icon });
      catId[c.name.toLowerCase()] = r.category_id;
    }
    for (const l of toCreate.labels) {
      const r = await call({ type: "config/label_registry/create", name: l.name, icon: l.icon, color: l.color, description: l.description });
      labelId[l.name.toLowerCase()] = r.label_id;
    }
  }

  const state = loadState();
  const backup = {};
  const done = [];
  for (const it of items) {
    const a = pending.get(it.entity_id);
    if (it.skip) {
      done.push({ entity_id: it.entity_id, skipped: it.reason || true });
      if (!DRY) state.processed[a.id] = { at: new Date().toISOString(), name: a.name, by: "agent", skipped: it.reason || true };
      continue;
    }
    const cfg = await rest("GET", `config/automation/config/${a.id}`);
    const entry = reg.ent[a.entity_id] || {};
    backup[a.entity_id] = { config: structuredClone(cfg), registry: { name: entry.name, labels: entry.labels, categories: entry.categories } };
    const before = contentOf(cfg);
    cfg.alias = it.name.trim();
    cfg.description = it.description.trim();
    if (contentOf(cfg) !== before) throw new Error("Interner Fehler: Inhalt würde sich ändern");
    const labels = [...new Set([...(entry.labels || []), ...(it.labels || []).map((l) => labelId[l.toLowerCase()])])];
    const update = { type: "config/entity_registry/update", entity_id: a.entity_id, labels };
    if (it.category) update.categories = { ...(entry.categories || {}), automation: catId[it.category.toLowerCase()] };
    if (entry.name) update.name = null; // Namensüberschreibung entfernen, damit der neue Name sichtbar ist
    const change = { entity_id: a.entity_id, from: a.name, name: cfg.alias, category: it.category || a.category, labels: it.labels || [] };
    if (!DRY) {
      await rest("POST", `config/automation/config/${a.id}`, cfg);
      const check = await rest("GET", `config/automation/config/${a.id}`);
      if (contentOf(check) !== before) throw new Error(`${a.entity_id}: Inhalt hat sich beim Speichern verändert – abgebrochen`);
      await call(update);
      state.processed[a.id] = { at: new Date().toISOString(), name: cfg.alias, by: "agent" };
    }
    done.push(change);
  }
  const created = [...toCreate.categories.map((c) => `Kategorie ${c.name}`), ...toCreate.labels.map((l) => `Label ${l.name}`)];
  if (DRY) return { ok: true, dry: true, created, reused: toCreate.reused, done };

  mkdirSync(join(DATA, "backups"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(DATA, "backups", `${stamp}.json`), JSON.stringify(backup, null, 1));
  saveState(state);
  const check = await rest("POST", "config/core/check_config");

  const changed = done.filter((d) => !d.skipped);
  if (changed.length) {
    const lines = changed.map((d) => `• ${d.name} → ${d.category || "ohne Kategorie"}${d.labels.length ? ` (${d.labels.join(", ")})` : ""}`);
    if (created.length) lines.push(`Neu angelegt: ${created.join(", ")}`);
    await notify(call, `🤖 ${changed.length} Automation${changed.length === 1 ? "" : "en"} sortiert`, lines.join("\n"));
  }
  return { ok: true, created, reused: toCreate.reused, done, check: check.result, backup: `backups/${stamp}.json` };
}

async function main() {
  const [cmd, sub, ...rest_] = process.argv.slice(2);
  if (cmd === "automations") return automations(sub, rest_);
  if (cmd === "logs" || cmd === "energy" || cmd === "fixes") {
    const call = await connect();
    try {
      return await (cmd === "logs" ? logs(call, sub, rest_) : cmd === "fixes" ? fixes(call, sub, rest_) : energy(call, sub, rest_));
    } finally {
      call.close();
    }
  }
  if (cmd === "states") {
    const call = await connect();
    const states = await call({ type: "get_states" });
    call.close();
    return out(states.filter((s) => !sub || s.entity_id.startsWith(sub)).map((s) => ({ entity_id: s.entity_id, state: s.state, name: s.attributes.friendly_name })));
  }
  if (cmd === "notify") {
    const call = await connect();
    await notify(call, sub, rest_.join(" "));
    call.close();
    return out({ ok: true });
  }
  console.error("Befehle: states | notify | automations context|pending|apply|init|health|report | logs pending|harmless|report | energy week|report | fixes pending|apply|reject|finish");
  process.exit(2);
}

main().catch((e) => {
  console.error(`Fehler: ${e.message}`);
  process.exit(1);
});
