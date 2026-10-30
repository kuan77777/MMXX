// NPC 管理器（Director）：负责"生几个、在哪生、什么时候不要了"，以及按距离降频更新。
// 与 Npc 的分工：Npc 只管一个角色的行为；Director 管数量上限、LOD、回收与存档。

import { Npc } from './npc.js';

const TWO_PI = Math.PI * 2;

export class NpcDirector {
  /**
   * @param {object} ctx {
   *   config, nav, collision, scene,
   *   createCharacter(cfg, index) -> Character,
   *   onDeath(npc), playSound(name, opts), emitSound(x,z,loudness)
   * }
   */
  constructor(THREE, ctx = {}) {
    this.THREE = THREE;
    this.ctx = ctx;
    this.cfg = ctx.config || {};
    this.nav = ctx.nav || null;
    this.collision = ctx.collision || null;
    this.npcs = [];
    this.byId = new Map();
    this.zones = [];
    this._spawnTimer = 0;
    this._nextIndex = 0;
    this._rng = mulberry32((this.cfg.seed || 12345) ^ 0x5f3759df);
    this.stats = { spawned: 0, despawned: 0, updates: 0, skipped: 0, frozen: 0 };
    this.ai = this.cfg.ai || {};
  }

  setZones(zones) { this.zones = Array.isArray(zones) ? zones : []; }

  get counts() {
    let z = 0, f = 0, h = 0;
    for (const n of this.npcs) {
      if (!n.alive) continue;
      if (n.type === 'zombie') z += 1;
      else if (n.type === 'friendly') f += 1;
      else h += 1;
    }
    return { zombie: z, friendly: f, hostile: h, total: this.npcs.length };
  }

  _limit(type) {
    const ai = this.ai;
    if (type === 'zombie') return ai.maxZombies != null ? ai.maxZombies : 34;
    if (type === 'friendly') return ai.maxFriendlies != null ? ai.maxFriendlies : 10;
    return ai.maxHostiles != null ? ai.maxHostiles : 8;
  }

  /** 在区域里找一个可站立的点。 */
  _pickPoint(zone) {
    for (let i = 0; i < 12; i += 1) {
      const a = this._rng() * TWO_PI;
      const r = Math.sqrt(this._rng()) * Math.max(2, zone.radius || 10);
      const x = zone.x + Math.cos(a) * r;
      const z = zone.z + Math.sin(a) * r;
      if (!this.collision || !this.collision.blockedAt(x, z, 0.4, 0, 1.7)) {
        if (!this.nav || this.nav.isWalkableWorld(x, z)) return { x, z };
      }
    }
    if (this.nav) {
      const near = this.nav.nearestWalkable(zone.x, zone.z, Math.max(6, zone.radius || 10));
      if (near) return near;
    }
    return { x: zone.x, z: zone.z };
  }

  spawn(cfgOverrides = {}) {
    const index = this._nextIndex++;
    const npcCfg = this.ctx.makeConfig
      ? this.ctx.makeConfig(cfgOverrides, index)
      : cfgOverrides;
    if (!npcCfg || !npcCfg.id) return null;
    if (this.byId.has(npcCfg.id)) return this.byId.get(npcCfg.id);

    const character = this.ctx.createCharacter ? this.ctx.createCharacter(npcCfg, index) : null;
    const npc = new Npc(npcCfg, {
      character,
      nav: this.nav,
      rng: this._rng,
      faction: npcCfg.factionId,
      groundAt: this.ctx.groundAt || null,
    });
    if (character && this.ctx.scene) {
      this.ctx.scene.add(character.group);
      character.setPosition(npc.x, npc.y, npc.z);
    }
    this.npcs.push(npc);
    this.byId.set(npc.id, npc);
    this.stats.spawned += 1;
    return npc;
  }

  /** 按区域把 NPC 补到上限。只在玩家附近"看得见的地方"之外生成，避免凭空出现。 */
  tickSpawns(now, playerPos) {
    const counts = this.counts;
    const ai = this.ai;
    const minR = ai.spawnRadiusMin || 26;
    const maxR = ai.spawnRadiusMax || 95;
    let spawnedNow = 0;
    for (const zone of this.zones) {
      if (spawnedNow >= 3) break; // 每帧最多补 3 个，避免卡帧
      const type = zone.type;
      if ((counts[type] || 0) >= this._limit(type)) continue;
      if (zone.count != null && this.npcs.filter((n) => n.zoneId === zone.id).length >= zone.count) continue;
      // 玩家离区域中心太远就不刷（分区管理，省性能）
      if (playerPos && zone.radius != null) {
        const d = Math.hypot(zone.x - playerPos.x, zone.z - playerPos.z);
        if (d > maxR + zone.radius) continue;
      }
      const p = this._pickPoint(zone);
      if (playerPos) {
        const d = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
        if (d < minR) continue;
      }
      const npc = this.spawn(Object.assign({}, this.ctx.zoneDefaults ? this.ctx.zoneDefaults(zone) : {}, {
        id: `${zone.id}_${type}_${this._nextIndex}`,
        type,
        spawnPosition: { x: p.x, y: 0, z: p.z },
        patrolRoute: zone.patrolRoute || [],
      }));
      if (npc) {
        npc.zoneId = zone.id;
        counts[type] = (counts[type] || 0) + 1;
        spawnedNow += 1;
      }
    }
  }

  /**
   * 每帧更新：按距离决定更新频率（近 20Hz / 中 6Hz / 远 1.5Hz），
   * 超出动画距离的冻结骨骼计算，超出 despawnRadius 的回收。
   */
  update(dt, now, world, playerPos) {
    const ai = this.ai;
    // 感知倍率（天气/夜色）每帧缓存一份：broadcastSound 是音效→AI 的入口，
    // 它拿不到 world，但必须用与视觉同一套" environnement 数字"。
    this.perception = (world && world.perception) || { sight: 1, hearing: 1 };
    const nearD = ai.nearUpdateDistance || 26;
    const midD = ai.midUpdateDistance || 65;
    const nearHz = ai.nearHz || 20;
    const midHz = ai.midHz || 6;
    const farHz = ai.farHz || 1.5;
    const animD = ai.animDistance || 45;
    const despawnR = ai.despawnRadius || 130;

    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = 1.0;
      this.tickSpawns(now, playerPos);
    }

    const keep = [];
    for (const npc of this.npcs) {
      const d = playerPos ? Math.hypot(npc.x - playerPos.x, npc.z - playerPos.z) : 0;
      // 回收
      if (npc.shouldDespawn(now, d, despawnR)) {
        this.stats.despawned += 1;
        if (npc.char) { npc.char.dispose(); }
        this.byId.delete(npc.id);
        continue;
      }
      keep.push(npc);

      // 动画 LOD
      if (npc.char) {
        const frozen = d > animD;
        npc.char.animator.setFrozen(frozen);
        if (frozen) this.stats.frozen += 1;
      }

      if (!npc.alive) continue;

      // AI 频率 LOD：累积到间隔再跑一次逻辑，dt 传累积值保证速度一致
      const hz = d < nearD ? nearHz : (d < midD ? midHz : farHz);
      npc._accum = (npc._accum || 0) + dt;
      const interval = 1 / Math.max(0.2, hz);
      if (npc._accum < interval) { this.stats.skipped += 1; continue; }
      const step = Math.min(0.5, npc._accum);
      npc._accum = 0;
      npc.update(step, world);
      this.stats.updates += 1;
    }
    this.npcs = keep;
  }

  /** 角色自己的动画也要推进（AI 逻辑降频，但骨骼动画仍按帧插值，否则远处会一顿一顿）。 */
  updateAnimations(dt, playerPos) {
    for (const npc of this.npcs) {
      if (!npc.char) continue;
      const d = playerPos ? Math.hypot(npc.x - playerPos.x, npc.z - playerPos.z) : 0;
      npc.char.update(dt, d, this.ai.animDistance || 45);
    }
  }

  damageNpc(npc, amount, source) {
    if (!npc || !npc.alive) return false;
    // 防御：调用方可能误传了玩家代理对象
    if (typeof npc.onDamaged !== 'function') return false;
    const died = npc.onDamaged(amount, this.ctx.now ? this.ctx.now() : 0, source);
    if (died && this.ctx.onDeath) this.ctx.onDeath(npc, source);
    return died;
  }

  nearestHostileTo(x, z, radius) {
    let best = null;
    let bestD = radius * radius;
    for (const n of this.npcs) {
      if (!n.alive) continue;
      if (n.type !== 'zombie' && n.type !== 'hostile') continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /** 广播声音事件（枪声会引来一片僵尸）。 */
  broadcastSound(x, z, loudness, tag) {
    let heard = 0;
    for (const n of this.npcs) {
      if (!n.alive) continue;
      if (n.hear(x, z, loudness, { now: this.ctx.now ? this.ctx.now() : 0 })) heard += 1;
    }
    return heard;
  }

  forgetDead(now) {
    const out = [];
    for (const n of this.npcs) {
      if (!n.alive && now - n.deadAt > (this.ai.corpseLifetime || 45)) {
        if (n.char) n.char.dispose();
        continue;
      }
      out.push(n);
    }
    this.npcs = out;
  }

  serialize() {
    return {
      npcs: this.npcs.filter((n) => !n.alive).map((n) => n.serialize()),
      counts: this.counts,
    };
  }

  /** 恢复"已死亡 NPC"的状态：只记录谁死了，不重建整个场景。 */
  restoreDead(list) {
    if (!Array.isArray(list)) return;
    for (const rec of list) {
      if (!rec || !rec.id) continue;
      this._deadIds = this._deadIds || new Set();
      this._deadIds.add(rec.id);
    }
  }

  isDeadId(id) { return !!(this._deadIds && this._deadIds.has(id)); }

  dispose() {
    for (const n of this.npcs) { if (n.char) n.char.dispose(); }
    this.npcs.length = 0;
    this.byId.clear();
  }
}

function mulberry32(a) {
  let t = a >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export default { NpcDirector };
