/**
 * Preisabruf fuer Hertz.
 *
 * Hertz' neue Buchungsseite (/de/de/book/vehicles) laesst sich mit allen
 * Reiseparametern direkt aufrufen. Sie holt ihre Fahrzeuge dann selbst als
 * JSON von api.hertz.io/vehicle-rates, mit einem Gast-Token, den sie sich
 * vorher besorgt. Der Abruf macht nichts weiter, als diese eine Antwort
 * abzufangen: kein Formular, kein Klick, kein eigener Token.
 *
 * Gemessen an Frankfurt Flughafen (FRAT50), 04.-07.11.2026: 24 Fahrzeuge in
 * 4,4 Sekunden, je mit SIPP-Code, Modell und zwei Tarifen (Vorauszahlung,
 * Zahlung bei Abholung).
 *
 * Der Weg ueber die alte Suchmaske (/rentacar/reservation/) fuehrt zur
 * selben Seite, nur ueber einen POST mit vierzig Feldern und einer Altersfrage
 * dazwischen. Den braucht niemand mehr.
 */

import { withPage } from '../browser.mjs';

const HOST = 'www.hertz.de';

/** Der guenstigste Tarif eines Fahrzeugs; Hertz rechnet je Tarif alles ein. */
function guenstigsterTarif(pricing = {}) {
  let best = null;
  for (const p of Object.values(pricing)) {
    if (p?.approximate_total == null) continue;
    if (!best || p.approximate_total < best.approximate_total) best = p;
  }
  return best;
}

/** Ein Eintrag aus der Antwort in das Format des Sixt-Lesers. */
export function hertzAngebot(v) {
  const tarif = guenstigsterTarif(v.pricing);
  if (!v.sipp_code || !tarif) return null;
  const km = (tarif.policy_messages || []).find((m) => (m.tags || []).includes('TOTAL_DISTANCE_INCLUDED'));
  const kmZahl = km ? Number(km.aem_parameters?.[0]) : null;
  const unbegrenzt = (tarif.policy_messages || []).some((m) => /unlimited|unbegrenzt/i.test(m.message || ''));
  return {
    acriss: v.sipp_code,
    // Hertz haelt je SIPP-Code ein Bild vor, nicht je Modell.
    image: `https://${HOST}/content/dam/hertz/de/vehicles/${v.sipp_code}.rendition.vlarge.webp`,
    aktionen: [],
    fruehbucher: false,
    model: v.make_model || v.vehicle_display_name || v.sipp_code,
    category: v.vehicle_display_name || v.vehicle_category || '',
    transmission: v.features?.transmission_type === 'AUTO' ? 'Automatik' : 'Schaltung',
    unlimitedKm: unbegrenzt,
    kmInklusive: !unbegrenzt && Number.isFinite(kmZahl) ? kmZahl : null,
    guaranteedModel: Boolean(v.can_book_exact_vehicle),
    perDay: tarif.calculated_daily_rate ?? null,
    total: tarif.approximate_total,
    currency: tarif.currency || 'EUR',
    tarif: /PAYNOW/.test(tarif.rate_type || '') ? 'Vorauszahlung' : 'Zahlung bei Abholung',
  };
}

export function hertzUrl(q) {
  return `https://${HOST}/de/de/book/vehicles?` + new URLSearchParams({
    pid: q.stationCode,
    did: q.returnCode || q.stationCode,
    pdate: `${q.pickupDate}T${q.pickupTime}:00`,
    ddate: `${q.returnDate}T${q.returnTime}:00`,
    pCountryCode: 'DE',
    age: '27',
    travelType: 'LEISURE',
  });
}

export async function quoteHertz(q) {
  const started = Date.now();
  const url = hertzUrl(q);

  return withPage({ host: HOST, sichtbar: q.sichtbar, inkognito: q.inkognito }, async (page) => {
    // Erst lauschen, dann laden: die Antwort kommt sonst, bevor jemand zuhoert.
    const antwort = page
      .waitForResponse((r) => r.url().includes('/vehicle-rates'), { timeout: 45000 })
      .catch(() => null);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const r = await antwort;

    if (!r) {
      const text = await page.locator('body').innerText().catch(() => '');
      return {
        ok: false,
        offers: [],
        error: /access denied|blocked|request unsuccessful/i.test(text) ? 'Zugriff von der Seite blockiert' : 'Preisliste kam nicht',
        url,
        ms: Date.now() - started,
      };
    }

    let json = null;
    try { json = JSON.parse(await r.text()); } catch { /* unten gemeldet */ }
    const liste = Array.isArray(json) ? json : null;
    if (r.status() !== 200 || !liste) {
      // Hertz meldet "keine Fahrzeuge" als Fehlerobjekt, nicht als leere Liste.
      const nichts = r.status() === 400 || r.status() === 404;
      return {
        ok: nichts,
        offers: [],
        error: nichts ? null : `Antwort ${r.status()}`,
        note: nichts ? 'An diesem Termin bietet die Station nichts an' : null,
        url,
        ms: Date.now() - started,
      };
    }

    const offers = liste.map(hertzAngebot).filter(Boolean);
    return {
      ok: true,
      station: q.stationCode,
      offers,
      note: offers.length ? null : 'An diesem Termin bietet die Station nichts an',
      url,
      ms: Date.now() - started,
    };
  });
}
