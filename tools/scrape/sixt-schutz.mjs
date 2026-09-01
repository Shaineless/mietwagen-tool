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
 * nicht direkt aufrufen — der Weg ueber die Klicks ist also nicht Bequemlichkeit,
 * sondern noetig.
 */

import { withPage, dismissConsent } from '../browser.mjs';
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

/** Zeilen ohne Zahl, die eine Selbstbeteiligung beschreiben. */
const SB_RE = /(selbstbeteiligung|deductible|excess|franquicia|franchigia)/i;
const OHNE_SB_RE = /(keine selbstbeteiligung|no deductible|sin franquicia|nessuna franchigia)/i;

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

  const inklusive = /inklusive|included|incluido|incluso/i.test(text) && !tagesPreise.length;

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
 * Paketnamen — daran, dass eine Zeile "…-Schutz", "…protection" o.ae. heisst
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
 * @param {object} q  wie quoteSixt, zusaetzlich:
 * @param {string} q.acriss  gewuenschte Fahrzeugklasse, z.B. "CDAR"
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

  return withPage({ host: q.host, sichtbar: q.sichtbar }, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);

    const bereit = await page
      .waitForFunction(
        () => {
          const i = document.querySelector('input[name="pickupLocation"]');
          return i && i.value.trim().length > 0;
        },
        { timeout: 40000 }
      )
      .then(() => true)
      .catch(() => false);

    if (!bereit) return { ok: false, error: 'Station wurde nicht übernommen', ms: Date.now() - started };

    await dismissConsent(page, { versuche: 2 });
    await page
      .waitForFunction(() => !document.querySelector('#usercentrics-cmp-ui'), { timeout: 4000 })
      .catch(() => {});
    await page.waitForTimeout(500);

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
    const zeilen = await page.$eval(SCHUTZ, (n) => n.innerText.split('\n'));

    const pakete = teileSchutzpakete(zeilen)
      .map((b) => parseSchutzBlock(b, q.currency))
      .filter((p) => p && p.name);

    return {
      ok: true,
      verfuegbar: true,
      acriss: q.acriss,
      pakete,
      url: page.url(),
      ms: Date.now() - started,
    };
  });
}
