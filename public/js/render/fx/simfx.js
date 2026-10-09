// public/js/render/fx/simfx.js — FxSystem placement of a sim fx event.
// Installed on FxSystem.prototype by ./system.js (a method container: never instantiated; `this` is the effect system).

import { SHOT_HEIGHT, bodyZ } from './camera.js';
import { fxSpec, tilesAround, wallTiles } from './kinds.js';
import { clamp } from './limits.js';

/**
 * An fx anchored on a unit (extra.id) is drawn at that unit's rendered position while the event's own (x, y) is within
 * this many tiles of it (it happens on the unit); farther away the fx happens at (x, y) — the sim puts the caster in
 * `id` of many area / target effects (an 'aoe' ahead of the caster, a 'crit' on the victim, 蕾缪安's 'bombard').
 */
const ANCHOR_SNAP = 0.75;

const num = (v, d) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : d; };

export class FxSim {
  // ---- sim fx (b.ev ['fx', kind, x, y, extra]) -------------------------------------------------------------

  /** Unit view of an fx's `id` / `src` / … (null when unknown or gone). */
  _viewOf(id) {
    if (id == null || !this.ctx.view) return null;
    const v = this.ctx.view(id);
    return v && !v.destroyed ? v : null;
  }

  /**
   * Where an fx happens: on its anchor unit `ex.id` (at the unit's rendered position, so it sticks to a moving unit)
   * when the event's (x, y) is that unit's spot (within ANCHOR_SNAP tiles) or has none; otherwise at (x, y) on the ground
   * — the sim often names the caster in `id` of an effect elsewhere ('aoe' at a target or ahead of the caster, 'crit'
   * on the victim, 'zone' where a skill lands), which used to be drawn on the caster.
   */
  _where(x, y, ex) {
    const v = this._viewOf(ex.id);
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
      const here = !Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(v.x - x, v.y - y) <= ANCHOR_SNAP;
      if (here) return { x: v.x, y: v.y, z: (v.z || 0) + (v.hover || 0), v };
    }
    return this._point(x, y);
  }

  /** An fx at the sim position (x, y), on the ground there. */
  _point(x, y) {
    return { x, y, z: Number.isFinite(x) && Number.isFinite(y) ? this._groundZ(x, y) : 0, v: null };
  }

  /**
   * b.ev 'fx': every kind the sim / content emits has a visual (FX_KINDS archetypes: blast, shell, zone, telegraph,
   * heal, sp, shield, shatter, summon, vanish, blink, move, wave, mark, reticle, buff, lift, sleep, crit, dodge,
   * counter, dp, coin, crate, down, beam, bolt, strike, volley, pillar, lp, chill, element, flame), except kinds whose
   * archetype is 'none' (hitCap: a leader hit cancelled by 限伤 draws nothing); unknown kinds get a generic sparkle. `extra` keys used: id (anchor unit — or the shooter of a `pt` kind), r | radius, dur | duration,
   * t (shell flight, game s), src / from / to / target / targets (unit ids), fx, fy / fromX, fromY / tx, ty (positions),
   * element, n, scale, kind, tiles, hold ('lock': the reticle waits while the shooter's skill runs).
   */
  simFx(kind, x, y, extra) {
    const ex = extra && typeof extra === 'object' ? extra : {};
    const spec = fxSpec(kind, ex);
    if (spec.a === 'none') return; // an event the screen does not show (hitCap)
    const at = spec.pt ? this._point(Number(x), Number(y)) : this._where(Number(x), Number(y), ex);
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    // 蕾缪安 S2: the aimed snipe ('crit' on the locked enemy, from her) ends that aim lock
    if (kind === 'crit' && ex.src != null && ex.id != null) {
      for (const L of this.locks) if (L.src === ex.src && L.id === ex.id) this._releaseLock(L);
    }
    const col = spec.c;
    const r = clamp(num(ex.r ?? ex.radius, spec.r ?? 1), 0.3, 30);
    const ts = this.ctx.timeScale ? Math.max(0.25, this.ctx.timeScale()) : 2;
    const dur = num(ex.dur ?? ex.duration, spec.dur ?? 0) / ts;
    const cam = this.ctx.cam();
    const chest = (v, out = this._p) => (v ? this._chest(v, out) : cam.project(at.x, at.y, at.z + 0.5, out));
    const p = chest(at.v);
    const s = p.s;
    switch (spec.a) {
      case 'blast': {
        if (r >= 12) { this.flashScreen(col, 0.5); break; }
        if (kind === 'bombard') { this._touchLocks(ex.id ?? ex.src ?? null); this._landed(ex.id ?? ex.src ?? null, at.x, at.y, r); }
        this.explosion(at.x, at.y, at.z, r, col, { smoke: spec.smoke, heavy: !!spec.heavy, tiles: ex.tiles ? tilesAround(at.x, at.y, r, ex.tiles) : null });
        break;
      }
      case 'shell': {
        // 蕾缪安 S3: a shell fired now by `id` that lands at (x, y) after `t` game seconds (its 'bombard' explodes there)
        const flight = num(ex.t ?? ex.flight ?? ex.dur ?? ex.duration, 1) / ts;
        this._touchLocks(ex.id ?? ex.src ?? null);
        this.mortar(this._viewOf(ex.id ?? ex.src), at.x, at.y, r, flight);
        break;
      }
      // `key`: one zone the sim re-sends as it moves / grows (an update in place, never a second layer — zones.js)
      case 'zone': this.zone(at.x, at.y, at.z, r, col, Math.max(0.6, dur || 1.5), spec.tex, false, ex.key != null ? String(ex.key) : null); break;
      case 'wall': {
        // a line of burning tiles through the anchor tile along `axis` ('col' | 'row', from the sim event)
        const rect = this.ctx.fieldRect ? this.ctx.fieldRect() : null;
        this.tileFlash(wallTiles(Number(x), Number(y), ex.axis === 'row' ? 'row' : 'col', rect), col, Math.max(0.6, dur || 1.5));
        this.zone(at.x, at.y, at.z, 0.6, col, Math.max(0.6, dur || 1.5), spec.tex);
        break;
      }
      case 'telegraph': {
        const d = Math.max(0.4, dur || 1);
        if (r >= 12) { this.flashScreen(col, 0.45, d); break; }
        if (ex.tiles) this.tileFlash(tilesAround(at.x, at.y, r, ex.tiles), col, d, true);
        else this.zone(at.x, at.y, at.z, r, col, d, 'ring', true);
        break;
      }
      case 'chill': this.flashScreen(col, 0.35, 0.8); this.snowfall(col); break;
      case 'heal': this.heal(at.v || { x: at.x, y: at.y, z: at.z }, 0); break;
      case 'healAoe': {
        this.ring(at.x, at.y, at.z, 0.2, r, col, 0.6);
        const n = this.quality === 'low' ? 4 : 9;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.85;
          const q = cam.project(at.x + Math.cos(a) * d, at.y + Math.sin(a) * d, at.z + 0.2);
          this.particle('plus', q.x, q.y, { tint: col, vy: -q.s * 0.9, life: 0.8, s0: q.s / 64 * 0.3, s1: q.s / 64 * 0.18, a0: 0.9, a1: 0, fadeIn: 0.1 });
        }
        break;
      }
      case 'sp': {
        for (let i = 0; i < (this.quality === 'low' ? 3 : 7); i++) {
          this.particle('dot', p.x + (Math.random() - 0.5) * s * 0.6, p.y + (Math.random() - 0.2) * s * 0.4, { tint: col, vy: -s * (0.6 + Math.random() * 0.6), life: 0.7, s0: s / 32 * 0.2, s1: 0, a0: 1, a1: 0, fadeIn: 0.05 });
        }
        this.particle('glow', p.x, p.y, { tint: col, life: 0.3, s0: s / 128 * 0.6, s1: s / 128 * 1.1, a0: 0.7, a1: 0 });
        break;
      }
      case 'shield': {
        // 斩业星熊 S2「无始无明」的投盾：
        //   `hsgma2ShieldSpawn` 只在投出那一刻发一次；`hsgma2Shield` 按**角度步进**发
        //   （服务端的 `SHIELD_EMIT_DEG`，约 5 次/s；被绊住慢下来时约 1 次/s）。
        // 用官方**径向光晕**做底光；投出瞬间额外叠一发官方**星爆**。
        // （两张都是从日服客户端解包出来的贴图，见 `textures.js` 的 `jpFxTextures()`。）
        //
        // ⚠️ 粒子数要克制：`life` 0.36 s × 5 次/s ≈ 同时存活 2 个；且**只有一层 halo**
        //    （这里原本还叠 `hex` + `glow` 两个加色粒子，在逐帧发射时糊成一团白 ——
        //     用户反馈「盾粒子效果太厚」）。要更亮就调 halo 的 `a0`/`s0`，
        //    **不要再加回粒子层数**，否则又会饱和。
        const isSpawn = p.skill === 'hsgma2ShieldSpawn';
        this.particle('jpHalo', p.x, p.y, { tint: col, life: isSpawn ? 0.5 : 0.36, s0: s / 256 * 1.5, s1: s / 256 * (isSpawn ? 2.4 : 1.8), a0: isSpawn ? 0.9 : 0.62, a1: 0 });
        if (isSpawn) {
          this.particle('jpBurst', p.x, p.y, { tint: col, life: 0.42, s0: s / 256 * 1.1, s1: s / 256 * 1.9, a0: 0.95, a1: 0, spin: 0.5 });
        }
        break;
      }
      case 'shatter': {
        this.particle('hex', p.x, p.y, { tint: col, life: 0.25, s0: s / 128 * 1.1, s1: s / 128 * 1.5, a0: 0.9, a1: 0 });
        for (let i = 0; i < (this.quality === 'low' ? 5 : 12); i++) {
          const a = Math.random() * Math.PI * 2;
          this.particle('shard', p.x + Math.cos(a) * s * 0.3, p.y + Math.sin(a) * s * 0.3, { tint: col, vx: Math.cos(a) * s * 1.6, vy: Math.sin(a) * s * 1.2 - s * 0.3, g: s * 3, life: 0.55, s0: s / 32 * 0.16, s1: s / 32 * 0.05, a0: 1, a1: 0, spin: (Math.random() - 0.5) * 12 });
        }
        break;
      }
      case 'summon': {
        const g = cam.project(at.x, at.y, at.z);
        this.particle('pillar', g.x, g.y, { tint: col, life: 0.55, s0: g.s / 64 * 0.8, s1: g.s / 64 * 0.3, a0: 0.9, a1: 0, sx: 1, ay: 1 });
        this.ring(at.x, at.y, at.z, 0.1, 0.9, col, 0.5, 'hex');
        this.burst(g.x, g.y - g.s * 0.3, g.s, 8, col, { speed: 1.4, up: 0.8, life: 0.5, tex: 'dot' });
        break;
      }
      case 'vanish': {
        this.particle('glow', p.x, p.y, { tint: col, life: 0.4, s0: s / 128 * 0.7, s1: s / 128 * 1.5, a0: 0.8, a1: 0 });
        this.smoke(p.x, p.y, s * 0.7, 0x2c2436, 0.5);
        this.burst(p.x, p.y, s, 7, col, { speed: 1.5, tex: 'dot', life: 0.45 });
        break;
      }
      case 'blink': {
        const fx0 = num(ex.fx ?? ex.fromX, NaN), fy0 = num(ex.fy ?? ex.fromY, NaN);
        if (Number.isFinite(fx0) && Number.isFinite(fy0)) {
          const q = cam.project(fx0, fy0, at.z + 0.5, this._q);
          this.smoke(q.x, q.y, q.s * 0.6, 0x2c2436, 0.45);
          this.particle('glow', q.x, q.y, { tint: col, life: 0.3, s0: q.s / 128 * 0.8, s1: q.s / 128 * 0.2, a0: 0.8, a1: 0 });
          this.streak(fx0, fy0, at.x, at.y, at.z + 0.5, col, 0.3);
        }
        this.particle('glow', p.x, p.y, { tint: col, life: 0.35, s0: s / 128 * 0.3, s1: s / 128 * 1.2, a0: 0.9, a1: 0 });
        this.burst(p.x, p.y, s, 6, col, { speed: 1.4, tex: 'dot', life: 0.4 });
        break;
      }
      case 'move': {
        const fx0 = num(ex.fromX ?? ex.fx ?? ex.x0, NaN), fy0 = num(ex.fromY ?? ex.fy ?? ex.y0, NaN);
        const tx = num(ex.tx, NaN), ty = num(ex.ty, NaN);
        if (Number.isFinite(fx0) && Number.isFinite(fy0)) this.streak(fx0, fy0, at.x, at.y, at.z + 0.35, col, 0.35);
        else if (Number.isFinite(tx) && Number.isFinite(ty)) this.streak(at.x, at.y, tx, ty, at.z + 0.35, col, 0.35);
        const g = cam.project(at.x, at.y, at.z + 0.05);
        for (let i = 0; i < (this.quality === 'low' ? 2 : 5); i++) {
          this.particle('smoke', g.x + (Math.random() - 0.5) * g.s * 0.5, g.y, { add: false, tint: 0x6b6358, vx: (Math.random() - 0.5) * g.s * 0.6, vy: -g.s * 0.2, drag: 2, life: 0.5, s0: g.s / 128 * 0.25, s1: g.s / 128 * 0.55, a0: 0.45, a1: 0 });
        }
        break;
      }
      case 'wave': {
        const k = clamp(num(ex.scale, 1), 0.5, 4);
        const rr = Math.max(0.8, r * (ex.scale ? Math.min(2, k / 2) : 1));
        for (let i = 0; i < 3; i++) this.ring(at.x, at.y, at.z, 0.15 + i * 0.15, rr * (0.7 + i * 0.25), col, 0.45 + i * 0.12);
        this.particle('glow', p.x, p.y, { tint: col, life: 0.3, s0: s / 128 * 0.5, s1: s / 128 * 1.2, a0: 0.7, a1: 0 });
        break;
      }
      case 'mark': case 'reticle': {
        if (kind === 'lock') {
          // `id` is always the locked enemy: the reticle sticks to its view even a little off the event's spot
          // (`hold`: 蕾缪安 S3 — the reticle waits while her skill runs, however long nothing is in range)
          const lv = at.v || this._viewOf(ex.id);
          this._touchLocks(ex.src ?? null);
          this._lock(lv, ex.src ?? null, lv ? lv.x : at.x, lv ? lv.y : at.y, lv ? bodyZ(cam, lv, SHOT_HEIGHT.aim) : at.z + 0.55, !!ex.hold);
          break;
        }
        const v = at.v;
        const hz = v ? (v.z || 0) + (v.hover || 0) + (v._headTiles || 1.2) + 0.25 : at.z + 1.4;
        const q = cam.project(at.x, at.y, hz, this._q);
        if (spec.a === 'mark') {
          this.particle('glow', q.x, q.y, { tint: col, life: 0.6, s0: q.s / 128 * 0.5, s1: q.s / 128 * 0.7, a0: 0.8, a1: 0 });
          this.numberAt(q.x, q.y, '!', col, 0.8);
        } else {
          this.particle('ring', p.x, p.y, { tint: col, life: 0.6, s0: s / 128 * 1.3, s1: s / 128 * 0.7, a0: 0.95, a1: 0, spin: 3 });
          this.particle('hex', p.x, p.y, { tint: col, life: 0.6, s0: s / 128 * 0.5, s1: s / 128 * 0.9, a0: 0.8, a1: 0, spin: -2 });
        }
        break;
      }
      case 'buff': {
        const g = cam.project(at.x, at.y, at.z + 0.05);
        const n = this.quality === 'low' ? 3 : 6;
        for (let i = 0; i < n; i++) {
          const ox = (Math.random() - 0.5) * g.s * 0.7;
          this.particle('chevron', g.x + ox, g.y - g.s * (0.1 + Math.random() * 0.5), { tint: col, vy: -g.s * (1 + Math.random() * 0.5), life: 0.65, s0: g.s / 64 * 0.22, s1: g.s / 64 * 0.12, a0: 0.95, a1: 0, rot: -Math.PI / 2, fadeIn: 0.06 });
        }
        this.ring(at.x, at.y, at.z, 0.2, 0.75, col, 0.4);
        this.particle('glow', p.x, p.y, { tint: col, life: 0.35, s0: s / 128 * 0.6, s1: s / 128 * 1.1, a0: 0.6, a1: 0 });
        break;
      }
      case 'lift': {
        const g = cam.project(at.x, at.y, at.z);
        this.ring(at.x, at.y, at.z, 0.2, 0.8, col, 0.5);
        for (let i = 0; i < (this.quality === 'low' ? 3 : 7); i++) {
          this.particle('streak', g.x + (Math.random() - 0.5) * g.s * 0.6, g.y - g.s * Math.random() * 0.4, { tint: col, vy: -g.s * 1.8, life: 0.4, s0: g.s / 128 * 0.4, s1: g.s / 128 * 0.2, a0: 0.8, a1: 0, rot: -Math.PI / 2, sx: 1 });
        }
        break;
      }
      case 'sleep': {
        const v = at.v;
        const hz = v ? (v.z || 0) + (v._headTiles || 1.2) : at.z + 1.2;
        const q = cam.project(at.x + 0.2, at.y, hz, this._q);
        for (let i = 0; i < 3; i++) this.particle('st_sleep', q.x + i * q.s * 0.12, q.y - i * q.s * 0.12, { add: false, vy: -q.s * 0.5, vx: q.s * 0.15, life: 0.9 + i * 0.2, s0: q.s / 32 * 0.22, s1: q.s / 32 * 0.32, a0: 1, a1: 0, fadeIn: 0.1 * i });
        break;
      }
      case 'crit': {
        this.particle('spark', p.x, p.y, { tint: col, life: 0.28, s0: s / 64 * 1.3, s1: s / 64 * 0.2, a0: 1, a1: 0, rot: Math.random() * Math.PI });
        this.particle('glow', p.x, p.y, { tint: 0xffffff, life: 0.18, s0: s / 128 * 0.9, s1: s / 128 * 1.4, a0: 0.9, a1: 0 });
        this.burst(p.x, p.y, s, 8, col, { speed: 3.2, life: 0.3, size: 0.5 });
        break;
      }
      case 'dodge': {
        this.particle('soft', p.x, p.y, { tint: 0xffffff, life: 0.3, s0: s / 128 * 0.5, s1: s / 128 * 0.9, a0: 0.5, a1: 0 });
        this.particle('slash', p.x, p.y, { tint: col, life: 0.22, s0: s / 128 * 0.8, s1: s / 128 * 1.1, a0: 0.7, a1: 0, rot: -0.5 });
        break;
      }
      case 'counter': {
        // 陈 S3「赤霄·天喟」的龙：叠官方**星爆 + 火焰须 + 速度光带**。
        // 三张都是从日服客户端解包出来的贴图（见 `textures.js` 的 `jpFxTextures()`）。
        // ⚠️ 只有这一条路径加 —— 普通近战挥砍也走 'counter'，不能给它加（会显脏）。
        // 🔴 2026-10-06（B，按 C 的玩法单 §1）：原来只匹配 `chen3Dragon`（**龙头**），于是
        //    `reserve-chen3.js:284` 里 **i>0 的龙身段**（标 `chen3DragonBody`）整段**没有**官方叠图——
        //    可那条是按**同款**逐段画的，只把首段标成 `chen3Dragon` ⇒ **龙头华丽、龙身素**，
        //    这正是用户"看不到龙"观感的一半。现在**龙头与龙身段一并叠**。
        //    下面两种**刻意不叠**（免得后人以为是漏了）：
        //      · `chen3DragonTurn`（`reserve-chen3.js:247`）—— 那是**转向**提示，不是龙的段；
        //      · `chen3DragonSpawn`（`:294`/`:394`）—— 那是**出生光束**，走下面的 `case 'beam'`，
        //        本身就带三通道光束 + 端点 `flare`（`_beam()` 里加的）；点是点、线是线，不混。
        //    判据：`test/render/chen3dragon.test.js` 的 A/B/C（A 是假绿哨兵、C 是"不许蹭"哨兵）。
        // 🔴 2026-10-06（B，用户 06:3x 实机反馈）：「陈 3 技能的剑气（龙）看上去**太晃眼睛**了，
        //    看上去也**不够清晰**」。根因是**发事件的频率**与**单段的亮度**相乘：
        //    `reserve-chen3.js:282-291` 的那组 `fx('slash', …)` 在 `while (d.acc >= 1)` **之外**
        //    ⇒ 龙是**逐段（3 段）× 每一帧**发，不是"每 hit 一次"。原来单段这一组共 9 个粒子、
        //    其中 **9 个的起手不透明度 a0 ≥ 0.8**（jpBurst 1 / spark 1 / burst×4 全 1 / jpFlame .9 /
        //    jpFlare .85 / slash .9），还叠了**两种色温**（冷蓝 0xbfe4ff 与暖白 0xffd9c0）互相打架，
        //    放大倍率最高到 2.4 ⇒ 段数 × 帧率一乘就是"糊成一团亮"，而龙本体（Spine 白刃段，
        //    **不在本文件**）被这层亮斑盖住 —— 这两句抱怨是同一个根因。
        //    现在：叠图**统一成一种色温**（暖白 0xffd9c0）+ 压到半透明 + 放大倍率 ≤ 2；
        //    整段的 spark/slash/burst 也**只在龙这条路上**收一档（普通近战每 hit 只发一次，**保持原样**）。
        //    判据：`test/render/chen3dragon.test.js` 的 D/E/F/G（亮度 / 色温 / 倍率 / 全不透明计数）
        //    与 H（哨兵：龙的折扣不许泄漏到普通近战）。
        const dragon = /^chen3Dragon(Body)?$/.test(ex.skill || '');
        if (dragon) {
          // 一种色温走到底（原来 jpBurst 用 col、jpFlame 冷蓝、jpFlare 暖白 = 三种底色打架）
          const t = 0xffd9c0;
          this.particle('jpBurst', p.x, p.y, { tint: t, life: 0.34, s0: s / 256 * 1.0, s1: s / 256 * 1.5, a0: 0.45, a1: 0, spin: 0.7 });
          this.particle('jpFlame', p.x, p.y - s * 0.12, { tint: t, life: 0.34, s0: s / 64 * 0.7, s1: s / 64 * 1.0, a0: 0.4, a1: 0, vy: -s * 1.1 });
          this.particle('jpFlare', p.x, p.y, { tint: t, life: 0.22, s0: s / 64 * 1.2, s1: s / 64 * 1.5, a0: 0.35, a1: 0, rot: 0 });
        }
        const dim = dragon ? 0.5 : 1; // 龙逐段每帧发 ⇒ 单段再收一档；普通近战不许受影响
        this.particle('spark', p.x, p.y, { tint: col, life: 0.22, s0: s / 64 * 0.9, s1: 0, a0: dim, a1: 0 });
        this.particle('slash', p.x, p.y, { tint: col, life: 0.22, s0: s / 128 * 0.9, s1: s / 128 * 1.2, a0: 0.9 * dim, a1: 0, rot: 0.6 });
        this.burst(p.x, p.y, s, 4, col, { speed: 2.4, life: 0.25, a0: dim });
        break;
      }
      case 'dp': {
        const n = Math.round(num(ex.n, 0));
        this.particle('shard', p.x, p.y, { tint: col, vy: -s * 0.6, life: 0.9, s0: s / 32 * 0.28, s1: s / 32 * 0.22, a0: 1, a1: 0 });
        if (n > 0) this.numberAt(p.x + s * 0.2, p.y, `+${n}`, col, 0.7);
        break;
      }
      case 'coin': {
        for (let i = 0; i < 4; i++) this.particle('coin', p.x + (Math.random() - 0.5) * s * 0.4, p.y, { add: false, vx: (Math.random() - 0.5) * s, vy: -s * (1.2 + Math.random() * 0.6), g: s * 4, life: 0.7, s0: s / 48 * 0.2, s1: s / 48 * 0.16, a0: 1, a1: 0.2 });
        break;
      }
      case 'crate': this.crateBreak(at.x, at.y, at.z); break;
      case 'down': {
        this.smoke(p.x, p.y, s * 0.6, spec.smoke ?? 0x1a1a1a, 0.5);
        this.burst(p.x, p.y, s, 5, col, { speed: 1.2, tex: 'dot', life: 0.5, g: 2 });
        break;
      }
      case 'beam': case 'bolt': {
        // ⚠️ 这里原来**只认单位视图**（`ex.from/src/to/target`），解析不到就退化成 `strike()`
        //    —— 于是「陈 S3 的龙」**一条光都画不出来**：它的载荷给的是**坐标** `tx/ty`
        //    （`reserve-chen3.js` 的 4 处 `fx('beam', {x, y, tx, ty, …})`），没有单位 id。
        //    用户实机反馈「陈的剑气（龙）没有任何特效和表现」，C 的玩法问题单 ① 定位到这里。
        //    修法：**带坐标载荷的光束也参与解析** —— 用 `_point(tx, ty)` 造一个世界坐标点；
        //    下游 `_bodyPt(view, …)` 本来就只读 `view.x/y/z`，纯坐标对象完全够用。
        //    ⚠️ 只走「**确实带 tx/ty**」这条新路，**其余情形保持原逻辑不变**
        //       （例如某些 `bolt` 依赖"解析不到就 strike"的退化行为，不能被我顺手改掉）。
        const hasPt = Number.isFinite(ex.tx) && Number.isFinite(ex.ty);
        let a = this._viewOf(ex.from ?? ex.src);
        let b = this._viewOf(ex.to ?? ex.target);
        if (hasPt && !b) {
          // 起点：优先单位，其次事件自带坐标（龙的两处都是陈自己的坐标），最后锚点
          if (!a) a = (Number.isFinite(ex.x) && Number.isFinite(ex.y)) ? this._point(ex.x, ex.y) : at.v;
          b = this._point(ex.tx, ex.ty);
        } else {
          if (!a) a = spec.a === 'bolt' ? null : at.v;
          if (!b) b = a === at.v ? null : at.v;
        }
        if (a && b && a !== b) this._beam(a, b, col, spec.a === 'bolt' ? 0.28 : 0.4, spec.a === 'bolt' ? 1 : 0.4);
        else this.strike(at.x, at.y, at.z, col);
        break;
      }
      case 'flame': {
        // at the event's spot (the locked target), not snapped onto the dragon hovering 0.25 tile from it
        const fx0 = Number(x), fy0 = Number(y);
        this._flame(ex.id ?? ex.src ?? null, ex.target ?? ex.to ?? null, fx0, fy0, r, col, Math.max(0.2, dur || 0.5));
        break;
      }
      case 'strike': case 'pillar': this.strike(at.x, at.y, at.z, col, spec.a === 'pillar'); break;
      case 'volley': {
        const list = Array.isArray(ex.targets) ? ex.targets.slice(0, 12) : [];
        const src = this._viewOf(ex.src ?? ex.id);
        for (const id of list) {
          const t = this._viewOf(id);
          if (!t) continue;
          if (src && src !== t) this.attack(src, t, 'arrow');
          else { const q = this._chest(t, this._q); this.burst(q.x, q.y, q.s, 4, col, { speed: 2, life: 0.3 }); }
        }
        if (!list.length) this.burst(p.x, p.y, s, 6, col, { speed: 2.4, life: 0.35 });
        break;
      }
      case 'lp': this.leak(); break;
      case 'element': {
        const el = ex.element;
        const c2 = el === 'burn' ? 0xff7a33 : el === 'neural' ? 0xff5ad0 : el === 'necrosis' || el === 'apoptosis' ? 0x9dff6a : el === 'erosion' ? 0x6fe0ff : col;
        this.particle('glow', p.x, p.y, { tint: c2, life: 0.45, s0: s / 128 * 1.2, s1: s / 128 * 2.6, a0: 1, a1: 0 });
        this.ring(at.x, at.y, at.z, 0.2, 1.5, c2, 0.55);
        this.burst(p.x, p.y, s, 12, c2, { speed: 3, life: 0.5 });
        break;
      }
      default: {
        this.particle('spark', p.x, p.y, { tint: col, life: 0.35, s0: s / 64 * 0.6, s1: 0, a0: 0.9, a1: 0, rot: Math.random() });
        this.particle('glow', p.x, p.y, { tint: col, life: 0.3, s0: s / 128 * 0.4, s1: s / 128 * 0.9, a0: 0.6, a1: 0 });
        this.burst(p.x, p.y, s, 4, col, { speed: 1.6, tex: 'dot', life: 0.35 });
      }
    }
  }
}
