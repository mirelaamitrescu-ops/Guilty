'use strict';
/**
 * State v. Tom Robinson — live jury voting server.
 * Express serves the pages; a WebSocket at /ws carries all live traffic.
 * All state lives in memory. The server is the source of truth.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const CONFIG_PATH = path.join(__dirname, 'questions.json');
const PHASES = ['lobby', 'vote1', 'closed1', 'vote2', 'closed2', 'final'];
const CHOICES = ['guilty', 'notGuilty'];

/* ---------- Config (re-read automatically when questions.json changes) ---------- */
let config = null;
let configMtime = 0;
function getConfig() {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
    if (!config || mtime !== configMtime) {
      const next = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      next.votes = next.votes || [];
      config = next;
      configMtime = mtime;
    }
  } catch (err) {
    console.error(`! Could not read questions.json: ${err.message}`);
    if (!config) throw err;
  }
  return config;
}

/* ---------- Network helpers ---------- */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      // Skip link-local 169.254.x.x addresses (unconnected adapters) — phones can't reach them.
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}
const LAN_ALL = lanAddresses();
const LAN_IP =
  LAN_ALL.find((a) => a.startsWith('192.168.')) ||
  LAN_ALL.find((a) => a.startsWith('10.')) ||
  LAN_ALL[0] ||
  null;
const lanBase = () => `http://${LAN_IP || 'localhost'}:${PORT}`;

// Where phones should go. On a live service the public address is used:
//  1. PUBLIC_URL if you set it, or RENDER_EXTERNAL_URL (Render sets this automatically);
//  2. otherwise the address the host screen was opened with (works on any hosting service);
//  3. if the host screen is on localhost, this computer's Wi-Fi address instead.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const LOCAL_HOSTNAME = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
function baseFromRequest(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostname = hostHeader.replace(/:\d+$/, '');
  if (!hostHeader || LOCAL_HOSTNAME.test(hostname)) return lanBase();
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${hostHeader}`;
}
const joinUrl = (base, code) => `${base}/?code=${encodeURIComponent(code)}`;

/* ---------- Rooms ---------- */
const rooms = new Map();
const ROOM_CODE = '1234'; // the room code is always 1234
const newToken = () => crypto.randomBytes(16).toString('hex');
function createRoom() {
  // There is only ever one room (code 1234). If it already exists, the host screen
  // simply opens it — jurors and votes are kept. Use "Reset session" to start over.
  if (rooms.has(ROOM_CODE)) return rooms.get(ROOM_CODE);
  const room = {
    code: ROOM_CODE,
    hostToken: newToken(),
    phase: 'lobby',
    revealed: { 1: false, 2: false }, // results stay hidden until the host shows them
    players: new Map(), // token -> { token, number, votes: {1,2}, sockets:Set }
    hosts: new Set(),
  };
  rooms.set(room.code, room);
  return room;
}
// Anonymous jurors: each gets a random, unused juror number (1–99, more if the room is huge).
function randomJurorNumber(room) {
  const used = new Set([...room.players.values()].map((p) => p.number));
  const max = Math.max(99, used.size * 2);
  let n;
  do n = 1 + crypto.randomInt(max); while (used.has(n));
  return n;
}
const phaseIdx = (p) => PHASES.indexOf(p);
const openRound = (room) => (room.phase === 'vote1' ? 1 : room.phase === 'vote2' ? 2 : null);

function tally(room, r) {
  let guilty = 0;
  let notGuilty = 0;
  for (const p of room.players.values()) {
    if (p.votes[r] === 'guilty') guilty++;
    else if (p.votes[r] === 'notGuilty') notGuilty++;
  }
  return { guilty, notGuilty, total: guilty + notGuilty };
}
function verdictOf(t) {
  if (!t.total || t.guilty === t.notGuilty) return null; // tie: no verdict is shown
  return t.guilty > t.notGuilty ? 'guilty' : 'notGuilty';
}
function finalStats(room) {
  const c = { guiltyToNot: 0, notToGuilty: 0, unchanged: 0, didNotVote: 0 };
  for (const p of room.players.values()) {
    const v1 = p.votes[1];
    const v2 = p.votes[2];
    if (!v1 || !v2) c.didNotVote++;
    else if (v1 === v2) c.unchanged++;
    else v1 === 'guilty' ? c.guiltyToNot++ : c.notToGuilty++;
  }
  const t1 = tally(room, 1);
  const t2 = tally(room, 2);
  return {
    changes: c,
    participation: { joined: room.players.size, voted1: t1.total, voted2: t2.total },
    verdict: verdictOf(t2),
  };
}

function hostState(room) {
  const cfg = getConfig();
  const r = openRound(room);
  const i = phaseIdx(room.phase);
  const isFinal = room.phase === 'final';
  return {
    type: 'host:state',
    code: room.code,
    joinBase: room.joinBase || lanBase(),
    joinUrl: joinUrl(room.joinBase || lanBase(), room.code),
    phase: room.phase,
    openRound: r,
    config: cfg,
    players: [...room.players.values()]
      .map((p) => ({
        number: p.number,
        connected: p.sockets.size > 0,
        voted: { 1: !!p.votes[1], 2: !!p.votes[2] },
      }))
      .sort((a, b) => a.number - b.number),
    votedCount: r ? tally(room, r).total : 0,
    closedCount: { 1: tally(room, 1).total, 2: tally(room, 2).total },
    revealed: room.revealed,
    // Tallies are only sent once a round is closed AND the host has chosen to show them.
    results: {
      1: i > phaseIdx('vote1') && (room.revealed[1] || isFinal) ? tally(room, 1) : null,
      2: i > phaseIdx('vote2') && (room.revealed[2] || isFinal) ? tally(room, 2) : null,
    },
    final: room.phase === 'final' ? finalStats(room) : null,
  };
}

function playerState(room, p) {
  const cfg = getConfig();
  const r = openRound(room);
  return {
    type: 'player:state',
    code: room.code,
    number: p.number,
    phase: room.phase,
    openRound: r,
    prompt: r ? (cfg.votes[r - 1] || {}).prompt || '' : null,
    voteTitle: r ? (cfg.votes[r - 1] || {}).title || `Vote ${r}` : null,
    myVotes: { 1: p.votes[1], 2: p.votes[2] },
    votedCount: r ? tally(room, r).total : 0,
    jurorCount: room.players.size,
    verdict: room.phase === 'final' ? verdictOf(tally(room, 2)) : null,
  };
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}
function broadcast(room) {
  const hs = JSON.stringify(hostState(room));
  for (const h of room.hosts) send(h, hs);
  for (const p of room.players.values()) {
    if (!p.sockets.size) continue;
    const ps = JSON.stringify(playerState(room, p));
    for (const s of p.sockets) send(s, ps);
  }
}

function detach(ws) {
  const room = ws.room;
  if (!room) return null;
  if (ws.role === 'host') room.hosts.delete(ws);
  if (ws.player) ws.player.sockets.delete(ws);
  ws.room = ws.player = ws.role = null;
  return room;
}
function attachHost(ws, room) {
  detach(ws);
  ws.role = 'host';
  ws.room = room;
  room.hosts.add(ws);
  room.joinBase = ws.base; // the address shown under the QR code follows the host screen
}
function attachPlayer(ws, room, p) {
  detach(ws);
  ws.role = 'player';
  ws.room = room;
  ws.player = p;
  p.sockets.add(ws);
}

function hostAction(room, action) {
  switch (action) {
    case 'open1':
      if (room.phase === 'lobby') room.phase = 'vote1';
      break;
    case 'close':
      if (room.phase === 'vote1') room.phase = 'closed1';
      else if (room.phase === 'vote2') room.phase = 'closed2';
      break;
    case 'reveal':
      if (room.phase === 'closed1') room.revealed[1] = true;
      else if (room.phase === 'closed2') room.revealed[2] = true;
      break;
    // The host may move on without showing a vote's results ("Skip results").
    case 'open2':
      if (room.phase === 'closed1') room.phase = 'vote2';
      break;
    case 'final':
      if (room.phase === 'closed2') room.phase = 'final';
      break;
    case 'reset':
      // Back to the lobby: all votes cleared; jurors still connected stay seated.
      room.phase = 'lobby';
      room.revealed = { 1: false, 2: false };
      for (const [token, p] of room.players) {
        if (!p.sockets.size) room.players.delete(token);
        else p.votes = { 1: null, 2: null };
      }
      break;
    default:
      return false;
  }
  return true;
}

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

function handle(ws, msg) {
  switch (msg.type) {
    case 'host:create': {
      const room = createRoom();
      attachHost(ws, room);
      send(ws, { type: 'host:created', code: room.code, hostToken: room.hostToken });
      console.log(`  Courtroom ${room.code} convened.`);
      broadcast(room);
      break;
    }
    case 'host:resume': {
      const room = rooms.get(cleanCode(msg.code));
      if (!room || room.hostToken !== msg.hostToken) return send(ws, { type: 'host:gone' });
      attachHost(ws, room);
      broadcast(room);
      break;
    }
    case 'host:action': {
      if (ws.role !== 'host' || !ws.room) return send(ws, { type: 'error', message: 'Not the host of a courtroom.' });
      if (hostAction(ws.room, msg.action)) broadcast(ws.room);
      break;
    }
    case 'player:join': {
      const room = rooms.get(cleanCode(msg.code));
      if (!room) return send(ws, { type: 'error', message: 'No room found with that code.' });
      let p = msg.token ? room.players.get(String(msg.token)) : null;
      if (!p) {
        p = { token: newToken(), number: randomJurorNumber(room), votes: { 1: null, 2: null }, sockets: new Set() };
        room.players.set(p.token, p);
      }
      attachPlayer(ws, room, p);
      send(ws, { type: 'player:joined', code: room.code, token: p.token, number: p.number });
      broadcast(room);
      break;
    }
    case 'player:vote': {
      const room = ws.room;
      const p = ws.player;
      if (!room || !p) return send(ws, { type: 'error', message: 'Join a courtroom first.' });
      const r = openRound(room);
      if (!r || Number(msg.round) !== r) return send(ws, { type: 'error', message: 'Voting is closed.' });
      if (!CHOICES.includes(msg.choice)) return send(ws, { type: 'error', message: 'Invalid ballot.' });
      if (p.votes[r]) return send(ws, { type: 'error', message: 'You have already voted in this round.' });
      p.votes[r] = msg.choice;
      broadcast(room);
      break;
    }
    default:
      break;
  }
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(joinUrl(baseFromRequest(req), cleanCode(req.query.code)), {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#211b15', light: '#0000' },
    });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) {
    res.status(500).send('QR error');
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  ws.base = baseFromRequest(req);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && typeof msg === 'object') handle(ws, msg);
  });
  ws.on('close', () => {
    const room = detach(ws);
    if (room) broadcast(room);
  });
});

// Drop dead connections so juror "connected" status stays accurate.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

getConfig(); // fail fast on a broken questions.json
server.listen(PORT, () => {
  console.log('\n  STATE v. TOM ROBINSON — the court is in session\n');
  if (PUBLIC_URL) {
    console.log(`  Host screen:  ${PUBLIC_URL}/host`);
    console.log(`  Jurors:       ${PUBLIC_URL}/\n`);
    return;
  }
  console.log(`  Host screen (this computer):  http://localhost:${PORT}/host`);
  console.log(`  Jurors on this computer:      http://localhost:${PORT}/`);
  if (LAN_ALL.length) {
    for (const ip of LAN_ALL) console.log(`  Jurors on the same Wi-Fi:     http://${ip}:${PORT}/`);
  } else {
    console.log('  (No LAN address found — connect to Wi-Fi so phones can join.)');
  }
  console.log('\n  Press Ctrl+C to adjourn.\n');
});
