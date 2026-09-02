/**
 * Katalog der jemals gesehenen Fahrzeugklassen.
 *
 * Warum: Eine Klasse, die heute nicht buchbar ist, taucht in der Trefferliste
 * gar nicht auf. In der Vergleichstabelle waere sie damit unsichtbar, und man
 * koennte "gibt es dort nicht" nicht von "heute ausgebucht" unterscheiden.
 *
 * Der Katalog haelt fest, welche ACRISS-Klassen an welcher Station auf welcher
 * Laenderseite schon einmal angeboten wurden. Die Tabelle kann dadurch drei
 * Zustaende zeigen:
 *
 *   Preis              buchbar
 *   "nicht buchbar"    Klasse dort bekannt, aktuell kein Angebot
 *   leer               dort noch nie gesehen
 *
 * Er waechst mit jeder Abfrage und wird auf Platte gehalten, weil die
 * Preisergebnisse selbst nach einer Stunde verfallen.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { datenOrdner } from './pfade.mjs';

const DATEI = join(datenOrdner, 'acriss-katalog.json');

let katalog = null;
let schreibTimer = null;

const leer = () => ({ version: 1, klassen: {}, gesehen: {} });

/** Schluessel fuer "Station auf dieser Laenderseite". */
function ort(provider, stationCode, host) {
  return `${provider}|${stationCode}|${host}`;
}

export async function ladeKatalog() {
  if (katalog) return katalog;
  try {
    katalog = JSON.parse(await readFile(DATEI, 'utf8'));
    if (!katalog.klassen || !katalog.gesehen) katalog = leer();
  } catch {
    katalog = leer();
  }
  return katalog;
}

/** Gebuendelt schreiben: ein Abruf loest bis zu 50 Aenderungen aus. */
function sichereBald() {
  clearTimeout(schreibTimer);
  schreibTimer = setTimeout(async () => {
    try {
      await mkdir(datenOrdner, { recursive: true });
      await writeFile(DATEI, JSON.stringify(katalog, null, 1));
    } catch {
      /* nicht schreibbar, der Katalog ist Beiwerk, kein Grund zu scheitern */
    }
  }, 1500);
}

/**
 * Ergebnis eines Abrufs einarbeiten.
 * @param {{provider:string, stationCode:string, host:string}} job
 * @param {Array} offers
 */
export async function merkeAngebote(job, offers) {
  const k = await ladeKatalog();
  const heute = new Date().toISOString().slice(0, 10);
  const schluessel = ort(job.provider, job.stationCode, job.host);
  if (!k.gesehen[schluessel]) k.gesehen[schluessel] = {};

  for (const o of offers || []) {
    if (!o.acriss) continue;

    const vorher = k.klassen[o.acriss] || { modelle: [] };
    // Bild und Modellnamen mitnehmen: dadurch laesst sich eine Klasse auch
    // dann anzeigen, wenn sie gerade nirgends buchbar ist.
    const modelle = new Set(vorher.modelle || []);
    if (o.model) modelle.add(o.model);

    k.klassen[o.acriss] = {
      bild: o.image || vorher.bild || null,
      modelle: [...modelle].slice(0, 6),
      // Der Kategorietext der jeweiligen Seite, nur als Beleg.
      beispielText: o.category || vorher.beispielText || null,
      zuletzt: heute,
    };

    k.gesehen[schluessel][o.acriss] = heute;
  }

  sichereBald();
  return k;
}

/**
 * Was ist an dieser Station auf diesen Laenderseiten schon einmal
 * angeboten worden?
 */
export async function bekannteKlassen(provider, stationCode, hosts) {
  const k = await ladeKatalog();
  const treffer = new Set();
  for (const host of hosts) {
    const eintrag = k.gesehen[ort(provider, stationCode, host)];
    if (eintrag) for (const acriss of Object.keys(eintrag)) treffer.add(acriss);
  }
  const klassen = {};
  for (const a of treffer) klassen[a] = k.klassen[a] || null;
  return klassen;
}

export async function katalogStand() {
  const k = await ladeKatalog();
  return {
    klassen: Object.keys(k.klassen).length,
    orte: Object.keys(k.gesehen).length,
  };
}
