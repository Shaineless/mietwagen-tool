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
 * Echtes Headless wird ebenfalls abgewiesen, auch das ist gemessen.
 */

import { chromium } from 'playwright';
import { weicheGebraucht, weicheAdresse, starteWeiche } from './proxy.mjs';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.MWT_CDP_PORT) || 9222;

/** Eigenes Profil: das echte Profil des Nutzers bleibt unberuehrt. */
const PROFILE = join(tmpdir(), 'mwt-preistool-chrome');

/** Wartezeit zwischen Aufrufen je Host, bewusst hoeflich. */
const MIN_GAP_MS = 1500;
const lastHit = new Map();

/**
 * Zwei getrennte Chrome-Instanzen, jede mit eigenem Profil und eigenem Port.
 *
 * `normal` behaelt seine Cookies: die Cookie-Auswahl steht dann schon, das
 * spart bei jedem Abruf mehrere Sekunden.
 *
 * `inkognito` wird vor jedem Durchlauf geloescht und neu angelegt. Das ist der
 * Sinn der Sache. Sixt erkennt einen wiederkehrenden Besucher an seinen
 * Cookies und zeigt ihm nicht zwingend denselben Preis wie einem, der zum
 * ersten Mal kommt. Wer wissen will, was ein Fremder sieht, muss als Fremder
 * kommen.
 *
 * Getrennte Ports statt einer Instanz, die das Profil wechselt: ein Profil
 * laesst sich nur loeschen, solange kein Chrome darauf liegt. Mit zwei Ports
 * stoert das Aufraeumen der einen Seite die andere nicht.
 */
const instanzen = {
  normal: { port: PORT, profil: PROFILE, proc: null, browser: null, cdp: null, anker: null, kassenAnker: null },
  inkognito: {
    port: PORT + 1,
    profil: PROFILE + '-inkognito',
    proc: null,
    browser: null,
    cdp: null,
    anker: null,
    kassenAnker: null,
  },
};

const artVon = (inkognito) => (inkognito ? 'inkognito' : 'normal');

/* ------------------------------------------------------ Chrome finden */

/**
 * Reihenfolge der Suche. Chrome zuerst, und das ist kein Geschmack:
 *
 * FUER DEN PREISABRUF FUNKTIONIERT NUR CHROME. Edge steht weiter in der Liste,
 * weil es fuer das Programmfenster (fenster.mjs) taugt, aber der Abruf kommt
 * damit nicht zustande. Nachgemessen auf diesem Rechner: Edge oeffnet den
 * Debug-Port zwar, lauscht auch darauf, weist die DevTools-Anfrage darauf aber
 * ab. Playwright scheitert dann beim Holen der WebSocket-Adresse, und der
 * Abruf bricht mit "Verbindung zu Chrome fehlgeschlagen" ab.
 *
 * Wer nur Edge hat, bleibt deshalb im Link-Modus: die Suchen werden gebaut,
 * geoeffnet werden sie von Hand.
 */
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
 * @param {boolean} sichtbar   true = Fenster auf dem Bildschirm, zum Zuschauen
 * @param {boolean} inkognito  true = frisches Profil ohne Cookies
 */
export async function getBrowser({ sichtbar = false, inkognito = false } = {}) {
  const inst = instanzen[artVon(inkognito)];
  if (inst.browser && inst.browser.isConnected()) return inst.browser;

  // Laeuft schon eine passende Instanz? Dann einfach anhaengen.
  try {
    inst.browser = await chromium.connectOverCDP(`http://127.0.0.1:${inst.port}`, { timeout: 2000 });
    return inst.browser;
  } catch {
    /* keine da, selbst starten */
  }

  const exe = findBrowser();
  if (!exe) {
    throw new Error(
      'Chrome (oder Edge) wurde nicht gefunden. Pfad über die Umgebungsvariable ' +
        'MWT_CHROME setzen, oder Chrome von https://google.com/chrome installieren.'
    );
  }

  const args = [
    `--remote-debugging-port=${inst.port}`,
    // Eigenes Profil ist Pflicht: Chrome verweigert Debugging auf dem
    // Standardprofil, und das echte Profil des Nutzers soll unberuehrt bleiben.
    `--user-data-dir=${inst.profil}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // Sind Proxys je Laenderseite eingestellt, bekommt Chrome GENAU EINEN Proxy
  // genannt: die eigene Weiche. Sie entscheidet dann je Ziel, welcher Proxy
  // wirklich benutzt wird, und meldet sich dort an. Chrome selbst koennte
  // beides nicht, weder je Ziel unterscheiden noch Zugangsdaten mitschicken.
  if (weicheGebraucht()) {
    const adresse = weicheAdresse() || `127.0.0.1:${await starteWeiche()}`;
    // Ohne Ausnahmeliste: Chrome laesst 127.0.0.1 von sich aus am Proxy
    // vorbei, und genau das ist noetig. Ein erster Versuch mit
    // "--proxy-bypass-list=<-loopback>" schickte auch die Verbindung zur
    // eigenen Oberflaeche durch den Proxy, und das Programmfenster war tot.
    args.push(`--proxy-server=${adresse}`);
  }
  if (!sichtbar) {
    args.push('--window-position=-32000,-32000', '--window-size=1400,1000');
  }
  args.push('about:blank');

  inst.proc = spawn(exe, args, { detached: true, stdio: 'ignore' });
  inst.proc.unref();

  // Chrome braucht einen Moment, bis der Debug-Port lauscht.
  let lastErr;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      inst.browser = await chromium.connectOverCDP(`http://127.0.0.1:${inst.port}`, { timeout: 2000 });
      await bereiteKontextVor(inst.browser);
      return inst.browser;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('Verbindung zu Chrome fehlgeschlagen: ' + String(lastErr?.message).slice(0, 120));
}

/**
 * Das Inkognito-Profil wegwerfen, damit der naechste Durchlauf ohne jede
 * Erinnerung beginnt.
 *
 * Erst muss das Chrome darauf beendet sein, sonst haelt es die Dateien fest.
 * Bleibt trotzdem etwas liegen (Windows gibt Dateihandles gern verzoegert
 * frei), ist das kein Grund abzubrechen: dann startet der Abruf eben auf dem
 * alten Verzeichnis, und wir sagen es dem Aufrufer.
 *
 * @returns {Promise<boolean>} true, wenn das Profil wirklich leer ist
 */
export async function frischesProfil() {
  const inst = instanzen.inkognito;
  await schliesse(inst);
  // Chrome braucht einen Moment, bis es seine Dateien loslaesst.
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(inst.profil, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return !existsSync(inst.profil);
}

/**
 * Einmalig je Sitzung: ein Skript, das vor jedem Seitenskript laeuft.
 *
 * Es loescht nur Sixts Erinnerung an die zuletzt gewaehlte Station. Frueher
 * wurde dafuer erst die Startseite geladen und der ganze Speicher geleert,
 * das kostete eine zusaetzliche Navigation pro Abruf und warf nebenbei die
 * Cookie-Auswahl weg, sodass der Banner jedes Mal neu erschien.
 *
 * Die Zustimmung bleibt jetzt erhalten: der Banner kommt genau einmal je
 * Profil, danach faellt der ganze Umweg weg.
 */
async function bereiteKontextVor(b) {
  const ctx = b.contexts()[0];
  if (!ctx || ctx.__mwtVorbereitet) return;
  ctx.__mwtVorbereitet = true;
  await ctx
    .addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('rent-search_')) localStorage.removeItem(k);
        }
        sessionStorage.clear();
      } catch {
        /* anderer Ursprung, egal */
      }
    })
    .catch(() => {});
}

async function schliesse(inst) {
  try {
    await inst.browser?.close();
  } catch {
    /* egal */
  }
  inst.browser = null;
  inst.cdp = null;
  inst.anker = null;
  inst.kassenAnker = null;
  try {
    if (inst.proc?.pid) process.kill(inst.proc.pid);
  } catch {
    /* schon beendet */
  }
  inst.proc = null;
}

export async function closeBrowser() {
  for (const inst of Object.values(instanzen)) await schliesse(inst);
  // Was ohne Cookies geholt wurde, soll auch keine hinterlassen: das
  // Inkognito-Profil geht beim Beenden mit. Misslingt es, wird es beim
  // naechsten Lauf ohnehin geleert.
  try {
    rmSync(instanzen.inkognito.profil, { recursive: true, force: true });
  } catch {
    /* Chrome haelt die Dateien noch, beim naechsten Start faellt es weg */
  }
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
 * Station. Deshalb wird vor jeder Anfrage der Speicher der Seite geleert,
 * sonst bekommt man das Ergebnis der vorigen Anfrage zurueck und merkt es
 * nicht. Genau dieser Effekt hat mich bei der Analyse zuerst in die Irre
 * gefuehrt.
 */
export async function withPage({ host, sichtbar = false, inkognito = false }, fn) {
  await throttle(host);
  const b = await getBrowser({ sichtbar, inkognito });
  const inst = instanzen[artVon(inkognito)];
  const ctx = b.contexts()[0];

  // Das Hauptfenster vorher aktivieren. Chrome legt einen neuen Tab immer im
  // zuletzt aktiven Fenster an, und wenn gerade jemand eine Kassenseite
  // angesehen hat, waere das dessen Fenster: der Abruf-Tab poppte dann mitten
  // in einer laufenden Buchung auf. So bleibt beides getrennt.
  const halt = await ankerSeite(inst, ctx).catch(() => null);
  await halt?.bringToFront().catch(() => {});

  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/* ------------------------------------------------------ Kassenfenster */

/**
 * Seiten, die nach dem Abruf offen bleiben, damit man auf ihnen weiterbuchen
 * kann.
 *
 * Sie liegen bewusst in einem EIGENEN Chrome-Fenster, nicht als weiterer Tab
 * im Abruf-Fenster. Zwei Gruende:
 *
 *   1. Beim Hervorholen saehe man sonst das ganze Abrufgeschehen mit, jeden
 *      Tab, der auf- und zugeht.
 *   2. Wer das Fenster nach dem Buchen schliesst, wuerde sonst den Abruf
 *      mitreissen.
 *
 * Dasselbe Profil bleibt es trotzdem, und darauf kommt es an: die Kasse haengt
 * an einer Sitzung, ein frisches Profil hiesse ein anderer Preis.
 */
const VERSTECK = { left: -32000, top: -32000, width: 1400, height: 1000 };
const AUF_DEM_SCHIRM = { left: 60, top: 40, width: 1280, height: 940 };

/** Merkt sich, welche Seiten Kassenseiten sind, damit der Anker sie meidet. */
const kassenSeiten = new WeakSet();

async function cdpVon(inst) {
  if (!inst.cdp) inst.cdp = await inst.browser.newBrowserCDPSession();
  return inst.cdp;
}

async function fensterVon(inst, ctx, page) {
  const cdp = await cdpVon(inst);
  const sitzung = await ctx.newCDPSession(page);
  try {
    const { targetInfo } = await sitzung.send('Target.getTargetInfo');
    const { windowId } = await cdp.send('Browser.getWindowForTarget', {
      targetId: targetInfo.targetId,
    });
    return windowId;
  } finally {
    await sitzung.detach().catch(() => {});
  }
}

/**
 * Eine Seite, die im Hauptfenster liegt und es aktiv haelt.
 *
 * Chrome legt einen neuen Tab immer im zuletzt aktiven Fenster an. Ohne diesen
 * Anker wandern nach dem ersten Kassenfenster alle Abruf-Tabs dorthin, und das
 * Kassenfenster liesse sich nicht mehr allein zeigen. Gemessen und genau so
 * eingetreten.
 */
async function ankerSeite(inst, ctx) {
  if (inst.anker && !inst.anker.isClosed()) return inst.anker;
  for (const p of ctx.pages()) {
    if (!p.isClosed() && !kassenSeiten.has(p)) {
      inst.anker = p;
      return p;
    }
  }
  inst.anker = await ctx.newPage();
  return inst.anker;
}

/**
 * Legt eine Kassenseite an: als Reiter im gemeinsamen Kassenfenster, oder,
 * wenn es das noch nicht gibt, als neues verstecktes Fenster.
 *
 * EIN Fenster mit mehreren Reitern statt vieler Fenster, aus zwei Gruenden.
 * Beim Buchen sieht man alle abgerufenen Laenderseiten nebeneinander und kann
 * selbst umschalten; und es liegt nicht ein halbes Dutzend Chrome-Fenster in
 * der Taskleiste. Am Speicher aendert es wenig, siehe die Messung in
 * buchung.mjs: Chrome nimmt fuer jede Herkunft ohnehin einen eigenen Prozess,
 * und sixt.de, sixt.fr und sixt.es sind drei Herkuenfte.
 *
 * @returns {Promise<{page: import('playwright').Page, windowId: number}>}
 */
export async function neueKassenseite({ host, inkognito = false }) {
  await throttle(host);
  const b = await getBrowser({ inkognito });
  const inst = instanzen[artVon(inkognito)];
  const ctx = b.contexts()[0];
  const cdp = await cdpVon(inst);
  const halt = await ankerSeite(inst, ctx);

  // Chrome legt einen neuen Reiter immer im zuletzt aktiven Fenster an. Steht
  // das Kassenfenster schon, wird es kurz aktiviert, damit der Reiter dort
  // landet; danach kommt das Hauptfenster wieder nach vorn.
  const anschluss = inst.kassenAnker && !inst.kassenAnker.isClosed() ? inst.kassenAnker : null;
  if (anschluss) await anschluss.bringToFront().catch(() => {});

  const wartet = ctx.waitForEvent('page', { timeout: 20000 });
  await cdp.send('Target.createTarget', {
    url: 'about:blank',
    ...(anschluss ? {} : { newWindow: true }),
  });
  const page = await wartet;
  kassenSeiten.add(page);
  page.setDefaultTimeout(30000);

  const windowId = await fensterVon(inst, ctx, page);
  if (!anschluss) {
    // Zuerst verstecken, dann das Hauptfenster wieder nach vorn: in dieser
    // Reihenfolge blitzt nichts auf und die naechsten Abruf-Tabs sitzen richtig.
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: VERSTECK }).catch(() => {});
    inst.kassenAnker = page;
  }
  await halt.bringToFront().catch(() => {});

  return { page, windowId };
}

async function setzeFenster(inkognito, windowId, bounds) {
  const inst = instanzen[artVon(inkognito)];
  if (!inst.browser?.isConnected()) return false;
  const cdp = await cdpVon(inst);
  // Ein minimiertes Fenster nimmt keine Koordinaten an, deshalb erst der
  // Zustand, dann die Masse.
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
  await cdp.send('Browser.setWindowBounds', { windowId, bounds });
  return true;
}

/** Holt ein Kassenfenster auf den Bildschirm und nach vorn. */
export async function zeigeFenster({ page, windowId, inkognito = false }) {
  const ok = await setzeFenster(inkognito, windowId, AUF_DEM_SCHIRM);
  if (ok) await page.bringToFront().catch(() => {});
  return ok;
}

/** Parkt ein Kassenfenster wieder ausserhalb des Bildschirms. */
export async function versteckeFenster({ windowId, inkognito = false }) {
  return setzeFenster(inkognito, windowId, VERSTECK).catch(() => false);
}

/*
 * Was hier bewusst NICHT steht: Kniffe, um eine wartende Kassenseite
 * sparsamer zu machen. Zwei wurden ausprobiert und beide wieder entfernt.
 *
 *   Page.setWebLifecycleState "frozen"
 *     Ein eingefrorener Renderer fuehrt kein Skript mehr aus. Der spaetere
 *     Klick lief danach endlos ins Leere, statt das Paket auszuwaehlen.
 *
 *   Memory.forciblyPurgeJavaScriptMemory
 *     Sah harmlos aus und war es nicht: nach dem Aufraeumen antwortete die
 *     Seite auf keine Abfrage mehr, schon das blosse Nachsehen, ob das
 *     Schutzformular noch da ist, blieb haengen.
 *
 * Gemessen haetten beide zusammen 300 auf 250 MB gebracht. Ein Sechstel
 * Speicher ist keinen haengenden Knopf wert. Die Seite bleibt deshalb, wie
 * sie ist: unangetastet und jederzeit bedienbar.
 */

/**
 * Cookie-Banner ablehnen, bewusst "Ablehnen", nicht "Einverstanden".
 *
 * Der Banner liegt im Shadow DOM von #usercentrics-cmp-ui. Angesprochen wird er
 * ueber Klassennamen, nicht ueber die Beschriftung: die heisst je Laenderseite
 * "Ablehnen", "Deny", "Rechazar" ... Geprueft auf sixt.de und sixt.co.uk.
 */
export async function dismissConsent(page, { timeout = 3000 } = {}) {
  // Erst kurz schauen, ob ueberhaupt ein Banner kommt. Vorher wurde stur eine
  // feste Zahl von Versuchen durchlaufen, auf einem Profil, das die Auswahl
  // schon gespeichert hat, waren das 13 Sekunden Warten auf etwas, das nie
  // erscheint. Das war der groesste Zeitfresser im ganzen Abruf.
  // Achtung auf die Signatur: waitForFunction(fn, arg, options). Werden die
  // Optionen als zweites Argument uebergeben, gelten sie als Argument fuer die
  // Seitenfunktion und der Timeout faellt still auf die Vorgabe von 30s
  // zurueck. Genau daran hing der Abruf 30 statt 3 Sekunden fest.
  const da = await page
    .waitForFunction(
      () => Boolean(document.querySelector('#usercentrics-cmp-ui')?.shadowRoot?.querySelector('button')),
      undefined,
      { timeout, polling: 150 }
    )
    .then(() => true)
    .catch(() => false);

  if (!da) return false;

  const geklickt = await page
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

  if (!geklickt) return false;

  // Nur warten, wenn wirklich geklickt wurde. Auf manchen Laenderseiten
  // bleibt die Huelle stehen; dafuer gibt es den Rueckfall im Aufrufer.
  await page
    .waitForFunction(() => !document.querySelector('#usercentrics-cmp-ui'), undefined, {
      timeout: 2500,
      polling: 150,
    })
    .catch(() => {});
  return true;
}

/**
 * Werbefenster wegklicken, die ueber der Suchmaske liegen.
 *
 * Neben dem Cookie-Banner blenden einige Laenderseiten gelegentlich ein
 * Mitgliedschafts-Fenster ein ("SIXT ONE"). Es traegt role=dialog, liegt mit
 * z-index ueber allem und faengt den Klick auf "Suchen" ab. Gemessen auf
 * sixt.es: fuenf von fuenf Versuchen blockiert, auf sixt.fr im selben Lauf
 * keiner, es kommt nicht immer.
 *
 * Bisher rettete das der Notklick direkt im DOM, aber erst nachdem der
 * regulaere Klick zwoelf Sekunden lang in einen Timeout gelaufen war. Unter
 * Last reicht das Zeitbudget dann nicht mehr, und der Abruf faellt aus.
 *
 * Erkannt wird das Fenster nicht am Text, der heisst in jeder Sprache anders,
 * sondern an der Rolle. Geschlossen wird ueber den Schliessen-Knopf, den man
 * an seiner zugaenglichen Beschriftung erkennt; als Rueckfall die Escape-Taste.
 */
const SCHLIESSEN_RE =
  /^(cerrar|close|schlie(ss|ß)en|fermer|chiudi|sluiten|fechar|luk|st[aä]ng|lukk|sulje|zamknij|zav(ř|r)[ií]t|bez[áa]r|zatvori|zapri|aizv(ē|e)rt|u(ž|z)daryti|sulge|loka|kapat|κλείσιμο|×|✕|✖|x)$/i;

export async function dismissPopups(page, { timeout = 3000 } = {}) {
  // Sichtbar heisst: gross genug UND nicht ausgeblendet. Nach dem Schliessen
  // bleibt das Fenster oft mit voller Groesse im DOM stehen und ist nur
  // durchsichtig, wer nur die Groesse prueft, haelt es faelschlich fuer offen.
  const sichtbaresFenster = () => {
    for (const d of document.querySelectorAll('[role=dialog], [role=alertdialog], dialog')) {
      if (d.closest('#usercentrics-cmp-ui')) continue;
      const r = d.getBoundingClientRect();
      if (r.width <= 200 || r.height <= 100) continue;
      const s = getComputedStyle(d);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
      return true;
    }
    return false;
  };

  const offen = () =>
    page.evaluate(sichtbaresFenster).catch(() => false);

  if (!(await offen())) return false;

  const geklickt = await page
    .evaluate((muster) => {
      const re = new RegExp(muster.quelle, muster.flaggen);
      for (const d of document.querySelectorAll('[role=dialog], [role=alertdialog], dialog')) {
        if (d.closest('#usercentrics-cmp-ui')) continue;
        for (const b of d.querySelectorAll('button, [role=button], a')) {
          const name = (b.getAttribute('aria-label') || b.innerText || '').trim();
          if (re.test(name)) {
            b.click();
            return name;
          }
        }
      }
      return null;
    }, { quelle: SCHLIESSEN_RE.source, flaggen: SCHLIESSEN_RE.flags })
    .catch(() => null);

  if (!geklickt) await page.keyboard.press('Escape').catch(() => {});

  // Nachsehen, ob es wirklich weg ist, ein Klick, der nichts bewirkt hat,
  // ist schlimmer als keiner, weil man sich dann in Sicherheit wiegt.
  const weg = await page
    .waitForFunction(
      (quelle) => {
        // Dieselbe Pruefung wie oben, hier als Text uebergeben, weil die
        // Funktion im Seitenkontext laeuft und nichts von aussen sieht.
        return !new Function('return (' + quelle + ')()')();
      },
      sichtbaresFenster.toString(),
      { timeout, polling: 100 }
    )
    .then(() => true)
    .catch(() => false);

  return weg;
}
