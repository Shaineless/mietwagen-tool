/**
 * Eine echte Excel-Mappe schreiben, ohne Fremdbibliothek.
 *
 * Eine .xlsx ist ein ZIP aus XML-Dateien. Das laesst sich von Hand bauen, und
 * genau das passiert hier — aus zwei Gruenden:
 *
 *   1. Die freie Fassung von SheetJS kann keine Zellformate. Ohne die waere
 *      das Ergebnis nur eine CSV mit anderer Endung, und die gibt es schon.
 *   2. ExcelJS kann sie, wiegt aber ein Vielfaches der ganzen heutigen
 *      Oberflaeche. Fuer ein Werkzeug, das als eine Datei ausgeliefert wird,
 *      ist das kein Tausch, den man machen will.
 *
 * Komprimiert wird nicht (ZIP-Methode 0). Deflate waere nochmal eine eigene
 * Implementierung; die Ersparnis lohnt bei diesen Datenmengen nicht.
 *
 * Alles laeuft im Browser — die Mappe entsteht also auch in der
 * eigenstaendigen HTML-Datei, ohne laufenden Dienst.
 */

/* ------------------------------------------------------------------ ZIP */

const CRC_TABELLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABELLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Datum und Zeit im DOS-Format, wie es der ZIP-Kopf verlangt.
 *
 * Vor 1980 gibt es dort nicht — und das ist keine theoretische Grenze: eine
 * falsch gestellte Uhr wuerde sonst eine Mappe erzeugen, die Excel nicht
 * oeffnet.
 */
function dosZeit(d = new Date()) {
  const jahr = Math.max(1980, d.getFullYear());
  return {
    zeit: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    datum: ((jahr - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Eine ZIP-Datei aus benannten Textinhalten.
 * @param {Array<{name: string, text: string}>} dateien
 * @returns {Blob}
 */
function zip(dateien) {
  const enc = new TextEncoder();
  const { zeit, datum } = dosZeit();
  const teile = [];
  const verzeichnis = [];
  let versatz = 0;

  for (const d of dateien) {
    const name = enc.encode(d.name);
    const inhalt = enc.encode(d.text);
    const summe = crc32(inhalt);

    const kopf = new DataView(new ArrayBuffer(30));
    kopf.setUint32(0, 0x04034b50, true); // Signatur
    kopf.setUint16(4, 20, true); // benoetigte Version
    kopf.setUint16(6, 0x0800, true); // Bit 11: Name ist UTF-8
    kopf.setUint16(8, 0, true); // Methode 0 = gespeichert
    kopf.setUint16(10, zeit, true);
    kopf.setUint16(12, datum, true);
    kopf.setUint32(14, summe, true);
    kopf.setUint32(18, inhalt.length, true);
    kopf.setUint32(22, inhalt.length, true);
    kopf.setUint16(26, name.length, true);
    kopf.setUint16(28, 0, true); // kein Zusatzfeld

    teile.push(new Uint8Array(kopf.buffer), name, inhalt);
    verzeichnis.push({ name, summe, laenge: inhalt.length, versatz });
    versatz += 30 + name.length + inhalt.length;
  }

  const zentralAb = versatz;
  for (const e of verzeichnis) {
    const k = new DataView(new ArrayBuffer(46));
    k.setUint32(0, 0x02014b50, true);
    k.setUint16(4, 20, true); // erzeugende Version
    k.setUint16(6, 20, true); // benoetigte Version
    k.setUint16(8, 0x0800, true);
    k.setUint16(10, 0, true);
    k.setUint16(12, zeit, true);
    k.setUint16(14, datum, true);
    k.setUint32(16, e.summe, true);
    k.setUint32(20, e.laenge, true);
    k.setUint32(24, e.laenge, true);
    k.setUint16(28, e.name.length, true);
    k.setUint16(30, 0, true); // Zusatzfeld
    k.setUint16(32, 0, true); // Kommentar
    k.setUint16(34, 0, true); // Datentraeger
    k.setUint16(36, 0, true); // interne Attribute
    k.setUint32(38, 0, true); // externe Attribute
    k.setUint32(42, e.versatz, true);
    teile.push(new Uint8Array(k.buffer), e.name);
    versatz += 46 + e.name.length;
  }

  const ende = new DataView(new ArrayBuffer(22));
  ende.setUint32(0, 0x06054b50, true);
  ende.setUint16(8, verzeichnis.length, true);
  ende.setUint16(10, verzeichnis.length, true);
  ende.setUint32(12, versatz - zentralAb, true);
  ende.setUint32(16, zentralAb, true);
  teile.push(new Uint8Array(ende.buffer));

  return new Blob(teile, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ------------------------------------------------------------------ XML */

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    // Steuerzeichen sind in XML 1.0 nicht erlaubt und lassen Excel die Datei
    // rundheraus abweisen. Modellnamen kommen aus fremdem HTML — da ist alles
    // moeglich.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Spaltenbuchstabe: 0 → A, 25 → Z, 26 → AA. */
function spalte(i) {
  let s = '';
  for (let n = i + 1; n > 0; ) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ---------------------------------------------------------------- Stile
 *
 * Die Reihenfolge in styles.xml ist die Nummerierung: Zelle mit s="3" meint
 * den vierten Eintrag in cellXfs. Deshalb stehen die Nummern als Konstanten
 * daneben — ein verrutschter Index faellt sonst erst in Excel auf.
 */

export const STIL = {
  normal: 0,
  titel: 1,
  kopfzeile: 2,
  betrag: 3,
  betragBest: 4,
  klein: 5,
  fett: 6,
  betragGrau: 7,
};

function stylesXml(waehrung) {
  // Ein Zahlenformat je Mappe: die Waehrung steht in der Zelle, damit
  // niemand die Einheit erraten muss.
  const fmt = `#,##0.00\\ &quot;${esc(waehrung || '')}&quot;`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="${fmt}"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="16"/><color rgb="FF1A1A1E"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><sz val="9"/><color rgb="FF77787F"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF1A1A1E"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F6DD0"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3F1E6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E4EA"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
</cellXfs>
</styleSheet>`;
}

/* --------------------------------------------------------------- Blätter */

/**
 * Ein Blatt aus Zeilen.
 *
 * Eine Zelle ist entweder ein Wert (Text/Zahl) oder `{w, s}` mit Wert und
 * Stilnummer. `null` laesst die Zelle leer — anders als eine leere
 * Zeichenkette, die Excel als Text zaehlt.
 */
function sheetXml(blatt) {
  const { zeilen, breiten = [], frieren = 0, filter = null, farbskala = null } = blatt;

  const cols = breiten.length
    ? `<cols>${breiten
        .map((b, i) => `<col min="${i + 1}" max="${i + 1}" width="${b}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';

  const body = zeilen
    .map((zeile, r) => {
      const zellen = (zeile || [])
        .map((z, c) => {
          if (z == null) return '';
          const wert = z && typeof z === 'object' ? z.w : z;
          const stil = z && typeof z === 'object' ? z.s || 0 : 0;
          if (wert == null || wert === '') return '';
          const ref = `${spalte(c)}${r + 1}`;
          const s = stil ? ` s="${stil}"` : '';
          return typeof wert === 'number' && Number.isFinite(wert)
            ? `<c r="${ref}"${s}><v>${wert}</v></c>`
            : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(wert)}</t></is></c>`;
        })
        .join('');
      return zellen ? `<row r="${r + 1}">${zellen}</row>` : '';
    })
    .join('');

  // Kopfzeile fixieren: beim Scrollen durch fünfzig Klassen soll oben stehen
  // bleiben, welche Länderseite welche Spalte ist.
  const pane = frieren
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${frieren}" topLeftCell="A${
        frieren + 1
      }" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  const auto = filter ? `<autoFilter ref="${filter}"/>` : '';

  // Farbskala: teuer und billig fallen ins Auge, ohne dass man Zahlen liest.
  const cf = farbskala
    ? `<conditionalFormatting sqref="${farbskala}"><cfRule type="colorScale" priority="1">` +
      '<colorScale><cfvo type="min"/><cfvo type="max"/>' +
      '<color rgb="FFD8EBDD"/><color rgb="FFF8D9D6"/></colorScale></cfRule></conditionalFormatting>'
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData>${auto}${cf}</worksheet>`;
}

/* ------------------------------------------------------------ Mappe bauen */

/**
 * @param {Array<{name: string, zeilen: Array, breiten?: number[],
 *   frieren?: number, filter?: string, farbskala?: string}>} blaetter
 * @param {string} waehrung  bestimmt das Zahlenformat der Betragszellen
 * @returns {Blob}
 */
export function mappe(blaetter, waehrung) {
  // Excel verbietet in Blattnamen : \ / ? * [ ] und mehr als 31 Zeichen.
  // Ein Blattname wie "Preise Köln/Bonn" käme sonst als kaputte Datei an.
  const gesehen = new Set();
  const namen = blaetter.map((b, i) => {
    let n =
      String(b.name || `Blatt${i + 1}`)
        .replace(/[:\\/?*[\]]/g, '-')
        .slice(0, 31)
        // Ein angeschnittener Name endet leicht auf Leerzeichen oder
        // Trennstrich — das sieht nach Versehen aus, weil es eines ist.
        .replace(/[\s·\-—]+$/, '')
        .trim() || `Blatt${i + 1}`;
    while (gesehen.has(n.toLowerCase())) n = n.slice(0, 28).trim() + '_' + (i + 1);
    gesehen.add(n.toLowerCase());
    return n;
  });

  const dateien = [
    {
      name: '[Content_Types].xml',
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        blaetter
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        namen
          .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        blaetter
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${
                i + 1
              }.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${blaetter.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', text: stylesXml(waehrung) },
    ...blaetter.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(b) })),
  ];

  return zip(dateien);
}
