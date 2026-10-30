// FW3D AI · 行为候选（设计 01 §7、02 §4）
// 每个行为：eligible(可执行) / score(归一化 0–1) / target(目标点) / pace(0 走 – 1 冲) / why(原因，给调试 HUD)
// 约定：
//   - score 必须是 0–1 的归一化分，内部用 blend() 加权平均，禁止把米/角度/概率直接相加；
//   - 行为只产生意图（目标点 + 期望速度），不改位置、不碰球；
//   - 所有坐标用 {x, z}。
import { clamp, sat, bell, dist, lerp, vsub, vnorm, vadd, vmul, vlen } from './mathx.js';
import { iqAvg, techOf } from './attrs.js';
import {
  laneRisk, offsideRisk, supportAngle, shapeAt, dangerOf, runBehindPoint, widthPoint,
  supportPoint, aimPoint, passOptions, carrySpace, coverPoint, blockPoint, markPoint, teamWidthUse,
  pressPartition,
} from './features.js';
import { blend } from './mathx.js';

const WIDE = { LW: 1, RW: 1, LB: 1, RB: 1 };
const isWidePos = (p) => !!WIDE[p.pos];

// ── 行为表 ───────────────────────────────────────────────
export const BEHAVIORS = [
  // 门将：站位（第七阶段才做扑救）
  {
    id: 'GkHold', label: '门将站位', pace: 0.35,
    eligible: (c) => c.me.isGk,
    score: (c) => 0.92,    target: (c) => ({
      x: clamp(c.ball.x * 0.32, -3.4, 3.4),
      z: clamp(c.ownGoalZ + (c.ownGoalZ > 0 ? -1.4 : 1.4), -c.halfL + 1, c.halfL - 1),
    }),
    why: () => ['门将只在门线附近活动'],
  },

  // 空中球：争落点（大脚/门将开球后的二次球）
  {
    id: 'ContestAerial', label: '争落点', pace: 0.95,
    eligible: (c) => !c.me.isGk && c.ball.speed > 3 && (c.ball.y || 0) > 1.0,
    score: (c) => {
      const y = c.ball.y || 0;
      const tLand = Math.sqrt(Math.max(0.05, y) / 4.9) + 0.15;   // 自由落体近似
      const d = dist(c.me.x, c.me.z, c.ball.x, c.ball.z);
      const reach = Math.max(1.2, tLand * 7.0);
      const reachable = sat(1 - Math.max(0, d - reach) / 12);
      const rankQ = c.myRank <= 2 ? 1 : c.myRank <= 4 ? 0.4 : 0.1;
      return sat(0.55 * reachable + 0.30 * rankQ + 0.15 * sat(1 - d / 30));
    },
    target: (c) => ({
      x: clamp(c.ball.x + c.ball.vx * 0.35, -c.halfW + 1, c.halfW - 1),
      z: clamp(c.ball.z + c.ball.vz * 0.35, -c.halfL + 1, c.halfL - 1),
    }),
    why: (c) => ['空中球 y=' + (c.ball.y || 0).toFixed(1), '距落点 ' + dist(c.me.x, c.me.z, c.ball.x, c.ball.z).toFixed(1) + ' m', '队内排名 #' + c.myRank],
  },

  // 门将出击：对手持球进入本方 22 m 内且没人逼抢时前压封角度（第七阶段）
  {
    id: 'GkRush', label: '门将出击', pace: 0.92,
    eligible: (c) => c.me.isGk && !!c.carrier && c.carrier.team !== c.me.team &&
      Math.hypot(c.carrier.x, c.carrier.z - c.ownGoalZ) < 22,
    score: (c) => {
      const d = Math.hypot(c.carrier.x, c.carrier.z - c.ownGoalZ);
      const threat = 1 - sat(d / 22);
      const free = 1 - sat(c.carrier.pressure || 0);
      return sat(0.55 + 0.50 * threat + 0.20 * free) * 0.99;
    },
    target: (c) => {
      const gz = c.ownGoalZ;
      const dz = c.carrier.z - gz;
      const s = Math.sign(dz) || 1;
      const out = Math.min(8, Math.max(3, Math.hypot(c.carrier.x, dz) * 0.35));
      return { x: clamp(c.carrier.x * 0.35, -c.halfW + 2, c.halfW - 2), z: clamp(gz + s * (1.4 + out), -c.halfL + 1, c.halfL - 1) };
    },
    why: (c) => ['持球者距门 ' + Math.hypot(c.carrier.x, c.carrier.z - c.ownGoalZ).toFixed(1) + ' m', '压迫 ' + (c.carrier.pressure || 0).toFixed(2)],
  },

  // 争抢无主球：只有最近的人去，其他人按职责站位（设计：不再全队追球）
  {
    id: 'ChaseBall', label: '争抢二点', pace: 0.95,
    eligible: (c) => !c.me.isGk && !c.ball.owner && c.myRank <= 3,
    score: (c) => {
      const rankQ = c.myRank === 1 ? 1 : c.myRank === 2 ? 0.42 : 0.16;
      const dQ = 1 - sat(c.me.distToBall / 26);
      return sat(0.62 * rankQ + 0.38 * dQ);
    },
    target: (c) => {
      const lead = 0.28;
      // 注意：贴边球的目标点不能收得太靠里，否则球员停在 2 m 外永远够不到球
      return { x: clamp(c.ball.x + c.ball.vx * lead, -c.halfW + 0.4, c.halfW - 0.4), z: clamp(c.ball.z + c.ball.vz * lead, -c.halfL + 0.4, c.halfL - 0.4) };
    },
    why: (c) => ['距球 ' + c.me.distToBall.toFixed(1) + ' m', '队内排名 #' + c.myRank],
  },

  // 逼抢持球者（设计 02 §4 PressCarrier）：只在"有球侧"上抢，无球侧守宽度（围抢分区）
  {
    id: 'PressCarrier', label: '逼抢', pace: 0.98,
    eligible: (c) => !c.me.isGk && c.phase === 'defend' && !!c.carrier,
    score: (c) => {
      const d = dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z);
      const prox = 1 - sat(d / 26);
      const threat = sat(1 - dist(c.carrier.x, c.carrier.z, 0, c.ownGoalZ) / 46);
      const stam = sat(c.me.stamina / 100);
      const isFirst = c.plan.presserId === c.me.id ? 1 : 0.15;
      const sup = c.myRank <= 2 ? 1 : 0.35;
      const pp = pressPartition(c.snap, c.me, c.carrier);
      // 有球侧的人多抢、无球侧的人少抢（否则一脚横传就把全队拉空）
      const sideMul = pp.isBallSide ? (pp.lateral < 24 ? 1.12 : 0.95) : 0.55;
      return sat(blend([
        { v: prox, w: 0.40 },
        { v: threat, w: 0.18 },
        { v: stam, w: 0.14 },
        { v: isFirst, w: 0.18 },
        { v: sup, w: 0.10 },
      ]) * c.cfg.difficulty.pressMul * (c.cfg.team.pressMul == null ? 1 : c.cfg.team.pressMul) * (c.pressMul == null ? 1 : c.pressMul) * sideMul);
    },
    target: (c) => {
      // 站在持球者与自家球门之间，稍微朝边线赶
      const dir = vnorm({ x: c.carrier.x * 0.15 - 0, z: c.ownGoalZ - c.carrier.z });
      const side = c.carrier.x >= 0 ? 1 : -1;
      const p = vadd({ x: c.carrier.x + dir.x * 1.15 + side * 0.55, z: c.carrier.z + dir.z * 1.15 }, { x: 0, z: 0 });
      return { x: clamp(p.x, -c.halfW + 1.5, c.halfW - 1.5), z: clamp(p.z, -c.halfL + 1.5, c.halfL - 1.5) };
    },
    why: (c) => {
      const d = dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z);
      const pp = pressPartition(c.snap, c.me, c.carrier);
      return ['距持球者 ' + d.toFixed(1) + ' m', '威胁 ' + sat(1 - dist(c.carrier.x, c.carrier.z, 0, c.ownGoalZ) / 46).toFixed(2),
        '体力 ' + Math.round(c.me.stamina), pp.isBallSide ? '有球侧' : '无球侧(' + pp.lateral.toFixed(0) + 'm)'];
    },
  },

  // 接应（设计 02 §4 OfferSupport）
  {
    id: 'OfferSupport', label: '接应', pace: 0.6,
    eligible: (c) => !c.me.isGk && c.phase === 'attack' && !!c.carrier && c.me.id !== c.carrier.id,
    score: (c) => {
      const d = dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z);
      const angQ = supportAngle(c.carrier, c.me, c.goalZ);
      const risk = laneRisk(c.carrier, c.me, c.me.opps);
      const distQ = bell(d, 11, 15);
      const roleBonus = (c.role === 'support' ? 1 : c.role === 'shape' ? 0.55 : 0.4);
      return sat(blend([
        { v: angQ, w: 0.26 },
        { v: c.me.space, w: 0.24 },
        { v: 1 - risk, w: 0.24 },
        { v: distQ, w: 0.16 },
        { v: roleBonus, w: 0.10 },
      ]) * (0.86 + 0.14 * iqAvg(c.me.attrs, ['teamwork', 'spatial'])));
    },
    target: (c) => supportPoint(c.carrier, c.me, c.snap, c.goalZ),
    why: (c) => {
      const d = dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z);
      const risk = laneRisk(c.carrier, c.me, c.me.opps);
      return ['距持球者 ' + d.toFixed(1) + ' m', '线路风险 ' + risk.toFixed(2), '空间 ' + c.me.space.toFixed(2)];
    },
  },

  // 前插（RunBehind）
  {
    id: 'RunBehind', label: '前插', pace: 0.95,
    eligible: (c) => !c.me.isGk && c.phase === 'attack' && !!c.carrier,
    score: (c) => {
      const off = offsideRisk(c.me, c.snap);
      const oppLine = c.snap.teams[c.me.team === 'home' ? 'away' : 'home'].defenderLineZ;
      const behind = sat((c.me.z - oppLine) * c.me.attackZ / 8);
      const room = sat(1 - Math.abs(c.me.z - oppLine) / 26);
      const distQ = bell(dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z), 18, 26);
      const roleBonus = c.role === 'runner' ? 1 : 0.35;
      return sat(blend([
        { v: behind, w: 0.28 },
        { v: 1 - off, w: 0.26 },
        { v: room, w: 0.16 },
        { v: distQ, w: 0.16 },
        { v: roleBonus, w: 0.14 },
      ]) * (0.8 + 0.2 * iqAvg(c.me.attrs, ['anticipation', 'spatial'])) * (0.75 + 0.25 * c.riskAppetite));
    },
    target: (c) => runBehindPoint(c.me, c.snap),
    why: (c) => {
      const off = offsideRisk(c.me, c.snap);
      return ['越位风险 ' + off.toFixed(2), '阵型角色 ' + c.role];
    },
  },

  // 拉边（HoldWidth）
  {
    id: 'HoldWidth', label: '拉边', pace: 0.75,
    eligible: (c) => !c.me.isGk && c.phase === 'attack' && (isWidePos(c.me) || c.role === 'widthL' || c.role === 'widthR'),
    score: (c) => {
      const side = c.me.x >= 0 ? 'right' : 'left';
      const used = teamWidthUse(c.snap, c.me.team, side);
      const lack = 1 - used;                     // 本侧宽度不够 → 拉边价值高
      const flank = sat((Math.abs(c.me.x) / c.halfW - 0.35) / 0.45);
      const roleBonus = (c.role === 'widthL' || c.role === 'widthR') ? 1 : 0.4;
      return sat(blend([
        { v: lack, w: 0.34 },
        { v: c.me.space, w: 0.26 },
        { v: flank, w: 0.22 },
        { v: roleBonus, w: 0.18 },
      ]) * (0.85 + 0.15 * iqAvg(c.me.attrs, ['tactical'])));
    },
    target: (c) => widthPoint(c.me, c.snap, c.me.x >= 0 ? 'right' : 'left'),
    why: (c) => ['本侧宽度占用 ' + teamWidthUse(c.snap, c.me.team, c.me.x >= 0 ? 'right' : 'left').toFixed(2), '空间 ' + c.me.space.toFixed(2)],
  },

  // 回撤接应（DropToReceive）
  {
    id: 'DropToReceive', label: '回撤接球', pace: 0.55,
    eligible: (c) => !c.me.isGk && c.phase === 'attack' && !!c.carrier && c.me.depth <= c.carrier.depth + 0.02,
    score: (c) => {
      const cp = c.carrier.pressure;
      const d = dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z);
      const safe = c.me.space;
      return sat(blend([
        { v: cp, w: 0.38 },
        { v: safe, w: 0.30 },
        { v: bell(d, 13, 20), w: 0.20 },
        { v: c.role === 'anchor' ? 0.8 : 0.4, w: 0.12 },
      ]) * (0.85 + 0.15 * iqAvg(c.me.attrs, ['composure', 'tactical'])));
    },
    target: (c) => {
      const back = vnorm({ x: c.me.x * 0.15, z: c.ownGoalZ - c.me.z });
      return {
        x: clamp(c.me.x + back.x * 4 + (c.ball.x - c.me.x) * 0.15, -c.halfW + 3, c.halfW - 3),
        z: clamp(c.me.z + back.z * 6, -c.halfL + 3, c.halfL - 3),
      };
    },
    why: (c) => ['持球者压迫 ' + c.carrier.pressure.toFixed(2), '自身空间 ' + c.me.space.toFixed(2)],
  },

  // 封堵传球线路（BlockLane）
  {
    id: 'BlockLane', label: '封线路', pace: 0.8,
    eligible: (c) => !c.me.isGk && c.phase === 'defend' && !!c.carrier,
    score: (c) => {
      const opts = passOptions(c.carrier, c.snap, c.cfg).slice(0, 2);
      if (!opts.length) return 0.1;
      const bp = blockPoint(c.carrier, opts);
      const d = dist(c.me.x, c.me.z, bp.x, bp.z);
      const prox = 1 - sat(d / 20);
      const importance = sat(opts[0].score);
      return sat(blend([
        { v: prox, w: 0.46 },
        { v: importance, w: 0.30 },
        { v: c.myRank <= 3 ? 1 : 0.4, w: 0.24 },
      ]) * (0.8 + 0.2 * iqAvg(c.me.attrs, ['defense', 'anticipation'])));
    },
    target: (c) => {
      const opts = passOptions(c.carrier, c.snap, c.cfg).slice(0, 2);
      c._lane = opts;
      return blockPoint(c.carrier, opts);
    },
    why: (c) => {
      const opts = passOptions(c.carrier, c.snap, c.cfg).slice(0, 1);
      return opts.length ? ['主要出球点 ' + (opts[0].to.name || opts[0].to.id) + ' 风险 ' + opts[0].risk.toFixed(2)] : ['无出球点'];
    },
  },

  // 补位保护（CoverSpace）：有球侧的第二人向持球者收 55%，形成双人围抢
  {
    id: 'CoverSpace', label: '补位', pace: 0.7,
    eligible: (c) => !c.me.isGk && c.phase === 'defend',
    score: (c) => {
      const cp = coverPoint(c.snap, c.me.team, c.carrier ? c.carrier.id : null);
      const danger = dangerOf(cp, c.snap, c.me.team);
      const d = dist(c.me.x, c.me.z, cp.x, cp.z);
      const pp = pressPartition(c.snap, c.me, c.carrier);
      const helper = c.carrier && pp.isBallSide && pp.lateral < 14 && dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z) < 16;
      return sat(blend([
        { v: danger, w: 0.40 },
        { v: 1 - sat(d / 24), w: 0.26 },
        { v: c.role === 'cover' ? 1 : 0.45, w: 0.20 },
        { v: iqAvg(c.me.attrs, ['defense']), w: 0.14 },
      ]) * (helper ? 1.10 : 1));
    },
    target: (c) => {
      const cp = coverPoint(c.snap, c.me.team, c.carrier ? c.carrier.id : null);
      const pp = pressPartition(c.snap, c.me, c.carrier);
      if (c.carrier && pp.isBallSide && pp.lateral < 14 && dist(c.me.x, c.me.z, c.carrier.x, c.carrier.z) < 16) {
        // 围抢：把补位点朝持球者收 55%（两人包夹，tackleTick 的 helpers 会因此生效）
        return { x: cp.x + (c.carrier.x - cp.x) * 0.55, z: cp.z + (c.carrier.z - cp.z) * 0.55 };
      }
      return cp;
    },
    why: (c) => {
      const cp = coverPoint(c.snap, c.me.team, c.carrier ? c.carrier.id : null);
      const pp = pressPartition(c.snap, c.me, c.carrier);
      return ['补位点危险度 ' + dangerOf(cp, c.snap, c.me.team).toFixed(2), pp.isBallSide ? '有球侧' : '无球侧'];
    },
  },

  // 盯人（TrackRunner）
  {
    id: 'TrackRunner', label: '盯人', pace: 0.85,
    eligible: (c) => !c.me.isGk && c.phase === 'defend' && !!c.plan.marks[c.me.id],
    score: (c) => {
      const markId = c.plan.marks[c.me.id];
      const mark = c.snap.byId[markId];
      if (!mark) return 0;
      const d = dist(c.me.x, c.me.z, mark.x, mark.z);
      const danger = dangerOf(mark, c.snap, c.me.team);
      return sat(blend([
        { v: danger, w: 0.38 },
        { v: 1 - sat(d / 18), w: 0.34 },
        { v: iqAvg(c.me.attrs, ['defense', 'anticipation']), w: 0.28 },
      ]));
    },
    target: (c) => {
      const mark = c.snap.byId[c.plan.marks[c.me.id]];
      return mark ? markPoint(mark, c.snap, c.me.team) : { x: c.me.x, z: c.me.z };
    },
    why: (c) => {
      const mark = c.snap.byId[c.plan.marks[c.me.id]];
      return mark ? ['盯防 ' + (mark.name || mark.id)] : ['无盯防对象'];
    },
  },

  // 回位（RecoverShape）：最低优先级的兜底行为
  {
    id: 'RecoverShape', label: '回位', pace: 0.5,
    eligible: () => true,
    score: (c) => {
      const d = dist(c.me.x, c.me.z, c.shape.x, c.shape.z);
      // 6 m 以内算"大致在位"，不抢别的行为；离开越远越急着回位
      const outOfPos = sat((d - 6) / 18);
      const anchorBonus = c.role === 'anchor' ? 1 : c.role === 'shape' ? 0.8 : 0.3;
      return sat(0.18 + 0.42 * outOfPos + 0.16 * anchorBonus);
    },
    target: (c) => c.shape,
    why: (c) => ['距阵型位置 ' + dist(c.me.x, c.me.z, c.shape.x, c.shape.z).toFixed(1) + ' m'],
  },
];

export const BEHAVIOR_BY_ID = BEHAVIORS.reduce((m, b) => (m[b.id] = b, m), {});
// 持球者的"行为"不参与无球效用竞争（由 decideOnBall 决定），但调试面板需要它的名字
BEHAVIOR_BY_ID.OnBall = { id: 'OnBall', label: '持球处理', pace: 0.6 };

/** 计算全部行为评分（已排序），并给每个行为带上原因 */
export function evaluateBehaviors(ctx) {
  const list = [];
  for (const b of BEHAVIORS) {
    let s = -1;
    let ok = false;
    try { ok = !!b.eligible(ctx); } catch (e) { ok = false; }
    if (ok) {
      try { s = clamp(b.score(ctx), 0, 1); } catch (e) { s = 0; }
    }
    if (s >= 0) list.push({ id: b.id, label: b.label, score: s, behavior: b });
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

/**
 * 持球者决策：射门 / 传球 / 带球 / 解围（设计 02 §6、路线图 Phase 4 的基础版）
 * 返回 { action, targetId, point, power, score, reason, candidates }
 */
export function decideOnBall(ctx) {
  const { me, cfg, snap, goalZ } = ctx;
  const opps = me.opps;
  const dGoal = dist(me.x, me.z, 0, goalZ);
  const sideQ = 1 - sat(Math.abs(me.x) / (ctx.halfW * 1.15));
  const shotTech = techOf(me.attrs, 'shooting');
  const passTech = techOf(me.attrs, 'passing');
  const composure = iqAvg(me.attrs, ['composure', 'decision']);
  const cands = [];

  // 1) 射门
  if (dGoal < cfg.shot.maxDist && !me.isGk) {
    const lane = laneRisk(me, { x: 0, z: goalZ }, opps);
    const distQ = 1 - sat(dGoal / cfg.shot.maxDist);
    const s = sat(blend([
      { v: distQ, w: 0.30 },
      { v: 1 - lane, w: 0.28 },
      { v: sideQ, w: 0.14 },
      { v: shotTech, w: 0.16 },
      { v: composure, w: 0.12 },
    ])) * (0.72 + 0.28 * composure);
    cands.push({
      action: 'shoot', score: sat(s), targetId: null,
      point: aimPoint(goalZ, me.x, cfg),
      power: clamp(cfg.shot.minPower + dGoal * 0.45, cfg.shot.minPower, cfg.shot.maxPower),
      reason: '距门 ' + dGoal.toFixed(1) + ' m，线路风险 ' + lane.toFixed(2),
    });
  }

  // 2) 传球：取最佳 3 个候选做调试对比
  const opts = passOptions(me, snap, cfg, { lastPasserId: ctx.lastPasserId }).slice(0, 3);
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const s = sat(blend([
      { v: o.score, w: 0.70 },
      { v: passTech, w: 0.18 },
      { v: composure, w: 0.12 },
    ]) * (i === 0 ? 1 : 0.94));
    cands.push({
      action: 'pass', score: s, targetId: o.to.id, to: o.to,
      point: o.point, power: 0, distance: o.d, risk: o.risk,
      reason: '接球者 ' + (o.to.name || o.to.id) + '，' + o.d.toFixed(0) + ' m，风险 ' + o.risk.toFixed(2),
    });
  }

  // 3) 带球（带球时间越长，出球意愿越高 → 不会抱着球不传）
  if (!me.isGk) {
    const carry = carrySpace(me, snap);
    const pressure = me.pressure;
    const carryTime = Math.max(0, ctx.carryTime || 0);
    const patience = 1 - 0.45 * sat(carryTime / Math.max(0.5, cfg.ball.maxDribbleSec));
    // 有空间且没人逼抢时更倾向自己带球推进（足球里这很常见），被贴身则优先出球
    const s = sat(blend([
      { v: carry, w: 0.44 },
      { v: 1 - pressure, w: 0.26 },
      { v: techOf(me.attrs, 'dribbling'), w: 0.16 },
      { v: composure, w: 0.14 },
    ]) * 0.94 * patience + 0.06 * carry * (1 - pressure));
    const g = vnorm({ x: (0 - me.x) * 0.25, z: goalZ - me.z });
    cands.push({
      action: 'dribble', score: s, targetId: null,
      point: {
        x: clamp(me.x + g.x * 9, -ctx.halfW + 3, ctx.halfW - 3),
        z: clamp(me.z + g.z * 9, -ctx.halfL + 3, ctx.halfL - 3),
      },
      power: 0,
      reason: '前方空间 ' + carry.toFixed(2) + '，压迫 ' + pressure.toFixed(2) + '，持球 ' + carryTime.toFixed(1) + ' s',
    });
  }

  // 4) 解围：自家三分之一区域 + 高压力
  if (me.depth < 0.34 && me.pressure > 0.5) {
    const s = sat(0.34 + me.pressure * 0.55 + (1 - techOf(me.attrs, 'passing')) * 0.12);
    cands.push({
      action: 'clear', score: s, targetId: null,
      point: { x: clamp(me.x * 0.4 + (Math.random() - 0.5) * 12, -ctx.halfW + 4, ctx.halfW - 4), z: clamp(me.z + ctx.attackZ * 34, -ctx.halfL + 4, ctx.halfL - 4) },
      power: cfg.pass.maxPower * 0.78,
      reason: '本区被压制，压迫 ' + me.pressure.toFixed(2),
    });
  }

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0] || { action: 'dribble', score: 0.2, point: { x: me.x, z: me.z }, reason: '无候选' };
  return { action: best.action, targetId: best.targetId || null, point: best.point, power: best.power || 0, score: best.score, reason: best.reason, candidates: cands, best };
}

export { shapeAt };
