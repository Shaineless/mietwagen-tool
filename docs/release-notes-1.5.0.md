## Eine Frage, die der Vergleich bisher offen ließ

TRACKER stellt Domains gegenüber: `sixt.de` gegen `sixt.fr` gegen `sixt.es`.
Eine zweite Größe blieb dabei ungetestet, nämlich **wo der Besucher sitzt**.
Sieht jemand aus Frankreich auf `sixt.fr` denselben Preis wie jemand aus
Deutschland? Das ließ sich mit dem Werkzeug nicht beantworten.

Jetzt schon.

### Die Antwort

> **Gemessen** · Französische Ausgänge auf `sixt.fr`, spanische auf `sixt.es`,
> jeweils gegen den direkten Abruf aus Deutschland, gleiche Station, gleicher
> Zeitraum:
>
> **34 von 34 Klassen identisch. Auf beiden Länderseiten.**

Die Herkunft des Besuchers ändert bei Sixt nichts. Die Länderseite dagegen
sehr wohl, und die Uhrzeit erst recht. Ein negatives Ergebnis, aber ein
nützliches: eine Variable weniger, über die man rätseln muss.

### Wie man Proxys hinterlegt

Zwei Betriebsarten, weil zwei verschiedene Fragen dahinterstehen:

- **Ein Vorrat für alle Länderseiten.** Derselbe Weg für jede Seite. Zeigt, ob
  ein anderer Anschluss überhaupt andere Preise sieht.
- **Je Länderseite ein eigener.** Sinnvollerweise mit Proxys aus dem
  jeweiligen Land. Seiten ohne eigenen Eintrag gehen bewusst direkt hinaus.

Hinterlegt wird als **Datei** oder als **eingefügte Liste**, eine Zeile je
Eintrag. Erkannt werden `host:port`, `host:port:benutzer:passwort`,
`benutzer:passwort@host:port` und Adressen mit Schema.

Ein Klick prüft eine Stichprobe und zeigt zu jedem Eintrag **Laufzeit und
Ausgangsadresse**; benutzt wird der schnellste, und der bleibt.

**Die Ausgangsadresse steht dort nicht als Schmuck.** Beim Testen für diese
Fassung stellte sich heraus, dass zwei Listen vertauscht beschriftet waren:
die als französisch bezeichnete lieferte spanische Ausgänge, die spanische
französische. Ohne diese Anzeige hätte der Versuch das Falsche gemessen, und
niemand hätte es bemerkt.

### Was bewusst nicht gebaut ist

Kein Wechsel bei Zurückweisung. Fällt ein Proxy **technisch** aus, rückt der
nächste geprüfte nach, das ist Ausfallsicherheit. Weist die **Länderseite
selbst** den Zugriff ab, wird das gemeldet und *nicht* still der nächste
probiert. Der Unterschied ist der zwischen einem kaputten Weg und dem Umgehen
einer Sperre, und TRACKER tut Letzteres nicht.

### Verbrauch, sichtbar

Residential-Proxys werden nach Gigabyte abgerechnet. Deshalb steht bei den
Einstellungen, wie viele Daten durchgelaufen sind, aufgeschlüsselt je Ziel und
mit Zähler zum Zurücksetzen. Gemessen: **rund 0,12 MB je Länderseite**, ein
Vergleich über 29 Seiten also gut 3,5 MB.

Messbar ist das nur, weil aller Verkehr durch eine **lokale Weiche** läuft.
Der Browser bekommt genau diese eine Adresse als Proxy genannt, und sie
entscheidet je Ziel, welcher Proxy wirklich benutzt wird. Nötig war das aus
zwei Gründen: ein Browser kennt seinen Proxy nur für den ganzen Prozess (sonst
bräuchte es einen Browser je Länderseite), und er kann über diesen Weg keine
Zugangsdaten mitschicken (sonst stünde ein Anmeldedialog in einem unsichtbaren
Fenster).

Dazu eine Anzeige oben rechts, solange ein Proxy wirkt: die aktuelle
Ausgangsadresse mit einem ruhig pulsierenden Punkt, die beim Wechsel einmal
aufblinkt.

### Kleinigkeit

Die Statusseite behauptete „Proxy je Länderseite, im Unterbau vorhanden". Im
Code stand dazu nichts. Jetzt stimmt es.
