// FW3D AI · 点球（第六阶段最后一块规则）
// 纯逻辑：禁区判定、罚球点、罚球方案（射哪边 / 门将猜哪边 / 球高 / 力量）、禁区外站位圈。
// 不 import THREE、不碰 DOM；随机源可注入，便于测试与复现。
//
// 分工：本文件只决定"怎么罚、往哪猜"，**进不进由真实物理 + keeperTick 决定**
// （球飞出去之后走的是同一套 updateBall / keeperTick / judgeExit 链路，不另开一套判定）。
import { clamp, sat } from './mathx.js';

export const PENALTY = {
  boxHalfW: 20.16,      // 禁区半宽 40.32 m
  boxDepth: 16.5,       // 禁区深度
  spotFromGoal: 11,     // 罚球点距门线 11 m
  goalHalfW: 3.66,
  goalH: 2.44,
  aimSpread: 3.0,       // 射向左右门柱内侧 3.0 m 处
};

/** 是否在 goalZ 这座球门所属球队的禁区内（|x| ≤ 20.16 且 距门线 ≤ 16.5） */
export function inPenaltyArea(x, z, goalZ) {
  if (!isFinite(x) || !isFinite(z) || !isFinite(goalZ)) return false;
  return Math.abs(x) <= PENALTY.boxHalfW && Math.abs(z - goalZ) <= PENALTY.boxDepth;
}

/** 罚球点：门线前 11 m、正对球门中心 */
export function penaltySpot(goalZ) {
  const s = goalZ >= 0 ? 1 : -1;
  return { x: 0, z: +(goalZ - s * PENALTY.spotFromGoal).toFixed(2) };
}

/**
 * 罚球方案。射手的技术/冷静决定"打飞"的风险；门将只负责猜边（扑不扑得到交给物理）。
 * @param {{shooting?:number, composure?:number, keeperAgility?:number}} o 归一化能力 0–1
 * @param {function} rng 返回 [0,1) 的随机源
 * @returns {{aimSide:-1|0|1, keeperSide:-1|0|1, aimY:number, power:number, wild:boolean, onTarget:boolean}}
 */
export function planPenalty(o, rng) {
  const opt = o || {};
  const r = typeof rng === 'function' ? rng : Math.random;
  const shooting = sat(opt.shooting == null ? 0.6 : opt.shooting);
  const composure = sat(opt.composure == null ? 0.5 : opt.composure);
  const pick = () => { const v = r(); return v < 0.36 ? -1 : v < 0.5 ? 0 : 1; };   // 略偏两侧
  const aimSide = pick();
  const keeperSide = pick();
  // 打飞：技术/冷静越差越可能。打飞时球高超过横梁，物理上就进不了
  const wild = r() < (1 - shooting) * (1 - composure) * 0.22;
  const aimY = wild ? PENALTY.goalH + 0.35 + r() * 0.7 : 0.5 + r() * 1.5;
  const power = clamp(20 + shooting * 8 + r() * 3, 18, 31);
  return {
    aimSide, keeperSide,
    aimY: +aimY.toFixed(2),
    power: +power.toFixed(1),
    wild,
    onTarget: !wild,
  };
}

/** 门将是否猜对方向 */
export function keeperGuessed(plan) {
  return !!plan && plan.keeperSide === plan.aimSide;
}

/**
 * 点球站位圈：除主罚者与门将外，其余球员退到禁区外。
 * 目标点在禁区前沿铺开、距门线 19–21.2 m（禁区 16.5 m 之外）。
 * @param {number} goalZ 攻方要打的球门
 * @param {number} count 需要站位的人数
 */
export function penaltyRing(goalZ, count) {
  const n = Math.max(1, Math.min(10, count || 8));
  const s = goalZ >= 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const x = -PENALTY.boxHalfW * 0.85 + t * PENALTY.boxHalfW * 1.7;
    const z = goalZ - s * (PENALTY.boxDepth + 2.5 + (i % 2) * 2.2);
    out.push({ x: +x.toFixed(1), z: +z.toFixed(1) });
  }
  return out;
}
