## Sixt hat die Kasse umgebaut, vier Länderseiten lasen falsch

Alle 27 Länderseiten gegen die neue Kasse geprüft. Vier lieferten bei den
Schutzpaketen falsche oder gar keine Endpreise, alle ohne Fehlermeldung:

- **Schweden las falsche Zahlen.** Aus „7 200,09 kr" wurde 200,09, weil das
  schmale Leerzeichen als Tausendertrenner nicht mehr erkannt wurde. Die
  Sonderleerzeichen im Muster waren beim Speichern einmal zu gewöhnlichen
  geworden; jetzt stehen sie als Codes in der Datei.
- **Schweiz blieb leer.** Sixt schreibt dort jetzt „CHF566.15" ohne
  Leerzeichen, und die Währungserkennung verlangte eine Wortgrenze.
- **Polen und Ungarn blieben leer.** Die Gesamtsumme heißt dort jetzt
  „Całkowity:" und „Teljes:", nicht mehr „Total:". Die Erkennung kennt jetzt
  die Beschriftung jeder Länderseite.

Jeder Fall hat einen eigenen Testfall mit dem echten Text der Seite.

## Nachgeprüft

Preisliste und Schutzpakete auf allen 27 Länderseiten, Frankfurt Flughafen,
25.–28.11.: überall vier Pakete, die Endpreise steigen von „Kein
Extra-Schutz" bis „All Inclusive". Die neue Stufe „Kein Extra-Schutz" landet in
der Schutztabelle in der Spalte „Ohne Extra-Schutz".
