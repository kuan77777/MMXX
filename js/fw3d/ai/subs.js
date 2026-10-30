// FW3D AI · 换人（P3：体力换下 / 伤病换下）
// 纯逻辑：什么时候该换、换谁下、换谁上。不 import THREE、不碰 DOM。
export const SUBS = {
  max: 3,             // 每队最多 3 次换人
  minuteMin: 55,      // 太早不换（除非伤病）
  staminaLow: 32,     // 体力低于这个值才考虑换（普通换人）
  staminaVeryLow: 22, // 低于这个值，55 分钟前也换
  gkNever: true,      // 不换门将（除非受伤）
};

/**
 * 该不该换人：伤病优先，其次体力。开场 55 分钟前只在体力极低或受伤时换。
 * @param {{minute:number, stamina:number, subsMade:number, maxSubs?:number, injured?:boolean}} o
 * @returns {{sub:boolean, urgent:boolean, reason:string}}
 */
export function shouldSub(o) {
  const opt = o || {};
  const minute = Math.max(0, Number(opt.minute) || 0);
  const stamina = Math.max(0, Math.min(100, isFinite(opt.stamina) ? opt.stamina : 100));
  const made = Math.max(0, Number(opt.subsMade) || 0);
  const max = isFinite(opt.maxSubs) ? opt.maxSubs : SUBS.max;
  if (made >= max) return { sub: false, urgent: false, reason: '换人次数已用完' };
  if (opt.injured) return { sub: true, urgent: true, reason: '受伤必须换下' };
  if (stamina <= SUBS.staminaVeryLow) return { sub: true, urgent: true, reason: '体力极低（' + Math.round(stamina) + '）' };
  if (minute < SUBS.minuteMin) return { sub: false, urgent: false, reason: '时间太早（' + Math.round(minute) + "'）" };
  if (stamina <= SUBS.staminaLow) return { sub: true, urgent: false, reason: '体力偏低（' + Math.round(stamina) + '）' };
  return { sub: false, urgent: false, reason: '体力还行（' + Math.round(stamina) + '）' };
}

/**
 * 选谁下、谁上。
 * @param {object} o
 *   lineup: [{id, position, stamina, isGk, off}]
 *   bench:  [{id, position, ca, banned}]
 *   subsMade, maxSubs, minute
 * @returns {null | {offId, onId, reason, urgent}}
 */
export function pickSub(o) {
  const opt = o || {};
  const lineup = (opt.lineup || []).filter((p) => p && !p.off && (opt.allowGk || !p.isGk));
  if (!lineup.length) return null;
  // 最该下的：体力最低（伤病者最优先）
  const sorted = lineup.slice().sort((a, b) => {
    const ia = a.injured ? -100 : 0, ib = b.injured ? -100 : 0;
    return (ia + a.stamina) - (ib + b.stamina);
  });
  const out = sorted[0];
  const decision = shouldSub({ minute: opt.minute, stamina: out.stamina, subsMade: opt.subsMade, maxSubs: opt.maxSubs, injured: out.injured });
  if (!decision.sub) return null;
  const bench = (opt.bench || []).filter((p) => p && !p.banned && !p.used);
  if (!bench.length) return null;
  // 同位置优先（门将不换），其次能力最高
  const posOf = (p) => String(p.position || '').toUpperCase();
  const same = bench.filter((p) => posOf(p) === posOf(out));
  const pool = same.length ? same : bench;
  const on = pool.slice().sort((a, b) => (Number(b.ca) || 0) - (Number(a.ca) || 0))[0];
  return { offId: out.id, onId: on.id, reason: decision.reason, urgent: decision.urgent, samePosition: same.length > 0 };
}
