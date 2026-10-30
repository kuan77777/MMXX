// 玩家控制器：移动、跳跃、蹲伏、体力/饥渴、武器状态、动画状态选择。
// 战斗判定与交互本身在 core/game.js 里做（需要世界、NPC、音效一起参与），
// 这里只负责"玩家的身体与状态"，并通过 ctx 回调把动作请求抛出去。

import { Inventory, ITEMS } from '../items/items.js';
import { WeaponState, WEAPONS } from '../combat/weapons.js';
import { BuffList, applyConsume, foodEffectConfig } from '../items/consumables.js';
import { MedicalState, treatOf, planTreatment, applyTreatment, applyWound } from '../items/medical.js';

export class Player {
  /**
   * @param {object} THREE
   * @param {object} ctx { config, collision, camera, materials, playSound, emitSound, onEvent }
   */
  constructor(THREE, ctx = {}) {
    this.THREE = THREE;
    this.ctx = ctx;
    this.cfg = ctx.config || {};
    const P = this.cfg.player || {};
    const I = this.cfg.items || {};

    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.grounded = true;
    // 脚下的地表高度（米）。平地小镇是 0；有真实地形时每帧从 ctx.groundHeightAt 取。
    this.groundY = 0;
    this.crouching = false;
    this.sprinting = false;
    this.aiming = false;
    this.moving = false;
    this.speed = 0;
    this.yaw = 0;

    // 体型模板的属性乘数（没有模板时 mul() 全返回 1，与老行为完全一致）
    const SM = ctx.statsMul || null;
    this.statsMul = SM;
    this.mul = (k) => (SM && Number.isFinite(SM[k]) && SM[k] > 0 ? SM[k] : 1);

    this.maxHealth = (P.maxHealth || 100) * this.mul('health');
    this.health = this.maxHealth;
    this.maxStamina = (P.maxStamina || 100) * this.mul('stamina');
    this.stamina = this.maxStamina;
    this.maxHunger = P.maxHunger || 100;
    this.hunger = this.maxHunger;
    this.maxThirst = P.maxThirst || 100;
    this.thirst = this.maxThirst;
    this.alive = true;
    this.deadAt = 0;
    this.kills = 0;
    this.walkedDistance = 0;

    // 食物功效：buff 列表 + 玩法参数（cfg.player.foodEffects，缺项自动补默认值）
    this.buffs = new BuffList();
    this.foodFx = foodEffectConfig(P.foodEffects);
    // 医疗：伤情状态（流血/感染/骨折/疼痛）+ 正在进行中的治疗
    this.med = new MedicalState();
    this._treat = null;

    // 先建武器表：Inventory 的 onChange 会在构造期/add 期间回调 _syncWeapons，
    // 顺序反了就会读到 undefined（浏览器测试第一个抓到的就是这个）。
    this.weapons = new Map();       // weaponId -> WeaponState
    this.equipped = null;           // weaponId

    this.inventory = new Inventory({
      maxWeight: (I.maxWeight || 24) * this.mul('carry'),
      quickSlots: I.quickSlots || 6,
      onChange: () => this._syncWeapons(),
    });
    // 初始装备：一把手枪 + 少量弹药（保证一进游戏就有战斗手段）
    this.inventory.add('i_w_pistol', 1, { ignoreWeight: true });
    this.inventory.add('i_ammo_9mm', 24, { ignoreWeight: true });
    this.inventory.add('i_med_bandage', 2, { ignoreWeight: true });
    this.inventory.add('i_food_can', 1, { ignoreWeight: true });
    this.inventory.add('i_drink_water', 1, { ignoreWeight: true });

    this._syncWeapons();

    this._footstepAccum = 0;
    this._bobT = 0;
    this._lastDamageAt = -999;
    this._regenCooldown = 0;
    this.character = null;
    this.desiredState = 'idle';
  }

  attachCharacter(character) {
    this.character = character;
  }

  /** 背包变化时同步"持有哪些武器"。 */
  _syncWeapons() {
    if (!this.weapons) return;   // 构造期回调保护
    const owned = new Set();
    for (const s of this.inventory.slots) if (s && ITEMS[s.itemId] && ITEMS[s.itemId].weaponId) owned.add(ITEMS[s.itemId].weaponId);
    for (const s of this.inventory.quick) if (s && ITEMS[s.itemId] && ITEMS[s.itemId].weaponId) owned.add(ITEMS[s.itemId].weaponId);
    for (const wid of owned) if (!this.weapons.has(wid) && WEAPONS[wid]) this.weapons.set(wid, new WeaponState(WEAPONS[wid]));
    for (const wid of [...this.weapons.keys()]) if (!owned.has(wid)) this.weapons.delete(wid);
    if (!this.equipped || !this.weapons.has(this.equipped)) {
      this.equipped = this.weapons.size ? [...this.weapons.keys()][0] : null;
    }
    this._ammoDirty = true;
  }

  get weaponState() { return this.equipped ? this.weapons.get(this.equipped) || null : null; }
  get weaponDef() { const w = this.weaponState; return w ? w.def : null; }

  /** 该武器的备弹数（来自背包）。 */
  /** 弹药 id → 物品 id 的约定：ammo_762 ↔ i_ammo_762（加新口径不用改这里）。 */
  ammoItemId(def) { return def && def.ammoId ? `i_${def.ammoId}` : null; }

  reserveFor(def) {
    const itemId = this.ammoItemId(def);
    if (!itemId) return 0;
    return this.inventory.countItem(itemId);
  }

  equip(weaponId) {
    if (!weaponId || !this.weapons.has(weaponId)) return false;
    if (this.equipped === weaponId) return false;
    this.equipped = weaponId;
    this._weaponChanged = true;
    return true;
  }

  equipSlot(index) {
    const ids = [...this.weapons.keys()];
    if (index < 0 || index >= ids.length) return false;
    return this.equip(ids[index]);
  }

  get eyeHeight() {
    const P = this.cfg.player || {};
    const base = this.crouching ? (P.crouchEyeHeight || 1.05) : (P.eyeHeight || 1.62);
    // 轻微走路晃动（第一人称时它明显但不晕）
    return base + (this._bobT % 2) * 0;
  }

  get eyePosition() {
    return { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
  }

  get forward() {
    const y = this.yaw;
    return { x: Math.sin(y), z: Math.cos(y) };
  }

  setPosition(x, y, z) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
    this.groundY = this.ctx.groundHeightAt ? this.ctx.groundHeightAt(x, z) : 0;
    this.grounded = y <= this.groundY + 0.01;
    if (this.character) this.character.setPosition(x, y, z);
  }

  /** 主更新。 */
  update(dt, input, world) {
    if (!this.alive) return;
    const P = this.cfg.player || {};
    const cam = this.ctx.camera;
    this.yaw = cam ? cam.yaw : this.yaw;
    // 驾驶中：位置由载具接管，玩家的移动/跳跃/瞄准输入要全部让位给车
    const driving = !!(world && world.driving);
    const canMove = !!input && !driving;

    // ── 输入 → 期望移动方向
    let fwd = 0, strafe = 0;
    if (canMove) {
      if (input.isDown('forward')) fwd += 1;
      if (input.isDown('back')) fwd -= 1;
      if (input.isDown('right')) strafe += 1;
      if (input.isDown('left')) strafe -= 1;
    }
    const wishLen = Math.hypot(fwd, strafe);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // 前方 = (sin yaw, cos yaw)。
    // 右方必须用"前方向 × 上方向"算：在右手系里 forward×up 才是玩家的右手边，
    // 结果 = (-cos yaw, 0, +sin yaw)。早先写成 (cos yaw, -sin yaw) 正好是左手方向，
    // 于是 A/D 横移整体反了（按 D 往左跑）。
    let wx = 0, wz = 0;
    if (wishLen > 0) {
      const nf = fwd / Math.max(1, wishLen);
      const ns = strafe / Math.max(1, wishLen);
      wx = sy * nf - cy * ns;
      wz = cy * nf + sy * ns;
      const l = Math.hypot(wx, wz) || 1;
      wx /= l; wz /= l;
    }

    // ── 蹲伏 / 冲刺 / 瞄准
    const wantCrouch = canMove ? input.isDown('crouch') : false;
    if (wantCrouch !== this.crouching) {
      this.crouching = wantCrouch;
      if (this.character) this.character.crouching = wantCrouch;
    }
    this.aiming = !!(canMove && input.mouseDown(2)) && !this.crouching;
    const wantSprint = (canMove ? input.isDown('sprint') : false) && wishLen > 0 && fwd > 0 && !this.aiming && this.stamina > 5;
    this.sprinting = wantSprint;

    let targetSpeed = 0;
    if (wishLen > 0) {
      if (this.crouching) targetSpeed = P.crouchSpeed || 1.7;
      else if (this.aiming) targetSpeed = P.aimSpeed || 1.5;
      else if (this.sprinting) targetSpeed = P.sprintSpeed || 8.2;
      else targetSpeed = P.runSpeed || 5.6;
    }
    // 天气只给乘数（雪地打滑 / 泥地拖脚），玩家不知道"天气"这个概念
    const wNow = (world && world.weather) || null;
    const grip = wNow && Number.isFinite(wNow.grip) ? wNow.grip : 1;
    targetSpeed *= grip;
    // 医疗：骨折/疼痛会拖慢脚步；治疗中移动更慢（相当于"边跑边包扎"）
    const medPen = this.med ? this.med.penalties() : null;
    if (medPen) targetSpeed *= medPen.moveMul * (this._treat ? 0.6 : 1);
    // 体型模板：腿长加成 / 体重扣分
    targetSpeed *= this.mul('speed');

    // 速度平滑（避免瞬间启停的僵硬感，也让动画切换更自然）
    const accel = this.grounded ? 14 : 4;
    this.vel.x += (wx * targetSpeed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wz * targetSpeed - this.vel.z) * Math.min(1, accel * dt);

    // ── 跳跃 / 重力
    if (canMove && input.wasPressed('jump') && this.grounded && this.stamina > 8) {
      this.vel.y = (P.jumpVelocity || 6.2) * this.mul('jump');
      this.grounded = false;
      // 骨折时跳跃更费体力
      this.stamina -= 8 * (medPen ? medPen.jumpCostMul : 1);
      if (this.character) this.character.triggerAction('jump', { fade: 0.08 });
      if (this.ctx.playSound) this.ctx.playSound('jump', { volume: 0.5 });
    }
    this.vel.y -= (P.gravity || 20) * dt;
    this.pos.y += this.vel.y * dt;
    // 脚下地表：真实地形时每帧采样一次（双线性插值，成本可忽略）
    this.groundY = this.ctx.groundHeightAt ? this.ctx.groundHeightAt(this.pos.x, this.pos.z) : 0;
    if (this.pos.y <= this.groundY) {
      if (!this.grounded && this.vel.y < -3) {
        if (this.character) this.character.triggerAction('land', { fade: 0.08 });
        if (this.ctx.playSound) this.ctx.playSound('land', { volume: Math.min(1, -this.vel.y / 10) });
        // 掉落伤害
        const fallSpeed = -this.vel.y;
        if (fallSpeed > 9) {
          this.applyDamage((fallSpeed - 9) * (P.fallDamagePerMeter || 9) * 0.35, null, world);
          // 摔伤：超过 14m/s 有概率骨折（越高越重）
          if (this.med && fallSpeed > 14) {
            applyWound(this.med, 'fall', Math.min(1, (fallSpeed - 14) / 12));
          }
        }
      }
      this.pos.y = this.groundY;
      this.vel.y = 0;
      this.grounded = true;
    }

    // ── 碰撞推进（分轴滑墙）
    const dx = this.vel.x * dt;
    const dz = this.vel.z * dt;
    if (this.ctx.collision && (dx || dz)) {
      const before = { x: this.pos.x, z: this.pos.z };
      const res = this.ctx.collision.move(this.pos.x, this.pos.z, P.radius || 0.34, dx, dz, this.pos.y, P.height || 1.75);
      this.pos.x = res.x;
      this.pos.z = res.z;
      // 撞墙时把速度也归零，避免"贴着墙还在积累速度"
      if (res.hitX) this.vel.x *= 0.2;
      if (res.hitZ) this.vel.z *= 0.2;
      const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
      this.walkedDistance += moved;
      this._bobT += moved;
      // 脚步声 + 给 AI 的听觉事件（走路 0.35 / 跑 0.75 / 冲刺 1.0）
      const stepLen = this.sprinting ? 2.1 : (this.runSpeedLike() ? 1.7 : 1.35);
      this._footstepAccum += moved;
      if (this._footstepAccum >= stepLen && this.grounded) {
        this._footstepAccum = 0;
        // 体型模板：块头越大脚步越响（AI 的听觉半径直接受影响）
        const loud = (this.sprinting ? 1.0 : (this.crouching ? 0.15 : 0.55)) * this.mul('noise');
        if (this.ctx.playSound) this.ctx.playSound(this.sprinting ? 'footstep_sprint' : 'footstep', { volume: 0.45 });
        if (this.ctx.emitSound) this.ctx.emitSound(this.pos.x, this.pos.z, loud, 'player');
      }
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.moving = this.speed > 0.35;

    // ── 医疗：伤情推进（流血/感染掉血、疼痛与耐受衰减）+ 治疗进度
    let medMul = null;
    if (this.med) {
      medMul = this.med.tick(dt);
      if (medMul.hpDrain > 0 && this.alive) this.applyDamage(medMul.hpDrain * dt, null, world, true);
      this._updateTreatment(dt);
    }

    // ── 体力
    // 湿冷/暴雪会额外消耗体力、也更难恢复（天气参数的 staminaMul / regenMul）
    const stamMul = wNow && Number.isFinite(wNow.staminaMul) ? wNow.staminaMul : 1;
    const regenMul = wNow && Number.isFinite(wNow.regenMul) ? wNow.regenMul : 1;
    // 食物功效也进这套乘数：饱腹/糖分冲刺/钾盐/冰凉/吃撑/中毒 + "低血糖、脱水"的次级惩罚
    const fx = this.foodFx;
    const bm = this.buffs ? this.buffs.mods() : null;
    const lowHunger = fx.enabled && this.hunger < fx.lowHunger;
    const lowThirst = fx.enabled && this.thirst < fx.lowThirst;
    const staminaRegenMul = (bm ? bm.staminaRegenMul : 1) * (lowHunger ? fx.lowHungerRegenMul : 1)
      * (medPen ? medPen.staminaRegenMul : 1);
    const sprintCostMul = (bm ? bm.sprintMul : 1) * (lowThirst ? fx.lowThirstSprintMul : 1)
      * (medPen ? medPen.sprintMul : 1);
    if (this.sprinting && this.speed > 1) {
      this.stamina = Math.max(0, this.stamina
        - (P.sprintStaminaCost || 18) * stamMul * sprintCostMul * dt * this.mul('staminaDrain'));
    } else {
      const regen = (P.staminaRegen || 12) * (this.crouching ? 1.6 : 1) * regenMul * staminaRegenMul;
      this.stamina = Math.min(this.maxStamina, this.stamina + regen * dt);
    }

    // ── 食物 buff 计时 + 中毒持续掉血
    if (this.buffs) {
      this.buffs.tick(dt);
      const dot = fx.enabled ? this.buffs.dot() : 0;
      if (dot > 0 && this.alive) this.applyDamage(dot * dt, null, world, true);
    }

    // ── 饥渴与自然恢复（速率受 buff 影响：饱腹 ×0.75、补水 ×0.7；感染会让人更饿更渴）
    const hungerMul = (bm ? bm.hungerMul : 1) * (medMul ? medMul.hungerMul : 1);
    const thirstMul = (bm ? bm.thirstMul : 1) * (medMul ? medMul.thirstMul : 1);
    this.hunger = Math.max(0, this.hunger - (P.hungerRate || 0.105) * hungerMul * dt);
    this.thirst = Math.max(0, this.thirst - (P.thirstRate || 0.15) * thirstMul * dt);
    this._regenCooldown = Math.max(0, this._regenCooldown - dt);
    if (this.hunger <= 0 || this.thirst <= 0) {
      // 饥饿/脱水会持续掉血（默认每秒 1.2），这是"必须吃东西"的压力来源
      this.applyDamage((fx.enabled ? fx.starvingDps : 1.2) * dt, null, world, true);
    } else if (this._regenCooldown <= 0 && this.health < this.maxHealth) {
      const regenHp = (fx.enabled ? fx.naturalRegen : 0.9) + (bm ? bm.healthRegenAdd : 0);
      this.health = Math.min(this.maxHealth, this.health + regenHp * dt);
    }

    // ── 动画状态
    this.desiredState = this._pickState();
    if (this.character) {
      this.character.setPosition(this.pos.x, this.pos.y, this.pos.z);
      this.character.setYaw(this.yaw);
      this.character.crouching = this.crouching;
      this.character.aiming = this.aiming;
      this.character.setBaseState(this.desiredState);
      this.character.speed = this.speed;
      this.character.moving = this.moving;
    }
  }

  runSpeedLike() { return this.speed > 4.2; }

  _pickState() {
    if (!this.grounded) return this.vel.y > 0.5 ? 'jump' : 'fall';
    if (this.crouching) return 'crouch';
    if (this.aiming) return 'aim';
    if (!this.moving) return 'idle';
    if (this.sprinting) return 'sprint';
    if (this.speed > 4.2) return 'run';
    return 'walk';
  }

  /** 开火：返回 {fired, def}，弹药与射速在这里扣。真正的命中结算在 game.js。 */
  fire(now) {
    const w = this.weaponState;
    if (!w || !this.alive) return { fired: false };
    if (w.def.type === 'melee') {
      if (!w.canFire(now)) return { fired: false };
      w.consume(now);
      if (this.character) this.character.triggerAction('melee', { fade: 0.06 });
      return { fired: true, def: w.def, melee: true };
    }
    if (w.def.ammoId && w.ammo <= 0) {
      // 空仓：自动换弹（有备弹时）
      if (this.reserveFor(w.def) > 0) this.reload(now);
      return { fired: false, empty: true };
    }
    if (!w.canFire(now)) return { fired: false, cooldown: true };
    w.consume(now);
    if (this.character) this.character.triggerAction('fire', { fade: 0.05 });
    return { fired: true, def: w.def };
  }

  reload(now) {
    const w = this.weaponState;
    if (!w) return false;
    const reserve = this.reserveFor(w.def);
    if (!w.startReload(now, reserve)) return false;
    if (this.character) this.character.triggerAction('reload', { fade: 0.1, timeScale: 1 });
    return true;
  }

  /** 换弹动画/计时结束时调用，从背包扣备弹并补满弹匣。 */
  finishReload() {
    const w = this.weaponState;
    if (!w) return 0;
    const need = w.finishReload();
    if (!need) return 0;
    const itemId = this.ammoItemId(w.def);
    if (!itemId) return 0;
    const taken = this.inventory.remove(itemId, need);
    w.ammo += taken;
    return taken;
  }

  applyDamage(amount, source, world, silent = false) {
    if (!this.alive) return;
    const n = Math.max(0, Number(amount) || 0);
    if (!n) return;
    if (this.cfg.debug && this.cfg.debug.godMode) return;
    this.health -= n;
    this._regenCooldown = 6;
    // 医疗：只有"真被打到"才留伤（流血/中毒/饿这种 silent 持续伤害不额外加疼痛）
    if (this.med && !silent) {
      this.med.add('pain', Math.min(0.45, (n / Math.max(1, this.maxHealth)) * 1.6));
      const kind = source && source.woundKind;
      if (kind) applyWound(this.med, kind, Math.min(1, n / Math.max(20, this.maxHealth * 0.45)));
      // 治疗被打断：按已完成进度给部分效果
      if (this._treat) this._interruptTreat('受到攻击');
    }
    if (!silent) {
      this._lastDamageAt = world && world.now ? world.now : 0;
      if (this.ctx.playSound) this.ctx.playSound('player_hurt', { volume: 0.7 });
      if (this.ctx.camera) this.ctx.camera.addShake(Math.min(0.35, n / 90));
    }
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deadAt = world && world.now ? world.now : 0;
      if (this.buffs) this.buffs.clear();   // 死亡清空食物 buff（中毒不该跟着复活）
      if (this.med) this.med.clear();       // 伤情也不跟着复活
      this._treat = null;
      if (this.character) this.character.animator.die();
    }
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount));
  }

  /** 使用物品（食物/饮水/医疗）。返回 {ok, message}。 */
  useItem(listName, index) {
    const arr = listName === 'quick' ? this.inventory.quick : this.inventory.slots;
    const slot = arr[index];
    if (!slot) return { ok: false, message: '没有物品' };
    const def = ITEMS[slot.itemId];
    if (!def) return { ok: false, message: '未知物品' };
    if (def.kind === 'food' || def.kind === 'drink') {
      // 食物功效统一走 items/consumables.js：即时数值 + 持续 buff + 中毒/吃撑风险
      const plan = applyConsume(this, def);
      if (!plan.ok) return { ok: false, message: `${def.name}不能吃` };
      this.inventory.removeAt(listName, index, 1);
      if (this.ctx.playSound) this.ctx.playSound(def.kind === 'drink' ? 'drink' : 'eat');
      return { ok: true, message: plan.message, plan };
    }
    if (def.kind === 'medical') {
      // 医疗品走 items/medical.js：不同药治不同伤情，且大多要花时间
      return this._startTreatment(listName, index, def);
    }
    if (def.weaponId) {
      this.equip(def.weaponId);
      return { ok: true, message: `装备了${def.name}` };
    }
    return { ok: false, message: `${def.name}不能直接使用` };
  }

  // ── 医疗：治疗动作（可被打断）─────────────────────────
  _medStats() {
    return { health: this.health, maxHealth: this.maxHealth, stamina: this.stamina, maxStamina: this.maxStamina };
  }

  /** 开始使用医疗品。耗时的（绷带/急救包/夹板/抗生素）要等进度条走完。 */
  _startTreatment(listName, index, def) {
    if (!this.med) return { ok: false, message: '医疗系统未初始化' };
    if (this._treat) return { ok: false, message: '正在处理伤口，别急' };
    const t = treatOf(def);
    if (!t) return { ok: false, message: `${def.name}不能使用` };
    // 满血又没有伤情：没必要浪费
    if (this.health >= this.maxHealth && !this.med.any) return { ok: false, message: '现在用不上' };
    this.inventory.removeAt(listName, index, 1);
    if (this.ctx.playSound) this.ctx.playSound('heal');

    if (!t.duration) {
      const plan = planTreatment({ def, med: this.med, stats: this._medStats(), progress: 1 });
      applyTreatment(plan, this.med, this);
      return { ok: true, message: `用了${def.name}：${plan.messages.join('，') || '没有效果'}`, plan };
    }
    this._treat = { def, duration: t.duration, elapsed: 0 };
    return { ok: true, message: `开始用${def.name}（${t.duration.toFixed(1)} 秒，别被打断）`, treating: true };
  }

  /** 打断治疗：药已经用掉，按已完成进度给部分效果。 */
  _interruptTreat(reason) {
    const tr = this._treat;
    if (!tr) return null;
    this._treat = null;
    const progress = Math.max(0, Math.min(1, tr.elapsed / tr.duration));
    const plan = planTreatment({ def: tr.def, med: this.med, stats: this._medStats(), progress });
    applyTreatment(plan, this.med, this);
    const msg = `治疗被打断（${reason}）：只生效 ${Math.round(progress * 100)}%`;
    if (this.ctx.toast) this.ctx.toast(msg, 'bad');
    return plan;
  }

  _updateTreatment(dt) {
    const tr = this._treat;
    if (!tr) return;
    tr.elapsed += dt;
    // 包扎时别乱跑：冲刺/腾空会中断
    if (this.sprinting || !this.grounded) { this._interruptTreat(this.sprinting ? '跑动' : '腾空'); return; }
    if (tr.elapsed < tr.duration) return;
    this._treat = null;
    const plan = planTreatment({ def: tr.def, med: this.med, stats: this._medStats(), progress: 1 });
    applyTreatment(plan, this.med, this);
    if (this.ctx.toast) this.ctx.toast(`用了${tr.def.name}：${plan.messages.join('，') || '完成'}`, 'good');
  }

  serialize() {
    return {
      x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw,
      health: this.health, hunger: this.hunger, thirst: this.thirst, stamina: this.stamina,
      alive: this.alive, kills: this.kills,
      equipped: this.equipped,
      buffs: this.buffs ? this.buffs.serialize() : [],
      medical: this.med ? this.med.serialize() : null,
      weapons: [...this.weapons.values()].map((w) => w.serialize()),
      inventory: this.inventory.serialize(),
    };
  }

  restore(data) {
    if (!data) return;
    this.setPosition(Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
    this.yaw = Number(data.yaw) || 0;
    this.health = Math.min(this.maxHealth, Number(data.health) || this.maxHealth);
    this.hunger = Math.min(this.maxHunger, Number(data.hunger) || this.maxHunger);
    this.thirst = Math.min(this.maxThirst, Number(data.thirst) || this.maxThirst);
    this.stamina = Math.min(this.maxStamina, Number(data.stamina) || this.maxStamina);
    this.kills = Number(data.kills) || 0;
    this.alive = data.alive !== false;
    if (this.buffs) this.buffs.restore(data.buffs);
    if (this.med) { this.med.restore(data.medical); this._treat = null; }
    if (data.inventory) {
      this.inventory = Inventory.deserialize(data.inventory, {
        quickSlots: (this.cfg.items && this.cfg.items.quickSlots) || 6,
        onChange: () => this._syncWeapons(),
      });
      this.inventory.onChange = () => this._syncWeapons();
      this.weapons.clear();
      this._syncWeapons();
    }
    if (Array.isArray(data.weapons)) {
      for (const rec of data.weapons) {
        if (!rec || !WEAPONS[rec.id]) continue;
        if (!this.weapons.has(rec.id)) this.weapons.set(rec.id, new WeaponState(WEAPONS[rec.id]));
        const st = this.weapons.get(rec.id);
        st.ammo = Math.max(0, Math.min(st.def.magSize, Number(rec.ammo) || 0));
      }
    }
    if (data.equipped && this.weapons.has(data.equipped)) this.equipped = data.equipped;
    if (this.character) this.character.setPosition(this.pos.x, this.pos.y, this.pos.z);
  }
}

export default { Player };
