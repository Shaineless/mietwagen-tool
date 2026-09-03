## Ein Fehler, bei dem scheinbar gar nichts passierte

Gemeldet wurde: Proxy einschalten, Cookies abschalten, mehrere Uhrzeiten im
Kalender, und dann tut sich nichts. Reproduziert, und es war schlimmer als
gedacht: **neun von neun Abrufen scheiterten**, alle mit
`ERR_PROXY_CONNECTION_FAILED`, während die Proxy-Weiche putzmunter lauschte.

Die Ursache lag an einer Stelle, die still das Gegenteil von dem tat, was ihr
Name verspricht:

> `browser.close()` **beendet ein über CDP verbundenes Chrome nicht.** Es
> klinkt sich nur aus. Der Prozess läuft weiter.

Damit überlebte nach jedem Neustart des Programms das alte Chrome, und weil
die Weiche bei jedem Start einen neuen Port bekommt, zeigte dieses Chrome auf
eine tote Adresse. Nachgemessen: `--proxy-server=127.0.0.1:65368`, während die
Weiche auf 55059 lauschte. Jetzt wird Chrome über CDP wirklich beendet.

## Ein toter Proxy hält den Abruf nicht mehr auf

Fällt ein Proxy technisch aus, weicht TRACKER jetzt selbst auf den nächsten
geprüften aus. Der erste Anlauf löste das eine Ebene zu hoch und half nicht:
Chrome merkt sich einen gescheiterten Proxy als schlecht und probiert ihn
danach gar nicht mehr, auch wenn längst ein anderer eingestellt ist.

Deshalb sitzt der Wechsel jetzt **in der Weiche selbst**. Sie probiert die
geprüften Einträge der Reihe nach durch, bevor sie überhaupt antwortet. Chrome
sieht entweder eine stehende Verbindung oder gar nichts, nie einen Ausfall.
Ein Ersatz, der trägt, wird dauerhaft übernommen.

**Die Grenze bleibt, wo sie war.** Gewechselt wird nur bei einem
Transportfehler, also wenn der Proxy nicht erreichbar ist. Weist die
Länderseite selbst den Zugriff ab, wird das gemeldet und *nicht* der nächste
probiert. Das eine ist ein kaputter Weg, das andere wäre das Umgehen einer
Sperre.

## Man sieht jetzt, was im Hintergrund geschieht

Ein Balken sagt „3 von 84". Stockt es dann, weiß niemand, ob etwas kaputt ist
oder ob gerade nachgefasst wird. Unter dem Fortschritt steht deshalb im
Klartext, was passiert:

> *Proxy war nicht erreichbar (ECONNREFUSED). Gewechselt, der Abruf läuft weiter.*
> *sixt.fr: Die Länderseite hat den Zugriff abgewiesen. Versuch 2 von 3.*

Gleiche Meldungen werden zusammengefasst statt fünfmal untereinander gestellt,
und der Rohtext der Bibliothek bleibt im Protokoll: in einer Statuszeile ist
`page.goto: Target page, context or browser has been closed Call log: …`
schlimmer als gar nichts.

Dazu ein Wachhund: ein einzelner Abruf, der länger als drei Minuten hängt,
gilt als gescheitert und wird wiederholt, statt die Warteschlange stillstehen
zu lassen.

## Proxy-Wahl dort, wo man den Abruf startet

Im Preisvergleich und im Kalender ließ sich bisher nur *ein* Haken setzen, der
stumm den allgemeinen Vorrat nahm. Jetzt stehen dort **beide Betriebsarten**
zur Wahl, allgemeiner Vorrat oder je Länderseite, jeweils mit dem Hinweis, was
hinterlegt und geprüft ist. Und ein **Proxys testen** direkt daneben, das den
derzeit schnellsten heraussucht.

Die Stichprobe ist von fünf auf **fünfzehn** erhöht. Gemessen streuen die
Ausgänge desselben Anbieters zwischen 306 und 1794 Millisekunden, also fast um
das Sechsfache. Wer nur fünf zieht, erwischt leicht einen langsamen und
schleppt ihn durch 84 Kalenderabrufe.

## Weniger gleichzeitig, wenn ein Proxy läuft

Ohne Proxy verteilen sich die Verbindungen über Sixts eigene Server, mit Proxy
laufen alle durch ein Gateway. Das ist dann der Engpass. Der Selbstregler geht
deshalb mit Proxy nur noch bis zwei gleichzeitig statt bis sechs.

## Wie viel ist zu viel?

Ein Hinweis, der bisher fehlte und der jetzt in der Oberfläche und in der
Beschreibung steht: Wer gelegentlich fünfzig Abfragen macht, braucht Proxys
nicht, in dieser Größenordnung fällt nichts auf. Wer **täglich Tausende**
abfragt, bewegt sich in einer anderen Liga und braucht hochwertige Proxys und
vor allem Zurückhaltung. Ein Kalender über 56 Tage mit drei Uhrzeiten sind
168 Abrufe, ausgelöst von einem Klick.

## Nachgeprüft

Ein Durchlauf über alle Kombinationen, 486 echte Abrufe:

| | ohne alles | ohne Cookies | mit Proxy | Proxy + ohne Cookies |
| --- | --- | --- | --- | --- |
| **Preisvergleich** (5 Stationen × 2 Uhrzeiten × 3 Länderseiten) | 30/30 | 29/30 | 30/30 | 28/30 |
| **Kalender** (28 Abholtage × 3 Uhrzeiten, 3 Tage Miete) | 84/84 | 84/84 | 84/84 | 84/84 |

**481 von 486 erfolgreich, kein einziger Fehler.** Die fünf fehlenden sind
Tage, an denen die Station wirklich nichts anbietet. Dazu 1,5 bis 3,4 Sekunden
je Abruf, und gegenüber der Fassung vor diesen Korrekturen ist der schwierigste
Fall um ein Drittel schneller (281 statt 413 Sekunden) bei 2 statt 11
Wiederholungen.
