/**
 * Prüft Länderseiten, die noch nicht im Register stehen.
 *
 *   node tools/try-laender.mjs [host …]
 *
 * Ohne Argumente werden die Kandidaten geprüft, die eine Domainabfrage als
 * "existiert und wird von Sixt ausgeliefert" gemeldet hat. Ein 403 aus Node
 * heisst nur, dass Cloudflare Node abweist — ob dort wirklich eine buchbare
 * Länderseite läuft, die unsere Suchparameter versteht, sagt erst ein echter
 * Abruf. Genau den macht dieses Skript.
 *
 * Nacheinander, mit Abstand: es geht um eine Handvoll Erkundungsabrufe, nicht
 * um Durchsatz.
 */

import { quoteSixt } from './scrape/sixt.mjs';
import { closeBrowser } from './browser.mjs';

const KANDIDATEN = [
  'www.sixt.ro',
  'www.sixt.si',
  'www.sixt.rs',
  'www.sixt.ee',
  'www.sixt.lv',
  'www.sixt.lt',
  'www.sixt.is',
  'www.sixt.ma',
  'www.sixt.ae',
  'www.sixt.ca',
  'www.sixt.com.au',
  'www.sixt.com.br',
  'www.sixt.jp',
  'ua.sixt.ua',
];

const hosts = process.argv.slice(2).length ? process.argv.slice(2) : KANDIDATEN;

const ab = new Date();
ab.setDate(ab.getDate() + 30);
const bis = new Date(ab);
bis.setDate(bis.getDate() + 4);
const iso = (d) => d.toISOString().slice(0, 10);

console.log(`Prüfe ${hosts.length} Länderseiten mit Station 110 (Frankfurt Flughafen)\n`);

for (const host of hosts) {
  process.stdout.write(host.padEnd(18));
  try {
    const r = await quoteSixt({
      host,
      stationCode: '110',
      pickupDate: iso(ab),
      returnDate: iso(bis),
      pickupTime: '10:00',
      returnTime: '10:00',
    });
    if (r.error) {
      console.log(`✕ ${r.error}`);
    } else if (!r.offers?.length) {
      console.log('~ Seite lief, aber keine Angebote');
    } else {
      const werte = r.offers.map((o) => o.total).filter((x) => x != null);
      console.log(
        `✓ ${String(r.offers.length).padStart(2)} Angebote · ab ` +
          `${Math.min(...werte).toFixed(2)} ${r.offers[0].currency || '?'}` +
          (r.warnung ? `  ! ${r.warnung}` : '')
      );
    }
  } catch (e) {
    console.log(`✕ ${String(e.message).slice(0, 90)}`);
  }
  // Zwischen den Erkundungen kurz Luft lassen.
  await new Promise((r) => setTimeout(r, 2000));
}

await closeBrowser();
