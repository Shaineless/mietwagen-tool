// Erzeugt von build.mjs aus src/offer-parse.js — nicht direkt bearbeiten.

/**
 * Angebotskacheln in Datensaetze uebersetzen.
 *
 * EINZIGE QUELLE fuer diese Logik. build.mjs erzeugt daraus zwei Kopien:
 *   - extension/content.js   (laeuft im Browser des Nutzers)
 *   - tools/scrape/offer-parse.mjs (fuer Node)
 * Bitte nur hier aendern.
 *
 * Absichtlich textbasiert statt ueber CSS-Klassen: Sixts Klassennamen sind
 * generiert (sc-79f1dc24-8) und wechseln bei jedem Deploy. Der sichtbare Text
 * einer Kachel ist deutlich langlebiger.
 */

/** Waehrungszeichen, die auf den Laenderseiten vorkommen. */
const MWT_CUR_RE = /(€|£|\$|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|zł|Kč|Ft|kr)/i;

/**
 * Betrag aus einer Zeile ziehen.
 *
 * Faengt beide Schreibweisen ab: "1.234,56 €" (de) und "£1,234.56" (uk).
 * Das jeweils letzte Trennzeichen ist das Dezimaltrennzeichen.
 *
 * Zeilen wie "134€49" — Sixts optisch aufgehuebschte Dopplung, bei der das
 * Waehrungszeichen zwischen den Ziffern steht — werden bewusst NICHT erkannt:
 * es gibt sie immer zusaetzlich in sauberer Form, und ein Fehlgriff hier
 * verfaelscht still den Preis.
 */
function mwtParseAmount(line) {
  const m = line.match(/\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2}|\d+[.,]\d{2}/);
  if (!m) return null;

  const raw = m[0].replace(/\s/g, '');
  const lastSep = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
  if (lastSep < 0) return null;

  const whole = raw.slice(0, lastSep).replace(/[.,]/g, '');
  const frac = raw.slice(lastSep + 1);
  const value = Number(`${whole}.${frac}`);
  return Number.isFinite(value) ? value : null;
}

/** Eine Kachel (als Zeilenliste) in einen Datensatz uebersetzen. */
function mwtParseTile(lines, fallbackCurrency) {
  const clean = lines.map((s) => s.trim()).filter(Boolean);
  if (!clean.length) return null;

  const amounts = [];
  for (const line of clean) {
    if (!MWT_CUR_RE.test(line)) continue;
    const value = mwtParseAmount(line);
    if (value == null) continue;
    // Der Tagespreis ist die Zeile mit dem Schraegstrich ("134,49€/Tag").
    amounts.push({ value, perDay: line.includes('/') });
  }
  if (!amounts.length) return null;

  const perDay = amounts.find((a) => a.perDay)?.value ?? null;
  const totals = amounts.filter((a) => !a.perDay).map((a) => a.value);
  const total = totals.length ? Math.max(...totals) : null;

  let currency = (clean.join(' ').match(MWT_CUR_RE) || [])[0] || fallbackCurrency || '';
  if (currency === '€') currency = 'EUR';
  else if (currency === '£') currency = 'GBP';
  else if (currency === '$') currency = 'USD';
  else currency = String(currency).toUpperCase();

  const category = clean[1] || '';
  return {
    model: clean[0],
    category,
    transmission: /automat/i.test(category)
      ? 'Automatik'
      : /manuell|manual|schalt|manuale|manuelle/i.test(category)
        ? 'Schaltung'
        : null,
    unlimitedKm: clean.some((l) => /unbegrenzt|unlimited|ilimitad|illimit|onbeperkt/i.test(l)),
    guaranteedModel: !clean.some((l) => /ähnlich|similar|simile|similaire|vergelijkbaar/i.test(l)),
    perDay,
    total,
    currency,
  };
}


/**
 * Content-Script — laeuft auf den Sixt-Laenderseiten.
 *
 * Aufgabe: auf einer Trefferliste, die der Nutzer ohnehin geoeffnet hat, die
 * Preise ablesen und an das lokal laufende Preistool weiterreichen.
 *
 * Wichtig zum Verstaendnis: hier wird nichts erschlichen. Die Seite laeuft in
 * der echten Browsersitzung des Nutzers, mit seinem Profil, in einem Tab, den
 * er selbst geoeffnet hat. Das Script liest nur ab, was ohnehin auf dem
 * Bildschirm steht.
 *
 * Ablauf:
 *   1. Landet die Seite mit ?mwt=<key>, wird der Schluessel fuer diesen Tab
 *      gemerkt (sessionStorage) — die Suche wechselt gleich auf
 *      /betafunnel/#/offerlist und wirft den Query-String weg.
 *   2. Sobald die Suchmaske befuellt ist, wird die Suche ausgeloest.
 *   3. Sobald Kacheln da sind und sich die Anzahl beruhigt hat, wird gelesen
 *      und an localhost geschickt.
 *
 * Die Parserfunktionen (mwtParseTile, mwtParseAmount) stehen darueber —
 * build.mjs setzt sie aus src/offer-parse.js davor.
 */

(() => {
  const TILE = '[data-testid="rent-offer-list-tile"]';
  const CTA =
    '[data-testid="rent-search-form-cta"] button, [data-testid="rent-minimized-form-cta"] button';
  const KEY_STORE = 'mwt:key';

  /* ------------------------------------------------- Auftragsschluessel */

  const fromUrl = new URLSearchParams(location.search).get('mwt');
  if (fromUrl) {
    try {
      sessionStorage.setItem(KEY_STORE, fromUrl);
    } catch {
      /* egal, dann eben ohne Zuordnung */
    }
  }

  function jobKey() {
    if (fromUrl) return fromUrl;
    try {
      return sessionStorage.getItem(KEY_STORE);
    } catch {
      return null;
    }
  }

  // Ohne Auftragsschluessel ist dies ein normaler Besuch des Nutzers.
  // Dann hat das Script hier nichts verloren.
  if (!jobKey()) return;

  /* ------------------------------------------------- Hilfen */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(payload) {
    chrome.runtime.sendMessage({ type: 'mwt:offers', payload }, () => {
      // Fehler bewusst schlucken: laeuft das Preistool gerade nicht, ist das
      // kein Grund, im Tab des Nutzers etwas kaputtzumachen.
      void chrome.runtime.lastError;
    });
  }

  /** Cookie-Banner ablehnen, falls er im Weg steht. */
  function denyConsent() {
    const host = document.querySelector('#usercentrics-cmp-ui');
    const roots = host?.shadowRoot ? [document, host.shadowRoot] : [document];
    for (const root of roots) {
      const btn = root.querySelector('button.uc-deny-button, button#deny');
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  /** Warten, bis `test()` wahr wird — oder aufgeben. */
  async function until(test, { timeout = 40000, step = 400 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (test()) return true;
      } catch {
        /* weiter versuchen */
      }
      await sleep(step);
    }
    return false;
  }

  /* ------------------------------------------------- Ablauf */

  async function run() {
    await until(() => document.readyState !== 'loading', { timeout: 10000 });

    // Banner kommt nachgeladen; ein paar Anlaeufe geben.
    for (let i = 0; i < 12 && !denyConsent(); i++) await sleep(500);

    const onOfferList = () => document.querySelector(TILE);

    if (!onOfferList()) {
      // Suchmaske: warten bis die Station aus den URL-Parametern steht,
      // sonst startet die Suche ins Leere.
      const ready = await until(() => {
        const i = document.querySelector('input[name="pickupLocation"]');
        return i && i.value.trim().length > 0;
      }, { timeout: 30000 });

      if (!ready) {
        send({ key: jobKey(), host: location.host, url: location.href, error: 'Station wurde nicht übernommen' });
        return;
      }

      denyConsent();
      await sleep(400);

      const cta = document.querySelector(CTA);
      if (!cta) {
        send({ key: jobKey(), host: location.host, url: location.href, error: 'Suchen-Schaltfläche nicht gefunden' });
        return;
      }
      cta.click();
    }

    const gotTiles = await until(onOfferList, { timeout: 60000 });

    if (!gotTiles) {
      const text = document.body?.innerText || '';
      const blocked = /access denied|request has been blocked/i.test(text);
      const soldOut = /keine.*verfügbar|nicht verfügbar|no.*available|sold out/i.test(text);
      send({
        key: jobKey(),
        host: location.host,
        url: location.href,
        error: blocked
          ? 'Zugriff von der Seite blockiert'
          : soldOut
            ? 'keine Fahrzeuge verfügbar'
            : 'Trefferliste kam nicht',
      });
      return;
    }

    // Die Liste laedt nach. Warten, bis die Anzahl zweimal hintereinander gleich bleibt.
    let last = -1;
    let stable = 0;
    while (stable < 2) {
      await sleep(1200);
      const n = document.querySelectorAll(TILE).length;
      stable = n === last ? stable + 1 : 0;
      last = n;
    }

    const offers = [...document.querySelectorAll(TILE)]
      .map((n) => mwtParseTile(n.innerText.split('\n')))
      .filter((o) => o && (o.perDay != null || o.total != null));

    const stationEl = document.querySelector('input[name="pickupLocation"]');

    send({
      key: jobKey(),
      host: location.host,
      url: location.href,
      station: stationEl ? stationEl.value : null,
      offers,
      at: Date.now(),
    });
  }

  run().catch((e) =>
    send({ key: jobKey(), host: location.host, url: location.href, error: String(e).slice(0, 200) })
  );
})();
