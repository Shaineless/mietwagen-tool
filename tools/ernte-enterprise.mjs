/**
 * Erntet alle deutschen Enterprise-Stationen nach src/data/stations.enterprise.txt.
 *
 *   node tools/ernte-enterprise.mjs
 *
 * Die Textsuche von enterprise.de findet nur Flughaefen und Bahnhoefe nach
 * Namen, die Stadtfilialen nicht (29 Treffer fuer ganz Deutschland). Die
 * Suchmaske benutzt fuer Staedte eine Umkreissuche, und die wird hier ueber
 * ein Raster aus Punkten ueber ganz Deutschland gestellt, 50 km Umkreis,
 * Punkte so dicht, dass sich die Kreise ueberlappen. Doppelte fallen ueber
 * die Kennung weg.
 *
 * Enterprise fuehrt drei Marken ueber dieselbe Suche: Enterprise, National
 * und Alamo. Hier zaehlt nur Enterprise, die anderen haben eigene Seiten.
 */

import { schreibeStationen } from './ernte-gemeinsam.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function umkreis(lat, lng) {
  const u = 'https://prd.location.enterprise.com/enterprise-sls/search/location/enterprise/web/spatial' +
    `?latitude=${lat}&longitude=${lng}&radius=50&countryCode=DE&brand=ENTERPRISE&dto=true&cor=DE&locale=de_DE`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.enterprise.de', Referer: 'https://www.enterprise.de/' } });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return j?.result || [];
}

// Deutschland: Breite 47,3-55,1, Laenge 5,9-15,0. Schritt 0,45 Grad Breite
// (50 km) und 0,7 Grad Laenge (rund 48 km bei 51 Grad Nord).
const stationen = new Map();
let anfragen = 0;
let maxTreffer = 0;
for (let lat = 47.3; lat <= 55.2; lat += 0.45) {
  for (let lng = 5.9; lng <= 15.1; lng += 0.7) {
    const liste = await umkreis(lat.toFixed(2), lng.toFixed(2));
    anfragen++;
    maxTreffer = Math.max(maxTreffer, liste.length);
    for (const s of liste) {
      const a = s.address || {};
      if (a.country_code !== 'DE' || !s.id || stationen.has(s.id) || s.brand !== 'ENTERPRISE') continue;
      stationen.set(s.id, {
        id: s.id,
        plz: a.postal,
        lat: s.gps?.latitude,
        lng: s.gps?.longitude,
        flughafen: s.location_type === 'AIRPORT',
        name: s.name,
      });
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`  Breite ${lat.toFixed(2)} · ${anfragen} Anfragen · ${stationen.size} Stationen`);
}
// Liefert ein Kreis genau die Obergrenze, fehlt dort etwas; dann Raster enger.
console.log(`Meiste Treffer in einem Kreis: ${maxTreffer}`);
schreibeStationen('stations.enterprise.txt', 'Enterprise', 'ernte-enterprise.mjs', stationen.values());
