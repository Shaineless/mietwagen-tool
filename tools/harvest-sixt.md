# Sixt-Stationen nachladen

Die Stationsliste in `src/data/stations.sixt.txt` stammt aus den **öffentlichen
Stationsseiten** auf sixt.de (`/mietwagen/<land>/<stadt>/<station>/`). Jede
dieser Seiten enthält im Seitenquelltext die numerische Stations-ID:

```
window.sixt.webapp["rentsearch"] = ... {"stationId":110}
```

Genau diese ID ist der `uci`-Parameter, den das Tool baut.

Enthalten sind derzeit **alle 104 Länder mit Stationen** — 1779 Stationen, Stand
2026-09-01: Flughäfen, Bahnhöfe, Stadt-, Hotel-, Hafen- und LKW-Stationen.
Nachladen lohnt also nur, wenn Sixt neue Stationen eröffnet hat.

## Neu einlesen

Es gibt keine offizielle Stations-API. Ein `fetch` aus Node wird von Cloudflare
mit 403 abgewiesen — deshalb läuft der Abruf in der Browser-Konsole auf sixt.de,
wo er derselben Herkunft entspringt.

1. <https://www.sixt.de/mietwagen/standorte/> öffnen.
2. Entwicklertools öffnen (F12) → Konsole.
3. Skript einfügen und ausführen. Es sammelt erst alle Stations-URLs, dann die
   IDs. Für alle Länder sind das rund 4600 Seitenaufrufe und einige Minuten.

```js
// Länder-Slug -> ISO-Code. Die Slugs stehen auf /mietwagen/standorte/.
const LAENDER = { polen: 'PL', griechenland: 'GR', kroatien: 'HR' };

const clean = (raw = '') =>
  raw.replace(/^ᐅ\s*/, '').split('|')[0]
     .replace(/^(Buchen Sie|Entdecken Sie|Mehr Komfort mit|Jetzt einen|Vorteile der)\s+/i, '')
     .replace(/\bSIXT\s+Mietwagen\s+(am|in|auf)\s+/i, '')
     .replace(/^SIXT\s+/i, '')
     .replace(/^Mietwagen\s+(am\s+|in\s+|auf\s+)?/i, '')
     .replace(/\s+(günstig|mieten|buchen|reservieren|entdecken|finden)\b.*$/i, '')
     .replace(/\s+bei\s+SIXT.*$/i, '')
     .replace(/\s+Autovermietung.*$/i, '')
     .trim();

const zeilen = [];
for (const [slug, iso] of Object.entries(LAENDER)) {
  const land = await (await fetch(`/mietwagen/${slug}/`)).text();
  const staedte = [...new Set(
    land.match(new RegExp(`/mietwagen/${slug}/[a-z0-9\\-]+/`, 'gi')) || []
  )];

  const stationen = new Set();
  for (const stadt of staedte) {
    const s = await (await fetch(stadt)).text();
    (s.match(new RegExp(`/mietwagen/${slug}/[a-z0-9\\-]+/[a-z0-9\\-]+/`, 'gi')) || [])
      .forEach((u) => stationen.add(u));
  }

  for (const url of stationen) {
    const t = await (await fetch(url)).text();
    const id = (t.match(/"stationId":(\d+)/) || [])[1];
    if (!id) continue;

    const titel =
      (t.match(/property="og:title" content="([^"]+)"/) ||
       t.match(/<title>([^<]+)<\/title>/) || [])[1] || '';

    // HTML-Entities auflösen, sonst landet "Van &amp; Truck" in der Datei.
    const ta = document.createElement('textarea');
    ta.innerHTML = clean(titel);
    let name = ta.value;

    // Manche Stationen heißen im Titel nur "LKW" — dann den Slug nehmen.
    if (name === 'LKW' || name.length < 3) {
      const teile = url.split('/').filter(Boolean);
      name = teile[teile.length - 1].split('-')
        .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') + ' (LKW)';
    }

    const iata = (titel.match(/\(([A-Z]{3})\)/) || [])[1] || '';
    zeilen.push(`${id}|${iso}|${iata}|${name}`);
  }
  console.log(`${slug}: fertig`);
}

console.log(zeilen.join('\n'));
```

4. Ergebnis an `src/data/stations.sixt.txt` anhängen (oder die Datei ersetzen).
5. `node build.mjs` — doppelte IDs werden dabei gemeldet und übersprungen.

Bitte in Maßen laufen lassen: das sind echte Seitenaufrufe auf sixt.de.

### Direkt in die Datei schreiben

Läuft `node tools/serve.mjs`, nimmt der Dienst die Zeilen auch direkt entgegen:

```js
await fetch('http://127.0.0.1:4173/api/stations-import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: '<Token aus dem Terminal>',
                         file: 'stations.sixt.txt', rows: zeilen }),
});
```

Das Token gibt der Dienst beim Start aus; ohne Token wird abgelehnt, damit nicht
jede beliebige offene Seite die Datei überschreiben kann.

Von `sixt.de` aus scheitert der Aufruf allerdings an deren Content-Security-Policy —
dort bleibt nur der Weg über die Konsolenausgabe.

## Einzelne Station von Hand ergänzen

Schneller, wenn nur eine Station fehlt:

1. Station auf sixt.de normal suchen und die Stationsseite öffnen.
2. Im Seitenquelltext (Strg+U) nach `stationId` suchen.
3. Zeile anhängen: `<id>|<land>|<iata oder leer>|<Name>`
4. `node build.mjs`

## Format

```
id|land|iata|name
110|DE|FRA|Frankfurt Flughafen (FRA)
168|DE||München Hauptbahnhof
```

Zeilen mit `#` sind Kommentare. Das `iata`-Feld darf leer bleiben; es dient der
Suche (Eingabe `FRA` findet die Station sofort) und der Zuordnung im
Anbieter-Vergleich, wo Flughäfen darüber exakt gematcht werden.
