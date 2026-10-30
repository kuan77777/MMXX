// FW3D AI · 牌面跨场累积与停赛（第六阶段）
// 纯逻辑：把红黄牌记到"球员级"的纪律档案里，算出停赛场次并扣减。
// 规则（简化但可解释，写清楚便于以后校准）：
//   - 累计 3 张黄牌 → 停赛 1 场，累计清零（再得黄重新数）；
//   - 直接红牌 → 停赛 2 场；
//   - 两黄变红 → 停赛 1 场（这两张黄不再计入 3 黄阈值）；
//   - 停赛只影响"下一场能不能上"，不在这里改能力值。
// 不 import THREE、不碰 DOM；记录本身是 JSON-safe 的普通对象，可直接进存档。
export const SUSPEND = {
  yellowForBan: 3,       // 累计黄牌数
  redBan: 2,             // 直接红牌停赛场次
  secondYellowBan: 1,    // 两黄变红停赛场次
};

/** 规整成完整档案结构（不修改入参） */
export function normalize(record) {
  const r = record || {};
  return {
    yellow: Math.max(0, Number(r.yellow) || 0),
    red: Math.max(0, Number(r.red) || 0),
    ban: Math.max(0, Number(r.ban) || 0),
    yellowTotal: Math.max(0, Number(r.yellowTotal) || 0),
    redTotal: Math.max(0, Number(r.redTotal) || 0),
    matches: Math.max(0, Number(r.matches) || 0),
  };
}

/**
 * 增量记一张牌（arena 每给一张牌就调一次，立即持久化）
 * @param {object} record 原档案（可为空）
 * @param {'yellow'|'red'} kind
 * @param {{secondYellow?:boolean}} opts secondYellow=true 表示这是该场第二黄（两黄变红）
 * @returns {object} 新档案
 */
export function addCardToRecord(record, kind, opts) {
  const r = normalize(record);
  const second = !!(opts && opts.secondYellow);
  if (kind === 'yellow') {
    if (second) {
      // 两黄变红：先前那张黄不再计入累计，本次直接停 1 场
      r.yellow = Math.max(0, r.yellow - 1);
      r.red += 1;
      r.redTotal += 1;
      r.ban += SUSPEND.secondYellowBan;
    } else {
      r.yellow += 1;
      r.yellowTotal += 1;
      while (r.yellow >= SUSPEND.yellowForBan) { r.yellow -= SUSPEND.yellowForBan; r.ban += 1; }
    }
  } else if (kind === 'red') {
    r.red += 1;
    r.redTotal += 1;
    r.ban += SUSPEND.redBan;
  }
  return r;
}

/**
 * 一场比赛结束后的批量结算（用 addCardToRecord 同一套常量，便于测试与回放）
 * @param {object} record
 * @param {{yellow?:number, red?:number, secondYellow?:number}} cards 本场该球员的牌
 */
export function applyMatchCards(record, cards) {
  const c = cards || {};
  let r = normalize(record);
  r.matches += 1;
  const sy = Math.max(0, c.secondYellow | 0);
  const red = Math.max(0, c.red | 0);
  const yellow = Math.max(0, (c.yellow | 0) - sy * 2);   // 两黄变红的两张黄不再计入
  for (let i = 0; i < sy; i++) r = addCardToRecord(r, 'yellow', { secondYellow: true });
  for (let i = 0; i < red; i++) r = addCardToRecord(r, 'red');
  for (let i = 0; i < yellow; i++) r = addCardToRecord(r, 'yellow');
  return r;
}

/** 该球员是否处于停赛中 */
export function isSuspended(record) {
  return normalize(record).ban > 0;
}

/** 停赛场次 -1（该球员缺席了一场之后调用） */
export function serveBan(record) {
  const r = normalize(record);
  r.ban = Math.max(0, r.ban - 1);
  return r;
}

/**
 * 从名单里滤掉停赛球员（arena 的 pickXI 用它选人）
 * @param {Array<string>} ids 候选球员 id
 * @param {object} registry playerId → 档案
 * @returns {{available:string[], suspended:string[]}}
 */
export function filterAvailable(ids, registry) {
  const reg = registry || {};
  const available = [], suspended = [];
  for (const id of (ids || [])) {
    if (id == null) continue;
    if (isSuspended(reg[id])) suspended.push(id);
    else available.push(id);
  }
  return { available, suspended };
}

/** 整本档案的汇总（HUD / 赛后报告） */
export function disciplineSummary(registry) {
  const reg = registry || {};
  let players = 0, banned = 0, yellowTotal = 0, redTotal = 0;
  for (const id of Object.keys(reg)) {
    const r = normalize(reg[id]);
    players += 1;
    if (r.ban > 0) banned += 1;
    yellowTotal += r.yellowTotal;
    redTotal += r.redTotal;
  }
  return { players, banned, yellowTotal, redTotal };
}
