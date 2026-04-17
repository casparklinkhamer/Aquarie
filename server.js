const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// ─── Game constants ───────────────────────────────────────────────────────────
const CHAINS = ['worldwide','luxor','continental','imperial','american','festival','tower'];
const CHAIN_LABELS = {worldwide:'Worldwide',luxor:'Luxor',continental:'Continental',imperial:'Imperial',american:'American',festival:'Festival',tower:'Tower'};
const ROWS = ['A','B','C','D','E','F','G','H','I'];
const COLS = [1,2,3,4,5,6,7,8,9,10,11,12];
const TIER_CHAINS = {tier2:['worldwide','luxor'],tier3:['continental','imperial'],tier4:['american','festival','tower']};
const STOCK_PRICE_TABLE = {
  2:[200,200,300,300,300,400,400,400,500,500,500,600],
  3:[300,300,400,400,400,500,500,500,600,600,600,700],
  4:[400,400,500,500,500,600,600,600,700,700,700,800]
};

function getTier(chain){
  if(TIER_CHAINS.tier2.includes(chain)) return 2;
  if(TIER_CHAINS.tier3.includes(chain)) return 3;
  return 4;
}
function getStockPrice(chain, size){
  if(size <= 0) return 0;
  if(size === 1) return STOCK_PRICE_TABLE[getTier(chain)][0];
  const tier = getTier(chain);
  const idx = Math.min(size - 2, 11);
  return STOCK_PRICE_TABLE[tier][Math.max(0, idx)];
}
function getBonuses(chain, size){
  const price = getStockPrice(chain, size);
  return { majority: price * 10, minority: price * 5 };
}
function shuffle(a){
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
function genCode(){
  return Math.random().toString(36).slice(2,6).toUpperCase();
}
function chainTiles(board, chain){
  return Object.keys(board).filter(t => board[t] && board[t].chain === chain);
}
function tileCoord(tile){
  return { r: tile[0], c: parseInt(tile.slice(1)) };
}
function tileNeighbors(tile){
  const {r,c} = tileCoord(tile);
  const ri = ROWS.indexOf(r);
  const nb = [];
  if(ri > 0) nb.push(ROWS[ri-1]+c);
  if(ri < 8) nb.push(ROWS[ri+1]+c);
  if(c > 1) nb.push(r+(c-1));
  if(c < 12) nb.push(r+(c+1));
  return nb;
}
function getChainsFromNeighbors(board, tile){
  const nb = tileNeighbors(tile).filter(t => board[t]);
  const cs = new Set();
  for(const n of nb) if(board[n] && board[n].chain) cs.add(board[n].chain);
  return [...cs];
}
function classifyTile(state, tile){
  const {board, chains} = state;
  if(board[tile]) return 'used';
  const boardedNb = tileNeighbors(tile).filter(t => board[t]);
  if(!boardedNb.length) return 'orphan';
  const adjChains = getChainsFromNeighbors(board, tile);
  if(adjChains.length === 0){
    const orphanNb = boardedNb.filter(n => board[n] && !board[n].chain);
    return orphanNb.length > 0 ? 'found' : 'extend_solo';
  }
  if(adjChains.length === 1) return 'extend';
  const safe = adjChains.filter(c => chainTiles(board,c).length >= 11);
  if(safe.length >= 2) return 'unplayable';
  return 'merge';
}

function initGameState(players){
  const tiles = [];
  for(const r of ROWS) for(const c of COLS) tiles.push(r+c);
  shuffle(tiles);
  const ps = players.map((p, i) => ({
    id: p.id, name: p.name, cash: 6000,
    hand: tiles.splice(0, 6),
    stocks: Object.fromEntries(CHAINS.map(c => [c, 0]))
  }));
  // Starting tiles
  const board = {};
  ps.forEach(() => { const t = tiles.splice(0,1)[0]; board[t] = {chain:null}; });
  return {
    board,
    players: ps,
    tileBag: tiles,
    chains: Object.fromEntries(CHAINS.map(c => [c, {size:0, active:false, stocks:25}])),
    currentPlayer: 0,
    phase: 'place',
    log: [],
    gameOver: false,
    merger: null
  };
}

function addLog(state, msg){
  state.log.unshift(msg);
  if(state.log.length > 50) state.log.pop();
}

function payBonuses(state, defunct){
  const size = chainTiles(state.board, defunct).length;
  const {majority, minority} = getBonuses(defunct, size);
  const holders = state.players
    .filter(p => p.stocks[defunct] > 0)
    .sort((a,b) => b.stocks[defunct] - a.stocks[defunct]);
  if(!holders.length) return;
  if(holders.length === 1){
    holders[0].cash += majority + minority;
    addLog(state, `${holders[0].name} krijgt bonus $${majority+minority}`);
  } else {
    if(holders[0].stocks[defunct] === holders[1].stocks[defunct]){
      const each = Math.ceil((majority+minority)/2/100)*100;
      holders.slice(0,2).forEach(h => { h.cash += each; addLog(state,`${h.name} gedeelde bonus $${each}`); });
    } else {
      holders[0].cash += majority;
      addLog(state, `${holders[0].name} meerderheidsbonus $${majority}`);
      holders[1].cash += minority;
      addLog(state, `${holders[1].name} minderheidsbonus $${minority}`);
    }
  }
}

function doMerge(state, tile, survivor, defunct){
  const defTiles = chainTiles(state.board, defunct);
  defTiles.forEach(t => { state.board[t] = {chain: survivor}; });
  state.board[tile] = {chain: survivor};
  state.chains[survivor].size = chainTiles(state.board, survivor).length;
  addLog(state, `Fusie: ${CHAIN_LABELS[survivor]} neemt ${CHAIN_LABELS[defunct]} over`);
  payBonuses(state, defunct);
  state.merger = {
    survivor, defunct,
    pending: state.players.map(p => ({id:p.id, name:p.name, stocks:p.stocks[defunct], done:false})),
    idx: 0
  };
  state.chains[defunct].active = false;
  state.chains[defunct].size = 0;
}

function checkGameEnd(state){
  const active = CHAINS.filter(c => state.chains[c].active);
  if(!active.length) return false;
  const allSafe = active.every(c => chainTiles(state.board, c).length >= 11);
  const hasHuge = active.some(c => chainTiles(state.board, c).length >= 41);
  return allSafe || hasHuge;
}

function finalizeGame(state){
  CHAINS.filter(c => state.chains[c].active).forEach(c => payBonuses(state, c));
  state.players.forEach(p => {
    CHAINS.forEach(c => {
      if(p.stocks[c] > 0 && state.chains[c].active){
        const price = getStockPrice(c, chainTiles(state.board, c).length);
        p.cash += p.stocks[c] * price;
        p.stocks[c] = 0;
      }
    });
  });
  state.gameOver = true;
}

function advanceMerger(state){
  state.merger.idx++;
  while(state.merger.idx < state.merger.pending.length){
    const cur = state.merger.pending[state.merger.idx];
    const real = state.players.find(p => p.id === cur.id);
    if(real.stocks[state.merger.defunct] > 0) return false; // still waiting
    state.merger.idx++;
  }
  state.merger = null;
  state.phase = 'buy';
  return true;
}

function drawTile(state, player){
  if(state.tileBag.length === 0) return;
  // skip unplayable tiles
  let attempts = 0;
  while(state.tileBag.length > 0 && attempts < 20){
    const t = state.tileBag.splice(0,1)[0];
    if(classifyTile(state, t) !== 'unplayable'){
      player.hand.push(t);
      return;
    }
    attempts++;
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('host', ({name}) => {
    const code = genCode();
    rooms[code] = {
      code,
      players: [{id: socket.id, name, host:true}],
      started: false,
      state: null
    };
    socket.join(code);
    socket.emit('hosted', {code});
    io.to(code).emit('lobby', rooms[code].players);
  });

  socket.on('join', ({code, name}) => {
    const room = rooms[code];
    if(!room) return socket.emit('error', 'Spelcode niet gevonden.');
    if(room.started) return socket.emit('error', 'Dit spel is al begonnen.');
    if(room.players.length >= 6) return socket.emit('error', 'Spel is vol (max 6 spelers).');
    room.players.push({id: socket.id, name, host:false});
    socket.join(code);
    socket.emit('joined', {code});
    io.to(code).emit('lobby', room.players);
  });

  socket.on('start', ({code}) => {
    const room = rooms[code];
    if(!room) return;
    if(room.players[0].id !== socket.id) return;
    if(room.players.length < 2) return socket.emit('error', 'Minimaal 2 spelers nodig.');
    room.state = initGameState(room.players);
    room.started = true;
    io.to(code).emit('gameState', sanitizeState(room.state, code, rooms));
  });

  socket.on('placeTile', ({code, tile}) => {
    const room = rooms[code];
    if(!room || !room.state) return;
    const state = room.state;
    const player = state.players[state.currentPlayer];
    if(player.id !== socket.id) return;
    if(state.phase !== 'place') return;
    const tileIdx = player.hand.indexOf(tile);
    if(tileIdx === -1) return;
    player.hand.splice(tileIdx, 1);

    const type = classifyTile(state, tile);
    if(type === 'used' || type === 'unplayable') return;

    state.board[tile] = {chain: null};

    if(type === 'orphan' || type === 'extend_solo'){
      addLog(state, `${player.name} plaatste tegel ${tile}`);
      state.phase = 'buy';
      io.to(code).emit('gameState', sanitizeState(state, code, rooms));
    } else if(type === 'extend'){
      const chains = getChainsFromNeighbors(state.board, tile);
      state.board[tile] = {chain: chains[0]};
      state.chains[chains[0]].size = chainTiles(state.board, chains[0]).length;
      addLog(state, `${player.name} breidde ${CHAIN_LABELS[chains[0]]} uit met tegel ${tile}`);
      state.phase = 'buy';
      io.to(code).emit('gameState', sanitizeState(state, code, rooms));
    } else if(type === 'found'){
      const orphanNb = tileNeighbors(tile).filter(t => state.board[t] && !state.board[t].chain);
      const avail = CHAINS.filter(c => !state.chains[c].active);
      socket.emit('chooseChain', {tile, orphans: orphanNb, available: avail});
    } else if(type === 'merge'){
      const adjChains = getChainsFromNeighbors(state.board, tile);
      const sorted = [...adjChains].sort((a,b) => chainTiles(state.board,b).length - chainTiles(state.board,a).length);
      const topSize = chainTiles(state.board, sorted[0]).length;
      const secondSize = chainTiles(state.board, sorted[1]).length;
      if(topSize > secondSize){
        doMerge(state, tile, sorted[0], sorted[1]);
        io.to(code).emit('gameState', sanitizeState(state, code, rooms));
        // prompt merger stock decisions
        promptNextMergerPlayer(code, state);
      } else {
        // tie: ask player to choose
        socket.emit('chooseMerge', {tile, chains: sorted});
      }
    }
  });

  socket.on('foundChain', ({code, tile, orphans, chainName}) => {
    const room = rooms[code];
    if(!room || !room.state) return;
    const state = room.state;
    const player = state.players[state.currentPlayer];
    if(player.id !== socket.id) return;
    state.chains[chainName].active = true;
    [tile, ...orphans].forEach(t => { state.board[t] = {chain: chainName}; });
    state.chains[chainName].size = [tile,...orphans].length;
    // founder gets 1 free share
    if(state.chains[chainName].stocks > 0){
      player.stocks[chainName]++;
      state.chains[chainName].stocks--;
    }
    addLog(state, `${player.name} richtte ${CHAIN_LABELS[chainName]} op (${state.chains[chainName].size} tegels)`);
    state.phase = 'buy';
    io.to(code).emit('gameState', sanitizeState(state, code, rooms));
  });

  socket.on('chooseMerge', ({code, tile, survivor, defunct}) => {
    const room = rooms[code];
    if(!room || !room.state) return;
    const state = room.state;
    const player = state.players[state.currentPlayer];
    if(player.id !== socket.id) return;
    doMerge(state, tile, survivor, defunct);
    io.to(code).emit('gameState', sanitizeState(state, code, rooms));
    promptNextMergerPlayer(code, state);
  });

  socket.on('mergerDecision', ({code, choice}) => {
    const room = rooms[code];
    if(!room || !room.state) return;
    const state = room.state;
    if(!state.merger) return;
    const cur = state.merger.pending[state.merger.idx];
    if(cur.id !== socket.id) return;
    const realPlayer = state.players.find(p => p.id === cur.id);
    const defunct = state.merger.defunct;
    const survivor = state.merger.survivor;
    const qty = realPlayer.stocks[defunct];

    if(choice === 'sell'){
      const price = getStockPrice(defunct, chainTiles(state.board, survivor).length);
      realPlayer.cash += price * qty;
      state.chains[defunct].stocks += qty;
      realPlayer.stocks[defunct] = 0;
      addLog(state, `${realPlayer.name} verkocht ${qty}x ${CHAIN_LABELS[defunct]} voor $${price*qty}`);
    } else if(choice === 'trade'){
      const give = Math.floor(qty/2)*2;
      const get = give/2;
      realPlayer.stocks[defunct] -= give;
      state.chains[defunct].stocks += give;
      realPlayer.stocks[survivor] = (realPlayer.stocks[survivor]||0) + get;
      state.chains[survivor].stocks -= get;
      addLog(state, `${realPlayer.name} ruilde ${give}x voor ${get}x ${CHAIN_LABELS[survivor]}`);
    } else {
      addLog(state, `${realPlayer.name} hield ${qty}x ${CHAIN_LABELS[defunct]}`);
    }

    state.merger.pending[state.merger.idx].done = true;
    advanceMergerIdx(code, state);
  });

  socket.on('buyStocks', ({code, purchases}) => {
    const room = rooms[code];
    if(!room || !room.state) return;
    const state = room.state;
    const player = state.players[state.currentPlayer];
    if(player.id !== socket.id) return;
    if(state.phase !== 'buy') return;

    let total = 0;
    let bought = 0;
    for(const [chain, qty] of Object.entries(purchases)){
      if(!qty || !state.chains[chain].active) continue;
      if(bought + qty > 3) continue;
      const price = getStockPrice(chain, chainTiles(state.board, chain).length);
      const cost = price * qty;
      if(total + cost > player.cash) continue;
      player.stocks[chain] = (player.stocks[chain]||0) + qty;
      state.chains[chain].stocks -= qty;
      player.cash -= cost;
      total += cost;
      bought += qty;
      addLog(state, `${player.name} kocht ${qty}x ${CHAIN_LABELS[chain]}`);
    }

    // Draw tile
    drawTile(state, player);
    // Advance turn
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    state.phase = 'place';

    if(checkGameEnd(state)){
      finalizeGame(state);
    }

    io.to(code).emit('gameState', sanitizeState(state, code, rooms));
  });

  socket.on('disconnect', () => {
    // Mark player disconnected in any room
    for(const [code, room] of Object.entries(rooms)){
      const p = room.players.find(p => p.id === socket.id);
      if(p){
        p.disconnected = true;
        if(!room.started) io.to(code).emit('lobby', room.players);
      }
    }
  });
});

function promptNextMergerPlayer(code, state){
  if(!state.merger) return;
  const cur = state.merger.pending[state.merger.idx];
  const real = state.players.find(p => p.id === cur.id);
  const qty = real ? real.stocks[state.merger.defunct] : 0;
  if(qty === 0){
    advanceMergerIdx(code, state);
    return;
  }
  const size = chainTiles(state.board, state.merger.survivor).length;
  const price = getStockPrice(state.merger.defunct, size);
  io.to(cur.id).emit('mergerChoice', {
    defunct: state.merger.defunct,
    survivor: state.merger.survivor,
    qty,
    price
  });
}

function advanceMergerIdx(code, state){
  state.merger.idx++;
  while(state.merger.idx < state.merger.pending.length){
    const cur = state.merger.pending[state.merger.idx];
    const real = state.players.find(p => p.id === cur.id);
    if(real && real.stocks[state.merger.defunct] > 0){
      promptNextMergerPlayer(code, state);
      io.to(code).emit('gameState', sanitizeState(state, code, rooms));
      return;
    }
    state.merger.idx++;
  }
  state.merger = null;
  state.phase = 'buy';
  io.to(code).emit('gameState', sanitizeState(state, code, rooms));
}

function sanitizeState(state, code, rooms){
  // Send full state (in production you'd hide other players' hands)
  return state;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Acquire server draait op poort ${PORT}`));
