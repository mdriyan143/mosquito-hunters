// Hit Machar – canvas game engine (framework-free so React only handles UI).
//
// Timing model (measured from the reference video):
//  * The mosquito buzz sound is 8.04s and restarts every time a mosquito spawns (measured: the video's
//    audio repeats every ~8.5s, starting ~0.3s after PLAY). It peaks ~0.9s in, while the mosquito crosses
//    the screen, and has a second bump ~4.7s in, on its return pass (see FLIGHT below).
//  * One mosquito "cycle" lasts 8.6s. If it is not killed, a new one spawns (sound restarts).
//  * After a kill the next mosquito spawns ~0.5s later.
//  * Hold = dashed aim line, release = fire: orange laser (0.22s) + 2s fire sound,
//    on hit a ring + confetti burst and a floating "+1" (0.9s).

export const W = 720; // logical world width; height follows the screen aspect

const CYCLE = 8.6;
const FIRST_SPAWN_DELAY = 0.4;
const RESPAWN_DELAY = 0.5;
const BEAM_LIFE = 0.22;
const BURST_LIFE = 0.9;
const FIRE_COOLDOWN = 0.25;
const HIT_RADIUS = 44;
const MOSQ_W = 92;

// Flight script re-tracked frame-by-frame from the reference video (20 fps colour tracking):
// each 8.6s cycle has exactly TWO visible fly-bys at a steady height (~35% down the screen) and the
// mosquito is off-screen the rest of the time:
//   pass 1  life 0.2s–1.6s  : enters from the side, ~0.8 screen-widths/s  (buzz peak at ~0.9s)
//   pass 2  life 4.3s–5.1s  : comes back the other way, faster (~1.1 w/s) (buzz bump at ~4.7s)
// [time(s), x (fraction of width, <0 / >1 = off-screen), y (fraction of height), pass]
// pass: 0 → height of pass 1, 1 → height of pass 2, 2 → average (off-screen transit)
const FLIGHT = [
  [0.0, -0.12, 0.35, 0],
  [0.4, 0.06, 0.35, 0],
  [0.65, 0.25, 0.35, 0],
  [0.9, 0.47, 0.35, 0],
  [1.15, 0.66, 0.35, 0],
  [1.4, 0.85, 0.35, 0],
  [1.75, 1.12, 0.34, 0],
  [2.5, 1.2, 0.2, 2], // off-screen turn-around
  [3.4, 1.18, 0.28, 1],
  [4.0, 1.08, 0.34, 1],
  [4.35, 0.87, 0.34, 1],
  [4.6, 0.61, 0.34, 1],
  [4.85, 0.34, 0.34, 1],
  [5.1, 0.05, 0.34, 1],
  [5.45, -0.14, 0.34, 1],
  [6.2, -0.22, 0.22, 2], // lurks just off-screen (small buzz bump)
  [6.9, -0.2, 0.4, 2],
  [7.7, -0.2, 0.3, 2],
  [8.6, -0.2, 0.34, 2],
];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

export class Engine {
  constructor(canvas, { base = '', onKill = () => {}, onFire = () => {}, onLog = null } = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.base = base;
    this.onKill = onKill;
    this.onFire = onFire;
    this.onLog = onLog; // test hook: (event, data) => void

    this.running = false; // game loop advancing
    this.kills = 0;
    this.elapsed = 0; // seconds of un-paused play
    this.shots = 0;
    this.muted = false;

    this.mosq = null; // {life, dir, nodes, x, y, vx, vy, face, g, src}
    this.spawnIn = null;
    this.aiming = false;
    this.aimAngle = -Math.PI / 2;
    this.cooldown = 0;
    this.beams = [];
    this.bursts = [];
    this.hintT = 0;

    this.audio = null;
    this.buffers = {};
    this.imgs = {};
    this._raf = 0;
    this._last = 0;

    this._bind();
    this.resize();
  }

  // ---------- setup ----------
  async load() {
    const [boy, mosq] = await Promise.all([
      loadImage(`${this.base}/img/boy.png`),
      loadImage(`${this.base}/img/mosquito.png`),
    ]);
    this.imgs = { boy, mosq };
    this._layout();
    this._render(); // idle frame behind the menu
  }

  async _loadAudio() {
    if (this.audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 1;
    master.connect(ctx.destination);
    this.audio = { ctx, master };
    const get = async (name) => {
      try {
        const r = await fetch(`${this.base}/sounds/${name}.mp3`);
        const ab = await r.arrayBuffer();
        this.buffers[name] = await new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
      } catch (e) {
        console.warn('sound failed', name, e);
      }
    };
    await Promise.all([get('mosquito'), get('fire')]);
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    this._down = (e) => {
      if (!this.running) return;
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.aiming = true;
      this._aimTo(e);
    };
    this._move = (e) => {
      if (this.aiming) this._aimTo(e);
    };
    this._up = (e) => {
      if (!this.aiming) return;
      this.aiming = false;
      if (this.running) this._fire();
    };
    this._cancel = () => { this.aiming = false; };
    c.addEventListener('pointerdown', this._down);
    c.addEventListener('pointermove', this._move);
    c.addEventListener('pointerup', this._up);
    c.addEventListener('pointercancel', this._cancel);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(c);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._down);
    c.removeEventListener('pointermove', this._move);
    c.removeEventListener('pointerup', this._up);
    c.removeEventListener('pointercancel', this._cancel);
    this._ro.disconnect();
    this._stopMosqSound(true);
    if (this.audio) this.audio.ctx.close().catch(() => {});
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cw = c.clientWidth || 360;
    const ch = c.clientHeight || 640;
    c.width = Math.round(cw * dpr);
    c.height = Math.round(ch * dpr);
    this.scale = cw / W;
    this.H = ch / this.scale;
    this.dpr = dpr;
    this._layout();
    if (!this.running && this.imgs.boy) this._render();
  }

  _layout() {
    if (!this.imgs.boy) return;
    const bw = W * 0.675;
    const bh = (bw * this.imgs.boy.height) / this.imgs.boy.width;
    const bx = W * 0.125;
    const by = this.H * 0.7 - bh / 2;
    this.bed = { x: bx, y: by, w: bw, h: bh };
    // the boy's hand on the bed – where the aim line / laser comes from
    this.muzzle = { x: bx + bw * 0.575, y: by + bh * 0.51 };
  }

  // ---------- control ----------
  async start() {
    await this._loadAudio();
    if (this.audio) await this.audio.ctx.resume();
    this._stopMosqSound(true);
    this.kills = 0;
    this.elapsed = 0;
    this.shots = 0;
    this.mosq = null;
    this.spawned = 0;
    this.spawnIn = FIRST_SPAWN_DELAY;
    this.beams = [];
    this.bursts = [];
    this.aiming = false;
    this.cooldown = 0;
    this.hintT = 0;
    this.aimAngle = -Math.PI / 2;
    this._run();
  }

  _run() {
    this.running = true;
    this._last = performance.now();
    cancelAnimationFrame(this._raf);
    const tick = (now) => {
      if (!this.running) return;
      const dt = Math.min((now - this._last) / 1000, 0.05);
      this._last = now;
      this.update(dt);
      this._render();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    this.aiming = false;
    cancelAnimationFrame(this._raf);
    if (this.audio) this.audio.ctx.suspend();
    this._render();
  }

  async resume() {
    if (this.running) return;
    if (this.audio) await this.audio.ctx.resume();
    this._run();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._stopMosqSound(true);
    this.mosq = null;
    this.beams = [];
    this.bursts = [];
    if (this.audio) this.audio.ctx.resume();
    this._render();
  }

  setMuted(m) {
    this.muted = m;
    if (this.audio) this.audio.master.gain.setTargetAtTime(m ? 0 : 1, this.audio.ctx.currentTime, 0.02);
  }

  // ---------- sound ----------
  _play(name, gain = 1) {
    const a = this.audio;
    const buf = this.buffers[name];
    this.onLog && this.onLog('sound:' + name, { t: this.elapsed });
    if (!a || !buf) return null;
    const src = a.ctx.createBufferSource();
    const g = a.ctx.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g).connect(a.master);
    src.start();
    return { src, g };
  }

  _stopMosqSound(immediate = false) {
    const m = this.mosq;
    if (!m || !m.snd || !this.audio) return;
    const { src, g } = m.snd;
    const t = this.audio.ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, immediate ? 0.01 : 0.06);
      src.stop(t + (immediate ? 0.06 : 0.4));
    } catch (_) { /* already stopped */ }
    m.snd = null;
  }

  // ---------- mosquito ----------
  _spawn() {
    this._stopMosqSound(false);
    // the very first mosquito of a run enters from the left, exactly like the video; later ones are random
    const dir = this.spawned++ === 0 ? 1 : Math.random() < 0.5 ? 1 : -1;
    // each fly-by gets its own height (the video shows ~0.28–0.39 of the screen height)
    const shift = [rand(-0.06, 0.05), rand(-0.06, 0.05)];
    shift[2] = (shift[0] + shift[1]) / 2;
    const nodes = FLIGHT.map(([t, x, y, pass]) => {
      const edge = x < 0 || x > 1;
      const jx = edge ? 0 : rand(-0.015, 0.015);
      return [t, x + jx, clamp(y + shift[pass] + rand(-0.01, 0.01), 0.1, 0.5)];
    });
    this.mosq = { life: 0, dir, nodes, x: -999, y: -999, vx: 0, vy: 0, face: dir, snd: this._play('mosquito', 1), alive: true };
    this.onLog && this.onLog('spawn', { t: this.elapsed, dir });
    this._placeMosq(0);
  }

  _placeMosq(life, dt = 0.016) {
    const m = this.mosq;
    const n = m.nodes;
    let i = 0;
    while (i < n.length - 2 && life > n[i + 1][0]) i++;
    const p0 = n[Math.max(i - 1, 0)], p1 = n[i], p2 = n[i + 1], p3 = n[Math.min(i + 2, n.length - 1)];
    const h = p2[0] - p1[0];
    const u = clamp((life - p1[0]) / h, 0, 1);
    const m1 = (k) => (p2[k] - p0[k]) / (p2[0] - p0[0]);
    const m2 = (k) => (p3[k] - p1[k]) / (p3[0] - p1[0]);
    const herm = (k) => {
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * p1[k] + (u3 - 2 * u2 + u) * h * m1(k) + (-2 * u3 + 3 * u2) * p2[k] + (u3 - u2) * h * m2(k);
    };
    let fx = herm(1);
    if (m.dir < 0) fx = 1 - fx;
    const px = fx * W + Math.sin(life * 9.5) * 5;
    const py = herm(2) * this.H + Math.sin(life * 13) * 8 + Math.sin(life * 4.1) * 6;
    m.vx = (px - m.x) / dt;
    m.vy = (py - m.y) / dt;
    if (m.x === -999) { m.vx = 0; m.vy = 0; }
    m.x = px;
    m.y = py;
    if (Math.abs(m.vx) > 60) m.face = m.vx > 0 ? 1 : -1;
  }

  // ---------- fire ----------
  _aimTo(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * this.H;
    const dx = px - this.muzzle.x, dy = py - this.muzzle.y;
    if (Math.hypot(dx, dy) > 18) this.aimAngle = Math.atan2(dy, dx);
  }

  _fire() {
    if (this.cooldown > 0) return;
    this.cooldown = FIRE_COOLDOWN;
    this.shots++;
    const M = this.muzzle;
    const dx = Math.cos(this.aimAngle), dy = Math.sin(this.aimAngle);
    let len = 3000;
    let hit = false;
    const m = this.mosq;
    if (m && m.alive) {
      const vx = m.x - M.x, vy = m.y - M.y;
      const along = vx * dx + vy * dy;
      const perp = Math.abs(vx * dy - vy * dx);
      const onScreen = m.x > -10 && m.x < W + 10 && m.y > -10 && m.y < this.H;
      if (along > 0 && perp < HIT_RADIUS && onScreen) {
        hit = true;
        len = along;
      }
    }
    this.beams.push({ t: 0, x: M.x, y: M.y, dx, dy, len });
    this._play('fire', 0.9);
    this.onFire();
    this.onLog && this.onLog('fire', { hit, angle: this.aimAngle, t: this.elapsed });

    if (hit) {
      const bx = M.x + dx * len, by = M.y + dy * len;
      this._burst(bx, by);
      m.alive = false;
      this._stopMosqSound(false);
      this.mosq = null;
      this.spawnIn = RESPAWN_DELAY;
      this.kills++;
      this.onKill(this.kills);
      this.onLog && this.onLog('kill', { kills: this.kills, t: this.elapsed });
    }
  }

  _burst(x, y) {
    const colors = ['#e8353a', '#ff8a3d', '#ffd23f', '#2b2b2b', '#ff5d4d', '#f4a21d'];
    const parts = [];
    for (let i = 0; i < 18; i++) {
      const a = rand(0, Math.PI * 2), s = rand(110, 290);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, r: rand(4, 9), c: colors[(Math.random() * colors.length) | 0], tick: false });
    }
    for (let i = 0; i < 5; i++) {
      const a = rand(0, Math.PI * 2), s = rand(60, 160);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: rand(8, 13), c: i % 2 ? '#2b2b2b' : '#ffa31a', tick: true, rot: rand(0, 6) });
    }
    this.bursts.push({ t: 0, x, y, parts });
  }

  // ---------- update ----------
  update(dt) {
    this.elapsed += dt;
    this.hintT += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.spawnIn !== null) {
      this.spawnIn -= dt;
      if (this.spawnIn <= 0) { this.spawnIn = null; this._spawn(); }
    }
    if (this.mosq) {
      this.mosq.life += dt;
      if (this.mosq.life >= CYCLE) {
        this._spawn(); // cycle ended: new mosquito + buzz restarts (matches the video's 8.6s rhythm)
      } else {
        this._placeMosq(this.mosq.life, dt);
      }
    }
    this.beams.forEach((b) => (b.t += dt));
    this.beams = this.beams.filter((b) => b.t < BEAM_LIFE);
    this.bursts.forEach((b) => {
      b.t += dt;
      b.parts.forEach((p) => {
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 1 - 2.2 * dt; p.vy = p.vy * (1 - 2.2 * dt) + 60 * dt;
      });
    });
    this.bursts = this.bursts.filter((b) => b.t < BURST_LIFE);
  }

  // ---------- render ----------
  _render() {
    const g = this.ctx2d;
    const s = this.scale * this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(s, 0, 0, s, 0, 0);
    if (!this.imgs.boy) return;

    // bed + boy
    const b = this.bed;
    g.drawImage(this.imgs.boy, b.x, b.y, b.w, b.h);

    // hint text (fades after ~4.5s like the video)
    if (this.running || this.elapsed > 0) {
      const a = clamp(1 - (this.hintT - 4.5) / 0.6, 0, 1);
      if (a > 0) {
        g.save();
        g.globalAlpha = a * 0.8;
        g.fillStyle = '#333';
        g.font = '600 21px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        g.textAlign = 'center';
        if ('letterSpacing' in g) g.letterSpacing = '1px';
        g.fillText('HOLD = AIM  •  RELEASE = FIRE', W / 2, this.H * 0.47);
        g.restore();
      }
    }

    // mosquito
    const m = this.mosq;
    if (m) this._drawMosquito(g, m);

    // aim line
    if (this.aiming && this.running) this._drawAim(g);

    // beams
    this.beams.forEach((bm) => this._drawBeam(g, bm));
    // bursts
    this.bursts.forEach((bu) => this._drawBurst(g, bu));
  }

  _drawMosquito(g, m) {
    const w = MOSQ_W, h = (w * this.imgs.mosq.height) / this.imgs.mosq.width;
    const flap = 1 + Math.sin(this.elapsed * 70) * 0.035; // wing flutter
    const tilt = clamp(Math.atan2(m.vy, Math.abs(m.vx) + 220), -0.5, 0.5) * 0.6 * m.face;
    g.save();
    g.translate(m.x, m.y);
    g.rotate(tilt);
    g.scale(m.face, flap);
    // flutter marks (like the little arcs beside the wings in the sprite sheet)
    g.strokeStyle = 'rgba(120,130,150,.35)';
    g.lineWidth = 2;
    g.beginPath();
    const o = Math.sin(this.elapsed * 70) * 2;
    g.arc(-w * 0.12, -h * 0.42, 14 + o, Math.PI * 1.15, Math.PI * 1.7);
    g.stroke();
    g.drawImage(this.imgs.mosq, -w / 2, -h / 2, w, h);
    g.restore();
  }

  _drawAim(g) {
    const M = this.muzzle, a = this.aimAngle;
    const dx = Math.cos(a), dy = Math.sin(a);
    g.save();
    g.strokeStyle = '#111';
    g.lineWidth = 4.5;
    g.setLineDash([24, 17]);
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(M.x + dx * 14, M.y + dy * 14);
    g.lineTo(M.x + dx * 3000, M.y + dy * 3000);
    g.stroke();
    g.setLineDash([]);
    // muzzle ring
    g.beginPath();
    g.arc(M.x, M.y, 11, 0, Math.PI * 2);
    g.fillStyle = '#f4f4f4';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#8c8c8c';
    g.stroke();
    g.beginPath();
    g.arc(M.x, M.y, 4, 0, Math.PI * 2);
    g.fillStyle = '#bdbdbd';
    g.fill();
    g.restore();
  }

  _drawBeam(g, bm) {
    const k = 1 - bm.t / BEAM_LIFE; // 1 → 0
    const ex = bm.x + bm.dx * bm.len, ey = bm.y + bm.dy * bm.len;
    g.save();
    g.lineCap = 'round';
    const stroke = (w, col) => {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(bm.x, bm.y);
      g.lineTo(ex, ey);
      g.stroke();
    };
    stroke(34 * (0.5 + k / 2), `rgba(255,176,120,${0.28 * k})`);
    stroke(18 * (0.4 + k / 2), `rgba(255,140,70,${0.55 * k})`);
    stroke(7 * k + 2, `rgba(255,112,45,${0.95 * k})`);
    stroke(2.5 * k + 0.5, `rgba(255,240,215,${k})`);
    // muzzle flash
    const r = 12 + 22 * k;
    const grd = g.createRadialGradient(bm.x, bm.y, 0, bm.x, bm.y, r);
    grd.addColorStop(0, `rgba(255,214,60,${k})`);
    grd.addColorStop(0.5, `rgba(255,170,30,${0.7 * k})`);
    grd.addColorStop(1, 'rgba(255,150,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(bm.x, bm.y, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  _drawBurst(g, bu) {
    const t = bu.t / BURST_LIFE; // 0 → 1
    const ringT = clamp(bu.t / 0.6, 0, 1);
    g.save();
    // expanding ring
    g.globalAlpha = clamp(1 - ringT * 1.05, 0, 1);
    g.strokeStyle = '#ffb03a';
    g.lineWidth = 9 * (1 - ringT) + 1.2;
    g.beginPath();
    g.arc(bu.x, bu.y, 14 + 56 * easeOut(ringT), 0, Math.PI * 2);
    g.stroke();
    // particles
    const pa = clamp(1 - Math.pow(t, 1.6), 0, 1);
    g.globalAlpha = pa;
    bu.parts.forEach((p) => {
      g.fillStyle = p.c;
      if (p.tick) {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot + bu.t * 2);
        g.fillRect(-p.r / 2, -1.6, p.r, 3.2);
        g.restore();
      } else {
        g.beginPath();
        g.arc(p.x, p.y, p.r * (1 - t * 0.5), 0, Math.PI * 2);
        g.fill();
      }
    });
    // +1
    const ta = clamp(1 - (bu.t - 0.35) / 0.55, 0, 1);
    g.globalAlpha = ta;
    g.fillStyle = '#222';
    g.font = '700 46px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    g.textAlign = 'center';
    g.fillText('+1', bu.x, bu.y - 30 - 26 * easeOut(clamp(bu.t / 0.8, 0, 1)));
    g.restore();
  }

  // ---------- test helpers ----------
  /** screen (client) coordinates of a logical-world point */
  worldToClient(x, y) {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + (x / W) * r.width, y: r.top + (y / this.H) * r.height };
  }
}
