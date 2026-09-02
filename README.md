# TRACKER

*Mietwagen. Vergleichen. Losfahren.*

Stellt dieselbe Mietwagensuche auf allen Sixt-Länderseiten gegenüber. Sixt ruft
für identische Anfragen je nach Landesdomain unterschiedliche Preise auf — das
Werkzeug fragt sie im Hintergrund ab und stellt sie Klasse für Klasse
nebeneinander, inklusive der Schutzpakete, die den Endpreis wirklich bestimmen.

Neubau des [MWT-Preistools von Sloth & Crazer][mwt] (mietwagen-talk.de, 2020),
dessen URL-Format zwischenzeitlich nicht mehr funktioniert.

[mwt]: https://www.mietwagen-talk.de/forum/thread/22175-mietwagen-preistool-zum-vergleichen/

## Benutzen

**Als Programm:** `dist/Tracker.exe` doppelklicken. Eine einzelne Datei, keine
Installation, kein Node nötig. Nach der Startanimation öffnet sich ein eigenes
Programmfenster — keine Konsole, keine Adresszeile, keine Tabs, eigener Eintrag
in der Taskleiste. Fenster zu heisst Programm beendet. Alles, was es schreibt,
landet im Ordner `Tracker-Daten` daneben.

**Aus dem Quellbaum:** Doppelklick auf `TRACKER starten.cmd`, oder von Hand:

```bash
node build.mjs
node tools/serve.mjs
```

Dann <http://127.0.0.1:4173/> öffnen.

Ohne den Dienst läuft `dist/tracker.html` auch per Doppelklick aus dem
Dateisystem — dann allerdings nur als Linkliste, ohne Preisabruf. Die
Oberfläche erkennt beim Start selbst, welche Betriebsart verfügbar ist, und sagt
es oben an.

### Die EXE selbst bauen

```bash
npm install
npm run exe
```

Fünf Schritte: Oberfläche bauen, den Dienst samt Playwright mit esbuild in eine
CommonJS-Datei bündeln, daraus einen SEA-Vorrat erzeugen, den in eine Kopie von
`node.exe` einspritzen und im PE-Kopf das Subsystem von Konsole auf Fenster
stellen. Ergebnis: ~96 MB, davon ist das meiste die Node-Laufzeit.

Ein Browser kommt **nicht** mit — auch nicht für das Fenster. Chrome und Edge
zeichnen mit `--app=` ein Fenster ohne Adresszeile und Tabs, das von aussen ein
gewöhnliches Programmfenster ist; ein eigenes Profil gibt ihm einen eigenen
Eintrag in der Taskleiste. Electron hätte dafür ein zweites, vollständiges
Chromium mitgebracht — rund 150 MB für ein Fenster, das der installierte
Browser genauso zeichnet. Und da ist ohnehin eines: der Preisabruf braucht ein
echtes, installiertes Chrome, weil ein mitgebrachtes von Sixt abgewiesen würde.

Weil die EXE kein Konsolenfenster mehr hat, schreibt sie ihr Protokoll nach
`Tracker-Daten/tracker.log`, und was den Start verhindert, kommt als
Meldungsfenster auf den Bildschirm. Wann das Programm endet, sagt die Seite im
Fenster selbst: sie meldet sich alle 15 Sekunden und verabschiedet sich beim
Schliessen. Am Chrome-Prozess lässt sich das nicht ablesen — Chrome reicht
Fenster zwischen seinen Prozessen weiter, der gestartete Prozess endet dabei,
das Fenster bleibt stehen.

Zwei Dinge, die beim Weitergeben zu erwarten sind: Windows SmartScreen warnt
beim ersten Start, weil die Datei nicht signiert ist (eine Code-Signatur kostet
Geld und läuft auf einen Namen), und manche Virenscanner sind bei frisch
gebauten SEA-Dateien misstrauisch.

## Was es tut

- **Preise je Länderseite.** 29 Sixt-Domains, dieselbe Station, derselbe
  Zeitraum. Der Abruf läuft in einem eigenen Chrome-Fenster außerhalb des
  sichtbaren Bereichs; man merkt nichts davon.
- **ACRISS-Codes als Vergleichsschlüssel.** Die Klassennamen unterscheiden sich
  je Sprache, der Vier-Buchstaben-Code nicht. Dazu Fahrzeugbild und Modellname
  aus der Angebotskachel.
- **Schutzpakete mit echtem Endpreis.** Jedes Paket wird in der Kasse angeklickt
  und die Gesamtsumme abgelesen — der Tagespreis mal Miettage zu rechnen lag bis
  zu 26 % daneben. Station und Termin sind dort umschaltbar.
- **Frühbucherrabatt sichtbar.** Er läuft nicht auf allen Länderseiten
  gleichzeitig; ohne den Hinweis wäre der Vergleich verzerrt.
- **Mehrere Stationen und Termine.** Datums-Matrix von −5 bis +5 Tagen um den
  Stichtag, dazu beliebige Mietdauern.
- **Klassen, die gerade nicht buchbar sind,** bleiben als Zeile stehen und
  werden markiert, statt aus der Tabelle zu verschwinden.
- **Preisentwicklung.** Jeder Abruf hinterlässt einen Messpunkt; daraus wird
  eine Kurve je Länderseite. Beantwortet die Frage, die kein Vergleichsportal
  ehrlich beantwortet: wird es billiger, wenn ich warte?
- **Preiswecker.** Eine Suche wird alle paar Stunden selbst nachgeprüft und
  meldet sich, wenn der Preis unter eine Grenze fällt — nur solange das
  Programm läuft, im Hintergrund bleibt nichts zurück.
- **Monatsübersicht.** Eigener Bereich: Station, Länderseite, Fahrzeugklasse,
  Mietdauer, erster Abholtag, Anzahl der Tage und Abholzeit frei wählbar.
  Rechnet jeden Abholtag durch und färbt einen Kalender danach ein. Im Test
  München Flughafen, dieselbe Dauer: 111 € am günstigsten, 317 € am teuersten
  Tag — 186 % Unterschied allein durch den Abholtag.
- **Als CSV speichern**, Notiz je gespeicherter Suche, Einweg-Miete direkt in
  der Stationsauswahl.
- **Abbrechen** mitten im Abruf.
- **Startanimation und Hintergrund.** Beim Öffnen läuft der Vorspann; ein Klick
  überspringt ihn. Der Hintergrund ist wählbar — Tracker (mintfarbene
  Lichtspuren), Space, Sakura, Sixt-Orange oder aus. Die Bewegung bleibt oben
  und endet oberhalb der Preistabelle: unter Zahlen, die man vergleicht, darf
  nichts wandern.

Was bewusst **nicht** drin ist: Währungsumrechnung (verglichen wird nur innerhalb
derselben Währung), Statusrabatte für Gold/Platin/Diamond (gezeigt werden nur
abgelesene Preise) und jede Form von Tarnkappen-Technik gegenüber Sixt.

Der Bildschirm **„Was geht gerade?"** im Werkzeug führt denselben Stand live —
inklusive der Zahlen dieses Rechners.

## Was es besser macht als das Original

| Original (2020) | Hier |
| --- | --- |
| `uda=01-12-2026` — von Sixt **nicht mehr ausgewertet**, das Datum wurde ignoriert | `uda=20261201`, gegen die Live-Seite geprüft |
| Fahrzeugklasse und Prepaid als Auswahl — beide Parameter werden heute **verworfen** | entfernt statt vorgetäuscht; dadurch landet jede Suche auf der vollständigen Klassenübersicht |
| Stationen als hartkodierte `<option>`-Listen im HTML | Stationsliste als editierbare Textdatei, Build meldet Dubletten |
| Riesige Dropdowns zum Scrollen | Suchfeld mit Umlaut- und IATA-Erkennung (`munchen`, `FRA`, `heathrow`) |
| ~500 Stationen, überwiegend DACH | 2250 Stationen aus 108 Ländern — Flughäfen, Bahnhöfe, Stadt-, Hotel-, Hafen- und Agenturstationen |
| Eine Station pro Suche | Beliebig viele Stationen gleichzeitig, oben umschaltbar |
| Ein Termin pro Suche | Datums-Matrix: Abholtag ±5 Tage × mehrere Mietdauern |
| `window.open()` beim Absenden — von Browsern als Popup blockiert | Preise landen direkt in der Tabelle; die Linkliste bleibt als Rückfallebene |
| Keine Preise | Preise, Schutzpakete und Endpreise im Werkzeug |
| Keine Persistenz | Auswahl bleibt im Browser gespeichert |
| Zugangsdaten im Formular | entfernt — die Login-Parameter wirken bei Sixt ohnehin nicht mehr |

## Grenzen

**Kein Direktsprung in die Trefferliste.** Sixts Ergebnisseite
(`/betafunnel/#/offerlist`) adressiert Stationen über eine UUID, die sich aus der
Stations-ID nicht ableiten lässt. Der gebaute Link belegt die Suchmaske vor; beim
Preisabruf drückt das Werkzeug den Suchknopf selbst.

**Chrome oder Edge muss installiert sein.** Ohne bleibt der Link-Modus. Warum der
Abruf ausgerechnet über ein selbst gestartetes Chrome läuft und welche
Alternativen daran gescheitert sind, steht in
[tools/README-preise.md](tools/README-preise.md).

**Es bricht, wenn Sixt umbaut.** Dann meldet der Eintrag den Grund, statt still
falsche Zahlen zu zeigen.

**Preise sind Momentaufnahmen.** Kein Dauer-Tracking, keine Historie. Ergebnisse
liegen im Arbeitsspeicher und verfallen nach einer Stunde.

## Stand der Anbieter

| Anbieter | Status |
| --- | --- |
| Sixt | **fertig** — Preise, Schutzpakete, 2250 Stationen in 108 Ländern, 29 Länderseiten |
| Avis | offen — POST-Formular an `secure.avis.de`, Feldnamen bekannt, Datumsformat noch nicht |
| Europcar, Hertz, Enterprise, Carvia, Arndt | offen — Suchmasken sind JS-gesteuert, das Link-Format muss je Anbieter aus einer echten Suche abgeleitet werden |

Die Adapter-Schnittstelle in `src/providers.js` ist auf mehrere Anbieter und auf
POST-Formulare ausgelegt.

## Aufbau

```
src/
  index.html            Grundgerüst
  styles.css            Darstellung: Nachtblau, Mint, Bahnschrift
  app.js                Zustand, Suche, Tabellen, Oberfläche
  hintergrund.js        bewegter Hintergrund, Themen und Auswahl
  providers.js          Anbieter-Adapter (URL-Bau, Status, Farbthemen)
  offer-classes.js      ACRISS-Decoder, inklusive Sixts eigener Buchstaben
  offer-parse.js        Auswertung der Angebotskacheln — einzige Quelle
  places.js             Ortsebene, vorbereitet für den Anbietervergleich
  bilder/
    tracker-logo.png    Logo, vom Build eingebettet
    tracker-intro.mp4   Startanimation, vom Build eingebettet
  data/
    stations.sixt.txt   Stationsliste, von Hand erweiterbar
  stations.js           erzeugt vom Build — nicht bearbeiten
extension/
  manifest.json         Manifest V3
  content.src.js        Ablauf im Tab
  content.js            erzeugt vom Build — nicht bearbeiten
  background.js         Weiterleitung an 127.0.0.1
tools/
  serve.mjs             lokaler Dienst: Oberfläche, Warteschlange, API
  pfade.mjs             wo gelesen und geschrieben wird — Quellbaum oder EXE
  fenster.mjs           das Programmfenster (Chrome/Edge im --app-Modus)
  meldung.mjs           Protokolldatei und Meldungsfenster ohne Konsole
  browser.mjs           Chrome starten und verbinden, Cookie-Banner
  katalog.mjs           merkt sich gesehene ACRISS-Klassen je Station
  beobachtung.mjs       Messpunkte für die Preiskurve (preisverlauf.jsonl)
  wecker.mjs            Preiswecker: anlegen, prüfen, auslösen
  selbsttest.mjs        prüft die ganze Kette auf einem fremden Rechner
  scrape/sixt.mjs       Preisliste auslesen
  scrape/sixt-schutz.mjs Schutzpakete in der Kasse durchklicken
  try-quote.mjs         Handprobe: eine Preisliste auslesen
  try-schutz.mjs        Handprobe: die Schutzpakete einer Klasse
  try-laender.mjs       prüft Länderseiten, die noch nicht im Register stehen
  try-waehrung.mjs      zeigt, wie eine Länderseite ihre Preise schreibt
  harvest-sixt.md       Anleitung: Stationen nachladen
  README-preise.md      warum der Preisabruf so läuft, wie er läuft
build.mjs               bündelt alles und verteilt den Parser
build-exe.mjs           baut daraus die einzelne Windows-EXE
TRACKER starten.cmd     bauen, Dienst starten, Browser öffnen
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

Fahrzeugbilder und Preise stammen von Sixt. Die Farbthemen sind an die
Hausfarben der Vermieter angelehnt und dienen der Orientierung. Keine Logos,
keine Nachbildung der Originalseiten; dies ist kein Angebot der genannten
Unternehmen.

## Lizenz

[MIT](LICENSE) für den Quelltext. Marken, Logos, Fahrzeugbilder und Preisdaten
der Sixt SE gehören ihr und sind davon nicht erfasst. Dieses Projekt steht in
keiner Verbindung zur Sixt SE.

Das Werkzeug ist für die eigene Suche gedacht. Wer es weitergibt oder
öffentlich betreibt, sollte vorher klären, ob das mit Sixts
Nutzungsbedingungen vereinbar ist — beim Abrufen im eigenen Browser ist die
Lage eine andere als bei einem Dienst, der für viele Leute gleichzeitig
abfragt.
