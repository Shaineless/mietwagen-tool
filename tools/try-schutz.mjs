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
console.log('Miete ohne Schutz:', r.mieteOhneSchutz);
console.log(
  '\n' +
    'Paket'.padEnd(24) +
    'angezeigt/Tag'.padStart(14) +
    'Gesamt'.padStart(12) +
    'Aufschlag'.padStart(11) +
    'daraus /Tag'.padStart(13)
);
for (const p of r.pakete || []) {
  const proTagEcht =
    p.aufschlag != null && r.tage ? (p.aufschlag / r.tage).toFixed(2) : '—';
  console.log(
    String(p.name).padEnd(24) +
      String(p.inklusive ? 'inklusive' : (p.proTag ?? '—')).padStart(14) +
      String(p.gesamt ?? '—').padStart(12) +
      String(p.aufschlag ?? '—').padStart(11) +
      String(p.aufschlag != null ? (p.aufschlag / 4).toFixed(2) : '—').padStart(13)
  );
}

await closeBrowser();
