/**
 * Offengehaltene Kassenseiten verwalten.
 *
 * Nach einem Schutzabruf bleibt die Kasse der jeweiligen Laenderseite offen,
 * versteckt in einem eigenen Fenster. Klickt man in TRACKER auf einen Preis,
 * wird dort dasselbe Paket ausgewaehlt und das Fenster kommt nach vorn: man
 * steht mitten in der Buchung, mit genau dem Preis, der im Vergleich stand.
 *
 * Der Grund, warum es diese Datei ueberhaupt gibt, ist aber nicht das Oeffnen,
 * sondern das Schliessen.
 *
 * NACHGEMESSEN, mehrfach, ueber den privaten Arbeitssatz aller Chrome-Prozesse
 * des Werkzeugs:
 *
 *   offene Sixt-Kasse, aktiv          rund 300 MB
 *   dieselbe, eingefroren             rund 250 MB   (so wird sie gehalten)
 *   vier Kassen in vier Fenstern      253,1 MB je Seite
 *   vier Kassen in einem Fenster      254,8 MB je Seite
 *
 * Die letzten beiden Zeilen beantworten die naheliegende Frage: Reiter statt
 * Fenster sparen nichts. Chrome nimmt fuer jede Herkunft einen eigenen
 * Prozess, und sixt.de, sixt.fr, sixt.es und sixt.at sind vier Herkuenfte.
 * Der Prozess kostet, nicht der Fensterrahmen. Ein Fenster mit Reitern ist
 * trotzdem die bessere Wahl, weil man beim Buchen alle Laenderseiten
 * nebeneinander hat.
 *
 * Vier Laenderseiten sind also rund ein Gigabyte, und niemand bemerkt es, weil
 * das Fenster unsichtbar ist. Deshalb wird an vier Stellen aufgeraeumt, ohne
 * dass jemand daran denken muss:
 *
 *   1. Wer die Schutzansicht verlaesst, ohne zu buchen: alles zu.
 *   2. Obergrenze: mehr als OBERGRENZE Seiten gibt es nicht, die aelteste geht.
 *   3. Ablauf: nach LEBENSDAUER_MS ist die Sitzung bei Sixt ohnehin hinueber.
 *   4. Beim Beenden des Dienstes.
 *
 * Wird eine Seite gebraucht, die schon weg ist, holt die Oberflaeche genau
 * diese eine nach. Das kostet zwoelf Sekunden statt eines Gigabytes, und der
 * Preis wird dabei sogar frisch bestaetigt.
 */

import { zeigeFenster, versteckeFenster } from './browser.mjs';

/**
 * So viele Kassenseiten duerfen gleichzeitig offen sein.
 *
 * Sechs, also rund 1,5 GB nach der Messung oben. Die Zahl ist bewusst so
 * gewaehlt, dass der uebliche Fall nie etwas wegraeumt: wer drei bis fuenf
 * Laenderseiten vergleicht, behaelt alle. Erst darueber greift die Grenze, und
 * zwar als Schutz vor dem Ausreisser: alle 29 Laenderseiten waeren sieben
 * Gigabyte und wuerden jeden Rechner umwerfen.
 *
 * Was weggeraeumt wird, ist nicht verloren. Ein Klick auf eine geschlossene
 * Kasse holt genau diese eine in rund zwoelf Sekunden zurueck, und der Preis
 * wird dabei frisch bestaetigt.
 */
export const OBERGRENZE = 6;

/** Erfahrungswert je Seite, fuer die Anzeige in der Oberflaeche. */
export const SPEICHER_JE_SEITE_MB = 250;

/**
 * So lange wird eine Kassenseite hoechstens gehalten.
 *
 * Sixts Checkout haengt an einer Sitzung, die von selbst ablaeuft. Eine Seite
 * laenger zu halten, spart kein Neuladen, sie kostet dann nur noch Speicher.
 */
const LEBENSDAUER_MS = 12 * 60 * 1000;

/** schluessel -> Eintrag */
const offen = new Map();
let waechter = null;

function starteWaechter() {
  if (waechter) return;
  waechter = setInterval(() => {
    raeumeAuf().catch(() => {});
  }, 60_000);
  // Der Waechter darf den Prozess nicht am Leben halten.
  waechter.unref?.();
}

async function schliesseEintrag(e, grund) {
  try {
    await e.page.close();
  } catch {
    /* war schon zu */
  }
  console.log(`  ⌫ Kassenseite ${e.host} ${e.acriss} geschlossen (${grund})`);
}

/**
 * Eine frisch abgerufene Kassenseite aufnehmen.
 * @param {object} e  schluessel, host, acriss, page, windowId, inkognito,
 *                    pakete [{name, i, gesamt}], mieteOhneSchutz, waehrung
 */
export async function merke(e) {
  await schliesse(e.schluessel, 'wird ersetzt');

  const eintrag = { ...e, erstellt: Date.now(), sichtbar: false };
  offen.set(e.schluessel, eintrag);

  // Schliesst der Nutzer das Fenster selbst, soll der Eintrag mitgehen. Die
  // Pruefung auf Identitaet ist noetig, sonst raeumt die alte Seite beim
  // Ersetzen den neuen Eintrag weg.
  e.page.once('close', () => {
    if (offen.get(e.schluessel) === eintrag) offen.delete(e.schluessel);
  });

  while (offen.size > OBERGRENZE) {
    const aeltester = [...offen.values()].sort((a, b) => a.erstellt - b.erstellt)[0];
    await schliesseEintrag(aeltester, 'Obergrenze erreicht');
    offen.delete(aeltester.schluessel);
  }

  starteWaechter();
  return eintrag;
}

export function hole(schluessel) {
  const e = offen.get(schluessel);
  if (!e) return null;
  if (e.page.isClosed()) {
    offen.delete(schluessel);
    return null;
  }
  return e;
}


/** Was die Oberflaeche wissen muss, ohne Playwright-Objekte. */
export function liste() {
  const jetzt = Date.now();
  const out = [];
  for (const e of offen.values()) {
    if (e.page.isClosed()) continue;
    out.push({
      schluessel: e.schluessel,
      host: e.host,
      acriss: e.acriss,
      sichtbar: e.sichtbar,
      alterSekunden: Math.round((jetzt - e.erstellt) / 1000),
      restSekunden: Math.max(0, Math.round((e.erstellt + LEBENSDAUER_MS - jetzt) / 1000)),
    });
  }
  return out;
}

export async function schliesse(schluessel, grund = 'auf Wunsch') {
  const e = offen.get(schluessel);
  if (!e) return false;
  offen.delete(schluessel);
  await schliesseEintrag(e, grund);
  return true;
}

export async function schliesseAlle(grund = 'aufgeraeumt') {
  const alle = [...offen.values()];
  offen.clear();
  for (const e of alle) await schliesseEintrag(e, grund);
  return alle.length;
}

/** Abgelaufene und von aussen geschlossene Seiten wegraeumen. */
export async function raeumeAuf() {
  const jetzt = Date.now();
  let weg = 0;
  for (const [k, e] of [...offen]) {
    if (e.page.isClosed()) {
      offen.delete(k);
      continue;
    }
    if (jetzt - e.erstellt > LEBENSDAUER_MS) {
      offen.delete(k);
      await schliesseEintrag(e, 'Sitzung abgelaufen');
      weg++;
    }
  }
  return weg;
}

/**
 * Ein Fenster nach vorn holen. Alle anderen wandern dabei zurueck ins
 * Versteck, sonst stapeln sich nach mehreren Klicks die Chrome-Fenster auf
 * dem Bildschirm.
 */
export async function zeige(schluessel) {
  const e = hole(schluessel);
  if (!e) return false;
  for (const anderer of offen.values()) {
    if (anderer !== e && anderer.sichtbar) {
      await versteckeFenster(anderer).catch(() => {});
      anderer.sichtbar = false;
    }
  }
  const ok = await zeigeFenster(e);
  e.sichtbar = ok;
  return ok;
}

export async function verstecke(schluessel) {
  const e = hole(schluessel);
  if (!e) return false;
  await versteckeFenster(e).catch(() => {});
  e.sichtbar = false;
  return true;
}

export function anzahl() {
  return offen.size;
}
