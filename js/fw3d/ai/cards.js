// FW3D AI · 红黄牌（设计 04 §比赛规则，第六阶段）
// 只负责两件事：
//   1) 给定"这次犯规的性质"，给出该出黄牌/红牌的概率（纯函数，随机数由调用方掷，便于测试与复现）；
//   2) 记录本（谁吃了几黄几红、是否已罚下）。
// 表现层（HUD 提示、球员下场、阵型按人数算）由 arena 负责，本文件不 import THREE、不碰 DOM。
//
// 判罚口径（IFAB 简化版，写清楚是为了以后能校准，不是为了假装精确）：
//   - 破坏明显进球机会（DOGSO：拉/推/手球挡出必进球）→ 大概率为红牌；
//   - 严重犯规（背后冲刺、亮鞋底/双脚这类 reckless）→ 黄牌概率高，小概率直接红；
//   - 普通战术犯规（拉人/挡人，正面且不快）→ 黄牌概率中等；
//   - 普通上抢失败 → 基本不出牌（否则一场会出十张牌）。
import { clamp, sat } from './mathx.js';

export const CARDS = ['none', 'yellow', 'red'];

/**
 * 这次犯规该出牌的概率（0–1，两者互相独立地"先判红再判黄"）
 * @param {object} o {angleCos, speed, reckless, deniedGoal}
 * @returns {{red:number, yellow:number}}
 */
export function cardChance(o) {
  const opt = o || {};
  const angleCos = isFinite(opt.angleCos) ? opt.angleCos : 0;   // <0 = 从背后上来
  const speed = Math.max(0, opt.speed || 0);                    // 上抢者速度 m/s
  const reckless = !!opt.reckless;
  const deniedGoal = !!opt.deniedGoal;
  if (deniedGoal) return { red: 0.72, yellow: 0.26 };           // 挡住必进球：红为主
  let yellow = 0.18;
  if (angleCos < -0.15) yellow += 0.22;                        // 背后
  if (speed > 4.5) yellow += 0.16;                              // 冲上来
  if (reckless) yellow += 0.30;
  const red = reckless ? 0.10 : 0.012;
  return { red: clamp(red, 0, 1), yellow: clamp(yellow, 0, 1) };
}

/**
 * 掷牌。先判红、再判黄（两者不互斥地叠加概率区间）。
 * @param {{red:number,yellow:number}} chance cardChance 的结果
 * @param {function} rng 返回 [0,1) 的随机源，默认 Math.random
 * @returns {'none'|'yellow'|'red'}
 */
export function rollCard(chance, rng) {
  const c = chance || { red: 0, yellow: 0 };
  const r = (typeof rng === 'function' ? rng : Math.random)();
  if (r < (c.red || 0)) return 'red';
  if (r < (c.red || 0) + (c.yellow || 0)) return 'yellow';
  return 'none';
}

/**
 * 破坏明显进球机会（DOGSO）判定（简化）：持球者离球门近、射门线路上几乎没有防守者、且不在自家半场。
 * @param {object} o {distToGoal, blockers, depth}
 * @returns {boolean}
 */
export function isDogso(o) {
  const opt = o || {};
  const d = isFinite(opt.distToGoal) ? opt.distToGoal : 99;
  const blockers = isFinite(opt.blockers) ? opt.blockers : 9;
  const depth = isFinite(opt.depth) ? opt.depth : 0;
  return d < 26 && blockers <= 1 && depth >= 0.5;
}

/**
 * 记账：给某人加一张牌（两黄自动变红并罚下）
 * @param {object} book playerId -> {y,r,off}
 * @param {string} playerId
 * @param {'yellow'|'red'} kind
 * @returns {{y:number,r:number,off:boolean}|null} 更新后的该球员记录
 */
export function addCard(book, playerId, kind) {
  if (!book || !playerId || (kind !== 'yellow' && kind !== 'red')) return null;
  const e = book[playerId] || (book[playerId] = { y: 0, r: 0, off: false });
  if (e.off) return e;                       // 已罚下：不再累计
  if (kind === 'yellow') {
    e.y += 1;
    if (e.y >= 2) { e.r += 1; e.off = true; }   // 两黄变红
  } else {
    e.r += 1;
    e.off = true;
  }
  return e;
}

/** 读某人记录（没有则全 0，不写入） */
export function bookOf(book, playerId) {
  const e = book && book[playerId];
  return e ? { y: e.y, r: e.r, off: !!e.off } : { y: 0, r: 0, off: false };
}

/** 已被罚下的球员 id 列表 */
export function sentOffIds(book) {
  return Object.keys(book || {}).filter((id) => book[id] && book[id].off);
}

/** 全队牌数统计（HUD/赛后用） */
export function cardTotals(book) {
  let yellow = 0, red = 0, off = 0;
  for (const id of Object.keys(book || {})) {
    const e = book[id];
    if (!e) continue;
    yellow += e.y || 0;
    red += e.r || 0;
    if (e.off) off += 1;
  }
  return { yellow, red, off };
}
