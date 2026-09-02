// Erzeugt von build.mjs aus src/offer-parse.js — nicht direkt bearbeiten.

/**
 * Angebotskacheln in Datensaetze uebersetzen.
 *
 * EINZIGE QUELLE fuer diese Logik. build.mjs erzeugt daraus zwei Kopien:
 *   - extension/content.js   (laeuft im Browser des Nutzers)
 *   - tools/scrape/offer-parse.mjs (fuer Node)
 * Bitte nur hier aendern.
 *
 * Absichtlich textbasiert statt ueber CSS-Klassen: Sixts Klassennamen sind
 * generiert (sc-79f1dc24-8) und wechseln bei jedem Deploy. Der sichtbare Text
 * einer Kachel ist deutlich langlebiger.
 */

/**
 * Erkennt, dass in einer Zeile ueberhaupt ein Preis steht.
 *
 * Bewusst weitherzig und ohne Wortgrenzen: die Laenderseiten schreiben die
 * Waehrung mal mit Abstand ("CHF 1'110.32"), mal direkt an die Ziffern
 * ("DKK2.556,01"). Mit \b um die Buchstabencodes fielen genau die Zeilen
 * durch, bei denen kein Abstand steht — die Schweiz, Daenemark, Norwegen,
 * Schweden und Ungarn lieferten daraufhin gar keine Angebote mehr.
 *
 * Ein Fehlgriff ist hier harmlos: findet mwtParseAmount in der Zeile keinen
 * Betrag, faellt sie ohnehin weg. Fuer die Frage, WELCHE Waehrung es ist,
 * taugt dieser Ausdruck dagegen nicht — dafuer gibt es mwtWaehrung.
 */
const MWT_CUR_RE = /(€|£|\$|zł|Kč|лв|₺|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|RON|BGN|Ft|kr)/i;

/**
 * Waehrung eindeutig bestimmen.
 *
 * Zwei Fallen, beide im Testlauf ueber alle 23 Laenderseiten aufgefallen:
 *
 *   "kr"  tragen Daenemark, Norwegen und Schweden gleichermassen. Wer daraus
 *         "KR" macht, vergleicht spaeter daenische mit schwedischen Preisen,
 *         als waere es dieselbe Waehrung.
 *   "TRY" stand ohne Wortgrenze und mit /i in der Liste — und traf damit
 *         mitten in polnischen Woertern wie "elektryczny". Die polnische
 *         Seite wurde dadurch als tuerkische Lira ausgewiesen.
 *
 * Deshalb entscheidet die Laenderseite, nicht der Seitentext: welche Waehrung
 * dort gilt, steht in providers.js und wird als `fallbackCurrency`
 * hereingereicht. Aus dem Text wird nur gelesen, wenn nichts angegeben ist —
 * etwa wenn die Browser-Erweiterung eine Seite meldet, die wir nicht kennen.
 */
const MWT_SYMBOLE = [
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  // Die zusammengesetzten Dollarzeichen zuerst: "A$76.67" ist australisch,
  // "R$246,99" brasilianisch. Wer nur auf "$" prueft, macht US-Dollar daraus.
  [/A\$/, 'AUD'],
  [/R\$/, 'BRL'],
  [/C\$|CA\$/, 'CAD'],
  [/NZ\$/, 'NZD'],
  [/\$/, 'USD'],
  [/zł/i, 'PLN'],
  [/Kč/i, 'CZK'],
  [/лв/i, 'BGN'],
  [/₺/, 'TRY'],
  [/\bFt\b/, 'HUF'],
  [/\b(CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|RON|BGN)\b/, null], // steht schon als Code da
];

function mwtWaehrung(text, fallbackCurrency) {
  // Die Angabe der Laenderseite hat Vorrang: sie ist gepflegt, der Seitentext
  // ist geraten.
  if (fallbackCurrency) return String(fallbackCurrency).toUpperCase();

  for (const [re, code] of MWT_SYMBOLE) {
    const m = text.match(re);
    if (m) return code || m[1].toUpperCase();
  }
  // "kr" allein bleibt unbestimmt — lieber nichts sagen als das Falsche.
  return '';
}

/**
 * Betrag aus einer Zeile ziehen.
 *
 * Faengt die Schreibweisen der Laenderseiten ab: "1.234,56 €" (de),
 * "£1,234.56" (uk), "1 234,56" (fr) und "CHF 1'234.55" (ch). Das jeweils
 * letzte Punkt oder Komma ist das Dezimaltrennzeichen.
 *
 * Der Apostroph hat gefehlt, und der Fehler war unsichtbar: aus "1'110.32"
 * wurde nicht etwa nichts, sondern "110.32" — der Ausdruck setzte einfach
 * hinter dem Apostroph neu an. Ein 7er BMW stand dadurch mit 110 Franken in
 * der Tabelle. Genau deshalb steht darunter die Stimmigkeitspruefung: ein
 * Betrag, der still um eine Stelle daneben liegt, ist schlimmer als gar
 * keiner.
 *
 * Zeilen wie "134€49" — Sixts optisch aufgehuebschte Dopplung, bei der das
 * Waehrungszeichen zwischen den Ziffern steht — werden bewusst NICHT erkannt:
 * es gibt sie immer zusaetzlich in sauberer Form, und ein Fehlgriff hier
 * verfaelscht still den Preis.
 */
function mwtParseAmount(line) {
  const m = line.match(/\d{1,3}(?:[.,\s'’′  ]\d{3})*[.,]\d{2}|\d+[.,]\d{2}/);
  if (!m) return null;

  const raw = m[0].replace(/[\s'’′  ]/g, '');
  const lastSep = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
  if (lastSep < 0) return null;

  const whole = raw.slice(0, lastSep).replace(/[.,]/g, '');
  const frac = raw.slice(lastSep + 1);
  const value = Number(`${whole}.${frac}`);
  return Number.isFinite(value) ? value : null;
}

/**
 * Eine Kachel in einen Datensatz uebersetzen.
 *
 * @param {{lines:string[], offerId?:string, image?:string}|string[]} roh
 *        Zeilen der Kachel, dazu — falls vorhanden — die offer-id
 *        ("CDAR-110-110", die ersten vier Zeichen sind der ACRISS-Code)
 *        und die Bildadresse.
 */
function mwtParseTile(roh, fallbackCurrency) {
  const daten = Array.isArray(roh) ? { lines: roh } : roh || {};
  const lines = daten.lines || [];
  const clean = lines.map((s) => s.trim()).filter(Boolean);
  if (!clean.length) return null;

  // "CDAR-110-110" -> "CDAR". Vier Grossbuchstaben, sonst verwerfen.
  const acrissRoh = String(daten.offerId || '').split('-')[0].toUpperCase();
  const acriss = /^[A-Z]{4}$/.test(acrissRoh) ? acrissRoh : null;

  const amounts = [];
  for (const line of clean) {
    if (!MWT_CUR_RE.test(line)) continue;
    const value = mwtParseAmount(line);
    if (value == null) continue;
    // Der Tagespreis ist die Zeile mit dem Schraegstrich ("134,49€/Tag").
    amounts.push({ value, perDay: line.includes('/') });
  }
  if (!amounts.length) return null;

  const perDay = amounts.find((a) => a.perDay)?.value ?? null;
  const totals = amounts.filter((a) => !a.perDay).map((a) => a.value);
  const total = totals.length ? Math.max(...totals) : null;

  const currency = mwtWaehrung(clean.join(' '), fallbackCurrency);

  // Aktionen aus dem Kacheltext. Ohne die ist ein Preisvergleich wertlos:
  // laeuft auf einer Laenderseite gerade der Fruehbucherrabatt und auf einer
  // anderen nicht, vergleicht man zwei verschiedene Dinge.
  const aktionen = [];
  let fruehbucher = false;
  for (const l of clean) {
    if (/frühbucher|fruehbucher|early bird|early book|prenota prima|reserva anticipada/i.test(l)) {
      fruehbucher = true;
      aktionen.push(l);
    } else if (/top[- ]angebot|top deal|bestpreis|best price|special offer|aktion/i.test(l)) {
      aktionen.push(l);
    }
  }

  const category = clean[1] || '';
  return {
    acriss,
    image: daten.image || null,
    aktionen,
    fruehbucher,
    model: clean[0],
    category,
    transmission: /automat/i.test(category)
      ? 'Automatik'
      : /manuell|manual|schalt|manuale|manuelle/i.test(category)
        ? 'Schaltung'
        : null,
    unlimitedKm: clean.some((l) => /unbegrenzt|unlimited|ilimitad|illimit|onbeperkt/i.test(l)),
    guaranteedModel: !clean.some((l) => /ähnlich|similar|simile|similaire|vergelijkbaar/i.test(l)),
    perDay,
    total,
    currency,
  };
}


export { mwtParseTile, mwtParseAmount };
