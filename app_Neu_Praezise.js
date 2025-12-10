/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5518,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,
  ROUNDS_MIN: parseInt(Q.get('rmin') || '8', 10),
  ROUNDS_MAX: parseInt(Q.get('rmax') || '12', 10),
  THINK_DELAY_MS_MIN: parseInt(Q.get('tmin') || '1200', 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get('tmax') || '2800', 10),
  ACCEPT_RANGE_MIN: Number(Q.get('armin')) || 4700,
  ACCEPT_RANGE_MAX: Number(Q.get('armax')) || 4800
};
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

/* ========================================================================== */
/* Spieler-ID / Probandencode initialisieren                                  */
/* ========================================================================== */
if (!window.playerId) {
  const fromUrl =
    Q.get('player_id') ||
    Q.get('playerId') ||
    Q.get('pid') ||
    Q.get('id');

  window.playerId = fromUrl || ('P_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
}

if (!window.probandCode) {
  const fromUrlCode =
    Q.get('proband_code') ||
    Q.get('probandCode') ||
    Q.get('code');

  window.probandCode = fromUrlCode || window.playerId;
}

/* ========================================================================== */
/* Konstanten                                                                 */
/* ========================================================================== */
const UNACCEPTABLE_LIMIT = 2250;
const EXTREME_BASE = 1500;
const ABSOLUTE_FLOOR = 3500;

const BASE_INITIAL_OFFER = CONFIG.INITIAL_OFFER;
const BASE_MIN_PRICE     = CONFIG.MIN_PRICE;
const BASE_STEP_AMOUNT   = 500;

const DIMENSION_FACTORS = [1.0, 1.3, 1.5];
let dimensionQueue = [];

function refillDimensionQueue() {
  dimensionQueue = [...DIMENSION_FACTORS];
  for (let i = dimensionQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dimensionQueue[i], dimensionQueue[j]] = [dimensionQueue[j], dimensionQueue[i]];
  }
}
function nextDimensionFactor() {
  if (dimensionQueue.length === 0) refillDimensionQueue();
  return dimensionQueue.pop();
}

const PERCENT_STEPS = [
  0.02, 0.021, 0.022, 0.023, 0.024, 0.025,
  0.026, 0.027, 0.028, 0.029, 0.03, 0.031,
  0.032, 0.033, 0.034, 0.035, 0.036, 0.037,
  0.038, 0.039, 0.04
];

/* ========================================================================== */
/* Hilfsfunktionen                                                            */
/* ========================================================================== */
const app = document.getElementById('app');

const randInt = (a,b) => Math.floor(a + Math.random()*(b-a+1));
const eur = n => new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'}).format(n);

/* ========================================================================== */
/* Zustand                                                                    */
/* ========================================================================== */
function newState(){
  const factor = nextDimensionFactor();

  const initialOffer  = Math.round(BASE_INITIAL_OFFER * factor);
  const floorRounded  = Math.round(ABSOLUTE_FLOOR * factor);
  const stepAmount    = BASE_STEP_AMOUNT * factor;

  return {
    participant_id: crypto.randomUUID?.() || ('x_'+Date.now()+Math.random().toString(36).slice(2)),
    runde: 1,
    max_runden: randInt(CONFIG.ROUNDS_MIN, CONFIG.ROUNDS_MAX),

    scale_factor: factor,
    step_amount: stepAmount,

    min_price: floorRounded,
    max_price: initialOffer,
    initial_offer: initialOffer,
    current_offer: initialOffer,

    history: [],
    last_concession: null,
    finished: false,
    accepted: false,

    patternMessage: '',
    deal_price: null,
    finish_reason: null,

    last_abort_chance: null
  };
}
let state = newState();

/* ========================================================================== */
/* Logging                                                                    */
/* ========================================================================== */
function logRound(row) {
  const payload = {
    participant_id: state.participant_id,
    player_id: window.playerId,
    proband_code: window.probandCode,

    scale_factor: state.scale_factor,

    runde: row.runde,
    algo_offer: row.algo_offer,
    proband_counter: row.proband_counter,
    accepted: row.accepted,
    finished: row.finished,
    deal_price: row.deal_price
  };

  if (window.sendRow) window.sendRow(payload);
  else console.log('[sendRow fallback]', payload);
}

/* ========================================================================== */
/* Auto-Accept                                                                */
/* ========================================================================== */
function shouldAutoAccept(initialOffer, minPrice, prevOffer, counter){
  const c = Number(counter);
  if (!Number.isFinite(c)) return false;

  const f = state.scale_factor;

  const diff = Math.abs(prevOffer - c);
  if (diff <= prevOffer * 0.05) return true;

  const accMin = CONFIG.ACCEPT_RANGE_MIN * f;
  const accMax = CONFIG.ACCEPT_RANGE_MAX * f;
  if (c >= accMin && c <= accMax) return true;

  const margin = CONFIG.ACCEPT_MARGIN;
  const threshold = Math.max(minPrice, initialOffer * (1 - margin));
  return c >= threshold;
}

/* ========================================================================== */
/* *** NEUE Abbruchwahrscheinlichkeit — NUR Differenzbasiert ***             */
/* ========================================================================== */

function abortProbability(userOffer) {
  const seller = state.current_offer;
  const buyer  = Number(userOffer);
  const f = state.scale_factor || 1.0;

  const diff = Math.abs(seller - buyer);

  if (buyer < 1500 * f) return 100;

  if (diff >= 1000 * f) return 60;
  if (diff >= 750  * f) return 45;
  if (diff >= 500  * f) return 30;
  if (diff >= 250  * f) return 15;
  if (diff >= 100  * f) return 8;

  return 2;
}

function maybeAbort(userOffer) {
  const chance = abortProbability(userOffer);
  state.last_abort_chance = chance;

  const roll = randInt(1, 100);
  if (roll <= chance) {

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: userOffer,
      accepted: false,
      finished: true,
      deal_price: ''
    });

    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: userOffer,
      accepted: false
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';

    viewAbort(chance);
    return true;
  }
  return false;
}

/* ========================================================================== */
/* Mustererkennung                                                            */
/* ========================================================================== */
function getThresholdForAmount(prev){
  const f = state.scale_factor || 1.0;

  const A = 2250 * f;
  const B = 3000 * f;
  const C = 4000 * f;
  const D = 5000 * f;

  if (prev >= A && prev < B) return 0.05;
  if (prev >= B && prev < C) return 0.04;
  if (prev >= C && prev < D) return 0.03;
  return null;
}

function updatePatternMessage(){
  const f = state.scale_factor || 1.0;
  const limit = UNACCEPTABLE_LIMIT * f;

  const counters = [];
  for (let h of state.history) {
    let c = h.proband_counter;
    if (!c && c !== 0) continue;
    c = Number(c);
    if (c < limit) continue;
    counters.push(c);
  }

  if (counters.length < 3) {
    state.patternMessage = '';
    return;
  }

  let chainLen = 1;
  for (let j = 1; j < counters.length; j++) {
    const prev = counters[j - 1];
    const curr = counters[j];
    const diff = curr - prev;

    if (diff < 0) { chainLen = 1; continue; }

    const th = getThresholdForAmount(prev);
    if (th == null) { chainLen = 1; continue; }

    if (diff <= prev * th) chainLen++;
    else chainLen = 1;
  }

  state.patternMessage =
    chainLen >= 3
      ? 'Mit solchen kleinen Erhöhungen wird das schwierig...'
      : '';
}

/* ========================================================================== */
/* Angebotslogik                                                              */
/* ========================================================================== */
function computeNextOffer(prevOffer, minPrice){
  const prev  = Number(prevOffer);
  const floor = Number(minPrice);
  const step  = Number(state.step_amount);

  const raw = prev - step;
  return Math.max(floor, Math.min(raw, prev));
}

/* ========================================================================== */
/* Screens                                                                    */
/* ========================================================================== */

function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>
      Ein Verkäufer bietet eine <b>Designer-Ledercouch</b> an.
    </p>
    <p class="muted">
      Unangemessen niedrige oder kaum veränderte Angebote erhöhen das Abbruchrisiko.
    </p>

    <label class="consent">
      <input id="consent" type="checkbox">
      <span>Ich stimme der anonymen Speicherung zu.</span>
    </label>

    <button id="startBtn" disabled>Starten</button>
  `;

  document.getElementById('consent').onchange = e =>
    document.getElementById('startBtn').disabled = !e.target.checked;

  document.getElementById('startBtn').onclick = () => {
    state = newState();
    viewNegotiate();
  };
}

function viewThink(next){
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">…</span></h1>
  `;
  setTimeout(next, delay);
}

function historyTable(){
  if (!state.history.length) return '';
  return `
    <h2>Verlauf</h2>
    <table>
      <thead><tr>
        <th>Runde</th><th>Verkäufer</th><th>Du</th><th>OK?</th>
      </tr></thead>
      <tbody>
        ${state.history.map(h => `
          <tr>
            <td>${h.runde}</td>
            <td>${eur(h.algo_offer)}</td>
            <td>${h.proband_counter != null ? eur(h.proband_counter) : '-'}</td>
            <td>${h.accepted ? 'Ja' : 'Nein'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function viewAbort(chance){
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p>Abbruchwahrscheinlichkeit: <b>${chance}%</b></p>
    ${historyTable()}
    <button id="restartBtn">Neu starten</button>
  `;
  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };
}

function viewNegotiate(errorMsg){
  const abortChance = state.last_abort_chance ?? null;

  let color = '#16a34a';
  if (abortChance !== null) {
    if      (abortChance > 50) color = '#ea580c';
    else if (abortChance > 25) color = '#eab308';
  }

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>

    <div class="card">
      <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
    </div>

    <div style="
      border-left:6px solid ${color};
      padding:10px;
      background:${color}22;
      margin-bottom:10px;">
      <b style="color:${color};">Abbruchwahrscheinlichkeit:</b>
      <span style="color:${color}; font-weight:600;">
        ${abortChance !== null ? abortChance + '%' : '--'}
      </span>
    </div>

    <label>Dein Gegenangebot (€)</label>
    <input id="counter" type="number" step="1">

    <button id="sendBtn">Senden</button>
    <button id="acceptBtn" class="ghost">Annehmen</button>

    ${state.patternMessage ? `<p>${state.patternMessage}</p>` : ''}
    ${errorMsg ? `<p style="color:red">${errorMsg}</p>` : ''}

    ${historyTable()}
  `;

  document.getElementById('sendBtn').onclick =
    () => handleSubmit(document.getElementById('counter').value);

  document.getElementById('acceptBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: true
    });
    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });
    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;
    viewThink(() => viewFinish(true));
  };
}

function handleSubmit(raw){
  const num = Math.round(Number(raw));
  if (!Number.isFinite(num) || num < 0)
    return viewNegotiate('Bitte gültige Zahl.');

  const prevOffer = state.current_offer;
  const f = state.scale_factor;
  const extremeThreshold = 1500 * f;

  if (shouldAutoAccept(state.initial_offer, state.min_price, prevOffer, num)) {
    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true
    });
    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
      finished: true,
      deal_price: num
    });
    state.accepted = true;
    state.finished = true;
    state.deal_price = num;
    return viewThink(() => viewFinish(true));
  }

  if (num < extremeThreshold) {
    state.last_abort_chance = 100;
    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false
    });
    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false,
      finished: true,
      deal_price: ''
    });
    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';
    return viewAbort(100);
  }

  if (maybeAbort(num)) return;

  const next = computeNextOffer(prevOffer, state.min_price);
  const concession = prevOffer - next;

  logRound({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false,
    finished: false,
    deal_price: ''
  });

  state.history.push({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false
  });

  updatePatternMessage();

  state.current_offer = next;
  state.last_concession = concession;

  if (state.runde >= state.max_runden) {
    state.finished = true;
    state.finish_reason = 'max_rounds';
    return viewThink(() => viewDecision());
  }

  state.runde++;
  return viewThink(() => viewNegotiate());
}

function viewDecision(){
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p>Letztes Angebot: ${eur(state.current_offer)}</p>

    <button id="takeBtn">Annehmen</button>
    <button id="noBtn" class="ghost">Ablehnen</button>

    ${historyTable()}
  `;

  document.getElementById('takeBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:true
    });
    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });
    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;
    viewThink(() => viewFinish(true));
  };

  document.getElementById('noBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:false
    });
    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: false,
      finished: true,
      deal_price: ''
    });
    state.finished = false;
    state.finish_reason = 'max_rounds';
    viewThink(() => viewFinish(false));
  };
}

function viewFinish(accepted){
  const dealPrice = state.deal_price ?? state.current_offer;

  let text =
    accepted
      ? `Einigung bei ${eur(dealPrice)}.`
      : state.finish_reason === 'abort'
        ? `Verhandlung abgebrochen.`
        : `Maximale Runden erreicht.`;

  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p>${text}</p>

    ${historyTable()}

    <button id="restartBtn">Neu starten</button>
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };
}

viewVignette();
