(() => {
  'use strict';
  const STORE = 'jury.host.v1';
  const stage = document.getElementById('stage');
  const controls = document.getElementById('controls');
  const conn = document.getElementById('conn');
  const toastEl = document.getElementById('toast');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let ws = null;
  let state = null;
  let screenKey = null;
  let controlsHTML = '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (n, t) => (t ? Math.round((n * 100) / t) : 0);
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } };
  const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch {} };
  const clear = () => { try { localStorage.removeItem(STORE); } catch {} };
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

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
      const s = load();
      if (s && s.code && s.hostToken) send({ type: 'host:resume', code: s.code, hostToken: s.hostToken });
      else showCreate();
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'host:created') save({ code: m.code, hostToken: m.hostToken });
      else if (m.type === 'host:gone') { clear(); state = null; showCreate(); }
      else if (m.type === 'host:state') { state = m; render(); }
      else if (m.type === 'error') toast(m.message);
    };
    ws.onclose = () => {
      conn.classList.add('show');
      setTimeout(connect, 1500);
    };
  }

  /* ---------- Effects ---------- */
  function countUp(el, to) {
    if (reduceMotion || !to) { el.textContent = to; return; }
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 1500);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function animateBars(root) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.querySelectorAll('.bar-fill').forEach((b) => { b.style.width = b.dataset.pct + '%'; });
      root.querySelectorAll('[data-count]').forEach((el) => countUp(el, Number(el.dataset.count)));
    }));
  }

  /* ---------- Building blocks ---------- */
  const caseTitle = () => state.config.caseTitle || 'State v. Tom Robinson';
  const voteCfg = (r) => (state.config.votes && state.config.votes[r - 1]) || { title: `Vote ${r}`, prompt: '' };

  function bar(label, cls, n, p) {
    return `<div class="bar-row">
      <div class="bar-label">${label}</div>
      <div class="bar-track"><div class="bar-fill ${cls}" data-pct="${p}"></div></div>
      <div class="bar-value"><span data-count="${n}">0</span><span class="pct">${p}%</span></div>
    </div>`;
  }
  function barsHTML(t, compact) {
    t = t || { guilty: 0, notGuilty: 0, total: 0 };
    return `<div class="bars ${compact ? 'compact' : ''}">
      ${bar('Guilty', 'guilty', t.guilty, pct(t.guilty, t.total))}
      ${bar('Not Guilty', 'not', t.notGuilty, pct(t.notGuilty, t.total))}
    </div>`;
  }
  const note = (text) => `<div class="record-note"><span class="rn-label">RECORD NOTE:</span>${esc(text)}</div>`;

  /* ---------- Screens ---------- */
  function showCreate() {
    screenKey = 'create';
    qrShown = false;
    renderQR();
    controls.innerHTML = controlsHTML = '';
    stage.innerHTML = `<section class="screen create">
      <h1 class="heading"><span>State v. Tom Robinson</span></h1>
      <hr class="rule double">
      <button class="btn primary huge" id="create">Create Room</button>
    </section>`;
    document.getElementById('create').onclick = () => send({ type: 'host:create' });
  }

  function lobbyScreen() {
    return `<section class="screen lobby">
      <h1 class="heading"><span>Investigation Report — ${esc(caseTitle())}</span></h1>
      <hr class="rule">
      <h2 class="heading-sm">Jurors <span class="count-tag" id="jcount">0</span></h2>
      <ul class="juror-list" id="jurors"></ul>
      ${note('Waiting for the court to convene.')}
    </section>`;
  }

  /* ---------- QR code (shown only when the host chooses) ---------- */
  let qrShown = false;
  const qrOverlay = document.getElementById('qr-overlay');
  function renderQR() {
    if (!state || !qrShown) { qrOverlay.hidden = true; qrOverlay.innerHTML = ''; return; }
    if (qrOverlay.dataset.code !== state.code || qrOverlay.hidden) {
      qrOverlay.dataset.code = state.code;
      qrOverlay.innerHTML = `<div class="join-panel">
        <div class="kicker">Scan to join the jury</div>
        <img class="qr" alt="QR code to join" src="/qr.svg?code=${encodeURIComponent(state.code)}">
        <div class="join-url">or go to <b>${esc(state.joinBase.replace(/^https?:\/\//, ''))}</b> · code <b>${esc(state.code)}</b></div>
      </div>`;
      qrOverlay.hidden = false;
    }
  }

  function voteScreen(r) {
    const v = voteCfg(r);
    return `<section class="screen vote">
      <div class="kicker">${esc(v.title)}</div>
      <h1 class="heading"><span>${esc(v.prompt)}</span></h1>
      <hr class="rule">
      <div class="counter"><b id="voted">0</b> of <span id="total">0</span> jurors have voted</div>
      <div class="progress"><div class="progress-fill" id="progress"></div></div>
      <ul class="juror-list" id="jurors"></ul>
    </section>`;
  }

  function resultsScreen(r) {
    const v = voteCfg(r);
    if (!state.revealed[r]) {
      return `<section class="screen results">
        <div class="kicker">${esc(v.title)}</div>
        <h1 class="heading"><span>Vote ${r} is closed</span></h1>
        <hr class="rule">
        ${note(`${state.closedCount[r]} of ${state.players.length} jurors voted. The results are sealed.`)}
      </section>`;
    }
    const t = state.results[r] || { guilty: 0, notGuilty: 0, total: 0 };
    return `<section class="screen results">
      <div class="kicker">${esc(v.title)}</div>
      <h1 class="heading"><span>Vote ${r} — Results</span></h1>
      <p class="sub">“${esc(v.prompt)}”</p>
      <hr class="rule">
      ${barsHTML(t)}
      ${note(`${t.total} of ${state.players.length} jurors voted.`)}
    </section>`;
  }

  function finalScreen() {
    const f = state.final;
    const c = f.changes;
    const p = f.participation;
    const verdictText = { guilty: 'Guilty', notGuilty: 'Not Guilty' }[f.verdict];
    const row = (label, n) => `<tr><td>${label}</td><td class="n">${n}</td></tr>`;
    return `<section class="screen final">
      <h1 class="heading"><span>Final Verdict — ${esc(caseTitle())}</span></h1>
      <hr class="rule">
      <div class="final-grid">
        <div class="panel"><h2 class="heading-sm">${esc(voteCfg(1).title)}</h2>${barsHTML(state.results[1], true)}</div>
        <div class="panel" style="animation-delay:.15s"><h2 class="heading-sm">${esc(voteCfg(2).title)}</h2>${barsHTML(state.results[2], true)}</div>
      </div>
      <div class="final-grid">
        <div class="panel" style="animation-delay:.3s">
          <h2 class="heading-sm">Changes of mind</h2>
          <table class="ledger">
            ${row('Guilty → Not Guilty', c.guiltyToNot)}
            ${row('Not Guilty → Guilty', c.notToGuilty)}
            ${row('Unchanged', c.unchanged)}
            ${row('Did not vote', c.didNotVote)}
          </table>
        </div>
        <div class="panel" style="animation-delay:.45s">
          <h2 class="heading-sm">Participation</h2>
          <table class="ledger">
            ${row('Jurors joined', p.joined)}
            ${row('Voted in Vote 1', `${p.voted1} / ${p.joined}`)}
            ${row('Voted in Vote 2', `${p.voted2} / ${p.joined}`)}
          </table>
        </div>
      </div>
      ${verdictText ? `<div class="verdict-wrap">
        <div class="verdict-line">The jury has reached a verdict:</div>
        <div class="verdict-stamp v-${f.verdict}">${verdictText}</div>
      </div>` : ''}
    </section>`;
  }

  /* ---------- Render ---------- */
  function render() {
    document.getElementById('case-title').textContent = caseTitle();
    const key = `${state.code}:${state.phase}:${state.revealed[1]}:${state.revealed[2]}`;
    if (key !== screenKey) {
      screenKey = key;
      const p = state.phase;
      stage.innerHTML =
        p === 'lobby' ? lobbyScreen()
        : p === 'vote1' ? voteScreen(1)
        : p === 'vote2' ? voteScreen(2)
        : p === 'closed1' ? resultsScreen(1)
        : p === 'closed2' ? resultsScreen(2)
        : finalScreen();
      window.scrollTo(0, 0);
      animateBars(stage);
    }
    updateLive();
    renderControls();
    renderQR();
  }

  function updateLive() {
    const r = state.openRound;
    const list = document.getElementById('jurors');
    if (list) {
      list.innerHTML = state.players.length
        ? state.players.map((p) => `<li class="juror ${p.connected ? '' : 'away'} ${r && p.voted[r] ? 'voted' : ''}">No. ${esc(p.number)}</li>`).join('')
        : '<li class="empty">No jurors yet.</li>';
    }
    const jc = document.getElementById('jcount');
    if (jc) jc.textContent = state.players.length;
    const voted = document.getElementById('voted');
    if (voted) {
      voted.textContent = state.votedCount;
      document.getElementById('total').textContent = state.players.length;
      document.getElementById('progress').style.width = pct(state.votedCount, state.players.length) + '%';
    }
  }

  function nextStep() {
    const s = state;
    switch (s.phase) {
      case 'lobby': return ['Open Vote 1', 'open1'];
      case 'vote1': return ['Close Vote 1', 'close'];
      case 'closed1': return s.revealed[1] ? ['Open Vote 2', 'open2'] : ['Show Vote 1 Results', 'reveal'];
      case 'vote2': return ['Close Vote 2', 'close'];
      case 'closed2': return s.revealed[2] ? ['Show Final Verdict', 'final'] : ['Show Vote 2 Results', 'reveal'];
      default: return null;
    }
  }
  // While a vote's results are still hidden, the host can move on without showing them.
  function skipStep() {
    const s = state;
    if (s.phase === 'closed1' && !s.revealed[1]) return ['Skip results → Open Vote 2', 'open2'];
    if (s.phase === 'closed2' && !s.revealed[2]) return ['Skip results → Final Verdict', 'final'];
    return null;
  }
  function renderControls() {
    const next = nextStep();
    const skip = skipStep();
    const html = `
      <div class="ctl-side">
        <button class="btn" data-action="qr">${qrShown ? 'Hide QR code' : 'Show QR code'}</button>
        <span class="ctl-info">Code <b>${esc(state.code)}</b></span>
      </div>
      <div class="ctl-main">${next ? `<button class="btn primary" data-action="${next[1]}">${next[0]}</button>` : ''}${skip ? `<button class="btn" data-action="${skip[1]}">${skip[0]}</button>` : ''}</div>
      <div class="ctl-side"><button class="btn danger" data-action="reset">Reset session</button></div>`;
    if (html !== controlsHTML) controls.innerHTML = controlsHTML = html;
  }

  controls.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'qr') { qrShown = !qrShown; renderControls(); renderQR(); return; }
    if (action === 'reset' && !confirm('Reset the session? All votes will be cleared.')) return;
    send({ type: 'host:action', action });
  });

  connect();
})();
