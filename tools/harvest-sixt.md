# Sixt-Stationen erneuern

Die Stationsliste in `src/data/stations.sixt.txt` stammt aus **Sixts eigener
Sitemap** — der Liste, die Sixt selbst für Suchmaschinen veröffentlicht:

```
https://www.sixt.de/robots.txt          →  Sitemap: /sitemap_index.xml
https://www.sixt.de/mietwagen/sitemap.xml   →  rund 2255 Stationsseiten
```

Jede Stationsseite trägt die Nummer im Quelltext:

```
window.sixt.webapp["rentsearch"] = ... {"stationId":110}
```

Genau diese Nummer ist der `uci`-Parameter, den das Tool baut.

## Warum die Sitemap und nicht die Städteseiten

Der erste Anlauf lief über `/mietwagen/<land>/` → Städteseiten → Stationsseiten
und fand 1779 Stationen. Das klang vollständig, war es aber nicht: Sixt verlinkt
auf den Städteseiten nur einen Teil. **476 Stationen fehlten** — vor allem die
Agenturen: Bonn Bad Godesberg, Bonn Zentrum, Euskirchen, Siegburg und viele
mehr. Über die Sitemap sind es 2250.

Wer die Liste erneuert: **immer über die Sitemap.**

## Erneuern

1. Eine **HTML**-Seite auf sixt.de öffnen, etwa
   <https://www.sixt.de/mietwagen/deutschland/>.

   Nicht die Sitemap-XML-Datei selbst! In einem XML-Dokument wirft
   `textarea.innerHTML` einen Fehler, und die Entity-Dekodierung
   (`K&ouml;ln` → `Köln`) schlägt still fehl. Ergebnis waren 2250 Stationen
   mit Namen aus dem URL-Slug: „Bad Toelz" statt „Bad Tölz". Für die Suche ist
   das wertlos, weil die Umlaut-Faltung `ö`→`o` erwartet, nicht `oe`.

2. Entwicklertools (F12) → Konsole.
3. Skript einfügen und ausführen. Rund 2255 Abrufe, etwa sieben Minuten.

```js
const ISO = { deutschland: 'DE', oesterreich: 'AT', schweiz: 'CH' /* … */ };

const sm = await (await fetch('/mietwagen/sitemap.xml')).text();
// Stationsseiten sind genau vier Pfadstufen tief:
// /mietwagen/<land>/<stadt>/<station>/
const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => new URL(m[1]).pathname)
  .filter((u) => u.split('/').filter(Boolean).length === 4);

// Rohtitel mitspeichern: dann lässt sich die Namensaufbereitung später
// ändern, ohne 2255 Seiten erneut zu laden.
const roh = {};
for (const u of urls) {
  try {
    const t = await (await fetch(u)).text();
    roh[u] = {
      id: (t.match(/"stationId":(\d+)/) || [])[1],
      titel:
        (t.match(/property="og:title" content="([^"]+)"/) ||
         t.match(/<title>([^<]+)<\/title>/) || [])[1] || '',
    };
  } catch { roh[u] = { err: 1 }; }
}

const entschluessele = (s) => {
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
};

const saeubere = (titel) =>
  entschluessele(
    titel.replace(/^ᐅ\s*/, '').split('|')[0]
      .replace(/^(Buchen Sie|Entdecken Sie|Mehr Komfort mit|Jetzt einen|Vorteile der)\s+/i, '')
      .replace(/\bSIXT\s+Mietwagen\s+(am|in|auf)\s+/i, '')
      .replace(/^►\s*/, '').replace(/^SIXT\s+/i, '')
      .replace(/^Mietwagen\s+(am\s+|in\s+|auf\s+)?/i, '')
      .replace(/\s+(günstig|mieten|buchen|reservieren|entdecken|finden)\b.*$/i, '')
      .replace(/\s+bei\s+SIXT.*$/i, '').replace(/\s+mit\s+SIXT\s*$/i, '')
      .replace(/\s+Autovermietung.*$/i, '').trim()
  );

const gesehen = new Set();
const zeilen = [];
for (const [u, r] of Object.entries(roh)) {
  if (!r.id || gesehen.has(r.id)) continue;
  gesehen.add(r.id);
  const teile = u.split('/').filter(Boolean);
  let name = saeubere(r.titel);
  if (!name || name.length < 3 || name === 'LKW') {
    name = teile[teile.length - 1].split('-')
      .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  const iata = (r.titel.match(/\(([A-Z]{3})\)/) || [])[1] || '';
  zeilen.push(`${r.id}|${ISO[teile[1]] || '??'}|${iata}|${name}`);
}
console.log(zeilen.length + ' Stationen');
console.log(zeilen.join('\n'));
```

4. Ergebnis nach `src/data/stations.sixt.txt` (Kopfzeilen mit `#` behalten).
5. `node build.mjs` — doppelte Nummern werden gemeldet und übersprungen.

## Wichtig: nicht gleichzeitig Preise abrufen

Während der Ernte laufen 2255 Abrufe gegen sixt.de. Läuft parallel ein
Preisabruf, wird der ausgebremst und scheitert reihenweise mit „Station wurde
nicht übernommen" — nachgemessen. Also erst ernten, dann Preise holen.

## Einzelne Station ergänzen

Schneller, wenn nur eine fehlt — geht auch direkt in der Oberfläche unter
„Station fehlt? Nummer von Hand eintragen":

1. Stationsseite auf sixt.de öffnen.
2. Quelltext (Strg+U), nach `stationId` suchen.
3. Zeile anhängen: `<nummer>|<land>|<iata oder leer>|<Name>`

## Format

```
id|land|iata|name
110|DE|FRA|Frankfurt Flughafen (FRA)
2442|DE||Bonn Bad Godesberg
```

Zeilen mit `#` sind Kommentare. Das `iata`-Feld darf leer bleiben; es dient der
Suche — die Eingabe `FRA` findet die Station sofort.
