/**
 * Schutzpakete fuer ein bestimmtes Fahrzeug abrufen.
 *
 * Das ist der Schritt, der den Vergleich erst ehrlich macht: der Listenpreis
 * sagt wenig, solange die Selbstbeteiligung offen ist. Ein Angebot fuer
 * 356 Euro mit 1.100 Euro Selbstbeteiligung ist etwas anderes als eines fuer
 * 420 Euro ohne.
 *
 * Ablauf: normale Suche, die Kachel mit dem gewuenschten ACRISS-Code
 * anklicken, "Weiter", dann die Schutzpakete auslesen.
 *
 * Die Checkout-Seite haengt an einer Sitzung (zen_session_id) und laesst sich
 * nicht direkt aufrufen, der Weg ueber die Klicks ist also nicht Bequemlichkeit,
 * sondern noetig.
 */

import { withPage, neueKassenseite, dismissConsent, dismissPopups } from '../browser.mjs';
import { mwtParseAmount } from './offer-parse.mjs';

/** Waehrung aus dem Text lesen; der uebergebene Wert ist nur Rueckfall. */
const CUR_RE = /(€|£|\$|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|zł|Kč)/;
function erkenneWaehrung(text, rueckfall) {
  const m = text.match(CUR_RE);
  if (!m) return rueckfall || '';
  const z = m[0];
  if (z === '€') return 'EUR';
  if (z === '£') return 'GBP';
  if (z === '$') return 'USD';
  return z.toUpperCase();
}

const TILE = '[data-testid="rent-offer-list-tile"]';
const CTA =
  '[data-testid="rent-search-form-cta"] button, [data-testid="rent-minimized-form-cta"] button';
const WEITER = '[data-testid="rent-offer-list-offer-snapshot-cta"]';
const SCHUTZ = '[data-testid="rent-checkout-protection-packages-form"]';

/**
 * Zeilen, die eine Selbstbeteiligung beschreiben, in jeder Sprache anders.
 * Fehlt eine Sprache, landet das Paket im falschen Fach: auf der franzoesischen
 * Seite wurde "Protection Basique" als SB-frei einsortiert, weil "franchise"
 * hier fehlte.
 */
const SB_RE = /(selbstbeteiligung|deductible|excess|franquicia|franchigia|franchise|eigen risico)/i;
const OHNE_SB_RE =
  /(keine selbstbeteiligung|no deductible|no excess|sin franquicia|nessuna franchigia|sans franchise|aucune franchise|geen eigen risico)/i;

/**
 * Den Textblock eines Schutzpakets zerlegen.
 *
 * Aufbau laut Seite (DE):
 *   Basic-Schutz | rating | Selbstbeteiligung: bis 1.100,00 € | <Leistungen…> | 9€00 | 9,00€/ Tag
 * Bei Rabatt zusaetzlich ein durchgestrichener Preis dahinter.
 */
export function parseSchutzBlock(zeilen, waehrung) {
  const z = zeilen.map((s) => s.trim()).filter(Boolean);
  if (!z.length) return null;

  const name = z[0];
  const text = z.join(' ');

  // Selbstbeteiligung
  let selbstbeteiligung = null;
  let sbBetrag = null;
  if (OHNE_SB_RE.test(text)) {
    selbstbeteiligung = 'keine';
    sbBetrag = 0;
  } else {
    const sbZeile = z.find((l) => SB_RE.test(l));
    if (sbZeile) {
      selbstbeteiligung = sbZeile.replace(/^[^:]*:\s*/, '').trim();
      sbBetrag = mwtParseAmount(sbZeile);
    }
  }

  // Preise: nur Zeilen mit Schraegstrich sind Tagespreise. Die erste ist der
  // gueltige Preis, eine zweite waere der durchgestrichene Listenpreis.
  const tagesPreise = z
    .filter((l) => l.includes('/') && /\d/.test(l))
    .map((l) => mwtParseAmount(l))
    .filter((v) => v != null);

  const inklusive =
    /inklusive|included|incluido|incluso|inclus|inbegrepen/i.test(text) && !tagesPreise.length;

  const rabatt = (text.match(/-\s?(\d{1,2})\s?%/) || [])[1];

  return {
    name,
    selbstbeteiligung,
    sbBetrag,
    proTag: inklusive ? 0 : (tagesPreise[0] ?? null),
    statt: tagesPreise.length > 1 ? Math.max(...tagesPreise) : null,
    rabattProzent: rabatt ? Number(rabatt) : null,
    inklusive,
    waehrung: erkenneWaehrung(text, waehrung),
  };
}

/**
 * Die Pakete stehen als ein Textblock im Formular. Getrennt wird an den
 * Paketnamen, daran, dass eine Zeile "…-Schutz", "…protection" o.ae. heisst
 * und die naechste "rating" ist. Letzteres ist Sixts Bewertungs-Widget und
 * steht zuverlaessig unter jedem Paketnamen.
 */
export function teileSchutzpakete(zeilen) {
  const bloecke = [];
  let aktuell = null;
  for (let i = 0; i < zeilen.length; i++) {
    const naechste = (zeilen[i + 1] || '').trim().toLowerCase();
    if (naechste === 'rating') {
      if (aktuell) bloecke.push(aktuell);
      aktuell = [zeilen[i]];
      i++; // "rating" ueberspringen
      continue;
    }
    if (aktuell) aktuell.push(zeilen[i]);
  }
  if (aktuell) bloecke.push(aktuell);
  return bloecke;
}

/**
 * Der mitlaufende Gesamtpreis auf der Checkout-Seite.
 *
 * Das ist die einzige belastbare Zahl. Der je Paket angezeigte Tagespreis
 * laesst sich NICHT hochrechnen: gemessen zeigte Sixt fuer Smart-Schutz
 * 10,77 EUR/Tag an, waehrend der Gesamtpreis bei vier Tagen um 54,22 EUR
 * stieg, also 13,56 EUR je Tag. Wer multipliziert, liegt daneben.
 */
export function liesGesamtpreis(page) {
  // Mit eigenem Zeitlimit. page.evaluate hat in Playwright KEINES, auch nicht
  // ueber setDefaultTimeout. Bei einem gedrosselten Hintergrundreiter kommt
  // die Antwort nie, und ohne dieses Rennen haengt der ganze Dienst daran.
  return Promise.race([
    page.evaluate(() => {
      const marke = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && /Gesamt:|Total:|Totale:|Total :/i.test(e.textContent)
      );
      const text = marke?.closest('div,section,aside')?.innerText || '';

      // Zeilenweise auswerten. Ueber Zeilen hinweg zu suchen war ein Fehler:
      // Sixt zeigt denselben Betrag zweimal, einmal als "411€94" und einmal
      // als "411,94€". Ein Muster, das Leerraum als Tausendertrenner zulaesst,
      // klebt das Ende der einen an den Anfang der naechsten Zeile und liest
      // 94411,94 statt 411,94.
      for (const zeile of text.split('\n')) {
        if (!/[€£$]|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY/i.test(zeile)) continue;
        // Zwei Formen noetig. Mit Tausendertrenner ("1.084,66") greift die
        // erste, ohne ihn ("1025,85") nur die zweite. Fehlte die zweite,
        // rutschte die Erkennung eine Stelle weiter und las "025,85", aus
        // 1025,85 wurde 25,85. Genau so entstanden die 33,24 EUR auf der
        // spanischen Seite, wo Tausender ohne Punkt geschrieben werden.
        const m = zeile.match(/\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2}/);
        if (!m) continue;
        const roh = m[0];
        const sep = Math.max(roh.lastIndexOf('.'), roh.lastIndexOf(','));
        const wert = Number(roh.slice(0, sep).replace(/[.,]/g, '') + '.' + roh.slice(sep + 1));
        if (Number.isFinite(wert)) return wert;
      }
      return null;
    }),
    new Promise((r) => setTimeout(() => r(null), 8000)),
  ]);
}

/** Warten, bis sich der Gesamtpreis nach einem Klick beruhigt hat. */
export async function wartAufGesamt(page, vorher) {
  const bis = Date.now() + 8000;
  let letzter = vorher;
  let gleich = 0;
  while (Date.now() < bis && gleich < 2) {
    await page.waitForTimeout(350);
    const jetzt = await liesGesamtpreis(page).catch(() => null);
    if (jetzt != null && jetzt === letzter) gleich++;
    else gleich = 0;
    letzter = jetzt ?? letzter;
  }
  return letzter;
}

/**
 * Auf einer offengehaltenen Kassenseite ein Paket auswaehlen.
 *
 * Wird gerufen, wenn jemand in TRACKER auf einen Schutzpreis klickt, um dort
 * weiterzubuchen. Zurueck kommt der Gesamtpreis, den die Seite JETZT zeigt,
 * damit die Oberflaeche ihn gegen den gemessenen halten kann. Weicht er ab,
 * soll das dastehen und nicht stillschweigend durchgehen.
 */
export async function waehleSchutzpaket(page, index) {
  // Erst den Reiter aktivieren. Alle Kassenseiten liegen in einem Fenster, und
  // Chrome drosselt Hintergrundreiter so stark, dass Klick und Auswertung dort
  // nicht mehr durchlaufen. Genau daran blieb der Aufruf einmal endlos haengen.
  await page.bringToFront().catch(() => {});
  const vorher = await liesGesamtpreis(page).catch(() => null);
  await page
    .locator(`${SCHUTZ} label`)
    .nth(index)
    .locator('input[type=radio]')
    .click({ timeout: 10000, force: true });
  return wartAufGesamt(page, vorher);
}

/** Steht die Kasse noch, oder ist die Sitzung abgelaufen? */
export async function kasseLebt(page) {
  if (page.isClosed()) return false;
  return page
    .locator(SCHUTZ)
    .first()
    .isVisible({ timeout: 4000 })
    .catch(() => false);
}

/**
 * @param {object} q  wie quoteSixt, zusaetzlich:
 * @param {string} q.acriss  gewuenschte Fahrzeugklasse, z.B. "CDAR"
 * @param {boolean} [q.offenhalten]  Kassenseite nach dem Abruf offen lassen,
 *   damit man auf ihr weiterbuchen kann
 */
export async function quoteSchutz(q) {
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

  const ablauf = async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // waitForFunction(fn, arg, options). Optionen an dritter Stelle.
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

    // Dieselbe Behandlung wie beim Preisabruf: Banner-Pruefung parallel zum
    // Warten auf die Station, und ein Neuladeversuch. Laufen mehrere Abrufe
    // gleichzeitig, braucht die Seite deutlich laenger, genau daran sind
    // hier sixt.fr und sixt.es gescheitert.
    let [bereit] = await Promise.all([stationDa(), dismissConsent(page, { timeout: 2500 })]);
    if (!bereit) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await dismissConsent(page, { timeout: 2500 });
      bereit = await stationDa();
    }

    if (!bereit) {
      return {
        ok: false,
        verfuegbar: false,
        error: 'Station wurde nicht übernommen',
        ms: Date.now() - started,
      };
    }

    await page.waitForTimeout(250);
    // Dasselbe Werbefenster wie beim Preisabruf, hier faengt es den Klick auf
    // "Suchen" genauso ab.
    await dismissPopups(page);

    try {
      await page.locator(CTA).first().click({ timeout: 12000 });
    } catch {
      await page.evaluate((sel) => document.querySelector(sel)?.click(), CTA).catch(() => {});
    }

    const kamen = await page
      .waitForSelector(TILE, { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    if (!kamen) {
      const text = await page.locator('body').innerText().catch(() => '');
      return {
        ok: false,
        error: /access denied|blocked/i.test(text) ? 'Zugriff blockiert' : 'Trefferliste kam nicht',
        ms: Date.now() - started,
      };
    }
    await page.waitForTimeout(1800);

    // Kachel mit dem gewuenschten ACRISS-Code oeffnen.
    const gefunden = await page.evaluate(
      ({ sel, acriss }) => {
        const t = [...document.querySelectorAll(sel)].find((x) =>
          (x.getAttribute('data-offer-id') || '').toUpperCase().startsWith(acriss)
        );
        if (!t) return false;
        t.click();
        return true;
      },
      { sel: TILE, acriss: q.acriss.toUpperCase() }
    );

    if (!gefunden) {
      return { ok: true, verfuegbar: false, note: 'Klasse aktuell nicht buchbar', ms: Date.now() - started };
    }

    const weiter = await page
      .waitForSelector(WEITER, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!weiter) return { ok: false, error: 'Weiter-Schaltfläche fehlt', ms: Date.now() - started };

    await page.locator(WEITER).first().click({ timeout: 10000 }).catch(() => {});

    const da = await page
      .waitForSelector(SCHUTZ, { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (!da) return { ok: false, error: 'Schutzpakete kamen nicht', ms: Date.now() - started };

    await page.waitForTimeout(1200);

    const liesGesamt = () => liesGesamtpreis(page);
    const gesamtNachKlick = (vorher) => wartAufGesamt(page, vorher);

    // Die Pakete stehen als <label> mit einem Radio darin.
    const paketLabels = await page.$$eval(`${SCHUTZ} label`, (ls) =>
      ls
        .map((l, i) => ({ i, radio: Boolean(l.querySelector('input[type=radio]')), text: l.innerText }))
        .filter((x) => x.radio)
    );

    const basis = await liesGesamt().catch(() => null);
    const pakete = [];

    for (const eintrag of paketLabels) {
      const block = parseSchutzBlock(eintrag.text.split('\n'), q.currency);
      if (!block || !block.name) continue;

      let gesamt = null;
      try {
        await page
          .locator(`${SCHUTZ} label`)
          .nth(eintrag.i)
          .locator('input[type=radio]')
          .click({ timeout: 8000, force: true });
        gesamt = await gesamtNachKlick(basis);
      } catch {
        /* Paket liess sich nicht waehlen, dann bleibt gesamt leer */
      }

      pakete.push({
        ...block,
        // Die Stelle im Formular, damit dasselbe Paket spaeter auf der
        // offengehaltenen Seite wieder angeklickt werden kann.
        i: eintrag.i,
        // Abgelesen, nicht gerechnet.
        gesamt,
        // Was der Schutz tatsaechlich kostet: Differenz zur reinen Miete.
        aufschlag: gesamt != null && basis != null ? Number((gesamt - basis).toFixed(2)) : null,
      });
    }

    return {
      ok: true,
      verfuegbar: true,
      acriss: q.acriss,
      mieteOhneSchutz: basis,
      pakete,
      url: page.url(),
      ms: Date.now() - started,
    };
  };

  // Der uebliche Weg: Wegwerf-Tab, der danach zugeht.
  if (!q.offenhalten) {
    return withPage({ host: q.host, sichtbar: q.sichtbar, inkognito: q.inkognito }, ablauf);
  }

  // Offenhalten: eigenes, verstecktes Fenster, das den Abruf ueberlebt. Der
  // Aufrufer bekommt die Seite mit und ist ab dann fuer ihr Ende zustaendig.
  // Nur wenn wirklich Pakete herauskamen, lohnt das Offenhalten; sonst ist die
  // Seite nur Speicher ohne Nutzen und geht sofort wieder zu.
  const kasse = await neueKassenseite({ host: q.host, inkognito: q.inkognito });
  try {
    const r = await ablauf(kasse.page);
    if (r.ok && r.verfuegbar && r.pakete?.length) {
      return { ...r, kasse };
    }
    await kasse.page.close().catch(() => {});
    return r;
  } catch (e) {
    await kasse.page.close().catch(() => {});
    throw e;
  }
}
