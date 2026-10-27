# Rezept-Agent

Ein Docker-Container, in dem KI-Agenten (Claude Code) Rezepte in [Tandoor](https://tandoor.dev) pflegen. Die Steuerung läuft über Slack und eine eigene Weboberfläche.

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
  agents/         ein Ordner je Agent (agent.json + prompt.md)
  app/            Programm
  daten/          Entwürfe, Logs je Agent
  npm/            Claude Code (installiert sich beim ersten Start selbst)
```

Neue oder geänderte Agenten pushst du einfach nach GitHub (`agents/<name>/agent.json` + `prompt.md`, Vorlage `agents/_vorlage`): Der Container holt `agents/` alle 10 Minuten (`AGENTS_SYNC`, „aus“ = nie) und erkennt sie ohne Neustart. Änderungen direkt auf dem Host in Agenten aus dem Repo werden dabei überschrieben.

Die Weboberfläche läuft auf Port 8080 (`WEB_PORT`, Passwort über `WEB_PASSWORT`). Dort stellst du die Zeiten ein, siehst Status und letzten Lauf und startest Agenten mit **Jetzt starten** sofort. Die Rezept-Statistik schickst du mit **Jetzt senden** sofort in den Slack-Kanal. Bei „Rezept-Qualität“ stellst du ein, wie viele Rezepte pro Tag geprüft werden (Standard 5, gespeichert in `daten/rezepte/einstellungen.json`).

Slash-Befehle in Slack: `/statistik` zeigt die Rezept-Statistik, `/neuronen` die heute noch freien Cloudflare-Neuronen (Antwort nur für dich sichtbar).

## Zugangsdaten

Als Umgebungsvariablen, in Portainer unter „Environment variables“ (Vorlage: `.env.example`):

- **CLAUDE_CODE_OAUTH_TOKEN:** auf einem Rechner mit Claude Code `claude setup-token` ausführen.
- **TANDOOR_URL**, **TANDOOR_TOKEN:** Tandoor → Einstellungen → API, Scope „read write“.
- **SLACK_BOT_TOKEN**, **SLACK_APP_TOKEN**, **SLACK_CHANNEL:** Slack-App „Rezept-Helfer“ aus `slack-app-manifest.yml` anlegen. In den Kanal kommen auch Meldungen über fehlgeschlagene Läufe.
- **CF_ACCOUNT_ID**, **CF_AI_TOKEN:** für KI-Fotos (optional). Damit nach jedem Foto und mit `/neuronen` in Slack die freien Neuronen angezeigt werden, braucht der Token zusätzlich die Berechtigung „Account Analytics: Read“.

## Einrichten mit Docker Compose

```sh
cp .env.example .env    # ausfüllen
docker compose up -d --build
docker compose logs -f
```

## Bedienen

```sh
docker compose exec rezept-agent node /app/scheduler.mjs list
docker compose exec rezept-agent node /app/scheduler.mjs run rezept-qualitaet
```

## Lizenz

MIT · Autor: SebastianInTheWild
