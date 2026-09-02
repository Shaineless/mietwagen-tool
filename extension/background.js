/**
 * Service Worker der Erweiterung.
 *
 * Einziger Zweck: die vom Content-Script gelesenen Preise an das lokal
 * laufende Preistool weiterreichen. Der Umweg ueber den Service Worker ist
 * noetig, weil ein fetch() aus dem Content-Script an localhost je nach
 * Seiten-CSP scheitert, hier gelten die Rechte der Erweiterung.
 *
 * Es verlaesst nichts den Rechner: Ziel ist ausschliesslich localhost.
 */

const DEFAULT_PORTS = [4173, 4174];
const PATH = '/api/offers';

async function deliver(payload) {
  const { mwtPort } = await chrome.storage.local.get('mwtPort');
  const ports = mwtPort ? [mwtPort, ...DEFAULT_PORTS] : DEFAULT_PORTS;

  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        // Funktionierenden Port merken, damit der naechste Treffer sofort sitzt.
        if (port !== mwtPort) await chrome.storage.local.set({ mwtPort: port });
        return true;
      }
    } catch {
      /* naechster Port */
    }
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'mwt:offers') return;
  deliver(msg.payload).then((ok) => sendResponse({ ok }));
  return true; // asynchrone Antwort
});
