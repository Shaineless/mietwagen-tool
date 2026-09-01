/**
 * Baut aus den Quellen unter src/ eine einzige, in sich geschlossene HTML-Datei.
 *
 * Warum ein Build? Der Quellcode soll in Module aufgeteilt bleiben (lesbar,
 * erweiterbar), das Ergebnis aber per Doppelklick aus dem Dateisystem laufen —
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
      console.warn(`  ! ${file}:${i + 1} doppelte ID ${id} — übersprungen`);
      return;
    }
    seen.add(id);

    out.push({
      // `code` ist der anbietereigene Stationsschlüssel — bei Sixt eine Zahl
      // (der uci-Parameter), bei anderen Anbietern oft ein Buchstabencode.
      code: id.trim(),
      country: (country || '').trim(),
      iata: (iata || '').trim(),
      name,
      provider: providerId,
    });
  });

  return out;
}

console.log('Stationen einlesen …');
const stations = parseStations(src('data/stations.sixt.txt'), 'sixt');
console.log(`  ${stations.length} Sixt-Stationen`);

const stationsModule =
  '// Automatisch erzeugt von build.mjs aus src/data/*.txt — nicht direkt bearbeiten.\n' +
  'export const STATIONS = ' +
  JSON.stringify(stations) +
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
// derzeit nicht gebraucht — vorerst nur Sixt.
const MODULES = ['providers.js', 'offer-classes.js', 'hintergrund.js', 'app.js'];

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
const GENERATED = '// Erzeugt von build.mjs aus src/offer-parse.js — nicht direkt bearbeiten.\n\n';

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

const html = readFileSync(src('index.html'), 'utf8')
  .replace('/*STYLES*/', () => readFileSync(src('styles.css'), 'utf8'))
  .replace('/*SCRIPT*/', () => bundle);

mkdirSync(join(root, 'dist'), { recursive: true });
const outFile = join(root, 'dist', 'mietwagen-preistool.html');
writeFileSync(outFile, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`\nFertig: dist/mietwagen-preistool.html (${kb} kB)`);
console.log('Einfach im Browser öffnen — kein Server nötig.');
