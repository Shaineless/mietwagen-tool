**Ausgebuchte Tage sind kein Fehler mehr.**

Gemeldet und nachgestellt: An manchen Tagen bietet eine Station schlicht nichts
an. TRACKER hat daraus einen Fehler gemacht, statt es zu sagen.

Der Ablauf wartete stur bis zu 60 Sekunden auf eine Angebotsliste, die nie kam,
meldete dann „Trefferliste kam nicht" und versuchte es dreimal erneut. Für
einen einzigen Tag, an dem es nichts zu holen gab, waren das über vier Minuten.

Sixt kennzeichnet diesen Fall im Seitengerüst selbst. TRACKER wartet jetzt auf
beides zugleich, die Angebotsliste **oder** diese Kennzeichnung, und nimmt,
was zuerst kommt.

**Gemessen an Frankfurt Zentrum/Zeil, 4. und 5. September 2026:**

| | vorher | jetzt |
| --- | --- | --- |
| Dauer | 64,7 s | **6,5 s** |
| Ergebnis | Fehler „Trefferliste kam nicht" | „An diesem Tag bietet die Station nichts an" |
| Wiederholungen | vier | keine |

Der Tag steht im Kalender jetzt mit seinem Grund da, statt mit „Noch nicht
abgerufen" auszusehen wie ein misslungener Abruf. Und er wird nicht mehr
nachgefasst, denn die Station hat ja geantwortet.

Warum die alte Erkennung nicht griff: sie suchte nach „verfügbar", „available"
und „sold out". Auf der Seite steht „Wir konnten keine passenden Fahrzeuge
finden", also keines dieser Wörter.

---

Außerdem behoben:

- In der Kalenderlegende stand „**,**" statt „**–**" als Zeichen für „kein
  Preis vorhanden". Ein Überbleibsel des letzten Textdurchgangs.
- Ohne gewählte Fahrzeugklasse meldete der Kalender „An 2 davon gibt es
  nicht." mit einer Lücke, wo der Klassenname fehlte.
- Das Veröffentlichungsskript arbeitet nur noch von `main` aus. Wer auf einem
  Nebenzweig etwas ausprobiert, kann nicht mehr aus Versehen einen
  halbfertigen Stand online stellen.
