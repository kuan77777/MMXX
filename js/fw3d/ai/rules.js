// FW3D AI · 出界与重开球（设计 04 §比赛规则，路线图 Phase 6 的最小可用子集）
// 现在只做"球出界 → 判给谁 → 在哪里重开"，进球仍由引擎时间线/key moment 决定比分，
// 3D 侧只负责判定"球是否已经整体越过线"，避免球飞出场外再也回不来。
import { clamp } from './mathx.js';

export const GOAL_HALF_WIDTH = 3.66;   // 7.32 / 2
export const GOAL_HEIGHT = 2.44;
const MARGIN = 0.13;                   // 球半径 0.11 + 线宽

// 停球分档（P1 动画）：同一个"接球"动作按球高拆成地面 / 大腿 / 胸部三档
export const TRAP = { thighMin: 0.55, chestMin: 1.00, headMin: 1.55 };

/**
 * 停球部位：球越高越用上身（地面用脚、0.55–1.0 大腿、1.0–1.55 胸部、更高是头球）
 * @param {number} y 球心高度
 * @returns {'ground'|'thigh'|'chest'|'head'}
 */
export function trapZone(y) {
  const h = isFinite(y) ? y : 0;
  if (h >= TRAP.headMin) return 'head';
  if (h >= TRAP.chestMin) return 'chest';
  if (h >= TRAP.thighMin) return 'thigh';
  return 'ground';
}

/**
 * 判定是否已出界
 * @param {object} o {ball:{x,z,y}, pitch:{halfW,halfL}, lastTouchTeam}
 * @returns {null | {type, teamId, point:{x,z}, detail}}
 */
export function judgeExit(o) {
  const b = o.ball || { x: 0, z: 0, y: 0 };
  const p = o.pitch || { halfW: 34, halfL: 52.5 };
  const hw = p.halfW, hl = p.halfL;
  const outX = Math.abs(b.x) > hw + MARGIN;
  const outZ = Math.abs(b.z) > hl + MARGIN;
  if (!outX && !outZ) return null;
  const last = o.lastTouchTeam || null;

  // 1) 越过球门线且在门框内 → 进球（比分由引擎记，这里只报告事件）
  if (outZ && Math.abs(b.x) < GOAL_HALF_WIDTH && b.y < GOAL_HEIGHT + 0.12) {
    const goalSide = b.z > 0 ? 'home' : 'away';   // 球进的是 +z 门 → 主队进球
    return { type: 'goal', teamId: goalSide, point: { x: 0, z: 0 }, detail: '球进 ' + (b.z > 0 ? '+z' : '-z') + ' 门' };
  }

  // 2) 越过球门线（门框外 / 横梁以上）→ 球门球或角球
  if (outZ) {
    const lineZ = b.z > 0 ? hl : -hl;
    const attacking = b.z > 0 ? 'home' : 'away';   // 朝这条底线进攻的队
    const defending = attacking === 'home' ? 'away' : 'home';
    if (last === attacking) {
      return {
        type: 'goalKick', teamId: defending,
        point: { x: (b.x >= 0 ? 1 : -1) * 5.5, z: lineZ - Math.sign(lineZ) * 5.5 },
        detail: '进攻方触球出底线 → 球门球',
      };
    }
    return {
      type: 'corner', teamId: attacking,
      point: { x: (b.x >= 0 ? 1 : -1) * (hw - 0.8), z: lineZ - Math.sign(lineZ) * 0.8 },
      detail: '防守方触球出底线 → 角球',
    };
  }

  // 3) 越过边线 → 界外球（由最后触球方的对手掷）
  const throwTeam = last === 'home' ? 'away' : 'home';
  return {
    type: 'throwIn', teamId: throwTeam,
    point: { x: Math.sign(b.x) * (hw - 0.5), z: clamp(b.z, -hl + 2, hl - 2) },
    detail: '球出边线 → 界外球',
  };
}

/**
 * 越位判定（第六阶段，简化版）：传球瞬间接球者是否①在对方半场 ②越过倒数第二名防守者 ③比球更靠近对方球门。
 * 门将不判越位；本方半场内不越位。返回 true 表示**越位**。
 */
export function isOffside(snap, receiverId) {
  const r = snap && snap.byId ? snap.byId[receiverId] : null;
  if (!r || r.isGk) return false;
  if (r.depth < 0.5) return false;                                  // 本方半场不越位
  // 越位线按"接球者所在队"取：snapshot 里 teams[key].offsideLine 已按该队的进攻方向算出
  const line = snap.teams[r.team].offsideLine;
  const a = r.attackZ > 0 ? 1 : -1;
  const beyond = a > 0 ? r.z - line : line - r.z;                   // 越过越位线多少米
  if (beyond <= 0.05) return false;
  const ballBeyond = a > 0 ? snap.ball.z - r.z : r.z - snap.ball.z; // 球在接球者身后（不含同时）
  if (ballBeyond >= 0) return false;
  return true;
}

/** 重开球后的球速：界外球更慢，球门球/角球更远 */
export function restartKickSpeed(type, cfg) {
  const max = (cfg && cfg.pass && cfg.pass.maxPower) || 27;
  if (type === 'throwIn') return max * 0.45;
  if (type === 'goalKick') return max * 0.95;
  if (type === 'corner') return max * 0.8;
  return max * 0.6;
}

// 手球判定用的身体尺寸（与低模球员的盒子比例一致：躯干半宽 0.22 + 球 0.11，手臂外侧到 0.62）
export const HAND = { minY: 0.80, maxY: 1.55, torsoHalf: 0.30, armReach: 0.62 };

/**
 * 手球概率（第六阶段）：只判"球是否打在手臂/手上"，以及手臂是否离开身体。
 * 几何近似：球高在手臂带内、横向偏移在"躯干外侧～手臂最远"之间才算碰到手臂；
 *   - 手张开/离开身体（raised）= 判，概率 0.75；
 *   - 手臂贴身 = 多数不判（0.22，慢球再 ×0.6）；
 *   - 门将用手合法；打在自己躯干/够不到的位置一律不判；
 *   - 挡出必进球（deniedGoal）至少 0.9（arena 会再给红牌）。
 * @returns {number} 0–1
 */
export function handballChance(o) {
  const opt = o || {};
  if (opt.isGk) return 0;
  const y = isFinite(opt.ballY) ? opt.ballY : 0;
  const lat = Math.abs(isFinite(opt.lateral) ? opt.lateral : 0);
  const speed = Math.max(0, opt.ballSpeed || 0);
  if (y < HAND.minY || y > HAND.maxY) return 0;
  if (lat < HAND.torsoHalf || lat > HAND.armReach) return 0;   // 打在躯干上 / 根本够不到
  let p = 0.22;
  if (opt.raised) p = 0.75;
  if (speed < 6) p *= 0.6;
  if (opt.deniedGoal) p = Math.max(p, 0.9);
  return clamp(p, 0, 1);
}

/**
 * 定位球站位（第六阶段）：给出开球方三名球员的目标点（taker 一定在球点）
 * @param {string} type throwIn | goalKick | corner
 * @param {{x:number,z:number}} point 重开点（judgeExit 给出）
 * @param {{halfW:number,halfL:number}} geom
 */
export function setPieceTargets(type, point, geom) {
  const hw = (geom && geom.halfW) || 34, hl = (geom && geom.halfL) || 52.5;
  const clampX = (x) => Math.max(-hw + 1, Math.min(hw - 1, x));
  const clampZ = (z) => Math.max(-hl + 1, Math.min(hl - 1, z));
  const p = point || { x: 0, z: 0 };
  const sign = p.z >= 0 ? 1 : -1;            // 靠近哪条底线
  const taker = { role: 'taker', x: clampX(p.x), z: clampZ(p.z) };
  if (type === 'corner') {
    return [taker,
      { role: 'near', x: clampX(p.x * 0.55), z: clampZ(p.z - sign * 4.5) },
      { role: 'far', x: clampX(-p.x * 0.5), z: clampZ(p.z - sign * 9) }];
  }
  if (type === 'goalKick') {
    return [taker,
      { role: 'wideL', x: clampX(-18), z: clampZ(p.z - sign * 12) },
      { role: 'wideR', x: clampX(18), z: clampZ(p.z - sign * 12) }];
  }
  // 界外球：接应一近一远，都在场内 8 m 内
  return [taker,
    { role: 'supportNear', x: clampX(p.x + (p.x >= 0 ? -6 : 6)), z: clampZ(p.z - 3) },
    { role: 'supportFar', x: clampX(p.x + (p.x >= 0 ? -4 : 4)), z: clampZ(p.z + 7) }];
}
