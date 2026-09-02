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
import { writeFile, appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { quoteSixt } from './scrape/sixt.mjs';
import { quoteSchutz } from './scrape/sixt-schutz.mjs';
import { findBrowser, closeBrowser } from './browser.mjs';
import { merkeAngebote, bekannteKlassen, katalogStand } from './katalog.mjs';
import { istExe, quellWurzel, datenOrdner, leseVorrat } from './pfade.mjs';
import { oeffneFenster } from './fenster.mjs';
import { protokolliereNach, protokollPfad, zeigeMeldung } from './meldung.mjs';
import { merkeAbruf, leseVerlauf, verlaufUebersicht } from './beobachtung.mjs';
import {
  alleWecker,
  legeWecker,
  loescheWecker,
  quittiereWecker,
  faelligeWecker,
  vermerkePruefung,
} from './wecker.mjs';

const argumente = process.argv.slice(2);
// Den Port aus dem ersten Zahlenargument holen, nicht aus argv[2] — sonst
// verschiebt ein vorangestellter Schalter ihn. PORT aus der Umgebung kommt
// danach: Werkzeuge, die den Dienst starten, teilen ihn so zu, ohne dass am
// Aufruf etwas geaendert werden muss.
const port =
  Number(argumente.find((a) => /^\d+$/.test(a))) || Number(process.env.PORT) || 4173;
/** Kein Fenster aufmachen — fuer Pruefläufe und stille Starts. */
const stillerStart = argumente.includes('--kein-browser');

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

/* ------------------------------------------------------ Abrufwarteschlange */

/**
 * Der Preisabruf laeuft im Hintergrund, damit die Oberflaeche waehrenddessen
 * bedienbar bleibt. Zwei Anfragen gleichzeitig — mehr waere gegenueber den
 * Anbieterseiten unhoeflich und bringt auch nichts, weil ohnehin jede Seite
 * ihre Ladezeit braucht.
 */
const queue = [];
let laufend = 0;
let erledigt = 0;
let gesamt = 0;
const PARALLEL = 2;

const ABRUF = { sixt: quoteSixt };
const SCHUTZ_ABRUF = { sixt: quoteSchutz };

function enqueue(jobs) {
  for (const j of jobs) {
    if (!j?.key || results.has(j.key)) continue;
    if (queue.some((q) => q.key === j.key)) continue;
    queue.push(j);
    gesamt++;
  }
  for (let i = laufend; i < PARALLEL; i++) tick();
}

/**
 * Mindestabstand zwischen zwei Startvorgaengen.
 *
 * browser.mjs bremst je Host — bei einem Rundumschlag ueber dreissig
 * verschiedene Laenderseiten greift das nie, weil jeder Host nur einmal
 * drankommt. Der Abruf lief dadurch dauerhaft mit zwei parallelen Zugriffen
 * auf Sixt, und im Test stiegen dabei reihenweise Seiten mit "Station wurde
 * nicht uebernommen" aus — einzeln aufgerufen liefen dieselben Seiten
 * einwandfrei. Eine dreiviertel Sekunde Abstand kostet bei dreissig Seiten
 * gut zehn Sekunden und erspart das Nachfassen.
 */
const START_ABSTAND_MS = 750;
let letzterStart = 0;

async function tick() {
  if (laufend >= PARALLEL) return;
  const job = queue.shift();
  if (!job) {
    // Nichts mehr zu tun: Zaehler zuruecksetzen, damit der naechste Lauf
    // wieder bei 0 anfaengt.
    if (laufend === 0) {
      erledigt = 0;
      gesamt = 0;
    }
    return;
  }

  laufend++;
  try {
    const wartet = START_ABSTAND_MS - (Date.now() - letzterStart);
    if (wartet > 0) await new Promise((r) => setTimeout(r, wartet));
    letzterStart = Date.now();

    // Zwei Arten von Auftrag: Preisliste einer Station, oder Schutzpakete
    // fuer eine bestimmte Fahrzeugklasse.
    const schutz = Boolean(job.acriss);
    const abruf = (schutz ? SCHUTZ_ABRUF : ABRUF)[job.provider];
    if (!abruf) throw new Error(`Anbieter ${job.provider} hat keinen Abruf`);

    console.log(
      `  → ${job.host}  Station ${job.stationCode}` +
        (schutz ? `  Schutz ${job.acriss}` : `  ${job.pickupDate}`)
    );
    const res = await abruf(job);

    if (schutz) {
      remember(job.key, {
        host: job.host,
        url: res.url || null,
        acriss: job.acriss,
        // Nur als verfuegbar merken, wenn der Abruf auch geklappt hat.
        // Vorher galt ein gescheiterter Abruf als verfuegbar, weil
        // `undefined !== false` wahr ist — die Oberflaeche zeigte dann ein
        // nichtssagendes "—" statt der Fehlermeldung.
        verfuegbar: res.ok === true && res.verfuegbar !== false,
        pakete: res.pakete || [],
        error: res.error || null,
        note: res.note || null,
      });
      console.log(
        `  ← ${job.host}  ${res.error || res.note || (res.pakete?.length ?? 0) + ' Schutzpakete'}` +
          (res.ms ? `  (${(res.ms / 1000).toFixed(1)}s)` : '')
      );
      return;
    }

    remember(job.key, {
      host: job.host,
      url: res.url || null,
      station: res.station || null,
      offers: res.offers || [],
      error: res.error || null,
      warnung: res.warnung || null,
    });
    if (res.warnung) console.log(`  ! ${job.host}  ${res.warnung}`);

    // Gesehene Klassen dauerhaft merken, damit spaeter "gerade nicht buchbar"
    // von "gibt es dort nicht" unterscheidbar bleibt.
    if (res.offers?.length) await merkeAngebote(job, res.offers).catch(() => {});
    // Und den Preis fuer die Kurve — jeder Abruf ist ein Messpunkt.
    await merkeAbruf(job, res).catch(() => {});

    const n = res.offers?.length ?? 0;
    console.log(
      `  ← ${job.host}  ${res.error ? 'Fehler: ' + res.error : n + ' Angebote'}` +
        (res.ms ? `  (${(res.ms / 1000).toFixed(1)}s)` : '')
    );
  } catch (e) {
    remember(job.key, { host: job.host, offers: [], error: String(e.message).slice(0, 160) });
    console.log(`  ← ${job.host}  Fehler: ${String(e.message).slice(0, 120)}`);
  } finally {
    laufend--;
    erledigt++;
    tick();
  }
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

/* ------------------------------------------------------ Weckerrunde
 *
 * Faellige Wecker der Reihe nach nachpruefen — einzeln und nur, wenn sonst
 * nichts laeuft. Eine Weckerrunde darf niemals eine Suche ausbremsen, die
 * jemand gerade angestossen hat: die wartet einer an, die Runde nicht.
 */

const WECKER_TAKT_MS = 30 * 60 * 1000;
let naechsteWeckerRunde = null;
let weckerLaeuft = false;

async function weckerRunde({ sofort = false } = {}) {
  if (weckerLaeuft) return;
  if (laufend > 0 || queue.length) return; // der Nutzer hat Vorrang
  if (!findBrowser()) return;

  const faellig = sofort ? await alleWecker() : await faelligeWecker();
  const zuTun = sofort
    ? faellig.filter((w) => w.bis >= new Date().toISOString().slice(0, 10))
    : faellig;
  if (!zuTun.length) return;

  weckerLaeuft = true;
  console.log(`  ⏰ Weckerrunde: ${zuTun.length} zu prüfen`);
  try {
    for (const w of zuTun) {
      // Zwischendurch abbrechen, sobald jemand selbst etwas sucht.
      if (laufend > 0 || queue.length) break;
      try {
        const r = await quoteSixt({
          host: w.host,
          stationCode: w.station,
          pickupDate: w.von,
          returnDate: w.bis,
          pickupTime: '10:00',
          returnTime: '10:00',
          currency: w.waehrung || undefined,
        });
        await merkeAbruf(
          { host: w.host, stationCode: w.station, pickupDate: w.von, returnDate: w.bis },
          r
        ).catch(() => {});

        const treffer = (r.offers || []).find((o) => o.acriss === w.acriss && o.total != null);
        const loest = await vermerkePruefung(w.id, {
          preis: treffer?.total ?? null,
          fehler: r.error || (treffer ? null : 'Klasse gerade nicht im Angebot'),
        });

        if (loest) {
          const text =
            `${w.stationName || 'Station ' + w.station}\n` +
            `${w.acriss} auf ${w.host.replace(/^www\./, '')}\n\n` +
            `${treffer.total} ${w.waehrung} — unter deiner Grenze von ${w.grenze}.\n` +
            `${w.von} bis ${w.bis}`;
          console.log(`  ⏰ AUSGELÖST: ${w.acriss} ${treffer.total} ${w.waehrung}`);
          if (istExe) zeigeMeldung(text, 'Preiswecker');
        }
      } catch (e) {
        await vermerkePruefung(w.id, { fehler: String(e.message).slice(0, 140) }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    weckerLaeuft = false;
  }
}

function starteWeckerTakt() {
  const takt = () => {
    naechsteWeckerRunde = Date.now() + WECKER_TAKT_MS;
    weckerRunde().catch(() => {});
  };
  takt();
  setInterval(takt, WECKER_TAKT_MS).unref();
}

/* ------------------------------------------------------ Lebenszeichen
 *
 * Woher weiss ein Programm ohne Konsolenfenster, dass es fertig ist?
 *
 * Nicht vom Chrome-Prozess: Chrome reicht Fenster zwischen seinen Prozessen
 * weiter, der gestartete Prozess endet dabei, das Fenster bleibt stehen. Wer
 * daran das Programmende haengt, beendet sich nach Sekunden von selbst —
 * genau das ist passiert.
 *
 * Also sagt es die Seite selbst: sie meldet sich regelmaessig und schickt beim
 * Schliessen ein letztes Signal. Das Neuladen schickt dasselbe Signal, deshalb
 * wird nicht sofort beendet, sondern ein paar Sekunden auf ein neues
 * Lebenszeichen gewartet. Bleibt es aus, war es wirklich das Ende.
 */

/**
 * Offene Fenster, je mit eigener Kennung.
 *
 * Gezaehlt wird einzeln und nicht bloss "irgendwer war da": sonst beendet das
 * Schliessen des einen Fensters das Programm, waehrend ein zweites noch offen
 * ist. Die Kennung vergibt die Seite beim Laden.
 */
const offeneFenster = new Map(); // Kennung -> zuletzt gesehen

/** So lange nach dem letzten Fenster gewartet wird — ein Neuladen dauert kürzer. */
const NACHFRIST_MS = 4000;

/** Ohne Lebenszeichen gilt ein Fenster nach dieser Zeit als abgestürzt. */
const STILLE_MS = 90_000;

let schliessTimer = null;

/**
 * Hat sich seit dem Start ueberhaupt schon einmal ein Fenster gemeldet?
 *
 * Ohne diese Frage schlaegt der Waechter beim Start zu: die Liste ist dann
 * leer, weil die Seite noch laedt — und vier Sekunden spaeter beendet sich
 * das Programm, waehrend der Vorspann noch laeuft. Genau das ist passiert.
 * Solange noch nie ein Fenster da war, wird nur die grosszuegige Startfrist
 * abgewartet; erst danach gilt "niemand da" als Grund zu gehen.
 */
let jeEinFenster = false;
const gestartetUm = Date.now();
const STARTFRIST_MS = 120_000;

function pruefeObNochWer() {
  if (!istExe) return;
  if (offeneFenster.size > 0) {
    jeEinFenster = true;
    if (schliessTimer) {
      clearTimeout(schliessTimer);
      schliessTimer = null;
    }
    return;
  }
  // Beim Start geduldig sein: eine grosse Seite mit eingebettetem Vorspann
  // braucht auf einem langsamen Rechner spuerbar laenger, als vier Sekunden
  // Nachfrist erlauben.
  if (!jeEinFenster && Date.now() - gestartetUm < STARTFRIST_MS) return;
  if (schliessTimer) return;
  // Nicht sofort: ein Neuladen meldet sich ab und gleich darauf neu an.
  schliessTimer = setTimeout(() => {
    if (offeneFenster.size > 0) return;
    console.log('Letztes Fenster geschlossen — Programm beendet.');
    beenden();
  }, NACHFRIST_MS);
}

function lebenszeichen(kennung) {
  if (!kennung) return;
  offeneFenster.set(kennung, Date.now());
  pruefeObNochWer();
}

function fensterGehtZu(kennung) {
  if (kennung) offeneFenster.delete(kennung);
  pruefeObNochWer();
}

// Notnagel: stuerzt der Browser ab, kommt kein Abschiedssignal. Ohne diese
// Pruefung liefe der Dienst unsichtbar weiter, bis jemand ihn im Taskmanager
// findet.
if (istExe) {
  setInterval(() => {
    const alt = Date.now() - STILLE_MS;
    for (const [k, zuletzt] of offeneFenster) if (zuletzt < alt) offeneFenster.delete(k);
    pruefeObNochWer();
  }, 15_000).unref();
}

/* ------------------------------------------------------ Server */

const server = createServer(async (req, res) => {
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
    return json(res, 200, {
      ok: true,
      service: 'mwt-preistool',
      stored: results.size,
      // Ohne Chrome gibt es keinen automatischen Abruf; die Oberflaeche sagt
      // das dann statt es zu versuchen und stillschweigend zu scheitern.
      chrome: Boolean(findBrowser()),
      queue: { laufend, offen: queue.length, erledigt, gesamt },
    });
  }

  // Automatischer Preisabruf anstossen.
  if (path === '/api/fetch' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const jobs = Array.isArray(body.jobs) ? body.jobs : [];
      if (!findBrowser()) {
        return json(res, 200, {
          ok: false,
          error: 'Chrome wurde nicht gefunden — automatischer Abruf nicht möglich.',
        });
      }
      const vorher = queue.length + laufend;
      enqueue(jobs);
      return json(res, 200, { ok: true, angenommen: queue.length + laufend - vorher });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
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
      // Der Import schreibt in den Quellbaum und braucht danach einen neuen
      // Build. In der EXE gibt es beides nicht.
      if (istExe) return json(res, 400, { ok: false, error: 'Nur aus dem Quellbaum möglich' });

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

      await writeFile(join(quellWurzel, 'src', 'data', body.file), head + '\n' + valid.join('\n') + '\n');
      console.log(`  ← Stationsimport: ${valid.length} Zeilen in src/data/${body.file}`);
      return json(res, 200, { ok: true, written: valid.length, skipped: rows.length - valid.length });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  // Welche Klassen sind an dieser Station schon einmal angeboten worden?
  if (path === '/api/katalog') {
    const provider = url.searchParams.get('provider') || 'sixt';
    const station = url.searchParams.get('station') || '';
    const hosts = (url.searchParams.get('hosts') || '').split(',').filter(Boolean);
    try {
      const klassen = await bekannteKlassen(provider, station, hosts);
      return json(res, 200, { ok: true, klassen });
    } catch (e) {
      return json(res, 200, { ok: false, klassen: {}, error: String(e.message).slice(0, 120) });
    }
  }

  if (path === '/api/cancel' && req.method === 'POST') {
    const verworfen = queue.length;
    queue.length = 0;
    gesamt -= verworfen;
    console.log(`  ! Abgebrochen: ${verworfen} wartende Abrufe verworfen`);
    return json(res, 200, { ok: true, verworfen, nochLaufend: laufend });
  }

  /* ---------------------------------------------------- Preisverlauf */

  if (path === '/api/verlauf') {
    try {
      const punkte = await leseVerlauf({
        station: url.searchParams.get('station') || undefined,
        acriss: url.searchParams.get('acriss') || undefined,
        host: url.searchParams.get('host') || undefined,
        von: url.searchParams.get('von') || undefined,
        bis: url.searchParams.get('bis') || undefined,
      });
      return json(res, 200, { ok: true, punkte });
    } catch (e) {
      return json(res, 200, { ok: false, punkte: [], error: String(e.message).slice(0, 160) });
    }
  }

  if (path === '/api/verlauf/uebersicht') {
    try {
      return json(res, 200, { ok: true, gruppen: await verlaufUebersicht() });
    } catch (e) {
      return json(res, 200, { ok: false, gruppen: [], error: String(e.message).slice(0, 160) });
    }
  }

  /* ---------------------------------------------------- Preiswecker */

  if (path === '/api/wecker' && req.method === 'GET') {
    return json(res, 200, { ok: true, wecker: await alleWecker(), naechstePruefung: naechsteWeckerRunde });
  }

  if (path === '/api/wecker' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req, 20_000));
      if (!body.station || !body.von || !body.bis || !body.host || !body.acriss) {
        return json(res, 400, { ok: false, error: 'Station, Zeitraum, Länderseite und Klasse nötig' });
      }
      if (!(Number(body.grenze) > 0)) {
        return json(res, 400, { ok: false, error: 'Preisgrenze fehlt' });
      }
      const w = await legeWecker(body);
      console.log(`  ⏰ Wecker: ${w.stationName} ${w.acriss} unter ${w.grenze} ${w.waehrung}`);
      // Gleich einmal nachsehen, statt bis zur nächsten Runde zu warten.
      weckerRunde().catch(() => {});
      return json(res, 200, { ok: true, wecker: w });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  if (path === '/api/wecker/loeschen' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 4000));
    return json(res, 200, { ok: await loescheWecker(body.id) });
  }

  if (path === '/api/wecker/quittieren' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 4000));
    return json(res, 200, { ok: await quittiereWecker(body.id) });
  }

  if (path === '/api/wecker/pruefen' && req.method === 'POST') {
    // Von Hand angestossen — ohne Rücksicht auf den Mindestabstand.
    weckerRunde({ sofort: true }).catch(() => {});
    return json(res, 200, { ok: true });
  }

  // Selbsttest: geht die ganze Kette auf diesem Rechner durch?
  if (path === '/api/selbsttest' && req.method === 'POST') {
    if (laufend > 0 || queue.length) {
      return json(res, 200, {
        ok: false,
        error: 'Erst den laufenden Abruf abwarten — beides gleichzeitig verfälscht das Ergebnis.',
      });
    }
    try {
      const { selbsttest } = await import('./selbsttest.mjs');
      const schritte = await selbsttest();
      return json(res, 200, { ok: true, schritte });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 300) });
    }
  }

  // Die Seite meldet, dass ihr Fenster noch offen ist.
  if (path === '/api/lebt') {
    lebenszeichen(url.searchParams.get('id'));
    return json(res, 200, { ok: true });
  }

  // ... und dass es zugeht.
  if (path === '/api/fenster-zu') {
    fensterGehtZu(url.searchParams.get('id'));
    return json(res, 200, { ok: true });
  }

  if (path === '/api/results/clear' && req.method === 'POST') {
    results.clear();
    return json(res, 200, { ok: true });
  }

  /* ---------------------------------------------------- Statische Dateien */

  const file = path === '/' ? '/dist/mietwagen-preistool.html' : path;
  // Erst normalisieren, dann fuehrende Schraegstriche und Aufstiege abtragen —
  // und zwar so lange, bis nichts mehr uebrig ist. Nur einmal zu ersetzen
  // laesst "/../x" stehen. Die eigentliche Sperre sitzt zusaetzlich in
  // leseVorrat; hier geht es darum, gar nicht erst danach zu fragen.
  let name = normalize(file).replaceAll('\\', '/');
  for (let vorher = null; vorher !== name; ) {
    vorher = name;
    name = name.replace(/^\/+/, '').replace(/^(\.\.?\/)+/, '');
  }

  // Ausgeliefert wird nur, was in dist/ liegt — die gebaute Oberflaeche.
  // Alles andere braucht die Seite nicht: sie ist eine einzige Datei, die
  // Daten kommen ueber /api/. Der Dienst hoert zwar nur auf 127.0.0.1, aber
  // jede beliebige offene Seite im Browser kann ihn ansprechen, und dann muss
  // sie nicht den Quellbaum durchblaettern koennen.
  if (!name.startsWith('dist/')) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('nur dist/ wird ausgeliefert: ' + path);
    return;
  }

  const body = await leseVorrat(name);
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('nicht gefunden: ' + path);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(name)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
});

/* ------------------------------------------------------ Starten */

/**
 * Laeuft auf diesem Port bereits unser eigener Dienst?
 *
 * Wichtig fuer den Doppelklick: startet jemand das Programm ein zweites Mal,
 * soll es nicht mit einer Fehlermeldung abbrechen, sondern einfach das
 * Fenster zum schon laufenden Dienst aufmachen.
 */
async function schonUnserer(p) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return r.ok && (await r.json()).service === 'mwt-preistool';
  } catch {
    return false;
  }
}

/**
 * Einmal versuchen zu lauschen. `false` heisst "Port belegt"; jeder andere
 * Fehler wird durchgereicht, denn der ist nicht durch Weiterzaehlen zu heilen.
 */
function versucheLauschen(p) {
  return new Promise((gelungen, gescheitert) => {
    const beiFehler = (e) => {
      server.removeListener('listening', beiErfolg);
      if (e.code === 'EADDRINUSE') gelungen(false);
      else gescheitert(e);
    };
    const beiErfolg = () => {
      server.removeListener('error', beiFehler);
      gelungen(true);
    };
    server.once('error', beiFehler);
    server.once('listening', beiErfolg);
    server.listen(p, '127.0.0.1');
  });
}

/**
 * Das Programmfenster öffnen.
 *
 * Wann das Programm endet, entscheidet nicht dieser Prozess, sondern die
 * Seite darin (siehe Lebenszeichen weiter unten). Chrome reicht Fenster
 * zwischen eigenen Prozessen weiter, wie es ihm passt — der hier gestartete
 * Prozess kann längst beendet sein, während das Fenster offen auf dem
 * Bildschirm steht. Ihn als Ausschalter zu nehmen, hat genau das getan:
 * das Programm beendete sich nach ein paar Sekunden von selbst.
 */
function oeffneProgrammfenster(adresse) {
  const { art, prozess } = oeffneFenster(adresse, datenOrdner);

  if (art === 'keiner') {
    zeigeMeldung(
      'Es liess sich kein Fenster öffnen.\n\n' +
        'TRACKER läuft, erreichbar unter:\n' +
        adresse
    );
    return;
  }

  if (art === 'browser') {
    console.log('Kein Chrome und kein Edge gefunden — geöffnet im Standardbrowser.');
    zeigeMeldung(
      'Chrome oder Edge wurde nicht gefunden.\n\n' +
        'TRACKER ist im Standardbrowser geöffnet, aber der Preisabruf ' +
        'braucht Chrome oder Edge. Ohne einen der beiden bleibt es beim ' +
        'Erzeugen der Links.'
    );
    return;
  }

  // Nur fürs Protokoll: der Prozess sagt nichts darüber aus, ob das Fenster
  // noch steht, aber sein Ende ist beim Suchen eines Fehlers nützlich.
  prozess.on('exit', (code) => console.log(`Fensterprozess beendet (Code ${code}).`));
}

async function starteDienst() {
  if (istExe) protokolliereNach(datenOrdner);

  // 127.0.0.1 statt localhost: der Dienst haengt nur an der IPv4-Adresse,
  // waehrend "localhost" unter Windows zuerst als ::1 aufgeloest wird.
  for (let p = port; p < port + 12; p++) {
    if (await schonUnserer(p)) {
      const adresse = `http://127.0.0.1:${p}/`;
      console.log(`TRACKER läuft bereits auf ${adresse}`);
      if (istExe && !stillerStart) {
        // Nur ein weiteres Fenster dazu — der laufende Dienst bleibt der Chef,
        // deshalb hier ohne Ende-Kopplung.
        oeffneFenster(adresse, datenOrdner);
        setTimeout(() => process.exit(0), 2500);
        return;
      }
      process.exit(0);
    }

    if (!(await versucheLauschen(p))) {
      console.log(`Port ${p} ist belegt — versuche ${p + 1} …`);
      continue;
    }

    const adresse = `http://127.0.0.1:${p}/`;
    const chrome = findBrowser();
    console.log(`TRACKER:              ${adresse}`);
    console.log(
      `Preisabruf:           ${chrome ? chrome : 'kein Chrome gefunden — nur Link-Modus'}`
    );
    if (istExe) {
      console.log(`Daten:                ${datenOrdner}`);
      if (!stillerStart) oeffneProgrammfenster(adresse);
    } else {
      console.log(`Import-Token:         ${IMPORT_TOKEN}`);
    }

    // Erst wenn der Dienst wirklich steht: sonst pruefte die erste Runde,
    // waehrend der Port noch gesucht wird.
    starteWeckerTakt();
    return;
  }

  throw new Error(`Kein freier Port zwischen ${port} und ${port + 11} gefunden.`);
}

/**
 * Fehler sichtbar machen.
 *
 * Ohne Konsolenfenster gibt es niemanden, der eine Ausgabe liest. Was den
 * Start verhindert, muss deshalb als Fenster auf den Bildschirm — mit einem
 * Verweis auf das Protokoll, in dem die Einzelheiten stehen.
 */
function melde(ueberschrift, fehler) {
  const text = String(fehler?.stack || fehler?.message || fehler);
  console.error(ueberschrift + ': ' + text);
  if (!istExe || stillerStart) return;
  zeigeMeldung(
    `${ueberschrift}:\n\n${String(fehler?.message || fehler).slice(0, 400)}\n\n` +
      `Einzelheiten stehen in:\n${protokollPfad() || '(kein Protokoll)'}`
  );
}

starteDienst().catch((e) => {
  melde('Start fehlgeschlagen', e);
  // Der Meldung Zeit lassen, sich zu zeigen, bevor der Prozess endet.
  setTimeout(() => process.exit(1), 2500);
});

process.on('uncaughtException', (e) => {
  melde('Unerwarteter Fehler', e);
  setTimeout(() => process.exit(1), 2500);
});

/**
 * Geordnet enden.
 *
 * Das Chrome des Preisabrufs laeuft ausserhalb des Bildschirms; bliebe es als
 * Waise zurueck, haette der Nutzer einen unsichtbaren Prozess auf dem Rechner,
 * den er nicht findet und nicht zuordnen kann.
 */
let beendetGerade = false;

async function beenden(code = 0) {
  if (beendetGerade) return;
  beendetGerade = true;
  try {
    await closeBrowser();
  } catch {
    /* dann eben nicht — beenden ist wichtiger */
  }
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => beenden(0));
}
