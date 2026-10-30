// 四季感染者变种：**纯数据 + 纯函数**（零 THREE 依赖），Node 里可直接单测。
//
// 设计稿见 docs/ZOMBIE-SEASONS.md。这里只回答四个问题：
//   1) 每个季节的"当季变种"是谁；
//   2) 新刷出来的僵尸该抽到哪个变种（含换季过渡：新季爬升、旧季残党消退）；
//   3) 普通僵尸要乘哪些季节系数；
//   4) 变种离开本季/本温度后弱多少（"主场优势"）。
// 外形（调色板/挂件/身高）与能力（伏击/孢子云/热浪/嚎叫/冰壳…）分别在
// characters/zombie-look.js 与 ai/zombie-abilities.js 里，本文件不碰渲染、不碰 AI 状态机。

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/** 季节 → 当季变种 id。 */
export const SEASON_VARIANT = {
  spring: 'spore',
  summer: 'thirst',
  autumn: 'howler',
  winter: 'frost',
};

/** 季节 → 上一季（换季时用来留"残党"）。 */
export const PREV_SEASON = {
  spring: 'winter',
  summer: 'spring',
  autumn: 'summer',
  winter: 'autumn',
};

/**
 * 变种表。stats 为 null 表示"用 npc-config 的普通僵尸默认值"。
 * 所有 stats 都会经过 npc-config 的夹紧函数，所以这里写的是**目标值**，不是最终值。
 */
export const ZOMBIE_VARIANTS = {
  base: {
    id: 'base', label: '感染者', season: null,
    template: 'zombie', palette: null, accessories: null, targetHeight: 1.78,
    audioRate: 1, abilities: [], weakness: null,
    stats: null,
  },
  spore: {
    id: 'spore', label: '孢子行者', season: 'spring',
    template: 'zombie_spring', palette: 'spring', accessories: 'spores', targetHeight: 1.72,
    audioRate: 1.15, abilities: ['ambush', 'sporeCloud'],
    weakness: '孢子怕风与雨；它扎根时近战可以打断',
    stats: {
      health: 78, movementSpeed: 1.10, chaseSpeed: 2.30,
      attackDamage: 9, attackCooldown: 1.30,
      sightRange: 22, hearingRange: 30,
    },
  },
  thirst: {
    id: 'thirst', label: '焦渴者', season: 'summer',
    template: 'zombie_summer', palette: 'summer', accessories: null, targetHeight: 1.75,
    audioRate: 1.05, abilities: ['heatAura', 'lunge'],
    weakness: '雨/室内让热浪失效；三连扑结束有 0.8 秒硬直',
    stats: {
      health: 72, movementSpeed: 1.50, chaseSpeed: 3.20,
      attackDamage: 12, attackCooldown: 0.90,
      sightRange: 30, hearingRange: 24,
    },
  },
  howler: {
    id: 'howler', label: '嚎叫者', season: 'autumn',
    template: 'zombie_autumn', palette: 'autumn', accessories: 'mushroom', targetHeight: 1.80,
    audioRate: 0.95, abilities: ['howl', 'pack'],
    weakness: '单独时最弱；嚎叫的 1.2 秒定身是爆头窗口',
    stats: {
      health: 112, movementSpeed: 1.20, chaseSpeed: 2.60,
      attackDamage: 10, attackCooldown: 1.15,
      sightRange: 26, hearingRange: 32,
    },
  },
  frost: {
    id: 'frost', label: '冻尸', season: 'winter',
    template: 'zombie_winter', palette: 'winter', accessories: 'ice', targetHeight: 1.86,
    audioRate: 0.85, abilities: ['iceArmor', 'frostTouch'],
    weakness: '最慢；爆头不吃冰壳减伤；车撞直接碎壳；离开冬天会变脆',
    stats: {
      health: 145, movementSpeed: 1.00, chaseSpeed: 2.20,
      attackDamage: 16, attackCooldown: 1.60,
      sightRange: 24, hearingRange: 24,
    },
  },
};

/** 变种 id 列表（不含 base）。 */
export const VARIANT_IDS = Object.keys(ZOMBIE_VARIANTS).filter((id) => id !== 'base');

/** 变种 → 角色模板 key。 */
export const VARIANT_TEMPLATE = Object.fromEntries(
  Object.entries(ZOMBIE_VARIANTS).map(([id, v]) => [id, v.template]),
);

/**
 * 四季僵尸的模型清单（给 CharacterFactory 用）。
 * 独立放在这里而不是写进 assets/manifest.js：四个变种共用同一个 FBX，只是调色板/挂件/身高不同，
 * 清单与变种数据放一起更不容易两边改漏；game.js 会把它和 CHARACTER_MODELS 合并。
 */
export const ZOMBIE_VARIANT_MODELS = Object.fromEntries(
  VARIANT_IDS.map((id) => {
    const v = ZOMBIE_VARIANTS[id];
    return [v.template, {
      url: 'assets/characters/zombie.fbx',
      kind: 'zombie',
      targetHeight: v.targetHeight,
      palette: v.palette,
      accessories: v.accessories,
      license: 'CC0-1.0 (Quaternius)',
    }];
  }),
);

/** 变种 → 模型 key（缺模板时回落到普通僵尸）。 */
export function templateForVariant(variantId) {
  const def = variantDef(variantId);
  return def.template || 'zombie';
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function isVariantId(id) { return !!ZOMBIE_VARIANTS[id]; }

export function variantDef(id) { return ZOMBIE_VARIANTS[id] || ZOMBIE_VARIANTS.base; }

/** 当季变种 id（未知季节回落到 base）。 */
export function variantForSeason(season) { return SEASON_VARIANT[season] || 'base'; }

/** 上一季变种 id（用于"残党"）。 */
export function previousVariantForSeason(season) {
  const prev = PREV_SEASON[season];
  return prev ? variantForSeason(prev) : 'base';
}

/** 变种是否在自己的季节。base 永远算"本季"。 */
export function isHomeSeason(variantId, season) {
  const def = variantDef(variantId);
  return !def.season || def.season === season;
}

/**
 * 换季过渡进度 0..1：dayInSeason 从 1 开始（第 1 天 + 当天经过的比例）。
 * 第一个游戏日的 85% 走完过渡 —— 换季不会"啪"一下全变，而是旧季残党慢慢退场。
 */
export function transitionProgress(dayInSeason) {
  const d = Number.isFinite(dayInSeason) ? dayInSeason : 1;
  return clamp01((d - 1) / 0.85);
}

/**
 * 刷怪权重（百分比，总和 100）：
 *   当季变种 8%→32%（爬升），上季残党 20%→0%（消退），其余是普通僵尸。
 * 为什么当季不是从 0 开始：换季那一刻如果一只新变种都没有，玩家会觉得"什么都没变"。
 */
export function spawnWeights(season, dayInSeason) {
  const t = transitionProgress(dayInSeason);
  const current = 8 + 24 * t;
  const previous = 20 * (1 - t);
  const base = Math.max(0, 100 - current - previous);
  return {
    base,
    current,
    previous,
    currentId: variantForSeason(season),
    previousId: previousVariantForSeason(season),
    t,
  };
}

/**
 * 抽一个变种 id。
 * @param {number} unit 0..1 的确定性随机（调用方用 id 哈希，避免打乱 director 的随机序列）
 * @param {string} season 当前季节
 * @param {number} dayInSeason 当前是季节里的第几天（小数）
 */
export function pickVariantId(unit, season, dayInSeason) {
  const w = spawnWeights(season, dayInSeason);
  const r = clamp01(unit) * 100;
  if (r < w.current) return w.currentId;
  if (r < w.current + w.previous) return w.previousId;
  return 'base';
}

/**
 * 普通僵尸的季节修正（乘数）。全部只会乘到 npc-config 的合法区间里（测试会拦）。
 * @param {string} season
 * @param {number} hour 0..24（夏天空腹更躁：正午加速、夜里减速）
 */
export function baseSeasonMods(season, hour = 12) {
  const h = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12;
  switch (season) {
    case 'spring':
      return { hearingMul: 1.10, note: '潮气传声：听觉 +10%' };
    case 'summer':
      if (h >= 10 && h < 16) return { chaseMul: 1.08, note: '正午躁动：追击 +8%' };
      if (h >= 20 || h < 6) return { chaseMul: 0.92, note: '夜里蔫了：追击 -8%' };
      return {};
    case 'autumn':
      return { hearingMul: 1.15, note: '落叶惊动：听觉 +15%' };
    case 'winter':
      return { moveMul: 0.92, healthMul: 1.12, note: '冻硬了：更慢、更耐打' };
    default:
      return {};
  }
}

/**
 * "主场优势"：变种离开本季/遇到高温时的能力强度与移速修正。
 * 返回值字段都是**绝对数量或倍率**，AI 直接读，不再二次推断。
 */
export function variantPower(variantId, season, tempC = 0) {
  const def = variantDef(variantId);
  const home = isHomeSeason(variantId, season);
  const temp = Number.isFinite(tempC) ? tempC : 0;
  const out = {
    home,
    sporeRadius: 0, sporeDuration: 0, sporeDebuff: false,
    heatAura: false, heatRange: 3.5,
    summonCount: 0,
    armorMul: 1, armorHp: 40, iceTrail: false,
    chaseMul: 1, moveMul: 1,
  };
  switch (def.id) {
    case 'spore':
      // 风/雨在 AI 里再乘；这里只给"在本季"的基准
      out.sporeRadius = home ? 3.0 : 1.2;
      out.sporeDuration = home ? 6 : 3;
      out.sporeDebuff = home;
      break;
    case 'thirst':
      out.heatAura = home;
      out.chaseMul = home ? 1 : 0.85;
      break;
    case 'howler':
      out.summonCount = home ? 2 : 1;
      break;
    case 'frost':
      // 温度 > 8°C：冰壳减半（离开冬天的残党会变脆）
      out.armorMul = temp > 8 ? 0.90 : 0.80;
      out.armorHp = temp > 8 ? 22 : 40;
      out.iceTrail = temp <= 8;
      break;
    default:
      break;
  }
  return out;
}

/** 给 HUD/提示用的一句话。 */
export function variantHint(variantId) {
  const def = variantDef(variantId);
  if (!def.weakness) return def.label;
  return `${def.label}：${def.weakness}`;
}

/** 稳定哈希 → 0..1（同一个 id + 盐永远同一个值，不消耗 rng）。 */
export function hashUnit(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export default {
  SEASONS, SEASON_VARIANT, PREV_SEASON, ZOMBIE_VARIANTS, VARIANT_IDS, VARIANT_TEMPLATE,
  ZOMBIE_VARIANT_MODELS, templateForVariant,
  isVariantId, variantDef, variantForSeason, previousVariantForSeason, isHomeSeason,
  transitionProgress, spawnWeights, pickVariantId, baseSeasonMods, variantPower, variantHint, hashUnit,
};
