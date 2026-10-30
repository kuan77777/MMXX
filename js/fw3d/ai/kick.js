// FW3D AI · KickResolver（设计 03 §3、路线图 Phase 2）
// 只负责一件事：把"踢球意图"翻译成球的初始速度与旋转，并给出可解释的执行误差。
// 不负责把球瞬移，也不负责判定球权（分别由物理积分与 match-state 管）。
import { clamp, sat, gauss, vnorm, dist } from './mathx.js';
import { techOf, iqAvg } from './attrs.js';

// 球的滚动线性减速度（m/s²）。物理侧（arena.updateBall）必须用同一个值，
// 否则 AI 算出来的传球会系统性偏短或偏长。
export const ROLL_DECEL = 1.7;
export const AIR_DRAG = 0.0016;      // 与 arena 的 BALL.dragK 保持一致
export const MAX_SPEED = 35;         // 与 arena 的 BALL.maxSpeed 保持一致

// 地滚球：给定距离与期望到达球速，反解初速
export function groundSpeedFor(distance, arriveSpeed) {
  const d = Math.max(0.5, distance);
  const va = clamp(arriveSpeed == null ? 4.5 : arriveSpeed, 1, 14);
  return Math.min(MAX_SPEED, Math.sqrt(va * va + 2 * ROLL_DECEL * d));
}

function skillErr(attrs, pressure, cfg, weight) {
  const skill = techOf(attrs, weight === 'shot' ? 'shooting' : 'passing');
  const compo = iqAvg(attrs, ['composure']);
  const p = sat(pressure || 0);
  // 技术越好、越冷静，误差越小；压力使误差上升（设计 03 §3.5）
  const base = (1 - skill) * 0.115 + p * 0.075;
  return base * (cfg.difficulty.errorScale || 1) * (1 - compo * 0.42);
}

function rotateDir(d, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: d.x * c - d.z * s, z: d.x * s + d.z * c };
}

/**
 * 传球求解
 * @returns {{vx,vz,vy,spin:{x,y,z},speed,sigma,lofted,bad}}
 */
export function solvePass(o) {
  const from = o.from, to = o.to;
  const cfg = o.cfg;
  const d = dist(from.x, from.z, to.x, to.z);
  let dir = vnorm({ x: to.x - from.x, z: to.z - from.z });
  if (!dir.x && !dir.z) dir = { x: 0, z: -1 };
  const sigma = skillErr(o.attrs, o.pressure, cfg, 'pass');
  const err = gauss() * sigma;
  dir = rotateDir(dir, err);

  const P = cfg.pass;
  let speed, vy;
  let lofted = false;
  if (d > 24) {
    // 长距离用空中球：飞行时间决定仰角与水平速度，避免被地滚摩擦吃掉
    lofted = true;
    const T = clamp(d / 16, 1.1, 2.5);
    speed = clamp(d / T, P.minPower, Math.min(22, P.maxPower + 6));
    vy = 0.5 * 9.81 * T;
  } else {
    speed = clamp(groundSpeedFor(d, P.arriveSpeed + (1 - sigma) * 1.5), P.minPower, P.maxPower);
    vy = 0.9 + d * 0.015;    // 轻微离地，避免贴地瞬移观感
  }
  // 长传/直塞允许一点点侧旋（弧线），但不要夸张
  const spinY = (err >= 0 ? 1 : -1) * speed * 0.18 * (1 - techOf(o.attrs, 'passing')) * 3;
  return {
    vx: dir.x * speed, vz: dir.z * speed, vy,
    spin: { x: 0, y: clamp(spinY, -4, 4), z: 0 },
    speed, sigma, lofted, bad: sigma > 0.09,
  };
}

/**
 * 高球解算（玩家的长传 / 传中 / 挑传专用）
 *
 * 和 solvePass 的区别只有一个，但很关键：**不论距离远近一定离地**。
 * solvePass 只有 d > 24 m 才走抛射，否则给一颗 vy≈1 米的地滚球 —— 对 AI 是合理的，
 * 但玩家按"长传"要看的是过顶球而不是又一颗贴地滚。所以这里显式解仰角：
 * 用飞行时间 T 反解，水平速度 = 距离 / T，垂直初速 = g·T/2（同一时间落回地面）。
 *
 * @returns {{vx,vy,vz,spin,speed,sigma,lofted,flightTime,apex,bad}}
 */
export function solveLoft(o) {
  const from = o.from, to = o.to, cfg = o.cfg;
  const d = Math.max(2.5, dist(from.x, from.z, to.x, to.z));
  let dir = vnorm({ x: to.x - from.x, z: to.z - from.z });
  if (!dir.x && !dir.z) dir = { x: 0, z: -1 };
  const sigma = skillErr(o.attrs, o.pressure, cfg, 'pass') * (o.sigmaMul == null ? 1 : o.sigmaMul);
  dir = rotateDir(dir, gauss() * sigma);
  // 飞行时间随距离增长：短传中约 1.2 s，40 m 长传约 2.7 s，上限 3.2 s（≈门将开大脚）
  const T = clamp(o.flightTime || (0.55 + d * 0.055), 0.5, 3.2);
  const speedH = clamp(d / T, 5, 26);
  const vy = 0.5 * 9.81 * T;
  // 长传带一点侧旋（弧线），技术越好越直
  const spinY = (gauss() > 0 ? 1 : -1) * speedH * 0.12 * (1 - techOf(o.attrs, 'passing'));
  return {
    vx: dir.x * speedH, vz: dir.z * speedH, vy,
    spin: { x: 0, y: clamp(spinY, -3, 3), z: 0 },
    speed: speedH, sigma, lofted: true, flightTime: T,
    apex: (vy * vy) / (2 * 9.81),        // 预计最高点（m）：自检据此断言"球真的离地了"
    bad: sigma > 0.09,
  };
}

/** 射门求解 */export function solveShot(o) {
  const from = o.from;
  const cfg = o.cfg;
  const goal = o.goal || { x: 0, z: o.goalZ };
  const d = dist(from.x, from.z, goal.x, goal.z);
  let dir = vnorm({ x: goal.x - from.x, z: goal.z - from.z });
  const sigma = skillErr(o.attrs, o.pressure, cfg, 'shot');
  dir = rotateDir(dir, gauss() * sigma);
  const power = clamp(o.power || 22, cfg.shot.minPower, cfg.shot.maxPower);
  const vy = clamp(power * 0.085 + d * 0.012, 0.5, 3.0);
  const spinY = (gauss() > 0 ? 1 : -1) * power * 0.25 * (1 - techOf(o.attrs, 'shooting'));
  return {
    vx: dir.x * power, vz: dir.z * power, vy,
    spin: { x: 0, y: clamp(spinY, -6, 6), z: 0 },
    speed: power, sigma, onTarget: sigma < 0.055, bad: sigma > 0.085,
  };
}

/**
 * 门将分球决策（第七阶段）：25 m 内有队友就手抛球，否则开大脚到前场边路
 * @param {{x,z,attackZ}} gk
 * @param {Array} mates 本方非门将球员
 * @returns {{mode:'throw'|'punt', targetId:string|null, point:{x,z}, speed:number, loft:number}}
 */
export function keeperDistribution(gk, mates) {
  let best = null, bd = 25;
  for (const m of (mates || [])) {
    if (!m) continue;
    const d = Math.hypot(m.x - gk.x, m.z - gk.z);
    if (d < bd) { bd = d; best = m; }
  }
  if (best) return { mode: 'throw', targetId: best.id, point: { x: best.x, z: best.z }, speed: 12, loft: 1.6 };
  const sign = (gk.attackZ || 1) >= 0 ? 1 : -1;
  return { mode: 'punt', targetId: null, point: { x: gk.x * 0.3, z: gk.z + sign * 38 }, speed: 26, loft: 6.5 };
}

/**
 * 门柱 / 横梁碰撞（第一阶段补齐球物理）：返回修正后的速度、命中类型与接触点
 * 门宽 7.32（柱在 x=±3.66）、门高 2.44、柱半径 0.06 + 球半径 0.11 = 判定半径 0.17
 *
 * 两层判定：
 *  ① 采样判定：当前帧位置已经在柱/横梁判定半径内（慢球、贴柱滚动）。
 *  ② 连续判定（防穿透）：传入 prev（本帧积分前的位置）时，用 prev→当前位置的线段
 *     与球门平面求交。渲染帧 dt 被钳在 0.05 s，一脚 22 m/s 的射门单帧位移 1.1 m，
 *     而判定窗口只有 0.34 m —— 只做采样的话快球会直接穿过门柱、还会被 judgeExit
 *     误判成进球。求交后同时返回接触点，调用方把球放回门前，避免误判。
 * @returns {{vx,vy,vz,hit:'post'|'bar'|null,point:{x,y,z}|null}}
 */
export function resolveGoalFrame(b, goalZ, prev) {
  const RR = 0.06 + 0.11;
  const HALF = 3.66, H = 2.44;
  const out = { vx: b.vx || 0, vy: b.vy || 0, vz: b.vz || 0, hit: null, point: null };
  const bx = b.x || 0, by = b.y || 0, bz = b.z || 0;
  const dz = bz - goalZ;
  if (Math.abs(dz) < RR + 0.05 && by <= H + 0.11) {
    for (const sx of [-1, 1]) {
      const dx = bx - sx * HALF;
      const d = Math.hypot(dx, dz);
      if (d < RR) {
        const nx = dx / (d || 1), nz = dz / (d || 1);
        const vn = out.vx * nx + out.vz * nz;
        if (vn < 0) { out.vx -= 2 * vn * nx; out.vz -= 2 * vn * nz; }
        out.vx *= 0.65; out.vz *= 0.65;
        out.hit = 'post';
        out.point = { x: bx, y: by, z: bz };
        break;
      }
    }
  }
  if (!out.hit && Math.abs(bx) < HALF && Math.abs(dz) < 0.6 && Math.abs(by - H) < RR) {
    if (out.vy > 0) out.vy = -out.vy * 0.6;
    out.hit = 'bar';
    out.point = { x: bx, y: by, z: bz };
  }
  // ② 连续判定：本帧是否跨过了球门平面，且交点落在柱/横梁截面内
  if (!out.hit && prev && typeof prev.z === 'number') {
    const px = prev.x || 0, py = prev.y || 0, pz = (prev.z || 0) - goalZ;
    const cz = dz;
    if ((pz > 0 && cz <= 0) || (pz < 0 && cz >= 0)) {
      const den = cz - pz;
      const u = Math.abs(den) > 1e-9 ? Math.max(0, Math.min(1, -pz / den)) : 1;
      const cx = px + (bx - px) * u;
      const cy = py + (by - py) * u;
      const side = pz > 0 ? 1 : -1;          // 从球门平面的哪一侧撞上来
      for (const sx of [-1, 1]) {
        const dx = cx - sx * HALF;
        if (Math.abs(dx) >= RR || cy > H + 0.11) continue;
        // 球心在柱面上、朝来袭一侧：法向 = (dx, side*sqrt(RR²-dx²))
        const nzr = Math.sqrt(Math.max(0.0004, RR * RR - dx * dx));
        const nx = dx / RR, nz = side * nzr / RR;
        const vn = out.vx * nx + out.vz * nz;
        if (vn < 0) { out.vx -= 2 * vn * nx; out.vz -= 2 * vn * nz; }
        out.vx *= 0.65; out.vz *= 0.65;
        out.hit = 'post';
        out.point = { x: cx, y: cy, z: goalZ + side * (nzr + 0.02) };
        break;
      }
      if (!out.hit && Math.abs(cx) < HALF && Math.abs(cy - H) < RR) {
        out.vy = out.vy > 0 ? -out.vy * 0.6 : -1.5;
        out.hit = 'bar';
        out.point = { x: cx, y: Math.max(by, H - 0.12), z: goalZ + side * 0.3 };
      }
    }
  }
  return out;
}

/**
 * 头球决策（第七阶段）：离对方球门近 → 攻门；否则解围
 * @returns {'shot'|'clear'}
 */
export function headerDecision(o) {
  const dGoal = Math.hypot((o.x || 0) - 0, (o.z || 0) - (o.goalZ || 0));
  if (dGoal < 14 && (o.speed || 0) > 2) return 'shot';
  return 'clear';
}

/** 解围：朝边线/前场大脚，误差更大（技术占比更低） */export function solveClear(o) {
  const from = o.from;
  const cfg = o.cfg;
  const point = o.point || { x: from.x, z: from.z + (o.attackZ || 1) * 34 };
  let dir = vnorm({ x: point.x - from.x, z: point.z - from.z });
  const sigma = skillErr(o.attrs, o.pressure, cfg, 'pass') * 1.35;
  dir = rotateDir(dir, gauss() * sigma);
  const power = clamp(o.power || cfg.pass.maxPower, 14, 30);
  return {
    vx: dir.x * power, vz: dir.z * power, vy: 4.6,
    spin: { x: 0, y: 0, z: 0 }, speed: power, sigma, bad: false,
  };
}
