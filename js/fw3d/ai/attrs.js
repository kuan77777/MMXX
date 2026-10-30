// FW3D AI · 球员三向属性：球商 / 技术 / 体能（设计 02 §1、§2）
// 原则：
//   1. 球商只影响"选什么"（行为评分、决策延迟、风险偏好），不改球速/跑速/精度；
//   2. 技术影响"做得多准"（传球线路误差、第一脚质量、射门偏差）；
//   3. 体能影响"能不能一直做到"（跑速上限、体力消耗、动作质量衰减）。
// 数据来源：FW.state.players[id] 的 6 项属性（speed/shooting/passing/control/defense/stamina）
// 与 ca/position/fitness/morale；球商引擎里没有，用 ca + 位置档案 + 稳定哈希派生（同一球员每次一致）。
import { clamp, hash01, hashStr } from './mathx.js';

export const IQ_DIMS = ['spatial', 'tactical', 'decision', 'anticipation', 'teamwork', 'defense', 'composure'];
export const TECH_DIMS = ['passing', 'firstTouch', 'dribbling', 'shooting', 'tackling', 'heading'];

// 位置档案：球商分布 0–1（不是"能力值"，只描述这类位置的球商偏好）
const POS_IQ = {
  GK: { spatial: 0.58, tactical: 0.60, decision: 0.60, anticipation: 0.80, teamwork: 0.60, defense: 0.84, composure: 0.76 },
  CB: { spatial: 0.62, tactical: 0.64, decision: 0.66, anticipation: 0.68, teamwork: 0.66, defense: 0.86, composure: 0.70 },
  LB: { spatial: 0.66, tactical: 0.66, decision: 0.64, anticipation: 0.64, teamwork: 0.74, defense: 0.74, composure: 0.62 },
  RB: { spatial: 0.66, tactical: 0.66, decision: 0.64, anticipation: 0.64, teamwork: 0.74, defense: 0.74, composure: 0.62 },
  CM: { spatial: 0.74, tactical: 0.78, decision: 0.76, anticipation: 0.70, teamwork: 0.80, defense: 0.66, composure: 0.72 },
  AM: { spatial: 0.82, tactical: 0.78, decision: 0.76, anticipation: 0.78, teamwork: 0.68, defense: 0.50, composure: 0.68 },
  LW: { spatial: 0.84, tactical: 0.68, decision: 0.70, anticipation: 0.76, teamwork: 0.62, defense: 0.46, composure: 0.64 },
  RW: { spatial: 0.84, tactical: 0.68, decision: 0.70, anticipation: 0.76, teamwork: 0.62, defense: 0.46, composure: 0.64 },
  ST: { spatial: 0.80, tactical: 0.66, decision: 0.72, anticipation: 0.82, teamwork: 0.58, defense: 0.42, composure: 0.72 },
};
const POS_ALIAS = { CF: 'ST', DM: 'CM', CDM: 'CM', CAM: 'AM', WD: 'LW', WB: 'LB', SW: 'CB', ST: 'ST', W: 'LW' };
export function normPos(pos) {
  const p = String(pos || 'CM').toUpperCase();
  if (POS_IQ[p]) return p;
  return POS_ALIAS[p] || 'CM';
}

function jitter(seed, dim) {
  // 稳定抖动：-0.07 … +0.07
  return (hash01(hashStr(seed + '|' + dim)) - 0.5) * 0.14;
}

// 把引擎球员对象转成 AI 需要的三向属性
export function deriveAttrs(src) {
  const s = src || {};
  const ca = clamp(Number(s.ca) || 55, 20, 99);
  const pos = normPos(s.position);
  const st = s.stats || {};
  const seed = String(s.id || s.name || (pos + ca));
  const base = 0.30 + (ca / 99) * 0.56;            // 0.41（ca40）… 0.86（ca99）
  const prof = POS_IQ[pos] || POS_IQ.CM;

  const iq = {};
  for (const d of IQ_DIMS) {
    iq[d] = clamp(base * 0.45 + prof[d] * 0.55 + jitter(seed, d), 0.12, 0.96);
  }

  const pick = (v, fallback) => {
    const n = Number(v);
    return isFinite(n) ? clamp(n, 10, 99) : fallback;
  };
  const passing = pick(st.passing, ca);
  const control = pick(st.control, ca);
  const shooting = pick(st.shooting, ca);
  const defense = pick(st.defense, ca);
  const speed = pick(st.speed, ca);
  const stamina = pick(st.stamina, ca);
  const heading = (defense * 0.6 + shooting * 0.4) / 100;

  const tech = {
    passing: passing / 100,
    firstTouch: control / 100,
    dribbling: (control * 0.75 + speed * 0.25) / 100,
    shooting: shooting / 100,
    tackling: defense / 100,
    heading,
  };

  // 体力/状态：fitness 0–100、morale 0–100 影响可用体能上限与冷静
  const fitness = isFinite(Number(s.fitness)) ? clamp(Number(s.fitness), 20, 100) : 82;
  const morale = isFinite(Number(s.morale)) ? clamp(Number(s.morale), 0, 100) : 60;
  const condition = clamp(0.62 + (fitness / 100) * 0.30 + (morale / 100) * 0.08, 0.55, 1);

  const phys = {
    maxSpeed: 4.35 + (speed / 99) * 3.65,        // m/s：5.9（speed20）… 8.0（speed99）
    accel: 4.0 + (speed / 99) * 3.2,             // m/s²
    agility: 0.55 + (control / 99) * 0.45,       // 0.55–1 转身速率系数
    strength: 0.5 + (defense / 99) * 0.45,       // 对抗（第七阶段用）
    stamina: stamina / 100,                      // 0–1 体力属性（决定消耗速率）
    condition,
  };
  // 球商修正体能表现：预判好的人跑位更省力（设计 02 §1 只改"选择"，不改基础速度）
  return { id: seed, pos, ca, iq, tech, phys, name: s.name || '' };
}

// 没有任何球员数据时的兜底（例如没有存档直接看球场）
export function fallbackAttrs(seedNum, pos, name) {
  const s = String(seedNum);
  const ca = 52 + Math.round(hash01(hashStr(s + 'ca')) * 22);
  return deriveAttrs({ id: 'fb-' + s, ca, position: pos, name: name || '球员', fitness: 84, morale: 62, stats: { speed: ca, shooting: ca, passing: ca, control: ca, defense: ca, stamina: ca } });
}

// 取若干球商维度的均值（0–1）
export function iqAvg(attrs, dims) {
  if (!attrs || !attrs.iq) return 0.5;
  let sum = 0;
  for (const d of dims) sum += clamp(Number(attrs.iq[d]) || 0.5, 0, 1);
  return sum / (dims.length || 1);
}

export function techOf(attrs, key) {
  return attrs && attrs.tech && isFinite(attrs.tech[key]) ? clamp(attrs.tech[key], 0, 1) : 0.55;
}

export function physOf(attrs, key) {
  return attrs && attrs.phys && isFinite(attrs.phys[key]) ? attrs.phys[key] : 0.6;
}
