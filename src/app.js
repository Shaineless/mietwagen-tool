import { PROVIDERS, providerById } from './providers.js';
import { STATIONS } from './stations.js';
import { classify, classOrder, decodeAcriss } from './offer-classes.js';

/* =========================================================== Zustand */

const LS_KEY = 'mwt-preistool/v3';
const PROVIDER = 'sixt'; // vorerst nur Sixt

const defaults = () => {
  const t = new Date();
  t.setDate(t.getDate() + 14);
  const back = new Date(t);
  back.setDate(back.getDate() + 4);
  return {
    mode: null,
    pickupDate: iso(t),
    returnDate: iso(back),
    pickupTime: '10:00',
    returnTime: '10:00',
    dayShifts: [0],
    returnShifts: [0],
    durations: [],
    /**
     * Weitere Uhrzeitpaare neben dem Grundpaar oben.
     *
     * Sixt rechnet nach Uhrzeit ab, nicht nach Kalendertag, 12:30 → 12:30
     * kostet etwas anderes als 13:30 → 13:30. Jedes Paar ist eine eigene
     * Abfrage; Einträge der Form { ab: 'HH:MM', zurueck: 'HH:MM' }.
     */
    zeiten: [],
    stations: ['110'],
    returnStation: null,
    markets: ['de', 'at', 'ch', 'nl', 'es'],
    /** Nur bekannte, aber gerade nicht buchbare Klassen mitzeigen? */
    zeigeNichtBuchbare: true,
    /**
     * Ohne Cookies abrufen, als käme man zum ersten Mal auf die Seite.
     *
     * Standardmässig aus: der Abruf mit gespeicherter Cookie-Auswahl ist
     * mehrere Sekunden je Länderseite schneller, weil der Banner nicht jedes
     * Mal neu weggeklickt werden muss.
     */
    inkognito: false,
    /** Einstellungen der Monatsübersicht, eigener Bereich, eigener Zustand. */
    kalender: {
      station: '110',
      host: 'www.sixt.de',
      klasse: '',
      dauer: 3,
      // Drei Tage Vorlauf: was übermorgen abgeholt wird, ist ohnehin teuer,
      // und ein Kalender, der mit Ausreissern anfängt, führt in die Irre.
      start: iso(new Date(Date.now() + 3 * 86400000)),
      spanne: 28,
      zeit: '10:00',
      /** Weitere Uhrzeitpaare, jede multipliziert die ganze Spanne. */
      zeiten: [],
      inkognito: false,
      /** Stationen für den Mehrstationslauf, eigener Bereich, eigene Liste. */
      stationen: [],
    },
  };
};

let state = load();

/** Fahrzeugklasse, deren Schutzpakete gerade betrachtet werden. */
let schutzAcriss = null;

/** Station/Termin, deren Schutzpakete gezeigt werden (Schluessel wie `gruppe`). */
let schutzGruppe = null;

/**
 * Welche Station/Termin-Kombination gerade angezeigt wird.
 *
 * Bei mehreren Stationen oder Datumsvarianten wurden vorher alle Tabellen
 * untereinander gestapelt, bei fuenf Stationen sind das fuenf mal fuenfzig
 * Zeilen und man findet nichts wieder. Jetzt gibt es einen Umschalter und
 * immer nur eine Tabelle.
 */
let aktiveGruppe = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!saved) return defaults();
    // Verschachtelte Bereiche einzeln zusammenfuehren: ein flaches Spread
    // wuerde einen alten kalender-Block ohne neue Felder uebernehmen und
    // damit undefined-Werte einschleppen.
    const grund = defaults();
    const merged = { ...grund, ...saved, kalender: { ...grund.kalender, ...(saved.kalender || {}) } };
    // Eine Länderseite, die inzwischen als gestört gilt, kann noch im
    // gespeicherten Zustand stehen, sonst liefe jeder Abruf sehenden Auges
    // in einen Fehlschlag.
    merged.markets = ohneGestoerte(merged.markets || []);
    if (merged.pickupDate < iso(new Date())) {
      const d = defaults();
      merged.pickupDate = d.pickupDate;
      merged.returnDate = d.returnDate;
    }
    return merged;
  } catch {
    return defaults();
  }
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* privater Modus */
  }
}

/* =========================================================== Dienst */

const service = {
  available: false,
  chrome: false,
  queue: null,
};
const prices = new Map(); // Auftragsschlüssel -> Preisergebnis
const schutz = new Map(); // Auftragsschlüssel -> Schutzergebnis
let katalog = {}; // ACRISS -> {bild, modelle, beispielText}
let pollTimer = null;

async function checkService() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    service.available = r.ok;
    if (r.ok) {
      const d = await r.json();
      service.chrome = Boolean(d.chrome);
      service.queue = d.queue || null;
    }
  } catch {
    service.available = false;
  }
  return service.available;
}

function jobKey(host, stationCode, v, acrissCode, inkognito = state.inkognito) {
  return [
    acrissCode ? 'schutz' : 'preis',
    PROVIDER,
    host,
    stationCode,
    v.pickupDate,
    v.returnDate,
    // Die Uhrzeit gehört zur Variante, nicht zum Grundzustand: sonst
    // überschrieben sich zwei Abholzeiten desselben Tages gegenseitig, und
    // man sähe nur die zuletzt geholte. Ältere Aufrufe ohne Zeit in der
    // Variante fallen auf den Grundzustand zurück.
    v.pickupTime ?? state.pickupTime,
    v.returnTime ?? state.returnTime,
    acrissCode || '',
    // Ein Abruf ohne Cookies ist ein anderer Abruf, genau darum geht es.
    // Ohne diesen Teil im Schlüssel läge das alte Ergebnis noch im Speicher
    // und der Haken bliebe wirkungslos.
    inkognito ? 'inkognito' : '',
  ].join('~');
}

/** Katalog laden: welche Klassen gab es an diesen Stationen schon einmal? */
async function ladeKatalog() {
  if (!service.available || !state.stations.length) return;
  const hosts = marktListe().map((m) => m.host);
  try {
    const r = await fetch(
      `/api/katalog?provider=${PROVIDER}&station=${encodeURIComponent(state.stations[0])}` +
        `&hosts=${encodeURIComponent(hosts.join(','))}`
    );
    const d = await r.json();
    if (d.ok) katalog = d.klassen || {};
  } catch {
    /* Katalog ist Beiwerk */
  }
}

/**
 * Schluessel, die nicht aus der aktuellen Suche stammen.
 *
 * Der Monatskalender fragt dreissig Termine ab, die in keiner der beiden
 * Auftragslisten stehen. Ohne diesen Zusatz holt der Takt ihre Ergebnisse nie
 * ab: die Abrufe laufen durch, der Kalender bleibt leer.
 */
const extraSchluessel = new Set();

async function pollErgebnisse() {
  if (!service.available) return;

  const offen = [
    ...[...aktuelleJobs(), ...schutzJobs()].map((j) => j.key),
    ...extraSchluessel,
  ].filter((k) => k && !prices.has(k) && !schutz.has(k));

  if (offen.length) {
    try {
      const r = await fetch(`/api/results?keys=${encodeURIComponent(offen.join(','))}`, {
        cache: 'no-store',
      });
      const d = await r.json();
      let neu = false;
      let neueKasse = false;
      for (const [k, v] of Object.entries(d.results || {})) {
        if (k.startsWith('schutz~')) {
          if (!schutz.has(k)) {
            schutz.set(k, v);
            neu = true;
            if (v.kasse) neueKasse = true;
          }
        } else if (!prices.has(k)) {
          prices.set(k, v);
          neu = true;
        }
      }
      // Kam eine Kassenseite dazu, muss die Oberfläche wissen, welche Zellen
      // ab jetzt anklickbar sind. ladeKassen zeichnet selbst nach.
      if (neueKasse) ladeKassen();
      if (neu) {
        // Nur neu zeichnen, wenn sich die sichtbare Ansicht wirklich aendert.
        // Frueher wurde bei jedem Takt die ganze Tabelle verworfen und neu
        // gebaut, 52 Zeilen, alle 2,5 Sekunden. Das sah man als Flackern,
        // Scrollposition und Hover gingen dabei jedes Mal verloren.
        if (schutzAcriss) renderSchutz();
        else renderResults();
      }
    } catch {
      /* nächster Durchlauf */
    }
  }

  try {
    const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
    const liefNoch = Boolean(service.queue && (service.queue.laufend || service.queue.offen));
    service.queue = h.queue || null;
    renderFortschritt();

    // Genau im Moment des Leerlaufens ablegen, nicht bei jedem Takt, sonst
    // stünde alles fünfmal drin.
    const laeuftNoch = Boolean(h.queue && (h.queue.laufend || h.queue.offen));
    if (liefNoch && !laeuftNoch) {
      merkeSuche();
      // War es ein Schutzabruf, gehören die Pakete ans angesehene Fahrzeug.
      if (schutzAcriss) merkeFahrzeug(schutzAcriss);
      await hakeNach();
    }
  } catch {
    /* egal */
  }
}

/**
 * Nach einem Durchlauf selbst nachfassen, was nichts geliefert hat.
 *
 * Der Dienst wiederholt schon dreimal je Auftrag. Was danach noch fehlt, war
 * meist ein Fenster oder eine Zeitüberschreitung, die beim nächsten Anlauf
 * nicht wieder auftritt, deshalb einmal von selbst nachfassen, statt darauf
 * zu warten, dass jemand den Knopf findet.
 *
 * Genau einmal je Durchlauf: liefe es endlos, drehte sich das Werkzeug bei
 * einer dauerhaft gestörten Seite im Kreis und belastete Sixt ohne Nutzen.
 */
let nachgefasst = new Set();

async function hakeNach() {
  if (!service.chrome) return;
  const offen = jobsOhneErgebnis(aktuelleJobs()).filter((j) => !nachgefasst.has(j.key));
  if (!offen.length) return;

  for (const j of offen) {
    nachgefasst.add(j.key);
    prices.delete(j.key);
  }
  flash(
    `${offen.length} ${offen.length === 1 ? 'Länderseite hat' : 'Länderseiten haben'} nichts ` +
      'geliefert, wird automatisch noch einmal versucht.'
  );
  await sendeJobs(
    offen.map((j) => ({
      key: j.key,
      provider: PROVIDER,
      host: j.market.host,
      stationCode: j.station.code,
      returnCode: state.returnStation || undefined,
      pickupDate: j.variant.pickupDate,
      returnDate: j.variant.returnDate,
      pickupTime: j.variant.pickupTime ?? state.pickupTime,
      returnTime: j.variant.returnTime ?? state.returnTime,
      currency: j.market.cur,
      inkognito: state.inkognito || undefined,
    })),
    $('#getPrices')
  );
  renderResults({ erzwingen: true });
}

function startPolling() {
  if (pollTimer || !service.available) return;
  pollTimer = setInterval(pollErgebnisse, 2500);
}

/* =========================================================== Datum */

function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(s, n) {
  const d = new Date(s + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return iso(d);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function pretty(s) {
  const d = new Date(s + 'T12:00:00');
  return `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(
    d.getMonth() + 1
  ).padStart(2, '0')}.`;
}

function money(v, cur) {
  if (v == null) return '–';
  return `${v.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}${cur ? ' ' + cur : ''}`;
}

/* =========================================================== Suche */

function score(text, iata, needle) {
  const q = fold(needle);
  const name = fold(text);
  const code = (iata || '').toLowerCase();
  if (code && code === q) return 1000;
  if (code && code.startsWith(q)) return 900;
  if (name.startsWith(q)) return 800;
  if (name.split(/[\s/().,-]+/).some((w) => w.startsWith(q))) return 700;
  if (name.includes(q)) return 500;
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  return i === q.length ? 100 : -1;
}

function fold(s) {
  return (s || '')
    .toLowerCase()
    .replaceAll('ä', 'a')
    .replaceAll('ö', 'o')
    .replaceAll('ü', 'u')
    .replaceAll('ß', 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const ALLE_STATIONEN = STATIONS.filter((s) => s.provider === PROVIDER);

function suche(needle, limit = 60) {
  if (!needle.trim()) {
    return [...ALLE_STATIONEN]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  let hits = ALLE_STATIONEN.map((s) => ({
    s,
    sc: score(`${s.name} ${s.country}`, s.iata, needle),
  })).filter((h) => h.sc >= 0);

  const best = Math.max(0, ...hits.map((h) => h.sc));
  if (best >= 500) hits = hits.filter((h) => h.sc >= 500);

  return hits
    .sort(
      (a, b) =>
        b.sc - a.sc ||
        Number(Boolean(b.s.iata)) - Number(Boolean(a.s.iata)) ||
        a.s.name.localeCompare(b.s.name)
    )
    .slice(0, limit)
    .map((h) => h.s);
}

function stationByCode(code) {
  return ALLE_STATIONEN.find((s) => s.code === code);
}

function marktListe() {
  return providerById(PROVIDER).markets.filter((m) => state.markets.includes(m.code));
}

/* =========================================================== Aufträge */

/**
 * Die Termine, die abgefragt werden.
 *
 * Zwei Denkweisen, und sie schliessen einander aus:
 *
 *   Mietdauer     Die Rueckgabe haengt an der Abholung. "Sieben Tage, egal wann
 *                 ich starte." Ist eine Dauer gewaehlt, gilt nur das.
 *   Rueckgabetag  Beide Enden sind unabhaengig. "Montag bis Montag, aber was
 *                 kostet Dienstag bis Montag, was Sonntag bis Montag?" Genau
 *                 dafuer laesst sich die Rueckgabe getrennt verschieben.
 *
 * Kombinationen, bei denen die Rueckgabe nicht nach der Abholung liegt, fallen
 * weg: dafuer gibt es keinen Preis, nur eine Fehlermeldung von Sixt.
 */
/**
 * Die Uhrzeitpaare, die abgefragt werden.
 *
 * Sixt rechnet nach Uhrzeit ab, nicht nach Kalendertag: 12:30 → 12:30 ist ein
 * anderer Preis als 13:30 → 13:30, und 13:30 → 08:00 ist wieder ein anderer,
 * weil die Rueckgabe dann in den Vortag faellt. Wer das nicht mitvergleicht,
 * vergleicht Laenderseiten und uebersieht die groessere Ersparnis daneben.
 *
 * Das erste Paar sind immer die beiden Felder oben. Weitere kommen als Liste
 * dazu, das haelt den einfachen Fall einfach.
 */
function zeitVarianten() {
  const paare = [{ ab: state.pickupTime, zurueck: state.returnTime }];
  for (const z of state.zeiten || []) {
    if (!/^\d{2}:\d{2}$/.test(z.ab) || !/^\d{2}:\d{2}$/.test(z.zurueck)) continue;
    if (paare.some((p) => p.ab === z.ab && p.zurueck === z.zurueck)) continue;
    paare.push({ ab: z.ab, zurueck: z.zurueck });
  }
  return paare;
}

function dateVariants() {
  const grunddauer = Math.max(1, daysBetween(state.pickupDate, state.returnDate));
  const shifts = state.dayShifts.length ? state.dayShifts : [0];
  const zeiten = zeitVarianten();
  const roh = [];

  if (state.durations.length) {
    for (const shift of shifts) {
      for (const dur of state.durations) {
        const pickupDate = addDays(state.pickupDate, shift);
        roh.push({ pickupDate, returnDate: addDays(pickupDate, dur), duration: dur });
      }
    }
  } else {
    const rueck = state.returnShifts?.length ? state.returnShifts : [0];
    for (const shift of shifts) {
      for (const rshift of rueck) {
        const pickupDate = addDays(state.pickupDate, shift);
        const returnDate = addDays(state.returnDate, rshift);
        const duration = daysBetween(pickupDate, returnDate);
        if (duration < 1) continue;
        roh.push({ pickupDate, returnDate, duration });
      }
    }
    // Alles weggefallen? Dann wenigstens der eingestellte Zeitraum selbst.
    if (!roh.length) {
      roh.push({
        pickupDate: state.pickupDate,
        returnDate: state.returnDate,
        duration: grunddauer,
      });
    }
  }

  // Jeder Termin mal jedes Uhrzeitpaar.
  const out = [];
  for (const v of roh) {
    for (const z of zeiten) {
      out.push({ ...v, pickupTime: z.ab, returnTime: z.zurueck });
    }
  }
  return out;
}

function renderZeiten() {
  const liste = state.zeiten || [];
  setChildren(
    $('#zeitenListe'),
    ...liste.map((z, i) =>
      el(
        'div',
        { class: 'zeitzeile' },
        el('span', { class: 'zlabel' }, `Zeit ${i + 2}`),
        el('input', {
          type: 'time',
          step: '900',
          value: z.ab,
          'aria-label': `Abholzeit ${i + 2}`,
          onchange: (e) => {
            state.zeiten[i].ab = e.target.value;
            update();
          },
        }),
        el('span', { class: 'zpfeil', 'aria-hidden': 'true' }, '→'),
        el('input', {
          type: 'time',
          step: '900',
          value: z.zurueck,
          'aria-label': `Rückgabezeit ${i + 2}`,
          onchange: (e) => {
            state.zeiten[i].zurueck = e.target.value;
            update();
          },
        }),
        el(
          'button',
          {
            type: 'button',
            class: 'ghost mini',
            title: 'Diese Uhrzeit entfernen',
            onclick: () => {
              state.zeiten.splice(i, 1);
              update();
            },
          },
          '×'
        )
      )
    )
  );

  const n = zeitVarianten().length;
  const jobs = aktuelleJobs().length;
  $('#zeitenHinweis').textContent =
    n === 1
      ? 'Nur die Uhrzeit oben.'
      : `${n} Uhrzeiten · ${jobs} Abfragen insgesamt, rund ${minutenText(jobs)}.`;
  // Ist etwas eingestellt, soll der Bereich nicht zugeklappt danebenstehen.
  if (liste.length && !$('#zeitenBereich').open) $('#zeitenBereich').open = true;
}

/** "1 Minute" statt "1 Minuten", an drei Stellen gebraucht, also einmal hier. */
function minutenText(abrufe) {
  const m = Math.max(1, Math.ceil((abrufe * 6) / 2 / 60));
  return `${m} ${m === 1 ? 'Minute' : 'Minuten'}`;
}

/** Ein Uhrzeitpaar kurz, für Reiter und Überschriften. */
function zeitKurz(v) {
  return v.pickupTime === v.returnTime
    ? v.pickupTime
    : `${v.pickupTime}→${v.returnTime}`;
}

function aktuelleJobs() {
  const provider = providerById(PROVIDER);
  const märkte = marktListe();
  const stationen = state.stations.map(stationByCode).filter(Boolean);
  const ret = state.returnStation ? stationByCode(state.returnStation) : null;

  const jobs = [];
  for (const station of stationen) {
    for (const v of dateVariants()) {
      for (const market of märkte) {
        const q = {
          ...state,
          pickupDate: v.pickupDate,
          returnDate: v.returnDate,
          pickupTime: v.pickupTime ?? state.pickupTime,
          returnTime: v.returnTime ?? state.returnTime,
        };
        const built = provider.build(q, market, station, ret);
        const key = jobKey(market.host, station.code, v);
        jobs.push({
          market,
          station,
          variant: v,
          key,
          // Die Uhrzeit gehört in die Gruppe: 12:30→12:30 und 13:30→13:30 sind
          // zwei Abfragen mit zwei Preisen, und sie brauchen zwei Reiter.
          gruppe: `${station.code}|${v.pickupDate}|${v.returnDate}|${v.pickupTime}|${v.returnTime}`,
          url: built.url,
        });
      }
    }
  }
  return jobs;
}

/**
 * Alle Schutz-Auftraege der betrachteten Klasse, ueber jede Station und
 * jeden Termin, in denselben Gruppen wie die Preistabelle.
 */
function alleSchutzJobs() {
  if (!schutzAcriss) return [];
  const stationen = state.stations.map(stationByCode).filter(Boolean);
  const jobs = [];
  for (const station of stationen) {
    for (const v of dateVariants()) {
      for (const market of marktListe()) {
        jobs.push({
          market,
          station,
          variant: v,
          acriss: schutzAcriss,
          gruppe: `${station.code}|${v.pickupDate}|${v.returnDate}|${v.pickupTime}|${v.returnTime}`,
          key: jobKey(market.host, station.code, v, schutzAcriss),
        });
      }
    }
  }
  return jobs;
}

/**
 * Nur die Auftraege der gerade gewaehlten Station/Termin-Gruppe.
 *
 * Ohne diese Einschraenkung stuenden bei zwei Stationen alle Laenderseiten
 * doppelt nebeneinander, mit gleicher Beschriftung, also nicht
 * unterscheidbar, und der Abruf liefe doppelt so lange.
 */
function schutzJobs() {
  const alle = alleSchutzJobs();
  const schluessel = [...new Set(alle.map((j) => j.gruppe))];
  if (!schluessel.includes(schutzGruppe)) schutzGruppe = schluessel[0] ?? null;
  return alle.filter((j) => j.gruppe === schutzGruppe);
}

/* =========================================================== DOM */

const $ = (s) => document.querySelector(s);

function setChildren(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k != null));
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === false || v === undefined) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function showScreen(name) {
  const previous = document.body.dataset.screen;
  $('#start').hidden = name !== 'start';
  $('#statusScreen').hidden = name !== 'status';
  $('#work').hidden = name !== 'work';
  $('#schutzScreen').hidden = name !== 'schutz';
  $('#mailScreen').hidden = name !== 'mail';
  $('#verlaufScreen').hidden = name !== 'verlauf';
  $('#kurveScreen').hidden = name !== 'kurve';
  $('#kalenderScreen').hidden = name !== 'kalender';
  $('#willkommen').hidden = name !== 'willkommen';
  document.body.dataset.screen = name;
  // Der Takt läuft nur, wo die Liste auch zu sehen ist.
  haltWeckerFrisch(name === 'kurve');
  haltKassenFrisch(name === 'schutz');
  // Wer die Schutzansicht verlässt, ohne zu buchen, soll keine unsichtbaren
  // Chrome-Fenster zurücklassen. Jede offene Kassenseite kostet rund 100 MB,
  // und man sieht sie nicht, also muss es von selbst geschehen.
  if (previous === 'schutz' && name !== 'schutz') schliesseKassen(true);
  document.querySelectorAll('[data-nav]').forEach((button) => {
    if (button.dataset.nav === name || (name === 'schutz' && button.dataset.nav === 'work')) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
  if (previous && previous !== name) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const heading = document.querySelector('.screen:not([hidden]) h1');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
  }
}

/**
 * Die Ergebnistabelle als CSV.
 *
 * Semikolon statt Komma und Komma als Dezimaltrennzeichen: so oeffnet Excel
 * in einer deutschen Einstellung die Datei ohne Rueckfrage. Mit Punkt und
 * Komma landet alles in einer Spalte, und dann schimpft zu Recht jeder.
 */
function alsCsv() {
  const jobs = aktuelleJobs().filter((j) => j.gruppe === aktiveGruppe);
  if (!jobs.length) return null;

  const klassen = new Map();
  for (const j of jobs) {
    for (const o of prices.get(j.key)?.offers || []) {
      if (!o.acriss) continue;
      if (!klassen.has(o.acriss)) klassen.set(o.acriss, { modell: o.model || '', preise: {} });
      klassen.get(o.acriss).preise[j.market.host] = o;
    }
  }
  if (!klassen.size) return null;

  const zahl = (n) => (n == null ? '' : String(n.toFixed(2)).replace('.', ','));
  const feld = (s) => `"${String(s ?? '').replaceAll('"', '""')}"`;

  const f = jobs[0];
  const zeilen = [
    [
      feld('Station'),
      feld('Von'),
      feld('Bis'),
      feld('Tage'),
      feld('ACRISS'),
      feld('Modell'),
      ...jobs.flatMap((j) => [feld(`${j.market.label} gesamt`), feld(`${j.market.label} pro Tag`)]),
    ].join(';'),
  ];

  for (const [acriss, d] of [...klassen].sort((a, b) => a[0].localeCompare(b[0]))) {
    zeilen.push(
      [
        feld(f.station.name),
        feld(f.variant.pickupDate),
        feld(f.variant.returnDate),
        f.variant.duration,
        feld(acriss),
        feld(d.modell),
        ...jobs.flatMap((j) => {
          const o = d.preise[j.market.host];
          return [zahl(o?.total), zahl(o?.perDay)];
        }),
      ].join(';')
    );
  }

  // BOM voran, sonst zeigt Excel aus Umlauten Kraut und Rüben.
  return '﻿' + zeilen.join('\r\n') + '\r\n';
}

function ladeCsvHerunter() {
  const csv = alsCsv();
  if (!csv) {
    flash('Noch keine Preise zum Ausgeben.');
    return;
  }
  const f = aktuelleJobs().find((j) => j.gruppe === aktiveGruppe);
  const name =
    `preise-${(f?.station.name || 'station').replace(/[^\wäöüÄÖÜß]+/g, '-').toLowerCase()}` +
    `-${f?.variant.pickupDate || ''}.csv`;

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  // Der Browser braucht die Adresse noch einen Moment, bis der Download steht.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  flash('Als CSV gespeichert.');
}

/* ------------------------------------------------------------ Excel-Mappe
 *
 * Die CSV bleibt der kurze Weg. Diese hier ist der andere: eine Mappe, die
 * auch in drei Monaten noch sagt, was sie zeigt, mit Kopfblock, festen
 * Spaltenbreiten, echten Zahlen statt Text und einer Farbskala, damit teuer
 * und billig ins Auge fallen.
 *
 * Getrennt je Waehrung, wie ueberall im Werkzeug: Preise in EUR und CHF
 * gehoeren nicht in dieselbe Spalte, und umgerechnet wird nicht.
 */

/** Die Einstellungen des Ausgabedialogs. */
const xlsxVorgabe = () => ({
  preise: true,
  schutz: true,
  kalender: false,
  alleStationen: false,
  nichtBuchbare: false,
  /** 'gesamt' | 'tag' | 'beide' */
  betraege: 'beide',
  farbskala: true,
});

function xlsxOptionen() {
  return { ...xlsxVorgabe(), ...(state.xlsx || {}) };
}

/** Kopfblock eines Blattes: was hier steht, muss die Datei selbst erklaeren. */
function xlsxKopf(titel, f, waehrung) {
  return [
    [{ w: titel, s: STIL.titel }],
    [{ w: 'Station', s: STIL.klein }, f.station.name, null, { w: 'Nr.', s: STIL.klein }, f.station.code],
    [
      { w: 'Zeitraum', s: STIL.klein },
      `${f.variant.pickupDate} ${f.variant.pickupTime} → ${f.variant.returnDate} ${f.variant.returnTime}`,
      null,
      { w: 'Tage', s: STIL.klein },
      f.variant.duration,
    ],
    [
      { w: 'Abruf', s: STIL.klein },
      state.inkognito ? 'ohne Cookies (wie ein Erstbesuch)' : 'mit gespeicherter Cookie-Auswahl',
      null,
      { w: 'Währung', s: STIL.klein },
      waehrung,
    ],
    [
      { w: 'Erstellt', s: STIL.klein },
      new Date().toLocaleString('de-DE'),
      null,
      { w: 'Quelle', s: STIL.klein },
      'TRACKER · Preise von Sixt, abgelesen',
    ],
    [],
  ];
}

/**
 * Das Preisblatt einer Station in einer Waehrung.
 *
 * @returns {object|null} Blatt fuer mappe(), oder null wenn nichts vorliegt
 */
function xlsxPreisblatt(jobs, waehrung, opt) {
  const relevant = jobs.filter((j) => (j.market.cur || '') === waehrung);
  if (!relevant.length) return null;

  // Klasse → Länderseite → Angebot
  const klassen = new Map();
  for (const j of relevant) {
    for (const o of prices.get(j.key)?.offers || []) {
      if (!o.acriss || (o.currency || '') !== waehrung) continue;
      if (!klassen.has(o.acriss)) klassen.set(o.acriss, { modell: o.model || '', nach: new Map() });
      const e = klassen.get(o.acriss);
      const alt = e.nach.get(j.market.host);
      if (!alt || (o.total ?? Infinity) < (alt.total ?? Infinity)) e.nach.set(j.market.host, o);
      if (!e.modell && o.model) e.modell = o.model;
    }
  }

  // Bekannte, gerade nicht buchbare Klassen ergaenzen, dieselbe Wahl wie in
  // der Tabelle, damit Ausgabe und Bildschirm dasselbe zeigen.
  if (opt.nichtBuchbare) {
    for (const acriss of Object.keys(katalog)) {
      if (!klassen.has(acriss)) klassen.set(acriss, { modell: '', nach: new Map() });
    }
  }
  if (!klassen.size) return null;

  const zeigeGesamt = opt.betraege !== 'tag';
  const zeigeTag = opt.betraege !== 'gesamt';

  const f = relevant[0];
  const zeilen = xlsxKopf('Preisvergleich', f, waehrung);
  const kopfZeile = zeilen.length; // 0-basiert: hier kommt die Kopfzeile hin

  // Erst alle Gesamtpreise, dann alle Tagespreise, nicht abwechselnd.
  // Abwechselnd liessen sich die Gesamtpreise weder mit einem Blick
  // vergleichen noch mit einer Farbskala hinterlegen: die Tagespreise sind
  // um ein Vielfaches kleiner und zoegen die Skala an ihr Ende.
  const kopf = [
    { w: 'ACRISS', s: STIL.kopfzeile },
    { w: 'Fahrzeugklasse', s: STIL.kopfzeile },
    { w: 'Beispielmodell', s: STIL.kopfzeile },
  ];
  const abGesamt = kopf.length;
  if (zeigeGesamt) for (const j of relevant) kopf.push({ w: `${j.market.label} gesamt`, s: STIL.kopfzeile });
  const bisGesamt = kopf.length - 1;
  if (zeigeTag) for (const j of relevant) kopf.push({ w: `${j.market.label} pro Tag`, s: STIL.kopfzeile });
  kopf.push({ w: 'Günstigste Seite', s: STIL.kopfzeile });
  zeilen.push(kopf);

  const sortiert = [...klassen].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [acriss, d] of sortiert) {
    const werte = relevant.map((j) => d.nach.get(j.market.host));
    const gesamte = werte.map((o) => o?.total).filter((n) => n != null);
    const bester = gesamte.length ? Math.min(...gesamte) : null;
    const besteSeite =
      bester == null
        ? ''
        : relevant.find((j) => d.nach.get(j.market.host)?.total === bester)?.market.label || '';

    const dek = decodeAcriss(acriss);
    const zeile = [acriss, dek ? dek.label : '', d.modell];
    // Hervorheben lohnt nur, wo es etwas zu vergleichen gibt. Bei einer
    // einzigen Länderseite waere jede Zelle "die günstigste", eine Farbe,
    // die nichts unterscheidet, ist nur Lärm.
    const lohntHervorhebung = gesamte.length > 1;
    if (zeigeGesamt) {
      for (const o of werte) {
        const best = lohntHervorhebung && o?.total != null && o.total === bester;
        zeile.push(o?.total == null ? null : { w: o.total, s: best ? STIL.betragBest : STIL.betrag });
      }
    }
    if (zeigeTag) {
      for (const o of werte) zeile.push(o?.perDay == null ? null : { w: o.perDay, s: STIL.betragGrau });
    }
    zeile.push(relevant.length > 1 ? besteSeite : '');
    zeilen.push(zeile);
  }

  const spalten = kopf.length;
  const letzte = zeilen.length;
  return {
    // Nicht hier kuerzen: der Aufrufer stellt ggf. noch die Währung voran,
    // und mappe() beschneidet am Ende einmal sauber.
    name: `Preise ${f.station.name}`,
    zeilen,
    breiten: [10, 30, 26, ...Array(spalten - 4).fill(16), 20],
    frieren: kopfZeile + 1,
    filter: `A${kopfZeile + 1}:${spaltenBuchstabe(spalten - 1)}${letzte}`,
    // Nur ueber die Gesamtpreise. Tagespreise mit hineinzunehmen verschoebe
    // die Skala: sie sind um ein Vielfaches kleiner und faerbten alles gleich.
    farbskala:
      opt.farbskala && zeigeGesamt && letzte > kopfZeile + 1
        ? `${spaltenBuchstabe(abGesamt)}${kopfZeile + 2}:${spaltenBuchstabe(bisGesamt)}${letzte}`
        : null,
  };
}

/** Spaltenbuchstabe, dieselbe Rechnung wie in xlsx.js, hier fuer die Bereiche. */
function spaltenBuchstabe(i) {
  let s = '';
  for (let n = i + 1; n > 0; ) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Das Schutzblatt: die vier Faecher je Länderseite. */
function xlsxSchutzblatt(jobs, waehrung) {
  const relevant = jobs.filter((j) => (j.market.cur || '') === waehrung);
  const zeilen = [];
  const f = relevant[0];
  if (!f) return null;

  let etwas = false;
  const kopf = [
    { w: 'ACRISS', s: STIL.kopfzeile },
    { w: 'Länderseite', s: STIL.kopfzeile },
    { w: 'Ohne Schutz', s: STIL.kopfzeile },
    { w: 'Mit Selbstbeteiligung', s: STIL.kopfzeile },
    { w: 'Freistellung', s: STIL.kopfzeile },
    { w: 'Freistellung plus', s: STIL.kopfzeile },
  ];

  const daten = [];
  for (const [key, r] of schutz) {
    const j = relevant.find((x) => jobKey(x.market.host, x.station.code, x.variant, r.acriss) === key);
    if (!j || !r.pakete?.length) continue;
    const fa = schutzFaecher(r.pakete);
    if (!fa) continue;
    etwas = true;
    daten.push([
      r.acriss,
      j.market.label,
      fa.ohne ? { w: fa.ohne.gesamt, s: STIL.betrag } : null,
      fa.sb ? { w: fa.sb.gesamt, s: STIL.betrag } : null,
      fa.frei1 ? { w: fa.frei1.gesamt, s: STIL.betrag } : null,
      fa.frei2 ? { w: fa.frei2.gesamt, s: STIL.betrag } : null,
    ]);
  }
  if (!etwas) return null;

  zeilen.push(...xlsxKopf('Schutzpakete, abgelesener Endpreis aus der Kasse', f, waehrung));
  const kopfZeile = zeilen.length;
  zeilen.push(kopf);
  daten.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  zeilen.push(...daten);
  zeilen.push([]);
  zeilen.push([
    {
      w:
        'Jedes Paket wurde in der Kasse einzeln ausgewählt und die Gesamtsumme abgelesen. ' +
        'Der Tagespreis mal Miettage lag gemessen bis zu 26 % daneben.',
      s: STIL.klein,
    },
  ]);

  return {
    name: 'Schutzpakete',
    zeilen,
    breiten: [10, 22, 18, 22, 18, 20],
    frieren: kopfZeile + 1,
    filter: `A${kopfZeile + 1}:F${kopfZeile + daten.length + 1}`,
  };
}

/** Das Kalenderblatt: ein Abholtag je Zeile. */
function xlsxKalenderblatt() {
  const d = kalJobs();
  if (!d) return null;

  const zeilen = [
    [{ w: 'Monatsübersicht', s: STIL.titel }],
    [{ w: 'Station', s: STIL.klein }, d.station.name, null, { w: 'Nr.', s: STIL.klein }, d.station.code],
    [
      { w: 'Länderseite', s: STIL.klein },
      `${d.markt.label} (${d.markt.cur})`,
      null,
      { w: 'Mietdauer', s: STIL.klein },
      state.kalender.dauer,
    ],
    [
      { w: 'Klasse', s: STIL.klein },
      state.kalender.klasse || 'Günstigste Klasse je Tag',
      null,
      { w: 'Abruf', s: STIL.klein },
      state.kalender.inkognito ? 'ohne Cookies' : 'mit Cookies',
    ],
    [{ w: 'Erstellt', s: STIL.klein }, new Date().toLocaleString('de-DE')],
    [],
  ];
  const kopfZeile = zeilen.length;
  // Bei mehreren Uhrzeiten gehört eine Spalte dafür dazu, sonst stünden
  // drei Zeilen mit demselben Datum und verschiedenen Preisen da, und man
  // wüsste nicht, welche welche ist.
  const mehrZeiten = kalZeitVarianten().length > 1;
  zeilen.push([
    { w: 'Abholtag', s: STIL.kopfzeile },
    { w: 'Wochentag', s: STIL.kopfzeile },
    { w: 'Rückgabe', s: STIL.kopfzeile },
    ...(mehrZeiten
      ? [
          { w: 'Abholzeit', s: STIL.kopfzeile },
          { w: 'Rückgabezeit', s: STIL.kopfzeile },
        ]
      : []),
    { w: 'Gesamtpreis', s: STIL.kopfzeile },
    { w: 'Pro Tag', s: STIL.kopfzeile },
    { w: 'Herkunft', s: STIL.kopfzeile },
    { w: 'Gemessen', s: STIL.kopfzeile },
  ]);

  // Je Abholtag den günstigsten Preis merken, um ihn hervorzuheben, bei
  // mehreren Uhrzeiten ist genau das die Aussage der Tabelle.
  const bestProTag = new Map();
  for (const j of d.jobs) {
    const p = kalPreis(j);
    if (p.preis == null) continue;
    if (!bestProTag.has(j.pickupDate) || p.preis < bestProTag.get(j.pickupDate)) {
      bestProTag.set(j.pickupDate, p.preis);
    }
  }

  let n = 0;
  for (const j of d.jobs) {
    const p = kalPreis(j);
    if (p.preis == null) continue;
    n++;
    const best = mehrZeiten && p.preis === bestProTag.get(j.pickupDate);
    zeilen.push([
      j.pickupDate,
      new Date(j.pickupDate + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long' }),
      j.returnDate,
      ...(mehrZeiten ? [j.pickupTime, j.returnTime] : []),
      { w: p.preis, s: best ? STIL.betragBest : STIL.betrag },
      { w: p.preis / state.kalender.dauer, s: STIL.betragGrau },
      // Woher der Wert stammt, gehoert dazu: ein Preis aus dem Verlauf ist
      // etwas anderes als einer von eben.
      p.ausAufzeichnung ? 'gespeicherter Preisverlauf' : 'frischer Abruf',
      p.zeit ? new Date(p.zeit).toLocaleString('de-DE') : '',
    ]);
  }
  if (!n) return null;

  const preisSp = mehrZeiten ? 'F' : 'D';
  const letzteSp = mehrZeiten ? 'I' : 'G';
  return {
    name: 'Monatsübersicht',
    zeilen,
    breiten: mehrZeiten
      ? [14, 14, 14, 12, 13, 16, 14, 26, 20]
      : [14, 14, 14, 16, 14, 26, 20],
    frieren: kopfZeile + 1,
    filter: `A${kopfZeile + 1}:${letzteSp}${kopfZeile + n + 1}`,
    farbskala: `${preisSp}${kopfZeile + 2}:${preisSp}${kopfZeile + n + 1}`,
  };
}

/**
 * Die Mappe zusammenstellen und speichern.
 *
 * Je Waehrung eine eigene Datei waere unhandlich; je Waehrung ein eigenes
 * Blatt ist genau richtig. Der Zahlenformat-Code der Mappe kann aber nur eine
 * Waehrung tragen, deshalb entscheidet die haeufigste, und die uebrigen
 * Blaetter tragen sie im Kopfblock.
 */
function ladeExcelHerunter() {
  const opt = xlsxOptionen();
  const alle = aktuelleJobs();
  const jobs = opt.alleStationen ? alle : alle.filter((j) => j.gruppe === aktiveGruppe);

  const blaetter = [];
  const waehrungen = [...new Set(jobs.map((j) => j.market.cur || ''))].filter(Boolean);

  if (opt.preise) {
    for (const w of waehrungen) {
      // Bei "alle Stationen" je Station ein Blatt: eine Tabelle, die zwei
      // Stationen uebereinanderlegt, verglichen zwei verschiedene Reisen.
      const gruppen = opt.alleStationen ? [...new Set(jobs.map((j) => j.gruppe))] : [aktiveGruppe];
      for (const g of gruppen) {
        const b = xlsxPreisblatt(jobs.filter((j) => j.gruppe === g), w, opt);
        // Die Währung nach vorn: Excel lässt nur 31 Zeichen zu, und beim
        // Abschneiden fiele sonst genau das weg, was die Blätter unterscheidet
        // aus zwei Währungen würden zwei gleich heissende Blätter.
        if (b) blaetter.push(waehrungen.length > 1 ? { ...b, name: `${w} · ${b.name}` } : b);
      }
    }
  }
  if (opt.schutz) {
    for (const w of waehrungen) {
      const b = xlsxSchutzblatt(jobs.filter((j) => j.gruppe === aktiveGruppe), w);
      if (b) blaetter.push(waehrungen.length > 1 ? { ...b, name: `${w} · ${b.name}` } : b);
    }
  }
  if (opt.kalender) {
    const b = xlsxKalenderblatt();
    if (b) blaetter.push(b);
  }

  if (!blaetter.length) {
    flash('Für diese Auswahl liegt nichts vor, was sich ausgeben ließe.');
    return;
  }

  const f = jobs.find((j) => j.gruppe === aktiveGruppe) || jobs[0];
  const name =
    `tracker-${(f?.station.name || 'vergleich').replace(/[^\wäöüÄÖÜß]+/g, '-').toLowerCase()}` +
    `-${f?.variant.pickupDate || ''}.xlsx`;

  const blob = mappe(blaetter, waehrungen[0] || 'EUR');
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  flash(`Als Excel gespeichert, ${blaetter.length} ${blaetter.length === 1 ? 'Blatt' : 'Blätter'}.`);
}

/* =========================================================== Preiskurve
 *
 * Die Frage, die kein Vergleichsportal ehrlich beantwortet: wird es billiger,
 * wenn ich warte? Sie laesst sich nur beantworten, indem man denselben Wagen
 * ueber Wochen beobachtet, der Dienst legt dafuer bei jedem Abruf einen
 * Messpunkt ab.
 */

let kurveGruppe = null;
let kurveKlasse = null;
let kurveGruppen = [];
let kurveBildAnfrage = 0;
/** Wie viel der Verlauf belegt, für die Zeile über der Liste. */
let kurveGroesse = null;
/** Suchbegriff und Filter der Reiseliste. */
let kurveNadel = '';
let kurveNurLaufend = false;
/**
 * Die Messpunkte der GEWÄHLTEN Reise, einmal geholt.
 *
 * Vorher wurde bei jedem Klassenwechsel neu abgefragt, obwohl sich die Reise
 * nicht geändert hat. Jetzt kommen alle Klassen einer Reise in einem Zug, und
 * das Umschalten ist nur noch ein Filter im Speicher.
 */
let kurveReise = null;

async function ladeKurve() {
  try {
    // Schlank: ohne die vollen Klassen-, Host- und Uhrzeitlisten. Die machten
    // zwei Drittel der Antwort aus und werden erst gebraucht, wenn eine Reise
    // gewählt ist.
    const d = await (await fetch('/api/verlauf/uebersicht?schlank=1')).json();
    kurveGruppen = d.gruppen || [];
    kurveGroesse = d.groesse || null;
  } catch {
    kurveGruppen = [];
    kurveGroesse = null;
  }
  renderKurve();
}

/** Die Messpunkte der gewählten Reise holen, samt Klassen- und Hostliste. */
async function ladeKurveReise(g) {
  const schluessel = `${g.station}|${g.von}|${g.bis}`;
  if (kurveReise?.schluessel === schluessel) return kurveReise;
  const p = new URLSearchParams({ station: g.station, von: g.von, bis: g.bis });
  try {
    const d = await (await fetch(`/api/verlauf?${p}`)).json();
    const punkte = (d.punkte || [])
      .filter((e) => Number.isFinite(e.p) && Number.isFinite(e.t))
      .sort((a, b) => a.t - b.t);
    kurveReise = {
      schluessel,
      punkte,
      klassen: [...new Set(punkte.map((e) => e.k))].sort(),
      hosts: [...new Set(punkte.map((e) => e.h))].sort(),
      // Uhrzeitpaare wie in der Übersicht. Altdaten ohne Uhrzeit wurden
      // damals um 10:00 gemessen, und genau das steht dann da.
      zeiten: [
        ...new Set(punkte.map((e) => `${e.z || '10:00'}|${e.zr || e.z || '10:00'}`)),
      ].sort(),
    };
  } catch {
    kurveReise = { schluessel, punkte: [], klassen: [], hosts: [], zeiten: [], fehler: true };
  }
  return kurveReise;
}

/**
 * Linien in ein SVG zeichnen.
 *
 * Von Hand statt mit einer Bibliothek: es ist eine Linie je Laenderseite auf
 * einer Zeitachse, und dafuer 300 kB Diagrammcode mitzuschleppen waere
 * unverhaeltnismaessig. Ausserdem kaeme die Bibliothek von einem fremden
 * Server, das Werkzeug laedt sonst nichts nach.
 */
function zeichneKurve(reihen, waehrung) {
  const B = 960;
  const H = 290;
  const links = 66;
  const unten = 36;
  const oben = 22;
  const rechts = 18;

  const alle = reihen.flatMap((r) => r.punkte);
  if (!alle.length) return null;

  const tMin = Math.min(...alle.map((p) => p.t));
  const tMax = Math.max(...alle.map((p) => p.t));
  const pMin = Math.min(...alle.map((p) => p.p));
  const pMax = Math.max(...alle.map((p) => p.p));
  // Etwas Luft nach oben und unten, sonst klebt die Linie am Rand.
  const spanne = Math.max(pMax - pMin, pMax * 0.05, 1);
  const yMin = Math.max(0, pMin - spanne * 0.15);
  const yMax = pMax + spanne * 0.15;

  const x = (t) => tMin === tMax ? (links + B - rechts) / 2 : links + ((t - tMin) / (tMax - tMin)) * (B - links - rechts);
  const y = (p) => oben + (1 - (p - yMin) / (yMax - yMin)) * (H - oben - unten);

  const svg = (tag, attrs, ...kinder) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    for (const kind of kinder.flat()) if (kind != null) n.append(kind);
    return n;
  };

  const farben = ['#0066cc', '#8172b2', '#418a87', '#c38b48', '#6b8dab', '#ba768c', '#566375', '#79935e'];

  // Waagerechte Hilfslinien mit Beschriftung, ohne die ist eine Kurve nur
  // eine Form, keine Aussage.
  const linien = [];
  for (let i = 0; i <= 3; i++) {
    const wert = yMin + ((yMax - yMin) * i) / 3;
    const yy = y(wert);
    linien.push(
      svg('line', { x1: links, y1: yy, x2: B - rechts, y2: yy, stroke: '#e8ebf0', 'stroke-width': 1, 'stroke-dasharray': '3 5' }),
      svg(
        'text',
        { x: links - 12, y: yy + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 12 },
        document.createTextNode(wert.toLocaleString('de-DE', { maximumFractionDigits: yMax - yMin < 1 ? 2 : yMax - yMin < 10 ? 1 : 0 }))
      )
    );
  }

  const pfade = reihen.map((r, i) => {
    const sortiert = [...r.punkte].sort((a, b) => a.t - b.t);
    const d = sortiert.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(' ');
    return svg(
      'g',
      {},
      reihen.length === 1 && sortiert.length > 1 ? svg('path', {
        d: `${d} L${x(sortiert.at(-1).t)},${H - unten} L${x(sortiert[0].t)},${H - unten} Z`,
        fill: '#0066cc', opacity: '.045',
      }) : null,
      svg('path', {
        d,
        fill: 'none',
        stroke: farben[i % farben.length],
        'stroke-width': 2.5,
        'stroke-dasharray': i >= farben.length ? '7 5' : 'none',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
      ...sortiert.map((p) =>
        svg(
          'circle',
          { cx: x(p.t).toFixed(1), cy: y(p.p).toFixed(1), r: 4, fill: farben[i % farben.length], stroke: '#fff', 'stroke-width': 1.5 },
          svg(
            'title',
            {},
            document.createTextNode(
              `${r.label}: ${money(p.p, waehrung)} am ${new Date(p.t).toLocaleDateString('de-DE')}`
            )
          )
        )
      )
    );
  });

  const zeitachse = (tMin === tMax ? [tMin] : [tMin, tMax]).map((t, i) =>
    svg(
      'text',
      {
        x: tMin === tMax ? x(t) : i ? B - rechts : links,
        y: H - 6,
        'text-anchor': tMin === tMax ? 'middle' : i ? 'end' : 'start',
        fill: 'var(--muted)',
        'font-size': 12,
      },
      document.createTextNode(new Date(t).toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
    )
  );

  const bild = svg(
    'svg',
    { viewBox: `0 0 ${B} ${H}`, class: 'kurve', role: 'img', 'aria-label': `Preisverlauf in ${waehrung || 'unbekannter Währung'} mit ${alle.length} ${alle.length === 1 ? 'Messpunkt' : 'Messpunkten'}. Letzte Preise stehen in der Legende.` },
    ...linien,
    ...pfade,
    ...zeitachse
  );

  const legende = el(
    'div',
    { class: 'kurvelegende' },
    ...reihen.map((r, i) =>
      el(
        'span',
        { class: 'trend-series' },
        el('span', { class: 'trend-series-name' }, el('i', { style: `background:${farben[i % farben.length]}`, 'aria-hidden': 'true' }), r.label),
        el('strong', {}, waehrung ? kalBetrag(r.punkte.at(-1).p, waehrung) : money(r.punkte.at(-1).p, '')),
        el('span', { class: 'trend-series-date' }, `Letzter Abruf: ${new Date(r.punkte.at(-1).t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`)
      )
    )
  );

  return el('div', {}, el('div', { class: 'trend-chart-scroll', tabindex: '0', role: 'region', 'aria-label': `Preisdiagramm ${waehrung || ''}, horizontal scrollbar` }, bild), legende);
}

async function renderKurveBild() {
  const anfrage = ++kurveBildAnfrage;
  const g = kurveGruppen.find((x) => `${x.station}|${x.von}|${x.bis}` === kurveGruppe);
  if (!g || !kurveKlasse) {
    $('#kurveKarte').hidden = true;
    return;
  }

  const klasse = kurveKlasse;
  $('#kurveTitel').textContent = `${klasse} · ${decodeAcriss(klasse)?.label || 'Deine Fahrzeugklasse'}`;
  $('#kurveUntertitel').textContent = `${stationByCode(g.station)?.name || 'Station ' + g.station} · ${pretty(g.von)} – ${pretty(g.bis)}`;
  $('#kurveKarte').hidden = false;
  $('#kurveBild').setAttribute('aria-busy', 'true');
  setChildren($('#kurveBild'), el('p', { class: 'empty trend-empty' }, 'Dein Preisverlauf wird geladen …'));
  $('#kurveNote').textContent = '';

  // Die Punkte der Reise liegen schon vor, geholt beim Umschalten der Reise.
  // Ein Klassenwechsel ist damit ein Filter im Speicher statt einer Abfrage.
  const reise = await ladeKurveReise(g);
  if (anfrage !== kurveBildAnfrage) return;
  $('#kurveBild').setAttribute('aria-busy', 'false');

  if (reise.fehler) {
    setChildren($('#kurveBild'), el('p', { class: 'empty trend-empty' }, 'Der Preisverlauf ist gerade nicht erreichbar. Öffne diese Ansicht erneut, um es noch einmal zu versuchen.'));
    return;
  }
  const punkte = reise.punkte.filter((e) => e.k === klasse);

  // Unterschiedliche Währungen erhalten jeweils eine eigene Skala und Kennzahlen.
  const nachWaehrung = new Map();
  for (const e of punkte) {
    const w = e.w || '';
    if (!nachWaehrung.has(w)) nachWaehrung.set(w, []);
    nachWaehrung.get(w).push(e);
  }
  if (!punkte.length) {
    setChildren(
      $('#kurveBild'),
      el(
        'p',
        { class: 'empty trend-empty' },
        'Für diese Klasse ist noch kein Preis aufgezeichnet. Der nächste Preisabruf ergänzt deinen Verlauf.'
      )
    );
    $('#kurveNote').textContent = '';
    return;
  }

  setChildren($('#kurveBild'), ...[...nachWaehrung].map(([waehrung, werte]) => {
    // Nach Länderseite, Abrufmodus *und* Uhrzeit getrennt. Alle drei ändern
    // den Preis, ohne dass Sixt etwas geändert hätte: mit und ohne Cookies
    // sind zwei Messreihen, und 12:30 gegen 13:30 lagen gemessen bis zu 57 %
    // auseinander. In eine Linie gelegt sähe jeder Wechsel aus wie eine
    // Preisänderung.
    const mehrereZeiten = new Set(werte.map((e) => `${e.z || ''}|${e.zr || ''}`)).size > 1;
    const nachHost = new Map();
    for (const e of werte) {
      const k = `${e.h}|${e.i ? 1 : 0}|${e.z || ''}|${e.zr || ''}`;
      if (!nachHost.has(k)) nachHost.set(k, []);
      nachHost.get(k).push(e);
    }
    const reihen = [...nachHost]
      .map(([k, pkt]) => {
        const [host, modus, ab, zurueck] = k.split('|');
        return {
          label:
            host.replace(/^www\./, '') +
            (modus === '1' ? ' · ohne Cookies' : '') +
            // Die Uhrzeit nur anschreiben, wo es mehr als eine gibt, sonst
            // stünde an jeder Linie eine Zahl, die nichts unterscheidet.
            (mehrereZeiten && ab ? ` · ${ab}${zurueck && zurueck !== ab ? `→${zurueck}` : ''}` : ''),
          punkte: pkt,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const tiefst = werte.reduce((a, b) => a.p <= b.p ? a : b);
    const letzte = reihen.map((r) => r.punkte.at(-1)).reduce((a, b) => a.p <= b.p ? a : b);
    const kennzahl = (label, wert, note) => el('div', { class: 'calendar-insight' },
      el('span', { class: 'calendar-insight-label' }, label),
      el('strong', { class: 'calendar-insight-value' }, wert),
      el('span', { class: 'calendar-insight-note' }, note));
    return el('section', { class: 'trend-currency', 'aria-label': `Preise in ${waehrung || 'unbekannter Währung'}` },
      el('div', { class: 'trend-currency-heading' }, el('h3', {}, `Preise in ${waehrung || 'unbekannter Währung'}`), el('span', {}, 'Aufgezeichnete Gesamtpreise')),
      el('div', { class: 'calendar-insights' },
        kennzahl('Bisheriger Tiefstpreis', waehrung ? kalBetrag(tiefst.p, waehrung) : money(tiefst.p, ''), `${tiefst.h.replace(/^www\./, '')} · ${new Date(tiefst.t).toLocaleDateString('de-DE')}`),
        kennzahl('Günstigster letzter Stand', waehrung ? kalBetrag(letzte.p, waehrung) : money(letzte.p, ''), `${letzte.h.replace(/^www\./, '')} · letzter Abruf je Seite`),
        kennzahl('Messpunkte', String(werte.length), `${reihen.length} Länderseite${reihen.length === 1 ? '' : 'n'}`)
      ),
      zeichneKurve(reihen, waehrung)
    );
  }));
  const spanne = Math.max(...punkte.map((e) => e.t)) - Math.min(...punkte.map((e) => e.t));
  const tage = Math.round(spanne / 86400000);
  $('#kurveNote').textContent =
    `${punkte.length} ${punkte.length === 1 ? 'Messpunkt' : 'Messpunkte'} über ${tage < 1 ? 'weniger als einen Tag' : tage === 1 ? 'einen Tag' : tage + ' Tage'}. ` +
    'Jeder Punkt ist ein Abruf. Verbundene Punkte zeigen die Entwicklung derselben Länderseite.' +
    (nachWaehrung.size > 1 ? ' Verschiedene Währungen werden getrennt dargestellt.' : '') +
    (punkte.some((e) => e.i) && punkte.some((e) => !e.i)
      ? ' Abrufe ohne Cookies stehen als eigene Reihe, sie sind mit den anderen nicht direkt vergleichbar.'
      : '') +
    (new Set(punkte.map((e) => `${e.z || ''}|${e.zr || ''}`)).size > 1
      ? ' Verschiedene Abholzeiten stehen als eigene Reihen: Sixt rechnet nach Uhrzeit ab, ' +
        'ein Zeitwechsel ist keine Preisänderung.'
      : '');
}

function renderKurve() {
  $('#kurveAnzahl').textContent = `${kurveGruppen.length} gespeicherte Reisen`;
  if (!kurveGruppen.length) {
    kurveGruppe = null;
    kurveKlasse = null;
    kurveBildAnfrage++;
    setChildren(
      $('#kurveWahl'),
      el(
        'p',
        { class: 'empty' },
        'Noch nichts aufgezeichnet. Nach dem ersten Preisabruf steht hier eine Suche zur Wahl.'
      )
    );
    $('#kurveKlassen').hidden = true;
    $('#kurveKarte').hidden = true;
    setChildren($('#kurveKontext'), el('p', { class: 'eyebrow' }, 'HIER BEGINNT DEIN VERLAUF'), el('h3', {}, 'Ein erster Preis. Der Anfang von mehr.'), el('p', {}, 'Starte einen Preisvergleich. Deine Reise erscheint anschließend hier.'));
    renderWecker();
    return;
  }

  if (!kurveGruppen.some((g) => `${g.station}|${g.von}|${g.bis}` === kurveGruppe)) {
    const erste = kurveGefiltert()[0] || kurveGruppen[0];
    kurveGruppe = `${erste.station}|${erste.von}|${erste.bis}`;
    kurveKlasse = null;
    kurveReise = null;
  }

  renderKurveListe();
  renderKurveDetail();
}

/**
 * Die Reisen, die dem Suchbegriff und dem Filter entsprechen.
 *
 * Gesucht wird über denselben Weg wie in der Stationsauswahl: `fold` zieht
 * Umlaute und Akzente glatt, `score` bewertet gestaffelt von "genauer Code"
 * bis "Teilfolge". Gesucht wird über den Stationsnamen und über die Daten,
 * damit "köln" und "10.10." beide zum Ziel führen.
 */
function kurveGefiltert() {
  const heute = new Date().toISOString().slice(0, 10);
  let liste = kurveGruppen;
  if (kurveNurLaufend) liste = liste.filter((g) => g.bis >= heute);

  const nadel = kurveNadel.trim();
  if (!nadel) return liste;

  let bewertet = liste
    .map((g) => {
      const name = stationByCode(g.station)?.name || `Station ${g.station}`;
      const text = `${name} ${pretty(g.von)} ${pretty(g.bis)} ${g.von} ${g.bis}`;
      return { g, punkte: score(text, '', nadel) };
    })
    .filter((x) => x.punkte >= 0);

  // Dieselbe Regel wie in der Stationssuche: gibt es echte Treffer, fliegen
  // die schwachen raus. `score` vergibt 100 schon dafür, dass die Buchstaben
  // irgendwo in dieser Reihenfolge vorkommen; ohne diese Regel stünden bei
  // "köln" auch Reisen, die nichts damit zu tun haben.
  const bestes = Math.max(0, ...bewertet.map((x) => x.punkte));
  if (bestes >= 500) bewertet = bewertet.filter((x) => x.punkte >= 500);

  bewertet.sort((a, b) => b.punkte - a.punkte || b.g.zuletzt - a.g.zuletzt);
  return bewertet.map((x) => x.g);
}

function renderKurveListe() {
  const treffer = kurveGefiltert();
  const heute = new Date().toISOString().slice(0, 10);
  const laufend = kurveGruppen.filter((g) => g.bis >= heute).length;

  // Die Scrollposition retten: die Liste wird beim Tippen neu gebaut, und ohne
  // das springt sie bei jedem Zeichen an den Anfang.
  const alteListe = $('#kurveTreffer');
  const scroll = alteListe ? alteListe.scrollTop : 0;

  setChildren(
    $('#kurveWahl'),
    el('input', {
      id: 'kurveSuche',
      type: 'search',
      class: 'premium-input',
      placeholder: 'Station oder Datum, z. B. köln',
      value: kurveNadel,
      autocomplete: 'off',
      oninput: (e) => {
        kurveNadel = e.target.value;
        renderKurveListe();
        $('#kurveSuche').focus({ preventScroll: true });
      },
    }),
    el(
      'label',
      { class: 'kurvefilter' },
      el('input', {
        type: 'checkbox',
        checked: kurveNurLaufend,
        onchange: (e) => {
          kurveNurLaufend = e.target.checked;
          renderKurveListe();
        },
      }),
      // Vergangene Reisen bleiben erreichbar, sie sind ja gemessen. Sie stehen
      // nur nicht mehr im Weg, wenn man die nächste Reise sucht.
      `nur laufende Reisen (${laufend} von ${kurveGruppen.length})`
    ),
    el(
      'div',
      { id: 'kurveTreffer', class: 'kurvetreffer', role: 'listbox' },
      ...(treffer.length
        ? treffer.slice(0, 80).map((g) => {
            const schluessel = `${g.station}|${g.von}|${g.bis}`;
            const gewaehlt = schluessel === kurveGruppe;
            return el(
              'button',
              {
                type: 'button',
                class: 'kurvereise' + (gewaehlt ? ' aktiv' : ''),
                role: 'option',
                'aria-selected': gewaehlt ? 'true' : 'false',
                onclick: () => {
                  if (schluessel === kurveGruppe) return;
                  kurveGruppe = schluessel;
                  kurveKlasse = null;
                  kurveReise = null;
                  renderKurveListe();
                  renderKurveDetail();
                },
              },
              el('span', { class: 'kreise' }, stationByCode(g.station)?.name || `Station ${g.station}`),
              el(
                'span',
                { class: 'kmeta' },
                `${pretty(g.von)} – ${pretty(g.bis)} · ${g.klassenAnzahl ?? g.klassen?.length ?? 0} Klassen · ${g.punkte} Messpunkte`
              )
            );
          })
        : [el('p', { class: 'empty' }, 'Keine Reise gefunden.')])
    ),
    treffer.length > 80
      ? el('p', { class: 'tabnote' }, `${treffer.length} Treffer, die ersten 80 werden gezeigt. Tippe genauer.`)
      : null,
    kurveGroesse ? kurveSpeicherzeile() : null
  );

  if (alteListe) $('#kurveTreffer').scrollTop = scroll;

  $('#kurveAnzahl').textContent =
    kurveNadel.trim() || kurveNurLaufend
      ? `${treffer.length} von ${kurveGruppen.length} Reisen`
      : `${kurveGruppen.length} gespeicherte Reisen`;
}

/**
 * Wie viel der Verlauf belegt, und der Weg, ihn auszudünnen.
 *
 * Steht sichtbar unter der Liste, weil diese Datei sonst unbemerkt wächst.
 * Gelöscht wird nie von selbst: erst wird gezählt und gefragt, dann erst
 * geschrieben. Die Messpunkte sind mühsam gesammelt und kommen nicht wieder.
 */
function kurveSpeicherzeile() {
  const mb = (kurveGroesse.bytes / 1024 / 1024).toFixed(1).replace('.', ',');
  return el(
    'p',
    { class: 'kurvespeicher' },
    `${kurveGroesse.punkte.toLocaleString('de-DE')} Messpunkte · ${mb} MB`,
    el(
      'button',
      {
        type: 'button',
        class: 'linkknopf',
        onclick: async (e) => {
          const knopf = e.currentTarget;
          knopf.disabled = true;
          try {
            const frage = await (
              await fetch('/api/verlauf/ausduennen', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ vorTagen: 30 }),
              })
            ).json();
            if (!frage.ok) return flash(frage.error || 'Ging nicht.');
            if (!frage.entfernt) {
              return flash('Es gibt nichts auszudünnen. Alle Punkte sind jünger als 30 Tage oder einzigartig.');
            }
            const ja = confirm(
              `${frage.entfernt.toLocaleString('de-DE')} Messpunkte entfernen?\n\n` +
                `Betroffen sind nur Punkte, die älter als 30 Tage sind und von denen es am selben Tag ` +
                `für dieselbe Reihe mehrere gibt. Je Tag bleibt der erste stehen, die Kurve behält ihre Form.\n\n` +
                `Danach: ${frage.nachher.toLocaleString('de-DE')} statt ${frage.vorher.toLocaleString('de-DE')} Punkte.\n\n` +
                `Das lässt sich nicht rückgängig machen.`
            );
            if (!ja) return;
            const erg = await (
              await fetch('/api/verlauf/ausduennen', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ vorTagen: 30, bestaetigt: true }),
              })
            ).json();
            flash(
              erg.ok
                ? `${erg.entfernt.toLocaleString('de-DE')} Punkte entfernt, ${erg.nachher.toLocaleString('de-DE')} bleiben.`
                : erg.error || 'Ging nicht.'
            );
            kurveReise = null;
            await ladeKurve();
          } catch {
            flash('Der Preisdienst antwortet nicht.');
          } finally {
            knopf.disabled = false;
          }
        },
      },
      'ausdünnen'
    )
  );
}

async function renderKurveDetail() {
  const g = kurveGruppen.find((x) => `${x.station}|${x.von}|${x.bis}` === kurveGruppe);
  if (!g) return;

  setChildren($('#kurveKontext'),
    el('span', { class: 'feature-symbol', 'aria-hidden': 'true', html: '<svg class="icon"><use href="#i-chart"/></svg>' }),
    el('p', { class: 'eyebrow' }, 'DEINE REISE IM FOKUS'),
    el('h3', {}, stationByCode(g.station)?.name || `Station ${g.station}`),
    el('p', {}, `${pretty(g.von)} – ${pretty(g.bis)} · ${daysBetween(g.von, g.bis)} Tage`),
    el('div', { class: 'trend-context-meta' },
      el('span', {}, `${g.hostsAnzahl ?? g.hosts?.length ?? 0} Länderseite${(g.hostsAnzahl ?? g.hosts?.length) === 1 ? '' : 'n'}`),
      el('span', {}, `${g.klassenAnzahl ?? g.klassen?.length ?? 0} Fahrzeugklasse${(g.klassenAnzahl ?? g.klassen?.length) === 1 ? '' : 'n'}`))
  );

  const reise = await ladeKurveReise(g);
  // Zwischendurch umgeschaltet? Dann gehört diese Antwort nicht mehr hierher.
  if (`${g.station}|${g.von}|${g.bis}` !== kurveGruppe) return;

  if (!reise.klassen.includes(kurveKlasse)) kurveKlasse = reise.klassen[0] || null;

  $('#kurveKlassen').hidden = !reise.klassen.length;
  setChildren(
    $('#kurveKlassenPillen'),
    el('select', { id: 'kurveKlasseWahl', name: 'fahrzeugklasse', class: 'premium-select', onchange: (e) => {
      kurveKlasse = e.target.value;
      // Nur das Diagramm, nicht die Reiseliste: die hat sich nicht geändert.
      renderKurveBild();
      $('#kurveKlasseWahl').focus({ preventScroll: true });
    } }, ...reise.klassen.map((k) =>
      el(
        'option',
        {
          value: k,
          selected: k === kurveKlasse,
        },
        `${k}, ${decodeAcriss(k)?.label || 'Fahrzeugklasse'}`
      )
    ))
  );

  renderKurveBild();
  // Der Kalender ist ein eigener Bereich geworden, hier hat er nichts mehr
  // zu suchen.
  renderWecker();
}

/* =========================================================== Monatsübersicht
 *
 * Die Datums-Matrix im Vergleich kann dasselbe rechnen, was fehlte, war die
 * Darstellung. Dreissig Zahlen in einer Tabelle sagen einem nichts; dieselben
 * dreissig als eingefaerbter Kalender sagen sofort, dass der Dienstag billig
 * und das Wochenende teuer ist.
 *
 * Eine Laenderseite, eine Klasse, eine Dauer je Durchlauf: das sind dreissig
 * Abrufe. Alle Laenderseiten gleichzeitig waeren neunhundert, das waere
 * weder gegenueber Sixt in Ordnung noch gegenueber dem Nutzer, der eine
 * halbe Stunde wartet.
 */

/**
 * Vorgeschlagene Mietdauern.
 *
 * Bis 7 Tage jeder einzelne Tag, danach in Sprüngen, wie Mietwagen tatsächlich
 * gebucht werden: Wochen, drei Wochen, ein Monat. Was hier fehlt, trägt man
 * unter "Andere Dauer" von Hand ein.
 */
const KAL_DAUERN = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 27, 28, 30];

/** Grenzen für die frei eingetragene Dauer. */
const KAL_DAUER_MIN = 1;
const KAL_DAUER_MAX = 90;
const KAL_SPANNEN = [7, 14, 21, 28, 35, 42, 56];

let kalLaeuft = false;
let kalKlassen = [];
let kalKatalog = {};
let kalKatalogOrt = '';
let kalTagAuswahl = null;

/** Die aktuelle Einstellung als Auftragsliste. */
function kalJobs() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.kalender.start)) return null;
  const station = stationByCode(state.kalender.station);
  if (!station) return null;

  const host = state.kalender.host;
  const markt = providerById(PROVIDER).markets.find((m) => m.host === host);
  if (!markt) return null;

  const jobs = [];
  for (let i = 0; i < state.kalender.spanne; i++) {
    const ab = addDays(state.kalender.start, i);
    const bis = addDays(ab, state.kalender.dauer);
    for (const z of kalZeitVarianten()) {
      // Die Uhrzeit gehoert in die Variante, nicht bloss in den Auftrag: sonst
      // fiele jobKey auf state.pickupTime zurueck, die Zeit des
      // Preisvergleichs, und ein Wechsel der Kalenderzeit aenderte den
      // Schluessel nicht. Man saehe dann den alten Preis fuer eine andere Zeit.
      const v = {
        pickupDate: ab,
        returnDate: bis,
        duration: state.kalender.dauer,
        pickupTime: z.ab,
        returnTime: z.zurueck,
      };
      jobs.push({
        key: jobKey(host, station.code, v, null, state.kalender.inkognito),
        provider: PROVIDER,
        host,
        stationCode: station.code,
        pickupDate: ab,
        returnDate: bis,
        pickupTime: z.ab,
        returnTime: z.zurueck,
        currency: markt.cur,
        inkognito: state.kalender.inkognito || undefined,
      });
    }
  }
  return { jobs, station, markt, zeiten: kalZeitVarianten() };
}

/**
 * Die Uhrzeitpaare des Kalenders.
 *
 * Dieselbe Ueberlegung wie beim Preisvergleich, mit einem Unterschied im
 * Gewicht: hier multipliziert jede Zeit die ganze Spanne. 56 Abholtage mal
 * drei Uhrzeiten sind 168 Abrufe. Deshalb sagt die Oberflaeche die Zahl vorher
 * an, statt sie herauszufinden zu lassen.
 */
function kalZeitVarianten() {
  const paare = [{ ab: state.kalender.zeit, zurueck: state.kalender.zeit }];
  for (const z of state.kalender.zeiten || []) {
    if (!/^\d{2}:\d{2}$/.test(z.ab) || !/^\d{2}:\d{2}$/.test(z.zurueck)) continue;
    if (paare.some((p) => p.ab === z.ab && p.zurueck === z.zurueck)) continue;
    paare.push({ ab: z.ab, zurueck: z.zurueck });
  }
  return paare;
}

function renderKalZeiten() {
  const liste = state.kalender.zeiten || [];
  setChildren(
    $('#kalZeitenListe'),
    ...liste.map((z, i) =>
      el(
        'div',
        { class: 'zeitzeile' },
        el('span', { class: 'zlabel' }, `Zeit ${i + 2}`),
        el('input', {
          type: 'time',
          step: '900',
          value: z.ab,
          'aria-label': `Abholzeit ${i + 2}`,
          onchange: (e) => {
            state.kalender.zeiten[i].ab = e.target.value;
            kalTagAuswahl = null;
            persist();
            renderKalFormular();
            renderKalBild();
          },
        }),
        el('span', { class: 'zpfeil', 'aria-hidden': 'true' }, '→'),
        el('input', {
          type: 'time',
          step: '900',
          value: z.zurueck,
          'aria-label': `Rückgabezeit ${i + 2}`,
          onchange: (e) => {
            state.kalender.zeiten[i].zurueck = e.target.value;
            kalTagAuswahl = null;
            persist();
            renderKalFormular();
            renderKalBild();
          },
        }),
        el(
          'button',
          {
            type: 'button',
            class: 'ghost mini',
            title: 'Diese Uhrzeit entfernen',
            onclick: () => {
              state.kalender.zeiten.splice(i, 1);
              kalTagAuswahl = null;
              persist();
              renderKalFormular();
              renderKalBild();
            },
          },
          '×'
        )
      )
    )
  );

  const n = kalZeitVarianten().length;
  const abrufe = n * state.kalender.spanne;
  $('#kalZeitenHinweis').textContent =
    n === 1
      ? 'Nur die Abholzeit oben.'
      : `${n} Uhrzeiten × ${state.kalender.spanne} Abholtage = ${abrufe} Abrufe, rund ${minutenText(abrufe)}.`;
  if (liste.length && !$('#kalZeitenBereich').open) $('#kalZeitenBereich').open = true;
}

/**
 * Der beste Preis eines Abholtags ueber alle Uhrzeiten.
 *
 * Der Kalender zeigt eine Zahl je Tag. Bei mehreren Uhrzeiten ist die richtige
 * Zahl die guenstigste, und dazu, welche Uhrzeit sie war. Ohne die zweite
 * Angabe waere die erste unbrauchbar: man wuesste den Preis, aber nicht, wann
 * man ihn bekommt.
 */
function kalTagBester(jobsDesTages) {
  let bester = null;
  let offen = 0;
  /** Warum es keinen Preis gibt, falls es keinen gibt. */
  let grund = null;
  for (const j of jobsDesTages) {
    const p = kalPreis(j);
    if (p.preis == null) {
      if (!p.geladen) offen++;
      // Den Grund mitnehmen statt wegzuwerfen: sonst steht am Tag "Noch nicht
      // abgerufen", obwohl die Station geantwortet hat, dass sie an dem Tag
      // nichts anbietet. Das ist ein Unterschied, den man sehen muss.
      else if (!grund && p.grund) grund = p.grund;
      continue;
    }
    // `uhr`, nicht `zeit`: `zeit` ist im Preisergebnis schon der Zeitpunkt der
    // Messung. Zwei Bedeutungen unter einem Namen sind ein Fehler auf Vorrat.
    if (!bester || p.preis < bester.preis) bester = { ...p, uhr: j.pickupTime, rueckUhr: j.returnTime, job: j };
  }
  return bester || { geladen: offen === 0, preis: null, uhr: null, grund };
}

/** Welche Klassen sind an dieser Station schon einmal gesehen worden? */
async function ladeKalKlassen() {
  const station = stationByCode(state.kalender.station);
  if (!station) {
    kalKlassen = [];
    kalKatalog = {};
    kalKatalogOrt = '';
    return true;
  }
  const host = state.kalender.host;
  const ort = `${station.code}|${host}`;
  let klassen = {};
  try {
    const r = await fetch(
      `/api/katalog?provider=${PROVIDER}&station=${encodeURIComponent(station.code)}` +
        `&hosts=${encodeURIComponent(host)}`
    );
    const d = await r.json();
    klassen = d.klassen || {};
  } catch {
    /* Ohne Katalog bleibt die Auswahl der günstigsten Klasse möglich. */
  }
  // Eine langsame Antwort darf nach einem Stationswechsel kein altes Bild zeigen.
  if (`${state.kalender.station}|${state.kalender.host}` !== ort) return false;
  kalKatalog = klassen;
  kalKatalogOrt = ort;
  kalKlassen = Object.keys(klassen).sort();
  return true;
}

/** Das Beispiel gehört zur Klasse der Kalenderstation, nicht zur Hauptsuche. */
function renderKalFahrzeug() {
  const k = state.kalender;
  const box = $('#kalFahrzeug');
  const info = kalKatalogOrt === `${k.station}|${k.host}` ? kalKatalog[k.klasse] : null;
  const modell = info?.modelle?.[0] || (k.klasse ? 'Deine Fahrzeugklasse' : 'Offen für das beste Angebot.');
  const bild = info?.bild || '';
  const beschreibung = info?.beispielText || decodeAcriss(k.klasse)?.label || '';
  const signatur = JSON.stringify([k.station, k.host, k.klasse, modell, bild, beschreibung]);
  if (box.dataset.signatur === signatur) return;
  box.dataset.signatur = signatur;

  const platzhalter = el('div', { class: 'kal-vehicle-placeholder', hidden: Boolean(bild) },
    el('span', { html: '<svg class="icon" aria-hidden="true"><use href="#i-car"/></svg>' }),
    k.klasse ? 'Kein Fahrzeugbild verfügbar' : 'Jeden Tag die günstigste Klasse'
  );
  const foto = bild ? el('img', {
    class: 'kal-vehicle-image', src: bild, width: 400, height: 266,
    alt: `${modell} – Beispielfahrzeug für ${k.klasse}`,
    onerror: (e) => { e.target.hidden = true; platzhalter.hidden = false; },
  }) : null;
  setChildren(box,
    el('p', { class: 'eyebrow' }, k.klasse ? 'DEIN BEISPIELFAHRZEUG' : 'DEINE AUSWAHL'),
    el('h3', { class: 'kal-vehicle-model' }, modell),
    el('div', { class: 'kal-vehicle-media' }, foto, platzhalter),
    k.klasse ? el('div', { class: 'kal-vehicle-class' }, el('span', { class: 'acriss' }, k.klasse), beschreibung) : null,
    el('p', { class: 'kal-vehicle-note' }, k.klasse
      ? 'Beispiel aus dieser Klasse. Das tatsächliche Modell kann abweichen.'
      : 'Wir vergleichen je Abholtag das günstigste Angebot. Modell und Fahrzeugklasse können wechseln.')
  );
}

function renderKalFormular() {
  const k = state.kalender;

  // Länderseiten
  const host = $('#kalHost');
  if (!host.options.length) {
    setChildren(
      host,
      // Gestörte Länderseiten stehen im Monatskalender nicht zur Wahl: ein
      // ganzer Monat Fehlschläge wäre nur Wartezeit.
      ...providerById(PROVIDER)
        .markets.filter((m) => !m.gestoert)
        .map((m) => el('option', { value: m.host }, `${m.label} (${m.cur})`))
    );
  }
  host.value = k.host;

  // Klassen: billigste zuerst, dann alles, was der Katalog kennt
  setChildren(
    $('#kalKlasse'),
    el('option', { value: '' }, 'Billigste Klasse des Tages'),
    ...kalKlassen.map((c) => {
      const d = decodeAcriss(c);
      return el('option', { value: c }, d ? `${c}, ${d.label}` : c);
    })
  );
  $('#kalKlasse').value = kalKlassen.includes(k.klasse) ? k.klasse : '';
  if (!kalKlassen.includes(k.klasse)) k.klasse = '';
  renderKalFahrzeug();

  // Eine selbst eingetragene Dauer steht mit in der Liste, sonst spränge die
  // Auswahl beim nächsten Zeichnen auf einen der Vorschläge zurück.
  const dauern = KAL_DAUERN.includes(k.dauer)
    ? KAL_DAUERN
    : [...KAL_DAUERN, k.dauer].sort((a, b) => a - b);
  setChildren(
    $('#kalDauer'),
    ...dauern.map((n) => el('option', { value: n }, `${n} ${n === 1 ? 'Tag' : 'Tage'}`)),
    el('option', { value: 'frei' }, 'Andere Dauer …')
  );
  $('#kalDauer').value = String(k.dauer);
  // Das Eingabefeld bleibt stehen, solange eine eigene Dauer eingestellt ist,
  // sonst verschwände der Wert aus dem Blick, obwohl er gilt.
  const eigene = !KAL_DAUERN.includes(k.dauer);
  $('#kalDauerFrei').hidden = !eigene;
  if (eigene) $('#kalDauerFrei').value = String(k.dauer);

  setChildren(
    $('#kalSpanne'),
    ...KAL_SPANNEN.map((n) => el('option', { value: n }, `${n} Abholtage`))
  );
  $('#kalSpanne').value = String(k.spanne);

  $('#kalStart').value = k.start;
  $('#kalZeit').value = k.zeit;
  $('#kalInkognito').checked = Boolean(k.inkognito);
  renderKalZeiten();

  const station = stationByCode(k.station);
  $('#kalStationGewaehlt').textContent = station
    ? `Gewählt: ${station.name} (Nr. ${station.code})`
    : 'Noch keine Station gewählt.';

  const { offen, bestaetigtLeer, ausAufzeichnung, aeltester } = station
    ? kalStand()
    : { offen: [], bestaetigtLeer: 0, ausAufzeichnung: 0, aeltester: null };
  const minuten = Math.ceil((Math.max(offen.length, 1) * 7) / 60);
  // Wie alt der älteste angezeigte Wert ist. Ohne diese Angabe sieht ein Preis
  // von letzter Woche genauso aus wie einer von eben.
  const altText = alter(aeltester);

  $('#kalHinweis').textContent = !station
    ? 'Bitte zuerst eine Station wählen.'
    : offen.length
      // Bei mehreren Uhrzeiten sind Abrufe und Tage nicht mehr dasselbe,
      // "21 von 7 Tagen" wäre Unsinn.
      ? (kalZeitVarianten().length > 1
          ? `${offen.length} von ${k.spanne * kalZeitVarianten().length} Abrufen fehlen noch ` +
            `(${k.spanne} Abholtage × ${kalZeitVarianten().length} Uhrzeiten), rund `
          : `${offen.length} von ${k.spanne} Tagen fehlen noch, rund `) +
        `${minuten} ${minuten === 1 ? 'Minute' : 'Minuten'}.`
      : bestaetigtLeer
        // Ohne Klassenwahl stand hier "gibt es  nicht" mit einer Lücke, wo der
        // Klassenname fehlte. Ohne gewählte Klasse ist die Aussage ohnehin eine
        // andere: dann bietet die Station an dem Tag überhaupt nichts an.
        ? k.klasse
          ? `Alle Tage geprüft. An ${bestaetigtLeer} davon gibt es ${k.klasse} nicht.`
          : `Alle Tage geprüft. An ${bestaetigtLeer} davon bietet die Station nichts an.`
        : ausAufzeichnung
          ? `Alle Tage liegen vor, ${ausAufzeichnung} davon aus dem gespeicherten ` +
            `Preisverlauf${altText ? `, ältester Wert ${altText}` : ''}.`
          : 'Alle Tage liegen vor, frisch abgerufen.';

  // Ist nichts mehr offen, wird aus dem Knopf kein toter Knopf, sondern das
  // Mittel gegen alte Zahlen: alles noch einmal messen.
  const nurNeu = station && !kalLaeuft && !offen.length;
  $('#kalStart2').disabled = !station || kalLaeuft;
  $('#kalStart2').textContent = kalLaeuft
    ? 'Preise werden geladen …'
    : nurNeu
      ? `Alle ${k.spanne} Tage neu messen`
      : 'Preise im Kalender finden';
  $('#kalStart2').title = nurNeu
    ? 'Verwirft die angezeigten Werte für diesen Zeitraum und ruft jeden Tag frisch ab. ' +
      'Der gespeicherte Preisverlauf bleibt vollständig erhalten.'
    : '';
  $('#kalStart2').dataset.neu = nurNeu ? '1' : '';
  $('#kalAbbrechen').hidden = !kalLaeuft;

  // Zweiter Durchgang: erst nach dem ersten Lauf steht die Klassenliste zur
  // Verfügung, und eine dort gewählte Klasse hat oft Lücken. Der Knopf holt
  // genau die Tage nach, die noch nie frisch abgerufen wurden, und macht
  // damit den Unterschied sichtbar zwischen "dort wirklich nicht buchbar" und
  // "beim ersten Mal nicht mitgekommen". Sind alle geprüft, verschwindet er,
  // statt dieselben Tage endlos anzubieten.
  const nach = $('#kalNachfassen');
  nach.hidden = !station || kalLaeuft || !offen.length || !k.klasse;
  nach.textContent = `${offen.length} fehlende Tage nachholen`;
}

function renderKalStationSuche() {
  const needle = $('#kalStation').value;
  const feld = $('#kalStationTreffer');
  if (!needle.trim()) {
    feld.hidden = true;
    return;
  }
  const hits = suche(needle, 30);
  feld.hidden = false;
  setChildren(
    feld,
    ...hits.map((s) =>
      el(
        'button',
        {
          type: 'button',
          class: 'station' + (s.code === state.kalender.station ? ' on' : ''),
          onclick: async () => {
            state.kalender.station = s.code;
            kalTagAuswahl = null;
            $('#kalStation').value = '';
            feld.hidden = true;
            persist();
            renderKalFahrzeug();
            if (!(await ladeKalKlassen())) return;
            await ladeKalAufzeichnung();
            renderKalFormular();
            renderKalBild();
          },
        },
        el('span', { class: 'flag' }, s.country),
        el('span', { class: 'sname' }, s.name),
        el('span', { class: 'art' }, s.flughafen ? 'ap' : 'dt')
      )
    ),
    hits.length ? null : el('p', { class: 'empty' }, 'Keine Station gefunden.')
  );
}

/**
 * Aufgezeichnete Messpunkte fuer die Monatsuebersicht.
 *
 * Die Ergebnisse im Dienst verfallen nach einer Stunde, und ein Neuladen der
 * Seite loescht ohnehin alles im Arbeitsspeicher. Ein Kalender, fuer den man
 * vier Minuten gewartet hat, war danach leer. Die Messpunkte liegen aber
 * dauerhaft in preisverlauf.jsonl, von dort wird er wieder aufgebaut.
 *
 * Schluessel: "Abholdatum|ACRISS" -> Preis. Bei mehreren Messungen desselben
 * Tages gewinnt die juengste.
 */
let kalAufzeichnung = new Map();

async function ladeKalAufzeichnung() {
  kalAufzeichnung = new Map();
  const station = stationByCode(state.kalender.station);
  if (!station) return;

  try {
    const p = new URLSearchParams({ station: station.code, host: state.kalender.host });
    const d = await (await fetch(`/api/verlauf?${p}`)).json();
    const zeiten = new Map();
    for (const e of d.punkte || []) {
      // Nur Messungen mit derselben Mietdauer, ein Preis fuer sieben Tage
      // gehoert nicht in einen Kalender fuer drei.
      if (daysBetween(e.v, e.b) !== state.kalender.dauer) continue;
      // Und nur Messungen aus demselben Modus: ein Preis mit Cookies gehört
      // nicht in einen Kalender ohne. Ältere Messungen tragen kein Merkmal,
      // die zählen als "mit Cookies", denn so wurde damals gemessen.
      if (Boolean(e.i) !== Boolean(state.kalender.inkognito)) continue;
      const k = `${e.v}|${e.k}`;
      if (!zeiten.has(k) || e.t > zeiten.get(k)) {
        zeiten.set(k, e.t);
        // Der Zeitpunkt gehört dazu: ein Preis von vorletzter Woche sieht im
        // Kalender genauso aus wie einer von eben, und das ist der Unterschied,
        // auf den es ankommt.
        kalAufzeichnung.set(k, { preis: e.p, waehrung: e.w, zeit: e.t });
      }
    }
  } catch {
    /* ohne Aufzeichnung zeigt der Kalender eben nur die frischen Abrufe */
  }
}

/** Der Preis eines Tages, je nach Wahl die Klasse oder das billigste Angebot. */
function kalPreis(job) {
  const klasse = state.kalender.klasse;
  const r = prices.get(job.key);

  // Frischer Abruf hat Vorrang: er ist der aktuellere Stand.
  if (r) {
    const angebote = r.offers || [];
    // Reihenfolge mit Absicht: der Fehler zuerst, dann Sixts eigene Auskunft,
    // erst zuletzt die nichtssagende Ersatzformel.
    if (!angebote.length) {
      return { geladen: true, preis: null, grund: r.error || r.note || 'kein Angebot' };
    }

    if (klasse) {
      const t = angebote.find((o) => o.acriss === klasse);
      if (t?.total != null) return { geladen: true, preis: t.total, modell: t.model };
      return { geladen: true, preis: null, grund: 'Klasse an dem Tag nicht im Angebot' };
    }
    const billigstes = angebote
      .filter((o) => o.total != null)
      .reduce((a, b) => (b.total < a.total ? b : a), { total: Infinity });
    return billigstes.total === Infinity
      ? { geladen: true, preis: null }
      : { geladen: true, preis: billigstes.total, modell: billigstes.model, acriss: billigstes.acriss };
  }

  // Die Aufzeichnung kennt keine Uhrzeit: sie haelt Datum, Dauer und Klasse
  // fest, mehr nicht. Solange nur eine Uhrzeit eingestellt ist, macht das
  // nichts. Bei mehreren waere es falsch, jede Zeit bekaeme denselben
  // gespeicherten Wert, und "beste Uhrzeit" waere geraten. Dann zaehlt nur
  // der frische Abruf.
  if (kalZeitVarianten().length > 1) return { geladen: false, preis: null };

  // Sonst aus der Aufzeichnung. Ohne Klassenwahl ist das der billigste
  // aufgezeichnete Wert dieses Tages.
  if (klasse) {
    const a = kalAufzeichnung.get(`${job.pickupDate}|${klasse}`);
    if (a) return { geladen: true, preis: a.preis, ausAufzeichnung: true, zeit: a.zeit || null };
    // Wurde der Tag ueberhaupt schon einmal gemessen?
    const gemessen = [...kalAufzeichnung.keys()].some((k) => k.startsWith(job.pickupDate + '|'));
    return {
      geladen: gemessen,
      preis: null,
      grund: gemessen ? 'Klasse an dem Tag nicht gemessen' : null,
    };
  }

  let min = Infinity;
  let zeit = null;
  for (const [k, v] of kalAufzeichnung) {
    if (k.startsWith(job.pickupDate + '|') && v.preis < min) {
      min = v.preis;
      zeit = v.zeit || null;
    }
  }
  return min === Infinity
    ? { geladen: false, preis: null }
    : { geladen: true, preis: min, ausAufzeichnung: true, zeit };
}

/**
 * "Vor drei Tagen" statt eines Zeitstempels.
 *
 * Bei einem gespeicherten Preis ist die Frage nicht, wann genau er gemessen
 * wurde, sondern ob er noch etwas taugt.
 */
function alter(zeit) {
  if (!zeit) return null;
  const min = Math.round((Date.now() - zeit) / 60000);
  if (min < 2) return 'gerade eben';
  if (min < 60) return `vor ${min} Minuten`;
  const std = Math.round(min / 60);
  if (std < 24) return `vor ${std} ${std === 1 ? 'Stunde' : 'Stunden'}`;
  const tage = Math.round(std / 24);
  if (tage < 30) return `vor ${tage} ${tage === 1 ? 'Tag' : 'Tagen'}`;
  return `am ${new Date(zeit).toLocaleDateString('de-DE')}`;
}

/**
 * Wo bei der aktuellen Wahl noch etwas fehlt, und wo nicht mehr.
 *
 * Der Unterschied ist der Kern des zweiten Durchgangs: ein Tag ohne Preis
 * kann heissen "noch nicht nachgesehen" oder "nachgesehen, gibt es dort
 * nicht". Nur das erste lohnt einen weiteren Abruf. Ohne diese Trennung
 * bietet der Knopf immer wieder dieselben Tage an, die schon zweimal
 * geprueft wurden.
 */
function kalStand() {
  const d = kalJobs();
  if (!d) return { offen: [], bestaetigtLeer: 0, ausAufzeichnung: 0, aeltester: null };

  const offen = [];
  let bestaetigtLeer = 0;
  let ausAufzeichnung = 0;
  let aeltester = null;
  for (const j of d.jobs) {
    const p = kalPreis(j);
    if (p.preis != null) {
      // Woher der Wert kommt, entscheidet, ob ein neuer Abruf etwas bringt.
      if (p.ausAufzeichnung) {
        ausAufzeichnung++;
        if (p.zeit && (aeltester == null || p.zeit < aeltester)) aeltester = p.zeit;
      }
      continue;
    }
    // Ein frischer Abruf liegt vor und enthaelt die Klasse trotzdem nicht:
    // damit ist die Frage beantwortet.
    if (prices.has(j.key)) bestaetigtLeer++;
    else offen.push(j);
  }
  return { offen, bestaetigtLeer, ausAufzeichnung, aeltester };
}

/**
 * Alles noch einmal messen.
 *
 * Der Kalender fuellt sonst nur Luecken: was schon im gespeicherten
 * Preisverlauf steht, gilt als erledigt, und der Knopf ist tot. Nach ein paar
 * Tagen sieht man dann alte Zahlen und hat kein Mittel dagegen.
 *
 * Geloescht wird nur die Anzeige dieses Kalenders, der Preisverlauf selbst
 * bleibt vollstaendig. Er ist die Grundlage der Preisentwicklung; ihn
 * wegzuwerfen, um eine Ansicht aufzufrischen, waere ein schlechter Tausch.
 */
async function kalNeuMessen() {
  const d = kalJobs();
  if (!d) return;
  for (const j of d.jobs) prices.delete(j.key);
  kalAufzeichnung = new Map();
  kalTagAuswahl = null;
  // Auch beim Dienst wegraeumen, sonst kaemen die alten Werte beim naechsten
  // Takt gleich wieder herein.
  await fetch('/api/results/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: d.jobs.map((j) => j.key) }),
  }).catch(() => {});
  renderKalFormular();
  renderKalBild();
  await starteKalender();
}

function kalBetrag(preis, waehrung) {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: waehrung, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(preis);
}

function kalDatum(datum, lang = false) {
  return new Date(datum + 'T12:00:00').toLocaleDateString('de-DE', {
    weekday: lang ? 'long' : 'short', day: 'numeric', month: lang ? 'long' : 'short',
    ...(lang ? { year: 'numeric' } : {}),
  });
}

/**
 * Die Klassenwahl am Kalender selbst.
 *
 * Dieselbe Einstellung wie oben im Formular, nur dort, wo man hinsieht. Der
 * Wechsel kostet keinen Abruf: die Angebote aller Klassen liegen im Ergebnis,
 * die Klasse sucht nur aus, welches davon gezeigt wird. Deshalb reagiert es
 * ohne Warten, und deshalb ist das Hoch- und Runterscrollen überflüssig.
 */
function renderKalKlassenleiste(tage, mitPreis) {
  const wahl = $('#kalKlasse2');

  // Optionen nur neu bauen, wenn sie sich geändert haben, sonst springt die
  // Auswahl bei jedem Neuzeichnen zu.
  const soll = ['', ...kalKlassen].join('|');
  if (wahl.dataset.stand !== soll) {
    wahl.dataset.stand = soll;
    setChildren(
      wahl,
      el('option', { value: '' }, 'Günstigste Klasse des Tages'),
      ...kalKlassen.map((c) => {
        const d = decodeAcriss(c);
        return el('option', { value: c }, d ? `${c}, ${d.label}` : c);
      })
    );
  }
  wahl.value = state.kalender.klasse || '';

  // Wie viele Tage diese Klasse überhaupt hat. Beim Durchschalten ist das die
  // wichtigste Nebeninformation: eine Klasse, die es an neun von 28 Tagen gibt,
  // sieht im Kalender aus wie ein kaputter Abruf.
  $('#kalKlasseHinweis').textContent =
    mitPreis === tage
      ? `an allen ${tage} Tagen verfügbar`
      : `an ${mitPreis} von ${tage} Tagen verfügbar`;
}

/** Klasse gewechselt, neu zeichnen, nicht neu abrufen. */
function wechsleKalKlasse(wert) {
  state.kalender.klasse = wert;
  kalTagAuswahl = null;
  persist();
  renderKalFormular();
  renderKalBild();
  // Zurück zum Kalender, nicht zum Formular: der Wechsel kam von hier.
  $('#kalBild')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Einen Kalendertag in den Preisvergleich übernehmen.
 *
 * Der Kalender beantwortet "wann", der Preisvergleich "wo und mit welchem
 * Schutz". Ohne diesen Weg müsste man Station und beide Daten von Hand
 * abtippen, und tippt sich dabei irgendwann vertan.
 */
function uebernehmeKalendertag(job) {
  state.stations = [state.kalender.station];
  state.returnStation = null;
  state.pickupDate = job.pickupDate;
  state.returnDate = job.returnDate;
  state.pickupTime = state.kalender.zeit;
  state.returnTime = state.kalender.zeit;
  state.dayShifts = [0];
  state.returnShifts = [0];
  state.durations = [];
  // Die Länderseite des Kalenders ist vorgewählt, sie ist die, auf die man
  // gerade geschaut hat. Weitere kommen gleich dazu: der Bereich geht offen
  // auf, statt die Auswahl hinter einem zugeklappten Reiter zu verstecken.
  const markt = providerById(PROVIDER).markets.find((m) => m.host === state.kalender.host);
  if (markt) state.markets = [markt.code];
  state.inkognito = Boolean(state.kalender.inkognito);
  state.mode = 'work';
  persist();
  showScreen('work');
  update();
  offenerBereich = null;
  zeigeBereich('land');
  $('#panelLand').scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(
    `${kalDatum(job.pickupDate, true)} übernommen. Weitere Länderseiten dazuwählen, ` +
      'dann „Preise vergleichen“, der Schutz lässt sich dort je Klasse öffnen.'
  );
}

/** Tagesdetails sind auch per Tastatur und auf Touch-Geräten erreichbar. */
function renderKalTag() {
  document.querySelectorAll('#kalBild .ktag').forEach((button) => {
    const aktiv = button.dataset.datum === kalTagAuswahl;
    button.classList.toggle('ausgewaehlt', aktiv);
    button.setAttribute('aria-pressed', String(aktiv));
  });
  const box = $('#kalAuswahl');
  const d = kalJobs();
  const desTages = d?.jobs.filter((j) => j.pickupDate === kalTagAuswahl) || [];
  // Der Auftrag mit dem günstigsten Preis vertritt den Tag; die übrigen
  // Uhrzeiten stehen darunter, damit man sieht, was die Wahl kostet.
  const job = kalTagBester(desTages).job || desTages[0];
  if (!job) {
    box.dataset.signatur = '';
    setChildren(box, el('p', {}, kalLaeuft
      ? 'Deine Preise werden geladen. Du kannst die ersten Tage schon auswählen.'
      : 'Wähle einen Tag im Kalender. Mit „Preise im Kalender finden“ startest du den Vergleich.'));
    return;
  }
  const p = kalPreis(job);
  // Alle Uhrzeiten des Tages, günstigste zuerst, das ist bei mehreren Zeiten
  // die eigentliche Aussage: nicht nur was, sondern wann.
  const zeiten = desTages
    .map((j) => ({ job: j, p: kalPreis(j) }))
    .filter((x) => x.p.preis != null)
    .sort((a, b) => a.p.preis - b.p.preis);
  const signatur = JSON.stringify([job, p, state.kalender.klasse, zeiten.map((z) => z.p.preis)]);
  if (box.dataset.signatur === signatur) return;
  box.dataset.signatur = signatur;
  const klasse = state.kalender.klasse || p.acriss;
  const modell = p.modell || (klasse && kalKatalog[klasse]?.modelle?.[0]);
  setChildren(box,
    el('div', {},
      el('p', { class: 'eyebrow' }, 'DEIN ABHOLTAG'),
      el('h3', {}, kalDatum(job.pickupDate, true)),
      el('p', {}, `Rückgabe ${kalDatum(job.returnDate)} · ${state.kalender.dauer} ${state.kalender.dauer === 1 ? 'Tag' : 'Tage'}`),
      p.preis == null
        ? el('p', {}, p.grund || (p.geladen ? 'Kein Preis vorhanden.' : 'Dieser Tag wurde noch nicht abgerufen.'))
        : modell ? el('p', {}, `${modell}${klasse ? ` · ${klasse}` : ''}`) : null,
      // Der Kalender vergleicht Grundpreise. Das Schutzpaket verschiebt die
      // Reihenfolge kräftig, deshalb führt der Weg von hier in den
      // Preisvergleich, wo es mit echtem Kassenpreis danebensteht.
      p.preis != null
        ? el(
            'button',
            {
              type: 'button',
              class: 'ghost mini',
              onclick: () => uebernehmeKalendertag(job),
              title:
                'Übernimmt Station und Zeitraum in den Preisvergleich. Dort lässt sich zu ' +
                'dieser Klasse auch der Schutz vergleichen.',
            },
            'Diesen Tag im Preisvergleich öffnen'
          )
        : null
    ),
    p.preis != null ? el('div', { class: 'calendar-selection-price' },
      el('strong', {}, kalBetrag(p.preis, d.markt.cur)),
      el('span', {}, `Gesamtpreis · ${kalBetrag(p.preis / state.kalender.dauer, d.markt.cur)} pro Tag`),
      el(
        'span',
        {},
        p.ausAufzeichnung
          ? `Aus dem gespeicherten Preisverlauf${p.zeit ? ` · gemessen ${alter(p.zeit)}` : ''}`
          : 'Aus dem aktuellen Abruf'
      ),
      // Bei mehreren Uhrzeiten: was jede kostet, und wie viel die Wahl
      // ausmacht. Genau das ist der Grund, warum es die Zeiten überhaupt gibt.
      zeiten.length > 1
        ? el(
            'div',
            { class: 'kal-zeiten' },
            el('span', { class: 'kal-zeiten-kopf' }, 'Nach Abholzeit'),
            ...zeiten.map((z, i) =>
              el(
                'span',
                { class: 'kal-zeit-zeile' + (i === 0 ? ' beste' : '') },
                el(
                  'b',
                  {},
                  z.job.pickupTime +
                    (z.job.returnTime !== z.job.pickupTime ? ` → ${z.job.returnTime}` : '')
                ),
                kalBetrag(z.p.preis, d.markt.cur),
                i === 0
                  ? el('em', {}, 'günstigste')
                  : el('em', {}, `+${kalBetrag(z.p.preis - zeiten[0].p.preis, d.markt.cur)}`)
              )
            )
          )
        : null
    ) : null
  );
}

function renderKalBild() {
  const d = kalJobs();
  if (!d) {
    $('#kalErgebnis').hidden = true;
    return;
  }
  // Ein Feld je Abholtag, nicht je Auftrag: bei mehreren Uhrzeiten gehören
  // sie zusammen, und gezeigt wird die günstigste, mit der Uhrzeit dazu.
  const nachTag = new Map();
  for (const j of d.jobs) {
    if (!nachTag.has(j.pickupDate)) nachTag.set(j.pickupDate, []);
    nachTag.get(j.pickupDate).push(j);
  }
  const tage = [...nachTag].map(([datum, js]) => ({ datum, ...kalTagBester(js) }));
  const werte = tage.map((t) => t.preis).filter((p) => p != null);
  const min = werte.length ? Math.min(...werte) : null;
  const max = werte.length ? Math.max(...werte) : null;
  const beste = min == null ? [] : tage.filter((t) => t.preis === min);
  if (!tage.some((t) => t.datum === kalTagAuswahl)) kalTagAuswahl = beste[0]?.datum || null;

  $('#kalErgebnis').hidden = false;
  // Die Legende erklärt den Punkt nur, wenn es auch welche gibt.
  $('#kalLegendeAlt').hidden = !tage.some((t) => t.ausAufzeichnung);
  $('#kalLegendeZeit').hidden = d.zeiten.length < 2;
  $('#kalCsv').disabled = !werte.length;
  $('#kalTitel').textContent = 'Dein Preiskalender';
  $('#kalUntertitel').textContent = `${d.station.name} · ${d.markt.label} · ${state.kalender.klasse || 'Günstigste Klasse je Tag'}`;
  renderKalKlassenleiste(tage.length, werte.length);
  const kennzahl = (label, wert, note) => el('div', { class: 'calendar-insight' },
    el('span', { class: 'calendar-insight-label' }, label),
    el('strong', { class: 'calendar-insight-value' }, wert),
    el('span', { class: 'calendar-insight-note' }, note)
  );
  // Bei mehreren Uhrzeiten die Frage beantworten, die man dann hat: welche
  // gewinnt eigentlich? Ohne diese Zahl müsste man Tag für Tag anklicken.
  const zeitBilanz = () => {
    if (d.zeiten.length < 2) return null;
    const siege = new Map();
    let mitPreis = 0;
    for (const t of tage) {
      if (t.preis == null || !t.uhr) continue;
      mitPreis++;
      const k = t.rueckUhr && t.rueckUhr !== t.uhr ? `${t.uhr}→${t.rueckUhr}` : t.uhr;
      siege.set(k, (siege.get(k) || 0) + 1);
    }
    if (!siege.size) return null;
    const [zeit, n] = [...siege].sort((a, b) => b[1] - a[1])[0];
    return { zeit, n, mitPreis, geteilt: siege.size > 1 };
  };
  const bilanz = zeitBilanz();

  $('#kalKennzahlen').classList.toggle('vier', Boolean(bilanz));
  setChildren($('#kalKennzahlen'),
    kennzahl('Bester Gesamtpreis', min == null ? '–' : kalBetrag(min, d.markt.cur),
      beste.length ? `${kalDatum(beste[0].datum)}${beste.length > 1 ? ` und ${beste.length - 1} ${beste.length === 2 ? 'weiterer Tag' : 'weitere Tage'}` : ''}` : 'Sobald die ersten Preise vorliegen'),
    kennzahl('Preisunterschied', min == null ? '–' : kalBetrag(max - min, d.markt.cur), 'Zwischen günstigstem und teuerstem Abholtag'),
    bilanz
      ? kennzahl(
          'Beste Abholzeit',
          bilanz.zeit,
          bilanz.geteilt
            ? `an ${bilanz.n} von ${bilanz.mitPreis} Tagen vorn`
            : `an allen ${bilanz.mitPreis} Tagen vorn`
        )
      : null,
    kennzahl('Tage mit Preis', `${werte.length} / ${tage.length}`, `${state.kalender.dauer} ${state.kalender.dauer === 1 ? 'Tag' : 'Tage'} Mietdauer · ${d.markt.cur}`)
  );

  // Jeder Monat erhält sein eigenes Raster. Auch Jahreswechsel und kurze
  // Restmonate behalten so die richtigen Wochentage und eine klare Überschrift.
  const monate = new Map();
  for (const tag of tage) {
    const monat = tag.datum.slice(0, 7);
    if (!monate.has(monat)) monate.set(monat, []);
    monate.get(monat).push(tag);
  }
  const fokusDatum = document.activeElement?.closest('#kalBild .ktag')?.dataset.datum;
  const tageNamen = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  setChildren($('#kalBild'), ...[...monate].map(([monat, monatstage]) => {
    const titel = new Date(monat + '-01T12:00:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const luecke = (new Date(monatstage[0].datum + 'T12:00:00').getDay() + 6) % 7;
    const felder = [...Array(luecke).fill(null), ...monatstage];
    while (felder.length % 7) felder.push(null);
    const wochen = [];
    for (let i = 0; i < felder.length; i += 7) wochen.push(felder.slice(i, i + 7));
    return el('section', { class: 'kal-month', 'aria-label': titel },
      el('div', { class: 'kal-month-heading' }, el('h3', {}, titel),
        el('span', {}, `${d.markt.cur} · ${state.kalender.dauer} ${state.kalender.dauer === 1 ? 'Tag' : 'Tage'}`)),
      el('table', { class: 'kalender' },
        el('caption', { class: 'visually-hidden' }, `${titel}: Gesamtpreise in ${d.markt.cur} für ${state.kalender.dauer} Tage Mietdauer`),
        el('thead', {}, el('tr', {}, ...tageNamen.map((name) => el('th', { scope: 'col', abbr: name }, name.slice(0, 2))))),
        el('tbody', {}, ...wochen.map((woche) => el('tr', {}, ...woche.map((t) => {
          if (!t) return el('td', { class: 'kal-blank', 'aria-hidden': 'true' });
          const istBest = min != null && t.preis === min;
          const exakt = t.preis == null ? (t.geladen ? '–' : '…') : t.preis.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const kurz = t.preis == null ? exakt : Math.round(t.preis).toLocaleString('de-DE');
          const beschreibung =
            `${kalDatum(t.datum, true)} · ${t.preis != null ? kalBetrag(t.preis, d.markt.cur) : (t.grund || 'Noch nicht abgerufen')}` +
            (istBest ? ' · Günstigster Tag' : '') +
            // Bei mehreren Uhrzeiten gehört dazu, welche den Preis gemacht hat.
            (d.zeiten.length > 1 && t.uhr
              ? ` · beste Zeit ${t.uhr}${t.rueckUhr !== t.uhr ? ` → ${t.rueckUhr}` : ''}`
              : '') +
            // Ein gespeicherter Wert sagt selbst, wie alt er ist, sonst waere
            // nicht zu sehen, ob er von heute oder von vorletzter Woche ist.
            (t.ausAufzeichnung ? ` · aus dem Preisverlauf${t.zeit ? `, ${alter(t.zeit)}` : ''}` : '');
          return el('td', {}, el('button', {
            type: 'button', class: 'ktag' + (istBest ? ' billigster' : '') + (t.preis == null ? ' nichts' : '') + (t.ausAufzeichnung ? ' gespeichert' : ''),
            'data-datum': t.datum, 'aria-label': beschreibung, 'aria-pressed': String(kalTagAuswahl === t.datum),
            title: beschreibung, onclick: () => { kalTagAuswahl = t.datum; renderKalTag(); },
          },
          el('span', { class: 'kdatum', 'aria-hidden': 'true' }, String(new Date(t.datum + 'T12:00:00').getDate())),
          el('span', { 'aria-hidden': 'true' },
            el('span', { class: 'kpreis' }, el('span', { class: 'kpreis-genau' }, exakt), el('span', { class: 'kpreis-kurz' }, kurz)),
            // Bei mehreren Uhrzeiten steht die siegreiche im Feld selbst. Sie
            // nur in den Tooltip zu legen hiess: unsichtbar auf dem Touchgerät
            // und uebersehen auf jedem anderen.
            el(
              'span',
              { class: 'kal-day-note' },
              t.preis == null
                ? t.geladen
                  ? 'kein Preis'
                  : 'offen'
                : d.zeiten.length > 1 && t.uhr
                  ? (istBest ? '★ ' : '') +
                    t.uhr +
                    (t.rueckUhr && t.rueckUhr !== t.uhr ? `→${t.rueckUhr}` : '')
                  : istBest
                    ? 'Bestpreis'
                    : ''
            )
          )));
        }))))
      )
    );
  }));
  renderKalTag();
  if (fokusDatum) document.querySelector(`#kalBild [data-datum="${fokusDatum}"]`)?.focus({ preventScroll: true });
}

/**
 * Durchrechnen.
 *
 * @param {boolean} nurFehlende  Nur die Tage, zu denen bei der gewaehlten
 *   Klasse kein Preis vorliegt. Das ist der zweite Durchgang: nach dem ersten
 *   Lauf steht die Klassenliste erst zur Verfuegung, und wer dann eine Klasse
 *   waehlt, sieht Luecken, teils weil die Klasse dort wirklich nicht im
 *   Angebot war, teils weil ein Abruf dazwischengegangen ist. Welches von
 *   beidem, weiss man erst nach dem zweiten Versuch.
 */
async function starteKalender({ nurFehlende = false } = {}) {
  const d = kalJobs();
  if (!d || kalLaeuft) return;

  kalLaeuft = true;
  for (const j of d.jobs) extraSchluessel.add(j.key);
  renderKalFormular();

  try {
    const offen = kalStand().offen;

    if (!offen.length) {
      flash(nurFehlende ? 'Es fehlt kein Tag mehr.' : 'Alle Tage liegen schon vor.');
      return;
    }

    // Beim Nachfassen den alten Stand wegräumen, sonst bleibt die alte
    // Fehlanzeige stehen, während der neue Abruf längst läuft.
    if (nurFehlende) for (const j of offen) prices.delete(j.key);

    await sendeJobs(offen, $('#kalStart2'));

    // Mitzeichnen, statt am Ende alles auf einmal zu zeigen: so sieht man,
    // dass etwas passiert, und die ersten Tage sind sofort brauchbar.
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      await pollErgebnisse();
      renderKalFortschritt(d.jobs);
      renderKalBild();
      const q = service.queue;
      if (q && !q.laufend && !q.offen) break;
    }
  } finally {
    kalLaeuft = false;
    $('#kalFortschritt').hidden = true;
    // Erst jetzt weiss der Katalog, welche Klassen es an dieser Station gibt,
    // vor dem ersten Durchlauf stand in der Auswahl nur "billigste".
    await ladeKalKlassen();
    await ladeKalAufzeichnung();
    renderKalFormular();
    renderKalBild();
  }
}

/* ---------------------------------------------------- Mehrere Stationen
 *
 * Derselbe Zeitraum an mehreren Stationen. Das ist ein langer Lauf, bei drei
 * Stationen und 28 Abholtagen 84 Abrufe, und deshalb ein eigener Bereich mit
 * eigenem Fortschritt, statt eines Hakens irgendwo im Formular.
 *
 * Gerechnet wird ueber die Tage, die an *allen* Stationen einen Preis haben.
 * Dieselbe Ueberlegung wie beim Stationsvergleich oben: mittelt man ueber
 * unterschiedliche Tage, vergleicht man zwei verschiedene Zeitraeume und nennt
 * das Ergebnis Stationsunterschied.
 */

let kalMultiLaeuft = false;
let kalMultiStand = null;

/** Die Auftraege einer Station fuer den eingestellten Kalenderzeitraum. */
function kalJobsFuer(stationCode) {
  const station = stationByCode(stationCode);
  const markt = providerById(PROVIDER).markets.find((m) => m.host === state.kalender.host);
  if (!station || !markt || !/^\d{4}-\d{2}-\d{2}$/.test(state.kalender.start)) return null;

  const jobs = [];
  for (let i = 0; i < state.kalender.spanne; i++) {
    const ab = addDays(state.kalender.start, i);
    const bis = addDays(ab, state.kalender.dauer);
    // Auch hier jede Uhrzeit, sonst verglichen sich Stationen zu einer Zeit,
    // waehrend der Kalender daneben die guenstigste ueber alle zeigt.
    for (const z of kalZeitVarianten()) {
      const v = {
        pickupDate: ab,
        returnDate: bis,
        duration: state.kalender.dauer,
        pickupTime: z.ab,
        returnTime: z.zurueck,
      };
      jobs.push({
        key: jobKey(state.kalender.host, station.code, v, null, state.kalender.inkognito),
        provider: PROVIDER,
        host: state.kalender.host,
        stationCode: station.code,
        pickupDate: ab,
        returnDate: bis,
        pickupTime: z.ab,
        returnTime: z.zurueck,
        currency: markt.cur,
        inkognito: state.kalender.inkognito || undefined,
      });
    }
  }
  return { jobs, station, markt };
}

/** Der billigste Preis eines Tages an einer Station, aus frischem Abruf. */
function kalMultiPreis(key) {
  const r = prices.get(key);
  if (!r?.offers?.length) return null;
  const klasse = state.kalender.klasse;
  if (klasse) {
    const t = r.offers.find((o) => o.acriss === klasse);
    return t?.total ?? null;
  }
  const werte = r.offers.map((o) => o.total).filter((n) => n != null);
  return werte.length ? Math.min(...werte) : null;
}

function renderKalMulti() {
  const liste = state.kalender.stationen || [];
  $('#kalMultiZahl').textContent = `${liste.length} ${liste.length === 1 ? 'Station' : 'Stationen'}`;

  setChildren(
    $('#kalMultiListe'),
    ...liste.map((code) => {
      const s = stationByCode(code);
      return el(
        'div',
        { class: 'station on' },
        el('span', { class: 'flag' }, s?.country || ''),
        el('span', { class: 'sname' }, s?.name || code),
        el('span', { class: 'scode' }, code),
        el(
          'button',
          {
            type: 'button',
            class: 'ghost mini',
            title: 'Aus dem Vergleich nehmen',
            onclick: () => {
              state.kalender.stationen = liste.filter((c) => c !== code);
              persist();
              renderKalMulti();
            },
          },
          '×'
        )
      );
    })
  );

  const tage = state.kalender.spanne;
  const abrufe = liste.length * tage;
  $('#kalMultiStart').disabled = kalMultiLaeuft || liste.length < 2;
  $('#kalMultiAbbrechen').hidden = !kalMultiLaeuft;
  $('#kalMultiHinweis').textContent = kalMultiLaeuft
    ? ''
    : liste.length < 2
      ? 'Mindestens zwei Stationen wählen, sonst gibt es nichts zu vergleichen.'
      : `${abrufe} Abrufe, rund ${minutenText(abrufe)}.`;

  if (kalMultiStand) renderKalMultiErgebnis();
}

function renderKalMultiTreffer() {
  const feld = $('#kalMultiTreffer');
  const needle = $('#kalMultiSuche').value;
  if (!needle.trim()) {
    feld.hidden = true;
    return;
  }
  const treffer = suche(needle, 12);
  feld.hidden = false;
  setChildren(
    feld,
    ...(treffer.length
      ? treffer.map((s) =>
          el(
            'button',
            {
              type: 'button',
              class: 'station' + ((state.kalender.stationen || []).includes(s.code) ? ' on' : ''),
              onclick: () => {
                const liste = state.kalender.stationen || (state.kalender.stationen = []);
                if (!liste.includes(s.code)) liste.push(s.code);
                persist();
                $('#kalMultiSuche').value = '';
                feld.hidden = true;
                renderKalMulti();
              },
            },
            el('span', { class: 'flag' }, s.country),
            el('span', { class: 'sname' }, s.name),
            el('span', { class: 'scode' }, s.code)
          )
        )
      : [el('p', { class: 'empty' }, 'Kein Treffer.')])
  );
}

async function starteKalMulti() {
  const codes = state.kalender.stationen || [];
  if (codes.length < 2 || kalMultiLaeuft) return;

  const paket = codes.map(kalJobsFuer).filter(Boolean);
  if (paket.length < 2) {
    flash('Bitte erst Zeitraum und Länderseite im Kalender einstellen.');
    return;
  }

  kalMultiLaeuft = true;
  kalMultiStand = null;
  renderKalMulti();
  $('#kalMultiFortschritt').hidden = false;

  const alle = paket.flatMap((p) => p.jobs);
  for (const j of alle) extraSchluessel.add(j.key);

  try {
    // Station für Station, nicht alles auf einmal: so sind die ersten
    // Ergebnisse früh brauchbar, und ein Abbruch mittendrin lässt eine
    // vollständige Station zurück statt drei halbe.
    for (const p of paket) {
      if (!kalMultiLaeuft) break;
      const offen = p.jobs.filter((j) => !prices.has(j.key));
      if (!offen.length) continue;
      await sendeJobs(offen, $('#kalMultiStart'));

      for (let i = 0; i < 900 && kalMultiLaeuft; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        await pollErgebnisse();
        const fertig = alle.filter((j) => prices.has(j.key)).length;
        $('#kalMultiBalken').style.width = `${Math.round((fertig / alle.length) * 100)}%`;
        $('#kalMultiText').textContent =
          `${p.station.name}: ${fertig} von ${alle.length} Abrufen · ` +
          `${paket.indexOf(p) + 1} von ${paket.length} Stationen`;
        const q = service.queue;
        if (q && !q.laufend && !q.offen) break;
      }
    }

    // Was nichts geliefert hat, einmal von selbst nachfassen, bei einem Lauf
    // dieser Länge klemmt fast immer irgendwo eine Seite.
    const fehlt = alle.filter((j) => {
      const r = prices.get(j.key);
      return !r || r.error != null || !r.offers?.length;
    });
    if (fehlt.length && kalMultiLaeuft) {
      $('#kalMultiText').textContent = `${fehlt.length} Abrufe ohne Ergebnis, zweiter Versuch …`;
      for (const j of fehlt) prices.delete(j.key);
      await sendeJobs(fehlt, $('#kalMultiStart'));
      for (let i = 0; i < 900 && kalMultiLaeuft; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        await pollErgebnisse();
        const q = service.queue;
        if (q && !q.laufend && !q.offen) break;
      }
    }

    kalMultiStand = { paket, alle };
  } finally {
    kalMultiLaeuft = false;
    $('#kalMultiFortschritt').hidden = true;
    renderKalMulti();
  }
}

function renderKalMultiErgebnis() {
  const { paket } = kalMultiStand;
  const waehrung = paket[0]?.markt.cur || '';

  // Je Station: Tag → Preis
  const proStation = paket.map((p) => {
    const tage = new Map();
    for (const j of p.jobs) {
      const preis = kalMultiPreis(j.key);
      // Mehrere Uhrzeiten je Tag: der guenstigste zaehlt, wie im Kalender.
      if (preis != null && (!tage.has(j.pickupDate) || preis < tage.get(j.pickupDate))) {
        tage.set(j.pickupDate, preis);
      }
    }
    // Ein Tag zaehlt als fehlend, wenn *keine* seiner Uhrzeiten einen Preis
    // hat, nicht schon dann, wenn eine von dreien ausfiel.
    const alleTage = new Set(p.jobs.map((j) => j.pickupDate));
    const fehlend = [...alleTage].filter((t) => !tage.has(t)).length;
    return { station: p.station, tage, fehlend };
  });

  // Nur Tage, die es überall gibt, sonst verglichen sich zwei Zeiträume.
  let gemeinsam = [...(proStation[0]?.tage.keys() || [])];
  for (const s of proStation.slice(1)) gemeinsam = gemeinsam.filter((t) => s.tage.has(t));

  const mitWerten = proStation.filter((s) => s.tage.size);
  if (mitWerten.length < 2 || !gemeinsam.length) {
    setChildren(
      $('#kalMultiErgebnis'),
      el(
        'p',
        { class: 'note warn' },
        !gemeinsam.length && mitWerten.length >= 2
          ? 'Die Stationen haben keinen gemeinsamen Abholtag mit Preis, ohne den lässt ' +
            'sich nichts sauber gegenüberstellen. Lauf wiederholen.'
          : 'Zu wenige Stationen haben Preise geliefert. Lauf wiederholen.'
      )
    );
    return;
  }

  const zeilen = proStation.map((s) => {
    const werte = gemeinsam.map((t) => s.tage.get(t)).filter((n) => n != null);
    const schnitt = werte.length ? werte.reduce((a, b) => a + b, 0) / werte.length : null;
    const bestTag = [...s.tage].reduce((a, b) => (b[1] < a[1] ? b : a), [null, Infinity]);
    return {
      station: s.station,
      schnitt,
      bester: bestTag[0] ? { datum: bestTag[0], preis: bestTag[1] } : null,
      gewinntBei: 0,
      fehlend: s.fehlend,
    };
  });

  // Wer gewinnt an wie vielen Tagen, die Zahl, die zählt.
  for (const t of gemeinsam) {
    let best = null;
    for (const z of zeilen) {
      const p = proStation.find((s) => s.station.code === z.station.code).tage.get(t);
      if (p != null && (best == null || p < best.p)) best = { p, z };
    }
    if (best) best.z.gewinntBei++;
  }

  zeilen.sort((a, b) => (a.schnitt ?? Infinity) - (b.schnitt ?? Infinity));
  const sieger = zeilen[0];

  setChildren(
    $('#kalMultiErgebnis'),
    el(
      'div',
      { class: 'stationsvergleich' },
      el(
        'div',
        { class: 'sv-block' },
        el('p', { class: 'eyebrow' }, `ÜBER ${gemeinsam.length} GEMEINSAME ABHOLTAGE`),
        el(
          'p',
          { class: 'sv-satz' },
          el('b', {}, sieger.station.name),
          ' ist im Schnitt am günstigsten, ',
          el('b', {}, kalBetrag(sieger.schnitt, waehrung)),
          ` je ${state.kalender.dauer} ${state.kalender.dauer === 1 ? 'Tag' : 'Tage'}, ` +
            `und an ${sieger.gewinntBei} von ${gemeinsam.length} Tagen die billigste.`
        ),
        ...zeilen.slice(1).map((z) =>
          el(
            'p',
            { class: 'sv-zeile' },
            el('span', { class: 'sv-name leise' }, z.station.name),
            ' liegt im Schnitt ',
            el('b', {}, kalBetrag(z.schnitt - sieger.schnitt, waehrung)),
            ` (${(((z.schnitt - sieger.schnitt) / sieger.schnitt) * 100).toFixed(1).replace('.', ',')} %) darüber` +
              (z.gewinntBei ? `, ist aber an ${z.gewinntBei} Tagen die billigste.` : '.')
          )
        ),
        el(
          'p',
          { class: 'sv-fuss' },
          'Verglichen wird nur über Abholtage, die an allen Stationen einen Preis haben.'
        ),
        zeilen.some((z) => z.fehlend)
          ? el(
              'p',
              { class: 'sv-fuss warn' },
              'Ohne Ergebnis geblieben: ' +
                zeilen.filter((z) => z.fehlend).map((z) => `${z.station.name} (${z.fehlend})`).join(', ') +
                '. Diese Tage fehlen im Vergleich.'
            )
          : null
      )
    ),
    el(
      'div',
      { class: 'tabellenrahmen' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Station'),
            el('th', {}, 'Schnitt'),
            el('th', {}, 'Billigste Tage'),
            el('th', {}, 'Bester Einzeltag')
          )
        ),
        el(
          'tbody',
          {},
          ...zeilen.map((z) =>
            el(
              'tr',
              {},
              el('td', {}, z.station.name),
              el('td', { class: 'betrag' }, kalBetrag(z.schnitt, waehrung)),
              el('td', {}, `${z.gewinntBei} von ${gemeinsam.length}`),
              el(
                'td',
                {},
                z.bester ? `${kalDatum(z.bester.datum)} · ${kalBetrag(z.bester.preis, waehrung)}` : '–'
              )
            )
          )
        )
      )
    )
  );
}

function renderKalFortschritt(jobs) {
  const fertig = jobs.filter((j) => prices.has(j.key)).length;
  const box = $('#kalFortschritt');
  box.hidden = !kalLaeuft;
  $('#kalFuellung').style.width = `${Math.round((fertig / jobs.length) * 100)}%`;
  $('#kalText').textContent = `${fertig} von ${jobs.length} Tagen berechnet`;
}

function kalenderCsv() {
  const d = kalJobs();
  if (!d) return;
  const zahl = (n) => (n == null ? '' : String(n.toFixed(2)).replace('.', ','));
  const feld = (s) => `"${String(s ?? '').replaceAll('"', '""')}"`;

  const zeilen = [
    ['Abholtag', 'Rückgabe', 'Wochentag', 'Klasse', 'Modell', 'Preis', 'Währung']
      .map(feld)
      .join(';'),
  ];
  for (const j of d.jobs) {
    const p = kalPreis(j);
    zeilen.push(
      [
        feld(j.pickupDate),
        feld(j.returnDate),
        feld(
          new Date(j.pickupDate + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long' })
        ),
        feld(state.kalender.klasse || p.acriss || ''),
        feld(p.modell || ''),
        zahl(p.preis),
        feld(d.markt.cur),
      ].join(';')
    );
  }

  const url = URL.createObjectURL(
    new Blob(['﻿' + zeilen.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
  );
  const a = el('a', {
    href: url,
    download: `monat-${d.station.name.replace(/[^\wäöüÄÖÜß]+/g, '-').toLowerCase()}-${state.kalender.start}.csv`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  flash('Als CSV gespeichert.');
}

async function oeffneKalender() {
  showScreen('kalender');
  // Die Schlüssel des Kalenders in den Abfragetakt geben. Ohne das holt die
  // Seite nach einem Neuladen nur die Aufträge des Preisvergleichs ab, und
  // der Kalender stünde leer da, obwohl der Dienst seine Preise noch hat,
  // was besonders auffällt, seit die Aufzeichnung bei mehreren Uhrzeiten
  // nicht mehr aushilft.
  for (const j of kalJobs()?.jobs || []) extraSchluessel.add(j.key);
  await pollErgebnisse();
  if (!(await ladeKalKlassen())) return;
  // Was frueher schon gemessen wurde, steht sofort da, auch nach einem
  // Neustart des Programms.
  await ladeKalAufzeichnung();
  renderKalFormular();
  renderKalBild();
  renderKalMulti();
}

/* =========================================================== Preiswecker */

let weckerListe = [];

/** Welche Sorte Wecker gerade angelegt wird: 'wunsch' oder 'buchung'. */
let weckerArt = 'wunsch';

/**
 * Solange die Weckerliste zu sehen ist, zieht sie sich selbst nach.
 *
 * Die Prüfungen laufen im Dienst, nicht in der Seite. Ohne das stünde nach
 * einer Runde im Hintergrund immer noch "noch nicht geprüft" da, während das
 * Ergebnis längst vorliegt, und wer eine gebuchte Reise beobachtet, sieht
 * genau auf diese Zeile.
 */
let weckerTakt = null;

function haltWeckerFrisch(an) {
  if (an && !weckerTakt) {
    weckerTakt = setInterval(ladeWecker, 30000);
    // Der Stand der geplanten Aufgabe ändert sich nicht von selbst, einmal
    // beim Öffnen der Ansicht genügt.
    ladeHintergrund();
  }
  if (!an && weckerTakt) {
    clearInterval(weckerTakt);
    weckerTakt = null;
  }
}

async function ladeWecker() {
  try {
    const d = await (await fetch('/api/wecker')).json();
    weckerListe = d.wecker || [];
  } catch {
    weckerListe = [];
  }
  renderWecker();
}

/* ------------------------------------------------------ Proxys */

/**
 * Zwei Betriebsarten, weil zwei verschiedene Fragen dahinterstehen:
 *
 *   allgemein  Ein Vorrat für alle Länderseiten. Ändert sich der Preis, wenn
 *              die Anfrage von einem anderen Anschluss kommt als meinem?
 *   jeSeite    Je Länderseite ein eigener Vorrat, sinnvollerweise mit Proxys
 *              aus dem jeweiligen Land. Sieht ein Franzose auf sixt.fr
 *              denselben Preis wie ich?
 */
let proxy = null;
let proxyTakt = null;
let proxyLetzterWechsel = 0;

const PROXY_ARTEN = [
  ['aus', 'Ohne Proxy', 'Jeder Abruf geht direkt von diesem Rechner aus.'],
  ['allgemein', 'Ein Vorrat für alle Länderseiten', 'Derselbe Weg für jede Seite. Zeigt, ob ein anderer Anschluss andere Preise sieht.'],
  ['jeSeite', 'Je Länderseite ein eigener', 'Nur Seiten mit eigenem Eintrag gehen über einen Proxy, die übrigen direkt.'],
];

async function ladeProxy() {
  try {
    proxy = await (await fetch('/api/proxy')).json();
  } catch {
    proxy = null;
  }
  renderProxy();
  renderProxyWahl();
  ladeProxyVerbrauch();
}

/** Betriebsart umstellen. Chrome startet dabei neu, das dauert kurz. */
async function setzeProxyModus(modus) {
  try {
    const d = await (
      await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modus }),
      })
    ).json();
    if (!d.ok) return flash(d.error || 'Ging nicht.');
    proxy = d;
    if (d.neustartNoetig) flash('Umgestellt. Der Abrufbrowser startet beim nächsten Abruf neu.');
    renderProxy();
    renderProxyWahl();
    haltProxyLampeFrisch();
  } catch {
    flash('Der Preisdienst antwortet nicht.');
  }
}

/** Eine Liste prüfen und den schnellsten übernehmen. */
async function testeProxy(ziel, knopf, anzahl = 8) {
  if (knopf) {
    knopf.disabled = true;
    knopf.textContent = 'wird geprüft …';
  }
  try {
    const d = await (
      await fetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ziel, anzahl }),
      })
    ).json();
    if (!d.ok) return flash(d.error || 'Prüfung ging nicht.');
    proxy = d;
    flash(
      d.davonGut
        ? `${d.davonGut} von ${d.geprueft} erreichbar, ${d.ausgaenge} verschiedene Ausgänge. ` +
            `Genommen wird der schnellste mit ${d.schnellste.ms} ms über ${d.schnellste.ip}.`
        : `Keiner von ${d.geprueft} war erreichbar.`
    );
    renderProxy();
    renderProxyWahl();
  } catch {
    flash('Der Preisdienst antwortet nicht.');
  } finally {
    if (knopf) {
      knopf.disabled = false;
      knopf.textContent = 'Proxys testen';
    }
  }
}

async function hinterlegeProxy(ziel, text) {
  const zeilen = String(text || '').split('\n').map((z) => z.trim()).filter(Boolean);
  try {
    const d = await (
      await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ziel, liste: zeilen }),
      })
    ).json();
    if (!d.ok) return flash(d.error || 'Ging nicht.');
    proxy = d;
    flash(d.anzahl ? `${d.anzahl} Einträge hinterlegt. Jetzt prüfen.` : 'Liste entfernt.');
    renderProxy();
    renderProxyWahl();
  } catch {
    flash('Der Preisdienst antwortet nicht.');
  }
}

/** Ein Vorrat als Kasten: Zustand, Liste einlesen, prüfen, entfernen. */
function proxyVorrat(ziel, titel, stand) {
  const dateiId = 'pxDatei_' + ziel.replace(/\W/g, '_');
  return el(
    'div',
    { class: 'pxvorrat' + (stand ? ' hat' : '') },
    el(
      'div',
      { class: 'pxkopf' },
      el('b', {}, titel),
      stand
        ? el(
            'span',
            { class: 'pxzustand' },
            `${stand.anzahl.toLocaleString('de-DE')} Einträge`,
            stand.geprueft
              ? ` · ${stand.geprueft.davonGut} von ${stand.geprueft.geprueft} erreichbar` +
                (stand.geprueft.schnellste
                  ? ` · genommen: ${stand.geprueft.schnellste.ip} (${stand.geprueft.schnellste.ms} ms)`
                  : '')
              : ' · noch nicht geprüft'
          )
        : el('span', { class: 'pxzustand leer' }, 'nichts hinterlegt')
    ),
    el(
      'div',
      { class: 'pxreihe' },
      // Zwei Wege, weil beide gebraucht werden: eine Datei vom Anbieter mit
      // zehntausend Zeilen, oder eben zwei Zeilen von Hand eingefügt.
      el('label', { class: 'pxdatei' }, 'Datei wählen', el('input', {
        type: 'file',
        id: dateiId,
        accept: '.txt,.csv,text/plain',
        onchange: async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          await hinterlegeProxy(ziel, await f.text());
        },
      })),
      el(
        'button',
        {
          type: 'button',
          class: 'linkknopf',
          onclick: (e) => {
            const feld = e.currentTarget.closest('.pxvorrat').querySelector('.pxfeld');
            feld.hidden = !feld.hidden;
            if (!feld.hidden) feld.querySelector('textarea').focus();
          },
        },
        stand ? 'bearbeiten' : 'einfügen'
      ),
      stand
        ? el(
            'button',
            {
              type: 'button',
              class: 'ghost klein',
              onclick: (e) => testeProxy(ziel, e.currentTarget),
            },
            'Proxys testen'
          )
        : null,
      stand
        ? el(
            'button',
            {
              type: 'button',
              class: 'linkknopf',
              onclick: async () => {
                if (!confirm(`Die Liste für ${titel} entfernen?`)) return;
                await hinterlegeProxy(ziel, '');
              },
            },
            'entfernen'
          )
        : null
    ),
    // Eintippen oder einfügen. Zeigt beim Öffnen nicht die ganze Liste: bei
    // zehntausend Zeilen wäre das Feld unbedienbar und der Browser träge.
    el(
      'div',
      { class: 'pxfeld', hidden: true },
      el('textarea', {
        rows: 5,
        spellcheck: 'false',
        placeholder:
          'Eine Zeile je Proxy:\nhost:port:benutzer:passwort\nhost:port\nbenutzer:passwort@host:port',
      }),
      el(
        'div',
        { class: 'pxreihe' },
        el(
          'button',
          {
            type: 'button',
            class: 'ghost klein',
            onclick: async (e) => {
              const kasten = e.currentTarget.closest('.pxfeld');
              const text = kasten.querySelector('textarea').value;
              if (!text.trim()) return flash('Nichts eingetragen.');
              await hinterlegeProxy(ziel, text);
            },
          },
          'Speichern'
        ),
        el(
          'span',
          { class: 'pxhinweis' },
          stand
            ? `Ersetzt die vorhandenen ${stand.anzahl.toLocaleString('de-DE')} Einträge.`
            : 'Am besten host:port:benutzer:passwort.'
        )
      )
    ),
    // Die Einzelergebnisse der letzten Prüfung, damit die Ausgangsadressen
    // nachvollziehbar sind und nicht nur eine Zahl dasteht.
    stand?.geprueft?.einzeln?.length
      ? el(
          'div',
          { class: 'pxtreffer' },
          ...stand.geprueft.einzeln.map((e) =>
            el(
              'span',
              { class: 'pxtreffer1 ' + (e.ok ? 'gut' : 'schlecht') },
              e.ok ? `${e.ip} · ${e.ms} ms` : e.grund
            )
          )
        )
      : null
  );
}

/** Datenmengen lesbar: 1,4 GB statt 1503238553. */
function datenmenge(b) {
  if (!b) return '0 B';
  const einheiten = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < einheiten.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0).replace('.', ',')} ${einheiten[i]}`;
}

/**
 * Was durch die Proxys gelaufen ist.
 *
 * Steht hier bei den Einstellungen und nicht im Bild: es ist eine Zahl zum
 * Nachschlagen, nicht zum Danebensitzen. Wichtig ist sie trotzdem, weil
 * Residential-Proxys nach Gigabyte abgerechnet werden.
 */
let proxyVerbrauch = null;

async function ladeProxyVerbrauch() {
  try {
    proxyVerbrauch = await (await fetch('/api/proxy/verbrauch')).json();
  } catch {
    proxyVerbrauch = null;
  }
  renderProxyVerbrauch();
}

function renderProxyVerbrauch() {
  const ziel = $('#proxyVerbrauch');
  if (!ziel) return;
  const v = proxyVerbrauch;
  if (!v || !v.ok) return setChildren(ziel);

  if (!v.gesamt) {
    return setChildren(
      ziel,
      el('p', { class: 'pxverbrauch leer' }, 'Noch nichts durch einen Proxy gelaufen.')
    );
  }

  setChildren(
    ziel,
    el(
      'div',
      { class: 'pxverbrauch' },
      el(
        'p',
        { class: 'pxsumme' },
        el('b', {}, datenmenge(v.gesamt)),
        ` durch Proxys gelaufen · ${v.verbindungen.toLocaleString('de-DE')} Verbindungen · ` +
          `empfangen ${datenmenge(v.rein)}, gesendet ${datenmenge(v.raus)}`,
        el(
          'span',
          { class: 'pxseit' },
          'gezählt seit ' + new Date(v.seit).toLocaleString('de-DE'),
          el(
            'button',
            {
              type: 'button',
              class: 'linkknopf',
              onclick: async () => {
                if (!confirm('Den Zähler auf null setzen?')) return;
                try {
                  proxyVerbrauch = await (
                    await fetch('/api/proxy/verbrauch', { method: 'POST' })
                  ).json();
                  renderProxyVerbrauch();
                } catch {
                  flash('Der Preisdienst antwortet nicht.');
                }
              },
            },
            'zurücksetzen'
          )
        )
      ),
      // Je Ziel, damit man sieht, welche Länderseite teuer ist.
      v.jeZiel?.length
        ? el(
            'table',
            { class: 'pxtabelle' },
            el(
              'tbody',
              {},
              ...v.jeZiel.slice(0, 12).map((z) =>
                el(
                  'tr',
                  {},
                  el('td', {}, z.host),
                  el('td', { class: 'r' }, datenmenge(z.gesamt)),
                  el('td', { class: 'r leise' }, `${z.verbindungen.toLocaleString('de-DE')} Verb.`)
                )
              )
            )
          )
        : null
    )
  );
}

function renderProxy() {
  const betrieb = $('#proxyBetrieb');
  const liste = $('#proxyListe');
  if (!betrieb || !liste) return;
  if (!proxy) {
    setChildren(betrieb, el('p', { class: 'note' }, 'Der Preisdienst antwortet nicht.'));
    return setChildren(liste);
  }

  setChildren(
    betrieb,
    el(
      'div',
      { class: 'pxmodus' },
      ...PROXY_ARTEN.map(([wert, titel, erklaerung]) =>
        el(
          'label',
          { class: 'pxwahl' + (proxy.modus === wert ? ' an' : '') },
          el('input', {
            type: 'radio',
            name: 'proxymodus',
            value: wert,
            checked: proxy.modus === wert,
            onchange: () => setzeProxyModus(wert),
          }),
          el('span', {}, el('b', {}, titel), el('small', {}, erklaerung))
        )
      )
    )
  );

  const maerkte = providerById(PROVIDER).markets;
  setChildren(
    liste,
    proxyVorrat('allgemein', 'Allgemeiner Vorrat', proxy.allgemein),
    el('p', { class: 'pxtrenner' }, 'Je Länderseite'),
    ...maerkte
      .filter((m) => !m.gestoert)
      .map((m) => proxyVorrat(m.host, `${m.label} · ${m.host}`, proxy.hosts?.[m.host]))
  );
}

/** Der Haken im Preisvergleich und im Kalender. */
function renderProxyWahl() {
  for (const id of ['#proxyWahl', '#kalProxyWahl']) {
    const ziel = $(id);
    if (!ziel) continue;
    if (!proxy) {
      setChildren(ziel);
      continue;
    }
    const an = proxy.modus !== 'aus';
    const bereit =
      proxy.modus === 'allgemein'
        ? proxy.allgemein?.gewaehlt != null
        : Object.values(proxy.hosts || {}).some((h) => h.gewaehlt != null);

    setChildren(
      ziel,
      el(
        'label',
        { class: 'optionzeile' + (id === '#proxyWahl' ? ' am-abruf' : '') },
        el('input', {
          type: 'checkbox',
          checked: an,
          onchange: (e) => setzeProxyModus(e.target.checked ? 'allgemein' : 'aus'),
        }),
        el(
          'span',
          {},
          el('b', {}, 'Über Proxy abrufen'),
          el(
            'small',
            {},
            an
              ? bereit
                ? PROXY_ARTEN.find(([w]) => w === proxy.modus)[1] +
                  '. Verwaltet wird das unter „Was geht gerade".'
                : 'Eingeschaltet, aber noch kein Proxy geprüft. Erst testen, sonst geht der Abruf direkt hinaus.'
              : 'Aus. Der Abruf geht direkt von diesem Rechner. Listen liegen unter „Was geht gerade".'
          )
        )
      ),
      an && !bereit
        ? el(
            'button',
            {
              type: 'button',
              class: 'ghost klein',
              onclick: (e) => testeProxy(proxy.modus === 'allgemein' ? 'allgemein' : null, e.currentTarget),
            },
            'Proxys testen'
          )
        : null
    );
  }
}

/* --- Die Lampe ----------------------------------------------------------
   Zeigt dauerhaft, über welchen Weg gerade abgerufen wird. Beim Wechsel
   blinkt sie kurz auf: eine Messung über eine andere Adresse ist etwas
   anderes als die davor, und das soll man sehen, ohne ins Protokoll zu
   schauen. */

function haltProxyLampeFrisch() {
  if (proxyTakt) {
    clearInterval(proxyTakt);
    proxyTakt = null;
  }
  ladeProxyLampe();
  proxyTakt = setInterval(ladeProxyLampe, 3000);
}

async function ladeProxyLampe() {
  const lampe = $('#proxyLampe');
  if (!lampe) return;
  let d;
  try {
    d = await (await fetch('/api/proxy/live')).json();
  } catch {
    lampe.hidden = true;
    return;
  }
  if (!d.aktiv) {
    lampe.hidden = true;
    return;
  }
  lampe.hidden = false;

  const gewechselt = d.seitWann && d.seitWann !== proxyLetzterWechsel;
  if (gewechselt) {
    proxyLetzterWechsel = d.seitWann;
    // Neu anstoßen: die Klasse muss weg und wieder dran, sonst läuft die
    // Bewegung beim zweiten Wechsel nicht noch einmal.
    lampe.classList.remove('wechsel');
    void lampe.offsetWidth;
    lampe.classList.add('wechsel');
  }

  // Bewusst knapp: Adresse und Betriebsart. Wie viel durchgelaufen ist, steht
  // bei den Einstellungen, das ist eine Zahl zum Nachschlagen.
  setChildren(
    lampe,
    el('span', { class: 'pxpunkt' }),
    el(
      'span',
      {},
      el('b', {}, d.ausgang || d.inBenutzung || 'Proxy aktiv'),
      el('small', {}, d.modus === 'allgemein' ? 'alle Länderseiten' : 'je Länderseite')
    )
  );
}

/* ------------------------------------------------------ Hintergrundprüfung */

/** Stand der geplanten Aufgabe, vom Dienst geholt. */
let hintergrund = null;

async function ladeHintergrund() {
  try {
    hintergrund = await (await fetch('/api/hintergrund')).json();
  } catch {
    hintergrund = null;
  }
  renderHintergrund();
}

/**
 * Der Schalter für die tägliche Prüfung ohne offenes Programm.
 *
 * Der vollständige Befehl steht im Klartext daneben, und der Name des
 * Eintrags auch. Ein Autostart, den man nicht sieht und in der
 * Aufgabenplanung nicht wiederfindet, ist genau das, was man von fremder
 * Software nicht haben will.
 */
function renderHintergrund() {
  const ziel = $('#hintergrundBereich');
  if (!ziel) return;
  if (!hintergrund) return setChildren(ziel);

  if (!hintergrund.moeglich) {
    return setChildren(
      ziel,
      el('p', { class: 'hgzeile aus' }, el('b', {}, 'Prüfung im Hintergrund: '), hintergrund.grund)
    );
  }

  const an = hintergrund.an;
  setChildren(
    ziel,
    el(
      'div',
      { class: 'hgkarte' + (an ? ' an' : '') },
      el(
        'label',
        { class: 'hgschalter' },
        el('input', {
          type: 'checkbox',
          checked: an,
          onchange: async (e) => {
            const kasten = e.currentTarget;
            kasten.disabled = true;
            const uhrzeit = $('#hgUhrzeit')?.value || '09:00';
            try {
              const d = await (
                await fetch('/api/hintergrund', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ an: kasten.checked, uhrzeit }),
                })
              ).json();
              if (!d.ok) flash(d.error || 'Ging nicht.');
              else
                flash(
                  kasten.checked
                    ? `Eingetragen. TRACKER prüft ab jetzt täglich um ${uhrzeit}, auch wenn es zu ist.`
                    : 'Der Eintrag ist entfernt. Es läuft nichts mehr im Hintergrund.'
                );
            } catch {
              flash('Der Preisdienst antwortet nicht.');
            } finally {
              await ladeHintergrund();
            }
          },
        }),
        el(
          'span',
          {},
          el('b', {}, 'Täglich prüfen, auch wenn TRACKER zu ist'),
          el(
            'span',
            { class: 'hgunter' },
            an
              ? 'Läuft. Meldet sich mit einem Fenster, wenn ein Preis gefallen ist.'
              : 'Aus. Solange das aus ist, prüft der Wecker nur bei geöffnetem Programm.'
          )
        )
      ),
      el(
        'label',
        { class: 'hguhr' },
        'um ',
        el('input', {
          id: 'hgUhrzeit',
          type: 'time',
          value: hintergrund.uhrzeit || '09:00',
          onchange: async (e) => {
            if (!an) return;
            // Schon eingeschaltet? Dann den Eintrag mit der neuen Uhrzeit
            // überschreiben, statt den Nutzer aus- und wieder einschalten
            // zu lassen.
            await fetch('/api/hintergrund', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ an: true, uhrzeit: e.target.value }),
            }).catch(() => {});
            flash(`Umgestellt auf ${e.target.value}.`);
            ladeHintergrund();
          },
        })
      ),
      // Volle Offenlegung: was genau angelegt wird, und wo man es wiederfindet.
      el(
        'p',
        { class: 'hgbefehl' },
        an
          ? `Eintrag „${hintergrund.aufgabe}" in der Windows-Aufgabenplanung: ${hintergrund.befehl}`
          : `Angelegt würde der Eintrag „${hintergrund.aufgabe}" in der Windows-Aufgabenplanung: ${hintergrund.befehl}`,
        an && hintergrund.naechste ? el('span', { class: 'hgnaechste' }, `Nächster Lauf: ${hintergrund.naechste}`) : null
      )
    )
  );
}

function renderWecker() {
  const roh = kurveGruppen.find((x) => `${x.station}|${x.von}|${x.bis}` === kurveGruppe);
  // Die Übersicht kommt schlank, also ohne die Listen der Länderseiten und
  // Uhrzeiten. Die stehen in den Messpunkten der gewählten Reise, die für das
  // Diagramm ohnehin geladen werden. Ohne diese Zusammenführung lief das
  // Weckerformular in ein "undefined.map".
  const g =
    roh && kurveReise?.schluessel === kurveGruppe
      ? { ...roh, hosts: kurveReise.hosts, zeiten: kurveReise.zeiten, klassen: kurveReise.klassen }
      : roh && Array.isArray(roh.hosts)
        ? roh
        : null;

  // Das Formular wird gleich neu gebaut. Weil die Liste im Takt nachlädt,
  // träfe das mitten in eine Eingabe: der halb getippte Betrag wäre weg und
  // der Cursor gleich mit. Deshalb vorher merken, hinterher zurücksetzen.
  const getippt = $('#weckerGrenze')?.value || '';
  const hatteFokus = document.activeElement?.id === 'weckerGrenze';

  // Anlegen ist nur sinnvoll, wenn eine beobachtete Suche gewählt ist,
  // Station, Zeitraum und Klasse kommen von dort.
  setChildren(
    $('#weckerNeu'),
    g && kurveKlasse
      ? el(
          'div',
          { class: 'weckerform' },
          el(
            'p',
            { class: 'wecker-reise' },
            `${stationByCode(g.station)?.name || g.station} · ${kurveKlasse} · ` +
              `${pretty(g.von)} – ${pretty(g.bis)}`
          ),
          el('div', { class: 'field' },
            el('label', { class: 'flabel', for: 'weckerHost' }, 'Länderseite'),
            el('select', { id: 'weckerHost', class: 'premium-select', onchange: (e) => {
              const cur = providerById(PROVIDER).markets.find((m) => m.host === e.target.value)?.cur;
              $('#weckerGrenzeLabel').textContent =
                (weckerArt === 'buchung' ? 'Was du bezahlt hast' : 'Wunschpreis') +
                (cur ? ' in ' + cur : '');
            } }, ...g.hosts.map((h) => {
              const markt = providerById(PROVIDER).markets.find((m) => m.host === h);
              return el('option', { value: h }, markt ? `${markt.label} (${markt.cur})` : h.replace(/^www\./, ''));
            }))
          ),
          // Uhrzeit nur zur Wahl stellen, wo es mehr als eine gibt. Sixt
          // rechnet nach Uhrzeit ab, ein Wecker zur falschen Zeit meldet
          // einen Preis, den es für diese Buchung nie gab.
          (g.zeiten || []).length > 1
            ? el(
                'div',
                { class: 'field' },
                el('label', { class: 'flabel', for: 'weckerZeit' }, 'Uhrzeit'),
                el(
                  'select',
                  { id: 'weckerZeit', class: 'premium-select' },
                  ...g.zeiten.map((z) => {
                    const [ab, zurueck] = z.split('|');
                    return el(
                      'option',
                      { value: z },
                      ab === zurueck ? `${ab} Uhr` : `${ab} → ${zurueck} Uhr`
                    );
                  })
                )
              )
            : null,
          // Zwei Sorten: ein Wunschpreis vor der Buchung, oder der schon
          // gezahlte Preis danach. Die zweite ist die interessantere, sie
          // beantwortet "hätte ich warten sollen?", solange man noch
          // umbuchen kann.
          el(
            'div',
            { class: 'field' },
            el('span', { class: 'flabel' }, 'Was soll beobachtet werden?'),
            el(
              'div',
              { class: 'segmented-actions', id: 'weckerArt', role: 'group' },
              ...[
                ['wunsch', 'Wunschpreis', 'Melden, sobald der Preis unter deine Grenze fällt.'],
                ['buchung', 'Ich habe gebucht', 'Melden, sobald es billiger wird als das, was du bezahlt hast, und bei jedem weiteren Rückgang.'],
              ].map(([wert, text, titel]) =>
                el(
                  'button',
                  {
                    type: 'button',
                    'data-art': wert,
                    'aria-pressed': String(weckerArt === wert),
                    class: weckerArt === wert ? 'on' : '',
                    title: titel,
                    onclick: () => {
                      weckerArt = wert;
                      renderWecker();
                    },
                  },
                  text
                )
              )
            )
          ),
          el('div', { class: 'field' },
            el(
              'label',
              { id: 'weckerGrenzeLabel', class: 'flabel', for: 'weckerGrenze' },
              (weckerArt === 'buchung' ? 'Was du bezahlt hast' : 'Wunschpreis') +
                (providerById(PROVIDER).markets.find((m) => m.host === g.hosts[0])?.cur
                  ? ' in ' + providerById(PROVIDER).markets.find((m) => m.host === g.hosts[0]).cur
                  : '')
            ),
            el('input', {
              type: 'number',
              id: 'weckerGrenze',
              placeholder: weckerArt === 'buchung' ? 'Gesamtpreis der Buchung' : 'z. B. 300',
              min: '1',
              step: '0.01',
            })
          ),
          el(
            'p',
            { class: 'note' },
            weckerArt === 'buchung'
              ? 'Wird alle sechs Stunden nachgeprüft, bis zum Abholtag. Gemeldet wird jeder ' +
                'neue Tiefstand unter deinem Preis, nicht immer wieder derselbe. Ob sich das ' +
                'Umbuchen lohnt, hängt an den Stornobedingungen deiner Buchung; die kennt ' +
                'dieses Werkzeug nicht.'
              : 'Wird alle sechs Stunden nachgeprüft und meldet sich einmal, sobald der Preis ' +
                'unter deiner Grenze liegt.'
          ),
          el(
            'button',
            { type: 'button', class: 'primary', onclick: legeWeckerAn },
            weckerArt === 'buchung' ? 'Buchung beobachten' : 'Preiswecker aktivieren'
          )
        )
      : el('p', { class: 'note' }, 'Oben eine beobachtete Suche und eine Klasse wählen.')
  );

  if (getippt && $('#weckerGrenze')) {
    $('#weckerGrenze').value = getippt;
    if (hatteFokus) $('#weckerGrenze').focus({ preventScroll: true });
  }

  if (!weckerListe.length) {
    setChildren($('#weckerListe'), el('p', { class: 'empty' }, 'Kein Wecker gestellt.'));
    return;
  }

  setChildren(
    $('#weckerListe'),
    ...weckerListe.map((w) => {
      const station = stationByCode(w.station);
      const buchung = w.art === 'buchung';
      // Bei einer beobachteten Buchung ist die eine Zahl, die zählt, die
      // Differenz zum gezahlten Preis, nicht der Preis selbst.
      const ersparnis =
        buchung && w.letzterPreis != null ? w.gebucht - w.letzterPreis : null;
      return el(
        'div',
        { class: 'weckerzeile' + (w.ausgeloest ? ' ausgeloest' : '') },
        el(
          'div',
          { class: 'wtext' },
          el(
            'b',
            {},
            `${station?.name || w.stationName || w.station} · ${w.acriss} · ${w.hostLabel.replace(/^www\./, '')}`,
            buchung ? el('span', { class: 'aktion' }, 'gebucht') : null
          ),
          ersparnis != null
            ? el(
                'span',
                { class: 'sttext' + (ersparnis > 0 ? ' guenstiger' : '') },
                ersparnis > 0
                  ? `Zurzeit ${money(ersparnis, w.waehrung)} billiger als gebucht ` +
                    `(${money(w.letzterPreis, w.waehrung)} statt ${money(w.gebucht, w.waehrung)}).`
                  : `Zurzeit nicht billiger als deine Buchung ` +
                    `(${money(w.letzterPreis, w.waehrung)} gegen ${money(w.gebucht, w.waehrung)}).`
              )
            : null,
          el(
            'span',
            { class: 'sttext' },
            `${pretty(w.von)} → ${pretty(w.bis)}` +
              // Die Uhrzeit gehört dazu: sie entscheidet über den Preis, und
              // ein Wecker, dessen Zeit man nicht sieht, ist eine Falle.
              (w.zeit && w.zeit !== '10:00'
                ? ` ${w.zeit}${w.zeitRueck && w.zeitRueck !== w.zeit ? `→${w.zeitRueck}` : ''}`
                : '') +
              ' · ' +
              (buchung ? `gebucht für ${money(w.gebucht, w.waehrung)}` : `Grenze ${money(w.grenze, w.waehrung)}`) +
              (w.letzterPreis != null ? ` · zuletzt ${money(w.letzterPreis, w.waehrung)}` : '') +
              (w.bestPreis != null && w.bestPreis !== w.letzterPreis
                ? ` · bester ${money(w.bestPreis, w.waehrung)}`
                : '') +
              (w.zuletztGeprueft
                ? ` · geprüft ${new Date(w.zuletztGeprueft).toLocaleString('de-DE', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`
                : ' · noch nicht geprüft') +
              (w.fehler ? ` · ${w.fehler}` : '')
          )
        ),
        w.ausgeloest
          ? el(
              'button',
              {
                type: 'button',
                class: 'ghost mini',
                onclick: async () => {
                  await fetch('/api/wecker/quittieren', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ id: w.id }),
                  });
                  ladeWecker();
                },
              },
              'Gesehen'
            )
          : null,
        el(
          'button',
          {
            type: 'button',
            class: 'ghost mini',
            title: 'Wecker löschen',
            onclick: async () => {
              await fetch('/api/wecker/loeschen', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: w.id }),
              });
              ladeWecker();
            },
          },
          '×'
        )
      );
    }),
    el(
      'div',
      { class: 'btnrow' },
      el(
        'button',
        {
          type: 'button',
          class: 'ghost mini',
          onclick: async () => {
            await fetch('/api/wecker/pruefen', { method: 'POST' });
            flash('Prüfung läuft, das dauert einen Moment.');
            setTimeout(ladeWecker, 15000);
          },
        },
        'Jetzt prüfen'
      )
    )
  );
}

async function legeWeckerAn() {
  const g = kurveGruppen.find((x) => `${x.station}|${x.von}|${x.bis}` === kurveGruppe);
  if (!g || !kurveKlasse) return;

  const grenze = Number($('#weckerGrenze').value);
  if (!(grenze > 0)) {
    flash(
      weckerArt === 'buchung'
        ? 'Bitte eintragen, was die Buchung gekostet hat.'
        : 'Bitte eine Preisgrenze eintragen.'
    );
    $('#weckerGrenze').focus();
    return;
  }

  const host = $('#weckerHost').value;
  const markt = providerById(PROVIDER).markets.find((m) => m.host === host);

  const r = await fetch('/api/wecker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      station: g.station,
      stationName: stationByCode(g.station)?.name || '',
      von: g.von,
      bis: g.bis,
      host,
      hostLabel: markt?.label || host,
      acriss: kurveKlasse,
      art: weckerArt,
      // Die Uhrzeit, zu der geprüft werden soll. Steht keine zur Wahl, ist es
      // die einzige beobachtete, die erste aus der Gruppe.
      ...(() => {
        const wahl = $('#weckerZeit')?.value || (g.zeiten || [])[0] || '10:00|10:00';
        const [zeit, zeitRueck] = wahl.split('|');
        return { zeit, zeitRueck: zeitRueck || zeit };
      })(),
      grenze,
      gebucht: weckerArt === 'buchung' ? grenze : undefined,
      waehrung: markt?.cur || '',
    }),
  });
  const d = await r.json();
  if (!d.ok) {
    flash(d.error || 'Wecker konnte nicht gestellt werden.');
    return;
  }
  flash(
    weckerArt === 'buchung'
      ? 'Buchung wird beobachtet. Erste Prüfung läuft gleich.'
      : 'Wecker gestellt.'
  );
  ladeWecker();
}

/* =========================================================== Verlauf
 *
 * Die Preisergebnisse selbst verfallen nach einer Stunde, bewusst, es ist
 * kein Beobachtungsdienst. Der Verlauf ist etwas anderes: eine Handvoll
 * Momentaufnahmen zum Nachschlagen, "was war letzte Woche derselbe Wagen".
 * Deshalb liegt er im Browser und nicht im Ergebnisspeicher.
 */

const LS_VERLAUF = 'mwt-preistool/verlauf';
const VERLAUF_MAX = 5;

/* ---------------------------------------------------- Verglichene Fahrzeuge
 *
 * Der Verlauf hielt bisher nur Suchen fest: Station, Zeitraum, alle Klassen.
 * Die Frage, die man hinterher aber wirklich hat, lautet nicht "was habe ich
 * am Dienstag gesucht", sondern "welchen Wagen habe ich mir angesehen und was
 * kam dabei heraus", besonders bei den Schutzpaketen, deren Abruf Minuten
 * dauert und die man nicht zweimal holen will.
 *
 * Deshalb eine zweite, eigene Liste: ein Eintrag je Fahrzeugklasse und
 * Zeitraum, mit den Preisen je Laenderseite und, sobald abgerufen, den
 * Schutzpaketen dazu.
 */

const LS_FAHRZEUGE = 'mwt-preistool/fahrzeuge';
const FAHRZEUGE_MAX = 24;

function ladeFahrzeuge() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_FAHRZEUGE) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function speichereFahrzeuge(liste) {
  try {
    localStorage.setItem(LS_FAHRZEUGE, JSON.stringify(liste.slice(0, FAHRZEUGE_MAX)));
  } catch {
    /* privater Modus oder voll */
  }
}

/**
 * Pakete in die vier vergleichbaren Faecher einsortieren.
 *
 * Dieselbe Regel wie in der Schutzansicht: "ohne Schutz" ist das billigste
 * Paket, danach das mit Selbstbeteiligung, dann die beiden SB-freien nach
 * Preis. Ueber die Namen zu gehen traegt nicht, die heissen in jeder Sprache
 * anders.
 */
function schutzFaecher(pakete) {
  const rest = [...(pakete || [])].filter((p) => p.gesamt != null);
  if (!rest.length) return null;

  rest.sort((a, b) => a.gesamt - b.gesamt);
  const ohne = rest.shift();
  const sb = rest.find((p) => p.sbBetrag != null && p.sbBetrag > 0) || null;
  const frei = rest.filter((p) => p !== sb);

  const kurz = (p) => (p ? { name: p.name, gesamt: p.gesamt, aufschlag: p.aufschlag ?? null } : null);
  return { ohne: kurz(ohne), sb: kurz(sb), frei1: kurz(frei[0]), frei2: kurz(frei[1]) };
}

/**
 * Ein angesehenes Fahrzeug festhalten.
 *
 * Wird zweimal gerufen: beim Oeffnen einer Klasse (dann stehen die Preise
 * drin) und nach einem Schutzabruf (dann kommen die Pakete dazu). Der zweite
 * Aufruf ergaenzt den vorhandenen Eintrag, statt einen neuen anzulegen,
 * sonst stuende dasselbe Auto zweimal in der Liste.
 */
function merkeFahrzeug(acriss) {
  if (!acriss) return;

  const jobs = aktuelleJobs().filter((j) => j.gruppe === aktiveGruppe);
  const f = jobs[0];
  if (!f) return;

  const kennung = `${f.station.code}|${f.variant.pickupDate}|${f.variant.returnDate}|${acriss}`;
  const liste = ladeFahrzeuge();
  const vorhanden = liste.find((e) => e.kennung === kennung);

  const preise = [];
  let modell = vorhanden?.modell || null;
  for (const j of jobs) {
    const o = (prices.get(j.key)?.offers || []).find((x) => x.acriss === acriss);
    if (!o) continue;
    if (o.model && !modell) modell = o.model;
    preise.push({
      host: j.market.host,
      land: j.market.label,
      cur: j.market.cur,
      betrag: o.total ?? null,
      proTag: o.perDay ?? null,
      fruehbucher: Boolean(o.fruehbucher),
    });
  }

  // Schutzpakete dieser Klasse, sofern abgerufen.
  const schutzListe = [];
  for (const [k, r] of schutz) {
    if (!k.endsWith(`~${acriss}`)) continue;
    if (!k.includes(`~${f.station.code}~`)) continue;
    if (!k.includes(`~${f.variant.pickupDate}~`)) continue;
    const faecher = schutzFaecher(r.pakete);
    if (!faecher) continue;
    const markt = providerById(PROVIDER).markets.find((m) => m.host === r.host);
    schutzListe.push({ host: r.host, land: markt?.label || r.host, cur: markt?.cur || '', ...faecher });
  }

  // Nichts Neues? Dann auch keinen leeren Eintrag anlegen.
  if (!preise.length && !schutzListe.length && !vorhanden) return;

  const eintrag = {
    kennung,
    acriss,
    modell,
    klasse: decodeAcriss(acriss)?.label || '',
    station: f.station.name,
    stationCode: f.station.code,
    von: f.variant.pickupDate,
    bis: f.variant.returnDate,
    tage: f.variant.duration,
    am: Date.now(),
    preise: preise.length ? preise : vorhanden?.preise || [],
    schutz: schutzListe.length ? schutzListe : vorhanden?.schutz || null,
    notiz: vorhanden?.notiz || '',
  };

  speichereFahrzeuge([eintrag, ...liste.filter((e) => e.kennung !== kennung)]);
}

function ladeVerlauf() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_VERLAUF) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function speichereVerlauf(liste) {
  try {
    localStorage.setItem(LS_VERLAUF, JSON.stringify(liste.slice(0, VERLAUF_MAX)));
  } catch {
    /* privater Modus oder voll, dann eben kein Verlauf */
  }
}

/**
 * Die gerade gezeigte Gruppe als Momentaufnahme sichern.
 *
 * Gleiche Station, gleicher Zeitraum, gleiche Länderseiten überschreiben den
 * vorhandenen Eintrag statt einen zweiten anzulegen, sonst ist die Liste
 * nach dreimal Nachfassen voll mit derselben Suche.
 */
function merkeSuche() {
  const jobs = aktuelleJobs().filter((j) => j.gruppe === aktiveGruppe);
  const fertig = jobs.filter((j) => prices.get(j.key)?.offers?.length);
  if (!fertig.length) return;

  const f = jobs[0];
  const kennung = `${f.station.code}|${f.variant.pickupDate}|${f.variant.returnDate}`;

  // Nicht nur der billigste Wagen je Land, sondern jede Klasse: nur so lassen
  // sich zwei Suchen spaeter fuer eine bestimmte Fahrzeugklasse nebeneinander
  // stellen, und genau darum geht es beim Vergleichen.
  const laender = [];
  const preise = {}; // ACRISS -> { host: Betrag }
  const modelle = {}; // ACRISS -> Modellname

  for (const j of fertig) {
    laender.push({ host: j.market.host, land: j.market.label, cur: j.market.cur });
    for (const o of prices.get(j.key).offers) {
      if (!o.acriss || o.total == null) continue;
      (preise[o.acriss] ||= {})[j.market.host] = o.total;
      if (o.model && !modelle[o.acriss]) modelle[o.acriss] = o.model;
    }
  }

  const treffer = fertig.map((j) => {
    const angebote = prices.get(j.key).offers;
    const billigstes = angebote.reduce((a, b) =>
      (b.total ?? b.perDay ?? Infinity) < (a.total ?? a.perDay ?? Infinity) ? b : a
    );
    return {
      host: j.market.host,
      land: j.market.label,
      betrag: billigstes.total ?? billigstes.perDay ?? null,
      waehrung: billigstes.currency || j.market.cur,
      acriss: billigstes.acriss || null,
      modell: billigstes.model || null,
      klassen: angebote.length,
    };
  });

  // Schutzpreise nur, wenn für diese Gruppe welche abgerufen wurden.
  const schutzTreffer = [...schutz.entries()]
    .filter(([k, r]) => k.includes(`~${f.station.code}~`) && r.pakete?.length)
    .map(([, r]) => ({
      host: r.host,
      acriss: r.acriss,
      pakete: r.pakete.map((p) => ({ name: p.name, gesamt: p.gesamt ?? null })),
    }));

  const eintrag = {
    kennung,
    am: Date.now(),
    station: f.station.name,
    stationCode: f.station.code,
    von: f.variant.pickupDate,
    bis: f.variant.returnDate,
    tage: f.variant.duration,
    treffer,
    laender,
    preise,
    modelle,
    schutz: schutzTreffer.length ? schutzTreffer : null,
  };

  const liste = ladeVerlauf();
  // Eine Notiz überlebt das Neuabrufen derselben Suche, sie gehört dem
  // Nutzer, nicht dem Messwert.
  const alt = liste.find((e) => e.kennung === kennung);
  if (alt?.notiz) eintrag.notiz = alt.notiz;
  speichereVerlauf([eintrag, ...liste.filter((e) => e.kennung !== kennung)]);
}

/** Welche Fahrzeugklasse im Vergleich gezeigt wird. */
let verlaufKlasse = null;

/**
 * Mehrere Suchen nebeneinander.
 *
 * Untereinander liegende Karten beantworten die eigentliche Frage nicht:
 * "war derselbe Wagen letzte Woche billiger?" heisst, zwei Zahlen direkt
 * nebeneinander zu sehen. Deshalb bilden die Suchen die Spalten, die
 * Länderseiten die Zeilen, und oben wird die Fahrzeugklasse gewählt, denn
 * ohne die vergleicht man Golf mit S-Klasse.
 */
function renderVergleich(liste) {
  // Klassen, die in mindestens zwei Suchen vorkommen, führen die Liste an,
  // nur die taugen zum Vergleich.
  const zaehler = new Map();
  for (const e of liste) {
    for (const acriss of Object.keys(e.preise || {})) {
      zaehler.set(acriss, (zaehler.get(acriss) || 0) + 1);
    }
  }
  const klassen = [...zaehler.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  if (!klassen.length) return null;
  if (!klassen.includes(verlaufKlasse)) verlaufKlasse = klassen[0];

  // Alle Länderseiten, die in irgendeiner der Suchen vorkommen.
  const hosts = new Map();
  for (const e of liste) {
    for (const l of e.laender || []) if (!hosts.has(l.host)) hosts.set(l.host, l);
  }
  const zeilen = [...hosts.values()].filter((l) =>
    liste.some((e) => e.preise?.[verlaufKlasse]?.[l.host] != null)
  );

  const modell = liste.map((e) => e.modelle?.[verlaufKlasse]).find(Boolean);

  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Nebeneinander'),
    el(
      'div',
      { class: 'field' },
      el('span', { class: 'flabel' }, 'Fahrzeugklasse'),
      el(
        'div',
        { class: 'pills' },
        ...klassen.slice(0, 24).map((k) =>
          el(
            'button',
            {
              type: 'button',
              class: 'pill' + (k === verlaufKlasse ? ' on' : ''),
              title: `${k}${liste[0]?.modelle?.[k] ? ' · ' + liste[0].modelle[k] : ''}` +
                ` · in ${zaehler.get(k)} von ${liste.length} Suchen`,
              onclick: () => {
                verlaufKlasse = k;
                renderVerlauf();
              },
            },
            k
          )
        )
      )
    ),
    el(
      'p',
      { class: 'note' },
      modell
        ? `${verlaufKlasse}, zum Beispiel ${modell}. Verglichen wird nur innerhalb derselben Währung.`
        : 'Verglichen wird nur innerhalb derselben Währung.'
    ),
    el(
      'div',
      { class: 'tabellenrahmen' },
      el(
        'table',
        { class: 'vergleich' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { class: 'klasse' }, 'Länderseite'),
            ...liste.map((e) =>
              el(
                'th',
                {},
                el('span', {}, pretty(e.von)),
                el('span', { class: 'thcur' }, `${e.tage} Tg · ${e.station.split(' ')[0]}`)
              )
            )
          )
        ),
        el(
          'tbody',
          {},
          ...zeilen.map((l) => {
            // Bester Wert dieser Zeile, aber nur unter gleicher Währung.
            const werte = liste.map((e) => e.preise?.[verlaufKlasse]?.[l.host] ?? null);
            const gueltig = werte.filter((w) => w != null);
            const min = gueltig.length > 1 ? Math.min(...gueltig) : null;

            return el(
              'tr',
              {},
              el('th', { class: 'klasse' }, l.land),
              ...werte.map((w) =>
                el(
                  'td',
                  { class: w != null && w === min ? 'best' : '' },
                  w != null ? el('span', { class: 'betrag' }, money(w, l.cur)) : '–'
                )
              )
            );
          })
        )
      )
    ),
    el(
      'p',
      { class: 'tabnote' },
      'Jede Spalte ist eine gespeicherte Suche. Markiert ist der günstigste ' +
        'Termin je Länderseite, dieselbe Klasse, dieselbe Währung.'
    )
  );
}

/**
 * Ein angesehenes Fahrzeug als Karte.
 *
 * Zeigt, was man beim Vergleichen wirklich wissen will: welcher Wagen, wo,
 * wann, und was er auf welcher Länderseite kostet. Sind Schutzpakete
 * abgerufen, stehen sie darunter, denn die sind der teure Teil des Abrufs und
 * niemand will sie zweimal holen.
 */
function renderFahrzeugkarte(e) {
  const mitPreis = (e.preise || []).filter((p) => p.betrag != null);
  const billigster = mitPreis.length
    ? mitPreis.reduce((a, b) => (b.betrag < a.betrag ? b : a))
    : null;

  return el(
    'section',
    { class: 'card fahrzeugkarte' },
    el(
      'div',
      { class: 'vkopf' },
      el(
        'div',
        {},
        el(
          'h3',
          {},
          e.modell || e.acriss,
          el('span', { class: 'acriss' }, e.acriss)
        ),
        el(
          'p',
          { class: 'note' },
          `${e.klasse ? e.klasse + ' · ' : ''}${e.station} · ${pretty(e.von)} → ${pretty(e.bis)} · ${e.tage} Tage · ` +
            `angesehen ${new Date(e.am).toLocaleString('de-DE', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}`
        )
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'ghost mini',
          title: 'Aus der Liste nehmen',
          onclick: () => {
            speichereFahrzeuge(ladeFahrzeuge().filter((x) => x.kennung !== e.kennung));
            renderVerlauf();
          },
        },
        '×'
      )
    ),

    mitPreis.length
      ? el(
          'div',
          { class: 'tabellenrahmen' },
          el(
            'table',
            { class: 'vergleich' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { class: 'klasse' }, 'Länderseite'),
                el('th', {}, 'Gesamt'),
                el('th', {}, 'pro Tag')
              )
            ),
            el(
              'tbody',
              {},
              ...e.preise.map((p) =>
                el(
                  'tr',
                  {},
                  el(
                    'th',
                    { class: 'klasse' },
                    p.land,
                    p.fruehbucher ? el('span', { class: 'aktion' }, 'Frühbucher') : null
                  ),
                  el(
                    'td',
                    { class: billigster && p.host === billigster.host ? 'best' : '' },
                    p.betrag != null ? el('span', { class: 'betrag' }, money(p.betrag, p.cur)) : '–'
                  ),
                  el('td', {}, p.proTag != null ? `${money(p.proTag, '')}/Tag` : '–')
                )
              )
            )
          )
        )
      : el('p', { class: 'empty' }, 'Für dieses Fahrzeug lagen keine Preise vor.'),

    // Schutzpakete: der Teil, für den man Minuten gewartet hat.
    e.schutz?.length
      ? el(
          'details',
          { class: 'vschutz', open: '' },
          el('summary', {}, `Schutzpakete (${e.schutz.length} Länderseiten)`),
          el(
            'div',
            { class: 'tabellenrahmen' },
            el(
              'table',
              { class: 'vergleich' },
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', { class: 'klasse' }, 'Länderseite'),
                  el('th', {}, 'ohne Schutz'),
                  el('th', {}, 'mit SB'),
                  el('th', {}, 'ohne SB'),
                  el('th', {}, 'Rundum')
                )
              ),
              el(
                'tbody',
                {},
                ...e.schutz.map((s) =>
                  el(
                    'tr',
                    {},
                    el('th', { class: 'klasse' }, s.land),
                    ...['ohne', 'sb', 'frei1', 'frei2'].map((f) =>
                      el(
                        'td',
                        {},
                        s[f]
                          ? el(
                              'span',
                              { class: 'betrag', title: s[f].name },
                              money(s[f].gesamt, s.cur)
                            )
                          : '–'
                      )
                    )
                  )
                )
              )
            )
          )
        )
      : el(
          'p',
          { class: 'note' },
          'Schutzpakete noch nicht abgerufen, in der Preistabelle auf die Zeile klicken.'
        ),

    el('input', {
      type: 'text',
      class: 'notiz',
      value: e.notiz || '',
      placeholder: 'Notiz zu diesem Fahrzeug',
      oninput: (ev) => {
        const alle = ladeFahrzeuge();
        const t = alle.find((x) => x.kennung === e.kennung);
        if (t) {
          t.notiz = ev.target.value;
          speichereFahrzeuge(alle);
        }
      },
    })
  );
}

function renderVerlauf() {
  const liste = ladeVerlauf();
  const fahrzeuge = ladeFahrzeuge();

  if (!liste.length && !fahrzeuge.length) {
    setChildren(
      $('#verlaufBody'),
      el(
        'p',
        { class: 'empty' },
        'Noch nichts angesehen. Klick in der Preistabelle auf eine Fahrzeugzeile, ' +
          'das Auto erscheint dann hier, mitsamt seinen Schutzpreisen.'
      )
    );
    return;
  }

  setChildren(
    $('#verlaufBody'),

    // Die Fahrzeuge zuerst: "welchen Wagen habe ich verglichen" ist die Frage,
    // die man hinterher hat, nicht "was habe ich am Dienstag gesucht".
    fahrzeuge.length ? el('h2', { class: 'statusteil' }, 'Verglichene Fahrzeuge') : null,
    ...fahrzeuge.map(renderFahrzeugkarte),
    fahrzeuge.length
      ? el(
          'div',
          { class: 'btnrow' },
          el(
            'button',
            {
              type: 'button',
              class: 'ghost mini',
              onclick: () => {
                speichereFahrzeuge([]);
                renderVerlauf();
              },
            },
            'Fahrzeugliste leeren'
          )
        )
      : null,

    liste.length ? el('h2', { class: 'statusteil' }, 'Gespeicherte Suchen') : null,
    // Der Vergleich zuerst, er ist der Grund, warum es diese Seite gibt.
    liste.length > 1 ? renderVergleich(liste) : null,
    liste.length > 1 ? el('h2', { class: 'statusteil' }, 'Die einzelnen Suchen') : null,
    ...liste.map((e) => {
      const vergleichbar = e.treffer.filter((t) => t.betrag != null);
      const billigster = vergleichbar.length
        ? vergleichbar.reduce((a, b) => (b.betrag < a.betrag ? b : a))
        : null;

      return el(
        'section',
        { class: 'card verlaufkarte' },
        el(
          'div',
          { class: 'vkopf' },
          el(
            'div',
            {},
            el('h3', {}, e.station),
            el(
              'p',
              { class: 'note' },
              `${pretty(e.von)} → ${pretty(e.bis)} · ${e.tage} Tage · ` +
                `abgerufen ${new Date(e.am).toLocaleString('de-DE', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
            )
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'ghost mini',
              title: 'Diese Suche wieder einstellen',
              onclick: () => {
                state.stations = [e.stationCode];
                state.pickupDate = e.von;
                state.returnDate = e.bis;
                state.dayShifts = [0];
                state.returnShifts = [0];
                state.durations = [];
                state.mode = 'markets';
                aktiveGruppe = null;
                showScreen('work');
                update();
              },
            },
            'Erneut suchen'
          )
        ),
        // Notiz: warum diese Suche aufgehoben wurde. Nach drei Wochen weiss
        // das sonst niemand mehr, auch der nicht, der sie gemacht hat.
        el('input', {
          type: 'text',
          class: 'notiz',
          value: e.notiz || '',
          placeholder: 'Notiz, z. B. „für Mallorca im Mai, Angebot lief noch"',
          oninput: (ev) => {
            const liste = ladeVerlauf();
            const treffer = liste.find((x) => x.kennung === e.kennung);
            if (treffer) {
              treffer.notiz = ev.target.value;
              speichereVerlauf(liste);
            }
          },
        }),
        el(
          'div',
          { class: 'tabellenrahmen' },
          el(
            'table',
            { class: 'vergleich' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { class: 'klasse' }, 'Länderseite'),
                el('th', {}, 'günstigstes Angebot'),
                el('th', {}, 'Klasse'),
                el('th', {}, 'Angebote')
              )
            ),
            el(
              'tbody',
              {},
              ...e.treffer.map((t) =>
                el(
                  'tr',
                  {},
                  el('th', { class: 'klasse' }, t.land),
                  el(
                    'td',
                    { class: billigster && t.host === billigster.host ? 'best' : '' },
                    t.betrag != null
                      ? el('span', { class: 'betrag' }, money(t.betrag, t.waehrung))
                      : '–'
                  ),
                  el(
                    'td',
                    {},
                    t.acriss ? el('span', { class: 'acriss' }, t.acriss) : '–',
                    t.modell ? el('span', { class: 'proTag' }, t.modell) : null
                  ),
                  el('td', {}, String(t.klassen))
                )
              )
            )
          )
        ),
        e.schutz
          ? el(
              'details',
              { class: 'vschutz' },
              el('summary', {}, `Schutzpakete (${e.schutz.length} Länderseiten)`),
              ...e.schutz.map((s) =>
                el(
                  'p',
                  { class: 'note' },
                  el('b', {}, `${s.host.replace(/^www\./, '')} · ${s.acriss}: `),
                  s.pakete
                    .map((p) => `${p.name}${p.gesamt != null ? ` ${p.gesamt.toFixed(2)}` : ''}`)
                    .join(' · ')
                )
              )
            )
          : null
      );
    }),
    el(
      'div',
      { class: 'btnrow' },
      el(
        'button',
        {
          type: 'button',
          class: 'ghost mini',
          onclick: () => {
            speichereVerlauf([]);
            renderVerlauf();
          },
        },
        'Verlauf leeren'
      )
    )
  );
}

/* =========================================================== Adressen */

/**
 * Adresse einer Station.
 *
 * Sixt bildet sie aus der Stationsnummer: Flughafenstationen `ap<Nummer>`,
 * alle uebrigen `dt<Nummer>`. Ob eine Station als Flughafen zaehlt, steht als
 * `flughafen` am Datensatz und entscheidet sich am Namen (siehe build.mjs),
 * das IATA-Feld taugt dafuer nicht, das haben nur 43 von 2250 Stationen.
 */
function stationsAdresse(station, alsFlughafen = station.flughafen === true) {
  return `${alsFlughafen ? 'ap' : 'dt'}${station.code}@sixt.com`;
}

/** Stationen auf der Adressliste; Wert sagt, ob als Flughafen gewertet wird. */
const mailAuswahl = new Map();

function renderMailTreffer() {
  const needle = $('#mailSuche').value;
  const hits = suche(needle);
  const scroll = $('#mailTreffer').scrollTop;

  $('#mailAnzahl').textContent =
    `${hits.length} von ${ALLE_STATIONEN.length} Stationen` +
    (needle.trim() ? '' : ', tippen zum Filtern');
  $('#mailAlleTreffer').hidden = !needle.trim() || !hits.length;
  $('#mailAlleTreffer').textContent = `Alle ${hits.length} übernehmen`;

  setChildren(
    $('#mailTreffer'),
    ...hits.map((s) => {
      const drin = mailAuswahl.has(s.code);
      return el(
        'button',
        {
          type: 'button',
          class: 'station' + (drin ? ' on' : ''),
          title: `${stationsAdresse(s)} · Stationsnummer ${s.code}`,
          onclick: () => {
            if (drin) mailAuswahl.delete(s.code);
            else mailAuswahl.set(s.code, s.flughafen === true);
            renderMail();
          },
        },
        el('span', { class: 'flag' }, s.country),
        el('span', { class: 'sname' }, s.name),
        el('span', { class: 'art' }, s.flughafen ? 'ap' : 'dt')
      );
    }),
    hits.length ? null : el('p', { class: 'empty' }, 'Keine Station gefunden.')
  );
  $('#mailTreffer').scrollTop = scroll;
}

function mailAdressen() {
  return [...mailAuswahl]
    .map(([code, alsFlughafen]) => {
      const s = stationByCode(code);
      return s ? stationsAdresse(s, alsFlughafen) : null;
    })
    .filter(Boolean);
}

function renderMailListe() {
  const eintraege = [...mailAuswahl];
  $('#mailListeKarte').hidden = !eintraege.length;
  if (!eintraege.length) return;

  setChildren(
    $('#mailListe'),
    ...eintraege.map(([code, alsFlughafen]) => {
      const s = stationByCode(code);
      if (!s) return null;
      const adresse = stationsAdresse(s, alsFlughafen);
      return el(
        'div',
        { class: 'mailzeile' },
        el(
          'div',
          { class: 'mailort' },
          el('b', {}, s.name),
          el('span', { class: 'gid' }, s.code)
        ),
        el('code', { class: 'mailadr' }, adresse),
        // Die Einordnung ist geraten, nicht gewusst, also umstellbar.
        el(
          'button',
          {
            type: 'button',
            class: 'ghost mini',
            title: alsFlughafen
              ? 'Als Stadtstation behandeln (dt)'
              : 'Als Flughafenstation behandeln (ap)',
            onclick: () => {
              mailAuswahl.set(code, !alsFlughafen);
              renderMail();
            },
          },
          alsFlughafen ? 'ap → dt' : 'dt → ap'
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'ghost mini',
            onclick: async () => {
              await navigator.clipboard.writeText(adresse).catch(() => {});
              flash(`${adresse} kopiert`);
            },
          },
          'Kopieren'
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'ghost mini',
            title: 'Von der Liste nehmen',
            onclick: () => {
              mailAuswahl.delete(code);
              renderMail();
            },
          },
          '×'
        )
      );
    })
  );
}

function renderMail() {
  renderMailTreffer();
  renderMailListe();
}


/* =========================================================== Stationen */

function renderStationPicker() {
  const needle = $('#stationSearch').value;
  const hits = suche(needle);
  // Scrollstand merken: die Liste wird komplett neu aufgebaut, und ohne das
  // springt sie bei jedem Klick an den Anfang zurueck.
  const scroll = $('#stationResults').scrollTop;

  $('#stationCount').textContent =
    `${hits.length} von ${ALLE_STATIONEN.length} Stationen` +
    (needle.trim() ? '' : ', tippen zum Filtern');
  $('#addAll').hidden = !needle.trim() || !hits.length;
  $('#addAll').textContent = `Alle ${hits.length} hinzufügen`;

  setChildren(
    $('#stationResults'),
    ...hits.map((s) => {
      const on = state.stations.includes(s.code);
      return el(
        'button',
        {
          type: 'button',
          class: 'station' + (on ? ' on' : ''),
          title: `Sixt-Stationsnummer ${s.code}`,
          onclick: () => {
            const i = state.stations.indexOf(s.code);
            if (i >= 0) state.stations.splice(i, 1);
            else state.stations.push(s.code);
            update();
          },
        },
        el('span', { class: 'flag' }, s.country),
        el('span', { class: 'sname' }, s.name),
        s.iata ? el('span', { class: 'iata' }, s.iata) : null
      );
    }),
    hits.length ? null : el('p', { class: 'empty' }, 'Keine Station gefunden.')
  );
  $('#stationResults').scrollTop = scroll;

  const gewählt = state.stations.map(stationByCode).filter(Boolean);
  setChildren(
    $('#chosenStations'),
    ...gewählt.map((s) =>
      el(
        'span',
        { class: 'chip' },
        s.name,
        el('span', { class: 'chipid' }, s.code),
        el('button', {
          type: 'button',
          class: 'x',
          html: '&times;',
          onclick: () => {
            state.stations = state.stations.filter((c) => c !== s.code);
            update();
          },
        })
      )
    ),
    gewählt.length ? null : el('span', { class: 'empty' }, 'Noch keine Station gewählt.')
  );

  const sel = $('#returnStation');
  setChildren(
    sel,
    el('option', { value: '' }, ', gleiche wie Abholung, '),
    ...gewählt.map((s) =>
      el('option', { value: s.code, selected: state.returnStation === s.code }, s.name)
    )
  );
}
/* =========================================================== Märkte, Pills */

/**
 * Laenderseiten als Chips statt als Liste von Ankreuzfeldern.
 *
 * 23 Kaestchen untereinander sind ein Formular; als Chipfeld ist dieselbe
 * Auswahl halb so hoch und auf einen Blick erfassbar, man sieht sofort, was
 * gewaehlt ist, ohne 23 Zeilen abzusuchen.
 */
function renderMarkets() {
  $('#marketSelectionCount').textContent = `${state.markets.length} ausgewählt`;
  setChildren(
    $('#markets'),
    ...providerById(PROVIDER).markets.map((m) => {
      const on = state.markets.includes(m.code);
      return el(
        'button',
        {
          type: 'button',
          // Gestörte Länderseiten bleiben sichtbar, aber nicht wählbar. Sie
          // stillschweigend zu entfernen wirft nur die Frage auf, wo sie
          // geblieben sind.
          class: 'mchip' + (on ? ' on' : '') + (m.gestoert ? ' gestoert' : ''),
          disabled: m.gestoert ? '' : null,
          'aria-pressed': String(on),
          'aria-label': `${m.label}, ${m.cur}${m.gestoert ? ', derzeit gestört' : ''}`,
          title: m.gestoert || `${m.label} · ${m.host}`,
          'data-market': m.code,
          onclick: () => {
            if (m.gestoert) return;
            if (on) state.markets = state.markets.filter((c) => c !== m.code);
            else state.markets.push(m.code);
            // Nur das Ergebnis neu zeichnen: die Stationsliste anzufassen
            // liesse sie zurueckscrollen.
            update({ stationen: false });
            // Der neu gezeichnete Schalter behält den Tastaturfokus.
            [...$('#markets').children].find((b) => b.dataset.market === m.code)?.focus({ preventScroll: true });
          },
        },
        el('span', { class: 'market-code', 'aria-hidden': 'true' }, m.code.toUpperCase()),
        el('span', { class: 'market-copy' }, el('span', { class: 'mklabel' }, m.label), el('span', { class: 'market-domain' }, m.host.replace(/^www\./, ''))),
        el(
          'span',
          { class: 'market-trailing', 'aria-hidden': 'true' },
          el('span', { class: 'market-check' }, m.gestoert ? '⚠' : on ? '✓' : ''),
          el('span', { class: 'cur' }, m.gestoert ? 'gestört' : m.cur)
        )
      );
    })
  );
}

/**
 * Gestörte Länderseiten aus einer Auswahl nehmen.
 *
 * Sie können noch aus einer früheren Sitzung im gespeicherten Zustand stehen,
 * und dann liefe jeder Abruf sehenden Auges in einen Fehlschlag.
 */
function ohneGestoerte(codes) {
  const gestoert = new Set(
    providerById(PROVIDER).markets.filter((m) => m.gestoert).map((m) => m.code)
  );
  return codes.filter((c) => !gestoert.has(c));
}

function renderPills(sel, opts, list, label, onEmpty) {
  setChildren(
    $(sel),
    ...opts.map((n) =>
      el(
        'label',
        { class: 'pill' + (list().includes(n) ? ' on' : '') },
        el('input', {
          type: 'checkbox',
          checked: list().includes(n),
          onchange: (e) => {
            const arr = list();
            if (e.target.checked) arr.push(n);
            else {
              const i = arr.indexOf(n);
              if (i >= 0) arr.splice(i, 1);
            }
            onEmpty(arr);
            update({ stationen: false });
          },
        }),
        label(n)
      )
    )
  );
}

/* =========================================================== Tabelle */

/**
 * Zeilen sind Fahrzeugklassen (ACRISS), Spalten die Laenderseiten.
 *
 * Drei Zustaende je Zelle:
 *   Preis            buchbar
 *   "nicht buchbar"  Klasse dort schon einmal gesehen, heute kein Angebot
 *   leer             dort noch nie gesehen
 */
function renderTable(list) {
  // Vor dem ersten Ergebnis ist ein klarer Leerzustand hilfreicher als
  // dutzende Katalogzeilen mit leeren Preisspalten.
  if (!list.some((j) => prices.has(j.key))) return null;
  const spalten = list;
  const zeilen = new Map();

  for (const j of spalten) {
    const rec = prices.get(j.key);
    for (const o of rec?.offers || []) {
      const cls = classify(o);
      if (!zeilen.has(cls.key)) zeilen.set(cls.key, { cls, zellen: new Map(), beispiel: o });
      const z = zeilen.get(cls.key);

      // Beschriftung: Sixts eigener Kategorietext schlägt meine ACRISS-
      // Dekodierung. Sixt führt Buchstaben, die nicht im Standard stehen
      // (S und L für Automatik, P als Antrieb), deren Text ist damit immer
      // richtiger als jede Tabelle, die ich pflege. Der Code bleibt die
      // Verknüpfung über die Sprachen hinweg, der Text nur die Anzeige.
      if (o.category && !z.eigenerText) z.eigenerText = o.category;
      const bisher = z.zellen.get(j.key);
      const wert = o.total ?? o.perDay ?? Infinity;
      const alt = bisher ? (bisher.total ?? bisher.perDay ?? Infinity) : Infinity;
      if (wert < alt) z.zellen.set(j.key, o);
      if (!z.beispiel.image && o.image) z.beispiel = o;
    }
  }

  // Bekannte, aktuell nicht buchbare Klassen ergaenzen.
  if (state.zeigeNichtBuchbare) {
    for (const [acriss, info] of Object.entries(katalog)) {
      if (zeilen.has(acriss)) continue;
      const d = decodeAcriss(acriss);
      if (!d) continue;
      zeilen.set(acriss, {
        cls: { key: acriss, ...d, exakt: true },
        zellen: new Map(),
        beispiel: { image: info?.bild || null, model: (info?.modelle || [])[0] || '' },
        nurKatalog: true,
      });
    }
  }

  if (!zeilen.size) return null;

  const sortiert = [...zeilen.values()].sort(
    (a, b) => classOrder(a.cls.key) - classOrder(b.cls.key) || a.cls.label.localeCompare(b.cls.label)
  );

  // Waehrungen: markiert wird nur innerhalb derselben Waehrung.
  const spaltenJeWährung = new Map();
  for (const z of zeilen.values()) {
    for (const [k, o] of z.zellen) {
      if (!spaltenJeWährung.has(o.currency)) spaltenJeWährung.set(o.currency, new Set());
      spaltenJeWährung.get(o.currency).add(k);
    }
  }
  const vergleichbar = new Set([...spaltenJeWährung].filter(([, s]) => s.size > 1).map(([w]) => w));
  const gemischt = spaltenJeWährung.size > 1;

  function minima(z) {
    const min = new Map();
    const anzahl = new Map();
    for (const o of z.zellen.values()) {
      const w = o.total ?? o.perDay;
      if (w == null) continue;
      anzahl.set(o.currency, (anzahl.get(o.currency) || 0) + 1);
      const b = min.get(o.currency);
      if (b == null || w < b) min.set(o.currency, w);
    }
    return { min, anzahl };
  }

  // Läuft auf einer Spalte gerade der Frühbucherrabatt?
  const fruehbucherSpalten = new Set();
  for (const z of zeilen.values()) {
    for (const [k, o] of z.zellen) if (o.fruehbucher) fruehbucherSpalten.add(k);
  }

  const kopf = el(
    'tr',
    {},
    el('th', { class: 'klasse' }, 'Fahrzeug'),
    ...spalten.map((j) =>
      el(
        'th',
        {},
        el('a', { href: j.url, target: '_blank', rel: 'noopener' }, j.market.label),
        el('span', { class: 'thcur' }, j.market.cur),
        // Der Abruf hat selbst gemerkt, dass Zahlen nicht zusammenpassen,
        // das gehört an die Spalte, nicht nur ins Protokoll.
        prices.get(j.key)?.warnung
          ? el('span', { class: 'aktion warnmark', title: prices.get(j.key).warnung }, 'Prüfen')
          : null,
        fruehbucherSpalten.has(j.key)
          ? el('span', { class: 'aktion', title: 'Frühbucherrabatt aktiv' }, 'Frühbucher')
          : prices.get(j.key)
            ? null
            : el('span', { class: 'thwait' }, 'lädt …')
      )
    )
  );

  const körper = sortiert.map((z) => {
    const { min, anzahl } = minima(z);
    const bild = z.beispiel?.image;

    return el(
      'tr',
      {
        class: 'zeile' + (z.nurKatalog ? ' nurkatalog' : ''),
        onclick: () => öffneSchutz(z.cls.key),
        title: 'Schutzpakete für diese Klasse vergleichen',
      },
      el(
        'th',
        { class: 'klasse' },
        el(
          'span',
          { class: 'fzg' },
          bild
            ? el('img', {
                src: bild,
                alt: '',
                loading: 'lazy',
                class: 'fbild',
                // Aus dem Zwischenspeicher ist das Bild sofort da, dann gar
                // nicht erst ueberblenden.
                onload: (e) => e.target.classList.add('geladen'),
                onerror: (e) => e.target.classList.add('geladen'),
              })
            : el('span', { class: 'fbild leer' }),
          el(
            'span',
            { class: 'ftext2' },
            el('span', { class: 'fmodell' }, z.beispiel?.model || z.cls.label),
            el(
              'span',
              { class: 'fklasse' },
              el('span', { class: 'acriss' }, z.cls.acriss || '–'),
              z.eigenerText || z.cls.label
            )
          )
        )
      ),
      ...spalten.map((j) => {
        const o = z.zellen.get(j.key);
        if (!o) {
          const geladen = prices.get(j.key);
          if (!geladen) return el('td', { class: 'leer' }, '');
          // Bekannt, aber heute nicht im Angebot.
          const bekannt = katalog[z.cls.key];
          return el(
            'td',
            { class: 'leer' },
            bekannt ? el('span', { class: 'nichtbuchbar' }, 'nicht buchbar') : '–'
          );
        }
        const roh = o.total ?? o.perDay;
        const wert = roh;
        const billigste =
          vergleichbar.has(o.currency) &&
          (anzahl.get(o.currency) || 0) > 1 &&
          roh === min.get(o.currency);

        return el(
          'td',
          {
            class: (billigste ? 'best' : '') + (o.unstimmig ? ' unstimmig' : ''),
            title:
              (o.unstimmig ? 'Betrag passt nicht zum Tagespreis, bitte auf der Seite prüfen. ' : '') +
              `${o.model}${o.unlimitedKm ? ' · unbegrenzte km' : ''}${
                o.aktionen?.length ? ' · ' + o.aktionen.join(' · ') : ''
              }`,
          },
          el('span', { class: 'betrag' }, money(wert, o.currency)),
          el(
            'span',
            { class: 'proTag' },
            `${money(o.perDay, '')}/Tag`,
            o.fruehbucher ? el('span', { class: 'fbmark', title: 'Frühbucherrabatt' }, 'FB') : null
          )
        );
      })
    );
  });

  return el(
    'div',
    { class: 'tabellenblock' },
    el(
      'div',
      { class: 'tabellenrahmen' },
      el('table', { class: 'vergleich' }, el('thead', {}, kopf), el('tbody', {}, ...körper))
    ),
    el(
      'p',
      { class: 'tabnote' },
      'Zeile anklicken zeigt die Schutzpakete dieser Klasse im Ländervergleich.',
      gemischt
        ? ` Mehrere Währungen (${[...spaltenJeWährung.keys()].join(', ')}), markiert wird nur innerhalb derselben Währung, es wird nicht umgerechnet.`
        : '',
      fruehbucherSpalten.size && fruehbucherSpalten.size < spalten.length
        ? ' Achtung: der Frühbucherrabatt läuft nicht auf allen Länderseiten. Spalten mit „Frühbucher" sind dadurch im Vorteil.'
        : ''
    )
  );
}

/* =========================================================== Bühne */

/**
 * Der Fund als Satz, die Bühne oben auf der Seite.
 *
 * Zeigt das guenstigste Angebot ueber alle abgerufenen Laenderseiten und
 * wieviel es gegenueber der teuersten Seite derselben Klasse spart. Solange
 * nichts abgerufen ist, steht hier die Aufforderung statt einer Zahl, eine
 * leere Buehne waere schlimmer als gar keine.
 */
function renderHeld() {
  const held = $('#held');
  // Nur die gezeigte Station und ihren Termin. Ueber alle Gruppen hinweg zu
  // suchen ergaebe einen Satz, der "gleiche Station, gleicher Zeitraum"
  // behauptet und dabei zwei verschiedene Staedte vergleicht.
  const alle = aktuelleJobs();
  const jobs = alle.filter((j) => j.gruppe === aktiveGruppe);
  const v = jobs[0]?.variant;

  const tage = v?.duration ?? Math.max(1, daysBetween(state.pickupDate, state.returnDate));
  const von = v?.pickupDate ?? state.pickupDate;
  const bis = v?.returnDate ?? state.returnDate;
  const zeit = `${pretty(von)} → ${pretty(bis)} · ${tage} Tage`;

  // Bestes Angebot je Klasse suchen, nur innerhalb derselben Waehrung.
  let bester = null;
  for (const j of jobs) {
    for (const o of prices.get(j.key)?.offers || []) {
      const wert = o.total ?? o.perDay;
      if (wert == null) continue;
      if (!bester || wert < bester.wert) bester = { wert, o, job: j };
    }
  }

  if (!bester) {
    setChildren(
      held,
      el(
        'div',
        { class: 'heldleer' },
        el('p', { class: 'lab' }, 'DEIN VERGLEICH IST VORBEREITET'),
        el(
          'h2',
          {},
          // Die Buehne zeigt immer genau die gewaehlte Gruppe, auch wenn
          // dort noch nichts abgerufen ist.
          jobs[0]
            ? `${jobs[0].station.name} · ${jobs.length} Länderseite${jobs.length === 1 ? '' : 'n'}`
            : state.stations.length
              ? 'Länderseite wählen'
              : 'Station wählen'
        ),
        el('p', { class: 'unter' }, zeit)
      )
    );
    return;
  }

  // Teuerste Seite derselben Klasse und Waehrung, daraus die Ersparnis.
  let teuerste = null;
  for (const j of jobs) {
    const t = (prices.get(j.key)?.offers || []).find(
      (o) => o.acriss === bester.o.acriss && o.currency === bester.o.currency
    );
    const wert = t?.total ?? t?.perDay;
    if (wert != null && (teuerste == null || wert > teuerste)) teuerste = wert;
  }
  const spart = teuerste != null ? teuerste - bester.wert : null;

  setChildren(
    held,
    bester.o.image
      ? el('img', {
          src: bester.o.image,
          alt: '',
          class: 'heldbild',
          onload: (e) => e.target.classList.add('geladen'),
          onerror: (e) => e.target.classList.add('geladen'),
        })
      : null,
    el(
      'div',
      { class: 'heldtext' },
      el(
        'p',
        { class: 'lab' },
        // Bei mehreren Stationen muss dranstehen, welche gemeint ist, der
        // Satz darunter gilt nur fuer diese eine.
        new Set(alle.map((j) => j.gruppe)).size > 1
          ? `Günstigster Fund · ${bester.job.station.name}`
          : 'Günstigster Fund'
      ),
      el(
        'h2',
        {},
        // Kein zusammengebautes Adjektiv aus dem Landesnamen, daraus wird
        // schnell "spanienen". Der Host sagt ohnehin mehr aus.
        `${bester.o.model} für `,
        el('em', {}, money(bester.wert, bester.o.currency)),
        ` auf ${bester.job.market.host.replace(/^www\./, '')}.`
      ),
      spart && spart > 0.5
        ? el(
            'p',
            { class: 'unter' },
            `${money(spart, bester.o.currency)} weniger als auf der teuersten geprüften Seite, ` +
              'gleiche Station, gleicher Zeitraum, gleiche Klasse.'
          )
        : el('p', { class: 'unter' }, 'Auf allen geprüften Länderseiten gleich teuer.'),
      el(
        'div',
        { class: 'werte' },
        el(
          'div',
          {},
          el('span', { class: 'z' }, `${tage} Tage`),
          el('span', { class: 'w' }, zeit.split(' · ')[0])
        ),
        el(
          'div',
          {},
          el('span', { class: 'z' }, String(jobs.filter((j) => prices.has(j.key)).length)),
          el('span', { class: 'w' }, `von ${jobs.length} Länderseiten`)
        ),
        el(
          'div',
          {},
          el('span', { class: 'z' }, bester.o.acriss || '–'),
          el('span', { class: 'w' }, 'günstigste Klasse')
        )
      )
    )
  );
}

/* ------------------------------------------------- Stationen gegenüberstellen
 *
 * Bei mehreren Stationen entstehen Reiter, und man klickt hin und her, um zu
 * sehen, welche günstiger ist. Diese Rechnung sagt es.
 *
 * Nicht als Durchschnitt aller Angebote: eine Station, die drei Luxuswagen im
 * Katalog hat, bekäme den höheren Schnitt, auch dann, wenn sie bei jeder
 * Klasse billiger ist, die es an beiden gibt. Verglichen wird deshalb
 * paarweise über die Klassen, die überall vorkommen.
 */

/**
 * Stellt die Stationen derselben Datumsvariante gegenüber.
 *
 * @returns {Array|null} je Währung ein Vergleich, oder null wenn es nichts
 *   zu vergleichen gibt.
 */
function stationsvergleich() {
  const jobs = aktuelleJobs();
  if (!jobs.length) return null;

  // Nur derselbe Termin. Gruppen heissen station|von|bis; über zwei Termine
  // hinweg zu vergleichen stellte zwei verschiedene Reisen nebeneinander.
  const aktiv = jobs.find((j) => j.gruppe === aktiveGruppe);
  if (!aktiv) return null;
  const { pickupDate, returnDate } = aktiv.variant;
  const passend = jobs.filter(
    (j) => j.variant.pickupDate === pickupDate && j.variant.returnDate === returnDate
  );

  // Je Station: die günstigste Klasse über alle Länderseiten, getrennt nach
  // Währung. Zwei Währungen sind zwei verschiedene Fragen, umgerechnet wird
  // hier grundsätzlich nicht.
  const stationen = new Map();
  for (const j of passend) {
    const st = stationen.get(j.station.code) || {
      station: j.station,
      gruppe: j.gruppe,
      seiten: 0,
      mitErgebnis: 0,
      /** waehrung → acriss → günstigster Gesamtpreis */
      preise: new Map(),
    };
    st.seiten++;
    const r = prices.get(j.key);
    if (r?.offers?.length) st.mitErgebnis++;
    for (const o of r?.offers || []) {
      const wert = o.total ?? o.perDay;
      if (!o.acriss || wert == null || o.unstimmig) continue;
      const w = o.currency || '';
      if (!st.preise.has(w)) st.preise.set(w, new Map());
      const nach = st.preise.get(w);
      if (!nach.has(o.acriss) || wert < nach.get(o.acriss)) nach.set(o.acriss, wert);
    }
    stationen.set(j.station.code, st);
  }
  if (stationen.size < 2) return null;

  const alle = [...stationen.values()];
  // Eine Station, die nichts geliefert hat, gehört nicht in den Vergleich,
  // aber sie verschwindet auch nicht stillschweigend, sondern wird benannt.
  const ohneErgebnis = alle.filter((s) => !s.mitErgebnis);
  const dabei = alle.filter((s) => s.mitErgebnis);
  // Bleibt nur eine Station übrig, gibt es nichts zu vergleichen. Das ist
  // aber kein Grund zu schweigen: sonst fehlt der Kasten und man rätselt,
  // warum. Liegt für gar keine Station etwas vor, ist der Vergleich schlicht
  // noch nicht dran, dann still bleiben.
  if (dabei.length < 2) {
    return dabei.length && ohneErgebnis.length
      ? [{ waehrung: null, nurHinweis: true, ohneErgebnis, dabei }]
      : null;
  }

  const waehrungen = new Set();
  for (const s of dabei) for (const w of s.preise.keys()) waehrungen.add(w);

  const ergebnisse = [];
  for (const waehrung of waehrungen) {
    const mit = dabei.filter((s) => (s.preise.get(waehrung)?.size ?? 0) > 0);
    if (mit.length < 2) continue;

    // Nur Klassen, die es an allen verglichenen Stationen gibt.
    let gemeinsam = [...mit[0].preise.get(waehrung).keys()];
    for (const s of mit.slice(1)) {
      const hat = s.preise.get(waehrung);
      gemeinsam = gemeinsam.filter((a) => hat.has(a));
    }

    if (!gemeinsam.length) {
      ergebnisse.push({ waehrung, stationen: mit, gemeinsam: [], sieger: null, ohneErgebnis });
      continue;
    }

    // Je Klasse: wer ist am billigsten, und wie weit liegt der Rest zurück?
    const punkte = new Map(mit.map((s) => [s.station.code, 0]));
    const abstaende = new Map(mit.map((s) => [s.station.code, []]));
    for (const acriss of gemeinsam) {
      let bester = null;
      for (const s of mit) {
        const p = s.preise.get(waehrung).get(acriss);
        if (bester == null || p < bester.p) bester = { p, code: s.station.code };
      }
      punkte.set(bester.code, punkte.get(bester.code) + 1);
      for (const s of mit) {
        const p = s.preise.get(waehrung).get(acriss);
        // Abstand zum Besten dieser Klasse, für den Sieger ist er null.
        if (s.station.code !== bester.code) {
          abstaende.get(s.station.code).push({ acriss, diff: p - bester.p, anteil: (p - bester.p) / bester.p });
        }
      }
    }

    const sieger = mit.reduce((a, b) =>
      punkte.get(b.station.code) > punkte.get(a.station.code) ? b : a
    );
    const siegerPreise = sieger.preise.get(waehrung);

    // Wie weit die anderen im Mittel danebenliegen, gerechnet gegen den
    // Sieger, nicht gegen den jeweils Besten. Sonst stünde eine Zahl da, die
    // keiner Gegenüberstellung entspricht.
    const gegner = mit
      .filter((s) => s !== sieger)
      .map((s) => {
        const eigene = s.preise.get(waehrung);
        const diffs = gemeinsam.map((a) => eigene.get(a) - siegerPreise.get(a));
        const summe = diffs.reduce((x, y) => x + y, 0);
        const basis = gemeinsam.reduce((x, a) => x + siegerPreise.get(a), 0);
        return {
          station: s.station,
          gruppe: s.gruppe,
          // Klassen, bei denen der Herausforderer den Sieger unterbietet.
          billigerBei: gemeinsam.filter((a) => eigene.get(a) < siegerPreise.get(a)),
          mittel: summe / gemeinsam.length,
          prozent: basis ? (summe / basis) * 100 : 0,
        };
      });

    ergebnisse.push({
      waehrung,
      stationen: mit,
      gemeinsam,
      sieger: {
        station: sieger.station,
        gruppe: sieger.gruppe,
        gewinntBei: punkte.get(sieger.station.code),
        von: gemeinsam.length,
      },
      gegner,
      ohneErgebnis,
    });
  }

  return ergebnisse.length ? ergebnisse : null;
}

function renderStationsvergleich() {
  const v = stationsvergleich();
  if (!v) return null;

  const mehrereWaehrungen = v.length > 1;

  return el(
    'section',
    { class: 'stationsvergleich', 'aria-label': 'Stationen im Vergleich' },
    ...v.map((e) =>
      e.nurHinweis
        ? el(
            'div',
            { class: 'sv-block' },
            el('p', { class: 'eyebrow' }, 'STATIONEN IM VERGLEICH'),
            el(
              'p',
              { class: 'sv-satz' },
              'Kein Vergleich möglich: nur ',
              el('b', {}, e.dabei[0].station.name),
              ' hat Preise geliefert.'
            ),
            el(
              'p',
              { class: 'sv-fuss warn' },
              `Ohne Ergebnis: ${e.ohneErgebnis.map((s) => s.station.name).join(', ')}. ` +
                'Abruf für diese Station wiederholen, dann steht der Vergleich hier.'
            )
          )
        : el(
        'div',
        { class: 'sv-block' },
        el(
          'p',
          { class: 'eyebrow' },
          'STATIONEN IM VERGLEICH' + (mehrereWaehrungen ? ` · ${e.waehrung}` : '')
        ),
        !e.gemeinsam.length
          ? el(
              'p',
              { class: 'sv-satz' },
              'Diese Stationen haben keine Fahrzeugklasse gemeinsam, es gibt nichts, ' +
                'was sich sauber gegenüberstellen ließe.'
            )
          : el(
              'p',
              { class: 'sv-satz' },
              el(
                'button',
                {
                  type: 'button',
                  class: 'sv-name',
                  onclick: () => {
                    aktiveGruppe = e.sieger.gruppe;
                    renderResults({ erzwingen: true });
                  },
                  title: 'Tabelle dieser Station zeigen',
                },
                e.sieger.station.name
              ),
              ' ist günstiger, bei ',
              el('b', {}, `${e.sieger.gewinntBei} von ${e.sieger.von}`),
              ' gemeinsamen Klassen.'
            ),
        ...e.gegner.map((g) =>
          el(
            'p',
            { class: 'sv-zeile' },
            el(
              'button',
              {
                type: 'button',
                class: 'sv-name leise',
                onclick: () => {
                  aktiveGruppe = g.gruppe;
                  renderResults({ erzwingen: true });
                },
                title: 'Tabelle dieser Station zeigen',
              },
              g.station.name
            ),
            g.mittel > 0.005
              ? el(
                  'span',
                  {},
                  ' liegt im Mittel ',
                  el('b', {}, money(g.mittel, e.waehrung)),
                  ` (${g.prozent.toFixed(1).replace('.', ',')} %) darüber.`
                )
              : g.mittel < -0.005
                ? el(
                    'span',
                    {},
                    ' liegt im Mittel ',
                    el('b', {}, money(-g.mittel, e.waehrung)),
                    ` (${Math.abs(g.prozent).toFixed(1).replace('.', ',')} %) darunter, ` +
                      'gewinnt aber seltener.'
                  )
                : el('span', {}, ' liegt im Mittel gleichauf.'),
            // Die Ausnahmen sind der eigentliche Wert: dort liegt das Geld,
            // das ein Blick auf den Sieger allein übersieht.
            g.billigerBei.length
              ? el(
                  'span',
                  { class: 'sv-ausnahmen' },
                  ` Billiger bei: ${g.billigerBei.join(', ')}.`
                )
              : null
          )
        ),
        mehrereWaehrungen
          ? el('p', { class: 'sv-fuss' }, 'Getrennt je Währung, es wird nicht umgerechnet.')
          : null,
        e.ohneErgebnis.length
          ? el(
              'p',
              { class: 'sv-fuss warn' },
              `Nicht im Vergleich, weil kein Ergebnis vorliegt: ` +
                e.ohneErgebnis.map((s) => s.station.name).join(', ') + '.'
            )
          : null
      )
    )
  );
}

/** Kopfzeile: die Einstellung auf eine Zeile eingedampft. */
function renderKopf() {
  const gewählt = state.stations.map(stationByCode).filter(Boolean);
  $('#kurzStation').textContent = gewählt.length
    ? gewählt.length === 1
      ? gewählt[0].name
      : `${gewählt.length} Stationen`
    : 'Keine Station';
  $('#kurzZeit').textContent =
    `${pretty(state.pickupDate)} ${state.pickupTime} → ${pretty(state.returnDate)} ${state.returnTime}`;
  $('#knopfLand').textContent = `${state.markets.length} Länderseiten`;
  // Der Haken steht jetzt am Abruf, nicht mehr in der Länderauswahl, also
  // auch dann gleichziehen, wenn die Länderkacheln gar nicht neu gezeichnet
  // werden.
  $('#inkognito').checked = Boolean(state.inkognito);
}

/** Aufklappende Bereiche: immer nur einer offen. */
let offenerBereich = null;

function zeigeBereich(name) {
  offenerBereich = offenerBereich === name ? null : name;
  for (const [n, sel] of [
    ['station', '#panelStation'],
    ['zeit', '#panelZeit'],
    ['land', '#panelLand'],
  ]) {
    $(sel).hidden = offenerBereich !== n;
  }
  document.querySelectorAll('[data-panel]').forEach((b) => {
    const offen = b.dataset.panel === offenerBereich;
    b.toggleAttribute('data-offen', offen);
    b.setAttribute('aria-expanded', String(offen));
  });
}

/**
 * Reiter fuer Station/Termin-Gruppen.
 *
 * Gibt es nur eine Gruppe, gibt es auch nichts zu waehlen, dann null, damit
 * kein leerer Streifen stehen bleibt.
 */
function gruppenwahl(jobs, aktiv, waehle) {
  const erste = new Map();
  for (const j of jobs) if (!erste.has(j.gruppe)) erste.set(j.gruppe, j);
  if (erste.size < 2) return null;

  return el(
    'div',
    { class: 'gruppenwahl' },
    ...[...erste].map(([k, f]) =>
      el(
        'button',
        {
          type: 'button',
          class: 'gtab' + (k === aktiv ? ' on' : ''),
          onclick: () => waehle(k),
        },
        el('span', {}, f.station.name),
        // Die Uhrzeit gehört auf den Reiter, sobald es mehr als eine gibt,
        // sonst stünden zwei gleich beschriftete Reiter mit zwei Preisen da.
        el(
          'span',
          { class: 'gzeit' },
          `${pretty(f.variant.pickupDate)} · ${f.variant.duration} Tage` +
            (zeitVarianten().length > 1 ? ` · ${zeitKurz(f.variant)}` : '')
        )
      )
    )
  );
}

/* =========================================================== Ergebnisse */

/** Kennung dessen, was die Ergebnisansicht darstellt. */
let letzteSignatur = null;

/**
 * Fingerabdruck der Ergebnisansicht.
 *
 * Der Abfragetakt laeuft alle 2,5 Sekunden und rief bisher jedes Mal einen
 * vollstaendigen Neubau der Tabelle aus, auch wenn sich nichts geaendert
 * hatte. Bei ueber fuenfzig Zeilen sieht man das als Flackern, und Hover und
 * Scrollstand gehen dabei verloren.
 */
function ergebnisSignatur(jobs) {
  return [
    aktiveGruppe,
    Object.keys(katalog).length,
    ...jobs.map((j) => {
      const r = prices.get(j.key);
      return `${j.key}:${r ? (r.error ? 'e' : r.offers?.length ?? 0) : '-'}`;
    }),
  ].join('|');
}

function renderResults({ erzwingen = false } = {}) {
  const jobs = aktuelleJobs();

  // Die gezeigte Gruppe festlegen, bevor irgendjemand sie liest. Buehne und
  // Signatur haengen beide daran.
  const schluessel = [...new Set(jobs.map((j) => j.gruppe))];
  if (!schluessel.includes(aktiveGruppe)) aktiveGruppe = schluessel[0] ?? null;

  // Die billigen Anzeigen laufen immer, sie kosten nichts und flackern nicht.
  $('#jobCount').textContent = jobs.length
    ? `${jobs.length} Abfrage${jobs.length === 1 ? '' : 'n'}`
    : '';
  $('#openAll').disabled = !jobs.length;
  $('#copyAll').disabled = !jobs.length;

  // Nachfassen anbieten, sobald eine Länderseite nichts geliefert hat.
  const ohne = jobsOhneErgebnis(jobs);
  const nochmal = $('#nochmal');
  nochmal.hidden = !ohne.length;
  nochmal.textContent = `${ohne.length} ohne Ergebnis, nochmal versuchen`;
  $('#warn').hidden = jobs.length <= 12;
  $('#warn').textContent =
    jobs.length > 12
      ? `${jobs.length} Abfragen, das dauert rund ${minutenText(jobs.length)}.`
      : '';

  // Die Tabelle nur anfassen, wenn sich an ihrem Inhalt etwas geaendert hat.
  const sig = ergebnisSignatur(jobs);
  if (!erzwingen && sig === letzteSignatur) return;
  letzteSignatur = sig;

  renderHeld();

  if (!jobs.length) {
    setChildren($('#results'), el('p', { class: 'empty' }, 'Station und Länderseite wählen.'));
    return;
  }

  const gruppen = new Map();
  for (const j of jobs) {
    if (!gruppen.has(j.gruppe)) gruppen.set(j.gruppe, []);
    gruppen.get(j.gruppe).push(j);
  }

  const hatPreise = [...prices.values()].some((r) => r.offers?.length);

  // Umschalter, sobald es mehr als eine Station/Termin-Kombination gibt.
  const umschalter = gruppenwahl(jobs, aktiveGruppe, (k) => {
    aktiveGruppe = k;
    renderResults();
  });

  const sichtbar = schluessel.filter((k) => schluessel.length === 1 || k === aktiveGruppe);

  setChildren(
    $('#results'),
    // Die Aussage steht über den Reitern: sie beantwortet die Frage, wegen
    // der man sonst zwischen ihnen hin und her klickt.
    renderStationsvergleich(),
    umschalter,
    ...sichtbar.map((k) => {
      const list = gruppen.get(k);
      const f = list[0];
      return el(
        'div',
        { class: 'group' },
        el(
          'h3',
          {},
          f.station.name,
          el('span', { class: 'gid' }, f.station.code),
          el(
            'span',
            { class: 'span' },
            `${pretty(f.variant.pickupDate)} ${f.variant.pickupTime} → ` +
              `${pretty(f.variant.returnDate)} ${f.variant.returnTime} · ${f.variant.duration} Tage`
          )
        ),
        renderTable(list) ||
          el(
            'p',
            { class: 'empty comparison-empty' },
            service.chrome
              ? 'Starte oben mit „Preise vergleichen“. Deine Angebote erscheinen hier, sobald sie eintreffen.'
              : 'Kein Preisabruf verfügbar. Die Links unten führen zur Suche.'
          ),
        el(
          'div',
          { class: 'links' },
          ...list.map((j) => {
            const rec = prices.get(j.key);
            return el(
              'a',
              { href: j.url, target: '_blank', rel: 'noopener', class: 'lnk' },
              el('span', { class: 'mkname' }, j.market.label),
              // Verständlicher Grund statt Rohmeldung, samt Fehlerkennung zum
              // Nachschlagen und der Zahl der Versuche.
              rec?.error
                ? el(
                    'span',
                    {
                      class: 'price err',
                      title:
                        (rec.fehlerRat ? rec.fehlerRat + '\n\n' : '') +
                        `Kennung: ${rec.fehlerCode || '–'} · ${rec.versuche || 1} Versuch(e)\n` +
                        rec.error,
                    },
                    `${rec.fehlerCode || 'FEHLER'}, ${rec.fehlerKlartext || rec.error}`
                  )
                : null
            );
          })
        )
      );
    })
  );
}

/* =========================================================== Schutz */

function öffneSchutz(acriss) {
  if (!decodeAcriss(acriss)) return;
  schutzAcriss = acriss;
  // Auf der Station landen, aus deren Tabelle geklickt wurde.
  schutzGruppe = aktiveGruppe;
  // Ab hier gilt dieses Fahrzeug als angesehen, mit den Preisen, die schon
  // vorliegen. Die Schutzpakete kommen nach ihrem Abruf dazu.
  merkeFahrzeug(acriss);
  showScreen('schutz');
  renderSchutz();
  window.scrollTo(0, 0);
}

function renderSchutz() {
  const d = decodeAcriss(schutzAcriss);
  if (!d) return;

  const jobs = schutzJobs();
  const gruppe = jobs[0];

  setChildren(
    $('#schutzGruppen'),
    gruppenwahl(alleSchutzJobs(), schutzGruppe, (k) => {
      schutzGruppe = k;
      renderSchutz();
    })
  );

  const info = katalog[schutzAcriss] || {};
  const beispiel = (() => {
    for (const rec of prices.values()) {
      const t = (rec.offers || []).find((o) => o.acriss === schutzAcriss);
      if (t) return t;
    }
    return null;
  })();

  setChildren(
    $('#schutzKopf'),
    el(
      'div',
      { class: 'fzgkopf' },
      beispiel?.image || info.bild
        ? el('img', { src: beispiel?.image || info.bild, alt: '', class: 'kbild' })
        : null,
      el(
        'div',
        {},
        el('p', { class: 'kmodell' }, beispiel?.model || (info.modelle || [])[0] || d.label),
        el(
          'p',
          { class: 'kklasse' },
          el('span', { class: 'acriss gross' }, d.acriss),
          d.label
        ),
        // Station und Termin der gewaehlten Gruppe, nicht die Grundeinstellung
        // bei zwei Stationen stand hier sonst immer dasselbe.
        gruppe
          ? el(
              'p',
              { class: 'kzeit' },
              el('b', {}, gruppe.station.name),
              ` · ${pretty(gruppe.variant.pickupDate)} ${gruppe.variant.pickupTime} → ` +
                `${pretty(gruppe.variant.returnDate)} ${gruppe.variant.returnTime} · ${gruppe.variant.duration} Tage`
            )
          : null
      )
    )
  );

  const fertig = jobs.filter((j) => schutz.has(j.key));
  $('#schutzHinweis').textContent = fertig.length
    ? `${fertig.length} von ${jobs.length} Länderseiten abgerufen`
    : `${jobs.length} Länderseiten · rund ${Math.ceil((jobs.length * 12) / 2)} Sekunden`;

  // Die Paketnamen heißen in jeder Sprache anders, "Smart-Schutz",
  // "Smart Protection", "Protección Smart". Zugeordnet wird deshalb NICHT über
  // den Namen, sondern über den Inhalt: Gibt es eine Selbstbeteiligung, und
  // wenn nein, ist es das günstigere oder das teurere der SB-freien Pakete?
  // Die reine Reihenfolge wäre zu wackelig, sobald ein Land ein Paket weniger
  // führt. Der Name der jeweiligen Länderseite steht dann in der Zelle.
  const KANON = [
    ['ohne', 'Ohne Extra-Schutz', 'volle Haftung bis Fahrzeugwert'],
    ['sb', 'Mit Selbstbeteiligung', 'Basis-Schutz, Restrisiko bleibt'],
    ['frei1', 'Ohne Selbstbeteiligung', 'das günstigere SB-freie Paket'],
    ['frei2', 'Ohne SB, Rundum', 'das teurere SB-freie Paket'],
  ];

  function kanonisiere(pakete) {
    const zu = {};
    const rest = [...(pakete || [])];

    // "Ohne Schutz" ist das Paket mit dem niedrigsten Gesamtpreis, das kostet
    // per Definition nichts extra. Ueber den Text zu gehen war zu wackelig:
    // die franzoesische Seite schreibt "Inclus", was in keiner meiner
    // Wortlisten stand, und das Paket landete dadurch bei den SB-freien.
    let ohneIdx = -1;
    let min = Infinity;
    rest.forEach((p, i) => {
      const g = p.gesamt ?? Infinity;
      if (g < min) {
        min = g;
        ohneIdx = i;
      }
    });
    if (ohneIdx < 0) ohneIdx = rest.findIndex((p) => p.inklusive || p.proTag === 0);
    if (ohneIdx >= 0) {
      zu.ohne = rest[ohneIdx];
      rest.splice(ohneIdx, 1);
    }

    const frei = [];
    for (const p of rest) {
      if (p.sbBetrag != null && p.sbBetrag > 0) zu.sb = p;
      else frei.push(p);
    }
    frei.sort(
      (a, b) => (a.gesamt ?? a.proTag ?? Infinity) - (b.gesamt ?? b.proTag ?? Infinity)
    );
    if (frei[0]) zu.frei1 = frei[0];
    if (frei[1]) zu.frei2 = frei[1];
    return zu;
  }

  const proMarkt = new Map();
  for (const j of jobs) {
    const r = schutz.get(j.key);
    if (r?.pakete?.length) proMarkt.set(j.key, kanonisiere(r.pakete));
  }

  const benutzt = KANON.filter(([k]) => [...proMarkt.values()].some((m) => m[k]));

  if (!benutzt.length) {
    setChildren(
      $('#schutzBody'),
      el(
        'p',
        { class: 'empty' },
        fertig.length
          ? 'Keine Schutzpakete gefunden, die Klasse ist dort vermutlich nicht buchbar.'
          : 'Noch nichts abgerufen.'
      )
    );
    return;
  }

  // Die Mietdauer der gezeigten Gruppe, nicht die der Grundeinstellung, mit
  // Datums-Matrix koennen sich die beiden unterscheiden.
  const tage = gruppe?.variant.duration ?? Math.max(1, daysBetween(state.pickupDate, state.returnDate));

  /**
   * Mietpreis ohne Zusatzschutz.
   *
   * Bevorzugt der Gesamtpreis, den die Kasse beim Paket "kein Extra-Schutz"
   * anzeigt, gemessen unter denselben Bedingungen wie alle anderen Pakete.
   * Der Wert aus der Trefferliste weicht um Kleinbetraege ab (gemessen 97
   * Cent), und dann stimmen die Aufschlaege nicht mehr zusammen.
   */
  function mietpreis(j) {
    const ohne = proMarkt.get(j.key)?.ohne;
    if (ohne?.gesamt != null) return ohne.gesamt;
    const r = schutz.get(j.key);
    if (r?.mieteOhneSchutz != null) return r.mieteOhneSchutz;
    const rec = prices.get(jobKey(j.market.host, j.station.code, j.variant));
    const treffer = (rec?.offers || []).find((o) => o.acriss === schutzAcriss);
    return treffer ? (treffer.total ?? null) : null;
  }

  const kopf = el(
    'tr',
    {},
    el('th', { class: 'klasse' }, 'Schutzpaket'),
    ...jobs.map((j) =>
      el(
        'th',
        {},
        j.market.label,
        el('span', { class: 'thcur' }, j.market.cur),
        schutz.has(j.key) ? null : el('span', { class: 'thwait' }, 'lädt …')
      )
    )
  );

  // Erste Zeile: die reine Miete, als Bezugsgroesse fuer alles darunter.
  const mieteZeile = el(
    'tr',
    { class: 'mietzeile' },
    el(
      'th',
      { class: 'klasse' },
      el('span', { class: 'pname' }, 'Nur Miete'),
      el('span', { class: 'psb' }, `${tage} Tage, ohne jeden Zusatzschutz`)
    ),
    ...jobs.map((j) => {
      const m = mietpreis(j);
      return el(
        'td',
        {},
        el('span', { class: 'betrag' }, m == null ? '–' : money(m, j.market.cur))
      );
    })
  );

  const zeilen = benutzt.map(([k, titel, erklärung]) =>
    el(
      'tr',
      {},
      el(
        'th',
        { class: 'klasse' },
        el('span', { class: 'pname' }, titel),
        el('span', { class: 'psb' }, erklärung)
      ),
      ...jobs.map((j) => {
        const r = schutz.get(j.key);
        const p = proMarkt.get(j.key)?.[k];
        if (!p) {
          // Unterscheiden: gescheiterter Abruf, dort nicht buchbar, oder
          // dieses eine Paket fehlt. Ein blosses "–" verschweigt den Grund.
          if (!r) return el('td', { class: 'leer' }, '');
          if (r.error) return el('td', { class: 'leer' }, el('span', { class: 'zellfehler' }, r.error));
          if (r.verfuegbar === false)
            return el('td', { class: 'leer' }, el('span', { class: 'zellfehler' }, 'nicht buchbar'));
          return el('td', { class: 'leer' }, '–');
        }

        // Der Gesamtpreis ist abgelesen, nicht gerechnet. Der je Paket
        // angezeigte Tagespreis multipliziert sich nicht sauber hoch:
        // gemessen zeigte Sixt 10,77 EUR/Tag an, waehrend der Gesamtpreis bei
        // vier Tagen um 54,22 EUR stieg, 13,55 statt 10,77 je Tag.
        const gesamt = p.gesamt ?? null;
        // Aufschlag hier ausrechnen statt aus dem Abruf uebernehmen: so
        // stammen Bezugswert und Paketpreis aus derselben Messreihe.
        const basis = mietpreis(j);
        const aufschlag =
          gesamt != null && basis != null ? Number((gesamt - basis).toFixed(2)) : null;
        const echtProTag = aufschlag != null ? aufschlag / tage : null;

        const inhalt = [
          // Der Name, wie ihn diese Länderseite nennt, bewusst mitgezeigt,
          // damit man die Zuordnung nachprüfen kann.
          el('span', { class: 'lokalname' }, p.name),
          el(
            'span',
            { class: 'betrag' },
            gesamt != null ? money(gesamt, p.waehrung) : '–'
          ),
          aufschlag
            ? el(
                'span',
                { class: 'proTag' },
                `+ ${money(aufschlag, '')} Schutz · ${money(echtProTag, '')}/Tag`
              )
            : aufschlag === 0
              ? el('span', { class: 'proTag' }, 'nur Miete')
              : null,
          p.proTag && echtProTag != null && Math.abs(echtProTag - p.proTag) > 0.02
            ? el(
                'span',
                { class: 'proTag hinweis' },
                `Seite zeigt ${money(p.proTag, '')}/Tag`
              )
            : null,
          p.selbstbeteiligung
            ? el('span', { class: 'proTag sb' }, 'SB: ' + p.selbstbeteiligung)
            : null,
        ];

        // Steht die Kasse dieser Länderseite noch offen, ist die Zelle ein
        // Knopf: er wählt dort dasselbe Paket und holt das Sixt-Fenster nach
        // vorn. Ist sie weg, bleibt die Zahl als Text stehen; nachgeholt wird
        // nur auf ausdrücklichen Klick, weil ein Abruf zwölf Sekunden dauert.
        const offenHier = kassen.has(j.key) && p.i != null;
        if (offenHier) {
          return el(
            'td',
            { class: 'buchbar' },
            el(
              'button',
              {
                type: 'button',
                class: 'kassenknopf',
                title: `Auf ${j.market.label} öffnen, ${p.name} ist dann ausgewählt`,
                onclick: () => oeffneKasse(j, p),
              },
              ...inhalt,
              el('span', { class: 'buchhinweis' }, 'Zum Buchen öffnen')
            )
          );
        }
        return el('td', {}, ...inhalt);
      })
    )
  );

  // Leiste über der Tabelle: wie viele Kassenseiten gerade offen stehen. Das
  // gehört sichtbar hierher, weil jede davon rund 100 MB kostet und in einem
  // unsichtbaren Fenster liegt, wo niemand sie vermuten würde.
  const rest = [...kassen.values()].reduce(
    (m, k) => (m == null ? k.restSekunden : Math.min(m, k.restSekunden)),
    null
  );
  const kassenleiste = kassen.size
    ? el(
        'div',
        { class: 'kassenleiste' },
        el(
          'span',
          {},
          el('b', {}, `${kassen.size} ${kassen.size === 1 ? 'Kassenseite' : 'Kassenseiten'} offen`),
          ' · Klick auf einen Preis wählt dort das Paket und holt das Sixt-Fenster nach vorn.',
          // Der Speicher gehört dazu. Er ist gemessen, nicht geschätzt, und er
          // ist unsichtbar, weil das Fenster unsichtbar ist. Wer ihn nicht
          // ausgeben will, verlässt die Ansicht, dann geht alles zu.
          el(
            'span',
            { class: 'kassenram' },
            `Kostet rund ${kassen.size * 250 >= 1000 ? ((kassen.size * 250) / 1000).toFixed(1).replace('.', ',') + ' GB' : kassen.size * 250 + ' MB'} Arbeitsspeicher` +
              (rest != null ? `, schließt sich in ${Math.max(1, Math.ceil(rest / 60))} Min. von selbst` : '')
          )
        ),
        el(
          'button',
          { type: 'button', class: 'ghost klein', onclick: () => schliesseKassen() },
          'Alle schließen'
        )
      )
    : fertig.length
      ? el(
          'div',
          { class: 'kassenleiste zu' },
          el(
            'span',
            {},
            'Die Kassenseiten sind geschlossen, das spart Speicher. Zum Weiterbuchen ' +
              'müssen sie neu geholt werden.'
          ),
          el(
            'button',
            { type: 'button', class: 'ghost klein', onclick: () => oeffneKassenNeu() },
            `Erneut öffnen · rund ${Math.ceil((fertig.length * 12) / 2)} Sekunden`
          )
        )
      : null;

  setChildren(
    $('#schutzBody'),
    kassenleiste,
    el(
      'div',
      { class: 'tabellenrahmen' },
      el(
        'table',
        { class: 'vergleich schutz' },
        el('thead', {}, kopf),
        el('tbody', {}, mieteZeile, ...zeilen)
      )
    ),
    el(
      'p',
      { class: 'tabnote' },
      'Die große Zahl ist der Gesamtpreis für den ganzen Zeitraum, abgelesen von Sixts ' +
        'eigener Kasse, jedes Paket wird dafür einzeln ausgewählt. Nicht hochgerechnet: ' +
        'der angezeigte Tagespreis multipliziert sich nicht sauber auf, gemessen lagen ' +
        'zwischen beiden rund 26 %. Weicht er ab, steht der Wert der Seite klein darunter. ' +
        'Zugeordnet wird über den Inhalt (Selbstbeteiligung ja/nein, günstiger/teurer), ' +
        'nicht über den Namen, der heißt auf jeder Länderseite anders. Der jeweilige ' +
        'Originalname steht klein über dem Preis, damit die Zuordnung nachprüfbar bleibt. ' +
        'Solange die Kassenseiten offen sind, führt ein Klick auf einen Preis direkt dorthin, ' +
        'mit dem Paket bereits ausgewählt. Weicht der Preis dort inzwischen ab, wird das ' +
        'gemeldet, statt es durchgehen zu lassen.'
    )
  );
}

/**
 * Die Kassenseiten noch einmal holen, nachdem sie geschlossen wurden.
 *
 * Dafür müssen die alten Ergebnisse weg, sonst nimmt der Dienst den Auftrag
 * gar nicht erst an, er kennt den Schlüssel ja schon. Die Preise stehen so
 * lange auf "lädt", und das ist richtig so: sie werden wirklich neu gemessen.
 */
async function oeffneKassenNeu() {
  const jobs = schutzJobs().filter((j) => schutz.has(j.key));
  if (!jobs.length) return;
  const keys = jobs.map((j) => j.key);
  try {
    await fetch('/api/results/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
  } catch {
    flash('Der Preisdienst antwortet nicht.');
    return;
  }
  for (const k of keys) schutz.delete(k);
  renderSchutz();
  await sendeJobs(jobs.map(schutzAuftrag), $('#getSchutz'));
}

/* ------------------------------------------------------ Kassenseiten */

/**
 * Nach einem Schutzabruf bleibt die Kasse jeder Länderseite offen, versteckt
 * in einem eigenen Chrome-Fenster. Ein Klick auf einen Preis wählt dort
 * dasselbe Paket und holt das Fenster nach vorn: man steht mitten in der
 * Buchung, mit genau dem Preis, der hier stand.
 *
 * Offen bleiben kostet Speicher, rund 100 MB je Seite, und man sieht es nicht,
 * weil das Fenster unsichtbar ist. Deshalb wird zugemacht, sobald diese
 * Ansicht verlassen wird; der Dienst räumt zusätzlich nach zwanzig Minuten und
 * ab acht offenen Seiten auf.
 *
 * Auftragsschlüssel -> { restSekunden, sichtbar }
 */
const kassen = new Map();
let kassenTakt = null;

async function ladeKassen(neuZeichnen = true) {
  try {
    const d = await (await fetch('/api/buchung')).json();
    kassen.clear();
    for (const e of d.offen || []) kassen.set(e.schluessel, e);
  } catch {
    kassen.clear();
  }
  if (neuZeichnen && document.body.dataset.screen === 'schutz') renderSchutz();
}

/** Der Takt läuft nur, solange die Schutzansicht offen ist. */
function haltKassenFrisch(an) {
  if (kassenTakt) {
    clearInterval(kassenTakt);
    kassenTakt = null;
  }
  if (an) kassenTakt = setInterval(() => ladeKassen(), 20000);
}

async function oeffneKasse(job, paket, zweiterVersuch = false) {
  const knopf = document.activeElement;
  if (knopf?.tagName === 'BUTTON') knopf.disabled = true;
  try {
    const d = await (
      await fetch('/api/buchung/oeffnen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: job.key, paket: paket.i }),
      })
    ).json();

    if (!d.ok) {
      // Seite abgelaufen oder für eine neuere weggeräumt: genau diese eine
      // nachholen, statt den Klick ins Leere laufen zu lassen.
      if (d.grund === 'weg' && !zweiterVersuch) {
        await holeKasseNach(job, paket);
        return;
      }
      flash(d.error || 'Die Kassenseite ließ sich nicht öffnen.');
      await ladeKassen();
      return;
    }
    if (!d.sichtbar) {
      flash('Das Paket ist gewählt, aber das Fenster ließ sich nicht nach vorn holen.');
      return;
    }

    // Der Preis wird gegengeprüft, nicht bloß behauptet. Weicht er ab, ist
    // das die wichtigste Information überhaupt, bevor jemand bucht.
    if (d.abweichung != null && Math.abs(d.abweichung) >= 0.01) {
      flash(
        `Achtung: die Seite zeigt jetzt ${money(d.jetzt, '')} statt ${money(d.gemessen, '')}. ` +
          `Unterschied ${d.abweichung > 0 ? '+' : ''}${money(d.abweichung, '')}.`
      );
    } else {
      flash(`${d.paket} ist gewählt. Das Sixt-Fenster steht vorn.`);
    }
  } catch {
    flash('Der Preisdienst antwortet nicht.');
  } finally {
    if (knopf?.tagName === 'BUTTON') knopf.disabled = false;
    await ladeKassen();
  }
}

/**
 * Genau eine Kassenseite nachholen und dann darauf öffnen.
 *
 * Passiert, wenn die Seite abgelaufen ist oder für eine neuere weichen musste.
 * Der Klick soll deshalb nicht ins Leere laufen: er holt sie zurück. Das
 * dauert rund zwölf Sekunden und hat einen Vorteil, den das Offenhalten nicht
 * hat: der Preis wird dabei frisch bestätigt.
 */
async function holeKasseNach(job, paket) {
  flash('Die Kassenseite war geschlossen. Sie wird neu geholt, rund 12 Sekunden.');
  try {
    await fetch('/api/results/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: [job.key] }),
    });
  } catch {
    flash('Der Preisdienst antwortet nicht.');
    return;
  }
  schutz.delete(job.key);
  renderSchutz();
  await sendeJobs([schutzAuftrag(job)], $('#getSchutz'));

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await ladeKassen(false);
    if (kassen.has(job.key) && schutz.has(job.key)) break;
  }
  await ladeKassen();

  if (!kassen.has(job.key)) {
    flash('Die Kassenseite kam nicht zurück. Klasse dort vermutlich nicht mehr buchbar.');
    return;
  }
  // Über den Namen wiederfinden: die Reihenfolge der Pakete im Formular kann
  // sich beim neuen Abruf geändert haben, die Nummer von vorhin trüge dann
  // auf ein anderes Paket.
  const neu = (schutz.get(job.key)?.pakete || []).find((p) => p.name === paket.name);
  if (!neu) {
    flash(`„${paket.name}" gibt es dort gerade nicht mehr.`);
    return;
  }
  await oeffneKasse(job, neu, true);
}

async function schliesseKassen(still = false) {
  if (!kassen.size) return;
  try {
    const d = await (
      await fetch('/api/buchung/schliessen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alle: true }),
      })
    ).json();
    kassen.clear();
    if (!still && d.geschlossen) {
      flash(`${d.geschlossen} Kassenseiten geschlossen, das gibt den Speicher frei.`);
    }
  } catch {
    kassen.clear();
  }
  if (document.body.dataset.screen === 'schutz') renderSchutz();
}

function schutzAuftrag(j) {
  return {
    key: j.key,
    provider: PROVIDER,
    host: j.market.host,
    stationCode: j.station.code,
    acriss: j.acriss,
    pickupDate: j.variant.pickupDate,
    returnDate: j.variant.returnDate,
    pickupTime: j.variant.pickupTime ?? state.pickupTime,
    returnTime: j.variant.returnTime ?? state.returnTime,
    currency: j.market.cur,
    // Derselbe Modus wie beim Preisabruf: sonst stünde ein Schutzpreis aus
    // dem Cookie-Abruf neben einem Grundpreis ohne Cookies.
    inkognito: state.inkognito || undefined,
    // Die Kasse offen lassen, damit man von hier aus weiterbuchen kann.
    offenhalten: true,
  };
}

async function fetchSchutz() {
  const jobs = schutzJobs().filter((j) => !schutz.has(j.key));
  if (!jobs.length) {
    flash('Für diese Klasse liegen schon alle Schutzpreise vor.');
    return;
  }
  await sendeJobs(jobs.map(schutzAuftrag), $('#getSchutz'));
}

/* =========================================================== Abruf */

async function sendeJobs(jobs, btn) {
  btn.disabled = true;
  try {
    const r = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs }),
    });
    const d = await r.json();
    if (!d.ok) {
      flash(d.error || 'Abruf nicht möglich.');
      btn.disabled = false;
      return;
    }
    service.queue = { laufend: 1, offen: d.angenommen, erledigt: 0, gesamt: d.angenommen };
    renderFortschritt();
    startPolling();
    pollErgebnisse();
  } catch {
    flash('Der Preisdienst antwortet nicht.');
    btn.disabled = false;
  }
}

/**
 * Warteschlange abbrechen.
 *
 * Was schon laeuft, laeuft zu Ende, ein Abruf mittendrin abzuwuergen liesse
 * eine halb geladene Seite stehen. Alles Wartende wird verworfen.
 */
async function abbrechen() {
  try {
    const d = await (await fetch('/api/cancel', { method: 'POST' })).json();
    flash(
      d.verworfen
        ? `${d.verworfen} Abrufe verworfen` +
            (d.nochLaufend ? ` · ${d.nochLaufend} laufen noch zu Ende` : '')
        : 'Es wartete nichts mehr.'
    );
    pollErgebnisse();
  } catch {
    flash('Abbruch nicht möglich. Dienst antwortet nicht.');
  }
}

/**
 * Abrufe ohne brauchbares Ergebnis.
 *
 * Der Dienst merkt sehr wohl, wenn eine Länderseite nicht durchkommt, der
 * Grund steht in der Zelle. Nur nachgefasst hat bisher niemand: der Abruf
 * überging jeden Schlüssel, zu dem schon irgendein Ergebnis vorlag, und ein
 * Fehler ist eben auch eines. Damit blieb eine Seite, die einmal
 * dazwischenging, für immer leer.
 *
 * Als "ohne Ergebnis" zählt auch eine leere Trefferliste ohne Fehlermeldung.
 * Es kann sein, dass dort wirklich nichts frei ist; häufiger ist es ein still
 * gescheiterter Abruf, und ein zweiter Versuch kostet wenig.
 */
function jobsOhneErgebnis(jobs = aktuelleJobs()) {
  return jobs.filter((j) => {
    const r = prices.get(j.key);
    if (!r) return false;
    // Eine Station, die an dem Tag nichts anbietet, hat sauber geantwortet.
    // Sie noch dreimal zu fragen kostet Minuten und ändert nichts.
    if (r.note && !r.error) return false;
    return r.error != null || !r.offers?.length;
  });
}

async function fetchPrices({ nurFehler = false } = {}) {
  const alle = aktuelleJobs();
  const offen = nurFehler ? jobsOhneErgebnis(alle) : alle.filter((j) => !prices.has(j.key));

  if (!offen.length) {
    flash(
      nurFehler
        ? 'Alle Länderseiten haben ein Ergebnis geliefert.'
        : 'Für diese Auswahl liegen schon alle Preise vor.'
    );
    return;
  }

  // Das alte Ergebnis wegräumen, sonst steht die Fehlermeldung noch in der
  // Zelle, während der neue Abruf längst läuft.
  if (nurFehler) for (const j of offen) prices.delete(j.key);
  // Wer von Hand anstösst, fängt von vorn an: das automatische Nachfassen
  // steht ihm danach wieder einmal zu.
  if (!nurFehler) nachgefasst = new Set();

  await sendeJobs(
    offen.map((j) => ({
      key: j.key,
      provider: PROVIDER,
      host: j.market.host,
      stationCode: j.station.code,
      returnCode: state.returnStation || undefined,
      pickupDate: j.variant.pickupDate,
      returnDate: j.variant.returnDate,
      pickupTime: j.variant.pickupTime ?? state.pickupTime,
      returnTime: j.variant.returnTime ?? state.returnTime,
      currency: j.market.cur,
      inkognito: state.inkognito || undefined,
    })),
    $(nurFehler ? '#nochmal' : '#getPrices')
  );
  renderResults({ erzwingen: true });
  $('#fortschritt').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderFortschritt() {
  const q = service.queue;
  const aktiv = Boolean(q && (q.laufend > 0 || q.offen > 0));

  for (const [box, füllung, text] of [
    ['#fortschritt', '#ffuellung', '#ftext'],
    ['#schutzFortschritt', '#sffuellung', '#sftext'],
  ]) {
    const n = $(box);
    if (!n) continue;
    n.hidden = !aktiv;
    if (aktiv) {
      const anteil = Math.round((q.erledigt / Math.max(1, q.gesamt)) * 100);
      $(füllung).style.width = `${anteil}%`;
      $(text).textContent =
        `${q.erledigt} von ${q.gesamt} abgerufen` +
        (q.laufend ? ` · ${q.laufend} unterwegs` : '');
    }
  }

  for (const id of ['#getPrices', '#getSchutz']) {
    const b = $(id);
    if (!b) continue;
    b.disabled = aktiv;
  }
  $('#getPrices').textContent = aktiv ? 'Abruf läuft …' : 'Preise vergleichen';
  $('#getSchutz').textContent = aktiv ? 'Abruf läuft …' : 'Schutzpreise holen';

  if (!aktiv) ladeKatalog();
}

/* =========================================================== Aktionen */

async function openAll() {
  const jobs = aktuelleJobs();
  const btn = $('#openAll');
  btn.disabled = true;
  let blockiert = 0;
  for (let i = 0; i < jobs.length; i++) {
    if (!window.open(jobs[i].url, '_blank', 'noopener')) blockiert++;
    btn.textContent = `Öffne ${i + 1}/${jobs.length} …`;
    await new Promise((r) => setTimeout(r, 260));
  }
  btn.textContent = 'Im Browser öffnen';
  btn.disabled = false;
  if (blockiert) $('#popupHint').hidden = false;
}

function copyAll() {
  const text = aktuelleJobs()
    .map((j) => `${j.station.name} · ${j.market.label}\n${j.url}`)
    .join('\n\n');
  navigator.clipboard.writeText(text).then(
    () => flash('Links kopiert.'),
    () => flash('Kopieren nicht möglich.')
  );
}

let flashTimer;
function flash(msg) {
  const n = $('#flash');
  n.textContent = msg;
  n.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (n.hidden = true), 3000);
}

/* =========================================================== Status */

const CAP_LABEL = {
  station: 'Station wird übernommen',
  date: 'Datum wird übernommen',
  time: 'Uhrzeit wird übernommen',
  oneWay: 'Abweichende Rückgabestation',
  vehicleClass: 'Fahrzeugklasse (Parameter wird verworfen)',
  prepaid: 'Prepaid-Filter (Parameter wird verworfen)',
};

/* ------------------------------------------------------------- Begrüßung
 *
 * Einmal beim ersten Start. Wer TRACKER zum ersten Mal öffnet, soll nicht an
 * einer leeren Tabelle merken, dass Chrome fehlt oder eine Firewall
 * dazwischensteht, sondern es vorher wissen, samt Grund und Rat.
 *
 * Die frühere Fassung hatte eine Animation vor *jedem* Start. Die kommt
 * bewusst nicht zurück: sie erschien immer und führte nirgendwohin. Diese
 * erscheint einmal und führt zu einem Testlauf.
 */

const LS_ERSTSTART = 'mwt-preistool/erststart';
const SS_LAEUFT = 'mwt-preistool/sitzung';

function erststartErledigt() {
  try {
    return localStorage.getItem(LS_ERSTSTART) === 'fertig';
  } catch {
    // Ohne Speicher liesse sich die Begrüßung nie abstellen, dann lieber
    // gar nicht zeigen, als sie bei jedem Start aufzudrängen.
    return true;
  }
}

function zeigeWillkommen() {
  showScreen('willkommen');
  $('#wkErgebnis').replaceChildren();
  $('#wkAbschluss').hidden = true;
  $('#wkStart').disabled = false;
  $('#wkStart').textContent = 'Prüfen, ob alles läuft';
}

/** Die Begrüßung abschliessen und dorthin gehen, wo es losgeht. */
function beendeWillkommen(merken) {
  try {
    if (merken) localStorage.setItem(LS_ERSTSTART, 'fertig');
    else localStorage.removeItem(LS_ERSTSTART);
  } catch {
    /* dann eben nur für diese Sitzung */
  }
  state.mode = null;
  persist();
  showScreen('start');
}

/**
 * Der Testlauf der Begrüßung: erst die Kette, dann drei weitere Länderseiten.
 *
 * Jede Seite ist ein eigener Aufruf, damit die Schritte einzeln eintreffen.
 * Ein Endpunkt, der zwei Minuten schweigt und dann alles auf einmal liefert,
 * ist von einem Absturz nicht zu unterscheiden.
 */
async function willkommenTest() {
  const knopf = $('#wkStart');
  const kasten = $('#wkErgebnis');
  knopf.disabled = true;
  knopf.textContent = 'Läuft …';
  $('#wkAbschluss').hidden = true;
  $('#wkUeberspringen').hidden = true;

  const schritte = [];
  const zeichne = (laeuft) =>
    setChildren(
      kasten,
      schrittliste(schritte),
      laeuft ? el('p', { class: 'note wk-laeuft' }, `${laeuft} wird geprüft …`) : null
    );

  try {
    zeichne('Die Grundkette');
    const d = await (await fetch('/api/selbsttest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).json();

    if (!d.ok) {
      setChildren(kasten, el('p', { class: 'note warn' }, d.error));
      return;
    }
    schritte.push(...d.schritte);
    zeichne(null);

    // Weiter nur, wenn die Grundkette hält, ohne Browser ist jede weitere
    // Seite dieselbe Fehlermeldung noch einmal.
    const gebrochen = schritte.some((s) => s.stand === 'schlecht');
    if (!gebrochen) {
      for (const seite of d.weitere || []) {
        zeichne(seite.label);
        const r = await (await fetch('/api/selbsttest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seite: seite.host }),
        })).json();
        if (r.ok) schritte.push(...r.schritte);
        zeichne(null);
      }
    }

    const schlecht = schritte.filter((s) => s.stand === 'schlecht').length;
    const mittel = schritte.filter((s) => s.stand === 'mittel').length;

    setChildren(
      kasten,
      schrittliste(schritte),
      el(
        'p',
        { class: 'note ' + (schlecht ? 'warn' : '') },
        schlecht
          ? 'Hier hakt es. Der Rat steht am betroffenen Schritt.'
          : mittel
            ? `Läuft. ${mittel} von ${schritte.length} Punkten mit Einschränkung, ` +
              'einzelne Länderseiten können also klemmen, der Rest geht.'
            : 'Alles in Ordnung. Jede geprüfte Länderseite hat geliefert.'
      )
    );

    // Ausblenden anbieten nur, wenn nichts gebrochen ist. Wer ein kaputtes
    // Setup hat, soll die Meldung beim nächsten Start wiedersehen.
    $('#wkAbschluss').hidden = false;
    $('#wkNichtMehr').closest('.optionzeile').hidden = Boolean(schlecht);
    $('#wkNichtMehr').checked = !schlecht;
  } catch {
    setChildren(kasten, el('p', { class: 'note warn' }, 'Der Dienst antwortet nicht.'));
    $('#wkAbschluss').hidden = false;
    $('#wkNichtMehr').closest('.optionzeile').hidden = true;
    $('#wkNichtMehr').checked = false;
  } finally {
    knopf.disabled = false;
    knopf.textContent = 'Noch einmal prüfen';
    $('#wkStart').hidden = true;
  }
}

/** Die Schritte eines Testlaufs als Liste, geteilt von Status und Begrüßung. */
function schrittliste(schritte) {
  return el(
    'ul',
    { class: 'standliste' },
    ...schritte.map((s) =>
      el(
        'li',
        { class: 'st ' + (s.stand === 'gut' ? 'ja' : s.stand === 'mittel' ? 'teils' : 'nein') },
        el('span', { class: 'stmark' }, s.stand === 'gut' ? '✓' : s.stand === 'mittel' ? '~' : '✕'),
        el(
          'span',
          {},
          el('b', {}, s.name),
          el('span', { class: 'sttext' }, s.text),
          s.rat ? el('span', { class: 'sttext rat' }, s.rat) : null
        )
      )
    )
  );
}

/**
 * Selbsttest anstossen und das Ergebnis zeigen.
 *
 * Auf dem eigenen Rechner laeuft immer alles. Der Test ist fuer den fremden
 * gedacht: er sagt nicht nur, dass etwas nicht geht, sondern an welcher Stelle
 * der Kette und was dagegen hilft.
 */
async function starteSelbsttest() {
  const knopf = $('#testStart');
  const hinweis = $('#testHinweis');
  knopf.disabled = true;
  knopf.textContent = 'Läuft …';
  hinweis.textContent = 'Chrome wird gestartet, eine echte Suche durchgeführt.';
  setChildren($('#testErgebnis'));

  try {
    const d = await (await fetch('/api/selbsttest', { method: 'POST' })).json();
    if (!d.ok) {
      hinweis.textContent = '';
      setChildren($('#testErgebnis'), el('p', { class: 'note warn' }, d.error));
      return;
    }

    const schlecht = d.schritte.filter((s) => s.stand === 'schlecht').length;
    const mittel = d.schritte.filter((s) => s.stand === 'mittel').length;
    hinweis.textContent = schlecht
      ? 'Hier hakt es:'
      : mittel
        ? 'Läuft, mit Einschränkung:'
        : 'Alles in Ordnung.';

    setChildren($('#testErgebnis'), schrittliste(d.schritte));
  } catch {
    hinweis.textContent = '';
    setChildren($('#testErgebnis'), el('p', { class: 'note warn' }, 'Der Dienst antwortet nicht.'));
  } finally {
    knopf.disabled = false;
    knopf.textContent = 'Selbsttest starten';
  }
}

/** Eine Kennzahl im Dienst-Kasten. */
function kennzahl(wert, was, ok = null, hinweis = null) {
  return el(
    'div',
    { class: 'kz' + (ok === true ? ' gut' : ok === false ? ' schlecht' : ''), title: hinweis },
    el('span', { class: 'kzwert' }, String(wert)),
    el('span', { class: 'kzwas' }, was)
  );
}

function renderStatus() {
  const gespeichert = prices.size + schutz.size;
  const klassen = Object.keys(katalog).length;
  $('#wkWiederZeigen').checked = !erststartErledigt();

  setChildren(
    $('#statusBody'),

    /* --- Was gerade laeuft, aus dem Dienst selbst gelesen --- */
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'Dieser Rechner'),
      el(
        'div',
        { class: 'kzreihe' },
        kennzahl(
          service.available ? 'läuft' : 'aus',
          'Preisdienst auf 127.0.0.1:4173',
          service.available
        ),
        kennzahl(
          service.chrome ? 'gefunden' : 'fehlt',
          'Chrome für den Abruf',
          service.chrome
        ),
        kennzahl(ALLE_STATIONEN.length, 'Sixt-Stationen hinterlegt'),
        kennzahl(
          providerById(PROVIDER).markets.filter((m) => !m.gestoert).length,
          'Länderseiten abrufbar',
          null,
          providerById(PROVIDER)
            .markets.filter((m) => m.gestoert)
            .map((m) => `${m.label}: ${m.gestoert}`)
            .join('\n') || null
        ),
        kennzahl(klassen, 'ACRISS-Klassen im Katalog'),
        kennzahl(gespeichert, 'Abrufe im Speicher')
      ),
      el(
        'p',
        { class: 'note' },
        service.available
          ? service.chrome
            ? 'Der Abruf öffnet die Länderseiten in einem eigenen Chrome-Fenster außerhalb des sichtbaren Bereichs. Es wird nichts an Dritte gesendet; Ergebnisse verfallen nach einer Stunde.'
            : 'Ohne Google Chrome bleibt der Link-Modus: das Werkzeug baut die Suchen, abgerufen wird von Hand. Edge genügt dafür nicht, damit kommt der Abruf nicht zustande.'
          : 'Der Dienst läuft nicht. Ohne ihn gibt es nur die Linkliste, zum Abrufen „Preistool starten.cmd" verwenden.'
      )
    ),

    /* --- Was das Werkzeug kann, mit den bewussten Luecken --- */
    ...WERKZEUG_STAND.map((g) =>
      el(
        'div',
        { class: 'card' },
        el('h3', {}, g.gruppe),
        el(
          'ul',
          { class: 'standliste' },
          ...g.punkte.map(([stand, titel, text]) =>
            el(
              'li',
              { class: 'st ' + stand },
              el(
                'span',
                { class: 'stmark' },
                stand === 'ja' ? '✓' : stand === 'teils' ? '~' : '✕'
              ),
              el(
                'span',
                {},
                el('b', {}, titel),
                el('span', { class: 'sttext' }, text)
              )
            )
          )
        )
      )
    ),

    el('h2', { class: 'statusteil' }, 'Anbieter'),

    ...PROVIDERS.map((p) =>
      el(
        'div',
        { class: 'card statusrow' },
        el(
          'h3',
          {},
          el('span', { class: 'dot', style: `background:${p.theme?.accent || '#888'}` }),
          p.label,
          el(
            'span',
            { class: 'mtag ' + (p.status === 'ready' ? 'ok' : 'warn') },
            p.status === 'ready' ? 'angebunden' : 'noch nicht angebunden'
          )
        ),
        p.status === 'ready'
          ? el(
              'ul',
              { class: 'caps' },
              ...Object.entries(p.capabilities).map(([k, v]) =>
                el('li', { class: v ? 'yes' : 'no' }, (v ? '✓ ' : '✕ ') + CAP_LABEL[k])
              )
            )
          : null,
        // Die Stationszahl steht schon oben als Kennzahl, hier waere sie
        // nur Wiederholung.
        ...p.notes.map((n) => el('p', { class: 'note' }, n))
      )
    )
  );
}

/* =========================================================== Ablauf */

/**
 * Neu zeichnen.
 *
 * `teile` grenzt ein, was wirklich neu gebaut wird. Alles blind neu zu bauen
 * ist der Grund, warum die Seite bei jedem Klick zuckt: Listen scrollen
 * zurueck, Hoehen aendern sich, der Blick verliert die Stelle.
 */
function update(teile = {}) {
  const { stationen = true, maerkte = true, pillen = true } = teile;
  persist();

  const tage = Math.max(1, daysBetween(state.pickupDate, state.returnDate));
  $('#dauer').textContent =
    `${pretty(state.pickupDate)} ${state.pickupTime} → ${pretty(state.returnDate)} ${state.returnTime}` +
    ` · ${tage} ${tage === 1 ? 'Tag' : 'Tage'}`;

  renderKopf();
  renderZeiten();

  if (stationen) renderStationPicker();
  if (maerkte) renderMarkets();
  if (pillen) {
    renderPills(
      '#shifts',
      [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
      () => state.dayShifts,
      (n) => (n === 0 ? 'Stichtag' : (n > 0 ? `+${n}` : `${n}`) + ' Tg'),
      (arr) => {
        if (!arr.length) arr.push(0);
      }
    );
    renderPills(
      '#returnShifts',
      [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
      () => state.returnShifts,
      (n) => (n === 0 ? 'Stichtag' : (n > 0 ? `+${n}` : `${n}`) + ' Tg'),
      (arr) => {
        if (!arr.length) arr.push(0);
      }
    );
    renderPills(
      '#durations',
      [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28],
      () => state.durations,
      (n) => `${n} Tg`,
      () => {}
    );

    // Eine feste Mietdauer setzt den Rückgabetag ausser Kraft, das muss man
    // sehen, sonst stellt man dort etwas ein, das nichts bewirkt.
    const dauerGesetzt = state.durations.length > 0;
    $('#feldRueck').classList.toggle('stillgelegt', dauerGesetzt);
    $('#rueckNote').textContent = dauerGesetzt
      ? 'Ohne Wirkung, solange unten eine Mietdauer gewählt ist.'
      : 'Beide Enden getrennt: Mo→Mo bleibt, dazu Di→Mo und So→Mo.';
  }
  // Aus update() heraus hat sich der Zustand geaendert, hier muss die
  // Tabelle tatsaechlich neu gebaut werden.
  renderResults({ erzwingen: true });
}

/**
 * Dem Dienst sagen, dass dieses Fenster noch offen ist.
 *
 * Läuft das Werkzeug als eigenständiges Programm, hat es kein Konsolenfenster
 * mehr, das man schliessen könnte, dieses Fenster hier ist der Ausschalter.
 * Der Dienst kann das aber nicht am Chrome-Prozess ablesen, weil Chrome
 * Fenster zwischen seinen Prozessen weiterreicht. Also sagt es die Seite.
 *
 * Aus dem Quellbaum heraus ist beides folgenlos: der Dienst nimmt es
 * entgegen und beendet sich nicht.
 */
function haltAmLeben() {
  // Eigene Kennung je Fenster: der Dienst zählt sie einzeln, sonst würde das
  // Schliessen des einen Fensters das Programm beenden, während ein zweites
  // noch offen steht.
  const kennung = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const melde = () => fetch(`/api/lebt?id=${kennung}`, { cache: 'no-store' }).catch(() => {});
  melde();
  setInterval(melde, 15_000);

  // pagehide statt unload: unload verhindert, dass die Seite in den
  // Zwischenspeicher des Browsers darf, und wird in manchen Fällen gar nicht
  // mehr ausgelöst. sendBeacon kommt auch dann noch durch, wenn die Seite
  // schon abgebaut wird.
  addEventListener('pagehide', () => {
    try {
      navigator.sendBeacon(`/api/fenster-zu?id=${kennung}`);
    } catch {
      /* dann greift der Notnagel im Dienst */
    }
  });
}

/**
 * Oberfläche initialisieren. Die Startseite ist ohne Vorspann sofort bedienbar.
 */
function init() {
  // Als Allererstes: dem Dienst sagen, dass es dieses Fenster gibt. Vorher
  // geschah das erst, nachdem die Dienstpruefung zurueck war, bei einer
  // grossen Seite mit eingebettetem Vorspann dauert das lange genug, dass
  // sich das Programm zwischendurch fuer verwaist hielt und beendete.
  haltAmLeben();


  document.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      schutzAcriss = null;
      state.mode = b.dataset.mode;
      persist();
      if (state.mode === 'status') {
        renderStatus();
        showScreen('status');
      } else if (state.mode === 'mail') {
        renderMail();
        showScreen('mail');
      } else if (state.mode === 'verlauf') {
        renderVerlauf();
        showScreen('verlauf');
      } else if (state.mode === 'kurve') {
        showScreen('kurve');
        ladeKurve();
        ladeWecker();
      } else if (state.mode === 'kalender') {
        oeffneKalender();
      } else {
        showScreen('work');
        update();
        // Ohne Station gibt es nichts zu zeigen, dann führt die Wahl.
        if (!state.stations.length) zeigeBereich('station');
      }
    })
  );

  document.querySelectorAll('.back').forEach((b) =>
    b.addEventListener('click', () => {
      schutzAcriss = null;
      state.mode = null;
      persist();
      showScreen('start');
    })
  );
  document.querySelectorAll('.zurueckTabelle').forEach((b) =>
    b.addEventListener('click', () => {
      schutzAcriss = null;
      showScreen('work');
    })
  );

  for (const [sel, key] of [
    ['#pickupDate', 'pickupDate'],
    ['#returnDate', 'returnDate'],
    ['#pickupTime', 'pickupTime'],
    ['#returnTime', 'returnTime'],
  ]) {
    const n = $(sel);
    n.value = state[key];
    n.addEventListener('input', () => {
      state[key] = n.value;
      update();
    });
  }

  $('#stationSearch').addEventListener('input', renderStationPicker);
  $('#addAll').addEventListener('click', () => {
    for (const s of suche($('#stationSearch').value)) {
      if (!state.stations.includes(s.code)) state.stations.push(s.code);
    }
    update();
  });
  $('#addManual').addEventListener('click', () => {
    const code = $('#manualStation').value.trim();
    if (!code) return;
    if (!state.stations.includes(code)) state.stations.push(code);
    $('#manualStation').value = '';
    update();
  });
  $('#returnStation').addEventListener('change', (e) => {
    state.returnStation = e.target.value || null;
    update();
  });

  $('#testStart').addEventListener('click', starteSelbsttest);

  /* --- Begrüßung --- */
  $('#wkStart').addEventListener('click', willkommenTest);
  $('#wkNochmal').addEventListener('click', willkommenTest);
  // "Später prüfen" merkt sich nichts: beim nächsten Start steht die
  // Begrüßung wieder da. Wer sie loswerden will, prüft einmal.
  $('#wkUeberspringen').addEventListener('click', () => beendeWillkommen(false));
  $('#wkFertig').addEventListener('click', () => beendeWillkommen($('#wkNichtMehr').checked));

  $('#wkWiederZeigen').addEventListener('change', (e) => {
    // Angehakt heisst "zeigen", im Speicher steht aber das Gegenteil.
    try {
      if (e.target.checked) localStorage.removeItem(LS_ERSTSTART);
      else localStorage.setItem(LS_ERSTSTART, 'fertig');
    } catch {
      /* ohne Speicher lässt sich das nicht merken */
    }
    flash(
      e.target.checked
        ? 'Die Begrüßung erscheint beim nächsten Start.'
        : 'Die Begrüßung bleibt aus.'
    );
  });
  $('#wkJetztAnsehen').addEventListener('click', zeigeWillkommen);

  /* --- Monatsübersicht --- */
  $('#kalStation').addEventListener('input', renderKalStationSuche);

  // Die Klassenwahl am Kalender. Dieselbe Einstellung wie im Formular oben,
  // renderKalFormular() zieht das dortige Feld hinterher, sodass beide nie
  // auseinanderlaufen.
  $('#kalKlasse2').addEventListener('change', (e) => wechsleKalKlasse(e.target.value));

  $('#kalZeitHinzu').addEventListener('click', () => {
    if (!Array.isArray(state.kalender.zeiten)) state.kalender.zeiten = [];
    const spaeter = (t) => {
      const [h, m] = String(t || '10:00').split(':').map(Number);
      return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    const letzte = state.kalender.zeiten.at(-1) || { ab: state.kalender.zeit, zurueck: state.kalender.zeit };
    state.kalender.zeiten.push({ ab: spaeter(letzte.ab), zurueck: spaeter(letzte.zurueck) });
    kalTagAuswahl = null;
    persist();
    renderKalFormular();
    renderKalBild();
  });

  /* --- Mehrere Stationen im Kalender --- */
  $('#kalMultiSuche').addEventListener('input', renderKalMultiTreffer);
  $('#kalMultiStart').addEventListener('click', starteKalMulti);
  $('#kalMultiAbbrechen').addEventListener('click', async () => {
    // Erst das eigene Weiterlaufen stoppen, dann die Warteschlange leeren,
    // andersherum stellte die Schleife gleich wieder Aufträge nach.
    kalMultiLaeuft = false;
    await abbrechen();
    renderKalMulti();
  });
  $('#kalStart2').addEventListener('click', (e) =>
    e.currentTarget.dataset.neu ? kalNeuMessen() : starteKalender()
  );
  $('#kalNachfassen').addEventListener('click', () => starteKalender({ nurFehlende: true }));
  $('#kalAbbrechen').addEventListener('click', abbrechen);
  $('#kalCsv').addEventListener('click', kalenderCsv);
  $('#kalInkognito').addEventListener('change', async (e) => {
    state.kalender.inkognito = e.target.checked;
    kalTagAuswahl = null;
    persist();
    // Die Aufzeichnung muss mit: sie ist nach Modus gefiltert, und ohne das
    // Nachladen blieben die Messungen des anderen Modus stehen, der Kalender
    // sähe voll aus, obwohl im neuen Modus noch nichts gemessen wurde.
    await ladeKalAufzeichnung();
    renderKalFormular();
    renderKalBild();
  });
  // Eine frei eingetragene Dauer wird erst übernommen, wenn sie fertig
  // getippt ist: bei "change" statt "input". Sonst stünde nach der ersten
  // Ziffer von "45" schon ein Kalender für 4 Tage da und der Abruf liefe an.
  $('#kalDauerFrei').addEventListener('change', async (e) => {
    const n = Math.round(Number(e.target.value));
    if (!Number.isFinite(n) || n < KAL_DAUER_MIN || n > KAL_DAUER_MAX) {
      e.target.value = String(state.kalender.dauer);
      flash(`Bitte eine Mietdauer zwischen ${KAL_DAUER_MIN} und ${KAL_DAUER_MAX} Tagen eintragen.`);
      return;
    }
    state.kalender.dauer = n;
    kalTagAuswahl = null;
    persist();
    await ladeKalAufzeichnung();
    renderKalFormular();
    renderKalBild();
  });

  for (const [sel, feld, wandeln] of [
    ['#kalHost', 'host', String],
    ['#kalKlasse', 'klasse', String],
    ['#kalDauer', 'dauer', Number],
    ['#kalSpanne', 'spanne', Number],
    ['#kalStart', 'start', String],
    ['#kalZeit', 'zeit', String],
  ]) {
    $(sel).addEventListener('input', async (e) => {
      // "Andere Dauer …" ist keine Zahl, sondern der Weg zum Eingabefeld.
      if (feld === 'dauer' && e.target.value === 'frei') {
        const feldFrei = $('#kalDauerFrei');
        feldFrei.hidden = false;
        feldFrei.value = String(state.kalender.dauer);
        feldFrei.focus();
        feldFrei.select();
        return;
      }
      state.kalender[feld] = wandeln(e.target.value);
      kalTagAuswahl = null;
      persist();
      // Ein Wechsel der Länderseite ändert, welche Klassen es dort gibt.
      if (feld === 'host') {
        renderKalFahrzeug();
        if (!(await ladeKalKlassen())) return;
      }
      // Länderseite und Mietdauer entscheiden mit, welche Messpunkte
      // überhaupt zum Kalender passen, sonst zeigt er Preise für drei Tage,
      // während sieben eingestellt sind.
      if (feld === 'host' || feld === 'dauer') await ladeKalAufzeichnung();
      renderKalFormular();
      renderKalBild();
    });
  }

  $('#mailSuche').addEventListener('input', renderMailTreffer);
  $('#mailAlleTreffer').addEventListener('click', () => {
    for (const s of suche($('#mailSuche').value)) {
      if (!mailAuswahl.has(s.code)) mailAuswahl.set(s.code, s.flughafen === true);
    }
    renderMail();
  });
  $('#mailLeeren').addEventListener('click', () => {
    mailAuswahl.clear();
    renderMail();
  });
  $('#mailKopieren').addEventListener('click', async () => {
    const adressen = mailAdressen();
    await navigator.clipboard.writeText(adressen.join('; ')).catch(() => {});
    flash(`${adressen.length} Adressen kopiert`);
  });
  $('#mailSchreiben').addEventListener('click', () => {
    const adressen = mailAdressen();
    // Ins BCC-Feld: die Stationen sollen die Adressen der anderen nicht sehen.
    // Sehr lange Listen sprengen die Laengengrenze mancher Mailprogramme,
    // dann ist "kopieren" der bessere Weg, und das steht dann auch da.
    const link = `mailto:?bcc=${encodeURIComponent(adressen.join(','))}`;
    if (link.length > 1800) {
      flash(`${adressen.length} Adressen sind zu viele für einen Mail-Link, bitte kopieren.`);
      return;
    }
    location.href = link;
  });

  // Einstellungen klappen auf, statt dauerhaft Platz zu nehmen.
  document.querySelectorAll('[data-panel]').forEach((b) =>
    b.addEventListener('click', () => zeigeBereich(b.dataset.panel))
  );

  $('#getPrices').addEventListener('click', () => fetchPrices());
  $('#nochmal').addEventListener('click', () => fetchPrices({ nurFehler: true }));
  $('#getSchutz').addEventListener('click', fetchSchutz);
  for (const id of ['#abbrechen', '#abbrechen2']) {
    $(id).addEventListener('click', abbrechen);
  }
  $('#csv').addEventListener('click', ladeCsvHerunter);

  /* --- Excel-Ausgabe --- */
  const xFelder = [
    ['#xPreise', 'preise'],
    ['#xSchutz', 'schutz'],
    ['#xKalender', 'kalender'],
    ['#xAlleStationen', 'alleStationen'],
    ['#xNichtBuchbare', 'nichtBuchbare'],
    ['#xFarbskala', 'farbskala'],
  ];
  $('#excel').addEventListener('click', () => {
    const karte = $('#xlsxKarte');
    // Zweiter Klick schliesst wieder, derselbe Umgang wie bei den
    // aufklappenden Bereichen oben.
    if (!karte.hidden) {
      karte.hidden = true;
      return;
    }
    const opt = xlsxOptionen();
    for (const [sel, feld] of xFelder) $(sel).checked = Boolean(opt[feld]);
    $('#xBetraege').value = opt.betraege;
    karte.hidden = false;
    karte.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#xAbbrechen').addEventListener('click', () => ($('#xlsxKarte').hidden = true));
  $('#xSpeichern').addEventListener('click', () => {
    state.xlsx = {
      ...xlsxOptionen(),
      ...Object.fromEntries(xFelder.map(([sel, feld]) => [feld, $(sel).checked])),
      betraege: $('#xBetraege').value,
    };
    persist();
    ladeExcelHerunter();
    $('#xlsxKarte').hidden = true;
  });
  $('#openAll').addEventListener('click', openAll);
  $('#copyAll').addEventListener('click', copyAll);
  $('#marketsAll').addEventListener('click', () => {
    state.markets = providerById(PROVIDER)
      .markets.filter((m) => !m.gestoert)
      .map((m) => m.code);
    update();
  });
  $('#marketsNone').addEventListener('click', () => {
    state.markets = [];
    update();
  });
  $('#marketsDACH').addEventListener('click', () => {
    state.markets = ['de', 'at', 'ch'];
    update();
  });
  $('#zeitHinzu').addEventListener('click', () => {
    if (!Array.isArray(state.zeiten)) state.zeiten = [];
    // Als Vorschlag eine Stunde später als das Grundpaar: so sieht man sofort,
    // worum es geht, statt zweimal dieselbe Zeit dastehen zu haben.
    const spaeter = (t) => {
      const [h, m] = String(t || '10:00').split(':').map(Number);
      return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    const letzte = state.zeiten.at(-1) || { ab: state.pickupTime, zurueck: state.returnTime };
    state.zeiten.push({ ab: spaeter(letzte.ab), zurueck: spaeter(letzte.zurueck) });
    update();
  });

  $('#inkognito').addEventListener('change', (e) => {
    state.inkognito = e.target.checked;
    // Der Modus steckt im Schlüssel jedes Auftrags. Was mit Cookies geholt
    // wurde, gehört nicht in dieselbe Tabelle wie ein Abruf ohne, deshalb
    // beginnt der Vergleich sichtbar von vorn statt halb gefüllt.
    prices.clear();
    schutz.clear();
    aktiveGruppe = null;
    letzteSignatur = null;
    update();
    flash(
      e.target.checked
        ? 'Abruf ohne Cookies. Der nächste Vergleich beginnt von vorn und dauert etwas länger.'
        : 'Abruf mit gespeicherter Cookie-Auswahl, schneller, aber Sixt erkennt dich wieder.'
    );
  });
  // Wirklich auf null: keine Station, keine Länderseite, keine Matrix, keine
  // Ergebnisse. Vorher setzte der Knopf auf die Voreinstellung zurück, also
  // wieder Frankfurt und fünf Länder, und wer zwanzig Stationen loswerden
  // wollte, hatte danach immer noch eine.
  $('#reset').addEventListener('click', async () => {
    state.stations = [];
    state.markets = [];
    state.returnStation = null;
    state.dayShifts = [0];
    state.returnShifts = [0];
    state.durations = [];
    prices.clear();
    schutz.clear();
    schutzAcriss = null;
    aktiveGruppe = null;
    letzteSignatur = null;
    // Auch beim Dienst wegräumen, sonst kommen die alten Preise beim
    // nächsten Takt gleich wieder herein.
    await fetch('/api/results/clear', { method: 'POST' }).catch(() => {});
    update();
    // Ohne das Zurücksetzen würde zeigeBereich() umschalten und den schon
    // offenen Bereich zuklappen, nach einem Reset soll er offen sein.
    offenerBereich = null;
    zeigeBereich('station');
    flash('Auswahl zurückgesetzt.');
  });

  // Die Laenderzahl aus den Daten holen, nicht hinschreiben, sonst stimmt
  // sie nach der naechsten Ernte nicht mehr.
  const laender = new Set(ALLE_STATIONEN.map((s) => s.country).filter(Boolean)).size;
  $('#stationTotal').textContent = ALLE_STATIONEN.length.toLocaleString('de-DE');
  $('#marketTotal').textContent = providerById(PROVIDER).markets.length;
  $('#startFuss').textContent =
    `${ALLE_STATIONEN.length} Sixt-Stationen aus ${laender} Ländern hinterlegt.`;

  // Ein Programmstart fängt auf der Übersicht an, ein Neuladen nicht.
  //
  // sessionStorage ist genau die richtige Grenze: er überlebt F5, aber nicht
  // ein neues Fenster. Die EXE öffnet bei jedem Start ein neues, dort ist er
  // also leer, und man landet vorn. Wer mitten in der Arbeit versehentlich
  // neu lädt, bleibt dagegen, wo er war.
  let fortsetzen = false;
  try {
    fortsetzen = sessionStorage.getItem(SS_LAEUFT) === '1';
    sessionStorage.setItem(SS_LAEUFT, '1');
  } catch {
    /* privater Modus o. ä. dann eben immer vorn anfangen */
  }

  if (!erststartErledigt()) {
    zeigeWillkommen();
  } else if (!fortsetzen) {
    showScreen('start');
  } else if (state.mode === 'status') {
    renderStatus();
    showScreen('status');
  } else if (state.mode === 'mail') {
    renderMail();
    showScreen('mail');
  } else if (state.mode === 'verlauf') {
    renderVerlauf();
    showScreen('verlauf');
  } else if (state.mode === 'kurve') {
    showScreen('kurve');
    ladeKurve();
    ladeWecker();
  } else if (state.mode === 'kalender') {
    oeffneKalender();
  } else if (state.mode) {
    showScreen('work');
    update();
  } else {
    showScreen('start');
  }

  // Proxy-Zustand einmal holen und die Lampe in Gang setzen. Sie zeigt sich
  // von selbst nur, wenn wirklich ein Proxy wirkt.
  ladeProxy();
  haltProxyLampeFrisch();

  checkService().then((ok) => {
    const badge = $('#serviceBadge');
    badge.hidden = false;
    badge.className = 'svc ' + (ok && service.chrome ? 'on' : 'off');
    badge.textContent = !ok
      ? 'Kein Preisdienst, nur Links. Zum Abrufen "Preistool starten.cmd" verwenden.'
      : service.chrome
        ? 'Preisabruf bereit, holt die Preise unsichtbar im Hintergrund'
        : 'Preisdienst läuft, aber kein Chrome gefunden, nur Links';

    $('#getPrices').hidden = !(ok && service.chrome);
    $('#getSchutz').hidden = !(ok && service.chrome);

    if (ok) {
      startPolling();
      ladeKatalog().then(() => {
        if (state.mode && state.mode !== 'status') update();
      });
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
