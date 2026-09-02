**Sicherheitsdurchgang nach den letzten Änderungen.**

Seit der letzten Prüfung sind Endpunkte und Parameter dazugekommen. Alle
wurden erneut angegriffen statt nur angesehen.

Bestanden: der Dienst hört weiterhin nur auf 127.0.0.1 und ist aus dem Netz
nicht erreichbar. Alle sechs zustandsändernden Aufrufe weisen eine fremde
Herkunft ab. Aufträge auf fremde Adressen, auf das eigene Heimnetz und auf
getarnte Namen wie `www.sixt.de.boese.example` werden nicht angenommen. Der
Selbsttest lässt sich nicht auf eine fremde Seite lenken. Quellcode,
Betriebsdaten und Pfade außerhalb des Ausgabeordners bleiben gesperrt, auch
kodiert geschrieben.

**Ein Punkt nachgebessert:** Ein Preiswecker mit unbekannter Länderseite ließ
sich anlegen. Abgerufen wurde er nie, das hat die Prüfung beim Abruf sicher
verhindert. Aber der Eintrag landete bis dahin in der Weckerdatei. Geprüft wird
jetzt schon beim Anlegen.

Im Quellcode und im gesamten Verlauf stehen keine Zugangsdaten. Das
Veröffentlichungsskript holt sein Zugriffsrecht aus dem Windows-Speicher, zeigt
es nirgends an und schreibt es in keine Datei.
