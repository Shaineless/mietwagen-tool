/**
 * Langzeitgedächtnis für Preise.
 *
 * Die Ergebnisse im Dienst verfallen nach einer Stunde, richtig so, sie sind
 * Momentaufnahmen. Für die beiden Fragen, die man bei Mietwagen wirklich hat,
 * reicht das aber nicht:
 *
 *   "Wird es noch billiger, wenn ich warte?"   braucht denselben Preis über Wochen
 *   "Sag mir Bescheid, wenn es unter X fällt"  braucht einen Vergleich mit früher
 *
 * Deshalb wandert von jedem Abruf eine knappe Zeile in eine Datei: wann, wo,
 * welcher Zeitraum, welche Klasse, welcher Preis. Eine Zeile je Klasse und
 * Länderseite, im JSON-Lines-Format, anhängend geschrieben, mit jedem Editor
 * lesbar, und nichts kann dabei kaputtgehen.
 *
 * Bewusst nicht in einer Datenbank: es sind ein paar tausend Zeilen im Jahr,
 * und eine Datei, die man aufmachen und verstehen kann, ist an dieser Stelle
 * mehr wert als Abfragegeschwindigkeit.
 */

import { appendFile, readFile, writeFile, readdir, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { datenOrdner } from './pfade.mjs';

const DATEI = join(datenOrdner, 'preisverlauf.jsonl');

/**
 * Alle Dateien, die zum Verlauf gehoeren: die aktuelle und jedes Archiv.
 *
 * Frueher benannte sich die Datei bei 8 MB selbst in `preisverlauf-<Jahr>.jsonl`
 * um, mit dem Kommentar "wer die Kurve ueber Jahre will, hat sie dann noch".
 * Das stimmte nicht: gelesen wurde ausschliesslich die eine Datei. In dem
 * Moment, in dem die Grenze gefallen waere, waere die gesamte Kurve auf einen
 * Schlag aus dem Programm verschwunden, ohne Meldung.
 *
 * Jetzt wird alles gelesen, was da ist. Umbenannt wird nichts mehr von selbst.
 */
async function verlaufDateien() {
  const dateien = [DATEI];
  try {
    for (const name of await readdir(datenOrdner)) {
      if (/^preisverlauf-.+\.jsonl$/.test(name)) dateien.push(join(datenOrdner, name));
    }
  } catch {
    /* Ordner gibt es noch nicht */
  }
  return dateien;
}

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
        // Der Frühbucherrabatt erklärt Spruenge in der Kurve, ohne ihn sieht
        // ein Preissprung nach Zufall aus.
        f: o.fruehbucher ? 1 : 0,
        // Ob ohne Cookies gemessen wurde. Gemessen liegen die beiden Modi
        // auseinander; stuenden sie unmarkiert in derselben Kurve, saehe der
        // Unterschied nach einer Preisaenderung bei Sixt aus, waere aber nur
        // ein Wechsel des Haekchens.
        i: job.inkognito ? 1 : 0,
        // Die Uhrzeit gehoert dazu: Sixt rechnet nach Uhrzeit ab, nicht nach
        // Kalendertag, gemessen lagen 12:30 und 13:30 am selben Tag 57 %
        // auseinander. Ohne dieses Feld ist ein gespeicherter Preis nicht
        // zuzuordnen, sobald jemand mehr als eine Uhrzeit vergleicht.
        z: job.pickupTime || null,
        zr: job.returnTime || null,
      })
    );

  if (!zeilen.length) return;

  try {
    await mkdir(datenOrdner, { recursive: true });
    await appendFile(DATEI, zeilen.join('\n') + '\n', 'utf8');
    // Der Zwischenspeicher haengt mit an, statt beim naechsten Lesen die
    // ganze Datei noch einmal durchzugehen.
    if (bestand) for (const z of zeilen) bestand.push(JSON.parse(z));
  } catch {
    /* Der Preisverlauf ist Beiwerk, sein Scheitern darf keinen Abruf stoppen. */
  }
}

/* ------------------------------------------------------ Lesen */

/**
 * Der geparste Bestand, solange sich auf der Platte nichts geaendert hat.
 *
 * Nicht wegen der Geschwindigkeit: 22.000 Zeilen zu lesen und zu parsen dauert
 * gemessen 14 ms. Sondern damit diese Kosten nicht mitwachsen, denn die
 * Uebersicht wird bei jedem Betreten der Ansicht geholt und die Kurve bei jeder
 * Auswahl.
 */
let bestand = null;
let bestandStempel = '';

async function stempel() {
  const teile = [];
  for (const d of await verlaufDateien()) {
    try {
      const i = await stat(d);
      teile.push(`${d}:${i.size}:${i.mtimeMs}`);
    } catch {
      /* gibt es nicht */
    }
  }
  return teile.join('|');
}

/** Zwischenspeicher verwerfen, nachdem von aussen geschrieben wurde. */
export function vergissBestand() {
  bestand = null;
  bestandStempel = '';
}

async function ladeBestand() {
  const jetzt = await stempel();
  if (bestand && jetzt === bestandStempel) return bestand;

  const alle = [];
  for (const datei of await verlaufDateien()) {
    let roh;
    try {
      roh = await readFile(datei, 'utf8');
    } catch {
      continue;
    }
    for (const zeile of roh.split('\n')) {
      if (!zeile) continue;
      try {
        alle.push(JSON.parse(zeile));
      } catch {
        /* abgeschnittene letzte Zeile nach einem Absturz */
      }
    }
  }
  bestand = alle;
  bestandStempel = jetzt;
  return bestand;
}

/**
 * Beobachtungen lesen und auf das Gefragte eingrenzen.
 *
 * Gelesen wird die aktuelle Datei UND jedes Archiv daneben, damit nichts
 * unerreichbar wird, was einmal gemessen wurde.
 */
export async function leseVerlauf({ station, acriss, host, von, bis, seit } = {}) {
  const alle = await ladeBestand();
  const treffer = [];
  for (const e of alle) {
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

/** Wie viel Platz der Verlauf belegt, fuer die Anzeige. */
export async function verlaufGroesse() {
  let bytes = 0;
  let dateien = 0;
  for (const d of await verlaufDateien()) {
    try {
      bytes += (await stat(d)).size;
      dateien++;
    } catch {
      /* gibt es nicht */
    }
  }
  return { bytes, dateien, punkte: (await ladeBestand()).length };
}

/* ------------------------------------------------------ Ausduennen */

/**
 * Alte Messpunkte ausduennen.
 *
 * Eine Kurve ueber Wochen braucht keine sechs Messungen desselben Tages. Fuer
 * alles, was aelter ist als `vorTagen`, bleibt je Reihe und Tag der erste
 * Punkt stehen; die Form der Kurve bleibt damit erhalten, die Datei schrumpft.
 *
 * Zwei Dinge sind hier Absicht:
 *
 *   1. Es geschieht NIE von selbst. Diese Daten sind muehsam gesammelt und
 *      nicht wiederherstellbar, deshalb entscheidet das ein Mensch.
 *   2. `nurZaehlen` beantwortet zuerst die Frage "was wuerde das kosten?",
 *      damit niemand blind zustimmt.
 *
 * Geschrieben wird ueber eine Zwischendatei, die erst am Ende an ihren Platz
 * geschoben wird: bricht es mittendrin ab, steht der alte Stand unberuehrt da.
 */
export async function duenneAus({ vorTagen = 30, nurZaehlen = true } = {}) {
  const grenze = Date.now() - vorTagen * 24 * 60 * 60 * 1000;
  const alle = await ladeBestand();

  const gesehen = new Set();
  const behalten = [];
  let entfernt = 0;

  // Aeltester zuerst, damit je Tag der erste Punkt stehen bleibt und nicht ein
  // beliebiger. Der erste Messwert eines Tages ist der, den man beim Vergleich
  // mit dem Vortag sehen will.
  for (const e of [...alle].sort((a, b) => a.t - b.t)) {
    if (e.t >= grenze) {
      behalten.push(e);
      continue;
    }
    const tag = new Date(e.t).toISOString().slice(0, 10);
    const reihe = `${e.s}|${e.v}|${e.b}|${e.k}|${e.h}|${e.i ? 1 : 0}|${e.z || ''}|${e.zr || ''}|${tag}`;
    if (gesehen.has(reihe)) {
      entfernt++;
      continue;
    }
    gesehen.add(reihe);
    behalten.push(e);
  }

  const vorher = await verlaufGroesse();
  if (nurZaehlen || !entfernt) {
    return { entfernt, vorher: alle.length, nachher: alle.length - entfernt, bytes: vorher.bytes, geschrieben: false };
  }

  // Wieder in Messreihenfolge bringen, die Datei soll bleiben, was sie ist:
  // eine chronologische Liste, die man mit jedem Editor lesen kann.
  behalten.sort((a, b) => a.t - b.t);
  const zwischen = DATEI + '.neu';
  await writeFile(zwischen, behalten.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  // Archive gehen mit auf: ihr Inhalt steckt jetzt in der neuen Datei.
  for (const d of await verlaufDateien()) {
    if (d === DATEI) continue;
    await unlink(d).catch(() => {});
  }
  await rename(zwischen, DATEI);
  vergissBestand();

  const nachher = await verlaufGroesse();
  return {
    entfernt,
    vorher: alle.length,
    nachher: behalten.length,
    bytes: vorher.bytes,
    bytesNachher: nachher.bytes,
    geschrieben: true,
  };
}

/**
 * Welche Kombinationen sind ueberhaupt beobachtet worden?
 *
 * Damit die Oberflaeche zur Auswahl stellen kann, wozu es Daten gibt, statt
 * den Nutzer raten zu lassen.
 */
export async function verlaufUebersicht({ schlank = false } = {}) {
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
      // Uhrzeitpaare als "HH:MM|HH:MM". Altdaten tragen keine Uhrzeit, die
      // wurden damals alle um 10:00 gemessen, und genau das steht dann da,
      // statt eine Luecke zu lassen, die spaeter niemand mehr deuten kann.
      zeiten: new Set(),
      punkte: 0,
      zuerst: e.t,
      zuletzt: e.t,
    };
    g.klassen.add(e.k);
    g.hosts.add(e.h);
    g.zeiten.add(`${e.z || '10:00'}|${e.zr || e.z || '10:00'}`);
    g.punkte++;
    if (e.t < g.zuerst) g.zuerst = e.t;
    if (e.t > g.zuletzt) g.zuletzt = e.t;
    nach.set(schluessel, g);
  }
  // Schlank: nur die Anzahlen. Die vollen Listen sind der weitaus groesste
  // Teil der Antwort (gemessen 12.498 Klassen-Eintraege ueber 280 Reisen, das
  // sind die 136 KB), und die Oberflaeche braucht sie erst, wenn eine Reise
  // gewaehlt ist. Bis dahin genuegt "wie viele".
  return [...nach.values()]
    .map((g) =>
      schlank
        ? {
            station: g.station,
            von: g.von,
            bis: g.bis,
            klassenAnzahl: g.klassen.size,
            hostsAnzahl: g.hosts.size,
            zeitenAnzahl: g.zeiten.size,
            punkte: g.punkte,
            zuerst: g.zuerst,
            zuletzt: g.zuletzt,
          }
        : {
            ...g,
            klassen: [...g.klassen].sort(),
            hosts: [...g.hosts].sort(),
            zeiten: [...g.zeiten].sort(),
          }
    )
    .sort((a, b) => b.zuletzt - a.zuletzt);
}
