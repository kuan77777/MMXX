// FW3D AI · 一对一对抗判定（设计 04 §防守、路线图 Phase 5 的收尾）
// 只做"这次上抢能不能断下来"的概率模型，具体什么时候试、试完怎么表现由 arena 决定。
// 分离：技术（抢断/盘带）决定概率，体能状态与是否护球修正概率，球商不直接参与（避免"聪明=必断"）。
import { clamp, sat } from './mathx.js';
import { techOf } from './attrs.js';

export const DUEL = {
  attemptHz: 1.3,          // 每秒上抢尝试次数（粗略）
  baseChance: 0.34,        // 势均力敌时的单次成功率
  skillWeight: 0.95,       // 抢断-盘带差值权重
  shieldMul: 0.28,         // 持球方护球时的成功率倍率
  tiredMul: 0.72,          // 防守方体力低于阈值时的倍率
  minChance: 0.06,
  maxChance: 0.86,
  cooldown: 0.55,          // 同一名防守者两次尝试的最小间隔（秒）
  loseBalanceChance: 0.35, // 抢断失败时防守者自己失位的概率
  doubleRadius: 2.5,       // 第二名防守者在这个半径内算"包夹"
  helperMul: 0.22,         // 每多一名协同防守者的成功率加成（封顶 helperMax）
  helperMax: 2,
};

/**
 * 单次上抢成功率
 * @param {object} o {tackler, carrier, shielding, tacklerStamina, carrierStamina, cfg}
 * @returns {number} 0.06–0.86
 */
export function tackleChance(o) {
  const t = techOf(o.tackler && o.tackler.attrs, 'tackling');
  const d = techOf(o.carrier && o.carrier.attrs, 'dribbling');
  const tackleCond = o.tackler && o.tackler.attrs && o.tackler.attrs.phys ? sat(o.tackler.attrs.phys.condition) : 0.8;
  const carrierCond = o.carrier && o.carrier.attrs && o.carrier.attrs.phys ? sat(o.carrier.attrs.phys.condition) : 0.8;
  let p = DUEL.baseChance + (t - d) * DUEL.skillWeight + (tackleCond - carrierCond) * 0.3;
  if (o.shielding) p *= DUEL.shieldMul;
  const stam = o.tacklerStamina == null ? 100 : o.tacklerStamina;
  if (stam < 30) p *= DUEL.tiredMul;
  if (o.carrierStamina != null && o.carrierStamina < 25) p *= 1.15;
  // 协防包夹：第二名防守者贴身时更难护住球（只加成，不改判定规则本身）
  const helpers = Math.max(0, Math.min(DUEL.helperMax, o.helpers == null ? 0 : o.helpers));
  p *= 1 + helpers * DUEL.helperMul;
  return clamp(p, DUEL.minChance, DUEL.maxChance);
}

/** 每帧尝试概率（把"每秒尝试次数"折算到 dt） */
export function tackleRoll(dt, hz) {
  return clamp((hz || DUEL.attemptHz) * Math.max(0, dt), 0, 1);
}

/**
 * 犯规概率（第六阶段）：从背后上抢、冲刺中、抢断技术差 → 更容易犯规
 * @param {object} o {angleCos, speed, tackling}
 *   angleCos：防守者相对持球者朝向的夹角余弦（-1 = 正后方，1 = 正面）
 * @returns {number} 0.02–0.34
 */
export function foulChance(o) {
  const cos = isFinite(o && o.angleCos) ? o.angleCos : 1;
  const speed = isFinite(o && o.speed) ? o.speed : 0;
  const tech = o && isFinite(o.tackling) ? o.tackling : 0.6;
  const behind = Math.max(0, -cos - 0.15) / 1.15;     // 背后 → 0..1
  const fast = Math.min(1, Math.max(0, speed) / 8);
  return clamp(0.03 + 0.16 * behind + 0.07 * fast + (1 - tech) * 0.08, 0.02, 0.34);
}

/**
 * 门将二次扑救成功率（第七阶段）：第一次扑救后再起身的反应窗口，成功率显著低于第一次
 * @param {number} firstChance 第一次扑救的成功率（0–1）
 * @returns {number} 0.04–0.5
 */
export function secondSaveChance(firstChance) {
  const f = isFinite(firstChance) ? clamp(firstChance, 0, 1) : 0.6;
  return clamp(f * 0.55, 0.04, 0.5);
}

// ── 铲球（滑铲）：什么时候选滑铲、倒地多久 ──────────────────────────────────
export const SLIDE = {
  minDist: 1.0,        // 最近可下脚距离
  maxDist: 2.6,        // 最远可下脚距离
  recover: 0.95,       // 铲成功：自己倒地多久才能起身
  downed: 1.15,        // 铲失败/被过：倒地多久
  foulBonus: 0.26,     // 从侧后方的滑铲额外犯规率（亮鞋底）
  reach: 1.35,         // 铲到球的判定半径（比站着的抢断略长）
};

/**
 * 选择滑铲的概率（不是"铲到球"的概率，是"防守者选不选择铲"）
 * 距离近 / 从侧后方来 / 速度快 / 抢断技术好 → 更倾向滑铲
 * @param {{dist?:number, angleCos?:number, speed?:number, tackling?:number}} o
 * @returns {number} 0.02–0.72
 */
export function slideTackleChance(o) {
  const opt = o || {};
  const dist = clamp(isFinite(opt.dist) ? opt.dist : 1.6, 0.4, 4);
  const cos = clamp(isFinite(opt.angleCos) ? opt.angleCos : -0.3, -1, 1);
  const tackling = clamp(isFinite(opt.tackling) ? opt.tackling : 0.6, 0, 1);
  const speed = Math.max(0, isFinite(opt.speed) ? opt.speed : 0);
  const base = 0.14 + tackling * 0.30;
  const near = clamp(1.12 - Math.abs(dist - 1.7) * 0.5, 0.15, 1.12);
  const behind = clamp(0.58 - cos * 0.42, 0.12, 1);      // 侧后方/正后方 → 高
  const pace = clamp(0.55 + speed / 12, 0.55, 1.2);
  return clamp(base * near * behind * pace, 0.02, 0.72);
}

/** 滑铲后的起身时间（铲成功 0.95 s / 失误 1.15 s，抢断技术好的人快一点） */
export function getUpTime(o) {
  const opt = o || {};
  const failed = !!opt.failed;
  const tackling = clamp(isFinite(opt.tackling) ? opt.tackling : 0.6, 0, 1);
  const base = failed ? SLIDE.downed : SLIDE.recover;
  return +(base * (1.1 - tackling * 0.25)).toFixed(2);
}

/**
 * 争顶胜负（第七阶段）：a 赢下这次头球的概率
 * 只看身体对抗（strength）与位置（posQuality：离落点多近，0–1），不看球商
 * @returns {number} 0.12–0.88
 */
export function aerialDuel(a, b) {
  const sa = (a && a.attrs && a.attrs.phys && a.attrs.phys.strength) || 0.6;
  const sb = (b && b.attrs && b.attrs.phys && b.attrs.phys.strength) || 0.6;
  const pa = a && isFinite(a.posQuality) ? a.posQuality : 0.6;
  const pb = b && isFinite(b.posQuality) ? b.posQuality : 0.6;
  return clamp(0.5 + (sa - sb) * 0.9 + (pa - pb) * 0.35, 0.12, 0.88);
}

/** 人墙站位：离球 9.15 m，两名防守者左右各偏 0.6 m（朝攻方球门方向排开） */export function freeKickWall(point, attackSign, count) {
  const n = Math.max(0, Math.min(3, count == null ? 2 : count));
  const out = [];
  const s = attackSign >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * 1.2;
    out.push({ x: point.x + off, z: point.z + s * 9.15 });
  }
  return out;
}
