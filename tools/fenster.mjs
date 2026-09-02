/**
 * Das Programmfenster.
 *
 * Chrome und Edge können mit `--app=<Adresse>` ein Fenster ohne Adresszeile,
 * ohne Tableiste und ohne Lesezeichen öffnen, von aussen ein gewöhnliches
 * Programmfenster. Zusammen mit einem eigenen Profilordner bekommt es einen
 * eigenen Eintrag in der Taskleiste und teilt sich nichts mit dem Chrome, in
 * dem der Nutzer sonst surft.
 *
 * Warum nicht Electron: das brächte ein zweites, vollständiges Chromium mit,
 * rund 150 MB obendrauf für ein Fenster, das der installierte Browser genauso
 * zeichnet. Der Preisabruf braucht ohnehin ein echtes, installiertes Chrome
 * (siehe browser.mjs), also ist eines schon da.
 *
 * Das Fenster ist zugleich der Ein- und Ausschalter: schliesst man es, endet
 * das Programm. Ohne das liefe der Dienst unsichtbar weiter, denn ein eigenes
 * Konsolenfenster hat die EXE nicht mehr.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { findBrowser } from './browser.mjs';

/**
 * Eigenes Profil für das Programmfenster.
 *
 * Getrennt vom Profil des Preisabrufs (browser.mjs): jenes läuft mit
 * Debug-Port weit ausserhalb des Bildschirms, dieses ist das sichtbare
 * Fenster. Zwei Rollen, zwei Profile, sonst stört sich beides gegenseitig.
 */
function profilOrdner(datenOrdner) {
  return join(datenOrdner, 'fenster-profil');
}

/**
 * Öffnet das Programmfenster.
 *
 * @returns {{art: 'fenster'|'browser'|'keiner', prozess: import('node:child_process').ChildProcess|null}}
 *   `fenster` = eigenes Fenster, `browser` = Notbehelf im Standardbrowser,
 *   `keiner` = weder noch, der Aufrufer muss es dem Nutzer sagen.
 */
export function oeffneFenster(adresse, datenOrdner, { breite = 1280, hoehe = 860 } = {}) {
  const browser = findBrowser();

  if (browser) {
    const prozess = spawn(
      browser,
      [
        `--app=${adresse}`,
        `--user-data-dir=${profilOrdner(datenOrdner)}`,
        `--window-size=${breite},${hoehe}`,
        // Ein frisches Profil begrüsst sonst mit Einrichtungsassistent und der
        // Frage nach dem Standardbrowser, in einem Programmfenster deplatziert.
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
      ],
      { stdio: 'ignore' }
    );
    return { art: 'fenster', prozess };
  }

  // Kein Chrome und kein Edge: dann wenigstens der Standardbrowser. Der
  // Preisabruf geht so zwar nicht, die Linkliste aber schon.
  try {
    if (process.platform === 'win32') {
      // Das leere Argument ist der Fenstertitel, den start erwartet, ohne ihn
      // liest start die Adresse als Titel und öffnet nichts.
      spawn('cmd', ['/c', 'start', '', adresse], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [adresse], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [adresse], { detached: true, stdio: 'ignore' }).unref();
    }
    return { art: 'browser', prozess: null };
  } catch {
    return { art: 'keiner', prozess: null };
  }
}
