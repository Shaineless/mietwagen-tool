/**
 * Fahrzeugklassen ueber Laendergrenzen hinweg zuordnen, ueber den ACRISS-Code.
 *
 * Sixt liefert ihn frei Haus: jede Angebotskachel traegt
 * data-offer-id="CDAR-110-110", die ersten vier Zeichen sind der ACRISS-Code.
 * Der ist per Definition sprachunabhaengig und damit die verlaessliche
 * Vergleichsachse:
 *
 *   GWAR = Oberklasse Elite · Kombi · Automatik · mit Klima
 *          -> "Oberklasse Elite Kombi Automatik" (DE)
 *          -> "Fullsize Elite Wagon Automatic"   (EN)
 *          -> "Fullsize Elite Familiar Automático" (ES)
 *
 * Die Dekodierung unten ergibt exakt Sixts eigene Beschriftung, geprueft
 * gegen sixt.de, .co.uk, .es und .it.
 *
 * Nur falls ein Angebot einmal keinen Code traegt, greift ganz unten ein
 * Notnagel ueber den Kategorietext.
 */

/* Zeichen 1. Klasse. Reihenfolge = Anzeigereihenfolge, klein nach gross. */
const KLASSE = {
  M: ['Mini', 0],
  N: ['Mini Elite', 1],
  E: ['Kleinwagen', 2],
  H: ['Kleinwagen Elite', 3],
  C: ['Kompaktklasse', 4],
  D: ['Kompaktklasse Elite', 5],
  I: ['Mittelklasse', 6],
  J: ['Mittelklasse Elite', 7],
  S: ['Standard', 8],
  R: ['Standard Elite', 9],
  F: ['Oberklasse', 10],
  G: ['Oberklasse Elite', 11],
  P: ['Premium', 12],
  U: ['Premium Elite', 13],
  L: ['Luxusklasse', 14],
  W: ['Luxusklasse Elite', 15],
  O: ['Übergröße', 16],
  X: ['Special', 17],
};

/* Zeichen 2. Karosserie. */
const KAROSSERIE = {
  B: ['2–3-türig', 0],
  C: ['2/4-türig', 1],
  D: ['Limousine', 2],
  W: ['Kombi', 3],
  V: ['Van', 4],
  // ACRISS meint mit L die Stretch-Limousine; Sixt beschriftet L als
  // "Gran Coupé" (BMW M440 Gran Coupé = GLSR). Wir folgen Sixt.
  L: ['Gran Coupé', 5],
  S: ['Sport', 6],
  T: ['Cabrio', 7],
  F: ['SUV', 8],
  J: ['Geländewagen offen', 9],
  X: ['Special', 10],
  P: ['Pick-up', 11],
  Q: ['Pick-up Doppelkabine', 12],
  Z: ['Sonderangebot', 13],
  E: ['Coupé', 14],
  M: ['Monospace', 15],
  R: ['Wohnmobil', 16],
  H: ['Reisemobil', 17],
  Y: ['Zweirad', 18],
  N: ['Roadster', 19],
  G: ['Crossover', 20],
  K: ['Transporter', 21],
};

/*
 * Zeichen 3. Getriebe und Antrieb.
 *
 * S und L stehen nicht im ACRISS-Standard, Sixt benutzt sie trotzdem: bei den
 * AMG-, M- und Porsche-Modellen (DDSR, WFLP, GELP). Beide bedeuten dort
 * Automatik, abgeglichen mit Sixts eigener Beschriftung.
 */
const GETRIEBE = {
  M: ['Schaltung', 'Schaltung'],
  N: ['Schaltung 4x4', 'Schaltung'],
  C: ['Schaltung Allrad', 'Schaltung'],
  A: ['Automatik', 'Automatik'],
  B: ['Automatik 4x4', 'Automatik'],
  D: ['Automatik Allrad', 'Automatik'],
  S: ['Automatik', 'Automatik'],
  L: ['Automatik', 'Automatik'],
};

/* Zeichen 4. Kraftstoff und Klimaanlage. */
const ANTRIEB = {
  R: ['', true],
  N: ['', false],
  D: ['Diesel', true],
  Q: ['Diesel', false],
  H: ['Hybrid', true],
  I: ['Plug-in-Hybrid', true],
  E: ['Elektrisch', true],
  C: ['Elektrisch', true],
  L: ['Autogas', true],
  S: ['Autogas', false],
  A: ['Wasserstoff', true],
  B: ['Wasserstoff', false],
  M: ['Mehrstoff', true],
  F: ['Mehrstoff', false],
  V: ['Benzin', true],
  Z: ['Benzin', false],
  U: ['Ethanol', true],
  X: ['Ethanol', false],
  // Nicht im Standard, kommt bei Sixts Sportwagen vor (WFLP, GELP, GTLP).
  P: ['', true],
};

/**
 * ACRISS-Code aufschluesseln.
 * @returns {null|{acriss:string, label:string, klasse:string, karosserie:string,
 *                 getriebe:string, antrieb:string, klima:boolean, ordnung:number}}
 */
export function decodeAcriss(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(c)) return null;

  const k = KLASSE[c[0]];
  const b = KAROSSERIE[c[1]];
  const g = GETRIEBE[c[2]];
  const a = ANTRIEB[c[3]];

  // Bewusst nachsichtig: Klasse und Karosserie genuegen. Unbekannte Zeichen an
  // Stelle 3 oder 4 lassen den Code trotzdem durch. Sixt fuehrt eigene
  // Buchstaben ein, und ein halb erkannter Code ist deutlich brauchbarer als
  // ein Rueckfall auf den uebersetzten Rohtext, der die Zeile spaltet.
  if (!k || !b) return null;

  return {
    acriss: c,
    klasse: k[0],
    karosserie: b[0],
    getriebe: g ? g[0] : '',
    unbekannt: !g,
    antrieb: a ? a[0] : '',
    klima: a ? a[1] : true,
    label: [k[0], b[0], g ? g[0] : null, a && a[0] ? a[0] : null].filter(Boolean).join(' · '),
    // Klasse schlaegt Karosserie schlaegt Getriebe.
    ordnung: k[1] * 1000 + b[1] * 10 + (g && g[0].startsWith('Automatik') ? 1 : 0),
  };
}

/* ------------------------------------------------------------- Notnagel */

/**
 * Ohne ACRISS-Code bleibt nur der Kategorietext. Der ist sprachabhaengig,
 * deshalb bekommt so ein Angebot einen eigenen Schluessel und steht als
 * separate Zeile, sichtbar unvollstaendig statt still falsch zusammen-
 * geworfen.
 */
function rohSchluessel(offer) {
  const text = (offer?.category || '').trim();
  return {
    key: 'roh:' + text.toLowerCase(),
    acriss: null,
    label: text || '(ohne Angabe)',
    ordnung: 99000,
    exakt: false,
  };
}

/** Ein Angebot in eine vergleichbare Klasse uebersetzen. */
export function classify(offer) {
  const d = decodeAcriss(offer?.acriss);
  if (!d) return rohSchluessel(offer);
  return { key: d.acriss, ...d, exakt: true };
}

export function classOrder(key) {
  const d = decodeAcriss(key);
  return d ? d.ordnung : 99000;
}
