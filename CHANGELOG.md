# Changelog

Alle wichtigen Änderungen am Rezept-Agent. Neueste oben. (All notable changes, newest first – written in German; see the [README](README.md) for an English overview.)

Jeder Abschnitt ist eine Version (Zeitpunkt des Merges auf `main`, deutsche Zeit) mit Pull Request und dem Image-Tag, unter dem genau dieser Stand zu ziehen ist: `ghcr.io/sebastianinthewild/rezept-agent:<Tag>` – in Portainer über `IMAGE_TAG`. Ab der nächsten Version heißen die Tags wie die Version (`2026-11-03_10-11`); für ältere Stände gibt es `sha-<commit>`.

## Unveröffentlicht

_Kommt mit dem nächsten Merge auf `main`. Sobald das Image gebaut ist, ersetzt GitHub Actions diese Überschrift durch die Version und den Image-Tag._

_Noch nichts._

## 2026-11-10 20-37 · [PR #18](https://github.com/SebastianInTheWild/Rezept-Agent/pull/18) · Image-Tag `2026-11-10_20-37`

### Geändert
- **Import auf 4 Portionen:** Rezepte von Webseiten, HelloFresh, Videos, Sprachnachrichten, Fotos und Text werden immer auf 4 Portionen umgerechnet (Mengen sinnvoll gerundet, auch Mengen im Schritttext; ohne Portionsangabe geschätzt). HelloFresh nimmt die 4-Personen-Variante. Ausnahme Gebäck – Kuchen, Torten, Brot, Brötchen, Plätzchen, Muffins, Bleche: Die Menge der Quelle bleibt, die Anzahl Stücke zählt als Portionen. Steht in `changes` des Vorschlags.

## 2026-11-03 11-50 · [PR #17](https://github.com/SebastianInTheWild/Rezept-Agent/pull/17) · Image-Tag `2026-11-03_11-50`

### Neu
- **Versionsnummer** im Format `JJJJ-MM-TT HH-MM`: der Zeitpunkt des Commits auf main (deutsche Zeit), aus dem das Image gebaut wird – jeder gemergte Pull Request ergibt automatisch eine neue Version, der wöchentliche Neubau behält sie. Sichtbar oben rechts in der Weboberfläche (mit Link zum Commit) und in der Fußzeile, in der Slack-Neustart-Meldung („Update von *2026-11-02 20-41* auf *2026-11-03 10-11*“), unter `/hilfe` und beim Start im Container-Log. Neuer Image-Tag je Version (`:2026-11-03_10-11`) zum gezielten Zurückgehen per `IMAGE_TAG`; das Image-Label `org.opencontainers.image.version` trägt sie ebenfalls. Lokal gebaut: `dev`.
- **Changelog nach Versionen:** Jeder Abschnitt ist eine Version mit Pull Request und Image-Tag, unter dem die Änderung zu ziehen ist (`ghcr.io/sebastianinthewild/rezept-agent:<Tag>`). Ältere Stände wurden nachträglich ihrem Merge zugeordnet; für sie gibt es nur die Tags `sha-<commit>`. Ab jetzt ersetzt GitHub Actions nach jedem Image-Bau die Überschrift „Unveröffentlicht“ automatisch durch Version, PR und Tag (`JJJJ-MM-TT_HH-MM`).
- **„Wie war's?“ nach dem Kochen:** Um 20:30 (`koch-frage` im Zeitplan, `KOCH_FRAGE`) fragt die Slack-Brücke zu jedem Gericht, das heute im Tandoor-Essensplan steht, wie es war – Knöpfe ⭐1–5 und „Nicht gekocht“. Die Bewertung wird als Eintrag ins Tandoor-Kochprotokoll geschrieben (Rezept, Portionen, Tag); daraus berechnet Tandoor Bewertung und „zuletzt gekocht“, nach denen der Wochenplan auswählt. Jede Frage kommt einmal, doppelte Klicks tragen nichts doppelt ein. In der Weboberfläche als eigener Eintrag mit **Jetzt senden**.
- **Wochenrückblick:** sonntags um 19:30 (`wochenrueckblick`, `WOCHENRUECKBLICK`) in den Kanal – neue Rezepte (in Tandoor angelegt oder per Import übernommen), übernommene/verworfene und offene Vorschläge, was gekocht und wie bewertet wurde (Schnitt und bestes Gericht), Bestand und geschätzte Google-Kosten der letzten 7 Tage. In der Weboberfläche mit **Jetzt senden**.
- **Status-Seite** in der Weboberfläche (Reiter „Status“): Tandoor, Slack, Claude, Google Gemini, GitHub-Sicherung, Cloudflare und OpenAI – erreichbar, Zugangsdaten gültig, Ablaufdatum des Tokens (GitHub aus dem Antwort-Header, Cloudflare über `tokens/verify`, Tandoor über `/api/access-token/`; Claude geschätzt 365 Tage ab erstem Einsatz oder genau per `CLAUDE_TOKEN_ABLAUF`), mit Hinweis zum Erneuern. **Jetzt prüfen**, sonst 60 Sekunden zwischengespeichert.
- **Warnung vor ablaufenden Tokens:** täglich um 09:05 (`token-pruefung`, `TOKEN_PRUEFUNG`) Meldung im Kanal, wenn ein Token in höchstens `TOKEN_WARNUNG_TAGE` (Standard 14) Tagen abläuft, noch einmal 3 Tage vorher und am Ablauftag, und einmal, wenn Zugangsdaten nicht funktionieren. Ein neuer Token setzt die Warnungen zurück; gespeichert wird nur ein Fingerabdruck (`daten/token-status.json`). Neue Einstellungen `CLAUDE_TOKEN_ABLAUF`, `CLAUDE_TOKEN_GUELTIG_TAGE`, `TOKEN_WARNUNG_TAGE`.
- **Doppelte Rezepte:** Ein neues Rezept mit (fast) gleichem Namen wie ein vorhandenes zeigt im Vorschlag „🔁 Gibt es vielleicht schon“ mit Link und den Knopf **🔁 Als Verbesserung für „…“** – daraus wird ein Verbesserungsvorschlag für das vorhandene Rezept, Übernehmen ersetzt es (alte Fassung und Bild gesichert) statt ein zweites anzulegen. Gilt für Claude und Gemini.
- **Rezept aus einer Sprachnachricht:** Slack-Audioclips und Video-Dateien im Rezept-Kanal werden zum Auftrag; Gemini schreibt Zutaten, Mengen und Schritte heraus (neues Werkzeug `node tandoor.mjs fetch-media`, nur Dateien aus dem Auftrag), Videos bekommen Standbilder. Funktioniert auch, wenn Gemini statt Claude arbeitet.
- Feste Aufgaben der Slack-Brücke (`koch-frage`, `wochenrueckblick`, `token-pruefung`) laufen wie die Statistik einmal pro Tag zur Uhrzeit aus `zeitplan.conf` und werden nachgeholt, wenn die Brücke zur Uhrzeit nicht lief; „aus“ schaltet ab.

### Behoben
- **Weboberfläche auf dem Handy:** Die Leiste oben war mit Version und Uhr zu breit; unter 640 Pixeln werden beide ausgeblendet (die Version steht weiter in der Fußzeile), die Reiter lassen sich verschieben.

## 2026-11-03 10-11 · [PR #16](https://github.com/SebastianInTheWild/Rezept-Agent/pull/16) · Image-Tag `sha-4ecc18d`

### Neu
- **KI-Anbieter wählbar: Claude oder Google Gemini** (`KI_ANBIETER`, Einstellungen → KI-Anbieter): `claude,google` (Standard: Claude, am Claude-Limit sofort Gemini statt 30 Minuten warten), `google,claude` (Gemini zuerst, bei Fehlern Claude), `claude` oder `google` (nur dieser). Gilt für Rezept-Import (Link, HelloFresh, Reel/Short, Foto, Text), Änderungswünsche im Thread, Qualitätsprüfung und Wochenplan. Gemini bekommt die Anweisungen aus `prompt.md` und alle Daten, die der Agent sonst mit seinen Werkzeugen holt (Auftrag, Standard, Einheiten, Link- und Video-Auslese, Fotos und Standbilder, Rezepte bzw. Wochenplan-Daten), und antwortet in einer Anfrage als JSON. Das läuft durch dieselbe Prüfung; bei Fehlern darf Gemini bis zu zweimal korrigieren. Vorschläge tragen den Hinweis „Erstellt mit Google Gemini …“ (am Limit zusätzlich „– bitte genauer ansehen“), Wochenpläne in der Zusammenfassung. Modell `GEMINI_TEXT_MODELL` (Standard `gemini-flash-latest`); `/google` zeigt Anfragen und Kosten. In `agent.json` legt `"fallback"` fest, welcher Agent Gemini nutzen kann; die Weboberfläche zeigt im letzten Lauf, ob Gemini ihn gemacht hat.
- **Kleinere Bilder in Sicherungen:** Rezeptbilder in der GitHub-Sicherung und Bild-Sicherungen vor dem Ersetzen (`daten/rezepte/sicherungen`, auch beim Spiegeln nach GitHub) werden mit ffmpeg als JPEG (ca. 85 %) auf höchstens 1600 Pixel Breite verkleinert – typisch wenige hundert KB statt 1–2 MB. Nur wenn es mindestens 10 % spart; ohne ffmpeg bleibt das Original. Einstellungen `SICHERUNG_BILDER_KOMPRIMIEREN` (`aus` = Originale) und `SICHERUNG_BILD_BREITE` in der Weboberfläche. Der erste Sicherungslauf lädt alle Rezeptbilder einmal verkleinert neu hoch; die Originale bleiben in der Git-Historie. Die Tests in GitHub Actions installieren dafür ffmpeg.
- **Neues Bild mit Wunsch:** Die Knöpfe **🎨 Neues Bild** am Vorschlag und **🎨 Bild erzeugen** bei `/ohne-bild` öffnen ein Fenster, in das du optional schreibst, was anders sein soll (z. B. „mehr Soße, von oben fotografiert“). Leer = normales neues Bild im einheitlichen Stil. Der Wunsch hat Vorrang vor der Stilbeschreibung und steht in der Rückmeldung. Bei `/bild-neu` geht es mit Doppelpunkt: `/bild-neu Lasagne: mehr Käse, von oben`. Ist das Fenster nicht zu öffnen (z. B. sehr alter Knopf), wird wie bisher direkt erzeugt.

## 2026-11-02 20-41 · [PR #15](https://github.com/SebastianInTheWild/Rezept-Agent/pull/15) · Image-Tag `sha-b270c11`

### Neu
- **KI-Bild mit Vorlage aus dem Video:** Beim Import aus Instagram-Reels, YouTube-Shorts und TikTok geht das Standbild vom fertigen Gericht (`…-fertig.jpg`) als Referenzbild an Google (Nano Banana). Das KI-Foto zeigt das Essen so wie im Video (Farbe, Form, Belag). Tisch, Licht, Perspektive und Geschirr kommen weiter aus `agents/bild-stil.md`, Hintergrund, Hände und Text aus dem Video werden nicht übernommen. **🎨 Neues Bild** am Vorschlag erzeugt dagegen normal, ohne Vorlage. Im Vorschlag steht dann „mit dem fertigen Gericht aus dem Video als Vorlage“. Fotos aus Slack (z. B. Kochbuchseiten) werden nicht als Vorlage genutzt, Cloudflare und OpenAI bekommen weiter nur die Beschreibung.

## 2026-11-02 19-47 · [PR #14](https://github.com/SebastianInTheWild/Rezept-Agent/pull/14) · Image-Tag `sha-a2e5554`

### Neu
- **`/pruefen-rezept <Name | ID>`** (englisch `/check-recipe`): prüft ein einzelnes Rezept gezielt neu, auch wenn es schon geprüft, abgelehnt oder auf „nicht bearbeiten“ gesetzt ist. Die Qualitätsprüfung startet sofort (läuft sie gerade, direkt danach), das Rezept kommt zuerst dran und zählt nicht zum Tageswert. Bei mehreren Treffern zeigt der Befehl die IDs; gibt es schon einen offenen Vorschlag, verweist er darauf. Der Befehl wird über das Manifest selbst in Slack eingetragen.

## 2026-11-02 19-27 · [PR #13](https://github.com/SebastianInTheWild/Rezept-Agent/pull/13) · Image-Tag `sha-691ff92`

### Behoben
- **Google-Bilder: „Deadline expired before operation could complete“** (HTTP 504) und andere vorübergehende Google-Fehler (500/502/503) werden jetzt bis zu zweimal wiederholt (nach 10 und 20 Sekunden), statt das Bild gleich als Fehler zu werten – z. B. bei `/bild-alle`.

## 2026-11-02 18-03 · [PR #12](https://github.com/SebastianInTheWild/Rezept-Agent/pull/12) · Image-Tag `sha-4ddd37e`

### Behoben
- **`/bild-alle` ging nicht mehr:** Slack lehnte die Auswahl-Nachricht ab (`invalid_blocks`, „`action_id` already exists“), weil die Knöpfe „Alle“, „Nur ohne KI-Bild“ und „Nur alter Stil“ dieselbe Kennung hatten. Jeder Knopf hat jetzt eine eigene.

## 2026-11-02 13-57 · [PR #11](https://github.com/SebastianInTheWild/Rezept-Agent/pull/11) · Image-Tag `sha-3d7d73c`

### Neu
- **Knopf „🎨 Neues Bild“ an jedem Vorschlag in Slack:** erzeugt das Bild des Entwurfs nachträglich (neu), z. B. wenn es beim Anlegen nicht geklappt hat (wie bei den „Cremigen Curry-Hack-Nudeln“). Zählt nicht gegen `BILD_PRO_TAG`.
- **Ordner in der GitHub-Sicherung heißen `<id> - <Rezeptname>`** (z. B. `rezepte/12 - Lasagne/`, `geloescht/12 - Lasagne/`), damit sich Rezepte leichter finden und wiederherstellen lassen. Bestehende Ordner `<id>/` werden beim nächsten Lauf umbenannt, ohne neu hochzuladen; ändert sich ein Rezeptname, zieht der Ordner mit. Heruntergeladene JSON-Dateien tragen denselben Namen.
- **Aufgeräumte `.env`:** In Portainer bzw. `.env` stehen nur noch `AGENTS_HOST_DIR`, `TZ`, `WEB_PASSWORT`, `WEB_ZUGANGSDATEN_OHNE_PASSWORT` (optional `PUID`, `PGID`, `WEB_DOMAIN`, `IMAGE_TAG`). Alles andere kommt aus der Weboberfläche. Dort neu einstellbar: Claude-API-Schlüssel, Wartezeit nach dem Claude-Limit, Cookie-Datei für Instagram, Cloudflare-Neuronen pro Tag, Abgleich von `app/`, Repo und Branch. **`AGENTS_HOST_DIR` hat jetzt den Standard `./`.** In Portainer muss der Pfad deshalb als Umgebungsvariable gesetzt sein, z. B. `/home/benutzer/docker/rezepte`.
- **GitHub-Sicherung im Log:** Start (Zeitplan oder von Hand), Anzahl Rezepte in Tandoor und in der Sicherung, Fortschritt beim Holen und Hochladen (alle 25), in Tandoor gelöschte Rezepte, Ergebnis mit Dauer und Commit, Fehler.
- **Log mit einheitlichem Datum:** Jede Zeile im Container-Log beginnt mit `[TT.MM.JJJJ hh:mm:ss]` (Zeitzone aus `TZ`), auch Zeitplan, Weboberfläche und Abgleich, die bisher keinen Zeitstempel hatten.
- **`/offen neu`** (englisch `/open resend`): schickt alle offenen Vorschläge und Wochenpläne noch einmal in den Kanal, im aktuellen Format mit allen Knöpfen. Die alte Nachricht wird zum Verweis ohne Knöpfe, Antworten in ihrem Thread zählen weiter. Vorschläge merken sich dafür ab jetzt ihre Änderungen und Hinweise; bei älteren steht ein Verweis auf den Entwurf.
- **Bilder beim Prüfen:** Verbesserungsvorschläge bringen das Bild auf den einheitlichen Stil (neues KI-Bild, außer das Original hat schon eins im aktuellen Stil). Beim Übernehmen wird das alte Bild vorher gesichert – wie bei `/bild-neu`. Behoben: Das Bild des Originals landete nicht im Entwurf (signierte Bildadressen ließen sich nicht weiterreichen; jetzt herunterladen und hochladen).
- **`BILD_PRO_TAG` leer = unbegrenzt** (bisher 10).
- **Weboberfläche ohne Login:** `WEB_PASSWORT` leer = kein Login. Neu: `WEB_ZUGANGSDATEN_OHNE_PASSWORT=an` erlaubt das Ändern von Zugangsdaten auch ohne Passwort – gedacht, wenn der Proxy die Seite schützt (z. B. nur Heimnetz). Nur in Portainer/`.env` setzbar, nicht in der Weboberfläche; dort erscheint ein Hinweis.

## 2026-11-02 13-16 · [PR #10](https://github.com/SebastianInTheWild/Rezept-Agent/pull/10) · Image-Tag `sha-cf9886c`

### Neu
- **GitHub-Sicherung:** täglich (03:30, `rezept-sicherung` im Zeitplan, oder **Jetzt sichern**) alle Rezepte mit Bild, in Tandoor gelöschte Rezepte (`geloescht/`) und die Bild-/Rezept-Sicherungen in ein privates GitHub-Repo (`BACKUP_REPO`, `BACKUP_TOKEN`) – über die GitHub-API, nur Geändertes, mit Schutz vor Fehlalarm (bricht ab, wenn mehr als die Hälfte der Rezepte fehlt). Gelöschte Rezepte lassen sich in der Weboberfläche unter „Sicherungen“ mit Bild wieder anlegen; lokal aufgeräumte Sicherungen kommen aus GitHub. Meldung im Slack-Kanal bei gelöschten Rezepten und Fehlern.
- **Wochenplan:** Slack `/wochenplan [Tage] [Wünsche]` (englisch `/meal-plan`) – neuer Agent `wochenplan` wählt abwechslungsreich aus euren Rezepten, Knöpfe **In Essensplan + Einkaufsliste** / **Nur Essensplan** / **Verwerfen**, Antwort im Thread tauscht Gerichte. Optional automatisch nach Zeitplan (z. B. sonntags). Einstellungen `WOCHENPLAN_PORTIONEN`, `WOCHENPLAN_MAHLZEIT`.
- **„Was koche ich?“:** Slack `/was-kochen <Zutaten>` (englisch `/what-to-cook`) findet Rezepte mit diesen Zutaten, ohne Claude.
- **Nährwerte pro Portion:** Agenten schätzen Kalorien, Eiweiß, Fett und Kohlenhydrate (oder übernehmen sie aus der Quelle) und tragen sie als Tandoor-Eigenschaften ein (so zeigt Tandoor 2.x sie an); Anzeige im Vorschlag in Slack. Fehlende Eigenschafts-Typen werden angelegt, andere Eigenschaften bleiben erhalten.
- **Claude-Limit:** Läufe, die am Nutzungslimit scheitern, werden alle 30 Minuten wiederholt (`CLAUDE_WIEDERHOLEN_MIN`, höchstens 24 Stunden) – nach Zeitplan und aus Slack. Meldung im Kanal, nächster Versuch in der Weboberfläche.
- **Automatische Tests bei jedem Pull Request** (`.github/workflows/test.yml`): Syntax, Tests mit nachgebautem Tandoor/Slack/Google/GitHub, Image-Build.
- **Weboberfläche „Sicherungen“:** eigener Menüpunkt mit allen gesicherten Bildern aus `daten/rezepte/sicherungen`, je Rezept neben dem aktuellen Bild, mit Datum, Größe und Ablaufdatum (180 Tage). Knöpfe **Öffnen**, **Herunterladen**, **Wiederherstellen** (setzt das Bild wieder ins Rezept; das aktuelle Bild wird vorher gesichert, Merkmal `ki-bild` entfällt) und **Löschen**. Rezept-Sicherungen (JSON vor einem übernommenen Verbesserungsvorschlag) zum Herunterladen. Suche nach Rezeptname oder ID.

## 2026-11-02 09-42 · [PR #8](https://github.com/SebastianInTheWild/Rezept-Agent/pull/8) · Image-Tag `sha-2645de6`

### Neu
- **Merkmal „KI-Bild“:** Jedes mit KI erzeugte Rezeptbild wird intern mitgeschrieben (Anbieter, Modell, Datum, Stil-Kennung aus `agents/bild-stil.md`, Bildpfad) und in Tandoor mit dem Schlagwort `ki-bild` markiert – bei neuen Rezepten, Verbesserungsvorschlägen, `/ohne-bild`, `/bild-neu` und `/bild-alle`. Ein täglicher Abgleich entfernt das Merkmal, wenn das Bild in Tandoor ersetzt oder gelöscht wurde, und setzt fehlende Schlagwörter wieder. `/statistik` zählt die KI-Bilder, `/rezept` zeigt Modell, Datum und ob der Stil veraltet ist, `/bild-alle` bietet „alle“, „nur ohne KI-Bild“ und „nur alter Stil“ an.

## 2026-11-02 09-15 · [PR #7](https://github.com/SebastianInTheWild/Rezept-Agent/pull/7) · Image-Tag `sha-0329b6b`

### Neu
- **Slack `/google`:** Google-Nutzung des Monats – Bilder (je Modell), ausgewertete Videos mit Tokens, geschätzte Kosten, heute und Vormonat. Mit `GOOGLE_GUTHABEN` (z. B. 10 $ aus Google AI Pro) auch das Rest-Guthaben und einmal pro Monat eine Warnung bei 80 %. Gezählt werden die eigenen Aufrufe des Agenten (`daten/rezepte/google-nutzung.json`), Preise in den Einstellungen anpassbar (`GOOGLE_PREIS_BILD`, `GEMINI_PREIS_EINGABE`, `GEMINI_PREIS_AUSGABE`).

## 2026-11-02 08-41 · [PR #6](https://github.com/SebastianInTheWild/Rezept-Agent/pull/6) · Image-Tag `sha-1a2ce8c`

### Neu
- **Meldung nach Neustart:** Nach jedem Start des Containers (Update, Neustart aus der Weboberfläche, Server-Neustart, Absturz) schreibt der Agent in den Rezept-Kanal, dass er wieder läuft – mit Version (Commit) und ob es ein Update war (von … auf …). Ein Neustart nur der Slack-Brücke wird nicht gemeldet. Abschaltbar mit `NEUSTART_MELDUNG=aus` bzw. in der Weboberfläche unter Einstellungen → Slack. Das Image kennt dafür seine Version (`APP_VERSION`, `APP_BUILD` aus GitHub Actions).

## 2026-11-02 08-33 · [PR #5](https://github.com/SebastianInTheWild/Rezept-Agent/pull/5) · Image-Tag `sha-31e3b23`

### Behoben
- **`/bild-neu` und `/bild-alle`:** Das Sichern des alten Bildes scheiterte mit HTTP 400, wenn Tandoor die Bilder über signierte S3-Adressen ausliefert (z. B. app.tandoor.dev) – S3 lehnt den zusätzlich mitgeschickten Tandoor-Token ab. Das Bild wird jetzt zuerst ohne Token geladen, der Token nur bei 401/403 mitgeschickt.

## 2026-11-02 07-58 · [PR #4](https://github.com/SebastianInTheWild/Rezept-Agent/pull/4) · Image-Tag `sha-a6c863b`

### Neu
- **Deutsch oder Englisch:** neue Einstellung „Sprache“ (Weboberfläche → Einstellungen → Allgemein, oder `SPRACHE=de|en`). Gilt für neue Rezepte und Verbesserungsvorschläge (vorhandene Rezepte übersetzt der Qualitäts-Agent nach und nach), alle Slack-Nachrichten und Knöpfe und die Weboberfläche. Englischer Rezept-Standard in `agents/rezept-standard.en.md` mit englischen Einheiten; Geräte-Schritt, „Schritt n“, Portionen und Entwurfs-Präfix in der gewählten Sprache.
- **Englische Slack-Befehle:** `/stats`, `/open`, `/recipe`, `/no-image`, `/new-image`, `/all-images`, `/check`, `/per-day`, `/neurons`, `/help` – die deutschen Namen funktionieren weiter. Mit `SLACK_APP_ID`/`SLACK_CONFIG_TOKEN` trägt die Brücke bei Englisch die englischen Befehle und Beschreibungen selbst in Slack ein.
- **README auf Englisch** (`README.md`), deutsche Fassung in `README.de.md`.

### Geändert
- Status-Schlagwörter in Tandoor und die Logs bleiben bewusst deutsch. Entwürfe werden in beiden Sprachen erkannt („⏳ Entwurf:“ / „⏳ Draft:“).

## 2026-11-01 20-16 · [PR #3](https://github.com/SebastianInTheWild/Rezept-Agent/pull/3) · Image-Tag `sha-87ddc02`

### Neu
- **Rezepte aus Instagram-Reels und YouTube-Shorts** (auch TikTok und YouTube-Videos bis 10 Minuten): Link in den Rezept-Kanal schicken. `yt-dlp` holt Bildunterschrift und Video, Gemini wertet das Video aus (Gesprochenes, eingeblendeter Text, Mengen), der Agent baut daraus den Entwurf. Ein Link zum Blog in der Bildunterschrift wird bevorzugt gelesen. Neue Einstellungen: `GEMINI_VIDEO_MODELL`, `VIDEO_MAX_SEKUNDEN`, `VIDEO_COOKIES`.
- **Einheitlicher Bildstil:** Alle KI-Rezeptfotos nutzen denselben Stil aus `agents/bild-stil.md` (Prompt für Nano Banana: Tisch, Licht, Perspektive, passendes Geschirr). Neue Rezepte bekommen immer ein KI-Foto, auch wenn die Quelle ein eigenes Foto hat; der Agent beschreibt nur das Gericht (`image_prompt`). Abschaltbar mit `BILD_EINHEITLICH=aus`. Vorhandene Rezepte mit `/bild-alle` angleichen.
- **Rezepte von HelloFresh importieren:** Tandoors Import scheitert an HelloFresh – der Container liest die Rezeptdaten jetzt selbst aus der Seite (Zutaten je Portionszahl, Schritte mit Zutaten, Utensilien, Zeiten; Reserve: schema.org-Daten).
- **Rezepttext einfügen:** Längerer Text ohne Link oder Foto (z. B. eine kopierte Bildunterschrift) wird als Rezept angelegt statt mit der Hilfe beantwortet.

### Geändert
- Image enthält jetzt `ffmpeg` und `yt-dlp` (wird mit dem wöchentlichen Build aktuell).
- Der Agent `rezepte` darf Befehle bis 8 Minuten laufen lassen (Video-Auswertung).

## 2026-11-01 17-39 · [PR #2](https://github.com/SebastianInTheWild/Rezept-Agent/pull/2) · Image-Tag `sha-cefae7c`

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

## 2026-10-27 · vor dem ersten Image (enthalten ab `sha-cefae7c`)

- Node 26 als Basis; What's Up Docker mit Digest-Updates.
- Slack-Befehle `/statistik`, `/offen`, `/rezept`, `/pruefen`, `/pro-tag`, `/neuronen`, `/hilfe`.
- Rezepte pro Tag in der Weboberfläche einstellbar; Statistik von Hand senden.
- `agents/` wird automatisch aus GitHub geholt (`AGENTS_SYNC`).
- Freie Cloudflare-Neuronen nach jedem KI-Foto und per `/neuronen`.
- Zugangsdaten nur noch als Umgebungsvariablen.

## 2026-10-26 · vor dem ersten Image (enthalten ab `sha-cefae7c`)

- Erste Veröffentlichung als eigenständiger Rezept-Agent (herausgelöst aus „Unser Zuhause“).
- Weboberfläche „Zeitplan“ mit **Jetzt starten**, Fehlermeldungen nach Slack.
- Rezept-Qualität: 5 Rezepte pro Tag (höchstens 10 offen), tägliche Statistik in Slack.
