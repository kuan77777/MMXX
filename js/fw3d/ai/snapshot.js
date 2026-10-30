// FW3D AI · WorldSnapshot（设计 01 §5）
// 以固定频率把场景压成只读快照：AI 只读快照，不读 THREE 对象，也不逐帧全量查询。
// 全部坐标为平面坐标 {x, z}，单位 m：x ∈ [-halfW, halfW]，z ∈ [-halfL, halfL]。
// 攻击方向：team.attackZ = +1 表示朝 +z 球门进攻（自己的球门在 -z）。
import { clamp, sat, dist } from './mathx.js';

const EMPTY_BALL = { x: 0, z: 0, y: 0, vx: 0, vz: 0, speed: 0, ownerId: null, ownerTeam: null, lastTouchId: null, lastTouchTeam: null, inPlay: true };

function pressureOf(p, opponents) {
  let sum = 0;
  for (const o of opponents) {
    const d = dist(p.x, p.z, o.x, o.z);
    if (d < 8) {
      const w = Math.pow(1 - d / 8, 1.4);
      // 对手朝我跑来得更快（预判压迫）
      const closing = (o.vx * (p.x - o.x) + o.vz * (p.z - o.z)) / Math.max(0.4, d);
      sum += w * (1 + sat(closing / 6) * 0.5);
    }
  }
  return sat(sum / 2.6);
}

function spaceOf(p, opponents, minD, approachSpeed) {
  if (!opponents.length) return 1;
  const space = sat(minD / 13);
  const speedMul = 1 - sat(approachSpeed / 9) * 0.35;
  return sat(space * speedMul);
}

// 最近对手（含距离与逼近速度）
function nearestOf(p, list) {
  let best = null, bd = Infinity;
  for (const o of list) {
    if (o.id === p.id) continue;
    const d = dist(p.x, p.z, o.x, o.z);
    if (d < bd) { bd = d; best = o; }
  }
  if (!best) return { id: null, d: Infinity, closing: 0 };
  const closing = ((p.x - best.x) * best.vx + (p.z - best.z) * best.vz) / Math.max(0.4, bd);
  return { id: best.id, d: bd, closing, player: best };
}

/**
 * @param {object} inp
 *  inp.t 秒；inp.ball；inp.players[]；inp.pitch{halfW,halfL}；inp.teams{home,away}；inp.match{phase,score,minute}
 */
export function buildSnapshot(inp) {
  const pitch = inp.pitch || { halfW: 34, halfL: 52.5 };
  const teamsIn = inp.teams || { home: { attackZ: 1 }, away: { attackZ: -1 } };
  const ballIn = Object.assign({}, EMPTY_BALL, inp.ball || {});

  const snap = {
    t: inp.t || 0,
    dt: inp.dt || 0,
    tick: inp.tick || 0,
    pitch: { halfW: pitch.halfW, halfL: pitch.halfL },
    match: {
      phase: (inp.match && inp.match.phase) || 'inPlay',
      minute: (inp.match && inp.match.minute) || 0,
      score: (inp.match && inp.match.score) || { home: 0, away: 0 },
    },
    teams: {},
    players: [],
    byId: Object.create(null),
    teamOf: Object.create(null),
  };

  for (const key of ['home', 'away']) {
    const t = teamsIn[key] || {};
    const attackZ = t.attackZ === -1 ? -1 : 1;
    snap.teams[key] = {
      id: key,
      label: t.label || (key === 'home' ? '主队' : '客队'),
      attackZ,
      goalZ: pitch.halfL * attackZ,
      ownGoalZ: -pitch.halfL * attackZ,
      players: [],
      color: t.color || null,
    };
  }

  // 1) 归一化球员
  for (const raw of (inp.players || [])) {
    const teamKey = raw.team === 'away' ? 'away' : 'home';
    const team = snap.teams[teamKey];
    const p = {
      id: raw.id,
      team: teamKey,
      slot: raw.slot == null ? -1 : raw.slot,
      pos: raw.pos || 'CM',
      name: raw.name || '',
      number: raw.number == null ? null : raw.number,
      x: Number(raw.x) || 0,
      z: Number(raw.z) || 0,
      vx: Number(raw.vx) || 0,
      vz: Number(raw.vz) || 0,
      speed: Math.hypot(Number(raw.vx) || 0, Number(raw.vz) || 0),
      facing: isFinite(raw.facing) ? raw.facing : 0,
      stamina: isFinite(raw.stamina) ? raw.stamina : 100,
      isUser: !!raw.isUser,
      isGk: !!raw.isGk || raw.pos === 'GK',
      attrs: raw.attrs || null,
      shape: raw.shape || { x: raw.x, z: raw.z },
      // 攻击方向与纵深（0 = 自己底线，1 = 对方底线）
      attackZ: team.attackZ,
      depth: sat((team.attackZ > 0 ? raw.z + pitch.halfL : pitch.halfL - raw.z) / (pitch.halfL * 2)),
      width: sat(Math.abs(raw.x) / pitch.halfW),
      goalZ: team.goalZ,
      ownGoalZ: team.ownGoalZ,
      distToBall: dist(raw.x, raw.z, ballIn.x, ballIn.z),
    };
    snap.players.push(p);
    snap.byId[p.id] = p;
    snap.teamOf[p.id] = teamKey;
    team.players.push(p);
  }

  // 2) 球
  snap.ball = {
    x: ballIn.x, z: ballIn.z, y: ballIn.y,
    vx: ballIn.vx, vz: ballIn.vz,
    speed: ballIn.speed != null ? ballIn.speed : Math.hypot(ballIn.vx || 0, ballIn.vz || 0),
    ownerId: ballIn.ownerId || null,
    ownerTeam: ballIn.ownerTeam || null,
    lastTouchId: ballIn.lastTouchId || null,
    lastTouchTeam: ballIn.lastTouchTeam || null,
    inPlay: ballIn.inPlay !== false,
  };
  snap.ball.owner = snap.ball.ownerId ? snap.byId[snap.ball.ownerId] || null : null;

  // 3) 每个球员的局部感知（只算一次，供所有行为复用 → 感知简化）
  const home = snap.teams.home.players, away = snap.teams.away.players;
  for (const p of snap.players) {
    const opp = p.team === 'home' ? away : home;
    const mates = (p.team === 'home' ? home : away).filter((m) => m.id !== p.id);
    const nOpp = nearestOf(p, opp);
    const nMate = nearestOf(p, mates);
    p.oppDist = nOpp.d;
    p.oppId = nOpp.id;
    p.oppPlayer = nOpp.player || null;
    p.mateDist = nMate.d;
    p.pressure = pressureOf(p, opp);
    p.space = spaceOf(p, opp, nOpp.d, nOpp.closing);
    p.mates = mates;
    p.opps = opp;
  }

  // 4) 球权候选者（玩法层的置信度，不是刚体属性）
  if (!snap.ball.ownerId) {
    let cand = null, cd = Infinity;
    for (const p of snap.players) {
      if (p.distToBall < cd) { cd = p.distToBall; cand = p; }
    }
    snap.ball.candidateId = cand ? cand.id : null;
    snap.ball.candidateDist = cd;
  } else {
    snap.ball.candidateId = snap.ball.ownerId;
    snap.ball.candidateDist = snap.ball.owner ? snap.ball.owner.distToBall : Infinity;
  }

  // 5) 队伍级统计（阵型宽度/纵深、最近压迫者），行为和调试都用
  for (const key of ['home', 'away']) {
    const t = snap.teams[key];
    const outfield = t.players.filter((p) => !p.isGk);
    let sumX = 0, sumDepth = 0;
    for (const p of outfield) { sumX += p.x; sumDepth += p.depth; }
    t.avgX = outfield.length ? sumX / outfield.length : 0;
    t.avgDepth = outfield.length ? sumDepth / outfield.length : 0.5;
    t.widthSpread = outfield.length ? Math.max.apply(null, outfield.map((p) => Math.abs(p.x))) / snap.pitch.halfW : 0;
    t.defenderLineZ = defensiveLineZ(t, snap.pitch.halfL);
    t.nearestToBall = t.players.slice().sort((a, b) => a.distToBall - b.distToBall)[0] || null;
  }

  // 6) 越位线（简化：对方倒数第二名球员纵深，含门将）
  for (const key of ['home', 'away']) {
    const oppKey = key === 'home' ? 'away' : 'home';
    snap.teams[key].offsideLine = offsideLineOf(snap.teams[oppKey], snap.teams[key].attackZ, snap.pitch.halfL);
  }
  return snap;
}

// 防守线：全队（不含门将）中最靠自己球门的纵深
function defensiveLineZ(team, halfL) {
  let best = null;
  for (const p of team.players) {
    if (p.isGk) continue;
    if (best == null || (team.attackZ > 0 ? p.z < best : p.z > best)) best = p.z;
  }
  return best == null ? (team.attackZ > 0 ? -halfL * 0.6 : halfL * 0.6) : best;
}

// 越位线：防守方倒数第二名球员的 z（简化，不含"球本身在更前面"的例外）
function offsideLineOf(defTeam, attackZ, halfL) {
  const zs = defTeam.players.map((p) => p.z).sort((a, b) => (attackZ > 0 ? b - a : a - b));
  const second = zs.length > 1 ? zs[1] : (zs[0] == null ? (attackZ > 0 ? halfL : -halfL) : zs[0]);
  return clamp(second, -halfL, halfL);
}

// 供 arena 复用：把球权判定集中在一处
export function pickBallOwner(snap, cfg) {
  const b = snap.ball;
  if (b.speed > (cfg.ball.controlMaxSpeed || 9.5)) return null;
  let best = null, bd = (cfg.ball.controlRadius || 1.75);
  for (const p of snap.players) {
    if (p.isGk) continue;
    if (p.distToBall < bd) { bd = p.distToBall; best = p; }
  }
  return best;
}
