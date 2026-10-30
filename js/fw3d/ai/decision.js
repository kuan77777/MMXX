// FW3D AI · 决策层（Utility AI + 滞回 + 原因日志）
// 设计依据：01 §7、02 §3/§8、05 Phase 3
// 输入：WorldSnapshot（只读）+ TeamPlan；输出：PlayerIntent / KickRequest（意图，不改位置不碰球）
import { createConfig } from './config.js';
import { clamp, sat, hash01, hashStr, vlerp, dist } from './mathx.js';
import { iqAvg } from './attrs.js';
import { buildSnapshot } from './snapshot.js';
import { assignRoles, rolesDue, ROLE_LABEL } from './roles.js';
import { evaluateBehaviors, decideOnBall, BEHAVIOR_BY_ID } from './behaviors.js';
import { shapeAt } from './features.js';

const DIM_WEIGHT = { decision: 0.45, tactical: 0.3, composure: 0.25 };

/**
 * 按比分与时间自动调整战术倾向（第八阶段"自动换档"，纯函数便于测试）
 * @returns {{pressMul:number, riskDelta:number, label:string}}
 */
export function autoTactics(score, minute, team) {
  const mine = team === 'away' ? (score && score.away) || 0 : (score && score.home) || 0;
  const theirs = team === 'away' ? (score && score.home) || 0 : (score && score.away) || 0;
  const m = minute || 0;
  if (mine < theirs && m >= 80) return { pressMul: 1.30, riskDelta: 0.12, label: '末段追分' };
  if (mine < theirs && m >= 60) return { pressMul: 1.20, riskDelta: 0.08, label: '落后加压' };
  if (mine > theirs && m >= 75) return { pressMul: 0.80, riskDelta: -0.08, label: '领先控场' };
  if (mine === theirs && m >= 85) return { pressMul: 1.12, riskDelta: 0.05, label: '尾声争胜' };
  return { pressMul: 1, riskDelta: 0, label: '均衡' };
}

export function createTeamBrain(overrides) {
  const cfg = createConfig(overrides);
  const agents = new Map();       // playerId -> 个体决策状态
  let roles = null;               // 当前 TeamPlan
  let log = [];                   // 行为切换日志（调试 / 复盘）
  let lastOwner = null;
  let lastOwnerTeam = null;
  let urgentUntil = 0;
  let lastSnap = null;
  let updateCount = 0;
  const receivedFrom = new Map();   // playerId -> {from, t}：最近一次是谁传给他的

  function agentOf(id) {
    let a = agents.get(id);
    if (!a) {
      a = {
        id,
        behavior: null, score: 0, since: 0, lastSwitchAt: -99,
        target: null, smooth: null, pace: 0.5, reason: '', why: [],
        role: 'shape', nextThink: 0, pendingKick: null, kickReadyAt: 0,
        lastScores: [], switches: 0, carrySince: null, onBall: null,
      };
      agents.set(id, a);
    }
    return a;
  }

  function reset() {
    agents.clear(); roles = null; log = []; lastOwner = null; urgentUntil = 0; lastSnap = null;
  }

  function configure(partial) {
    Object.assign(cfg, createConfig(partial));
    return cfg;
  }

  // ── 个体认知参数 ──────────────────────────────
  function thinkInterval(p) {
    const iq = iqAvg(p.attrs, ['decision', 'anticipation']);
    const base = 1 / Math.max(1, cfg.rates.thinkHz);
    const slow = 1 + (1 - iq) * 0.95;
    const jit = 1 + (hash01(hashStr(p.id + '|think')) - 0.5) * 2 * cfg.rates.thinkJitter;
    return base * slow * jit * (cfg.difficulty.thinkMul || 1);
  }

  // 球商对行为评分的稳定偏好（不是每帧随机，避免"用随机伪装智能"）
  function iqBias(p, behaviorId) {
    const d = iqAvg(p.attrs, ['decision']);
    return (hash01(hashStr(p.id + '|' + behaviorId)) - 0.5) * (1 - d) * 0.07;
  }

  function riskAppetite(p, snap) {
    const t = snap.teams[p.team];
    const score = snap.match.score || { home: 0, away: 0 };
    const mine = p.team === 'home' ? score.home : score.away;
    const theirs = p.team === 'home' ? score.away : score.home;
    const behind = mine < theirs ? 0.12 : mine > theirs ? -0.08 : 0;
    const late = sat((snap.match.minute - 70) / 20) * 0.1;
    return sat(cfg.team.riskAppetite + behind + late + (iqAvg(p.attrs, ['tactical']) - 0.5) * 0.2);
  }

  function rankToBall(p, snap) {
    const mates = snap.teams[p.team].players.filter((m) => !m.isGk);
    const sorted = mates.slice().sort((a, b) => a.distToBall - b.distToBall);
    return sorted.findIndex((m) => m.id === p.id) + 1;
  }

  function makeCtx(p, plan, snap) {
    const team = snap.teams[p.team];
    const carrier = snap.ball.owner && snap.ball.ownerTeam === p.team ? snap.ball.owner : snap.ball.owner;
    const ctx = {
      snap, me: p, plan, cfg, t: snap.t,
      ball: snap.ball,
      carrier: carrier && carrier.id !== p.id ? carrier : (snap.ball.owner || null),
      phase: plan.phase,
      goalZ: team.goalZ, ownGoalZ: team.ownGoalZ, attackZ: team.attackZ,
      halfW: snap.pitch.halfW, halfL: snap.pitch.halfL,
      role: plan.roleOf[p.id] || 'shape',
      shape: shapeAt(p, snap, cfg),
      myRank: rankToBall(p, snap),
      riskAppetite: riskAppetite(p, snap),
      lastPasserId: null,
      pressMul: 1,
    };
    // 自动换档：落后加压、领先控场（叠加在战术风格之上，不改 cfg 本体）
    const at = autoTactics(snap.match.score, snap.match.minute, p.team);
    ctx.pressMul = at.pressMul;
    ctx.autoTactic = at.label;
    ctx.riskAppetite = clamp(ctx.riskAppetite + at.riskDelta, 0, 1);
    const rf = receivedFrom.get(p.id);
    if (rf && snap.t - rf.t < 6) ctx.lastPasserId = rf.from;
    return ctx;
  }

  // ── 切换（滞回）──────────────────────────────
  function trySwitch(a, p, list, ctx, urgent) {
    const top = list[0];
    if (!top) return false;
    const curEntry = list.find((x) => x.id === a.behavior);
    const curScore = curEntry ? curEntry.score : -1;
    const gone = a.behavior && !curEntry;              // 当前行为已不可执行 → 立刻换
    const margin = urgent ? cfg.switch.urgentThreshold : cfg.switch.threshold;
    const held = ctx.t - a.since;
    const minHold = urgent ? cfg.switch.urgentCommitment : cfg.switch.minCommitment;
    const cooled = ctx.t - a.lastSwitchAt >= cfg.switch.cooldown;
    if (gone) {
      // 允许立即切换
    } else if (!(cooled && held >= minHold)) {
      return false;
    }
    if (!gone && !(top.score > curScore + margin)) return false;
    if (top.id === a.behavior) return false;

    const fromId = a.behavior;
    a.behavior = top.id;
    a.score = top.score;
    a.since = ctx.t;
    a.lastSwitchAt = ctx.t;
    a.switches++;
    const b = top.behavior;
    let why = [];
    try { why = b.why ? b.why(ctx) : []; } catch (e) { why = []; }
    a.why = why;
    a.reason = b.label + '（' + top.score.toFixed(2) + '）' + (why.length ? ' · ' + why.join(' · ') : '');
    const tgt = safeTarget(b, ctx, p);
    a.target = tgt;
    a.pace = b.pace == null ? 0.6 : b.pace;
    a.scores = list.slice(0, 4).map((x) => ({ id: x.id, score: +x.score.toFixed(2) }));
    log.push({
      t: +ctx.t.toFixed(2), id: p.id, name: p.name, team: p.team,
      from: fromId, to: top.id, score: +top.score.toFixed(2), prev: curScore < 0 ? null : +curScore.toFixed(2),
      why, urgent: !!urgent,
    });
    if (log.length > cfg.debug.logLimit) log.shift();
    lastSnap = lastSnap || ctx.snap;
    return true;
  }

  function safeTarget(b, ctx, p) {
    let t = null;
    try { t = b.target(ctx); } catch (e) { t = null; }
    if (!t || !isFinite(t.x) || !isFinite(t.z)) t = { x: ctx.shape.x, z: ctx.shape.z };
    return {
      x: clamp(t.x, -ctx.halfW + 0.8, ctx.halfW - 0.8),
      z: clamp(t.z, -ctx.halfL + 0.8, ctx.halfL - 0.8),
    };
  }

  // ── 主循环 ───────────────────────────────────
  /**
   * @param {object} inp 与 buildSnapshot 相同的输入
   * @param {number} dt
   * @returns {{intents:Array, kicks:Array, debug:object, snapshot:object}}
   */
  function update(inp, dt) {
    const snap = buildSnapshot(inp);
    snap.tick = ++updateCount;
    lastSnap = snap;

    // 只有"球权换队"或"球变无主"才算紧急事件（设计 02 §8 紧急事件中断）
    // 同一队内部的传递不该打断所有人的行为，否则会抖动。
    const turnover = snap.ball.ownerTeam !== lastOwnerTeam || (!snap.ball.ownerId && lastOwner);
    if (turnover) urgentUntil = snap.t + 0.3;
    lastOwnerTeam = snap.ball.ownerTeam;
    lastOwner = snap.ball.ownerId;
    const urgent = snap.t < urgentUntil;

    if (rolesDue(snap, roles, cfg)) {
      roles = assignRoles(snap, roles, cfg);
      roles.at = snap.t;
    }

    const intents = [];
    const kicks = [];
    for (const p of snap.players) {
      if (p.isUser) continue;                 // 玩家自己控制，AI 只给他提供接应/传球选择
      const a = agentOf(p.id);
      const teamPlan = roles[p.team] || plan;
      const ctx = makeCtx(p, teamPlan, snap);
      const isCarrier = snap.ball.ownerId === p.id;
      const urgentForP = urgent && p.distToBall < 22;   // 只有球附近的人被紧急事件打断
      // 持球计时：带球太久要出球（避免抱着球不传）
      if (isCarrier) {
        if (a.carrySince == null) {
          a.carrySince = snap.t;
          // 第一脚处理：刚拿到球不能立刻出脚（设计 03 §6 触球窗口）
          a.kickReadyAt = Math.max(a.kickReadyAt, snap.t + cfg.ball.touchDelay);
        }
      } else { a.carrySince = null; a.onBall = null; }
      ctx.carryTime = a.carrySince != null ? snap.t - a.carrySince : 0;

      // 到点思考
      if (snap.t >= a.nextThink) {
        a.nextThink = snap.t + thinkInterval(p);
        if (isCarrier && snap.t >= a.kickReadyAt) {
          const ob = decideOnBall(ctx);
          a.behavior = 'OnBall';
          a.score = ob.score;
          a.onBall = ob.action;
          a.scores = (ob.candidates || []).slice(0, 4).map((c) => ({ id: c.action + (c.targetId ? ':' + (c.to && c.to.name || c.targetId) : ''), score: +c.score.toFixed(2) }));
          a.reason = '持球 · ' + ob.action + '（' + ob.score.toFixed(2) + '）· ' + ob.reason;
          a.why = [ob.reason];
          a.since = snap.t;
          if (ob.action === 'dribble') {
            a.target = ob.point;
            a.pace = 0.7;
            a.pendingKick = null;
          } else {
            // 出脚起手（触球窗口），真正改球速由 arena 在窗口内执行
            a.target = { x: p.x, z: p.z };
            a.pace = 0.25;
            a.pendingKick = {
              at: snap.t + cfg.ball.windup,
              type: ob.action,
              targetId: ob.targetId,
              point: ob.point,
              power: ob.power,
              score: ob.score,
              reason: ob.reason,
            };
            a.kickReadyAt = snap.t + cfg.ball.windup + cfg.ball.followThrough;
          }
        } else if (!isCarrier) {
          a.pendingKick = null;
          const list = evaluateBehaviors(ctx).map((x) => ({
            x, score: x.score,
          }));
          for (const it of list) it.score = sat(it.score + iqBias(p, it.x.id));
          list.sort((m, n) => n.score - m.score);
          a.allScores = list.map((it) => ({ id: it.x.id, label: it.x.label, score: +it.score.toFixed(2) }));
          trySwitch(a, p, list.map((it) => Object.assign({}, it.x, { score: it.score })), ctx, urgentForP);
          // 无论是否切换，每个思考周期都要刷新目标点与原因：
          // 否则球飞走/对手跑动后，行为还在跑旧目标（曾导致 NPC 追着一个 40 m 外的旧点不动）
          const cur = BEHAVIOR_BY_ID[a.behavior];
          if (cur) {
            a.target = safeTarget(cur, ctx, p);
            a.pace = cur.pace == null ? 0.6 : cur.pace;
            const entry = list.find((it) => it.x.id === a.behavior);
            if (entry) a.score = entry.score;
            try { a.why = cur.why ? cur.why(ctx) : []; } catch (e) { a.why = a.why || []; }
            a.reason = cur.label + '（' + (entry ? entry.score : a.score).toFixed(2) + '）' + (a.why.length ? ' · ' + a.why.join(' · ') : '');
          }
        }
      }

      // 出脚窗口到了 → 交给 arena 执行（brain 只发请求）
      if (isCarrier && a.pendingKick && snap.t >= a.pendingKick.at) {
        if (a.pendingKick.type === 'pass' && a.pendingKick.targetId) {
          receivedFrom.set(a.pendingKick.targetId, { from: p.id, t: snap.t });
        }
        kicks.push({
          playerId: p.id, team: p.team, type: a.pendingKick.type,
          targetId: a.pendingKick.targetId, point: a.pendingKick.point,
          power: a.pendingKick.power, reason: a.pendingKick.reason,
          pressure: p.pressure, attrs: p.attrs,
          x: p.x, z: p.z, goalZ: p.goalZ,
        });
        a.pendingKick = null;
      }

      // 每个球员每帧产出移动意图（目标点平滑，避免瞬移式转向）
      let target = a.target || ctx.shape;
      if (a.smooth) {
        const k = 1 - Math.exp(-Math.max(0.001, dt) / Math.max(0.04, cfg.target.smooth * 1.25));
        a.smooth = vlerp(a.smooth, target, k);
      } else {
        a.smooth = { x: target.x, z: target.z };
      }
      const dToTarget = dist(p.x, p.z, a.smooth.x, a.smooth.z);
      const pace = dToTarget < cfg.target.deadzone ? 0 : a.pace;
      intents.push({
        id: p.id, team: p.team, x: a.smooth.x, z: a.smooth.z, pace,
        behavior: a.behavior || 'RecoverShape', role: ctx.role,
        score: a.score, urgent: !!urgent,
        reason: a.reason, stamina: p.stamina,
      });
    }

    return { intents, kicks, snapshot: snap, debug: debugOf(snap, roles) };
  }

  function planTeamOf(snap) {
    // 玩家所在队（视角队）
    const u = snap.players.find((p) => p.isUser);
    return u ? u.team : 'home';
  }

  function debugOf(snap, plans) {
    const rows = [];
    for (const p of snap.players) {
      if (p.isUser) continue;
      const a = agents.get(p.id);
      if (!a) continue;
      const plan = plans[p.team];
      rows.push({
        id: p.id, name: p.name, team: p.team, number: p.number,
        x: p.x, z: p.z,
        role: (plan && plan.roleOf[p.id]) || 'shape',
        roleLabel: ROLE_LABEL[(plan && plan.roleOf[p.id]) || 'shape'] || '',
        behavior: a.behavior || 'RecoverShape',
        behaviorLabel: (BEHAVIOR_BY_ID[a.behavior] || BEHAVIOR_BY_ID.RecoverShape).label,
        action: a.onBall || null,
        score: +a.score.toFixed(2),
        target: a.smooth ? { x: +a.smooth.x.toFixed(1), z: +a.smooth.z.toFixed(1) } : null,
        reason: a.reason,
        why: a.why,
        scores: a.allScores || a.scores || [],
        switches: a.switches,
        stamina: Math.round(p.stamina),
        pending: a.pendingKick ? a.pendingKick.type : null,
      });
    }
    return {
      phase: plans.home.phase, home: plans.home, away: plans.away,
      carrier: snap.ball.ownerId, ball: { x: +snap.ball.x.toFixed(1), z: +snap.ball.z.toFixed(1), speed: +snap.ball.speed.toFixed(1) },
      players: rows, log: log.slice(-12),
    };
  }

  return {
    cfg,
    update, reset, configure,
    plans: () => roles,
    logs: () => log.slice(),
    agentOf,
    lastSnapshot: () => lastSnap,
  };
}
