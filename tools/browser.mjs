/**
 * Browser-Steuerung fuer den Preisabruf.
 *
 * Der entscheidende Punkt steht ganz am Anfang, weil er nicht offensichtlich
 * ist und teuer erkauft wurde:
 *
 *   Playwrights eigenes chromium.launch() wird von Sixt abgewiesen
 *   ("Access denied. Your request has been blocked."), egal ob headless oder
 *   nicht, egal ob Chromium oder echtes Chrome. Playwright startet den Browser
 *   mit Automatisierungs-Flags und einem Wegwerfprofil; das faellt auf.
 *
 *   Ein selbst gestartetes, ganz normales Chrome mit --remote-debugging-port,
 *   an das man sich per CDP anhaengt, kommt dagegen durch. Gemessen: 50 von 50
 *   Angebotskacheln.
 *
 * Deshalb: Chrome selbst starten, dann verbinden. Nicht "vereinfachen".
 *
 * Unsichtbar laeuft es ueber --window-position weit ausserhalb des Bildschirms.
 * Echtes Headless wird ebenfalls abgewiesen — auch das ist gemessen.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.MWT_CDP_PORT) || 9222;

/** Eigenes Profil: das echte Profil des Nutzers bleibt unberuehrt. */
const PROFILE = join(tmpdir(), 'mwt-preistool-chrome');

/** Wartezeit zwischen Aufrufen je Host — bewusst hoeflich. */
const MIN_GAP_MS = 1500;
const lastHit = new Map();

let proc = null;
let browser = null;

/* ------------------------------------------------------ Chrome finden */

const CANDIDATES = [
  [process.env.PROGRAMFILES, 'Google\\Chrome\\Application\\chrome.exe'],
  [process.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe'],
  [process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
  [process.env.PROGRAMFILES, 'Microsoft\\Edge\\Application\\msedge.exe'],
  [process.env['PROGRAMFILES(X86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
];

export function findBrowser() {
  if (process.env.MWT_CHROME && existsSync(process.env.MWT_CHROME)) {
    return process.env.MWT_CHROME;
  }
  for (const [base, rest] of CANDIDATES) {
    if (!base) continue;
    const p = join(base, rest);
    if (existsSync(p)) return p;
  }
  return null;
}

/* ------------------------------------------------------ Start und Verbindung */

/**
 * Startet Chrome (falls noetig) und verbindet sich.
 * @param {boolean} sichtbar  true = Fenster auf dem Bildschirm, zum Zuschauen
 */
export async function getBrowser({ sichtbar = false } = {}) {
  if (browser && browser.isConnected()) return browser;

  // Laeuft schon eine passende Instanz? Dann einfach anhaengen.
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 2000 });
    return browser;
  } catch {
    /* keine da — selbst starten */
  }

  const exe = findBrowser();
  if (!exe) {
    throw new Error(
      'Chrome (oder Edge) wurde nicht gefunden. Pfad über die Umgebungsvariable ' +
        'MWT_CHROME setzen, oder Chrome von https://google.com/chrome installieren.'
    );
  }

  const args = [
    `--remote-debugging-port=${PORT}`,
    // Eigenes Profil ist Pflicht: Chrome verweigert Debugging auf dem
    // Standardprofil, und das echte Profil des Nutzers soll unberuehrt bleiben.
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (!sichtbar) {
    args.push('--window-position=-32000,-32000', '--window-size=1400,1000');
  }
  args.push('about:blank');

  proc = spawn(exe, args, { detached: true, stdio: 'ignore' });
  proc.unref();

  // Chrome braucht einen Moment, bis der Debug-Port lauscht.
  let lastErr;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 2000 });
      return browser;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('Verbindung zu Chrome fehlgeschlagen: ' + String(lastErr?.message).slice(0, 120));
}

export async function closeBrowser() {
  try {
    await browser?.close();
  } catch {
    /* egal */
  }
  browser = null;
  try {
    if (proc?.pid) process.kill(proc.pid);
  } catch {
    /* schon beendet */
  }
  proc = null;
}

/* ------------------------------------------------------ Seiten */

async function throttle(host) {
  const last = lastHit.get(host) || 0;
  const wait = MIN_GAP_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

/**
 * Fuehrt `fn` in einem frischen Tab aus und raeumt ihn danach weg.
 *
 * Frischer Tab, aber gemeinsames Profil: Sixt merkt sich die zuletzt gewaehlte
 * Station. Deshalb wird vor jeder Anfrage der Speicher der Seite geleert —
 * sonst bekommt man das Ergebnis der vorigen Anfrage zurueck und merkt es
 * nicht. Genau dieser Effekt hat mich bei der Analyse zuerst in die Irre
 * gefuehrt.
 */
export async function withPage({ host, sichtbar = false }, fn) {
  await throttle(host);
  const b = await getBrowser({ sichtbar });
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto(`https://${host}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page
      .evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      })
      .catch(() => {});
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Cookie-Banner ablehnen — bewusst "Ablehnen", nicht "Einverstanden".
 *
 * Der Banner liegt im Shadow DOM von #usercentrics-cmp-ui. Angesprochen wird er
 * ueber Klassennamen, nicht ueber die Beschriftung: die heisst je Laenderseite
 * "Ablehnen", "Deny", "Rechazar" ... Geprueft auf sixt.de und sixt.co.uk.
 */
export async function dismissConsent(page, { versuche = 16 } = {}) {
  for (let i = 0; i < versuche; i++) {
    const ok = await page
      .evaluate(() => {
        const h = document.querySelector('#usercentrics-cmp-ui');
        const roots = h?.shadowRoot ? [document, h.shadowRoot] : [document];
        for (const r of roots) {
          const b = r.querySelector('button.uc-deny-button, button#deny');
          if (b) {
            b.click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
    if (ok) {
      await page.waitForTimeout(400);
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}
