/**
 * Ausgabe für ein Programm ohne Konsolenfenster.
 *
 * Die EXE wird als Fensterprogramm gebaut, damit beim Doppelklick keine
 * schwarze Konsole aufgeht. Damit hat sie aber auch kein `stdout` mehr, das
 * jemand liest: alles, was das Programm sagt, ginge ersatzlos verloren.
 *
 * Deshalb zwei Wege, jede Zeile wandert zusätzlich in eine Protokolldatei
 * neben dem Programm, und was den Start verhindert, kommt als Fenster auf den
 * Bildschirm. Eine Fehlermeldung, die niemand sehen kann, ist keine.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

let protokollDatei = null;

/** Ab hier wird jede Konsolenausgabe zusätzlich mitgeschrieben. */
export function protokolliereNach(ordner) {
  try {
    mkdirSync(ordner, { recursive: true });
  } catch {
    return;
  }
  protokollDatei = join(ordner, 'tracker.log');

  for (const art of ['log', 'warn', 'error']) {
    const original = console[art].bind(console);
    console[art] = (...teile) => {
      original(...teile);
      schreibe(art, teile);
    };
  }

  schreibe('log', [`--- Start ${new Date().toISOString()} ---`]);
}

function schreibe(art, teile) {
  if (!protokollDatei) return;
  try {
    const zeile = teile
      .map((t) => (typeof t === 'string' ? t : t?.stack || JSON.stringify(t)))
      .join(' ');
    appendFileSync(protokollDatei, `[${art}] ${zeile}\n`, 'utf8');
  } catch {
    /* Wenn nicht einmal das Protokoll geht, ist Schweigen die einzige Option. */
  }
}

export function protokollPfad() {
  return protokollDatei;
}

/**
 * Meldung als Fenster.
 *
 * `mshta` gehört zu Windows und kann eine Meldungsbox anzeigen, ohne dass
 * etwas installiert sein müsste. Anführungszeichen werden in VBScript durch
 * Verdoppeln geschützt; Zeilenumbrüche müssen als Ausdruck zusammengesetzt
 * werden, weil ein Zeilenumbruch im Quelltext die Anweisung beenden würde.
 */
export function zeigeMeldung(text, titel = 'TRACKER') {
  if (process.platform !== 'win32') {
    console.error(text);
    return;
  }
  try {
    const vb = (s) =>
      s
        .split('\n')
        .map((z) => `"${z.replaceAll('"', '""')}"`)
        .join(' & vbCrLf & ');
    spawn(
      'mshta',
      [`vbscript:Execute("msgbox ${vb(text)},16,${vb(titel)}:close")`],
      { detached: true, stdio: 'ignore' }
    ).unref();
  } catch {
    console.error(text);
  }
}
