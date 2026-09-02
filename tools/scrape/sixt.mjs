/**
 * Preisabruf fuer Sixt.
 *
 * Ablauf je Anfrage: Laenderseite mit vorbelegten Suchparametern oeffnen,
 * Cookie-Banner ablehnen, warten bis die Maske aus den URL-Parametern befuellt
 * ist, Suche ausloesen, Trefferliste abwarten, Kacheln auslesen.
 *
 * Angesprochen wird alles ueber `data-testid`-Haken und Textmuster, nicht ueber
 * CSS-Klassen: die Klassennamen sind generiert (sc-79f1dc24-8) und wechseln bei
 * jedem Deploy.
 *
 * Geprueft gegen sixt.de und sixt.co.uk, beide Sprachen, beide Zahlenformate.
 */

import { withPage, dismissConsent, dismissPopups } from '../browser.mjs';
import { mwtParseTile } from './offer-parse.mjs';

const TILE = '[data-testid="rent-offer-list-tile"]';
/** Sixts eigene Meldung, dass es fuer diese Suche nichts gibt. */
const LEER = '[data-testid="rent-offer-list-error"]';
const CTA =
  '[data-testid="rent-search-form-cta"] button, [data-testid="rent-minimized-form-cta"] button';

/**
 * @param {object} q
 * @param {string} q.host        z.B. "www.sixt.es"
 * @param {string} q.stationCode numerische Sixt-Stations-ID (uci)
 * @param {string} [q.returnCode]
 * @param {string} q.pickupDate  yyyy-mm-dd
 * @param {string} q.returnDate  yyyy-mm-dd
 * @param {string} q.pickupTime  hh:mm
 * @param {string} q.returnTime  hh:mm
 * @param {string} [q.currency]  Rueckfallwert, falls die Seite keins zeigt
 * @param {boolean} [q.sichtbar] Browserfenster anzeigen statt verstecken
 * @param {boolean} [q.inkognito] Ohne Cookies abrufen, wie ein Erstbesucher
 */
export async function quoteSixt(q) {
  const p = new URLSearchParams({
    uci: String(q.stationCode),
    rci: String(q.returnCode || q.stationCode),
    uda: q.pickupDate.replaceAll('-', ''),
    rda: q.returnDate.replaceAll('-', ''),
    uti: q.pickupTime.replace(':', ''),
    rti: q.returnTime.replace(':', ''),
    ctyp: 'P',
  });
  const url = `https://${q.host}/?${p.toString()}`;
  const started = Date.now();

  return withPage({ host: q.host, sichtbar: q.sichtbar, inkognito: q.inkognito }, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Die Maske wird clientseitig aus den URL-Parametern befuellt. Erst danach
    // darf die Suche los, sonst sucht sie mit leerer Station.
    //
    // Grosszuegiges Zeitfenster und ein Neuladeversuch: laufen mehrere Abrufe
    // parallel, braucht die Seite deutlich laenger als allein. Genau daran ist
    // sixt.at im Zweierbetrieb gescheitert, waehrend es einzeln nach drei
    // Sekunden stand.
    // waitForFunction(fn, arg, options), die Optionen gehoeren an die dritte
    // Stelle, sonst greift still der Vorgabe-Timeout.
    const stationDa = () =>
      page
        .waitForFunction(
          () => {
            const i = document.querySelector('input[name="pickupLocation"]');
            return i && i.value.trim().length > 0;
          },
          undefined,
          { timeout: 40000, polling: 100 }
        )
        .then(() => true)
        .catch(() => false);

    // Beides gleichzeitig: der Banner blockiert nur den spaeteren Klick, und
    // das Warten auf die Station ist ohnehin der laengere Weg. Nacheinander
    // kostete das drei Sekunden je Abruf fuer nichts.
    let [bereit] = await Promise.all([stationDa(), dismissConsent(page, { timeout: 2500 })]);
    if (!bereit) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await dismissConsent(page, { versuche: 4 });
      bereit = await stationDa();
    }

    const station = await page
      .locator('input[name="pickupLocation"]')
      .first()
      .inputValue()
      .catch(() => '');

    if (!bereit || !station) {
      return { ok: false, error: 'Station wurde nicht übernommen', url, ms: Date.now() - started };
    }

    // Auf manchen Laenderseiten (sixt.es) bleibt die Banner-Huelle nach dem
    // Ablehnen im DOM stehen und faengt weiter Klicks ab, dafuer gibt es
    // unten den Rueckfall auf einen direkten DOM-Klick.
    await page.waitForTimeout(250);
    // Werbefenster wegklicken, bevor der Klick auf "Suchen" darin haengen
    // bleibt. Ohne das lief der regulaere Klick erst zwoelf Sekunden in einen
    // Timeout, bevor der Notklick uebernahm.
    await dismissPopups(page);

    let geklickt = false;
    try {
      await page.locator(CTA).first().click({ timeout: 12000 });
      geklickt = true;
    } catch {
      // Rueckfall: direkt im DOM klicken. Umgeht die Huelle, ohne dass die
      // Seite etwas anderes zu sehen bekommt als einen Klick auf ihren Knopf.
      geklickt = await page
        .evaluate((sel) => {
          const b = document.querySelector(sel);
          if (!b) return false;
          b.click();
          return true;
        }, CTA)
        .catch(() => false);
    }

    if (!geklickt) {
      return { ok: false, station, error: 'Suche ließ sich nicht auslösen', url, ms: Date.now() - started };
    }

    // Auf beides zugleich warten: die Angebotskacheln *oder* Sixts eigene
    // Meldung, dass es an dem Tag nichts gibt.
    //
    // Vorher lief hier nur der Timeout auf die Kacheln, 60 Sekunden lang.
    // Eine ausgebuchte Station kostete damit 65 Sekunden statt 6, kam als
    // Fehler zurueck und wurde anschliessend dreimal wiederholt: ueber vier
    // Minuten fuer einen Tag, an dem es schlicht nichts zu holen gab.
    //
    // `rent-offer-list-error` ist Sixts eigenes Merkmal fuer diesen Fall und
    // damit unabhaengig von der Sprache der Laenderseite. Gemessen an
    // Frankfurt Zentrum/Zeil, 04.09.2026: dort steht "Wir konnten keine
    // passenden Fahrzeuge finden" — kein Wort, nach dem die alte Textsuche
    // gefahndet hat.
    const ausgang = await Promise.race([
      page.waitForSelector(TILE, { timeout: 60000 }).then(() => 'liste').catch(() => 'nichts'),
      page.waitForSelector(LEER, { timeout: 60000 }).then(() => 'leer').catch(() => 'nichts'),
    ]);

    if (ausgang !== 'liste') {
      const text = await page.locator('body').innerText().catch(() => '');
      const blockiert = /access denied|request has been blocked/i.test(text);
      // Merkmal im Seitengeruest, sonst noch die Formulierungen als Rueckfall.
      const ausgebucht =
        ausgang === 'leer' ||
        /keine.*(verfügbar|gefunden|finden)|nicht verfügbar|no.*available|sold out|tut uns leid/i.test(text);
      return {
        ok: ausgebucht,
        station,
        offers: [],
        error: blockiert
          ? 'Zugriff von der Seite blockiert'
          : ausgebucht
            ? null
            : 'Trefferliste kam nicht',
        note: ausgebucht ? 'An diesem Tag bietet die Station nichts an' : null,
        url: page.url(),
        ms: Date.now() - started,
      };
    }

    // Die Liste laedt nach. Kuerzer takten und frueher zufrieden sein: zwei
    // gleiche Messungen im Abstand von 500ms genuegen, das spart gegenueber
    // 1200ms rund zwei Sekunden je Abruf.
    let letzte = -1;
    let stabil = 0;
    const bis = Date.now() + 12000;
    while (stabil < 2 && Date.now() < bis) {
      await page.waitForTimeout(500);
      const n = await page.locator(TILE).count();
      stabil = n === letzte ? stabil + 1 : 0;
      letzte = n;
    }

    // Neben dem sichtbaren Text tragen die Kacheln zwei Schaetze:
    //   data-offer-id="CDAR-110-110"  -> ACRISS-Code, sprachunabhaengig
    //   ein Fahrzeugbild auf transparentem Grund
    const roh = await page.$$eval(TILE, (nodes) =>
      nodes.map((n) => ({
        lines: n.innerText.split('\n'),
        offerId: n.getAttribute('data-offer-id') || '',
        image: [...n.querySelectorAll('img')].find((i) => i.alt)?.src || '',
      }))
    );

    const offers = roh
      .map((r) => mwtParseTile(r, q.currency))
      .filter((o) => o && (o.perDay != null || o.total != null));

    // Stimmigkeitspruefung: der Gesamtpreis muss zum Tagespreis mal Mietdauer
    // passen. Zwei Mal ist ein Zahlenformat still danebengegangen, spanische
    // Betraege ohne Tausendertrenner, danach Schweizer mit Apostroph, und
    // beide Male stand einfach eine falsche Zahl in der Tabelle. Eine Ziffer
    // zu verlieren ist schlimmer als gar nichts zu lesen, deshalb wird das
    // hier gemeldet statt hingenommen.
    const tage = Math.max(
      1,
      Math.round(
        (new Date(q.returnDate + 'T12:00:00') - new Date(q.pickupDate + 'T12:00:00')) / 86400000
      )
    );
    const unstimmig = [];
    for (const o of offers) {
      if (o.total == null || o.perDay == null) continue;
      const soll = o.perDay * tage;
      if (soll > 0 && Math.abs(o.total - soll) / soll > 0.02) {
        o.unstimmig = true;
        unstimmig.push(`${o.acriss || '?'} ${o.total} statt ~${soll.toFixed(2)}`);
      }
    }

    return {
      ok: true,
      station,
      offers,
      // Nur melden, wenn wirklich etwas nicht stimmt, sonst steht in jedem
      // Ergebnis ein leeres Feld herum.
      ...(unstimmig.length
        ? {
            warnung:
              `${unstimmig.length} von ${offers.length} Preisen passen nicht zum Tagespreis ` +
              `(${unstimmig.slice(0, 3).join(', ')}), vermutlich ein unbekanntes Zahlenformat.`,
          }
        : {}),
      url: page.url(),
      ms: Date.now() - started,
    };
  });
}
