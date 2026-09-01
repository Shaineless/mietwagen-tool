# Preise automatisch auslesen — Stand und Wege

## Was versucht wurde

Ein Playwright-Worker (`tools/browser.mjs`, `tools/scrape/sixt.mjs`) öffnet
`sixt.de` headless, lehnt den Cookie-Banner ab, füllt die Suchmaske aus den
URL-Parametern, löst die Suche aus und liest die Angebotskacheln
(`[data-testid="rent-offer-list-tile"]`) aus.

Technisch funktioniert die Kette bis zur Trefferliste. Dort kommt:

```
Access denied. Oops! You've hit a speed bump on our digital highway.
Your request has been blocked.
```

Begleitet von durchgehenden 403ern auf die internen Endpunkte. Sixt erkennt den
automatisierten Browser und sperrt den Zugriff aktiv.

## Warum hier Schluss ist

Es gäbe eine Tarnkappen-Schicht (`navigator.webdriver` fälschen, Fingerabdruck
angleichen, `playwright-extra` mit Stealth-Plugin). Die ist bewusst **nicht**
eingebaut.

Eine öffentlich ausgelieferte Seite zu lesen ist das eine — so sind die
Stationsdaten entstanden, aus den für Suchmaschinen freigegebenen
Stationsseiten. Eine ausdrücklich ausgesprochene Zugriffssperre gezielt zu
umgehen, ist etwas anderes. Dazu kommt: dieser Wettlauf ist nicht zu gewinnen.
Sixt fährt Cloudflare plus eigene Signale; jede Tarnung hält bis zum nächsten
Deploy.

Der Parser (`parseTile`, `parseAmount`) bleibt erhalten — er wird für jeden der
folgenden Wege gebraucht.

## Wege, die funktionieren

### 1. Browser-Erweiterung — empfohlen

Eine kleine Chrome-Erweiterung mit einem Content-Script auf den Sixt-Domains.
Das Tool öffnet die Tabs wie bisher; das Script liest auf der fertig geladenen
Trefferliste die Preise aus und schickt sie an den lokalen Dienst, der sie zu
einer Vergleichstabelle zusammenführt.

Entscheidender Unterschied: die Anfragen kommen aus der echten Browsersitzung
des Nutzers, mit dessen Profil, im normalen Surfverlauf. Es wird nichts
vorgetäuscht und keine Sperre umgangen — es wird nur eingesammelt, was ohnehin
schon auf dem Bildschirm steht.

Aufwand: überschaubar. Manifest V3, ein Content-Script, ein `fetch` an
`localhost`. Der Nutzer installiert sie einmalig als entpackte Erweiterung.

Einschränkung: die Tabs öffnen sich sichtbar. „Unsichtbar im Hintergrund" ist
damit nicht zu haben — das ist genau der Teil, den der Bot-Schutz verhindert.

### 2. Offizielle Schnittstelle

Sauberster Weg, wenn erreichbar. Wichtig bei der Auswahl: die Schnittstelle muss
**landesspezifische Raten** liefern. Aggregatoren wie Amadeus oder CarTrawler
geben ihre eigenen Vertragspreise zurück, nicht den Unterschied zwischen
`sixt.de` und `sixt.fr` — und genau der ist der Zweck dieses Tools.

### 3. Halbautomatisch über ein Lesezeichen

Ohne Installation: ein Bookmarklet, das der Nutzer auf einer offenen
Trefferliste anklickt. Es liest die Kacheln und schickt sie an den lokalen
Dienst. Ein Klick pro Tab statt vollautomatisch, dafür sofort einsatzbereit und
ohne jede Grauzone.

## Proxy pro Länderseite

Der Playwright-Kontext setzt den Proxy bereits pro Sitzung
(`withPage({ proxy })`), das bleibt nutzbar, sobald ein Weg oben trägt. Für die
Erweiterungs-Variante übernimmt das ein Proxy-Switcher im Browser des Nutzers,
der pro Domain regelt.
