/**
 * Anbieter-Register.
 *
 * Jeder Anbieter beschreibt drei Dinge:
 *   1. welche Laenderseiten es gibt      -> markets
 *   2. wie aus einer Anfrage ein Aufruf wird -> build()
 *   3. was davon nachweislich funktioniert   -> status / capabilities
 *
 * Punkt 3 ist bewusst Teil der Datenstruktur. Das Vorgaengertool bot
 * Bedienelemente an, die Sixt inzwischen ignoriert (Fahrzeugklasse, Prepaid) —
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
  { code: 'lu', host: 'www.sixt.lu', label: 'Luxemburg', cur: 'EUR' },
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
  { code: 'cz', host: 'www.sixt.cz', label: 'Tschechien', cur: 'CZK' },
  { code: 'hu', host: 'www.sixt.hu', label: 'Ungarn', cur: 'HUF' },
  { code: 'hr', host: 'www.sixt.hr', label: 'Kroatien', cur: 'EUR' },
  { code: 'gr', host: 'www.sixt.gr', label: 'Griechenland', cur: 'EUR' },
  { code: 'tr', host: 'www.sixt.com.tr', label: 'Türkei', cur: 'TRY' },
  { code: 'com', host: 'www.sixt.com', label: 'International (.com)', cur: 'EUR' },
];

/**
 * Farbthemen zur Orientierung — angelehnt an die Hausfarben der Vermieter,
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
    // Nachweislich NICHT mehr ausgewertet — die Parameter werden verworfen:
    vehicleClass: false,
    prepaid: false,
  },
  notes: [
    'Datum muss als yyyymmdd übergeben werden. Das vom Original-Tool benutzte ' +
      'dd-mm-yyyy wird stillschweigend ignoriert.',
    'Die Parameter grp (Fahrzeugklasse) und prpd (Prepaid) werden von Sixt ' +
      'heute verworfen — geprüft: die Trefferliste startet mit leerem Filter.',
    'Ein Direktsprung in die Trefferliste ist nicht möglich; Sixt adressiert ' +
      'Stationen dort über eine UUID, die sich aus der Stations-ID nicht ' +
      'ableiten lässt. Das Tool belegt die Suchmaske vor.',
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
 * konstruierten Link — ein geratener Link waere schlechter als gar keiner.
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

export const PROVIDERS = [sixt, avis, europcar, hertz, enterprise, carvia, arndt];

export const READY_PROVIDERS = PROVIDERS.filter((p) => p.status === 'ready');

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id);
}
