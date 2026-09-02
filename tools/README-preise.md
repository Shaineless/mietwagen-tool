# Wie der Preisabruf funktioniert

Kurzfassung: Der Dienst startet **dein eigenes, installiertes Chrome** mit einem
separaten Profil und einem Debug-Port, hängt sich per CDP daran, öffnet die
Anbieterseiten und liest die Preise. Das Fenster steht außerhalb des
sichtbaren Bildschirmbereichs, man merkt nichts davon.

## Warum ausgerechnet so

Das ist nicht die naheliegende Lösung, sondern die einzige, die trägt. Der Reihe
nach gemessen, alles am selben Beispiel (Frankfurt Flughafen, 01.–05.12.):

| Ansatz | Ergebnis |
| --- | --- |
| `fetch()` aus Node | **403** von Cloudflare, noch vor dem HTML |
| Playwright `chromium.launch()`, headless | *Access denied. Your request has been blocked.* |
| Playwright `launch({channel:'chrome'})`, headless | ebenfalls blockiert |
| Playwright `launch({channel:'chrome'})`, sichtbar | ebenfalls blockiert |
| **Chrome selbst starten + `connectOverCDP`** | **50 von 50 Kacheln** |
| dasselbe, Fenster außerhalb des Bildschirms | **50 von 50 Kacheln** |

Der Unterschied liegt nicht am Headless-Modus, sondern daran, **wie** der Browser
startet: Playwright setzt Automatisierungs-Flags und legt ein Wegwerfprofil an.
Ein normal gestartetes Chrome mit `--remote-debugging-port`, an das man sich
nachträglich anhängt, sieht aus wie ein Browser, weil es einer ist.

Wichtig für spätere Änderungen: **nicht auf `chromium.launch()` „vereinfachen".**
Das sieht kürzer aus und funktioniert nicht.

## Was bewusst nicht drin ist

Es gäbe eine Tarnkappen-Schicht, `navigator.webdriver` fälschen, Fingerabdruck
angleichen, `playwright-extra` mit Stealth-Plugin. Die ist **nicht** eingebaut,
und zwar nicht aus Bequemlichkeit: eine ausdrücklich ausgesprochene
Zugriffssperre gezielt zu umgehen ist etwas anderes, als öffentliche Seiten zu
lesen oder einen echten Browser zu benutzen. Der Weg über das eigene Chrome
braucht sie ohnehin nicht.

## Aufbau

```
tools/browser.mjs        Chrome finden, starten, verbinden; Cookie-Banner
tools/scrape/sixt.mjs    Ablauf je Anfrage, Trefferliste auslesen
src/offer-parse.js       Kachel-Auswertung, einzige Quelle, vom Build verteilt
tools/serve.mjs          Warteschlange (2 parallel), Ergebnisspeicher, API
```

Die Warteschlange arbeitet höchstens zwei Anfragen gleichzeitig ab, mit
mindestens 1,5 Sekunden Abstand pro Host. Das ist bewusst zurückhaltend.

Ergebnisse liegen nur im Arbeitsspeicher und verfallen nach einer Stunde.

## Grenzen

- **Chrome oder Edge muss installiert sein.** Ohne bleibt der Link-Modus; die
  Oberfläche sagt das, statt es stillschweigend zu versuchen.
- **Es bricht, wenn Sixt umbaut.** Angesprochen wird alles über
  `data-testid`-Haken, die seit Jahren stabil sind, aber eine Garantie ist das
  nicht. Bricht es, meldet der Eintrag „Trefferliste kam nicht" statt still
  falsche Zahlen zu zeigen.
- **Preise sind Momentaufnahmen.** Es gibt bewusst kein Dauer-Tracking.

## Die Browser-Erweiterung

Unter `extension/` liegt zusätzlich eine Erweiterung, die Preise aus Tabs liest,
die du selbst öffnest. Sie war der ursprüngliche Weg, bevor sich der CDP-Ansatz
als tragfähig erwies, und bleibt als Rückfallebene erhalten, etwa falls Chrome
den Debug-Port irgendwann sperrt. Für den Alltag wird sie nicht gebraucht.
