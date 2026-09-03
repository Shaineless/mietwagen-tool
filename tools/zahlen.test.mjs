/**
 * Prueft die Zahlenerkennung.
 *
 * Warum ausgerechnet hier, wo es sonst keine Tests gibt: die gefaehrlichsten
 * Fehler dieses Werkzeugs waren nie Abstuerze, sondern stille Zahlendreher.
 * Ein Abruf, der scheitert, meldet sich. Ein Preis, der um eine Stelle daneben
 * liegt, steht ruhig in der Tabelle und sieht aus wie ein Schnaeppchen.
 *
 * Jeder Fall hier unten ist wirklich passiert:
 *
 *   1025,85  wurde als    25,85  gelesen (spanische Seite, Tausender ohne Punkt)
 *   1'110.32 wurde als   110.32  gelesen (Schweiz, Apostroph als Trenner)
 *   "Inclus" landete im falschen Schutzfach (franzoesische Seite)
 *
 * Gestartet mit:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lesePreisAusText, parseSchutzBlock, teileSchutzpakete } from './scrape/sixt-schutz.mjs';
import { mwtParseAmount } from './scrape/offer-parse.mjs';

/* ============================================ Betrag aus einer Zeile */

test('mwtParseAmount: die Schreibweisen der Laenderseiten', () => {
  assert.equal(mwtParseAmount('1.234,56 €'), 1234.56, 'deutsch, Punkt als Tausender');
  assert.equal(mwtParseAmount('£1,234.56'), 1234.56, 'britisch, Komma als Tausender');
  assert.equal(mwtParseAmount('1 234,56'), 1234.56, 'franzoesisch, Leerzeichen als Tausender');
  assert.equal(mwtParseAmount('1 234,56'), 1234.56, 'franzoesisch, schmales Leerzeichen');
  assert.equal(mwtParseAmount("CHF 1'234.55"), 1234.55, 'schweizerisch, Apostroph als Tausender');
  assert.equal(mwtParseAmount('99,00 €'), 99, 'ohne Tausenderstelle');
});

test('mwtParseAmount: der Apostroph-Fehler, der einen 7er BMW auf 110 Franken setzte', () => {
  // Vorher sprang der Ausdruck hinter den Apostroph und las "110.32".
  assert.equal(mwtParseAmount("CHF 1'110.32"), 1110.32);
  assert.notEqual(mwtParseAmount("CHF 1'110.32"), 110.32);
});

test('mwtParseAmount: keine Zahl bleibt keine Zahl', () => {
  assert.equal(mwtParseAmount('unbegrenzte km'), null);
  assert.equal(mwtParseAmount(''), null);
  assert.equal(mwtParseAmount('Early bird Promotion'), null);
});

test('mwtParseAmount: Sixts aufgehuebschte Dopplung wird bewusst nicht gelesen', () => {
  // "134€49" gibt es immer auch in sauberer Form daneben. Wer sie hier liest,
  // riskiert einen stillen Fehlgriff ohne Not.
  assert.equal(mwtParseAmount('134€49'), null);
});

/* ============================================ Gesamtpreis der Kasse */

test('lesePreisAusText: der 1025,85-Fehler der spanischen Seite', () => {
  // Tausender ohne Punkt. Fehlte die zweite Musterform, wurde daraus 25,85.
  assert.equal(lesePreisAusText('Total: 1025,85€'), 1025.85);
  assert.notEqual(lesePreisAusText('Total: 1025,85€'), 25.85);
});

test('lesePreisAusText: mit Tausendertrenner', () => {
  assert.equal(lesePreisAusText('Gesamt: 1.084,66 €'), 1084.66);
});

test('lesePreisAusText: derselbe Betrag zweimal, in zwei Zeilen', () => {
  // Sixt zeigt "411€94" und "411,94€" untereinander. Ein Muster, das ueber
  // Zeilen hinweg sucht, klebt beide zusammen und liest 94411,94.
  const block = ['Gesamt:', '411€94', '411,94€', 'Ahorras: 110,01€'].join('\n');
  assert.equal(lesePreisAusText(block), 411.94);
});

test('lesePreisAusText: echter Block von der spanischen Kasse', () => {
  // Wortwoertlich so gemessen, als "Protección Completa" gewaehlt war.
  const block = ['Total:', '463€00', '463,00€', 'Ahorras: 110,01€'].join('\n');
  assert.equal(lesePreisAusText(block), 463);
});

test('lesePreisAusText: Zeilen ohne Waehrung werden uebersprungen', () => {
  // "3 Tage" und "2 Fahrer" duerfen nicht als Betrag durchgehen.
  const block = ['Gesamt:', '3 Tage', '2 Fahrer', '178,59 €'].join('\n');
  assert.equal(lesePreisAusText(block), 178.59);
});

test('lesePreisAusText: nichts Lesbares ergibt null, nicht 0', () => {
  // Der Unterschied ist wichtig: 0 waere ein Preis, null ist "unbekannt".
  assert.equal(lesePreisAusText('Gesamt: siehe unten'), null);
  assert.equal(lesePreisAusText(''), null);
  assert.equal(lesePreisAusText(null), null);
});

test('lesePreisAusText: andere Waehrungen der Laenderseiten', () => {
  assert.equal(lesePreisAusText('Celkem: 12500,00 CZK'), 12500);
  assert.equal(lesePreisAusText('Totalt: 4999,00 SEK'), 4999);
  assert.equal(lesePreisAusText('Összesen: 45900,00 Ft'), 45900, 'ungarisch, nur "Ft"');
  assert.equal(lesePreisAusText('Razem: 1250,00 zł'), 1250, 'polnisch, nur "zł"');
});

test('lesePreisAusText: Leerzeichen als Tausendertrenner', () => {
  // Frankreich, Schweden, Norwegen, Polen und Tschechien schreiben so. Vorher
  // las die Kasse hier still den falschen Betrag, ohne jede Fehlermeldung.
  assert.equal(lesePreisAusText('Celkem: 12 500,00 CZK'), 12500);
  assert.notEqual(lesePreisAusText('Celkem: 12 500,00 CZK'), 500);
  assert.equal(lesePreisAusText('Totalt: 4 999,00 SEK'), 4999);
  assert.equal(lesePreisAusText('Total: 1 234,56 €'), 1234.56);
  assert.equal(lesePreisAusText('Razem: 1 250,00 zł'), 1250);
});

test('lesePreisAusText: Apostroph als Tausendertrenner, wie in der Schweiz', () => {
  assert.equal(lesePreisAusText("Total: CHF 1'234.55"), 1234.55);
  assert.notEqual(lesePreisAusText("Total: CHF 1'234.55"), 234.55);
});

test('lesePreisAusText: Buchstabencodes brauchen eine Wortgrenze', () => {
  // "kr" darf nicht in "Kreditkarte" treffen und "TRY" nicht in polnischen
  // Woertern. Der Fehler ist an der Kachel-Auswertung schon einmal passiert.
  assert.equal(lesePreisAusText('Kreditkarte 12,00 hinterlegen'), null);
  assert.equal(lesePreisAusText('samochód elektryczny 15,00'), null);
});

/* ============================================ Schutzpakete */

test('parseSchutzBlock: deutsches Paket mit Selbstbeteiligung', () => {
  const p = parseSchutzBlock(
    ['Basic-Schutz', 'Selbstbeteiligung: bis 1.100,00 €', 'Diebstahlschutz', '9,00€/ Tag'],
    'EUR'
  );
  assert.equal(p.name, 'Basic-Schutz');
  assert.equal(p.sbBetrag, 1100);
  assert.equal(p.proTag, 9);
  assert.equal(p.inklusive, false);
  assert.equal(p.waehrung, 'EUR');
});

test('parseSchutzBlock: SB-freies Paket wird als solches erkannt', () => {
  const p = parseSchutzBlock(
    ['Smart-Schutz', 'Keine Selbstbeteiligung', '19,23€/ Tag'],
    'EUR'
  );
  assert.equal(p.selbstbeteiligung, 'keine');
  assert.equal(p.sbBetrag, 0);
});

test('parseSchutzBlock: das franzoesische "franchise" fehlte einmal in der Wortliste', () => {
  // Folge damals: "Protection Basique" landete im Fach der SB-freien Pakete.
  const p = parseSchutzBlock(
    ['Protection Basique', "Franchise: jusqu'à 1 900,00 €", '5,64€/ Jour'],
    'EUR'
  );
  assert.equal(p.sbBetrag, 1900, 'die Selbstbeteiligung muss erkannt werden');
  assert.notEqual(p.selbstbeteiligung, 'keine');
});

test('parseSchutzBlock: Selbstbeteiligung in den uebrigen Sprachen', () => {
  const faelle = [
    ['Basic Protection', 'Deductible: up to 1,900.00 €', 1900],
    ['Protección Básica', 'Franquicia: Hasta 1900,00 €', 1900],
    ['Protezione Base', 'Franchigia: fino a 1.900,00 €', 1900],
    ['Basisdekking', 'Eigen risico: tot 1.900,00 €', 1900],
    ['Basic Cover', 'Excess: up to 1,900.00 €', 1900],
  ];
  for (const [name, zeile, erwartet] of faelle) {
    const p = parseSchutzBlock([name, zeile, '5,64€/ Tag'], 'EUR');
    assert.equal(p.sbBetrag, erwartet, `${name}: ${zeile}`);
  }
});

test('parseSchutzBlock: "keine Selbstbeteiligung" schlaegt "Selbstbeteiligung"', () => {
  // Die Verneinung muss zuerst greifen, sonst wird aus "Sin franquicia" ein
  // Paket MIT Selbstbeteiligung.
  for (const zeile of [
    'Keine Selbstbeteiligung',
    'No deductible',
    'Sin franquicia',
    'Aucune franchise',
    'Nessuna franchigia',
    'Geen eigen risico',
  ]) {
    const p = parseSchutzBlock(['Paket', zeile, '9,00€/ Tag'], 'EUR');
    assert.equal(p.selbstbeteiligung, 'keine', zeile);
    assert.equal(p.sbBetrag, 0, zeile);
  }
});

test('parseSchutzBlock: Rabatt und durchgestrichener Listenpreis', () => {
  const p = parseSchutzBlock(
    ['All Inclusive-Schutz', 'Keine Selbstbeteiligung', '- 51%', '26,42€/ Tag', '53,92€/ Tag'],
    'EUR'
  );
  assert.equal(p.rabattProzent, 51);
  assert.equal(p.proTag, 26.42, 'der gueltige Preis ist der erste');
  assert.equal(p.statt, 53.92, 'der durchgestrichene ist der hoehere');
});

test('parseSchutzBlock: inklusive Pakete kosten 0, nicht null', () => {
  const p = parseSchutzBlock(['Sin protección adicional', 'Incluido'], 'EUR');
  assert.equal(p.inklusive, true);
  assert.equal(p.proTag, 0);
});

test('parseSchutzBlock: leerer Block ergibt null', () => {
  assert.equal(parseSchutzBlock([], 'EUR'), null);
  assert.equal(parseSchutzBlock(['', '  '], 'EUR'), null);
});

test('teileSchutzpakete: getrennt wird an der rating-Zeile', () => {
  // Sixts Bewertungs-Widget steht zuverlaessig unter jedem Paketnamen und ist
  // die einzige sprachunabhaengige Trennmarke.
  const zeilen = [
    'Kein Extra-Schutz', 'rating', 'Selbstbeteiligung: bis Fahrzeugwert', 'Inklusive',
    'Basic-Schutz', 'rating', 'Selbstbeteiligung: bis 1.100,00 €', '9,00€/ Tag',
    'Smart-Schutz', 'rating', 'Keine Selbstbeteiligung', '19,23€/ Tag',
  ];
  const bloecke = teileSchutzpakete(zeilen);
  assert.equal(bloecke.length, 3);
  assert.equal(bloecke[0][0], 'Kein Extra-Schutz');
  assert.equal(bloecke[1][0], 'Basic-Schutz');
  assert.equal(bloecke[2][0], 'Smart-Schutz');
  assert.ok(!bloecke.some((b) => b.includes('rating')), 'rating gehoert nicht in den Block');
});

test('teileSchutzpakete: ohne rating-Zeile gibt es keine Bloecke', () => {
  assert.deepEqual(teileSchutzpakete(['irgendwas', 'anderes']), []);
});
