# Tills Fitness (private Web-App)

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
| `sw.js` | Service Worker: App-Dateien offline verfügbar |

## Daten

Die Sammlungen `sessions`, `daily`, `weekly` und `food` sind unverändert aus der Claude-Version übernommen.
Neu hinzugekommen ist `products`.

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
