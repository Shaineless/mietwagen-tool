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

/** Waehrungszeichen, die auf den Laenderseiten vorkommen. */
const MWT_CUR_RE = /(€|£|\$|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|zł|Kč|Ft|kr)/i;

/**
 * Betrag aus einer Zeile ziehen.
 *
 * Faengt beide Schreibweisen ab: "1.234,56 €" (de) und "£1,234.56" (uk).
 * Das jeweils letzte Trennzeichen ist das Dezimaltrennzeichen.
 *
 * Zeilen wie "134€49" — Sixts optisch aufgehuebschte Dopplung, bei der das
 * Waehrungszeichen zwischen den Ziffern steht — werden bewusst NICHT erkannt:
 * es gibt sie immer zusaetzlich in sauberer Form, und ein Fehlgriff hier
 * verfaelscht still den Preis.
 */
function mwtParseAmount(line) {
  const m = line.match(/\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2}|\d+[.,]\d{2}/);
  if (!m) return null;

  const raw = m[0].replace(/\s/g, '');
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

  let currency = (clean.join(' ').match(MWT_CUR_RE) || [])[0] || fallbackCurrency || '';
  if (currency === '€') currency = 'EUR';
  else if (currency === '£') currency = 'GBP';
  else if (currency === '$') currency = 'USD';
  else currency = String(currency).toUpperCase();

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
