/**
 * Ortsebene, das Bindeglied fuer den Anbietervergleich.
 *
 * Das Problem: Autovermieter haben nicht dieselben Stationen. Sixt sitzt am
 * Flughafen im Parkhaus P4, Europcar im Terminal, Enterprise 3 km weiter im
 * Gewerbegebiet. Ein Vergleich "Sixt gegen Europcar" braucht also einen
 * gemeinsamen Bezugspunkt, der ueber den einzelnen Stationen liegt.
 *
 * Dieser Bezugspunkt ist der ORT (place). Jede Anbieterstation wird einem Ort
 * zugeordnet; der Vergleich laeuft dann Ort gegen Ort.
 *
 * Zuordnung, in absteigender Verlaesslichkeit:
 *
 *   1. manuelle Zuordnung   (data/places.overrides.txt), schlaegt alles
 *   2. IATA-Code. Flughaefen, anbieteruebergreifend eindeutig
 *   3. Stadt + Stationsart, "Muenchen"+"Hauptbahnhof", nur ungefaehr
 *
 * Wichtig: die Verlaesslichkeit wird mitgefuehrt und angezeigt. Ein Vergleich
 * zwischen "Flughafen-Schalter" und "Stadtbuero 8 km entfernt" ist kein
 * ehrlicher Preisvergleich, und das Tool soll das nicht verschweigen.
 */

/** Umlaute/Akzente vereinheitlichen und Fuellzeichen entfernen. */
export function fold(s) {
  return (s || '')
    .toLowerCase()
    .replaceAll('ä', 'a')
    .replaceAll('ö', 'o')
    .replaceAll('ü', 'u')
    .replaceAll('ß', 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Stationsart aus dem Namen ableiten. Diese Grobklassen genuegen, um
 * "Flughafen" nicht versehentlich mit "Innenstadt" zu verheiraten.
 */
export function kindOf(name) {
  const n = fold(name);
  if (/privatflughafen|\bgat\b/.test(n)) return 'gat';
  if (/flughafen|airport|aeropuerto|aeroport|aeroporto/.test(n)) return 'airport';
  if (/hauptbahnhof|bahnhof|hbf|station|gare|termini|bhf/.test(n)) return 'rail';
  if (/hafen|cruise|port/.test(n)) return 'port';
  if (/hotel|hilton|marriott|melia|tivoli|waldorf/.test(n)) return 'hotel';
  return 'city';
}

const KIND_LABEL = {
  airport: 'Flughafen',
  gat: 'Privatflughafen',
  rail: 'Bahnhof',
  port: 'Hafen',
  hotel: 'Hotel',
  city: 'Stadt',
};

/** Fuellwoerter, die keinen Ort bezeichnen. */
const STOP = new Set([
  'flughafen', 'airport', 'aeropuerto', 'aeroport', 'aeroporto',
  'hauptbahnhof', 'bahnhof', 'hbf', 'bhf', 'station', 'gare', 'termini',
  'zentrum', 'city', 'centro', 'centre', 'downtown', 'innenstadt',
  'privatflughafen', 'gat', 'hafen', 'cruise', 'port', 'terminal',
  'nord', 'sud', 'ost', 'west', 'north', 'south', 'east', 'nahe', 'am', 'an',
  'der', 'die', 'das', 'de', 'du', 'la', 'le', 'el', 'und', 'and',
]);

/**
 * Stadtkern aus dem Stationsnamen ziehen: das erste bedeutungstragende Wort.
 * "München Flughafen (MUC)" -> "munchen", "Rom Termini Bahnhof" -> "rom"
 */
export function cityOf(name) {
  const words = fold(name)
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
  return words[0] || fold(name).slice(0, 12);
}

/**
 * Baut die Ortsliste aus allen Anbieterstationen.
 *
 * @param {Array} stations  alle Stationen, jede mit {provider, code, country, iata, name}
 * @param {Map}   overrides code-Schluessel -> Orts-ID (manuelle Zuordnung)
 */
export function buildPlaces(stations, overrides = new Map()) {
  const places = new Map();

  for (const st of stations) {
    const kind = kindOf(st.name);
    const manual = overrides.get(`${st.provider}:${st.code}`);

    let id, confidence, label;

    if (manual) {
      id = manual;
      confidence = 'manual';
      label = manual;
    } else if (st.iata && (kind === 'airport' || kind === 'gat')) {
      // Flughaefen sind der verlaessliche Fall: der IATA-Code ist bei allen
      // Anbietern derselbe.
      id = `air:${st.iata}`;
      confidence = 'exact';
      label = `${cap(cityOf(st.name))} ${KIND_LABEL[kind]} (${st.iata})`;
    } else {
      // Alles andere nur ungefaehr: gleiche Stadt, gleiche Stationsart.
      const city = cityOf(st.name);
      id = `loc:${st.country}:${city}:${kind}`;
      confidence = 'approx';
      label = `${cap(city)} · ${KIND_LABEL[kind]}`;
    }

    if (!places.has(id)) {
      places.set(id, {
        id,
        label,
        country: st.country,
        kind,
        iata: st.iata || null,
        confidence,
        stations: [],
      });
    }
    const place = places.get(id);
    place.stations.push(st);
    // Sobald ein Ort Stationen mehrerer Anbieter buendelt, ist er fuer den
    // Anbietervergleich brauchbar.
    place.providers = [...new Set(place.stations.map((s) => s.provider))];
  }

  return [...places.values()].sort((a, b) => {
    // Orte mit mehreren Anbietern zuerst, sie sind der eigentliche Zweck.
    const d = (b.providers.length || 1) - (a.providers.length || 1);
    return d || a.label.localeCompare(b.label);
  });
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export const CONFIDENCE_LABEL = {
  manual: { text: 'zugeordnet', hint: 'Von Hand zugeordnet.' },
  exact: {
    text: 'gleicher Flughafen',
    hint: 'Über den IATA-Code eindeutig, dieselbe Anlage bei allen Anbietern.',
  },
  approx: {
    text: 'ungefähr',
    hint:
      'Nur über Ortsname und Stationsart zugeordnet. Die Stationen können ' +
      'mehrere Kilometer auseinanderliegen. Preise sind nicht 1:1 vergleichbar.',
  },
};

/**
 * Fuer einen Ort die Stationen je Anbieter heraussuchen.
 * Anbieter ohne Station am Ort erscheinen bewusst mit `station: null`,
 * damit die Oberflaeche "keine Station" anzeigen kann statt sie zu verschweigen.
 */
export function stationsAtPlace(place, providers) {
  return providers.map((p) => ({
    provider: p,
    station: place.stations.find((s) => s.provider === p.id) || null,
  }));
}
