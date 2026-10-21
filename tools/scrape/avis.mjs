/**
 * Preisabruf fuer Avis.
 *
 * Avis' Suche ist ein schlichtes GET auf secure.avis.de/mietwagensuche, die
 * Trefferliste kommt fertig gerendert. Jede Fahrzeugkarte traegt alles als
 * Attribut, sprach- und zahlenformatunabhaengig:
 *
 *   data-acriss-sipp="CDMR"  data-vehicle-name="Seat Leon"
 *   data-pay-online-price="304.07"  data-pay-collection-price="349.67"
 *
 * Gelesen werden nur diese Attribute, kein sichtbarer Text, ausser fuer die
 * Kilometer. Geprueft an Flughafen Koeln/Bonn (CGN), 04.-07.11.2026: 15
 * Fahrzeuge, alle mit unbegrenzten Kilometern.
 *
 * `data-transmission` taugt nicht: beim Seat Leon stand dort "auto", auf der
 * Karte "Schaltung". Das Getriebe kommt deshalb aus dem ACRISS-Code.
 */

import { withPage, dismissConsent } from '../browser.mjs';

const HOST = 'secure.avis.de';

/** TT/MM/JJJJ, so erwartet es das versteckte Feld der Suchmaske. */
const datum = (iso) => iso.split('-').reverse().join('/');

export function avisUrl(q) {
  const p = new URLSearchParams({
    vehicleCategory: 'car', fleet: 'car', 'hire-country': 'DE',
    'hire-location': q.stationCode, 'return-location': q.returnCode || q.stationCode,
    'date-from': datum(q.pickupDate), 'time-from': q.pickupTime.replace(':', ''),
    'date-to': datum(q.returnDate), 'time-to': q.returnTime.replace(':', ''),
    rentalType: 'leisure_check', exclusiveSearch: 'true', isNewHomePageTemplate: 'true',
  });
  return `https://${HOST}/mietwagensuche?${p}`;
}

export async function quoteAvis(q) {
  const started = Date.now();
  const url = avisUrl(q);

  return withPage({ host: HOST, sichtbar: q.sichtbar, inkognito: q.inkognito }, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    dismissConsent(page, { timeout: 2500 }).catch(() => {});

    const ausgang = await page
      .waitForSelector('[data-acriss-sipp]', { timeout: 45000 })
      .then(() => 'liste')
      .catch(() => 'nichts');

    if (ausgang !== 'liste') {
      const text = await page.locator('body').innerText().catch(() => '');
      const blockiert = /access denied|request has been blocked|ungewöhnliche aktivität/i.test(text);
      const nichts = /keine fahrzeuge|nicht verfügbar|geschlossen|no vehicles/i.test(text);
      return {
        ok: nichts,
        offers: [],
        error: blockiert ? 'Zugriff von der Seite blockiert' : nichts ? null : 'Trefferliste kam nicht',
        note: nichts ? 'An diesem Termin bietet die Station nichts an' : null,
        url: page.url(),
        ms: Date.now() - started,
      };
    }

    const roh = await page.$$eval('[data-acriss-sipp]', (nodes) =>
      nodes.map((n) => ({
        acriss: n.dataset.acrissSipp,
        model: n.dataset.vehicleName,
        online: n.dataset.payOnlinePrice,
        abholung: n.dataset.payCollectionPrice,
        image: n.querySelector('img')?.src || null,
        unbegrenzt: /unbegrenzte kilometer/i.test(n.innerText),
        gruppe: n.dataset.vehicleGroup,
      }))
    );

    const tage = Math.max(1, Math.round((new Date(q.returnDate + 'T12:00:00') - new Date(q.pickupDate + 'T12:00:00')) / 86400000));
    const offers = roh
      .map((r) => {
        const preise = [Number(r.online), Number(r.abholung)].filter((x) => Number.isFinite(x) && x > 0);
        if (!r.acriss || !preise.length) return null;
        const total = Math.min(...preise);
        return {
          acriss: r.acriss.toUpperCase(),
          image: r.image,
          aktionen: [],
          fruehbucher: false,
          model: r.model || r.acriss,
          category: r.gruppe ? `Fahrzeuggruppe ${r.gruppe}` : '',
          // Dritter Buchstabe des ACRISS-Codes: A/B/D automatisch, M/N/C geschaltet.
          transmission: /^..[ABD]/.test(r.acriss.toUpperCase()) ? 'Automatik' : 'Schaltung',
          unlimitedKm: r.unbegrenzt,
          kmInklusive: null,
          guaranteedModel: false,
          perDay: Math.round((total / tage) * 100) / 100,
          total,
          currency: 'EUR',
          tarif: total === Number(r.online) ? 'Online zahlen' : 'Zahlung bei Abholung',
        };
      })
      .filter(Boolean);

    return { ok: true, station: q.stationCode, offers, url: page.url(), ms: Date.now() - started };
  });
}
