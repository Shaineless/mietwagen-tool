/**
 * Proxys je Länderseite.
 *
 * WOZU DAS GUT IST, und wozu nicht:
 *
 * Der Preisvergleich stellt bisher nur Domains gegenüber, sixt.de gegen
 * sixt.fr. Die Herkunft des Besuchers ist dabei eine zweite, ungetestete
 * Grösse: sieht jemand aus Frankreich auf sixt.fr denselben Preis wie jemand
 * aus Deutschland? Mit einem Proxy je Länderseite lässt sich das messen.
 *
 * Bewusst NICHT gebaut ist ein Wechsel bei Zurückweisung. Fällt ein Proxy
 * technisch aus (tot, Zeitüberschreitung, Tunnel abgelehnt), wird der nächste
 * geprüfte genommen, das ist Ausfallsicherheit. Weist dagegen die Länderseite
 * selbst den Zugriff ab, wird das GEMELDET und nicht still der nächste
 * probiert. Der Unterschied ist der zwischen einem kaputten Weg und dem
 * Umgehen einer Sperre, und er steht auch so im README.
 *
 *
 * WARUM EINE EIGENE WEICHE, statt Chrome den Proxy direkt zu nennen:
 *
 *   1. `--proxy-server` gilt für den GANZEN Chrome-Prozess, nicht je Tab. Ein
 *      Proxy je Länderseite hiesse sonst ein Chrome je Länderseite, und bei
 *      29 Seiten wäre das jeder Rechner los.
 *   2. `--proxy-server` kann KEINE Zugangsdaten tragen. Chrome öffnet dann
 *      einen Anmeldedialog, den in einem unsichtbaren Fenster niemand
 *      wegklickt, und der Abruf steht.
 *
 * Also: Chrome bekommt genau einen Proxy genannt, nämlich diese Weiche auf
 * 127.0.0.1. Sie schaut sich das Ziel jeder Verbindung an, sucht den dafür
 * eingestellten Proxy heraus, meldet sich dort an und leitet weiter. Ist für
 * ein Ziel nichts eingestellt, geht die Verbindung ohne Umweg hinaus.
 */

// http.createServer, NICHT net.createServer: nur der HTTP-Server kennt das
// Ereignis "connect", mit dem ein Proxy die CONNECT-Anfrage bekommt. Als
// net-Server angelegt feuerte der Zuhoerer nie, die Weiche bearbeitete gar
// nichts, und jeder Abruf lief in eine Zeitueberschreitung.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { datenOrdner } from './pfade.mjs';

const DATEI = join(datenOrdner, 'proxies.json');

/** Wie viele Einträge eine Prüfung höchstens anfasst. */
export const PRUEF_GRENZE = 25;

/* ------------------------------------------------------ Einträge lesen */

/**
 * Eine Zeile in ihre Teile zerlegen.
 *
 * Übliche Schreibweisen, alle unterstützt:
 *   host:port
 *   host:port:benutzer:passwort
 *   benutzer:passwort@host:port
 *   http://benutzer:passwort@host:port
 */
export function zerlegeProxy(zeile) {
  const roh = String(zeile || '').trim();
  if (!roh || roh.startsWith('#')) return null;

  // Mit Schema oder mit @: als Adresse lesen, das erspart eigenes Raten.
  if (/^\w+:\/\//.test(roh) || roh.includes('@')) {
    try {
      const u = new URL(/^\w+:\/\//.test(roh) ? roh : `http://${roh}`);
      if (!u.hostname || !u.port) return null;
      return {
        host: u.hostname,
        port: Number(u.port),
        benutzer: decodeURIComponent(u.username) || null,
        passwort: decodeURIComponent(u.password) || null,
      };
    } catch {
      return null;
    }
  }

  const t = roh.split(':');
  if (t.length === 2 || t.length === 4) {
    const port = Number(t[1]);
    if (!t[0] || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      host: t[0],
      port,
      benutzer: t[2] || null,
      passwort: t[3] || null,
    };
  }
  return null;
}

/** Zum Anzeigen: ohne Passwort. */
export function proxyKurz(p) {
  if (!p) return null;
  return `${p.host}:${p.port}` + (p.benutzer ? ` (${p.benutzer.slice(0, 6)}…)` : '');
}

/* ------------------------------------------------------ Einstellungen */

/**
 * Zwei Betriebsarten, weil zwei verschiedene Fragen dahinterstehen.
 *
 *   "allgemein"  Ein Vorrat für ALLE Länderseiten. Beantwortet: ändert sich
 *                der Preis, wenn die Anfrage von einem anderen Anschluss
 *                kommt als meinem? Woher die Proxys stammen, ist dabei egal.
 *
 *   "jeSeite"    Je Länderseite ein eigener Vorrat, sinnvollerweise mit
 *                Proxys aus dem jeweiligen Land. Beantwortet die eigentlich
 *                interessante Frage: sieht ein Franzose auf sixt.fr denselben
 *                Preis wie ich? Länderseiten ohne eigenen Eintrag gehen
 *                bewusst direkt hinaus, statt still auf den allgemeinen
 *                Vorrat auszuweichen. Sonst wüsste hinterher niemand mehr,
 *                über welchen Weg eine Zahl gemessen wurde.
 *
 * Aufbau:
 *   { modus: 'aus'|'allgemein'|'jeSeite',
 *     allgemein: Vorrat,
 *     hosts: { 'www.sixt.fr': Vorrat } }
 *
 * Ein Vorrat: { liste: [Zeile], gewaehlt: index|null, geprueft: {...}|null }
 */
let einstellungen = null;

const LEER = () => ({ modus: 'aus', allgemein: null, hosts: {} });

async function laden() {
  if (einstellungen) return einstellungen;
  try {
    const roh = await readFile(DATEI, 'utf8');
    const d = JSON.parse(roh.replace(/^﻿/, ''));
    einstellungen = d && typeof d === 'object' && d.hosts ? d : LEER();
  } catch {
    einstellungen = LEER();
  }
  if (!['aus', 'allgemein', 'jeSeite'].includes(einstellungen.modus)) einstellungen.modus = 'aus';
  einstellungen.hosts ||= {};
  return einstellungen;
}

/** 'allgemein' oder ein Hostname; gibt den passenden Vorrat zurück. */
function vorrat(ziel, anlegen = false) {
  if (ziel === 'allgemein') {
    if (anlegen) einstellungen.allgemein ||= { liste: [], gewaehlt: null, geprueft: null };
    return einstellungen.allgemein;
  }
  if (anlegen) einstellungen.hosts[ziel] ||= { liste: [], gewaehlt: null, geprueft: null };
  return einstellungen.hosts[ziel];
}

async function sichern() {
  try {
    await mkdir(datenOrdner, { recursive: true });
    await writeFile(DATEI, JSON.stringify(einstellungen, null, 1), 'utf8');
  } catch {
    /* dann eben nur für diese Sitzung */
  }
}

function standVon(k) {
  if (!k?.liste?.length) return null;
  const gewaehlt = k.gewaehlt != null ? zerlegeProxy(k.liste[k.gewaehlt]) : null;
  return {
    anzahl: k.liste.length,
    gewaehlt: k.gewaehlt ?? null,
    gewaehltKurz: proxyKurz(gewaehlt),
    geprueft: k.geprueft || null,
  };
}

/** Was die Oberfläche sehen darf: keine Passwörter. */
export async function proxyStand() {
  const e = await laden();
  const hosts = {};
  for (const [host, k] of Object.entries(e.hosts)) {
    const s = standVon(k);
    if (s) hosts[host] = s;
  }
  return {
    modus: e.modus,
    allgemein: standVon(e.allgemein),
    hosts,
    weiche: weichenPort,
    // Was jetzt tatsächlich benutzt würde, als Klartext für die Oberfläche.
    wirksam: [...zuordnung.keys()].sort(),
  };
}

/** @param {string} ziel  'allgemein' oder der Host einer Länderseite */
export async function setzeListe(ziel, zeilen) {
  await laden();
  const liste = (Array.isArray(zeilen) ? zeilen : String(zeilen).split('\n'))
    .map((z) => String(z).trim())
    .filter((z) => z && zerlegeProxy(z));

  if (!liste.length) return loescheListe(ziel);

  const k = vorrat(ziel, true);
  k.liste = liste;
  k.gewaehlt = null;
  k.geprueft = null;
  await sichern();
  aktualisiereWeiche();
  return { ok: true, anzahl: liste.length };
}

export async function loescheListe(ziel) {
  await laden();
  if (ziel === 'allgemein') einstellungen.allgemein = null;
  else delete einstellungen.hosts[ziel];
  await sichern();
  aktualisiereWeiche();
  return { ok: true, anzahl: 0 };
}

export async function setzeModus(modus) {
  await laden();
  if (!['aus', 'allgemein', 'jeSeite'].includes(modus)) {
    return { ok: false, error: 'Unbekannte Betriebsart.' };
  }
  const vorher = einstellungen.modus;
  einstellungen.modus = modus;
  await sichern();
  aktualisiereWeiche();
  // Chrome bekommt den Proxy beim Start genannt. Wechselt die Betriebsart,
  // muss es deshalb neu starten, sonst gilt weiter der alte Weg.
  return { ok: true, modus, neustartNoetig: vorher !== modus };
}

/* ------------------------------------------------------ Prüfen */

/**
 * Einen Proxy anfassen: Tunnel aufbauen und die Ausgangsadresse erfragen.
 *
 * Die Ausgangsadresse ist die eigentlich interessante Angabe. Die Laufzeit
 * sagt bei einem Anbieter, der alle Einträge über dasselbe Gateway führt,
 * wenig aus; welche IP hinten herauskommt, sagt alles.
 */
export function pruefeProxy(zeile, { zeitlimit = 15000, ziel = 'api.ipify.org' } = {}) {
  const p = zerlegeProxy(zeile);
  if (!p) return Promise.resolve({ ok: false, grund: 'Zeile nicht lesbar' });

  return new Promise((fertig) => {
    const start = Date.now();
    let erledigt = false;
    const s = connect(p.port, p.host);
    const ende = (erg) => {
      if (erledigt) return;
      erledigt = true;
      s.destroy();
      fertig({ ...erg, ms: Date.now() - start });
    };
    s.setTimeout(zeitlimit, () => ende({ ok: false, grund: 'Zeitüberschreitung' }));
    s.on('error', (e) => ende({ ok: false, grund: e.code || e.message }));
    s.on('connect', () => {
      s.write(connectKopf(p, ziel, 443));
    });

    let kopf = '';
    s.on('data', function ersteAntwort(d) {
      kopf += d.toString('latin1');
      if (!kopf.includes('\r\n\r\n')) return;
      s.off('data', ersteAntwort);
      const status = Number((kopf.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      if (status !== 200) {
        return ende({
          ok: false,
          grund: status === 407 ? 'Zugangsdaten abgelehnt' : `Tunnel abgelehnt (${status || '?'})`,
        });
      }
      const r = request(
        { host: ziel, path: '/', method: 'GET', socket: s, agent: false, servername: ziel },
        (ant) => {
          let text = '';
          ant.on('data', (c) => (text += c));
          ant.on('end', () => ende({ ok: true, ip: text.trim().slice(0, 45) }));
        }
      );
      r.on('error', (e) => ende({ ok: false, grund: 'TLS: ' + (e.code || e.message) }));
      r.end();
    });
  });
}

/**
 * Eine Liste prüfen und den schnellsten funktionierenden auswählen.
 *
 * Grosse Listen werden BEWUSST nur in Stichproben angefasst. Zehntausend
 * Einträge zu prüfen dauerte Stunden und brächte nichts: bei einem Anbieter
 * mit einem einzigen Gateway sind es keine zehntausend Wege, sondern
 * zehntausend Sitzungskennungen auf demselben Weg.
 */
export async function pruefeListe(ziel, { anzahl = 10 } = {}) {
  await laden();
  const k = vorrat(ziel);
  if (!k?.liste?.length) return { ok: false, error: 'Dort ist keine Liste hinterlegt.' };

  const wieViele = Math.min(anzahl, PRUEF_GRENZE, k.liste.length);
  // Gleichmässig über die Liste verteilt statt die ersten N: bei sortierten
  // Listen wären die ersten N sonst alle vom selben Anbieter oder Standort.
  const schritt = Math.max(1, Math.floor(k.liste.length / wieViele));
  const indizes = [];
  for (let i = 0; indizes.length < wieViele && i < k.liste.length; i += schritt) indizes.push(i);

  const ergebnisse = [];
  // Nacheinander, nicht gleichzeitig: parallele Messungen ueber dasselbe
  // Gateway messen die Warteschlange, nicht den Proxy.
  for (const i of indizes) {
    const e = await pruefeProxy(k.liste[i]);
    ergebnisse.push({ i, ...e, kurz: proxyKurz(zerlegeProxy(k.liste[i])) });
  }

  const gute = ergebnisse.filter((e) => e.ok).sort((a, b) => a.ms - b.ms);
  k.gewaehlt = gute.length ? gute[0].i : null;
  if (gute.length) letzterAusgang = gute[0].ip;
  k.geprueft = {
    wann: Date.now(),
    geprueft: ergebnisse.length,
    davonGut: gute.length,
    schnellste: gute[0] ? { i: gute[0].i, ms: gute[0].ms, ip: gute[0].ip } : null,
    ausgaenge: [...new Set(gute.map((e) => e.ip))].length,
    einzeln: ergebnisse,
  };
  await sichern();
  aktualisiereWeiche();
  return { ok: true, ...k.geprueft, gewaehlt: k.gewaehlt };
}

/* ------------------------------------------------------ Die Weiche */

let weiche = null;
let weichenPort = null;
/** Zielhost (Kleinschreibung) -> zerlegter Proxy */
let zuordnung = new Map();

function connectKopf(p, host, port) {
  let kopf = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
  if (p.benutzer) {
    const auth = Buffer.from(`${p.benutzer}:${p.passwort ?? ''}`).toString('base64');
    kopf += `Proxy-Authorization: Basic ${auth}\r\n`;
  }
  return kopf + 'Connection: keep-alive\r\n\r\n';
}

/** Gilt für ALLE Ziele, in der Betriebsart "allgemein". */
let fuerAlle = null;

/**
 * Was gerade wirklich benutzt wird, für die Anzeige in der Oberfläche.
 *
 * Nicht dasselbe wie "was eingestellt ist": eingestellt sein kann etwas, das
 * nie zum Einsatz kam. Hier steht, worüber tatsächlich eine Verbindung
 * zustande gekommen ist, samt Zeitpunkt des letzten Wechsels. Daran hängt die
 * Anzeige, die beim Wechsel aufblinkt.
 */
let inBenutzung = null;
let seitWann = 0;
let wechselZaehler = 0;
let verbindungen = 0;

function merkeBenutzt(p) {
  verbindungen++;
  const kurz = proxyKurz(p);
  if (inBenutzung !== kurz) {
    inBenutzung = kurz;
    seitWann = Date.now();
    wechselZaehler++;
  }
}

/** Der Live-Zustand für die Anzeige. */
export function proxyLive() {
  return {
    modus: einstellungen?.modus || 'aus',
    aktiv: weicheGebraucht(),
    inBenutzung,
    ausgang: letzterAusgang,
    seitWann: seitWann || null,
    wechsel: wechselZaehler,
    verbindungen,
    verkehr: verkehrStand(),
  };
}

/* ------------------------------------------------------ Verbrauch */

/**
 * Wie viele Daten durch die Proxys gelaufen sind.
 *
 * Das ist keine Statistik zum Angucken, sondern Kostenkontrolle: Residential-
 * Proxys werden fast immer nach Gigabyte abgerechnet. Ohne Zähler weiss man
 * erst am Monatsende, was ein Kalenderlauf über 56 Tage gekostet hat.
 *
 * Messbar ist das nur, WEIL aller Verkehr durch die eigene Weiche läuft. Würde
 * Chrome direkt mit dem Proxy sprechen, käme man an diese Zahlen nicht heran.
 *
 * Gezählt wird an der Stelle, an der die beiden Steckdosen zusammengeschaltet
 * werden. Ein zusätzlicher Zuhörer auf "data" verbraucht die Daten nicht, er
 * sieht dieselben Stücke wie die Weiterleitung.
 */
const VERBRAUCH_DATEI = join(datenOrdner, 'proxy-verbrauch.json');

let verkehr = { seit: Date.now(), rein: 0, raus: 0, verbindungen: 0, jeZiel: {} };
let verkehrGeaendert = false;
let verkehrGeladen = false;

async function ladeVerkehr() {
  if (verkehrGeladen) return;
  verkehrGeladen = true;
  try {
    const roh = await readFile(VERBRAUCH_DATEI, 'utf8');
    const d = JSON.parse(roh.replace(/^﻿/, ''));
    if (d && typeof d.rein === 'number') verkehr = { jeZiel: {}, ...d };
  } catch {
    /* noch nichts gezaehlt */
  }
}

async function sichereVerkehr() {
  if (!verkehrGeaendert) return;
  verkehrGeaendert = false;
  try {
    await mkdir(datenOrdner, { recursive: true });
    await writeFile(VERBRAUCH_DATEI, JSON.stringify(verkehr, null, 1), 'utf8');
  } catch {
    /* dann eben nur fuer diese Sitzung */
  }
}

function zaehle(zielHost, richtung, anzahl) {
  if (!anzahl) return;
  verkehr[richtung] += anzahl;
  const z = (verkehr.jeZiel[zielHost] ||= { rein: 0, raus: 0, verbindungen: 0 });
  z[richtung] += anzahl;
  verkehrGeaendert = true;
}

/** Nur, was durch einen Proxy ging: direkte Verbindungen zählen nicht mit. */
function zaehleVerbindung(zielHost) {
  verkehr.verbindungen++;
  (verkehr.jeZiel[zielHost] ||= { rein: 0, raus: 0, verbindungen: 0 }).verbindungen++;
  verkehrGeaendert = true;
}

export function verkehrStand() {
  const jeZiel = Object.entries(verkehr.jeZiel)
    .map(([host, z]) => ({ host, ...z, gesamt: z.rein + z.raus }))
    .sort((a, b) => b.gesamt - a.gesamt);
  return {
    seit: verkehr.seit,
    rein: verkehr.rein,
    raus: verkehr.raus,
    gesamt: verkehr.rein + verkehr.raus,
    verbindungen: verkehr.verbindungen,
    jeZiel,
  };
}

export async function setzeVerkehrZurueck() {
  verkehr = { seit: Date.now(), rein: 0, raus: 0, verbindungen: 0, jeZiel: {} };
  verkehrGeaendert = true;
  await sichereVerkehr();
  return verkehrStand();
}

/**
 * Die zuletzt gemessene Ausgangsadresse.
 *
 * Die kann die Weiche nicht selbst sehen, sie tunnelt ja nur. Sie kommt aus
 * der Prüfung und wird hier gehalten, damit die Anzeige eine Zahl zeigen
 * kann, die jemandem etwas sagt.
 */
let letzterAusgang = null;

function gewaehlterProxy(k) {
  if (!k?.liste?.length || k.gewaehlt == null) return null;
  return zerlegeProxy(k.liste[k.gewaehlt]);
}

function aktualisiereWeiche() {
  zuordnung = new Map();
  fuerAlle = null;
  const e = einstellungen;
  if (!e || e.modus === 'aus') return;

  if (e.modus === 'allgemein') {
    fuerAlle = gewaehlterProxy(e.allgemein);
    return;
  }
  for (const [host, k] of Object.entries(e.hosts)) {
    const p = gewaehlterProxy(k);
    if (p) zuordnung.set(host.toLowerCase(), p);
  }
}

/** Findet den Proxy für ein Ziel, auch für Unterdomänen. */
function proxyFuer(zielHost) {
  if (fuerAlle) return fuerAlle;
  const h = String(zielHost || '').toLowerCase();
  if (zuordnung.has(h)) return zuordnung.get(h);
  // www.sixt.fr eingestellt, Anfrage geht an bilder.sixt.fr: dieselbe
  // Laenderseite, derselbe Weg.
  for (const [eingestellt, p] of zuordnung) {
    const kern = eingestellt.replace(/^www\./, '');
    if (h === kern || h.endsWith('.' + kern)) return p;
  }
  return null;
}

/** Läuft überhaupt eine Zuordnung? Dann braucht Chrome die Weiche. */
export function weicheGebraucht() {
  return Boolean(fuerAlle) || zuordnung.size > 0;
}

export function weicheAdresse() {
  return weichenPort ? `127.0.0.1:${weichenPort}` : null;
}

/**
 * Die Weiche starten. Chrome bekommt sie als einzigen Proxy genannt.
 */
let verkehrTakt = null;

export async function starteWeiche() {
  await laden();
  await ladeVerkehr();
  aktualisiereWeiche();
  if (weiche) return weichenPort;

  // Nicht bei jedem Datenstueck schreiben, das waere bei einem Abruf mit
  // Bildern ein paar tausend Schreibvorgaenge. Alle halbe Minute genuegt,
  // beim Beenden wird ohnehin gesichert.
  verkehrTakt = setInterval(() => sichereVerkehr(), 30000);
  verkehrTakt.unref?.();

  weiche = createServer();

  weiche.on('connect', (req, klient, kopfRest) => {
    const [zielHost, zielPortRoh] = String(req.url).split(':');
    const zielPort = Number(zielPortRoh) || 443;
    const p = proxyFuer(zielHost);

    // JEDE Steckdose braucht einen Fehlerzuhoerer. Ohne den reisst ein
    // abgerissener Tunnel (ECONNRESET, und davon gibt es beim Surfen staendig
    // welche) den ganzen Dienst mit. Genau so ist er beim ersten Versuch
    // gestorben.
    klient.on('error', () => {});

    let fertig = false;
    const scheitern = (grund) => {
      if (fertig) return;
      fertig = true;
      try {
        klient.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        /* Gegenstelle schon weg */
      }
      klient.destroy();
      if (p) console.log(`  ! Proxy für ${zielHost}: ${grund}`);
    };

    if (!p) {
      // Nichts eingestellt: ohne Umweg hinaus.
      const direkt = connect(zielPort, zielHost, () => {
        fertig = true;
        klient.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (kopfRest?.length) direkt.write(kopfRest);
        direkt.pipe(klient);
        klient.pipe(direkt);
      });
      direkt.on('error', () => scheitern('direkt nicht erreichbar'));
      klient.on('close', () => direkt.destroy());
      return;
    }

    const oben = connect(p.port, p.host);
    oben.setTimeout(20000, () => {
      oben.destroy();
      scheitern('Zeitüberschreitung');
    });
    oben.on('error', (e) => scheitern(e.code || e.message));
    klient.on('close', () => oben.destroy());

    oben.on('connect', () => oben.write(connectKopf(p, zielHost, zielPort)));

    let kopf = '';
    oben.on('data', function antwort(d) {
      kopf += d.toString('latin1');
      const schluss = kopf.indexOf('\r\n\r\n');
      if (schluss < 0) return;
      oben.off('data', antwort);
      const status = Number((kopf.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      if (status !== 200) {
        return scheitern(status === 407 ? 'Zugangsdaten abgelehnt' : `Tunnel abgelehnt (${status || '?'})`);
      }
      oben.setTimeout(0);
      fertig = true;
      merkeBenutzt(p);
      zaehleVerbindung(zielHost);
      klient.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Was der Proxy nach dem Kopf schon mitgeschickt hat, gehört dem Klienten.
      const rest = Buffer.from(kopf.slice(schluss + 4), 'latin1');
      if (rest.length) {
        zaehle(zielHost, 'rein', rest.length);
        klient.write(rest);
      }
      if (kopfRest?.length) {
        zaehle(zielHost, 'raus', kopfRest.length);
        oben.write(kopfRest);
      }
      // Mitzaehlen, bevor weitergeleitet wird. Ein zusaetzlicher Zuhoerer auf
      // "data" verbraucht nichts, er sieht dieselben Stuecke wie die
      // Weiterleitung darunter.
      oben.on('data', (d) => zaehle(zielHost, 'rein', d.length));
      klient.on('data', (d) => zaehle(zielHost, 'raus', d.length));
      oben.pipe(klient);
      klient.pipe(oben);
    });
  });

  // Reines HTTP kommt bei Sixt praktisch nicht vor, aber Chrome fragt
  // nebenbei anderes ab. Ohne diese Behandlung liefe das ins Leere.
  weiche.on('request', (req, res) => {
    res.writeHead(501, { 'content-type': 'text/plain' });
    res.end('Diese Weiche vermittelt nur verschluesselte Verbindungen.');
  });

  // Auch der Server selbst darf an einer abgerissenen Verbindung nicht
  // sterben.
  weiche.on('clientError', (_e, s) => s.destroy());
  weiche.on('error', (e) => console.log('  ! Proxy-Weiche: ' + e.message));

  await new Promise((fertig, scheitert) => {
    weiche.once('error', scheitert);
    weiche.listen(0, '127.0.0.1', fertig);
  });
  weichenPort = weiche.address().port;
  console.log(`  ⇄ Proxy-Weiche auf 127.0.0.1:${weichenPort}`);
  return weichenPort;
}

export async function stoppeWeiche() {
  if (verkehrTakt) {
    clearInterval(verkehrTakt);
    verkehrTakt = null;
  }
  // Zuletzt Gezaehltes festhalten, sonst faellt der Verbrauch der laufenden
  // Sitzung unter den Tisch.
  await sichereVerkehr();
  if (!weiche) return;
  await new Promise((f) => weiche.close(f));
  weiche = null;
  weichenPort = null;
}
