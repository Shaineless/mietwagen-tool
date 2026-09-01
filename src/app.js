import { PROVIDERS, READY_PROVIDERS, providerById } from './providers.js';
import { STATIONS } from './stations.js';
import {
  buildPlaces,
  stationsAtPlace,
  CONFIDENCE_LABEL,
  fold,
} from './places.js';

/* =========================================================== Zustand */

const LS_KEY = 'mwt-preistool/v2';

const defaults = () => {
  const t = new Date();
  t.setDate(t.getDate() + 14);
  const back = new Date(t);
  back.setDate(back.getDate() + 4);
  return {
    mode: null, // null = Startbildschirm
    provider: 'sixt', // Länder-Modus: der eine Anbieter
    compare: ['sixt'], // Anbieter-Modus: die verglichenen Anbieter
    pickupDate: iso(t),
    returnDate: iso(back),
    pickupTime: '10:00',
    returnTime: '10:00',
    dayShifts: [0],
    durations: [],
    stations: ['110'], // Codes des gewählten Anbieters
    returnStation: null,
    placeId: null,
    markets: ['de', 'at', 'ch', 'nl', 'es'],
  };
};

let state = load();

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
    /* privater Modus — kein Grund zu scheitern */
  }
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

/* =========================================================== Suche */

const PLACES = buildPlaces(STATIONS);

/**
 * Bewertet, wie gut ein Eintrag zur Eingabe passt.
 * IATA-Code und Wortanfang zählen mehr als ein Treffer irgendwo im Namen.
 */
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

/**
 * Gemeinsame Suchlogik für Stationen und Orte.
 * Ohne Eingabe werden ALLE Einträge gezeigt — Bahnhöfe und Stadtstationen
 * sind gleichberechtigt, Flughäfen stehen nur bei Gleichstand vorn.
 */
function rank(items, needle, textOf, iataOf, limit) {
  if (!needle.trim()) {
    // Ohne Eingabe rein alphabetisch: Bahnhöfe, Stadt- und Hotelstationen
    // stehen gleichberechtigt neben den Flughäfen.
    return [...items].sort((a, b) => textOf(a).localeCompare(textOf(b))).slice(0, limit);
  }

  let hits = items
    .map((x) => ({ x, sc: score(textOf(x), iataOf(x), needle) }))
    .filter((h) => h.sc >= 0);

  // Sobald es echte Treffer gibt, die lockeren Fuzzy-Treffer wegwerfen —
  // sonst steht hinter "PMI" plötzlich halb Frankreich.
  const best = Math.max(0, ...hits.map((h) => h.sc));
  if (best >= 500) hits = hits.filter((h) => h.sc >= 500);

  return hits
    .sort(
      (a, b) =>
        b.sc - a.sc ||
        Number(Boolean(iataOf(b.x))) - Number(Boolean(iataOf(a.x))) ||
        textOf(a.x).localeCompare(textOf(b.x))
    )
    .slice(0, limit)
    .map((h) => h.x);
}

function providerStations(providerId) {
  return STATIONS.filter((s) => s.provider === providerId);
}

function stationByCode(providerId, code) {
  return STATIONS.find((s) => s.provider === providerId && s.code === code);
}

/* =========================================================== Aufträge */

/** Datumsvarianten aus Verschiebungen × Mietdauern. */
function dateVariants() {
  const base = Math.max(1, daysBetween(state.pickupDate, state.returnDate));
  const durations = state.durations.length ? state.durations : [base];
  const shifts = state.dayShifts.length ? state.dayShifts : [0];
  const out = [];
  for (const shift of shifts) {
    for (const dur of durations) {
      const pickupDate = addDays(state.pickupDate, shift);
      out.push({ pickupDate, returnDate: addDays(pickupDate, dur), duration: dur });
    }
  }
  return out;
}

/** Länder-Modus: ein Anbieter × Stationen × Termine × Länderseiten. */
function jobsByMarket() {
  const provider = providerById(state.provider);
  if (!provider || !provider.build) return [];

  const markets = provider.markets.filter((m) => state.markets.includes(m.code));
  const stations = state.stations
    .map((c) => stationByCode(provider.id, c))
    .filter(Boolean);
  const ret = state.returnStation
    ? stationByCode(provider.id, state.returnStation)
    : null;

  const jobs = [];
  for (const station of stations) {
    for (const v of dateVariants()) {
      for (const market of markets) {
        const q = { ...state, pickupDate: v.pickupDate, returnDate: v.returnDate };
        jobs.push({
          provider,
          market,
          station,
          variant: v,
          groupKey: `${station.code}|${v.pickupDate}|${v.returnDate}`,
          groupLabel: station.name,
          itemLabel: market.label,
          itemSub: market.cur,
          ...provider.build(q, market, station, ret),
        });
      }
    }
  }
  return jobs;
}

/**
 * Anbieter-Modus: ein Ort × Termine × Anbieter.
 * Anbieter ohne Station am Ort liefern absichtlich keinen Link, sondern
 * einen sichtbaren Fehlanzeige-Eintrag.
 */
function jobsByProvider() {
  const place = PLACES.find((p) => p.id === state.placeId);
  if (!place) return [];

  const chosen = PROVIDERS.filter((p) => state.compare.includes(p.id));
  const jobs = [];

  for (const v of dateVariants()) {
    for (const { provider, station } of stationsAtPlace(place, chosen)) {
      const common = {
        provider,
        variant: v,
        place,
        groupKey: `${place.id}|${v.pickupDate}|${v.returnDate}`,
        groupLabel: place.label,
        itemLabel: provider.label,
      };

      if (!station || !provider.build) {
        jobs.push({
          ...common,
          station,
          url: null,
          missing: !station ? 'keine Station an diesem Ort' : 'noch nicht angebunden',
          fallback: provider.homepage || null,
        });
        continue;
      }

      // Heimatmarkt des Anbieters für den reinen Anbietervergleich.
      const market = provider.markets[0];
      const q = { ...state, pickupDate: v.pickupDate, returnDate: v.returnDate };
      jobs.push({
        ...common,
        station,
        market,
        itemSub: station.name,
        ...provider.build(q, market, station, null),
      });
    }
  }
  return jobs;
}

function buildJobs() {
  return state.mode === 'providers' ? jobsByProvider() : jobsByMarket();
}

/* =========================================================== DOM-Helfer */

const $ = (s) => document.querySelector(s);

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

/* =========================================================== Ansichten */

function showScreen(name) {
  $('#start').hidden = name !== 'start';
  $('#statusScreen').hidden = name !== 'status';
  $('#work').hidden = name !== 'work';
}

function applyTheme(provider) {
  const root = document.documentElement;
  if (provider && provider.theme) {
    root.style.setProperty('--accent', provider.theme.accent);
    root.style.setProperty('--accent-ink', provider.theme.ink);
    root.dataset.provider = provider.id;
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
    delete root.dataset.provider;
  }
}

function renderStatus() {
  $('#statusBody').replaceChildren(
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
                el(
                  'li',
                  { class: v ? 'yes' : 'no' },
                  (v ? '✓ ' : '✕ ') + CAP_LABEL[k]
                )
              )
            )
          : null,
        ...p.notes.map((n) => el('p', { class: 'note' }, n)),
        p.status === 'ready'
          ? el('p', { class: 'note' }, `${providerStations(p.id).length} Stationen hinterlegt.`)
          : el(
              'p',
              { class: 'note' },
              'Bis dahin: ',
              el('a', { href: p.homepage, target: '_blank', rel: 'noopener' }, p.homepage)
            )
      )
    )
  );
}

const CAP_LABEL = {
  station: 'Station wird übernommen',
  date: 'Datum wird übernommen',
  time: 'Uhrzeit wird übernommen',
  oneWay: 'Abweichende Rückgabestation',
  vehicleClass: 'Fahrzeugklasse (wird verworfen)',
  prepaid: 'Prepaid-Filter (wird verworfen)',
};

function renderProviderPick() {
  const box = $('#providerPick');
  const multi = state.mode === 'providers';

  box.replaceChildren(
    ...PROVIDERS.map((p) => {
      const on = multi ? state.compare.includes(p.id) : state.provider === p.id;
      const dead = p.status !== 'ready';
      return el(
        'button',
        {
          type: 'button',
          class: 'prov' + (on ? ' on' : '') + (dead ? ' dead' : ''),
          style: on ? `--pa:${p.theme.accent}` : `--pa:#8a8a8a`,
          title: dead ? p.notes[0] : `${providerStations(p.id).length} Stationen`,
          onclick: () => {
            if (multi) {
              const i = state.compare.indexOf(p.id);
              if (i >= 0) state.compare.splice(i, 1);
              else state.compare.push(p.id);
            } else {
              if (dead) return; // Länder-Modus braucht einen echten Adapter
              state.provider = p.id;
              state.stations = [];
              state.markets = p.markets.slice(0, 5).map((m) => m.code);
            }
            update();
          },
        },
        el('span', { class: 'pbar' }),
        el('span', { class: 'plabel' }, p.label),
        dead ? el('span', { class: 'ptag' }, 'offen') : null
      );
    })
  );

  const note = $('#providerNote');
  if (multi) {
    const ready = state.compare.filter(
      (id) => providerById(id)?.status === 'ready'
    ).length;
    note.textContent =
      ready < 2
        ? 'Ein echter Anbietervergleich braucht mindestens zwei angebundene Anbieter. Bisher ist nur Sixt angebunden — die übrigen erscheinen als Fehlanzeige.'
        : `${ready} Anbieter angebunden.`;
  } else {
    const p = providerById(state.provider);
    note.textContent = p ? p.notes[0] : '';
  }
}

function renderStationPicker() {
  const provider = providerById(state.provider);
  const all = providerStations(provider.id);
  const hits = rank(
    all,
    $('#stationSearch').value,
    (s) => `${s.name} ${s.country}`,
    (s) => s.iata,
    60
  );

  $('#stationCount').textContent =
    `${hits.length} von ${all.length} Stationen` +
    ($('#stationSearch').value.trim() ? '' : ' — tippen zum Filtern');

  $('#stationResults').replaceChildren(
    ...hits.map((s) => {
      const on = state.stations.includes(s.code);
      return el(
        'button',
        {
          type: 'button',
          class: 'station' + (on ? ' on' : ''),
          title: `${provider.label}-Stationscode ${s.code}`,
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

  $('#chosenStations').replaceChildren(
    ...state.stations
      .map((c) => stationByCode(provider.id, c))
      .filter(Boolean)
      .map((s) =>
        el(
          'span',
          { class: 'chip' },
          `${s.name} (${s.code})`,
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
    state.stations.length ? null : el('span', { class: 'empty' }, 'Noch keine Station gewählt.')
  );

  const sel = $('#returnStation');
  sel.replaceChildren(
    el('option', { value: '' }, '— gleiche wie Abholung —'),
    ...all
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) =>
        el('option', { value: s.code, selected: state.returnStation === s.code }, s.name)
      )
  );
}

function renderPlacePicker() {
  const hits = rank(
    PLACES,
    $('#placeSearch').value,
    (p) => `${p.label} ${p.country}`,
    (p) => p.iata,
    60
  );

  $('#placeResults').replaceChildren(
    ...hits.map((p) =>
      el(
        'button',
        {
          type: 'button',
          class: 'station' + (state.placeId === p.id ? ' on' : ''),
          onclick: () => {
            state.placeId = p.id;
            update();
          },
        },
        el('span', { class: 'flag' }, p.country),
        el('span', { class: 'sname' }, p.label),
        el('span', { class: 'cnt' }, `${p.providers.length} Anbieter`)
      )
    ),
    hits.length ? null : el('p', { class: 'empty' }, 'Kein Ort gefunden.')
  );

  const place = PLACES.find((p) => p.id === state.placeId);
  $('#placeDetail').replaceChildren(
    place
      ? el(
          'div',
          { class: 'field' },
          el('span', { class: 'flabel' }, 'Zuordnung'),
          el(
            'p',
            { class: 'note ' + (place.confidence === 'approx' ? 'warn' : '') },
            el('strong', {}, CONFIDENCE_LABEL[place.confidence].text),
            ' — ',
            CONFIDENCE_LABEL[place.confidence].hint
          ),
          el(
            'ul',
            { class: 'caps' },
            ...place.stations.map((s) =>
              el('li', { class: 'yes' }, `${providerById(s.provider).label}: ${s.name}`)
            )
          )
        )
      : el('p', { class: 'empty' }, 'Noch kein Ort gewählt.')
  );
}

function renderMarkets() {
  const provider = providerById(state.provider);
  $('#markets').replaceChildren(
    ...provider.markets.map((m) =>
      el(
        'label',
        { class: 'mk' + (state.markets.includes(m.code) ? ' on' : '') },
        el('input', {
          type: 'checkbox',
          checked: state.markets.includes(m.code),
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

function renderPills(sel, opts, list, label, onEmpty) {
  $(sel).replaceChildren(
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
            update();
          },
        }),
        label(n)
      )
    )
  );
}

function renderResults() {
  const jobs = buildJobs();
  const openable = jobs.filter((j) => j.url);

  $('#jobCount').textContent = openable.length;
  $('#openAll').disabled = !openable.length;
  $('#copyAll').disabled = !openable.length;
  $('#warn').hidden = openable.length <= 12;
  $('#warn').textContent =
    openable.length > 12
      ? `${openable.length} Tabs — der Browser drosselt das eventuell. Weniger Länder oder Datumsvarianten wählen, oder unten einzeln öffnen.`
      : '';

  if (!jobs.length) {
    $('#results').replaceChildren(
      el(
        'p',
        { class: 'empty' },
        state.mode === 'providers'
          ? 'Ort und mindestens einen Anbieter wählen.'
          : 'Station und mindestens eine Länderseite wählen.'
      )
    );
    return;
  }

  const groups = new Map();
  for (const j of jobs) {
    if (!groups.has(j.groupKey)) groups.set(j.groupKey, []);
    groups.get(j.groupKey).push(j);
  }

  $('#results').replaceChildren(
    ...[...groups.values()].map((list) => {
      const f = list[0];
      return el(
        'div',
        { class: 'group' },
        el(
          'h3',
          {},
          f.groupLabel,
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
            j.url
              ? el(
                  'a',
                  {
                    href: j.url,
                    target: '_blank',
                    rel: 'noopener',
                    class: 'lnk',
                    style: `--pa:${j.provider.theme.accent}`,
                  },
                  el('span', { class: 'pbar' }),
                  el('span', { class: 'mkname' }, j.itemLabel),
                  j.itemSub ? el('span', { class: 'cur' }, j.itemSub) : null
                )
              : el(
                  'span',
                  { class: 'lnk off' },
                  el('span', { class: 'mkname' }, j.itemLabel),
                  el('span', { class: 'cur' }, j.missing),
                  j.fallback
                    ? el(
                        'a',
                        { href: j.fallback, target: '_blank', rel: 'noopener', class: 'tiny' },
                        'Website'
                      )
                    : null
                )
          )
        )
      );
    })
  );
}

/* =========================================================== Aktionen */

async function openAll() {
  const jobs = buildJobs().filter((j) => j.url);
  const btn = $('#openAll');
  btn.disabled = true;
  let blocked = 0;

  for (let i = 0; i < jobs.length; i++) {
    if (!window.open(jobs[i].url, '_blank', 'noopener')) blocked++;
    btn.textContent = `Öffne ${i + 1}/${jobs.length} …`;
    await new Promise((r) => setTimeout(r, 260));
  }

  btn.textContent = 'Alle öffnen';
  btn.disabled = false;
  if (blocked) $('#popupHint').hidden = false;
}

function copyAll() {
  const text = buildJobs()
    .filter((j) => j.url)
    .map(
      (j) =>
        `${j.groupLabel} · ${j.itemLabel} · ${j.variant.pickupDate} → ${j.variant.returnDate}\n${j.url}`
    )
    .join('\n\n');
  navigator.clipboard.writeText(text).then(
    () => flash('Links kopiert.'),
    () => flash('Kopieren nicht möglich — Links unten markieren.')
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

/* =========================================================== Ablauf */

function enterMode(mode) {
  state.mode = mode;
  if (mode === 'status') {
    applyTheme(null);
    renderStatus();
    showScreen('status');
    persist();
    return;
  }
  showScreen('work');
  update();
}

function update() {
  persist();

  const isCompare = state.mode === 'providers';
  $('#workTitle').textContent = isCompare ? 'Anbieter-Vergleich' : 'Länder-Vergleich';
  $('#stationCard').hidden = isCompare;
  $('#placeCard').hidden = !isCompare;
  $('#marketCard').hidden = isCompare;

  applyTheme(isCompare ? null : providerById(state.provider));

  renderProviderPick();
  if (isCompare) renderPlacePicker();
  else {
    renderStationPicker();
    renderMarkets();
  }

  renderPills(
    '#shifts',
    [-3, -2, -1, 0, 1, 2, 3],
    () => state.dayShifts,
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

  renderResults();
}

function init() {
  document.querySelectorAll('.mode').forEach((b) =>
    b.addEventListener('click', () => enterMode(b.dataset.mode))
  );
  document.querySelectorAll('.back').forEach((b) =>
    b.addEventListener('click', () => {
      state.mode = null;
      applyTheme(null);
      persist();
      showScreen('start');
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
  $('#placeSearch').addEventListener('input', renderPlacePicker);
  $('#returnStation').addEventListener('change', (e) => {
    state.returnStation = e.target.value || null;
    update();
  });

  $('#openAll').addEventListener('click', openAll);
  $('#copyAll').addEventListener('click', copyAll);
  $('#marketsAll').addEventListener('click', () => {
    state.markets = providerById(state.provider).markets.map((m) => m.code);
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
    localStorage.removeItem(LS_KEY);
    location.reload();
  });

  $('#cmpTag').textContent =
    READY_PROVIDERS.length > 1
      ? `${READY_PROVIDERS.length} Anbieter angebunden`
      : 'nur Sixt angebunden';

  if (state.mode) enterMode(state.mode);
  else showScreen('start');
}

document.addEventListener('DOMContentLoaded', init);
