/**
 * Anbieter-Adapter.
 *
 * Jeder Adapter beschreibt, wie aus einer Suchanfrage (Query) eine aufrufbare
 * Anfrage wird. Zwei Transportarten werden unterstuetzt:
 *
 *   method: 'GET'   -> { url }                       ... normaler Link
 *   method: 'POST'  -> { url, fields: {name: wert} } ... Auto-Submit-Formular
 *
 * Das Original-Tool aus dem MWT-Forum konnte nur GET. Anbieter wie Avis
 * erwarten aber ein POST-Formular; deshalb kennt der Runner beide Wege.
 *
 * `status` ist ehrlich gemeint und wird in der Oberflaeche angezeigt:
 *   'verified'  - Deep-Link wurde gegen die Live-Seite geprueft
 *   'untested'  - Format plausibel, aber nicht geprueft
 */

/** Verfuegbare Sixt-Laenderseiten. Preise unterscheiden sich je Domain. */
export const SIXT_MARKETS = [
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
  { code: 'us', host: 'www.sixt.com/us', label: 'USA', cur: 'USD' },
];

/** ACRISS-Klassen, die Sixt ueber `grp` direkt ansteuern kann. */
export const SIXT_GROUPS = [
  { code: '', label: '— Übersicht (alle Klassen) —' },
  { code: 'MBMR', label: 'MBMR · Mini' },
  { code: 'EDMR', label: 'EDMR · Economy' },
  { code: 'CDMR', label: 'CDMR · Compact' },
  { code: 'CDAR', label: 'CDAR · Compact Automatik' },
  { code: 'CWAR', label: 'CWAR · Compact Kombi Automatik' },
  { code: 'IDAR', label: 'IDAR · Intermediate Automatik' },
  { code: 'IWAR', label: 'IWAR · Intermediate Kombi' },
  { code: 'SDAR', label: 'SDAR · Standard Automatik' },
  { code: 'SWAR', label: 'SWAR · Standard Kombi' },
  { code: 'FDAR', label: 'FDAR · Fullsize Automatik' },
  { code: 'FWAR', label: 'FWAR · Fullsize Kombi' },
  { code: 'PDAR', label: 'PDAR · Premium' },
  { code: 'PWAR', label: 'PWAR · Premium Kombi' },
  { code: 'LDAR', label: 'LDAR · Luxury' },
  { code: 'XDAR', label: 'XDAR · Special' },
  { code: 'XSAR', label: 'XSAR · Special SUV' },
  { code: 'XFAR', label: 'XFAR · Special Fullsize' },
  { code: 'ECAR', label: 'ECAR · Economy 2/4-türig' },
  { code: 'ECMR', label: 'ECMR · Economy Schaltung' },
  { code: 'IFAR', label: 'IFAR · Intermediate SUV' },
  { code: 'SFAR', label: 'SFAR · Standard SUV' },
  { code: 'FFAR', label: 'FFAR · Fullsize SUV' },
  { code: 'PFAR', label: 'PFAR · Premium SUV' },
];

/* ---------------------------------------------------------------- Helfer */

/** 2026-12-01 -> 20261201 (das Format, das Sixt heute tatsaechlich auswertet). */
function sixtDate(iso) {
  return iso.replaceAll('-', '');
}

/** '10:00' -> '1000' */
function hhmm(t) {
  return t.replace(':', '');
}

/* -------------------------------------------------------------- Adapter */

const sixt = {
  id: 'sixt',
  label: 'Sixt',
  status: 'verified',
  method: 'GET',
  markets: SIXT_MARKETS,
  /** Sixt adressiert Stationen ueber eine numerische ID (Legacy-Parameter `uci`). */
  stationKey: 'sixt',
  note:
    'Öffnet die Länderseite mit vorbelegter Suchmaske. Ein Klick auf "Suche" ' +
    'zeigt die Preise. Ein Direktsprung in die Trefferliste ist nicht möglich — ' +
    'Sixt verlangt dafür eine stationsspezifische UUID, die sich nicht aus der ' +
    'Stations-ID ableiten lässt.',

  build(q, market, station, returnStation) {
    const p = new URLSearchParams();
    p.set('uci', String(station.id));
    p.set('rci', String((returnStation || station).id));
    p.set('uda', sixtDate(q.pickupDate));
    p.set('rda', sixtDate(q.returnDate));
    p.set('uti', hhmm(q.pickupTime));
    p.set('rti', hhmm(q.returnTime));
    if (q.vehicleType !== 'truck') p.set('ctyp', 'P');
    if (q.group) p.set('grp', q.group);
    if (q.prepaid) p.set('prpd', 'Y');
    // Kundennummer/Passwort landen im Klartext in der URL — bewusst optional.
    if (q.sixtCustomerNo) p.set('kdnr', q.sixtCustomerNo);
    if (q.sixtPassword) p.set('pasw', q.sixtPassword);

    const base = market.host.includes('/')
      ? `https://${market.host}/`
      : `https://${market.host}/`;
    return { url: `${base}?${p.toString()}` };
  },
};

export const PROVIDERS = [sixt];

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id);
}
