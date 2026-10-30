// NPC 配置：统一结构 + 默认值 + 数据校验。
// 硬性要求（任务书 6.4）：缺少任何可选字段都不能让游戏崩，所以这里对每个字段都夹紧；
// 类型不同行为不同，但配置结构完全一致，方便后续做成 JSON/编辑器驱动。

import { ZOMBIE_VARIANTS, isHomeSeason, baseSeasonMods } from './zombie-variants.js';

export const NPC_TYPES = ['zombie', 'friendly', 'hostile'];

export const NPC_TYPE_DEFAULTS = {
  zombie: {
    health: 90,
    movementSpeed: 1.35,
    chaseSpeed: 2.75,
    sightRange: 26,
    sightFov: 2.15,
    hearingRange: 24,
    attackRange: 1.85,
    attackDamage: 11,
    attackCooldown: 1.2,
    aggression: 0.95,
    lootTable: 'residential',
    color: 0x7d8b74,
  },
  friendly: {
    health: 110,
    movementSpeed: 2.1,
    chaseSpeed: 2.1,
    sightRange: 30,
    sightFov: 2.55,
    hearingRange: 20,
    attackRange: 1.7,
    attackDamage: 9,
    attackCooldown: 1.5,
    aggression: 0.35,
    lootTable: 'residential',
    color: 0x4a7aa8,
  },
  hostile: {
    health: 120,
    movementSpeed: 2.3,
    chaseSpeed: 4.1,
    sightRange: 34,
    sightFov: 2.5,
    hearingRange: 26,
    attackRange: 22,
    attackDamage: 14,
    attackCooldown: 0.85,
    aggression: 0.85,
    lootTable: 'military',
    color: 0xa8544a,
  },
};

const num = (v, d, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};

const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);

/**
 * 生成一个合法 NPC 配置。任何字段缺失/类型错误都会回到默认值。
 * @param {object} src
 * @param {number} index 用于生成稳定的默认 id
 */
export function makeNpcConfig(src = {}, index = 0) {
  const type = NPC_TYPES.includes(src.type) ? src.type : 'zombie';
  const base = NPC_TYPE_DEFAULTS[type];
  // 四季变种：只有僵尸有；未知 id 回落到普通僵尸
  const variantId = type === 'zombie' && ZOMBIE_VARIANTS[src.variant] ? src.variant : 'base';
  const variant = ZOMBIE_VARIANTS[variantId];
  const v = variant.stats || {};
  const pick = (k) => (Number.isFinite(v[k]) ? v[k] : base[k]);
  // 普通僵尸的季节修正（只改"默认值"，调用方显式传的数值仍然优先）
  const season = typeof src.season === 'string' ? src.season : null;
  const mods = type === 'zombie' && season ? baseSeasonMods(season, Number.isFinite(src.hour) ? src.hour : 12) : {};
  const healthScale = Number.isFinite(src.healthScale) ? src.healthScale : 1;
  const id = str(src.id, `npc_${type}_${index}`);
  const spawn = src.spawnPosition || {};
  const sx = num(spawn.x, num(src.x, 0, -10000, 10000), -10000, 10000);
  const sz = num(spawn.z, num(src.z, 0, -10000, 10000), -10000, 10000);

  const route = Array.isArray(src.patrolRoute)
    ? src.patrolRoute
      .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z)))
      .map((p) => ({ x: Number(p.x), z: Number(p.z) }))
    : [];

  return {
    id,
    type,
    factionId: src.factionId != null ? String(src.factionId) : null,
    appearanceId: src.appearanceId != null ? String(src.appearanceId) : null,
    modelPath: typeof src.modelPath === 'string' ? src.modelPath : null,
    spawnPosition: { x: sx, y: num(spawn.y, 0, 0, 100), z: sz },
    patrolRoute: route,
    health: num(src.health, pick('health') * (mods.healthMul || 1) * healthScale, 10, 5000),
    movementSpeed: num(src.movementSpeed, pick('movementSpeed') * (mods.moveMul || 1), 0.2, 20),
    chaseSpeed: num(src.chaseSpeed, pick('chaseSpeed') * (mods.chaseMul || 1), 0.2, 24),
    sightRange: num(src.sightRange, pick('sightRange'), 2, 200),
    sightFov: num(src.sightFov, base.sightFov, 0.3, Math.PI * 2),
    hearingRange: num(src.hearingRange, pick('hearingRange') * (mods.hearingMul || 1), 0, 200),
    attackRange: num(src.attackRange, pick('attackRange') || base.attackRange, 0.6, 200),
    attackDamage: num(src.attackDamage, pick('attackDamage'), 0, 500),
    attackCooldown: num(src.attackCooldown, pick('attackCooldown'), 0.1, 20),
    aggression: num(src.aggression, base.aggression, 0, 1),
    lootTable: str(src.lootTable, base.lootTable),
    // 内部字段（不由外部随意写）
    homeRadius: num(src.homeRadius, 34, 2, 400),
    name: str(src.name, type === 'zombie' ? variant.label : '幸存者'),
    weaponId: type === 'hostile' ? str(src.weaponId, 'w_pistol_9mm') : (type === 'friendly' ? (src.weaponId || null) : null),
    dialogueId: src.dialogueId ? String(src.dialogueId) : null,
    // 变种元数据（AI/外观/提示都读这里；非僵尸就是 base）
    variant: variantId,
    variantLabel: variant.label,
    variantSeason: variant.season || null,
    templateKey: variant.template || 'zombie',
    abilities: type === 'zombie' ? (variant.abilities || []).slice() : [],
    audioRate: Number.isFinite(variant.audioRate) ? variant.audioRate : 1,
    weakness: variant.weakness || null,
    season,
    variantHome: type === 'zombie' ? isHomeSeason(variantId, season || variant.season) : false,
  };
}

/** 配置合法性检查（供测试与编辑器用）。返回问题列表，空数组代表合法。 */
export function validateNpcConfig(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') return ['config 不是对象'];
  if (!cfg.id) problems.push('缺少 id');
  if (!NPC_TYPES.includes(cfg.type)) problems.push(`未知 type: ${cfg.type}`);
  if (!(cfg.health > 0)) problems.push('health 必须 > 0');
  if (!(cfg.movementSpeed > 0)) problems.push('movementSpeed 必须 > 0');
  if (!(cfg.attackRange > 0)) problems.push('attackRange 必须 > 0');
  if (cfg.variant && !ZOMBIE_VARIANTS[cfg.variant]) problems.push(`未知 variant: ${cfg.variant}`);
  if (cfg.abilities != null && !Array.isArray(cfg.abilities)) problems.push('abilities 必须是数组');
  if (cfg.sightFov <= 0 || cfg.sightFov > Math.PI * 2 + 1e-6) problems.push('sightFov 越界');
  if (!Array.isArray(cfg.patrolRoute)) problems.push('patrolRoute 必须是数组');
  if (!cfg.spawnPosition || !Number.isFinite(cfg.spawnPosition.x) || !Number.isFinite(cfg.spawnPosition.z)) problems.push('spawnPosition 非法');
  return problems;
}

/** 由阵营 + 位置批量生成一组巡逻路线（围绕中心的多边形）。 */
export function patrolLoop(cx, cz, radius, points = 4, phase = 0) {
  const out = [];
  for (let i = 0; i < points; i += 1) {
    const a = phase + (i / points) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius });
  }
  return out;
}

export default { NPC_TYPES, NPC_TYPE_DEFAULTS, makeNpcConfig, validateNpcConfig, patrolLoop };
