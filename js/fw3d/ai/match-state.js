// FW3D AI · 比赛状态（设计 01 §1 Match Core、路线图 Phase 1）
// 唯一权威：比赛阶段、比赛时间、比分、球权、最后触球。
// 其它模块（渲染 / 动画 / HUD）只读这里，不自己算比分和阶段。
import { clamp } from './mathx.js';

export const PHASES = ['preMatch', 'kickoff', 'inPlay', 'goalPause', 'halfTime', 'fullTime', 'setPiece', 'paused'];

export function createMatchState(opts) {
  const o = opts || {};
  const s = {
    phase: o.phase || 'preMatch',
    prevPhase: null,
    minute: 0,
    rate: o.rate == null ? 1.6 : o.rate,   // 现实秒 → 比赛分钟
    half: 1,
    score: { home: 0, away: 0 },
    possession: { teamId: null, playerId: null, confidence: 0 },
    lastTouch: { playerId: null, teamId: null, t: -99, kind: null },
    touches: 0,
    goals: 0,
    goalLockUntil: 0,
    phaseAt: 0,
    events: [],
    over: false,
  };

  function pushEvent(type, data, t) {
    s.events.push(Object.assign({ type, t: t == null ? s.minute : t, minute: Math.floor(s.minute) }, data || {}));
    if (s.events.length > 120) s.events.shift();
  }

  function setPhase(p, t, data) {
    if (PHASES.indexOf(p) < 0 || s.phase === p) return s.phase;
    s.prevPhase = s.phase;
    s.phase = p;
    s.phaseAt = t == null ? s.minute : t;
    pushEvent('phase', { phase: p, from: s.prevPhase }, t);
    return s.phase;
  }

  // 每个渲染帧推进（只有 inPlay 走表）
  function tick(dtReal, tReal) {
    if (s.phase === 'inPlay') {
      s.minute += Math.max(0, dtReal) * s.rate;
      if (s.minute >= 90) {
        s.minute = 90;
        s.over = true;
        setPhase('fullTime', tReal);
      }
    }
    return s.minute;
  }

  // 触球记录：所有改球速的地方都必须调一次（保证"最后触球"可信）
  function touch(playerId, teamId, tReal, kind) {
    s.lastTouch = { playerId: playerId || null, teamId: teamId || null, t: tReal == null ? 0 : tReal, kind: kind || 'kick' };
    s.touches++;
    return s.lastTouch;
  }

  // 球权：由 arena 每帧判定候选者后写入（含置信度）
  function setPossession(playerId, teamId, confidence, tReal) {
    const changed = s.possession.playerId !== (playerId || null);
    s.possession = { playerId: playerId || null, teamId: teamId || null, confidence: clamp(confidence == null ? (playerId ? 1 : 0) : confidence, 0, 1) };
    if (changed && playerId) touch(playerId, teamId, tReal, 'control');
    return changed;
  }

  // 进球：只有规则系统调用；带同帧去重，避免一次进球被多路记两遍
  function goal(teamId, tReal, detail) {
    const t = tReal == null ? 0 : tReal;
    if (t < s.goalLockUntil) return null;
    s.goalLockUntil = t + 1.0;
    if (teamId === 'home') s.score.home++;
    else if (teamId === 'away') s.score.away++;
    else return null;
    s.goals++;
    pushEvent('goal', Object.assign({ team: teamId, score: { home: s.score.home, away: s.score.away } }, detail || {}));
    setPhase('goalPause', tRan(tReal));
    return { score: { home: s.score.home, away: s.score.away }, team: teamId };
  }
  function tRan(v) { return v == null ? s.minute : v; }

  function kickoff(tReal) {
    setPhase('kickoff', tRan(tReal));
    return s.phase;
  }

  function resume(tReal) {
    setPhase('inPlay', tRan(tReal));
    return s.phase;
  }

  function setScore(home, away) {
    s.score.home = Math.max(0, home | 0);
    s.score.away = Math.max(0, away | 0);
    return s.score;
  }

  function snapshotOf() {
    return {
      phase: s.phase, minute: +s.minute.toFixed(2), half: s.half,
      score: { home: s.score.home, away: s.score.away },
      possession: Object.assign({}, s.possession),
      lastTouch: Object.assign({}, s.lastTouch),
      over: s.over, goals: s.goals, touches: s.touches,
    };
  }

  return {
    state: s, PHASES,
    setPhase, tick, touch, setPossession, goal, kickoff, resume, setScore,
    snapshot: snapshotOf, events: () => s.events.slice(),
  };
}
