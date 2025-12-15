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
const EXTREME_BASE       = 1500;
const ABSOLUTE_FLOOR     = 3500;
const BASE_INITIAL_OFFER = CONFIG.INITIAL_OFFER;
const BASE_MIN_PRICE     = CONFIG.MIN_PRICE;
const BASE_STEP_AMOUNT   = 500;

/* Multiplikator: reelle Zahl in [1, 5] */
function nextDimensionFactor() {
  return 1 + Math.random() * 4; // 1.0–5.0
}

/* ========================================================================== */
/* Hilfsfunktionen                                                            */
/* ========================================================================== */
const app = document.getElementById('app');
const randInt = (a,b) => Math.floor(a + Math.random()*(b-a+1));
const eur = n => new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR' }).format(n);

/* ========================================================================== */
/* Zustand                                                                    */
/* ========================================================================== */
function newState(){
  const factor       = nextDimensionFactor();
  const initialOffer = Math.round(BASE_INITIAL_OFFER * factor);
  const floorRounded = Math.round(ABSOLUTE_FLOOR     * factor);
  const stepAmount   = BASE_STEP_AMOUNT * factor;

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
    deal_price: null,
    finish_reason: null,

    patternMessage: '',
    warningRounds: 0,          // wie viele Runden in Folge das Klein-Schritt-Muster aktiv ist
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
/* Auto-Accept – Verhandlungsstil unverändert                                 */
/* ========================================================================== */
function shouldAutoAccept(initialOffer, minPrice, prevOffer, counter){
  const c = Number(counter);
  if (!Number.isFinite(c)) return false;

  const f = state.scale_factor || 1.0;

  const diff = Math.abs(prevOffer - c);
  if (diff <= prevOffer * 0.05) return true;

  const accMin = CONFIG.ACCEPT_RANGE_MIN * f;
  const accMax = CONFIG.ACCEPT_RANGE_MAX * f;
  if (c >= accMin && c <= accMax) return true;

  const margin    = CONFIG.ACCEPT_MARGIN;
  const threshold = Math.max(minPrice, initialOffer * (1 - margin));
  return c >= threshold;
}

/* ========================================================================== */
/* Abbruchwahrscheinlichkeit: Diff 3000 × f → 30 %                            */
/* ========================================================================== */
function abortProbability(userOffer) {
  const seller = state.current_offer;
  const buyer  = Number(userOffer);
  const f      = state.scale_factor || 1.0;

  const diff     = Math.abs(seller - buyer);
  const BASE_DIFF = 3000 * f;        // bei dieser Differenz sollen 30 % entstehen

  let chance = (diff / BASE_DIFF) * 30;

  if (chance < 0)   chance = 0;
  if (chance > 100) chance = 100;

  return Math.round(chance);
}

/* ========================================================================== */
/* Mustererkennung: gleiche / kleine Schritte (< 100 × f)                     */
/* ========================================================================== */
/* Warnung nach 2 aufeinanderfolgenden Runden mit:
   - gleichem Angebot oder
   - Steigerung < 100 × Multiplikator.
   Dann warningRounds++ pro Runde, solange dieses Muster anhält */
function updatePatternMessage(currentBuyerOffer){
  const f    = state.scale_factor || 1.0;
  const last = state.history[state.history.length - 1];

  let smallStep = false;

  if (last && last.proband_counter != null && last.proband_counter !== '') {
    const lastBuyer = Number(last.proband_counter);
    if (Number.isFinite(lastBuyer)) {
      const diff = Number(currentBuyerOffer) - lastBuyer;
      if (diff >= 0 && diff < 100 * f) {
        // keine Veränderung oder Steigerung < 100 × Multiplikator
        smallStep = true;
      }
    }
  }

  if (smallStep) {
    state.warningRounds = (state.warningRounds || 0) + 1;
  } else {
    state.warningRounds = 0;
    state.patternMessage = '';
    return;
  }

  if (state.warningRounds >= 2) {
    state.patternMessage =
      'Mit derart kleinen Erhöhungen kommen wir eher unwahrscheinlich zu einer Einigung.';
  } else {
    state.patternMessage = '';
  }
}

/* ========================================================================== */
/* maybeAbort                                                                 */
/* ========================================================================== */
function maybeAbort(userOffer) {
  const buyer = Number(userOffer);
  const f     = state.scale_factor || 1.0;

  // Basiswahrscheinlichkeit über Differenz
  let chance = abortProbability(userOffer);

  // Aufschlag durch Warnhinweis:
  // Wenn Warnung aktiv (warningRounds ≥ 2), +2 %-Punkte pro Warnrunde,
  // beginnend ab dem ersten Warn-Aufploppen.
  if (state.warningRounds && state.warningRounds >= 2) {
    const extra = (state.warningRounds - 1) * 2;  // 2 %, 4 %, 6 %, ...
    chance = Math.min(100, chance + extra);
  }

  // Vor Runde 4: Nur Anzeige, kein Abbruch
  if (state.runde < 4) {
    state.last_abort_chance = chance;
    return false;
  }

  // Ab Runde 4: Extrem-Lowball → immer Abbruch
  if (buyer < EXTREME_BASE * f) {
    chance = 100;
  }

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
/* Angebotslogik – Verhandlungsstil unverändert, aber nie unter Spielerangebot*/
/* ========================================================================== */
function computeNextOffer(prevOffer, minPrice, probandCounter, runde, lastConcession){
  const prev   = Number(prevOffer);
  const floor  = Number(minPrice);
  const step   = Number(state.step_amount || BASE_STEP_AMOUNT);
  const buyer  = Number(probandCounter);

  // Basis: Verkäufer geht um step nach unten, aber nicht unter min_price
  let candidate = prev - step;
  candidate = Math.max(floor, Math.min(candidate, prev));

  // Verkäufer soll nicht UNTER dem Gegenangebot liegen,
  // geht aber nie über sein letztes eigenes Angebot hinaus.
  if (Number.isFinite(buyer) && candidate < buyer) {
    candidate = Math.min(prev, buyer);
  }

  return candidate;
}

/* ========================================================================== */
/* Rendering                                                                  */
/* ========================================================================== */

function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>
      Ein Verkäufer bietet eine <b>hochwertige Designer-Ledercouch</b> auf einer Möbelmesse an.
      Solche Möbel werden üblicherweise im <b>gehobenen Preissegment €</b> gehandelt, da sie aus wertvollem 
      Material bestehen und in der Regel Einzelstücke sind. Den Rahmen des Preises siehst du in der Verhandlung. 
    </p>
    <p>
      Du verhandelst mit dem Verkäufer über den endgültigen Verkaufspreis. 
    </p>
    <p class="muted"> 
      <b>Hinweis:</b> Die Verhandlung dauert zufällig ${CONFIG.ROUNDS_MIN}–${CONFIG.ROUNDS_MAX} Runden.
      Dein Verhalten beeinflusst das <b>Abbruchrisiko</b>: unangemessen niedrige oder kaum veränderte
      Angebote können zu einem vorzeitigen Abbruch führen.
    </p>
    <div class="grid">
      <label class="consent">
        <input id="consent" type="checkbox" />
        <span>Ich stimme zu, dass meine Eingaben anonym gespeichert werden.</span>
      </label>
      <div><button id="startBtn" disabled>Verhandlung starten</button></div>
    </div>`;

  const consent = document.getElementById('consent');
  const startBtn = document.getElementById('startBtn');
  consent.onchange = () => startBtn.disabled = !consent.checked;
  startBtn.onclick = () => { state = newState(); viewNegotiate(); };
}

function viewThink(next){
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">…</span></h1>
    <p class="muted">Bitte warten.</p>`;
  setTimeout(next, delay);
}

function historyTable(){
  if (!state.history.length) return '';
  const rows = state.history.map(h => `
    <tr>
      <td>${h.runde}</td>
      <td>${eur(h.algo_offer)}</td>
      <td>${h.proband_counter != null && h.proband_counter !== '' ? eur(h.proband_counter) : '-'}</td>
      <td>${h.accepted ? 'Ja' : 'Nein'}</td>
    </tr>`).join('');
  return `
    <h2>Verlauf</h2>
    <table>
      <thead><tr><th>Runde</th><th>Angebot Verkäufer</th><th>Gegenangebot</th><th>Angenommen?</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function viewAbort(chance){
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>
    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Die Verkäuferseite hat die Verhandlung beendet, da er mit Ihrem Gegenangebot nicht zufrieden war.</strong>
      <p class="muted" style="margin-top:8px;">Abbruchwahrscheinlichkeit in dieser Runde: ${chance}%</p>
    </div>

    <p class="muted"><b>Du kannst nun entweder eine neue Verhandlungsrunde starten oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById('surveyBtn');
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        'https://docs.google.com/forms/d/e/1FAIpQLSer5kQ5ew47-cZQ6Kg0DQDITEgzfN9CNoCPon8htZnBCocjLw/viewform?usp=publish-editor';
    };
  }
}

/* ========================================================================== */
/* Hauptscreen der Verhandlung                                                */
/* ========================================================================== */
function viewNegotiate(errorMsg){
  const abortChance = (typeof state.last_abort_chance === 'number')
    ? state.last_abort_chance
    : null;

  // Farbskala: <20 % grün, 20–40 % orange, >40 % rot
  let color = '#16a34a'; // grün
  if (abortChance !== null) {
    if (abortChance > 40)      color = '#dc2626'; // rot
    else if (abortChance >=20) color = '#ea580c'; // orange
  }

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Spieler-ID: ${window.playerId ?? '-'}</p>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>
    <div class="grid">
      <div class="card" style="padding:16px;border:1px dashed var(--accent);">
        <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
      </div>

      <div style="
        background:${color}22;
        border-left:6px solid ${color};
        padding:10px;
        border-radius:8px;
        margin-bottom:10px;">
        <b style="color:${color};">Abbruchwahrscheinlichkeit:</b>
        <span style="color:${color}; font-weight:600;">
          ${abortChance !== null ? abortChance + '%' : '--'}
        </span>
      </div>

      ${state.patternMessage ? `<p class="info">${state.patternMessage}</p>` : ''}

      <label for="counter">Dein Gegenangebot (€)</label>
      <div class="row">
        <input id="counter" type="number" step="1" min="0" />
        <button id="sendBtn">Gegenangebot senden</button>
      </div>

      <button id="acceptBtn" class="ghost">Angebot annehmen</button>
    </div>

    ${historyTable()}
    ${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}
  `;

  const inputEl = document.getElementById('counter');
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.onclick = () => handleSubmit(inputEl.value);
  inputEl.onkeydown = e => { if (e.key === "Enter") handleSubmit(inputEl.value); };

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

/* ========================================================================== */
/* Handle Submit                                                              */
/* ========================================================================== */
function handleSubmit(raw){
  const val    = String(raw ?? '').trim().replace(',','.');
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || parsed < 0){
    return viewNegotiate('Bitte eine gültige Zahl ≥ 0 eingeben.');
  }

  const num       = Math.round(parsed);
  const prevOffer = state.current_offer;

  // kein niedrigeres Gegenangebot als in der Vorrunde
  const last = state.history[state.history.length - 1];
  if (last && last.proband_counter != null && last.proband_counter !== '') {
    const lastBuyer = Number(last.proband_counter);
    if (Number.isFinite(lastBuyer) && num < lastBuyer) {
      return viewNegotiate(
        `Dein Gegenangebot darf nicht niedriger sein als in der Vorrunde (${eur(lastBuyer)}).`
      );
    }
  }

  /* Auto-Accept – unverändert */
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

    state.accepted   = true;
    state.finished   = true;
    state.deal_price = num;
    return viewThink(() => viewFinish(true));
  }

  // Warnhinweis / Patternzustand vor der Abbruchentscheidung aktualisieren
  updatePatternMessage(num);

  // Abbruchentscheidung (inkl. +2 %-Punkte je Warnrunde, ab Runde 4)
  if (maybeAbort(num)) {
    return;
  }

  // Normale Verhandlungsrunde
  const next       = computeNextOffer(prevOffer, state.min_price, num, state.runde, state.last_concession);
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

  state.current_offer   = next;
  state.last_concession = concession;

  if (state.runde >= state.max_runden) {
    state.finished      = true;
    state.finish_reason = 'max_rounds';
    return viewThink(() => viewDecision());
  }

  state.runde++;
  return viewThink(() => viewNegotiate());
}

/* ========================================================================== */
/* Entscheidung – letzte Runde                                                */
/* ========================================================================== */
function viewDecision(){
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Letztes Angebot:</strong> ${eur(state.current_offer)}</strong>
    </div>

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

    state.accepted   = true;
    state.finished   = true;
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

    state.accepted      = false;
    state.finished      = true;
    state.finish_reason = 'max_rounds';
    viewThink(() => viewFinish(false));
  };
}

/* ========================================================================== */
/* Finish                                                                     */
/* ========================================================================== */
function viewFinish(accepted){
  const dealPrice = state.deal_price ?? state.current_offer;

  let text;
  if (accepted) {
    text = `Einigung in Runde ${state.runde} bei ${eur(dealPrice)}.`;
  } else if (state.finish_reason === 'abort') {
    text = `Verhandlung vom Verkäufer abgebrochen.`;
  } else {
    text = `Maximale Runden erreicht.`;
  }

  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Ergebnis:</strong> ${text}</strong>
    </div>

    <p class="muted"><b>Du kannst nun entweder eine neue Verhandlungsrunde starten oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById('surveyBtn');
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        'https://docs.google.com/forms/d/e/1FAIpQLSer5kQ5ew47-cZQ6Kg0DQDITEgzfN9CNoCPon8htZnBCocjLw/viewform?usp=publish-editor';
    };
  }
}

/* ========================================================================== */
/* Start                                                                      */
/* ========================================================================== */
viewVignette();
