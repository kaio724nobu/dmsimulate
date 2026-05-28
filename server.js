// ============================================================
// カードゲームシミュレーター サーバー
// 起動: node server.js  →  http://localhost:3000 を開く
// ============================================================
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const fs = require('fs');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '20mb' }));

// ================================================================
// ユーザー認証 & デッキ保存 API
// ================================================================
const USERS_FILE = path.join(__dirname, 'users.json');
const sessions = new Map(); // token → username

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPw(pw) {
  return crypto.createHash('sha256').update('cgs_salt_v1:' + pw).digest('hex');
}
function authMW(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: '再ログインしてください' });
  req.username = sessions.get(token);
  next();
}

// 新規登録
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const u = (username || '').trim();
  if (!u || !password) return res.status(400).json({ error: '入力してください' });
  if (u.length < 2 || u.length > 20) return res.status(400).json({ error: 'ユーザー名は2〜20文字にしてください' });
  if (password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上にしてください' });
  const users = loadUsers();
  if (users[u]) return res.status(400).json({ error: 'そのユーザー名はすでに使われています' });
  users[u] = { passwordHash: hashPw(password), decks: {} };
  saveUsers(users);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, u);
  res.json({ token, username: u, decks: {} });
});

// ログイン
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = (username || '').trim();
  const users = loadUsers();
  const user = users[u];
  if (!user || user.passwordHash !== hashPw(password)) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, u);
  res.json({ token, username: u, decks: user.decks || {} });
});

// トークン検証（自動ログイン用）
app.post('/api/verify', authMW, (req, res) => {
  const users = loadUsers();
  const user = users[req.username];
  if (!user) return res.status(401).json({ error: '再ログインしてください' });
  res.json({ username: req.username, decks: user.decks || {} });
});

// デッキ取得
app.get('/api/decks', authMW, (req, res) => {
  const users = loadUsers();
  res.json({ decks: users[req.username]?.decks || {} });
});

// デッキ保存
app.post('/api/decks', authMW, (req, res) => {
  const { decks } = req.body || {};
  const users = loadUsers();
  if (!users[req.username]) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  users[req.username].decks = decks || {};
  saveUsers(users);
  res.json({ ok: true });
});

// 画像をメモリに保管 (imageId -> base64DataUrl)
const imageStore = new Map();

app.post('/api/images', (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });
  const imageId = crypto.randomBytes(8).toString('hex');
  imageStore.set(imageId, imageData);
  res.json({ imageId });
});

app.get('/api/images/:id', (req, res) => {
  const data = imageStore.get(req.params.id);
  if (!data) return res.status(404).send('Not found');
  const match = data.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    res.setHeader('Content-Type', match[1]);
    res.send(Buffer.from(match[2], 'base64'));
  } else {
    res.status(400).send('Invalid image data');
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

function genId() { return crypto.randomBytes(4).toString('hex'); }
function genRoomCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

// ============================================================
// GameRoom クラス
// ============================================================
class GameRoom {
  constructor(code) {
    this.code = code;
    this.players = []; // [{ws, id, name, deck:[], ready:false}]
    this.gameState = null;
    this.started = false;
  }

  addPlayer(ws, id, name) {
    if (this.players.length >= 2) return false;
    this.players.push({ ws, id, name, deck: [], ready: false });
    return true;
  }

  sendTo(id, msg) {
    const p = this.players.find(p => p.id === id);
    if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, excludeId = null) {
    this.players.forEach(p => {
      if (p.id !== excludeId && p.ws.readyState === 1)
        p.ws.send(JSON.stringify(msg));
    });
  }

  sendAll(msg) {
    this.players.forEach(p => {
      if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
    });
  }

  // ゲーム状態初期化
  initGame() {
    const [p1, p2] = this.players;
    this.gameState = {
      players: [
        this._makePlayerState(p1),
        this._makePlayerState(p2),
      ],
      turn: 0,       // 現在のターンプレイヤーindex
      turnNumber: 1,
      log: [],
      pendingPick: null, // {requesterId, message, hand}
    };
    const gs = this.gameState;
    // シャッフル
    gs.players.forEach(p => this._shuffle(p.deck));
    // シールド設置 (5枚) + 初手 (5枚)
    gs.players.forEach(p => {
      for (let i = 0; i < 5 && p.deck.length; i++) p.shieldZone.push(p.deck.shift());
      for (let i = 0; i < 5 && p.deck.length; i++) p.hand.push(p.deck.shift());
    });
    this.started = true;
    this._addLog('ゲーム開始！');
  }

  _makePlayerState(player) {
    return {
      id: player.id,
      name: player.name,
      deck: player.deck.map(c => ({ ...c })),
      hand: [],
      battleZone: [],
      manaZone: [],
      shieldZone: [],
      graveyard: [],
    };
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  _addLog(msg) {
    if (!this.gameState) return;
    this.gameState.log.unshift({ t: Date.now(), msg });
    if (this.gameState.log.length > 50) this.gameState.log.pop();
  }

  // プレイヤー用にフィルタリングしたゲーム状態を返す
  getStateFor(playerId) {
    const gs = this.gameState;
    if (!gs) return null;
    const myIdx = gs.players.findIndex(p => p.id === playerId);
    return {
      players: gs.players.map((p, idx) => {
        const isMe = idx === myIdx;
        return {
          id: p.id,
          name: p.name,
          deckCount: p.deck.length,
          hand: isMe
            ? p.hand
            : p.hand.map(() => ({ id: '__hidden__', hidden: true })),
          handCount: p.hand.length,
          battleZone: p.battleZone,
          manaZone: p.manaZone,
          shieldZone: p.shieldZone.map(c => ({ id: c.id, hidden: true })),
          shieldCount: p.shieldZone.length,
          graveyard: p.graveyard,
        };
      }),
      turn: gs.turn,
      turnNumber: gs.turnNumber,
      myIndex: myIdx,
      log: gs.log.slice(0, 20),
      pendingPick: gs.pendingPick
        ? { message: gs.pendingPick.message, requesterId: gs.pendingPick.requesterId }
        : null,
    };
  }

  // アクション処理
  processAction(playerId, action) {
    const gs = this.gameState;
    if (!gs) return { error: 'Game not started' };
    const myIdx = gs.players.findIndex(p => p.id === playerId);
    if (myIdx === -1) return { error: 'Player not found' };

    const me = gs.players[myIdx];
    const opp = gs.players[1 - myIdx];

    switch (action.type) {
      // --- ドロー ---
      case 'draw': {
        const count = action.count || 1;
        let drawn = 0;
        for (let i = 0; i < count && me.deck.length; i++) {
          me.hand.push(me.deck.shift());
          drawn++;
        }
        this._addLog(`${me.name} が ${drawn}枚ドロー`);
        return { ok: true };
      }

      // --- シャッフル ---
      case 'shuffle': {
        this._shuffle(me.deck);
        this._addLog(`${me.name} が山札をシャッフル`);
        return { ok: true };
      }

      // --- 山札確認（プライベート）---
      case 'view_deck': {
        return { ok: true, private: { type: 'deck_view', cards: me.deck } };
      }

      // --- 山札上N枚確認（プライベート）---
      case 'look_top': {
        const n = Math.min(action.count || 1, me.deck.length);
        return { ok: true, private: { type: 'look_top', cards: me.deck.slice(0, n) } };
      }

      // --- 山札並び替え ---
      case 'reorder_deck': {
        const { order } = action;
        const map = Object.fromEntries(me.deck.map(c => [c.id, c]));
        me.deck = order.map(id => map[id]).filter(Boolean);
        this._addLog(`${me.name} が山札を並び替え`);
        return { ok: true };
      }

      // --- カード移動 ---
      case 'move_card': {
        const { cardId, fromZone, toZone, tapped, faceDown, position } = action;
        // fromZone / toZone: "hand" | "deck" | "battleZone" | "manaZone" | "shieldZone" | "graveyard"
        //                    またはプレフィクスに "opp_" をつけると相手のゾーン
        const card = this._removeCard(me, opp, cardId, fromZone);
        if (!card) return { error: 'Card not found in ' + fromZone };
        if (tapped !== undefined) card.tapped = tapped;
        if (faceDown !== undefined) card.faceDown = faceDown;
        this._insertCard(me, opp, card, toZone, position);
        this._addLog(`${me.name}: ${card.name || 'カード'} → ${toZone}`);
        return { ok: true };
      }

      // --- タップ/アンタップ ---
      case 'tap': {
        const { cardId, zone } = action;
        const card = this._findInZone(me, cardId, zone);
        if (!card) return { error: 'Card not found' };
        card.tapped = !card.tapped;
        this._addLog(`${me.name}: ${card.name || 'カード'} ${card.tapped ? 'タップ' : 'アンタップ'}`);
        return { ok: true };
      }

      // --- 全アンタップ ---
      case 'untap_all': {
        [...me.battleZone, ...me.manaZone].forEach(c => c.tapped = false);
        this._addLog(`${me.name} が全アンタップ`);
        return { ok: true };
      }

      // --- ターン終了 ---
      case 'end_turn': {
        gs.turn = 1 - gs.turn;
        if (gs.turn === 0) gs.turnNumber++;
        // 次のプレイヤーを全アンタップ
        const next = gs.players[gs.turn];
        [...next.battleZone, ...next.manaZone].forEach(c => c.tapped = false);
        this._addLog(`ターン${gs.turnNumber}: ${next.name} のターン`);
        return { ok: true };
      }

      // --- 相手に手札を選ばせる ---
      case 'request_pick': {
        gs.pendingPick = {
          requesterId: playerId,
          message: action.message || '手札からカードを1枚選んでください',
          hand: me.hand,
        };
        this._addLog(`${me.name} が相手に手札選択を要求`);
        return {
          ok: true,
          toOpponent: {
            type: 'pick_request',
            message: gs.pendingPick.message,
            cards: me.hand,
            requesterId: playerId,
          }
        };
      }

      // --- 相手の手札選択応答 ---
      case 'pick_response': {
        if (!gs.pendingPick) return { error: 'No pending pick' };
        const reqId = gs.pendingPick.requesterId;
        const requester = gs.players.find(p => p.id === reqId);
        const { cardId, toZone } = action;
        if (requester) {
          const card = this._removeCard(requester, me, cardId, 'hand');
          if (card && toZone) {
            this._insertCard(requester, me, card, toZone);
            this._addLog(`${me.name} が ${card.name || 'カード'} を選択 → ${toZone}`);
          }
        }
        gs.pendingPick = null;
        return {
          ok: true,
          toRequester: { type: 'pick_result', cardId },
        };
      }

      // --- 手札を相手に見せる ---
      case 'reveal': {
        const { cardId } = action;
        const card = me.hand.find(c => c.id === cardId);
        if (!card) return { error: 'Card not found' };
        this._addLog(`${me.name} が ${card.name || 'カード'} を公開`);
        return {
          ok: true,
          toOpponent: { type: 'card_revealed', card, revealerName: me.name },
        };
      }

      // --- 山札を全て確認してサーチ ---
      case 'search_deck': {
        return { ok: true, private: { type: 'deck_search', cards: me.deck } };
      }

      default:
        return { error: 'Unknown action: ' + action.type };
    }
  }

  _findInZone(player, cardId, zone) {
    return (player[zone] || []).find(c => c.id === cardId);
  }

  _removeCard(me, opp, cardId, zone) {
    let target = me;
    let z = zone;
    if (zone.startsWith('opp_')) { target = opp; z = zone.slice(4); }
    const arr = target[z];
    if (!arr) return null;
    const i = arr.findIndex(c => c.id === cardId);
    if (i === -1) return null;
    return arr.splice(i, 1)[0];
  }

  _insertCard(me, opp, card, zone, position) {
    let target = me;
    let z = zone;
    if (zone.startsWith('opp_')) { target = opp; z = zone.slice(4); }
    const arr = target[z];
    if (!arr) return;
    if (position === 'top') arr.unshift(card);
    else if (position === 'bottom') arr.push(card);
    else if (typeof position === 'number') arr.splice(position, 0, card);
    else arr.push(card);
  }
}

// ============================================================
// WebSocket ハンドラ
// ============================================================
wss.on('connection', ws => {
  let info = null; // { id, roomCode }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); return; }

    switch (msg.type) {

      case 'create_room': {
        const id = genId();
        const code = genRoomCode();
        const room = new GameRoom(code);
        room.addPlayer(ws, id, msg.name || 'Player 1');
        rooms.set(code, room);
        info = { id, roomCode: code };
        ws.send(JSON.stringify({ type: 'room_created', roomCode: code, playerId: id, playerIndex: 0 }));
        break;
      }

      case 'join_room': {
        const code = (msg.roomCode || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません' })); return; }
        if (room.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', message: 'ルームが満員です' })); return; }
        if (room.started) { ws.send(JSON.stringify({ type: 'error', message: 'ゲームが既に開始されています' })); return; }
        const id = genId();
        room.addPlayer(ws, id, msg.name || 'Player 2');
        info = { id, roomCode: code };
        ws.send(JSON.stringify({
          type: 'room_joined', roomCode: code, playerId: id,
          playerIndex: 1, opponentName: room.players[0].name,
        }));
        room.broadcast({ type: 'opponent_joined', opponentName: msg.name || 'Player 2' }, id);
        break;
      }

      case 'submit_deck': {
        if (!info) return;
        const room = rooms.get(info.roomCode);
        if (!room) return;
        const player = room.players.find(p => p.id === info.id);
        if (!player) return;
        player.deck = (msg.cards || []).map(c => ({
          id: genId(),
          name: c.name || 'No Name',
          imageId: c.imageId || null,
          tapped: false,
          faceDown: false,
          ownerId: info.id,
        }));
        player.ready = true;
        ws.send(JSON.stringify({ type: 'deck_submitted', count: player.deck.length }));
        // 両者準備完了でゲーム開始
        if (room.players.length === 2 && room.players.every(p => p.ready)) {
          room.initGame();
          room.players.forEach(p => {
            p.ws.send(JSON.stringify({ type: 'game_start', state: room.getStateFor(p.id) }));
          });
        }
        break;
      }

      // relay: ゲームデータをそのまま相手に転送（ゲームロジックはクライアント側）
      case 'relay': {
        if (!info) return;
        const room = rooms.get(info.roomCode);
        if (!room) return;
        room.broadcast(msg.data, info.id);
        break;
      }

      // 後方互換: action も relay として扱う
      case 'action': {
        if (!info) return;
        const room = rooms.get(info.roomCode);
        if (!room) return;
        room.broadcast(msg.action || msg, info.id);
        break;
      }

      case 'chat': {
        if (!info) return;
        const room = rooms.get(info.roomCode);
        if (!room) return;
        const player = room.players.find(p => p.id === info.id);
        room.sendAll({ type: 'chat', sender: player?.name || '?', text: msg.text });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (room) {
      room.broadcast({ type: 'opponent_left' }, info.id);
      if (room.players.every(p => p.ws.readyState > 1)) rooms.delete(info.roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎴 カードゲームシミュレーター起動！`);
  console.log(`   http://localhost:${PORT} をブラウザで開いてください\n`);
});
