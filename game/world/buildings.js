// 建筑资产与体型档案 —— 全部来自道具包「建筑/Textured Models/Finished Textured Buildings/OBJ」
// （Quaternius Ultimate Textured Buildings，CC0 1.0，见 ASSET_CATALOG.md）。
//
// 这里是**唯一**的建筑模型清单，被三处共用：
//   · world/layout.js     摆放：决定每栋楼用哪个模型、多大、门开在哪（纯数据，Node 里可单测）
//   · world/building-mesh.js 实例化：顶点色（调色板）+ 门洞切割 + 内外两遍渲染
//   · assets/manifest.js  预加载：把 OBJ 交给 AssetLoader 烘焙
//
// 为什么这些数字是"实测"而不是猜的：道具包里的房子是**纯色板贴图**（32×32 的 4×4 调色板），
// 每张面靠 UV 指向调色板里的一格，所以颜色完全等价于"每个三角面一个纯色"。实测：
//   1) 用射线从外面打四个立面，反查 UV → 调色板格子，得到立面像素图；
//   2) 三角面 UV 的三个角都落在同一格（26 个模型 × 0 个跨格面），所以按面取色与贴图逐像素一致；
//   3) 门洞位置 = 砖基座以上、只有门色出现的连续列（见 door.u / door.w / door.h）。
// 于是游戏里不需要任何 PNG 贴图，顶点色即可还原外观，且能和程序化几何合批。

export const BUILDING_ASSET_DIR = 'assets/models/buildings/';

/**
 * 调色板（道具包 Textures/Texture_*.png 的 4×4 格，逐格取色，行优先）。
 * 同一套几何换调色板 = 换整栋楼的砖色/窗框色，这是道具包本来的用法。
 */
export const BUILDING_PALETTES = {
  brick: ['#834a34', '#a37b73', '#a5a097', '#5f453a', '#86533d', '#664630', '#494949', '#86533d', '#5f453a', '#000000', '#ed1c24', '#000000', '#c9c9c9', '#748a9b', '#664630', '#ed1c24'],
  grey: ['#8b8b8b', '#9ea3a1', '#a5a097', '#5f5b5c', '#86533d', '#664630', '#494949', '#86533d', '#5f5b5c', '#000000', '#ed1c24', '#000000', '#c9c9c9', '#748a9b', '#664630', '#ed1c24'],
  light: ['#a5a5a5', '#d4d4d4', '#b8b2b0', '#92877f', '#888176', '#595b6d', '#494949', '#888176', '#92877f', '#000000', '#ed1c24', '#000000', '#c9c9c9', '#748a9b', '#595b6d', '#ed1c24'],
  dark: ['#423f39', '#5c595c', '#a5a097', '#454643', '#636363', '#5c6658', '#494949', '#636363', '#454643', '#000000', '#ed1c24', '#000000', '#c9c9c9', '#748a9b', '#5c6658', '#ed1c24'],
  green: ['#5f7f76', '#71978c', '#9da580', '#4a5f5e', '#86533d', '#664630', '#494949', '#86533d', '#405352', '#000000', '#ed1c24', '#000000', '#c9c9c9', '#748a9b', '#664630', '#ed1c24'],
  blue: ['#586683', '#757e9b', '#a5a097', '#554c5f', '#86533d', '#664630', '#494949', '#86533d', '#554c5f', '#000000', '#ed1c24', '#000000', '#c9c9c9', '#748a9b', '#664630', '#ed1c24'],
  darkblue: ['#242424', '#3f3f3f', '#233d53', '#1f313b', '#272e35', '#4e4e4e', '#494949', '#2e2c30', '#1f313b', '#000000', '#ed1c24', '#000000', '#272e35', '#748a9b', '#664630', '#ed1c24'],
  yellow: ['#837c6c', '#9b968e', '#a5a097', '#5f553f', '#86533d', '#664630', '#494949', '#86533d', '#5f553f', '#000000', '#ed1c24', '#000000', '#c9c9c9', '#748a9b', '#664630', '#ed1c24'],
};

/**
 * 模型表。键名是游戏里的建筑变体，obj 是道具包里的文件名（不含扩展名）。
 *   size  = 模型包围盒尺寸（模型单位）
 *   ys    = 竖直压缩系数。道具包是"沿街拼接的街屋"，两层的房子按人体比例会是 ~3.7m/层，
 *           放进 340m 的镇子里显得像塔；压 12% 后层高回到 3m 左右，横向比例不受影响。
 *   door  = 正面（+Z）上那扇门的实测参数：u 是门中心相对模型中心的水平偏移，
 *           w/h 是门洞宽高。切割门洞时用同一组数字，保证"看到的门"和"能走进去的洞"是同一个。
 *   facades = 四面里哪一面做了细节（本包全部是 +Z），其余三面是砖墙 —— 摆放时把 +Z 转向街道。
 */
export const BUILDING_MODELS = {
  // ── 一层小房子：工具棚 / 小屋 / 报亭
  b_1story: { obj: '1Story', size: { w: 2.154, h: 1.672, d: 2.175 }, ys: 0.94, door: { u: 0.009, w: 0.592, h: 0.967 } },
  b_1story_gable: { obj: '1Story_GableRoof', size: { w: 2.105, h: 2.025, d: 2.380 }, ys: 0.9, door: { u: 0.009, w: 0.599, h: 1.327 } },
  b_1story_round: { obj: '1Story_RoundRoof', size: { w: 2.087, h: 2.383, d: 2.126 }, ys: 0.9, door: { u: 0.022, w: 0.412, h: 0.849 } },
  b_1story_sign: { obj: '1Story_Sign', size: { w: 2.154, h: 1.794, d: 2.154 }, ys: 0.94, door: { u: 0.015, w: 0.413, h: 0.859 } },

  // ── 两层住宅：民居 / 公寓
  b_2story: { obj: '2Story', size: { w: 2.159, h: 2.745, d: 2.532 }, ys: 0.86, door: { u: 0, w: 0.431, h: 1.164 } },
  b_2story_balcony: { obj: '2Story_Balcony', size: { w: 2.159, h: 2.944, d: 2.532 }, ys: 0.85, door: { u: 0.009, w: 0.521, h: 1.164 } },
  b_2story_columns: { obj: '2Story_Columns', size: { w: 2.159, h: 2.769, d: 2.489 }, ys: 0.86, door: { u: 0.009, w: 0.592, h: 0.992 } },
  b_2story_sign: { obj: '2Story_Sign', size: { w: 2.154, h: 2.757, d: 2.154 }, ys: 0.86, door: { u: 0.002, w: 0.412, h: 1.260 } },

  // ── 宽店面 / 仓库：门面宽，进深浅（道具包本来就是沿街拼接的"街屋"）
  b_2story_wide: { obj: '2Story_Wide', size: { w: 3.825, h: 2.748, d: 2.255 }, ys: 0.88, door: { u: 0.016, w: 0.796, h: 1.398 } },
  // 双门面：模型有两扇门（±0.786），游戏只开 +X 那扇，另一扇保留成"关着的门"
  b_wide_2doors: { obj: '2Story_Wide_2Doors', size: { w: 6.828, h: 2.748, d: 2.255 }, ys: 0.9, door: { u: 0.786, w: 0.898, h: 1.569 } },
  b_tower_2doors: { obj: '4Story_Wide_2Doors', size: { w: 6.828, h: 5.151, d: 2.696 }, ys: 0.82, door: { u: 0.786, w: 0.898, h: 1.050 } },
};

/** 建筑类型 → 候选模型与目标宽度（米）。宽度定了，高度/进深按模型比例自动得到。 */
export const BUILDING_TYPE_POOLS = {
  house: [
    { key: 'b_1story', width: 5.6 },
    { key: 'b_1story_gable', width: 5.4 },
    { key: 'b_2story', width: 5.8 },
    { key: 'b_2story_balcony', width: 6.0 },
  ],
  apartment: [
    { key: 'b_2story_balcony', width: 6.6 },
    { key: 'b_2story', width: 6.4 },
    { key: 'b_2story_columns', width: 6.6 },
  ],
  shop: [
    { key: 'b_1story_sign', width: 6.2 },
    { key: 'b_2story_sign', width: 6.2 },
    { key: 'b_2story_wide', width: 8.0 },
    { key: 'b_2story_columns', width: 6.6 },
  ],
  office: [
    { key: 'b_2story_wide', width: 8.8 },
    { key: 'b_2story_sign', width: 6.6 },
    { key: 'b_2story_columns', width: 7.0 },
  ],
  warehouse: [
    { key: 'b_wide_2doors', width: 12.0 },
    { key: 'b_2story_wide', width: 10.0 },
    { key: 'b_tower_2doors', width: 11.0 },
  ],
  factory: [
    { key: 'b_tower_2doors', width: 13.0 },
    { key: 'b_wide_2doors', width: 14.0 },
  ],
  shed: [
    { key: 'b_1story_gable', width: 4.8 },
    { key: 'b_1story_round', width: 4.6 },
    { key: 'b_1story', width: 5.0 },
  ],
};

/** 区域 → 调色板候选（同一栋楼换调色板 = 换砖色，住宅偏红、商业偏浅、工业偏暗）。
 *  `stadium` 是球场区（world/grounds.js）用的：会所/器材库/医疗点按混凝土与钢构配色，不要镇子的红砖。 */
export const BUILDING_PALETTE_BY_DISTRICT = {
  residential: ['brick', 'brick', 'yellow', 'green'],
  commercial: ['grey', 'light', 'light', 'blue'],
  industrial: ['dark', 'darkblue', 'grey', 'green'],
  park: ['green', 'grey', 'brick'],
  plaza: ['light', 'grey', 'blue'],
  stadium: ['grey', 'light', 'light', 'darkblue'],
};

/**
 * 门洞尺寸下限。为什么要下限：
 *   · 玩家碰撞半径 0.34m → 直径 0.68m，1.2m 的门洞留出 0.5m 余量，贴着门框也能进出；
 *   · NPC 的导航网格格子 2m（config.world.cell），比门洞还宽 —— 所以 NPC 穿门靠的是
 *     layout.navDoors 里显式清出来的"门口走廊"格（见 layout.js / game.js），
 *     不靠门洞宽度；门洞只要玩家能过就行，不必为了 NPC 做成 4m 的车库门。
 * 上限用来防止模型按比例放大后门洞夸张成车库门。
 */
export const DOOR_MIN_WIDTH = 1.2;
export const DOOR_MAX_WIDTH = 2.8;
export const DOOR_MIN_HEIGHT = 2.05;

export const BUILDING_MODEL_KEYS = Object.keys(BUILDING_MODELS);

/**
 * 模型键 + 缩放 → 世界尺寸与门洞（米）。layout 与 building-mesh 必须共用这一份换算，
 * 否则"门画在哪"和"洞切在哪"会差几厘米，墙上就会剩下半截门。
 */
export function buildingSpec(modelKey, scale) {
  const m = BUILDING_MODELS[modelKey];
  if (!m) return null;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const ys = Number.isFinite(m.ys) && m.ys > 0 ? m.ys : 1;
  const width = m.size.w * s;
  const depth = m.size.d * s;
  const height = m.size.h * s * ys;
  const rawDoorW = m.door.w * s + 0.12;   // 多切 0.12m：把门框边缘一起切掉，不剩毛边
  const rawDoorH = m.door.h * s * ys + 0.1;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    modelKey, scale: s, yScale: ys,
    width, depth, height,
    door: {
      offset: m.door.u * s,                       // 门中心相对楼中心的水平偏移（沿正面宽度方向）
      width: clamp(rawDoorW, DOOR_MIN_WIDTH, Math.min(DOOR_MAX_WIDTH, width - 1.0)),
      height: clamp(rawDoorH, DOOR_MIN_HEIGHT, height - 0.4),
    },
  };
}

/** 给定类型随机抽一个模型 + 目标宽度（确定性：同一个 rng 序列 → 同一个结果）。 */
export function pickBuildingModel(rng, type) {
  const pool = BUILDING_TYPE_POOLS[type] || BUILDING_TYPE_POOLS.house;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/**
 * 模型正面是 +Z。世界约定：north = z 小的一侧（rect.z0），south = z 大的一侧（rect.z1）。
 * 所以 south 不用转、north 转 180°、east（+X）转 +90°、west 转 -90°。
 */
export function buildingRotation(doorSide) {
  if (doorSide === 'north') return Math.PI;
  if (doorSide === 'east') return Math.PI / 2;
  if (doorSide === 'west') return -Math.PI / 2;
  return 0;
}

/** 区域 → 调色板名（确定性）。 */
export function pickBuildingPalette(rng, district) {
  const pool = BUILDING_PALETTE_BY_DISTRICT[district] || BUILDING_PALETTE_BY_DISTRICT.residential;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/** 调色板名 → 16 个 #rrggbb；未知名字退回 brick。 */
export function buildingPalette(name) {
  return BUILDING_PALETTES[name] || BUILDING_PALETTES.brick;
}

/**
 * UV → 调色板格子（4×4，行优先，行 0 在图集顶部）。
 * 道具包的 UV 直接指向调色板，所以"按面取一格纯色"等于原贴图逐像素还原（实测跨格面为 0）。
 */
export function paletteCellIndex(u, v) {
  const fu = ((u % 1) + 1) % 1;
  const fv = ((v % 1) + 1) % 1;
  const cx = Math.min(3, Math.floor(fu * 4));
  const cy = Math.min(3, Math.floor((1 - fv) * 4));
  return cy * 4 + cx;
}

/** UV + 调色板 → #rrggbb 字符串（越界 UV 按图集重复处理，和 WebGL 的 RepeatWrapping 一致）。 */
export function paletteColorForUV(palette, u, v) {
  const list = Array.isArray(palette) && palette.length === 16 ? palette : BUILDING_PALETTES.brick;
  return list[paletteCellIndex(u, v)];
}

export default {
  BUILDING_MODELS, BUILDING_PALETTES, BUILDING_TYPE_POOLS, BUILDING_MODEL_KEYS,
  DOOR_MIN_WIDTH, DOOR_MAX_WIDTH, DOOR_MIN_HEIGHT,
  buildingSpec, pickBuildingModel, pickBuildingPalette, buildingPalette,
  buildingRotation, paletteCellIndex, paletteColorForUV,
};
