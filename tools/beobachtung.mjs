/**
 * Langzeitgedächtnis für Preise.
 *
 * Die Ergebnisse im Dienst verfallen nach einer Stunde — richtig so, sie sind
 * Momentaufnahmen. Für die beiden Fragen, die man bei Mietwagen wirklich hat,
 * reicht das aber nicht:
 *
 *   "Wird es noch billiger, wenn ich warte?"   braucht denselben Preis über Wochen
 *   "Sag mir Bescheid, wenn es unter X fällt"  braucht einen Vergleich mit früher
 *
 * Deshalb wandert von jedem Abruf eine knappe Zeile in eine Datei: wann, wo,
 * welcher Zeitraum, welche Klasse, welcher Preis. Eine Zeile je Klasse und
 * Länderseite, im JSON-Lines-Format — anhängend geschrieben, mit jedem Editor
 * lesbar, und nichts kann dabei kaputtgehen.
 *
 * Bewusst nicht in einer Datenbank: es sind ein paar tausend Zeilen im Jahr,
 * und eine Datei, die man aufmachen und verstehen kann, ist an dieser Stelle
 * mehr wert als Abfragegeschwindigkeit.
 */

import { appendFile, readFile, mkdir, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { datenOrdner } from './pfade.mjs';

const DATEI = join(datenOrdner, 'preisverlauf.jsonl');

/** Ab dieser Größe wird umbenannt, damit die Datei nicht unbegrenzt wächst. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Einen Abruf festhalten.
 *
 * Gespeichert wird nur, was für eine Kurve nötig ist. Modellnamen und Bilder
 * bleiben draußen: die ändern sich, blähen die Datei auf und beantworten
 * keine Frage über die Zeit.
 */
export async function merkeAbruf(job, res) {
  if (!res?.offers?.length) return;

  const zeit = Date.now();
  const zeilen = res.offers
    .filter((o) => o.acriss && o.total != null && !o.unstimmig)
    .map((o) =>
      JSON.stringify({
        t: zeit,
        h: job.host,
        s: String(job.stationCode),
        v: job.pickupDate,
        b: job.returnDate,
        k: o.acriss,
        p: o.total,
        w: o.currency || null,
        // Der Frühbucherrabatt erklärt Spruenge in der Kurve — ohne ihn sieht
        // ein Preissprung nach Zufall aus.
        f: o.fruehbucher ? 1 : 0,
      })
    );

  if (!zeilen.length) return;

  try {
    await mkdir(datenOrdner, { recursive: true });
    await umbenennenWennGross();
    await appendFile(DATEI, zeilen.join('\n') + '\n', 'utf8');
  } catch {
    /* Der Preisverlauf ist Beiwerk — sein Scheitern darf keinen Abruf stoppen. */
  }
}

async function umbenennenWennGross() {
  try {
    const info = await stat(DATEI);
    if (info.size < MAX_BYTES) return;
    // Eine Sicherung, nicht loeschen: wer die Kurve ueber Jahre will, hat sie
    // dann noch.
    await rename(DATEI, DATEI.replace(/\.jsonl$/, `-${new Date().getFullYear()}.jsonl`));
  } catch {
    /* gibt es noch nicht */
  }
}

/**
 * Beobachtungen lesen und auf das Gefragte eingrenzen.
 *
 * Die Datei wird ganz gelesen und dann gefiltert. Bei ein paar zehntausend
 * Zeilen ist das eine Sache von Millisekunden, und alles andere waere eine
 * Datenbank, die hier niemand braucht.
 */
export async function leseVerlauf({ station, acriss, host, von, bis, seit } = {}) {
  let roh;
  try {
    roh = await readFile(DATEI, 'utf8');
  } catch {
    return [];
  }

  const treffer = [];
  for (const zeile of roh.split('\n')) {
    if (!zeile) continue;
    let e;
    try {
      e = JSON.parse(zeile);
    } catch {
      continue; // abgeschnittene letzte Zeile nach einem Absturz
    }
    if (station && e.s !== String(station)) continue;
    if (acriss && e.k !== acriss) continue;
    if (host && e.h !== host) continue;
    if (von && e.v !== von) continue;
    if (bis && e.b !== bis) continue;
    if (seit && e.t < seit) continue;
    treffer.push(e);
  }
  return treffer;
}

/**
 * Welche Kombinationen sind ueberhaupt beobachtet worden?
 *
 * Damit die Oberflaeche zur Auswahl stellen kann, wozu es Daten gibt, statt
 * den Nutzer raten zu lassen.
 */
export async function verlaufUebersicht() {
  const alle = await leseVerlauf();
  const nach = new Map();
  for (const e of alle) {
    const schluessel = `${e.s}|${e.v}|${e.b}`;
    const g = nach.get(schluessel) || {
      station: e.s,
      von: e.v,
      bis: e.b,
      klassen: new Set(),
      hosts: new Set(),
      punkte: 0,
      zuerst: e.t,
      zuletzt: e.t,
    };
    g.klassen.add(e.k);
    g.hosts.add(e.h);
    g.punkte++;
    if (e.t < g.zuerst) g.zuerst = e.t;
    if (e.t > g.zuletzt) g.zuletzt = e.t;
    nach.set(schluessel, g);
  }
  return [...nach.values()]
    .map((g) => ({ ...g, klassen: [...g.klassen].sort(), hosts: [...g.hosts].sort() }))
    .sort((a, b) => b.zuletzt - a.zuletzt);
}
