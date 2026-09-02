## Vom Vergleich direkt in die Buchung

Bisher endete der Schutzvergleich an der schönsten Stelle: Man sah, welches
Paket auf welcher Länderseite was kostet, und musste die Buchung anschließend
von Hand nachbauen. Station eintippen, Datum, Uhrzeit, Klasse suchen, Paket
anklicken, und am Ende hoffen, dass derselbe Preis herauskommt.

Das entfällt.

**Ein Klick auf einen Preis führt jetzt dorthin.** Nach dem Abruf bleiben die
Kassenseiten aller geprüften Länderseiten geöffnet, unsichtbar im Hintergrund.
Klickt man in der Tabelle auf einen Preis, wird auf der Seite genau dieses
Paket ausgewählt und das Sixt-Fenster kommt nach vorn. Gemessen dauert das
**unter einer Sekunde**, weil nichts neu geladen werden muss. Man steht mitten
in der Buchung, bei dem Preis, der im Vergleich stand.

**Der Preis wird gegengeprüft.** Was die Kasse in diesem Moment anzeigt, wird
mit dem verglichen, was gemessen wurde. Weicht es ab, steht das da, bevor
jemand bucht, statt stillschweigend durchzugehen.

## Was das an Speicher kostet, und was dagegen getan wird

Eine offene Kassenseite ist ein vollwertiger Browser-Tab. Nachgemessen über den
privaten Arbeitssatz aller beteiligten Prozesse: **rund 250 MB je Länderseite**.
Bei vier Ländern ist das ein Gigabyte, und man merkt es nicht, weil das Fenster
unsichtbar ist.

Deshalb räumt TRACKER von selbst auf, an vier Stellen:

- Wer die Schutzansicht verlässt, ohne zu buchen: alles geht zu.
- Ab der siebten Seite geht die älteste.
- Nach zwölf Minuten, dann ist die Sitzung bei Sixt ohnehin abgelaufen.
- Beim Beenden des Programms.

Über der Tabelle steht, wie viele Seiten offen sind und wie viel sie belegen.
Wurde eine schon geschlossen, holt der Klick genau diese eine zurück; das
dauert rund zwölf Sekunden und bestätigt den Preis nebenbei frisch.

Alle Kassenseiten liegen in **einem** Fenster als Reiter, nicht in mehreren
Fenstern. Das spart keinen Speicher, das wurde gemessen: 253 MB je Seite in
getrennten Fenstern gegen 255 MB in einem. Der Browser nimmt für jede Herkunft
ohnehin einen eigenen Prozess. Es ist nur angenehmer zu bedienen, weil man
alle Länderseiten nebeneinander hat.

## Google Chrome ist Voraussetzung

Das stand bisher missverständlich da. Für den Preisabruf genügt **Microsoft
Edge nicht**. Es kann das Programmfenster darstellen, aber nicht abrufen: Edge
öffnet den Steuerungszugang zwar, weist die Anfragen darauf dann jedoch ab.
Nachgeprüft und reproduziert. Ohne Chrome bleibt es beim Link-Modus, in dem die
Suchen gebaut und von Hand geöffnet werden.

Die Hinweise im Programm, im Selbsttest und in der Beschreibung sagen das
jetzt deutlich.

## Kleinigkeiten

- Das Veröffentlichungsskript prüft den Zweig, bevor es baut, statt danach.
  Ein Fehlklick auf einem Nebenzweig beendete vorher erst ein laufendes
  TRACKER und baute zwei Minuten lang, um dann abzulehnen.
