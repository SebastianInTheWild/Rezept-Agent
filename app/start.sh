#!/bin/sh
# Start im Container: Claude Code bei Bedarf installieren (bleibt in /data/npm), dann den Zeitplan starten.
set -e
export NPM_CONFIG_PREFIX=/data/npm
export PATH="/data/npm/bin:$PATH"
# Zugangsdaten aus /data/geheim.env (eine Zeile KEY=Wert); Werte aus Portainer haben Vorrang. Änderungen gelten nach Neustart.
SECRETS="${SECRETS_FILE:-/data/geheim.env}"
if [ -f "$SECRETS" ]; then
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in '' | \#* | *[!A-Za-z0-9_]* | [0-9]*) continue ;; esac
    v=$(printf '%s' "$v" | tr -d '\r')
    eval "cur=\${$k:-}"
    [ -n "$cur" ] || export "$k=$v"
  done < "$SECRETS"
  echo "Zugangsdaten aus $SECRETS geladen"
fi
if ! command -v claude >/dev/null 2>&1 || [ "${CLAUDE_UPDATE:-0}" = "1" ]; then
  echo "Claude Code wird installiert …"
  npm install -g @anthropic-ai/claude-code --no-fund --no-audit
fi
echo "Claude Code $(claude --version 2>/dev/null || echo '?')"
[ -n "$HA_TOKEN" ] || echo "WARNUNG: HA_TOKEN fehlt – in Portainer unter Environment variables setzen"
[ -n "$CLAUDE_CODE_OAUTH_TOKEN$ANTHROPIC_API_KEY" ] || echo "WARNUNG: CLAUDE_CODE_OAUTH_TOKEN fehlt – auf einem PC mit Claude Code „claude setup-token“ ausführen"
# Slack-Brücke (Rezepte) läuft neben dem Zeitplan, sobald beide Slack-Tokens gesetzt sind; startet sich bei Fehlern neu
if [ -n "$SLACK_APP_TOKEN" ] && [ -n "$SLACK_BOT_TOKEN" ]; then
  (while true; do
    node "$(dirname "$0")/slack-bridge.mjs" || true
    echo "Slack-Brücke beendet – Neustart in 15 s"
    sleep 15
  done) &
else
  echo "Slack-Brücke aus (SLACK_APP_TOKEN/SLACK_BOT_TOKEN in geheim.env fehlen)"
fi
exec node "$(dirname "$0")/scheduler.mjs"
