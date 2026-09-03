/**
 * Lokaler Dienst: liefert die Oberflaeche aus und nimmt die von der
 * Erweiterung gelesenen Preise entgegen.
 *
 *   node tools/serve.mjs [port]
 *
 * Ohne diesen Dienst funktioniert das Tool weiterhin, dann eben als reiner
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
import { quoteSchutz, waehleSchutzpaket, kasseLebt } from './scrape/sixt-schutz.mjs';
import { findBrowser, closeBrowser, frischesProfil } from './browser.mjs';
import * as buchung from './buchung.mjs';
import { hintergrundStand, setzeHintergrund } from './hintergrund.mjs';
import {
  proxyStand,
  proxyLive,
  verkehrStand,
  setzeVerkehrZurueck,
  setzeListe,
  setzeModus,
  loescheListe,
  pruefeListe,
  starteWeiche,
  stoppeWeiche,
  weicheGebraucht,
  wechsleProxy,
  setzeLagemelder,
} from './proxy.mjs';
import { merkeAngebote, bekannteKlassen, katalogStand } from './katalog.mjs';
import { istExe, quellWurzel, datenOrdner, leseVorrat } from './pfade.mjs';
import { oeffneFenster } from './fenster.mjs';
import { protokolliereNach, protokollPfad, zeigeMeldung, meldungenStehen } from './meldung.mjs';
import {
  merkeAbruf,
  leseVerlauf,
  verlaufUebersicht,
  verlaufGroesse,
  duenneAus,
} from './beobachtung.mjs';
import {
  alleWecker,
  legeWecker,
  loescheWecker,
  quittiereWecker,
  faelligeWecker,
  vermerkePruefung,
} from './wecker.mjs';

const argumente = process.argv.slice(2);
// Den Port aus dem ersten Zahlenargument holen, nicht aus argv[2], sonst
// verschiebt ein vorangestellter Schalter ihn. PORT aus der Umgebung kommt
// danach: Werkzeuge, die den Dienst starten, teilen ihn so zu, ohne dass am
// Aufruf etwas geaendert werden muss.
const port =
  Number(argumente.find((a) => /^\d+$/.test(a))) || Number(process.env.PORT) || 4173;
/** Kein Fenster aufmachen, fuer Pruefläufe und stille Starts. */
const stillerStart = argumente.includes('--kein-browser');

/**
 * Eine einzelne Weckerrunde laufen lassen und sich danach beenden.
 *
 * Das ist die Betriebsart fuer die Windows-Aufgabenplanung. Bis hierher pruefte
 * der Wecker nur, solange das Programm offen war, und damit war sein Zweck
 * verfehlt: wer eine Buchung beobachten laesst, hat TRACKER gerade nicht auf.
 *
 * Kein Port, kein Fenster, kein Dauerlauf. Alle vorhandenen Sicherungen
 * greifen unveraendert weiter, vor allem der Mindestabstand von sechs Stunden
 * je Wecker aus faelligeWecker().
 */
const nurWeckerRunde = argumente.includes('--wecker-einmal');

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

/**
 * Die eigene Versionsnummer, einzige Quelle ist package.json.
 *
 * In der EXE liegt sie als eingebetteter Vorrat bei (siehe build-exe.mjs),
 * aus dem Quellbaum wird die Datei gelesen. Gebraucht wird sie an genau einer
 * Stelle, und die ist wichtiger, als sie klingt: startet jemand eine neu
 * heruntergeladene Fassung, waehrend die alte noch laeuft, muss er erfahren,
 * dass er weiterhin die alte vor sich hat.
 */
let VERSION = '';
async function leseVersion() {
  try {
    VERSION = JSON.parse((await leseVorrat('package.json')).toString('utf8')).version || '';
  } catch {
    VERSION = '';
  }
  return VERSION;
}

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
 * bedienbar bleibt. Wie viele Abrufe gleichzeitig laufen, regelt sich selbst,
 * siehe unten. Der Mindestabstand je Host in browser.mjs bleibt davon
 * unberuehrt: er ist die Hoeflichkeitsgrenze und wird nicht angetastet.
 */
const queue = [];
let laufend = 0;
let erledigt = 0;
let gesamt = 0;

/* --------------------------------------------- Wie viele auf einmal?
 *
 * Feste Zahl geht nicht: gemessen vertrug ein kraeftiger Rechner sechs
 * gleichzeitige Abrufe (12 Abrufe in 17,6s statt 23,4s bei vier), waehrend auf
 * einem schwaecheren Geraet die Zeit je Abruf schneller steigt und die
 * Saettigung frueher kommt. Zwei zu nehmen, weil es ueberall geht, verschenkt
 * auf dem einen die Haelfte; sechs zu nehmen, weil es hier geht, koennte den
 * anderen ueberladen.
 *
 * Deshalb faengt es klein an und tastet sich hoch, solange der Durchsatz
 * dabei steigt. Faellt er, geht es einen Schritt zurueck und bleibt dort.
 *
 * Die Obergrenze ist nicht willkuerlich: bei sechs lag der Durchsatz bei
 * einem Abruf je 1,47 Sekunden, und MIN_GAP_MS in browser.mjs laesst je Host
 * ohnehin nur einen alle 1,5 Sekunden zu. Mehr Arbeiter warten dann bloss
 * gemeinsam. Gemessen brachte acht denn auch nichts mehr gegenueber sechs.
 */
const PARALLEL_MIN = 2;
const PARALLEL_MAX = 6;

/**
 * Mit Proxy gilt eine engere Grenze, und zwar aus einem anderen Grund als oben.
 *
 * Ohne Proxy verteilen sich die Verbindungen ueber Sixts eigene Server. Mit
 * Proxy laufen ALLE durch ein einziges Gateway, und das ist dann der Engpass,
 * nicht der eigene Rechner. Gemessen mit Proxy und zugleich geleertem Profil,
 * also ohne alles im Zwischenspeicher: bei drei gleichzeitigen Abrufen
 * brauchten sechs Kalendertage zehn Anlaeufe, vier davon scheiterten mit
 * "Station wurde nicht uebernommen". Die Seite war schlicht nicht rechtzeitig
 * fertig aufgebaut.
 *
 * Der Selbstregler haette das auch bemerkt, aber erst nach den Fehlversuchen.
 * Also gar nicht erst hochtasten, solange ein Proxy im Spiel ist.
 */
const PARALLEL_MAX_PROXY = 2;
let parallel = PARALLEL_MIN;

/** Die letzten Abrufdauern, jüngste zuerst. */
let dauern = [];
/** Bester bisher gesehener Mittelwert, der Massstab fuer "wird es schlechter?". */
let besteDauer = null;

function mittelwert(werte) {
  if (!werte.length) return null;
  return werte.reduce((a, b) => a + b, 0) / werte.length;
}

/**
 * Nach jedem Abruf nachjustieren.
 *
 * Bewusst traege: erst ab vier Messungen, und nur um einen Schritt. Ein
 * Regler, der bei jedem Ausreisser springt, pendelt und wird dadurch
 * langsamer als eine feste Zahl.
 */
function regleParallel(dauerMs) {
  dauern.unshift(dauerMs);
  if (dauern.length > 6) dauern.pop();
  if (dauern.length < 4) return;

  const jetzt = mittelwert(dauern.slice(0, 4));
  if (besteDauer == null || jetzt < besteDauer) besteDauer = jetzt;

  // Deutlich langsamer als im besten Fall: einen Schritt zurueck. Der Faktor
  // ist grosszuegig, weil die Zeit je Abruf mit mehr Arbeitern natuerlich
  // steigt, entscheidend ist der Durchsatz, nicht der einzelne Abruf.
  if (jetzt > besteDauer * 2.2 && parallel > PARALLEL_MIN) {
    parallel--;
    dauern = [];
    console.log(`  ⇣ ${parallel} gleichzeitig, es wurde langsamer`);
    return;
  }

  // Laeuft es rund und wartet genug Arbeit, einen Schritt hoch.
  if (jetzt < besteDauer * 1.5 && parallel < obergrenze() && queue.length > parallel) {
    parallel++;
    dauern = [];
    console.log(`  ⇡ ${parallel} gleichzeitig`);
  }
}

/** Vor einem neuen Durchlauf wieder klein anfangen. */
/** Wie weit darf sich der Regler hochtasten? Mit Proxy weniger weit. */
function obergrenze() {
  return weicheGebraucht() ? PARALLEL_MAX_PROXY : PARALLEL_MAX;
}

function setzeParallelZurueck() {
  parallel = Math.min(PARALLEL_MIN, obergrenze());
  dauern = [];
  besteDauer = null;
}

const ABRUF = { sixt: quoteSixt };
const SCHUTZ_ABRUF = { sixt: quoteSchutz };

/**
 * Erlaubte Zieladressen.
 *
 * Der Host aus einem Auftrag landet ungeprueft in einer Adresse, die der
 * Dienst dann im Browser oeffnet. Ohne diese Liste koennte jede Seite, die im
 * Browser offen ist, den Dienst ueber /api/fetch dazu bringen, eine beliebige
 * Adresse aufzurufen, auch im Heimnetz, etwa die Weboberflaeche des Routers.
 * Deshalb: nur die Laenderseiten, die im Anbieterregister stehen.
 *
 * Die Liste wird einmal aus src/providers.js gelesen, damit sie nicht an zwei
 * Stellen gepflegt werden muss und nicht auseinanderlaufen kann.
 */
let erlaubteHosts = null;

async function hostErlaubt(host) {
  if (!erlaubteHosts) {
    erlaubteHosts = new Set();
    try {
      const roh = (await leseVorrat('src/providers.js'))?.toString('utf8') || '';
      for (const t of roh.matchAll(/host:\s*'([^']+)'/g)) erlaubteHosts.add(t[1]);
    } catch {
      /* unten abgefangen */
    }
    // Aus der EXE heraus gibt es keine Quelldatei; dann kommt die Liste aus
    // dem gebauten Bundle, in dem dieselben Zeilen stehen.
    if (!erlaubteHosts.size) {
      const roh = (await leseVorrat('dist/mietwagen-preistool.html'))?.toString('utf8') || '';
      for (const t of roh.matchAll(/host:\s*"([^"]+\.sixt\.[^"]+|[^"]*sixt\.com[^"]*)"/g)) {
        erlaubteHosts.add(t[1]);
      }
      for (const t of roh.matchAll(/host:\s*'([^']+)'/g)) erlaubteHosts.add(t[1]);
    }
  }
  return erlaubteHosts.has(String(host));
}

async function enqueue(jobs) {
  // Ein Abruf ohne Cookies faengt mit einem leeren Profil an, sonst waere
  // nur der allererste wirklich einer. Aber nur, wenn gerade nichts laeuft:
  // mitten im Durchlauf das Chrome zu beenden, risse die offenen Abrufe ab.
  if (queue.length === 0 && laufend === 0 && jobs.some((j) => j?.inkognito)) {
    // Das Profil zu leeren beendet das Chrome darauf, und damit stirbt jede
    // offengehaltene Kassenseite. Sie vorher geordnet zu schliessen ist
    // sauberer, als sie hinterher als Leiche in der Verwaltung zu finden.
    await buchung.schliesseAlle('Profil wird geleert').catch(() => {});
    const leer = await frischesProfil();
    console.log(
      leer
        ? '  ⌾ Ohne Cookies: Profil geleert'
        : '  ! Ohne Cookies: Profil ließ sich nicht ganz leeren. Chrome hält noch Dateien'
    );
  }

  let abgelehnt = 0;
  for (const j of jobs) {
    if (!j?.key || results.has(j.key)) continue;
    if (queue.some((q) => q.key === j.key)) continue;
    if (!(await hostErlaubt(j.host))) {
      abgelehnt++;
      continue;
    }
    queue.push(j);
    gesamt++;
  }
  if (abgelehnt) console.log(`  ! ${abgelehnt} Auftraege mit unbekanntem Ziel abgelehnt`);
  for (let i = laufend; i < parallel; i++) tick();
}

/**
 * Mindestabstand zwischen zwei Startvorgaengen.
 *
 * browser.mjs bremst je Host, bei einem Rundumschlag ueber dreissig
 * verschiedene Laenderseiten greift das nie, weil jeder Host nur einmal
 * drankommt. Der Abruf lief dadurch dauerhaft mit zwei parallelen Zugriffen
 * auf Sixt, und im Test stiegen dabei reihenweise Seiten mit "Station wurde
 * nicht uebernommen" aus, einzeln aufgerufen liefen dieselben Seiten
 * einwandfrei. Eine dreiviertel Sekunde Abstand kostet bei dreissig Seiten
 * gut zehn Sekunden und erspart das Nachfassen.
 */
const START_ABSTAND_MS = 750;
let letzterStart = 0;

/**
 * Grund einer Fehlmeldung in eine verständliche Ursache übersetzen.
 *
 * Die Rohmeldungen sind für den Nutzer wertlos ("locator.click: Timeout
 * 12000ms exceeded"). Wichtig ist die Frage dahinter: liegt es an dieser
 * Länderseite, an der Verbindung, oder war es Zufall und ein zweiter Versuch
 * hilft? Genau das entscheidet auch, ob nachgefasst wird.
 *
 * `nochmal: false` heisst: wiederholen bringt nichts. Tschechien und die
 * Türkei nehmen eine deutsche Station gar nicht erst an, gemessen, vier von
 * vier Versuchen. Da noch dreimal anzuklopfen kostet nur Zeit.
 */
function deuteFehler(text) {
  const t = String(text || '');
  // Zuerst der Proxy: dieselbe Meldung darf nicht als "Verbindung weg"
  // durchgehen, denn hier ist nicht das Netz kaputt, sondern der eingestellte
  // Weg. Wer das nicht erfaehrt, sucht den Fehler bei Sixt.
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_AUTH/i.test(t)) {
    return {
      code: 'PROXY',
      klartext: 'Der eingestellte Proxy war nicht erreichbar.',
      rat: 'Unter Einstellungen die Proxys erneut prüfen, oder den Proxy abschalten.',
      nochmal: false,
    };
  }
  if (/access denied|blocked|blockiert/i.test(t)) {
    return {
      code: 'ZUGRIFF',
      klartext: 'Die Länderseite hat den Zugriff abgewiesen.',
      rat: 'Ein paar Minuten warten und weniger Länderseiten auf einmal abfragen.',
      nochmal: true,
    };
  }
  if (/station wurde nicht übernommen/i.test(t)) {
    return {
      code: 'STATION',
      klartext: 'Die Länderseite hat die Station nicht übernommen.',
      rat: 'Meist bedient diese Seite nur ihre eigene Region. Kommt es nur gelegentlich, war die Seite zu langsam.',
      nochmal: true,
    };
  }
  if (/trefferliste kam nicht/i.test(t)) {
    return {
      code: 'KEINE_LISTE',
      klartext: 'Die Suche lief, aber es kam keine Trefferliste.',
      rat: 'Entweder ist für den Zeitraum dort nichts frei, oder Sixt hat den Seitenaufbau geändert.',
      nochmal: true,
    };
  }
  if (/ERR_CERT|ERR_NAME|ERR_CONNECTION|ENOTFOUND|EAI_AGAIN/i.test(t)) {
    return {
      code: 'NETZ',
      klartext: 'Die Adresse war nicht erreichbar.',
      rat: 'Entweder gibt es dort keine Länderseite mehr, oder die Internetverbindung streikt.',
      nochmal: false,
    };
  }
  if (/timeout|timed out|zeit/i.test(t)) {
    return {
      code: 'ZEIT',
      klartext: 'Die Seite hat zu lange gebraucht.',
      rat: 'Bei vielen Länderseiten gleichzeitig kommt das vor, nachfassen hilft meist.',
      nochmal: true,
    };
  }
  return { code: 'UNBEKANNT', klartext: t.slice(0, 160), rat: null, nochmal: true };
}

/** So oft wird ein gescheiterter Abruf von selbst wiederholt. */
const VERSUCHE_MAX = 3;

/**
 * Wie lange ein einzelner Auftrag hoechstens laufen darf.
 *
 * Grosszuegig bemessen: gemessen dauert ein Abruf mit Proxy und ohne Cookies
 * rund fuenf Sekunden, der langsamste gemessene Einzelfall 25. Drei Minuten
 * sind also weit jenseits von allem Normalen und greifen nur, wenn wirklich
 * etwas haengt.
 */
const JOB_FRIST_MS = 180000;

/**
 * Was gerade passiert, fuer die Oberflaeche.
 *
 * Ein Fortschrittsbalken sagt nur "3 von 84". Wenn es dann stockt, weiss
 * niemand, ob etwas kaputt ist oder ob im Hintergrund gerade nachgefasst
 * wird. Deshalb hier die letzten Ereignisse im Klartext, mit Zeitstempel.
 */
const LAGE_MAX = 12;
const lage = [];

function merkeLage(art, text) {
  // Dieselbe Meldung nicht mehrfach. Ein Proxyausfall trifft alle Verbindungen
  // einer Seite gleichzeitig, und ungefiltert stand die Zeile fuenfmal
  // untereinander, mit derselben Uhrzeit. Das sieht nach fuenf Problemen aus
  // und ist eines.
  const gleich = lage.find((e) => e.text === text && Date.now() - e.zeit < 30000);
  if (gleich) {
    gleich.zeit = Date.now();
    gleich.wieOft = (gleich.wieOft || 1) + 1;
    return;
  }
  lage.unshift({ zeit: Date.now(), art, text });
  if (lage.length > LAGE_MAX) lage.pop();
}

/**
 * Was einem Menschen ueber einen Fehler zu sagen ist.
 *
 * NICHT der Rohtext. `deuteFehler` gibt bei einem unbekannten Fehler die
 * Meldung der Bibliothek zurueck, und die sieht so aus:
 *   "page.goto: Target page, context or browser has been closed Call log:
 *    [2m - navigating to \"https://www.sixt.de/?uci=4485&rci=..."
 * Steuerzeichen, Aufrufprotokoll, eine halbe URL. In einer Statuszeile ist
 * das schlimmer als gar nichts. Der Rohtext bleibt im Protokoll und in der
 * Tabellenzelle, hier steht ein Satz.
 */
function lagesatz(d) {
  if (d.code === 'UNBEKANNT') return 'Ein unerwarteter Fehler, Einzelheiten stehen im Protokoll.';
  return d.klartext;
}

/**
 * Was nach einem gescheiterten Abruf geschieht.
 *
 * EINE Stelle fuer beide Wege, und das ist der Punkt: ein Abruf kann
 * scheitern, indem er einen Fehler ZURUECKGIBT (Station nicht uebernommen)
 * oder indem er einen WIRFT (page.goto bei ERR_PROXY_CONNECTION_FAILED).
 * Frueher hatte jeder Weg seine eigene Behandlung, und der Proxywechsel hing
 * nur am ersten: gemessen wurde bei einem toten Proxy deshalb nie
 * gewechselt, obwohl acht gepruefte Ersatzeintraege bereitlagen.
 *
 * @returns {Promise<boolean>} true, wenn der Auftrag erneut eingereiht wurde
 */
async function behandleFehler(job, roh) {
  const d = deuteFehler(roh);

  // Transportfehler am Proxy: auf den naechsten geprueften ausweichen.
  // Das ist Ausfallsicherheit. Bei einer Zurueckweisung durch die
  // Laenderseite (ZUGRIFF) geschieht das ausdruecklich NICHT, siehe
  // wechsleProxy in proxy.mjs.
  if (d.code === 'PROXY' && weicheGebraucht() && (job.proxyWechsel || 0) < 2) {
    const neu = await wechsleProxy(job.host).catch(() => null);
    if (neu) {
      job.proxyWechsel = (job.proxyWechsel || 0) + 1;
      // BEWUSST OHNE Chrome-Neustart. Die Adresse der Weiche bleibt dieselbe,
      // nur ihre innere Zuordnung wechselt; die naechste Verbindung nimmt
      // schon den neuen Weg. Ein Neustart riss dagegen die gerade laufenden
      // Nachbarabrufe mit ("Target page, context or browser has been closed"),
      // die dann unnoetig wiederholt werden mussten.
      const text = `Proxy war nicht erreichbar. Gewechselt auf ${neu.ip}, der Abruf läuft weiter.`;
      console.log(`  ⇄ ${text}`);
      merkeLage('proxy', text);
      queue.push(job);
      gesamt++;
      return true;
    }
    merkeLage('aufgegeben', 'Der Proxy ist nicht erreichbar, und es gibt keinen geprüften Ersatz. Unter Einstellungen erneut prüfen.');
    return false;
  }

  if ((job.versuch || 1) < VERSUCHE_MAX && d.nochmal) {
    job.versuch = (job.versuch || 1) + 1;
    // Ans Ende der Schlange: erst kommen die anderen Länderseiten dran, dann
    // der zweite Anlauf. Das gibt der Seite Zeit und hält den Fortschritt in
    // Bewegung.
    queue.push(job);
    gesamt++;
    console.log(`  ↻ ${job.host}  ${d.code}. Versuch ${job.versuch} von ${VERSUCHE_MAX}`);
    merkeLage(
      'wiederholung',
      `${job.host.replace(/^www\./, '')}: ${lagesatz(d)} Versuch ${job.versuch} von ${VERSUCHE_MAX}.`
    );
    return true;
  }

  merkeLage('aufgegeben', `${job.host.replace(/^www\./, '')}: ${lagesatz(d)} ${d.rat || ''}`.trim());
  return false;
}

async function tick() {
  if (laufend >= parallel) return;
  const job = queue.shift();
  if (!job) {
    // Nichts mehr zu tun: Zaehler zuruecksetzen, damit der naechste Lauf
    // wieder bei 0 anfaengt.
    if (laufend === 0) {
      erledigt = 0;
      gesamt = 0;
      // Auch den Regler: der naechste Lauf kann ein ganz anderer sein, eine
      // Laenderseite statt fuenfzig Kalendertagen.
      setzeParallelZurueck();
    }
    return;
  }

  laufend++;
  const begonnen = Date.now();
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
        (schutz ? `  Schutz ${job.acriss}` : `  ${job.pickupDate}`) +
        (job.inkognito ? '  ohne Cookies' : '')
    );

    // Wachhund. Die einzelnen Schritte im Abruf haben zwar eigene Zeitlimits,
    // aber sie summieren sich, und ein Schritt ohne Limit (page.evaluate hat
    // keins) koennte einen Auftrag fuer immer festhalten. Dann stuende die
    // Warteschlange still und in der Oberflaeche passierte scheinbar nichts.
    // Nach dieser Frist gilt der Auftrag als gescheitert und wird wiederholt.
    const res = await Promise.race([
      abruf(job),
      new Promise((f) =>
        setTimeout(() => f({ ok: false, error: 'Zeitlimit für den ganzen Abruf erreicht' }), JOB_FRIST_MS)
      ),
    ]);

    if (schutz) {
      // Kassenseite offen halten, wenn der Abruf eine mitgebracht hat. Ab hier
      // gehoert sie der Verwaltung in buchung.mjs, die sie auch wieder zumacht.
      if (res.kasse) {
        await buchung
          .merke({
            schluessel: job.key,
            host: job.host,
            acriss: job.acriss,
            inkognito: Boolean(job.inkognito),
            page: res.kasse.page,
            windowId: res.kasse.windowId,
            pakete: (res.pakete || []).map((p) => ({ name: p.name, i: p.i, gesamt: p.gesamt })),
            mieteOhneSchutz: res.mieteOhneSchutz ?? null,
          })
          .catch((e) => console.log('  ! Kassenseite ließ sich nicht merken: ' + e.message));
      }
      remember(job.key, {
        host: job.host,
        url: res.url || null,
        acriss: job.acriss,
        // Damit die Oberflaeche weiss, auf welche Zellen man klicken kann.
        kasse: Boolean(res.kasse),
        // Nur als verfuegbar merken, wenn der Abruf auch geklappt hat.
        // Vorher galt ein gescheiterter Abruf als verfuegbar, weil
        // `undefined !== false` wahr ist, die Oberflaeche zeigte dann ein
        // nichtssagendes "–" statt der Fehlermeldung.
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

    // Gescheitert? Dann nicht gleich aufgeben, aber auch nicht stur
    // wiederholen, wo es nachweislich nichts bringt.
    if (res.error && (await behandleFehler(job, res.error))) return;

    const gedeutet = res.error ? deuteFehler(res.error) : null;
    remember(job.key, {
      host: job.host,
      url: res.url || null,
      station: res.station || null,
      offers: res.offers || [],
      error: res.error || null,
      // Damit die Oberflaeche sagen kann, woran es lag, statt nur dass es
      // schieflief.
      fehlerCode: gedeutet?.code || null,
      fehlerKlartext: gedeutet?.klartext || null,
      fehlerRat: gedeutet?.rat || null,
      versuche: job.versuch || 1,
      warnung: res.warnung || null,
      // "Nichts im Angebot" ist kein Fehler, sondern eine Antwort. Ohne diese
      // Notiz saehe der Tag in der Oberflaeche aus wie ein misslungener Abruf.
      note: res.note || null,
    });
    if (res.warnung) console.log(`  ! ${job.host}  ${res.warnung}`);

    // Gesehene Klassen dauerhaft merken, damit spaeter "gerade nicht buchbar"
    // von "gibt es dort nicht" unterscheidbar bleibt.
    if (res.offers?.length) await merkeAngebote(job, res.offers).catch(() => {});
    // Und den Preis fuer die Kurve, jeder Abruf ist ein Messpunkt.
    await merkeAbruf(job, res).catch(() => {});

    const n = res.offers?.length ?? 0;
    console.log(
      `  ← ${job.host}  ${res.error ? 'Fehler: ' + res.error : n ? n + ' Angebote' : res.note || '0 Angebote'}` +
        (res.ms ? `  (${(res.ms / 1000).toFixed(1)}s)` : '')
    );
  } catch (e) {
    const roh = String(e.message).slice(0, 160);
    const d = deuteFehler(roh);
    // Dieselbe Behandlung wie beim zurueckgegebenen Fehler. Genau hier fehlte
    // sie: ein toter Proxy wirft eine Ausnahme, und der Wechsel hing bis 1.5.2
    // nur am anderen Weg.
    if (await behandleFehler(job, roh)) return;
    remember(job.key, {
      host: job.host,
      offers: [],
      error: roh,
      fehlerCode: d.code,
      fehlerKlartext: d.klartext,
      fehlerRat: d.rat,
      versuche: job.versuch || 1,
    });
    console.log(`  ← ${job.host}  ${d.code}: ${roh.slice(0, 110)}`);
  } finally {
    laufend--;
    erledigt++;
    regleParallel(Date.now() - begonnen);
    // So viele nachstarten, wie der Regler jetzt erlaubt, nach einem
    // Hochschalten sind das zwei statt einem, sonst bliebe die neue Stufe
    // bis zum naechsten Auftrag ungenutzt.
    for (let i = laufend; i < parallel; i++) tick();
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

/**
 * Darf diese Anfrage etwas veraendern?
 *
 * Der Dienst hoert nur auf 127.0.0.1, von aussen kommt niemand heran. Aber
 * jede Seite, die der Nutzer im Browser offen hat, kann an localhost senden.
 * Ohne Pruefung koennte eine beliebige Webseite dem Dienst Auftraege geben,
 * waehrend TRACKER laeuft.
 *
 * Erlaubt sind deshalb nur: die eigene Oberflaeche (gleicher Ursprung), die
 * Browser-Erweiterung (chrome-extension://) und Aufrufe ganz ohne Ursprung,
 * das sind Werkzeuge wie curl, die kein Browser sind und bei denen es keine
 * fremde Seite gibt, die jemanden hereinlegen koennte.
 */
function darfAendern(req) {
  const ursprung = req.headers.origin;
  if (!ursprung) return true;
  if (ursprung.startsWith('chrome-extension://') || ursprung.startsWith('moz-extension://')) {
    return true;
  }
  try {
    const u = new URL(ursprung);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch {
    return false;
  }
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
 * Faellige Wecker der Reihe nach nachpruefen, einzeln und nur, wenn sonst
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
      // Der Wecker ruft am Auftragsweg vorbei direkt ab, die Zielpruefung
      // muss er deshalb selbst machen. Ein Wecker mit fremdem Ziel waere
      // sonst eine Anweisung, die sich alle sechs Stunden wiederholt.
      if (!(await hostErlaubt(w.host))) {
        await vermerkePruefung(w.id, { fehler: 'Unbekannte Länderseite' }).catch(() => {});
        continue;
      }
      try {
        // Zur Uhrzeit des Weckers pruefen, nicht zu einer festen. Sonst
        // meldete er einen Preis, der zu einer anderen Abholzeit gehoert.
        const zeit = w.zeit || '10:00';
        const zeitRueck = w.zeitRueck || zeit;
        const r = await quoteSixt({
          host: w.host,
          stationCode: w.station,
          pickupDate: w.von,
          returnDate: w.bis,
          pickupTime: zeit,
          returnTime: zeitRueck,
          currency: w.waehrung || undefined,
        });
        // Die Uhrzeit gehoert auch in den Messpunkt, sonst faellt er in der
        // Kurve wieder mit den anderen Uhrzeiten zusammen.
        await merkeAbruf(
          {
            host: w.host,
            stationCode: w.station,
            pickupDate: w.von,
            returnDate: w.bis,
            pickupTime: zeit,
            returnTime: zeitRueck,
          },
          r
        ).catch(() => {});

        const treffer = (r.offers || []).find((o) => o.acriss === w.acriss && o.total != null);
        const loest = await vermerkePruefung(w.id, {
          preis: treffer?.total ?? null,
          fehler: r.error || (treffer ? null : 'Klasse gerade nicht im Angebot'),
        });

        if (loest) {
          const buchung = w.art === 'buchung';
          const gespart = buchung ? (w.gebucht - treffer.total).toFixed(2) : null;
          const text =
            `${w.stationName || 'Station ' + w.station}\n` +
            `${w.acriss} auf ${w.host.replace(/^www\./, '')}\n\n` +
            (buchung
              ? `${treffer.total} ${w.waehrung} statt gebuchter ${w.gebucht} ${w.waehrung}.\n` +
                `Das sind ${gespart} ${w.waehrung} weniger. Umbuchen prüfen.\n`
              : `${treffer.total} ${w.waehrung}, unter deiner Grenze von ${w.grenze}.\n`) +
            `${w.von} bis ${w.bis}`;
          console.log(
            `  ⏰ AUSGELÖST: ${w.acriss} ${treffer.total} ${w.waehrung}` +
              (buchung ? `  (${gespart} ${w.waehrung} unter der Buchung)` : '')
          );
          if (istExe) zeigeMeldung(text, buchung ? 'Buchung wurde billiger' : 'Preiswecker');
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
 * daran das Programmende haengt, beendet sich nach Sekunden von selbst,
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

/** So lange nach dem letzten Fenster gewartet wird, ein Neuladen dauert kürzer. */
const NACHFRIST_MS = 4000;

/** Ohne Lebenszeichen gilt ein Fenster nach dieser Zeit als abgestürzt. */
const STILLE_MS = 90_000;

let schliessTimer = null;

/**
 * Hat sich seit dem Start ueberhaupt schon einmal ein Fenster gemeldet?
 *
 * Ohne diese Frage schlaegt der Waechter beim Start zu: die Liste ist dann
 * leer, weil die Seite noch laedt, und vier Sekunden spaeter beendet sich
 * das Programm, waehrend der Vorspann noch laeuft. Genau das ist passiert.
 * Solange noch nie ein Fenster da war, wird nur die grosszuegige Startfrist
 * abgewartet; erst danach gilt "niemand da" als Grund zu gehen.
 */
let jeEinFenster = false;
const gestartetUm = Date.now();
const STARTFRIST_MS = 120_000;
/** Ein neuer Start hat uebernommen: die Fenster sollen sich schliessen. */
let sollSchliessen = false;

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
    console.log('Letztes Fenster geschlossen. Programm beendet.');
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

  // Alles, was etwas veraendert oder anstoesst, nur vom eigenen Ursprung.
  // Lesende Abfragen bleiben offen, sie richten keinen Schaden an, und die
  // Erweiterung fragt aus dem Kontext der Anbieterseite.
  if (req.method === 'POST' && !darfAendern(req)) {
    console.log(`  ! Abgewiesen: POST ${path} von ${req.headers.origin}`);
    return json(res, 403, { ok: false, error: 'Nur von der eigenen Oberfläche.' });
  }

  // Lebenszeichen, die Oberflaeche schaltet daran den Preis-Modus frei.
  if (path === '/api/health') {
    return json(res, 200, {
      ok: true,
      service: 'mwt-preistool',
      version: VERSION,
      // Fuer die Uebernahme beim zweiten Doppelklick: laesst sich der laufende
      // Dienst nicht im Guten beenden, wird er ueber diese Nummer abgeraeumt.
      pid: process.pid,
      stored: results.size,
      // Ohne Chrome gibt es keinen automatischen Abruf; die Oberflaeche sagt
      // das dann statt es zu versuchen und stillschweigend zu scheitern.
      chrome: Boolean(findBrowser()),
      queue: { laufend, offen: queue.length, erledigt, gesamt },
      // Was zuletzt geschehen ist, im Klartext. Ein Fortschrittsbalken allein
      // laesst offen, ob es stockt oder ob im Hintergrund nachgefasst wird.
      lage,
    });
  }

  // Automatischer Preisabruf anstossen.
  /**
   * Platz machen fuer einen neuen Start.
   *
   * Wer eine neuere Fassung herunterlaedt und doppelt klickt, waehrend die
   * alte noch laeuft, sass vorher fest: der zweite Start reichte an die alte
   * weiter und beendete sich nach zweieinhalb Sekunden. Von aussen sah das
   * aus, als starte das Programm nicht.
   *
   * Zuerst antworten, dann aufraeumen, sonst wartet der neue Start auf eine
   * Antwort, die nicht mehr kommt. Und den Fenstern Bescheid geben, damit
   * nicht ein totes Fenster stehenbleibt: sie fragen ohnehin im Sekundentakt
   * bei /api/lebt nach.
   *
   * Die Frist ist ein Notnagel. Schliessen sich die Fenster von selbst, endet
   * das Programm vorher ueber den gewoehnlichen Weg (pruefeObNochWer).
   */
  if (path === '/api/beenden' && req.method === 'POST') {
    sollSchliessen = true;
    json(res, 200, { ok: true, pid: process.pid, version: VERSION });
    // Die Fenster merken es binnen zweieinhalb Sekunden und schliessen sich;
    // danach endet das Programm ohnehin ueber pruefeObNochWer. Diese Frist
    // ist nur der Notnagel, falls kein Fenster mehr antwortet.
    setTimeout(() => {
      console.log('Ein neuer Start übernimmt, dieser Dienst endet.');
      beenden(0);
    }, 4000);
    return;
  }

  if (path === '/api/fetch' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const jobs = Array.isArray(body.jobs) ? body.jobs : [];
      if (!findBrowser()) {
        return json(res, 200, {
          ok: false,
          error: 'Chrome wurde nicht gefunden, automatischer Abruf nicht möglich.',
        });
      }
      const vorher = queue.length + laufend;
      await enqueue(jobs);
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
        '# SIXT-Stationen. Format: id|land|iata|name',
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
      // Mit ?schlank=1 kommen nur die Anzahlen statt der vollen Klassen-,
      // Host- und Uhrzeitlisten. Das ist der weitaus groesste Teil der
      // Antwort, und gebraucht wird er erst, wenn eine Reise gewaehlt ist.
      const schlank = url.searchParams.get('schlank') === '1';
      return json(res, 200, {
        ok: true,
        gruppen: await verlaufUebersicht({ schlank }),
        groesse: await verlaufGroesse(),
      });
    } catch (e) {
      return json(res, 200, { ok: false, gruppen: [], error: String(e.message).slice(0, 160) });
    }
  }

  /**
   * Alte Messpunkte ausduennen.
   *
   * Ohne `bestaetigt: true` wird nur gezaehlt. Diese Daten sind muehsam
   * gesammelt und nicht wiederherstellbar; sie verschwinden nur, wenn jemand
   * gesehen hat, wie viel es waere, und dann ausdruecklich zustimmt.
   */
  if (path === '/api/verlauf/ausduennen' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const vorTagen = Number.isFinite(body.vorTagen) ? Math.max(0, body.vorTagen) : 30;
      const erg = await duenneAus({ vorTagen, nurZaehlen: body.bestaetigt !== true });
      if (erg.geschrieben) {
        console.log(`  ✂ Preisverlauf ausgedünnt: ${erg.entfernt} Punkte entfernt, ${erg.nachher} bleiben`);
      }
      return json(res, 200, { ok: true, ...erg });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 160) });
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
      const schwelle = body.art === 'buchung' ? Number(body.gebucht) : Number(body.grenze);
      if (!(schwelle > 0)) {
        return json(res, 400, {
          ok: false,
          error: body.art === 'buchung' ? 'Gebuchter Preis fehlt' : 'Preisgrenze fehlt',
        });
      }
      // Das Ziel schon beim Anlegen pruefen, nicht erst beim Abrufen.
      // weckerRunde() faengt ein unbekanntes Ziel zwar ab, aber bis dahin
      // stuende der Eintrag mit fremdem Inhalt in der Weckerdatei. Geprueft
      // wird an der Tuer.
      if (!(await hostErlaubt(body.host))) {
        return json(res, 400, { ok: false, error: 'Unbekannte Länderseite' });
      }
      const w = await legeWecker(body);
      console.log(
        `  ⏰ ${w.art === 'buchung' ? 'Buchung beobachten' : 'Wecker'}: ` +
          `${w.stationName} ${w.acriss} unter ${w.grenze} ${w.waehrung}`
      );
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
    // Von Hand angestossen, ohne Rücksicht auf den Mindestabstand.
    weckerRunde({ sofort: true }).catch(() => {});
    return json(res, 200, { ok: true });
  }

  // Selbsttest: geht die ganze Kette auf diesem Rechner durch?
  /* ---------------------------------------------------- Proxys je Länderseite */

  if (path === '/api/proxy' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...(await proxyStand()) });
  }

  // Nur der Live-Zustand, klein genug für einen kurzen Takt: woran hängt der
  // Abruf gerade, und wann hat er zuletzt gewechselt.
  if (path === '/api/proxy/live') {
    return json(res, 200, { ok: true, ...proxyLive() });
  }

  // Verbrauch, für die Einstellungen. Residential-Proxys werden nach
  // Gigabyte abgerechnet, deshalb ist das Kostenkontrolle und nicht Zierde.
  if (path === '/api/proxy/verbrauch' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...verkehrStand() });
  }
  if (path === '/api/proxy/verbrauch' && req.method === 'POST') {
    const stand = await setzeVerkehrZurueck();
    console.log('  ⇄ Proxy-Verbrauch zurückgesetzt');
    return json(res, 200, { ok: true, ...stand });
  }

  // Liste hinterlegen, entfernen, Betriebsart wechseln.
  if (path === '/api/proxy' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 5_000_000)) || '{}');

      if (body.modus) {
        const erg = await setzeModus(body.modus);
        // Chrome bekommt den Proxy als Startparameter. Nach einem Wechsel muss
        // es neu starten, sonst läuft der nächste Abruf noch über den alten
        // Weg und niemand merkt es.
        if (erg.ok && erg.neustartNoetig) {
          await closeBrowser().catch(() => {});
          console.log(`  ⇄ Proxy-Betriebsart: ${body.modus}, Chrome startet neu`);
        }
        return json(res, 200, { ...erg, ...(await proxyStand()) });
      }

      const ziel = body.ziel === 'allgemein' ? 'allgemein' : body.ziel;
      if (!ziel || (ziel !== 'allgemein' && !(await hostErlaubt(ziel)))) {
        return json(res, 400, { ok: false, error: 'Unbekanntes Ziel' });
      }
      if (body.loeschen) {
        await loescheListe(ziel);
        await closeBrowser().catch(() => {});
        console.log(`  ⇄ Proxys für ${ziel} entfernt`);
        return json(res, 200, { ok: true, ...(await proxyStand()) });
      }
      const erg = await setzeListe(ziel, body.liste);
      console.log(`  ⇄ ${erg.anzahl} Proxys für ${ziel} hinterlegt`);
      return json(res, 200, { ...erg, ...(await proxyStand()) });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  // Stichprobe prüfen und den schnellsten auswählen.
  if (path === '/api/proxy/test' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ziel = body.ziel === 'allgemein' ? 'allgemein' : body.ziel;
      if (!ziel) return json(res, 400, { ok: false, error: 'Ziel fehlt' });
      const erg = await pruefeListe(ziel, { anzahl: Number(body.anzahl) || 10 });
      // Der gewählte Proxy ändert die Startparameter von Chrome.
      if (erg.ok) await closeBrowser().catch(() => {});
      if (erg.ok) {
        console.log(
          `  ⇄ ${ziel}: ${erg.davonGut} von ${erg.geprueft} Proxys erreichbar` +
            (erg.schnellste ? `, schnellster ${erg.schnellste.ms} ms über ${erg.schnellste.ip}` : '')
        );
      }
      return json(res, 200, { ...erg, ...(await proxyStand()) });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  /* ---------------------------------------------------- Hintergrundprüfung */

  if (path === '/api/hintergrund' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...(await hintergrundStand()) });
  }

  if (path === '/api/hintergrund' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const erg = await setzeHintergrund(body.an === true, body.uhrzeit || '09:00');
      console.log(
        erg.ok
          ? `  ⏰ Hintergrundprüfung ${body.an ? 'eingeschaltet (' + (body.uhrzeit || '09:00') + ')' : 'abgeschaltet'}`
          : `  ! Hintergrundprüfung: ${erg.error}`
      );
      return json(res, 200, erg);
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  /* ---------------------------------------------------- Kassenseiten */

  // Welche Kassenseiten stehen noch offen? Die Oberflaeche fragt das ab, um
  // die anklickbaren Zellen zu kennen und die Restzeit anzuzeigen.
  if (path === '/api/buchung' && req.method === 'GET') {
    await buchung.raeumeAuf().catch(() => {});
    return json(res, 200, { ok: true, offen: buchung.liste() });
  }

  // Ein Paket auf der offengehaltenen Seite auswaehlen und das Fenster zeigen.
  if (path === '/api/buchung/oeffnen' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const begonnen = Date.now();

      const e = buchung.hole(body.key);
      if (!e) {
        return json(res, 200, { ok: false, grund: 'weg', error: 'Die Kassenseite ist nicht mehr offen.' });
      }
      if (!(await kasseLebt(e.page))) {
        await buchung.schliesse(body.key, 'Sitzung war hinüber');
        return json(res, 200, { ok: false, grund: 'weg', error: 'Die Sitzung bei Sixt ist abgelaufen.' });
      }

      const paket = e.pakete.find((p) => p.i === body.paket);
      if (!paket) return json(res, 400, { ok: false, error: 'Dieses Paket kennt die Seite nicht.' });

      const jetzt = await waehleSchutzpaket(e.page, paket.i).catch(() => null);
      const sichtbar = await buchung.zeige(body.key);
      console.log(
        `  ⇱ Kasse ${e.host} ${paket.name}` +
          (jetzt != null ? `  ${jetzt}` : '  Preis nicht lesbar') +
          `  (${Date.now() - begonnen}ms)`
      );

      // Der Preis wird zurueckgemeldet, nicht nur behauptet: weicht er vom
      // gemessenen ab, soll der Nutzer das sehen, bevor er bucht.
      return json(res, 200, {
        ok: true,
        sichtbar,
        paket: paket.name,
        gemessen: paket.gesamt ?? null,
        jetzt: jetzt ?? null,
        abweichung:
          jetzt != null && paket.gesamt != null ? Number((jetzt - paket.gesamt).toFixed(2)) : null,
      });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  if (path === '/api/buchung/verstecken' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
    return json(res, 200, { ok: await buchung.verstecke(body.key) });
  }

  // Aufraeumen. Die Oberflaeche ruft das beim Verlassen der Schutzansicht,
  // damit nicht unsichtbar ein halbes Gigabyte Chrome stehen bleibt.
  if (path === '/api/buchung/schliessen' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
    if (body.alle) {
      const n = await buchung.schliesseAlle('Ansicht verlassen');
      return json(res, 200, { ok: true, geschlossen: n });
    }
    const weg = await buchung.schliesse(body.key);
    return json(res, 200, { ok: true, geschlossen: weg ? 1 : 0 });
  }

  if (path === '/api/selbsttest' && req.method === 'POST') {
    if (laufend > 0 || queue.length) {
      return json(res, 200, {
        ok: false,
        error: 'Erst den laufenden Abruf abwarten, beides gleichzeitig verfälscht das Ergebnis.',
      });
    }
    try {
      const roh = await readBody(req, 4000);
      const body = roh ? JSON.parse(roh) : {};
      const { selbsttest, pruefeSeite, WEITERE_SEITEN } = await import('./selbsttest.mjs');

      // Eine einzelne Länderseite: die Oberfläche ruft sie nacheinander ab
      // und zeigt jeden Schritt, sobald er da ist. Ein Endpunkt, der zwei
      // Minuten schweigt und dann alles auf einmal liefert, sieht aus wie
      // ein Absturz.
      if (body.seite) {
        const seite = WEITERE_SEITEN.find((s) => s.host === body.seite);
        if (!seite) return json(res, 400, { ok: false, error: 'Unbekannte Länderseite' });
        return json(res, 200, { ok: true, schritte: [await pruefeSeite(seite)] });
      }

      const schritte = await selbsttest();
      return json(res, 200, { ok: true, schritte, weitere: WEITERE_SEITEN });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 300) });
    }
  }

  // Die Seite meldet, dass ihr Fenster noch offen ist.
  //
  // Und bekommt zurueck, ob sie gehen soll. Das ist der Weg, auf dem ein
  // neuer Start das alte Fenster schliesst: der Dienst kann das Fenster nicht
  // selbst zumachen, Chrome reicht es zwischen eigenen Prozessen weiter. Die
  // Seite darin kann es.
  if (path === '/api/lebt') {
    lebenszeichen(url.searchParams.get('id'));
    return json(res, 200, { ok: true, schliessen: sollSchliessen, version: VERSION });
  }

  // ... und dass es zugeht.
  if (path === '/api/fenster-zu') {
    fensterGehtZu(url.searchParams.get('id'));
    return json(res, 200, { ok: true });
  }

  if (path === '/api/results/clear' && req.method === 'POST') {
    // Ohne Angabe alles, das ist der grosse Reset. Mit einer Schluesselliste
    // nur diese: der Kalender misst seinen Zeitraum neu, ohne nebenbei die
    // Preistabelle zu leeren, die jemand daneben offen hat.
    try {
      const roh = await readBody(req, 200_000);
      const body = roh ? JSON.parse(roh) : {};
      if (Array.isArray(body.keys) && body.keys.length) {
        let weg = 0;
        for (const k of body.keys) if (results.delete(String(k))) weg++;
        return json(res, 200, { ok: true, geloescht: weg });
      }
    } catch {
      /* kein oder kaputter Rumpf: dann eben alles */
    }
    results.clear();
    return json(res, 200, { ok: true });
  }

  /* ---------------------------------------------------- Statische Dateien */

  const file = path === '/' ? '/dist/mietwagen-preistool.html' : path;
  // Erst normalisieren, dann fuehrende Schraegstriche und Aufstiege abtragen,
  // und zwar so lange, bis nichts mehr uebrig ist. Nur einmal zu ersetzen
  // laesst "/../x" stehen. Die eigentliche Sperre sitzt zusaetzlich in
  // leseVorrat; hier geht es darum, gar nicht erst danach zu fragen.
  let name = normalize(file).replaceAll('\\', '/');
  for (let vorher = null; vorher !== name; ) {
    vorher = name;
    name = name.replace(/^\/+/, '').replace(/^(\.\.?\/)+/, '');
  }

  // Ausgeliefert wird nur, was in dist/ liegt, die gebaute Oberflaeche.
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
    if (!r.ok) return null;
    const d = await r.json();
    // Der Fund selbst wird zurueckgegeben, nicht bloss ja/nein: der Aufrufer
    // muss wissen, WELCHE Fassung dort lauscht. Fassungen vor 1.5.4 kennen
    // das Feld nicht, ein fehlender Wert heisst deshalb "aeltere Fassung".
    return d.service === 'mwt-preistool' ? { version: d.version || '', pid: d.pid || null } : null;
  } catch {
    return null;
  }
}

/**
 * Den laufenden Dienst zum Gehen bewegen, damit dieser Start den Port bekommt.
 *
 * Zwei Wege, in dieser Reihenfolge:
 *
 *   1. Im Guten: `/api/beenden`. Der laufende Dienst schliesst seine Fenster
 *      und raeumt Chrome und die Proxy-Weiche ordentlich ab.
 *   2. Mit Gewalt: Fassungen vor 1.5.4 kennen den Endpunkt nicht und liefern
 *      404. Dann bleibt nur, den Prozess zu beenden. Sein Programmfenster
 *      bleibt dabei stehen; es haengt sich gleich an den neuen Dienst und
 *      laedt sich selbst neu, sobald es die andere Fassung bemerkt.
 *
 * @returns {Promise<boolean>} true, wenn der Port danach wirklich frei ist.
 */
async function raeumePlatz(p, laeuft) {
  const weg = async () => !(await schonUnserer(p));

  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/beenden`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      // Grosszuegig: der alte Dienst schliesst erst seine Fenster und beendet
      // dann Chrome, das dauert einen Moment.
      for (let i = 0; i < 40; i++) {
        await new Promise((f) => setTimeout(f, 250));
        if (await weg()) return true;
      }
    }
  } catch {
    /* antwortet nicht mehr, dann eben der harte Weg */
  }

  const pid = laeuft?.pid || (await pidAufPort(p));
  if (!pid || pid === process.pid) return await weg();

  console.log(`Die laufende Fassung antwortet nicht auf die Bitte zu gehen, Prozess ${pid} wird beendet.`);
  try {
    process.kill(pid);
  } catch (e) {
    console.log(`  ging nicht: ${e.message}`);
    return false;
  }
  for (let i = 0; i < 24; i++) {
    await new Promise((f) => setTimeout(f, 250));
    if (await weg()) return true;
  }
  return false;
}

/**
 * Wer lauscht auf diesem Port? Nur noetig fuer den harten Weg oben, wenn der
 * laufende Dienst seine Prozessnummer noch nicht mitteilt.
 */
async function pidAufPort(p) {
  if (process.platform !== 'win32') return null;
  try {
    const { execFile } = await import('node:child_process');
    const text = await new Promise((fertig, schief) =>
      execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 5000 }, (e, aus) =>
        e ? schief(e) : fertig(aus)
      )
    );
    for (const zeile of text.split('\n')) {
      // Nur die lauschende Zeile zaehlt, nicht die vielen Verbindungen dorthin.
      const t = zeile.trim().split(/\s+/);
      if (t.length < 5 || t[1] !== `127.0.0.1:${p}`) continue;
      if (!/^(LISTENING|ABH)/i.test(t[3])) continue;
      const n = Number(t[4]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  } catch {
    /* dann eben nicht */
  }
  return null;
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
 * zwischen eigenen Prozessen weiter, wie es ihm passt, der hier gestartete
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
    console.log('Kein Chrome und kein Edge gefunden, geöffnet im Standardbrowser.');
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
  await leseVersion();

  // Einzelrunde: laeuft vor allem anderen, damit weder ein Port belegt noch
  // ein Fenster geoeffnet wird.
  if (nurWeckerRunde) {
    // Laeuft schon ein TRACKER, hat der seinen eigenen Takt. Zweimal
    // gleichzeitig zu pruefen brauchte niemand und faellt Sixt nur auf.
    for (let p = port; p < port + 12; p++) {
      if (await schonUnserer(p)) {
        console.log('TRACKER läuft bereits, die Weckerrunde übernimmt der laufende Dienst.');
        return beenden(0);
      }
    }
    console.log('Weckerrunde im Hintergrund …');
    await weckerRunde({ sofort: false });
    // Erst wenn ein etwaiges Meldungsfenster wirklich steht. Ohne das beendet
    // sich der Prozess, bevor mshta ueberhaupt gestartet ist, und die Meldung
    // erscheint nie: der Wecker haette dann still ausgeloest.
    await meldungenStehen();
    console.log('Weckerrunde beendet.');
    return beenden(0);
  }

  // 127.0.0.1 statt localhost: der Dienst haengt nur an der IPv4-Adresse,
  // waehrend "localhost" unter Windows zuerst als ::1 aufgeloest wird.
  for (let p = port; p < port + 12; p++) {
    const laeuft = await schonUnserer(p);
    if (laeuft) {
      const adresse = `http://127.0.0.1:${p}/`;
      const fassung = laeuft.version || 'vor 1.5.4';
      console.log(`TRACKER läuft bereits auf ${adresse} (Fassung ${fassung})`);

      // Der neue Start ist der gemeinte. Vorher reichte er an den alten weiter
      // und beendete sich nach zweieinhalb Sekunden: von aussen sah das aus,
      // als starte das Programm nicht, und wer doch ein Fenster sah, hielt die
      // ALTE Oberflaeche fuer die neue. Wer doppelt klickt, will das laufende
      // Programm vorn haben, nicht ein zweites daneben.
      if (!stillerStart && (await raeumePlatz(p, laeuft))) {
        console.log(`Die laufende Fassung ${fassung} wurde beendet, dieser Start übernimmt.`);
        // Weiter in derselben Runde: der Port ist jetzt frei, gleich darunter
        // wird er belegt.
      } else if (istExe && !stillerStart) {
        // Der alte Dienst geht nicht. Dann wenigstens sein Fenster nach vorn,
        // statt den Doppelklick wirkungslos verpuffen zu lassen.
        console.log('Die laufende Fassung ließ sich nicht beenden, ihr Fenster wird geöffnet.');
        oeffneFenster(adresse, datenOrdner);
        setTimeout(() => process.exit(0), 2500);
        return;
      } else {
        process.exit(0);
      }
    }

    if (!(await versucheLauschen(p))) {
      console.log(`Port ${p} ist belegt, versuche ${p + 1} …`);
      continue;
    }

    const adresse = `http://127.0.0.1:${p}/`;
    const chrome = findBrowser();
    console.log(`TRACKER:              ${adresse}`);
    console.log(
      `Preisabruf:           ${chrome ? chrome : 'kein Chrome gefunden, nur Link-Modus'}`
    );
    if (istExe) {
      console.log(`Daten:                ${datenOrdner}`);
      if (!stillerStart) oeffneProgrammfenster(adresse);
    } else {
      console.log(`Import-Token:         ${IMPORT_TOKEN}`);
    }

    // Die Proxy-Weiche muss stehen, bevor Chrome startet: sie wird ihm als
    // Startparameter genannt. Und sie soll sagen koennen, was sie tut.
    setzeLagemelder(merkeLage);
    await starteWeiche().catch((e) => console.log('  ! Proxy-Weiche: ' + e.message));

    // Und ein Chrome, das noch von einem frueheren Lauf steht, muss weg.
    //
    // Die Weiche nimmt beim Start einen freien Port, nach einem Neustart also
    // einen anderen. getBrowser haengt sich per CDP an ein laufendes Chrome an,
    // ohne dessen Startparameter zu kennen: es zeigte dann weiter auf die alte,
    // tote Adresse. Gemessen scheiterten so NEUN VON NEUN Abrufen mit
    // ERR_PROXY_CONNECTION_FAILED, und in der Oberflaeche sah es aus, als
    // passiere gar nichts.
    if (weicheGebraucht()) {
      await closeBrowser().catch(() => {});
      console.log('  ⇄ Proxy aktiv: Chrome startet mit der neuen Weichenadresse neu');
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
 * Start verhindert, muss deshalb als Fenster auf den Bildschirm, mit einem
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
    await buchung.schliesseAlle('Dienst endet');
  } catch {
    /* das Chrome geht gleich ohnehin mit */
  }
  try {
    await closeBrowser();
  } catch {
    /* dann eben nicht, beenden ist wichtiger */
  }
  try {
    await stoppeWeiche();
  } catch {
    /* der Prozess geht ohnehin gleich */
  }
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => beenden(0));
}
