## Drei stille Fehler, die niemand bemerkt hätte

Diese Fassung ist vor allem eine Aufräumrunde. Drei Dinge waren kaputt, ohne
je eine Fehlermeldung zu zeigen, und genau das macht sie gefährlich.

**Der Preisverlauf hätte sich selbst gelöscht.** Ab 8 MB benannte sich die
Datei um, in `preisverlauf-<Jahr>.jsonl`. Der Kommentar daneben versprach:
*„wer die Kurve über Jahre will, hat sie dann noch."* Das stimmte nicht,
gelesen wurde immer nur die eine Datei. In dem Moment, in dem die Grenze
gefallen wäre, wäre die **gesamte Kurve auf einen Schlag verschwunden**, ohne
Meldung. Behoben: Archive werden mitgelesen, und automatisch umbenannt wird
nichts mehr. Wer aufräumen will, dünnt aus, und das fragt vorher mit genauer
Zahl nach.

**Die Kasse las auf fünf Länderseiten falsche Beträge.** Leerzeichen und
Apostroph als Tausendertrenner waren ihr unbekannt:

| Angezeigt | Gelesen | Richtig |
| --- | --- | --- |
| `12 500,00 CZK` | 500 | 12.500 |
| `4 999,00 SEK` | 999 | 4.999 |
| `CHF 1'234.55` | 234,55 | 1.234,55 |
| `1 250,00 zł` | nichts | 1.250 |

Frankreich, Schweden, Norwegen, Polen und Tschechien schreiben so. Gefunden
hat das der allererste Testlauf, keine Minute nachdem es Tests gab.

**Die Weckermeldung erschien auf Windows 11 gar nicht mehr.** Sie lief über
`mshta` mit VBScript. Gemessen auf Build 26200: `mshta` beendet sich nach
36 Millisekunden, ohne Fenster, ohne Fehler. Microsoft baut VBScript aus dem
System heraus. Ein ausgelöster Wecker hat also ins Protokoll geschrieben und
sonst nichts getan. Jetzt über PowerShell, nachgeprüft und mit Eintrag ins
Protokoll, ob das Fenster wirklich gestartet ist.

## Der Wecker prüft jetzt auch, wenn TRACKER zu ist

Bisher stand im README offen als Einschränkung: *„Kein Hintergrunddienst."*
Damit war der Zweck der Funktion verfehlt, denn wer eine Buchung beobachten
lässt, hat das Programm gerade nicht auf.

Ein Schalter bei den Weckern trägt eine tägliche Aufgabe in die
**Windows-Aufgabenplanung** ein. Sie startet TRACKER zur eingestellten
Uhrzeit, lässt eine Weckerrunde laufen und beendet sich wieder.

Drei Dinge daran sind Absicht:

- **Voreinstellung aus.** Es geschieht nichts, was niemand eingeschaltet hat.
- **Der vollständige Befehl steht im Klartext daneben**, samt Name des
  Eintrags, mit dem man ihn in der Aufgabenplanung wiederfindet. Kein
  Autostart, kein Dienst, keine Administratorrechte.
- **Derselbe Schalter macht es wieder weg**, vollständig.

Läuft TRACKER ohnehin, tut die geplante Aufgabe nichts.

## Die Preisentwicklung lässt sich wieder bedienen

Die Reiseliste war ein Auswahlfeld mit inzwischen 280 Einträgen, in dem man
nicht suchen konnte. Jetzt: Suchfeld mit derselben Umlaut- und
Teilworterkennung wie die Stationsauswahl, ein Filter auf laufende Reisen und
die Trefferzahl daneben.

Dazu weniger Leerlauf. Ein Klassenwechsel baute bisher die ganze Reiseliste
neu auf und fragte den Verlauf erneut ab; nachgemessen bleiben die Elemente
jetzt stehen und es geht **keine einzige** Abfrage mehr raus. Die Übersicht
kommt schlank, 135 statt 46 KB.

Neu unter der Liste: wie viele Messpunkte der Verlauf hat und wie viel Platz
er belegt, mit einem Weg zum Ausdünnen alter Punkte. Der zählt erst und fragt
dann, mit genauer Zahl. Gelöscht wird nur nach ausdrücklicher Zustimmung.

## Ein Netz für die Zahlen

Das Werkzeug hatte bis hierher keine einzige Testdatei, obwohl seine
gefährlichsten Fehler stille Zahlendreher waren. Jetzt liegen **24 Tests** bei,
mit Bordmitteln von Node, ohne neue Abhängigkeit. Geprüft werden die Stellen,
an denen schon einmal falsche Beträge herauskamen, mit genau den Fällen, die
wirklich passiert sind. Zu starten mit `npm test`.

## Kleinigkeiten

- Das Flackern beim zweiten Klick auf einen Schutzpreis ist weg.
- Die Statusseite „Was geht gerade?" behauptete „Zwei Abfragen gleichzeitig",
  seit 1.3.1 sind es zwei bis sechs. Sie ist jetzt auf dem Stand, samt der
  Funktionen, die dort ganz fehlten.
- Die Beschreibung in `package.json` hatte zerlegte Umlaute.
