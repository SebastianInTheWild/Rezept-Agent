// Slack: Web-API (Nachrichten, Knöpfe, Dateien) und Socket Mode (Ereignisse ohne Adresse von außen).
// Autor: SebastianInTheWild · MIT-Lizenz

const API = "https://slack.com/api/";
export const slackReady = () => Boolean(process.env.SLACK_BOT_TOKEN);

export async function slack(method, body = {}, token = process.env.SLACK_BOT_TOKEN) {
  if (!token) throw new Error("SLACK_BOT_TOKEN fehlt (Umgebungsvariable)");
  const r = await fetch(API + method, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}${j.response_metadata?.messages ? " " + j.response_metadata.messages.join("; ") : ""}`);
  return j;
}

export const post = (channel, text, blocks, thread_ts) => slack("chat.postMessage", { channel, text, blocks, thread_ts, unfurl_links: false, unfurl_media: false });
export const update = (channel, ts, text, blocks) => slack("chat.update", { channel, ts, text, blocks });
export const react = (channel, timestamp, name) => slack("reactions.add", { channel, timestamp, name }).catch(() => {});
export const unreact = (channel, timestamp, name) => slack("reactions.remove", { channel, timestamp, name }).catch(() => {});

// Datei aus Slack laden (url_private braucht den Bot-Token)
export async function download(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
  if (!r.ok) throw new Error(`Download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Slack schreibt Links als <https://…|Text> oder <https://…>
export const linksIn = (text = "") => [...text.matchAll(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
export const plain = (text = "") => text.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1").replace(/<@[A-Z0-9]+>/g, "").trim();
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const link = (url, text) => `<${url}|${esc(text).replace(/\|/g, "¦")}>`;
export { esc };

// Socket Mode: hält die Verbindung, quittiert jede Nachricht und meldet Ereignisse und Knopfdrücke.
export function socket({ onEvent, onAction, log = console.log }) {
  let stopped = false;
  let retry = 1;
  const connect = async () => {
    let url;
    try {
      url = (await slack("apps.connections.open", {}, process.env.SLACK_APP_TOKEN)).url;
    } catch (e) {
      log(`Slack-Verbindung fehlgeschlagen: ${e.message} – neuer Versuch in ${retry * 10} s`);
      return setTimeout(connect, Math.min(retry++, 30) * 10_000);
    }
    const ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 1;
      log("Slack verbunden");
    };
    ws.onmessage = async (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.envelope_id) ws.send(JSON.stringify({ envelope_id: m.envelope_id }));
      try {
        if (m.type === "events_api") await onEvent(m.payload.event);
        else if (m.type === "interactive") await onAction(m.payload);
        else if (m.type === "disconnect") ws.close();
      } catch (e) {
        log(`Fehler bei Slack-Ereignis: ${e.stack || e}`);
      }
    };
    ws.onclose = () => {
      if (!stopped) setTimeout(connect, 2_000);
    };
    ws.onerror = () => {};
  };
  connect();
  return { stop: () => (stopped = true) };
}
