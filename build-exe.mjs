/**
 * Baut aus dem Quellbaum eine einzelne Windows-EXE.
 *
 *   node build-exe.mjs
 *   node build-exe.mjs Tracker-Premium.exe
 *
 * Vier Schritte: Oberfläche bauen, den Dienst mitsamt Playwright in eine
 * einzige CommonJS-Datei bündeln, daraus einen SEA-Vorrat erzeugen und diesen
 * in eine Kopie von node.exe einspritzen.
 *
 * Was dabei NICHT mitkommt: ein Browser. Der Preisabruf benutzt weiterhin das
 * Chrome oder Edge, das ohnehin auf dem Rechner ist, ein mitgeliefertes
 * Chromium wäre nicht nur 150 MB grösser, es würde von Sixt auch abgewiesen.
 * Genau darum geht der Abruf über den installierten Browser.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const bau = join(root, 'build');
const dateiname = process.argv[2] || 'Tracker.exe';
if (!/^[a-z0-9_-]+\.exe$/i.test(dateiname)) throw new Error('Bitte einen EXE-Dateinamen ohne Pfad angeben.');
const ziel = join(root, 'dist', dateiname);

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB';

function lauf(datei, args, was) {
  process.stdout.write(`  ${was} … `);
  try {
    execFileSync(datei, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('ok');
  } catch (e) {
    console.log('FEHLER\n');
    console.error(String(e.stderr || e.stdout || e.message));
    process.exit(1);
  }
}

console.log('\nMietwagen-Preistool. EXE bauen\n');

if (process.platform !== 'win32') {
  console.log('Hinweis: gebaut wird für die Plattform, auf der dieses Skript läuft.\n');
}

// Der Bauordner wird nicht geleert, sondern ueberschrieben: liegt dort noch
// eine Datei, die ein anderer Prozess offen haelt, scheiterte der ganze Build
// am Aufraeumen, an einer Datei, die er gar nicht braucht.
mkdirSync(bau, { recursive: true });
mkdirSync(join(root, 'dist'), { recursive: true });

/* --------------------------------------------------- 1. Oberfläche */

lauf(process.execPath, [join(root, 'build.mjs')], 'Oberfläche bauen');

/* --------------------------------------------------- 2. Dienst bündeln */

// Playwright zieht den BiDi-Treiber herein, den wir nie benutzen: der Abruf
// läuft über CDP. Ein leeres Modul an seiner Stelle spart den Ballast und den
// Auflösungsfehler beim Bündeln.
const leer = join(bau, 'leer.cjs');
writeFileSync(leer, '// Platzhalter für ungenutzte Playwright-Treiber.\nmodule.exports = {};\n');

// In einer gepackten EXE löst `require()` ausschliesslich eingebaute Module
// auf. Dateipfade kann es nicht. Playwright liest damit zur Laufzeit seine
// eigene package.json ein, nur um an die Versionsnummer zu kommen. Der
// Vorspann beantwortet genau diese Frage selbst und lässt alles andere
// durch; taucht später ein anderer Dateipfad auf, sagt die Meldung, welcher.
const pwCore = join(root, 'node_modules', 'playwright-core');
const pwVersion = JSON.parse(readFileSync(join(pwCore, 'package.json'), 'utf8')).version;

// Die JSON-Dateien, nach denen Playwright zur Laufzeit greift, kommen als
// fertige Werte mit, nachgeschlagen über den Dateinamen.
const mitgeliefert = {
  'package.json': { name: 'playwright-core', version: pwVersion },
  'browsers.json': JSON.parse(readFileSync(join(pwCore, 'browsers.json'), 'utf8')),
};

const vorspann = `
if (typeof require === 'function') {
  const eingebaut = require;
  const dabei = ${JSON.stringify(mitgeliefert)};
  require = function (id) {
    if (typeof id === 'string' && /[\\\\/]/.test(id) && !id.startsWith('node:')) {
      const name = String(id).replace(/\\\\/g, '/').split('/').pop();
      if (name in dabei) return dabei[name];
      throw new Error('In der EXE nicht ladbar: ' + id + ', build-exe.mjs anpassen.');
    }
    return eingebaut(id);
  };
}
`.trim();

const esbuild = join(
  root,
  'node_modules',
  process.platform === 'win32' ? '@esbuild/win32-x64' : '@esbuild/linux-x64',
  process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
);
const bundle = join(bau, 'preistool.cjs');

lauf(
  esbuild,
  [
    join(root, 'tools', 'serve.mjs'),
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=cjs',
    '--log-level=error',
    `--banner:js=${vorspann}`,
    `--alias:chromium-bidi/lib/cjs/bidiMapper/BidiMapper=${leer}`,
    `--alias:chromium-bidi/lib/cjs/cdp/CdpConnection=${leer}`,
    `--outfile=${bundle}`,
  ],
  'Dienst bündeln'
);
console.log(`     ${mb(bundle)} JavaScript`);

/* --------------------------------------------------- 3. SEA-Vorrat */

// Die Oberfläche wird als Vorrat eingebettet; der Dienst liest sie über
// tools/pfade.mjs unter genau diesem Namen wieder heraus.
const konfig = join(bau, 'sea-config.json');
writeFileSync(
  konfig,
  JSON.stringify(
    {
      main: bundle,
      output: join(bau, 'preistool.blob'),
      disableExperimentalSEAWarning: true,
      assets: {
        'dist/mietwagen-preistool.html': join(root, 'dist', 'mietwagen-preistool.html'),
      },
    },
    null,
    2
  )
);

lauf(process.execPath, ['--experimental-sea-config', konfig], 'Vorrat erzeugen');

/* --------------------------------------------------- 4. Einspritzen */

copyFileSync(process.execPath, ziel);

lauf(
  process.execPath,
  [
    join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    ziel,
    'NODE_SEA_BLOB',
    join(bau, 'preistool.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  'in die EXE einspritzen'
);

/* --------------------------------------------------- 5. Ohne Konsole */

/**
 * Aus dem Konsolenprogramm ein Fensterprogramm machen.
 *
 * node.exe ist als Konsolenprogramm gebaut: beim Doppelklick geht immer eine
 * schwarze Konsole auf. Welche Art Programm es ist, steht als eine einzige
 * Zahl im PE-Kopf, 3 heisst Konsole, 2 heisst Fenster. Das Feld sitzt
 * 68 Bytes hinter dem Anfang des Optional Headers, und der beginnt hinter der
 * PE-Signatur (4 Bytes) und dem COFF-Kopf (20 Bytes). Der Offset dorthin
 * steht bei 0x3C.
 *
 * Ohne Konsole gibt es kein stdout mehr, das jemand liest, deshalb schreibt
 * das Programm sein Protokoll in eine Datei und zeigt Startfehler als Fenster
 * (tools/meldung.mjs).
 */
function machZuFensterprogramm(datei) {
  const bytes = readFileSync(datei);

  if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Keine PE-Datei (MZ fehlt).');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) throw new Error('PE-Signatur nicht gefunden.');

  const subsystem = peOffset + 4 + 20 + 68;
  const vorher = bytes.readUInt16LE(subsystem);
  if (vorher === 2) return 'war schon ein Fensterprogramm';
  if (vorher !== 3) throw new Error(`Unerwartetes Subsystem ${vorher}, erwartet 3 (Konsole).`);

  bytes.writeUInt16LE(2, subsystem);
  writeFileSync(datei, bytes);
  return 'Konsole → Fenster';
}

if (process.platform === 'win32') {
  process.stdout.write('  Konsolenfenster abschalten … ');
  try {
    console.log(machZuFensterprogramm(ziel));
  } catch (e) {
    console.log('FEHLER\n');
    console.error('  ' + e.message);
    console.error('  Die EXE läuft, öffnet beim Start aber ein Konsolenfenster.');
  }
}

console.log(`\nFertig: dist/${dateiname} (${mb(ziel)})`);
console.log('Doppelklick öffnet ein eigenes Programmfenster, ohne Konsole.');
console.log('Chrome oder Edge muss installiert sein, sonst bleibt der Link-Modus.\n');
