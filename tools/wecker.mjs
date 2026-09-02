/**
 * Preiswecker.
 *
 * Eine hinterlegte Suche wird in Abständen von selbst nachgeprüft und meldet
 * sich, wenn der Preis unter eine Grenze fällt. Damit wird aus dem
 * Nachschlagewerk ein Werkzeug, das arbeitet, während man etwas anderes tut.
 *
 * Die eine Einschränkung, die offen dastehen muss: geprüft wird nur, solange
 * das Programm läuft. Ein Dienst, der im Hintergrund startet und sich in den
 * Autostart einträgt, wäre eine andere Sorte Programm — und niemand rechnet
 * damit, wenn er ein Vergleichswerkzeug öffnet. Die Oberfläche sagt das dazu.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { datenOrdner } from './pfade.mjs';

const DATEI = join(datenOrdner, 'wecker.json');

/** Wie oft dieselbe Suche höchstens nachgeprüft wird. */
const MIN_ABSTAND_MS = 6 * 60 * 60 * 1000; // sechs Stunden

let wecker = null;

async function laden() {
  if (wecker) return wecker;
  try {
    const roh = await readFile(DATEI, 'utf8');
    const d = JSON.parse(roh.replace(/^﻿/, ''));
    wecker = Array.isArray(d) ? d : [];
  } catch {
    wecker = [];
  }
  return wecker;
}

async function sichern() {
  try {
    await mkdir(datenOrdner, { recursive: true });
    await writeFile(DATEI, JSON.stringify(wecker, null, 1), 'utf8');
  } catch {
    /* dann eben nur für diese Sitzung */
  }
}

export async function alleWecker() {
  return await laden();
}

/**
 * @param {object} w  station, stationName, von, bis, host, hostLabel, acriss,
 *                    grenze, waehrung
 */
export async function legeWecker(w) {
  await laden();
  const eintrag = {
    id: randomBytes(6).toString('hex'),
    angelegt: Date.now(),
    station: String(w.station),
    stationName: w.stationName || '',
    von: w.von,
    bis: w.bis,
    host: w.host,
    hostLabel: w.hostLabel || w.host,
    acriss: w.acriss,
    grenze: Number(w.grenze),
    waehrung: w.waehrung || '',
    // Betriebsdaten
    zuletztGeprueft: null,
    letzterPreis: null,
    bestPreis: null,
    ausgeloest: false,
    ausgeloestAm: null,
    fehler: null,
  };
  wecker.unshift(eintrag);
  await sichern();
  return eintrag;
}

export async function loescheWecker(id) {
  await laden();
  const vorher = wecker.length;
  wecker = wecker.filter((w) => w.id !== id);
  await sichern();
  return vorher !== wecker.length;
}

/** Einen ausgelösten Wecker bestätigen, damit er nicht weiter meldet. */
export async function quittiereWecker(id) {
  await laden();
  const w = wecker.find((x) => x.id === id);
  if (!w) return false;
  w.ausgeloest = false;
  await sichern();
  return true;
}

/** Welche Wecker sind jetzt an der Reihe? */
export async function faelligeWecker() {
  const alle = await laden();
  const jetzt = Date.now();
  return alle.filter((w) => {
    // Abgelaufene Termine nicht mehr prüfen — der Wagen ist längst weg.
    if (w.bis < new Date().toISOString().slice(0, 10)) return false;
    if (w.ausgeloest) return false;
    return !w.zuletztGeprueft || jetzt - w.zuletztGeprueft > MIN_ABSTAND_MS;
  });
}

/**
 * Ergebnis einer Prüfung eintragen.
 * @returns {boolean} ob der Wecker gerade jetzt ausgelöst hat
 */
export async function vermerkePruefung(id, { preis = null, fehler = null } = {}) {
  await laden();
  const w = wecker.find((x) => x.id === id);
  if (!w) return false;

  w.zuletztGeprueft = Date.now();
  w.fehler = fehler;
  if (preis != null) {
    w.letzterPreis = preis;
    if (w.bestPreis == null || preis < w.bestPreis) w.bestPreis = preis;
  }

  const loest = preis != null && preis <= w.grenze;
  if (loest) {
    w.ausgeloest = true;
    w.ausgeloestAm = Date.now();
  }
  await sichern();
  return loest;
}
