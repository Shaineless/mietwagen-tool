/**
 * Woher gelesen und wohin geschrieben wird, je nachdem, ob das Werkzeug aus
 * dem Quellbaum läuft oder als eine einzelne EXE.
 *
 * In der EXE gibt es keinen Quellbaum mehr. Die Oberfläche und die
 * Stationsliste stecken als eingebettete Vorräte in der Datei selbst; alles,
 * was der Betrieb schreibt (Katalog, Verbesserungsvorschläge), landet in einem
 * Ordner neben der EXE. Das ist die einzige Stelle, an der man beim Weitergeben
 * sicher schreiben darf, der Programmordner selbst kann schreibgeschützt sein,
 * und in `%TEMP%` würde es beim nächsten Aufräumen verschwinden.
 */

import { isSea, getRawAsset } from 'node:sea';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Läuft dieser Prozess als gepackte EXE? */
export const istExe = isSea();

/**
 * Wurzel des Quellbaums.
 *
 * `import.meta.url` überlebt das Bündeln nicht, esbuild ersetzt es durch einen
 * leeren String. In der EXE wird dieser Zweig nie erreicht; läuft das Bündel
 * versehentlich doch unter normalem Node, ist das Arbeitsverzeichnis die
 * nächstbeste Annahme.
 */
function ermittleQuellWurzel() {
  if (istExe) return null;
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

export const quellWurzel = ermittleQuellWurzel();

/** Ordner für alles, was der Betrieb schreibt. */
export const datenOrdner = istExe
  ? join(dirname(process.execPath), 'Tracker-Daten')
  : join(quellWurzel, 'data');

/**
 * Eingebetteter Vorrat oder Datei aus dem Quellbaum.
 *
 * `name` ist immer der Pfad relativ zur Projektwurzel, damit beide Betriebsarten
 * dieselben Namen benutzen. Gibt `null` zurück, wenn es die Datei nicht gibt,
 * der Aufrufer entscheidet, ob das ein Fehler ist.
 */
export async function leseVorrat(name) {
  const schluessel = name.replaceAll('\\', '/');

  if (istExe) {
    try {
      // Wirft, wenn der Vorrat nicht eingebettet wurde, hier ist das kein
      // Fehler, sondern schlicht "gibt es nicht".
      return Buffer.from(getRawAsset(schluessel));
    } catch {
      return null;
    }
  }

  // Aus dem Quellbaum wird von der Platte gelesen, und da zaehlt, dass der
  // Name nicht aus dem Baum herausfuehrt. Der Dienst hoert zwar nur auf
  // 127.0.0.1, aber jede offene Seite im Browser kann ihn ansprechen, ein
  // "/../" im Pfad wuerde sonst Dateien oberhalb des Projekts ausliefern.
  const abs = resolve(quellWurzel, schluessel);
  if (abs !== quellWurzel && !abs.startsWith(quellWurzel + sep)) return null;

  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}
