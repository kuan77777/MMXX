// FW3D · 场景侧的外观取用助手
// 统一入口：任何场景要建球员模型时都走这里，保证「同一球员在任何场景是同一张脸」。
//  · 有真实球员记录（FW.state.players[id]）→ 用记录里的 id/位置/年龄，并叠加 real-likeness 覆盖
//  · 没有记录（记者、路人、测试模型）→ 用调用方给的稳定 pseudoId（不要用随机数，否则每次进场景都换脸）
import { appearanceFor } from './appearance.js';
import { likenessOf } from './real-likeness.js';

/**
 * @param {object|null} record FW.state.players 里的球员对象（可为 null）
 * @param {object} kit { jersey, shorts, accent, boot, socks, number, gk, position }
 * @param {string} fallbackId 稳定 pseudoId（例如 'PRESS-1'、'BENCH-3'）
 */
export function playerAppearance(record, kit = {}, fallbackId = 'anonymous') {
  const rec = record && record.id ? record : { id: fallbackId };
  const id = String(rec.id || fallbackId);
  const merged = Object.assign({}, rec, {
    id,
    position: rec.position || kit.position || null,
    age: rec.age || null,
    number: kit.number != null ? kit.number : rec.number,
  });
  return appearanceFor(merged, {
    overrides: likenessOf(merged),
    kit: {
      jersey: kit.jersey, shorts: kit.shorts, accent: kit.accent,
      boot: kit.boot, socks: kit.socks,
      number: kit.number != null ? kit.number : (rec.number != null ? rec.number : null),
      gk: !!kit.gk || String(rec.position || '').toUpperCase() === 'GK',
    },
  });
}

export default { playerAppearance };
