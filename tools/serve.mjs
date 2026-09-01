/**
 * Winziger statischer Server fuer die Entwicklung — ohne Abhaengigkeiten.
 * Fuer den Alltag nicht noetig: dist/mietwagen-preistool.html laeuft auch
 * direkt per Doppelklick aus dem Dateisystem.
 *
 *   node tools/serve.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/dist/mietwagen-preistool.html';

  // Ausbruch aus dem Projektordner verhindern.
  const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('verboten');
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('kein File');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('nicht gefunden: ' + path);
  }
}).listen(port, () => {
  console.log(`Mietwagen-Preistool: http://localhost:${port}/`);
});
