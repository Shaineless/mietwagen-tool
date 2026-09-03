/**
 * Faellt ein Proxy technisch aus, muss TRACKER auf den naechsten geprueften
 * wechseln UND es dem Nutzer sagen.
 *
 * Aufruf in zwei Schritten:
 *   node tools/try-ausfall.mjs vorbereiten
 *   (Dienst neu starten, damit der tote Eintrag als gewaehlt gilt)
 *   node tools/try-ausfall.mjs pruefen
 */
import { readFileSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:4173';
const hole = async (p) => (await fetch(B + p)).json();
const post = async (p, b) =>
  (await fetch(B + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b ?? {}),
  })).json();
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

const schritt = process.argv[2] || 'vorbereiten';

if (schritt === 'vorbereiten') {
  const echte = readFileSync(
    'C:\\Users\\Shaine\\Downloads\\proxies_6835f84a092ed625f7f88362_2026-09-03.txt',
    'utf8'
  ).split('\n').map((z) => z.trim()).filter(Boolean).slice(0, 8);

  // Der tote steht an erster Stelle. Auf 127.0.0.1:9 lauscht nichts.
  const liste = ['127.0.0.1:9:tot:tot', ...echte];
  console.log('Liste:', (await post('/api/proxy', { ziel: 'allgemein', liste })).anzahl, 'Eintraege');

  const t = await post('/api/proxy/test', { ziel: 'allgemein', anzahl: 9 });
  console.log(`Geprueft: ${t.davonGut} von ${t.geprueft} erreichbar`);
  for (const e of t.einzeln || []) {
    console.log(`  [${e.i}] ${e.ok ? 'geht  ' + e.ip + '  ' + e.ms + ' ms' : 'nein  ' + e.grund}`);
  }
  await post('/api/proxy', { modus: 'allgemein' });

  // Den TOTEN als gewaehlt eintragen. Der Dienst haelt die Einstellungen im
  // Speicher, deshalb muss er danach neu starten.
  const p = 'data/proxies.json';
  const d = JSON.parse(readFileSync(p, 'utf8'));
  d.allgemein.gewaehlt = 0;
  writeFileSync(p, JSON.stringify(d, null, 1));
  console.log('\nGewaehlt auf den TOTEN gesetzt:', d.allgemein.liste[0]);
  console.log('Jetzt den Dienst neu starten, dann: node tools/try-ausfall.mjs pruefen');
} else {
  const vor = await hole('/api/proxy');
  console.log(`Vor dem Abruf gewaehlt: Index ${vor.allgemein?.gewaehlt} (${vor.allgemein?.gewaehltKurz})`);

  const job = {
    key: 'af~1', provider: 'sixt', host: 'www.sixt.de', stationCode: '4485',
    pickupDate: '2027-06-12', returnDate: '2027-06-15',
    pickupTime: '10:00', returnTime: '10:00', currency: 'EUR',
  };
  await post('/api/results/clear', { keys: [job.key] });
  console.log('\nAbruf laeuft ...');
  await post('/api/fetch', { jobs: [job] });

  let lief = false;
  for (let i = 0; i < 100; i++) {
    await schlaf(3000);
    const h = await hole('/api/health');
    if (h.queue.laufend || h.queue.offen) lief = true;
    if (lief && !h.queue.laufend && !h.queue.offen) break;
  }

  const r = (await hole('/api/results?keys=af~1')).results['af~1'];
  console.log(`Ergebnis: ${r?.offers?.length ?? 0} Angebote, Fehler: ${r?.fehlerCode || '(keiner)'}`);

  const h = await hole('/api/health');
  console.log('\nWas der Nutzer angezeigt bekommt:');
  if (!h.lage?.length) console.log('  (keine Meldung)');
  for (const e of h.lage || []) {
    console.log(`  ${new Date(e.zeit).toLocaleTimeString('de-DE')}  [${e.art}] ${e.text}`);
  }

  const nach = await hole('/api/proxy');
  console.log(`\nNach dem Abruf gewaehlt: Index ${nach.allgemein?.gewaehlt} (${nach.allgemein?.gewaehltKurz})`);
  console.log(
    vor.allgemein?.gewaehlt !== nach.allgemein?.gewaehlt
      ? '  -> gewechselt, wie es sein soll'
      : '  -> NICHT gewechselt'
  );

  await post('/api/proxy', { modus: 'aus' });
  await post('/api/proxy', { ziel: 'allgemein', loeschen: true });
  await post('/api/results/clear', { keys: ['af~1'] });
  console.log('\nAufgeraeumt.');
}
