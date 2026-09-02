/**
 * Sucht die Pop-ups, die einen Abruf zufällig scheitern lassen.
 *
 *   node tools/try-popup.mjs [host …] [--mal 5]
 *
 * Manche Länderseiten — gemeldet für Frankreich und Spanien — zeigen beim
 * Öffnen gelegentlich ein Fenster, das über der Suchmaske liegt und den Klick
 * auf „Suchen" abfängt. Weil es nicht jedes Mal kommt, hilft nur Wiederholen:
 * derselbe Aufruf mehrfach, und bei jedem Versuch wird festgehalten, was
 * ausser dem Cookie-Banner sonst noch auf der Seite liegt.
 *
 * Ausgegeben werden Rolle, Beschriftung und die Haken, an denen man so ein
 * Fenster ansprechen könnte. Daraus wird dann die Behandlung im Abruf gebaut —
 * geraten wird hier nichts.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withPage, dismissConsent, dismissPopups, closeBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const malIdx = args.indexOf('--mal');
const MAL = malIdx >= 0 ? Number(args[malIdx + 1]) : 5;
/**
 * Vor jedem Versuch ein frisches Browserprofil.
 *
 * Ohne das testet nur der erste Versuch je Länderseite etwas: Sixt merkt sich
 * im Profil, dass das Werbefenster weggeklickt wurde, und zeigt es danach
 * nicht mehr. Zwanzig Wiederholungen auf demselben Profil sind deshalb neunzehn
 * Mal Leerlauf — und genau der Fall, den ein neuer Nutzer erlebt, käme nie dran.
 */
const FRISCH = args.includes('--frisch');
const hosts = args.filter((a, i) => !a.startsWith('--') && i !== malIdx + 1);

async function profilLeeren() {
  await closeBrowser().catch(() => {});
  await rm(join(tmpdir(), 'mwt-preistool-chrome'), { recursive: true, force: true }).catch(() => {});
}

const ZIELE = hosts.length ? hosts : ['www.sixt.fr', 'www.sixt.es'];

const ab = new Date();
ab.setDate(ab.getDate() + 30);
const bis = new Date(ab);
bis.setDate(bis.getDate() + 4);
const tag = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

/**
 * Alles einsammeln, was wie ein aufgesetztes Fenster aussieht.
 *
 * Bewusst breit gefasst: Dialogrollen, Elemente mit "modal"/"popup"/"overlay"
 * im Klassennamen, und alles, was gross ist und weit oben liegt. Lieber ein
 * paar Fehlfunde als das eine Fenster übersehen, das den Klick abfängt.
 */
async function findeAufgesetztes(page) {
  return page
    .evaluate(() => {
      const treffer = [];
      const gesehen = new Set();

      const merke = (n, grund) => {
        if (!n || gesehen.has(n)) return;
        const r = n.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) return;
        const s = getComputedStyle(n);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return;
        gesehen.add(n);
        treffer.push({
          grund,
          tag: n.tagName.toLowerCase(),
          rolle: n.getAttribute('role') || '',
          testid: n.getAttribute('data-testid') || '',
          id: n.id || '',
          klasse: (n.className?.baseVal ?? n.className ?? '').toString().slice(0, 80),
          zIndex: s.zIndex,
          position: s.position,
          groesse: `${Math.round(r.width)}x${Math.round(r.height)}`,
          text: (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          knoepfe: [...n.querySelectorAll('button, [role=button], a')]
            .map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 8),
        });
      };

      for (const n of document.querySelectorAll('[role=dialog], [role=alertdialog], dialog')) {
        merke(n, 'Dialogrolle');
      }
      for (const n of document.querySelectorAll('[class*=modal i], [class*=popup i], [class*=overlay i], [class*=lightbox i]')) {
        merke(n, 'Klassenname');
      }
      // Was liegt ganz oben und deckt die Mitte des Bildschirms ab?
      const mitte = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      if (mitte) {
        let n = mitte;
        for (let i = 0; i < 6 && n; i++) {
          const s = getComputedStyle(n);
          if (s.position === 'fixed' || Number(s.zIndex) > 100) merke(n, 'liegt in der Mitte oben');
          n = n.parentElement;
        }
      }
      return treffer;
    })
    .catch(() => []);
}

const CTA =
  '[data-testid="rent-search-form-cta"] button, [data-testid="rent-minimized-form-cta"] button';

console.log(`Je Länderseite ${MAL} Versuche\n`);
const bilanz = new Map();

for (const host of ZIELE) {
  console.log(`── ${host} ──`);
  for (let i = 1; i <= MAL; i++) {
    const url =
      `https://${host}/?uci=110&rci=110&uda=${tag(ab)}&rda=${tag(bis)}&uti=1000&rti=1000&ctyp=P`;
    if (FRISCH) await profilLeeren();
    try {
      const erg = await withPage({ host }, async (page) => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const stationDa = await page
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

        await dismissConsent(page, { timeout: 2500 });
        await page.waitForTimeout(700);

        // Genau hier scheitert es laut Meldung: der Klick auf "Suchen".
        const aufgesetzt = await findeAufgesetztes(page);
        // Erst wegklicken, dann noch einmal nachsehen — so steht in der
        // Ausgabe, ob die Behandlung wirklich gegriffen hat.
        const weggeklickt = aufgesetzt.length ? await dismissPopups(page) : null;
        const danach = aufgesetzt.length ? await findeAufgesetztes(page) : [];
        let geklickt = true;
        let klickFehler = null;
        try {
          await page.locator(CTA).first().click({ timeout: 8000 });
        } catch (e) {
          geklickt = false;
          klickFehler = String(e.message).split('\n')[0].slice(0, 90);
        }

        const liste = await page
          .waitForSelector('[data-testid="rent-offer-list-tile"]', { timeout: 30000 })
          .then(() => true)
          .catch(() => false);

        return { stationDa, aufgesetzt, weggeklickt, danach, geklickt, klickFehler, liste };
      });

      const ok = erg.stationDa && erg.geklickt && erg.liste;
      const b = bilanz.get(host) || { ok: 0, fehler: 0 };
      ok ? b.ok++ : b.fehler++;
      bilanz.set(host, b);

      console.log(
        `  ${i}. ${ok ? '✓' : '✕'} Station:${erg.stationDa ? 'ja' : 'NEIN'} ` +
          `Klick:${erg.geklickt ? 'ja' : 'NEIN'} Liste:${erg.liste ? 'ja' : 'NEIN'}` +
          (erg.klickFehler ? `  (${erg.klickFehler})` : '')
      );
      if (erg.aufgesetzt.length) {
        const a = erg.aufgesetzt[0];
        console.log(
          `      ↳ Fenster: "${a.text.slice(0, 60)}"  Knöpfe: ${a.knoepfe.join(' | ')}`
        );
        console.log(
          `        weggeklickt: ${erg.weggeklickt ? 'ja' : 'NEIN'} · danach noch offen: ${erg.danach.length}`
        );
      }
    } catch (e) {
      const b = bilanz.get(host) || { ok: 0, fehler: 0 };
      b.fehler++;
      bilanz.set(host, b);
      console.log(`  ${i}. ✕ ${String(e.message).split('\n')[0].slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log('');
}

console.log('── Bilanz ──');
for (const [host, b] of bilanz) {
  console.log(`  ${host.padEnd(18)} ${b.ok} von ${b.ok + b.fehler} gelungen`);
}

await closeBrowser();
