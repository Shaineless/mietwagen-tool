/**
 * Bewegter Hintergrund mit waehlbarem Thema.
 *
 * Drei Regeln, die alle Themen einhalten:
 *
 * 1. Die Bewegung bleibt oben. Die Leinwand liegt hinter der Seite und wird
 *    nach unten hin ausgeblendet (Maske in styles.css), damit unter der
 *    Preistabelle nichts wandert — Zahlen, die man vergleicht, brauchen einen
 *    ruhigen Grund.
 * 2. Sie ist sichtbar, aber nie schneller als der Blick. Der erste Entwurf
 *    lief in 68 bis 113 Sekunden pro Umlauf und wirkte dadurch wie ein Standbild.
 * 3. Sie kostet nichts, wenn niemand hinsieht: bei verstecktem Tab haelt die
 *    Schleife an, bei "Bewegung reduzieren" wird ein einziges Standbild
 *    gezeichnet.
 */

const LS_HG = 'mwt-preistool/hintergrund';

const THEMEN = [
  { id: 'space', name: 'Space', beschreibung: 'Sternenfeld mit Sternschnuppen' },
  { id: 'sakura', name: 'Sakura', beschreibung: 'Fallende Kirschblüten' },
  { id: 'sixt', name: 'Sixt', beschreibung: 'Orange Lichtspuren' },
  { id: 'aus', name: 'Aus', beschreibung: 'Ruhiger, einfarbiger Grund' },
];

let aktuellesThema = 'space';
let leinwand = null;
let ctx = null;
let breite = 0;
let hoehe = 0;
let teilchen = [];
let laeuft = false;
let letzterTakt = 0;
let rafId = 0;

const zufall = (min, max) => min + Math.random() * (max - min);

/**
 * Weisse Sterne auf hellem Grund sind unsichtbar. Statt das Thema im Hellen
 * wegzulassen, kehrt sich der Sternenton um — nachts weiss, tags ein dunkles
 * Blaugrau. Rosa Blueten und oranges Licht tragen auf beidem und bleiben.
 */
let dunkel = true;

function beobachteFarbschema() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  dunkel = mq.matches;
  mq.addEventListener('change', (e) => {
    dunkel = e.matches;
  });
}

const sternTon = (a) =>
  dunkel ? `rgba(255,255,255,${a})` : `rgba(52,60,86,${(a * 0.85).toFixed(3)})`;

/* ---------------------------------------------------------------- Themen */

/**
 * Jedes Thema erzeugt seine Teilchen selbst und zeichnet einen Schritt.
 * `dt` ist die vergangene Zeit in Sekunden — die Bewegung haengt damit an der
 * Uhr, nicht an der Bildrate. Auf einem 144-Hz-Schirm laeuft sonst alles
 * doppelt so schnell wie auf einem 60-Hz-Schirm.
 */
const MOTOREN = {
  /* --- Space: drei Sternenebenen mit Parallaxe, dazu Sternschnuppen --- */
  space: {
    erzeuge() {
      const dichte = Math.round((breite * hoehe) / 9000);
      const sterne = [];
      for (let i = 0; i < Math.min(dichte, 260); i++) {
        // Ebene 0 ist am weitesten weg: klein, dunkel, langsam.
        const ebene = Math.random() < 0.55 ? 0 : Math.random() < 0.7 ? 1 : 2;
        sterne.push({
          x: Math.random() * breite,
          y: Math.random() * hoehe,
          r: [0.6, 1, 1.6][ebene] * zufall(0.7, 1.3),
          v: [5, 11, 20][ebene] * zufall(0.8, 1.2),
          hell: [0.35, 0.6, 0.9][ebene] * zufall(0.7, 1),
          // Funkeln: eigene Phase, damit nicht alle im Takt blinken.
          phase: Math.random() * Math.PI * 2,
          takt: zufall(0.4, 1.4),
        });
      }
      return { sterne, schnuppen: [], bisSchnuppe: zufall(1.5, 4) };
    },

    schritt(s, dt, statisch) {
      ctx.clearRect(0, 0, breite, hoehe);

      for (const st of s.sterne) {
        if (!statisch) {
          st.x -= st.v * dt;
          st.phase += dt * st.takt;
          if (st.x < -4) {
            st.x = breite + 4;
            st.y = Math.random() * hoehe;
          }
        }
        const a = st.hell * (0.72 + 0.28 * Math.sin(st.phase));
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fillStyle = sternTon(a.toFixed(3));
        ctx.fill();
      }

      if (statisch) return;

      // Sternschnuppen sind das, was den Blick kurz hebt — deshalb selten.
      s.bisSchnuppe -= dt;
      if (s.bisSchnuppe <= 0) {
        s.bisSchnuppe = zufall(2.5, 7);
        s.schnuppen.push({
          x: zufall(breite * 0.25, breite * 1.05),
          y: zufall(-20, hoehe * 0.55),
          v: zufall(620, 1000),
          laenge: zufall(90, 200),
          leben: 0,
          dauer: zufall(0.6, 1.1),
        });
      }

      for (let i = s.schnuppen.length - 1; i >= 0; i--) {
        const f = s.schnuppen[i];
        f.leben += dt;
        if (f.leben > f.dauer) {
          s.schnuppen.splice(i, 1);
          continue;
        }
        const t = f.leben / f.dauer;
        // Auf- und abschwellen, damit nichts hart erscheint oder abreisst.
        const a = Math.sin(t * Math.PI) * 0.85;
        f.x -= f.v * dt;
        f.y += f.v * 0.32 * dt;

        const x2 = f.x + f.laenge;
        const y2 = f.y - f.laenge * 0.32;
        const g = ctx.createLinearGradient(f.x, f.y, x2, y2);
        g.addColorStop(0, sternTon(a.toFixed(3)));
        g.addColorStop(0.4, sternTon((a * 0.4).toFixed(3)));
        g.addColorStop(1, sternTon('0'));
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(f.x, f.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    },
  },

  /* --- Sakura: fallende Blueten, jede mit eigener Drehung und Pendelbahn --- */
  sakura: {
    erzeuge() {
      const anzahl = Math.min(Math.round((breite * hoehe) / 26000), 70);
      const blueten = [];
      for (let i = 0; i < anzahl; i++) {
        blueten.push(neueBluete(Math.random() * hoehe));
      }
      return { blueten };
    },

    schritt(s, dt, statisch) {
      ctx.clearRect(0, 0, breite, hoehe);
      for (let i = 0; i < s.blueten.length; i++) {
        const b = s.blueten[i];
        if (!statisch) {
          b.t += dt;
          b.y += b.fall * dt;
          // Pendeln um die eigene Bahn — Blueten fallen nicht senkrecht.
          b.x += Math.sin(b.t * b.pendel) * b.weite * dt + b.wind * dt;
          b.dreh += b.drehV * dt;
          if (b.y > hoehe + 20) s.blueten[i] = neueBluete(-20);
          else if (b.x > breite + 30) b.x = -30;
          else if (b.x < -30) b.x = breite + 30;
        }
        zeichneBluete(b);
      }
    },
  },

  /* --- Sixt: orange Lichtspuren, wie Scheinwerfer in der Langzeitbelichtung --- */
  sixt: {
    erzeuge() {
      const anzahl = Math.min(Math.round(breite / 46), 34);
      const spuren = [];
      for (let i = 0; i < anzahl; i++) spuren.push(neueSpur(true));
      // Ein paar langsam steigende Funken darunter, damit die Flaeche zwischen
      // den Spuren nicht tot wirkt.
      const funken = [];
      for (let i = 0; i < Math.min(Math.round(breite / 40), 40); i++) {
        funken.push({
          x: Math.random() * breite,
          y: Math.random() * hoehe,
          r: zufall(0.8, 2.2),
          v: zufall(6, 18),
          a: zufall(0.15, 0.5),
          phase: Math.random() * Math.PI * 2,
        });
      }
      return { spuren, funken };
    },

    schritt(s, dt, statisch) {
      ctx.clearRect(0, 0, breite, hoehe);

      for (const f of s.funken) {
        if (!statisch) {
          f.y -= f.v * dt;
          f.phase += dt * 1.1;
          if (f.y < -6) {
            f.y = hoehe + 6;
            f.x = Math.random() * breite;
          }
        }
        const a = f.a * (0.6 + 0.4 * Math.sin(f.phase));
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,170,80,${a.toFixed(3)})`;
        ctx.fill();
      }

      for (let i = 0; i < s.spuren.length; i++) {
        const sp = s.spuren[i];
        if (!statisch) {
          sp.x += sp.v * dt;
          sp.y += sp.v * 0.42 * dt;
          if (sp.x - sp.laenge > breite || sp.y - sp.laenge * 0.42 > hoehe) {
            s.spuren[i] = neueSpur(false);
            continue;
          }
        }
        const x0 = sp.x - sp.laenge;
        const y0 = sp.y - sp.laenge * 0.42;
        const g = ctx.createLinearGradient(x0, y0, sp.x, sp.y);
        g.addColorStop(0, 'rgba(255,120,0,0)');
        g.addColorStop(0.75, `rgba(255,125,20,${(sp.a * 0.55).toFixed(3)})`);
        g.addColorStop(1, `rgba(255,205,150,${sp.a.toFixed(3)})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = sp.dick;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(sp.x, sp.y);
        ctx.stroke();
      }
    },
  },
};

/* ------------------------------------------------------------- Bausteine */

function neueBluete(y) {
  const groesse = zufall(6, 15);
  return {
    x: Math.random() * breite,
    y,
    g: groesse,
    // Grosse Blueten sind naeher und fallen schneller — das gibt Tiefe.
    fall: groesse * zufall(3.4, 5.2),
    pendel: zufall(0.7, 1.8),
    weite: zufall(14, 40),
    wind: zufall(6, 22),
    dreh: Math.random() * Math.PI * 2,
    drehV: zufall(-1.6, 1.6),
    t: Math.random() * 10,
    a: zufall(0.32, 0.78),
    ton: Math.random() < 0.25 ? [255, 226, 236] : [255, 183, 206],
  };
}

/**
 * Eine Bluete als zwei gespiegelte Bezier-Boegen: von weitem genau die
 * Herzform eines Kirschblueten-Blattes, und billiger als ein Bild.
 */
function zeichneBluete(b) {
  const [r, g, bl] = b.ton;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.dreh);
  // Die Drehung um die Laengsachse: das Blatt wird schmal und wieder breit.
  ctx.scale(Math.max(0.25, Math.abs(Math.cos(b.t * 1.3))), 1);
  ctx.beginPath();
  ctx.moveTo(0, -b.g / 2);
  ctx.bezierCurveTo(b.g * 0.55, -b.g * 0.35, b.g * 0.42, b.g * 0.45, 0, b.g / 2);
  ctx.bezierCurveTo(-b.g * 0.42, b.g * 0.45, -b.g * 0.55, -b.g * 0.35, 0, -b.g / 2);
  ctx.fillStyle = `rgba(${r},${g},${bl},${b.a.toFixed(3)})`;
  ctx.fill();
  ctx.restore();
}

function neueSpur(verteilt) {
  const laenge = zufall(70, 260);
  return {
    // Beim ersten Aufbau ueber das Bild verteilt, danach von links unten neu.
    x: verteilt ? Math.random() * breite : zufall(-breite * 0.35, 0),
    y: verteilt ? Math.random() * hoehe : zufall(-hoehe * 0.3, hoehe),
    v: zufall(90, 260),
    laenge,
    dick: zufall(1, 2.6),
    a: zufall(0.18, 0.6),
  };
}

/* ---------------------------------------------------------------- Ablauf */

function magBewegung() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function passeGroesseAn() {
  if (!leinwand) return;
  // Ueber 2 bringt mehr Pixel keinen sichtbaren Gewinn, kostet aber Fläche.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  breite = leinwand.clientWidth;
  hoehe = leinwand.clientHeight;
  leinwand.width = Math.round(breite * dpr);
  leinwand.height = Math.round(hoehe * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function baueAuf() {
  const motor = MOTOREN[aktuellesThema];
  if (!motor || !breite || !hoehe) {
    teilchen = null;
    return;
  }
  teilchen = motor.erzeuge();
}

function takt(jetzt) {
  rafId = 0;
  if (!laeuft) return;
  const dt = Math.min((jetzt - letzterTakt) / 1000, 0.05); // Sprung nach Tab-Wechsel abfangen
  letzterTakt = jetzt;
  MOTOREN[aktuellesThema]?.schritt(teilchen, dt, false);
  rafId = requestAnimationFrame(takt);
}

function starte() {
  if (laeuft || !ctx) return;
  if (!MOTOREN[aktuellesThema] || !teilchen) return;
  if (!magBewegung()) {
    // Ein Standbild statt einer Schleife: die Gestaltung bleibt, die Bewegung
    // faellt weg. Ganz leer waere eine Verschlechterung, keine Ruecksicht.
    MOTOREN[aktuellesThema].schritt(teilchen, 0, true);
    return;
  }
  laeuft = true;
  letzterTakt = performance.now();
  rafId = requestAnimationFrame(takt);
}

function halte() {
  laeuft = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/* ------------------------------------------------------------- Oberfläche */

function setzeThema(id, merken = true) {
  if (!THEMEN.some((t) => t.id === id)) id = 'space';
  aktuellesThema = id;
  document.querySelector('.schleier')?.setAttribute('data-thema', id);
  if (merken) {
    try {
      localStorage.setItem(LS_HG, id);
    } catch {}
  }

  halte();
  if (ctx) ctx.clearRect(0, 0, breite, hoehe);
  if (leinwand) leinwand.hidden = id === 'aus';

  if (id !== 'aus') {
    baueAuf();
    starte();
  }
  zeichneWahl();
}

/** Die Auswahl steht in jedem Behaelter mit [data-hintergrundwahl]. */
function zeichneWahl() {
  for (const behaelter of document.querySelectorAll('[data-hintergrundwahl]')) {
    if (!behaelter.firstChild) {
      for (const t of THEMEN) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hgs';
        b.dataset.thema = t.id;
        b.title = `${t.name} — ${t.beschreibung}`;
        b.setAttribute('aria-label', `Hintergrund: ${t.name}`);
        b.addEventListener('click', () => setzeThema(t.id));
        behaelter.appendChild(b);
      }
    }
    for (const b of behaelter.children) {
      b.setAttribute('aria-pressed', String(b.dataset.thema === aktuellesThema));
    }
  }
}

let groessenTimer = 0;

export function starteHintergrund() {
  leinwand = document.querySelector('#schleierLeinwand');
  if (!leinwand) return;
  ctx = leinwand.getContext('2d');
  beobachteFarbschema();

  let gemerkt = null;
  try {
    gemerkt = localStorage.getItem(LS_HG);
  } catch {}

  passeGroesseAn();
  setzeThema(gemerkt || 'space', false);

  window.addEventListener('resize', () => {
    clearTimeout(groessenTimer);
    // Waehrend des Ziehens jedes Mal neu aufzubauen ruckelt sichtbar.
    groessenTimer = setTimeout(() => {
      const lief = laeuft;
      halte();
      passeGroesseAn();
      if (aktuellesThema !== 'aus') {
        baueAuf();
        if (lief || magBewegung()) starte();
      }
    }, 180);
  });

  // Im versteckten Tab zeichnet der Browser ohnehin nichts Sichtbares — dann
  // soll die Schleife auch keine Rechenzeit kosten.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) halte();
    else if (aktuellesThema !== 'aus') starte();
  });

  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    halte();
    if (aktuellesThema !== 'aus') starte();
  });
}
