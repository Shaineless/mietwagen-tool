/**
 * Zeigt, wie eine Länderseite ihre Preise schreibt.
 *
 *   node tools/try-waehrung.mjs <host> [host …]
 *
 * Fuer neue Laenderseiten: das Dollarzeichen allein sagt nicht, ob es
 * kanadische, australische oder US-Dollar sind. Statt zu raten wird hier der
 * rohe Kacheltext ausgegeben und die Waehrung von Hand eingetragen.
 */

import { withPage, dismissConsent } from './browser.mjs';
import { closeBrowser } from './browser.mjs';

const TILE = '[data-testid="rent-offer-list-tile"]';
const CTA =
  '[data-testid="rent-search-form-cta"] button, [data-testid="rent-minimized-form-cta"] button';

const ab = new Date();
ab.setDate(ab.getDate() + 30);
const bis = new Date(ab);
bis.setDate(bis.getDate() + 4);
const tag = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

for (const host of process.argv.slice(2)) {
  const url =
    `https://${host}/?uci=110&rci=110&uda=${tag(ab)}&rda=${tag(bis)}&uti=1000&rti=1000&ctyp=P`;
  process.stdout.write(`\n${host}\n`);
  try {
    const zeilen = await withPage({ host }, async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await Promise.all([
        page
          .waitForFunction(
            () => {
              const i = document.querySelector('input[name="pickupLocation"]');
              return i && i.value.trim().length > 0;
            },
            undefined,
            { timeout: 40000, polling: 100 }
          )
          .catch(() => {}),
        dismissConsent(page, { timeout: 2500 }),
      ]);
      await page.waitForTimeout(400);
      await page.locator(CTA).first().click({ timeout: 12000 }).catch(() => {});
      await page.waitForSelector(TILE, { timeout: 45000 }).catch(() => {});
      return page
        .$$eval(TILE, (n) => n.slice(0, 2).map((t) => t.innerText.split('\n')))
        .catch(() => []);
    });
    for (const kachel of zeilen) {
      console.log('  ' + kachel.filter((z) => /\d/.test(z)).join(' | '));
    }
    if (!zeilen.length) console.log('  keine Kacheln');
  } catch (e) {
    console.log('  Fehler: ' + String(e.message).slice(0, 100));
  }
}

await closeBrowser();
