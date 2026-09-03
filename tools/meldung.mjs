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
 * Über PowerShell und `System.Windows.Forms.MessageBox`, nicht mehr über
 * `mshta`. Der Grund ist gemessen und war eine unangenehme Überraschung:
 *
 *   Auf Windows 11 (Build 26200) startet `mshta` zwar, zeigt aber nichts mehr
 *   und beendet sich sofort, sowohl mit `vbscript:` als auch mit
 *   `javascript:`. Microsoft baut VBScript aus dem System heraus. Es gab
 *   keinen Fehler, keinen Rückgabewert, nichts: die Weckermeldung
 *   verschwand einfach. Genau die Sorte Fehler, die man erst bemerkt, wenn
 *   man auf eine Nachricht wartet, die nie kommt.
 *
 * PowerShell liegt seit Windows 7 auf jedem Rechner. Der Befehl wird als
 * Base64 übergeben (`-EncodedCommand`, UTF-16LE), damit weder
 * Anführungszeichen noch Umlaute auf dem Weg durch die Kommandozeile
 * zerlegt werden.
 */
/**
 * Meldungen, die gerade erst gestartet werden.
 *
 * `spawn` kehrt sofort zurueck, der Prozess selbst entsteht erst danach. Wer
 * unmittelbar hinterher `process.exit()` ruft, beendet sich, bevor das Fenster
 * ueberhaupt existiert, und die Meldung erscheint nie. Genau so verschwand die
 * Weckermeldung in der Einzelrunde fuer die Aufgabenplanung.
 */
const angestossen = [];

/** Warten, bis alle angestossenen Meldungsfenster wirklich laufen. */
export async function meldungenStehen() {
  if (!angestossen.length) return;
  await Promise.race([
    Promise.all(angestossen.splice(0)),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
}

export function zeigeMeldung(text, titel = 'TRACKER') {
  if (process.platform !== 'win32') {
    console.error(text);
    return;
  }
  try {
    // In PowerShell-Quelltext einsetzen: einfache Anfuehrungszeichen werden
    // verdoppelt, Zeilenumbrueche als [char]10 zusammengesetzt.
    const ps = (s) =>
      s
        .split('\n')
        .map((z) => `'${z.replaceAll("'", "''")}'`)
        .join(' + [char]10 + ');

    const skript =
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      `[void][System.Windows.Forms.MessageBox]::Show(${ps(text)},${ps(titel)},0,64)`;

    // Als Base64 uebergeben, damit weder Anfuehrungszeichen noch Umlaute auf
    // dem Weg durch die Kommandozeile zerlegt werden. UTF-16LE, das erwartet
    // -EncodedCommand.
    const kodiert = Buffer.from(skript, 'utf16le').toString('base64');

    const kind = spawn('powershell', ['-NoProfile', '-EncodedCommand', kodiert], {
      detached: true,
      stdio: 'ignore',
    });
    angestossen.push(
      new Promise((fertig) => {
        kind.once('spawn', () => {
          // Ins Protokoll, nicht stillschweigend: eine Meldung, die nicht
          // erscheint, ist der schlimmste Fehler an dieser Stelle, weil man
          // auf eine Nachricht wartet, die nie kommt.
          console.log(`  Meldungsfenster gestartet (PID ${kind.pid}): ${titel}`);
          fertig();
        });
        kind.once('error', (e) => {
          console.error(`  Meldungsfenster ließ sich nicht öffnen: ${e.message}`);
          console.error(text);
          fertig();
        });
      })
    );
    kind.unref();
  } catch (e) {
    console.error(`  Meldungsfenster fehlgeschlagen: ${e.message}`);
    console.error(text);
  }
}
