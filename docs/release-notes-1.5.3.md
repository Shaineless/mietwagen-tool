## „Am Ende alle auf einmal"

So war der Kalender bisher gemeldet worden, und so war er auch: Ein Lauf über
28 Abholtage arbeitet knapp zwei Minuten, und das Ergebnis erschien in einem
Schlag. Von dem, was dazwischen geschah, war nichts zu sehen.

Jetzt legt sich **jeder Tag einzeln hin, in dem Moment, in dem sein Preis
ankommt**. Der Betrag folgt der Kachel um eine Sechzehntelsekunde, das liest
sich als „der Wert trifft ein" statt als „hier stand schon immer etwas". Der
günstigste Tag bekommt einen kurzen Lichtstreif, aber erst, wenn der Lauf
durch ist: währenddessen wandert der Bestpreis noch, da wäre der Streif
gelogen. Und die Kennzahlen darüber zählen zum neuen Wert hoch, statt zu
springen.

Im **Preisvergleich** dasselbe für die Spalten. Eine Länderseite braucht zehn
bis vierzig Sekunden; antwortet sie, fällt ihre Spalte von oben nach unten
ein. Damit sieht man, *welche* Seite gerade hereingekommen ist, und nicht nur,
dass sich irgendwo etwas geändert hat.

Alles davon ist Deckkraft und Verschiebung, nichts davon kostet einen
Zeilenumbruch oder ein Neuzeichnen der Seite. Wer im Betriebssystem „weniger
Bewegung" eingestellt hat, bekommt das reine Aufblenden: es sagt weiterhin,
was hereinkam, ohne dass etwas wandert.

## Der Fortschritt hat gelogen

Unter dem Kalender stand **„0 von 21 Tagen berechnet"**, während sechs Tage
längst Preise zeigten. Beides stimmte für sich: die Anzeige zählte nur, was
*dieser* Lauf geholt hatte, und die sechs stammten aus dem gespeicherten
Preisverlauf.

Gezählt wird jetzt, was auf dem Schirm steht, egal woher es kommt, und in
Tagen statt in Abrufen. Bei drei Uhrzeiten waren es vorher dreimal so viele
Aufträge wie Tage, und „13 von 63" hätte niemandem etwas gesagt. Jetzt steht
dort **„26 von 28 Tagen mit Preis · 2 offen"**.

Der Balken selbst bewegt nicht mehr seine Breite, sondern seinen Maßstab. Das
erspart dem Browser bei jedem Schritt einen Umbruch der Seite. Dazu ein
leiser Laufschimmer: zwischen zwei Länderseiten steht der Balken schon mal
zwanzig Sekunden still, und dann ist er das Einzige, was sagt, dass nichts
hängt.

## Zwei Fehler, die beim Prüfen aufgefallen sind

**Der Merker hing an der falschen Stelle.** Er lag am Nachladen des
Preisverlaufs. Das läuft aber auch am *Ende* eines Laufs und bei jedem
Wechsel der Fahrzeugklasse, und genau dort wäre wieder alles auf einmal
losgeflogen. Er hängt jetzt an der Reise selbst: Station, Länderseite,
Mietdauer, Start, Spanne, Cookie-Modus. Die Fahrzeugklasse steht bewusst nicht
darin, die wechselt man oft, und die Kacheln bleiben dieselben.

**Bei gleichem Preis gibt es mehrere günstigste Tage.** Der Merker hielt nur
einen davon fest, dadurch hätte sich der Lichtstreif bei jedem Neuzeichnen
wieder angeworfen. Der Fall ist nicht theoretisch: an einer geprüften Station
lagen der 18. und der 25. September beide bei 105,98 €.

Dazu eine kleine Vorsichtsmaßnahme beim Hochzählen: der richtige Wert steht
zuerst da und wird erst vom ersten gezeichneten Bild abgelöst. In einem
Fenster im Hintergrund liefert der Browser keine Bilder, und andersherum wäre
dort der alte Wert stehengeblieben.

## Nachgeprüft

Die Zeichenlogik am echten Code mit echten Verlaufsdaten durchgespielt: 28
Kacheln, 26 mit Preis, 26 bewegt, zwei Lichtstreifen für den Gleichstand.
Fünf weitere Neuaufbauten derselben Tafel danach: keine Bewegung mehr, kein
Streif. Der Ablauf angehalten bei 90 ms zeigt die Welle, Kachel für Kachel bei
91, 75 und 37 Prozent, der Rest steht noch. Das Hochzählen über eine eigene
Bilduhr gemessen: 300,00 → 228,16 → 176,69 → 130,23 → 110,51 → 105,98 €,
schnell los, sanft aus, exakt auf dem Endwert. Zwei volle Runden durch alle
Ansichten samt Tageswechseln und Klassenwechseln: keine Fehlermeldung.
