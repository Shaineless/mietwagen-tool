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
    stations: ['110'],
    returnStation: null,
    markets: ['de', 'at', 'ch', 'nl', 'es'],
    /** Nur bekannte, aber gerade nicht buchbare Klassen mitzeigen? */
    zeigeNichtBuchbare: true,
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
 * untereinander gestapelt — bei fuenf Stationen sind das fuenf mal fuenfzig
 * Zeilen und man findet nichts wieder. Jetzt gibt es einen Umschalter und
 * immer nur eine Tabelle.
 */
let aktiveGruppe = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!saved) return defaults();
    const merged = { ...defaults(), ...saved };
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
  weiterleitung: false,
  vorschlaegeMail: null,
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
      service.weiterleitung = Boolean(d.weiterleitung);
      service.vorschlaegeMail = d.vorschlaegeMail || null;
    }
  } catch {
    service.available = false;
  }
  return service.available;
}

function jobKey(host, stationCode, v, acrissCode) {
  return [
    acrissCode ? 'schutz' : 'preis',
    PROVIDER,
    host,
    stationCode,
    v.pickupDate,
    v.returnDate,
    state.pickupTime,
    state.returnTime,
    acrissCode || '',
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

async function pollErgebnisse() {
  if (!service.available) return;

  const offen = [...aktuelleJobs(), ...schutzJobs()]
    .filter((j) => j.key && !prices.has(j.key) && !schutz.has(j.key))
    .map((j) => j.key);

  if (offen.length) {
    try {
      const r = await fetch(`/api/results?keys=${encodeURIComponent(offen.join(','))}`, {
        cache: 'no-store',
      });
      const d = await r.json();
      let neu = false;
      for (const [k, v] of Object.entries(d.results || {})) {
        if (k.startsWith('schutz~')) {
          if (!schutz.has(k)) { schutz.set(k, v); neu = true; }
        } else if (!prices.has(k)) {
          prices.set(k, v);
          neu = true;
        }
      }
      if (neu) {
        // Nur neu zeichnen, wenn sich die sichtbare Ansicht wirklich aendert.
        // Frueher wurde bei jedem Takt die ganze Tabelle verworfen und neu
        // gebaut — 52 Zeilen, alle 2,5 Sekunden. Das sah man als Flackern,
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

    // Genau im Moment des Leerlaufens die Suche in den Verlauf legen — nicht
    // bei jedem Takt, sonst stünde sie fünfmal drin.
    const laeuftNoch = Boolean(h.queue && (h.queue.laufend || h.queue.offen));
    if (liefNoch && !laeuftNoch) merkeSuche();
  } catch {
    /* egal */
  }
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
  if (v == null) return '—';
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
 *   Rueckgabetag  Beide Enden sind unabhaengig. "Montag bis Montag — aber was
 *                 kostet Dienstag bis Montag, was Sonntag bis Montag?" Genau
 *                 dafuer laesst sich die Rueckgabe getrennt verschieben.
 *
 * Kombinationen, bei denen die Rueckgabe nicht nach der Abholung liegt, fallen
 * weg: dafuer gibt es keinen Preis, nur eine Fehlermeldung von Sixt.
 */
function dateVariants() {
  const grunddauer = Math.max(1, daysBetween(state.pickupDate, state.returnDate));
  const shifts = state.dayShifts.length ? state.dayShifts : [0];
  const out = [];

  if (state.durations.length) {
    for (const shift of shifts) {
      for (const dur of state.durations) {
        const pickupDate = addDays(state.pickupDate, shift);
        out.push({ pickupDate, returnDate: addDays(pickupDate, dur), duration: dur });
      }
    }
    return out;
  }

  const rueck = state.returnShifts?.length ? state.returnShifts : [0];
  for (const shift of shifts) {
    for (const rshift of rueck) {
      const pickupDate = addDays(state.pickupDate, shift);
      const returnDate = addDays(state.returnDate, rshift);
      const duration = daysBetween(pickupDate, returnDate);
      if (duration < 1) continue;
      out.push({ pickupDate, returnDate, duration });
    }
  }
  // Alles weggefallen? Dann wenigstens der eingestellte Zeitraum selbst.
  if (!out.length) {
    out.push({
      pickupDate: state.pickupDate,
      returnDate: state.returnDate,
      duration: grunddauer,
    });
  }
  return out;
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
        const q = { ...state, pickupDate: v.pickupDate, returnDate: v.returnDate };
        const built = provider.build(q, market, station, ret);
        const key = jobKey(market.host, station.code, v);
        jobs.push({
          market,
          station,
          variant: v,
          key,
          gruppe: `${station.code}|${v.pickupDate}|${v.returnDate}`,
          url: built.url,
        });
      }
    }
  }
  return jobs;
}

/**
 * Alle Schutz-Auftraege der betrachteten Klasse — ueber jede Station und
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
          gruppe: `${station.code}|${v.pickupDate}|${v.returnDate}`,
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
 * doppelt nebeneinander — mit gleicher Beschriftung, also nicht
 * unterscheidbar — und der Abruf liefe doppelt so lange.
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
  $('#start').hidden = name !== 'start';
  $('#statusScreen').hidden = name !== 'status';
  $('#work').hidden = name !== 'work';
  $('#schutzScreen').hidden = name !== 'schutz';
  $('#mailScreen').hidden = name !== 'mail';
  $('#verlaufScreen').hidden = name !== 'verlauf';
}

/* =========================================================== Verlauf
 *
 * Die Preisergebnisse selbst verfallen nach einer Stunde — bewusst, es ist
 * kein Beobachtungsdienst. Der Verlauf ist etwas anderes: eine Handvoll
 * Momentaufnahmen zum Nachschlagen, "was war letzte Woche derselbe Wagen".
 * Deshalb liegt er im Browser und nicht im Ergebnisspeicher.
 */

const LS_VERLAUF = 'mwt-preistool/verlauf';
const VERLAUF_MAX = 5;

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
    /* privater Modus oder voll — dann eben kein Verlauf */
  }
}

/**
 * Die gerade gezeigte Gruppe als Momentaufnahme sichern.
 *
 * Gleiche Station, gleicher Zeitraum, gleiche Länderseiten überschreiben den
 * vorhandenen Eintrag statt einen zweiten anzulegen — sonst ist die Liste
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

  const liste = ladeVerlauf().filter((e) => e.kennung !== kennung);
  liste.unshift(eintrag);
  speichereVerlauf(liste);
}

/** Welche Fahrzeugklasse im Vergleich gezeigt wird. */
let verlaufKlasse = null;

/**
 * Mehrere Suchen nebeneinander.
 *
 * Untereinander liegende Karten beantworten die eigentliche Frage nicht:
 * "war derselbe Wagen letzte Woche billiger?" heisst, zwei Zahlen direkt
 * nebeneinander zu sehen. Deshalb bilden die Suchen die Spalten, die
 * Länderseiten die Zeilen — und oben wird die Fahrzeugklasse gewählt, denn
 * ohne die vergleicht man Golf mit S-Klasse.
 */
function renderVergleich(liste) {
  // Klassen, die in mindestens zwei Suchen vorkommen, führen die Liste an —
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
        ? `${verlaufKlasse} — zum Beispiel ${modell}. Verglichen wird nur innerhalb derselben Währung.`
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
                  w != null ? el('span', { class: 'betrag' }, money(w, l.cur)) : '—'
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
        'Termin je Länderseite — dieselbe Klasse, dieselbe Währung.'
    )
  );
}

function renderVerlauf() {
  const liste = ladeVerlauf();

  if (!liste.length) {
    setChildren(
      $('#verlaufBody'),
      el(
        'p',
        { class: 'empty' },
        'Noch nichts gesucht. Nach jedem Abruf wird die Suche hier abgelegt — die letzten fünf.'
      )
    );
    return;
  }

  setChildren(
    $('#verlaufBody'),
    // Der Vergleich zuerst — er ist der Grund, warum es diese Seite gibt.
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
                      : '—'
                  ),
                  el(
                    'td',
                    {},
                    t.acriss ? el('span', { class: 'acriss' }, t.acriss) : '—',
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
 * `flughafen` am Datensatz und entscheidet sich am Namen (siehe build.mjs) —
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
    (needle.trim() ? '' : ' — tippen zum Filtern');
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
        // Die Einordnung ist geraten, nicht gewusst — also umstellbar.
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
    (needle.trim() ? '' : ' — tippen zum Filtern');
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
    el('option', { value: '' }, '— gleiche wie Abholung —'),
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
 * Auswahl halb so hoch und auf einen Blick erfassbar — man sieht sofort, was
 * gewaehlt ist, ohne 23 Zeilen abzusuchen.
 */
function renderMarkets() {
  setChildren(
    $('#markets'),
    ...providerById(PROVIDER).markets.map((m) => {
      const on = state.markets.includes(m.code);
      return el(
        'button',
        {
          type: 'button',
          class: 'mchip' + (on ? ' on' : ''),
          onclick: () => {
            if (on) state.markets = state.markets.filter((c) => c !== m.code);
            else state.markets.push(m.code);
            // Nur das Ergebnis neu zeichnen: die Stationsliste anzufassen
            // liesse sie zurueckscrollen.
            update({ stationen: false });
          },
        },
        el('span', { class: 'mklabel' }, m.label),
        el('span', { class: 'cur' }, m.cur)
      );
    })
  );
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
      // (S und L für Automatik, P als Antrieb) — deren Text ist damit immer
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
        // Der Abruf hat selbst gemerkt, dass Zahlen nicht zusammenpassen —
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
                // Aus dem Zwischenspeicher ist das Bild sofort da — dann gar
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
              el('span', { class: 'acriss' }, z.cls.acriss || '—'),
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
            bekannt ? el('span', { class: 'nichtbuchbar' }, 'nicht buchbar') : '—'
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
              (o.unstimmig ? 'Betrag passt nicht zum Tagespreis — bitte auf der Seite prüfen. ' : '') +
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
        ? ` Mehrere Währungen (${[...spaltenJeWährung.keys()].join(', ')}) — markiert wird nur innerhalb derselben Währung, es wird nicht umgerechnet.`
        : '',
      fruehbucherSpalten.size && fruehbucherSpalten.size < spalten.length
        ? ' Achtung: der Frühbucherrabatt läuft nicht auf allen Länderseiten — Spalten mit „Frühbucher" sind dadurch im Vorteil.'
        : ''
    )
  );
}

/* =========================================================== Bühne */

/**
 * Der Fund als Satz — die Bühne oben auf der Seite.
 *
 * Zeigt das guenstigste Angebot ueber alle abgerufenen Laenderseiten und
 * wieviel es gegenueber der teuersten Seite derselben Klasse spart. Solange
 * nichts abgerufen ist, steht hier die Aufforderung statt einer Zahl — eine
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
        el('p', { class: 'lab' }, 'Bereit'),
        el(
          'h2',
          {},
          // Die Buehne zeigt immer genau die gewaehlte Gruppe — auch wenn
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

  // Teuerste Seite derselben Klasse und Waehrung — daraus die Ersparnis.
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
        // Bei mehreren Stationen muss dranstehen, welche gemeint ist — der
        // Satz darunter gilt nur fuer diese eine.
        new Set(alle.map((j) => j.gruppe)).size > 1
          ? `Günstigster Fund · ${bester.job.station.name}`
          : 'Günstigster Fund'
      ),
      el(
        'h2',
        {},
        // Kein zusammengebautes Adjektiv aus dem Landesnamen — daraus wird
        // schnell "spanienen". Der Host sagt ohnehin mehr aus.
        `${bester.o.model} für `,
        el('em', {}, money(bester.wert, bester.o.currency)),
        ` auf ${bester.job.market.host.replace(/^www\./, '')}.`
      ),
      spart && spart > 0.5
        ? el(
            'p',
            { class: 'unter' },
            `${money(spart, bester.o.currency)} weniger als auf der teuersten geprüften Seite — ` +
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
          el('span', { class: 'z' }, bester.o.acriss || '—'),
          el('span', { class: 'w' }, 'günstigste Klasse')
        )
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
  document.querySelectorAll('[data-panel]').forEach((b) =>
    b.toggleAttribute('data-offen', b.dataset.panel === offenerBereich)
  );
}

/**
 * Reiter fuer Station/Termin-Gruppen.
 *
 * Gibt es nur eine Gruppe, gibt es auch nichts zu waehlen — dann null, damit
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
        el('span', { class: 'gzeit' }, `${pretty(f.variant.pickupDate)} · ${f.variant.duration} Tage`)
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
 * vollstaendigen Neubau der Tabelle aus — auch wenn sich nichts geaendert
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

  // Die gezeigte Gruppe festlegen, bevor irgendjemand sie liest — Buehne und
  // Signatur haengen beide daran.
  const schluessel = [...new Set(jobs.map((j) => j.gruppe))];
  if (!schluessel.includes(aktiveGruppe)) aktiveGruppe = schluessel[0] ?? null;

  // Die billigen Anzeigen laufen immer — sie kosten nichts und flackern nicht.
  $('#jobCount').textContent = jobs.length
    ? `${jobs.length} Abfrage${jobs.length === 1 ? '' : 'n'}`
    : '';
  $('#openAll').disabled = !jobs.length;
  $('#copyAll').disabled = !jobs.length;

  // Nachfassen anbieten, sobald eine Länderseite nichts geliefert hat.
  const ohne = jobsOhneErgebnis(jobs);
  const nochmal = $('#nochmal');
  nochmal.hidden = !ohne.length;
  nochmal.textContent = `${ohne.length} ohne Ergebnis — nochmal versuchen`;
  $('#warn').hidden = jobs.length <= 12;
  $('#warn').textContent =
    jobs.length > 12
      ? `${jobs.length} Abfragen — das dauert rund ${Math.ceil((jobs.length * 6) / 2 / 60)} Minuten.`
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
            `${pretty(f.variant.pickupDate)} ${state.pickupTime} → ${pretty(
              f.variant.returnDate
            )} ${state.returnTime} · ${f.variant.duration} Tage`
          )
        ),
        renderTable(list) ||
          el(
            'p',
            { class: 'empty' },
            service.chrome
              ? 'Noch keine Preise — „Preise holen" drücken.'
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
              rec?.error ? el('span', { class: 'price err' }, rec.error) : null
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
        // — bei zwei Stationen stand hier sonst immer dasselbe.
        gruppe
          ? el(
              'p',
              { class: 'kzeit' },
              el('b', {}, gruppe.station.name),
              ` · ${pretty(gruppe.variant.pickupDate)} ${state.pickupTime} → ` +
                `${pretty(gruppe.variant.returnDate)} ${state.returnTime} · ${gruppe.variant.duration} Tage`
            )
          : null
      )
    )
  );

  const fertig = jobs.filter((j) => schutz.has(j.key));
  $('#schutzHinweis').textContent = fertig.length
    ? `${fertig.length} von ${jobs.length} Länderseiten abgerufen`
    : `${jobs.length} Länderseiten · rund ${Math.ceil((jobs.length * 12) / 2)} Sekunden`;

  // Die Paketnamen heißen in jeder Sprache anders — "Smart-Schutz",
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

    // "Ohne Schutz" ist das Paket mit dem niedrigsten Gesamtpreis — das kostet
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
          ? 'Keine Schutzpakete gefunden — die Klasse ist dort vermutlich nicht buchbar.'
          : 'Noch nichts abgerufen.'
      )
    );
    return;
  }

  // Die Mietdauer der gezeigten Gruppe, nicht die der Grundeinstellung — mit
  // Datums-Matrix koennen sich die beiden unterscheiden.
  const tage = gruppe?.variant.duration ?? Math.max(1, daysBetween(state.pickupDate, state.returnDate));

  /**
   * Mietpreis ohne Zusatzschutz.
   *
   * Bevorzugt der Gesamtpreis, den die Kasse beim Paket "kein Extra-Schutz"
   * anzeigt — gemessen unter denselben Bedingungen wie alle anderen Pakete.
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
        el('span', { class: 'betrag' }, m == null ? '—' : money(m, j.market.cur))
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
          // dieses eine Paket fehlt. Ein blosses "—" verschweigt den Grund.
          if (!r) return el('td', { class: 'leer' }, '');
          if (r.error) return el('td', { class: 'leer' }, el('span', { class: 'zellfehler' }, r.error));
          if (r.verfuegbar === false)
            return el('td', { class: 'leer' }, el('span', { class: 'zellfehler' }, 'nicht buchbar'));
          return el('td', { class: 'leer' }, '—');
        }

        // Der Gesamtpreis ist abgelesen, nicht gerechnet. Der je Paket
        // angezeigte Tagespreis multipliziert sich nicht sauber hoch:
        // gemessen zeigte Sixt 10,77 EUR/Tag an, waehrend der Gesamtpreis bei
        // vier Tagen um 54,22 EUR stieg — 13,55 statt 10,77 je Tag.
        const gesamt = p.gesamt ?? null;
        // Aufschlag hier ausrechnen statt aus dem Abruf uebernehmen: so
        // stammen Bezugswert und Paketpreis aus derselben Messreihe.
        const basis = mietpreis(j);
        const aufschlag =
          gesamt != null && basis != null ? Number((gesamt - basis).toFixed(2)) : null;
        const echtProTag = aufschlag != null ? aufschlag / tage : null;

        return el(
          'td',
          {},
          // Der Name, wie ihn diese Länderseite nennt — bewusst mitgezeigt,
          // damit man die Zuordnung nachprüfen kann.
          el('span', { class: 'lokalname' }, p.name),
          el(
            'span',
            { class: 'betrag' },
            gesamt != null ? money(gesamt, p.waehrung) : '—'
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
            : null
        );
      })
    )
  );

  setChildren(
    $('#schutzBody'),
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
        'eigener Kasse — jedes Paket wird dafür einzeln ausgewählt. Nicht hochgerechnet: ' +
        'der angezeigte Tagespreis multipliziert sich nicht sauber auf, gemessen lagen ' +
        'zwischen beiden rund 26 %. Weicht er ab, steht der Wert der Seite klein darunter. ' +
        'Zugeordnet wird über den Inhalt (Selbstbeteiligung ja/nein, günstiger/teurer), ' +
        'nicht über den Namen — der heißt auf jeder Länderseite anders. Der jeweilige ' +
        'Originalname steht klein über dem Preis, damit die Zuordnung nachprüfbar bleibt.'
    )
  );
}

async function fetchSchutz() {
  const jobs = schutzJobs().filter((j) => !schutz.has(j.key));
  if (!jobs.length) {
    flash('Für diese Klasse liegen schon alle Schutzpreise vor.');
    return;
  }
  await sendeJobs(
    jobs.map((j) => ({
      key: j.key,
      provider: PROVIDER,
      host: j.market.host,
      stationCode: j.station.code,
      acriss: j.acriss,
      pickupDate: j.variant.pickupDate,
      returnDate: j.variant.returnDate,
      pickupTime: state.pickupTime,
      returnTime: state.returnTime,
      currency: j.market.cur,
    })),
    $('#getSchutz')
  );
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
 * Was schon laeuft, laeuft zu Ende — ein Abruf mittendrin abzuwuergen liesse
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
    flash('Abbruch nicht möglich — Dienst antwortet nicht.');
  }
}

/**
 * Abrufe ohne brauchbares Ergebnis.
 *
 * Der Dienst merkt sehr wohl, wenn eine Länderseite nicht durchkommt — der
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
    return r && (r.error != null || !r.offers?.length);
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

  await sendeJobs(
    offen.map((j) => ({
      key: j.key,
      provider: PROVIDER,
      host: j.market.host,
      stationCode: j.station.code,
      returnCode: state.returnStation || undefined,
      pickupDate: j.variant.pickupDate,
      returnDate: j.variant.returnDate,
      pickupTime: state.pickupTime,
      returnTime: state.returnTime,
      currency: j.market.cur,
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
  $('#getPrices').textContent = aktiv ? 'Abruf läuft …' : 'Preise holen';
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

/* =========================================================== Vorschläge */

/**
 * Sagen, wohin ein Vorschlag geht — und zwar bevor jemand tippt.
 *
 * Der Text stand fest auf "bleibt auf diesem Rechner". Sobald eine
 * Weiterleitung eingerichtet ist, waere das nicht mehr wahr, und Vertrauen
 * verliert man genau an solchen Stellen.
 */
function renderVorschlagWohin() {
  $('#vorschlagWohin').textContent = service.weiterleitung
    ? 'Kurz aufschreiben — wird gespeichert und an den Betreuer des Werkzeugs weitergeleitet.'
    : 'Kurz aufschreiben — landet in einer Datei auf diesem Rechner, sonst nirgends.';

  // Ohne eingerichtete Weiterleitung ist die E-Mail der einzige Weg, auf dem
  // ein Vorschlag ankommt. Mit Weiterleitung waere der Knopf nur Beiwerk.
  const mail = $('#vorschlagMail');
  mail.hidden = service.weiterleitung || !service.vorschlaegeMail;
}

/** Vorschlag im Mailprogramm des Nutzers öffnen — er drückt selbst auf Senden. */
function vorschlagAlsMail() {
  const text = $('#vorschlagText').value.trim();
  if (text.length < 3) {
    $('#vorschlagStatus').textContent = 'Bitte etwas mehr schreiben.';
    $('#vorschlagText').focus();
    return;
  }
  const betreff = 'Mietwagen-Preistool — Verbesserungsvorschlag';
  const koerper =
    `${text}\n\n— — —\nStand beim Schreiben:\n` +
    `Stationen: ${state.stations.join(', ') || '—'}\n` +
    `Länderseiten: ${state.markets.join(', ') || '—'}\n` +
    `Zeitraum: ${state.pickupDate} → ${state.returnDate}\n`;
  location.href =
    `mailto:${encodeURIComponent(service.vorschlaegeMail)}` +
    `?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(koerper)}`;
  $('#vorschlagStatus').textContent = 'Mailprogramm geöffnet — dort noch absenden.';
}

async function sendeVorschlag() {
  const feld = $('#vorschlagText');
  const text = feld.value.trim();
  const status = $('#vorschlagStatus');

  if (text.length < 3) {
    status.textContent = 'Bitte etwas mehr schreiben.';
    feld.focus();
    return;
  }

  const btn = $('#vorschlagSenden');
  btn.disabled = true;
  status.textContent = 'wird gespeichert …';

  try {
    const r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        // Der eingestellte Zustand hilft beim Nachvollziehen — ohne
        // persoenliche Daten, das steht hier ohnehin nichts.
        kontext: {
          stationen: state.stations,
          maerkte: state.markets,
          von: state.pickupDate,
          bis: state.returnDate,
          klasse: schutzAcriss,
        },
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'abgelehnt');
    feld.value = '';
    status.textContent = d.weitergeleitet
      ? 'Danke — angekommen.'
      : service.weiterleitung
        ? 'Gespeichert. Weiterleitung hat nicht geklappt — später erneut versuchen.'
        : 'Danke — ist gespeichert.';
  } catch {
    status.textContent = 'Konnte nicht gespeichert werden.';
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ''), 4000);
  }
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

    setChildren(
      $('#testErgebnis'),
      el(
        'ul',
        { class: 'standliste' },
        ...d.schritte.map((s) =>
          el(
            'li',
            { class: 'st ' + (s.stand === 'gut' ? 'ja' : s.stand === 'mittel' ? 'teils' : 'nein') },
            el(
              'span',
              { class: 'stmark' },
              s.stand === 'gut' ? '✓' : s.stand === 'mittel' ? '~' : '✕'
            ),
            el(
              'span',
              {},
              el('b', {}, s.name),
              el('span', { class: 'sttext' }, s.text),
              s.rat ? el('span', { class: 'sttext rat' }, s.rat) : null
            )
          )
        )
      )
    );
  } catch {
    hinweis.textContent = '';
    setChildren($('#testErgebnis'), el('p', { class: 'note warn' }, 'Der Dienst antwortet nicht.'));
  } finally {
    knopf.disabled = false;
    knopf.textContent = 'Selbsttest starten';
  }
}

/** Eine Kennzahl im Dienst-Kasten. */
function kennzahl(wert, was, ok = null) {
  return el(
    'div',
    { class: 'kz' + (ok === true ? ' gut' : ok === false ? ' schlecht' : '') },
    el('span', { class: 'kzwert' }, String(wert)),
    el('span', { class: 'kzwas' }, was)
  );
}

function renderStatus() {
  const gespeichert = prices.size + schutz.size;
  const klassen = Object.keys(katalog).length;

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
        kennzahl(providerById(PROVIDER).markets.length, 'Länderseiten'),
        kennzahl(klassen, 'ACRISS-Klassen im Katalog'),
        kennzahl(gespeichert, 'Abrufe im Speicher')
      ),
      el(
        'p',
        { class: 'note' },
        service.available
          ? service.chrome
            ? 'Der Abruf öffnet die Länderseiten in einem eigenen Chrome-Fenster außerhalb des sichtbaren Bereichs. Es wird nichts an Dritte gesendet; Ergebnisse verfallen nach einer Stunde.'
            : 'Ohne Chrome oder Edge bleibt der Link-Modus: das Werkzeug baut die Suchen, abgerufen wird von Hand.'
          : 'Der Dienst läuft nicht. Ohne ihn gibt es nur die Linkliste — zum Abrufen „Preistool starten.cmd" verwenden.'
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
        // Die Stationszahl steht schon oben als Kennzahl — hier waere sie
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

    // Eine feste Mietdauer setzt den Rückgabetag ausser Kraft — das muss man
    // sehen, sonst stellt man dort etwas ein, das nichts bewirkt.
    const dauerGesetzt = state.durations.length > 0;
    $('#feldRueck').classList.toggle('stillgelegt', dauerGesetzt);
    $('#rueckNote').textContent = dauerGesetzt
      ? 'Ohne Wirkung, solange unten eine Mietdauer gewählt ist.'
      : 'Beide Enden getrennt: Mo→Mo bleibt, dazu Di→Mo und So→Mo.';
  }
  // Aus update() heraus hat sich der Zustand geaendert — hier muss die
  // Tabelle tatsaechlich neu gebaut werden.
  renderResults({ erzwingen: true });
}

/**
 * Dem Dienst sagen, dass dieses Fenster noch offen ist.
 *
 * Läuft das Werkzeug als eigenständiges Programm, hat es kein Konsolenfenster
 * mehr, das man schliessen könnte — dieses Fenster hier ist der Ausschalter.
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

function init() {
  starteHintergrund();

  document.querySelectorAll('.mode').forEach((b) =>
    b.addEventListener('click', () => {
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
      } else {
        showScreen('work');
        update();
        // Ohne Station gibt es nichts zu zeigen — dann führt die Wahl.
        if (!state.stations.length) zeigeBereich('station');
      }
    })
  );

  document.querySelectorAll('.back').forEach((b) =>
    b.addEventListener('click', () => {
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
    // Sehr lange Listen sprengen die Laengengrenze mancher Mailprogramme —
    // dann ist "kopieren" der bessere Weg, und das steht dann auch da.
    const link = `mailto:?bcc=${encodeURIComponent(adressen.join(','))}`;
    if (link.length > 1800) {
      flash(`${adressen.length} Adressen sind zu viele für einen Mail-Link — bitte kopieren.`);
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
  $('#vorschlagSenden').addEventListener('click', sendeVorschlag);
  $('#vorschlagMail').addEventListener('click', vorschlagAlsMail);
  for (const id of ['#abbrechen', '#abbrechen2']) {
    $(id).addEventListener('click', abbrechen);
  }
  $('#openAll').addEventListener('click', openAll);
  $('#copyAll').addEventListener('click', copyAll);
  $('#marketsAll').addEventListener('click', () => {
    state.markets = providerById(PROVIDER).markets.map((m) => m.code);
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
  // Wirklich auf null: keine Station, keine Länderseite, keine Matrix, keine
  // Ergebnisse. Vorher setzte der Knopf auf die Voreinstellung zurück — also
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
    // offenen Bereich zuklappen — nach einem Reset soll er offen sein.
    offenerBereich = null;
    zeigeBereich('station');
    flash('Auswahl zurückgesetzt.');
  });

  // Die Laenderzahl aus den Daten holen, nicht hinschreiben — sonst stimmt
  // sie nach der naechsten Ernte nicht mehr.
  const laender = new Set(ALLE_STATIONEN.map((s) => s.country).filter(Boolean)).size;
  $('#startFuss').textContent =
    `${ALLE_STATIONEN.length} Sixt-Stationen aus ${laender} Ländern hinterlegt.`;

  if (state.mode === 'status') {
    renderStatus();
    showScreen('status');
  } else if (state.mode === 'mail') {
    renderMail();
    showScreen('mail');
  } else if (state.mode === 'verlauf') {
    renderVerlauf();
    showScreen('verlauf');
  } else if (state.mode) {
    showScreen('work');
    update();
  } else {
    showScreen('start');
  }

  checkService().then((ok) => {
    const badge = $('#serviceBadge');
    badge.hidden = false;
    badge.className = 'svc ' + (ok && service.chrome ? 'on' : 'off');
    badge.textContent = !ok
      ? 'Kein Preisdienst — nur Links. Zum Abrufen "Preistool starten.cmd" verwenden.'
      : service.chrome
        ? 'Preisabruf bereit — holt die Preise unsichtbar im Hintergrund'
        : 'Preisdienst läuft, aber kein Chrome gefunden — nur Links';

    $('#getPrices').hidden = !(ok && service.chrome);
    $('#getSchutz').hidden = !(ok && service.chrome);
    // Vorschläge brauchen den Dienst — ohne ihn gäbe es nichts, was sie
    // entgegennimmt.
    $('#vorschlagKarte').hidden = !ok;
    renderVorschlagWohin();

    if (ok) {
      haltAmLeben();
      startPolling();
      ladeKatalog().then(() => {
        if (state.mode && state.mode !== 'status') update();
      });
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
