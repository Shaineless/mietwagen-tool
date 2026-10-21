/**
 * Holt alle deutschen Hertz-Stationen nach src/data/stations.hertz.txt.
 *
 *   node tools/ernte-hertz.mjs
 *
 * Anders als bei Europcar und Avis gibt es hier eine Gesamtliste: dieselbe
 * Schnittstelle, die hertz.de fuer "alle Stationen eines Landes" benutzt,
 * liefert in einer einzigen Anfrage alle rund 320 Stationen samt Koordinate.
 * Die Kennung ist der erweiterte OAG-Code (CGNT50, STRE03), mit dem auch die
 * Buchung arbeitet.
 */

import { schreibeStationen } from './ernte-gemeinsam.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const r = await fetch('https://api.hertz.com/rest/location/country/DE?dialect=deDE', {
  headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.hertz.de', Referer: 'https://www.hertz.de/' },
});
if (!r.ok) throw new Error(`Hertz-Stationsliste: Antwort ${r.status}`);
const liste = (await r.json()).data?.model || [];

const stationen = liste
  // Nur buchbare PKW-Stationen; die Lkw-Standorte vermieten keine Personenwagen.
  .filter((s) => s.bookable && !s.heavy_trucks && s.extendedOAGCode && s.countryCode === 'DE')
  .map((s) => ({
    id: s.extendedOAGCode.trim(),
    plz: (s.zip || '').trim(),
    lat: s.latitude,
    lng: s.longitude,
    flughafen: s.major_airport === 'Y' || /flughafen|airport/i.test(s.locationName),
    name: s.locationName.trim(),
  }));

schreibeStationen('stations.hertz.txt', 'Hertz', 'ernte-hertz.mjs', stationen);
