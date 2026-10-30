// 车辆目录：道具包「车辆」= Quaternius **Cars Pack**（CC0 1.0）里的 7 台车。
// 摆放（world/layout.js）、渲染（world/build.js）、加载清单（assets/manifest.js）、
// 驾驶手感与后备箱容量（vehicles/vehicles.js）**共用这一份数据**，改车长/车速/容量只改这里。
//
// ── 实测结论（用 OBJ 几何算出来的，不是猜的；见 `_work/car-audit.mjs`）──
//   · 7 台的**车长都沿本地 +Z**、**车头也朝 +Z**（用 Headlights 与 TailLights 两个材质的
//     顶点重心差判断方向）。VehicleController 的前进方向正好是 +Z，所以模型**不需要任何旋转烘焙**；
//   · 源文件车长不一致（3.31~4.22 单位），所以按目标车长做 `fit:{mode:'longest'}` 归一，
//     否则同一张图里的车会长短不齐（Scale 差 27% 一眼就能看出来）；
//   · 每台车只有一种固定车身色（Blue / LightBlue / White / Orange / Yellow / 警车 White+Blue），
//     包内没有独立的"车漆"材质，因此不做随机染色 —— 想换色得在 MTL 里加材质，不在运行时乱涂；
//   · MTL 的 Kd 是 Blender 导出的**线性**值，加载时要 `mtlLinear:true` 还原，否则整台车会暗一大截
//     （和树木/街道是同一个坑，见 loader.bakeGeometry 的注释）。

const CAR_DIR = 'assets/models/cars/';

/**
 * @typedef {object} CarType
 * @property {string} id       车型 id（存档、调试用）
 * @property {string} kind     layout 里的 kind（程序化回退车模按它选形状）
 * @property {string} label    UI 里的中文名（交互提示用）
 * @property {string} model    加载清单里的模型 key
 * @property {string} file     dist/assets/models/cars 下的 OBJ 文件名（不含扩展名）
 * @property {number} length   目标车长（米）
 * @property {number} halfWidth 归一后的半车宽（米，由 `_work/car-audit.mjs` 实测，测试会复核）
 * @property {number} weight   生成权重
 * @property {string} trunk    后备箱的初始战利品表（见 items.js LOOT_TABLES）
 * @property {number} trunkWeight 后备箱载重（kg）——比背包（24kg）大，车就是"移动仓库"
 * @property {number} trunkSlots  后备箱格数
 * @property {{speed:number, accel:number, steer:number}} perf 相对驾驶手感（1 = 配置默认值）
 * @property {string} license
 */
export const CAR_TYPES = [
  {
    id: 'sedan', kind: 'sedan', label: '轿车', model: 'car_normal', file: 'NormalCar1', length: 4.2, halfWidth: 0.90, weight: 4,
    trunk: 'vehicle', trunkWeight: 45, trunkSlots: 8,
    perf: { speed: 1.0, accel: 1.0, steer: 1.0 }, license: 'CC0-1.0 (Quaternius)',
  },
  {
    id: 'compact', kind: 'hatch', label: '小型车', model: 'car_compact', file: 'NormalCar2', length: 3.55, halfWidth: 0.90, weight: 3,
    trunk: 'vehicle', trunkWeight: 32, trunkSlots: 6,
    perf: { speed: 0.95, accel: 1.05, steer: 1.15 }, license: 'CC0-1.0 (Quaternius)',
  },
  {
    id: 'suv', kind: 'suv', label: 'SUV', model: 'car_suv', file: 'SUV', length: 4.6, halfWidth: 1.18, weight: 3,
    trunk: 'vehicle', trunkWeight: 85, trunkSlots: 12,
    perf: { speed: 0.92, accel: 0.95, steer: 0.9 }, license: 'CC0-1.0 (Quaternius)',
  },
  {
    id: 'sports', kind: 'sports', label: '跑车', model: 'car_sports', file: 'SportsCar', length: 4.3, halfWidth: 0.98, weight: 2,
    trunk: 'vehicle', trunkWeight: 22, trunkSlots: 4,
    perf: { speed: 1.25, accel: 1.25, steer: 1.05 }, license: 'CC0-1.0 (Quaternius)',
  },
  {
    id: 'sports2', kind: 'sports2', label: '跑车', model: 'car_sports2', file: 'SportsCar2', length: 4.1, halfWidth: 0.98, weight: 2,
    trunk: 'vehicle', trunkWeight: 22, trunkSlots: 4,
    perf: { speed: 1.2, accel: 1.2, steer: 1.05 }, license: 'CC0-1.0 (Quaternius)',
  },
  {
    id: 'taxi', kind: 'taxi', label: '出租车', model: 'car_taxi', file: 'Taxi', length: 4.4, halfWidth: 0.95, weight: 2,
    trunk: 'vehicle', trunkWeight: 55, trunkSlots: 9,
    perf: { speed: 1.0, accel: 1.0, steer: 1.0 }, license: 'CC0-1.0 (Quaternius)',
  },
  {
    id: 'police', kind: 'police', label: '警车', model: 'car_police', file: 'Cop', length: 4.45, halfWidth: 1.07, weight: 1,
    // 警车是这台小镇里唯一带警灯的车：开起来更快一点、后备箱里是警用装备，当"稀有载具"
    trunk: 'military', trunkWeight: 60, trunkSlots: 10,
    perf: { speed: 1.3, accel: 1.3, steer: 1.0 }, license: 'CC0-1.0 (Quaternius)',
  },
];

export const CAR_TYPE_BY_ID = Object.fromEntries(CAR_TYPES.map((t) => [t.id, t]));

const TOTAL_WEIGHT = CAR_TYPES.reduce((s, t) => s + t.weight, 0);

/**
 * 按权重挑一台车。**只消耗一次 rng()** —— layout 的随机序列不能因为换车而错位
 * （同 seed 必须得到同一张图，存档/测试依赖这一点）。
 */
export function pickCarType(rng) {
  let r = (typeof rng === 'function' ? rng() : 0) * TOTAL_WEIGHT;
  for (const t of CAR_TYPES) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return CAR_TYPES[0];
}

/**
 * 第 index 台车该用哪一台车模。
 * 前 7 台按 `(index×3) mod 7` 依次发牌 → **一张图里 7 种车一定能全见到**
 * （纯加权随机会出现"整张图没有警车/出租车"，7 台车白接一半体验）。
 * 但无论如何都先调一次 `pickCarType(rng)` 把随机数消耗掉：布局里车辆的随机序列不能错位，
 * 否则同 seed 的地图（连同后面的补给箱/战利品位置）会整体漂移。
 */
export function carTypeForSlot(index, rng) {
  const rolled = pickCarType(rng);
  const i = Math.max(0, Math.floor(index) || 0);
  if (i < CAR_TYPES.length) return CAR_TYPES[(i * 3) % CAR_TYPES.length];
  return rolled;
}

/** 模型 key → 加载清单条目（assets/manifest.js 直接展开）。 */
export function carPropModels() {
  const out = {};
  for (const t of CAR_TYPES) {
    out[t.model] = {
      url: `${CAR_DIR}${t.file}.obj`,
      mtl: `${CAR_DIR}${t.file}.mtl`,
      // 车长沿 +Z 且车头朝 +Z，和 VehicleController 的前进方向一致 → 不需要 rx/ry/rz
      fit: { mode: 'longest', size: t.length, mtlLinear: true },
      license: t.license,
    };
  }
  return out;
}

/** 旧存档/旧代码里只有 kind 时的兜底映射。 */
export const CAR_MODEL_BY_KIND = Object.fromEntries(CAR_TYPES.map((t) => [t.kind, t.model]));

export default { CAR_TYPES, CAR_TYPE_BY_ID, pickCarType, carTypeForSlot, carPropModels, CAR_MODEL_BY_KIND };
