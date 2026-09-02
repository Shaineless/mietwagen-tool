/**
 * Preiswecker.
 *
 * Eine hinterlegte Suche wird in Abständen von selbst nachgeprüft und meldet
 * sich, wenn der Preis unter eine Grenze fällt. Damit wird aus dem
 * Nachschlagewerk ein Werkzeug, das arbeitet, während man etwas anderes tut.
 *
 * Die eine Einschränkung, die offen dastehen muss: geprüft wird nur, solange
 * das Programm läuft. Ein Dienst, der im Hintergrund startet und sich in den
 * Autostart einträgt, wäre eine andere Sorte Programm, und niemand rechnet
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
 *                    grenze, waehrung, art, gebucht
 */
export async function legeWecker(w) {
  await laden();
  // Zwei Sorten. "wunsch": ich hätte den Wagen gern unter X. "buchung": ich
  // habe für X gebucht, sag mir, wenn es billiger wird, dann kann ich
  // stornieren und neu buchen. Die zweite läuft weiter, nachdem sie einmal
  // gemeldet hat: der Preis kann noch tiefer fallen, und jedes weitere Mal
  // ist wieder Geld.
  const art = w.art === 'buchung' ? 'buchung' : 'wunsch';
  const gebucht = art === 'buchung' ? Number(w.gebucht) : null;
  const eintrag = {
    id: randomBytes(6).toString('hex'),
    angelegt: Date.now(),
    art,
    station: String(w.station),
    stationName: w.stationName || '',
    von: w.von,
    bis: w.bis,
    // Ohne Uhrzeit ist ein Wecker eine Falle: Sixt rechnet nach Uhrzeit ab,
    // und gemessen lagen 12:30 und 13:30 am selben Tag 57 % auseinander. Wer
    // bei 13:30 sucht, bekaeme sonst Alarm ueber einen Preis, den er nie
    // gesehen hat. '10:00' als Rueckfall, weil aeltere Wecker so geprueft
    // wurden, sie verhalten sich damit unveraendert.
    zeit: w.zeit || '10:00',
    zeitRueck: w.zeitRueck || w.zeit || '10:00',
    host: w.host,
    hostLabel: w.hostLabel || w.host,
    acriss: w.acriss,
    // Bei einer Buchung ist der gezahlte Preis die Grenze, etwas anderes
    // einzutragen ergäbe keinen Sinn.
    grenze: art === 'buchung' ? gebucht : Number(w.grenze),
    gebucht,
    waehrung: w.waehrung || '',
    // Betriebsdaten
    zuletztGeprueft: null,
    letzterPreis: null,
    bestPreis: null,
    /** Der Preis, über den zuletzt Meldung gemacht wurde. */
    gemeldet: null,
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
  const heute = new Date().toISOString().slice(0, 10);
  return alle.filter((w) => {
    // Abgelaufene Termine nicht mehr prüfen, der Wagen ist längst weg.
    // Bei einer Buchung zählt der Abholtag: ab da ist nichts mehr umzubuchen.
    if ((w.art === 'buchung' ? w.von : w.bis) < heute) return false;
    // Ein Wunschwecker hat seine Aufgabe erfüllt, sobald er einmal gemeldet
    // hat. Ein Buchungswecker nicht, der Preis kann weiter fallen.
    if (w.ausgeloest && w.art !== 'buchung') return false;
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

  let loest = false;
  if (preis != null) {
    if (w.art === 'buchung') {
      // Melden nur bei einem neuen Tiefstand unter dem gezahlten Preis,
      // sonst käme alle sechs Stunden dieselbe Nachricht über denselben
      // Preis, und man hörte irgendwann weg.
      loest = preis < w.gebucht && (w.gemeldet == null || preis < w.gemeldet);
      if (loest) w.gemeldet = preis;
    } else {
      loest = preis <= w.grenze;
    }
  }
  if (loest) {
    w.ausgeloest = true;
    w.ausgeloestAm = Date.now();
  }
  await sichern();
  return loest;
}
