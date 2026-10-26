// Baut portainer/stack.yml: ein Compose-Stack ohne eigenes Image, die App- und Agenten-Dateien stecken als
// configs direkt im Stack. So lässt er sich in Portainer (Stacks → Web editor) ohne Build anlegen.
// Aufruf: node tools/build-stack.mjs
// Autor: SebastianInTheWild · MIT-Lizenz

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["app/ha.mjs", "/app/ha.mjs"],
  ["app/lib/ha.mjs", "/app/lib/ha.mjs"],
  ["app/run-agent.mjs", "/app/run-agent.mjs"],
  ["app/scheduler.mjs", "/app/scheduler.mjs"],
  ["app/start.sh", "/app/start.sh"],
];
for (const d of readdirSync(join(ROOT, "agents"), { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith("_")) continue;
  for (const f of readdirSync(join(ROOT, "agents", d.name))) files.push([`agents/${d.name}/${f}`, `/agents/${d.name}/${f}`]);
}

const key = (p) => p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
// Compose ersetzt ${…} auch in configs → jedes $ verdoppeln
const block = (text) => text.replace(/\$/g, "$$$$").replace(/\r\n/g, "\n").split("\n").map((l) => (l ? `      ${l}` : "")).join("\n");

let yml = `# Unser Zuhause – Agenten (Portainer-Stack, erzeugt von tools/build-stack.mjs – nicht von Hand ändern)
# In Portainer unter „Environment variables“ setzen: HA_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
services:
  agents:
    image: node:22-bookworm-slim
    container_name: ha-unser-zuhause-agents
    restart: unless-stopped
    command: ["sh", "/app/start.sh"]
    environment:
      HA_URL: \${HA_URL:-http://192.168.11.252:8123}
      HA_TOKEN: \${HA_TOKEN:-}
      CLAUDE_CODE_OAUTH_TOKEN: \${CLAUDE_CODE_OAUTH_TOKEN:-}
      CLAUDE_MODEL: \${CLAUDE_MODEL:-}
      NOTIFY_PERSONS: \${NOTIFY_PERSONS:-person.sebastian}
      SKIP_LABEL: \${SKIP_LABEL:-Test}
      TZ: \${TZ:-Europe/Berlin}
      AGENTS_DIR: /agents
      DATA_DIR: /data
      DISABLE_AUTOUPDATER: "1"
    volumes:
      - agents-data:/data
    configs:
${files.map(([, target]) => `      - source: ${key(target)}\n        target: ${target}`).join("\n")}

volumes:
  agents-data:

configs:
${files.map(([src, target]) => `  ${key(target)}:\n    content: |\n${block(readFileSync(join(ROOT, src), "utf8").replace(/\n$/, ""))}`).join("\n")}
`;
mkdirSync(join(ROOT, "portainer"), { recursive: true });
writeFileSync(join(ROOT, "portainer", "stack.yml"), yml);
console.log(`portainer/stack.yml: ${files.length} Dateien, ${yml.length} Zeichen`);
