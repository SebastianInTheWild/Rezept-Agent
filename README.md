# Rezept-Agent

Ein Docker-Container, in dem KI-Agenten (Claude Code) Rezepte in [Tandoor](https://tandoor.dev) pflegen. Die Steuerung läuft über Slack und eine eigene Weboberfläche.

| Agent / Dienst | Zeit | Was er macht |
|---|---|---|
| `rezepte` | über Slack | Legt aus Links und Fotos im Rezept-Kanal Entwürfe in Tandoor an und überarbeitet sie auf Wunsch. Startet die Slack-Brücke, nicht der Zeitplan. |
| `rezept-qualitaet` | 12:00 | Prüft Rezepte ohne Status-Schlagwort gegen den Standard (`agents/rezept-standard.md`) und schickt Verbesserungen als Vorschlag in Slack (5 pro Lauf, höchstens 10 offen). |
| `rezept-statistik` | 19:00 | Schickt täglich die Zahlen (gesamt, geprüft, offen, ohne Bild) in den Slack-Kanal. Kein Agent, das macht die Slack-Brücke. |

Fehlen Bilder, erzeugt der Container KI-Fotos über Google Gemini „Nano Banana“ (sehr realistisch, kostenpflichtig), Cloudflare Workers AI (kostenlos) oder OpenAI. Fällt Google oder OpenAI aus, springt Cloudflare ein.

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

Slash-Befehle in Slack (Antwort nur für dich sichtbar; `/pruefen`, `/ohne-bild`, `/bild-neu`, `/bild-alle` und `/pro-tag <Zahl>` nur im Rezept-Kanal):

| Befehl | Was er macht |
| --- | --- |
| `/statistik` | Rezept-Statistik: gesamt, geprüft, offen, noch zu prüfen, ohne Bild |
| `/offen` | Vorschläge, die auf eine Entscheidung warten, mit Link |
| `/rezept <Name>` | Rezept in Tandoor suchen, mit Status |
| `/ohne-bild [Anzahl \| Name]` | Rezepte ohne Bild, jedes als eigene Nachricht im Kanal mit Knopf **🎨 Bild erzeugen** (KI-Foto direkt in Tandoor, danach **🔄 Anderes Bild erzeugen**). Ohne Angabe 5 Stück; schon gezeigte kommen erst nach 7 Tagen wieder, mit Name wird gezielt gesucht. Ein eigenes Foto wird nie ersetzt. |
| `/bild-neu <Name \| ID>` | Neues KI-Bild mit Google (`GOOGLE_BILD_MODELL`) für ein Rezept, auch wenn es schon ein Foto hat. Bei mehreren Treffern zeigt er die Liste mit IDs. |
| `/bild-alle` | Alle Rezeptbilder mit Google neu erzeugen. Fragt zweimal nach (mit Anzahl und geschätzten Kosten), nur wer fragt, darf bestätigen. Läuft im Hintergrund mit Fortschritt und Knopf **⏹️ Anhalten**, nach einem Neustart geht es weiter. Nach 3 Fehlern hintereinander (z. B. Google-Kontingent) hält er an. |
| `/pruefen [Anzahl]` | Qualitätsprüfung jetzt starten; mit Anzahl darf er heute so viele Rezepte zusätzlich zum Tageswert prüfen |
| `/pro-tag [Anzahl]` | Rezepte pro Tag anzeigen oder ändern (wie in der Weboberfläche) |
| `/neuronen` | Heute noch freie Cloudflare-Neuronen für KI-Fotos |
| `/hilfe` | Übersicht |

Bei `/bild-neu` und `/bild-alle` wird das alte Bild vorher in `daten/rezepte/sicherungen` gesichert (180 Tage). Lässt es sich nicht sichern, bleibt das Rezept unverändert. Beide nutzen nur Google, ohne Cloudflare als Ersatz, und zählen nicht gegen `BILD_PRO_TAG`.

## Zugangsdaten

Als Umgebungsvariablen, in Portainer unter „Environment variables“ (Vorlage: `.env.example`):

- **CLAUDE_CODE_OAUTH_TOKEN:** auf einem Rechner mit Claude Code `claude setup-token` ausführen.
- **TANDOOR_URL**, **TANDOOR_TOKEN:** Tandoor → Einstellungen → API, Scope „read write“.
- **SLACK_BOT_TOKEN**, **SLACK_APP_TOKEN**, **SLACK_CHANNEL:** Slack-App „Rezept-Helfer“ aus `slack-app-manifest.yml` anlegen. In den Kanal kommen auch Meldungen über fehlgeschlagene Läufe.
- **GEMINI_API_KEY:** für KI-Fotos mit Google Nano Banana (optional, ca. 0,03–0,04 $ pro Bild). Schlüssel unter [aistudio.google.com](https://aistudio.google.com) → „Get API key“, Abrechnung muss aktiviert sein. Modell wählen mit `GOOGLE_BILD_MODELL`: `gemini-nano-banana-2.1` (Standard), `gemini-2.5-flash-image` (günstiger) oder `gemini-3-pro-image` (beste Qualität).
- **CF_ACCOUNT_ID**, **CF_AI_TOKEN:** für KI-Fotos (optional, kostenlos; mit Google als Ersatz). Damit nach jedem Foto und mit `/neuronen` in Slack die freien Neuronen angezeigt werden, braucht der Token zusätzlich die Berechtigung „Account Analytics: Read“.

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
