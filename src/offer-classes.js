/**
 * Fahrzeugklassen ueber Laendergrenzen hinweg zuordnen.
 *
 * Das ist der Kern des Vergleichs. Sixt beschreibt jedes Angebot nach demselben
 * Muster — Groesse, Karosserie, Getriebe — aber in der Sprache der jeweiligen
 * Laenderseite:
 *
 *   DE  Kompaktklasse Kombi Automatik
 *   EN  Compact Wagon Automatic
 *   ES  Compacto Familiar Automático
 *   IT  Compatta Station wagon Automatico
 *
 * Alles dieselbe Klasse. Ueber die Modellnamen ginge es nicht: aus
 * "VW GOLF VARIANT" wird auf der britischen Seite "VW GOLF ESTATE", aus
 * "BMW 3ER TOURING" wird "BMW SERIE 3 TOURING".
 *
 * Die Vokabeln stammen aus echten Abrufen gegen sixt.de, .co.uk, .es und .it.
 * Fehlt eine Sprache, faellt der Eintrag auf den Rohtext zurueck und bildet
 * eine eigene Zeile — sichtbar unvollstaendig statt still falsch zusammen-
 * geworfen.
 */

/** Reihenfolge = Anzeigereihenfolge, klein nach gross. */
const GROESSEN = [
  ['mini', 'Kleinstwagen', ['mini', 'kleinstwagen']],
  ['economy', 'Kleinwagen', ['economy', 'economico', 'económico', 'kleinwagen', 'ökonomisch']],
  ['compact', 'Kompaktklasse', ['compact', 'compacto', 'compatta', 'kompaktklasse', 'kompakt']],
  ['midsize', 'Mittelklasse', ['midsize', 'mittelklasse', 'intermediate', 'mediano', 'medio', 'media']],
  ['fullsize', 'Oberklasse', ['fullsize', 'oberklasse', 'grande', 'full size']],
  ['premium', 'Premium', ['premium']],
  ['luxury', 'Luxusklasse', ['luxury', 'luxusklasse', 'lujo', 'lusso']],
  ['special', 'Special', ['special', 'spezial', 'especial', 'speciale']],
];

const KAROSSERIEN = [
  ['sedan', 'Limousine', ['sedan', 'limousine', 'berlina', 'berline', 'saloon']],
  ['suv', 'SUV', ['suv']],
  ['wagon', 'Kombi', ['kombi', 'wagon', 'estate', 'familiar', 'station wagon', 'break', 'touring', 'giardinetta']],
  ['convertible', 'Cabrio', ['cabrio', 'convertible', 'cabriolet', 'descapotable']],
  ['coupe', 'Coupé', ['coupe', 'coupé']],
  ['van', 'Van', ['van', 'minivan', 'monovolumen', 'monospace', 'transporter', 'people carrier']],
  ['pickup', 'Pick-up', ['pickup', 'pick-up', 'pick up']],
  ['truck', 'LKW', ['truck', 'lkw', 'lorry', 'camion']],
  // Sixt verkauft auch "Ueberraschungsfahrzeuge" — das Modell steht erst bei
  // der Abholung fest. Eigene Karosserieklasse, sonst landen sie als Rohtext
  // in einer Extrazeile.
  ['mystery', 'Glücksauto', ['glucksauto', 'glücksauto', 'lucky car', 'mystery car', 'coche sorpresa', 'auto a sorpresa']],
];

const GETRIEBE = [
  ['automatic', 'Automatik', ['automatik', 'automatic', 'automático', 'automatico', 'automatique', 'automaat']],
  ['manual', 'Schaltung', ['manuell', 'manual', 'manuale', 'manuelle', 'schaltgetriebe', 'handgeschakeld']],
];

const ELITE = ['elite'];

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

/** Ersten passenden Eintrag einer Tabelle im Text finden. */
function treffer(tabelle, text) {
  const t = fold(text);
  for (const [code, label, worte] of tabelle) {
    for (const w of worte) {
      const f = fold(w);
      // Wortgrenzen, damit "van" nicht in "Caravan" anschlägt.
      if (new RegExp(`(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)) {
        return { code, label };
      }
    }
  }
  return null;
}

/**
 * Ein Angebot in eine sprachunabhaengige Klasse uebersetzen.
 *
 * @returns {{key:string, label:string, groesse:string, karosserie:string,
 *            getriebe:string, elite:boolean, exakt:boolean}}
 */
export function classify(offer) {
  const cat = offer?.category || '';
  const g = treffer(GROESSEN, cat);
  const k = treffer(KAROSSERIEN, cat);
  const a = treffer(GETRIEBE, cat);
  const elite = ELITE.some((e) => fold(cat).includes(e));

  // Nur wenn alle drei Bestandteile erkannt wurden, ist die Zuordnung
  // belastbar. Sonst bekommt der Eintrag einen eigenen Schluessel aus dem
  // Rohtext und steht als separate Zeile da.
  const exakt = Boolean(g && k && a);

  if (!exakt) {
    return {
      key: 'roh:' + fold(cat),
      label: cat || '(ohne Angabe)',
      groesse: g?.label || '',
      karosserie: k?.label || '',
      getriebe: a?.label || '',
      elite,
      exakt: false,
    };
  }

  return {
    key: [g.code, k.code, elite ? 'elite' : '-', a.code].join('|'),
    label: [g.label, elite ? 'Elite' : null, k.label, a.label].filter(Boolean).join(' · '),
    groesse: g.label,
    karosserie: k.label,
    getriebe: a.label,
    elite,
    exakt: true,
  };
}

/** Sortiergewicht: klein nach gross, damit die Tabelle einer Logik folgt. */
export function classOrder(key) {
  const [g, k, e] = String(key).split('|');
  const gi = GROESSEN.findIndex(([c]) => c === g);
  const ki = KAROSSERIEN.findIndex(([c]) => c === k);
  return (gi < 0 ? 99 : gi) * 100 + (ki < 0 ? 99 : ki) * 2 + (e === 'elite' ? 1 : 0);
}
