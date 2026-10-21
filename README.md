# myFitness (private Web-App)

Trainingsplan, Ernährungs-Zähler mit Barcode-Scanner und Trainingslog. Läuft als Web-App mit Symbol auf dem
Home-Bildschirm (PWA). Alle Dateien liegen bewusst flach in einem Ordner, damit sie sich auch vom iPhone aus hochladen lassen. **Alle persönlichen Daten liegen nur auf dem Gerät** (IndexedDB). Dieses Repository
enthält nur den Programmcode, keine persönlichen Daten.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `index.html` | Die bestehende App (Training · Ernährung · Eintragen), übernommen aus der Claude-Version |
| `localdb.js` | Lokaler Speicher. Bildet die Datenbank-Schnittstelle der Claude-Version nach (`claude.use("db")`), deshalb blieb der App-Code fast unverändert. Export/Import für Sicherung und Umzug |
| `nutrition.js` | Reine Nährwert-Logik: Open-Food-Facts-Daten übernehmen, Mengen umrechnen, Prüfziffern. Automatisch getestet |
| `scan.js` | Scanner-Ansicht, Produktsuche, eigene Produkte und Korrekturen |
| `app.js` | Daten-Menü (Sicherung), Meldungen, Offline-Betrieb und Updates |
| `barcode-detector-ponyfill.js`, `zxing_reader.wasm` | Barcode-Erkennung [barcode-detector](https://github.com/Sec-ant/barcode-detector) 3.2.2 + zxing-wasm 3.1.3 (MIT). Liegt lokal und funktioniert offline |
| `docs.js` | Ausführliche Erklärungen (Trainings- und Ernährungsplan, Stand 15.10.2026) für das Buch-Symbol oben rechts |
| `photo.js` | Foto-Mahlzeit: Foto → Analyse mit Google Gemini (Schlüssel nur auf dem Gerät) → Prüfen/Korrigieren → Speichern |
| `bls.js` | Nährwert-Datenbank Bundeslebensmittelschlüssel 4.0 (optional, aus der offiziellen Excel-Datei erzeugt) |
| `recipes.js` | Rezeptbereich: Suche, Filter, Portionsrechner, Favoriten, eigene Rezepte, „Zum Tagebuch“ |
| `recipes-data.js` | Rezeptbibliothek (40 KI-erstellte Rezepte, Nährwerte aus BLS berechnet), erzeugt mit `tests/build_recipes.py`, wird erst beim Öffnen des Tabs geladen |
| `sw.js` | Service Worker: App-Dateien offline verfügbar |

## Daten

Die Sammlungen `sessions`, `daily`, `weekly` und `food` sind unverändert aus der Claude-Version übernommen.
Neu hinzugekommen sind `products`, `recipes` (eigene Rezepte) und `recipeFavs` (Favoriten). Alle sind Teil der Sicherung.

- **`products/<barcode>`**: `code` (immer als Text, damit führende Nullen erhalten bleiben), `name`, `brand`, `basis` (`g`/`ml`),
  `per100`, `perServing`, `prepared100` (je kcal/p/c/f/sugar/fiber/salt, fehlende Werte = `null`), `servingQty`, `packQty`,
  `source` (`off`/`own`), `custom` (persönliche Korrekturen, nur Abweichungen), `lastUsed`.
- **Ernährungseintrag (in `food/<datum>.entries`)**: `name`, `kcal`, `p`, `f`, `c` werden als Momentaufnahme gespeichert. Gescannte
  Einträge haben zusätzlich `code`, `amount`, `unitKey`, `qty`, `unit`, `basis` und `prepared`. Eine spätere Korrektur am Produkt ändert
  alte Tage deshalb nicht.

## Regeln der Nährwertberechnung

- Werte werden pro 100 g bzw. pro 100 ml berechnet. Gramm und Milliliter werden nie gleichgesetzt. Ist die Einheit unklar, wird g angenommen und das sichtbar markiert.
- „Portion“ und „Packung“ gibt es nur, wenn die Menge dazu bekannt ist. Mehrfachpackungen wie „4 × 125 g“ werden nicht geraten.
- Fehlt ein Wert, bleibt er `null`, wird als „fehlt“ angezeigt und nicht als 0 gezählt.
- Ist nur kJ angegeben, wird umgerechnet (kcal = kJ / 4,184) und das markiert.
- Werte für das zubereitete Produkt bleiben getrennt und werden nur auf ausdrückliche Auswahl verwendet.
- Gespeichert wird mit 1 Nachkommastelle, gerundet wird erst für die Anzeige.

## Open Food Facts

- `GET https://world.openfoodfacts.org/api/v2/product/<code>.json?fields=…`: es werden nur die benötigten Felder abgefragt.
- Pro Scan geht **nur die Barcode-Nummer** raus, nie ein Bild. Die Bilderkennung läuft auf dem Gerät.
- Abgerufene Produkte werden lokal gespeichert, ein erneuter Scan braucht kein Netz. Eigene Produkte werden nie überschrieben, Korrekturen bleiben auch bei „Daten neu laden“ erhalten.
- Grenze: Open Food Facts erlaubt 15 Produktabfragen pro Minute. Die App bremst selbst bei 10 pro Minute.
- Lizenz: Daten unter ODbL, Bilder unter CC BY-SA. Der Hinweis steht in der App, im Daten-Menü.
- Es wird nichts zu Open Food Facts hochgeladen.

## Tests

```
node --test tests/*.test.js                         # Rechenlogik (19 Tests)
python3 tests/e2e.py <video.y4m> <screenshot-ordner> # Browser-Ablauf mit simulierter Kamera (34 Prüfungen)
python3 tests/migration_offline.py <umzug.json> <ordner>   # Import + Offline-Start
```

Das Testvideo erzeugt `tests/make_barcode.py 4006381333931 <ziel>`. Die Browser-Tests laufen in Chromium mit simulierter
Kamera und nachgestellter Open-Food-Facts-Antwort. **Sie ersetzen keinen Test auf dem echten iPhone.**

## Updates veröffentlichen

1. Dateien ändern.
2. In `sw.js` die Versionsnummer in `CACHE` erhöhen.
3. Hochladen (Push).

Die App zeigt dann „Neue Version verfügbar“ an.

## Foto-Mahlzeiten

- Analyse: Google Gemini API (`generateContent`, Modell `gemini-3.5-flash-lite` (schnell), Ersatz `gemini-3.8-flash` mit begrenztem Denken), kostenloses Kontingent.
- Vermittler: Cloudflare Worker (`worker/worker.js`, wird in Cloudflare eingefügt, NICHT auf GitHub Pages benötigt). Der Gemini-Schlüssel liegt nur dort als geheime Variable `GEMINI_API_KEY`. Der Worker prüft Herkunft (`https://madtillo.github.io`), App-Passwort (`APP_TOKEN`) und erlaubte Modelle.
- Die App speichert nur Worker-Adresse und App-Passwort lokal (Sammlung `settings`, nicht Teil der Sicherung).
- Gesendet wird ein auf max. 1024 px verkleinertes JPEG (ohne Metadaten) plus Auftragstext – erst nach Tippen auf „Analysieren“. Das Foto wird nicht gespeichert.
- Die KI liefert Bestandteile, Zustand (roh/gegart) und geschätzte Gramm. Nährwerte pro 100 g kommen aus der BLS-Datenbank, KI-Richtwerte nur als gekennzeichneter Ersatz.
- Jede KI-Antwort wird geprüft (`Nutri.mealValidate`): unplausible Mengen und Werte werden verworfen.
- Gespeichert wird als normaler Tageseintrag mit `src: "photo"`, `mealId`, `cat`, `fraction` und allen Bestandteilen. Dadurch lässt sich der Eintrag später bearbeiten.
- Tests: `tests/meal.test.js` (Logik), `tests/worker.test.mjs` (Worker-Schutz), `tests/photo_e2e.py` (Ablauf über den lokal gestarteten Worker mit nachgestellten Gemini-Antworten).

## Rezepte

- Bibliothek: 40 KI-erstellte Rezepte (je ≥ 10 für Frühstück, Mittag/Meal Prep, Abend, Snack), als „KI-erstellt“ gekennzeichnet.
- Nährwerte: aus Grammangaben × BLS 4.0 pro 100 g berechnet. Gewürze in kleinen Mengen werden angezeigt, aber nicht eingerechnet. Fehlende Werte zählen nie als 0 („unvollständig“, „Zum Tagebuch“ gesperrt).
- Einheiten: Stück/EL/TL usw. werden nie automatisch in Gramm umgerechnet – jede Zutat hat eine feste, sichtbare Gramm-Angabe (≈ … g).
- Portionen: „Zubereiten für“ skaliert Zutaten und Gesamtwerte, die Werte pro Portion bleiben gleich. „Gegessen“ in halben Schritten.
- Tagebuch: Eintrag mit `src: "recipe"`, `recipeId`, `portions`, `per` (Werte pro Portion) – Momentaufnahme, spätere Rezeptänderungen ändern ihn nicht.
- Bibliotheksrezepte bearbeiten → eigene Variante (`basedOn`), das Original bleibt unverändert.
- „Proteinreich“ = mind. 25 g Eiweiß pro Portion und mind. 25 % der Kalorien aus Eiweiß.
- Tests: `tests/recipe.test.js` (Logik), `tests/recipes_e2e.py` (Ablauf im Browser).

## App-Symbol

- Aktuell: 3D-Hantel (icon-512.png, icon-192.png, apple-touch-icon.png).
- Vorheriges Hantel-Symbol bleibt erhalten: `icon-512-hantel-alt.png`, `icon-192-hantel-alt.png`, `apple-touch-icon-hantel-alt.png`. Zum Zurückwechseln diese Dateien auf die Namen ohne „-hantel-alt“ kopieren.
