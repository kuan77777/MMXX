// FW3D AI · PlayerMotor（设计 03 §4、01 §3）
// 只做一件事：把 {目标点, 期望速度} 变成速度与位移。AI 不写位置，位置只由这里改。
// 处理：起步加速 / 急停 / 转身延迟 / 侧向减速 / 体力 / 球员间避让 / 场地边界。
import { clamp, sat, lerp, dist, vnorm, angLerp } from './mathx.js';

// pace 0 = 站住，0.6 = 慢跑，1 = 冲刺
export function paceToSpeed(pace, cfg) {
  const M = cfg.motor;
  const p = sat(pace);
  if (p <= 0) return 0;
  if (p <= 0.6) return lerp(M.walk, M.jog, p / 0.6);
  return lerp(M.jog, M.sprint, (p - 0.6) / 0.4);
}

export function maxSpeedOf(a, cfg) {
  const phys = a.attrs && a.attrs.phys ? a.attrs.phys : null;
  const base = phys && isFinite(phys.maxSpeed) ? phys.maxSpeed : cfg.motor.jog * 1.5;
  const cond = phys && isFinite(phys.condition) ? phys.condition : 1;
  let v = base * (0.88 + 0.12 * sat(cond));
  if (a.stamina < cfg.motor.tiredBelow) v *= cfg.motor.tiredSpeedMul;
  return Math.min(v, cfg.motor.sprint * 1.02);
}

/**
 * 移动方向 vs 身体朝向 → 步态种类（第一阶段：侧移/后退专用姿态的依据）
 * 朝向向量 = (sin(facing), cos(facing))；cos>0.72 视为向前跑，cos<-0.5 视为后退，其余为侧移。
 * @returns {{kind:'idle'|'forward'|'strafe'|'back', side:number, cos:number}}
 */
export function moveKindOf(vx, vz, facing) {
  const sp = Math.hypot(vx || 0, vz || 0);
  const f = facing || 0;
  if (sp < 0.35) return { kind: 'idle', side: 0, cos: 1 };
  const fx = Math.sin(f), fz = Math.cos(f);
  const cos = (vx * fx + vz * fz) / sp;
  // side: >0 表示朝身体右侧移动（右手系，x 向量的叉积符号）
  const side = Math.sign(fx * vz - fz * vx) || 1;
  if (cos > 0.72) return { kind: 'forward', side: 0, cos: +cos.toFixed(3) };
  if (cos < -0.5) return { kind: 'back', side, cos: +cos.toFixed(3) };
  return { kind: 'strafe', side, cos: +cos.toFixed(3) };
}

/**
 * 玩家电机补偿（第二阶段收尾）：把 NPC 电机的属性映射到玩家原本的街机手感。
 *
 * 背景（实测，见 `arena.playerMotorAB()`）：NPC 电机的最高速来自 `attrs.phys.maxSpeed`
 * （真实球员 4.3–8.0，且再被 `cfg.motor.sprint*1.02` 夹到 8.06），而玩家一直用的是
 * `sprMax = sprint*(0.72+speed/100*0.5)`（8.4–9.1）。直接把玩家切到电机 = 冲刺掉 25%、
 * 到 80% 速度从 0.17 s 变成 0.88 s。这里用一份"克隆 + 覆盖 phys"的属性让电机跑出同样的
 * 最高速与更快的起步，**不改传入对象、也不改全局 cfg**。
 *
 * @param {object} attrs 原属性（不会被修改）
 * @param {{maxSpeed?:number, accel?:number}} tuning 目标最高速 / 加速度
 * @returns {object} 新的 attrs
 */
export function tunedAttrs(attrs, tuning) {
  const t = tuning || {};
  const src = attrs || {};
  const phys = Object.assign({}, src.phys || {});
  if (isFinite(t.maxSpeed)) phys.maxSpeed = t.maxSpeed;
  if (isFinite(t.accel)) phys.accel = t.accel;
  return Object.assign({}, src, { phys, tuned: true });
}

// 推荐补偿值（玩家 sprint ≈ 8.4–9.1 m/s、旧模型到 80% 约 0.17 s）。
// 上限说明：maxSpeedOf() 会把结果夹到 cfg.motor.sprint*1.02 ≈ 8.06，pace 也被 paceToSpeed 夹在 7.9，
// 所以再加一个 sprintMul 把期望速度补到 8.0 左右；accel 18 把 t80 从 0.88 s 压到 ~0.35 s。
export const ARCADE_TUNING = { maxSpeed: 8.3, accel: 18, sprintMul: 1.07 };

/**
 * 电机运动剖面（纯计算）：起步 → 接近最高速 → 急停，返回可对比的数字。
 * 与 NPC 实际跑的 stepPlayer 完全同一条路径（自检/调参/回归都用它）。
 * @returns {{top:number, cap:number, t80:number, run:number, stop:number, stopT:number}}
 */
export function motorProfile(attrs, cfg, opts) {
  const o = opts || {};
  const dt = o.dt || 1 / 60;
  const a = { x: 0, z: 0, vx: 0, vz: 0, facing: 0, stamina: 100, attrs };
  const cap = maxSpeedOf(a, cfg);
  let t80 = 0, top = 0, run = 0;
  for (let i = 0; i < 300; i++) {
    stepPlayer(a, { x: 0, z: 100, pace: o.pace == null ? 1 : o.pace, sprintMul: o.sprintMul }, dt, cfg, null, null);
    const sp = Math.hypot(a.vx, a.vz);
    top = Math.max(top, sp);
    run += sp * dt;
    if (!t80 && sp >= cap * 0.8) t80 = (i + 1) * dt;
  }
  let stopT = 0, stop = 0;
  while (Math.hypot(a.vx, a.vz) > 0.2 && stopT < 5) {
    stepPlayer(a, { x: a.x, z: a.z, pace: 0 }, dt, cfg, null, null);
    stop += Math.hypot(a.vx, a.vz) * dt;
    stopT += dt;
  }
  return { top: +top.toFixed(2), cap: +cap.toFixed(2), t80: +t80.toFixed(2), run: +run.toFixed(1), stop: +stop.toFixed(2), stopT: +stopT.toFixed(2) };
}

/**
 * 推进一个球员一帧
 * @param {object} a 运行时球员 {x,z,vx,vz,facing,stamina,attrs}
 * @param {object} intent {x,z,pace}
 * @param {number} dt
 * @param {object} cfg
 * @param {object} bounds {halfW,halfL}
 * @param {Array} others 其它球员（用于分离力），可为 null
 */
export function stepPlayer(a, intent, dt, cfg, bounds, others) {
  const M = cfg.motor;
  const phys = a.attrs && a.attrs.phys ? a.attrs.phys : { accel: 5, agility: 0.8, stamina: 0.6 };
  const maxV = maxSpeedOf(a, cfg);
  // intent.sprintMul：只在玩家侧用于"补偿到街机手感"（NPC 不传，等价 ×1）
  const sprintMul = intent && isFinite(intent.sprintMul) ? intent.sprintMul : 1;
  let want = Math.min(paceToSpeed(intent ? intent.pace : 0, cfg) * sprintMul, maxV);

  const tx = intent ? intent.x : a.x;
  const tz = intent ? intent.z : a.z;
  const d = dist(a.x, a.z, tx, tz);
  if (d < cfg.target.deadzone) want = 0;
  else if (d < cfg.target.arriveFade) want *= d / cfg.target.arriveFade;

  // 期望速度向量
  let dvx = 0, dvz = 0;
  if (want > 0.01 && d > 0.05) {
    const dir = vnorm({ x: tx - a.x, z: tz - a.z });
    dvx = dir.x * want;
    dvz = dir.z * want;
  }

  const curSpeed = Math.hypot(a.vx, a.vz);
  const wantDist = Math.hypot(dvx - a.vx, dvz - a.vz);
  // 加速 vs 制动：制动更快（急停），但转向要付代价
  const accelerating = want >= curSpeed;
  let accel = phys.accel * (accelerating ? 1 : M.brakeMul);
  if (curSpeed > 0.4 && want > 0.01) {
    const cos = (a.vx * dvx + a.vz * dvz) / Math.max(0.001, curSpeed * want);
    if (cos < 0.2) accel *= 0.55;          // 反向/大角度变向：起步慢
  }
  const maxDv = accel * Math.max(0.001, dt);
  if (wantDist > 0.0001 && wantDist > maxDv) {
    a.vx += (dvx - a.vx) / wantDist * maxDv;
    a.vz += (dvz - a.vz) / wantDist * maxDv;
  } else {
    a.vx = dvx; a.vz = dvz;
  }

  // 球员间避让：靠得太近就互推（不做硬碰撞，第七阶段再做对抗）
  if (others && others.length) {
    for (const o of others) {
      if (o === a) continue;
      const dx = a.x - o.x, dz = a.z - o.z;
      const dd = Math.hypot(dx, dz);
      if (dd > 0.001 && dd < M.separationRadius) {
        const push = (M.separationRadius - dd) / M.separationRadius * M.separation;
        a.vx += dx / dd * push * 2.2;
        a.vz += dz / dd * push * 2.2;
      }
    }
  }

  // 积分
  a.x += a.vx * dt;
  a.z += a.vz * dt;

  // 边界
  const margin = 0.7;
  if (bounds) {
    if (a.x < -bounds.halfW + margin) { a.x = -bounds.halfW + margin; a.vx = Math.max(0, a.vx); }
    if (a.x > bounds.halfW - margin) { a.x = bounds.halfW - margin; a.vx = Math.min(0, a.vx); }
    if (a.z < -bounds.halfL + margin) { a.z = -bounds.halfL + margin; a.vz = Math.max(0, a.vz); }
    if (a.z > bounds.halfL - margin) { a.z = bounds.halfL - margin; a.vz = Math.min(0, a.vz); }
  }

  const speed = Math.hypot(a.vx, a.vz);
  // 朝向：朝速度方向转（转身速度受 agility 影响）
  if (speed > 0.35) {
    const desired = Math.atan2(a.vx, a.vz);
    a.facing = angLerp(a.facing || 0, desired, clamp((M.turnRate * sat(phys.agility || 0.8)) * dt, 0, 1));
  } else if (intent && d > cfg.target.deadzone && want < 0.1) {
    // 站住时朝向目标（等球/接应）
    a.facing = angLerp(a.facing || 0, Math.atan2(tx - a.x, tz - a.z), clamp(4 * dt, 0, 1));
  }

  // 体力
  const sprinting = speed > cfg.motor.jog * 1.04;
  if (sprinting) {
    a.stamina = clamp(a.stamina - M.staminaDrain * (1.35 - sat(phys.stamina || 0.6)) * dt, 0, 100);
  } else {
    a.stamina = clamp(a.stamina + M.staminaRecover * dt, 0, 100);
  }

  return { speed, moved: speed * dt, arrived: want === 0 && speed < 0.2, moveKind: moveKindOf(a.vx, a.vz, a.facing).kind };
}
