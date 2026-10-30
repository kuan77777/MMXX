// 资产清单（运行时用）：把 dist/assets 里已经下载并通过浏览器加载测试的资源登记成数据。
// 原则：
//   · 路径写死、显式列出，不做目录扫描 —— 浏览器没法列目录，而且显式清单能让"缺文件"立刻暴露；
//   · 每个条目带 license 字段，来源见 ASSET_CATALOG.md；
//   · 只有真正用到的资源才在清单里（不把 49MB 全塞进游戏）。

import { TREE_MODELS, TREE_ASSET_DIR, treeObjFor, treeSeasonKey, seasonExtraModelKeys } from '../world/trees.js';
import { carPropModels } from '../world/cars.js';
import { BUILDING_MODELS, BUILDING_ASSET_DIR } from '../world/buildings.js';

export const ASSET_BASE = 'assets/';

/** 一棵树/一个道具 → 加载器条目（fit 里带 base:'trunk' + mtlLinear，见树木说明）。 */
function treeEntryFromObj(obj, fit) {
  return {
    url: `${TREE_ASSET_DIR}${obj}.obj`,
    mtl: `${TREE_ASSET_DIR}${obj}.mtl`,
    fit: { mode: 'height', size: fit, base: 'trunk', mtlLinear: true },
    license: 'CC0-1.0 (Quaternius)',
  };
}

/**
 * 树木（绿 / 春夏）：模型清单 + 目标高度 + 树干半径都写在 `world/trees.js`（摆放与渲染共用同一组数字）。
 * 这里只把它翻译成加载器要的形状；`fit.base: 'trunk'` 表示按**树干底部**做水平居中，
 * 否则树冠偏心的模型旋转时树干会绕着画圈、碰撞体也对不上。
 */
const treePropModels = Object.fromEntries(Object.entries(TREE_MODELS).map(([key, t]) => [key, treeEntryFromObj(t.obj, t.fit)]));

/**
 * 四季树木：秋/冬用同一植株的 `_Autumn` / `_Snow` 几何，**按需加载**（开局只装当季，换季时补装）。
 * 资产键带 `@autumn` / `@winter` 后缀，与绿几何区分开；枯树的秋色没有单独模型，直接复用绿几何。
 */
function seasonTreeProps(season) {
  const out = {};
  for (const key of seasonExtraModelKeys(season)) {
    const plant = key.split('@')[0];
    const obj = treeObjFor(season, plant);
    if (!obj) continue;
    out[key] = treeEntryFromObj(obj, TREE_MODELS[plant].fit);
  }
  return out;
}

export const SEASON_TREE_PROPS = {
  spring: {},
  summer: {},
  autumn: seasonTreeProps('autumn'),
  winter: seasonTreeProps('winter'),
};

/** 角色模型（FBX，带烘焙动画）。scale 会在加载时按包围盒自动归一。 */
export const CHARACTER_MODELS = {
  zombie: { url: 'assets/characters/zombie.fbx', kind: 'zombie', targetHeight: 1.78, license: 'CC0-1.0 (Quaternius)' },
  male_shirt: { url: 'assets/characters/male_shirt.fbx', kind: 'human', targetHeight: 1.78, license: 'CC0-1.0 (Quaternius)' },
  male_casual: { url: 'assets/characters/male_casual.fbx', kind: 'human', targetHeight: 1.78, license: 'CC0-1.0 (Quaternius)' },
  female_casual: { url: 'assets/characters/female_casual.fbx', kind: 'human', targetHeight: 1.70, license: 'CC0-1.0 (Quaternius)' },
  female_dress: { url: 'assets/characters/female_dress.fbx', kind: 'human', targetHeight: 1.70, license: 'CC0-1.0 (Quaternius)' },
};

/** 男/女各一套变体，用来让 NPC 不只长一个样。 */
export const HUMAN_VARIANTS = ['male_shirt', 'male_casual', 'female_casual', 'female_dress'];

/**
 * 建筑：模型清单、实测门洞、调色板全部在 `world/buildings.js`（摆放与渲染共用同一组数字）。
 * 建筑**不需要 MTL**：道具包的 MTL 里只有一个灰色 "Texture" 材质，真实配色靠 UV 指向
 * 4×4 纯色调色板，由 assets/loader.js 的 preloadBuildings 烘焙成顶点色（见该文件注释）。
 */
const buildingPropModels = Object.fromEntries(Object.entries(BUILDING_MODELS).map(([key, b]) => [key, {
  url: `${BUILDING_ASSET_DIR}${b.obj}.obj`,
  license: 'CC0-1.0 (Quaternius)',
}]));

/** 建筑模型（给 AssetLoader.preloadBuildings 用；键名 = world/buildings.js 的模型键）。 */
export const BUILDING_PROP_MODELS = {
  ...buildingPropModels,
  // 模块化窗户：给"只有正面有窗"的成品楼补侧墙窗（同一套调色板，见 world/building-mesh.js sideWindows）
  part_window: { url: 'assets/models/buildings/parts/Window_Double.obj', license: 'CC0-1.0 (Quaternius)' },
};

/**
 * 道具模型（OBJ + MTL）。fit 是目标尺寸（米），加载后按包围盒缩放：
 *   height = 按高度归一；longest = 按最长边归一；none = 保持原始尺寸；
 *   raw = 保留作者坐标与原始单位（街道模块，见 world/roads.js）；
 *   base: 'trunk' = 水平居中改成按树干底部重心（树木，见 world/trees.js）；
 *   rx/ry/rz = 烘焙前先旋转（枪械朝向修正，见下方枪械条目）。
 */
export const PROP_MODELS = {
  // 枪械（外观来自 Ultimate Guns）。Quaternius 的枪是「枪口朝 +X、枪身沿 X 轴、上方 +Y」，
  // 而武器挂点 / 第一人称视图模型都假定「枪口朝 +Z」，所以三个枪条目都带 fit.ry = -Math.PI/2，
  // 由 loader.bakeGeometry 在烘焙时旋转（几何只烘焙一次，之后随便克隆）。
  // 近战斧来自 Survival Pack（不是枪械），handle 沿 +Y，用 rx = +Math.PI/2 让握柄朝 +Z。
  // mtlLinear：与树木/车辆/街道同一处理 —— Blender 导出的 Kd 是线性值，
  // 不还原的话枪会黑成一团剪影（实测枪械 Kd 只有 6~27/255）。
  'w_pistol_9mm': { url: 'assets/models/guns/Pistol_1.obj', mtl: 'assets/models/guns/Pistol_1.mtl', fit: { mode: 'longest', size: 0.24, ry: -Math.PI / 2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  'w_rifle_556': { url: 'assets/models/guns/AssaultRifle_2.obj', mtl: 'assets/models/guns/AssaultRifle_2.mtl', fit: { mode: 'longest', size: 0.95, ry: -Math.PI / 2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  'w_shotgun_12g': { url: 'assets/models/guns/Shotgun_2.obj', mtl: 'assets/models/guns/Shotgun_2.mtl', fit: { mode: 'longest', size: 1.05, ry: -Math.PI / 2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  'w_melee_axe': { url: 'assets/models/survival/Axe_Small.obj', mtl: 'assets/models/survival/Axe_Small.mtl', fit: { mode: 'longest', size: 0.72, rx: Math.PI / 2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  'w_smg_9mm': { url: 'assets/models/guns/SubmachineGun_2.obj', mtl: 'assets/models/guns/SubmachineGun_2.mtl', fit: { mode: 'longest', size: 0.52, ry: -Math.PI / 2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  'w_sniper_762': { url: 'assets/models/guns/SniperRifle_2.obj', mtl: 'assets/models/guns/SniperRifle_2.mtl', fit: { mode: 'longest', size: 1.15, ry: -Math.PI / 2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },

  // 树木（22 个变体，按模型分桶做 InstancedMesh；见 world/trees.js）
  ...treePropModels,

  // 家具
  bed: { url: 'assets/models/furniture/BedTwin.obj', mtl: 'assets/models/furniture/BedTwin.mtl', fit: { mode: 'height', size: 0.55 } },
  bookcase: { url: 'assets/models/furniture/Bookcase.obj', mtl: 'assets/models/furniture/Bookcase.mtl', fit: { mode: 'height', size: 1.8 } },
  chair: { url: 'assets/models/furniture/Chair.obj', mtl: 'assets/models/furniture/Chair.mtl', fit: { mode: 'height', size: 0.9 } },
  desk: { url: 'assets/models/furniture/Desk.obj', mtl: 'assets/models/furniture/Desk.mtl', fit: { mode: 'height', size: 0.75 } },
  table: { url: 'assets/models/furniture/Table.obj', mtl: 'assets/models/furniture/Table.mtl', fit: { mode: 'height', size: 0.75 } },
  closet: { url: 'assets/models/furniture/Closet.obj', mtl: 'assets/models/furniture/Closet.mtl', fit: { mode: 'height', size: 2.0 } },
  sofa: { url: 'assets/models/furniture/Sofa.obj', mtl: 'assets/models/furniture/Sofa.mtl', fit: { mode: 'height', size: 0.85 } },

  // 容器 / 生存道具（Survival Pack，枪械一律不取）
  // 尺寸按现实物件给：急救包 30cm 长、绷带卷 16cm 高、易拉罐 16cm 高、水瓶 28cm 高、5 号电池 6cm 高。
  firstaid: { url: 'assets/models/survival/FirstAidKit.obj', mtl: 'assets/models/survival/FirstAidKit.mtl', fit: { mode: 'height', size: 0.3, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  firstaid_hard: { url: 'assets/models/survival/FirstAidKit_Hard.obj', mtl: 'assets/models/survival/FirstAidKit_Hard.mtl', fit: { mode: 'height', size: 0.26, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  bandages: { url: 'assets/models/survival/Bandages.obj', mtl: 'assets/models/survival/Bandages.mtl', fit: { mode: 'height', size: 0.16, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  waterbottle: { url: 'assets/models/survival/WaterBottle_1.obj', mtl: 'assets/models/survival/WaterBottle_1.mtl', fit: { mode: 'height', size: 0.28, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  can: { url: 'assets/models/survival/Can_Closed.obj', mtl: 'assets/models/survival/Can_Closed.mtl', fit: { mode: 'height', size: 0.16, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  backpack: { url: 'assets/models/survival/Backpack.obj', mtl: 'assets/models/survival/Backpack.mtl', fit: { mode: 'height', size: 0.5, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  radio: { url: 'assets/models/survival/Radio.obj', mtl: 'assets/models/survival/Radio.mtl', fit: { mode: 'height', size: 0.24, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  torch: { url: 'assets/models/survival/Torch.obj', mtl: 'assets/models/survival/Torch.mtl', fit: { mode: 'height', size: 0.34, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  woodlog: { url: 'assets/models/survival/WoodLog.obj', mtl: 'assets/models/survival/WoodLog.mtl', fit: { mode: 'longest', size: 0.9, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  battery: { url: 'assets/models/survival/Battery_Small.obj', mtl: 'assets/models/survival/Battery_Small.mtl', fit: { mode: 'height', size: 0.06, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },

  // 食物（Ultimate Food）：尺寸按现实物件（苹果 10cm、香蕉 20cm、面包 28cm、巧克力 16cm、易拉罐杯 16cm）
  apple: { url: 'assets/models/food/Apple.obj', mtl: 'assets/models/food/Apple.mtl', fit: { mode: 'height', size: 0.1, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  banana: { url: 'assets/models/food/Banana.obj', mtl: 'assets/models/food/Banana.mtl', fit: { mode: 'longest', size: 0.2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  orange: { url: 'assets/models/food/Orange.obj', mtl: 'assets/models/food/Orange.mtl', fit: { mode: 'height', size: 0.095, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  bread: { url: 'assets/models/food/Bread.obj', mtl: 'assets/models/food/Bread.mtl', fit: { mode: 'longest', size: 0.28, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  chocolate: { url: 'assets/models/food/ChocolateBar.obj', mtl: 'assets/models/food/ChocolateBar.mtl', fit: { mode: 'longest', size: 0.16, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  soda: { url: 'assets/models/food/Soda.obj', mtl: 'assets/models/food/Soda.mtl', fit: { mode: 'height', size: 0.16, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  jar: { url: 'assets/models/food/Jar_Large.obj', mtl: 'assets/models/food/Jar_Large.mtl', fit: { mode: 'height', size: 0.11, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  pizza: { url: 'assets/models/food/Pizza_Slice.obj', mtl: 'assets/models/food/Pizza_Slice.mtl', fit: { mode: 'longest', size: 0.16, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  sushi: { url: 'assets/models/food/Sushi_Roll1.obj', mtl: 'assets/models/food/Sushi_Roll1.mtl', fit: { mode: 'longest', size: 0.06, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  icecream: { url: 'assets/models/food/IceCream_1.obj', mtl: 'assets/models/food/IceCream_1.mtl', fit: { mode: 'height', size: 0.15, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },

  // 车辆（Cars Pack 的 7 台车，车型/车长/手感都写在 world/cars.js，这里只翻译成加载条目）
  ...carPropModels(),

  // ── 街道（Quaternius Modular Streets）──
  // 路面模块用 mode:'raw'：模型自带的 2×2 拼接原点与 0.1 高的沥青面必须原样保留，
  // 每个实例的缩放由 game/world/roads.js 的拼接计划决定（直道可以沿长度拉长，所以只要 1 个直道几何）。
  // 路灯/路牌/信号灯是"立在地上"的装饰，仍按高度归一。
  // mtlLinear：跟树木/车辆一样，Blender 导出的 Kd 是线性值，不还原的话沥青会黑成一片。
  street_straight: { url: 'assets/models/streets/Street_Straight.obj', mtl: 'assets/models/streets/Street_Straight.mtl', fit: { mode: 'raw', mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  street_4way: { url: 'assets/models/streets/Street_4Way.obj', mtl: 'assets/models/streets/Street_4Way.mtl', fit: { mode: 'raw', mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  street_deadend: { url: 'assets/models/streets/Street_Deadend.obj', mtl: 'assets/models/streets/Street_Deadend.mtl', fit: { mode: 'raw', mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  streetlight: { url: 'assets/models/streets/Streetlight_Single.obj', mtl: 'assets/models/streets/Streetlight_Single.mtl', fit: { mode: 'height', size: 6.5, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  sign_stop: { url: 'assets/models/streets/Sign_Stop.obj', mtl: 'assets/models/streets/Sign_Stop.mtl', fit: { mode: 'height', size: 2.2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
  traffic_light: { url: 'assets/models/streets/TrafficLight.obj', mtl: 'assets/models/streets/TrafficLight.mtl', fit: { mode: 'height', size: 3.2, mtlLinear: true }, license: 'CC0-1.0 (Quaternius)' },
};

/**
 * 物品 id → 世界外观模型 key（地面拾取物、容器里的图标模型都用它）。
 * 覆盖原则：有对应模型的物品就登记，没有的（撬棍/废金属/旧照片/球棒）不登记，
 * 由 game._addPickup 退化成彩色方块 —— 假装有模型反而更糟。
 * 每个 id 都必须在 items.js 的 ITEMS 里存在（tests/props.test.mjs 会检查）。
 */
export const ITEM_MODEL = {
  i_w_pistol: 'w_pistol_9mm',
  i_w_rifle: 'w_rifle_556',
  i_w_shotgun: 'w_shotgun_12g',
  i_w_smg: 'w_smg_9mm',
  i_w_sniper: 'w_sniper_762',
  i_w_axe: 'w_melee_axe',
  i_food_can: 'can',
  i_food_bar: 'chocolate',
  i_food_apple: 'apple',
  i_food_orange: 'orange',
  i_food_banana: 'banana',
  i_food_bread: 'bread',
  i_food_chocolate: 'chocolate',
  i_food_pizza: 'pizza',
  i_food_sushi: 'sushi',
  i_food_icecream: 'icecream',
  i_drink_water: 'waterbottle',
  i_drink_soda: 'soda',
  i_med_bandage: 'bandages',
  i_med_kit: 'firstaid',
  i_med_pills: 'jar',
  i_med_antibiotics: 'firstaid_hard',
  i_med_splint: 'woodlog',
  i_mat_wood: 'woodlog',
  i_mat_battery: 'battery',
  i_misc_radio: 'radio',
  i_tool_flashlight: 'torch',
  // 汽油桶：道具包里没有油桶模型，先用 Survival Pack 的金属罐代替（见 ASSET_CATALOG 已知缺口）
  i_tool_fuel_can: 'can',
  i_cloth_jacket: 'backpack',
};

/** 容器类型 → 外观模型 key。 */
export const CONTAINER_MODEL = {
  crate: 'woodlog',
  barrel: 'can',
  dumpster: 'can',
  backpack: 'backpack',
  cabinet: 'closet',
  drawer: 'desk',
  locker: 'closet',
  toolbox: 'firstaid',
  milcase: 'firstaid',
};

export const LICENSE_NOTE = {
  characters: 'CC0-1.0 (Quaternius, 见 assets/characters/License_Quaternius_CC0.txt)',
  props: 'CC0-1.0 (Quaternius)',
};

export default { CHARACTER_MODELS, HUMAN_VARIANTS, PROP_MODELS, BUILDING_PROP_MODELS, ITEM_MODEL, CONTAINER_MODEL };
