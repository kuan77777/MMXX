// NPC 行为：三类 NPC 共用一套状态机骨架，但**状态集合与转移条件由 type 决定**，
// 不是"所有 NPC 跑同一段逻辑"。
//
// 僵尸：   idle / wander / patrol / investigate / chase / attack / search / return / stagger / dead
// 友方：   idle / wander / patrol / follow / flee / investigate / interact / combat / returnToBase / dead
// 敌对：   patrol / investigate / engage / takeCover / retreat / search / dead
//
// 感知：视角 + 距离 + 射线遮挡（视线不能穿墙）；听觉事件（枪声/跑步/开门）会吸引调查。
// 目标丢失：先走到**最后看到的点**，再在原地有限时间搜索，然后返回活动区域。
// 性能：更新频率由 director 按距离决定；本类内部只做 O(一次寻路/chase) 的轻量工作。

import { PathFollower } from '../navigation/navgrid.js';
import { makeNpcConfig } from './npc-config.js';

const TWO_PI = Math.PI * 2;

function normAngle(a) {
  let x = a;
  while (x > Math.PI) x -= TWO_PI;
  while (x < -Math.PI) x += TWO_PI;
  return x;
}

function dist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

export const ZOMBIE_STATES = ['idle', 'wander', 'patrol', 'investigate', 'chase', 'attack', 'search', 'return', 'stagger', 'dead'];
export const FRIENDLY_STATES = ['idle', 'wander', 'patrol', 'follow', 'flee', 'investigate', 'interact', 'combat', 'returnToBase', 'dead'];
export const HOSTILE_STATES = ['patrol', 'investigate', 'engage', 'takeCover', 'retreat', 'search', 'dead'];

export class Npc {
  /**
   * @param {object} config 已校验的 NPC 配置（makeNpcConfig 的输出）
   * @param {object} deps { character, nav, rng, faction, name }
   */
  constructor(config, deps = {}) {
    this.cfg = config || makeNpcConfig({}, 0);
    this.char = deps.character || null;
    this.nav = deps.nav || null;
    this.rng = deps.rng || Math.random;
    this.faction = deps.faction || null;
    // 地面高度查询（真实地形时才给；平地小镇返回 0）
    this.groundAt = deps.groundAt || null;

    this.id = this.cfg.id;
    this.type = this.cfg.type;
    this.name = this.cfg.name;

    this.x = this.cfg.spawnPosition.x;
    this.z = this.cfg.spawnPosition.z;
    this.y = 0;
    this.yaw = this.rng() * TWO_PI;
    this.home = { x: this.x, z: this.z };

    this.health = this.cfg.health;
    this.maxHealth = this.cfg.health;
    this.alive = true;
    this.deadAt = 0;

    this.state = this.type === 'zombie' ? 'idle' : (this.type === 'hostile' ? 'patrol' : 'idle');
    this.stateTime = 0;
    this.stateEnteredAt = 0;

    this.follower = new PathFollower({ nav: this.nav, arriveRadius: this.type === 'zombie' ? 0.9 : 0.7 });
    this._repathAt = 0;
    this._lastPathGoal = null;
    this._stuckCount = 0;

    this.lastKnown = null;       // 最后看到目标的位置
    this.searchUntil = 0;
    this.investigateUntil = 0;
    this.alertness = 0;          // 0..1，影响听觉灵敏度与移动速度
    this.nextAttackAt = 0;
    this.attackWindupAt = 0;
    this.attacking = false;
    this.staggerUntil = 0;

    this.patrolIndex = 0;
    this.wanderTarget = null;
    this.wanderUntil = 0;
    this.followTarget = null;
    this.interactCooldown = 0;
    this._lastGrowl = 0;
    this._losCheckAt = 0;
    this._seen = false;

    this.weapon = this.cfg.weaponId || null;
    this.lootTable = this.cfg.lootTable;

    this._syncCharacter();
    if (this.char) this.char.setBaseState('idle', 0);
  }

  get x2() { return this.x; }

  _syncCharacter() {
    if (this.groundAt) this.y = this.groundAt(this.x, this.z);
    if (!this.char) return;
    this.char.setPosition(this.x, this.y, this.z);
    this.char.setYaw(this.yaw);
  }

  setState(next, world) {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
    this.stateEnteredAt = world && Number.isFinite(world.now) ? world.now : 0;
    // 换状态时清掉旧路径，防止"沿着上一个目标的路线继续走"
    if (next === 'chase' || next === 'search' || next === 'investigate' || next === 'engage') {
      // 保留路径也可以，但清掉更可预测
      this.follower.clear();
      this._repathAt = 0;
    }
    if (next === 'dead' && this.char) this.char.setBaseState('idle');
  }

  // ── 感知 ─────────────────────────────────────────────
  _eyeY() { return 1.55; }

  /** 是否看见某个点（距离 + 视角 + 遮挡）。天气/夜色对距离的缩放由 world.perception 给。 */
  canSeePoint(px, pz, world, rangeScale = 1) {
    const cfg = this.cfg;
    const d2 = dist2(this.x, this.z, px, pz);
    const perc = world && world.perception;
    const sightMul = perc && Number.isFinite(perc.sight) ? perc.sight : 1;
    const range = cfg.sightRange * rangeScale * sightMul;
    if (d2 > range * range) return false;
    const dx = px - this.x, dz = pz - this.z;
    const ang = Math.atan2(dx, dz);
    if (Math.abs(normAngle(ang - this.yaw)) > cfg.sightFov * 0.5) return false;
    if (world && world.collision) {
      return world.collision.lineOfSight(this.x, this._eyeY(), this.z, px, this._eyeY(), pz);
    }
    return true;
  }

  canSeePlayer(world) {
    const p = world && world.player;
    if (!p || !p.alive) return false;
    // 蹲伏会显著降低被发现距离（潜行有意义）
    const scale = p.crouching ? 0.55 : 1;
    return this.canSeePoint(p.x, p.z, world, scale);
  }

  /** 听觉事件。loudness: 1=普通脚步，4=枪声。环境噪声底（风雨）会缩短可听距离。 */
  hear(x, z, loudness, world) {
    if (!this.alive) return false;
    const perc = world && world.perception;
    const hearMul = perc && Number.isFinite(perc.hearing) ? perc.hearing : 1;
    const range = this.cfg.hearingRange * Math.max(0.2, loudness) * hearMul;
    if (dist2(this.x, this.z, x, z) > range * range) return false;
    this.alertness = Math.min(1, this.alertness + 0.35 * loudness);
    if (this.state === 'chase' || this.state === 'attack' || this.state === 'engage') return true;
    this.lastKnown = { x, z };
    this.investigateUntil = (world && world.now ? world.now : 0) + 8;
    if (this.type === 'zombie' && (this.state === 'idle' || this.state === 'wander' || this.state === 'patrol')) {
      this.setState('investigate', world);
    }
    return true;
  }

  onDamaged(amount, now, attacker) {
    if (!this.alive) return;
    this.health -= amount;
    this.alertness = 1;
    if (attacker && Number.isFinite(attacker.x)) {
      this.lastKnown = { x: attacker.x, z: attacker.z };
      this.searchUntil = now + (this.type === 'zombie' ? 9 : 6);
    }
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deadAt = now;
      this.setState('dead');
      if (this.char) this.char.animator.die();
      return true;
    }
    if (this.type === 'zombie') {
      this.staggerUntil = now + 0.45;
      if (this.char) this.char.triggerAction('hit', { fade: 0.05 });
    } else if (this.type === 'friendly') {
      if (this.cfg.aggression < 0.5) this.setState('flee');
      else this.setState('combat');
    } else if (this.type === 'hostile') {
      if (this.health < this.maxHealth * 0.3) this.setState('retreat');
      else if (this.state === 'patrol' || this.state === 'search') this.setState('engage');
    }
    return false;
  }

  // ── 移动 ─────────────────────────────────────────────
  /**
   * 朝目标点移动。近距离直接转向（精细），远距离用寻路（低频重算）。
   * @returns {number} 与目标的距离
   */
  moveToward(dt, tx, tz, speed, world) {
    const dx = tx - this.x, dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    let vx = 0, vz = 0;

    if (d > 0.001) {
      const directRange = this.type === 'zombie' ? 6 : 5;
      const usePath = d > directRange && this.nav && this.follower;
      if (usePath) {
        const now = world.now;
        const goalMoved = !this._lastPathGoal || dist2(this._lastPathGoal.x, this._lastPathGoal.z, tx, tz) > 9;
        if ((!this.follower.hasPath || goalMoved || this.follower.needsRepath) && now >= this._repathAt) {
          this._repathAt = now + 0.55 + this.rng() * 0.35;
          const path = this.nav.findPath({ x: this.x, z: this.z }, { x: tx, z: tz }, { smooth: true });
          this.follower.setPath(path);
          this._lastPathGoal = { x: tx, z: tz };
        }
        const st = this.follower.update(dt, { x: this.x, z: this.z });
        if (st.failed) {
          this._stuckCount += 1;
          this.follower.clear();
          this._repathAt = world.now + 1.2;
          // 连续卡住 → 交给行为层换个目标（不在这里死循环重算同一路径）
          if (this._stuckCount >= 2) {
            this._stuckCount = 0;
            this.wanderTarget = this._pickWanderPoint(world);
            this.wanderUntil = world.now + 4;
            return d;
          }
        }
        if (st.dir && !st.done) { vx = st.dir.x; vz = st.dir.z; }
        else if (!st.done && d > 0.01) { vx = dx / d; vz = dz / d; }
      } else {
        vx = dx / d;
        vz = dz / d;
      }
    }

    if (vx || vz) {
      const vlen = Math.hypot(vx, vz) || 1;
      vx /= vlen; vz /= vlen;
      const step = speed * dt;
      let nx = this.x + vx * step;
      let nz = this.z + vz * step;
      if (world.collision) {
        const res = world.collision.move(this.x, this.z, 0.34, nx - this.x, nz - this.z, 0, 1.7);
        nx = res.x; nz = res.z;
        if (res.hitX || res.hitZ) {
          // 贴墙：轻微侧移，避免原地抖动
          const side = (this.id.length % 2 === 0) ? 1 : -1;
          const slide = world.collision.move(nx, nz, 0.34, -vz * step * 0.7 * side, vx * step * 0.7 * side, 0, 1.7);
          nx = slide.x; nz = slide.z;
        }
      }
      this.x = nx; this.z = nz;
      const targetYaw = Math.atan2(vx, vz);
      this.yaw = this._turnToward(this.yaw, targetYaw, dt * (this.type === 'zombie' ? 5.5 : 8));
    }
    this._syncCharacter();
    return Math.hypot(tx - this.x, tz - this.z);
  }

  _turnToward(cur, target, maxStep) {
    const diff = normAngle(target - cur);
    if (Math.abs(diff) <= maxStep) return target;
    return cur + Math.sign(diff) * maxStep;
  }

  _pickWanderPoint(world) {
    const r = 6 + this.rng() * (this.cfg.homeRadius * 0.6);
    const a = this.rng() * TWO_PI;
    let x = this.home.x + Math.cos(a) * r;
    let z = this.home.z + Math.sin(a) * r;
    if (this.nav && !this.nav.isWalkableWorld(x, z)) {
      const near = this.nav.nearestWalkable(x, z, 10);
      if (near) { x = near.x; z = near.z; }
      else return null;
    }
    return { x, z };
  }

  // ── 战斗动作 ──────────────────────────────────────────
  _tryMelee(world, target) {
    const now = world.now;
    if (now < this.nextAttackAt) return;
    const d = Math.hypot(target.x - this.x, target.z - this.z);
    if (d > this.cfg.attackRange) return;
    this.nextAttackAt = now + this.cfg.attackCooldown;
    this.attacking = true;
    this.attackWindupAt = now + 0.26;
    this._pendingTarget = { x: target.x, z: target.z };
    this._pendingTargetObj = target;
    if (this.char) {
      // 僵尸用模型自带的 ZombieBite 当攻击动画。
      // 旧代码在这里又补了一发 'hit'，而 hit 是允许打断 melee 的 —— 结果咬击从来没播出来过，
      // FBX 僵尸攻击时只是站定僵一下。现在只留 melee，'hit' 只用于「被打」。
      // ZombieBite 原片 5.04s、前 0.5s 是后仰蓄力，从 0.55s 起按 2.6 倍速播 ≈ 1.7s。
      const fbxZombie = this.type === 'zombie' && this.char.modelKind === 'fbx';
      this.char.triggerAction('melee', fbxZombie
        ? { fade: 0.08, time: 0.55, timeScale: 2.6 }
        : { fade: 0.08 });
    }
    if (world.emitSound) world.emitSound(this.x, this.z, this.type === 'zombie' ? 1.6 : 1.1, this.type);
  }

  _resolveMelee(world) {
    if (!this.attacking || world.now < this.attackWindupAt) return;
    this.attacking = false;
    const t = this._pendingTarget;
    const victim = this._pendingTargetObj;
    if (!t) return;
    const d = Math.hypot(t.x - this.x, t.z - this.z);
    if (d <= this.cfg.attackRange + 0.5) {
      // 目标可能是玩家（game 传入的轻量代理对象，带 isPlayer 标记），也可能是另一个 NPC。
      // 早期版本用 `victim !== world.player` 判断，但 world.player 每帧都是新对象，判断永远成立，
      // 结果把玩家代理丢进了 NPC 伤害通道（浏览器测试抓到的 onDamaged is not a function）。
      const isPlayerTarget = victim && (victim.isPlayer === true || victim === world.player);
      if (!isPlayerTarget && victim && victim.alive && world.damageNpc) {
        world.damageNpc(victim, this.cfg.attackDamage, this);
      } else if (world.damagePlayer) {
        world.damagePlayer(this.cfg.attackDamage, this);
      }
      if (world.playSound) world.playSound(this.type === 'zombie' ? 'zombie_attack' : 'melee_hit', { position: { x: this.x, y: 1.2, z: this.z } });
    }
    this._pendingTarget = null;
    this._pendingTargetObj = null;
  }

  // ── 各类型状态机 ───────────────────────────────────────
  update(dt, world) {
    if (!this.alive) return;
    this.stateTime += dt;
    const now = world.now;
    this.alertness = Math.max(0, this.alertness - dt * 0.06);

    if (this.attacking) this._resolveMelee(world);

    if (this.type === 'zombie') this._tickZombie(dt, world, now);
    else if (this.type === 'friendly') this._tickFriendly(dt, world, now);
    else this._tickHostile(dt, world, now);
  }

  _tickZombie(dt, world, now) {
    const cfg = this.cfg;
    if (now < this.staggerUntil) {
      if (this.state !== 'stagger') this.setState('stagger', world);
      return;
    }
    if (this.state === 'stagger') { this.setState('chase', world); }

    const seen = this.canSeePlayer(world);
    this._seen = seen;
    const player = world.player;

    if (seen) {
      this.lastKnown = { x: player.x, z: player.z };
      this.searchUntil = now + 9;
      const d = Math.hypot(player.x - this.x, player.z - this.z);
      if (d <= cfg.attackRange) {
        if (this.state !== 'attack') this.setState('attack', world);
        this._turnTowardTo(player.x, player.z, dt);
        this._tryMelee(world, player);
        if (this.char) this.char.setBaseState('idle');
        return;
      }
      if (this.state !== 'chase') this.setState('chase', world);
      const speed = cfg.chaseSpeed * (0.85 + this.alertness * 0.3);
      this.moveToward(dt, player.x, player.z, speed, world);
      if (this.char) {
        this.char.setBaseState(d < 8 ? 'run' : 'walk');
      }
      if (now - this._lastGrowl > 4.5 + this.rng() * 3) {
        this._lastGrowl = now;
        if (world.playSound) world.playSound('zombie_growl', { position: { x: this.x, y: 1.4, z: this.z }, volume: 0.8 });
      }
      return;
    }

    // 目标丢失：先去最后看到的位置，再搜索
    if (this.lastKnown && now < this.searchUntil) {
      const d = Math.hypot(this.lastKnown.x - this.x, this.lastKnown.z - this.z);
      if (d > 1.6) {
        if (this.state !== 'search') this.setState('search', world);
        this.moveToward(dt, this.lastKnown.x, this.lastKnown.z, cfg.movementSpeed * 1.5, world);
        if (this.char) this.char.setBaseState('walk');
      } else {
        if (this.state !== 'investigate') this.setState('investigate', world);
        // 原地环顾
        this.yaw += dt * 1.2;
        this._syncCharacter();
        if (this.char) this.char.setBaseState('idle');
      }
      return;
    }

    if (this.lastKnown && now >= this.searchUntil) {
      this.lastKnown = null;
      this.setState('return', world);
    }

    if (this.state === 'return') {
      const d = Math.hypot(this.home.x - this.x, this.home.z - this.z);
      if (d > 3) {
        this.moveToward(dt, this.home.x, this.home.z, cfg.movementSpeed, world);
        if (this.char) this.char.setBaseState('walk');
      } else {
        this.setState('idle', world);
      }
      return;
    }

    if (this.investigateUntil > now && this.lastKnown) {
      const d = Math.hypot(this.lastKnown.x - this.x, this.lastKnown.z - this.z);
      if (d > 1.5) {
        this.moveToward(dt, this.lastKnown.x, this.lastKnown.z, cfg.movementSpeed * 1.25, world);
        if (this.char) this.char.setBaseState('walk');
      } else if (this.state !== 'investigate') {
        this.setState('investigate', world);
      }
      return;
    }

    // 空闲行为：有巡逻路线就巡逻，否则游荡
    if (cfg.patrolRoute.length > 1) {
      if (this.state !== 'patrol') this.setState('patrol', world);
      const wp = cfg.patrolRoute[this.patrolIndex % cfg.patrolRoute.length];
      const d = this.moveToward(dt, wp.x, wp.z, cfg.movementSpeed, world);
      if (this.char) this.char.setBaseState('walk');
      if (d < 1.6) this.patrolIndex = (this.patrolIndex + 1) % cfg.patrolRoute.length;
      return;
    }

    if (this.state !== 'wander' && this.state !== 'idle') this.setState('wander', world);
    if (!this.wanderTarget || now > this.wanderUntil) {
      this.wanderTarget = this._pickWanderPoint(world);
      this.wanderUntil = now + 5 + this.rng() * 6;
      if (this.wanderTarget) this.setState('wander', world);
    }
    if (this.wanderTarget) {
      const d = this.moveToward(dt, this.wanderTarget.x, this.wanderTarget.z, cfg.movementSpeed * 0.75, world);
      if (this.char) this.char.setBaseState('walk');
      if (d < 1.2) { this.wanderTarget = null; this.setState('idle', world); }
    } else if (this.char) {
      this.char.setBaseState('idle');
    }
  }

  _turnTowardTo(x, z, dt) {
    const target = Math.atan2(x - this.x, z - this.z);
    this.yaw = this._turnToward(this.yaw, target, dt * 7);
    this._syncCharacter();
  }

  _tickFriendly(dt, world, now) {
    const cfg = this.cfg;
    const player = world.player;
    const seenPlayer = this.canSeePlayer(world);

    // 有威胁（僵尸靠近）→ 逃或打
    const threat = world.nearestHostileTo ? world.nearestHostileTo(this.x, this.z, 16) : null;
    if (threat) {
      const d = Math.hypot(threat.x - this.x, threat.z - this.z);
      if (d < 16) {
        if (cfg.aggression < 0.45 || this.health < this.maxHealth * 0.4) {
          if (this.state !== 'flee') this.setState('flee', world);
          const away = Math.atan2(this.x - threat.x, this.z - threat.z);
          const fx = this.x + Math.sin(away) * 10;
          const fz = this.z + Math.cos(away) * 10;
          this.moveToward(dt, fx, fz, cfg.chaseSpeed, world);
          if (this.char) this.char.setBaseState('run');
          if (world.playSound && now - this._lastGrowl > 5) {
            this._lastGrowl = now;
            world.playSound('zombie_growl', { position: { x: this.x, y: 1.4, z: this.z }, volume: 0.4 });
          }
          return;
        }
        if (this.state !== 'combat') this.setState('combat', world);
        if (d <= cfg.attackRange) {
          this._turnTowardTo(threat.x, threat.z, dt);
          this._tryMelee(world, threat);
          if (this.char) this.char.setBaseState('idle');
        } else {
          this.moveToward(dt, threat.x, threat.z, cfg.chaseSpeed, world);
          if (this.char) this.char.setBaseState('walk');
        }
        return;
      }
    }

    // 跟随玩家（由 director/任务系统设置）
    if (this.followTarget && this.state !== 'interact') {
      if (this.state !== 'follow') this.setState('follow', world);
      const d = this.moveToward(dt, this.followTarget.x, this.followTarget.z, cfg.movementSpeed, world);
      if (this.char) this.char.setBaseState(d < 1.2 ? 'idle' : (d > 8 ? 'run' : 'walk'));
      if (d > 26) this.followTarget = null;
      return;
    }

    // 玩家靠近 → 交互（对话/任务）
    if (seenPlayer && player) {
      const d = Math.hypot(player.x - this.x, player.z - this.z);
      if (d < 3.4) {
        if (this.state !== 'interact') this.setState('interact', world);
        this._turnTowardTo(player.x, player.z, dt);
        if (this.char) this.char.setBaseState('idle');
        return;
      }
    }

    if (this.state === 'interact') this.setState('idle', world);

    // 巡逻/游荡/回家
    if (cfg.patrolRoute.length > 1) {
      if (this.state !== 'patrol') this.setState('patrol', world);
      const wp = cfg.patrolRoute[this.patrolIndex % cfg.patrolRoute.length];
      const d = this.moveToward(dt, wp.x, wp.z, cfg.movementSpeed, world);
      if (this.char) this.char.setBaseState('walk');
      if (d < 1.6) this.patrolIndex = (this.patrolIndex + 1) % cfg.patrolRoute.length;
      return;
    }
    const homeD = Math.hypot(this.home.x - this.x, this.home.z - this.z);
    if (homeD > cfg.homeRadius) {
      if (this.state !== 'returnToBase') this.setState('returnToBase', world);
      this.moveToward(dt, this.home.x, this.home.z, cfg.movementSpeed, world);
      if (this.char) this.char.setBaseState('walk');
      return;
    }
    if (!this.wanderTarget || now > this.wanderUntil) {
      this.wanderTarget = this._pickWanderPoint(world);
      this.wanderUntil = now + 6 + this.rng() * 8;
    }
    if (this.wanderTarget) {
      const d = this.moveToward(dt, this.wanderTarget.x, this.wanderTarget.z, cfg.movementSpeed * 0.6, world);
      if (this.char) this.char.setBaseState(d < 1.2 ? 'idle' : 'walk');
      if (d < 1.2) this.wanderTarget = null;
      if (this.state !== 'wander') this.setState('wander', world);
    } else if (this.char) this.char.setBaseState('idle');
  }

  _tickHostile(dt, world, now) {
    const cfg = this.cfg;
    const player = world.player;
    const seen = this.canSeePlayer(world);

    if (this.health < this.maxHealth * 0.28) {
      if (this.state !== 'retreat') this.setState('retreat', world);
      const away = Math.atan2(this.x - (player ? player.x : 0), this.z - (player ? player.z : 0));
      this.moveToward(dt, this.x + Math.sin(away) * 14, this.z + Math.cos(away) * 14, cfg.chaseSpeed, world);
      if (this.char) this.char.setBaseState('sprint');
      return;
    }

    if (seen && player) {
      this.lastKnown = { x: player.x, z: player.z };
      this.searchUntil = now + 7;
      const d = Math.hypot(player.x - this.x, player.z - this.z);
      if (this.state !== 'engage') this.setState('engage', world);
      this._turnTowardTo(player.x, player.z, dt);

      if (d > cfg.attackRange) {
        this.moveToward(dt, player.x, player.z, cfg.chaseSpeed, world);
        if (this.char) this.char.setBaseState('run');
        return;
      }
      // 进入射程：站定射击（有最小间隔 + 命中判定交给 game）
      if (this.char) this.char.setBaseState('aim');
      if (now >= this.nextAttackAt) {
        this.nextAttackAt = now + cfg.attackCooldown + this.rng() * 0.4;
        if (this.char) this.char.triggerAction('fire', { fade: 0.06 });
        if (world.npcShoot) {
          world.npcShoot(this, player, this.weapon);
        }
      }
      return;
    }

    if (this.lastKnown && now < this.searchUntil) {
      if (this.state !== 'search') this.setState('search', world);
      const d = this.moveToward(dt, this.lastKnown.x, this.lastKnown.z, cfg.movementSpeed * 1.4, world);
      if (this.char) this.char.setBaseState('run');
      if (d < 2) { this.yaw += dt * 1.6; this._syncCharacter(); }
      return;
    }

    if (cfg.patrolRoute.length > 1) {
      if (this.state !== 'patrol') this.setState('patrol', world);
      const wp = cfg.patrolRoute[this.patrolIndex % cfg.patrolRoute.length];
      const d = this.moveToward(dt, wp.x, wp.z, cfg.movementSpeed, world);
      if (this.char) this.char.setBaseState('walk');
      if (d < 1.6) this.patrolIndex = (this.patrolIndex + 1) % cfg.patrolRoute.length;
      return;
    }
    if (this.char) this.char.setBaseState('idle');
    void dt; void now;
  }

  /** director 用来判断是否该回收。 */
  shouldDespawn(now, playerDistance, despawnRadius) {
    if (this.alive) return playerDistance > despawnRadius;
    return now - this.deadAt > 45;
  }

  serialize() {
    return {
      id: this.id, type: this.type,
      x: Math.round(this.x * 100) / 100, z: Math.round(this.z * 100) / 100,
      yaw: Math.round(this.yaw * 1000) / 1000,
      health: Math.max(0, Math.round(this.health)),
      alive: this.alive,
    };
  }
}

export default { Npc, ZOMBIE_STATES, FRIENDLY_STATES, HOSTILE_STATES };
