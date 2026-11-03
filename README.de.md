# Rezept-Agent

**Deutsch** · [English](README.md)

Ein Docker-Container, in dem KI-Agenten (Claude Code) Rezepte in [Tandoor](https://tandoor.dev) pflegen. Die Steuerung läuft über Slack und eine eigene Weboberfläche. Was sich geändert hat, steht im [CHANGELOG](CHANGELOG.md).

| Agent / Dienst | Zeit | Was er macht |
|---|---|---|
| `rezepte` | über Slack | Legt aus Links (auch HelloFresh), Instagram-Reels, YouTube-Shorts, Fotos, Sprachnachrichten und eingefügtem Rezepttext im Rezept-Kanal Entwürfe in Tandoor an und überarbeitet sie auf Wunsch. Startet die Slack-Brücke, nicht der Zeitplan. |
| `rezept-qualitaet` | 12:00 | Prüft Rezepte ohne Status-Schlagwort gegen den Standard (`agents/rezept-standard.md`) und schickt Verbesserungen als Vorschlag in Slack (5 pro Lauf, höchstens 10 offen). |
| `rezept-statistik` | 19:00 | Schickt täglich die Zahlen (gesamt, geprüft, offen, ohne Bild) in den Slack-Kanal. Kein Agent, das macht die Slack-Brücke. |
| `wochenplan` | über Slack (optional z. B. So 17:00) | Schlägt einen Essensplan aus euren Rezepten vor; mit einem Klick in Tandoor-Essensplan und Einkaufsliste. |
| `rezept-sicherung` | 03:30 | Sichert alle Rezepte, gelöschte Rezepte und Bild-Sicherungen in ein privates GitHub-Repo. Kein Agent. |
| `koch-frage` | 20:30 | „Wie war's?“: fragt in Slack zu den heute geplanten Gerichten nach einer Bewertung (⭐1–5) fürs Tandoor-Kochprotokoll. Kein Agent. |
| `wochenrueckblick` | So 19:30 | Wochenrückblick in den Slack-Kanal: neue Rezepte, Vorschläge, Gekochtes mit Bewertung, Bestand, Google-Kosten. Kein Agent. |
| `token-pruefung` | 09:05 | Prüft alle Zugangsdaten und warnt in Slack rechtzeitig vor ablaufenden Tokens (Weboberfläche → Status). Kein Agent. |

Rezeptfotos erzeugt der Container mit KI über Google Gemini „Nano Banana“ (sehr realistisch, kostenpflichtig), Cloudflare Workers AI (kostenlos) oder OpenAI; fällt Google oder OpenAI aus, springt Cloudflare ein.

**Einheitlicher Bildstil:** Alle KI-Fotos nutzen denselben Stil – Tisch, Licht, Perspektive und Geschirr stehen in [`agents/bild-stil.md`](agents/bild-stil.md). Neue Rezepte (Links, Reels, Fotos, Text) bekommen immer ein KI-Foto in diesem Stil, auch wenn die Quelle ein eigenes Foto hat; der Agent beschreibt dafür nur, wie das Gericht aussieht (anhand des Quellfotos bzw. der Standbilder aus dem Video). Den Stil änderst du in der Datei (gilt ab dem nächsten Bild, über GitHub ohne Neustart); `/bild-alle` bringt alle vorhandenen Rezepte auf den Stil. `BILD_EINHEITLICH=aus` nimmt stattdessen wieder das Foto der Quelle. Jedes KI-Bild bekommt in Tandoor das Schlagwort **`ki-bild`** (zum Filtern); intern merkt sich der Agent Modell, Datum und Stil. Ersetzt du ein KI-Bild in Tandoor durch ein eigenes Foto, verschwindet das Schlagwort beim nächsten täglichen Abgleich.

**Bilder beim Prüfen:** Auch Verbesserungsvorschläge bringen das Bild auf den einheitlichen Stil – hat das Original schon ein KI-Bild im aktuellen Stil, bleibt es, sonst erzeugt der Agent ein neues. Beim **Übernehmen** wird das alte Bild vorher gesichert (`daten/rezepte/sicherungen`, wie bei `/bild-neu`); klappt die Sicherung nicht, bleibt das alte Bild. Jeder Vorschlag in Slack hat den Knopf **🎨 Neues Bild** – damit lässt sich ein Bild nachträglich (neu) erzeugen, z. B. wenn es beim Anlegen nicht geklappt hat; das zählt nicht gegen `BILD_PRO_TAG`. Der Knopf (wie auch **🎨 Bild erzeugen** bei `/ohne-bild`) öffnet ein kleines Fenster, in das du optional schreibst, was anders sein soll („mehr Soße, von oben fotografiert“). Leer lassen ergibt ein normales neues Bild.

**Sprache:** Deutsch oder Englisch – in der Weboberfläche unter **Einstellungen → Allgemein → Sprache** (oder `SPRACHE=de|en`). Die Sprache gilt für neue Rezepte und Verbesserungsvorschläge (der Agent übersetzt vorhandene Rezepte nach und nach, wenn er sie prüft), für alle Slack-Nachrichten und Knöpfe und für die Weboberfläche. Für Englisch gibt es einen eigenen Standard ([`agents/rezept-standard.en.md`](agents/rezept-standard.en.md)) mit englischen Einheiten (`tbsp`, `tsp`, `piece` …). Die Slack-Befehle heißen auf Englisch `/stats`, `/open`, `/recipe`, `/no-image`, `/new-image`, `/all-images`, `/check`, `/check-recipe`, `/per-day`, `/neurons`, `/help`; die deutschen Namen funktionieren weiter. Mit `SLACK_APP_ID`/`SLACK_CONFIG_TOKEN` trägt die Brücke die englischen Befehle selbst in Slack ein. Status-Schlagwörter in Tandoor (`geprüft`, `vorschlag-offen`, `nicht-bearbeiten`) und die Logs bleiben deutsch.

## Einrichten mit Portainer

Das Programm kommt als **fertiges Image** aus GitHub: Bei jedem Push auf `main` (und jeden Montag mit frischem Claude Code) baut GitHub Actions `ghcr.io/sebastianinthewild/rezept-agent:latest` (`.github/workflows/image.yml`). `portainer/stack-host.yml` startet dieses Image; die Daten liegen in **einem Ordner auf dem Docker-Host** (`AGENTS_HOST_DIR`, Standard `./`; in Portainer einen absoluten Pfad eintragen, siehe [Zugangsdaten](#zugangsdaten)):

```
AGENTS_HOST_DIR/
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

### Sicherungen in der Weboberfläche

Unter **Sicherungen** (Reiter oben) stehen alle Bilder, die vor `/bild-neu`, `/bild-alle` oder einer Wiederherstellung gesichert wurden (`daten/rezepte/sicherungen`, 180 Tage), jeweils neben dem aktuellen Bild des Rezepts. **Öffnen**, **Herunterladen**, **Wiederherstellen** (setzt das Bild wieder ins Rezept; das aktuelle wird vorher gesichert, das Merkmal `ki-bild` entfällt) und **Löschen**. Rezept-Sicherungen (JSON vor einem übernommenen Verbesserungsvorschlag) lassen sich herunterladen. Mit der GitHub-Sicherung kommen dazu die in Tandoor gelöschten Rezepte und Sicherungen, die lokal schon aufgeräumt sind.

### GitHub-Sicherung

Täglich (Standard 03:30, im Zeitplan änderbar oder **Jetzt sichern**) sichert der Container alle Rezepte in ein **privates GitHub-Repo** – über die GitHub-API, ohne git im Container:

| Im Repo | Was |
| --- | --- |
| `rezepte/<id> - <Name>/rezept.json`, `bild.*` | aktueller Stand jedes Rezepts mit Bild, z. B. `rezepte/12 - Lasagne/`; ältere Stände stehen in der Git-Historie. Ändert sich der Name, zieht der Ordner mit |
| `geloescht/<id> - <Name>/` | in Tandoor gelöschte Rezepte mit Löschdatum – in der Weboberfläche unter **Sicherungen** mit einem Klick (samt Bild) wieder anlegen oder als JSON herunterladen |
| `sicherungen/` | alles aus `daten/rezepte/sicherungen`, dort aber dauerhaft (lokal nach 180 Tagen aufgeräumt) |
| `index.json` | Übersicht |

Übertragen wird nur, was sich geändert hat. Fehlen plötzlich mehr als die Hälfte der Rezepte (oder alle), bricht der Abgleich ab, statt alles als gelöscht zu markieren – etwa wenn Tandoor gerade nicht erreichbar ist. Gelöschte Rezepte und Fehler meldet er im Slack-Kanal.

**Einrichten:** auf GitHub ein **privates, leeres** Repo anlegen (z. B. `rezepte-sicherung`), dann unter GitHub → Settings → Developer settings → **Fine-grained tokens** einen Token nur für dieses Repo mit **Contents: Read and write** erstellen. In der Weboberfläche unter Einstellungen → GitHub-Sicherung `BACKUP_REPO` (`besitzer/name`) und `BACKUP_TOKEN` eintragen, neu starten. Bilder werden für die Sicherung verkleinert: JPEG mit etwa 85 % Qualität, höchstens 1600 Pixel breit (typisch wenige hundert KB statt 1–2 MB je KI-Bild). Das gilt für die Rezeptbilder in GitHub und für die Bild-Sicherungen vor dem Ersetzen (`daten/rezepte/sicherungen`). Einstellbar unter Einstellungen → GitHub-Sicherung (`SICHERUNG_BILDER_KOMPRIMIEREN=aus` sichert die Originale, `SICHERUNG_BILD_BREITE` ändert die Breite). Beim ersten Lauf danach werden alle Rezeptbilder einmal verkleinert neu hochgeladen; die großen Originale bleiben in der Git-Historie des Repos.

### Wochenplan und „Was koche ich?“

- **`/wochenplan [Tage] [Wünsche]`** – der Agent `wochenplan` wählt aus euren Rezepten: nur Hauptgerichte, abwechslungsreich (Fleisch/Fisch/vegetarisch, keine Hauptzutat zweimal hintereinander), unter der Woche schnell, saisonal, gut bewertet, nichts kürzlich Gekochtes oder Geplantes. Wünsche haben Vorrang. Mit **🛒 In Essensplan + Einkaufsliste** landet er im Tandoor-Essensplan (Mahlzeit `WOCHENPLAN_MAHLZEIT`, Standard Abendessen; `WOCHENPLAN_PORTIONEN`, Standard 2) und die Zutaten auf der Einkaufsliste. Antwort im Thread tauscht einzelne Gerichte.
- **Automatisch:** Im Zeitplan beim Agenten „Wochenplan“ z. B. `So 17:00` eintragen – dann kommt jeden Sonntag ein Plan für die nächsten 7 Tage in den Kanal.
- **`/was-kochen Zucchini, Feta`** – Rezepte, die diese Zutaten enthalten (Tandoor-Lebensmittel), die mit allen zuerst. Ohne Claude.
- **„Wie war's?“** – Um 20:30 (`koch-frage` im Zeitplan) fragt die Brücke zu jedem Gericht, das heute im Tandoor-Essensplan steht, wie es war: **⭐1–5** oder **Nicht gekocht**. Die Bewertung landet im Kochprotokoll von Tandoor; daraus berechnet Tandoor Bewertung und „zuletzt gekocht“ – genau danach wählt der Wochenplan aus. Gilt auch für Einträge, die ihr direkt in Tandoor geplant habt. Jede Frage kommt nur einmal, ein zweiter Klick trägt nichts doppelt ein.
- **Wochenrückblick** – sonntags um 19:30 (`wochenrueckblick`): neue Rezepte, übernommene und verworfene Vorschläge, was noch offen ist, was gekocht und wie bewertet wurde (mit dem besten Gericht), der Bestand und die geschätzten Google-Kosten der Woche. In der Weboberfläche auch mit **Jetzt senden**.

### Doppelte Rezepte und Sprachnachrichten

- **Doppelte:** Hat ein neues Rezept (fast) denselben Namen wie ein vorhandenes – gleich ohne Satzzeichen und Zusätze in Klammern, oder der eine Name steckt ganz im anderen („Lasagne“ / „Lasagne Bolognese“) –, zeigt der Vorschlag „🔁 Gibt es vielleicht schon“ mit Link. Der Knopf **🔁 Als Verbesserung für „…“** macht daraus einen Verbesserungsvorschlag für das vorhandene Rezept: Übernehmen ersetzt dann dessen Inhalt (die alte Fassung und das alte Bild werden gesichert), statt ein zweites Rezept anzulegen.
- **Sprachnachricht:** Einfach in den Rezept-Kanal sprechen (Slack-Audioclip) oder eine Video-Datei schicken. Gemini (`GEMINI_API_KEY`) hört bzw. sieht sich die Aufnahme an und schreibt Zutaten, Mengen und Schritte heraus, unklare Stellen extra; der Agent macht daraus den Entwurf (fehlende Mengen geschätzt und in den Änderungen genannt). Bei Videos gibt es Standbilder wie bei Reels.

### Status und ablaufende Tokens

Die Weboberfläche hat den Reiter **Status**: Für Tandoor, Slack, Claude, Google Gemini, die GitHub-Sicherung, Cloudflare und OpenAI steht dort, ob die Verbindung klappt, die Zugangsdaten gelten und wann der Token abläuft – mit Hinweis, wo man ihn erneuert und einträgt. Ablaufdaten kommen, wo es geht, vom Dienst selbst: GitHub (Fine-grained Token), Cloudflare und Tandoor. Slack-Bot-Tokens und Google-Schlüssel laufen nicht ab. Beim Claude-Token aus `claude setup-token` verrät das niemand: Die Oberfläche nimmt 365 Tage ab dem ersten Einsatz an (`CLAUDE_TOKEN_GUELTIG_TAGE`) – genauer wird es, wenn du das Datum unter Einstellungen → Claude als `CLAUDE_TOKEN_ABLAUF` einträgst. Wie lange der Token wirklich gilt, legt Anthropic fest; deshalb ist die Annahme einstellbar.

**Rechtzeitige Meldung:** Jeden Morgen um 09:05 (`token-pruefung`) prüft die Brücke alles und schreibt in den Kanal, wenn ein Token in höchstens 14 Tagen abläuft (`TOKEN_WARNUNG_TAGE`), noch einmal 3 Tage vorher und am Ablauftag – und einmal, wenn Zugangsdaten nicht (mehr) funktionieren. Ein neuer Token setzt die Warnungen zurück. Gespeichert wird nur ein Fingerabdruck des Tokens, nie der Token selbst (`daten/token-status.json`).

### Nährwerte

Neue Rezepte und Verbesserungsvorschläge bekommen **Nährwerte pro Portion** (Kalorien, Eiweiß, Fett, Kohlenhydrate) als Tandoor-**Eigenschaften** – so zeigt Tandoor sie im Rezept an. Der Agent schätzt sie aus Zutaten und Mengen (Schlagwort „Nährwerte geschätzt“) oder übernimmt sie aus der Quelle (z. B. HelloFresh). Im Vorschlag in Slack stehen sie als „Pro Portion: …“. Fehlende Eigenschafts-Typen legt der Container in Tandoor an; andere Eigenschaften eines Rezepts bleiben erhalten. Bereits geprüfte Rezepte bekommen Nährwerte, sobald sie wieder geprüft werden.

### Claude-Limit

Läuft ein Agent ins Claude-Nutzungslimit („You've hit your limit“), startet er alle 30 Minuten neu (`CLAUDE_WIEDERHOLEN_MIN`), bis es wieder geht – höchstens 24 Stunden lang. Im Kanal kommt dazu eine Meldung, nach dem Nachholen ein „✅ hat geklappt“. Aufträge aus Slack (Link, Foto, Wochenplan) holt die Brücke genauso nach und schreibt die Uhrzeit in den Thread. Die Weboberfläche zeigt den nächsten Versuch.

**KI-Anbieter: Claude oder Google Gemini:** Unter Einstellungen → KI-Anbieter legt `KI_ANBIETER` fest, wer Rezepte importiert und prüft und den Wochenplan macht:

| `KI_ANBIETER` | Verhalten |
| --- | --- |
| leer bzw. `claude,google` | Claude; am Claude-Limit macht sofort Google Gemini weiter (Standard) |
| `google,claude` | Gemini zuerst; klappt es nicht, Claude |
| `claude` | nur Claude; am Limit alle 30 Minuten erneut (wie früher) |
| `google` | nur Gemini, Claude wird nie gestartet |

Gemini braucht den Google-API-Schlüssel (derselbe wie für die KI-Fotos), Modell `GEMINI_TEXT_MODELL` (Standard `gemini-flash-latest`). Es bekommt dieselben Anweisungen wie der Agent (`prompt.md`) und alle Daten, die der Agent sonst selbst holen würde (Auftrag, Standard, Link- und Video-Auslese, Fotos, Rezepte), und antwortet in einer Anfrage; das Ergebnis läuft durch dieselbe Prüfung (bei Fehlern bis zu zwei Korrekturen). Jeder Vorschlag sagt in den Änderungen „Erstellt mit Google Gemini …“ (am Limit mit „– bitte genauer ansehen“), beim Wochenplan steht es in der Zusammenfassung. Claude arbeitet als Agent in mehreren Schritten und ist bei schwierigen Quellen meist gründlicher; Gemini kostet pro Anfrage (`/google` zählt mit), Claude ist im Abo enthalten. Welche Agenten Gemini übernehmen kann, steht in `agent.json` unter `"fallback"`.

### Einstellungen in der Weboberfläche

Unter **Einstellungen** (Reiter oben) lassen sich Zugangsdaten und Optionen eintragen: Claude, Tandoor, Slack, KI-Fotos (Anbieter, Google-Modell, Schlüssel), Bilder pro Tag, Abgleich. Sie haben Vorrang vor den Umgebungsvariablen aus Portainer und liegen in `daten/umgebung.json` (nur für den Container-Benutzer lesbar). Leeres Feld bzw. „Eintrag löschen“ = wieder den Wert aus Portainer nehmen. Änderungen gelten nach **Jetzt neu starten**. Tokens und Schlüssel lassen sich nur ändern, wenn `WEB_PASSWORT` gesetzt ist; angezeigt werden sie nur gekürzt (`••••1234`). `WEB_PASSWORT` selbst bleibt in Portainer, damit man sich nicht aussperrt.

Die Weboberfläche läuft auf Port 8080 (`WEB_PORT`, Passwort über `WEB_PASSWORT`). Dort stellst du die Zeiten ein, siehst Status und letzten Lauf und startest Agenten mit **Jetzt starten** sofort. Die Rezept-Statistik schickst du mit **Jetzt senden** sofort in den Slack-Kanal. Bei „Rezept-Qualität“ stellst du ein, wie viele Rezepte pro Tag geprüft werden (Standard 5, gespeichert in `daten/rezepte/einstellungen.json`).

Slash-Befehle in Slack (Antwort nur für dich sichtbar; `/pruefen`, `/pruefen-rezept`, `/ohne-bild`, `/bild-neu`, `/bild-alle` und `/pro-tag <Zahl>` nur im Rezept-Kanal; englische Namen siehe oben):

| Befehl | Was er macht |
| --- | --- |
| `/statistik` | Rezept-Statistik: gesamt, geprüft, offen, noch zu prüfen, ohne Bild |
| `/offen` `[neu]` | Vorschläge, die auf eine Entscheidung warten, mit Link. `/offen neu` schickt alle offenen Vorschläge und Wochenpläne noch einmal in den Kanal, mit den aktuellen Knöpfen (z. B. **🎨 Neues Bild**). Die alte Nachricht wird zum Verweis auf die neue, Antworten in ihrem Thread funktionieren weiter |
| `/rezept <Name>` | Rezept in Tandoor suchen, mit Status |
| `/ohne-bild [Anzahl \| Name]` | Rezepte ohne Bild, jedes als eigene Nachricht im Kanal mit Knopf **🎨 Bild erzeugen** (KI-Foto direkt in Tandoor, danach **🔄 Anderes Bild erzeugen**). Ohne Angabe 5 Stück; schon gezeigte kommen erst nach 7 Tagen wieder, mit Name wird gezielt gesucht. Ein eigenes Foto wird nie ersetzt. |
| `/bild-neu <Name \| ID>[: Wunsch]` | Neues KI-Bild mit Google (`GOOGLE_BILD_MODELL`) für ein Rezept, auch wenn es schon ein Foto hat. Nach einem Doppelpunkt optional, was anders sein soll, z. B. `/bild-neu Lasagne: mehr Käse, von oben`. Bei mehreren Treffern zeigt er die Liste mit IDs. |
| `/bild-alle` | Rezeptbilder mit Google neu erzeugen: **alle**, **nur ohne KI-Bild** (eigene Fotos, Rezepte ohne Bild) oder **nur alter Stil** (KI-Bilder, die vor einer Änderung an `agents/bild-stil.md` entstanden sind). Fragt zweimal nach (mit Anzahl und geschätzten Kosten), nur wer fragt, darf bestätigen. Läuft im Hintergrund mit Fortschritt und Knopf **⏹️ Anhalten**, nach einem Neustart geht es weiter. Nach 3 Fehlern hintereinander (z. B. Google-Kontingent) hält er an. |
| `/pruefen [Anzahl]` | Qualitätsprüfung jetzt starten; mit Anzahl darf er heute so viele Rezepte zusätzlich zum Tageswert prüfen |
| `/pruefen-rezept <Name \| ID>` | Ein Rezept gezielt sofort neu prüfen – auch wenn es schon geprüft, abgelehnt oder auf „nicht bearbeiten“ gesetzt ist; zählt nicht zum Tageswert |
| `/pro-tag [Anzahl]` | Rezepte pro Tag anzeigen oder ändern (wie in der Weboberfläche) |
| `/neuronen` | Heute noch freie Cloudflare-Neuronen für KI-Fotos |
| `/google` | Google-Nutzung diesen Monat: Bilder, Videos, geschätzte Kosten, heute, Vormonat und – mit `GOOGLE_GUTHABEN` – Rest-Guthaben. Bei 80 % kommt einmal eine Warnung in den Kanal. Geschätzt aus den eigenen Aufrufen (Google liefert den Kontostand nicht über den API-Schlüssel). |
| `/wochenplan [Tage] [Wünsche]` | Essensplan aus euren Rezepten, z. B. `/wochenplan 5 vegetarisch, schnell` (Standard 7 Tage ab morgen). Knöpfe **🛒 In Essensplan + Einkaufsliste**, **📅 Nur Essensplan**, **Verwerfen**; Antwort im Thread tauscht Gerichte („Mittwoch lieber Fisch“). Siehe [Wochenplan](#wochenplan-und-was-koche-ich). |
| `/was-kochen <Zutaten>` | Rezepte mit diesen Zutaten, z. B. `/was-kochen Zucchini, Feta` – die mit allen Zutaten zuerst (⭐). Ohne Claude, direkt aus Tandoor. |
| `/hilfe` | Übersicht |

Bei `/bild-neu` und `/bild-alle` wird das alte Bild vorher in `daten/rezepte/sicherungen` gesichert (180 Tage). Lässt es sich nicht sichern, bleibt das Rezept unverändert. Beide nutzen nur Google, ohne Cloudflare als Ersatz, und zählen nicht gegen `BILD_PRO_TAG`.

**Meldung nach Neustart:** Nach jedem Start des Containers (Update, Neustart aus der Weboberfläche, Server-Neustart, Absturz) schreibt der Agent in den Rezept-Kanal, dass er wieder läuft – mit Version und ob es ein Update war („von … auf …“). Abschalten mit `NEUSTART_MELDUNG=aus` oder in der Weboberfläche unter Einstellungen → Slack.

**Version:** Jedes Image trägt eine Version aus dem Zeitpunkt des Commits auf main, z. B. `2026-11-03 10-11` (deutsche Zeit). Jeder gemergte Pull Request, der das Programm ändert, ergibt so automatisch eine neue Version; der wöchentliche Neubau mit frischem Claude Code behält sie. Die Version steht oben rechts in der Weboberfläche (Klick führt zum Commit), in der Neustart-Meldung, unter `/hilfe` und beim Start im Container-Log. Jede Version gibt es auch als Image-Tag, z. B. `ghcr.io/sebastianinthewild/rezept-agent:2026-11-03_10-11` – zum gezielten Zurückgehen `IMAGE_TAG` darauf setzen. Lokal gebaut heißt sie `dev`. Im [CHANGELOG](CHANGELOG.md) steht jede Änderung unter ihrer Version mit Pull Request und Image-Tag; nach jedem Merge trägt GitHub Actions die neue Version dort selbst ein.

## Rezepte von HelloFresh

Tandoors eigener Import kann HelloFresh-Seiten nicht lesen. Für HelloFresh-Links (alle Länderseiten, z. B. `hellofresh.de/recipes/…`) liest der Container das Rezept deshalb selbst aus den Daten der Seite: Zutaten mit Mengen je Portionszahl (der Agent nimmt 2 Portionen), Schritte mit den jeweils verwendeten Zutaten, Utensilien, Zeiten. Packungsangaben wie „1 Packung Kochsahne“ ergänzt der Agent um die übliche Menge. Blockt HelloFresh den Abruf, bittet er um einen Screenshot der Rezeptkarte oder den Text.

## Rezepte aus Reels und Shorts

Einen Link zu einem **Instagram-Reel** oder **YouTube-Short** (auch TikTok und normale YouTube-Videos bis 10 Minuten) einfach in den Rezept-Kanal schicken:

1. `yt-dlp` holt Bildunterschrift und Video, `ffmpeg` zieht Standbilder.
2. **Gemini** sieht sich das Video an und schreibt heraus, was gesagt und eingeblendet wird – Zutaten, Mengen, Schritte (nutzt `GEMINI_API_KEY`, Modell `GEMINI_VIDEO_MODELL`, Standard `gemini-flash-latest`; unter 1 Cent pro Reel). Ohne Schlüssel gibt es nur Bildunterschrift und Standbilder.
3. Der Agent setzt daraus das Rezept zusammen. Verweist die Bildunterschrift auf einen Blog mit dem ganzen Rezept, nimmt er bevorzugt diesen. Das Rezeptfoto ist ein KI-Foto im einheitlichen Stil. Der Agent beschreibt das Gericht anhand der Standbilder, und bei Google geht das Standbild vom fertigen Gericht als **Vorlage** mit: Das KI-Foto zeigt das Essen so wie im Video (Farbe, Form, Belag), Tisch, Licht und Perspektive kommen weiter aus `agents/bild-stil.md`. **🎨 Neues Bild** am Vorschlag erzeugt dagegen normal, ohne Vorlage. Cloudflare und OpenAI bekommen nur die Beschreibung.

Instagram blockt Abrufe ohne Anmeldung manchmal. Dann antwortet der Agent im Thread und bittet um die Bildunterschrift als Text oder einen Screenshot. Wird das häufig, hilft eine Cookie-Datei eines (am besten zweiten) Instagram-Kontos: `VIDEO_COOKIES=/data/daten/cookies.txt` (Netscape-Format, z. B. mit einer Browser-Erweiterung „Get cookies.txt“ exportiert). Automatisches Abrufen ist bei Instagram nicht erlaubt; das Konto kann gesperrt werden.

**Text einfügen:** Längerer Text ohne Link (ab etwa 80 Zeichen oder 3 Zeilen), z. B. eine kopierte Bildunterschrift, wird ebenfalls als Rezept angelegt.

## Zugangsdaten

In Portainer unter „Environment variables“ (bzw. in `.env`) stehen nur noch die Werte, die vor dem Start feststehen müssen (Vorlage: `.env.example`):

- **AGENTS_HOST_DIR:** Ordner auf dem Docker-Host für Zeitplan, Agenten und Daten. Standard `./`. In Portainer immer einen absoluten Pfad eintragen, z. B. `/home/benutzer/docker/rezepte`, weil `./` dort in Portainers eigenen Stack-Ordner zeigt.
- **TZ:** Zeitzone, Standard `Europe/Berlin`.
- **WEB_PASSWORT**, **WEB_ZUGANGSDATEN_OHNE_PASSWORT:** siehe unten. Eins von beiden braucht es, damit du die Zugangsdaten in der Weboberfläche eintragen kannst.
- optional **PUID**/**PGID** (Benutzer im Container, Standard 1000), **WEB_DOMAIN**, **IMAGE_TAG**.

Alles andere trägst du in der Weboberfläche unter **Einstellungen** ein (gespeichert in `daten/umgebung.json`, gilt nach dem Neustart). Das sind:

- **SPRACHE:** `de` (Standard) oder `en`.
- **CLAUDE_CODE_OAUTH_TOKEN:** auf einem Rechner mit Claude Code `claude setup-token` ausführen.
- **TANDOOR_URL**, **TANDOOR_TOKEN:** Tandoor → Einstellungen → API, Scope „read write“.
- **SLACK_BOT_TOKEN**, **SLACK_APP_TOKEN**, **SLACK_CHANNEL:** Slack-App „Rezept-Helfer“ aus `slack-app-manifest.yml` anlegen. In den Kanal kommen auch Meldungen über fehlgeschlagene Läufe.
- **GEMINI_API_KEY:** für KI-Fotos mit Google Nano Banana (optional, ca. 0,03–0,04 $ pro Bild). Schlüssel unter [aistudio.google.com](https://aistudio.google.com) → „Get API key“, Abrechnung muss aktiviert sein. Modell wählen mit `GOOGLE_BILD_MODELL`: `gemini-nano-banana-2.1` (Standard), `gemini-2.5-flash-image` (günstiger) oder `gemini-3-pro-image` (beste Qualität).
- **SLACK_APP_ID**, **SLACK_CONFIG_TOKEN:** optional, damit Änderungen an `slack-app-manifest.yml` (z. B. neue Befehle) von selbst in Slack landen. App-ID unter api.slack.com/apps → Rezept-Helfer → Basic Information; Token unter api.slack.com/apps → ganz unten „Your App Configuration Tokens“ → Generate Token, davon den **Refresh Token** (`xoxe-1-…`). Den erneuert der Container danach selbst (`daten/slack-config-token.json`).
- **BILD_ANBIETER:** optional `google`, `cloudflare` oder `openai`; ohne Angabe Google vor Cloudflare vor OpenAI. **BILD_PRO_TAG:** höchstens so viele KI-Fotos pro Tag; leer = unbegrenzt (ausdrücklich angeforderte wie /bild-neu, /bild-alle oder 🎨 Neues Bild zählen nie).
- **CF_ACCOUNT_ID**, **CF_AI_TOKEN:** für KI-Fotos (optional, kostenlos; mit Google als Ersatz). Damit nach jedem Foto und mit `/neuronen` in Slack die freien Neuronen angezeigt werden, braucht der Token zusätzlich die Berechtigung „Account Analytics: Read“.
- **OPENAI_API_KEY:** optional, für KI-Fotos mit OpenAI GPT Image (kostenpflichtig).
- Außerdem: Claude-API-Schlüssel statt Token, Wartezeit nach dem Claude-Limit, Video-Einstellungen samt Cookie-Datei für Instagram, Wochenplan, GitHub-Sicherung und der Abgleich mit GitHub (Repo, Branch, `app/`).

Nur in Portainer bzw. `.env`:

- **WEB_PASSWORT:** Passwort für die Weboberfläche (HTTP-Anmeldung). Leer = kein Login. Ohne Passwort lassen sich dort keine Zugangsdaten ändern – außer mit **WEB_ZUGANGSDATEN_OHNE_PASSWORT=an**: dann geht es auch ohne Login. Das nur setzen, wenn die Seite anders geschützt ist, z. B. im Nginx Proxy Manager per **Access List** nur aus dem Heimnetz (`192.168.0.0/16`) erreichbar. Der Schalter lässt sich bewusst nur in Portainer/`.env` setzen, nicht in der Weboberfläche; dort erscheint dann ein Hinweis.

## Einrichten mit Docker Compose

Baut das Image lokal aus diesem Repo (statt es aus GitHub zu laden):

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

## Tests

Jeder Pull Request wird in GitHub Actions geprüft (`.github/workflows/test.yml`): Syntax aller Programmdateien, die Tests in `test/` mit nachgebautem Tandoor, Slack, Google und GitHub (keine echten Zugangsdaten nötig) und ob sich das Docker-Image bauen lässt. Lokal:

```sh
node --test --test-force-exit "test/*.test.mjs"
```

## Lizenz

MIT · Autor: SebastianInTheWild
