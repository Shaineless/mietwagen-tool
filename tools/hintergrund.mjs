/**
 * Den Preiswecker in die Windows-Aufgabenplanung eintragen.
 *
 * Der Wecker prueft von sich aus nur, solange TRACKER offen ist. Damit ist
 * sein Zweck verfehlt, denn wer eine Buchung beobachten laesst, hat das
 * Programm gerade nicht auf. Ein Eintrag in der Aufgabenplanung startet die
 * EXE einmal taeglich mit `--wecker-einmal`: sie prueft, meldet sich, wenn
 * etwas billiger wurde, und beendet sich wieder.
 *
 * DREI DINGE SIND HIER ABSICHT, und sie sind wichtiger als die Funktion:
 *
 *   1. Voreinstellung aus. Es geschieht nichts, was niemand eingeschaltet hat.
 *   2. Der vollstaendige Befehl steht im Klartext in der Oberflaeche, samt
 *      Namen des Eintrags, mit dem man ihn in der Aufgabenplanung wiederfindet.
 *      Ein Autostart, den man nicht sieht und nicht zuordnen kann, ist genau
 *      das, was man von fremder Software nicht will.
 *   3. Derselbe Schalter macht ihn wieder weg, vollstaendig.
 *
 * Es wird bewusst KEIN Dienst und KEIN Autostart-Eintrag angelegt: eine
 * geplante Aufgabe steht sichtbar in einer Liste, die Windows selbst mitbringt,
 * und laesst sich auch ohne TRACKER wieder loeschen.
 */

import { execFile } from 'node:child_process';
import { istExe } from './pfade.mjs';

/** So heisst der Eintrag in der Aufgabenplanung. */
export const AUFGABE = 'TRACKER Preiswecker';

function schtasks(args) {
  return new Promise((fertig) => {
    execFile(
      'schtasks',
      args,
      // Windows-Konsolencodepage: ohne das kommen Umlaute als Fragezeichen
      // zurueck, und die Meldung ist unlesbar.
      { windowsHide: true, timeout: 20000 },
      (fehler, aus, err) => {
        fertig({
          ok: !fehler,
          code: fehler?.code ?? 0,
          text: String(aus || '').trim(),
          fehler: String(err || fehler?.message || '').trim(),
        });
      }
    );
  });
}

/** Der Befehl, den der Eintrag ausfuehren wuerde. Wird auch angezeigt. */
export function befehl() {
  return `"${process.execPath}" --wecker-einmal`;
}

/**
 * Steht der Eintrag, und wann lief er zuletzt?
 *
 * `moeglich` sagt, ob es hier ueberhaupt Sinn ergibt: aus dem Quellbaum heraus
 * zeigt process.execPath auf node.exe, und ein Eintrag darauf waere nach dem
 * naechsten Node-Update oder Ortswechsel kaputt.
 */
export async function hintergrundStand() {
  if (process.platform !== 'win32') {
    return { moeglich: false, an: false, grund: 'Die Aufgabenplanung gibt es nur unter Windows.' };
  }
  if (!istExe) {
    return {
      moeglich: false,
      an: false,
      grund:
        'Das geht nur mit der fertigen Tracker.exe. Aus dem Quellcode heraus zeigte der Eintrag auf node.exe und ginge beim nächsten Update kaputt.',
    };
  }

  const r = await schtasks(['/Query', '/TN', AUFGABE, '/FO', 'LIST']);
  if (!r.ok) return { moeglich: true, an: false, befehl: befehl(), aufgabe: AUFGABE };

  // Aus der Listenausgabe die Zeilen ziehen, die jemanden interessieren.
  //
  // Die Muster kommen BEWUSST ohne Umlaut aus. schtasks antwortet in der
  // Sprache des Systems ("Nächste Laufzeit"), und ein Umlaut im Muster
  // ueberstand den EXE-Bau nicht: aus der Oberflaeche heraus blieb die
  // naechste Laufzeit leer, waehrend "Status" als reines ASCII ankam. Der
  // Punkt steht fuer das eine Zeichen, das sich unterwegs verwandeln kann.
  const hole = (muster) =>
    (r.text.split('\n').find((z) => muster.test(z.trim())) || '')
      .split(':')
      .slice(1)
      .join(':')
      .trim();
  return {
    moeglich: true,
    an: true,
    befehl: befehl(),
    aufgabe: AUFGABE,
    naechste: hole(/^(Next Run Time|N.chste Laufzeit)/i) || null,
    zuletzt: hole(/^(Last Run Time|Letzte Laufzeit)/i) || null,
    status: hole(/^(Status)/i) || null,
  };
}

/**
 * Eintrag anlegen oder entfernen.
 * @param {boolean} an
 * @param {string} uhrzeit  "HH:MM", nur beim Anlegen
 */
export async function setzeHintergrund(an, uhrzeit = '09:00') {
  const stand = await hintergrundStand();
  if (!stand.moeglich) return { ok: false, error: stand.grund };

  if (!an) {
    const r = await schtasks(['/Delete', '/TN', AUFGABE, '/F']);
    // Nicht vorhanden ist kein Fehler, das Ziel ist ja erreicht.
    if (!r.ok && !/nicht gefunden|cannot find|does not exist/i.test(r.fehler + r.text)) {
      return { ok: false, error: r.fehler || 'Der Eintrag ließ sich nicht entfernen.' };
    }
    return { ok: true, an: false };
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(uhrzeit)) {
    return { ok: false, error: 'Uhrzeit bitte als HH:MM, zum Beispiel 09:00.' };
  }

  // /F ueberschreibt einen vorhandenen Eintrag, damit ein Wechsel der Uhrzeit
  // nicht erst ein Loeschen von Hand braucht.
  const r = await schtasks([
    '/Create', '/F',
    '/TN', AUFGABE,
    '/TR', befehl(),
    '/SC', 'DAILY',
    '/ST', uhrzeit,
  ]);
  if (!r.ok) {
    return {
      ok: false,
      error: (r.fehler || r.text || 'Der Eintrag ließ sich nicht anlegen.').slice(0, 300),
    };
  }
  return { ok: true, an: true, uhrzeit, ...(await hintergrundStand()) };
}
