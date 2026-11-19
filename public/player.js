(() => {
  'use strict';
  const STORE = 'jury.player.v1';
  const app = document.getElementById('app');
  const conn = document.getElementById('conn');
  const toastEl = document.getElementById('toast');
  const params = new URLSearchParams(location.search);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let ws = null;
  let saved = load(); // { code, token, number }
  let state = null;
  let key = null;
  let joined = false;
  let lastAttempt = null;

  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || null; } catch { return null; } }
  function store(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch {} }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const label = (v) => (v === 'guilty' ? 'Guilty' : v === 'notGuilty' ? 'Not Guilty' : '—');

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.classList.remove('show'), 3000);
  }

  /* ---------- Connection ---------- */
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      conn.classList.remove('show');
      const urlCode = (params.get('code') || '').toUpperCase();
      const sameRoom = saved && saved.token && (!urlCode || urlCode === saved.code);
      if (sameRoom) {
        // Refresh / reconnect: same anonymous juror, same ballots.
        send({ type: 'player:join', code: saved.code, token: saved.token });
      } else if (urlCode && key !== 'join') {
        // Scanned the QR code: join straight away, no typing needed.
        showJoining();
        send({ type: 'player:join', code: urlCode });
      } else if (key !== 'join') {
        showJoin();
      }
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'player:joined') {
        joined = true;
        saved = { code: m.code, token: m.token, number: m.number };
        store(saved);
      } else if (m.type === 'player:state') {
        joined = true;
        state = m;
        render();
      } else if (m.type === 'error') {
        if (!joined) {
          if (saved && saved.token) { saved = { code: saved.code }; store(saved); }
          showJoin(m.message);
        } else {
          toast(m.message);
          key = null; // re-enable the screen (e.g. after a rejected ballot)
          if (state) render();
        }
      }
    };
    ws.onclose = () => {
      conn.classList.add('show');
      joined = false;
      setTimeout(connect, 1500);
    };
  }

  /* ---------- Effects ---------- */

  /* ---------- Screens ---------- */
  function showJoining() {
    key = 'joining';
    app.innerHTML = `<section class="screen waiting"><div class="seal" aria-hidden="true">⚖</div><h1 class="heading">Joining the jury…</h1></section>`;
  }

  // Fallback only: shown when there is no code in the link or the code didn't work.
  function showJoin(error) {
    key = 'join';
    const code = lastAttempt || '';
    app.innerHTML = `<section class="screen join">
      <h1 class="heading">Join the Jury</h1>
      <hr class="rule">
      <form id="join-form" autocomplete="off">
        <label>Room code
          <input id="code" maxlength="6" inputmode="numeric" spellcheck="false" required value="${esc(code)}">
        </label>
        <button class="btn primary big" type="submit" id="join-btn">Join</button>
        <p class="form-error">${esc(error || '')}</p>
      </form>
    </section>`;
    const codeEl = document.getElementById('code');
    codeEl.focus();
    document.getElementById('join-form').onsubmit = (e) => {
      e.preventDefault();
      lastAttempt = codeEl.value.trim().toUpperCase();
      if (!lastAttempt) return;
      document.getElementById('join-btn').disabled = true;
      send({ type: 'player:join', code: lastAttempt });
    };
  }

  function badge() {
    return `<div class="badge"><span>Juror <b>No. ${esc(state.number)}</b></span></div>`;
  }

  function waitingScreen(title, text, icon = '⚖') {
    return `<section class="screen waiting">
      <div class="seal" aria-hidden="true">${icon}</div>
      <h1 class="heading"><span>${esc(title)}</span></h1>
      <p>${text}</p>
    </section>`;
  }

  function render() {
    const s = state;
    const r = s.openRound;
    const mine = r ? s.myVotes[r] : null;
    const k = [s.phase, r, mine, s.myVotes[1], s.myVotes[2]].join('|');
    if (k !== key) {
      key = k;
      lastAttempt = null;
      let body;
      if (r && !mine) {
        body = `<section class="screen vote-phone">
          <div class="kicker">${esc(s.voteTitle)}</div>
          <h1 class="question"><span>${esc(s.prompt)}</span></h1>
          <div class="vote-buttons">
            <button class="vote-btn guilty" data-choice="guilty">Guilty</button>
            <button class="vote-btn not" data-choice="notGuilty">Not Guilty</button>
          </div>
          <p class="fine">Your ballot is final and cannot be changed.</p>
        </section>`;
      } else if (r && mine) {
        body = `<section class="screen waiting">
          <div class="kicker">${esc(s.voteTitle)}</div>
          <h1 class="heading" style="margin-top:.6rem">Ballot recorded</h1>
          <div class="verdict-stamp small v-${mine}">${label(mine)}</div>
          <p><b id="pc">${s.votedCount}</b> of <span id="pt">${s.jurorCount}</span> jurors have voted.<br>Awaiting the remaining jurors…</p>
        </section>`;
      } else if (s.phase === 'lobby') {
        body = waitingScreen('Waiting for the court to convene', 'Keep this screen open.');
      } else if (s.phase === 'closed1' || s.phase === 'closed2') {
        body = waitingScreen('Voting is closed', 'Look at the main screen.');
      } else if (s.phase === 'final' && s.verdict) {
        const text = { guilty: 'Guilty', notGuilty: 'Not Guilty' }[s.verdict];
        body = `<section class="screen waiting">
          <div class="kicker">The verdict</div>
          <h1 class="heading" style="margin-top:.6rem">The jury has reached a verdict</h1>
          <div class="verdict-stamp small v-${s.verdict}" style="animation-delay:.4s">${text}</div>
        </section>`;
      } else if (s.phase === 'final') {
        body = waitingScreen('Voting is closed', 'Look at the main screen.');
      } else {
        body = waitingScreen('Please wait', 'The court will be with you shortly.');
      }
      app.innerHTML = badge() + body;
      wire();
    }
    const pc = document.getElementById('pc');
    if (pc) { pc.textContent = s.votedCount; document.getElementById('pt').textContent = s.jurorCount; }
  }

  function wire() {
    app.querySelectorAll('.vote-btn').forEach((b) => {
      b.onclick = () => {
        app.querySelectorAll('.vote-btn').forEach((x) => (x.disabled = true));
        b.classList.add('chosen');
        send({ type: 'player:vote', round: state.openRound, choice: b.dataset.choice });
      };
    });
  }

  connect();
})();
