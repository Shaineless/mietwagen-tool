/**
 * Erntet alle deutschen Avis-Stationen nach src/data/stations.avis.txt.
 *
 *   node tools/ernte-avis.mjs
 *
 * Avis' Stationssuche (JsonProviderServlet, dieselbe, die das Suchfeld auf
 * avis.de benutzt) antwortet auch ohne Browser. Gesucht wird jeder Ort der
 * gemeinsamen Ortsliste; siehe ernte-gemeinsam.mjs.
 *
 * Reine Budget-Stationen fallen weg: Budget gehoert zu Avis, hat aber eigene
 * Preise und eine eigene Seite.
 */

import { orte, schreibeStationen } from './ernte-gemeinsam.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function suche(stichwort) {
  const p = new URLSearchParams({
    keyword: stichwort, requestType: 'keyword', pickUpLocation: '', isPickUpSearch: 'true',
    isproxy: 'false', partnerBrand: 'other', vehicleCategory: 'default',
  });
  const r = await fetch(`https://secure.avis.de/JsonProviderServlet/de_DE?${p}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return (j?.results || []).flatMap((x) => x.data || []);
}

const liste = await orte();
console.log(`${liste.length} Orte`);
const stationen = new Map();
for (const [i, ort] of liste.entries()) {
  for (const s of await suche(ort)) {
    const a = s.Address || {};
    if (a.countryCode !== 'DE' || !s.StationCode || stationen.has(s.StationCode)) continue;
    if (s.LocationBrand === 'Budget' || s.ShowInPickUp === false) continue;
    stationen.set(s.StationCode, {
      id: s.StationCode,
      plz: a.PostCode,
      lat: s.GeoData?.Latitude,
      lng: s.GeoData?.Longitude,
      flughafen: s.StationType === 'airport',
      // "Flughafen Köln/Bonn - Deutschland": das Land steht ohnehin fest.
      name: (s.StationName || a.locName || s.StationCode).replace(/\s*-\s*Deutschland$/, ''),
    });
  }
  if (i % 50 === 0) console.log(`  ${i}/${liste.length} · ${stationen.size} Stationen`);
  // Langsam. Mit 250 ms Abstand (317 Anfragen in gut einer Minute) sperrte
  // Avis' CloudFront danach die IP auch fuer die normale Suche, 21.10.2026.
  await new Promise((r) => setTimeout(r, 3000));
}
schreibeStationen('stations.avis.txt', 'Avis', 'ernte-avis.mjs', stationen.values());
