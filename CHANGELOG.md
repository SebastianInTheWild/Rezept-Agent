# Changelog

Alle wichtigen Änderungen am Rezept-Agent. Neueste oben.

## Unveröffentlicht

### Neu
- **Rezepte aus Instagram-Reels und YouTube-Shorts** (auch TikTok und YouTube-Videos bis 10 Minuten): Link in den Rezept-Kanal schicken. `yt-dlp` holt Bildunterschrift und Video, Gemini wertet das Video aus (Gesprochenes, eingeblendeter Text, Mengen), der Agent baut daraus den Entwurf. Ein Link zum Blog in der Bildunterschrift wird bevorzugt gelesen; als Foto dient ein Standbild des fertigen Gerichts. Neue Einstellungen: `GEMINI_VIDEO_MODELL`, `VIDEO_MAX_SEKUNDEN`, `VIDEO_COOKIES`.
- **Rezepttext einfügen:** Längerer Text ohne Link oder Foto (z. B. eine kopierte Bildunterschrift) wird als Rezept angelegt statt mit der Hilfe beantwortet.

### Geändert
- Image enthält jetzt `ffmpeg` und `yt-dlp` (wird mit dem wöchentlichen Build aktuell).
- Der Agent `rezepte` darf Befehle bis 8 Minuten laufen lassen (Video-Auswertung).

## 2026-11-01

### Neu
- **Slack `/ohne-bild [Anzahl | Name]`:** zeigt Rezepte ohne Bild, jedes als eigene Nachricht im Kanal mit Knopf **🎨 Bild erzeugen** (danach **🔄 Anderes Bild erzeugen**). Schon gezeigte Rezepte kommen erst nach 7 Tagen wieder; ein eigenes Foto wird nie ersetzt.
- **Statistik:** zählt jetzt auch die Rezepte ohne Bild (`/statistik` und tägliche Nachricht).
- **KI-Fotos mit Google Gemini „Nano Banana“** (`GEMINI_API_KEY`); das Modell ist mit `GOOGLE_BILD_MODELL` wählbar (`gemini-nano-banana-2.1`, `gemini-2.5-flash-image`, `gemini-3-pro-image`). Schlägt Google fehl, springt Cloudflare ein.
- **Slack `/bild-neu <Name | ID>`:** neues KI-Bild mit Google für ein einzelnes Rezept, auch wenn es schon ein Foto hat.
- **Slack `/bild-alle`:** erneuert die Bilder aller Rezepte mit Google – mit zweimaliger Rückfrage (Anzahl und geschätzte Kosten, nur wer fragt, darf bestätigen). Läuft im Hintergrund mit Fortschritt, **Anhalten**/**Weitermachen** und macht nach einem Neustart weiter; nach 3 Fehlern hintereinander hält er an.
- **Sicherung:** Bei `/bild-neu` und `/bild-alle` wird das alte Bild vorher in `daten/rezepte/sicherungen` gesichert (180 Tage). Lässt es sich nicht sichern, bleibt das Rezept unverändert.
- **Weboberfläche „Einstellungen“:** Zugangsdaten und Optionen (Claude, Tandoor, Slack, KI-Fotos, Abgleich) direkt im Browser setzen. Sie haben Vorrang vor Portainer, liegen in `daten/umgebung.json` und gelten nach **Jetzt neu starten**. Tokens nur mit `WEB_PASSWORT` änderbar und nur gekürzt angezeigt.
- **Fertiges Image aus GitHub Actions:** `ghcr.io/sebastianinthewild/rezept-agent:latest` wird bei jedem Push auf `main` und jeden Montag (frisches Claude Code) gebaut. Optional lädt ein Portainer-Webhook (`PORTAINER_WEBHOOK`) den Stack danach sofort neu.
- **Slack-Manifest automatisch:** Änderungen an `slack-app-manifest.yml` spielt die Slack-Brücke selbst über die Manifest-API ein (`SLACK_APP_ID`, `SLACK_CONFIG_TOKEN`) und meldet das im Kanal.

### Geändert
- **Portainer-Stack** (`portainer/stack-host.yml`) nutzt das fertige Image statt `node:26` mit dem Programm im Host-Ordner. `app/` und `npm/` auf dem Host werden nicht mehr gebraucht. What's Up Docker beobachtet jetzt `:latest`.
- **Slack-Brücke startet immer** und wartet, bis die Tokens eingetragen sind (sie können jetzt auch aus der Weboberfläche kommen).
- **Container-Start** über `start.sh` (Zeitplan, Weboberfläche und Slack-Brücke) auch im Image; Claude Code aus dem Image hat Vorrang.
- **Ein neues KI-Bild** schickt geprüfte Rezepte nicht noch einmal in die Qualitätsprüfung.
- **Alte Ordner-Variante:** Der Abgleich holt dort zusätzlich `app/` und das Slack-Manifest aus GitHub und startet danach neu (`APP_SYNC`). Neuer Code wird vorher auf Syntaxfehler geprüft.

### Neue Slack-Befehle
`/ohne-bild`, `/bild-neu`, `/bild-alle` – das Slack-Manifest muss einmal übernommen werden (oder automatisch, sobald `SLACK_APP_ID`/`SLACK_CONFIG_TOKEN` gesetzt sind).

## 2026-10-27

- Node 26 als Basis; What's Up Docker mit Digest-Updates.
- Slack-Befehle `/statistik`, `/offen`, `/rezept`, `/pruefen`, `/pro-tag`, `/neuronen`, `/hilfe`.
- Rezepte pro Tag in der Weboberfläche einstellbar; Statistik von Hand senden.
- `agents/` wird automatisch aus GitHub geholt (`AGENTS_SYNC`).
- Freie Cloudflare-Neuronen nach jedem KI-Foto und per `/neuronen`.
- Zugangsdaten nur noch als Umgebungsvariablen.

## 2026-10-26

- Erste Veröffentlichung als eigenständiger Rezept-Agent (herausgelöst aus „Unser Zuhause“).
- Weboberfläche „Zeitplan“ mit **Jetzt starten**, Fehlermeldungen nach Slack.
- Rezept-Qualität: 5 Rezepte pro Tag (höchstens 10 offen), tägliche Statistik in Slack.
