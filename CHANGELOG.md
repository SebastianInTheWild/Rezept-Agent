# Changelog

Alle wichtigen Änderungen am Rezept-Agent. Neueste oben. (All notable changes, newest first – written in German; see the [README](README.md) for an English overview.)

## Unveröffentlicht

### Neu
- **Kleinere Bilder in Sicherungen:** Rezeptbilder in der GitHub-Sicherung und Bild-Sicherungen vor dem Ersetzen (`daten/rezepte/sicherungen`, auch beim Spiegeln nach GitHub) werden mit ffmpeg als JPEG (ca. 85 %) auf höchstens 1600 Pixel Breite verkleinert – typisch wenige hundert KB statt 1–2 MB. Nur wenn es mindestens 10 % spart; ohne ffmpeg bleibt das Original. Einstellungen `SICHERUNG_BILDER_KOMPRIMIEREN` (`aus` = Originale) und `SICHERUNG_BILD_BREITE` in der Weboberfläche. Der erste Sicherungslauf lädt alle Rezeptbilder einmal verkleinert neu hoch; die Originale bleiben in der Git-Historie. Die Tests in GitHub Actions installieren dafür ffmpeg.
- **Neues Bild mit Wunsch:** Die Knöpfe **🎨 Neues Bild** am Vorschlag und **🎨 Bild erzeugen** bei `/ohne-bild` öffnen ein Fenster, in das du optional schreibst, was anders sein soll (z. B. „mehr Soße, von oben fotografiert“). Leer = normales neues Bild im einheitlichen Stil. Der Wunsch hat Vorrang vor der Stilbeschreibung und steht in der Rückmeldung. Bei `/bild-neu` geht es mit Doppelpunkt: `/bild-neu Lasagne: mehr Käse, von oben`. Ist das Fenster nicht zu öffnen (z. B. sehr alter Knopf), wird wie bisher direkt erzeugt.
- **KI-Bild mit Vorlage aus dem Video:** Beim Import aus Instagram-Reels, YouTube-Shorts und TikTok geht das Standbild vom fertigen Gericht (`…-fertig.jpg`) als Referenzbild an Google (Nano Banana). Das KI-Foto zeigt das Essen so wie im Video (Farbe, Form, Belag). Tisch, Licht, Perspektive und Geschirr kommen weiter aus `agents/bild-stil.md`, Hintergrund, Hände und Text aus dem Video werden nicht übernommen. **🎨 Neues Bild** am Vorschlag erzeugt dagegen normal, ohne Vorlage. Im Vorschlag steht dann „mit dem fertigen Gericht aus dem Video als Vorlage“. Fotos aus Slack (z. B. Kochbuchseiten) werden nicht als Vorlage genutzt, Cloudflare und OpenAI bekommen weiter nur die Beschreibung.
- **`/pruefen-rezept <Name | ID>`** (englisch `/check-recipe`): prüft ein einzelnes Rezept gezielt neu, auch wenn es schon geprüft, abgelehnt oder auf „nicht bearbeiten“ gesetzt ist. Die Qualitätsprüfung startet sofort (läuft sie gerade, direkt danach), das Rezept kommt zuerst dran und zählt nicht zum Tageswert. Bei mehreren Treffern zeigt der Befehl die IDs; gibt es schon einen offenen Vorschlag, verweist er darauf. Der Befehl wird über das Manifest selbst in Slack eingetragen.
- **Merkmal „KI-Bild“:** Jedes mit KI erzeugte Rezeptbild wird intern mitgeschrieben (Anbieter, Modell, Datum, Stil-Kennung aus `agents/bild-stil.md`, Bildpfad) und in Tandoor mit dem Schlagwort `ki-bild` markiert – bei neuen Rezepten, Verbesserungsvorschlägen, `/ohne-bild`, `/bild-neu` und `/bild-alle`. Ein täglicher Abgleich entfernt das Merkmal, wenn das Bild in Tandoor ersetzt oder gelöscht wurde, und setzt fehlende Schlagwörter wieder. `/statistik` zählt die KI-Bilder, `/rezept` zeigt Modell, Datum und ob der Stil veraltet ist, `/bild-alle` bietet „alle“, „nur ohne KI-Bild“ und „nur alter Stil“ an.
- **GitHub-Sicherung:** täglich (03:30, `rezept-sicherung` im Zeitplan, oder **Jetzt sichern**) alle Rezepte mit Bild, in Tandoor gelöschte Rezepte (`geloescht/`) und die Bild-/Rezept-Sicherungen in ein privates GitHub-Repo (`BACKUP_REPO`, `BACKUP_TOKEN`) – über die GitHub-API, nur Geändertes, mit Schutz vor Fehlalarm (bricht ab, wenn mehr als die Hälfte der Rezepte fehlt). Gelöschte Rezepte lassen sich in der Weboberfläche unter „Sicherungen“ mit Bild wieder anlegen; lokal aufgeräumte Sicherungen kommen aus GitHub. Meldung im Slack-Kanal bei gelöschten Rezepten und Fehlern.
- **Wochenplan:** Slack `/wochenplan [Tage] [Wünsche]` (englisch `/meal-plan`) – neuer Agent `wochenplan` wählt abwechslungsreich aus euren Rezepten, Knöpfe **In Essensplan + Einkaufsliste** / **Nur Essensplan** / **Verwerfen**, Antwort im Thread tauscht Gerichte. Optional automatisch nach Zeitplan (z. B. sonntags). Einstellungen `WOCHENPLAN_PORTIONEN`, `WOCHENPLAN_MAHLZEIT`.
- **„Was koche ich?“:** Slack `/was-kochen <Zutaten>` (englisch `/what-to-cook`) findet Rezepte mit diesen Zutaten, ohne Claude.
- **Nährwerte pro Portion:** Agenten schätzen Kalorien, Eiweiß, Fett und Kohlenhydrate (oder übernehmen sie aus der Quelle) und tragen sie als Tandoor-Eigenschaften ein (so zeigt Tandoor 2.x sie an); Anzeige im Vorschlag in Slack. Fehlende Eigenschafts-Typen werden angelegt, andere Eigenschaften bleiben erhalten.
- **Claude-Limit:** Läufe, die am Nutzungslimit scheitern, werden alle 30 Minuten wiederholt (`CLAUDE_WIEDERHOLEN_MIN`, höchstens 24 Stunden) – nach Zeitplan und aus Slack. Meldung im Kanal, nächster Versuch in der Weboberfläche.
- **Knopf „🎨 Neues Bild“ an jedem Vorschlag in Slack:** erzeugt das Bild des Entwurfs nachträglich (neu), z. B. wenn es beim Anlegen nicht geklappt hat (wie bei den „Cremigen Curry-Hack-Nudeln“). Zählt nicht gegen `BILD_PRO_TAG`.
- **Ordner in der GitHub-Sicherung heißen `<id> - <Rezeptname>`** (z. B. `rezepte/12 - Lasagne/`, `geloescht/12 - Lasagne/`), damit sich Rezepte leichter finden und wiederherstellen lassen. Bestehende Ordner `<id>/` werden beim nächsten Lauf umbenannt, ohne neu hochzuladen; ändert sich ein Rezeptname, zieht der Ordner mit. Heruntergeladene JSON-Dateien tragen denselben Namen.
- **Aufgeräumte `.env`:** In Portainer bzw. `.env` stehen nur noch `AGENTS_HOST_DIR`, `TZ`, `WEB_PASSWORT`, `WEB_ZUGANGSDATEN_OHNE_PASSWORT` (optional `PUID`, `PGID`, `WEB_DOMAIN`, `IMAGE_TAG`). Alles andere kommt aus der Weboberfläche. Dort neu einstellbar: Claude-API-Schlüssel, Wartezeit nach dem Claude-Limit, Cookie-Datei für Instagram, Cloudflare-Neuronen pro Tag, Abgleich von `app/`, Repo und Branch. **`AGENTS_HOST_DIR` hat jetzt den Standard `./`.** In Portainer muss der Pfad deshalb als Umgebungsvariable gesetzt sein, z. B. `/home/benutzer/docker/rezepte`.
- **GitHub-Sicherung im Log:** Start (Zeitplan oder von Hand), Anzahl Rezepte in Tandoor und in der Sicherung, Fortschritt beim Holen und Hochladen (alle 25), in Tandoor gelöschte Rezepte, Ergebnis mit Dauer und Commit, Fehler.
- **Log mit einheitlichem Datum:** Jede Zeile im Container-Log beginnt mit `[TT.MM.JJJJ hh:mm:ss]` (Zeitzone aus `TZ`), auch Zeitplan, Weboberfläche und Abgleich, die bisher keinen Zeitstempel hatten.
- **`/offen neu`** (englisch `/open resend`): schickt alle offenen Vorschläge und Wochenpläne noch einmal in den Kanal, im aktuellen Format mit allen Knöpfen. Die alte Nachricht wird zum Verweis ohne Knöpfe, Antworten in ihrem Thread zählen weiter. Vorschläge merken sich dafür ab jetzt ihre Änderungen und Hinweise; bei älteren steht ein Verweis auf den Entwurf.
- **Bilder beim Prüfen:** Verbesserungsvorschläge bringen das Bild auf den einheitlichen Stil (neues KI-Bild, außer das Original hat schon eins im aktuellen Stil). Beim Übernehmen wird das alte Bild vorher gesichert – wie bei `/bild-neu`. Behoben: Das Bild des Originals landete nicht im Entwurf (signierte Bildadressen ließen sich nicht weiterreichen; jetzt herunterladen und hochladen).
- **`BILD_PRO_TAG` leer = unbegrenzt** (bisher 10).
- **Weboberfläche ohne Login:** `WEB_PASSWORT` leer = kein Login. Neu: `WEB_ZUGANGSDATEN_OHNE_PASSWORT=an` erlaubt das Ändern von Zugangsdaten auch ohne Passwort – gedacht, wenn der Proxy die Seite schützt (z. B. nur Heimnetz). Nur in Portainer/`.env` setzbar, nicht in der Weboberfläche; dort erscheint ein Hinweis.
- **Automatische Tests bei jedem Pull Request** (`.github/workflows/test.yml`): Syntax, Tests mit nachgebautem Tandoor/Slack/Google/GitHub, Image-Build.
- **Weboberfläche „Sicherungen“:** eigener Menüpunkt mit allen gesicherten Bildern aus `daten/rezepte/sicherungen`, je Rezept neben dem aktuellen Bild, mit Datum, Größe und Ablaufdatum (180 Tage). Knöpfe **Öffnen**, **Herunterladen**, **Wiederherstellen** (setzt das Bild wieder ins Rezept; das aktuelle Bild wird vorher gesichert, Merkmal `ki-bild` entfällt) und **Löschen**. Rezept-Sicherungen (JSON vor einem übernommenen Verbesserungsvorschlag) zum Herunterladen. Suche nach Rezeptname oder ID.
- **Slack `/google`:** Google-Nutzung des Monats – Bilder (je Modell), ausgewertete Videos mit Tokens, geschätzte Kosten, heute und Vormonat. Mit `GOOGLE_GUTHABEN` (z. B. 10 $ aus Google AI Pro) auch das Rest-Guthaben und einmal pro Monat eine Warnung bei 80 %. Gezählt werden die eigenen Aufrufe des Agenten (`daten/rezepte/google-nutzung.json`), Preise in den Einstellungen anpassbar (`GOOGLE_PREIS_BILD`, `GEMINI_PREIS_EINGABE`, `GEMINI_PREIS_AUSGABE`).

## 2026-11-02 (Neustart-Meldung, Bild-Fix)

### Neu
- **Meldung nach Neustart:** Nach jedem Start des Containers (Update, Neustart aus der Weboberfläche, Server-Neustart, Absturz) schreibt der Agent in den Rezept-Kanal, dass er wieder läuft – mit Version (Commit) und ob es ein Update war (von … auf …). Ein Neustart nur der Slack-Brücke wird nicht gemeldet. Abschaltbar mit `NEUSTART_MELDUNG=aus` bzw. in der Weboberfläche unter Einstellungen → Slack. Das Image kennt dafür seine Version (`APP_VERSION`, `APP_BUILD` aus GitHub Actions).

### Behoben
- **`/bild-alle` ging nicht mehr:** Slack lehnte die Auswahl-Nachricht ab (`invalid_blocks`, „`action_id` already exists“), weil die Knöpfe „Alle“, „Nur ohne KI-Bild“ und „Nur alter Stil“ dieselbe Kennung hatten. Jeder Knopf hat jetzt eine eigene.
- **Google-Bilder: „Deadline expired before operation could complete“** (HTTP 504) und andere vorübergehende Google-Fehler (500/502/503) werden jetzt bis zu zweimal wiederholt (nach 10 und 20 Sekunden), statt das Bild gleich als Fehler zu werten – z. B. bei `/bild-alle`.
- **`/bild-neu` und `/bild-alle`:** Das Sichern des alten Bildes scheiterte mit HTTP 400, wenn Tandoor die Bilder über signierte S3-Adressen ausliefert (z. B. app.tandoor.dev) – S3 lehnt den zusätzlich mitgeschickten Tandoor-Token ab. Das Bild wird jetzt zuerst ohne Token geladen, der Token nur bei 401/403 mitgeschickt.

## 2026-11-02 (Sprache)

### Neu
- **Deutsch oder Englisch:** neue Einstellung „Sprache“ (Weboberfläche → Einstellungen → Allgemein, oder `SPRACHE=de|en`). Gilt für neue Rezepte und Verbesserungsvorschläge (vorhandene Rezepte übersetzt der Qualitäts-Agent nach und nach), alle Slack-Nachrichten und Knöpfe und die Weboberfläche. Englischer Rezept-Standard in `agents/rezept-standard.en.md` mit englischen Einheiten; Geräte-Schritt, „Schritt n“, Portionen und Entwurfs-Präfix in der gewählten Sprache.
- **Englische Slack-Befehle:** `/stats`, `/open`, `/recipe`, `/no-image`, `/new-image`, `/all-images`, `/check`, `/per-day`, `/neurons`, `/help` – die deutschen Namen funktionieren weiter. Mit `SLACK_APP_ID`/`SLACK_CONFIG_TOKEN` trägt die Brücke bei Englisch die englischen Befehle und Beschreibungen selbst in Slack ein.
- **README auf Englisch** (`README.md`), deutsche Fassung in `README.de.md`.

### Geändert
- Status-Schlagwörter in Tandoor und die Logs bleiben bewusst deutsch. Entwürfe werden in beiden Sprachen erkannt („⏳ Entwurf:“ / „⏳ Draft:“).

## 2026-11-01 (Reels, HelloFresh, Bildstil)

### Neu
- **Rezepte aus Instagram-Reels und YouTube-Shorts** (auch TikTok und YouTube-Videos bis 10 Minuten): Link in den Rezept-Kanal schicken. `yt-dlp` holt Bildunterschrift und Video, Gemini wertet das Video aus (Gesprochenes, eingeblendeter Text, Mengen), der Agent baut daraus den Entwurf. Ein Link zum Blog in der Bildunterschrift wird bevorzugt gelesen. Neue Einstellungen: `GEMINI_VIDEO_MODELL`, `VIDEO_MAX_SEKUNDEN`, `VIDEO_COOKIES`.
- **Einheitlicher Bildstil:** Alle KI-Rezeptfotos nutzen denselben Stil aus `agents/bild-stil.md` (Prompt für Nano Banana: Tisch, Licht, Perspektive, passendes Geschirr). Neue Rezepte bekommen immer ein KI-Foto, auch wenn die Quelle ein eigenes Foto hat; der Agent beschreibt nur das Gericht (`image_prompt`). Abschaltbar mit `BILD_EINHEITLICH=aus`. Vorhandene Rezepte mit `/bild-alle` angleichen.
- **Rezepte von HelloFresh importieren:** Tandoors Import scheitert an HelloFresh – der Container liest die Rezeptdaten jetzt selbst aus der Seite (Zutaten je Portionszahl, Schritte mit Zutaten, Utensilien, Zeiten; Reserve: schema.org-Daten).
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
