// 命中判定：射线（hitscan）方案。世界遮挡与角色命中盒一起比较"谁更近"，
// 因此"隔着墙开枪"永远不会命中墙后的目标。后续要改成实体子弹，只需替换 resolveShot 的射线推进方式。
//
// 这里不 import three，只用 ColliderWorld 的纯数学接口 + 角色的 raycast(ray) 接口，
// 角色的 raycast 需要 THREE.Ray —— 为了保持本模块可单测，改成调用方传入已构造好的 ray 对象工厂。

import { WEAPONS, fireInterval } from './weapons.js';

/**
 * 对单个弹丸做一次射线结算。
 * @param {object} p
 * @param {object} p.world ColliderWorld
 * @param {Array} p.targets 角色数组（需实现 raycast(ray) 与 takeDamage）
 * @param {object} p.ray THREE.Ray（复用同一个实例，避免每帧 new）
 * @param {THREE.Vector3} p.origin
 * @param {THREE.Vector3} p.dir 单位向量
 * @param {object} p.weapon 武器定义
 * @param {number} p.maxRange
 * @param {object} p.opts { ignoreId, headshotMultiplier, limbMultiplier, tag }
 * @returns {{hit:boolean, kind:'world'|'character'|null, part:string, distance:number, point:object|null, target:object|null, damage:number}}
 */
export function resolveRay(p) {
  const { world, targets, ray, origin, dir, weapon, maxRange } = p;
  const opts = p.opts || {};
  const range = Math.min(maxRange || weapon.range || 100, weapon.range || 100);
  const hm = Number.isFinite(opts.headshotMultiplier) ? opts.headshotMultiplier : 2.1;
  const lm = Number.isFinite(opts.limbMultiplier) ? opts.limbMultiplier : 0.72;

  // 世界遮挡
  const worldHit = world
    ? world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, range)
    : null;
  let best = worldHit
    ? { kind: 'world', distance: worldHit.distance, point: worldHit, target: null, part: 'world', tag: worldHit.tag }
    : null;

  // 角色命中盒
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
      if (hit.distance > range) continue;
      if (best && hit.distance >= best.distance) continue;
      best = { kind: 'character', distance: hit.distance, point: hit.point, target: t, part: hit.part, tag: 'character' };
    }
  }

  if (!best) return { hit: false, kind: null, part: null, distance: 0, point: null, target: null, damage: 0 };

  let damage = weapon.damage || 0;
  if (best.kind === 'character') {
    if (best.part === 'head') damage *= hm;
    else if (best.part === 'legs') damage *= lm;
  } else {
    damage = 0; // 打在墙上不掉血
  }
  return {
    hit: true,
    kind: best.kind,
    part: best.part,
    distance: best.distance,
    point: best.point,
    target: best.target,
    damage: Math.round(damage * 10) / 10,
    tag: best.tag,
  };
}

/** 射线方向加散布（锥形）。纯数字实现，不依赖 three，方便单测。 */
export function spreadDir(dir, spread, rand = Math.random) {
  if (!spread) return { x: dir.x, y: dir.y, z: dir.z };
  // 与 dir 正交的两个基向量
  let ux = -dir.z, uy = 0, uz = dir.x;
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; }
  else { ux /= ul; uy /= ul; uz /= ul; }
  const vx = dir.y * uz - dir.z * uy;
  const vy = dir.z * ux - dir.x * uz;
  const vz = dir.x * uy - dir.y * ux;
  const a = (rand() * 2 - 1) * spread;
  const b = (rand() * 2 - 1) * spread;
  const nx = dir.x + ux * a + vx * b;
  const ny = dir.y + uy * a + vy * b;
  const nz = dir.z + uz * a + vz * b;
  const n = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / n, y: ny / n, z: nz / n };
}

/**
 * 一次开火（可能多发霰弹）：返回所有弹丸的结算结果。
 * @param {object} p 同 resolveRay，另加 p.rand
 */
export function resolveShot(p) {
  const results = [];
  const weapon = p.weapon;
  const pellets = Math.max(1, weapon.pellets || 1);
  const rand = p.rand || Math.random;
  for (let i = 0; i < pellets; i += 1) {
    const d = spreadDir(p.dir, weapon.spread, rand);
    results.push(resolveRay(Object.assign({}, p, { dir: d })));
  }
  return results;
}

/** 近战判定：一条朝前的短射线 + 扇形放宽（用 3 条射线近似，避免"贴着敌人砍不中"）。 */
export function resolveMelee(p) {
  const out = [];
  const spread = 0.16;
  const dirs = [0, spread, -spread];
  for (const off of dirs) {
    const d = p.tmpDir || { x: 0, y: 0, z: 0 };
    // 绕 Y 轴旋转一点
    const cs = Math.cos(off), sn = Math.sin(off);
    d.x = p.dir.x * cs - p.dir.z * sn;
    d.y = p.dir.y;
    d.z = p.dir.x * sn + p.dir.z * cs;
    out.push(resolveRay(Object.assign({}, p, { dir: d, maxRange: p.weapon.range })));
  }
  // 取最近的角色命中；没有角色命中时返回世界命中（用来播"打在墙上"的音效）
  let bestChar = null;
  let bestWorld = null;
  for (const r of out) {
    if (r.kind === 'character' && (!bestChar || r.distance < bestChar.distance)) bestChar = r;
    if (r.kind === 'world' && (!bestWorld || r.distance < bestWorld.distance)) bestWorld = r;
  }
  return bestChar || bestWorld || out[0];
}

export { WEAPONS, fireInterval };
export default { resolveRay, resolveShot, resolveMelee, spreadDir };
