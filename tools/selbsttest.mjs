/**
 * Selbsttest für einen fremden Rechner.
 *
 * Auf dem Rechner, auf dem etwas entsteht, läuft es immer. Interessant ist der
 * andere: dort kann Chrome fehlen, der Datenordner schreibgeschützt sein, eine
 * Firewall dazwischenfunken, der Cookie-Banner anders aussehen oder Sixt die
 * Sitzung abweisen. Ohne Prüfung merkt der Nutzer das erst an einer leeren
 * Tabelle, und weiss dann nicht, woran es lag.
 *
 * Der Test geht die Kette von unten nach oben durch und hält beim ersten
 * echten Bruch an. Weiterzumachen wäre sinnlos: ohne Browser kein Abruf, und
 * jede Folgemeldung wäre nur eine Wiederholung derselben Ursache.
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { findBrowser, closeBrowser } from './browser.mjs';
import { quoteSixt } from './scrape/sixt.mjs';
import { datenOrdner } from './pfade.mjs';

/** Ein Termin weit genug voraus, dass es an jeder Station Angebote gibt. */
function testTermin() {
  const ab = new Date();
  ab.setDate(ab.getDate() + 30);
  const bis = new Date(ab);
  bis.setDate(bis.getDate() + 3);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { pickupDate: iso(ab), returnDate: iso(bis) };
}

/**
 * Länderseiten für den erweiterten Test.
 *
 * Genau diese drei, weil dort die SIXT-ONE-Fenster aufgehen, die
 * dismissPopups() wegräumen muss. Das ist die Stelle, an der ein fremder
 * Rechner am ehesten anders reagiert als der, auf dem entwickelt wurde,
 * andere Sprache, anderer Banner, andere Zufallsauswahl.
 */
export const WEITERE_SEITEN = [
  { host: 'www.sixt.fr', label: 'Frankreich', cur: 'EUR' },
  { host: 'www.sixt.es', label: 'Spanien', cur: 'EUR' },
  { host: 'www.sixt.it', label: 'Italien', cur: 'EUR' },
];

/**
 * Eine einzelne Länderseite prüfen.
 *
 * Getrennt von selbsttest(), damit die Oberfläche die Seiten einzeln abrufen
 * und die Schritte zeigen kann, wie sie eintreffen. Ein Endpunkt, der zwei
 * Minuten schweigt und dann alles auf einmal liefert, sieht aus wie ein
 * Absturz.
 */
export async function pruefeSeite({ host, label }) {
  const termin = testTermin();
  try {
    const res = await quoteSixt({
      host,
      stationCode: '110',
      ...termin,
      pickupTime: '10:00',
      returnTime: '10:00',
    });
    if (res.error) {
      return {
        name: label,
        // Eine einzelne Seite, die klemmt, ist kein Bruch der Kette, die
        // anderen liefern ja. Deshalb "mittel", nicht "schlecht".
        stand: 'mittel',
        text: res.error,
        rat:
          'Diese Länderseite kam nicht bis zur Trefferliste. Meist ein Fenster, ' +
          'das anders aussieht als erwartet, oder eine langsame Verbindung. ' +
          'Die übrigen Seiten sind davon nicht betroffen.',
      };
    }
    const n = res.offers?.length ?? 0;
    return n
      ? { name: label, stand: 'gut', text: `${n} Angebote gelesen`, rat: null }
      : {
          name: label,
          stand: 'mittel',
          text: 'Seite geladen, aber kein Angebot gelesen',
          rat: 'Kann am Termin liegen. Bleibt es dabei, hat Sixt dort umgebaut.',
        };
  } catch (e) {
    return {
      name: label,
      stand: 'mittel',
      text: String(e.message).slice(0, 200),
      rat: 'Der Abruf dieser Länderseite ist abgebrochen. Die übrigen sind davon nicht betroffen.',
    };
  }
}

/**
 * @param {(schritt: object) => void} [melde]  wird nach jedem Schritt gerufen
 */
export async function selbsttest(melde = () => {}) {
  const schritte = [];

  const schritt = (name, stand, text, rat = null) => {
    const s = { name, stand, text, rat };
    schritte.push(s);
    melde(s);
    return s;
  };

  /* --- 1. Darf das Programm überhaupt etwas ablegen? --- */
  try {
    await mkdir(datenOrdner, { recursive: true });
    const probe = join(datenOrdner, '.schreibprobe');
    await writeFile(probe, 'ok');
    await unlink(probe);
    schritt('Datenordner', 'gut', datenOrdner);
  } catch (e) {
    schritt(
      'Datenordner',
      'schlecht',
      `Nicht beschreibbar: ${datenOrdner}`,
      'Das Programm in einen Ordner legen, in dem geschrieben werden darf, ' +
        'etwa auf den Desktop statt nach C:\\Programme.'
    );
    return schritte;
  }

  /* --- 2. Gibt es einen Browser? --- */
  const browser = findBrowser();
  if (!browser) {
    schritt(
      'Browser',
      'schlecht',
      'Google Chrome nicht gefunden',
      'Der Preisabruf braucht Google Chrome. Ohne ihn bleibt es beim Erzeugen ' +
        'der Links, die Suche muss dann von Hand geöffnet werden. Edge genügt ' +
        'dafür nicht: es weist den Steuerungszugang ab, den der Abruf braucht.'
    );
    return schritte;
  }
  schritt('Browser', 'gut', browser);

  /* --- 3. Ein echter Abruf, die ganze Kette --- */
  const termin = testTermin();
  let res;
  try {
    res = await quoteSixt({
      host: 'www.sixt.de',
      stationCode: '110', // Frankfurt Flughafen, grösste Station, immer belegt
      ...termin,
      pickupTime: '10:00',
      returnTime: '10:00',
      currency: 'EUR',
    });
  } catch (e) {
    schritt(
      'Verbindung zum Browser',
      'schlecht',
      String(e.message).slice(0, 200),
      'Chrome liess sich nicht starten oder nicht ansprechen. Häufigste ' +
        'Ursachen: eine Sicherheitssoftware blockiert den Debug-Port, oder ' +
        'ein Chrome mit demselben Profil läuft schon. Rechner neu starten ' +
        'und noch einmal versuchen.'
    );
    return schritte;
  }

  schritt('Verbindung zum Browser', 'gut', 'Chrome gestartet und angesprochen');

  /* --- 4. Was ist dabei herausgekommen? --- */
  if (res.error) {
    const rat = /station/i.test(res.error)
      ? 'Die Seite hat die Station nicht übernommen. Das passiert, wenn die ' +
        'Verbindung sehr langsam ist oder der Cookie-Banner anders aussieht ' +
        'als erwartet. Test wiederholen; bleibt es dabei, hat Sixt die Seite ' +
        'umgebaut.'
      : /denied|blocked|zugriff/i.test(res.error)
        ? 'Sixt hat den Zugriff abgewiesen. Meist hilft es, ein paar Minuten ' +
          'zu warten und weniger Länderseiten auf einmal abzufragen.'
        : 'Die Seite kam nicht bis zur Trefferliste. Test wiederholen; ' +
          'bleibt es dabei, stimmt etwas mit der Internetverbindung nicht.';
    schritt('Trefferliste von sixt.de', 'schlecht', res.error, rat);
    return schritte;
  }

  const n = res.offers?.length ?? 0;
  if (!n) {
    schritt(
      'Trefferliste von sixt.de',
      'mittel',
      'Seite geladen, aber kein einziges Angebot gelesen',
      'Die Kette funktioniert bis zur Trefferliste. Dass dort nichts steht, ' +
        'kann am Termin liegen, häufiger hat Sixt den Seitenaufbau geändert ' +
        'und die Angebote sind nicht mehr dort, wo das Werkzeug sie sucht.'
    );
    return schritte;
  }

  schritt(
    'Trefferliste von sixt.de',
    'gut',
    `${n} Angebote gelesen${res.station ? ` · Station: ${res.station}` : ''}` +
      (res.ms ? ` · ${(res.ms / 1000).toFixed(1)} s` : '')
  );

  /* --- 5. Sind die Klassen lesbar? --- */
  const mitAcriss = (res.offers || []).filter((o) => o.acriss).length;
  if (!mitAcriss) {
    schritt(
      'ACRISS-Klassen',
      'mittel',
      'Angebote gefunden, aber keine Klassencodes',
      'Ohne Klassencode lassen sich die Länderseiten nicht sauber ' +
        'gegenüberstellen. Vermutlich hat Sixt den Aufbau der Kacheln geändert.'
    );
  } else {
    schritt('ACRISS-Klassen', 'gut', `${mitAcriss} von ${n} Angeboten mit Code`);
  }

  return schritte;
}

/**
 * Denselben Test von der Kommandozeile: node tools/selbsttest.mjs
 *
 * Bewusst in einer Funktion und nicht als Top-Level-`await`: diese Datei wird
 * in die EXE gebuendelt, und dort gibt es kein Modulformat, das Warten auf
 * oberster Ebene erlaubt. Der Build bricht sonst ab.
 */
if (process.argv[1] && process.argv[1].endsWith('selbsttest.mjs')) {
  (async () => {
    const zeichen = { gut: '✓', mittel: '~', schlecht: '✕' };
    const schritte = await selbsttest((s) => {
      console.log(`${zeichen[s.stand]} ${s.name}: ${s.text}`);
      if (s.rat) console.log(`    ${s.rat}`);
    });
    await closeBrowser();
    process.exit(schritte.some((s) => s.stand === 'schlecht') ? 1 : 0);
  })();
}
