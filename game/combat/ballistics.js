// 枪械「功效」结算：距离衰减、穿透、流血、硬直、噪音、连发散热（heat）。
//
// 设计理念（见 docs/枪械功效设计.md）：
//   · 一把枪的"功效"不是单一伤害数字，而是 6 个可组合的维度：
//     射程衰减 / 穿透 / 致伤（流血）/ 停止力（硬直）/ 噪音 / 操控（散热）
//   · 全部参数写在 weapons.js 的武器定义里（数据与模型、逻辑都分离），
//     这个文件只负责"按数据算结果"，不依赖 three，可在 Node 里完整单测。
//   · 兼容旧数据：缺字段的武器按"无衰减、无穿透、无流血、无硬直、噪音 3.5"处理。
//
// 约定：
//   · 玩家与 NPC 用的是同一套函数（npcShoot 也走 rollHit），伤害规则不会两套；
//   · 穿透只穿"角色"，不穿墙（世界射线命中即终止）——墙后命中永远不成立；
//   · 流血是"施加者"负责计时的（game.js 里的 _bleeds），NPC 侧不需要新状态。

/** 默认功效参数（武器没写就用这些）。 */
export const DEFAULT_TRAITS = {
  falloffNear: 0.6,       // 射程的多少比例内保持全额伤害
  falloffMin: 0.55,       // 射程尽头的最小伤害倍率
  penetration: 0,         // 可额外穿透几个目标
  bleed: null,            // { chance, dps, dur }
  stagger: 0,             // 命中硬直（秒）
  noise: 3.5,             // 枪声"响度"（招僵尸半径相关）
  heatPerShot: 0.1,       // 每发累积的热量
  heatMax: 1,
  heatSpread: 1.2,        // 热量对扩散的放大系数（1.0 = 满热时扩散翻倍）
};

/** 距离衰减：near 比例内 100%，之后线性衰减到 falloffMin。 */
export function falloffMul(weapon, distance) {
  const near = clamp01(Number(weapon.falloffNear ?? DEFAULT_TRAITS.falloffNear));
  const minMul = clamp(Number(weapon.falloffMin ?? DEFAULT_TRAITS.falloffMin), 0.05, 1);
  const range = Math.max(1e-3, Number(weapon.range) || 100);
  const t = clamp(distance / range, 0, 1.6);
  if (t <= near) return 1;
  if (near >= 1) return 1;
  const k = (t - near) / (1 - near);
  return clamp(1 - (1 - minMul) * k, minMul * 0.8, 1);
}

/** 部位倍率（爆头/腿部），沿用项目的两个全局系数。 */
export function partMul(part, headMul = 2.1, limbMul = 0.72) {
  if (part === 'head') return headMul;
  if (part === 'legs') return limbMul;
  return 1;
}

/** 连发散热：扩散随热量放大。heat ∈ [0, heatMax]。 */
export function effectiveSpread(weapon, heat = 0) {
  const base = Number(weapon.spread) || 0;
  const k = Number(weapon.heatSpread ?? DEFAULT_TRAITS.heatSpread);
  const max = Math.max(0.0001, Number(weapon.heatMax ?? DEFAULT_TRAITS.heatMax));
  const h = clamp(heat / max, 0, 1);
  return base * (1 + k * h);
}

/**
 * 单次命中的伤害与附加效果（纯函数）。
 * @param {object} weapon 武器定义
 * @param {object} o { part, distance, rand, headMul, limbMul }
 * @returns {{damage:number, falloff:number, bleed:{dps:number,dur:number}|null, stagger:number}}
 */
export function rollHit(weapon, o = {}) {
  const rand = o.rand || Math.random;
  const fm = falloffMul(weapon, Number(o.distance) || 0);
  const pm = partMul(o.part, o.headMul, o.limbMul);
  const damage = (Number(weapon.damage) || 0) * fm * pm;
  let bleed = null;
  const b = weapon.bleed;
  if (b && Number(b.chance) > 0 && rand() < Number(b.chance)) {
    bleed = { dps: Number(b.dps) || 0, dur: Number(b.dur) || 0 };
  }
  return {
    damage: Math.round(damage * 10) / 10,
    falloff: Math.round(fm * 1000) / 1000,
    bleed,
    stagger: Number(weapon.stagger) || 0,
  };
}

/**
 * 一次射击的完整结算（含穿透）。
 * 每穿过一个目标，后续伤害乘 pierceMul；遇到墙体立即终止。
 *
 * @param {object} p
 * @param {object} p.world ColliderWorld
 * @param {Array} p.targets 角色数组（实现 raycast(ray)）
 * @param {object} p.ray THREE.Ray 复用实例
 * @param {{x,y,z}} p.origin
 * @param {{x,y,z}} p.dir 单位向量（调用方已加散布）
 * @param {object} p.weapon
 * @param {number} [p.maxRange]
 * @param {object} [p.opts] { ignoreId, headshotMultiplier, limbMultiplier, pierceDamageMul, rand }
 * @param {(id:string, hit:object) => void} [p.onHit] 兼容旧接口：逐命中回调
 * @returns {{hits:Array, blocked:boolean}}
 *   hits 按距离从近到远，元素 { target, part, distance, damage, bleed, stagger, layer }
 */
export function traceShot(p) {
  const { world, ray, origin, dir, weapon } = p;
  const opts = p.opts || {};
  const rand = opts.rand || Math.random;
  const headMul = opts.headshotMultiplier;
  const limbMul = opts.limbMultiplier;
  const pierceMul = Number.isFinite(opts.pierceDamageMul) ? opts.pierceDamageMul : 0.6;
  const maxRange = Math.min(Number(p.maxRange) || weapon.range || 100, Number(weapon.range) || 100);
  const layers = Math.max(0, Math.floor(Number(weapon.penetration) || 0));
  const targets = Array.isArray(p.targets) ? p.targets : [];
  const hits = [];
  const used = new Set();
  let blocked = false;

  // 逐层推进：每层重新做一次"最近命中"查询，排除已经打中的角色
  for (let layer = 0; layer <= layers; layer += 1) {
    const remaining = targets.filter((t) => t && !used.has(t.id || t));
    const r = resolveOne({ world, targets: remaining, ray, origin, dir, weapon, maxRange, opts });
    if (!r || r.hit === false) break;
    if (r.kind === 'world') { blocked = true; break; }
    const id = r.target && (r.target.id || r.target);
    if (id != null) used.add(id);
    const eff = rollHit(weapon, { part: r.part, distance: r.distance, rand, headMul, limbMul });
    const decay = Math.pow(pierceMul, layer);
    hits.push({
      target: r.target,
      part: r.part,
      distance: r.distance,
      point: r.point,
      layer,
      damage: Math.round(eff.damage * decay * 10) / 10,
      falloff: eff.falloff,
      bleed: eff.bleed,
      stagger: eff.stagger,
    });
    if (p.onHit) p.onHit(id, hits[hits.length - 1]);
    if (layer >= layers) break;
  }
  return { hits, blocked };
}

/** 内部：单层"最近命中"，与旧的 resolveRay 同语义（世界遮挡优先比较距离）。 */
function resolveOne({ world, targets, ray, origin, dir, weapon, maxRange, opts }) {
  const worldHit = world
    ? world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxRange)
    : null;
  let best = worldHit ? { kind: 'world', distance: worldHit.distance, point: worldHit, target: null, part: 'world' } : null;
  if (targets && targets.length) {
    if (ray && ray.origin && ray.direction) {
      ray.origin.set(origin.x, origin.y, origin.z);
      ray.direction.set(dir.x, dir.y, dir.z);
    }
    for (const t of targets) {
      if (!t || t.alive === false) continue;
      if (opts.ignoreId && t.id === opts.ignoreId) continue;
      const hit = t.raycast(ray);
      if (!hit) continue;
      if (hit.distance > maxRange) continue;
      if (best && hit.distance >= best.distance) continue;
      best = { kind: 'character', distance: hit.distance, point: hit.point, target: t, part: hit.part };
    }
  }
  return best || { hit: false };
}

/**
 * 连发散热模型：每次开枪加热、不射击时衰减。
 * 只影响扩散（effectiveSpread），不改伤害——"手感"层面的功效。
 */
export class HeatModel {
  constructor(def = {}) {
    this.perShot = Number(def.heatPerShot ?? DEFAULT_TRAITS.heatPerShot);
    this.max = Math.max(0.0001, Number(def.heatMax ?? DEFAULT_TRAITS.heatMax));
    this.value = 0;
  }

  add(shots = 1) {
    this.value = Math.min(this.max, this.value + this.perShot * shots);
    return this.value;
  }

  decay(dt, rate = 1.8) {
    this.value = Math.max(0, this.value - Math.max(0, dt) * rate * this.max * 0.5);
    return this.value;
  }

  clear() { this.value = 0; }
  get ratio() { return this.value / this.max; }
}

/** 给 UI/文档用的"功效画像"一句话（例如 "中距离 · 穿透 1 层 · 可致流血"）。 */
export function describeTrait(weapon) {
  if (!weapon) return '';
  const bits = [];
  if (weapon.type === 'melee') bits.push('近战');
  else {
    const r = Number(weapon.range) || 0;
    bits.push(r >= 150 ? '远距离' : r >= 80 ? '中距离' : '近距离');
    if ((weapon.pellets || 1) > 1) bits.push(`${weapon.pellets} 弹丸`);
  }
  if (Number(weapon.penetration) > 0) bits.push(`穿透 ${weapon.penetration} 层`);
  if (weapon.bleed && Number(weapon.bleed.chance) > 0) bits.push(`流血 ${Math.round(weapon.bleed.chance * 100)}%`);
  if (Number(weapon.stagger) >= 0.4) bits.push('强硬直');
  if (Number(weapon.noise) >= 5) bits.push('巨响');
  return bits.join(' · ');
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const clamp01 = (v) => clamp(v, 0, 1);

export default {
  DEFAULT_TRAITS, falloffMul, partMul, effectiveSpread, rollHit, traceShot, HeatModel, describeTrait,
};
