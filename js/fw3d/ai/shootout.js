// FW3D AI · 点球大战（淘汰赛，第六阶段规则收尾）
// 只做"轮次 / 先后 / 终止条件"这套纯逻辑：
//   - 5 轮互罚，先手先罚、严格交替；
//   - 每脚之后都判一次提前锁定（一方领先超过对手剩余罚球次数即结束）；
//   - 5 轮打完仍平 → 突然死亡（每轮双方各 1 脚，一轮打完分差即结束）；
//   - 兜底：突然死亡超过 maxRounds 轮仍平（理论几乎不可能）判先手获胜，避免死循环。
// 不 import THREE、不碰 DOM、不掷随机（进球与否由调用方按真实物理结果传入）。

export const SHOOTOUT = {
  rounds: 5,                 // 常规轮次
  maxRounds: 30,             // 突然死亡上限（轮），超过仍平则兜底判先手胜，避免死循环
};

/**
 * 建一场点球大战
 * @param {{first?:'home'|'away', rounds?:number}} opts
 */
export function createShootout(opts) {
  const o = opts || {};
  const first = o.first === 'away' ? 'away' : 'home';
  return {
    first,
    second: first === 'home' ? 'away' : 'home',
    rounds: Math.max(1, o.rounds || SHOOTOUT.rounds),
    kicks: { home: 0, away: 0 },
    goals: { home: 0, away: 0 },
    order: [],
    round: 1,
    sudden: false,
    done: false,
    winner: null,
    reason: null,
  };
}

/** 下一个主罚方：严格交替，先手先罚 */
export function nextShooter(st) {
  const n = st.order.length;
  return n % 2 === 0 ? st.first : st.second;
}

/** 该队在常规轮次里还剩几脚（突然死亡阶段恒为 0，用 pairDone 判定） */
export function remainingKicks(st, team) {
  if (st.sudden) return 0;
  return Math.max(0, st.rounds - st.kicks[team]);
}

function finish(st, winner, reason) {
  st.done = true;
  st.winner = winner;
  st.reason = reason;
  return { done: true, winner, reason, goals: { ...st.goals } };
}

/**
 * 记录一脚结果（进球 / 没进），按规则推进并判定是否结束。
 * @param {object} st createShootout 的返回
 * @param {boolean} scored
 * @returns {{done:boolean, winner:string|null, reason:string|null, goals:{home:number,away:number}}}
 */
export function recordKick(st, scored) {
  if (!st || st.done) return { done: true, winner: st ? st.winner : null, reason: st ? st.reason : null, goals: st ? { ...st.goals } : null };
  const team = nextShooter(st);
  st.kicks[team] += 1;
  if (scored) st.goals[team] += 1;
  st.order.push({ team, scored: !!scored, round: st.round, sudden: st.sudden });

  const a = st.first, b = st.second;
  if (!st.sudden) {
    const allRegular = st.kicks[a] >= st.rounds && st.kicks[b] >= st.rounds;
    // 五轮打完且分差已定（这是"提前锁定"的同一判据，但理由写清楚）
    if (allRegular && st.goals[a] !== st.goals[b]) {
      return finish(st, st.goals[a] > st.goals[b] ? a : b, '五轮决出（' + st.goals[a] + '-' + st.goals[b] + '）');
    }
    // 提前锁定：领先方分数 > 落后方分数 + 落后方剩余罚球次数
    if (st.goals[a] > st.goals[b] + remainingKicks(st, b)) return finish(st, a, '提前锁定（' + st.goals[a] + '-' + st.goals[b] + '）');
    if (st.goals[b] > st.goals[a] + remainingKicks(st, a)) return finish(st, b, '提前锁定（' + st.goals[b] + '-' + st.goals[a] + '）');
    if (allRegular) {
      // 五轮打完仍平 → 进入突然死亡
      st.sudden = true;
      st.round = st.rounds + 1;
    } else {
      st.round = Math.min(st.rounds, Math.floor(st.order.length / 2) + 1);
    }
    return { done: false, winner: null, reason: null, goals: { ...st.goals } };
  }

  // 突然死亡：双方都罚完这一轮（偶数脚）才判分差
  if (st.order.length % 2 === 0) {
    if (st.goals[a] !== st.goals[b]) {
      return finish(st, st.goals[a] > st.goals[b] ? a : b, '突然死亡（' + st.goals[a] + '-' + st.goals[b] + '）');
    }
    st.round += 1;
    if (st.round - st.rounds > SHOOTOUT.maxRounds) return finish(st, a, '超长平局兜底（' + st.goals[a] + '-' + st.goals[b] + '）');
  }
  return { done: false, winner: null, reason: null, goals: { ...st.goals } };
}

/**
 * 赛事类型规则表（**规定：联赛与友谊赛没有点球大战**，平局就是平局）。
 * - league：联赛（含各国顶级/次级联赛）→ 允许平局，**不允许点球大战**；
 * - friendly：友谊赛/热身赛 → 同上；
 * - cup：单场淘汰（杯赛）→ 平局后点球大战；
 * - twoLegged：两回合淘汰 → 总分平了点球大战；
 * - continental：洲际/大洲赛事（亚冠、解放者杯等）→ 同两回合淘汰。
 * 未知类型按 league 处理（宁可踢平也不乱上点球大战）。
 */
export const COMPETITIONS = {
  league: { label: '联赛', allowsDraw: true, allowsShootout: false, legs: 1 },
  friendly: { label: '友谊赛', allowsDraw: true, allowsShootout: false, legs: 1 },
  cup: { label: '杯赛（单场淘汰）', allowsDraw: false, allowsShootout: true, legs: 1 },
  twoLegged: { label: '两回合淘汰', allowsDraw: false, allowsShootout: true, legs: 2 },
  continental: { label: '洲际赛事（两回合）', allowsDraw: false, allowsShootout: true, legs: 2 },
};

/** 取赛事规则；未知/缺省一律按联赛处理 */
export function competitionRule(kind) {
  return COMPETITIONS[kind] || COMPETITIONS.league;
}

const CUP_WORDS = ['杯', 'cup', '淘汰', 'knockout', 'playoff', '附加赛'];
const CONTINENTAL_WORDS = ['亚冠', '欧冠', '欧联', '解放者', '南美', 'champions', 'europa', 'libertadores', '洲际', '联合会'];
const FRIENDLY_WORDS = ['友谊', '热身', 'friendly'];
const LEAGUE_WORDS = ['联赛', 'liga', 'league', 'premier', 'serie', 'bundesliga', 'ligue', '超级', '甲级', '乙级', 'division'];

/**
 * 从赛事名/标志推断赛事类型（不认识的按联赛，避免"联赛也罚点球"）
 * @param {{kind?:string, competition?:string, knockout?:boolean}} o
 */
export function competitionKindOf(o) {
  const opt = o || {};
  if (opt.kind && COMPETITIONS[opt.kind]) return opt.kind;
  const name = String(opt.competition || '').toLowerCase();
  if (name) {
    if (FRIENDLY_WORDS.some((w) => name.indexOf(w) >= 0)) return 'friendly';
    if (CONTINENTAL_WORDS.some((w) => name.indexOf(w) >= 0)) return 'continental';
    if (CUP_WORDS.some((w) => name.indexOf(w) >= 0)) return 'cup';
    if (LEAGUE_WORDS.some((w) => name.indexOf(w) >= 0)) return 'league';
  }
  if (opt.knockout === true) return 'cup';
  return 'league';
}

/**
 * 赛事层裁决：这场要不要点球大战，附带理由。
 * **联赛/友谊赛永远不需要**（即使传了 knockout:true 也不生效——那条规矩不能被调用方绕过）。
 * @param {{kind?:string, competition?:string, knockout?:boolean, aggA?:number, aggB?:number, scoreA?:number, scoreB?:number}} o
 *        aggA/aggB = 两回合总比分；单场淘汰赛传 scoreA/scoreB（两者择一，agg 优先）
 * @returns {{needed:boolean, kind:string, reason:string, rule:object}}
 */
export function shootoutDecision(o) {
  const opt = o || {};
  const kind = competitionKindOf(opt);
  const rule = competitionRule(kind);
  if (!rule.allowsShootout) {
    return {
      needed: false, kind, rule,
      reason: (kind === 'friendly' ? '友谊赛' : '联赛') + '没有点球大战（允许平局）',
    };
  }
  const a = isFinite(opt.aggA) ? opt.aggA : (isFinite(opt.scoreA) ? opt.scoreA : 0);
  const b = isFinite(opt.aggB) ? opt.aggB : (isFinite(opt.scoreB) ? opt.scoreB : 0);
  if (a !== b) return { needed: false, kind, rule, reason: '总分不平，不需要点球大战（' + a + '-' + b + '）' };
  return { needed: true, kind, rule, reason: rule.label + '总分平，进入点球大战（' + a + '-' + b + '）' };
}

/** 兼容旧调用：只要"要不要点球大战"这个布尔值 */
export function needsShootout(o) {
  return shootoutDecision(o).needed;
}

/** 汇总（HUD / 赛后报告用） */
export function shootoutSummary(st) {
  if (!st) return null;
  return {
    done: st.done, winner: st.winner, reason: st.reason,
    goals: { ...st.goals }, kicks: { ...st.kicks },
    rounds: st.round, sudden: st.sudden, kicksTotal: st.order.length,
    winnerGoals: st.winner ? st.goals[st.winner] : null,
    loserGoals: st.winner ? st.goals[st.winner === 'home' ? 'away' : 'home'] : null,
  };
}
