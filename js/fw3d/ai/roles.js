// FW3D AI · TeamPlan 与动态角色分配（设计 01 §6、02 §5）
// 角色不写死在球员编号上：每次按距离/位置/属性/体力/战术重算，但带"切换代价"和"最短保持"，
// 避免角色在两名球员之间来回跳。
import { clamp, sat, dist, bell } from './mathx.js';
import { iqAvg } from './attrs.js';
import { laneRisk, offsideRisk } from './features.js';

export const ROLE_LABEL = {
  GK: '门将',
  carrier: '持球',
  support: '接应',
  runner: '前插',
  widthL: '左拉边',
  widthR: '右拉边',
  anchor: '后场保护',
  presser: '逼抢',
  cover: '补位',
  mark: '盯人',
  shape: '回位',
};

function isWide(p) { return ['LW', 'RW', 'LB', 'RB'].indexOf(p.pos) >= 0; }
function isForward(p) { return ['ST', 'LW', 'RW', 'AM'].indexOf(p.pos) >= 0; }

// 带稳定性的选择：prev 持有者在最优候选的 margin 内则保留
function pick(cands, prevId, margin, used) {
  let best = null;
  for (const c of cands) {
    if (used.has(c.p.id)) continue;
    if (!best || c.score > best.score) best = c;
  }
  if (!best) return null;
  if (prevId && !used.has(prevId)) {
    const prev = cands.find((c) => c.p.id === prevId);
    if (prev && prev.score >= best.score - (margin == null ? 0.12 : margin)) return prev;
  }
  return best;
}

/** 单队角色分配 */
function planTeam(snap, teamKey, prevPlan, cfg) {
  const team = snap.teams[teamKey];
  const oppKey = teamKey === 'home' ? 'away' : 'home';
  const R = cfg.roles;
  const ball = snap.ball;
  const carrier = ball.owner && ball.ownerTeam === teamKey ? ball.owner : null;
  const loose = !ball.owner;
  const phase = carrier || (loose && ball.lastTouchTeam === teamKey) ? 'attack' : 'defend';

  const outfield = team.players.filter((p) => !p.isGk);
  const gk = team.players.find((p) => p.isGk) || null;
  const used = new Set();
  const roleOf = Object.create(null);
  if (gk) { roleOf[gk.id] = 'GK'; used.add(gk.id); }
  if (carrier) { roleOf[carrier.id] = 'carrier'; used.add(carrier.id); }

  const plan = {
    teamId: teamKey,
    at: snap.t,
    phase,
    carrierId: carrier ? carrier.id : null,
    gkId: gk ? gk.id : null,
    supportIds: [],
    runnerIds: [],
    widthIds: [],
    anchorIds: [],
    presserId: null,
    coverIds: [],
    marks: {},
    roleOf,
  };
  const prev = prevPlan || {};
  const prevHas = (role, id) => {
    if (!id) return false;
    if (role === 'support') return (prev.supportIds || []).indexOf(id) >= 0;
    if (role === 'runner') return (prev.runnerIds || []).indexOf(id) >= 0;
    if (role === 'width') return (prev.widthIds || []).indexOf(id) >= 0;
    if (role === 'anchor') return (prev.anchorIds || []).indexOf(id) >= 0;
    if (role === 'presser') return prev.presserId === id;
    if (role === 'cover') return (prev.coverIds || []).indexOf(id) >= 0;
    if (role === 'mark') return Object.keys(prev.marks || {}).indexOf(id) >= 0;
    return false;
  };

  if (phase === 'attack') {
    // ── 接应：离持球者 8–20 m、有空间、线路干净
    const c = carrier || team.nearestToBall;
    const supCands = [];
    for (const p of outfield) {
      if (!c || p.id === c.id) continue;
      const d = dist(p.x, p.z, c.x, c.z);
      const risk = laneRisk(c, p, p.opps);
      let score =
        0.34 * bell(d, 11, 15) +
        0.30 * p.space +
        0.22 * (1 - risk) +
        0.14 * iqAvg(p.attrs, ['teamwork', 'spatial']);
      if (prevHas('support', p.id)) score += R.stability;
      supCands.push({ p, score: sat(score) });
    }
    supCands.sort((a, b) => b.score - a.score);
    for (let i = 0; i < R.supportMax; i++) {
      const chosen = pick(supCands, i === 0 ? (prev.supportIds || [])[0] : null, 0.1, used);
      if (!chosen) break;
      plan.supportIds.push(chosen.p.id);
      roleOf[chosen.p.id] = 'support';
      used.add(chosen.p.id);
    }

    // ── 前插：位置靠前、身后有空间、不越位
    const runCands = [];
    for (const p of outfield) {
      if (used.has(p.id)) continue;
      if (!isForward(p) && p.pos !== 'CM') continue;
      const off = offsideRisk(p, snap);
      const behind = sat((p.depth - 0.42) * 2.2) * sat(1 - Math.abs(p.z - team.defenderLineZ) / 30);
      const score = sat(0.44 * behind + 0.28 * (1 - off) + 0.16 * p.space + 0.12 * (p.pos === 'ST' ? 1 : 0.55) + (prevHas('runner', p.id) ? R.stability : 0));
      runCands.push({ p, score });
    }
    runCands.sort((a, b) => b.score - a.score);
    {
      const chosen = pick(runCands, (prev.runnerIds || [])[0], 0.1, used);
      if (chosen) { plan.runnerIds.push(chosen.p.id); roleOf[chosen.p.id] = 'runner'; used.add(chosen.p.id); }
    }

    // ── 两侧拉边：优先边路球员，保留队形宽度
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? -1 : 1;
      const cands = [];
      for (const p of outfield) {
        if (used.has(p.id)) continue;
        const flank = sat((p.x * sign) / snap.pitch.halfW);           // 已在同一侧
        const sideSpace = sat(1 - Math.abs(Math.abs(p.x) - snap.pitch.halfW * 0.8) / 20);
        const score = sat(
          0.36 * flank + 0.26 * (isWide(p) ? 1 : 0.25) + 0.2 * p.space + 0.18 * (1 - laneRiskSnap(p, c)) +
          (prevHas('width', p.id) ? R.stability : 0)
        );
        cands.push({ p, score: sat(score * (0.6 + 0.4 * sideSpace)) });
      }
      cands.sort((a, b) => b.score - a.score);
      const chosen = pick(cands, (prev.widthIds || [])[side === 'L' ? 0 : 1], 0.1, used);
      if (chosen) { plan.widthIds.push(chosen.p.id); roleOf[chosen.p.id] = side === 'L' ? 'widthL' : 'widthR'; used.add(chosen.p.id); }
      else plan.widthIds.push(null);
    }

    // ── 后场保护：最深的两名球员
    const rest = outfield.filter((p) => !used.has(p.id)).sort((a, b) => a.depth - b.depth);
    for (let i = 0; i < Math.min(R.anchors, rest.length); i++) {
      plan.anchorIds.push(rest[i].id);
      roleOf[rest[i].id] = 'anchor';
      used.add(rest[i].id);
    }
  } else {
    // ── 防守：最近且合适的压迫者 + 补位 + 盯人
    const pressCands = [];
    for (const p of outfield) {
      const d = p.distToBall;
      const stamina = sat(p.stamina / 100);
      const score = sat(
        0.5 * (1 - sat(d / R.presserMaxDist)) +
        0.2 * (1 - sat((p.depth - 0.5) * 2)) +
        0.2 * stamina +
        0.1 * iqAvg(p.attrs, ['defense', 'decision']) +
        (prevHas('presser', p.id) ? R.stability : 0)
      );
      pressCands.push({ p, score, d });
    }
    pressCands.sort((a, b) => b.score - a.score);
    {
      const chosen = pick(pressCands, prev.presserId, 0.08, used);
      if (chosen && chosen.d < R.presserMaxDist) {
        plan.presserId = chosen.p.id;
        roleOf[chosen.p.id] = 'presser';
        used.add(chosen.p.id);
      }
    }

    const coverCands = [];
    for (const p of outfield) {
      if (used.has(p.id)) continue;
      const score = sat(
        0.42 * (1 - sat(p.distToBall / 28)) +
        0.28 * iqAvg(p.attrs, ['defense', 'anticipation']) +
        0.3 * (p.pos === 'CM' ? 1 : p.pos === 'CB' ? 0.8 : 0.4) +
        (prevHas('cover', p.id) ? R.stability : 0)
      );
      coverCands.push({ p, score });
    }
    coverCands.sort((a, b) => b.score - a.score);
    const cover = pick(coverCands, (prev.coverIds || [])[0], 0.1, used);
    if (cover) { plan.coverIds.push(cover.p.id); roleOf[cover.p.id] = 'cover'; used.add(cover.p.id); }

    // 盯人：对方最靠前的 3 名非持球者
    const oppTeam = snap.teams[oppKey];
    const threats = oppTeam.players
      .filter((o) => !o.isGk && o.id !== (ball.ownerId || ''))
      .sort((a, b) => b.depth - a.depth)
      .slice(0, 3);
    const free = outfield.filter((p) => !used.has(p.id) && p.pos !== 'ST');
    for (const th of threats) {
      if (!free.length) break;
      let best = null, bs = -1;
      for (const p of free) {
        if (used.has(p.id)) continue;
        const d = dist(p.x, p.z, th.x, th.z);
        let score = sat(1 - sat(d / 26) + iqAvg(p.attrs, ['defense']) * 0.3 + (prevHas('mark', p.id) ? R.stability : 0));
        if (score > bs) { bs = score; best = p; }
      }
      if (best) {
        plan.marks[best.id] = th.id;
        roleOf[best.id] = 'mark';
        used.add(best.id);
      }
    }

    const rest = outfield.filter((p) => !used.has(p.id)).sort((a, b) => a.depth - b.depth);
    for (let i = 0; i < Math.min(R.anchors, rest.length); i++) {
      plan.anchorIds.push(rest[i].id);
      roleOf[rest[i].id] = 'anchor';
      used.add(rest[i].id);
    }
  }

  // 未分配者一律"回位"
  for (const p of outfield) if (!roleOf[p.id]) roleOf[p.id] = 'shape';

  plan.changed = !prevPlan || prevPlan.phase !== plan.phase || prevPlan.carrierId !== plan.carrierId ||
    JSON.stringify(prevPlan.roleOf || {}) !== JSON.stringify(roleOf);
  plan.sig = Object.keys(roleOf).sort().map((k) => k + ':' + roleOf[k]).join(',');
  return plan;
}

function laneRiskSnap(p, c) {
  return c ? laneRisk(c, p, p.opps) : 0;
}

/** 两队角色分配；返回 {home, away, changed } */
export function assignRoles(snap, prev, cfg) {
  const home = planTeam(snap, 'home', prev && prev.home, cfg);
  const away = planTeam(snap, 'away', prev && prev.away, cfg);
  return { home, away, changed: home.changed || away.changed };
}

/** 角色是否到期需要重算 */
export function rolesDue(snap, prev, cfg) {
  if (!prev || !prev.home || !prev.away) return true;
  if (prev.at == null) return true;
  return (snap.t - prev.at) >= 1 / Math.max(0.5, cfg.rates.rolesHz);
}

export { clamp };

// ── 少一人阵型（红牌后重排用）─────────────────────────────
// 基准坐标与 arena 的 SHAPE_HOME 同一套（主队守 -z，所以 z 为负）；sign = +1 主队 / -1 客队（客队镜像）。
// 只在"人被罚下"这一刻改目标点（shape），不动球员当前位置、属性与动作。
export const SHAPE_10 = [
  [0, -48],                                        // GK
  [-22, -31], [-8, -33], [8, -33], [22, -31],      // 4 后卫
  [-18, -14], [-6, -12], [6, -12], [18, -14],      // 4 中场
  [0, 8],                                          // 1 前锋 → 4-4-1
];
export const SHAPE_9 = [
  [0, -48],
  [-20, -31], [-7, -33], [7, -33], [20, -31],      // 4 后卫
  [-12, -13], [0, -11], [12, -13],                 // 3 中场
  [0, 8],                                          // 1 前锋 → 4-3-1
];

/**
 * 少一人时的阵型点。
 * @param {number} count 场上实到人数（含门将）
 * @param {number} sign +1 主队 / -1 客队（客队镜像到 +z 半场）
 * @returns {Array<{x:number,z:number}>|null} 11 人及以上返回 null（不需要重排）
 */
export function reducedShape(count, sign) {
  const table = count === 10 ? SHAPE_10 : count === 9 ? SHAPE_9 : null;
  if (!table) return null;
  const s = sign >= 0 ? 1 : -1;
  return table.map(([x, z]) => ({ x: x * s, z: z * s }));
}
