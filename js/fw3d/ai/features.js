// FW3D AI · 归一化特征（设计 02 §6、01 §7「行为得分需归一化」）
// 所有函数都返回 0–1 或绝对坐标，禁止把距离、角度、概率直接相加。
import { clamp, sat, norm, bell, dist, vsub, vnorm, vdot, vlen, vadd, vmul, lerp } from './mathx.js';
import { isOffside } from './rules.js';

/**
 * 传球线路风险 0–1：取对手到线路的垂直距离与投影位置，最危险的那个决定主项。
 * from/to: {x,z}；opponents: 球员数组（vx/vz 可选）
 */
export function laneRisk(from, to, opponents, opts) {
  const blockR = (opts && opts.blockRadius) || 1.55;
  const dx = to.x - from.x, dz = to.z - from.z;
  const L2 = dx * dx + dz * dz;
  if (L2 < 0.36 || !opponents || !opponents.length) return 0;
  const L = Math.sqrt(L2);
  const nx = -dz / L, nz = dx / L;      // 线路法向
  let worst = 0, sum = 0, n = 0;
  for (const o of opponents) {
    const t = ((o.x - from.x) * dx + (o.z - from.z) * dz) / L2;
    if (t < -0.06 || t > 1.06) continue;
    const px = from.x + dx * t, pz = from.z + dz * t;
    const perp = Math.hypot(o.x - px, o.z - pz);
    if (perp >= blockR) continue;
    const close = 1 - perp / blockR;
    const tt = clamp(t, 0, 1);
    // 中段最难绕，靠近两端的拦截威胁小一些
    const w = 0.58 + 0.42 * (1 - Math.abs(tt - 0.5) * 2);
    // 朝线路移动的对手更容易断
    const closing = sat(Math.abs((o.vx || 0) * nx + (o.vz || 0) * nz) / 6);
    const c = close * w * (0.78 + 0.42 * closing);
    if (c > worst) worst = c;
    sum += c; n++;
  }
  if (!n) return 0;
  return sat(0.72 * worst + 0.28 * (sum / n));
}

/** 越位风险 0–1（简化：对方半场、越过越位线才开始计风险） */
export function offsideRisk(p, snap) {
  const line = snap.teams[p.team === 'home' ? 'away' : 'home'].offsideLine;
  const a = p.attackZ;
  if (p.depth < 0.5) return 0;                      // 自己半场不可能越位
  const beyond = a > 0 ? p.z - line : line - p.z;   // 越过越位线多少米
  if (beyond <= 0.15) return 0;
  return sat(beyond / 6);
}

/** 接应角度质量：侧前方最好（与"持球者→球门"方向夹角 ≈ 60–70°） */
export function supportAngle(carrier, me, goalZ) {
  const g = vnorm({ x: 0 - carrier.x, z: goalZ - carrier.z });
  const v = vnorm(vsub(me, carrier));
  const cos = vdot(v, g);
  // 目标 cos ≈ 0.35（侧前方）；正后方 -1 → 0 分
  return sat(1 - Math.abs(cos - 0.35) / 1.15);
}

/** 阵型基准点：随球横移、随球推进前后移动（设计 01 §6） */
export function shapeAt(p, snap, cfg) {
  const t = cfg.team;
  const halfL = snap.pitch.halfL, halfW = snap.pitch.halfW;
  const attacking = snap.ball.ownerTeam === p.team || (!snap.ball.ownerTeam && snap.ball.candidateId && snap.teamOf[snap.ball.candidateId] === p.team);
  const widthMul = attacking ? t.attackWidth : t.defendWidth;
  const ballProg = clamp((snap.ball.z * p.attackZ) / halfL, -1, 1);   // +1 = 球在对方底线
  const depthShift = (attacking ? t.attackDepth : t.defendDepth) * 20 + ballProg * 11 * (attacking ? 1.05 : 0.8);
  let x = p.shape.x * widthMul + snap.ball.x * t.ballPull * 0.6;
  let z = p.shape.z * (attacking ? 0.98 : 0.92) + depthShift * p.attackZ;
  // 越位陷阱（第五阶段收尾）：条件满足时整条防线统一前压，把对手前锋留在越位位置
  if (!attacking) z += offsideTrap(snap, p.team, cfg).step * p.attackZ;
  x = clamp(x, -halfW + 2, halfW - 2);
  z = clamp(z, -halfL + 2, halfL - 2);
  return { x, z };
}

/**
 * 围抢分区（第五阶段收尾）：把防守方分成"有球侧 / 无球侧"。
 * 有球侧的人去逼抢、包夹；无球侧的人保持阵型宽度，避免全队被一脚横传拉空。
 * @returns {{ballSide:number, isBallSide:boolean, lateral:number}}
 */
export function pressPartition(snap, me, carrier) {
  if (!carrier) return { ballSide: 0, isBallSide: true, lateral: 0 };
  const ballSide = carrier.x >= 0 ? 1 : -1;
  const mySide = me.x >= 0 ? 1 : -1;
  const lateral = Math.abs(me.x - carrier.x);
  const central = Math.abs(me.x) < 6;        // 中路球员算有球侧（能协防/补位）
  return { ballSide, isBallSide: mySide === ballSide || central, lateral: +lateral.toFixed(1) };
}

/**
 * 越位陷阱（造越位）：防守方在"球在远处 + 持球者被压迫 + 防线本来就不低"时整条线前压。
 * 返回 step 为前压米数（0 = 不造越位）。压迫解除或球进本方半场会自动解除。
 * @returns {{armed:boolean, step:number, line:number, pressure:number}}
 */
export function offsideTrap(snap, teamKey, cfg) {
  const team = snap.teams[teamKey];
  if (!team) return { armed: false, step: 0, line: 0, pressure: 0 };
  const owner = snap.ball.owner;
  const pressure = owner ? (owner.pressure || 0) : 0;
  const ownGoalZ = team.ownGoalZ;
  const ballFromGoal = Math.abs((snap.ball.z || 0) - ownGoalZ);
  const lineFromGoal = Math.abs(team.defenderLineZ - ownGoalZ);
  const highLine = (cfg.team.defendDepth == null ? -0.1 : cfg.team.defendDepth) >= -0.12;  // 低位/反击不造越位
  const armed = !!owner && owner.team !== teamKey && ballFromGoal > 32 && pressure > 0.35 && lineFromGoal > 14 && highLine;
  return {
    armed,
    step: armed ? Math.min(3, 1.2 + pressure * 3) : 0,
    line: +team.defenderLineZ.toFixed(1),
    pressure: +pressure.toFixed(2),
  };
}

/** 点位危险度 0–1：离我方球门越近、越居中越危险（防守行为用） */
export function dangerOf(point, snap, teamKey) {
  const team = snap.teams[teamKey];
  const ownZ = team.ownGoalZ;
  const d = dist(point.x, point.z, 0, ownZ);
  const central = 1 - sat(Math.abs(point.x) / (snap.pitch.halfW * 1.05)) * 0.55;
  return sat((1 - sat(d / 48)) * central);
}

/** 前插点：走向对方防线身后，避开越位线 */
export function runBehindPoint(me, snap) {
  const a = me.attackZ;
  const oppTeam = snap.teams[me.team === 'home' ? 'away' : 'home'];
  const line = oppTeam.defenderLineZ;
  const targetZ = line + a * (2.5 + Math.abs(me.shape.x) * 0.05);
  const x = clamp(me.x * 0.72 + me.shape.x * 0.28, -snap.pitch.halfW + 4, snap.pitch.halfW - 4);
  return { x, z: clamp(targetZ, -snap.pitch.halfL + 4, snap.pitch.halfL - 4) };
}

/** 拉边点 */
export function widthPoint(me, snap, side) {
  const halfW = snap.pitch.halfW;
  const dir = side === 'right' ? 1 : -1;
  const x = clamp(dir * (halfW - 4.5), -halfW + 3, halfW - 3);
  return { x, z: clamp(me.z + (snap.ball.z - me.z) * 0.35, -snap.pitch.halfL + 5, snap.pitch.halfL - 5) };
}

/** 接应点：持球者侧后方 9–13 m，避开最近的对手 */
export function supportPoint(carrier, me, snap, goalZ) {
  const g = vnorm({ x: 0 - carrier.x, z: goalZ - carrier.z });
  const side = me.x >= carrier.x ? 1 : -1;
  const toMe = vnorm(vsub(me, carrier));
  // 基础方向：朝球门反方向退半步 + 侧向
  const baseDir = vnorm({ x: -g.x * 0.55 + side * 0.9, z: -g.z * 0.55 });
  const distWant = clamp(9 + Math.abs(me.shape.x) * 0.08, 8, 15);
  let cand = { x: carrier.x + baseDir.x * distWant, z: carrier.z + baseDir.z * distWant };
  // 如果附近有对手，往远离对手的方向偏 1.5–3 m
  if (me.oppPlayer) {
    const away = vnorm(vsub(cand, me.oppPlayer));
    cand = vadd(cand, vmul(away, 2.2 * (1 - sat(me.oppDist / 6))));
  }
  // 结合自身原本站位，避免全体挤到持球者身边
  cand = { x: lerp(cand.x, me.shape.x, 0.25), z: lerp(cand.z, me.shape.z, 0.18) };
  void toMe;
  return {
    x: clamp(cand.x, -snap.pitch.halfW + 3, snap.pitch.halfW - 3),
    z: clamp(cand.z, -snap.pitch.halfL + 3, snap.pitch.halfL - 3),
  };
}

/** 射门瞄准点：球门内的一个位置（避开中路守门员区） */
export function aimPoint(goalZ, fromX, cfg) {
  const span = 3.4;
  const bias = clamp(fromX / 34, -1, 1);
  return { x: -bias * span * 0.55 + (Math.random() - 0.5) * 1.1, z: goalZ };
}

/**
 * 传球候选（设计 02 §6）：可达性 + 线路风险 + 接球空间 + 推进价值
 * 返回 [{ to, point, d, risk, score, prog }...]，已按 score 降序
 */
export function passOptions(carrier, snap, cfg, extra) {
  const P = cfg.pass;
  const opps = carrier.opps;
  const lastPasserId = extra && extra.lastPasserId;
  const out = [];
  for (const m of carrier.mates) {
    if (m.isGk) continue;
    // 不在场内的队友（例如玩家还在通道里）不参与传球评估
    if (Math.abs(m.z) > snap.pitch.halfL - 2 || Math.abs(m.x) > snap.pitch.halfW - 1) continue;
    // 越位的人不传：以前是"选了再被吹掉"（arena 里取消该脚传球并判对方任意球），
    // 现在在评估阶段就剔除，和 rules.isOffside 用同一判据，避免 AI 主动找死。
    if (isOffside(snap, m.id)) continue;
    const d = dist(carrier.x, carrier.z, m.x, m.z);
    if (d < 5) continue;                 // 贴脚横传没有意义（会变成乒乓短传）
    if (d > 32) continue;                // 32 m 以上的"传球"应该用大脚/长传，不在这里评估
    // 提前量：朝接球者移动方向送球
    const tt = clamp(d / Math.max(5, P.arriveSpeed + 4), 0, 1.6);
    const lead = { x: m.x + m.vx * tt * P.leadFactor * 2.2, z: m.z + m.vz * tt * P.leadFactor * 2.2 };
    const risk = laneRisk(carrier, lead, opps);
    const distQ = bell(d, (P.idealMin + P.idealMax) / 2, 22);
    const prog = sat((m.depth - carrier.depth) * 3.2);
    const recvSpace = m.space;
    let score =
      0.30 * distQ +
      0.28 * (1 - sat(risk * P.riskWeight)) +
      0.22 * recvSpace +
      0.20 * prog;
    // 接球者是否被贴身
    if (m.oppDist < 2.2) score *= 0.72;
    // 长距离高风险斜传：技术不够的人不要传
    if (d > 30) score *= 0.8;
    // 刚把球传给我的人：除非明显更好，否则不要立刻回传（避免两人对踢）
    if (lastPasserId && m.id === lastPasserId) score *= 0.55;
    out.push({ to: m, point: lead, d, risk, score: sat(score), prog });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 持球者是否有向前推进空间（带球行为用） */
export function carrySpace(carrier, snap) {
  const g = vnorm({ x: 0 - carrier.x, z: carrier.goalZ - carrier.z });
  const look = { x: carrier.x + g.x * 6, z: carrier.z + g.z * 6 };
  let minD = 12;
  for (const o of carrier.opps) {
    const d = dist(look.x, look.z, o.x, o.z);
    if (d < minD) minD = d;
  }
  return sat(minD / 12);
}

/** 补位点：球与自家球门连线的保护位置 */
export function coverPoint(snap, teamKey, holderId) {
  const team = snap.teams[teamKey];
  const ball = snap.ball;
  const ownZ = team.ownGoalZ;
  const k = 0.42;
  const base = { x: lerp(ball.x, 0, k), z: lerp(ball.z, ownZ, k) };
  // 若对方有更靠前的人，取其与球门连线中点（保护最危险的人）
  let threat = null, td = -1;
  for (const o of snap.teams[teamKey === 'home' ? 'away' : 'home'].players) {
    if (o.id === holderId || o.isGk) continue;
    const dz = (o.z - ownZ) * (team.attackZ > 0 ? 1 : -1);
    if (dz > td) { td = dz; threat = o; }
  }
  if (threat) {
    base.x = lerp(base.x, (threat.x + ball.x) / 2, 0.45);
    base.z = lerp(base.z, (threat.z + ball.z) / 2, 0.35);
  }
  return {
    x: clamp(base.x, -snap.pitch.halfW + 3, snap.pitch.halfW - 3),
    z: clamp(base.z, -snap.pitch.halfL + 3, snap.pitch.halfL - 3),
  };
}

/** 封堵点：站在持球者与最危险接应点之间 */
export function blockPoint(carrier, options) {
  const t = options && options[0];
  if (!t) return { x: carrier.x, z: carrier.z };
  const p = { x: lerp(carrier.x, t.point.x, 0.42), z: lerp(carrier.z, t.point.z, 0.42) };
  return p;
}

/** 盯人点：站在对手与自家球门之间 */
export function markPoint(mark, snap, teamKey) {
  const ownZ = snap.teams[teamKey === 'home' ? 'away' : 'home'].ownGoalZ;
  const dir = vnorm({ x: 0 - mark.x, z: ownZ - mark.z });
  return {
    x: clamp(mark.x + dir.x * 1.6, -snap.pitch.halfW + 2, snap.pitch.halfW - 2),
    z: clamp(mark.z + dir.z * 1.6, -snap.pitch.halfL + 2, snap.pitch.halfL - 2),
  };
}

/** 我方阵地宽度占用 0–1 */
export function teamWidthUse(snap, teamKey, side) {
  const t = snap.teams[teamKey];
  const target = side === 'right' ? 1 : -1;
  let best = 0;
  for (const p of t.players) {
    if (p.isGk) continue;
    if (Math.sign(p.x) === target) best = Math.max(best, Math.abs(p.x) / snap.pitch.halfW);
  }
  return sat(best);
}

/**
 * 主裁站位：站在球的后方（背向进攻方向一侧），横向偏一点，避免与持球者同线。
 * 纯函数，便于单测；夹在场地内。
 * @param {{x:number,z:number}} ball
 * @param {{attackSide?:number, behind?:number, lateral?:number, halfWidth?:number, halfLength?:number}} opts
 *        attackSide：攻方推进方向（+1 攻 +z 门 / -1 攻 -z 门）
 */
export function refAnchor(ball, opts) {
  const o = opts || {};
  const bx = isFinite(o && ball && ball.x) ? ball.x : 0;
  const bz = isFinite(o && ball && ball.z) ? ball.z : 0;
  const attack = o.attackSide === -1 ? -1 : 1;
  const behind = isFinite(o.behind) ? o.behind : 7;
  const lateral = isFinite(o.lateral) ? o.lateral : 3.2;
  const hw = isFinite(o.halfWidth) ? o.halfWidth : 34;
  const hl = isFinite(o.halfLength) ? o.halfLength : 52.5;
  // 横向：跟球但压到一侧（避免站在持球者正后方被挡）
  const x = clamp(bx * 0.45 + lateral, -hw + 2, hw - 2);
  // 纵向：在球的后方（背向进攻方向）
  const z = clamp(bz - attack * behind, -hl + 2, hl - 2);
  return { x: +x.toFixed(2), z: +z.toFixed(2) };
}

export { norm, sat, clamp, dist };
