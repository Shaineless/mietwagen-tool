/**
 * Erntet alle deutschen Europcar-PKW-Stationen nach src/data/stations.europcar.txt.
 *
 *   node tools/ernte-europcar.mjs
 *
 * Jeder Ort aus der gemeinsamen Ortsliste wird einmal gesucht; doppelte
 * Treffer fallen ueber die Stationskennung weg. Siehe ernte-gemeinsam.mjs.
 */

import { orte, schreibeStationen } from './ernte-gemeinsam.mjs';

const SUCHE = 'https://api.aws.emobg.io/stationsearchapi/v1/stations/keywordSearch';

async function suche(stichwort) {
  const p = new URLSearchParams({ view: 'FULL', limit: '100', brand: 'EUROPCAR', keyword: stichwort, locale: 'de_DE', vehicleType: 'CR' });
  const r = await fetch(`${SUCHE}?${p}`);
  return r.ok ? r.json() : [];
}

const liste = await orte();
console.log(`${liste.length} Orte`);
const stationen = new Map();
for (const [i, ort] of liste.entries()) {
  for (const s of await suche(ort)) {
    const a = s.contact?.address || {};
    if (a.countryCode !== 'DE' || stationen.has(s.id)) continue;
    // Nur PKW: reine Transporter- und Lkw-Stationen stehen sonst als
    // Zeilen ohne Preis in der Rangliste, wie damals die Sixt Truck Center.
    if (!(s.information?.rentedVehicleTypes || []).includes('CAR')) continue;
    if (s.config?.stationStatus && s.config.stationStatus !== 'A') continue;
    stationen.set(s.id, {
      id: s.id,
      plz: a.postCode,
      lat: s.geoPosition?.lat,
      lng: s.geoPosition?.lng,
      flughafen: s.information.type === 'AIRPORT',
      name: s.information.name,
    });
  }
  if (i % 50 === 0) console.log(`  ${i}/${liste.length} · ${stationen.size} Stationen`);
  await new Promise((r) => setTimeout(r, 150));
}
schreibeStationen('stations.europcar.txt', 'Europcar', 'ernte-europcar.mjs', stationen.values());
