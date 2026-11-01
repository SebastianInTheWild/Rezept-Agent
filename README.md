# Rezept-Agent

Ein Docker-Container, in dem KI-Agenten (Claude Code) Rezepte in [Tandoor](https://tandoor.dev) pflegen. Die Steuerung läuft über Slack und eine eigene Weboberfläche.

| Agent / Dienst | Zeit | Was er macht |
|---|---|---|
| `rezepte` | über Slack | Legt aus Links und Fotos im Rezept-Kanal Entwürfe in Tandoor an und überarbeitet sie auf Wunsch. Startet die Slack-Brücke, nicht der Zeitplan. |
| `rezept-qualitaet` | 12:00 | Prüft Rezepte ohne Status-Schlagwort gegen den Standard (`agents/rezept-standard.md`) und schickt Verbesserungen als Vorschlag in Slack (5 pro Lauf, höchstens 10 offen). |
| `rezept-statistik` | 19:00 | Schickt täglich die Zahlen (gesamt, geprüft, offen, ohne Bild) in den Slack-Kanal. Kein Agent, das macht die Slack-Brücke. |

Fehlen Bilder, erzeugt der Container KI-Fotos über Google Gemini „Nano Banana“ (sehr realistisch, kostenpflichtig), Cloudflare Workers AI (kostenlos) oder OpenAI. Fällt Google oder OpenAI aus, springt Cloudflare ein.

## Einrichten mit Portainer

Das Programm kommt als **fertiges Image** aus GitHub: Bei jedem Push auf `main` (und jeden Montag mit frischem Claude Code) baut GitHub Actions `ghcr.io/sebastianinthewild/rezept-agent:latest` (`.github/workflows/image.yml`). `portainer/stack-host.yml` startet dieses Image; die Daten liegen in **einem Ordner auf dem Docker-Host** (Standard `/home/sebastian/docker/rezepte`, änderbar mit `AGENTS_HOST_DIR`):

```
/home/sebastian/docker/rezepte/
  zeitplan.conf   wann welcher Agent läuft (Änderungen gelten ohne Neustart)
  agents/         ein Ordner je Agent (agent.json + prompt.md), alle 10 Minuten aus GitHub
  daten/          Entwürfe, Logs, Sicherungen, Einstellungen aus der Weboberfläche
```

1. **Stack anlegen:** Portainer → Stacks → Add stack → **Repository**: URL dieses Repos, Reference `refs/heads/main`, Compose path `portainer/stack-host.yml`. **GitOps updates** einschalten (Polling, z. B. 5 Minuten, mit **Re-pull image**) – dann kommen auch Änderungen an der Stack-Datei von selbst.
2. **Image-Zugriff:** Ist das Repo privat, ist auch das Image privat. Dann in Portainer unter **Registries → Add registry → GitHub** einen GitHub-Token mit `read:packages` hinterlegen – oder das Paket unter GitHub → Packages → rezept-agent → Package settings auf „Public“ stellen.
3. **Neues Image automatisch einspielen** – eine der beiden Möglichkeiten:
   - **Webhook (sofort):** Im Stack in Portainer den **Webhook** einschalten, die URL kopieren und im Repo unter Settings → Secrets → Actions als `PORTAINER_WEBHOOK` speichern. Nach jedem Build lädt GitHub den Stack neu. Portainer muss dafür aus dem Internet erreichbar sein.
   - **What's Up Docker:** Die Labels im Stack lassen WUD neue Builds von `:latest` erkennen; mit einem Docker-Trigger in WUD wird der Container automatisch erneuert.

Neue oder geänderte Agenten pushst du einfach nach GitHub (`agents/<name>/agent.json` + `prompt.md`, Vorlage `agents/_vorlage`): Der Container holt `agents/` alle 10 Minuten (`AGENTS_SYNC`, „aus“ = nie) und erkennt sie ohne Neustart. Änderungen direkt auf dem Host in Agenten aus dem Repo werden dabei überschrieben.

### Automatisch aktualisieren

Alles, was auf `main` landet, kommt von selbst auf den Server:

| Was | Wie |
| --- | --- |
| `app/` (Programm), Claude Code | GitHub Actions baut ein neues Image; Portainer-Webhook oder WUD spielen es ein |
| `agents/` | alle 10 Minuten aus GitHub (`AGENTS_SYNC`), ohne Neustart |
| `slack-app-manifest.yml` | steckt im Image; die Slack-Brücke spielt Änderungen über die Manifest-API in Slack ein (`SLACK_APP_ID`, `SLACK_CONFIG_TOKEN`) und meldet das im Kanal. Kommen neue Berechtigungen dazu, muss die App einmal von Hand neu installiert werden. |
| `portainer/stack-host.yml` | Portainer-Repository-Stack mit **GitOps updates** |

Alte Ordner-Variante (Programm in `app/` auf dem Host, Image `node`): Dort holt der Abgleich auch `app/` und das Manifest aus GitHub und startet danach neu (`APP_SYNC`, Standard an; wirkt nur, wenn `app/` beschreibbar ist). Mit dem Image sind `app/` und `npm/` auf dem Host überflüssig und können weg.

### Einstellungen in der Weboberfläche

Unter **Einstellungen** (Reiter oben) lassen sich Zugangsdaten und Optionen eintragen: Claude, Tandoor, Slack, KI-Fotos (Anbieter, Google-Modell, Schlüssel), Bilder pro Tag, Abgleich. Sie haben Vorrang vor den Umgebungsvariablen aus Portainer und liegen in `daten/umgebung.json` (nur für den Container-Benutzer lesbar). Leeres Feld bzw. „Eintrag löschen“ = wieder den Wert aus Portainer nehmen. Änderungen gelten nach **Jetzt neu starten**. Tokens und Schlüssel lassen sich nur ändern, wenn `WEB_PASSWORT` gesetzt ist; angezeigt werden sie nur gekürzt (`••••1234`). `WEB_PASSWORT` selbst bleibt in Portainer, damit man sich nicht aussperrt.

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
