/**
 * Preisabruf fuer Europcar.
 *
 * Anders als bei Sixt wird hier keine Trefferliste ausgelesen. Europcars
 * Seite holt ihre Angebote selbst als JSON von api.aws.emobg.io, und genau
 * diese Anfrage stellt der Abruf auch: aus einer geoeffneten europcar.de-
 * Seite heraus, mit dem oeffentlichen Schluessel, den die Seite in ihrer
 * Konfiguration (window.__NUXT__.config) mitbringt. Der Schluessel steht
 * bewusst nirgends fest im Code; wechselt Europcar ihn, kommt der neue mit.
 *
 * Warum aus der Seite und nicht direkt: europcar.de steht hinter Akamai. Ein
 * echtes Chrome mit geladener Seite ist das, was Europcar ohnehin sieht.
 *
 * Gemessen an Koeln Hbf (CGNL01), 04.-07.11.2026: 31 Fahrzeuge, je mit
 * ACRISS, Modell, Bild und zwei Preisen (Vorauszahlung, Zahlung bei Abholung).
 */

import { withPage } from '../browser.mjs';

const HOST = 'www.europcar.de';

/** Europcar rechnet je Tarif; verglichen wird der guenstigste. */
function guenstigsterTarif(rates = []) {
  let best = null;
  for (const r of rates) {
    const p = r.priceInCustomerCurrency;
    if (p?.amount == null) continue;
    if (!best || p.amount < best.priceInCustomerCurrency.amount) best = r;
  }
  return best;
}

/** Ein Eintrag aus `data` in dasselbe Format, das der Sixt-Leser liefert. */
export function europcarAngebot(d) {
  const car = d.car || {};
  const tarif = guenstigsterTarif(d.rates);
  if (!car.acriss || !tarif) return null;
  const preis = tarif.priceInCustomerCurrency;
  const km = tarif.policies?.mileage;
  return {
    acriss: car.acriss,
    image: car.photos?.left?.medium || car.photos?.left?.small || null,
    aktionen: [],
    fruehbucher: false,
    model: car.model || car.acriss,
    category: car.category || '',
    transmission: car.engine?.automatic ? 'Automatik' : 'Schaltung',
    unlimitedKm: Boolean(km?.isUnlimited),
    // Ohne unbegrenzte Kilometer steht dabei, wie viele drin sind. Bei 3 Tagen
    // Koeln waren es 1.200 km, ein echter Unterschied zu Sixt.
    kmInklusive: km && !km.isUnlimited ? km.included : null,
    guaranteedModel: Boolean(car.modelGuaranteed),
    perDay: preis.amountPerDay ?? null,
    total: preis.amount,
    currency: preis.currency,
    tarif: tarif.type === 'PREPAID' ? 'Vorauszahlung' : 'Zahlung bei Abholung',
  };
}

/**
 * @param {object} q wie quoteSixt; stationCode ist Europcars Kennung (CGNL01).
 */
export async function quoteEuropcar(q) {
  const started = Date.now();
  const params = {
    'pickup-station-code': q.stationCode,
    'drop-off-station-code': q.returnCode || q.stationCode,
    'pickup-date': `${q.pickupDate}T${q.pickupTime}:00`,
    'drop-off-date': `${q.returnDate}T${q.returnTime}:00`,
    'country-of-residence': 'DE',
    'driver-age': '26',
    limit: '100',
    offset: '0',
  };

  return withPage({ host: HOST, sichtbar: q.sichtbar, inkognito: q.inkognito }, async (page) => {
    await page.goto(`https://${HOST}/de-de`, { waitUntil: 'domcontentloaded' });
    const bereit = await page
      .waitForFunction(() => window.__NUXT__?.config?.offersApiKey || window.__NUXT__?.config?.public?.offersApiKey, undefined, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!bereit) {
      const text = await page.locator('body').innerText().catch(() => '');
      return {
        ok: false,
        error: /access denied|blocked/i.test(text) ? 'Zugriff von der Seite blockiert' : 'Europcar-Seite lud nicht',
        ms: Date.now() - started,
      };
    }

    const antwort = await page.evaluate(async (params) => {
      const c = window.__NUXT__.config;
      const key = c.offersApiKey || c.public?.offersApiKey;
      const basis = c.offersEndpoint || c.public?.offersEndpoint || 'https://api.aws.emobg.io';
      const u = `${basis}/group-direct-channel-context/v1/offers?` +
        new URLSearchParams({ apikey: key, origin: `${location.hostname}/onesite`, ...params });
      const r = await fetch(u, { headers: { 'Accept-Language': 'de-DE', 'Cache-Control': 'no-cache' } });
      return { status: r.status, text: await r.text() };
    }, params);

    let json = null;
    try { json = JSON.parse(antwort.text); } catch { /* unten gemeldet */ }

    if (antwort.status !== 200 || !json) {
      // Europcar meldet Gruende im Klartext, etwa eine geschlossene Station.
      const grund = json?.message || `Antwort ${antwort.status}`;
      const nichts = /no offer|not available|closed|opening/i.test(grund);
      return {
        ok: nichts,
        offers: [],
        error: nichts ? null : grund,
        note: nichts ? 'An diesem Termin bietet die Station nichts an' : null,
        ms: Date.now() - started,
      };
    }

    const offers = (json.data || []).map(europcarAngebot).filter(Boolean);
    return {
      ok: true,
      station: q.stationCode,
      offers,
      note: offers.length ? null : 'An diesem Termin bietet die Station nichts an',
      url: `https://${HOST}/de-de`,
      ms: Date.now() - started,
    };
  });
}
