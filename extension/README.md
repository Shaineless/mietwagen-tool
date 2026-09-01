# Preisleser — Browser-Erweiterung

Liest die Preise aus Trefferlisten, die du selbst öffnest, und reicht sie an den
lokal laufenden Dienst weiter.

## Rückfallebene, nicht der Normalweg

**Für den Alltag wird sie nicht gebraucht.** Der Preisabruf läuft heute über ein
eigenes, unsichtbares Chrome-Fenster, das der Dienst selbst startet und per CDP
steuert — ohne Erweiterung, ohne sichtbare Tabs. Warum ausgerechnet so und
welche Wege daran gescheitert sind, steht in
[../tools/README-preise.md](../tools/README-preise.md).

Diese Erweiterung war der ursprüngliche Weg, bevor sich der CDP-Ansatz als
tragfähig erwies. Sie bleibt erhalten für den Fall, dass Chrome den Debug-Port
sperrt oder auf dem Rechner gar kein Chrome installiert ist: dann laufen die
Seiten in **deiner** echten Sitzung, in Tabs, die du selbst öffnest, und die
Erweiterung liest nur ab, was ohnehin auf dem Bildschirm steht.

Der Preis dafür: die Tabs sind sichtbar.

## Installieren

1. `node build.mjs` ausführen (erzeugt `extension/content.js`).
2. In Chrome `chrome://extensions` öffnen.
3. Oben rechts **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** und den Ordner `extension` auswählen.

Die Erweiterung braucht keinen Neustart. Nach jedem `node build.mjs` genügt ein
Klick auf das Neuladen-Symbol der Erweiterung.

## Benutzen

1. Dienst starten: `node tools/serve.mjs`
2. <http://127.0.0.1:4173/> öffnen — oben im Ergebnisbereich muss der
   Preisdienst als laufend gemeldet sein.
3. Suche zusammenstellen, **Im Browser öffnen** klicken.
4. Die Tabs laden, suchen selbständig und melden ihre Preise zurück. Die
   Tabelle füllt sich nach und nach.

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

- Meldet das Tool den Preisdienst als laufend? Sonst läuft `tools/serve.mjs` nicht.
- Läuft der Dienst auf einem anderen Port als 4173 oder 4174? Dann in
  `chrome://extensions` bei der Erweiterung unter *Service Worker* die Konsole
  öffnen und `chrome.storage.local.set({mwtPort: <port>})` ausführen.
- Zeigt der Eintrag *„Zugriff von der Seite blockiert"*, hat Sixt den Tab
  abgewiesen. Meist hilft, ihn kurz später erneut zu öffnen und weniger Tabs
  gleichzeitig zu starten.
