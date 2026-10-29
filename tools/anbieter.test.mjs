/**
 * Die Leser der weiteren Anbieter, je an einem echten Ausschnitt der Antwort.
 *
 * Jeder Anbieter liefert JSON in eigener Form; hier steht fest, was daraus
 * im gemeinsamen Format ankommen muss: Code, Modell, Gesamtpreis, Kilometer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { europcarAngebot } from './scrape/europcar.mjs';
import { hertzAngebot } from './scrape/hertz.mjs';
import { enterpriseAngebot } from './scrape/enterprise.mjs';

test('Europcar: guenstigster Tarif, Kilometergrenze', () => {
  const o = europcarAngebot({
    car: { acriss: 'CDMR', model: 'VW GOLF', engine: { automatic: false }, photos: { left: { medium: 'bild.png' } } },
    rates: [
      { type: 'PREPAID', priceInCustomerCurrency: { amount: 246.81, amountPerDay: 82.27, currency: 'EUR' }, policies: { mileage: { isUnlimited: false, included: 1200 } } },
      { type: 'PAY_ON_ARRIVAL', priceInCustomerCurrency: { amount: 270.0, amountPerDay: 90, currency: 'EUR' }, policies: { mileage: { isUnlimited: false, included: 1200 } } },
    ],
  });
  assert.equal(o.total, 246.81);
  assert.equal(o.tarif, 'Vorauszahlung');
  assert.equal(o.kmInklusive, 1200);
  assert.equal(o.transmission, 'Schaltung');
});

test('Hertz: approximate_total ist der Endpreis, Kilometer aus der Meldung', () => {
  const o = hertzAngebot({
    sipp_code: 'CDMR', make_model: 'KIA CEED', features: { transmission_type: 'MANUAL' },
    pricing: {
      a: { rate_type: 'PAYLATER', approximate_total: 232.95, calculated_daily_rate: 44.83, currency: 'EUR', policy_messages: [{ tags: ['TOTAL_DISTANCE_INCLUDED'], aem_parameters: ['1200', 'km'], message: '1200 kms included per rental.' }] },
      b: { rate_type: 'NON_REFUNDABLE_PAYNOW', approximate_total: 211.78, calculated_daily_rate: 40.12, currency: 'EUR', policy_messages: [{ tags: ['TOTAL_DISTANCE_INCLUDED'], aem_parameters: ['1200', 'km'], message: '1200 kms included per rental.' }] },
    },
  });
  assert.equal(o.total, 211.78);
  assert.equal(o.tarif, 'Vorauszahlung');
  assert.equal(o.kmInklusive, 1200);
  assert.match(o.image, /CDMR\.rendition/);
});

test('Enterprise: Punkte zaehlen nicht, ausverkauft faellt weg', () => {
  const eur = (amount) => ({ code: 'EUR', amount: String(amount) });
  const o = enterpriseAngebot({
    code: 'CDMR', status: 'AVAILABLE_AT_RETAIL_RATE', make_model_or_similar_text: 'Volkswagen Golf', name: 'Kompaktklasse',
    mileage_info: { unlimited_mileage: true }, filters: { TRANSMISSION: { filter_code: '26' } },
    images: { SideProfile: { path: 'https://x/CDMR.{width}.{quality}.png' } },
    charges: {
      PREPAY: { charge_type: 'PREPAY', total_price_view: eur(167.34), rates: [{ unit_amount_view: eur(55.78) }] },
      REDEMPTION: { charge_type: 'REDEMPTION', total_price_view: { code: 'Pts', amount: '950' } },
      PAYLATER: { charge_type: 'PAYLATER', total_price_view: eur(187.41), rates: [{ unit_amount_view: eur(62.47) }] },
    },
  });
  assert.equal(o.total, 167.34);
  assert.equal(o.perDay, 55.78);
  assert.equal(o.unlimitedKm, true);
  assert.equal(o.image, 'https://x/CDMR.320.high.png');
  assert.equal(enterpriseAngebot({ code: 'PDAR', status: 'SOLD_OUT', charges: {} }), null);
});
