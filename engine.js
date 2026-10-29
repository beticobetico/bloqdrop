/* BloqDrop engine — deterministic (fixed 60 Hz ticks + seeded RNG).
   The same file runs in the browser and on the server, so the server can
   replay a game from its seed + input log and verify the score. */
(function (root) {
  'use strict';
  var COLS = 10, ROWS = 20, TPS = 60;
  var LOCK_TICKS = 30, MAX_RESETS = 15, CLEAR_TICKS = 13;
  var SHAPES = {
    I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    J: [[1,0,0],[1,1,1],[0,0,0]],
    L: [[0,0,1],[1,1,1],[0,0,0]],
    O: [[1,1],[1,1]],
    S: [[0,1,1],[1,1,0],[0,0,0]],
    T: [[0,1,0],[1,1,1],[0,0,0]],
    Z: [[1,1,0],[0,1,1],[0,0,0]]
  };
  var TYPES = ['I','J','L','O','S','T','Z'];
  var KICKS = [[0,0],[-1,0],[1,0],[0,-1],[-2,0],[2,0],[-1,-1],[1,-1]];
  var KICKS_I = KICKS.concat([[0,-2],[-2,-1],[2,-1]]);
  var LINE_PTS = [0,100,300,500,800];
  // action codes used in the input log
  var A = { LEFT:0, RIGHT:1, SOFT:2, HARD:3, CW:4, CCW:5, HOLD:6 };

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rotCW(m) { var n = m.length; return m.map(function (r, y) { return r.map(function (_, x) { return m[n-1-x][y]; }); }); }
  function gravityTicks(level) {
    return Math.max(1, Math.round(Math.pow(Math.max(0.05, 0.8 - (level-1)*0.007), level-1) * TPS));
  }

  function Game(seed) {
    this.rand = mulberry32(seed);
    this.board = []; for (var y = 0; y < ROWS; y++) this.board.push(new Array(COLS).fill(null));
    this.bag = []; this.queue = [];
    for (var i = 0; i < 5; i++) this.queue.push(this.nextType());
    this.hold = null; this.canHold = true;
    this.score = 0; this.lines = 0; this.level = 1; this.combo = -1;
    this.tick = 0; this.over = false; this.clearing = null;
    this.dropAcc = 0; this.lockT = 0; this.lockResets = 0;
    this.events = [];
    this.spawn();
  }
  var P = Game.prototype;
  P.nextType = function () {
    if (!this.bag.length) {
      this.bag = TYPES.slice();
      for (var i = this.bag.length - 1; i > 0; i--) { var j = Math.floor(this.rand() * (i + 1)); var t = this.bag[i]; this.bag[i] = this.bag[j]; this.bag[j] = t; }
    }
    return this.bag.pop();
  };
  P.collide = function (m, px, py) {
    for (var y = 0; y < m.length; y++) for (var x = 0; x < m[y].length; x++) {
      if (!m[y][x]) continue;
      var bx = px + x, by = py + y;
      if (bx < 0 || bx >= COLS || by >= ROWS) return true;
      if (by >= 0 && this.board[by][bx]) return true;
    }
    return false;
  };
  P.spawn = function (type) {
    if (!type) { type = this.queue.shift(); this.queue.push(this.nextType()); }
    var m = SHAPES[type].map(function (r) { return r.slice(); });
    this.cur = { t: type, m: m, x: Math.floor((COLS - m.length) / 2), y: type === 'I' ? -1 : 0 };
    this.lockT = 0; this.lockResets = 0; this.dropAcc = 0;
    if (this.collide(this.cur.m, this.cur.x, this.cur.y)) this.end();
  };
  P.end = function () { this.over = true; this.cur = null; this.events.push({ t: 'over' }); };
  P.grounded = function () { return this.collide(this.cur.m, this.cur.x, this.cur.y + 1); };
  P.onMoved = function () { if (this.grounded() && this.lockResets < MAX_RESETS) { this.lockT = 0; this.lockResets++; } };
  P.canAct = function () { return !this.over && this.cur && !this.clearing; };

  // Apply one input. Returns true if it changed the state.
  P.act = function (a) {
    if (!this.canAct()) return false;
    var c = this.cur;
    switch (a) {
      case A.LEFT: case A.RIGHT:
        var dx = a === A.LEFT ? -1 : 1;
        if (this.collide(c.m, c.x + dx, c.y)) return false;
        c.x += dx; this.onMoved(); this.events.push({ t: 'move' }); return true;
      case A.SOFT:
        if (this.collide(c.m, c.x, c.y + 1)) return false;
        c.y++; this.score += 1; this.dropAcc = 0; return true;
      case A.HARD:
        var n = 0; while (!this.collide(c.m, c.x, c.y + 1)) { c.y++; n++; }
        this.score += n * 2; this.events.push({ t: 'drop' }); this.lock(); return true;
      case A.CW: case A.CCW:
        if (c.t === 'O') return false;
        var m2 = rotCW(c.m); if (a === A.CCW) m2 = rotCW(rotCW(m2));
        var kicks = c.t === 'I' ? KICKS_I : KICKS;
        for (var i = 0; i < kicks.length; i++) {
          var kx = kicks[i][0], ky = kicks[i][1];
          if (!this.collide(m2, c.x + kx, c.y + ky)) { c.m = m2; c.x += kx; c.y += ky; this.onMoved(); this.events.push({ t: 'rot' }); return true; }
        }
        return false;
      case A.HOLD:
        if (!this.canHold) return false;
        var prev = this.hold; this.hold = c.t; this.canHold = false; this.events.push({ t: 'hold' });
        if (prev) this.spawn(prev); else this.spawn();
        return true;
    }
    return false;
  };
  P.lock = function () {
    var c = this.cur, out = false, self = this;
    c.m.forEach(function (r, y) { r.forEach(function (v, x) {
      if (!v) return; var by = c.y + y, bx = c.x + x;
      if (by < 0) out = true; else self.board[by][bx] = c.t;
    }); });
    this.cur = null; this.canHold = true;
    if (out) { this.end(); return; }
    var full = [];
    for (var y = 0; y < ROWS; y++) if (this.board[y].every(Boolean)) full.push(y);
    if (full.length) { this.clearing = { rows: full, t: 0 }; this.events.push({ t: 'clear', n: full.length }); }
    else { this.combo = -1; this.events.push({ t: 'lock' }); this.spawn(); }
  };
  P.finishClear = function () {
    var rows = this.clearing.rows, n = rows.length; this.clearing = null;
    this.board = this.board.filter(function (_, i) { return rows.indexOf(i) < 0; });
    while (this.board.length < ROWS) this.board.unshift(new Array(COLS).fill(null));
    this.combo++;
    this.score += LINE_PTS[n] * this.level + (this.combo > 0 ? 50 * this.combo * this.level : 0);
    var prevLevel = this.level; this.lines += n; this.level = Math.floor(this.lines / 10) + 1;
    this.events.push({ t: 'lines', n: n, combo: this.combo, levelUp: this.level > prevLevel });
    if (this.board.every(function (r) { return r.every(function (v) { return !v; }); })) {
      this.score += 2000 * this.level; this.events.push({ t: 'perfect' });
    }
    this.spawn();
  };
  // Advance exactly one tick (1/60 s).
  P.step = function () {
    if (this.over) return;
    this.tick++;
    if (this.clearing) { if (++this.clearing.t >= CLEAR_TICKS) this.finishClear(); return; }
    if (!this.cur) return;
    if (this.grounded()) { if (++this.lockT >= LOCK_TICKS) this.lock(); }
    else if (++this.dropAcc >= gravityTicks(this.level)) { this.dropAcc = 0; this.cur.y++; }
  };
  P.ghostY = function () { var y = this.cur.y; while (!this.collide(this.cur.m, this.cur.x, y + 1)) y++; return y; };

  /* Replay a recorded game. log = [tick, action, tick, action, ...] with
     non-decreasing ticks. Actions with tick k are applied after k steps. */
  function replay(seed, log, maxTicks) {
    if (!Array.isArray(log) || log.length % 2) return { ok: false, error: 'bad_log' };
    var g = new Game(seed), i = 0, last = 0;
    maxTicks = maxTicks || TPS * 60 * 90;
    while (!g.over) {
      while (i < log.length && log[i] === g.tick) {
        var a = log[i + 1];
        if (!(a >= 0 && a <= 6) || (a | 0) !== a) return { ok: false, error: 'bad_action' };
        g.act(a); i += 2;
      }
      if (i < log.length) {
        var t = log[i];
        if (typeof t !== 'number' || (t | 0) !== t || t < last || t < g.tick) return { ok: false, error: 'bad_tick' };
        last = t;
      }
      g.events.length = 0;
      if (g.tick >= maxTicks) return { ok: false, error: 'too_long' };
      g.step();
    }
    if (i < log.length) return { ok: false, error: 'actions_after_end' };
    return { ok: true, score: g.score, lines: g.lines, level: g.level, ticks: g.tick };
  }

  var api = { Game: Game, replay: replay, SHAPES: SHAPES, ACTIONS: A, COLS: COLS, ROWS: ROWS, TPS: TPS, CLEAR_TICKS: CLEAR_TICKS, gravityTicks: gravityTicks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BloqEngine = api;
})(typeof self !== 'undefined' ? self : this);
