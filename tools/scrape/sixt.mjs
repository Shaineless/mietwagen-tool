/**
 * Preisabruf fuer Sixt.
 *
 * Ablauf: Laenderseite mit vorbelegten Suchparametern oeffnen, Cookie-Banner
 * ablehnen, Suche ausloesen, auf die Trefferliste warten, Kacheln auslesen.
 *
 * Bewusst ueber `data-testid`-Haken und Textmuster statt ueber CSS-Klassen:
 * die Klassennamen sind generiert (sc-79f1dc24-8) und aendern sich bei jedem
 * Deploy, die Testid-Haken sind seit Jahren stabil.
 */

import { withPage, dismissConsent } from '../browser.mjs';

const TILE = '[data-testid="rent-offer-list-tile"]';
const CTA_MAIN = '[data-testid="rent-search-form-cta"] button';
const CTA_MINI = '[data-testid="rent-minimized-form-cta"] button';

/** Waehrungszeichen, die auf den Sixt-Laenderseiten vorkommen. */
const CUR_RE = /(€|£|\$|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|zł|Kč|Ft|kr)/i;

/**
 * Zahl aus einer Zeile ziehen.
 *
 * Faengt beide Schreibweisen ab: "1.234,56 €" (de) und "£1,234.56" (uk).
 * Das letzte Trennzeichen ist immer das Dezimaltrennzeichen.
 *
 * Zeilen wie "134€49" — Sixts optisch aufgehuebschte Dopplung, bei der das
 * Waehrungszeichen zwischen den Ziffern steht — werden absichtlich NICHT
 * erkannt: es gibt sie immer zusaetzlich in sauberer Form.
 */
export function parseAmount(line) {
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

/** Eine Angebotskachel in ein Datensatz-Objekt uebersetzen. */
export function parseTile(lines, fallbackCurrency) {
  const clean = lines.map((s) => s.trim()).filter(Boolean);
  if (!clean.length) return null;

  const amounts = [];
  for (const line of clean) {
    if (!CUR_RE.test(line)) continue;
    const value = parseAmount(line);
    if (value == null) continue;
    // Der Tagespreis ist die Zeile mit dem Schraegstrich ("134,49€/Tag").
    amounts.push({ value, perDay: line.includes('/') });
  }
  if (!amounts.length) return null;

  const perDay = amounts.find((a) => a.perDay)?.value ?? null;
  const totals = amounts.filter((a) => !a.perDay).map((a) => a.value);
  const total = totals.length ? Math.max(...totals) : null;

  const currency =
    (clean.join(' ').match(CUR_RE) || [])[0]?.toUpperCase() || fallbackCurrency;

  const category = clean[1] || '';
  return {
    model: clean[0],
    category,
    transmission: /automat/i.test(category)
      ? 'Automatik'
      : /manuell|manual|schalt/i.test(category)
        ? 'Schaltung'
        : null,
    unlimitedKm: clean.some((l) => /unbegrenzt|unlimited|ilimitad|illimit/i.test(l)),
    guaranteedModel: !clean.some((l) => /ähnlich|similar|simile|similaire/i.test(l)),
    perDay,
    total,
    currency: currency === '€' ? 'EUR' : currency === '£' ? 'GBP' : currency,
  };
}

/**
 * Preise fuer eine Anfrage holen.
 *
 * @param {object} q
 * @param {string} q.host          z.B. "www.sixt.es"
 * @param {string} q.stationCode   numerische Sixt-Stations-ID (uci)
 * @param {string} [q.returnCode]
 * @param {string} q.pickupDate    yyyy-mm-dd
 * @param {string} q.returnDate    yyyy-mm-dd
 * @param {string} q.pickupTime    hh:mm
 * @param {string} q.returnTime    hh:mm
 * @param {string} [q.currency]    Erwartete Waehrung, dient als Rueckfallwert
 * @param {object} [q.proxy]       { server, username?, password? }
 * @param {string} [q.locale]
 */
export async function quoteSixt(q) {
  const p = new URLSearchParams({
    uci: String(q.stationCode),
    rci: String(q.returnCode || q.stationCode),
    uda: q.pickupDate.replaceAll('-', ''),
    rda: q.returnDate.replaceAll('-', ''),
    uti: q.pickupTime.replace(':', ''),
    rti: q.returnTime.replace(':', ''),
    ctyp: 'P',
  });
  const url = `https://${q.host}/?${p.toString()}`;

  return withPage({ host: q.host, locale: q.locale, proxy: q.proxy }, async (page) => {
    const started = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);

    // Die Maske wird clientseitig aus den URL-Parametern befuellt; erst danach
    // darf die Suche losgehen, sonst sucht sie mit leerer Station.
    await page
      .waitForFunction(
        () => {
          const i = document.querySelector('input[name="pickupLocation"]');
          return i && i.value.trim().length > 0;
        },
        { timeout: 20000 }
      )
      .catch(() => {});

    const station = await page
      .locator('input[name="pickupLocation"]')
      .first()
      .inputValue()
      .catch(() => '');

    if (!station) {
      return { ok: false, error: 'Station wurde nicht übernommen', url };
    }

    // Zweiter Versuch: der Banner kann zwischen Seitenaufbau und Klick
    // aufgetaucht sein und faengt sonst den Klick ab.
    await dismissConsent(page, { timeout: 3000 });

    const cta = page.locator(`${CTA_MAIN}, ${CTA_MINI}`).first();
    await cta.click({ timeout: 15000 });

    // Entweder es kommen Kacheln, oder die Seite meldet "keine Verfügbarkeit".
    try {
      await page.waitForSelector(TILE, { timeout: 45000 });
    } catch {
      const text = await page.locator('body').innerText().catch(() => '');
      const soldOut = /keine.*verfügbar|no.*available|nicht verfügbar|sold out/i.test(text);
      return {
        ok: soldOut,
        offers: [],
        note: soldOut ? 'keine Fahrzeuge verfügbar' : 'Trefferliste kam nicht',
        url: page.url(),
        ms: Date.now() - started,
      };
    }

    // Nach dem ersten Treffer kurz nachladen lassen, damit die Liste vollzählig ist.
    await page.waitForTimeout(1500);

    const raw = await page.$$eval(TILE, (nodes) =>
      nodes.map((n) => n.innerText.split('\n'))
    );

    const offers = raw
      .map((lines) => parseTile(lines, q.currency))
      .filter((o) => o && (o.perDay != null || o.total != null));

    return {
      ok: true,
      station,
      offers,
      url: page.url(),
      ms: Date.now() - started,
    };
  });
}
