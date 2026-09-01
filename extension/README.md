# Preisleser — Browser-Erweiterung

Liest die Preise aus den Trefferlisten, die das Preistool ohnehin öffnet, und
reicht sie an den lokal laufenden Dienst weiter. Dadurch stehen die Preise
direkt im Tool statt in 20 Tabs verteilt.

## Warum eine Erweiterung und kein Scraper

Ein automatisierter Browser (Playwright) kommt bei Sixt nicht durch — die Seite
antwortet mit *„Access denied. Your request has been blocked."* Der Weg über die
Erweiterung umgeht das nicht, sondern arbeitet damit: die Seiten laufen in
**deiner** echten Browsersitzung, mit deinem Profil, in Tabs, die du selbst
öffnest. Die Erweiterung liest nur ab, was ohnehin auf dem Bildschirm steht.

Der Preis dafür: die Tabs sind sichtbar. Vollständig unsichtbar im Hintergrund
geht es nicht — genau das verhindert der Bot-Schutz.

## Installieren

1. `node build.mjs` ausführen (erzeugt `extension/content.js`).
2. In Chrome `chrome://extensions` öffnen.
3. Oben rechts **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** und den Ordner `extension` auswählen.

Die Erweiterung braucht keinen Neustart. Nach jedem `node build.mjs` genügt ein
Klick auf das Neuladen-Symbol der Erweiterung.

## Benutzen

1. Dienst starten: `node tools/serve.mjs`
2. <http://localhost:4173/> öffnen — oben im Ergebnisbereich muss
   *„Preisdienst verbunden"* stehen.
3. Suche zusammenstellen, **Alle öffnen** klicken.
4. Die Tabs laden, suchen selbständig und melden ihre Preise zurück. Im Tool
   füllen sich die Einträge nach und nach: günstigster Gesamtpreis und Anzahl
   der gefundenen Klassen.

Die Tabs können danach geschlossen werden; die Preise bleiben im Tool stehen.

## Was sie tut, und was nicht

Sie wird **nur** aktiv, wenn die URL den Parameter `mwt=` trägt — den setzt
ausschließlich das Preistool. Ein normaler Besuch auf sixt.de bleibt komplett
unberührt: kein Auslesen, kein Senden, kein Klick.

Gesendet wird ausschließlich an `127.0.0.1` — an den Dienst auf deinem eigenen
Rechner. Nichts verlässt die Maschine. Der Dienst hält die Ergebnisse nur im
Arbeitsspeicher und vergisst sie nach einer Stunde.

Der Cookie-Banner wird mit **Ablehnen** beantwortet, nicht mit „Einverstanden".

## Dateien

| Datei | Zweck |
| --- | --- |
| `manifest.json` | Rechte und Domains |
| `content.src.js` | Ablauf im Tab: warten, Suche auslösen, Kacheln lesen |
| `content.js` | **erzeugt** — `src/offer-parse.js` + `content.src.js` |
| `background.js` | Weiterleitung an `127.0.0.1` |

`content.js` nicht von Hand bearbeiten: die Auswertung der Kacheln steht in
`src/offer-parse.js` und wird von `build.mjs` hierher kopiert, damit Erweiterung
und Node-Worker nie auseinanderlaufen.

## Wenn nichts ankommt

- Steht im Tool *„Preisdienst verbunden"*? Sonst läuft `tools/serve.mjs` nicht.
- Läuft der Dienst auf einem anderen Port als 4173 oder 4174? Dann in
  `chrome://extensions` bei der Erweiterung unter *Service Worker* die Konsole
  öffnen und `chrome.storage.local.set({mwtPort: <port>})` ausführen.
- Zeigt der Eintrag *„Zugriff von der Seite blockiert"*, hat Sixt den Tab
  abgewiesen. Meist hilft, ihn kurz später erneut zu öffnen und weniger Tabs
  gleichzeitig zu starten.
