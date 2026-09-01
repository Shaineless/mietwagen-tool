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
