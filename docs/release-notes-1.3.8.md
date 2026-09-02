**Start aus dem Quellcode, ohne die EXE.**

Wer die fertige Datei nicht ausführen möchte, konnte TRACKER bisher nur über
die Kommandozeile aus dem Quellcode starten. Der Weg per Doppelklick war
angelegt, führte aber in zwei Sackgassen. Beide sind beseitigt.

**Erste Sackgasse: die Datei im Archiv angeklickt.** Windows lässt zu, dass man
`TRACKER starten.cmd` direkt in der ZIP-Datei doppelklickt. Es entpackt dann
nur diese eine Datei in einen Temp-Ordner und führt sie dort aus, ohne alles
andere. Die Meldung lautete `Cannot find module ... build.mjs` und sagte nicht,
woran es lag. Jetzt erkennt die Datei den Fall und erklärt in vier Schritten,
was zu tun ist.

**Zweite Sackgasse: die fehlenden Bausteine.** Nach dem Herunterladen fehlt der
Ordner `node_modules`, der gehört bewusst nicht ins Repository. Die
Oberfläche baute noch, der Dienst brach dann ab. Jetzt holt die Startdatei das
beim ersten Mal selbst nach.

Das dauert **wenige Sekunden statt eines Downloads von rund 700 MB**: TRACKER
benutzt das auf dem Rechner vorhandene Chrome über dessen Debug-Anschluss und
startet nie einen eigenen mitgelieferten Browser. Der große Browser-Download,
den die Bibliothek sonst mitbringt, entfällt damit vollständig.

Beides an einem frisch entpackten Ordner nachgestellt und geprüft: von der
leeren Ablage bis zum laufenden Dienst neun Sekunden.

---

**Dazu ein ausführlicher Abschnitt im README zur Download-Warnung.**

Browser melden beim Herunterladen „Tracker.exe wird häufig nicht
heruntergeladen". Das verunsichert zu Recht, und die bisherige Erklärung war
zu knapp. Jetzt steht dort, was die Meldung bedeutet (eine Aussage über die
Verbreitung, nicht über den Inhalt), warum sie sich nicht einfach abstellen
lässt, wie man weiterkommt, und vor allem: wie man sich vergewissert, statt
vertrauen zu müssen. Über den offenen Quellcode, über den Selbstbau, über die
Prüfsumme jeder veröffentlichten Datei.

Am Programm selbst ändert sich nichts.
