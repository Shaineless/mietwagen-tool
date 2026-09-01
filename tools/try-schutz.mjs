/**
 * Handprobe fuer den Schutzpaket-Abruf.
 *   node tools/try-schutz.mjs [host] [acriss] [station]
 */

import { quoteSchutz } from './scrape/sixt-schutz.mjs';
import { closeBrowser } from './browser.mjs';

const [host = 'www.sixt.de', acriss = 'CDAR', stationCode = '110'] = process.argv.slice(2);

console.log(`${host} · ${acriss} · Station ${stationCode}`);
const r = await quoteSchutz({
  host,
  acriss,
  stationCode,
  pickupDate: '2026-12-01',
  returnDate: '2026-12-05',
  pickupTime: '10:00',
  returnTime: '10:00',
  currency: 'EUR',
});

console.log('ok:', r.ok, '| verfügbar:', r.verfuegbar, '| Fehler:', r.error || r.note || '—');
for (const p of r.pakete || []) {
  console.log(
    `  ${String(p.name).padEnd(24)} SB ${String(p.selbstbeteiligung ?? '—').padEnd(22)} ` +
      `${p.inklusive ? 'inklusive' : (p.proTag ?? '—') + ' ' + p.waehrung + '/Tag'}` +
      (p.statt ? `  statt ${p.statt}` : '') +
      (p.rabattProzent ? `  (−${p.rabattProzent}%)` : '')
  );
}

await closeBrowser();
