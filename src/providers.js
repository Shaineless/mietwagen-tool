/**
 * Anbieter-Register.
 *
 * Jeder Anbieter beschreibt drei Dinge:
 *   1. welche Laenderseiten es gibt      -> markets
 *   2. wie aus einer Anfrage ein Aufruf wird -> build()
 *   3. was davon nachweislich funktioniert   -> status / capabilities
 *
 * Punkt 3 ist bewusst Teil der Datenstruktur. Das Vorgaengertool bot
 * Bedienelemente an, die Sixt inzwischen ignoriert (Fahrzeugklasse, Prepaid),
 * die Oberflaeche soll so etwas gar nicht erst als funktionierend darstellen.
 *
 * Transportarten:
 *   method: 'GET'  -> { url }
 *   method: 'POST' -> { url, fields } ... wird als Auto-Submit-Formular geoeffnet
 */

/* ============================================================ Sixt */

const SIXT_MARKETS = [
  { code: 'de', host: 'www.sixt.de', label: 'Deutschland', cur: 'EUR' },
  { code: 'at', host: 'www.sixt.at', label: 'Österreich', cur: 'EUR' },
  { code: 'ch', host: 'www.sixt.ch', label: 'Schweiz', cur: 'CHF' },
  { code: 'nl', host: 'www.sixt.nl', label: 'Niederlande', cur: 'EUR' },
  { code: 'be', host: 'www.sixt.be', label: 'Belgien', cur: 'EUR' },
  // Luxemburg ist bewusst nicht dabei: sixt.lu zeigt auf Sixts eigenen
  // Domain-Parkplatz (rproxy-domainparking.ingress.classic.sixt.cloud), das
  // Zertifikat passt nicht einmal zum Namen. Dort laeuft keine Laenderseite,
  // und eine tote Auswahlmoeglichkeit anzubieten waere schlechter als keine.
  { code: 'fr', host: 'www.sixt.fr', label: 'Frankreich', cur: 'EUR' },
  { code: 'es', host: 'www.sixt.es', label: 'Spanien', cur: 'EUR' },
  { code: 'it', host: 'www.sixt.it', label: 'Italien', cur: 'EUR' },
  { code: 'pt', host: 'www.sixt.pt', label: 'Portugal', cur: 'EUR' },
  { code: 'uk', host: 'www.sixt.co.uk', label: 'Großbritannien', cur: 'GBP' },
  { code: 'ie', host: 'www.sixt.ie', label: 'Irland', cur: 'EUR' },
  { code: 'dk', host: 'www.sixt.dk', label: 'Dänemark', cur: 'DKK' },
  { code: 'se', host: 'www.sixt.se', label: 'Schweden', cur: 'SEK' },
  { code: 'no', host: 'www.sixt.no', label: 'Norwegen', cur: 'NOK' },
  { code: 'fi', host: 'www.sixt.fi', label: 'Finnland', cur: 'EUR' },
  { code: 'pl', host: 'www.sixt.pl', label: 'Polen', cur: 'PLN' },
  // Gemessen am 02.09.2026: vier von vier Abrufen scheiterten mit "Station
  // wurde nicht uebernommen", die Seite nimmt eine deutsche Station gar
  // nicht erst an. Sie bleibt sichtbar, aber abgeschaltet: heimlich zu
  // loeschen wuerde nur die Frage aufwerfen, wo Tschechien geblieben ist.
  {
    code: 'cz',
    host: 'www.sixt.cz',
    label: 'Tschechien',
    cur: 'CZK',
    gestoert: 'Nimmt derzeit keine deutschen Stationen an (4 von 4 Abrufen ohne Ergebnis).',
  },
  { code: 'hu', host: 'www.sixt.hu', label: 'Ungarn', cur: 'HUF' },
  { code: 'hr', host: 'www.sixt.hr', label: 'Kroatien', cur: 'EUR' },
  { code: 'gr', host: 'www.sixt.gr', label: 'Griechenland', cur: 'EUR' },
  {
    code: 'tr',
    host: 'www.sixt.com.tr',
    label: 'Türkei',
    cur: 'TRY',
    gestoert: 'Nimmt derzeit keine deutschen Stationen an (4 von 4 Abrufen ohne Ergebnis).',
  },

  // Nachgetragen, nachdem ein echter Abruf sie bestätigt hat: alle sieben
  // nehmen unsere Suchparameter an und liefern eine vollständige Trefferliste
  // für eine deutsche Station (geprüft mit Frankfurt Flughafen, je 66
  // Angebote). Die Währungen stammen aus dem Kacheltext, nicht aus dem
  // Länderkürzel, "A$" und "R$" hätte ein Dollarzeichen sonst zu US-Dollar
  // gemacht.
  { code: 'si', host: 'www.sixt.si', label: 'Slowenien', cur: 'EUR' },
  { code: 'ee', host: 'www.sixt.ee', label: 'Estland', cur: 'EUR' },
  { code: 'lv', host: 'www.sixt.lv', label: 'Lettland', cur: 'EUR' },
  { code: 'lt', host: 'www.sixt.lt', label: 'Litauen', cur: 'EUR' },
  { code: 'is', host: 'www.sixt.is', label: 'Island', cur: 'ISK' },
  { code: 'au', host: 'www.sixt.com.au', label: 'Australien', cur: 'AUD' },
  { code: 'br', host: 'www.sixt.com.br', label: 'Brasilien', cur: 'BRL' },

  { code: 'com', host: 'www.sixt.com', label: 'International (.com)', cur: 'EUR' },
];

/**
 * Geprueft und bewusst NICHT aufgenommen.
 *
 * Alle diese Domains gehoeren Sixt und antworten, liefern fuer eine deutsche
 * Station aber keine Trefferliste, die Seite laeuft durch, die Liste bleibt
 * leer. Vermutlich bedienen sie nur ihre eigene Region. Sie hier zu fuehren
 * hiesse, dem Nutzer eine Spalte anzubieten, die immer leer bleibt.
 *
 *   sixt.ro, sixt.rs, sixt.ma, sixt.ae, sixt.jp, sixt.ca   Seite laeuft, keine Angebote
 *   ua.sixt.ua                                             Station wird nicht uebernommen
 *   sixt.lu, sixt.bg, sixt.sk, sixt.cy,
 *   sixt.co.za, sixt.co.nz, sixt.mx                        geparkt (Zertifikat passt nicht)
 *   sixt.mt, sixt.sa                                       kein DNS-Eintrag
 *
 * Nachpruefen mit: node tools/try-laender.mjs www.sixt.ro …
 */

/**
 * Farbthemen zur Orientierung, angelehnt an die Hausfarben der Vermieter,
 * damit beim Umschalten sofort klar ist, wessen Suche gerade gebaut wird.
 * Bewusst nur Akzentfarben: keine Logos, keine Nachbildung der Originalseiten.
 */
const THEMES = {
  sixt: { accent: '#ff5f00', ink: '#ffffff' },
  avis: { accent: '#d4002a', ink: '#ffffff' },
  europcar: { accent: '#7ab800', ink: '#0d2b00' },
  hertz: { accent: '#ffd100', ink: '#1a1a00' },
  enterprise: { accent: '#00693c', ink: '#ffffff' },
  carvia: { accent: '#2f6fed', ink: '#ffffff' },
  arndt: { accent: '#1f5f8b', ink: '#ffffff' },
};

const sixt = {
  id: 'sixt',
  label: 'Sixt',
  status: 'ready',
  method: 'GET',
  theme: THEMES.sixt,
  markets: SIXT_MARKETS,
  landing: 'form', // Suchmaske vorbelegt, ein Klick auf "Suche" fehlt noch
  capabilities: {
    // Nachweislich ausgewertet (gegen die Live-Seite geprueft, 09/2026):
    station: true,
    date: true,
    time: true,
    oneWay: true,
    // Nachweislich NICHT mehr ausgewertet, die Parameter werden verworfen:
    vehicleClass: false,
    prepaid: false,
  },
  notes: [
    'Datum muss als yyyymmdd übergeben werden. Das vom Original-Tool benutzte ' +
      'dd-mm-yyyy wird stillschweigend ignoriert.',
    'Die Parameter grp (Fahrzeugklasse) und prpd (Prepaid) werden von Sixt ' +
      'heute verworfen, geprüft: die Trefferliste startet mit leerem Filter.',
    'Ein Direktsprung in die Trefferliste ist nicht möglich; Sixt adressiert ' +
      'Stationen dort über eine UUID, die sich aus der Stations-ID nicht ' +
      'ableiten lässt. Der Link belegt daher die Suchmaske vor, beim ' +
      'Preisabruf drückt das Werkzeug den Suchknopf selbst.',
  ],

  build(q, market, station, returnStation) {
    const p = new URLSearchParams();
    p.set('uci', String(station.code));
    p.set('rci', String((returnStation || station).code));
    p.set('uda', q.pickupDate.replaceAll('-', ''));
    p.set('rda', q.returnDate.replaceAll('-', ''));
    p.set('uti', q.pickupTime.replace(':', ''));
    p.set('rti', q.returnTime.replace(':', ''));
    p.set('ctyp', 'P');
    return { url: `https://${market.host}/?${p.toString()}` };
  },
};

/* ============================================================ Geplant */

/**
 * Anbieter, deren Link-Format noch nicht aus einer echten Suche abgeleitet
 * wurde. Sie erscheinen in der Oberflaeche, liefern aber bewusst keinen
 * konstruierten Link, ein geratener Link waere schlechter als gar keiner.
 *
 * `homepage` dient als ehrlicher Notausgang: Suche dort von Hand.
 */
function planned(id, label, homepage, why) {
  return {
    id,
    label,
    status: 'planned',
    method: 'GET',
    // Auch geplante Anbieter brauchen ein Thema: die Oberfläche färbt jede
    // Zeile nach Anbieter ein, auch die Fehlanzeigen.
    theme: THEMES[id] || { accent: '#8a8a8a', ink: '#ffffff' },
    markets: [],
    homepage,
    capabilities: {},
    notes: [why],
    build: null,
  };
}

const avis = planned(
  'avis',
  'Avis',
  'https://www.avis.de/',
  'Sendet die Suche per POST an secure.avis.de. Die Feldnamen sind bekannt ' +
    '(hire-location, return-location, pickupDateTime, returnDateTime, awdcode), ' +
    'das erwartete Datumsformat noch nicht.'
);

const europcar = planned(
  'europcar',
  'Europcar',
  'https://www.europcar.de/',
  'Suchmaske ist vollständig JS-gesteuert, kein GET-Formular. Das Link-Format ' +
    'muss aus einer echten Suche abgeleitet werden.'
);

const hertz = planned('hertz', 'Hertz', 'https://www.hertz.de/', 'Noch nicht untersucht.');
const enterprise = planned(
  'enterprise',
  'Enterprise',
  'https://www.enterprise.de/',
  'Noch nicht untersucht.'
);
const carvia = planned('carvia', 'Carvia', 'https://www.carvia.de/', 'Noch nicht untersucht.');
const arndt = planned(
  'arndt',
  'Arndt',
  'https://www.arndt-autovermietung.de/',
  'Noch nicht untersucht.'
);

/* ============================================================ Stand */

/**
 * Was das Werkzeug heute kann, und was bewusst nicht.
 *
 * Diese Liste steht hier und nicht in der Oberflaeche, weil sie derselben
 * Regel folgt wie `capabilities` oben: nichts wird als koennend dargestellt,
 * was nicht geprueft ist. `stand` ist 'ja', 'nein' oder 'teils'; bei 'nein'
 * gehoert in den Text, ob es fehlt oder absichtlich fehlt.
 */
export const WERKZEUG_STAND = [
  {
    gruppe: 'Preise',
    punkte: [
      ['ja', 'Preise je Länderseite auslesen',
        'Läuft in einem eigenen, unsichtbaren Chrome-Fenster auf diesem Rechner. Zwei bis sechs Abfragen gleichzeitig, selbstregelnd: es misst den eigenen Durchsatz und geht zurück, sobald es langsamer wird.'],
      ['ja', 'Schutzpakete mit echtem Endpreis',
        'Jedes Paket wird in der Kasse angeklickt und die Gesamtsumme abgelesen. Der Tagespreis mal Tage zu rechnen ergab bis zu 26 % daneben.'],
      ['ja', 'Aus dem Vergleich heraus buchen',
        'Nach dem Schutzabruf bleiben die Kassenseiten offen. Ein Klick auf einen Preis wählt dort dasselbe Paket und holt das Fenster nach vorn, gemessen unter einer Sekunde. Der Preis wird dabei gegengeprüft.'],
      ['ja', 'Uhrzeiten getrennt vergleichen',
        'Abhol- und Rückgabezeit einzeln, beliebig viele Paare je Suche. Gemessen lagen 12:30 und 13:30 am selben Tag 57 % auseinander, das schlägt härter durch als die Länderseite.'],
      ['ja', 'Frühbucherrabatt erkennen',
        'Wird je Länderseite angezeigt, er läuft nicht überall gleichzeitig, und das verzerrt den Vergleich.'],
      ['nein', 'Währungen umrechnen',
        'Absichtlich nicht: verglichen wird nur innerhalb derselben Währung. Ein Kurs von heute wäre eine erfundene Genauigkeit.'],
      ['nein', 'Statusrabatt (Gold, Platin, Diamond)',
        'Wieder entfernt, gezeigt werden nur Preise, die tatsächlich von der Seite abgelesen wurden.'],
    ],
  },
  {
    gruppe: 'Vergleich',
    punkte: [
      ['ja', 'ACRISS-Code als Schlüssel',
        'Die Klassen heißen auf jeder Länderseite anders; der Vier-Buchstaben-Code ist sprachunabhängig. Sixt benutzt dabei eigene Buchstaben (S, L, P), die der Decoder mitträgt.'],
      ['ja', 'Fahrzeugbilder und Modellnamen', 'Direkt aus der Angebotskachel.'],
      ['ja', 'Mehrere Stationen und Termine',
        'Datums-Matrix: Abholtag −5 bis +5 Tage, dazu mehrere Mietdauern. Station und Termin sind oben umschaltbar.'],
      ['ja', 'Klassen merken, die gerade nicht buchbar sind',
        'Einmal gesehene Klassen bleiben als Zeile stehen und werden als „nicht buchbar" markiert, statt aus der Tabelle zu verschwinden.'],
      ['ja', 'Stationen gegenübergestellt',
        'Paarweise über die Klassen, die es an allen Stationen gibt, nicht als Durchschnitt. Gemessen lagen zwei Stationen derselben Stadt 49 % auseinander.'],
    ],
  },
  {
    gruppe: 'Über die Zeit',
    punkte: [
      ['ja', 'Preiskalender',
        'Jeder Abholtag einzeln gerechnet, bis zu 56 Tage am Stück, Mietdauer bis 90 Tage. Gemessen: 313,96 € am günstigsten gegen 1.130,98 € am teuersten Tag.'],
      ['ja', 'Preisentwicklung',
        'Jeder Abruf ist ein Messpunkt. Getrennte Linien je Länderseite, Abrufmodus und Uhrzeit, damit ein Wechsel nicht wie eine Preisänderung aussieht.'],
      ['ja', 'Preiswecker im Hintergrund',
        'Auf Wunsch trägt sich eine tägliche Aufgabe in die Windows-Aufgabenplanung ein und prüft, auch wenn TRACKER zu ist. Voreinstellung aus, der Befehl steht im Klartext daneben.'],
    ],
  },
  {
    gruppe: 'Betrieb',
    punkte: [
      ['ja', 'Abbrechen', 'Die Warteschlange lässt sich mitten im Abruf anhalten.'],
      ['ja', 'Alles bleibt auf diesem Rechner',
        'Der Dienst hört nur auf 127.0.0.1. Ergebnisse liegen im Arbeitsspeicher und verfallen nach einer Stunde.'],
      ['ja', 'Abruf ohne Cookies',
        'Zweites Chrome mit eigenem, vor jedem Lauf geleertem Profil. Damit sieht man, was ein Fremder sieht.'],
      ['ja', 'Excel-Ausgabe',
        'Selbst geschriebene Arbeitsmappe, ohne fremde Bibliothek: Preise, Schutzpakete und Kalender als eigene Blätter.'],
      ['ja', 'Proxys je Länderseite',
        'Zwei Betriebsarten: ein Vorrat für alle Seiten, oder je Länderseite ein eigener. Eine lokale Weiche verteilt je Ziel, deshalb genügt ein Browser für alle. Gemessen: die Herkunft des Besuchers ändert bei Sixt nichts, 34 von 34 Klassen gleich.'],
      ['ja', 'Verbrauch der Proxys',
        'Wie viele Daten durchgelaufen sind, je Ziel. Residential-Proxys werden nach Gigabyte abgerechnet, das ist Kostenkontrolle.'],
      ['nein', 'Andere Vermieter',
        'Nur Sixt ist angebunden. Der Rest steht unten mit dem Grund.'],
    ],
  },
];

export const PROVIDERS = [sixt, avis, europcar, hertz, enterprise, carvia, arndt];

export const READY_PROVIDERS = PROVIDERS.filter((p) => p.status === 'ready');

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id);
}
