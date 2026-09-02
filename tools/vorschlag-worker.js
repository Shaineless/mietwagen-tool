/**
 * Nimmt Verbesserungsvorschläge entgegen und schickt sie als E-Mail weiter.
 *
 * Damit landet ein Vorschlag ohne Zutun des Absenders im Postfach — das
 * Mailprogramm auf dessen Rechner wird nicht mehr gebraucht.
 *
 * Warum nicht direkt aus dem Programm heraus mailen: dafür bräuchte es
 * Zugangsdaten zu einem Postfach, und die stünden dann in der EXE, die jeder
 * öffnen kann. Ein winziger Dienst dazwischen kennt die Zugangsdaten, das
 * Programm kennt nur seine Adresse.
 *
 * ── Einrichten (rund fünf Minuten, kostenlos) ─────────────────────────────
 *
 *  1. Bei Cloudflare anmelden (dash.cloudflare.com), links "Workers & Pages",
 *     "Create" → "Start with Hello World!" → Namen vergeben, Deploy.
 *  2. "Edit code", den ganzen Inhalt dieser Datei hineinkopieren, Deploy.
 *  3. In den Worker-Einstellungen unter "Variables and Secrets" anlegen:
 *       ZIEL_MAIL     tool@qylar.com
 *       RESEND_KEY    (Schlüssel von resend.com, kostenloses Kontingent)
 *     RESEND_KEY als "Secret" anlegen, nicht als "Text".
 *  4. Bei resend.com anmelden, eine Absenderadresse verifizieren und den
 *     API-Schlüssel erzeugen. Ohne eigene Domain geht "onboarding@resend.dev"
 *     als Absender.
 *  5. Die Worker-Adresse (…​workers.dev) in die Datei
 *     `Preistool-Daten/einstellungen.json` neben dem Programm eintragen:
 *
 *       { "vorschlaegeAn": "https://mein-worker.mein-konto.workers.dev" }
 *
 *     Soll das für alle gelten, die das Programm bekommen, gehört dieselbe
 *     Zeile in VOREINSTELLUNG in tools/serve.mjs — dann ist sie in der EXE.
 *
 * Danach schickt "Absenden" den Vorschlag direkt ins Postfach.
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Nur POST', { status: 405 });
    }

    let daten;
    try {
      daten = await request.json();
    } catch {
      return new Response('Kein JSON', { status: 400 });
    }

    const text = String(daten.text || '').trim();
    // Untergrenze gegen versehentlich leere Sendungen, Obergrenze gegen
    // jemanden, der die Adresse findet und ein Buch schickt.
    if (text.length < 3 || text.length > 5000) {
      return new Response('Text fehlt oder ist zu lang', { status: 400 });
    }

    const kontext = daten.kontext
      ? '\n\n— — —\nStand beim Schreiben:\n' + JSON.stringify(daten.kontext, null, 1)
      : '';

    const antwort = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.ABSENDER || 'Preistool <onboarding@resend.dev>',
        to: [env.ZIEL_MAIL],
        subject: 'Mietwagen-Preistool — Verbesserungsvorschlag',
        text: `${text}${kontext}\n\nEingegangen: ${daten.am || new Date().toISOString()}`,
      }),
    });

    if (!antwort.ok) {
      // Der Grund gehört ins Worker-Protokoll, nicht in die Antwort: der
      // Absender kann damit nichts anfangen, und Fehlermeldungen eines
      // Maildienstes gehen niemanden etwas an.
      console.log('Resend antwortete', antwort.status, await antwort.text());
      return new Response('Konnte nicht senden', { status: 502 });
    }

    return new Response('ok');
  },
};
