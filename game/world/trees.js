// 树木资产与摆放档案 —— 树木全部来自道具包「树木/OBJ」（Quaternius Ultimate Nature，CC0）。
// 这里是**唯一**的树木模型清单，被三处共用：
//   · world/layout.js  摆放：决定每棵树用哪个模型、树干碰撞多大（纯数据，Node 里可单测）
//   · world/build.js   实例化：按模型分桶做 InstancedMesh
//   · assets/manifest.js 预加载：把 OBJ/MTL 交给 AssetLoader 烘焙
// 之所以把"目标高度 / 树干半径"也写在这里：它们是**从 OBJ 实测**出来的（见下方注释），
// 摆放和渲染必须用同一组数字，否则树干碰撞会和看得见的树干对不上。
//
// 实测方法：读 OBJ 顶点 + MTL 材质名，筛出树干材质（Wood/White/Black）的三角形，
// 用边长采样求 0.3~1.4m 高度带内的水平最大半径，再按 fit 高度折算到世界米。

export const TREE_ASSET_DIR = 'assets/models/trees/';

/**
 * 模型表。键名就是世界里的"树种变体"，obj 是道具包里的文件名（不含扩展名）。
 *   fit    目标高度（米）：按模型自身高度等比缩放，保证同种树在游戏里高矮合理
 *   trunk  树干碰撞半径（米，对应 fit 高度下的实测值；实例缩放时线性乘 scale）
 *   species 树种：松 / 阔叶 / 白桦 / 柳（决定平衡与回退外观）
 */
export const TREE_MODELS = {
  // ── 松树（PineTree_1..5）：尖塔形，镇外林带的主体
  pine_1: { obj: 'PineTree_1', fit: 7.8, trunk: 0.60, species: 'pine' },
  pine_2: { obj: 'PineTree_2', fit: 9.8, trunk: 0.45, species: 'pine' },
  pine_3: { obj: 'PineTree_3', fit: 9.0, trunk: 0.55, species: 'pine' },
  pine_4: { obj: 'PineTree_4', fit: 9.2, trunk: 0.55, species: 'pine' },
  pine_5: { obj: 'PineTree_5', fit: 7.6, trunk: 0.52, species: 'pine' },

  // ── 常见阔叶树（CommonTree_1..5）：圆冠，镇内绿化的主要树种
  common_1: { obj: 'CommonTree_1', fit: 7.0, trunk: 0.28, species: 'common' },
  common_2: { obj: 'CommonTree_2', fit: 8.4, trunk: 0.32, species: 'common' },
  common_3: { obj: 'CommonTree_3', fit: 8.0, trunk: 0.24, species: 'common' },
  common_4: { obj: 'CommonTree_4', fit: 7.4, trunk: 0.28, species: 'common' },
  common_5: { obj: 'CommonTree_5', fit: 7.0, trunk: 0.36, species: 'common' },

  // ── 白桦（BirchTree）：白树干，适合成组点缀在镇里
  birch_1: { obj: 'BirchTree_1', fit: 8.8, trunk: 0.35, species: 'birch' },
  birch_2: { obj: 'BirchTree_2', fit: 9.6, trunk: 0.24, species: 'birch' },
  birch_4: { obj: 'BirchTree_4', fit: 8.8, trunk: 0.35, species: 'birch' },
  birch_5: { obj: 'BirchTree_5', fit: 10.6, trunk: 0.20, species: 'birch' },

  // ── 柳树（Willow）：枝条下垂，只放少量做变化
  willow_2: { obj: 'Willow_2', fit: 9.0, trunk: 0.62, species: 'willow' },
  willow_4: { obj: 'Willow_4', fit: 8.4, trunk: 0.50, species: 'willow' },

  // ── 枯树（僵尸末日气氛用；资源包里松树没有枯死变体）
  dead_common_1: { obj: 'CommonTree_Dead_1', fit: 6.4, trunk: 0.28, species: 'common' },
  dead_common_3: { obj: 'CommonTree_Dead_3', fit: 7.6, trunk: 0.24, species: 'common' },
  dead_common_5: { obj: 'CommonTree_Dead_5', fit: 6.2, trunk: 0.34, species: 'common' },
  dead_birch_2: { obj: 'BirchTree_Dead_2', fit: 7.0, trunk: 0.25, species: 'birch' },
  dead_willow_1: { obj: 'Willow_Dead_1', fit: 6.8, trunk: 0.40, species: 'willow' },
  dead_willow_4: { obj: 'Willow_Dead_4', fit: 7.0, trunk: 0.50, species: 'willow' },

  // ── 棕榈（PalmTree_1..4，华南/江南用；素材包里原本没接进来）
  // 尺寸为 OBJ 实测：原始高 4.47 / 2.91 / 3.93 / 3.47，干半径按 fit 折算。
  // 棕榈没有 _Autumn / _Snow 变体（`treeSeasonKey` 对没有季节后缀的模型原样返回）。
  palm_1: { obj: 'PalmTree_1', fit: 7.0, trunk: 0.31, species: 'palm' },
  palm_2: { obj: 'PalmTree_2', fit: 5.6, trunk: 0.48, species: 'palm' },
  palm_3: { obj: 'PalmTree_3', fit: 8.0, trunk: 0.21, species: 'palm' },
  palm_4: { obj: 'PalmTree_4', fit: 6.6, trunk: 0.23, species: 'palm' },
};

/** 树种 → 活树变体 / 枯树变体。没有枯死变体的树种在抽到"枯树"时会退化成活树。 */
export const TREE_SPECIES = {
  pine: {
    label: '松树',
    variants: ['pine_1', 'pine_2', 'pine_3', 'pine_4', 'pine_5'],
    dead: [],
  },
  common: {
    label: '阔叶树',
    variants: ['common_1', 'common_2', 'common_3', 'common_4', 'common_5'],
    dead: ['dead_common_1', 'dead_common_3', 'dead_common_5'],
  },
  birch: {
    label: '白桦',
    variants: ['birch_1', 'birch_2', 'birch_4', 'birch_5'],
    dead: ['dead_birch_2'],
  },
  willow: {
    label: '柳树',
    variants: ['willow_2', 'willow_4'],
    dead: ['dead_willow_1', 'dead_willow_4'],
  },
  palm: {
    label: '棕榈',
    variants: ['palm_1', 'palm_2', 'palm_3', 'palm_4'],
    dead: [],   // 棕榈没有枯死变体：华南地区枯树少见，抽到枯树时退回活树
  },
};

/**
 * 树种权重（活树，默认 = 温带混交，也是"不指定地区"时的行为）。
 * 棕榈**不在这里**：它只在 `TREE_REGIONS.south`（华南）里出现，默认地图保持原来的混交比例，
 * 所以老存档/老截图的树一棵都不会变。棕榈在地区表里的权重见 TREE_REGIONS。
 */
export const TREE_MIX = { pine: 0.42, common: 0.28, birch: 0.18, willow: 0.12 };

/** 整体枯树比例：末日废土里每隔几棵就有一棵枯的，比例太高会像枯林。 */
export const TREE_DEAD_CHANCE = 0.1;

/** 抽到枯树时各树种的比例（阔叶枯树最多、柳树枯枝最好看）。 */
const DEAD_MIX = { common: 0.5, willow: 0.3, birch: 0.2 };

export const TREE_MODEL_KEYS = Object.keys(TREE_MODELS);

/** 给定模型键 → 世界尺度下的树干碰撞半径（模型缺失时给一个保守值）。 */
export function treeTrunkRadius(model, scale = 1) {
  const m = TREE_MODELS[model];
  const r = m ? m.trunk : 0.3;
  return r * (Number.isFinite(scale) ? scale : 1);
}

/** 取树种（用于回退外观与统计）；未知模型按形体猜一个。 */
export function treeSpeciesOf(model) {
  return (TREE_MODELS[model] && TREE_MODELS[model].species) || 'common';
}

// ── 中国树种：以"几何家族"为模板，映射真实物种 ───────────────
// 素材包只有 松 / 阔叶 / 白桦 / 柳 / 棕榈 五种几何，但中国从寒温带到热带横跨多个气候带。
// 所以这里不是再造几何，而是把**同一套几何**按地区组合成真实树种：
//   华北 = 油松/侧柏 + 国槐/白蜡/毛白杨/银杏 + 榆树 + 垂柳
//   江南 = 马尾松/杉木 + 香樟/银杏/悬铃木 + 垂柳
//   华南 = 马尾松 + 榕树/香樟/木棉 + 棕榈 + 垂柳
//   东北 = 红松/樟子松 + 白桦 + 蒙古栎 + 旱柳
//   西南 = 云南松/华山松 + 香樟/银杏 + 白桦 + 垂柳
//   西北 = 油松/侧柏 + 胡杨/榆树/刺槐 + 旱柳
// 每个物种字段：
//   label      中文名（HUD/文档/调试用）
//   family     用哪套几何（TREE_SPECIES 的键）
//   variants   只从这个子集里抽（默认用整个家族的活树变体）
//   evergreen  常绿：秋天不换成橙叶（如香樟/榕树/松柏）
//   tropical   热带：秋冬都保持绿几何（如棕榈，没有 _Autumn/_Snow 模型）
//   scaleMul   体型系数（榕树更大、侧柏更小）
export const CN_SPECIES = {
  // ── 针叶（松/柏/杉）
  hong_song: { label: '红松', family: 'pine', variants: ['pine_1', 'pine_4'], evergreen: true, scaleMul: 1.12, note: '东北长白山系针阔混交林' },
  zhangzi_song: { label: '樟子松', family: 'pine', variants: ['pine_3', 'pine_5'], evergreen: true, scaleMul: 1.0, note: '东北/内蒙沙地' },
  you_song: { label: '油松', family: 'pine', variants: ['pine_2', 'pine_4'], evergreen: true, scaleMul: 1.0, note: '华北山地与城市行道' },
  ce_bai: { label: '侧柏', family: 'pine', variants: ['pine_3'], evergreen: true, scaleMul: 0.85, note: '华北/西北常绿针叶' },
  ma_wei_song: { label: '马尾松', family: 'pine', variants: ['pine_1', 'pine_5'], evergreen: true, scaleMul: 1.08, note: '江南/华南低山丘陵' },
  yun_nan_song: { label: '云南松', family: 'pine', variants: ['pine_2', 'pine_5'], evergreen: true, scaleMul: 1.15, note: '西南高原' },
  hua_shan_song: { label: '华山松', family: 'pine', variants: ['pine_1', 'pine_3'], evergreen: true, scaleMul: 1.1, note: '西南/秦岭山地' },
  shan_mu: { label: '杉木', family: 'pine', variants: ['pine_4'], evergreen: true, scaleMul: 1.2, note: '江南人工林（树形细高）' },

  // ── 阔叶（落叶）
  meng_gu_li: { label: '蒙古栎', family: 'common', variants: ['common_1', 'common_5'], scaleMul: 1.0, note: '东北次生林' },
  guo_huai: { label: '国槐', family: 'common', variants: ['common_2', 'common_4'], scaleMul: 1.0, note: '华北城市/村落常见' },
  bai_la: { label: '白蜡', family: 'common', variants: ['common_3', 'common_5'], scaleMul: 1.0, note: '华北行道树' },
  mao_bai_yang: { label: '毛白杨', family: 'common', variants: ['common_2', 'common_1'], scaleMul: 1.12, note: '华北平原防护林' },
  yin_xing: { label: '银杏', family: 'common', variants: ['common_4', 'common_2'], scaleMul: 1.05, note: '南北皆有的秋色树种（秋季金黄）' },
  xuan_ling_mu: { label: '悬铃木', family: 'common', variants: ['common_3', 'common_1'], scaleMul: 1.08, note: '江南/城市法桐' },
  yu_shu: { label: '榆树', family: 'common', variants: ['common_1', 'common_5'], scaleMul: 0.95, note: '北方村口/四旁树' },
  ci_huai: { label: '刺槐', family: 'common', variants: ['common_4', 'common_3'], scaleMul: 1.0, note: '西北/华北耐旱' },
  hu_yang: { label: '胡杨', family: 'common', variants: ['common_5', 'common_4'], scaleMul: 1.05, note: '西北荒漠河岸（秋季金黄）' },

  // ── 阔叶（常绿，南方）
  xiang_zhang: { label: '香樟', family: 'common', variants: ['common_2', 'common_5'], evergreen: true, scaleMul: 1.1, note: '江南/华南常绿阔叶' },
  rong_shu: { label: '榕树', family: 'common', variants: ['common_1', 'common_4'], evergreen: true, scaleMul: 1.25, note: '华南村口大榕树' },
  mu_mian: { label: '木棉', family: 'common', variants: ['common_3'], evergreen: true, scaleMul: 1.15, note: '华南季雨林' },

  // ── 白桦 / 柳 / 棕榈
  bai_hua: { label: '白桦', family: 'birch', variants: ['birch_1', 'birch_2', 'birch_4'], scaleMul: 1.0, note: '东北/西南高山' },
  han_liu: { label: '旱柳', family: 'willow', variants: ['willow_2'], scaleMul: 0.95, note: '北方河渠/村边' },
  chui_liu: { label: '垂柳', family: 'willow', variants: ['willow_2', 'willow_4'], scaleMul: 1.0, note: '全国水边' },
  zong_lv: { label: '棕榈', family: 'palm', variants: ['palm_1', 'palm_2', 'palm_3', 'palm_4'], evergreen: true, tropical: true, scaleMul: 1.0, note: '华南/江南园林' },
};

/**
 * 中国地区混交表。`species` 是「CN 物种 id → 权重」，权重只用于相对比例（不必凑 100）。
 * `temperate`（默认）不是中国地区，而是**原来的温带混交**：保持老地图/老存档的树完全不变。
 */
export const TREE_REGIONS = {
  temperate: { label: '温带混交（默认）', species: null, deadChance: TREE_DEAD_CHANCE },
  northeast: {
    label: '东北', deadChance: 0.14,
    species: { hong_song: 20, zhangzi_song: 8, bai_hua: 28, meng_gu_li: 18, yu_shu: 12, han_liu: 14 },
  },
  north: {
    label: '华北', deadChance: 0.12,
    species: { you_song: 20, ce_bai: 8, guo_huai: 14, bai_la: 10, mao_bai_yang: 12, yin_xing: 8, yu_shu: 12, chui_liu: 16 },
  },
  jiangnan: {
    label: '江南', deadChance: 0.08,
    species: { ma_wei_song: 14, shan_mu: 8, xiang_zhang: 20, yin_xing: 10, xuan_ling_mu: 12, yu_shu: 12, chui_liu: 24 },
  },
  south: {
    label: '华南', deadChance: 0.05,
    species: { ma_wei_song: 14, shan_mu: 6, rong_shu: 20, xiang_zhang: 16, zong_lv: 24, mu_mian: 8, chui_liu: 12 },
  },
  southwest: {
    label: '西南', deadChance: 0.1,
    species: { yun_nan_song: 18, hua_shan_song: 10, xiang_zhang: 16, yin_xing: 8, bai_hua: 12, yu_shu: 16, chui_liu: 20 },
  },
  northwest: {
    label: '西北', deadChance: 0.18,
    species: { you_song: 16, ce_bai: 10, hu_yang: 20, yu_shu: 14, ci_huai: 14, han_liu: 26 },
  },
};

export const TREE_REGION_IDS = Object.keys(TREE_REGIONS);

/** 取某个中国树种记录（未知返回 null）。 */
export function cnSpecies(id) {
  return CN_SPECIES[id] || null;
}

/** 树种中文名（未知返回空串）。 */
export function cnLabel(id) {
  const c = CN_SPECIES[id];
  return c ? c.label : '';
}

/** 中国树种在某个季节是否必须保持绿几何（常绿/热带）。返回 'green' 或 null（按默认季节几何）。 */
export function cnSeasonSkin(cnId, season) {
  const c = CN_SPECIES[cnId];
  if (!c) return null;
  if (c.tropical && (season === 'autumn' || season === 'winter')) return 'green';
  if (c.evergreen && season === 'autumn') return 'green';
  return null;
}

/** 地区 → 几何家族权重（文档/统计用；也是"这个地区会不会出现棕榈"的判据）。 */
export function regionFamilyMix(regionId) {
  const def = TREE_REGIONS[regionId];
  const out = {};
  if (!def || !def.species) return out;
  for (const [id, w] of Object.entries(def.species)) {
    const fam = CN_SPECIES[id] && CN_SPECIES[id].family;
    if (!fam) continue;
    out[fam] = (out[fam] || 0) + w;
  }
  const total = Object.values(out).reduce((s, v) => s + v, 0) || 1;
  for (const k of Object.keys(out)) out[k] /= total;
  return out;
}

/** 按权重表抽一个键（确定性：只消费一次 rng）。 */
function pickWeighted(rng, weights) {
  let total = 0;
  for (const v of Object.values(weights)) total += v;
  if (!(total > 0)) return Object.keys(weights)[0] || null;
  let r = rng() * total;
  for (const [k, v] of Object.entries(weights)) {
    r -= v;
    if (r <= 0) return k;
  }
  return Object.keys(weights)[Object.keys(weights).length - 1];
}

/** 默认（温带）混交：与旧版本完全一致，保证老地图/老存档的树一棵都不变。 */
function pickTemperate(rng) {
  if (rng() < TREE_DEAD_CHANCE) {
    let r = rng();
    for (const species of Object.keys(DEAD_MIX)) {
      if (r < DEAD_MIX[species]) {
        const pool = TREE_SPECIES[species].dead;
        if (pool.length) {
          const model = pool[Math.floor(rng() * pool.length) % pool.length];
          return { model, species, dead: true, cn: null };
        }
        break;
      }
      r -= DEAD_MIX[species];
    }
  }
  let r = rng();
  let species = 'pine';
  for (const key of Object.keys(TREE_MIX)) {
    if (r < TREE_MIX[key]) { species = key; break; }
    r -= TREE_MIX[key];
  }
  const pool = TREE_SPECIES[species].variants;
  const model = pool[Math.floor(rng() * pool.length) % pool.length];
  return { model, species, dead: false, cn: null };
}

/**
 * 抽一棵树。不给 `region`（或给 temperate）时是**旧行为**（温带混交、rng 消耗序列完全不变）；
 * 给中国地区时按该地区的 CN 物种权重抽，并把 `cn`（中国树种 id）带回给布局/渲染用。
 * @param {() => number} rng 确定性随机源
 * @param {{region?: string}} [opts]
 * @returns {{model:string, species:string, dead:boolean, cn:string|null}}
 */
export function pickTreeModel(rng, opts = {}) {
  const regionId = opts && opts.region;
  const region = regionId && regionId !== 'temperate' ? TREE_REGIONS[regionId] : null;
  if (!region || !region.species) return pickTemperate(rng);

  const deadChance = Number.isFinite(region.deadChance) ? region.deadChance : TREE_DEAD_CHANCE;
  if (rng() < deadChance) {
    // 枯树也按该地区的树种权重挑一个"有枯树变体"的家族；没有就落到温带枯树池
    const families = {};
    for (const [id, w] of Object.entries(region.species)) {
      const fam = CN_SPECIES[id] && CN_SPECIES[id].family;
      if (fam && TREE_SPECIES[fam].dead.length) families[fam] = (families[fam] || 0) + w;
    }
    const fam = pickWeighted(rng, families);
    if (fam) {
      const pool = TREE_SPECIES[fam].dead;
      const model = pool[Math.floor(rng() * pool.length) % pool.length];
      return { model, species: fam, dead: true, cn: null };
    }
  }

  const cnId = pickWeighted(rng, region.species);
  const rec = CN_SPECIES[cnId];
  const family = rec.family;
  const pool = (rec.variants && rec.variants.length) ? rec.variants : TREE_SPECIES[family].variants;
  const model = pool[Math.floor(rng() * pool.length) % pool.length];
  return { model, species: family, dead: false, cn: cnId };
}

/** 地区标签（HUD/文档用）。 */
export function regionLabel(regionId) {
  const def = TREE_REGIONS[regionId];
  return def ? def.label : TREE_REGIONS.temperate.label;
}

// ── 四季 ─────────────────────────────────────────────────────────────
// 道具包天然就给了四季：同一棵树有 `Family_N`（绿）/ `Family_Autumn_N`（秋）/ `Family_Snow_N`（冬），
// 枯树只有 `Family_Dead_Snow_N`（雪里的枯树）。所以"季节"不需要美术再造，只需要**换几何 + 换环境色**：
//   · 春 / 夏 = 绿几何（春天靠色调更嫩、环境更亮、再加上花丛/新绿来区分）
//   · 秋      = 秋色几何（Orange/LightOrange 材质）+ 暖色雾 + 偏黄的地面
//   · 冬      = 雪几何（多一层 Snow 材质）+ 雪地地面 + 冷色雾/天光
// 布局只记"植株"(TREE_MODELS 的绿键)，季节在渲染时才解析成具体 OBJ，这样同一张地图四季通用，
// 存档也只需要记一个季节名，不用把 300 棵树的模型都存下来。
// 常绿/热带树种（中国树种表的 evergreen / tropical）秋天不换橙叶，棕榈秋冬都保持绿几何。
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const SEASON_LABELS = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
export const DEFAULT_SEASON = 'summer';

/** 模型键 → 该季节对应的几何集合：'green' | 'autumn' | 'winter'。 */
export function treeSeasonSkin(season) {
  if (season === 'autumn') return 'autumn';
  if (season === 'winter') return 'winter';
  return 'green';
}

const OBJ_NAME_RE = /^(PineTree|CommonTree|BirchTree|Willow)(_Dead)?_(\d+)$/;

/**
 * 模型键 + 季节 → 道具包里的 OBJ 名（不认识的名字原样返回）。
 * `cn` 是中国树种 id：常绿/热带树在秋天（甚至冬天）仍用绿几何。
 */
export function treeObjFor(season, model, cn = null) {
  const def = TREE_MODELS[model];
  if (!def) return null;
  const m = OBJ_NAME_RE.exec(def.obj);
  if (!m) return def.obj;
  if (cnSeasonSkin(cn, season) === 'green') return def.obj;
  const family = m[1];
  const dead = !!m[2];
  const variant = m[3];
  if (season === 'autumn') return dead ? def.obj : `${family}_Autumn_${variant}`;
  if (season === 'winter') return dead ? `${family}_Dead_Snow_${variant}` : `${family}_Snow_${variant}`;
  return def.obj;
}

/**
 * 模型键 + 季节 → 资产键。绿（春夏）就是原键；秋/冬加后缀，枯树的秋天复用绿几何；
 * 常绿树（cn）的秋天返回原键；没有季节变体的家族（棕榈）永远返回原键。
 */
export function treeSeasonKey(model, season, cn = null) {
  if (season !== 'autumn' && season !== 'winter') return model;
  const def = TREE_MODELS[model];
  if (!def) return model;
  if (cnSeasonSkin(cn, season) === 'green') return model;
  const m = OBJ_NAME_RE.exec(def.obj);
  if (!m) return model;                       // 棕榈：素材包里没有季节几何
  const dead = !!m[2];
  if (season === 'autumn' && dead) return model;
  return `${model}@${season}`;
}

/** 某个季节需要额外加载的资产键（不含绿几何；枯树的秋色复用绿几何，所以不在列表里）。 */
export function seasonExtraModelKeys(season) {
  return TREE_MODEL_KEYS.map((k) => treeSeasonKey(k, season)).filter((k) => k.includes('@'));
}

export default {
  TREE_MODELS, TREE_SPECIES, TREE_MIX, TREE_DEAD_CHANCE, TREE_MODEL_KEYS,
  pickTreeModel, treeTrunkRadius, treeSpeciesOf,
  CN_SPECIES, TREE_REGIONS, TREE_REGION_IDS, cnSpecies, cnLabel, cnSeasonSkin, regionFamilyMix, regionLabel,
  SEASONS, SEASON_LABELS, DEFAULT_SEASON, treeSeasonSkin, treeObjFor, treeSeasonKey, seasonExtraModelKeys,
};


