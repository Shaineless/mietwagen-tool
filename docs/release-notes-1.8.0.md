## Hertz und Enterprise

Damit vergleichen die Bundeslandsuche und Finde dein Auto **fünf Anbieter**
in einer Rangliste: Sixt, Europcar, Avis, Hertz, Enterprise.

- **Hertz:** Die neue Buchungsseite nimmt alle Reiseparameter im Link und holt
  die Fahrzeuge selbst als JSON. 85 klassische Stationen; die 200
  Selbstbedienungspunkte „Hertz 24/7" bei IKEA und Baumärkten sind bewusst
  nicht dabei, die Buchungsseite kennt sie nicht.
- **Enterprise:** Die Suche ist ein POST an Enterprise' eigene Schnittstelle,
  alle Klassen mit Preisen kommen in einer Antwort. Gemessen an Köln Hbf:
  75 Klassen, 46 davon verfügbar, in 8,7 Sekunden.

Gemessen in Bremen, CDMR, 26.–29.11., 15 Stationen, alle beantwortet:
Enterprise Überseestadt 81,14 €, Europcar Neustadt 118,29 € (800 km frei),
Sixt Bremerhaven 133,97 €, Avis Bremen Center 179,17 €. Derselbe Golf,
Faktor 2,2 zwischen günstigster und teuerster Station.

Dazu behoben: der Dienst ließ aus der EXE heraus nur Sixt-Adressen zu; die
anderen Anbieter wären dort als „unbekanntes Ziel" abgelehnt worden.

## Nachgeprüft

Jeder der vier neuen Leser hat einen Testfall mit einem echten Ausschnitt
der Antwort: Code, Modell, günstigster Tarif, Kilometer, Bild.
