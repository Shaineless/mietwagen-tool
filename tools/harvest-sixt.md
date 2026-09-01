# Sixt-Stationen nachladen

Die Stationsliste in `src/data/stations.sixt.txt` stammt aus den **öffentlichen
Stationsseiten** auf sixt.de (`/mietwagen/<land>/<stadt>/<station>/`). Jede
dieser Seiten enthält im Seitenquelltext die numerische Stations-ID:

```
window.sixt.webapp["rentsearch"] = ... {"stationId":110}
```

Genau diese ID ist der `uci`-Parameter, den das Tool baut.

Aktuell enthalten: **DE, AT, CH, ES, IT, FR, NL, PT, GB**. Sixt listet rund
110 Länder — die übrigen lassen sich bei Bedarf nachladen.

## Weitere Länder ergänzen

Es gibt keine offizielle Stations-API, deshalb läuft das Nachladen über die
Browser-Konsole auf sixt.de (gleiche Herkunft, damit `fetch` erlaubt ist).

1. <https://www.sixt.de/mietwagen/standorte/> öffnen — dort stehen alle
   Länder-Slugs (z. B. `polen`, `griechenland`, `kroatien`).
2. Entwicklertools öffnen (F12) → Konsole.
3. Skript einfügen, `LAENDER` anpassen, ausführen:

```js
const LAENDER = { polen: 'PL', griechenland: 'GR', kroatien: 'HR' };

const clean = (raw = '') =>
  raw.replace(/^ᐅ\s*/, '').split('|')[0]
     .replace(/^SIXT\s+/i, '')
     .replace(/^Mietwagen\s+(am\s+|in\s+)?/i, '')
     .replace(/\s+(günstig|mieten|buchen|reservieren)\b.*$/i, '')
     .replace(/\s+Autovermietung.*$/i, '')
     .trim();

const zeilen = [];
for (const [slug, iso] of Object.entries(LAENDER)) {
  const land = await (await fetch(`/mietwagen/${slug}/`)).text();
  const staedte = [...new Set(land.match(
    new RegExp(`/mietwagen/${slug}/[a-z0-9\\-]+/`, 'gi')) || [])];

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
    const titel = (t.match(/property="og:title" content="([^"]+)"/) ||
                   t.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
    const name = clean(titel);
    const iata = (titel.match(/\(([A-Z]{3})\)/) || [])[1] || '';
    if (name && name !== 'LKW') zeilen.push(`${id}|${iso}|${iata}|${name}`);
  }
  console.log(`${slug}: fertig`);
}

copy(zeilen.join('\n')); // liegt jetzt in der Zwischenablage
```

4. Das Ergebnis unten an `src/data/stations.sixt.txt` anhängen.
5. `node build.mjs` — doppelte IDs werden dabei gemeldet und übersprungen.

Bitte in Maßen laufen lassen: das sind echte Seitenaufrufe auf sixt.de.
Ein Land mit ~100 Stationen bedeutet ~100 Abrufe.

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

Zeilen mit `#` sind Kommentare. Das `iata`-Feld darf leer bleiben; es dient
nur der Suche (Eingabe `FRA` findet die Station sofort).
