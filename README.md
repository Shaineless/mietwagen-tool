# Mietwagen-Preistool

Öffnet dieselbe Mietwagensuche gleichzeitig auf allen Sixt-Länderseiten.
Sixt ruft für identische Anfragen je nach Landesdomain unterschiedliche Preise
auf — das Tool baut die passenden Links, öffnet sie in einem Rutsch und kann die
Preise über eine Browser-Erweiterung direkt einsammeln.

Neubau des [MWT-Preistools von Sloth & Crazer][mwt] (mietwagen-talk.de, 2020),
dessen URL-Format zwischenzeitlich nicht mehr funktioniert.

[mwt]: https://www.mietwagen-talk.de/forum/thread/22175-mietwagen-preistool-zum-vergleichen/

## Benutzen

**Nur Links** — eine einzelne Datei, kein Server, kein Installieren:

```bash
node build.mjs
```

Danach `dist/mietwagen-preistool.html` im Browser öffnen, auch per Doppelklick
aus dem Dateisystem.

**Mit Preisen** — zusätzlich der lokale Dienst und die Erweiterung:

```bash
node tools/serve.mjs
```

Dann <http://localhost:4173/> öffnen. Zur Einrichtung der Erweiterung siehe
[extension/README.md](extension/README.md).

## Betriebsarten

| | ohne Dienst | mit Dienst + Erweiterung |
| --- | --- | --- |
| Umfang | eine HTML-Datei | Datei + lokaler Node-Dienst + Chrome-Erweiterung |
| Ergebnis | Linkliste, Tabs selbst durchsehen | günstigster Preis und Klassenzahl direkt im Tool |
| Datenfluss | nichts verlässt den Browser | nur an `127.0.0.1`, eine Stunde im Arbeitsspeicher |

Das Tool erkennt beim Start selbst, welche Betriebsart verfügbar ist.

## Die drei Ansichten

- **Länder-Vergleich** — ein Anbieter, dieselbe Suche auf allen Länderseiten.
- **Anbieter-Vergleich** — ein Ort und ein Zeitraum, mehrere Vermieter
  nebeneinander. Weil Vermieter nicht dieselben Stationen haben, läuft der
  Vergleich über eine Ortsebene: Flughäfen werden über den IATA-Code exakt
  zugeordnet, alles andere über Ortsname und Stationsart und wird sichtbar als
  „ungefähr" gekennzeichnet. Anbieter ohne Station am Ort erscheinen als
  Fehlanzeige statt stillschweigend zu verschwinden.
- **Was geht gerade?** — ehrlicher Stand je Anbieter: welche Suchparameter
  nachweislich ausgewertet werden und welche verworfen.

## Was es besser macht als das Original

| Original (2020) | Hier |
| --- | --- |
| `uda=01-12-2026` — von Sixt **nicht mehr ausgewertet**, das Datum wurde ignoriert | `uda=20261201`, gegen die Live-Seite geprüft |
| Fahrzeugklasse und Prepaid als Auswahl — beide Parameter werden heute **verworfen** | entfernt statt vorgetäuscht; dadurch landet jeder Link auf der vollständigen Klassenübersicht mit allen Preisen |
| Stationen als hartkodierte `<option>`-Listen im HTML | Stationsliste als editierbare Textdatei, Build meldet Dubletten |
| Riesige Dropdowns zum Scrollen | Suchfeld mit Umlaut- und IATA-Erkennung (`munchen`, `FRA`, `heathrow`) |
| ~500 Stationen, überwiegend DACH | 1779 Stationen aus 104 Ländern — Flughäfen, Bahnhöfe, Stadt-, Hotel-, Hafen- und LKW-Stationen |
| Eine Station pro Suche | Beliebig viele Stationen gleichzeitig |
| Ein Termin pro Suche | Datums-Matrix: Abholtag ±3 Tage × mehrere Mietdauern |
| `window.open()` beim Absenden — von Browsern als Popup blockiert | Ergebnisse erst als Linkliste; „Alle öffnen" gestaffelt, mit Hinweis bei Blockade |
| Nur Sixt und Avis, fest verdrahtet | Adapter je Anbieter, GET- und POST-Formulare, Status je Anbieter sichtbar |
| Keine Preise | optional echte Preise im Tool, über die eigene Browsersitzung |
| Keine Persistenz | Auswahl bleibt im Browser gespeichert |
| Zugangsdaten im Formular | entfernt — die Login-Parameter wirken bei Sixt ohnehin nicht mehr |

## Grenzen

**Kein Direktsprung in die Trefferliste.** Sixts heutige Ergebnisseite
(`/betafunnel/#/offerlist`) adressiert Stationen über eine UUID, die sich aus der
Stations-ID nicht ableiten lässt. Das Tool belegt die Suchmaske der jeweiligen
Länderseite vor; es bleibt ein Klick auf „Suche" — den die Erweiterung
übernimmt, wenn sie läuft.

**Kein unsichtbarer Hintergrundabruf.** Ein automatisierter Browser wird von
Sixt abgewiesen („Access denied. Your request has been blocked."). Deshalb läuft
der Preisabruf über die echte Browsersitzung; die Tabs sind dabei sichtbar.
Hintergründe und die verworfenen Alternativen: [tools/README-preise.md](tools/README-preise.md).

## Stand der Anbieter

| Anbieter | Status |
| --- | --- |
| Sixt | **fertig** — Deep-Links gegen die Live-Seite verifiziert, 1779 Stationen in 104 Ländern, 23 Länderseiten, Preisauslesung |
| Avis | offen — POST-Formular an `secure.avis.de`, Feldnamen bekannt, Datumsformat noch nicht |
| Europcar, Hertz, Enterprise, Carvia, Arndt | offen — Suchmasken sind JS-gesteuert, das Link-Format muss je Anbieter aus einer echten Suche abgeleitet werden |

Die Adapter-Schnittstelle in `src/providers.js` ist auf mehrere Anbieter und auf
POST-Formulare ausgelegt.

## Aufbau

```
src/
  index.html            Grundgerüst
  styles.css            Darstellung, hell und dunkel
  app.js                Zustand, Suche, Kombinationslogik, Oberfläche
  providers.js          Anbieter-Adapter (URL-Bau, Status, Farbthemen)
  places.js             Ortsebene für den Anbieter-Vergleich
  offer-parse.js        Auswertung der Angebotskacheln — einzige Quelle
  data/
    stations.sixt.txt   Stationsliste, von Hand erweiterbar
  stations.js           erzeugt vom Build — nicht bearbeiten
extension/
  manifest.json         Manifest V3
  content.src.js        Ablauf im Tab
  content.js            erzeugt vom Build — nicht bearbeiten
  background.js         Weiterleitung an 127.0.0.1
tools/
  serve.mjs             lokaler Dienst: Oberfläche + Preiseingang
  browser.mjs           Playwright-Sitzungen (Proxy je Länderseite)
  scrape/sixt.mjs       Preisabruf per Playwright — von Sixt blockiert
  harvest-sixt.md       Anleitung: Stationen nachladen
  README-preise.md      warum der Preisabruf so läuft, wie er läuft
build.mjs               bündelt alles und verteilt den Parser
```

## Stationsliste erweitern

`src/data/stations.sixt.txt` ist eine schlichte Textdatei:

```
id|land|iata|name
110|DE|FRA|Frankfurt Flughafen (FRA)
168|DE||München Hauptbahnhof
```

Die `id` ist Sixts numerische Stations-ID (der `uci`-Parameter). Woher man sie
bekommt, steht in [tools/harvest-sixt.md](tools/harvest-sixt.md).

## Datenherkunft

Die Stations-IDs stammen aus den öffentlichen, für Suchmaschinen freigegebenen
Stationsseiten auf sixt.de, wo sie im Seitenquelltext stehen. Es wurde keine
interne API angezapft.

Die Farbthemen sind an die Hausfarben der Vermieter angelehnt und dienen der
Orientierung beim Umschalten. Keine Logos, keine Nachbildung der Originalseiten;
dies ist kein Angebot der genannten Unternehmen.
