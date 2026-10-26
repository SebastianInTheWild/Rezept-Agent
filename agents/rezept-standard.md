# Unser Rezept-Standard

Vorlage ist der **Rahmwirsing** (steht in `context` unter `reference`). So sollen alle Rezepte aussehen.

## Sprache
- **Alles auf Deutsch:** Name, Beschreibung, Geräte, Schritte, Notizen, Lebensmittel und Schlagwörter. Rezepte in anderen Sprachen (Englisch, Französisch, Italienisch …), ob als Link oder als Foto, vollständig übersetzen, nicht nur teilweise.
- Übliche deutsche Bezeichnungen nehmen („Frühlingszwiebel“ statt „scallion“, „Speisestärke“ statt „cornstarch“, „Sahne“ statt „heavy cream“). Gerichte mit eingeführtem Eigennamen behalten ihn („Tiramisu“, „Pad Thai“), bekommen aber eine deutsche Beschreibung.
- Amerikanische und britische Maße umrechnen: cups, oz, lb, fl oz, sticks in g/ml; °F in °C (350 °F = 175 °C, 400 °F = 200 °C). In `changes` nennen: „Aus dem Englischen übersetzt, Cups in g/ml umgerechnet“.

## Aufbau
- **Name:** sachlich und kurz, deutsch, ohne Werbung („Das beste … aller Zeiten“), ohne Blog- oder Markennamen, ohne „Rezept“ im Namen. Zusätze in Klammern nur, wenn sie unterscheiden („Nudelsalat mit Pesto“ statt „Tortellini Salat mit Pesto (schnelles Rezept)“). Omas Rezepte dürfen „nach Omas Rezept“ heißen.
- **Beschreibung:** ein sachlicher Satz, was es ist, z. B. „Cremiger Rahmwirsing mit Gemüsefond, Sahne und Butter.“ Kein Blog-Text.
- **Portionen:** `servings` ist die Anzahl, die Einheit heißt immer „Portionen“. Bei Kuchen, Plätzchen und Blechen die Anzahl Stücke als Portionen.
- **Zeiten:** `working_time` = aktive Arbeitszeit, `waiting_time` = Backen, Kühlen, Ruhen, Schmoren (Minuten).
- **Geräte:** `devices` = alles, was man braucht: Schüsseln, Messer, Schneidebrett, Topf, Pfanne, Backform mit Größe („Springform 26 cm“), Handmixer, Pürierstab, Backofen. Tandoor zeigt das als ersten Schritt „Benötigte Küchengeräte“.

## Schritte
- Ein Arbeitsgang pro Schritt. Lange Absätze aufteilen, Mini-Schritte zusammenfassen. Meist 3–8 Schritte.
- Imperativ, kurz und einfach: „Zwiebeln schälen und fein würfeln.“ Kein „Nun …“, „Anschließend …“, kein „man“, keine Ich-Form, keine Tipps aus Blogs im Schritt.
- Temperaturen in °C mit Art: „bei 180 °C Ober-/Unterhitze“ oder „Umluft“.
- **Schritt-Zeit:** `time` = Minuten, die der Schritt dauert, wenn darin gewartet, gebacken, gekocht oder gekühlt wird (Tandoor zeigt einen Timer). Reine Handgriffe ohne Wartezeit: 0.
- **Zutaten je Schritt:** Jede Zutat steht bei dem Schritt, in dem sie zuerst gebraucht wird. Keine Zutat doppelt, keine fehlt.

## Zutaten
- Menge, Einheit und Lebensmittel getrennt. Eigenschaften und Zubereitung in `note`: „fein gehackt“, „weich“, „Saft“, „optional“, „etwas“, „nach Geschmack“.
- **Einheiten** nur aus der Liste in `context` (`units`), metrisch: g, kg, ml, l, EL, TL, Prise, Stück, Zehe, Bund, Dose, Päckchen, Becher, Glas, Scheiben … Keine Tassen und Cups mehr – umrechnen (1 Tasse ≈ 150 ml bzw. Mehl ≈ 100 g, Zucker ≈ 150 g). Ganze Dinge (Ei, Zwiebel, Apfel) mit „Stück“.
- **Lebensmittel:** möglichst ein vorhandenes aus `foods` nehmen, im Singular und ohne Zusätze („Zwiebel“, nicht „Zwiebeln“ oder „rote Zwiebel, gewürfelt“). Neu nur, wenn es wirklich etwas anderes ist.
- Salz, Pfeffer, Wasser zum Abschmecken ohne Menge: `no_amount: true` (ohne Einheit), Notiz z. B. „nach Geschmack“.
- Kaufbare Zutaten brauchen eine Menge, damit die Einkaufsliste stimmt. Fehlt sie, schätze sinnvoll und schreib es in `changes`.
- Eine Zutat = ein Lebensmittel. „Salz, Pfeffer“ wird zu zwei Zutaten. „Butter oder Margarine“ → „Butter“ mit Notiz „oder Margarine“.

## Schlagwörter (`keywords`)
Vorhandene nehmen (siehe `context`). Jedes Rezept bekommt:
- **Aufwand:** genau eins von Einfach, Mittel, Anspruchsvoll
- **Geschmack:** Süß oder Herzhaft
- **Art:** z. B. Hauptgericht, Vorspeise, Salat, Suppe, Soße, Dip, Dessert, Süßspeise, Kuchen, Torte, Blechkuchen, Gebäck, Plätzchen, Backen, Getränk
- **Hauptzutaten:** 1–3, z. B. Kartoffeln, Hackfleisch, Sahne, Zwiebel
- „Nährwerte geschätzt“ bleibt, wenn es schon da war.
Status-Schlagwörter (geprüft, vorschlag-offen, nicht-bearbeiten) setzt das Werkzeug selbst.
