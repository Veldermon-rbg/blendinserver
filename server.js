// server.js - Full faithful Chameleon server for Replit + Netlify
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files for local testing (not required if client is on Netlify)
// app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

function makeCode(len = 4) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

function send(ws, type, data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

function broadcast(clients, type, data) {
    const msg = JSON.stringify({ type, data });
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// --- Rooms and game logic ---
const rooms = new Map();
let nextId = 1;

function createRoom() {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const room = {
        code,
        players: [],
        hostWs: null,
        state: 'lobby',
        capacity: 8,
        minPlayers: 3,
        category: null,
        grid: null,
        coord: null,
        chameleonId: null,
        hints: {},
        votes: {},
        accusations: [],
        created: Date.now()
    };
    rooms.set(code, room);
    return room;
}

const CATEGORIES = [
    { name: 'Fruits', grid: [['Apple','Banana','Cherry','Date'],['Fig','Grape','Lemon','Mango'],['Orange','Papaya','Pear','Quince'],['Kiwi','Lychee','Melon','Plum']]},
    { name: 'Animals', grid: [['Cat','Dog','Horse','Cow'],['Sheep','Pig','Goat','Deer'],['Lion','Tiger','Bear','Wolf'],['Rabbit','Fox','Otter','Whale']]},
    { name: 'Things at School', grid: [['Desk','Chair','Book','Pen'],['Ruler','Map','Clock','Bell'],['Laptop','Teacher','Board','Locker'],['Bus','Uniform','Exam','Class']]} 
];

function getPublicRoomState(room) {
    return {
        code: room.code,
        players: room.players.map(p => ({ id: p.id, name: p.name })),
        state: room.state,
        category: room.category ? room.category.name : null,
        playerCount: room.players.length
    };
}

wss.on('connection', (ws) => {
    ws.id = 'p' + (nextId++);
    ws.isAlive = true;

    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch(e){ return send(ws,'error','invalid_json'); }
        const { type, data } = msg;

        switch(type){
            case 'create_room': {
                const room = createRoom();
                room.hostWs = ws;
                ws.roomCode = room.code; ws.role = 'host';
                send(ws,'room_created',{code:room.code});
                console.log(`Room created: ${room.code}`);
                break;
            }
            case 'join_room': {
                const { code, name } = data||{};
                if(!code||!name) return send(ws,'error','missing_code_or_name');
                const room = rooms.get(code);
                if(!room) return send(ws,'error','room_not_found');
                if(room.players.length>=room.capacity) return send(ws,'error','room_full');
                if(room.state!=='lobby') return send(ws,'error','game_already_started');
                const player = {id:ws.id, ws, name:name.slice(0,20), ready:false};
                room.players.push(player);
                ws.roomCode = code; ws.role='player';
                console.log(`${name} joined room ${code}`);
                broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'room_update',getPublicRoomState(room));
                break;
            }
            case 'host_start_game': {
                const room = rooms.get(ws.roomCode); if(!room||ws!==room.hostWs) return send(ws,'error','not_host_or_room');
                if(room.players.length<room.minPlayers) return send(ws,'error','not_enough_players');
                const category = CATEGORIES[Math.floor(Math.random()*CATEGORIES.length)];
                const r = Math.floor(Math.random()*4), c = Math.floor(Math.random()*4);
                const chameleonIndex = Math.floor(Math.random()*room.players.length);
                room.category = category; room.grid = category.grid; room.coord={r,c}; room.chameleonId = room.players[chameleonIndex].id;
                room.state='hint'; room.hints={}; room.votes={}; room.accusations=[];
                room.players.forEach(p=>{
                    if(p.id===room.chameleonId) send(p.ws,'game_start_player',{role:'chameleon'});
                    else send(p.ws,'game_start_player',{role:'not_chameleon',coord:room.coord,grid:room.grid,category:room.category.name});
                });
                if(room.hostWs) send(room.hostWs,'game_start_host',{coord:room.coord,grid:room.grid,category:room.category.name,chameleonId:room.chameleonId});
                console.log(`Game started in room ${room.code}, chameleon: ${room.players[chameleonIndex].name}`);
                broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'room_update',getPublicRoomState(room));
                break;
            }
            case 'submit_hint': {
                const { hint } = data||{};
                const room = rooms.get(ws.roomCode); if(!room||room.state!=='hint') return send(ws,'error','not_in_hint');
                if(!hint||typeof hint!=='string') return send(ws,'error','invalid_hint');
                room.hints[ws.id]=hint.slice(0,50);
                console.log(`Hint submitted by ${ws.id}: ${hint}`);
                if(Object.keys(room.hints).length===room.players.length){
                    room.state='voting';
                    broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'hints_revealed',{hints:room.hints});
                    broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'room_update',getPublicRoomState(room));
                } else {
                    broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'hint_progress',{submitted:Object.keys(room.hints).length,total:room.players.length});
                }
                break;
            }
            case 'vote': {
                const { targetId } = data||{}; const room = rooms.get(ws.roomCode);
                if(!room||room.state!=='voting') return send(ws,'error','not_in_voting');
                room.votes[ws.id]=targetId;
                console.log(`${ws.id} voted for ${targetId}`);
                if(Object.keys(room.votes).length===room.players.length){
                    const tally={}; Object.values(room.votes).forEach(t=>{tally[t]=(tally[t]||0)+1});
                    let highest=0,winners=[]; Object.entries(tally).forEach(([id,c])=>{if(c>highest){highest=c;winners=[id];}else if(c===highest) winners.push(id);});
                    const accusedId = winners.length===1?winners[0]:null;
                    const secretWord = room.grid[room.coord.r][room.coord.c];
                    const success = accusedId===room.chameleonId; // non-chameleons win if they correctly identify
                    const result={success,secretWord,chameleonId:room.chameleonId,accusedId};
                    broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'round_result',result);
                    console.log(`Round finished in room ${room.code}: ${success?'Non-chameleons win':'Chameleon wins'}`);
                    room.state='finished'; broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'room_update',getPublicRoomState(room));
                } else {
                    broadcast(room.players.map(p=>p.ws).concat(room.hostWs?[room.hostWs]:[]),'vote_progress',{submitted:Object.keys(room.votes).length,total:room.players.length});
                }
                break;
            }
            default: send(ws,'error','unknown_type');
        }
    });

    ws.on('close',()=>{
        const code=ws.roomCode; if(!code) return;
        const room=rooms.get(code); if(!room) return;
        if(ws===room.hostWs){
            console.log(`Host left, closing room ${code}`);
            room.players.forEach(p=>send(p.ws,'room_closed',{}));
            rooms.delete(code);
        } else {
            room.players=room.players.filter(p=>p.id!==ws.id);
            console.log(`Player left room ${code}: ${ws.id}`);
            const clients=room.players.map(p=>p.ws);
            if(clients.length) broadcast(clients,'room_update',getPublicRoomState(room));
            else rooms.delete(code);
        }
    });

    send(ws,'connected',{id:ws.id});
});

// Ping clients to detect dead connections
setInterval(()=>{
    wss.clients.forEach(ws=>{
        if(!ws.isAlive) return ws.terminate();
        ws.isAlive=false; ws.ping(()=>{});
    });
},30000);

server.listen(PORT,()=>{console.log(`Chameleon server running on port ${PORT}`);});
