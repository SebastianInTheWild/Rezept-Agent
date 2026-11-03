#!/bin/sh
# Start im Container: Claude Code bei Bedarf installieren (bleibt in /data/npm), dann den Zeitplan starten.
set -e
export NPM_CONFIG_PREFIX=/data/npm
# Claude Code aus dem Image hat Vorrang; /data/npm nur, wenn es dort fehlt oder CLAUDE_UPDATE=1 (Ordner-Variante)
export PATH="$PATH:/data/npm/bin"
if ! command -v claude >/dev/null 2>&1 || [ "${CLAUDE_UPDATE:-0}" = "1" ]; then
  echo "Claude Code wird installiert …"
  npm install -g @anthropic-ai/claude-code --no-fund --no-audit
fi
echo "Rezept-Agent Version ${APP_RELEASE:-dev} (${APP_VERSION:-dev})"
echo "Claude Code $(claude --version 2>/dev/null || echo '?')"
# Startzeit des Containers: läuft bei jedem Containerstart (auch nach Neustart), nicht bei einem Neustart nur der Slack-Brücke.
# Die Brücke meldet daran einmal pro Containerstart in Slack, dass der Agent wieder läuft.
date +%s > /tmp/rezepte-containerstart 2>/dev/null || true
[ -n "$CLAUDE_CODE_OAUTH_TOKEN$ANTHROPIC_API_KEY" ] || grep -q CLAUDE_CODE_OAUTH_TOKEN "${DATA_DIR:-/data}/umgebung.json" 2>/dev/null || echo "WARNUNG: CLAUDE_CODE_OAUTH_TOKEN fehlt – auf einem PC mit Claude Code „claude setup-token“ ausführen und in der Weboberfläche unter Einstellungen eintragen"
# Slack-Brücke läuft immer neben dem Zeitplan (die Tokens können auch aus der Weboberfläche kommen – fehlen sie, wartet sie);
# startet sich bei Fehlern neu
(while true; do
  node "$(dirname "$0")/slack-bridge.mjs" || true
  echo "Slack-Brücke beendet – Neustart in 15 s"
  sleep 15
done) &
exec node "$(dirname "$0")/scheduler.mjs"
