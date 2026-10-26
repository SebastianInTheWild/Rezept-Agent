# Unser Zuhause – Agenten

Ein Docker-Container, in dem KI-Agenten (Claude Code) nach Zeitplan für Home Assistant arbeiten. Jeder Agent ist ein Ordner unter `agents/` mit einer Anweisung und einem Zeitplan. Neue Agenten legst du als neuen Ordner an, ohne den Container neu zu bauen.

| Agent | Zeit | Was er macht |
|---|---|---|
| `automationen` | 08:00 | Gibt neuen Automationen einen sprechenden Namen, eine Beschreibung, Labels und eine Kategorie. Danach kommt ein Push mit der Übersicht. |
| `log-detektiv` | täglich 07:30 | Liest neue Fehler im HA-Protokoll, gruppiert sie, erklärt Ursache und Lösung, merkt sich harmlose Meldungen. Push bei wichtigen Funden und Dashboard **Log-Detektiv** (Befunde, Verlauf, harmlose Meldungen). |
| `energie-coach` | So 18:00 | Wertet die letzten 7 Tage aus (PV, Akku, Netz, Geräte, Laufzeiten von Trockner & Co.) und schickt 1–2 konkrete Tipps per Push. Erkennt Datenlücken. |
| `automations-doktor` | Sa 09:00 | Prüft alle Automationen (fehlende/ausgefallene Entitäten, Fehler in Läufen, Stillstand) und schreibt den Befund ins Dashboard **Automations-Doktor**, ohne Push. |

## Agent „Automationen sortieren“

- Er bearbeitet nur **neue** Automationen. Beim ersten Start merkt er sich alle vorhandenen als erledigt.
- Automationen mit dem Label **Test** (`SKIP_LABEL`) lässt er aus. Nimmst du das Label weg, kommt die Automation beim nächsten Lauf dran.
- Seinen Plan schreibt er in `/data/automationen/plan.json`, die einzige Datei, die er schreiben darf. `apply` prüft ihn, bevor etwas geändert wird.
- Er ändert nur Name, Beschreibung, Kategorie und Labels, **nie** Auslöser, Bedingungen oder Aktionen. Das Werkzeug prüft das vor und nach dem Speichern.
- Er nimmt bevorzugt Kategorien und Labels, die schon an deinen Automationen hängen. So bleibt alles einheitlich. Passt keine, legt er selbst eine neue Kategorie oder ein neues Label an, aber höchstens 2 pro Lauf (`MAX_NEW`). Das gilt nur für Themen, unter die weitere Automationen passen, und immer mit Icon und Beschreibung. Gibt es den Namen in HA schon, nutzt er den vorhandenen Eintrag. Der Push nennt, was neu angelegt wurde. Ist etwas unklar oder kaputt, vergibt er „Prüfen“.
- Vorhandene Labels nimmt er nie weg.
- Vor jeder Änderung sichert er den alten Stand (`/data/automationen/backups/`).
- Gibt es nichts Neues, startet Claude gar nicht. Dann entstehen auch keine Kosten.

## Einrichten mit Portainer: Ordner auf dem Host (empfohlen)

`portainer/stack-host.yml` legt alles in **einen Ordner auf dem Docker-Host** (Standard `/home/sebastian/docker/agents`, änderbar mit `AGENTS_HOST_DIR`). Der Container heißt `agents` und läuft als Benutzer 1000. So kannst du alle Dateien direkt bearbeiten, ohne `sudo` und ohne den Stack zu ändern.

```
/home/sebastian/docker/agents/
  zeitplan.conf   wann welcher Agent läuft
  agents/         ein Ordner je Agent (agent.json + prompt.md), _vorlage zum Kopieren
  app/            Programm
  daten/          Merklisten, Logs, Sicherungen je Agent
  npm/            Claude Code
```

**Zeiten ändern** in `zeitplan.conf`. Die Änderung gilt nach spätestens 30 Sekunden, ohne Neustart. Der Container-Log meldet dann „Zeitplan geändert“.

```
automationen       = 08:00
log-detektiv       = 07:30
energie-coach      = So 18:00
automations-doktor = Sa 09:00; Mi 18:00   # mehrere Zeiten mit ;
mein-agent         = aus                  # pausiert
```

Ein Eintrag in `zeitplan.conf` hat Vorrang vor `schedule`/`enabled` aus der `agent.json`. Fehlt ein Agent in der Datei, gilt seine `agent.json`. Eine neu eingetragene Zeit, die heute schon vorbei ist, gilt erst ab morgen.

**Neuer Agent:** `agents/_vorlage` kopieren, z. B. `cp -r agents/_vorlage agents/batterien`, dann `prompt.md` und `agent.json` anpassen (`"enabled": true`) und in `zeitplan.conf` eine Zeile `batterien = 07:00` ergänzen. Ein Neustart ist nicht nötig.

## Einrichten mit Portainer (ohne Build)

`portainer/stack.yml` ist ein fertiger Stack ohne eigenes Image: Er nutzt `node:22-bookworm-slim`, die App- und Agenten-Dateien stecken direkt im Stack, und Claude Code installiert sich beim ersten Start ins Volume.

1. Portainer → Stacks → *Add stack* → *Web editor* → Inhalt von `portainer/stack.yml` einfügen.
2. Unter *Environment variables* `HA_TOKEN` und `CLAUDE_CODE_OAUTH_TOKEN` setzen (optional `HA_URL`, `NOTIFY_PERSONS`).
3. *Deploy the stack*.

Nach Änderungen an `app/` oder `agents/` die Datei mit `node tools/build-stack.mjs` neu erzeugen und den Stack in Portainer damit aktualisieren.

**Volume-Variante** (`portainer/stack-volume.yml`): Programm und Agenten liegen im Volume unter `/data/app` und `/data/agents`. Updates und neue Agenten kommen dann ohne Stack-Änderung dazu: Dateien ins Volume legen, Container neu starten. Das ist praktisch, weil eine Stack-Änderung über die Portainer-API die Umgebungsvariablen (Tokens) neu setzen würde. Claude Code aktualisierst du mit der Variable `CLAUDE_UPDATE=1` und einem Neustart.

## Einrichten mit Docker Compose

1. Ordner auf den Docker-Host kopieren.
2. `.env.example` nach `.env` kopieren und ausfüllen:
   - **HA_TOKEN:** In Home Assistant unter Profil → Sicherheit → *Langlebige Zugriffstoken* einen Token „Agenten“ erstellen.
   - **CLAUDE_CODE_OAUTH_TOKEN:** Auf einem Rechner mit Claude Code `claude setup-token` ausführen. Der Token läuft über dein Claude-Abo.
   - **NOTIFY_PERSONS:** Wer die Pushs bekommt, z. B. `person.sebastian`. Dafür braucht es die Integration [Unser Zuhause](https://github.com/SebastianInTheWild/ha-unser-zuhause-integration).
3. Starten:

```sh
docker compose up -d --build
docker compose logs -f
```

## Bedienen

```sh
docker compose exec agents node /app/scheduler.mjs list              # Agenten und Zeiten
docker compose exec agents node /app/scheduler.mjs run automationen  # sofort einmal laufen lassen
docker compose exec agents sh -c 'DRY=1 node /app/scheduler.mjs run automationen'  # nur zeigen, nichts ändern
docker compose exec agents ls /data/automationen/logs                # Logs je Tag
```

Zum Ausprobieren an bestehenden Automationen: `FORCE_IDS=automation.a,automation.b` zusammen mit `DRY=1` setzen.

Verpasst der Container eine Uhrzeit, weil er aus war, holt er den Lauf am selben Tag nach, sobald er wieder läuft.

### Dashboard „Agenten“ in Home Assistant

Der Scheduler legt in Home Assistant selbst ein Dashboard **Agenten** an (nur für Admins, in der Seitenleiste). Es zeigt je Agent:

- **Status** als Sensor `sensor.agent_<id>`: läuft, wartet, erfolgreich, fehlgeschlagen, nichts zu tun
- Zeitplan, nächster Lauf, letzter Lauf mit Ergebnis, Dauer und Auslöser (Zeitplan, von Hand, Slack …), dazu die letzten Protokollzeilen
- Knopf **Jetzt starten** (`input_button` „Agent <Name>“, mit Rückfrage)

Ein Druck auf den Knopf reiht den Agenten ein. Er startet innerhalb von etwa 30 Sekunden, sobald kein anderer Agent läuft. Die Vorprüfung gilt auch hier: Gibt es nichts zu tun, startet Claude nicht.

- Es gibt keinen offenen Port. Der Container fragt Home Assistant ab, die Anmeldung läuft über HA.
- Agenten mit `"manual": false` in der `agent.json` bekommen keinen Knopf, ihr Status wird trotzdem angezeigt.
- Auch pausierte Agenten (`aus` in `zeitplan.conf`) lassen sich von Hand starten.
- Das Dashboard wird bei neuen oder geänderten Agenten neu geschrieben. Eigene Änderungen daran gehen dabei verloren.
- `CONTROL=off` schaltet die Steuerung ab. `CONTROL_DASHBOARD` ändert die Adresse (Standard `dashboard-agenten`, Home Assistant verlangt einen Bindestrich).

## Eigenen Agenten anlegen

1. `agents/_vorlage` kopieren, z. B. nach `agents/batterien`. Ordner mit `_` am Anfang werden ignoriert.
2. In `prompt.md` beschreiben, was der Agent tun soll.
3. In `agent.json` einstellen:

| Feld | Bedeutung |
|---|---|
| `name`, `description` | Anzeige und Push-Titel bei Fehlern |
| `enabled` | `false` = pausiert |
| `schedule` | Uhrzeiten, z. B. `["08:00", "20:00"]`, mit Wochentagen `["So 18:00"]` oder `["Mo,Mi,Fr 07:30"]`, in Abständen `["alle 5 min"]` |
| `precheck` | Befehl vorab. Gibt er `0` aus, startet Claude nicht (spart Kosten). |
| `init` | Befehl, der nur beim allerersten Lauf ausgeführt wird |
| `allowedTools` | Was der Agent darf, z. B. `Bash(node ha.mjs states:*)`. Alles andere ist gesperrt. |
| `env` | zusätzliche Umgebungsvariablen nur für diesen Agenten |
| `manual` | `false` = kein Knopf „Jetzt starten“ im Dashboard „Agenten“ |
| `icon` | Symbol im Dashboard „Agenten“, z. B. `mdi:stethoscope` |
| `maxTurns`, `model` | Grenzen für Claude |

Das Werkzeug `app/ha.mjs` kann Zustände lesen (`states`), Pushs schicken (`notify`) und Automationen sortieren (`automations …`). Für neue Aufgaben bekommt es neue Befehle, damit jeder Agent genau das darf, was er braucht, und nicht mehr.

## Lizenz

MIT · Autor: SebastianInTheWild
