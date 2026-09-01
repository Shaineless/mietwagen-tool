/**
 * Lokaler Dienst: liefert die Oberflaeche aus und nimmt die von der
 * Erweiterung gelesenen Preise entgegen.
 *
 *   node tools/serve.mjs [port]
 *
 * Ohne diesen Dienst funktioniert das Tool weiterhin — dann eben als reiner
 * Link-Generator. Die Oberflaeche prueft beim Start, ob der Dienst da ist.
 *
 * Bindet absichtlich nur an 127.0.0.1: die gesammelten Daten sollen den
 * Rechner nicht verlassen.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 4173;

/**
 * Einmal-Token fuer den Stationsimport.
 *
 * Der Dienst nimmt Stationslisten entgegen, damit ein Crawl-Ergebnis direkt
 * aus der Browser-Konsole in die Datei wandern kann, ohne Umweg ueber
 * Zwischenablage und Editor. Weil dabei eine Datei geschrieben wird und jede
 * beliebige offene Seite localhost ansprechen koennte, braucht der Aufruf ein
 * Token, das nur hier im Terminal steht.
 */
const IMPORT_TOKEN = randomBytes(9).toString('hex');

/** Nur diese Dateien darf ein Import ueberschreiben. */
const IMPORTABLE = new Set(['stations.sixt.txt']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------ Ergebnisspeicher */

/** Auftragsschluessel -> Ergebnis. Bewusst nur im Arbeitsspeicher. */
const results = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

function remember(key, record) {
  results.set(key, { ...record, receivedAt: Date.now() });
  // Alte und ueberzaehlige Eintraege wegraeumen.
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of results) if (v.receivedAt < cutoff) results.delete(k);
  while (results.size > MAX_ENTRIES) results.delete(results.keys().next().value);
}

/* ------------------------------------------------------ Hilfen */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // Die Erweiterung meldet sich aus dem Kontext der Anbieterseite.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    // Chrome behandelt Zugriffe von einer oeffentlichen Seite auf localhost
    // als "Private Network Access" und verlangt diese ausdrueckliche Freigabe.
    'access-control-allow-private-network': 'true',
  });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Anfrage zu groß');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------ Server */

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600',
    });
    return res.end();
  }

  // Lebenszeichen — die Oberflaeche schaltet daran den Preis-Modus frei.
  if (path === '/api/health') {
    return json(res, 200, { ok: true, service: 'mwt-preistool', stored: results.size });
  }

  // Eingang der Erweiterung.
  if (path === '/api/offers' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body || typeof body.key !== 'string' || !body.key) {
        return json(res, 400, { ok: false, error: 'key fehlt' });
      }
      remember(body.key, {
        host: body.host || null,
        url: body.url || null,
        station: body.station || null,
        offers: Array.isArray(body.offers) ? body.offers : [],
        error: body.error || null,
      });
      const n = Array.isArray(body.offers) ? body.offers.length : 0;
      console.log(
        `  ← ${body.host || '?'}  ${body.error ? 'Fehler: ' + body.error : n + ' Angebote'}`
      );
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  // Abholung durch die Oberflaeche.
  if (path === '/api/results') {
    const want = url.searchParams.get('keys');
    const out = {};
    if (want) {
      for (const k of want.split(',')) if (results.has(k)) out[k] = results.get(k);
    } else {
      for (const [k, v] of results) out[k] = v;
    }
    return json(res, 200, { ok: true, results: out });
  }

  // Stationsliste aus einem Crawl uebernehmen.
  if (path === '/api/stations-import' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req, 5_000_000));
      if (body.token !== IMPORT_TOKEN) return json(res, 403, { ok: false, error: 'Token falsch' });
      if (!IMPORTABLE.has(body.file)) return json(res, 400, { ok: false, error: 'Datei nicht erlaubt' });

      const rows = Array.isArray(body.rows) ? body.rows : [];
      const valid = rows.filter((r) => /^\d+\|[A-Z?]{2}\|[A-Z]{0,3}\|.+/.test(r));
      if (!valid.length) return json(res, 400, { ok: false, error: 'keine gültigen Zeilen' });

      const head = [
        '# SIXT-Stationen — Format: id|land|iata|name',
        '# Quelle: oeffentliche Stationsseiten auf sixt.de (/mietwagen/<land>/<stadt>/<station>/)',
        `# Geerntet: ${new Date().toISOString().slice(0, 10)} · Anleitung: tools/harvest-sixt.md`,
        '# Zeilen mit # werden ignoriert. Eigene Stationen einfach unten anhaengen.',
      ].join('\n');

      await writeFile(join(root, 'src', 'data', body.file), head + '\n' + valid.join('\n') + '\n');
      console.log(`  ← Stationsimport: ${valid.length} Zeilen in src/data/${body.file}`);
      return json(res, 200, { ok: true, written: valid.length, skipped: rows.length - valid.length });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  if (path === '/api/results/clear' && req.method === 'POST') {
    results.clear();
    return json(res, 200, { ok: true });
  }

  /* ---------------------------------------------------- Statische Dateien */

  let file = path === '/' ? '/dist/mietwagen-preistool.html' : path;
  const abs = join(root, normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(root)) {
    res.writeHead(403).end('verboten');
    return;
  }

  try {
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('kein File');
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': TYPES[extname(abs)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('nicht gefunden: ' + path);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Mietwagen-Preistool:  http://localhost:${port}/`);
  console.log(`Preiseingang:         POST /api/offers`);
  console.log(`Import-Token:         ${IMPORT_TOKEN}`);
});
