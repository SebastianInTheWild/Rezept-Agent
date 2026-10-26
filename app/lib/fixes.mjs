// Empfehlungen des Automations-Doktors: Der Doktor beschreibt je Befund eine konkrete Änderung (fix.ops),
// du gibst sie im Dashboard per Knopf frei (Eintrag in der To-do-Liste „Doktor-Freigaben“), der Agent
// „Doktor-Umsetzer“ prüft sie und wendet genau diese Änderung an. Der Umsetzer kann die Änderung nicht
// umformulieren: apply nimmt nur die ID, die Schritte stehen fest in fixes.json.
// Autor: SebastianInTheWild · MIT-Lizenz

import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentData, loadJson, out, saveJson } from "./report.mjs";
import { notify, rest } from "./ha.mjs";
import { refreshDashboard } from "./doctor.mjs";

export const TODO_NAME = process.env.DOCTOR_TODO_NAME || "Doktor-Freigaben";
export const doctorData = () => process.env.DOCTOR_DATA || join(process.env.DATA_DIR || "/data", "automations-doktor");
const fixesFile = () => join(doctorData(), "fixes.json");
const runFile = () => join(agentData(), "run.json");
const DRY = () => process.env.DRY === "1";

export const loadFixes = () => loadJson(fixesFile(), { fixes: {} });
export const saveFixes = (f) => saveJson(fixesFile(), f);

// ---------- Schritte (ops) ----------
// replace {from, to}: Entität überall austauschen · remove {path}: Teil entfernen (JSON-Pointer, z. B. /actions/2)
// set {path, value}: Wert setzen (z. B. /mode = "restart") · disable {}: Automation ausschalten
export const OPS = ["replace", "remove", "set", "disable"];

const stable = (v) =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
  : JSON.stringify(v);
export const configHash = (cfg) => createHash("sha256").update(stable(cfg)).digest("hex").slice(0, 16);
export const fixId = (entityId, ops) => createHash("sha256").update(entityId + stable(ops)).digest("hex").slice(0, 8);

const tokens = (path) => {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`Pfad „${path}“ muss mit / beginnen (z. B. /actions/2)`);
  return path.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
};
function parentOf(root, path) {
  const t = tokens(path);
  let node = root;
  for (const k of t.slice(0, -1)) {
    node = Array.isArray(node) ? node[Number(k)] : node?.[k];
    if (node === undefined || node === null || typeof node !== "object") throw new Error(`Pfad ${path} gibt es nicht`);
  }
  return { node, key: t.at(-1) };
}

// Kurzbeschreibung eines Konfigurationsteils (für „entfernen“)
const describe = (v) =>
  v && typeof v === "object"
    ? v.alias || v.action || v.service || v.trigger || v.platform || v.condition ||
      (v.delay ? "Verzögerung" : v.wait_template || v.wait_for_trigger ? "Warten" : v.choose ? "Auswahl (choose)" : v.if ? "Wenn-dann"
        : v.variables ? "Variablen" : v.repeat ? "Wiederholung" : v.parallel ? "Parallel" : JSON.stringify(v).slice(0, 60))
    : JSON.stringify(v);

/** Wendet die Schritte auf eine Kopie an. Ergebnis: {config, disable, changes[], errors[]}. */
export function applyOps(cfg, ops, states = {}) {
  const config = structuredClone(cfg);
  const changes = [];
  const errors = [];
  let disable = false;
  if (!Array.isArray(ops) || !ops.length) return { config, disable, changes, errors: ["ops fehlt (mindestens ein Schritt)"] };
  for (const op of ops) {
    try {
      if (!OPS.includes(op?.op)) throw new Error(`Schritt „${op?.op}“ unbekannt (erlaubt: ${OPS.join(", ")})`);
      if (op.op === "disable") {
        disable = true;
        changes.push("Automation ausschalten");
      } else if (op.op === "replace") {
        const re = /^[a-z_]+\.[a-z0-9_]+$/;
        if (!re.test(op.from || "") || !re.test(op.to || "")) throw new Error("replace braucht from und to als entity_id");
        if (!states[op.to]) throw new Error(`replace: ${op.to} gibt es nicht`);
        let n = 0;
        const word = new RegExp(`(?<![\\w.])${op.from.replace(/\./g, "\\.")}(?![\\w])`, "g");
        const walk = (node) => {
          if (Array.isArray(node)) node.forEach((x, i) => (typeof x === "string" ? (node[i] = swap(x)) : walk(x)));
          else if (node && typeof node === "object") for (const k of Object.keys(node)) typeof node[k] === "string" ? (node[k] = swap(node[k])) : walk(node[k]);
        };
        const swap = (s) => s.replace(word, () => (n++, op.to));
        walk(config);
        if (!n) throw new Error(`replace: ${op.from} kommt in der Automation nicht vor`);
        changes.push(`${op.from} → ${op.to} (${n}×)`);
      } else if (op.op === "remove") {
        const { node, key } = parentOf(config, op.path);
        if (Array.isArray(node)) {
          const i = Number(key);
          if (!Number.isInteger(i) || i < 0 || i >= node.length) throw new Error(`Pfad ${op.path} gibt es nicht`);
          changes.push(`entfernen: ${op.path} (${describe(node[i])})`);
          node.splice(i, 1);
        } else {
          if (!(key in node)) throw new Error(`Pfad ${op.path} gibt es nicht`);
          changes.push(`entfernen: ${op.path} (${describe(node[key])})`);
          delete node[key];
        }
      } else if (op.op === "set") {
        if (!("value" in op)) throw new Error("set braucht value");
        const { node, key } = parentOf(config, op.path);
        changes.push(`${op.path} = ${JSON.stringify(op.value)}`);
        if (Array.isArray(node)) node[Number(key)] = op.value;
        else node[key] = op.value;
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!errors.length && !disable && stable(config) === stable(cfg)) errors.push("Die Schritte ändern nichts");
  return { config, disable, changes, errors };
}

// ---------- To-do-Liste „Doktor-Freigaben“ ----------

/** entity_id der Freigabe-Liste; legt sie bei Bedarf an (Integration „Lokale To-do-Liste“). */
export async function ensureTodo(call) {
  const find = async () => (await call({ type: "get_states" })).find((s) => s.entity_id.startsWith("todo.") && s.attributes.friendly_name === TODO_NAME)?.entity_id;
  let id = process.env.DOCTOR_TODO || (await find());
  if (id || DRY()) return id || "todo.doktor_freigaben";
  const flow = await rest("POST", "config/config_entries/flow", { handler: "local_todo" });
  await rest("POST", `config/config_entries/flow/${flow.flow_id}`, { todo_list_name: TODO_NAME });
  for (let i = 0; i < 10 && !id; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    id = await find();
  }
  if (!id) throw new Error(`To-do-Liste „${TODO_NAME}“ ließ sich nicht anlegen`);
  return id;
}

const ID_RE = /\[([0-9a-f]{8})\]\s*$/;
export const itemText = (fix) => `${fix.name}: ${fix.summary} [${fix.fid}]`;

/** Offene Freigaben: [{uid, summary, fid}] */
export async function approvals(call, todo) {
  const r = await call({ type: "call_service", domain: "todo", service: "get_items", target: { entity_id: todo }, service_data: { status: ["needs_action"] }, return_response: true });
  const items = r?.response?.[todo]?.items || [];
  return items.map((it) => ({ ...it, fid: ID_RE.exec(it.summary || "")?.[1] })).filter((it) => it.fid);
}

async function closeItems(call, todo, items, description) {
  if (DRY()) return;
  for (const it of items) {
    await call({ type: "call_service", domain: "todo", service: "update_item", target: { entity_id: todo }, service_data: { item: it.uid, status: "completed", description } });
  }
}

const now = () => new Date().toLocaleString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
const record = (entry) => {
  const r = loadJson(runFile(), { done: [] });
  r.done.push(entry);
  saveJson(runFile(), r);
};

// ---------- Befehle des Umsetzers ----------

export async function fixes(call, cmd, args) {
  const todo = await ensureTodo(call);
  const store = loadFixes();
  const list = await approvals(call, todo);
  const byFid = {};
  for (const it of list) (byFid[it.fid] ||= []).push(it);

  if (cmd === "pending") {
    // Freigaben ohne offene Empfehlung (unbekannt oder schon erledigt) gleich abschließen
    const stale = list.filter((it) => store.fixes[it.fid]?.status !== "offen");
    await closeItems(call, todo, stale, "Nichts zu tun: Empfehlung unbekannt oder schon erledigt.");
    const fids = Object.keys(byFid).filter((fid) => store.fixes[fid]?.status === "offen");
    // Neue Freigaben sofort im Dashboard zeigen („freigegeben – wird geprüft“), ohne Claude zu starten
    const sig = fids.sort().join(",");
    if (sig !== (store.approved_sig || "")) {
      store.approved_sig = sig;
      saveFixes(store);
      await refreshDashboard(call).catch((e) => console.error(`Dashboard: ${e.message}`));
    }
    if (args.includes("--count")) return console.log(fids.length);
    const res = [];
    for (const fid of fids) {
      const f = store.fixes[fid];
      const current = await rest("GET", `config/automation/config/${f.automation_id}`).catch(() => null);
      const states = Object.fromEntries((await call({ type: "get_states" })).map((s) => [s.entity_id, s]));
      const unchanged = current ? configHash(current) === f.hash : false;
      const preview = current ? applyOps(current, f.ops, states) : { errors: ["Automation nicht mehr vorhanden"] };
      res.push({
        fid, entity_id: f.entity_id, name: f.name, summary: f.summary, problem: f.problem, ops: f.ops,
        checks: { config_unchanged: unchanged, errors: preview.errors, changes: preview.changes, automation_state: states[f.entity_id]?.state ?? "fehlt" },
        config_now: current, config_after: preview.errors?.length ? undefined : preview.config,
        entities: Object.fromEntries(f.ops.filter((o) => o.op === "replace").flatMap((o) => [o.from, o.to]).map((id) => [id, states[id] ? { state: states[id].state, name: states[id].attributes.friendly_name } : "fehlt"])),
      });
    }
    return out({ todo, pending: res });
  }

  if (cmd === "apply" || cmd === "reject") {
    const fid = args[0];
    const f = store.fixes[fid];
    if (!f) return out({ ok: false, errors: [`Empfehlung ${fid} unbekannt`] });
    if (f.status !== "offen") return out({ ok: false, errors: [`Empfehlung ${fid} ist schon ${f.status}`] });
    if (!byFid[fid]) return out({ ok: false, errors: [`Empfehlung ${fid} ist nicht freigegeben`] });
    const finish = async (status, note, extra = {}) => {
      if (!DRY()) {
        Object.assign(f, { status, note, at: new Date().toISOString(), ...extra });
        saveFixes(store);
        await closeItems(call, todo, byFid[fid], `${status === "umgesetzt" ? "✅" : "❌"} ${status} am ${now()}${note ? `: ${note}` : ""}`);
        record({ fid, name: f.name, summary: f.summary, status, note });
        await refreshDashboard(call).catch((e) => console.error(`Dashboard: ${e.message}`));
      }
      return out({ ok: status === "umgesetzt", fid, status, note, dry: DRY(), ...extra });
    };

    if (cmd === "reject") {
      const reason = args.slice(1).join(" ").trim();
      if (!reason) return out({ ok: false, errors: ["Grund fehlt: reject <id> \"<grund>\""] });
      return finish("abgelehnt", reason);
    }

    const current = await rest("GET", `config/automation/config/${f.automation_id}`).catch(() => null);
    if (!current) return finish("abgelehnt", "Die Automation gibt es nicht mehr.");
    if (configHash(current) !== f.hash) return finish("abgelehnt", "Die Automation wurde seit dem Befund geändert – der Doktor prüft sie beim nächsten Lauf neu.");
    const states = Object.fromEntries((await call({ type: "get_states" })).map((s) => [s.entity_id, s]));
    const res = applyOps(current, f.ops, states);
    if (res.errors.length) return finish("abgelehnt", `Nicht anwendbar: ${res.errors.join("; ")}`);
    if (DRY()) return out({ ok: true, dry: true, fid, changes: res.changes, config_after: res.config });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `backups/${stamp}-${fid}.json`;
    saveJson(join(doctorData(), backup), { fid, entity_id: f.entity_id, automation_id: f.automation_id, state: states[f.entity_id]?.state, config: current });
    const configChanged = stable(res.config) !== stable(current);
    try {
      if (configChanged) await rest("POST", `config/automation/config/${f.automation_id}`, res.config);
      if (res.disable) await rest("POST", "services/automation/turn_off", { entity_id: f.entity_id });
      await new Promise((r) => setTimeout(r, 3000));
      const after = await rest("GET", `states/${f.entity_id}`).catch(() => null);
      if (!after || after.state === "unavailable") throw new Error("Automation ist danach nicht verfügbar");
    } catch (e) {
      // Zurück auf den alten Stand
      if (configChanged) await rest("POST", `config/automation/config/${f.automation_id}`, current).catch(() => {});
      return finish("fehlgeschlagen", `${e.message} – alter Stand wiederhergestellt`, { backup });
    }
    return finish("umgesetzt", res.changes.join("; "), { backup });
  }

  if (cmd === "finish") {
    const r = loadJson(runFile(), { done: [] });
    if (r.done.length && !DRY()) {
      const ok = r.done.filter((d) => d.status === "umgesetzt").length;
      const lines = r.done.map((d) => `${d.status === "umgesetzt" ? "✅" : "❌"} ${d.name}: ${d.status === "umgesetzt" ? d.summary : `${d.status} – ${d.note}`}`);
      await notify(call, `🩺 ${ok} von ${r.done.length} Empfehlung${r.done.length === 1 ? "" : "en"} umgesetzt`, lines.join("\n"));
      saveJson(runFile(), { done: [] });
    }
    return out({ ok: true, reported: r.done.length });
  }
  throw new Error(`Unbekannter Befehl: fixes ${cmd}`);
}
