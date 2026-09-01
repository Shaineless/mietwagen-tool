/**
 * Preisabruf fuer Sixt.
 *
 * Ablauf je Anfrage: Laenderseite mit vorbelegten Suchparametern oeffnen,
 * Cookie-Banner ablehnen, warten bis die Maske aus den URL-Parametern befuellt
 * ist, Suche ausloesen, Trefferliste abwarten, Kacheln auslesen.
 *
 * Angesprochen wird alles ueber `data-testid`-Haken und Textmuster, nicht ueber
 * CSS-Klassen: die Klassennamen sind generiert (sc-79f1dc24-8) und wechseln bei
 * jedem Deploy.
 *
 * Geprueft gegen sixt.de und sixt.co.uk — beide Sprachen, beide Zahlenformate.
 */

import { withPage, dismissConsent } from '../browser.mjs';
import { mwtParseTile } from './offer-parse.mjs';

const TILE = '[data-testid="rent-offer-list-tile"]';
const CTA =
  '[data-testid="rent-search-form-cta"] button, [data-testid="rent-minimized-form-cta"] button';

/**
 * @param {object} q
 * @param {string} q.host        z.B. "www.sixt.es"
 * @param {string} q.stationCode numerische Sixt-Stations-ID (uci)
 * @param {string} [q.returnCode]
 * @param {string} q.pickupDate  yyyy-mm-dd
 * @param {string} q.returnDate  yyyy-mm-dd
 * @param {string} q.pickupTime  hh:mm
 * @param {string} q.returnTime  hh:mm
 * @param {string} [q.currency]  Rueckfallwert, falls die Seite keins zeigt
 * @param {boolean} [q.sichtbar] Browserfenster anzeigen statt verstecken
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
  const started = Date.now();

  return withPage({ host: q.host, sichtbar: q.sichtbar }, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);

    // Die Maske wird clientseitig aus den URL-Parametern befuellt. Erst danach
    // darf die Suche los, sonst sucht sie mit leerer Station.
    const bereit = await page
      .waitForFunction(
        () => {
          const i = document.querySelector('input[name="pickupLocation"]');
          return i && i.value.trim().length > 0;
        },
        { timeout: 25000 }
      )
      .then(() => true)
      .catch(() => false);

    const station = await page
      .locator('input[name="pickupLocation"]')
      .first()
      .inputValue()
      .catch(() => '');

    if (!bereit || !station) {
      return { ok: false, error: 'Station wurde nicht übernommen', url, ms: Date.now() - started };
    }

    // Der Banner kann zwischen Aufbau und Klick aufgetaucht sein.
    await dismissConsent(page, { versuche: 2 });
    await page.waitForTimeout(600);

    try {
      await page.locator(CTA).first().click({ timeout: 15000 });
    } catch {
      return { ok: false, station, error: 'Suche ließ sich nicht auslösen', url, ms: Date.now() - started };
    }

    const kamen = await page
      .waitForSelector(TILE, { timeout: 60000 })
      .then(() => true)
      .catch(() => false);

    if (!kamen) {
      const text = await page.locator('body').innerText().catch(() => '');
      const blockiert = /access denied|request has been blocked/i.test(text);
      const ausgebucht = /keine.*verfügbar|nicht verfügbar|no.*available|sold out/i.test(text);
      return {
        ok: ausgebucht,
        station,
        offers: [],
        error: blockiert
          ? 'Zugriff von der Seite blockiert'
          : ausgebucht
            ? null
            : 'Trefferliste kam nicht',
        note: ausgebucht ? 'keine Fahrzeuge verfügbar' : null,
        url: page.url(),
        ms: Date.now() - started,
      };
    }

    // Die Liste laedt nach. Warten, bis die Anzahl zweimal gleich bleibt.
    let letzte = -1;
    let stabil = 0;
    while (stabil < 2) {
      await page.waitForTimeout(1200);
      const n = await page.locator(TILE).count();
      stabil = n === letzte ? stabil + 1 : 0;
      letzte = n;
    }

    const roh = await page.$$eval(TILE, (nodes) => nodes.map((n) => n.innerText.split('\n')));
    const offers = roh
      .map((lines) => mwtParseTile(lines, q.currency))
      .filter((o) => o && (o.perDay != null || o.total != null));

    return { ok: true, station, offers, url: page.url(), ms: Date.now() - started };
  });
}
