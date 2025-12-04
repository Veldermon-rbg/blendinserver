// server.js - Chameleon online (grid version)
// Node + Express + ws
// Faithful to the board game rules (grid-based coordinate selection)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// --- Utils ---
function makeCode(len = 4) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function send(ws, type, data) {
  ws.send(JSON.stringify({ type, data }));
}

function broadcast(clients, type, data) {
  const msg = JSON.stringify({ type, data });
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// --- Word bank (example) ---
// For a faithful implementation you'd want many category cards. This is a small sample set.
const CATEGORIES = [
  {
    name: 'Fruits',
    grid: [
      ['Apple','Banana','Cherry','Date'],
      ['Fig','Grape','Lemon','Mango'],
      ['Orange','Papaya','Pear','Quince'],
      ['Kiwi','Lychee','Melon','Plum']
    ]
  },
  {
    name: 'Animals',
    grid: [
      ['Cat','Dog','Horse','Cow'],
      ['Sheep','Pig','Goat','Deer'],
      ['Lion','Tiger','Bear','Wolf'],
      ['Rabbit','Fox','Otter','Whale']
    ]
  },
  {
    name: 'Things at School',
    grid: [
      ['Desk','Chair','Book','Pen'],
      ['Ruler','Map','Clock','Bell'],
      ['Laptop','Teacher','Board','Locker'],
      ['Bus','Uniform','Exam','Class']
    ]
  }
];

// --- Room / Game State Management ---
const rooms = new Map();

function createRoom() {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  const room = {
    code,
    players: [], // {id, ws, name, ready}
    hostWs: null,
    state: 'lobby', // lobby, choosing, hint, accusation, voting, reveal, finished
    capacity: 8,
    minPlayers: 3,
    category: null,
    grid: null,
    coord: null, // {r,c}
    chameleonId: null,
    hints: {}, // playerId -> hint
    votes: {}, // voterId -> targetId
    accusations: [], // array of {accuserId, accusedId}
    created: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function getPublicRoomState(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    state: room.state,
    category: room.category ? room.category.name : null,
    playerCount: room.players.length
  };
}

// assign a simple unique id per ws connection
let nextId = 1;

// --- WebSocket message handling ---

wss.on('connection', (ws, req) => {
  ws.id = 'p' + (nextId++);
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return send(ws, 'error', 'invalid_json'); }

    const { type, data } = msg;

    switch (type) {
      case 'create_room': {
        const room = createRoom();
        room.hostWs = ws;
        ws.roomCode = room.code;
        ws.role = 'host';
        send(ws, 'room_created', { code: room.code });
        break;
      }

      case 'join_room': {
        const { code, name } = data || {};
        if (!code || !name) return send(ws, 'error', 'missing_code_or_name');
        const room = rooms.get(code);
        if (!room) return send(ws, 'error', 'room_not_found');
        if (room.players.length >= room.capacity) return send(ws, 'error', 'room_full');
        if (room.state !== 'lobby') return send(ws, 'error', 'game_already_started');
        const player = { id: ws.id, ws, name: name.slice(0, 20), ready: false };
        room.players.push(player);
        ws.roomCode = code;
        ws.role = 'player';
        // notify everyone in the room
        const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
        broadcast(clients, 'room_update', getPublicRoomState(room));
        break;
      }

      case 'host_start_game': {
        const room = rooms.get(ws.roomCode);
        if (!room) return send(ws, 'error', 'room_not_found');
        if (ws !== room.hostWs) return send(ws, 'error', 'not_host');
        if (room.players.length < room.minPlayers) return send(ws, 'error', 'not_enough_players');

        // pick random category and coord
        const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
        const r = Math.floor(Math.random() * 4);
        const c = Math.floor(Math.random() * 4);
        const chameleonIndex = Math.floor(Math.random() * room.players.length);
        const chameleonId = room.players[chameleonIndex].id;

        room.category = category;
        room.grid = category.grid;
        room.coord = { r, c };
        room.chameleonId = chameleonId;
        room.state = 'hint';
        room.hints = {};
        room.votes = {};
        room.accusations = [];

        // send personalized info to each player
        room.players.forEach(p => {
          if (p.id === chameleonId) {
            send(p.ws, 'game_start_player', { role: 'chameleon' });
          } else {
            send(p.ws, 'game_start_player', { role: 'not_chameleon', coord: room.coord, grid: room.grid, category: room.category.name });
          }
        });

        // host gets full info (secret coord + who is chameleon only if you want)
        if (room.hostWs) send(room.hostWs, 'game_start_host', { coord: room.coord, grid: room.grid, category: room.category.name, chameleonId: room.chameleonId });

        // broadcast state
        const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
        broadcast(clients, 'room_update', getPublicRoomState(room));
        break;
      }

      case 'submit_hint': {
        const { hint } = data || {};
        const room = rooms.get(ws.roomCode);
        if (!room) return send(ws, 'error', 'room_not_found');
        if (room.state !== 'hint') return send(ws, 'error', 'not_in_hint_phase');
        if (!hint || typeof hint !== 'string' || hint.length > 50) return send(ws, 'error', 'invalid_hint');

        room.hints[ws.id] = hint.slice(0,50);

        // if all players have submitted (including chameleon), move to accusation phase
        if (Object.keys(room.hints).length === room.players.length) {
          room.state = 'accusation';
          const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
          // send all hints to everyone (revealed to all)
          broadcast(clients, 'hints_revealed', { hints: room.hints });
          broadcast(clients, 'room_update', getPublicRoomState(room));
        } else {
          // update players about progress
          const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
          broadcast(clients, 'hint_progress', { submitted: Object.keys(room.hints).length, total: room.players.length });
        }
        break;
      }

      case 'accuse': {
        // a player accuses another player of being the chameleon; moves to vote stage when accusation made
        const { accusedId } = data || {};
        const room = rooms.get(ws.roomCode);
        if (!room) return send(ws, 'error', 'room_not_found');
        if (room.state !== 'accusation') return send(ws, 'error', 'not_in_accusation_phase');
        if (!accusedId) return send(ws, 'error', 'missing_accused');

        // store one accusation (for simplicity allow only one accusation to advance)
        room.accusations.push({ accuserId: ws.id, accusedId });
        room.state = 'voting';
        room.votes = {}; // reset votes

        const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
        broadcast(clients, 'voting_start', { accusedId });
        broadcast(clients, 'room_update', getPublicRoomState(room));
        break;
      }

      case 'vote': {
        const { targetId } = data || {};
        const room = rooms.get(ws.roomCode);
        if (!room) return send(ws, 'error', 'room_not_found');
        if (room.state !== 'voting') return send(ws, 'error', 'not_in_voting_phase');
        if (!targetId) return send(ws, 'error', 'missing_vote_target');

        room.votes[ws.id] = targetId;

        // if all votes in, resolve
        if (Object.keys(room.votes).length === room.players.length) {
          // tally votes
          const tally = {};
          Object.values(room.votes).forEach(t => {
            tally[t] = (tally[t] || 0) + 1;
          });
          // find highest
          let highestCount = 0;
          let winners = [];
          Object.entries(tally).forEach(([id,count]) => {
            if (count > highestCount) { highestCount = count; winners = [id]; }
            else if (count === highestCount) winners.push(id);
          });

          // if tie or no clear majority, chameleon wins automatically (board rules vary; here tie -> chameleon survives)
          let accusedId = room.accusations.length ? room.accusations[0].accusedId : (winners.length === 1 ? winners[0] : null);

          if (!accusedId) {
            // no clear accused -> chameleon wins
            room.state = 'reveal';
            const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
            broadcast(clients, 'round_result', { success: false, reason: 'no_consensus', chameleonId: room.chameleonId, secretWord: room.grid[room.coord.r][room.coord.c] });
            room.state = 'finished';
            broadcast(clients, 'room_update', getPublicRoomState(room));
            break;
          }

          // if accusedId is chameleon -> non-chameleon team wins but chameleon gets to guess the secret word
          const isChameleon = (accusedId === room.chameleonId);
          const secretWord = room.grid[room.coord.r][room.coord.c];

          if (isChameleon) {
            // allow chameleon to guess; chameleon must send 'chameleon_guess' message; for now we move to reveal and await guess
            room.state = 'chameleon_guess';
            const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
            broadcast(clients, 'chameleon_caught', { accusedId, chameleonId: room.chameleonId });
            broadcast(clients, 'room_update', getPublicRoomState(room));
          } else {
            // chameleon was not caught -> chameleon (and his team) wins
            room.state = 'reveal';
            const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
            broadcast(clients, 'round_result', { success: false, reason: 'wrong_accusation', accusedId, chameleonId: room.chameleonId, secretWord });
            room.state = 'finished';
            broadcast(clients, 'room_update', getPublicRoomState(room));
          }
        } else {
          // update progress
          const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
          broadcast(clients, 'vote_progress', { submitted: Object.keys(room.votes).length, total: room.players.length });
        }
        break;
      }

      case 'chameleon_guess': {
        const { guess } = data || {};
        const room = rooms.get(ws.roomCode);
        if (!room) return send(ws, 'error', 'room_not_found');
        if (room.state !== 'chameleon_guess') return send(ws, 'error', 'not_in_chameleon_guess_phase');
        if (ws.id !== room.chameleonId) return send(ws, 'error', 'not_chameleon');

        const secretWord = room.grid[room.coord.r][room.coord.c];
        const correct = guess && guess.toLowerCase().trim() === secretWord.toLowerCase();
        room.state = 'reveal';
        const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
        if (correct) {
          broadcast(clients, 'round_result', { success: false, reason: 'chameleon_guessed', guess, secretWord, chameleonId: room.chameleonId });
        } else {
          broadcast(clients, 'round_result', { success: true, reason: 'chameleon_failed', guess, secretWord, chameleonId: room.chameleonId });
        }
        room.state = 'finished';
        broadcast(clients, 'room_update', getPublicRoomState(room));
        break;
      }

      case 'host_reset': {
        const room = rooms.get(ws.roomCode);
        if (!room) return send(ws, 'error', 'room_not_found');
        if (ws !== room.hostWs) return send(ws, 'error', 'not_host');
        // reset to lobby but keep players
        room.state = 'lobby';
        room.category = null;
        room.grid = null;
        room.coord = null;
        room.chameleonId = null;
        room.hints = {};
        room.votes = {};
        room.accusations = [];
        const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
        broadcast(clients, 'room_update', getPublicRoomState(room));
        break;
      }

      default:
        send(ws, 'error', 'unknown_message_type');
    }
  });

  ws.on('close', () => {
    // remove from any room
    const code = ws.roomCode;
    if (code) {
      const room = rooms.get(code);
      if (room) {
        if (ws === room.hostWs) {
          // host left -> dissolve room
          room.players.forEach(p => send(p.ws, 'room_closed', {}));
          rooms.delete(code);
        } else {
          // remove player
          room.players = room.players.filter(p => p.id !== ws.id);
          const clients = room.players.map(p => p.ws).concat(room.hostWs ? [room.hostWs] : []);
          if (clients.length) broadcast(clients, 'room_update', getPublicRoomState(room));
          else rooms.delete(code);
        }
      }
    }
  });

  // initial ping
  send(ws, 'connected', { id: ws.id });
});

// heartbeat to terminate dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Helpful: Place a 'public' folder beside this server.js with the client HTML/JS/CSS.
