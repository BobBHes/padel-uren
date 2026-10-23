'use strict';
// Padel Uren: lessen bijhouden en (stap 2) factureren. Alle data staat in IndexedDB op het toestel.
// Bedragen in centen, tarieven zijn uurtarieven incl. btw per persoon.

/* ---------- Opslag ---------- */
const DB = (() => {
  let open;
  const db = () => open || (open = new Promise((ok, fout) => {
    const r = indexedDB.open('padel-uren', 2);
    r.onupgradeneeded = () => {
      const d = r.result; // versie 2: facturen erbij
      for (const s of ['klanten', 'lessen', 'facturen']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('instellingen')) d.createObjectStore('instellingen');
    };
    r.onsuccess = () => {
      // Geef de database vrij als een andere tab (of een herstel) een nieuwe versie wil
      r.result.onversionchange = () => { r.result.close(); open = null; };
      ok(r.result);
    };
    r.onerror = () => fout(r.error);
  }));
  const tx = async (store, modus, fn) => {
    const d = await db();
    return new Promise((ok, fout) => {
      const t = d.transaction(store, modus);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => ok(req && req.result);
      t.onerror = () => fout(t.error);
    });
  };
  return {
    alle: s => tx(s, 'readonly', st => st.getAll()),
    zet: (s, v, k) => tx(s, 'readwrite', st => st.put(v, k)),
    haal: (s, k) => tx(s, 'readonly', st => st.get(k)),
    weg: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
    // Alles in één keer vervangen (back-up terugzetten): lukt het niet, dan blijft alles zoals het was
    vervang: async data => {
      const d = await db();
      return new Promise((ok, fout) => {
        const t = d.transaction(['klanten', 'lessen', 'facturen', 'instellingen'], 'readwrite');
        for (const s of ['klanten', 'lessen', 'facturen']) { const st = t.objectStore(s); st.clear(); (data[s] || []).forEach(x => st.put(x)); }
        const i = t.objectStore('instellingen'); i.clear(); if (data.ik) i.put(data.ik, 'ik');
        t.oncomplete = () => ok(); t.onerror = t.onabort = () => fout(t.error);
      });
    },
  };
})();

const S = { view: 'lessen', fview: 'te', klanten: [], lessen: [], facturen: [], ik: {} };
const VIEWS = ['lessen', 'facturen', 'stats', 'klanten'];
const STANDAARD_BERICHT = 'Hoi {voornaam},\n\nHierbij factuur {nummer} voor de padellessen ({bedrag}). Wil je dit vóór {vervaldatum} overmaken naar {iban} t.n.v. {tnv}, onder vermelding van {nummer}?\n\nBedankt en tot op de baan!\n{naam}';
// Eigen gegevens voor op de factuur en standaardtarieven voor nieuwe klanten
const IK = { naam: '', bedrijf: '', adres: '', email: '', telefoon: '', kvk: '', btw: '', iban: '', tnv: '', termijn: 14, volgnr: 1, jaar: new Date().getFullYear(), prive: 6000, groep: 2500, bericht: STANDAARD_BERICHT };

async function laad() {
  let ik;
  [S.klanten, S.lessen, S.facturen, ik] = await Promise.all([DB.alle('klanten'), DB.alle('lessen'), DB.alle('facturen'), DB.haal('instellingen', 'ik')]);
  S.ik = { ...IK, ...ik };
  S.klanten.sort((a, b) => a.naam.localeCompare(b.naam, 'nl'));
  S.lessen.sort((a, b) => (b.datum + b.tijd).localeCompare(a.datum + a.tijd));
  S.facturen.sort((a, b) => b.nummer.localeCompare(a.nummer));
}

/* ---------- Hulp ---------- */
const $ = s => document.querySelector(s);
const wacht = ms => new Promise(r => setTimeout(r, ms));
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = c => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
const euroKaal = c => (c / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// "45", "45,50", "1.250,00" en "45.5" worden allemaal centen
function centen(tekst) {
  let t = String(tekst).trim().replace(/[€\s]/g, '');
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100);
}
const uren = min => { const u = Math.floor(min / 60), m = Math.round(min % 60); return m ? `${u}:${String(m).padStart(2, '0')} u` : `${u} u`; };
const vandaag = () => new Date().toLocaleDateString('sv-SE');
const datumObj = d => new Date(d + 'T12:00:00');
const klant = kid => S.klanten.find(k => k.id === kid);
const regelBedrag = (les, d) => Math.round(d.tarief * les.duur / 60);
const lesBedrag = les => les.deelnemers.reduce((s, d) => s + regelBedrag(les, d), 0);
const initialen = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
// Gefactureerd per deelnemer (bij een groepsles kan de een al wel, de ander nog niet); l.factuur is van vóór stap 2
const gefact = (l, d) => d.factuur || l.factuur || null;
const kortDatum = d => datumObj(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
const langDatum = d => datumObj(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
const lesOmschrijving = n => n > 1 ? `Groepsles padel (${n} pers.)` : 'Privéles padel';
function ibanOk(iban) { // mod-97 controle
  const s = String(iban).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  let m = 0;
  for (const ch of (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => c.charCodeAt(0) - 55)) m = (m * 10 + +ch) % 97;
  return m === 1;
}
const ibanMooi = s => String(s).replace(/\s/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();

function weekStart(d) {
  const x = datumObj(d); const dag = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dag); return x.toLocaleDateString('sv-SE');
}
function weekLabel(start) {
  const nu = weekStart(vandaag());
  if (start === nu) return 'Deze week';
  const vorig = datumObj(nu); vorig.setDate(vorig.getDate() - 7);
  if (start === vorig.toLocaleDateString('sv-SE')) return 'Vorige week';
  if (start > nu) return 'Gepland';
  const eind = datumObj(start); eind.setDate(eind.getDate() + 6);
  const f = x => x.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  return `${f(datumObj(start))} – ${f(eind)}`;
}
const dezeWeek = () => { const w = weekStart(vandaag()); return S.lessen.filter(l => weekStart(l.datum) === w); };

/* ---------- Toast (met optionele actie, bv. Ongedaan) ---------- */
let toastTimer;
function toast(tekst, { actie, bij, duur = 2400 } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(tekst)}</span>${actie ? `<button type="button">${esc(actie)}</button>` : ''}`;
  if (actie) t.querySelector('button').onclick = () => { t.classList.remove('zicht'); bij(); };
  // Als popover komt de toast ook boven een open sheet (top layer)
  if (t.showPopover) { try { t.hidePopover(); } catch {} t.showPopover(); }
  t.classList.add('zicht');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('zicht'), actie ? Math.max(duur, 5000) : duur);
}

/* ---------- Padel-gimmicks ---------- */
const rustig = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const BAL = '<div class="padelbal"></div>';
const KRETEN = ['Vamos!', 'Punto!', 'Por tres!', 'Bandeja!', 'Víbora!', 'Smash!', 'Chiquita!', 'Globo!'];
const kreet = () => KRETEN[Math.floor(Math.random() * KRETEN.length)];
const midden = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

// Bal vliegt van de plusknop omhoog, stuitert, kaatst tegen de glazen wand links en landt op het balletje in de tabbalk
function vlucht() {
  if (rustig()) return pok(.8);
  const start = midden($('#plus')), doel = midden($('.tabs .pil .padelbal'));
  const H = innerHeight, vloer = start.y - 15, duur = 1700;
  const buiten = document.createElement('div');
  buiten.className = 'vlucht';
  buiten.innerHTML = `<div class="binnen">${BAL}</div>`;
  const muur = document.createElement('div'); muur.className = 'muur';
  document.body.append(buiten, muur);
  const bal = buiten.querySelector('.padelbal'), binnen = buiten.querySelector('.binnen');

  buiten.animate([
    { transform: `translateX(${start.x - 15}px)` },
    { transform: 'translateX(6px)', offset: .5, easing: 'cubic-bezier(.2,.7,.4,1)' },
    { transform: `translateX(${doel.x - 15}px)` },
  ], { duration: duur, easing: 'cubic-bezier(.45,0,.7,1)', fill: 'forwards' });
  const op = 'cubic-bezier(.2,.6,.5,1)', neer = 'cubic-bezier(.5,0,.8,.4)';
  binnen.animate([
    { transform: `translateY(${vloer}px)`, easing: op },
    { transform: `translateY(${vloer - H * .55}px)`, offset: .2, easing: neer },
    { transform: `translateY(${vloer}px) scale(1.15,.85)`, offset: .38, easing: op },
    { transform: `translateY(${vloer - H * .3}px)`, offset: .5, easing: 'linear' },   // tegen de wand
    { transform: `translateY(${vloer - H * .33}px)`, offset: .58, easing: neer },
    { transform: `translateY(${vloer}px) scale(1.12,.88)`, offset: .78, easing: op },
    { transform: `translateY(${vloer - H * .1}px)`, offset: .88, easing: neer },
    { transform: `translateY(${doel.y - 15}px) scale(.35)` },
  ], { duration: duur, fill: 'forwards' });
  bal.animate([{ rotate: '0deg' }, { rotate: '900deg' }], { duration: duur, easing: 'cubic-bezier(.3,.5,.6,1)' });

  setTimeout(() => muur.animate([{ opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 0 }], { duration: 520, easing: 'ease-out' }), duur * .5 - 40);
  // geluid op elke stuit: racket, vloer, glazen wand, vloer
  pok(1); [[.38, .6, false], [.5, .8, true], [.78, .35, false]].forEach(([t, s, g]) => setTimeout(() => pok(s, g), duur * t));
  setTimeout(() => {
    buiten.remove(); muur.remove();
    $('.tabs .pil .padelbal').animate([{ transform: 'scale(2.2)' }, { transform: 'scale(1)' }], { duration: 500, easing: 'cubic-bezier(.3,1.6,.5,1)' });
  }, duur);
}

// Regen van padelballen (golden point, eerste les)
function confetti(n = 26) {
  if (rustig()) return;
  const W = innerWidth, H = innerHeight;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'confetti';
    const groot = 10 + Math.random() * 16;
    el.innerHTML = i % 4 === 3
      ? `<div style="width:${groot * .6}px;height:${groot * .6}px;border-radius:3px;background:${i % 8 === 3 ? 'var(--baan)' : '#fff'}"></div>`
      : `<div class="padelbal" style="width:${groot}px;height:${groot}px"></div>`;
    document.body.append(el);
    const x0 = W / 2 + (Math.random() - .5) * 60, y0 = H * .55;
    const dx = (Math.random() - .5) * W * 1.1, top = H * (.25 + Math.random() * .4);
    const duur = 1300 + Math.random() * 700;
    el.animate([
      { transform: `translate(${x0}px, ${y0}px) scale(.3) rotate(0deg)`, opacity: 1, easing: 'cubic-bezier(.15,.7,.4,1)' },
      { transform: `translate(${x0 + dx * .6}px, ${y0 - top}px) scale(1) rotate(${Math.random() * 360}deg)`, offset: .38, easing: 'cubic-bezier(.5,0,.9,.6)' },
      { transform: `translate(${x0 + dx}px, ${H + 40}px) scale(1) rotate(${Math.random() * 720}deg)`, opacity: .9 },
    ], { duration: duur, fill: 'forwards' }).onfinish = () => el.remove();
  }
}

// "Pok": het geluid van een padelbal op het racket (geen bestand nodig, Web Audio). Glas klinkt hoger.
let audio;
function pok(sterkte = 1, glas = false) {
  if (S.ik.geluid === false) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime, uit = audio.createGain();
    uit.gain.value = .45 * sterkte; uit.connect(audio.destination);
    const toon = audio.createOscillator(), tg = audio.createGain();
    toon.type = 'triangle';
    toon.frequency.setValueAtTime(glas ? 1150 : 620, t); toon.frequency.exponentialRampToValueAtTime(glas ? 700 : 240, t + .07);
    tg.gain.setValueAtTime(1, t); tg.gain.exponentialRampToValueAtTime(.001, t + (glas ? .16 : .09));
    toon.connect(tg).connect(uit); toon.start(t); toon.stop(t + .2);
    // korte tik van de vilt/snaren-aanslag
    const n = audio.createBuffer(1, audio.sampleRate * .02, audio.sampleRate), data = n.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const ruis = audio.createBufferSource(), bp = audio.createBiquadFilter();
    ruis.buffer = n; bp.type = 'bandpass'; bp.frequency.value = glas ? 3500 : 1800;
    ruis.connect(bp).connect(uit); ruis.start(t);
  } catch {}
}
const tril = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} }; // Android; iOS laat websites niet trillen

/* ---------- Trofeeën ---------- */
const TROFEEEN = [
  ['les1', 'Eerste les', 'De eerste les staat erin', s => s.lessen >= 1, s => [s.lessen, 1]],
  ['les10', '10 lessen', 'Dubbele cijfers', s => s.lessen >= 10, s => [s.lessen, 10]],
  ['les50', '50 lessen', 'Halve eeuw op de baan', s => s.lessen >= 50, s => [s.lessen, 50]],
  ['les100', '100 lessen', 'Honderd keer vamos', s => s.lessen >= 100, s => [s.lessen, 100]],
  ['les250', '250 lessen', 'Legende van de baan', s => s.lessen >= 250, s => [s.lessen, 250]],
  ['uur100', '100 uur', 'Honderd uur lesgegeven', s => s.min >= 6000, s => [Math.floor(s.min / 60), 100]],
  ['groep', 'Groepsles', 'Eerste groepsles gegeven', s => s.groep >= 1, s => [s.groep, 1]],
  ['vol', 'Volle baan', 'Groepsles met 4 spelers', s => s.vol, s => [s.vol ? 1 : 0, 1]],
  ['omzet1', '€ 1.000', 'Eerste duizend binnen', s => s.omzet >= 100000, s => [s.omzet / 100, 1000]],
  ['omzet5', '€ 5.000', 'Vijf ruggen', s => s.omzet >= 500000, s => [s.omzet / 100, 5000]],
  ['omzet10', '€ 10.000', 'Vijf cijfers', s => s.omzet >= 1000000, s => [s.omzet / 100, 10000]],
  ['factuur1', 'Eerste factuur', 'Officieel ondernemer', s => s.facturen >= 1, s => [s.facturen, 1]],
  ['betaald10', '10x betaald', 'Tien facturen binnen', s => s.betaald >= 10, s => [s.betaald, 10]],
  ['rally4', 'Rally 4', '4 weken op rij les', s => s.rally >= 4, s => [s.rally, 4]],
  ['rally12', 'Rally 12', '12 weken op rij les', s => s.rally >= 12, s => [s.rally, 12]],
];
function trofeeStand() {
  const gegeven = S.lessen.filter(l => l.datum <= vandaag());
  return {
    lessen: gegeven.length, min: gegeven.reduce((s, l) => s + l.duur, 0), omzet: gegeven.reduce((s, l) => s + lesBedrag(l), 0),
    groep: gegeven.filter(l => l.deelnemers.length > 1).length, vol: gegeven.some(l => l.deelnemers.length >= 4),
    facturen: S.facturen.length, betaald: S.facturen.filter(f => f.status === 'betaald').length, rally: rally(),
  };
}
// Nieuwe trofee: opslaan en vieren. stil = alleen opslaan (bij openen of na een back-up, geen regen van meldingen)
async function trofeeen(stil = false) {
  const st = trofeeStand(), had = S.ik.trofeeen || {};
  const nieuw = TROFEEEN.filter(([k, , , ok]) => !had[k] && ok(st));
  if (!nieuw.length) return;
  S.ik.trofeeen = { ...had, ...Object.fromEntries(nieuw.map(([k]) => [k, vandaag()])) };
  await DB.zet('instellingen', S.ik, 'ik');
  if (stil) return;
  const [, titel] = nieuw[nieuw.length - 1];
  setTimeout(() => { confetti(30); pok(.8); toast(`Trofee: ${titel}!`, { duur: 3200 }); }, 1900);
}

// Getallen tellen op naar hun waarde
function telOp(root) {
  root.querySelectorAll('[data-tel]').forEach(el => {
    const eind = +el.dataset.tel, fmt = { euro, uren, getal: String }[el.dataset.fmt];
    if (rustig() || !eind) { el.textContent = fmt(eind); return; }
    const t0 = performance.now(), duur = 700;
    const stap = t => {
      const p = Math.min(1, (t - t0) / duur), e = 1 - Math.pow(1 - p, 3);
      const w = el.dataset.fmt === 'getal' ? Math.round(eind * e) : el.dataset.fmt === 'uren' ? Math.round(eind * e / 5) * 5 : Math.round(eind * e);
      el.textContent = fmt(p === 1 ? eind : w);
      if (p < 1) requestAnimationFrame(stap);
    };
    requestAnimationFrame(stap);
  });
}

// Startscherm: racket slaat de bal het scherm uit (één keer per sessie)
async function intro() {
  try { if (sessionStorage.getItem('intro')) return; sessionStorage.setItem('intro', '1'); } catch {}
  if (rustig()) return;
  const el = document.createElement('div');
  el.className = 'intro'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="racket"><svg viewBox="0 0 150 220">
      <defs><linearGradient id="rk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d8bff"/><stop offset="1" stop-color="#0d4fb8"/></linearGradient></defs>
      <rect x="64" y="140" width="22" height="74" rx="9" fill="#14223a"/>
      <path d="M68 150h14M68 164h14M68 178h14M68 192h14" stroke="#2c3e5c" stroke-width="3"/>
      <path d="M75 6c40 0 64 30 64 70 0 40-24 74-64 74S11 116 11 76C11 36 35 6 75 6z" fill="url(#rk)"/>
      <path d="M75 14c34 0 56 26 56 62s-22 66-56 66-56-30-56-66 22-62 56-62z" fill="none" stroke="#d7f25b" stroke-width="3" opacity=".9"/>
      ${[[55, 50], [75, 44], [95, 50], [45, 72], [65, 68], [85, 68], [105, 72], [55, 92], [75, 90], [95, 92], [65, 112], [85, 112]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.5" fill="#0a3a8a"/>`).join('')}
    </svg></div>${BAL}`;
  document.body.append(el);
  const racket = el.querySelector('.racket'), bal = el.querySelector('.padelbal');
  const klaar = () => { el.classList.add('weg'); setTimeout(() => el.remove(), 400); };
  el.addEventListener('click', klaar);
  racket.animate([
    { transform: 'rotate(-55deg) translateY(30px)', opacity: 0 },
    { transform: 'rotate(-55deg)', opacity: 1, offset: .35, easing: 'cubic-bezier(.6,0,.4,1.6)' },
    { transform: 'rotate(28deg)', offset: .62 },
    { transform: 'rotate(18deg)' },
  ], { duration: 900, fill: 'forwards' });
  bal.animate([
    { transform: 'translate(0,0)', offset: 0 },
    { transform: 'translate(-6px, 4px)', offset: .55 },
    { transform: `translate(${innerWidth}px, -${innerHeight * .6}px) scale(.4)`, easing: 'cubic-bezier(.2,.6,.4,1)' },
  ], { duration: 1150, fill: 'forwards' });
  await wacht(1050); klaar();
}

// Tik op de bal in een leeg scherm: smash!
function smash(knop) {
  const bal = knop.querySelector('.padelbal');
  if (!bal || bal.dataset.weg) return;
  bal.dataset.weg = '1';
  toast(kreet()); pok(1.2); tril();
  if (rustig()) { delete bal.dataset.weg; return; }
  bal.style.animation = 'none';
  bal.animate([
    { transform: 'translateY(-58px) scale(1)' },
    { transform: `translate(${innerWidth * .5}px, -${innerHeight}px) scale(.5) rotate(720deg)` },
  ], { duration: 520, easing: 'cubic-bezier(.3,0,.2,1)', fill: 'forwards' });
  setTimeout(() => {
    bal.getAnimations().forEach(a => a.cancel());
    bal.style.animation = ''; delete bal.dataset.weg;
    bal.animate([{ transform: 'translateY(-300px)' }, { transform: 'translateY(-58px)' }], { duration: 500, easing: 'cubic-bezier(.3,0,.5,1)' });
  }, 1400);
}

/* ---------- Schermen ---------- */
const TITELS = { lessen: 'Lessen', facturen: 'Facturen', stats: 'Statistiek', klanten: 'Klanten' };
const leeg = (titel, tekst) => `<div class="leeg glas in"><button type="button" class="stuiter" aria-label="Sla de bal">${BAL}<div class="schaduw"></div></button><b>${titel}</b>${tekst}</div>`;

function teken(anim = true) {
  const v = S.view;
  $('#titel').textContent = $('#balk-titel').textContent = TITELS[v];
  const i = VIEWS.indexOf(v);
  document.querySelectorAll('.tabs button').forEach((b, j) => { b.classList.toggle('actief', j === i); b.toggleAttribute('aria-current', j === i); });
  $('.tabs .pil').style.transform = `translateX(${i * 100}%)`;
  const plus = $('#plus');
  plus.setAttribute('aria-label', v === 'klanten' ? 'Nieuwe klant' : 'Nieuwe les');
  plus.innerHTML = v === 'klanten'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.6 0 3 .5 4.2 1.4M19 14v6M16 17h6"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const main = $('#main');
  main.innerHTML = ({ lessen: viewLessen, facturen: viewFacturen, stats: viewStats, klanten: viewKlanten })[v]();
  if (v === 'stats') tekenGrafiek(anim);
  main.classList.toggle('stil', !anim);
  main.querySelectorAll('.in').forEach((el, n) => el.style.setProperty('--i', Math.min(n, 12)));
  if (anim) telOp(main); else main.querySelectorAll('[data-tel]').forEach(el => { el.textContent = ({ euro, uren, getal: String })[el.dataset.fmt](+el.dataset.tel); });
}

/* ---------- Meldingen: installeren en back-up ---------- */
let installPrompt = null; // Android/Chrome: eigen installeerknop
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (S.view === 'lessen') teken(false); });
const opIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const geinstalleerd = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const onthouden = k => { try { return localStorage.getItem(k); } catch { return null; } };
const DEEL_KLEIN = '<svg class="inline" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

function meldingen() {
  let html = '';
  if (!geinstalleerd() && !onthouden('padel-install-weg') && (opIos() || installPrompt)) {
    html += `<div class="melding glas in"><div class="m-icoon">${BAL}</div><div class="m-tekst"><b>Zet Padel Uren op je beginscherm</b>
      ${opIos() ? `<span>Tik in Safari op ${DEEL_KLEIN} <b>Deel</b> en kies <b>Zet op beginscherm</b>. Dan werkt het als een echte app en blijven je gegevens veilig bewaard.</span>` : '<span>Dan werkt het als een echte app, ook zonder internet.</span>'}</div>
      <div class="m-knoppen"><button type="button" class="link" data-actie="install-weg">Begrepen</button>${installPrompt ? '<button type="button" class="knop hoofd klein" data-actie="installeer">Installeren</button>' : ''}</div></div>`;
  }
  const n = dagenGeleden(S.ik.laatsteBackup);
  if (S.lessen.length >= 3 && (n === null || n >= 14) && !S.backupLater) {
    html += `<div class="melding glas in"><div class="m-icoon m-blauw"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18z"/><path d="M12 11v6M9.5 13.5L12 11l2.5 2.5"/></svg></div>
      <div class="m-tekst"><b>Tijd voor een back-up</b><span>Laatste back-up: ${backupTekst()}. Je gegevens staan alleen op deze telefoon.</span></div>
      <div class="m-knoppen"><button type="button" class="link" data-actie="backup-later">Later</button><button type="button" class="knop hoofd klein" data-actie="backup">Maak back-up</button></div></div>`;
  }
  return html;
}

const groet = () => { const u = new Date().getHours(); return u < 6 ? 'Goedenacht' : u < 12 ? 'Goedemorgen' : u < 18 ? 'Goedemiddag' : 'Goedenavond'; };
const zelfdeGroep = (a, b) => a.deelnemers.length === b.deelnemers.length && a.deelnemers.every(d => b.deelnemers.some(x => x.klantId === d.klantId));
const plusDagen = (d, n) => { const x = datumObj(d); x.setDate(x.getDate() + n); return iso(x); };

// Rally: aantal weken op rij met minstens één les (deze week telt mee zodra er een les is)
function rally() {
  const weken = new Set(S.lessen.filter(l => l.datum <= vandaag()).map(l => weekStart(l.datum)));
  let w = weekStart(vandaag()), n = 0;
  if (!weken.has(w)) w = plusDagen(w, -7);
  while (weken.has(w)) { n++; w = plusDagen(w, -7); }
  return n;
}

// Lessen van vorige week die deze week nog niet staan: met één tik herhalen
function herhaalVoorstellen() {
  const deze = weekStart(vandaag()), vorige = plusDagen(deze, -7);
  return S.lessen.filter(l => l.datum >= vorige && l.datum < deze)
    .filter(l => !S.lessen.some(x => x.datum === plusDagen(l.datum, 7) && x.tijd === l.tijd && zelfdeGroep(x, l)))
    .sort((a, b) => (a.datum + a.tijd).localeCompare(b.datum + b.tijd)).slice(0, 6);
}

async function herhaal(bron) {
  const nieuw = bron.filter(Boolean).map(l => ({ ...structuredClone(l), id: id(), datum: plusDagen(l.datum, 7), factuur: null, deelnemers: l.deelnemers.map(({ factuur, ...d }) => d) }));
  if (!nieuw.length) return;
  for (const l of nieuw) await DB.zet('lessen', l);
  await laad(); teken(true); vlucht(); tril();
  toast(nieuw.length === 1 ? `Les herhaald · ${kreet()}` : `${nieuw.length} lessen herhaald · ${kreet()}`, { actie: 'Ongedaan', bij: async () => {
    for (const l of nieuw) await DB.weg('lessen', l.id);
    await laad(); teken(false); toast('Weggehaald');
  } });
  trofeeen();
}

function viewLessen() {
  const week = dezeWeek();
  const datum = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  const voornaam = (S.ik.naam || '').split(/\s+/)[0];
  $('#ondertitel').textContent = voornaam ? `${groet()}, ${voornaam} · ${datum}` : datum;
  const min = week.reduce((s, l) => s + l.duur, 0), omzet = week.reduce((s, l) => s + lesBedrag(l), 0);
  const r = rally();
  const score = `<div class="score glas in" aria-label="Deze week">
    <div><b data-tel="${min}" data-fmt="uren">${uren(min)}</b><small>uren</small></div>
    <div><b data-tel="${week.length}" data-fmt="getal">${week.length}</b><small>lessen</small></div>
    <div><b data-tel="${omzet}" data-fmt="euro">${euro(omzet)}</b><small>omzet</small></div></div>
    ${r >= 2 ? `<div class="rally in" title="Weken op rij met minstens één les"><span class="rally-ballen" aria-hidden="true">${BAL.repeat(Math.min(r, 5))}</span><span>Rally van <b>${r} weken</b> op rij${r >= 12 ? ' · onstopbaar!' : r >= 4 ? ' · lekker bezig' : ''}</span></div>` : ''}`;
  if (!S.lessen.length) return meldingen() + score + leeg('Nog geen lessen', 'Tik op de gele bal rechtsonder om je eerste les vast te leggen.');
  const voorstel = herhaalVoorstellen();
  const herhaal = voorstel.length ? `<section class="herhaal glas in" aria-labelledby="h-titel">
    <div class="kaart-kop"><h2 id="h-titel">Vaste lessen van vorige week</h2>${voorstel.length > 1 ? '<button type="button" class="link" data-herhaal="alles">Alles</button>' : ''}</div>
    <div class="chips">${voorstel.map(l => {
      const d = datumObj(plusDagen(l.datum, 7)).toLocaleDateString('nl-NL', { weekday: 'short' }).replace('.', '');
      return `<button type="button" class="chip herhaal-chip" data-herhaal="${l.id}" aria-label="Zet ${esc(l.deelnemers.map(x => klant(x.klantId)?.naam).join(', '))} ook op ${d} ${l.tijd}">
        <span class="plusje" aria-hidden="true">+</span><b>${d} ${esc(l.tijd)}</b> ${esc(l.deelnemers.map(x => (klant(x.klantId)?.naam || '?').split(' ')[0]).join(', '))}</button>`;
    }).join('')}</div></section>` : '';
  let html = meldingen() + score + herhaal, huidige = '';
  for (const l of S.lessen) {
    const w = weekStart(l.datum);
    if (w !== huidige) { if (huidige) html += '</div>'; html += `<h2 class="groep in">${weekLabel(w)}</h2><div class="lijst glas in">`; huidige = w; }
    const d = datumObj(l.datum);
    const namen = l.deelnemers.map(x => klant(x.klantId)?.naam || '?').join(', ');
    const groep = l.deelnemers.length > 1;
    const nGef = l.deelnemers.filter(x => gefact(l, x)).length;
    const fBadge = nGef === l.deelnemers.length ? ' <span class="badge">gefactureerd</span>' : nGef ? ' <span class="badge">deels gefactureerd</span>' : '';
    html += `<button type="button" class="rij" data-les="${l.id}">
      <div class="tegel"><b>${d.getDate()}</b><small>${d.toLocaleDateString('nl-NL', { weekday: 'short' }).replace('.', '')}</small></div>
      <div class="midden"><div class="naam">${esc(namen)}</div>
        <div class="sub">${esc(l.tijd)} · ${uren(l.duur)}${groep ? ` <span class="badge groep">groep ${l.deelnemers.length}</span>` : ''}${fBadge}</div></div>
      <div class="rechts">${euro(lesBedrag(l))}</div></button>`;
  }
  return html + '</div>';
}

// Per klant: wat is gegeven maar nog niet gefactureerd
function openPerKlant() {
  const m = new Map();
  for (const l of S.lessen) {
    if (l.datum > vandaag()) continue; // geplande lessen nog niet factureren
    for (const d of l.deelnemers) {
      if (gefact(l, d)) continue;
      const r = m.get(d.klantId) || { klantId: d.klantId, min: 0, bedrag: 0, regels: [] };
      r.min += l.duur; r.bedrag += regelBedrag(l, d); r.regels.push({ les: l, d });
      m.set(d.klantId, r);
    }
  }
  return [...m.values()].sort((a, b) => b.bedrag - a.bedrag);
}

const teLaat = f => f.status !== 'betaald' && f.verval < vandaag();
const PIJL = '<svg class="pijl" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const factuurRij = f => `<button type="button" class="rij" data-factuur="${f.id}">
  <div class="tegel letter">${esc(initialen(f.aan.naam))}</div>
  <div class="midden"><div class="naam">${esc(f.aan.naam)}</div>
    <div class="sub">${f.nummer} · ${f.status === 'betaald' ? `betaald ${kortDatum(f.betaaldOp)}` : `vervalt ${kortDatum(f.verval)}`}${teLaat(f) ? ' <span class="badge rood">te laat</span>' : ''}${f.status !== 'betaald' && !f.verstuurdOp ? ' <span class="badge grijs">niet verstuurd</span>' : ''}</div></div>
  <div class="rechts">${euro(f.totaal)}</div>${PIJL}</button>`;

function viewFacturen() {
  const rijen = openPerKlant();
  const onb = S.facturen.filter(f => f.status !== 'betaald'), bet = S.facturen.filter(f => f.status === 'betaald');
  const v = S.fview;
  const seg = `<div class="segment drie in" role="tablist" aria-label="Soort facturen">
    ${[['te', 'Factureren', rijen.length], ['onbetaald', 'Onbetaald', onb.length], ['betaald', 'Betaald', 0]].map(([k, t, n]) =>
      `<button type="button" role="tab" data-fview="${k}" class="${v === k ? 'aan' : ''}" aria-selected="${v === k}">${t}${n ? `<span class="teller">${n}</span>` : ''}</button>`).join('')}</div>`;

  if (v === 'te') {
    $('#ondertitel').textContent = 'Gegeven lessen, nog niet gefactureerd';
    if (!rijen.length) return seg + leeg('Alles is gefactureerd', 'Nieuwe lessen verschijnen hier vanzelf.');
    const totaal = rijen.reduce((s, r) => s + r.bedrag, 0), min = rijen.reduce((s, r) => s + r.min, 0);
    return seg + `<div class="score glas groot in" style="grid-template-columns:1.4fr 1fr 1fr">
      <div><b data-tel="${totaal}" data-fmt="euro">${euro(totaal)}</b><small>te factureren</small></div>
      <div><b data-tel="${min}" data-fmt="uren">${uren(min)}</b><small>uren</small></div>
      <div><b data-tel="${rijen.length}" data-fmt="getal">${rijen.length}</b><small>klanten</small></div></div>
      <h2 class="groep in">Tik op een klant om te factureren</h2><div class="lijst glas in">`
      + rijen.map(r => {
        const k = klant(r.klantId);
        return `<button type="button" class="rij" data-maak="${r.klantId}">
          <div class="tegel letter">${esc(initialen(k?.naam || '?'))}</div>
          <div class="midden"><div class="naam">${esc(k?.naam || '?')}</div><div class="sub">${r.regels.length} ${r.regels.length === 1 ? 'les' : 'lessen'} · ${uren(r.min)} · sinds ${kortDatum(r.regels[r.regels.length - 1].les.datum)}</div></div>
          <div class="rechts">${euro(r.bedrag)}</div>${PIJL}</button>`;
      }).join('') + '</div>';
  }
  if (v === 'onbetaald') {
    $('#ondertitel').textContent = 'Gemaakt, nog niet betaald';
    if (!onb.length) return seg + leeg('Niets openstaand', 'Alle facturen zijn betaald. Juego, set y partido!');
    const totaal = onb.reduce((s, f) => s + f.totaal, 0), laat = onb.filter(teLaat);
    return seg + `<div class="score glas groot in" style="grid-template-columns:1.4fr 1fr 1fr">
      <div><b data-tel="${totaal}" data-fmt="euro">${euro(totaal)}</b><small>openstaand</small></div>
      <div><b data-tel="${onb.length}" data-fmt="getal">${onb.length}</b><small>facturen</small></div>
      <div><b data-tel="${laat.length}" data-fmt="getal">${laat.length}</b><small>te laat</small></div></div>
      <div class="lijst glas in" style="margin-top:14px">${onb.sort((a, b) => a.verval.localeCompare(b.verval)).map(factuurRij).join('')}</div>`;
  }
  $('#ondertitel').textContent = 'Ontvangen betalingen';
  if (!bet.length) return seg + leeg('Nog niets betaald', 'Markeer een factuur als betaald zodra het geld binnen is.');
  const jaar = String(new Date().getFullYear());
  const ditJaar = bet.filter(f => (f.betaaldOp || '').startsWith(jaar)).reduce((s, f) => s + f.totaal, 0);
  return seg + `<div class="score glas groot in" style="grid-template-columns:1.4fr 1fr">
    <div><b data-tel="${ditJaar}" data-fmt="euro">${euro(ditJaar)}</b><small>ontvangen ${jaar}</small></div>
    <div><b data-tel="${bet.length}" data-fmt="getal">${bet.length}</b><small>facturen</small></div></div>
    <div class="lijst glas in" style="margin-top:14px">${bet.sort((a, b) => (b.betaaldOp || '').localeCompare(a.betaaldOp || '')).map(factuurRij).join('')}</div>`;
}

function viewKlanten() {
  $('#ondertitel').textContent = S.klanten.length ? `${S.klanten.length} ${S.klanten.length === 1 ? 'klant' : 'klanten'}` : '';
  if (!S.klanten.length) return leeg('Nog geen klanten', 'Tik op de gele bal om een klant toe te voegen, of voeg ze toe bij een les.');
  return `${S.klanten.length > 5 ? `<label class="zoekbalk veld in"><span class="sr">Zoek klant</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input class="invoer" id="zoek-klant" type="search" placeholder="Zoek klant" autocomplete="off"></label>` : ''}
    <div class="lijst glas in">` + S.klanten.map(k => {
    const n = S.lessen.filter(l => l.deelnemers.some(d => d.klantId === k.id)).length;
    return `<button type="button" class="rij" data-klant="${k.id}" data-naam="${esc(k.naam.toLowerCase())}">
      <div class="tegel letter">${esc(initialen(k.naam))}</div>
      <div class="midden"><div class="naam">${esc(k.naam)}</div><div class="sub">${esc(k.email || k.telefoon || 'Geen contactgegevens')}</div></div>
      <div class="rechts">${euro(k.tariefPrive)}<small>${n} ${n === 1 ? 'les' : 'lessen'}</small></div></button>`;
  }).join('') + '</div>';
}

/* ---------- Statistiek ---------- */
// Filters: periode (met vorige/volgende), klant, soort. Omzet is incl. btw, excl. = /1,21.
S.stat = { periode: 'maand', stap: 0, klant: '', soort: '' };
const PERIODES = [['week', 'Week'], ['maand', 'Maand'], ['kwartaal', 'Kwartaal'], ['jaar', 'Jaar'], ['alles', 'Alles']];
const iso = d => d.toLocaleDateString('sv-SE');
const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function bereik(periode, stap) {
  const nu = datumObj(vandaag());
  let van, tot;
  if (periode === 'week') { van = datumObj(weekStart(vandaag())); van.setDate(van.getDate() + 7 * stap); tot = new Date(van); tot.setDate(tot.getDate() + 6); }
  else if (periode === 'maand') { van = new Date(nu.getFullYear(), nu.getMonth() + stap, 1, 12); tot = new Date(van.getFullYear(), van.getMonth() + 1, 0, 12); }
  else if (periode === 'kwartaal') { const q = Math.floor(nu.getMonth() / 3) + stap; van = new Date(nu.getFullYear(), q * 3, 1, 12); tot = new Date(van.getFullYear(), van.getMonth() + 3, 0, 12); }
  else if (periode === 'jaar') { van = new Date(nu.getFullYear() + stap, 0, 1, 12); tot = new Date(van.getFullYear(), 11, 31, 12); }
  else {
    const d = S.lessen.map(l => l.datum).sort();
    van = datumObj(d[0] || vandaag()); tot = datumObj(d[d.length - 1] || vandaag());
    van = new Date(van.getFullYear(), van.getMonth(), 1, 12); tot = new Date(tot.getFullYear(), tot.getMonth() + 1, 0, 12);
  }
  return { van: iso(van), tot: iso(tot) };
}
function bereikLabel(periode, { van, tot }) {
  const v = datumObj(van);
  if (periode === 'week') { const f = x => datumObj(x).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }); return `${f(van)} – ${f(tot)}`; }
  if (periode === 'maand') return v.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
  if (periode === 'kwartaal') return `Q${Math.floor(v.getMonth() / 3) + 1} ${v.getFullYear()}`;
  if (periode === 'jaar') return String(v.getFullYear());
  return 'Alle lessen';
}
// Vakjes voor de grafiek: dagen (week), weken (maand, kwartaal) of maanden (jaar, alles)
function vakken(periode, { van, tot }) {
  const uit = [];
  if (periode === 'week') {
    for (let d = datumObj(van); iso(d) <= tot; d.setDate(d.getDate() + 1)) uit.push({ van: iso(d), tot: iso(d), label: d.toLocaleDateString('nl-NL', { weekday: 'short' }).replace('.', ''), lang: d.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }) });
  } else if (periode === 'maand' || periode === 'kwartaal') {
    for (let d = datumObj(weekStart(van)); iso(d) <= tot; d.setDate(d.getDate() + 7)) {
      const e = new Date(d); e.setDate(e.getDate() + 6);
      const wk = weeknr(d);
      uit.push({ van: iso(d) < van ? van : iso(d), tot: iso(e) > tot ? tot : iso(e), label: `wk ${wk}`, lang: `Week ${wk}` });
    }
  } else {
    for (let d = datumObj(van); iso(d) <= tot; d = new Date(d.getFullYear(), d.getMonth() + 1, 1, 12)) {
      const e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 12);
      uit.push({ van: iso(d), tot: iso(e), label: MAANDEN[d.getMonth()], lang: d.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' }) });
    }
  }
  return uit;
}
function weeknr(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

// Alle regels (per deelnemer) en lessen binnen bereik, gefilterd op klant en soort
function cijfers({ van, tot }, f = S.stat) {
  const lessen = S.lessen.filter(l => l.datum >= van && l.datum <= tot
    && (!f.soort || (f.soort === 'groep') === (l.deelnemers.length > 1))
    && (!f.klant || l.deelnemers.some(d => d.klantId === f.klant)));
  const regels = lessen.flatMap(l => l.deelnemers.filter(d => !f.klant || d.klantId === f.klant)
    .map(d => ({ les: l, d, bedrag: regelBedrag(l, d), groep: l.deelnemers.length > 1 })));
  const omzet = regels.reduce((s, r) => s + r.bedrag, 0);
  const min = lessen.reduce((s, l) => s + l.duur, 0);
  const open = regels.filter(r => !gefact(r.les, r.d)).reduce((s, r) => s + r.bedrag, 0);
  return { lessen, regels, omzet, min, open, excl: Math.round(omzet / 1.21) };
}

function viewStats() {
  const f = S.stat, r = bereik(f.periode, f.stap);
  $('#ondertitel').textContent = 'Omzet incl. 21% btw';
  if (!S.lessen.length) return leeg('Nog geen cijfers', 'Leg een paar lessen vast, dan zie je hier je omzet groeien.');
  const c = cijfers(r);
  // vorige periode ter vergelijking
  const vorige = f.periode === 'alles' ? null : cijfers(bereik(f.periode, f.stap - 1));
  const verschil = vorige && vorige.omzet ? Math.round((c.omzet - vorige.omzet) / vorige.omzet * 100) : null;
  const perUur = c.min ? Math.round(c.omzet / (c.min / 60)) : 0;
  const prive = c.regels.filter(x => !x.groep).reduce((s, x) => s + x.bedrag, 0), groep = c.omzet - prive;
  // record: beste maand tot nu toe
  let record = '';
  if (f.periode === 'maand' && c.omzet > 0) {
    const perMaand = {};
    for (const l of S.lessen) perMaand[l.datum.slice(0, 7)] = (perMaand[l.datum.slice(0, 7)] || 0) + lesBedrag(l);
    if (!f.klant && !f.soort && Object.keys(perMaand).length > 1 && c.omzet >= Math.max(...Object.values(perMaand))) record = `<span class="record">${BAL}Beste maand tot nu toe</span>`;
  }
  const top = Object.values(c.regels.reduce((m, x) => { const k = x.d.klantId; (m[k] ||= { k, bedrag: 0, n: 0 }).bedrag += x.bedrag; m[k].n++; return m; }, {}))
    .sort((a, b) => b.bedrag - a.bedrag).slice(0, 6);
  const max = top[0]?.bedrag || 1;
  const pijl = verschil === null ? '' : verschil >= 0
    ? `<span class="delta op"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14l5-5 5 5"/></svg>+${verschil}% t.o.v. vorige ${f.periode}</span>`
    : `<span class="delta neer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>${Math.abs(verschil)}% minder dan vorige ${f.periode}</span>`;

  return `
  <div class="filters in" role="group" aria-label="Filters">
    <div class="segment periodes">${PERIODES.map(([k, t]) => `<button type="button" data-periode="${k}" class="${f.periode === k ? 'aan' : ''}" aria-pressed="${f.periode === k}">${t}</button>`).join('')}</div>
    <div class="filterrij">
      <div class="stapper glas">
        <button type="button" data-stap="-1" aria-label="Vorige periode" ${f.periode === 'alles' ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span>${bereikLabel(f.periode, r)}</span>
        <button type="button" data-stap="1" aria-label="Volgende periode" ${f.periode === 'alles' || f.stap >= 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
    </div>
    <div class="filterrij">
      <label class="kiezer glas"><span class="sr">Klant</span><select id="f-klant"><option value="">Alle klanten</option>${S.klanten.map(k => `<option value="${k.id}" ${f.klant === k.id ? 'selected' : ''}>${esc(k.naam)}</option>`).join('')}</select></label>
      <label class="kiezer glas"><span class="sr">Soort les</span><select id="f-soort"><option value="">Privé + groep</option><option value="prive" ${f.soort === 'prive' ? 'selected' : ''}>Alleen privé</option><option value="groep" ${f.soort === 'groep' ? 'selected' : ''}>Alleen groep</option></select></label>
    </div>
  </div>

  <div class="held glas in">
    <small>Omzet ${esc(bereikLabel(f.periode, r))}</small>
    <b data-tel="${c.omzet}" data-fmt="euro">${euro(c.omzet)}</b>
    <div class="held-onder">${pijl}${record}</div>
  </div>

  <div class="tegels in">
    <div class="glas"><small>Excl. btw</small><b data-tel="${c.excl}" data-fmt="euro">${euro(c.excl)}</b></div>
    <div class="glas"><small>Btw 21%</small><b data-tel="${c.omzet - c.excl}" data-fmt="euro">${euro(c.omzet - c.excl)}</b></div>
    <div class="glas"><small>Uren</small><b data-tel="${c.min}" data-fmt="uren">${uren(c.min)}</b></div>
    <div class="glas"><small>Lessen</small><b data-tel="${c.lessen.length}" data-fmt="getal">${c.lessen.length}</b></div>
    <div class="glas"><small>Gem. per uur</small><b data-tel="${perUur}" data-fmt="euro">${euro(perUur)}</b></div>
    <div class="glas"><small>Te factureren</small><b data-tel="${c.open}" data-fmt="euro">${euro(c.open)}</b></div>
  </div>

  <section class="kaart glas in" aria-labelledby="g-titel">
    <div class="kaart-kop"><h2 id="g-titel">Omzet per ${f.periode === 'week' ? 'dag' : f.periode === 'maand' || f.periode === 'kwartaal' ? 'week' : 'maand'}</h2>
      <div class="legenda" aria-hidden="true"><span><i class="s-prive"></i>Privé</span><span><i class="s-groep"></i>Groep</span></div></div>
    <div class="grafiek" id="grafiek"></div>
    <details class="tabel"><summary>Toon als tabel</summary><div id="g-tabel"></div></details>
  </section>

  ${c.omzet ? `<section class="kaart glas in" aria-labelledby="v-titel">
    <div class="kaart-kop"><h2 id="v-titel">Privé en groep</h2></div>
    <div class="verdeling" role="img" aria-label="Privé ${euro(prive)}, groep ${euro(groep)}">
      ${prive ? `<div class="s-prive" style="flex:${prive}"></div>` : ''}${groep ? `<div class="s-groep" style="flex:${groep}"></div>` : ''}
    </div>
    <div class="verdeling-tekst">${prive ? `<span><i class="s-prive"></i>Privé <b>${euro(prive)}</b> · ${Math.round(prive / c.omzet * 100)}%</span>` : ''}${groep ? `<span><i class="s-groep"></i>Groep <b>${euro(groep)}</b> · ${Math.round(groep / c.omzet * 100)}%</span>` : ''}</div>
  </section>` : ''}

  ${top.length ? `<section class="kaart glas in" aria-labelledby="t-titel">
    <div class="kaart-kop"><h2 id="t-titel">Top klanten</h2></div>
    ${top.map((t, i) => `<button type="button" class="topklant" data-filterklant="${t.k}">
      <span class="plek">${i + 1}</span>
      <span class="tk-midden"><span class="tk-naam">${esc(klant(t.k)?.naam || '?')}<span>${euro(t.bedrag)}</span></span>
      <span class="tk-balk"><span style="--w:${Math.max(2, t.bedrag / max * 100)}%"></span></span></span></button>`).join('')}
  </section>` : ''}
  ${trofeeKast()}`;
}

const BEKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 3.4M17 6h2.5a2.5 2.5 0 0 1-2.6 3.4"/></svg>';
const SLOT = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
function trofeeKast() {
  const st = trofeeStand(), had = S.ik.trofeeen || {};
  const n = TROFEEEN.filter(([k]) => had[k]).length;
  return `<section class="kaart glas in" aria-labelledby="tr-titel">
    <div class="kaart-kop"><h2 id="tr-titel">Trofeeënkast</h2><span class="kast-teller">${n} van ${TROFEEEN.length}</span></div>
    <div class="kast">${TROFEEEN.map(([k, titel, uitleg, , voortgang]) => {
      const op = had[k], [nu, doel] = voortgang(st), pct = Math.min(100, Math.floor(nu / doel * 100));
      return `<div class="trofee${op ? ' aan' : ''}" role="img" aria-label="${esc(titel)}: ${esc(uitleg)}, ${op ? `behaald op ${langDatum(op)}` : `${pct}% op weg`}">
        <div class="t-icoon">${op ? BEKER : SLOT}</div><b>${esc(titel)}</b>
        ${op ? `<small>${kortDatum(op)}</small>` : `<span class="t-balk"><span style="width:${pct}%"></span></span>`}</div>`;
    }).join('')}</div></section>`;
}

// Gestapelde staven (privé onder, groep boven) met tooltip bij tik of hover
function tekenGrafiek(anim) {
  const el = $('#grafiek'); if (!el) return;
  const f = S.stat, r = bereik(f.periode, f.stap);
  const data = vakken(f.periode, r).map(v => {
    const c = cijfers(v);
    const prive = c.regels.filter(x => !x.groep).reduce((s, x) => s + x.bedrag, 0);
    return { ...v, prive, groep: c.omzet - prive, totaal: c.omzet, min: c.min, n: c.lessen.length };
  });
  const B = el.clientWidth || 320, H = 190, links = 44, onder = 24, boven = 8;
  const maxW = Math.max(...data.map(d => d.totaal), 1);
  const stapY = schaal(maxW), top = Math.ceil(maxW / stapY) * stapY || stapY;
  const y = v => boven + (H - onder - boven) * (1 - v / top);
  const band = (B - links) / data.length, bw = Math.max(4, Math.min(28, band * .62));
  const toonLabel = i => data.length <= 8 || i % Math.ceil(data.length / 8) === 0;
  let svg = `<svg viewBox="0 0 ${B} ${H}" width="${B}" height="${H}" role="img" aria-label="Omzet per periode, hoogste ${euro(maxW)}">`;
  for (let v = 0; v <= top; v += stapY) svg += `<line class="rooster" x1="${links}" x2="${B}" y1="${y(v)}" y2="${y(v)}"/><text class="as" x="${links - 6}" y="${y(v) + 4}" text-anchor="end">${kortEuro(v)}</text>`;
  data.forEach((d, i) => {
    const x = links + band * i + (band - bw) / 2;
    const hp = y(0) - y(d.prive), hg = y(0) - y(d.groep);
    const gat = d.prive && d.groep ? 2 : 0; // 2px tussenruimte tussen de segmenten
    svg += `<g class="staaf" data-i="${i}" style="--i:${i}">`;
    if (d.prive) svg += pad(x, y(d.prive), bw, hp, !d.groep, 's-prive');
    if (d.groep) svg += pad(x, y(d.prive) - hg - gat, bw, hg, true, 's-groep');
    svg += `<rect class="raak" x="${links + band * i}" y="0" width="${band}" height="${H - onder}"/></g>`;
    if (toonLabel(i)) svg += `<text class="as" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.label}</text>`;
  });
  svg += `</svg><div class="tip glas" role="status" hidden></div>`;
  el.innerHTML = svg;
  el.classList.toggle('groei', !!anim && !rustig());

  const tip = el.querySelector('.tip');
  const toon = i => {
    const d = data[i];
    el.querySelectorAll('.staaf').forEach(g => g.classList.toggle('dim', +g.dataset.i !== i));
    tip.innerHTML = `<b>${esc(d.lang)}</b><div><i class="s-prive"></i>Privé<span>${euro(d.prive)}</span></div><div><i class="s-groep"></i>Groep<span>${euro(d.groep)}</span></div><div class="tip-tot">Totaal<span>${euro(d.totaal)}</span></div><small>${d.n} ${d.n === 1 ? 'les' : 'lessen'} · ${uren(d.min)}</small>`;
    tip.hidden = false;
    const x = links + band * i + band / 2, tw = tip.offsetWidth;
    tip.style.left = Math.min(B - tw, Math.max(0, x - tw / 2)) + 'px';
    tip.style.top = Math.max(0, y(d.totaal) - tip.offsetHeight - 10) + 'px';
  };
  const verberg = () => { tip.hidden = true; el.querySelectorAll('.staaf').forEach(g => g.classList.remove('dim')); };
  el.querySelectorAll('.staaf').forEach(g => {
    g.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') toon(+g.dataset.i); });
    g.addEventListener('click', () => toon(+g.dataset.i));
  });
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') verberg(); });
  el.onclick = e => { if (!e.target.closest('.staaf')) verberg(); };

  $('#g-tabel').innerHTML = `<table><thead><tr><th>${f.periode === 'week' ? 'Dag' : f.periode === 'jaar' || f.periode === 'alles' ? 'Maand' : 'Week'}</th><th>Privé</th><th>Groep</th><th>Totaal</th><th>Uren</th></tr></thead><tbody>`
    + data.map(d => `<tr><td>${esc(d.lang)}</td><td>${euro(d.prive)}</td><td>${euro(d.groep)}</td><td><b>${euro(d.totaal)}</b></td><td>${uren(d.min)}</td></tr>`).join('') + '</tbody></table>';
}
// Staaf met afgeronde bovenkant (4px), vlak op de basislijn
function pad(x, y0, w, h, rond, cls) {
  if (h <= 0) return '';
  const r = rond ? Math.min(4, w / 2, h) : 0;
  return `<path class="${cls}" d="M${x},${y0 + h}V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + w - r}Q${x + w},${y0} ${x + w},${y0 + r}V${y0 + h}Z"/>`;
}
function schaal(max) { // nette stapgrootte voor 3-4 rasterlijnen
  const ruw = max / 3, macht = Math.pow(10, Math.floor(Math.log10(ruw)));
  return [1, 2, 2.5, 5, 10].map(m => m * macht).find(s => s >= ruw);
}
const kortEuro = c => { const e = c / 100; return e >= 1000 ? `€${(e / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}k` : `€${Math.round(e)}`; };

/* ---------- Sheet: veegt omhoog, sluit met vegen, kruisje, Esc of tik ernaast ---------- */
const sheet = $('#sheet'), form = $('#sheet-form');
const KRUIS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function openSheet(titel, html, bind) {
  form.innerHTML = `<div class="greep" aria-hidden="true"></div>
    <div class="kopregel"><h3 id="sheet-titel" tabindex="-1" autofocus>${titel}</h3><button type="button" class="sluit" data-sluit aria-label="Sluiten">${KRUIS}</button></div>` + html;
  form.onclick = form.onsubmit = null; // form wordt hergebruikt: oude handlers weg
  bind?.();
  sheet.showModal();
  form.scrollTop = 0;
  if (!rustig()) {
    sheet.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 460, easing: 'cubic-bezier(.2,1,.3,1)' });
    try { sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, pseudoElement: '::backdrop' }); } catch {}
  }
}
let sluitend = false;
async function sluit() {
  if (!sheet.open || sluitend) return;
  sluitend = true;
  if (!rustig()) {
    const nu = getComputedStyle(sheet).transform;
    const a = sheet.animate([{ transform: nu === 'none' ? 'translateY(0)' : nu }, { transform: 'translateY(100%)' }], { duration: 220, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    try { sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, pseudoElement: '::backdrop', fill: 'forwards' }); } catch {}
    await a.finished;
  }
  sheet.close(); sheet.getAnimations({ subtree: true }).forEach(a => a.cancel()); sheet.style.transform = '';
  sluitend = false;
}
sheet.addEventListener('cancel', e => { e.preventDefault(); sluit(); });
sheet.addEventListener('click', e => { if (e.target === sheet) sluit(); if (e.target.closest('[data-sluit]')) sluit(); });
// Naar beneden vegen aan de greep of de titelregel
(() => {
  let y0 = 0, t0 = 0, dy = 0, actief = false;
  sheet.addEventListener('pointerdown', e => {
    if (!e.target.closest('.greep, .kopregel') || e.target.closest('button')) return;
    actief = true; y0 = e.clientY; t0 = performance.now(); dy = 0;
    sheet.setPointerCapture(e.pointerId); sheet.style.transition = 'none';
  });
  sheet.addEventListener('pointermove', e => {
    if (!actief) return;
    dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translateY(${dy < 0 ? dy / 4 : dy}px)`;
  });
  const los = () => {
    if (!actief) return; actief = false;
    const snel = dy / Math.max(1, performance.now() - t0) > .6;
    if (dy > 120 || (snel && dy > 30)) sluit();
    else { sheet.style.transition = 'transform .35s cubic-bezier(.2,1,.3,1)'; sheet.style.transform = ''; }
  };
  sheet.addEventListener('pointerup', los); sheet.addEventListener('pointercancel', los);
})();

const veldFout = (naam, tekst) => {
  const v = form.querySelector(`[data-veld="${naam}"]`); if (!v) return;
  v.classList.toggle('fout-aan', !!tekst); v.querySelector('.fout').textContent = tekst || '';
  v.querySelector('input')?.setAttribute('aria-invalid', tekst ? 'true' : 'false');
};
const schud = el => !rustig() && el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 320 });

async function verwijder(store, obj, label) {
  await DB.weg(store, obj.id); await laad(); await sluit(); teken(false);
  toast(`${label} verwijderd`, { actie: 'Ongedaan', bij: async () => { await DB.zet(store, obj); await laad(); teken(false); toast('Teruggezet'); } });
}

/* ---------- Klant ---------- */
function nieuweKlant(naam = '') {
  return { id: id(), naam, email: '', telefoon: '', adres: '', tariefPrive: S.ik.prive, tariefGroep: S.ik.groep };
}

function klantSheet(k) {
  const nieuw = !k;
  k = k ? { ...k } : nieuweKlant();
  const inGebruik = S.lessen.some(l => l.deelnemers.some(d => d.klantId === k.id));
  openSheet(nieuw ? 'Nieuwe klant' : 'Klant', `
    <label class="veld" data-veld="naam"><span>Naam</span><input name="naam" value="${esc(k.naam)}" autocomplete="off" autocapitalize="words" enterkeyhint="next"><div class="fout"></div></label>
    <div class="twee">
      <label class="veld" data-veld="prive"><span>Uurtarief privé</span><input name="prive" inputmode="decimal" value="${euroKaal(k.tariefPrive)}"><div class="fout"></div></label>
      <label class="veld" data-veld="groep"><span>Groep, per persoon</span><input name="groep" inputmode="decimal" value="${euroKaal(k.tariefGroep)}"><div class="fout"></div></label>
    </div>
    <label class="veld"><span>E-mail</span><input name="email" type="email" inputmode="email" value="${esc(k.email)}" autocomplete="off" autocapitalize="off"></label>
    <label class="veld"><span>Telefoon</span><input name="telefoon" type="tel" value="${esc(k.telefoon)}" autocomplete="off"></label>
    <label class="veld"><span>Adres (komt op de factuur)</span><textarea name="adres" rows="2">${esc(k.adres)}</textarea></label>
    <div class="knoppen">
      ${!nieuw && !inGebruik ? '<button type="button" class="knop gevaar" id="weg">Verwijder</button>' : ''}
      <button type="submit" class="knop hoofd">Bewaar</button>
    </div>`, () => {
    form.onsubmit = async e => {
      e.preventDefault();
      const f = form.elements;
      const p = centen(f.prive.value), g = centen(f.groep.value), naam = f.naam.value.trim();
      veldFout('naam', naam ? '' : 'Vul een naam in');
      veldFout('prive', isNaN(p) ? 'Bijv. 60 of 57,50' : '');
      veldFout('groep', isNaN(g) ? 'Bijv. 25 of 22,50' : '');
      if (!naam || isNaN(p) || isNaN(g)) { schud(form.querySelector('.fout-aan')); form.querySelector('.fout-aan input')?.focus(); return; }
      Object.assign(k, { naam, email: f.email.value.trim(), telefoon: f.telefoon.value.trim(), adres: f.adres.value.trim(), tariefPrive: p, tariefGroep: g });
      await DB.zet('klanten', k); await laad(); await sluit(); teken(false); toast(nieuw ? `${k.naam} toegevoegd` : 'Klant bewaard');
    };
    $('#weg')?.addEventListener('click', () => verwijder('klanten', k, k.naam));
    if (nieuw) setTimeout(() => form.elements.naam.focus(), 350);
  });
}

/* ---------- Les ---------- */
const DUREN = [60, 90, 120];

function lesSheet(les, kopie = false) {
  const nieuw = !les || kopie;
  const nu = new Date();
  // Bestaande les of kopie: tarieven blijven zoals ze waren, ook als er iemand bij komt
  const handmatig = new Set(les ? les.deelnemers.map(d => d.klantId) : []);
  les = les ? structuredClone(les) : {
    id: id(), datum: vandaag(), tijd: `${String(nu.getHours()).padStart(2, '0')}:00`, duur: 60, deelnemers: [], notitie: '', factuur: null,
  };
  let zoek = '';

  // Privé of groep bepaalt het voorgestelde tarief
  const herbereken = () => {
    const groep = les.deelnemers.length > 1;
    for (const d of les.deelnemers) {
      if (handmatig.has(d.klantId)) continue;
      const k = klant(d.klantId); d.tarief = groep ? k.tariefGroep : k.tariefPrive;
    }
  };

  const tekenKeuze = () => {
    const z = zoek.trim().toLowerCase();
    const keuze = S.klanten.filter(k => !z || k.naam.toLowerCase().includes(z));
    $('#kies').innerHTML = keuze.map(k => `<button type="button" class="chip ${les.deelnemers.some(d => d.klantId === k.id) ? 'aan' : ''}" data-kies="${k.id}" aria-pressed="${les.deelnemers.some(d => d.klantId === k.id)}">${esc(k.naam)}</button>`).join('')
      + (z && !S.klanten.some(k => k.naam.toLowerCase() === z) ? `<button type="button" class="chip nieuw" id="snel">+ ${esc(zoek.trim())}</button>` : '')
      + (!S.klanten.length && !z ? '<span class="deelnemer hint">Typ de naam van je eerste klant</span>' : '');
  };
  const tekenDeelnemers = () => {
    $('#deelnemers').innerHTML = les.deelnemers.length ? les.deelnemers.map(d => `
      <div class="deelnemer"><div class="naam">${esc(klant(d.klantId)?.naam)}<small>${euro(regelBedrag(les, d))} voor deze les</small></div>
      <label>€/u <input inputmode="decimal" data-tarief="${d.klantId}" value="${euroKaal(d.tarief)}" aria-label="Uurtarief ${esc(klant(d.klantId)?.naam)}"></label></div>`).join('')
      : '<div class="deelnemer hint">Kies hierboven wie er meedoet</div>';
    $('#som').innerHTML = `<span>${les.deelnemers.length > 1 ? `Groepsles · ${les.deelnemers.length} personen` : 'Privéles'} · ${uren(les.duur)}</span><b>${euro(lesBedrag(les))}</b>`;
  };
  const alles = () => { tekenKeuze(); tekenDeelnemers(); };

  const anders = !DUREN.includes(les.duur);
  const opFactuur = nieuw ? [] : [...new Set(les.deelnemers.map(d => gefact(les, d)).filter(Boolean))].map(fid => S.facturen.find(f => f.id === fid)?.nummer || 'eerdere factuur');
  openSheet(opFactuur.length ? 'Les <span class="badge">gefactureerd</span>' : nieuw ? (kopie ? 'Les herhalen' : 'Nieuwe les') : 'Les', `
    ${opFactuur.length ? `<p class="uitleg">Staat op ${opFactuur.length > 1 ? 'facturen' : 'factuur'} ${esc(opFactuur.join(' en '))}. Wijzigingen hier passen ${opFactuur.length > 1 ? 'die facturen' : 'die factuur'} niet aan.</p>` : ''}
    <div class="twee">
      <label class="veld"><span>Datum</span><input name="datum" type="date" value="${les.datum}" required></label>
      <label class="veld"><span>Begintijd</span><input name="tijd" type="time" value="${les.tijd}" step="900" required></label>
    </div>
    <div class="veld"><span class="label" id="duur-label">Duur</span><div class="segment" role="group" aria-labelledby="duur-label">
      ${DUREN.map(m => `<button type="button" class="${les.duur === m ? 'aan' : ''}" data-duur="${m}" aria-pressed="${les.duur === m}">${uren(m)}</button>`).join('')}
      <input name="duur" inputmode="numeric" placeholder="min" aria-label="Andere duur in minuten" class="${anders ? 'aan' : ''}" value="${anders ? les.duur : ''}">
    </div></div>
    <div class="veld" data-veld="wie"><span class="label">Wie doen er mee?</span>
      <div class="zoekbalk"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
        <input class="invoer" id="zoekveld" placeholder="Zoek of typ een nieuwe naam" autocomplete="off" autocapitalize="words" enterkeyhint="done" aria-label="Zoek klant of typ nieuwe naam"></div>
      <div class="chips" id="kies"></div><div class="fout"></div>
    </div>
    <div class="kader glas" id="deelnemers"></div>
    <div class="samenvatting" id="som"></div>
    <label class="veld"><span>Notitie (optioneel)</span><input name="notitie" value="${esc(les.notitie)}" autocomplete="off" placeholder="Bijv. bandeja geoefend"></label>
    <div class="knoppen">
      ${nieuw ? '' : '<button type="button" class="knop gevaar" id="weg">Verwijder</button>'}
      <button type="submit" class="knop hoofd">${nieuw ? 'Vastleggen' : 'Bewaar'}</button>
    </div>
    ${nieuw ? '' : `<div class="midden-tekst"><button type="button" class="link" id="kopie"><svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"/></svg>Zelfde les volgende week</button></div>`}`, () => {
    alles();

    form.onclick = async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.duur) {
        les.duur = +t.dataset.duur; form.elements.duur.value = ''; form.elements.duur.classList.remove('aan');
        form.querySelectorAll('[data-duur]').forEach(b => { b.classList.toggle('aan', b === t); b.setAttribute('aria-pressed', b === t); });
        tekenDeelnemers();
      } else if (t.dataset.kies) {
        const kid = t.dataset.kies;
        const i = les.deelnemers.findIndex(d => d.klantId === kid);
        if (i >= 0 && gefact(les, les.deelnemers[i])) return toast(`${klant(kid)?.naam} staat al op een factuur`);
        if (i >= 0) { les.deelnemers.splice(i, 1); handmatig.delete(kid); } else les.deelnemers.push({ klantId: kid, tarief: 0 });
        herbereken(); veldFout('wie', '');
        if (zoek) { zoek = ''; $('#zoekveld').value = ''; }
        alles();
      } else if (t.id === 'snel') {
        const k = nieuweKlant(zoek.trim());
        await DB.zet('klanten', k); await laad();
        les.deelnemers.push({ klantId: k.id, tarief: 0 });
        zoek = ''; $('#zoekveld').value = '';
        herbereken(); veldFout('wie', ''); alles();
        toast(`${k.naam} toegevoegd`);
      }
    };
    $('#zoekveld').addEventListener('input', e => { zoek = e.target.value; tekenKeuze(); });
    $('#zoekveld').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      ($('#snel') || $('#kies .chip:not(.aan)'))?.click();
    });
    form.elements.duur.addEventListener('input', e => {
      const m = parseInt(e.target.value, 10);
      e.target.classList.toggle('aan', m > 0);
      if (m > 0 && m <= 600) { les.duur = m; form.querySelectorAll('[data-duur]').forEach(b => { b.classList.remove('aan'); b.setAttribute('aria-pressed', 'false'); }); tekenDeelnemers(); }
    });
    // Tarief aanpassen: geldt alleen voor deze les
    $('#deelnemers').addEventListener('change', e => {
      const kid = e.target.dataset.tarief; if (!kid) return;
      const c = centen(e.target.value);
      if (isNaN(c)) { schud(e.target); e.target.value = euroKaal(les.deelnemers.find(d => d.klantId === kid).tarief); return toast('Tarief klopt niet, bijv. 25 of 22,50'); }
      les.deelnemers.find(d => d.klantId === kid).tarief = c; handmatig.add(kid); tekenDeelnemers();
    });

    form.onsubmit = async e => {
      e.preventDefault();
      if (document.activeElement?.dataset?.tarief) document.activeElement.blur(); // tarief eerst verwerken
      if (!les.deelnemers.length) { veldFout('wie', 'Kies minstens één deelnemer'); schud($('#kies').parentElement); $('#zoekveld').focus(); return; }
      if (!form.elements.datum.value || !form.elements.tijd.value) return toast('Vul datum en tijd in');
      const voor = dezeWeek().filter(l => l.id !== les.id).reduce((s, l) => s + l.duur, 0) + (S.lessen.find(l => l.id === les.id && weekStart(l.datum) === weekStart(vandaag()))?.duur || 0);
      const eerste = !S.lessen.length;
      les.datum = form.elements.datum.value; les.tijd = form.elements.tijd.value; les.notitie = form.elements.notitie.value.trim();
      await DB.zet('lessen', les); await laad(); await sluit();
      if (S.view !== 'lessen') { S.view = 'lessen'; history.replaceState(null, '', '#lessen'); }
      teken(nieuw);
      if (!nieuw) return toast('Les bewaard');
      const na = dezeWeek().reduce((s, l) => s + l.duur, 0);
      vlucht();
      tril();
      if (eerste) toast(`Eerste les · ${kreet()}`); // de trofee volgt vanzelf
      else if (Math.floor(na / 300) > Math.floor(voor / 300)) { setTimeout(() => confetti(), 900); toast(`Golden point! ${uren(Math.floor(na / 300) * 300)} deze week`, { duur: 3200 }); }
      else toast(`Les vastgelegd · ${kreet()}`);
      trofeeen();
    };
    $('#weg')?.addEventListener('click', () => verwijder('lessen', les, 'Les'));
    $('#kopie')?.addEventListener('click', async () => {
      const d = datumObj(les.datum); d.setDate(d.getDate() + 7);
      const kopie = { ...structuredClone(les), id: id(), datum: d.toLocaleDateString('sv-SE'), factuur: null };
      kopie.deelnemers = kopie.deelnemers.map(({ factuur, ...d }) => d); // de kopie is nog niet gefactureerd
      await sluit(); lesSheet(kopie, true); // opent als nieuwe les, pas bewaard na Vastleggen
    });
  });
}

/* ---------- Instellingen (eigen gegevens voor de factuur) ---------- */
function volgendNummer(datum = vandaag()) {
  const j = +datum.slice(0, 4);
  let n = S.ik.jaar === j ? S.ik.volgnr : 1;
  const maak = () => `${j}-${String(n).padStart(3, '0')}`;
  while (S.facturen.some(f => f.nummer === maak())) n++; // nooit een dubbel nummer
  return { j, n, nummer: maak() };
}

function instellingenSheet(daarna) {
  const ik = S.ik;
  openSheet('Jouw gegevens', `
    <p class="uitleg">Deze gegevens komen op elke factuur.</p>
    <label class="veld" data-veld="naam"><span>Naam</span><input name="naam" value="${esc(ik.naam)}" autocomplete="name" autocapitalize="words"><div class="fout"></div></label>
    <label class="veld"><span>Bedrijfsnaam (optioneel)</span><input name="bedrijf" value="${esc(ik.bedrijf)}" autocomplete="organization" placeholder="Bijv. Padel Coaching Jansen"></label>
    <label class="veld"><span>Adres</span><textarea name="adres" rows="2" autocomplete="street-address" placeholder="Straat 1&#10;1234 AB Plaats">${esc(ik.adres)}</textarea></label>
    <div class="twee">
      <label class="veld"><span>E-mail</span><input name="email" type="email" inputmode="email" autocapitalize="off" value="${esc(ik.email)}" autocomplete="email"></label>
      <label class="veld"><span>Telefoon</span><input name="telefoon" type="tel" value="${esc(ik.telefoon)}" autocomplete="tel"></label>
    </div>
    <h4 class="sectie">Bedrijf en betaling</h4>
    <div class="twee">
      <label class="veld" data-veld="kvk"><span>KvK-nummer</span><input name="kvk" inputmode="numeric" value="${esc(ik.kvk)}" placeholder="12345678"><div class="fout"></div></label>
      <label class="veld" data-veld="btw"><span>Btw-nummer</span><input name="btw" autocapitalize="characters" value="${esc(ik.btw)}" placeholder="NL000099998B57"><div class="fout"></div></label>
    </div>
    <label class="veld" data-veld="iban"><span>IBAN</span><input name="iban" autocapitalize="characters" value="${esc(ibanMooi(ik.iban))}" placeholder="NL00 BANK 0123 4567 89"><div class="fout"></div></label>
    <label class="veld"><span>Ten name van</span><input name="tnv" value="${esc(ik.tnv)}" placeholder="${esc(ik.bedrijf || ik.naam || 'Zoals op je bankrekening')}"></label>
    <div class="twee">
      <label class="veld" data-veld="termijn"><span>Betalen binnen (dagen)</span><input name="termijn" inputmode="numeric" value="${ik.termijn}"><div class="fout"></div></label>
      <label class="veld" data-veld="volgnr"><span>Volgend factuurnr.</span><input name="volgnr" inputmode="numeric" value="${volgendNummer().n}"><div class="fout"></div></label>
    </div>
    <h4 class="sectie">Standaardtarieven nieuwe klant</h4>
    <div class="twee">
      <label class="veld" data-veld="prive"><span>Privé per uur</span><input name="prive" inputmode="decimal" value="${euroKaal(ik.prive)}"><div class="fout"></div></label>
      <label class="veld" data-veld="groep"><span>Groep p.p. per uur</span><input name="groep" inputmode="decimal" value="${euroKaal(ik.groep)}"><div class="fout"></div></label>
    </div>
    <h4 class="sectie">App</h4>
    <label class="schakel"><span>Geluid bij de bal<small>Een padel-"pok" bij het vastleggen, factureren en de smash</small></span><input type="checkbox" name="geluid" role="switch" ${S.ik.geluid !== false ? 'checked' : ''}></label>
    <h4 class="sectie">Bericht bij de factuur</h4>
    <label class="veld"><span class="sr">Bericht</span><textarea name="bericht" rows="7">${esc(ik.bericht)}</textarea>
      <small class="hulp">{voornaam} {nummer} {bedrag} {vervaldatum} {iban} {tnv} {naam} worden automatisch ingevuld.</small></label>
    <div class="knoppen"><button type="submit" class="knop hoofd">Bewaar</button></div>
    <h4 class="sectie">Back-up en export</h4>
    <p class="uitleg">Alles staat alleen op deze telefoon. Maak regelmatig een back-up en bewaar hem in iCloud Drive of je mail. Laatste back-up: <b>${backupTekst()}</b>.</p>
    <div class="knoppen"><button type="button" class="knop met-icoon" id="backup">${DEEL}Maak back-up</button></div>
    <div class="knoppen">
      <button type="button" class="knop" id="terugzetten">Zet back-up terug</button>
      <button type="button" class="knop" id="csv">Facturen (CSV)</button>
    </div>`, () => {
    $('#backup').onclick = backupMaken;
    $('#terugzetten').onclick = backupTerug;
    $('#csv').onclick = exportCsv;
    form.elements.geluid.onchange = e => { if (e.target.checked) { S.ik.geluid = true; pok(1); } };
    form.onsubmit = async e => {
      e.preventDefault();
      const f = form.elements, w = n => f[n].value.trim();
      const kvk = w('kvk').replace(/\s/g, ''), btw = w('btw').replace(/[\s.]/g, '').toUpperCase(), iban = w('iban').replace(/\s/g, '').toUpperCase();
      const termijn = +w('termijn'), volgnr = +w('volgnr'), prive = centen(w('prive')), groep = centen(w('groep'));
      const fouten = {
        naam: w('naam') ? '' : 'Vul je naam in',
        kvk: !kvk || /^\d{8}$/.test(kvk) ? '' : 'Een KvK-nummer heeft 8 cijfers',
        btw: !btw || /^NL\d{9}B\d{2}$/.test(btw) ? '' : 'Bijv. NL000099998B57',
        iban: !iban ? 'Nodig om betaald te worden' : ibanOk(iban) ? '' : 'Dit IBAN klopt niet, controleer de cijfers',
        termijn: Number.isInteger(termijn) && termijn >= 0 && termijn <= 120 ? '' : '0 tot 120 dagen',
        volgnr: Number.isInteger(volgnr) && volgnr >= 1 ? '' : 'Vanaf 1',
        prive: isNaN(prive) ? 'Bijv. 60' : '', groep: isNaN(groep) ? 'Bijv. 25' : '',
      };
      Object.entries(fouten).forEach(([k, t]) => veldFout(k, t));
      const eerste = form.querySelector('.fout-aan');
      if (eerste) { schud(eerste); eerste.querySelector('input')?.focus(); return; }
      Object.assign(S.ik, { naam: w('naam'), bedrijf: w('bedrijf'), adres: f.adres.value.trim(), email: w('email'), telefoon: w('telefoon'), kvk, btw, iban, tnv: w('tnv'), termijn, volgnr, jaar: new Date().getFullYear(), prive, groep, bericht: f.bericht.value.trim() || STANDAARD_BERICHT, geluid: f.geluid.checked });
      await DB.zet('instellingen', S.ik, 'ik'); await laad(); await sluit();
      toast('Gegevens bewaard');
      daarna?.();
    };
  });
}

/* ---------- Back-up en export ---------- */
// Delen via het deelmenu (iCloud Drive, Mail, WhatsApp), anders downloaden
async function deelBestand(blob, naam, titel) {
  const file = new File([blob], naam, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: titel }); return 'gedeeld'; }
    catch (e) { if (e.name === 'AbortError') return 'afgebroken'; }
  }
  download(blob, naam); return 'gedownload';
}
const dagenGeleden = d => d ? Math.floor((datumObj(vandaag()) - datumObj(d)) / 864e5) : null;
const backupTekst = () => { const n = dagenGeleden(S.ik.laatsteBackup); return n === null ? 'nog nooit' : n === 0 ? 'vandaag' : n === 1 ? 'gisteren' : `${n} dagen geleden`; };

async function backupMaken() {
  const data = { app: 'padel-uren', versie: 2, gemaakt: new Date().toISOString(), datum: vandaag(), klanten: S.klanten, lessen: S.lessen, facturen: S.facturen, ik: S.ik };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const uit = await deelBestand(blob, `Padel Uren back-up ${vandaag()}.json`, 'Padel Uren back-up');
  if (uit === 'afgebroken') return;
  S.ik.laatsteBackup = vandaag(); await DB.zet('instellingen', S.ik, 'ik');
  teken(false);
  toast(uit === 'gedeeld' ? 'Back-up gemaakt' : 'Back-up gedownload · bewaar hem goed');
}

function backupTerug() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const bestand = inp.files[0]; if (!bestand) return;
    let data;
    try { data = JSON.parse(await bestand.text()); } catch { return toast('Dit bestand is geen back-up'); }
    if (data?.app !== 'padel-uren' || !Array.isArray(data.klanten) || !Array.isArray(data.lessen)) return toast('Dit is geen back-up van Padel Uren');
    const tel = (n, een, meer) => `${n} ${n === 1 ? een : meer}`;
    const inhoud = `${tel(data.klanten.length, 'klant', 'klanten')}, ${tel(data.lessen.length, 'les', 'lessen')}, ${tel((data.facturen || []).length, 'factuur', 'facturen')}`;
    const gemaakt = data.datum || new Date(data.gemaakt).toLocaleDateString('sv-SE'); // lokale datum, niet UTC
    if (!confirm(`Back-up van ${langDatum(gemaakt)} terugzetten?\n\n${inhoud}\n\nAlles wat nu in de app staat, wordt vervangen.`)) return;
    const huidig = { klanten: S.klanten, lessen: S.lessen, facturen: S.facturen, ik: S.ik };
    try { await DB.vervang(data); } catch { return toast('Terugzetten lukte niet, er is niets veranderd'); }
    await laad(); await sluit(); teken();
    toast(`Teruggezet: ${inhoud}`, { actie: 'Ongedaan', bij: async () => { await DB.vervang(huidig); await laad(); teken(false); toast('Vorige gegevens terug'); } });
  };
  inp.click();
}

// Facturenlijst voor de boekhouder (Excel opent dit direct: puntkomma en BOM)
async function exportCsv() {
  if (!S.facturen.length) return toast('Nog geen facturen om te exporteren');
  const rijen = [['Factuurnummer', 'Factuurdatum', 'Vervaldatum', 'Klant', 'Excl. btw', 'Btw 21%', 'Totaal', 'Status', 'Betaald op']];
  S.facturen.slice().sort((a, b) => a.nummer.localeCompare(b.nummer)).forEach(f =>
    rijen.push([f.nummer, f.datum, f.verval, f.aan.naam, euroKaal(f.excl), euroKaal(f.btw), euroKaal(f.totaal), f.status === 'betaald' ? 'betaald' : 'open', f.betaaldOp || '']));
  const csv = '﻿' + rijen.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const uit = await deelBestand(new Blob([csv], { type: 'text/csv' }), `Padel Uren facturen ${vandaag()}.csv`, 'Facturen');
  if (uit !== 'afgebroken') toast('Facturenlijst klaar voor de boekhouder');
}

/* ---------- Factuur maken ---------- */
function factuurMaken(kid) {
  if (!S.ik.naam || !ibanOk(S.ik.iban)) { toast('Vul eerst je gegevens voor de factuur in'); return instellingenSheet(() => factuurMaken(kid)); }
  const k = klant(kid), open = openPerKlant().find(x => x.klantId === kid);
  if (!k || !open) return;
  const regels = open.regels.slice().sort((a, b) => (a.les.datum + a.les.tijd).localeCompare(b.les.datum + b.les.tijd));
  const gekozen = new Set(regels.map(x => x.les.id));
  openSheet(`Factuur voor ${esc(k.naam)}`, `
    ${!k.adres ? `<p class="uitleg">Geen adres bij ${esc(k.naam)}. Voor particulieren is dat niet verplicht. <button type="button" class="link" id="adres">Aanvullen</button></p>` : ''}
    <div class="veld"><div class="label-rij"><span class="label">Lessen op deze factuur</span><button type="button" class="link" id="allemaal">Niets</button></div>
      <div class="kader glas" id="keuze">${regels.map(x => `<label class="vink"><input type="checkbox" data-les="${x.les.id}" checked>
        <span class="vinkje" aria-hidden="true"></span>
        <span class="vink-tekst"><b>${kortDatum(x.les.datum)} · ${uren(x.les.duur)}</b><small>${lesOmschrijving(x.les.deelnemers.length)} · ${euro(x.d.tarief)}/u</small></span>
        <span class="vink-bedrag">${euro(regelBedrag(x.les, x.d))}</span></label>`).join('')}</div></div>
    <div class="twee">
      <label class="veld"><span>Factuurdatum</span><input name="datum" type="date" value="${vandaag()}" max="${vandaag()}"></label>
      <label class="veld"><span>Betalen binnen (dagen)</span><input name="termijn" inputmode="numeric" value="${S.ik.termijn}"></label>
    </div>
    <div class="samenvatting" id="som"></div>
    <div class="knoppen"><button type="submit" class="knop hoofd" id="maak"></button></div>`, () => {
    const tekenSom = () => {
      const t = regels.filter(x => gekozen.has(x.les.id)).reduce((s, x) => s + regelBedrag(x.les, x.d), 0);
      $('#som').innerHTML = `<span>${gekozen.size} ${gekozen.size === 1 ? 'les' : 'lessen'} · excl. btw ${euro(Math.round(t / 1.21))}</span><b>${euro(t)}</b>`;
      $('#maak').disabled = !gekozen.size;
      $('#maak').textContent = gekozen.size ? `Maak factuur ${volgendNummer(form.elements.datum.value || vandaag()).nummer}` : 'Kies minstens één les';
      $('#allemaal').textContent = gekozen.size === regels.length ? 'Niets' : 'Alles';
    };
    tekenSom();
    $('#keuze').addEventListener('change', e => { const lid = e.target.dataset.les; e.target.checked ? gekozen.add(lid) : gekozen.delete(lid); tekenSom(); });
    $('#allemaal').addEventListener('click', () => {
      const aan = gekozen.size !== regels.length;
      form.querySelectorAll('#keuze input').forEach(i => { i.checked = aan; aan ? gekozen.add(i.dataset.les) : gekozen.delete(i.dataset.les); });
      tekenSom();
    });
    form.elements.datum.addEventListener('change', tekenSom);
    $('#adres')?.addEventListener('click', async () => { await sluit(); klantSheet(k); });
    form.onsubmit = async e => {
      e.preventDefault();
      if (!gekozen.size) return;
      const datum = form.elements.datum.value || vandaag();
      const termijn = Math.min(120, Math.max(0, parseInt(form.elements.termijn.value, 10) || 0));
      const f = await maakFactuur(k, regels.filter(x => gekozen.has(x.les.id)), datum, termijn);
      await sluit();
      S.fview = 'onbetaald'; teken();
      confetti(); pok(1); tril();
      factuurSheet(f);
      trofeeen();
      toast(`Factuur ${f.nummer} klaar · ${kreet()}`); // na de sheet, anders valt hij erachter
    };
  });
}

async function maakFactuur(k, regels, datum, termijn) {
  const { j, n, nummer } = volgendNummer(datum);
  const verval = datumObj(datum); verval.setDate(verval.getDate() + termijn);
  const r = regels.map(({ les, d }) => ({ lesId: les.id, datum: les.datum, tijd: les.tijd, duur: les.duur, personen: les.deelnemers.length, tarief: d.tarief, bedrag: regelBedrag(les, d) }));
  const totaal = r.reduce((s, x) => s + x.bedrag, 0), excl = Math.round(totaal / 1.21);
  // Gegevens van afzender en klant worden vastgelegd: latere wijzigingen veranderen deze factuur niet
  const { bericht, volgnr, jaar, prive, groep, laatsteBackup, ...van } = S.ik;
  const f = { id: id(), nummer, datum, verval: iso(verval), termijn, klantId: k.id, aan: { naam: k.naam, adres: k.adres, email: k.email }, van, regels: r, totaal, excl, btw: totaal - excl, status: 'open', betaaldOp: null, verstuurdOp: null };
  for (const { les } of regels) {
    const l = structuredClone(S.lessen.find(x => x.id === les.id));
    l.deelnemers.find(d => d.klantId === k.id).factuur = f.id;
    await DB.zet('lessen', l);
  }
  await DB.zet('facturen', f);
  if (j > S.ik.jaar || (j === S.ik.jaar && n + 1 > S.ik.volgnr)) { S.ik.jaar = j; S.ik.volgnr = n + 1; await DB.zet('instellingen', S.ik, 'ik'); }
  await laad();
  return f;
}

/* ---------- Factuur bekijken, versturen, betaald ---------- */
const DEEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
const bestandsnaam = f => `Factuur ${f.nummer} ${f.aan.naam}.pdf`.replace(/[\\/:*?"<>|]/g, '');
const HERINNERING = 'Hoi {voornaam},\n\nMisschien over het hoofd gezien: factuur {nummer} van {bedrag} stond open tot {vervaldatum}. Wil je het alsnog overmaken naar {iban} t.n.v. {tnv}, onder vermelding van {nummer}? Is het al betaald, dan kun je dit bericht negeren.\n\nGroet,\n{naam}';
function bericht(f, sjabloon) {
  const v = { voornaam: f.aan.naam.split(/\s+/)[0], naam: f.van.naam, nummer: f.nummer, bedrag: euro(f.totaal), vervaldatum: langDatum(f.verval), iban: ibanMooi(f.van.iban), tnv: f.van.tnv || f.van.bedrijf || f.van.naam };
  return (sjabloon || S.ik.bericht || STANDAARD_BERICHT).replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
}
function download(blob, naam) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = naam; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function factuurSheet(f) {
  let pdf = null;
  // PDF alvast maken: iOS staat delen alleen direct na een tik toe, niet na lang wachten
  const klaar = maakPdf(f).then(b => (pdf = b)).catch(err => { console.error(err); toast('PDF maken lukte niet'); });
  const status = f.status === 'betaald' ? `<span class="badge">betaald op ${kortDatum(f.betaaldOp)}</span>`
    : teLaat(f) ? `<span class="badge rood">te laat, verviel ${kortDatum(f.verval)}</span>` : `<span class="badge grijs">open, vervalt ${kortDatum(f.verval)}</span>`;
  const max = 5, rest = f.regels.length - max;
  const herinner = teLaat(f); // te laat: de hoofdknop wordt een herinnering
  const tekst = () => herinner ? bericht(f, HERINNERING) : bericht(f);
  openSheet(`Factuur ${f.nummer}`, `
    <div class="fstatus">${status}${f.verstuurdOp ? `<span class="badge grijs">verstuurd ${kortDatum(f.verstuurdOp)}</span>` : ''}${f.herinnerdOp ? `<span class="badge grijs">herinnerd ${kortDatum(f.herinnerdOp)}</span>` : ''}</div>
    <button type="button" class="papier" id="bekijk" aria-label="Bekijk de PDF van factuur ${f.nummer}">
      <span class="p-kop"><span class="p-van">${BAL}<b>${esc(f.van.bedrijf || f.van.naam)}</b></span><span class="p-titel">FACTUUR</span></span>
      <span class="p-meta"><span>Aan <b>${esc(f.aan.naam)}</b></span><span>${f.nummer} · ${kortDatum(f.datum)}</span></span>
      <span class="p-regels">${f.regels.slice(0, max).map(r => `<span><span>${kortDatum(r.datum)} · ${lesOmschrijving(r.personen)}</span><span>${euro(r.bedrag)}</span></span>`).join('')}
        ${rest > 0 ? `<span class="p-meer"><span>+ ${rest} ${rest === 1 ? 'les' : 'lessen'}</span><span></span></span>` : ''}</span>
      <span class="p-tot"><span>Excl. btw ${euro(f.excl)} · btw ${euro(f.btw)}</span><b>${euro(f.totaal)}</b></span>
      <span class="p-hint">Tik om de PDF te bekijken</span>
    </button>
    <div class="knoppen"><button type="button" class="knop hoofd met-icoon" id="deel">${DEEL}${herinner ? 'Stuur herinnering' : 'Versturen'}</button></div>
    <div class="knoppen">
      <button type="button" class="knop" id="kopieer">Kopieer bericht</button>
      <button type="button" class="knop" id="betaald">${f.status === 'betaald' ? 'Toch onbetaald' : 'Markeer betaald'}</button>
    </div>
    <div class="midden-tekst"><button type="button" class="link rood-link" id="weg">Verwijder factuur</button></div>`, () => {
    $('#bekijk').onclick = async () => {
      await klaar; if (!pdf) return;
      const url = URL.createObjectURL(pdf);
      if (!window.open(url, '_blank')) download(pdf, bestandsnaam(f));
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    $('#deel').onclick = async () => {
      const tekstNu = tekst();
      if (!pdf) await klaar;
      if (!pdf) return;
      const file = new File([pdf], bestandsnaam(f), { type: 'application/pdf' });
      const tekst = tekstNu;
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `${herinner ? 'Herinnering f' : 'F'}actuur ${f.nummer}`, text: tekst });
          await bewaarFactuur(f, herinner ? { herinnerdOp: vandaag() } : { verstuurdOp: f.verstuurdOp || vandaag() });
          await sluit(); toast(herinner ? `Herinnering ${f.nummer} verstuurd` : `Factuur ${f.nummer} verstuurd · ${kreet()}`);
          return;
        } catch (e) { if (e.name === 'AbortError') return; }
      }
      // Geen deelmenu (bv. op een computer): downloaden en bericht kopiëren
      download(pdf, bestandsnaam(f));
      try { await navigator.clipboard.writeText(tekst); } catch {}
      toast('PDF gedownload en bericht gekopieerd', { actie: 'Markeer verstuurd', bij: async () => { await bewaarFactuur(f, herinner ? { herinnerdOp: vandaag() } : { verstuurdOp: vandaag() }); toast('Gemarkeerd als verstuurd'); } });
    };
    $('#kopieer').onclick = async () => {
      try { await navigator.clipboard.writeText(tekst()); toast(herinner ? 'Herinnering gekopieerd' : 'Bericht gekopieerd'); }
      catch { toast('Kopiëren lukte niet'); }
    };
    $('#betaald').onclick = async () => {
      const betaald = f.status !== 'betaald';
      await bewaarFactuur(f, betaald ? { status: 'betaald', betaaldOp: vandaag() } : { status: 'open', betaaldOp: null });
      await sluit();
      if (betaald) { confetti(36); pok(1); tril(20); toast('Juego, set y partido! Betaald', { duur: 3000 }); trofeeen(); } else toast('Weer op onbetaald gezet');
    };
    $('#weg').onclick = () => verwijderFactuur(f);
  });
}

async function bewaarFactuur(f, velden) {
  Object.assign(f, velden);
  await DB.zet('facturen', f); await laad(); teken(false);
}

// Verwijderen zet de lessen terug op "te factureren"; het nummer komt alleen vrij als het de laatste was
async function verwijderFactuur(f) {
  const lessenVoor = S.lessen.filter(l => l.deelnemers.some(d => d.factuur === f.id)).map(l => structuredClone(l));
  const ikVoor = { ...S.ik };
  for (const l of lessenVoor) {
    const n = structuredClone(l);
    n.deelnemers.forEach(d => { if (d.factuur === f.id) delete d.factuur; });
    await DB.zet('lessen', n);
  }
  const [j, nr] = f.nummer.split('-').map(Number);
  if (S.ik.jaar === j && S.ik.volgnr === nr + 1) { S.ik.volgnr = nr; await DB.zet('instellingen', S.ik, 'ik'); }
  await DB.weg('facturen', f.id); await laad(); await sluit(); teken(false);
  toast(`Factuur ${f.nummer} verwijderd`, { actie: 'Ongedaan', bij: async () => {
    await DB.zet('facturen', f);
    for (const l of lessenVoor) await DB.zet('lessen', l);
    await DB.zet('instellingen', ikVoor, 'ik'); await laad(); teken(false); toast('Teruggezet');
  } });
}

/* ---------- PDF (jsPDF, lokaal in lib/ zodat het offline werkt) ---------- */
let jspdfLaden;
const laadJsPdf = () => jspdfLaden || (jspdfLaden = new Promise((ok, fout) => {
  if (window.jspdf) return ok();
  const s = document.createElement('script');
  s.src = 'lib/jspdf.umd.min.js'; s.onload = ok;
  s.onerror = () => { jspdfLaden = null; fout(new Error('jsPDF niet geladen')); };
  document.head.append(s);
}));

async function maakPdf(f) {
  await laadJsPdf();
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const v = f.van, L = 18, R = 192, BLAUW = [22, 104, 227], INKT = [13, 27, 42], GRIJS = [95, 108, 122];
  const kleur = c => doc.setTextColor(...c);
  const letter = (stijl, grootte) => { doc.setFont('helvetica', stijl); doc.setFontSize(grootte); };
  doc.setProperties({ title: `Factuur ${f.nummer}`, author: v.bedrijf || v.naam, creator: 'Padel Uren' });

  function voet() {
    doc.setDrawColor(225, 230, 236); doc.setLineWidth(.3); doc.line(L, 280, R, 280);
    letter('normal', 7.5); kleur(GRIJS);
    doc.text([v.bedrijf || v.naam, v.kvk && `KvK ${v.kvk}`, v.btw && `Btw ${v.btw}`, `IBAN ${ibanMooi(v.iban)}`, v.email].filter(Boolean).join('   ·   '), 105, 285, { align: 'center' });
  }

  // Padelbal als beeldmerk
  doc.setFillColor(215, 242, 91); doc.circle(L + 5, 21, 5, 'F');
  doc.setDrawColor(255, 255, 255); doc.setLineWidth(.7);
  doc.lines([[2.4, 2.2, 2.4, 5.8, 0, 8]], L + 1.8, 17, [1, 1], 'S');
  doc.lines([[-2.4, 2.2, -2.4, 5.8, 0, 8]], L + 8.2, 17, [1, 1], 'S');

  letter('bold', 16); kleur(INKT); doc.text(v.bedrijf || v.naam, L + 14, 23);
  let y = 33; letter('normal', 9); kleur(GRIJS);
  [v.bedrijf ? v.naam : '', ...(v.adres || '').split('\n'), v.email, v.telefoon].filter(Boolean).forEach(t => { doc.text(t, L, y); y += 4.5; });

  letter('bold', 24); kleur(BLAUW); doc.text('FACTUUR', R, 24, { align: 'right' });
  let my = 33;
  [['Factuurnummer', f.nummer], ['Factuurdatum', langDatum(f.datum)], ['Vervaldatum', langDatum(f.verval)]].forEach(([a, b]) => {
    letter('normal', 9); kleur(GRIJS); doc.text(a, 130, my);
    letter('bold', 9); kleur(INKT); doc.text(b, R, my, { align: 'right' }); my += 5;
  });

  y = Math.max(y, my) + 8;
  letter('bold', 8); kleur(BLAUW); doc.text('FACTUUR AAN', L, y); y += 5;
  letter('bold', 11); kleur(INKT); doc.text(f.aan.naam, L, y); y += 5;
  letter('normal', 9); kleur(GRIJS);
  [...(f.aan.adres || '').split('\n'), f.aan.email].filter(Boolean).forEach(t => { doc.text(t, L, y); y += 4.5; });
  y += 8;

  const kol = { datum: L + 3, oms: L + 28, duur: 132, tarief: 160, bedrag: R - 3 };
  const kop = () => {
    doc.setFillColor(232, 240, 252); doc.roundedRect(L, y, R - L, 9, 2, 2, 'F');
    letter('bold', 8); kleur(BLAUW);
    doc.text('DATUM', kol.datum, y + 5.8); doc.text('OMSCHRIJVING', kol.oms, y + 5.8);
    doc.text('DUUR', kol.duur, y + 5.8, { align: 'right' }); doc.text('TARIEF P/U', kol.tarief, y + 5.8, { align: 'right' }); doc.text('BEDRAG', kol.bedrag, y + 5.8, { align: 'right' });
    y += 11;
  };
  kop();
  f.regels.forEach((r, i) => {
    if (y > 262) { voet(); doc.addPage(); y = 20; kop(); }
    if (i % 2) { doc.setFillColor(247, 249, 252); doc.rect(L, y - 1.5, R - L, 8, 'F'); }
    letter('normal', 9.5); kleur(INKT);
    doc.text(datumObj(r.datum).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }), kol.datum, y + 4);
    doc.text(lesOmschrijving(r.personen), kol.oms, y + 4);
    doc.text(uren(r.duur), kol.duur, y + 4, { align: 'right' });
    doc.text(euro(r.tarief), kol.tarief, y + 4, { align: 'right' });
    doc.text(euro(r.bedrag), kol.bedrag, y + 4, { align: 'right' });
    y += 8;
  });

  if (y > 220) { voet(); doc.addPage(); y = 24; }
  y += 4; doc.setDrawColor(225, 230, 236); doc.setLineWidth(.3); doc.line(118, y, R, y); y += 7;
  const regel = (a, b) => { letter('normal', 9.5); kleur(GRIJS); doc.text(a, 122, y); kleur(INKT); doc.text(b, R - 3, y, { align: 'right' }); y += 6; };
  regel('Subtotaal excl. btw', euro(f.excl));
  regel('Btw 21%', euro(f.btw));
  doc.setFillColor(...BLAUW); doc.roundedRect(118, y - 1, R - 118, 11, 2, 2, 'F');
  letter('bold', 11); doc.setTextColor(255, 255, 255);
  doc.text('Totaal', 122, y + 6.2); doc.text(euro(f.totaal), R - 3, y + 6.2, { align: 'right' });
  y += 24;

  letter('normal', 9.5); kleur(INKT);
  const tekst = `Graag het totaalbedrag van ${euro(f.totaal)} vóór ${langDatum(f.verval)} overmaken naar ${ibanMooi(v.iban)} t.n.v. ${v.tnv || v.bedrijf || v.naam}, onder vermelding van factuurnummer ${f.nummer}.`;
  const regels = doc.splitTextToSize(tekst, R - L);
  doc.text(regels, L, y); y += regels.length * 4.8 + 6;
  letter('bold', 10); kleur(BLAUW); doc.text('Bedankt en tot op de baan!', L, y);
  voet();
  return doc.output('blob');
}

/* ---------- Navigatie ---------- */
function gaNaar(v) {
  if (!VIEWS.includes(v) || v === S.view) return;
  S.view = v; history.replaceState(null, '', '#' + v);
  teken(); scrollTo({ top: 0, behavior: rustig() ? 'auto' : 'smooth' });
}
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) gaNaar(b.dataset.view); });
$('#plus').addEventListener('click', () => S.view === 'klanten' ? klantSheet() : lesSheet());
$('#main').addEventListener('click', e => {
  const st = e.target.closest('.stuiter'); if (st) return smash(st);
  const b = e.target.closest('[data-periode], [data-stap], [data-filterklant]');
  if (b) {
    if (b.dataset.periode) Object.assign(S.stat, { periode: b.dataset.periode, stap: 0 });
    else if (b.dataset.stap) S.stat.stap = Math.min(0, S.stat.stap + +b.dataset.stap);
    else S.stat.klant = S.stat.klant === b.dataset.filterklant ? '' : b.dataset.filterklant;
    return teken();
  }
  const hh = e.target.closest('[data-herhaal]');
  if (hh) return herhaal(hh.dataset.herhaal === 'alles' ? herhaalVoorstellen() : [S.lessen.find(l => l.id === hh.dataset.herhaal)]);
  const actie = e.target.closest('[data-actie]')?.dataset.actie;
  if (actie === 'backup') return backupMaken();
  if (actie === 'backup-later') { S.backupLater = true; return teken(false); }
  if (actie === 'install-weg') { try { localStorage.setItem('padel-install-weg', '1'); } catch {} return teken(false); }
  if (actie === 'installeer' && installPrompt) { installPrompt.prompt(); installPrompt.userChoice.finally(() => { installPrompt = null; teken(false); }); return; }
  const fv = e.target.closest('[data-fview]');
  if (fv) { if (S.fview !== fv.dataset.fview) { S.fview = fv.dataset.fview; teken(); } return; }
  const r = e.target.closest('.rij'); if (!r) return;
  if (r.dataset.les) lesSheet(S.lessen.find(l => l.id === r.dataset.les));
  else if (r.dataset.klant) klantSheet(S.klanten.find(k => k.id === r.dataset.klant));
  else if (r.dataset.maak) factuurMaken(r.dataset.maak);
  else if (r.dataset.factuur) factuurSheet(S.facturen.find(f => f.id === r.dataset.factuur));
});
$('#instellingen').addEventListener('click', () => instellingenSheet());
$('#main').addEventListener('change', e => {
  if (e.target.id === 'f-klant') { S.stat.klant = e.target.value; teken(); }
  else if (e.target.id === 'f-soort') { S.stat.soort = e.target.value; teken(); }
});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => S.view === 'stats' && tekenGrafiek(false), 150); });
$('#main').addEventListener('input', e => {
  if (e.target.id !== 'zoek-klant') return;
  const z = e.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-klant]').forEach(r => { r.hidden = !!z && !r.dataset.naam.includes(z); });
});
// Kleine kop in glas zodra de grote titel uit beeld scrolt
new IntersectionObserver(([e]) => $('#balk').classList.toggle('zicht', !e.isIntersecting), { rootMargin: '-50px 0px 0px 0px' }).observe($('#titel'));

(async () => {
  const h = location.hash.slice(1); if (VIEWS.includes(h)) S.view = h; else if (h === 'open') S.view = 'facturen';
  intro();
  await laad(); teken();
  trofeeen(true); // wat er al is, telt stil mee
  navigator.storage?.persist?.(); // vraag de browser de data niet op te ruimen
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
})();
