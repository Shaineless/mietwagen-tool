# Mietwagen-Preistool

Öffnet dieselbe Mietwagensuche gleichzeitig auf allen Sixt-Länderseiten.
Sixt ruft für identische Anfragen je nach Landesdomain unterschiedliche Preise
auf — das Tool baut die passenden Links und öffnet sie in einem Rutsch.

Neubau des [MWT-Preistools von Sloth & Crazer][mwt] (mietwagen-talk.de, 2020),
dessen URL-Format zwischenzeitlich nicht mehr funktioniert.

[mwt]: https://www.mietwagen-talk.de/forum/thread/22175-mietwagen-preistool-zum-vergleichen/

## Benutzen

```bash
node build.mjs
```

Danach `dist/mietwagen-preistool.html` im Browser öffnen — eine einzelne Datei,
kein Server, keine Installation. Funktioniert auch per Doppelklick aus dem
Dateisystem.

Zum Entwickeln mit Live-Reload-freiem Minimalserver:

```bash
node tools/serve.mjs
```

## Was es besser macht als das Original

| Original (2020) | Hier |
| --- | --- |
| `uda=01-12-2026` — von Sixt **nicht mehr ausgewertet**, Datum wurde ignoriert | `uda=20261201`, gegen die Live-Seite geprüft |
| Stationen als hartkodierte `<option>`-Listen im HTML | Stationsliste als editierbare Textdatei, Build meldet Dubletten |
| Riesige Dropdowns zum Scrollen | Suchfeld mit Umlaut- und IATA-Erkennung (`munchen`, `FRA`, `heathrow`) |
| Eine Station pro Suche | Beliebig viele Stationen gleichzeitig |
| Ein Termin pro Suche | Datums-Matrix: Abholtag ±3 Tage × mehrere Mietdauern |
| `window.open()` beim Absenden — von Browsern als Popup blockiert | Ergebnisse erst als Linkliste; „Alle öffnen" gestaffelt, mit Hinweis bei Blockade |
| Keine Persistenz | Auswahl bleibt im Browser gespeichert |
| Zugangsdaten im Formular | Optional, standardmäßig **nicht** gespeichert, mit Klartext-Warnung |
| Keine Kursinfo | Währung pro Länderseite sichtbar |

## Was es bewusst nicht tut

**Keine Preise abrufen.** Das Tool baut ausschließlich Links und öffnet sie im
Browser; die Suche macht der Nutzer auf der Anbieterseite selbst. Automatisiertes
Abfragen und Parsen der Preisseiten wäre technisch fragil (Bot-Erkennung,
Redesigns) und steht den AGB der Anbieter entgegen. Deshalb gibt es auch kein
Preis-Tracking — dieselbe Überlegung, an der die Cronjob-Idee im
Ursprungs-Thread hängengeblieben ist.

**Kein Direktsprung in die Trefferliste.** Sixts heutige Ergebnisseite
(`/betafunnel/#/offerlist`) adressiert Stationen über eine UUID, die sich aus der
Stations-ID nicht ableiten lässt. Das Tool belegt daher die Suchmaske der
jeweiligen Länderseite vor; es bleibt ein Klick auf „Suche".

## Stand der Anbieter

| Anbieter | Status |
| --- | --- |
| Sixt | **fertig**, Deep-Links gegen die Live-Seite verifiziert, 539 Stationen in 9 Ländern, 24 Länderseiten |
| Avis | offen — nutzt ein POST-Formular an `secure.avis.de`, die Feldnamen sind bekannt, das Datumsformat noch nicht |
| Europcar, Hertz, Enterprise, Carvia, Arndt | offen — Suchmasken sind JS-gesteuert, das Link-Format muss je Anbieter aus einer echten Suche abgeleitet werden |

Die Adapter-Schnittstelle in `src/providers.js` ist bereits auf mehrere Anbieter
und auf POST-Formulare ausgelegt.

## Aufbau

```
src/
  index.html            Grundgerüst
  styles.css            Darstellung, hell und dunkel
  app.js                Zustand, Suche, Kombinationslogik, Oberfläche
  providers.js          Anbieter-Adapter (URL-Bau je Anbieter)
  data/
    stations.sixt.txt   Stationsliste, von Hand erweiterbar
  stations.js           erzeugt vom Build — nicht bearbeiten
tools/
  serve.mjs             Minimalserver für die Entwicklung
  harvest-sixt.md       Anleitung: weitere Länder/Stationen nachladen
build.mjs               bündelt alles zu einer HTML-Datei
```

## Stationsliste erweitern

`src/data/stations.sixt.txt` ist eine schlichte Textdatei:

```
id|land|iata|name
110|DE|FRA|Frankfurt Flughafen (FRA)
```

Die `id` ist Sixts numerische Stations-ID (der `uci`-Parameter). Woher man sie
bekommt, steht in [tools/harvest-sixt.md](tools/harvest-sixt.md).

## Datenherkunft

Die Stations-IDs stammen aus den öffentlichen, für Suchmaschinen freigegebenen
Stationsseiten auf sixt.de, wo sie im Seitenquelltext stehen. Es wurde keine
interne API angezapft und es werden zur Laufzeit keine Daten abgerufen.
