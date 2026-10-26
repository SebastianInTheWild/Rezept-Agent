// Kleiner Home-Assistant-Client (REST + WebSocket) ohne Abhängigkeiten. Braucht Node 22+ (globales WebSocket).
// Autor: SebastianInTheWild · MIT-Lizenz

const HA_URL = (process.env.HA_URL || "").replace(/\/$/, "");
const HA_TOKEN = process.env.HA_TOKEN || "";

export function assertConfig() {
  if (!HA_URL || !HA_TOKEN) throw new Error("HA_URL und HA_TOKEN müssen gesetzt sein");
}

export async function rest(method, path, body) {
  assertConfig();
  const res = await fetch(`${HA_URL}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Öffnet eine WebSocket-Verbindung und gibt eine Funktion call(msg) zurück. */
export async function connect() {
  assertConfig();
  const ws = new WebSocket(`${HA_URL.replace(/^http/, "ws")}/api/websocket`);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error(`Keine Verbindung zu ${HA_URL}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      else if (msg.type === "auth_ok") resolve();
      else if (msg.type === "auth_invalid") reject(new Error("HA_TOKEN ungültig"));
      else if (msg.type === "result" && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.success ? ok(msg.result) : fail(new Error(`${msg.error?.code}: ${msg.error?.message}`));
      }
    };
  });
  const call = (msg) =>
    new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, ...msg }));
    });
  call.close = () => ws.close();
  return call;
}

/** Push über HA-Benachrichtigungsdienste (NOTIFY_SERVICE, kommagetrennt, z. B. notify.mobile_app_handy). */
export async function notify(call, title, message) {
  const services = (process.env.NOTIFY_SERVICE || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of services) {
    const [domain, service] = s.includes(".") ? s.split(".", 2) : ["notify", s];
    await call({ type: "call_service", domain, service, service_data: { title, message } });
  }
}
