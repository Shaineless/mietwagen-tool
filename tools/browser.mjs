/**
 * Browser-Verwaltung fuer den Preis-Worker.
 *
 * Warum ein echter Browser und kein simples fetch()? Zwei Gruende:
 *
 *   1. Die Anbieterseiten stehen hinter Bot-Schutz. Ein blankes fetch() aus
 *      Node bekommt von sixt.de zuverlaessig 403 — nachgemessen.
 *   2. Die Trefferliste wird erst clientseitig aufgebaut. Es gibt kein HTML
 *      mit Preisen, das man parsen koennte; die Seite muss laufen.
 *
 * Der Browser laeuft headless, also unsichtbar im Hintergrund.
 *
 * Der Proxy wird bewusst pro Kontext gesetzt und nicht global: so kann jede
 * Laenderseite ueber einen eigenen Ausgang laufen, was genau der Punkt ist —
 * Preise koennen davon abhaengen, aus welchem Land man anfragt.
 */

import { chromium } from 'playwright';

let browser = null;
let closing = null;

/** Wartezeit zwischen Aufrufen je Host — bewusst hoeflich. */
const MIN_GAP_MS = 1200;
const lastHit = new Map();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Einstellbar ueber Umgebungsvariablen, weil der Bot-Schutz der Anbieter
 * empfindlich auf die Startvariante reagiert:
 *
 *   MWT_HEADLESS=0        sichtbares Fenster (zum Nachvollziehen)
 *   MWT_CHANNEL=chrome    echtes Chrome statt gebuendeltem Chromium
 *   MWT_PROFILE=<pfad>    dauerhaftes Profil (stabilerer Fingerabdruck)
 */
export async function getBrowser() {
  if (closing) await closing;
  if (browser && browser.isConnected()) return browser;

  const headless = process.env.MWT_HEADLESS !== '0';
  const channel = process.env.MWT_CHANNEL || undefined;

  browser = await chromium.launch({
    headless,
    ...(channel ? { channel } : {}),
    args: ['--lang=de-DE', '--no-sandbox'],
  });
  return browser;
}

export async function closeBrowser() {
  if (!browser) return;
  closing = browser.close().catch(() => {});
  await closing;
  browser = null;
  closing = null;
}

/** Hoeflichkeitsbremse: nie zwei Aufrufe gegen denselben Host im Sekundentakt. */
async function throttle(host) {
  const last = lastHit.get(host) || 0;
  const wait = MIN_GAP_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

/**
 * Fuehrt `fn` in einer frischen, isolierten Sitzung aus.
 *
 * Frisch ist wichtig: Sixt merkt sich die zuletzt gewaehlte Station in
 * localStorage. Ohne saubere Sitzung bekommt man Ergebnisse fuer die vorige
 * Anfrage zurueck und merkt es nicht — genau dieser Effekt hat mich bei der
 * Analyse zuerst in die Irre gefuehrt.
 *
 * @param {object}   opts
 * @param {string}   opts.host    Zielhost, fuer die Hoeflichkeitsbremse
 * @param {string}   [opts.locale]
 * @param {object}   [opts.proxy] { server, username?, password? }
 * @param {Function} fn           bekommt die Page
 */
export async function withPage({ host, locale = 'de-DE', proxy }, fn) {
  await throttle(host);
  const b = await getBrowser();

  const context = await b.newContext({
    userAgent: UA,
    locale,
    viewport: { width: 1400, height: 1000 },
    timezoneId: 'Europe/Berlin',
    ...(proxy ? { proxy } : {}),
  });
  context.setDefaultTimeout(30000);

  // Bilder/Schriften blocken spart Zeit, ist aber selbst ein Erkennungsmerkmal
  // (echte Browser laden sie). Deshalb standardmaessig aus.
  if (process.env.MWT_BLOCK_ASSETS === '1') {
    await context.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'media') return route.abort();
      route.continue();
    });
  }

  // Hier stand kurzzeitig eine Tarnkappen-Schicht (navigator.webdriver
  // faelschen usw.). Sie ist bewusst wieder raus: Sixt hat den Zugriff
  // ausdruecklich gesperrt ("Access denied. Your request has been blocked"),
  // und diese Sperre gezielt zu umgehen ist etwas anderes als eine oeffentliche
  // Seite zu lesen. Der Weg ueber die echte Browsersitzung des Nutzers steht
  // in tools/README-preise.md.

  try {
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Cookie-Banner wegklicken — bewusst mit "Ablehnen", nicht "Akzeptieren".
 * Fuer einen Preisabruf wird kein Tracking gebraucht.
 */
export async function dismissConsent(page, { timeout = 12000 } = {}) {
  // Der Banner wird nachgeladen und ist beim DOMContentLoaded noch nicht da.
  // Ohne dieses Warten klickt man ins Leere und der Banner faengt danach
  // jeden weiteren Klick ab.
  const appeared = await page
    .waitForFunction(
      () => {
        const host = document.querySelector('#usercentrics-cmp-ui');
        return Boolean(host?.shadowRoot?.querySelector('button'));
      },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);

  if (!appeared) return false;

  // Der Banner liegt im Shadow DOM von #usercentrics-cmp-ui. Die Klassennamen
  // sind sprachunabhaengig — anders als die Beschriftung, die je Laenderseite
  // "Ablehnen", "Deny", "Rechazar" ... heisst.
  const clicked = await page
    .evaluate(() => {
      const roots = [document];
      const host = document.querySelector('#usercentrics-cmp-ui');
      if (host?.shadowRoot) roots.push(host.shadowRoot);

      const selectors = [
        'button.uc-deny-button',
        'button#deny',
        '[data-testid="uc-deny-all-button"]',
        '#uc-btn-deny-banner',
      ];

      for (const root of roots) {
        for (const sel of selectors) {
          const btn = root.querySelector(sel);
          if (btn) {
            btn.click();
            return sel;
          }
        }
      }
      return null;
    })
    .catch(() => null);

  if (clicked) {
    // Dem Banner Zeit geben, sich abzuräumen, sonst fängt er den nächsten Klick.
    await page
      .waitForFunction(() => !document.querySelector('#usercentrics-cmp-ui'), {
        timeout: 5000,
      })
      .catch(() => page.waitForTimeout(800));
    return true;
  }
  return false;
}
