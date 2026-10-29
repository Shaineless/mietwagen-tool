/**
 * Preisabruf fuer Enterprise.
 *
 * Enterprise' Buchungsmaske schickt die Suche als POST an die eigene
 * Schnittstelle (prd-east.webapi.enterprise.de, "reservations/initiate") und
 * bekommt alle Klassen samt Preisen in einer Antwort zurueck, rund 600 kB.
 * Der Abruf stellt genau diese Anfrage, aus einer geoeffneten enterprise.de-
 * Seite heraus. Vorher holt er die Stationsdaten (Koordinate, Gruppenkennung),
 * die der POST mitverlangt, mit einem GET von derselben Schnittstelle.
 *
 * Aus einem frisch gestarteten Playwright-Chromium weist Enterprise den POST
 * schon am Vorab-Check ab (ERR_FAILED); aus TRACKERs eigenem Chrome, dem das
 * auch Sixt gestattet, geht er durch. Gemessen an Koeln Hbf (1050672),
 * 25.-28.11.2026: 75 Klassen, 46 davon verfuegbar.
 */

import { withPage } from '../browser.mjs';

const HOST = 'www.enterprise.de';
const API = 'https://prd-east.webapi.enterprise.de/enterprise-ewt';

/** Ein Eintrag aus car_classes in das Format des Sixt-Lesers. */
export function enterpriseAngebot(c) {
  if (!c.code || !/^AVAILABLE/.test(c.status || '')) return null;
  let best = null;
  for (const ch of Object.values(c.charges || {})) {
    const p = Number(ch?.total_price_view?.amount);
    if (!Number.isFinite(p) || ch.total_price_view?.code === 'Pts') continue;
    if (!best || p < best.preis) best = { preis: p, cur: ch.total_price_view.code, art: ch.charge_type, tag: Number(ch.rates?.[0]?.unit_amount_view?.amount) };
  }
  if (!best) return null;
  const bild = c.images?.SideProfile?.path || c.images?.ThreeQuarter?.path || null;
  return {
    acriss: c.code,
    image: bild ? bild.replace('{width}', '320').replace('{quality}', 'high') : null,
    aktionen: [],
    fruehbucher: false,
    model: c.make_model_or_similar_text || c.name || c.code,
    category: c.name || c.sub_category?.name || '',
    transmission: /26/.test(c.filters?.TRANSMISSION?.filter_code || '') || /schalt/i.test(c.filters?.TRANSMISSION?.filter_description || '') ? 'Schaltung' : 'Automatik',
    unlimitedKm: Boolean(c.mileage_info?.unlimited_mileage),
    kmInklusive: null,
    guaranteedModel: Boolean(c.guaranteed_vehicle),
    perDay: Number.isFinite(best.tag) ? best.tag : null,
    total: best.preis,
    currency: best.cur || 'EUR',
    tarif: best.art === 'PREPAY' ? 'Vorauszahlung' : 'Zahlung bei Abholung',
  };
}

export async function quoteEnterprise(q) {
  const started = Date.now();
  const pickup = `${q.pickupDate}T${q.pickupTime}`;
  const dropoff = `${q.returnDate}T${q.returnTime}`;

  return withPage({ host: HOST, sichtbar: q.sichtbar, inkognito: q.inkognito }, async (page) => {
    await page.goto(`https://${HOST}/de/home.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const antwort = await page.evaluate(async ({ API, id, rid, pickup, dropoff }) => {
      const h = {
        'content-type': 'application/json', accept: 'application/json, text/plain, */*',
        brand: 'ENTERPRISE', channel: 'WEB', locale: 'de_DE', domain_country_of_residence: 'DE',
        page_type: 'home', request_origin_page: '/de/home.html', sofresh: 'SOCLEAN', tab_id: Date.now() + '_1',
      };
      const ort = async (kennung) => {
        const r = await fetch(`${API}/location/${kennung}?type=both`, { headers: h, credentials: 'include' });
        if (!r.ok) return null;
        const l = (await r.json()).location;
        if (!l) return null;
        return {
          airport_code: l.airport_code || '', location_type: 'BRANCH', my_location: false,
          gps: l.gps, name: l.name, country_code: l.address?.country_code || 'DE',
          branch_type: l.location_type, group_branch_id: l.location_id, type: 'BRANCH', id: l.id,
          time_zone_id: 'Europe/Berlin',
        };
      };
      const abhol = await ort(id);
      if (!abhol) return { status: 0, text: 'Station unbekannt' };
      const rueck = rid === id ? abhol : await ort(rid);
      const body = {
        pickup_location_id: id, pickup_location: abhol, return_location_id: rid, return_location: rueck || abhol,
        renter_age: 30, renter_age_label: '30+', pickup_time: pickup, return_time: dropoff,
        applied_vehicle_class_filters: [], country_of_residence_code: 'DE', enable_north_american_prepay_rates: true,
        view_currency_code: 'EUR', check_if_no_vehicles_available: true, check_if_oneway_allowed: true,
      };
      try {
        const r = await fetch(`${API}/reservations/initiate`, { method: 'POST', headers: h, body: JSON.stringify(body), credentials: 'include' });
        const text = await r.text();
        // Nur die Klassen zurueckgeben, nicht 600 kB Sitzung.
        try {
          const j = JSON.parse(text);
          return { status: r.status, klassen: j?.session?.gbo?.reservation?.car_classes || null, meldungen: j?.messages || null };
        } catch { return { status: r.status, text: text.slice(0, 300) }; }
      } catch (e) { return { status: 0, text: String(e) }; }
    }, { API, id: String(q.stationCode), rid: String(q.returnCode || q.stationCode), pickup, dropoff });

    if (antwort.status !== 200 || !Array.isArray(antwort.klassen)) {
      const text = antwort.text || JSON.stringify(antwort.meldungen || '');
      const nichts = /no vehicles|keine fahrzeuge|not available|closed/i.test(text);
      return {
        ok: nichts,
        offers: [],
        error: nichts ? null : antwort.status === 0 ? 'Enterprise-Seite antwortet nicht' : `Antwort ${antwort.status}: ${text.slice(0, 120)}`,
        note: nichts ? 'An diesem Termin bietet die Station nichts an' : null,
        ms: Date.now() - started,
      };
    }

    const offers = antwort.klassen.map(enterpriseAngebot).filter(Boolean);
    return {
      ok: true,
      station: q.stationCode,
      offers,
      note: offers.length ? null : 'An diesem Termin bietet die Station nichts an',
      url: `https://${HOST}/de/home.html`,
      ms: Date.now() - started,
    };
  });
}
