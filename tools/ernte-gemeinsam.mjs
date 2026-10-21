/**
 * Was alle Stationsernten brauchen: eine Liste deutscher Orte, nach denen
 * gesucht wird, die Zuordnung einer Koordinate zu einem Bundesland, und das
 * Schreiben der Ergebnisdatei.
 *
 * Keiner der Anbieter gibt eine Gesamtliste heraus; ihre Stationssuchen
 * kennen nur Ortsnamen. Die Ortsliste vereint deshalb zwei Quellen: Europcars
 * Sitemap (rund 215 Orte) und die Orte der deutschen Sixt-Stationen.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/* --- Ortsliste ---------------------------------------------------------- */

export async function orte() {
  const namen = new Set();

  const r = await fetch('https://www.europcar.de/de-de/sitemap-geopages.xml');
  if (r.ok) {
    // Sechs Adressmuster, deutsch und englisch, Auto und Transporter. Nur eins
    // davon zu nehmen ergab 61 Orte statt rund 215.
    const muster = /places\/(?:autovermietung|transporter-mieten|car-rental|van-rental)-(?:deutschland|germany)\/([a-z0-9-]+)/g;
    for (const m of (await r.text()).matchAll(muster)) {
      // "baden-baden" bleibt, "frankfurt-am-main" wird "frankfurt am main".
      namen.add(m[1] === 'baden-baden' ? m[1] : m[1].replace(/-/g, ' '));
    }
  }

  // Der Ort ist bei Sixt das erste Wort des Stationsnamens: "Köln Hbf",
  // "Bonn Bad Godesberg", "Frankfurt/Main Flughafen".
  for (const z of readFileSync(join(wurzel, 'src/data/stations.sixt.txt'), 'utf8').split(/\r?\n/)) {
    const [, land, , ...name] = z.split('|');
    if (land !== 'DE') continue;
    const ort = name.join('|').split(/[\s/(,]/)[0];
    if (ort.length > 2) namen.add(ort.toLowerCase());
  }
  return [...namen];
}

/* --- Ergebnis ----------------------------------------------------------- */

/**
 * @param {string} datei  z.B. 'stations.avis.txt'
 * @param {string} anbieter  fuer den Dateikopf
 * @param {{id,plz,lat,lng,flughafen,name}[]} stationen
 */
export function schreibeStationen(datei, anbieter, werkzeug, stationen) {
  const zeilen = [];
  let ohneLand = 0;
  for (const s of [...stationen].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
    const land = Number.isFinite(s.lat) ? bundeslandVon(s.lat, s.lng) : null;
    if (!land) ohneLand++;
    zeilen.push([s.id, s.plz || '', land || '', s.lat ?? '', s.lng ?? '', s.flughafen ? 'flughafen' : '', s.name].join('|'));
  }
  const kopf = [
    `# ${anbieter}-PKW-Stationen in Deutschland.`,
    '# Format: id|plz|bundesland|breite|laenge|art|name',
    `# Geerntet: ${new Date().toISOString().slice(0, 10)} mit tools/${werkzeug}`,
    '# Bundesland aus Koordinate und Landesumriss. Datei wird im Ganzen ersetzt.',
  ];
  writeFileSync(join(wurzel, 'src/data', datei), kopf.concat(zeilen).join('\n') + '\n');
  console.log(`${zeilen.length} Stationen nach src/data/${datei}, ${ohneLand} ohne Bundesland`);
}
