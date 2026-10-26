# Rezept-Agent

Ein Docker-Container, in dem KI-Agenten (Claude Code) Rezepte in [Tandoor](https://tandoor.dev) pflegen. Entstanden aus einem Agenten-Projekt für Home Assistant, die Git-Historie ist erhalten. Home Assistant ist hier nur optional.

| Agent / Dienst | Zeit | Was er macht |
|---|---|---|
| `rezepte` | über Slack | Legt aus Links und Fotos im Rezept-Kanal Entwürfe in Tandoor an und überarbeitet sie auf Wunsch. Startet die Slack-Brücke, nicht der Zeitplan. |
| `rezept-qualitaet` | 12:00 | Prüft Rezepte ohne Status-Schlagwort gegen den Standard (`agents/rezept-standard.md`) und schickt Verbesserungen als Vorschlag in Slack (5 pro Lauf, höchstens 10 offen). |
| `rezept-statistik` | 19:00 | Schickt täglich die Zahlen (gesamt, geprüft, offen) in den Slack-Kanal. Kein Agent, das macht die Slack-Brücke. |

Fehlen Bilder, erzeugt der Container KI-Fotos über Cloudflare Workers AI (kostenlos) oder optional OpenAI.

## Einrichten mit Portainer: Ordner auf dem Host

`portainer/stack-host.yml` legt alles in **einen Ordner auf dem Docker-Host** (Standard `/home/sebastian/docker/rezepte`, änderbar mit `AGENTS_HOST_DIR`):

```
/home/sebastian/docker/rezepte/
  zeitplan.conf   wann welcher Agent läuft (Änderungen gelten ohne Neustart)
  geheim.env      Zugangsdaten (Vorlage: geheim.env.example)
  agents/         ein Ordner je Agent (agent.json + prompt.md)
  app/            Programm
  daten/          Entwürfe, Logs je Agent
  npm/            Claude Code (installiert sich beim ersten Start selbst)
```

Die Zeitplan-Oberfläche läuft auf Port 8080 (`WEB_PORT`, Passwort über `WEB_PASSWORT`).

## Zugangsdaten

In `geheim.env` (siehe `geheim.env.example`) bzw. als Umgebungsvariablen:

- **CLAUDE_CODE_OAUTH_TOKEN:** auf einem Rechner mit Claude Code `claude setup-token` ausführen.
- **TANDOOR_URL**, **TANDOOR_TOKEN:** Tandoor → Einstellungen → API, Scope „read write“.
- **SLACK_BOT_TOKEN**, **SLACK_APP_TOKEN**, **SLACK_CHANNEL:** Slack-App „Rezept-Helfer“ aus `slack-app-manifest.yml` anlegen.
- **CF_ACCOUNT_ID**, **CF_AI_TOKEN:** für KI-Fotos (optional).
- **HA_URL**, **HA_TOKEN**, **NOTIFY_SERVICE:** optional. Mit Home Assistant gibt es einen Push bei fehlgeschlagenen Läufen über einen HA-Benachrichtigungsdienst (z. B. `notify.mobile_app_handy`, mehrere kommagetrennt) und ein Dashboard mit Status und Knöpfen **Jetzt starten**. Es heißt `dashboard-rezepte` (`CONTROL_DASHBOARD`), damit es kein anderes Dashboard überschreibt. Ohne `HA_TOKEN` läuft alles andere normal.

## Einrichten mit Docker Compose

```sh
cp .env.example .env    # ausfüllen
docker compose up -d --build
docker compose logs -f
```

## Bedienen

```sh
docker compose exec agents node /app/scheduler.mjs list
docker compose exec agents node /app/scheduler.mjs run rezept-qualitaet
```

## Lizenz

MIT · Autor: SebastianInTheWild
