/**
 * Handprobe fuer den Preisabruf.
 *
 *   node tools/try-quote.mjs [host] [stationCode] [pickupDate] [returnDate]
 *   node tools/try-quote.mjs www.sixt.es 110 2026-12-01 2026-12-05
 */

import { quoteSixt } from './scrape/sixt.mjs';
import { closeBrowser } from './browser.mjs';

const [host = 'www.sixt.de', stationCode = '110', pickupDate = '2026-12-01', returnDate = '2026-12-05'] =
  process.argv.slice(2);

console.log(`Abruf: ${host} · Station ${stationCode} · ${pickupDate} → ${returnDate}`);

const t = Date.now();
const res = await quoteSixt({
  host,
  stationCode,
  pickupDate,
  returnDate,
  pickupTime: '10:00',
  returnTime: '10:00',
  currency: 'EUR',
});

console.log(`\nDauer: ${((Date.now() - t) / 1000).toFixed(1)}s`);
console.log('ok:', res.ok, '| Station:', res.station, '| Angebote:', res.offers?.length ?? 0);
if (res.error || res.note) console.log('Hinweis:', res.error || res.note);

for (const o of (res.offers || []).slice(0, 8)) {
  const day = o.perDay != null ? `${o.perDay.toFixed(2)} ${o.currency}/Tag` : '—';
  const tot = o.total != null ? `${o.total.toFixed(2)} ${o.currency} gesamt` : '—';
  console.log(`  ${o.model.padEnd(24)} ${o.category.padEnd(34)} ${day.padStart(18)}  ${tot}`);
}

await closeBrowser();
