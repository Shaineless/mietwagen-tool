/**
 * Baut aus den Quellen unter src/ eine einzige, in sich geschlossene HTML-Datei.
 *
 * Warum ein Build? Der Quellcode soll in Module aufgeteilt bleiben (lesbar,
 * erweiterbar), das Ergebnis aber per Doppelklick aus dem Dateisystem laufen,
 * genau wie beim Original-Tool. ES-Module funktionieren unter file:// nicht,
 * deshalb werden sie hier zu einem klassischen Script zusammengefasst.
 *
 *   node build.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = (f) => join(root, 'src', f);

/* ------------------------------------------------ Stationen: txt -> js */

/**
 * Flughafen oder nicht?
 *
 * Entscheidet ueber die Form der Stationsadresse: Flughafenstationen tragen
 * bei Sixt das Kuerzel `ap`, alle uebrigen `dt`. Das IATA-Feld taugt dafuer
 * nicht, nur 43 der 2250 Stationen haben eines, waehrend ueber 700 dem Namen
 * nach Flughaefen sind. Also entscheidet der Name.
 *
 * Die Namen stammen von sixt.de und sind deshalb deutsch; die uebrigen
 * Schreibweisen stehen mit drin, falls die Liste einmal aus einer anderen
 * Laenderseite nachgezogen wird.
 */
const FLUGHAFEN_RE =
  /(flughafen|airport|a[eé]roport|aeropuerto|aeroporto|luchthaven|lufthavn|lentoasema|havaliman|repülőtér|letiště|lotnisko)/i;


function parseStations(file, providerId) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  const seen = new Set();

  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;

    const [id, country, iata, ...rest] = s.split('|');
    const name = rest.join('|').trim();

    if (!id || !name) {
      console.warn(`  ! ${file}:${i + 1} übersprungen (unvollständig): ${s}`);
      return;
    }
    if (seen.has(id)) {
      console.warn(`  ! ${file}:${i + 1} doppelte ID ${id}, übersprungen`);
      return;
    }
    seen.add(id);

    out.push({
      // `code` ist der anbietereigene Stationsschlüssel, bei Sixt eine Zahl
      // (der uci-Parameter), bei anderen Anbietern oft ein Buchstabencode.
      code: id.trim(),
      country: (country || '').trim(),
      iata: (iata || '').trim(),
      name,
      provider: providerId,
      // Nur bei Flughafenstationen gesetzt, spart in der erzeugten Datei
      // 1500 Mal `false`.
      ...(FLUGHAFEN_RE.test(name) ? { flughafen: true } : {}),

    });
  });

  return out;
}

/**
 * Ort je Station: Postleitzahl, Bundesland, Koordinate.
 *
 * Bewusst eine zweite Datei statt neuer Spalten in stations.sixt.txt. Die
 * Stationsliste ist gewachsen und wird von Hand ergaenzt; sie soll schmal
 * bleiben. Die Ortsdaten stammen dagegen aus einem Erntelauf und werden im
 * Ganzen ersetzt, wenn er wieder laeuft.
 *
 * Fehlt die Datei, entfaellt nur die Bundeslandsuche. Alles andere laeuft.
 */
function parseOrte(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.warn('  ! keine Ortsdaten gefunden, die Bundeslandsuche bleibt leer');
    return new Map();
  }
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const [id, plz, land, lat, lon, art] = s.split('|');
    if (!id || !land) continue;
    out.set(id.trim(), {
      plz: plz.trim(),
      land: land.trim(),
      lat: Number(lat),
      lon: Number(lon),
      lkw: (art || '').trim() === 'lkw',
    });
  }
  return out;
}

console.log('Stationen einlesen …');
const stations = parseStations(src('data/stations.sixt.txt'), 'sixt');
const orte = parseOrte(src('data/stationen-ort.txt'));

let mitOrt = 0;
for (const s of stations) {
  const o = orte.get(s.code);
  if (!o) continue;
  mitOrt++;
  // Kurze Schluessel, die Datei traegt sie 342 Mal: land, plz, Breite, Laenge.
  s.bl = o.land;
  s.plz = o.plz;
  s.bg = o.lat;
  s.lg = o.lon;
  // Nutzfahrzeugstation? Das steht in der Ortsdatei, geerntet aus dem Titel
  // der Sixt-Stationsseite. Am NAMEN erkannt ging es schief: "Bremen
  // Habenhausen" traegt kein "Truck" im Namen, ist aber eines, und stand
  // deshalb als Zeile ohne Preis in der Rangliste.
  if (o.lkw) s.lkw = true;
}

/**
 * Weitere Anbieter: je eine Datei mit allem, weil sie ganz aus einem
 * Erntelauf stammt (tools/ernte-*.mjs) und nie von Hand ergaenzt wird.
 */
function parseAnbieter(file, provider) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.warn(`  ! keine Stationen für ${provider} gefunden, der Anbieter bleibt aus`);
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const [id, plz, land, lat, lon, art, ...name] = s.split('|');
    out.push({
      code: id, country: 'DE', iata: '', name: name.join('|'), provider,
      ...(art === 'flughafen' ? { flughafen: true } : {}),
      bl: land, plz, bg: Number(lat), lg: Number(lon),
    });
  }
  return out;
}
const europcarStationen = parseAnbieter(src('data/stations.europcar.txt'), 'europcar');
const avisStationen = parseAnbieter(src('data/stations.avis.txt'), 'avis');
const hertzStationen = parseAnbieter(src('data/stations.hertz.txt'), 'hertz');
const enterpriseStationen = parseAnbieter(src('data/stations.enterprise.txt'), 'enterprise');
console.log(`  ${europcarStationen.length} Europcar-, ${avisStationen.length} Avis-, ${hertzStationen.length} Hertz- und ${enterpriseStationen.length} Enterprise-Stationen in Deutschland`);

const flughaefen = stations.filter((s) => s.flughafen).length;
console.log(
  `  ${stations.length} Sixt-Stationen (${flughaefen} Flughafen, ${stations.length - flughaefen} übrige)`
);
const laender = new Set(stations.filter((s) => s.bl).map((s) => s.bl));
const lkw = stations.filter((s) => s.lkw && s.bl).length;
console.log(`  ${mitOrt} davon mit Ort und Bundesland (${laender.size} Bundesländer)`);
console.log(`  ${lkw} deutsche Nutzfahrzeugstationen, nicht in der PKW-Suche`);

/* --------------------------------------------- Umrisse: txt -> Punktlisten */

/**
 * Bundeslandgrenzen und Städte für die Karte.
 *
 * Wird die Datei nicht gefunden, zeichnet die Karte nur die Stationen. Das
 * ist haesslicher, aber es laeuft; ein fehlender Umriss soll das Programm
 * nicht anhalten.
 */
function parseUmriss(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.warn('  ! keine Umrissdaten gefunden, die Karte zeigt nur Punkte');
    return { laender: [], staedte: [] };
  }
  const raus = { laender: [], staedte: [] };
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const [art, name, rest] = s.split('|');
    if (art === 'L') {
      raus.laender.push({
        id: name,
        // Ein Ring ist eine flache Zahlenfolge: laenge, breite, laenge, ...
        // Flach statt Paare, das spart in der erzeugten Datei ein Drittel.
        r: rest.split(';').map((ring) => ring.split(' ').flatMap((p) => p.split(',').map(Number))),
      });
    } else if (art === 'S') {
      const [bg, lg] = rest.split(',').map(Number);
      raus.staedte.push({ n: name, bg, lg });
    }
  }
  return raus;
}

const umriss = parseUmriss(src('data/umriss-deutschland.txt'));
const stuetzpunkte = umriss.laender.reduce((n, l) => n + l.r.reduce((m, r) => m + r.length / 2, 0), 0);
console.log(
  `  Karte: ${umriss.laender.length} Umrisse mit ${stuetzpunkte} Stützpunkten, ${umriss.staedte.length} Städte`
);

const stationsModule =
  '// Automatisch erzeugt von build.mjs aus src/data/*.txt, nicht direkt bearbeiten.\n' +
  'export const STATIONS = ' +
  JSON.stringify(stations.concat(europcarStationen, avisStationen, hertzStationen, enterpriseStationen)) +
  ';\n' +
  'export const UMRISS = ' +
  JSON.stringify(umriss) +
  ';\n';

writeFileSync(src('stations.js'), stationsModule);

/* ------------------------------------------------ Module zusammenfassen */

/**
 * Entfernt import-Zeilen und macht aus `export const X` ein `const X`.
 * Ausreichend, weil wir den Quellcode selbst kontrollieren und bewusst
 * auf zyklische oder umbenennende Importe verzichten.
 */
function flatten(code) {
  const flach = code
    .replace(/^\s*import[^;]+;\s*$/gm, '')
    // Sammel-Export am Dateiende: im Bundle ueberfluessig, im klassischen
    // Script ein Syntaxfehler. Kostet eine Zeile hier, spart die Suche danach.
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^export\s+(const|function|class|let)\b/gm, '$1')
    .trim();

  const rest = flach.match(/^\s*export\b.*$/m);
  if (rest) throw new Error(`build.mjs kann diese export-Zeile nicht auflösen: ${rest[0].trim()}`);
  return flach;
}

// Reihenfolge = Abhängigkeitsreihenfolge: app.js benutzt alles Vorherige.
// places.js liegt fuer den spaeteren Anbietervergleich bereit, wird aber
// derzeit nicht gebraucht, vorerst nur Sixt.
const MODULES = ['providers.js', 'offer-classes.js', 'xlsx.js', 'app.js'];

const bundle = [
  '(() => {',
  '"use strict";',
  flatten(stationsModule),
  ...MODULES.map((m) => flatten(readFileSync(src(m), 'utf8'))),
  '})();',
].join('\n\n');

/* ------------------------------------------------ In HTML einsetzen */

/* --------------------------------- Parser an seine zwei Einsatzorte kopieren */

// Die Kachel-Auswertung existiert genau einmal (src/offer-parse.js) und wird
// von hier aus verteilt. Sonst laufen Erweiterung und Worker auseinander,
// ohne dass es jemand merkt.
const parser = readFileSync(src('offer-parse.js'), 'utf8');
const GENERATED = '// Erzeugt von build.mjs aus src/offer-parse.js, nicht direkt bearbeiten.\n\n';

writeFileSync(
  join(root, 'extension', 'content.js'),
  GENERATED + parser + '\n\n' + readFileSync(join(root, 'extension', 'content.src.js'), 'utf8')
);

mkdirSync(join(root, 'tools', 'scrape'), { recursive: true });
writeFileSync(
  join(root, 'tools', 'scrape', 'offer-parse.mjs'),
  GENERATED + parser + '\n\nexport { mwtParseTile, mwtParseAmount };\n'
);

console.log('  Parser verteilt: extension/content.js, tools/scrape/offer-parse.mjs');

/* --------------------------------- In HTML einsetzen */

/* --------------------------------- Logo und Fahrzeugmotiv einbetten */

// Beides wandert als data:-Adresse in die HTML-Datei. Der Sinn des Werkzeugs
// ist eine einzige Datei, die auch per Doppelklick aus dem Dateisystem laeuft;
// eine Datei, die nebenan liegende Bilder nachlaedt, waere keine.
function alsDatenAdresse(datei, typ) {
  const roh = readFileSync(join(root, 'src', 'bilder', datei));
  return `data:${typ};base64,${roh.toString('base64')}`;
}

const logo = alsDatenAdresse('tracker-logo.png', 'image/png');
const heroCar = alsDatenAdresse('premium-car.png', 'image/png');
console.log(
  `  Logo ${(logo.length / 1024).toFixed(0)} kB, Fahrzeugmotiv ${(heroCar.length / 1024).toFixed(0)} kB eingebettet`
);

const html = readFileSync(src('index.html'), 'utf8')
  .replace('/*STYLES*/', () => readFileSync(src('styles.css'), 'utf8'))
  .replaceAll('/*LOGO*/', () => logo)
  .replace('/*HERO_CAR*/', () => heroCar)
  .replace('/*SCRIPT*/', () => bundle);

mkdirSync(join(root, 'dist'), { recursive: true });
const outFile = join(root, 'dist', 'mietwagen-preistool.html');
writeFileSync(outFile, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`\nFertig: dist/mietwagen-preistool.html (${kb} kB)`);
console.log('Einfach im Browser öffnen, kein Server nötig.');
