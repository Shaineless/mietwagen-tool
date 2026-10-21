/**
 * Erntet alle deutschen Europcar-PKW-Stationen nach src/data/stations.europcar.txt.
 *
 *   node tools/ernte-europcar.mjs
 *
 * Europcar gibt keine Gesamtliste heraus; die Stationssuche kennt nur Orts-
 * namen, keine Postleitzahlen. Die Ortsnamen kommen deshalb aus Europcars
 * eigener Sitemap (sitemap-geopages.xml, 369 deutsche Ortsseiten), und jeder
 * wird einmal gesucht. Doppelte Treffer fallen ueber die Stationskennung weg.
 *
 * Das Bundesland ergibt sich aus der Koordinate und den Landesumrissen in
 * src/data/umriss-deutschland.txt, nicht aus der Postleitzahl: fuer die
 * gibt es hier kein Verzeichnis, fuer die Umrisse schon.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUCHE = 'https://api.aws.emobg.io/stationsearchapi/v1/stations/keywordSearch';

/* --- Landesumrisse und Punkt-in-Flaeche --------------------------------- */

const laender = [];
for (const z of readFileSync(join(wurzel, 'src/data/umriss-deutschland.txt'), 'utf8').split(/\r?\n/)) {
  const [art, id, rest] = z.trim().split('|');
  if (art !== 'L') continue;
  laender.push({ id, ringe: rest.split(';').map((r) => r.split(' ').map((p) => p.split(',').map(Number))) });
}
// Stadtstaaten zuerst: die vereinfachten Umrisse von Brandenburg und
// Niedersachsen haben kein Loch, sonst landete Berlin in Brandenburg.
const STADTSTAATEN = ['berlin', 'hamburg', 'bremen'];
laender.sort((a, b) => STADTSTAATEN.includes(b.id) - STADTSTAATEN.includes(a.id));

/** Strahlverfahren; ein Punkt liegt im Land, wenn er in ungerade vielen Ringen liegt. */
function imRing(lg, bg, ring) {
  let drin = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > bg !== yj > bg && lg < ((xj - xi) * (bg - yi)) / (yj - yi) + xi) drin = !drin;
  }
  return drin;
}

export function bundeslandVon(bg, lg) {
  for (const l of laender) if (l.ringe.filter((r) => imRing(lg, bg, r)).length % 2) return l.id;
  // Kuestenstationen und Grenzorte fallen bei vereinfachten Umrissen knapp
  // heraus. Dann gilt das Land mit dem naechsten Stuetzpunkt.
  let best = null;
  let abstand = Infinity;
  for (const l of laender) {
    for (const r of l.ringe) {
      for (const [x, y] of r) {
        const d = (x - lg) ** 2 + (y - bg) ** 2;
        if (d < abstand) { abstand = d; best = l.id; }
      }
    }
  }
  return abstand < 0.05 ? best : null;
}

/* --- Ernte -------------------------------------------------------------- */

async function orte() {
  const r = await fetch('https://www.europcar.de/de-de/sitemap-geopages.xml');
  if (!r.ok) throw new Error(`Sitemap: Antwort ${r.status}`);
  const xml = await r.text();
  const slugs = new Set();
  // Sechs Adressmuster, deutsch und englisch, Auto und Transporter. Nur eins
  // davon zu nehmen ergab 61 Orte statt rund 215.
  const muster = /places\/(?:autovermietung|transporter-mieten|car-rental|van-rental)-(?:deutschland|germany)\/([a-z0-9-]+)/g;
  for (const m of xml.matchAll(muster)) slugs.add(m[1]);
  // "baden-baden" bleibt, "frankfurt-am-main" wird "frankfurt am main".
  return [...slugs].map((s) => (s === 'baden-baden' ? s : s.replace(/-/g, ' ')));
}

async function suche(stichwort) {
  const p = new URLSearchParams({ view: 'FULL', limit: '100', brand: 'EUROPCAR', keyword: stichwort, locale: 'de_DE', vehicleType: 'CR' });
  const r = await fetch(`${SUCHE}?${p}`);
  return r.ok ? r.json() : [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const liste = await orte();
  console.log(`${liste.length} Orte aus der Sitemap`);
  const stationen = new Map();
  for (const [i, ort] of liste.entries()) {
    for (const s of await suche(ort)) {
      const a = s.contact?.address || {};
      if (a.countryCode !== 'DE' || stationen.has(s.id)) continue;
      // Nur PKW: reine Transporter- und Lkw-Stationen stehen sonst als
      // Zeilen ohne Preis in der Rangliste, wie damals die Sixt Truck Center.
      if (!(s.information?.rentedVehicleTypes || []).includes('CAR')) continue;
      if (s.config?.stationStatus && s.config.stationStatus !== 'A') continue;
      stationen.set(s.id, s);
    }
    if (i % 40 === 0) process.stdout.write(`  ${i}/${liste.length} · ${stationen.size} Stationen\n`);
    await new Promise((r) => setTimeout(r, 150));
  }

  const zeilen = [];
  let ohneLand = 0;
  for (const s of [...stationen.values()].sort((a, b) => a.information.name.localeCompare(b.information.name, 'de'))) {
    const { lat, lng } = s.geoPosition || {};
    const land = Number.isFinite(lat) ? bundeslandVon(lat, lng) : null;
    if (!land) ohneLand++;
    const art = s.information.type === 'AIRPORT' ? 'flughafen' : '';
    zeilen.push([s.id, s.contact.address.postCode || '', land || '', lat ?? '', lng ?? '', art, s.information.name].join('|'));
  }

  const kopf = [
    '# Europcar-PKW-Stationen in Deutschland.',
    '# Format: id|plz|bundesland|breite|laenge|art|name',
    `# Geerntet: ${new Date().toISOString().slice(0, 10)} mit tools/ernte-europcar.mjs`,
    '# Bundesland aus Koordinate und Landesumriss. Datei wird im Ganzen ersetzt.',
  ];
  writeFileSync(join(wurzel, 'src/data/stations.europcar.txt'), kopf.concat(zeilen).join('\n') + '\n');
  console.log(`${zeilen.length} Stationen geschrieben, ${ohneLand} ohne Bundesland`);
}
