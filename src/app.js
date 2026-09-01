import { PROVIDERS, SIXT_MARKETS, SIXT_GROUPS } from './providers.js';
import { STATIONS } from './stations.js';

/* =========================================================== Zustand */

const LS_KEY = 'mwt-preistool/v1';

const defaults = () => {
  const t = new Date();
  t.setDate(t.getDate() + 14);
  const back = new Date(t);
  back.setDate(back.getDate() + 4);
  return {
    pickupDate: iso(t),
    returnDate: iso(back),
    pickupTime: '10:00',
    returnTime: '10:00',
    dayShifts: [0], // Abholdatum um n Tage verschieben
    durations: [], // leer = Rückgabedatum wie eingestellt
    stations: [110], // Frankfurt Flughafen
    returnStation: null, // null = gleiche Station
    markets: ['de', 'at', 'ch', 'nl', 'es'],
    group: '',
    prepaid: false,
    vehicleType: 'car',
    sixtCustomerNo: '',
    sixtPassword: '',
    saveLogin: false,
  };
};

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw);
    const merged = { ...defaults(), ...saved };
    // Zugangsdaten nur zurückholen, wenn der Nutzer das ausdrücklich wollte.
    if (!merged.saveLogin) {
      merged.sixtCustomerNo = '';
      merged.sixtPassword = '';
    }
    // Abgelaufene Daten auf sinnvolle Werte zurücksetzen.
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
  const copy = { ...state };
  if (!state.saveLogin) {
    copy.sixtCustomerNo = '';
    copy.sixtPassword = '';
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(copy));
  } catch {
    /* privater Modus o.ä. — kein Grund, das Tool scheitern zu lassen */
  }
}

/* =========================================================== Datums-Helfer */

function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(isoStr, n) {
  const d = new Date(isoStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return iso(d);
}

function daysBetween(a, b) {
  return Math.round(
    (new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000
  );
}

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function pretty(isoStr) {
  const d = new Date(isoStr + 'T12:00:00');
  return `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(
    d.getMonth() + 1
  ).padStart(2, '0')}.`;
}

/* =========================================================== Stationssuche */

/**
 * Bewertet, wie gut eine Station zur Eingabe passt.
 * Treffer im IATA-Code und am Wortanfang zählen mehr als Treffer irgendwo.
 * Gibt -1 zurück, wenn die Station nicht passt.
 */
function score(station, needle) {
  if (!needle) return 0;
  const q = fold(needle);
  const name = fold(station.name);
  const iata = (station.iata || '').toLowerCase();

  if (iata && iata === q) return 1000;
  if (iata && iata.startsWith(q)) return 900;
  if (name.startsWith(q)) return 800;

  // Wortanfang
  const words = name.split(/[\s/().,-]+/);
  if (words.some((w) => w.startsWith(q))) return 700;
  if (name.includes(q)) return 500;

  // Alle Zeichen der Eingabe in Reihenfolge (lockere Fuzzy-Suche)
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  return i === q.length ? 100 : -1;
}

/** Umlaute und Akzente vereinheitlichen, damit "munchen" auch München findet. */
function fold(s) {
  return s
    .toLowerCase()
    .replaceAll('ä', 'a')
    .replaceAll('ö', 'o')
    .replaceAll('ü', 'u')
    .replaceAll('ß', 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function searchStations(needle, limit = 40) {
  if (!needle.trim()) {
    return STATIONS.filter((s) => s.iata).slice(0, limit);
  }

  let hits = STATIONS.map((s) => ({ s, sc: score(s, needle) })).filter(
    (x) => x.sc >= 0
  );

  // Sobald es echte Treffer gibt, die lockeren Fuzzy-Treffer wegwerfen —
  // sonst steht hinter "PMI" plötzlich halb Frankreich.
  const best = Math.max(0, ...hits.map((x) => x.sc));
  if (best >= 500) hits = hits.filter((x) => x.sc >= 500);

  return hits
    .sort(
      (a, b) =>
        b.sc - a.sc ||
        // Bei Gleichstand zuerst Flughäfen — danach wird am häufigsten gesucht.
        Number(Boolean(b.s.iata)) - Number(Boolean(a.s.iata)) ||
        a.s.name.localeCompare(b.s.name)
    )
    .slice(0, limit)
    .map((x) => x.s);
}

function stationById(id) {
  return STATIONS.find((s) => s.id === id);
}

/* =========================================================== Kombinationen */

/**
 * Erzeugt aus dem Zustand alle konkreten Suchanfragen.
 * Achse 1: Stationen · Achse 2: Datumsvarianten · Achse 3: Länderseiten
 */
function buildJobs() {
  const jobs = [];
  const provider = PROVIDERS[0]; // aktuell nur Sixt
  const markets = SIXT_MARKETS.filter((m) => state.markets.includes(m.code));
  const stations = state.stations.map(stationById).filter(Boolean);
  const returnStation = state.returnStation
    ? stationById(state.returnStation)
    : null;

  const baseDuration = Math.max(1, daysBetween(state.pickupDate, state.returnDate));
  const durations = state.durations.length ? state.durations : [baseDuration];
  const shifts = state.dayShifts.length ? state.dayShifts : [0];

  const dateVariants = [];
  for (const shift of shifts) {
    for (const dur of durations) {
      const pickupDate = addDays(state.pickupDate, shift);
      dateVariants.push({
        pickupDate,
        returnDate: addDays(pickupDate, dur),
        duration: dur,
        shift,
      });
    }
  }

  for (const station of stations) {
    for (const v of dateVariants) {
      for (const market of markets) {
        const q = {
          ...state,
          pickupDate: v.pickupDate,
          returnDate: v.returnDate,
        };
        const req = provider.build(q, market, station, returnStation);
        jobs.push({
          provider,
          market,
          station,
          returnStation,
          variant: v,
          ...req,
        });
      }
    }
  }
  return jobs;
}

/* =========================================================== Oberfläche */

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

function renderStationPicker() {
  const box = $('#stationResults');
  const needle = $('#stationSearch').value;
  const hits = searchStations(needle);
  box.replaceChildren(
    ...hits.map((s) => {
      const active = state.stations.includes(s.id);
      return el(
        'button',
        {
          class: 'station' + (active ? ' on' : ''),
          type: 'button',
          title: `Sixt-ID ${s.id}`,
          onclick: () => {
            const i = state.stations.indexOf(s.id);
            if (i >= 0) state.stations.splice(i, 1);
            else state.stations.push(s.id);
            update();
          },
        },
        el('span', { class: 'flag' }, s.country),
        el('span', { class: 'sname' }, s.name),
        s.iata ? el('span', { class: 'iata' }, s.iata) : null
      );
    })
  );
  if (!hits.length) {
    box.append(el('p', { class: 'empty' }, 'Keine Station gefunden.'));
  }
}

function renderChosenStations() {
  const box = $('#chosenStations');
  const chosen = state.stations.map(stationById).filter(Boolean);
  box.replaceChildren(
    ...chosen.map((s) =>
      el(
        'span',
        { class: 'chip' },
        `${s.name} (${s.id})`,
        el('button', {
          type: 'button',
          class: 'x',
          title: 'entfernen',
          onclick: () => {
            state.stations = state.stations.filter((id) => id !== s.id);
            update();
          },
          html: '&times;',
        })
      )
    )
  );
  if (!chosen.length) {
    box.append(el('span', { class: 'empty' }, 'Noch keine Station gewählt.'));
  }

  // Rückgabestation nur anbieten, wenn genau eine Abholstation gewählt ist.
  const sel = $('#returnStation');
  sel.replaceChildren(
    el('option', { value: '' }, '— gleiche wie Abholung —'),
    ...chosen
      .concat(STATIONS.filter((s) => s.iata).slice(0, 60))
      .filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i)
      .map((s) =>
        el(
          'option',
          { value: s.id, ...(state.returnStation === s.id ? { selected: '' } : {}) },
          s.name
        )
      )
  );
}

function renderMarkets() {
  const box = $('#markets');
  box.replaceChildren(
    ...SIXT_MARKETS.map((m) =>
      el(
        'label',
        { class: 'mk' + (state.markets.includes(m.code) ? ' on' : '') },
        el('input', {
          type: 'checkbox',
          ...(state.markets.includes(m.code) ? { checked: '' } : {}),
          onchange: (e) => {
            if (e.target.checked) state.markets.push(m.code);
            else state.markets = state.markets.filter((c) => c !== m.code);
            update();
          },
        }),
        el('span', { class: 'mklabel' }, m.label),
        el('span', { class: 'cur' }, m.cur)
      )
    )
  );
}

function renderGroups() {
  const sel = $('#group');
  sel.replaceChildren(
    ...SIXT_GROUPS.map((g) =>
      el(
        'option',
        { value: g.code, ...(state.group === g.code ? { selected: '' } : {}) },
        g.label
      )
    )
  );
}

function renderShifts() {
  const box = $('#shifts');
  const opts = [-3, -2, -1, 0, 1, 2, 3];
  box.replaceChildren(
    ...opts.map((n) =>
      el(
        'label',
        { class: 'pill' + (state.dayShifts.includes(n) ? ' on' : '') },
        el('input', {
          type: 'checkbox',
          ...(state.dayShifts.includes(n) ? { checked: '' } : {}),
          onchange: (e) => {
            if (e.target.checked) state.dayShifts.push(n);
            else state.dayShifts = state.dayShifts.filter((x) => x !== n);
            if (!state.dayShifts.length) state.dayShifts = [0];
            update();
          },
        }),
        n === 0 ? 'Stichtag' : (n > 0 ? `+${n}` : `${n}`) + ' Tg'
      )
    )
  );
}

function renderDurations() {
  const box = $('#durations');
  const base = Math.max(1, daysBetween(state.pickupDate, state.returnDate));
  const opts = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28];
  box.replaceChildren(
    ...opts.map((n) =>
      el(
        'label',
        { class: 'pill' + (state.durations.includes(n) ? ' on' : '') },
        el('input', {
          type: 'checkbox',
          ...(state.durations.includes(n) ? { checked: '' } : {}),
          onchange: (e) => {
            if (e.target.checked) state.durations.push(n);
            else state.durations = state.durations.filter((x) => x !== n);
            update();
          },
        }),
        `${n} Tg`
      )
    ),
    el(
      'span',
      { class: 'hint' },
      state.durations.length
        ? `${state.durations.length} Dauer(n) gewählt`
        : `keine Auswahl = ${base} Tg laut Datum`
    )
  );
}

function renderResults() {
  const jobs = buildJobs();
  const box = $('#results');
  const count = jobs.length;

  $('#jobCount').textContent = count;
  $('#openAll').disabled = count === 0;
  $('#copyAll').disabled = count === 0;
  $('#warn').hidden = count <= 12;
  $('#warn').textContent =
    count > 12
      ? `${count} Tabs — der Browser wird das eventuell drosseln. Weniger Länder oder Datumsvarianten wählen, oder die Links unten einzeln öffnen.`
      : '';

  if (!count) {
    box.replaceChildren(
      el('p', { class: 'empty' }, 'Station und mindestens eine Länderseite wählen.')
    );
    return;
  }

  // Nach Station + Datumsvariante gruppieren, damit die Länder direkt vergleichbar sind.
  const groups = new Map();
  for (const j of jobs) {
    const key = `${j.station.id}|${j.variant.pickupDate}|${j.variant.returnDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }

  box.replaceChildren(
    ...[...groups.entries()].map(([, list]) => {
      const f = list[0];
      return el(
        'div',
        { class: 'group' },
        el(
          'h3',
          {},
          f.station.name,
          el(
            'span',
            { class: 'span' },
            `${pretty(f.variant.pickupDate)} ${state.pickupTime} → ${pretty(
              f.variant.returnDate
            )} ${state.returnTime} · ${f.variant.duration} Tg`
          )
        ),
        el(
          'div',
          { class: 'links' },
          ...list.map((j) =>
            el(
              'a',
              { href: j.url, target: '_blank', rel: 'noopener', class: 'lnk' },
              el('span', { class: 'mkname' }, j.market.label),
              el('span', { class: 'cur' }, j.market.cur)
            )
          )
        )
      );
    })
  );
}

/* =========================================================== Aktionen */

/**
 * Oeffnet alle Treffer nacheinander.
 * Gestaffelt, weil Browser Rudel von window.open() sonst als Popup-Flut werten.
 */
async function openAll() {
  const jobs = buildJobs();
  if (!jobs.length) return;
  const btn = $('#openAll');
  btn.disabled = true;
  let blocked = 0;

  for (let i = 0; i < jobs.length; i++) {
    const w = window.open(jobs[i].url, '_blank', 'noopener');
    if (!w) blocked++;
    btn.textContent = `Öffne ${i + 1}/${jobs.length} …`;
    await new Promise((r) => setTimeout(r, 260));
  }

  btn.textContent = 'Alle öffnen';
  btn.disabled = false;

  if (blocked) {
    $('#popupHint').hidden = false;
  }
}

function copyAll() {
  const text = buildJobs()
    .map(
      (j) =>
        `${j.station.name} · ${j.market.label} · ${j.variant.pickupDate} → ${j.variant.returnDate}\n${j.url}`
    )
    .join('\n\n');
  navigator.clipboard.writeText(text).then(
    () => flash('Links kopiert.'),
    () => flash('Kopieren nicht möglich — Links unten manuell markieren.')
  );
}

let flashTimer;
function flash(msg) {
  const n = $('#flash');
  n.textContent = msg;
  n.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (n.hidden = true), 2600);
}

/* =========================================================== Verdrahtung */

function bindInput(sel, key, transform = (v) => v) {
  const n = $(sel);
  n.value = state[key];
  n.addEventListener('input', () => {
    state[key] = transform(n.value);
    update();
  });
}

function update() {
  persist();
  renderStationPicker();
  renderChosenStations();
  renderMarkets();
  renderShifts();
  renderDurations();
  renderResults();
}

function init() {
  bindInput('#pickupDate', 'pickupDate');
  bindInput('#returnDate', 'returnDate');
  bindInput('#pickupTime', 'pickupTime');
  bindInput('#returnTime', 'returnTime');
  bindInput('#customerNo', 'sixtCustomerNo');
  bindInput('#password', 'sixtPassword');

  $('#stationSearch').addEventListener('input', renderStationPicker);

  $('#returnStation').addEventListener('change', (e) => {
    state.returnStation = e.target.value ? Number(e.target.value) : null;
    update();
  });

  renderGroups();
  $('#group').addEventListener('change', (e) => {
    state.group = e.target.value;
    update();
  });

  $('#prepaid').checked = state.prepaid;
  $('#prepaid').addEventListener('change', (e) => {
    state.prepaid = e.target.checked;
    update();
  });

  $('#saveLogin').checked = state.saveLogin;
  $('#saveLogin').addEventListener('change', (e) => {
    state.saveLogin = e.target.checked;
    update();
  });

  $('#openAll').addEventListener('click', openAll);
  $('#copyAll').addEventListener('click', copyAll);

  $('#marketsAll').addEventListener('click', () => {
    state.markets = SIXT_MARKETS.map((m) => m.code);
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

  $('#reset').addEventListener('click', () => {
    state = defaults();
    location.reload();
  });

  $('#stationCount').textContent = STATIONS.length;

  update();
}

document.addEventListener('DOMContentLoaded', init);
