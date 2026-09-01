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
import { mwtParseTile } from './offer-parse.mjs';

const TILE = '[data-testid="rent-offer-list-tile"]';
const CTA_MAIN = '[data-testid="rent-search-form-cta"] button';
const CTA_MINI = '[data-testid="rent-minimized-form-cta"] button';

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
      return { ok: false, error: 'Station wurde nicht Ã¼bernommen', url };
    }

    // Zweiter Versuch: der Banner kann zwischen Seitenaufbau und Klick
    // aufgetaucht sein und faengt sonst den Klick ab.
    await dismissConsent(page, { timeout: 3000 });

    const cta = page.locator(`${CTA_MAIN}, ${CTA_MINI}`).first();
    await cta.click({ timeout: 15000 });

    // Entweder es kommen Kacheln, oder die Seite meldet "keine VerfÃ¼gbarkeit".
    try {
      await page.waitForSelector(TILE, { timeout: 45000 });
    } catch {
      const text = await page.locator('body').innerText().catch(() => '');
      const soldOut = /keine.*verfÃ¼gbar|no.*available|nicht verfÃ¼gbar|sold out/i.test(text);
      return {
        ok: soldOut,
        offers: [],
        note: soldOut ? 'keine Fahrzeuge verfÃ¼gbar' : 'Trefferliste kam nicht',
        url: page.url(),
        ms: Date.now() - started,
      };
    }

    // Nach dem ersten Treffer kurz nachladen lassen, damit die Liste vollzÃ¤hlig ist.
    await page.waitForTimeout(1500);

    const raw = await page.$$eval(TILE, (nodes) =>
      nodes.map((n) => n.innerText.split('\n'))
    );

    const offers = raw
      .map((lines) => mwtParseTile(lines, q.currency))
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
