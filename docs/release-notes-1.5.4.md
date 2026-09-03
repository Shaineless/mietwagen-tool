## „Doppelklick, und nach zwei Sekunden ist es wieder zu"

Gemeldet, nachgestellt, und die Ursache war unangenehm banal: **es lief noch
die alte Fassung.**

Wer 1.5.3 herunterlud und startete, während 1.5.2 noch offen war, bekam einen
Prozess, der 2,7 Sekunden lebte und sich mit Code 0 beendete. Im Protokoll
stand der Grund, nur liest das niemand:

> `TRACKER läuft bereits auf http://127.0.0.1:4173/`

Das war so gebaut: Der zweite Start reichte an den laufenden Dienst weiter und
ging. Gedacht war das für den versehentlichen zweiten Doppelklick. Beim
Aktualisieren ist es aber genau falsch herum, und zwar doppelt: entweder sieht
man gar nichts und hält die neue Fassung für kaputt, oder man sieht ein
Fenster und hält die **alte** Oberfläche für die neue.

**Jetzt übernimmt der neue Start.** Er bittet den laufenden Dienst zu gehen,
dessen Fenster schließt sich, und das neue geht auf. Gemessen: 4,8 Sekunden von
Fassung zu Fassung, danach genau ein Fenster auf dem Schirm.

Antwortet der laufende Dienst nicht auf die Bitte, wird er beendet. Das ist der
Weg für alles vor 1.5.4, das den neuen Endpunkt noch nicht kennt: dort wird der
Prozess über den Port gefunden. Gemessen an einer laufenden 1.5.3: Übernahme
nach 1,8 Sekunden.

Dazu zwei Kleinigkeiten, die dasselbe Problem an der Wurzel packen:

- Ein Fenster, das nach einem Wechsel noch die alte Seite zeigt, **lädt sich
  selbst neu**, sobald es merkt, dass unten eine andere Fassung antwortet.
- Unter **Einstellungen** steht jetzt, **welche Fassung gerade läuft**. Ohne
  diese Zahl war von innen nicht zu erkennen, was man vor sich hat.

## Der Preiswecker war stumm

Beim Prüfen der Sache oben ist etwas Schlimmeres aufgefallen. Die
Weckermeldung erschien **gar nicht mehr**, dieselbe Sorte Fehler wie damals
bei `mshta`, nur an einer anderen Stelle:

> Mit `detached: true` startet PowerShell zwar, aber `MessageBox::Show` kehrt
> sofort zurück und der Prozess endet nach rund **120 Millisekunden** mit Code
> 0. Kein Fenster, kein Fehler, keine Ausgabe.

Nachgemessen mit drei Varianten desselben Aufrufs: nur die ohne `detached`
zeigt ein Fenster und bleibt stehen, bis jemand klickt. Genau die wird jetzt
benutzt. Das Fenster hängt damit am Programm, deshalb wartet die
Weckerrunde jetzt, bis die Meldung weggeklickt ist, statt sich vorher zu
beenden und sie mitzunehmen.

Und falls es doch je wieder passiert, verschwindet es nicht mehr lautlos: ein
Meldungsfenster, das nach weniger als 400 Millisekunden wieder zu ist, hat
niemand gesehen, und der Text landet dann im Protokoll.

## Nachgeprüft

Übernahme zwischen zwei laufenden Fassungen 1.5.4: 4,8 s, alter Dienst sauber
beendet, ein Fenster übrig. Übernahme über eine laufende 1.5.3 hinweg: 1,8 s.
Das Schließen des alten Fensters an der echten Seite gemessen, ebenso das
Neuladen bei Fassungswechsel: genau einmal, danach zwölf Sekunden Ruhe, kein
Neulade-Kreisel. Weckermeldung: Fenster steht nach einer Sekunde, Prozess
wartet, nach dem Wegklicken endet er.
