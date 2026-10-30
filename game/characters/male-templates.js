// 男性体型模板库：**只靠一份角色包 FBX** 做出多款体型/身高/发型/胡子都不同的模板。
//
// 背景（实测，不是猜的）：
//   · 角色包男性 4 个 FBX（Casual/Shirt/LongSleeve/Suit）都是「一个 SkinnedMesh + 7 个材质组」：
//     Skin / Eyes / Hair / Hair2 / Shirt / Pants / Socks / Shoes。**头发是烤进网格的**，
//     没有独立的头部挂点、没有贴图、也没有第二套发型 —— 想换款只能自己长几何。
//   · 骨架是 Quaternius 那套：Body → Hips → Abdomen → Torso → {ShoulderL/R, Neck → Head}，
//     Body → UpperLegL/R → LowerLegL/R；脚（FootL/R）挂在根骨骼上而不是小腿上。
//     骨骼局部轴基本是「Y 沿肢体、X 宽度、Z 前后」（见下面的 BONE_MORPH）。
//   · 动画片段里每根骨骼都带 scale 轨道，但**恒等于 1**（只有 HumanArmature 是 100）。
//     这类轨道会每帧把骨骼缩放覆盖掉，所以 mapClipsToStates() 里会把恒为 1 的 scale 轨道剔掉，
//     否则这里的体型变形一帧就会被动画抹平。see fbx.js stripConstantScaleTracks()。
//   · 头部在头骨局部空间里的尺寸对四个男性模型**完全一致**：
//     宽 0.5583 / 高 0.7376 / 深 0.6878，下巴 y=-0.1428，头顶 y=+0.5947，脸最前 z=+0.4235，
//     后脑 z=-0.2643（单位是模型自己的"米"：全身 4.83 个单位 = 1.78 米）。
//     所以发型/胡子可以直接按这些比例长几何，再挂到 Head 骨骼下面 —— 跟着头部动画走，不会飘。
//
// 于是模板由三部分组成：
//   ① 身高：外层 wrapper 缩放（世界对齐，最稳）；
//   ② 体型：按骨骼改**世界轴缩放**（肩宽/胸厚/腰腹/四肢粗细/头大小），自顶向下做继承补偿，
//      保证"把胸加宽"不会顺带把胳膊和脑袋一起吹大；
//   ③ 发型/胡子：在头骨局部空间里长低多边形盒子（和角色本身一样是硬边低多边形），
//      按款式组合，颜色跟发色走。
//
// 这个模块只依赖调用方传进来的 THREE（不顶层 import three），所以 Node 测试能直接跑。

/** 实测的男性头部尺寸（头骨局部空间，全身 4.83 单位 = 1.78 米）。量不出来时用它兜底。 */
export const HEAD_FRAME_FALLBACK = Object.freeze({
  x0: -0.2781, x1: 0.2802, y0: -0.1428, y1: 0.5947, z0: -0.2643, z1: 0.4235,
  source: 'fallback',
});

/** 骨骼 → 期望的**世界轴**缩放系数名。Y 一律不动（Y 是肢体长度方向，改它会破坏落脚点）。 */
const BONE_MORPH = {
  chest: { x: 'shoulder', z: 'chest' },      // Torso：肩宽 + 胸厚
  spine: { x: 'waist', z: 'belly' },         // Abdomen：腰宽 + 肚子
  neck: { x: 'neck', z: 'neck' },
  head: { x: 'head', y: 'head', z: 'head' }, // 头整体大小
  upperArmL: { x: 'arm', z: 'arm' },
  upperArmR: { x: 'arm', z: 'arm' },
  lowerArmL: { x: 'arm', z: 'arm' },
  lowerArmR: { x: 'arm', z: 'arm' },
  thighL: { x: 'leg', z: 'leg' },
  thighR: { x: 'leg', z: 'leg' },
  shinL: { x: 'leg', z: 'leg' },
  shinR: { x: 'leg', z: 'leg' },
};

/** 处理顺序：父骨骼必须先于子骨骼（继承补偿要自顶向下累积）。
 *  注意脊柱链的真实层级是 Body → Hips → Abdomen(spine) → Torso(chest) → Neck/Shoulders，
 *  所以 spine 要在 chest 之前处理，否则"胸"会把腰的倍数重复算一遍。 */
const MORPH_ORDER = ['spine', 'chest', 'neck', 'head', 'upperArmL', 'lowerArmL', 'upperArmR', 'lowerArmR', 'thighL', 'shinL', 'thighR', 'shinR'];

// ── 发型 ────────────────────────────────────────────────
// cap: 'hair' = 保留模型烤进去的那顶头发并染色；'skin' = 把它染成肤色（当光头底座），自己重新长。
// boxes(a) 返回若干个盒子 {w,h,d,x,y,z,ry,rx}，坐标/尺寸都是头骨局部空间（模型米制单位）。
//
// 经验（看渲染图调出来的）：**别在头顶再加一顶"帽子"**。模型烤进去的头发本来就是一顶
// 从发际线(头高 0.118)盖到头顶(0.5947)的"盔"，再叠一层只会变成悬浮的方块帽子。
// 所以 cap='hair' 的款式只加"额前刘海 / 两侧鬓角 / 后披 / 马尾"这些**额外**的部分。
const sideburn = (a, sx) => ({ w: a.W * 0.11, h: a.H * 0.17, d: a.D * 0.32, x: a.W * 0.44 * sx, y: a.top - a.H * 0.36, z: a.back + a.D * 0.50 });

export const HAIR_STYLES = [
  { key: 'bald', label: '光头', cap: 'skin', boxes: () => [] },

  // 寸头：烤好的那顶本来就是寸头，不加几何
  { key: 'buzz', label: '寸头', cap: 'hair', boxes: () => [] },

  // 短发：额前两段刘海（上宽下窄，像剪出来的） + 两侧鬓角
  { key: 'short', label: '短发', cap: 'hair', boxes: (a) => [
    { w: a.W * 0.80, h: a.H * 0.10, d: a.D * 0.11, y: a.top - a.H * 0.28, z: a.front - a.D * 0.06 },
    { w: a.W * 0.62, h: a.H * 0.06, d: a.D * 0.10, y: a.top - a.H * 0.36, z: a.front - a.D * 0.065 },
    sideburn(a, -1),
    sideburn(a, 1),
  ] },

  // 中分：两块刘海中间留缝
  { key: 'side', label: '中分', cap: 'hair', boxes: (a) => [
    { w: a.W * 0.39, h: a.H * 0.11, d: a.D * 0.12, x: -a.W * 0.21, y: a.top - a.H * 0.29, z: a.front - a.D * 0.07 },
    { w: a.W * 0.39, h: a.H * 0.11, d: a.D * 0.12, x: a.W * 0.21, y: a.top - a.H * 0.29, z: a.front - a.D * 0.07 },
    { w: a.W * 0.12, h: a.H * 0.32, d: a.D * 0.34, x: -a.W * 0.46, y: a.top - a.H * 0.40, z: a.back + a.D * 0.46 },
    { w: a.W * 0.12, h: a.H * 0.32, d: a.D * 0.34, x: a.W * 0.46, y: a.top - a.H * 0.40, z: a.back + a.D * 0.46 },
  ] },

  // 长发：背后一大片 + 两侧垂下来（都不碰头顶）
  { key: 'long', label: '长发', cap: 'hair', boxes: (a) => [
    { w: a.W * 0.94, h: a.H * 0.80, d: a.D * 0.18, y: a.top - a.H * 0.55, z: a.back + a.D * 0.06 },
    { w: a.W * 0.17, h: a.H * 0.52, d: a.D * 0.40, x: -a.W * 0.47, y: a.top - a.H * 0.46, z: a.back + a.D * 0.30 },
    { w: a.W * 0.17, h: a.H * 0.52, d: a.D * 0.40, x: a.W * 0.47, y: a.top - a.H * 0.46, z: a.back + a.D * 0.30 },
  ] },

  // 马尾：后面一条尾巴（留一小截发根在脑后）
  { key: 'ponytail', label: '马尾', cap: 'hair', boxes: (a) => [
    { w: a.W * 0.20, h: a.H * 0.16, d: a.D * 0.14, y: a.top - a.H * 0.34, z: a.back + a.D * 0.03 },
    { w: a.W * 0.15, h: a.H * 0.54, d: a.D * 0.15, y: a.top - a.H * 0.68, z: a.back - a.D * 0.06, rx: -0.2 },
  ] },

  // 莫西干：两侧剃光（烤进去的头发染色成肤色），头顶一条脊
  { key: 'mohawk', label: '莫西干', cap: 'skin', boxes: (a) => [
    { w: a.W * 0.23, h: a.H * 0.15, d: a.D * 0.74, y: a.top + a.H * 0.02, z: a.back + a.D * 0.46 },
    { w: a.W * 0.19, h: a.H * 0.09, d: a.D * 0.30, y: a.top + a.H * 0.13, z: a.back + a.D * 0.24 },
  ] },

  // 后移发际线：只剩两侧 + 后面一圈"马蹄"
  { key: 'recede', label: '后移发际线', cap: 'skin', boxes: (a) => [
    { w: a.W * 0.13, h: a.H * 0.34, d: a.D * 0.52, x: -a.W * 0.47, y: a.top - a.H * 0.26, z: a.back + a.D * 0.42 },
    { w: a.W * 0.13, h: a.H * 0.34, d: a.D * 0.52, x: a.W * 0.47, y: a.top - a.H * 0.26, z: a.back + a.D * 0.42 },
    { w: a.W * 0.96, h: a.H * 0.34, d: a.D * 0.12, y: a.top - a.H * 0.28, z: a.back + a.D * 0.02 },
  ] },
];

// ── 胡子 ────────────────────────────────────────────────
// 胡子不用"飘在脸前面的盒子"（那在渲染图上就是一只口罩），而是照着脸上的三角面生成一层壳：
// 判定条件写在 pred(x,y,z,a) 里，命中整片三角面就把它往外推 4~10mm 上色 —— 于是胡子必然贴着下颌线。
// 长须额外垂一段盒子下来（脸下面没有面可以借）。
export const BEARD_STYLES = [
  { key: 'none', label: '无' },

  { key: 'stubble', label: '胡茬', shell: {
    offset: 0.010,
    pred: (x, y, z, a) => y < a.mouth + a.H * 0.05 && z > a.back + a.D * 0.42,
  } },

  { key: 'mustache', label: '八字胡', shell: {
    offset: 0.012,
    pred: (x, y, z, a) => y > a.mouth - a.H * 0.04 && y < a.mouth + a.H * 0.055
      && Math.abs(x - a.cx) < a.W * 0.24 && z > a.back + a.D * 0.52,
  } },

  { key: 'goatee', label: '山羊胡', shell: {
    offset: 0.014,
    pred: (x, y, z, a) => {
      const half = Math.abs(x - a.cx);
      const jaw = y < a.mouth - a.H * 0.005 && half < a.W * 0.26;
      const lip = y > a.mouth - a.H * 0.04 && y < a.mouth + a.H * 0.055 && half < a.W * 0.24;
      return (jaw || lip) && z > a.back + a.D * 0.48;
    },
  } },

  { key: 'full', label: '络腮胡', shell: {
    offset: 0.020,
    pred: (x, y, z, a) => y < a.mouth + a.H * 0.075 && Math.abs(x - a.cx) < a.W * 0.46
      && z > a.back + a.D * 0.36,
  } },

  { key: 'long', label: '长须', shell: {
    offset: 0.020,
    pred: (x, y, z, a) => y < a.mouth + a.H * 0.075 && Math.abs(x - a.cx) < a.W * 0.46
      && z > a.back + a.D * 0.36,
  }, boxes: (a) => [
    // 垂下来的三段，越往下越窄，看起来像一撮胡子而不是一条纸片
    { w: a.W * 0.40, h: a.H * 0.14, d: a.D * 0.15, y: a.chin - a.H * 0.05, z: a.front - a.D * 0.10 },
    { w: a.W * 0.30, h: a.H * 0.12, d: a.D * 0.13, y: a.chin - a.H * 0.16, z: a.front - a.D * 0.11 },
    { w: a.W * 0.18, h: a.H * 0.08, d: a.D * 0.11, y: a.chin - a.H * 0.25, z: a.front - a.D * 0.12 },
  ] },
];

const HAIR_BY_KEY = new Map(HAIR_STYLES.map((s) => [s.key, s]));
const BEARD_BY_KEY = new Map(BEARD_STYLES.map((s) => [s.key, s]));

// ── 12 款模板 ────────────────────────────────────────────
// 身高 1.60~1.95，体型从清瘦到巨汉，发型 8 种、胡子 6 种都覆盖到。
// width/depth 是**整个人**的横向/前后（外层缩放），其余是骨骼级的世界轴倍数。
export const MALE_TEMPLATES = [
  {
    id: 'standard', name: '标准体格', note: '基准线：不胖不瘦、标准身高，用来对照其它模板',
    height: 1.76, width: 1.0, depth: 1.0,
    base: 'male_shirt',
    body: { shoulder: 1.0, chest: 1.0, waist: 1.0, belly: 1.0, arm: 1.0, leg: 1.0, neck: 1.0, head: 1.0 },
    skin: 0xd3a173, hair: { style: 'short', color: 0x2b1d14 }, beard: { style: 'none', color: 0x2b1d14 },
    tags: ['基准', '青年'],
  },
  {
    id: 'lanky', name: '清瘦高个', note: '高、窄、四肢细；肩不宽但脖子长，典型的"竹竿"',
    height: 1.89, width: 0.92, depth: 0.95,
    base: 'male_shirt',
    body: { shoulder: 0.98, chest: 0.93, waist: 0.90, belly: 0.90, arm: 0.87, leg: 0.89, neck: 0.95, head: 0.97 },
    skin: 0xd8ab84, hair: { style: 'side', color: 0x3a2517 }, beard: { style: 'none', color: 0x3a2517 },
    tags: ['瘦', '高个', '青年'],
  },
  {
    id: 'burly', name: '壮硕', note: '宽肩厚胸、胳膊粗；身高略高，站姿占地方',
    height: 1.83, width: 1.09, depth: 1.06,
    base: 'male_casual',
    body: { shoulder: 1.17, chest: 1.14, waist: 1.05, belly: 1.02, arm: 1.19, leg: 1.10, neck: 1.10, head: 1.0 },
    skin: 0xc38e63, hair: { style: 'buzz', color: 0x1d1510 }, beard: { style: 'stubble', color: 0x1d1510 },
    tags: ['壮', '宽肩'],
  },
  {
    id: 'stocky', name: '矮壮', note: '矮、宽、脖子短；重心低，看着敦实',
    height: 1.66, width: 1.13, depth: 1.08,
    base: 'male_shirt',
    body: { shoulder: 1.15, chest: 1.10, waist: 1.14, belly: 1.12, arm: 1.14, leg: 1.12, neck: 1.08, head: 1.02 },
    skin: 0xc08a5e, hair: { style: 'short', color: 0x241811 }, beard: { style: 'full', color: 0x241811 },
    tags: ['壮', '矮个'],
    stats: { recoil: 1.05 },
  },
  {
    id: 'paunch', name: '发福中年', note: '肚子是主要特征：腰腹前后加厚，肩线反而略塌',
    height: 1.72, width: 1.11, depth: 1.10,
    base: 'male_shirt',
    body: { shoulder: 1.0, chest: 1.06, waist: 1.16, belly: 1.26, arm: 1.04, leg: 1.02, neck: 1.12, head: 1.01 },
    skin: 0xcb9868, hair: { style: 'recede', color: 0x3b2a1c }, beard: { style: 'mustache', color: 0x3b2a1c },
    tags: ['中年', '发福'],
  },
  {
    id: 'elder', name: '干瘦老人', note: '瘦到见骨、略微驼背感（头稍大），光头长须',
    height: 1.68, width: 0.90, depth: 0.94,
    base: 'male_shirt',
    body: { shoulder: 0.94, chest: 0.90, waist: 0.92, belly: 0.94, arm: 0.84, leg: 0.88, neck: 0.90, head: 1.02 },
    skin: 0xc9a488, hair: { style: 'bald', color: 0xd8d4cf }, beard: { style: 'long', color: 0xd8d4cf },
    tags: ['老年', '瘦'],
    stats: { staminaDrain: 0.96 },
  },
  {
    id: 'teen', name: '少年', note: '矮、还没长开：头相对大、四肢细',
    height: 1.60, width: 0.93, depth: 0.95,
    base: 'male_casual',
    body: { shoulder: 0.94, chest: 0.93, waist: 0.94, belly: 0.94, arm: 0.88, leg: 0.92, neck: 0.93, head: 1.05 },
    skin: 0xdbad86, hair: { style: 'buzz', color: 0x231811 }, beard: { style: 'none', color: 0x231811 },
    tags: ['少年', '矮个'],
  },
  {
    id: 'veteran', name: '老兵', note: '结实但不夸张，深色皮肤 + 络腮胡',
    height: 1.80, width: 1.04, depth: 1.02,
    base: 'male_shirt',
    body: { shoulder: 1.08, chest: 1.08, waist: 1.0, belly: 1.0, arm: 1.10, leg: 1.06, neck: 1.05, head: 1.0 },
    skin: 0x8c5f3f, hair: { style: 'short', color: 0x171310 }, beard: { style: 'full', color: 0x171310 },
    tags: ['壮', '深肤色'],
    stats: { melee: 1.05 },
  },
  {
    id: 'punk', name: '朋克', note: '瘦而有棱角，莫西干 + 山羊胡',
    height: 1.75, width: 0.96, depth: 0.98,
    base: 'male_casual',
    body: { shoulder: 1.0, chest: 0.97, waist: 0.95, belly: 0.95, arm: 0.94, leg: 0.96, neck: 1.0, head: 1.0 },
    skin: 0xd9b6a0, hair: { style: 'mohawk', color: 0x3f2a4d }, beard: { style: 'goatee', color: 0x1b1418 },
    tags: ['瘦', '个性'],
    stats: { noise: 0.97 },
  },
  {
    id: 'drifter', name: '流浪汉', note: '佝偻消瘦、长发长须、脸色发灰',
    height: 1.70, width: 0.94, depth: 0.96,
    base: 'male_casual',
    body: { shoulder: 0.95, chest: 0.92, waist: 0.96, belly: 1.0, arm: 0.90, leg: 0.92, neck: 1.02, head: 1.0 },
    skin: 0xb79a7f, hair: { style: 'long', color: 0x4a3a2a }, beard: { style: 'long', color: 0x4a3a2a },
    tags: ['瘦', '落魄'],
  },
  {
    id: 'giant', name: '巨汉', note: '最高最宽：肩宽接近人体上限，走动时压迫感最强',
    height: 1.95, width: 1.16, depth: 1.10,
    base: 'male_shirt',
    body: { shoulder: 1.22, chest: 1.16, waist: 1.10, belly: 1.06, arm: 1.24, leg: 1.16, neck: 1.14, head: 1.0 },
    skin: 0xb98457, hair: { style: 'bald', color: 0x2a2019 }, beard: { style: 'full', color: 0x2a2019 },
    tags: ['壮', '高个'],
  },
  {
    id: 'athlete', name: '运动员', note: '高且匀称：肩宽、腰细、腿长（靠整体高个子比值体现）',
    height: 1.87, width: 0.99, depth: 1.0,
    base: 'male_casual',
    body: { shoulder: 1.12, chest: 1.10, waist: 0.94, belly: 0.92, arm: 1.08, leg: 1.06, neck: 1.02, head: 0.98 },
    skin: 0xd2a077, hair: { style: 'ponytail', color: 0x241a12 }, beard: { style: 'none', color: 0x241a12 },
    tags: ['壮', '高个', '青年'],
    stats: { speed: 1.03, stamina: 1.04 },
  },
];

const TEMPLATE_BY_ID = new Map(MALE_TEMPLATES.map((t) => [t.id, t]));

export const MALE_TEMPLATE_KEYS = MALE_TEMPLATES.map((t) => t.id);

export function findTemplate(id) {
  if (!id) return null;
  return TEMPLATE_BY_ID.get(String(id)) || null;
}

/** 按 id/名字做稳定哈希挑一个模板（同一个 NPC id 永远同一个样子）。 */
export function pickTemplate(seed) {
  const s = String(seed == null ? '' : seed);
  if (!s) return MALE_TEMPLATES[0];
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return MALE_TEMPLATES[(h >>> 0) % MALE_TEMPLATES.length];
}

/** 随机一个模板（预览页"随机"按钮用）。 */
export function randomTemplate(rand = Math.random) {
  return MALE_TEMPLATES[Math.min(MALE_TEMPLATES.length - 1, Math.floor(rand() * MALE_TEMPLATES.length))];
}

// ── 形态 → 属性 ──────────────────────────────────────────
// 只有外观差异的模板是"皮肤"，不是玩法。这里把体型换算成**战斗/生存属性乘数**，
// 并且刻意做成"没有白拿的便宜"：块头带来血量/负重/近战，代价是速度/体力/脚步声（更容易被听见）
// 和被命中面积（本来就自动变大，命中盒跟着 height 走）。
//
// 全部从物理量推出来（不逐个手写），所以以后加模板/调体型，属性会自动跟上：
//   体积指数 hit = 身高系数 h³ × 整体宽 × 整体厚 × 平均围度^1.2
//   体重指数 bulk = (hit / 基准) ^ 0.55   ← 0.55 是压缩指数：1.95m 巨汉不该是 1.76m 的 1.8 倍耐打
export const STAT_KEYS = [
  { key: 'health', label: '血量', unit: '×', hint: '最大生命值（块头越大越抗打）' },
  { key: 'stamina', label: '体力上限', unit: '×', hint: '体力池大小' },
  { key: 'staminaDrain', label: '冲刺耗力', unit: '×', hint: '冲刺时体力消耗速度（越大越费）' },
  { key: 'speed', label: '移动速度', unit: '×', hint: '跑/冲刺速度（腿长加成，体重扣分）' },
  { key: 'carry', label: '负重上限', unit: '×', hint: '背包能背多少公斤' },
  { key: 'melee', label: '近战伤害', unit: '×', hint: '拳头/斧头这类近战的伤害' },
  { key: 'recoil', label: '后坐力控制', unit: '×', hint: '块头越大越压得住枪：扩散与镜头后坐都更小' },
  { key: 'noise', label: '脚步声', unit: '×', hint: '移动噪音（AI 听觉听见你的半径，越大越吵）' },
  { key: 'jump', label: '跳跃力', unit: '×', hint: '起跳初速度' },
];

/** 基准模板的物理指数（标准体格 1.76m / 宽厚 1.0 / 围度 1.0）。属性以它为 1.0。 */
const BASE_HIT = Math.pow(1.76 / 1.78, 3) * 1.0 * 1.0 * 1.0;

const GIRTH_KEYS = ['arm', 'leg', 'chest', 'waist', 'belly', 'neck'];

/** 模板 → 物理量（纯函数，给属性推导与调试面板共用）。 */
export function physicsOf(def) {
  const b = (def && def.body) || {};
  const h = (Number(def && def.height) > 0.5 ? Number(def.height) : 1.78) / 1.78;
  const width = Math.min(1.6, Math.max(0.6, Number(def && def.width) || 1));
  const depth = Math.min(1.6, Math.max(0.6, Number(def && def.depth) || 1));
  const girth = GIRTH_KEYS.reduce((s, k) => s + (Number(b[k]) || 1), 0) / GIRTH_KEYS.length;
  const hit = Math.pow(h, 3) * width * depth * Math.pow(girth, 1.2);   // 近似体积
  const bulk = Math.pow(hit / BASE_HIT, 0.55);                        // 体重/块头指数（压缩过）
  // 被命中面积 ≈ 身高² × 宽 × 深（命中盒本来就随 height/width 放大，这里只是把它量化出来）
  const areaStd = Math.pow(1.76 / 1.78, 2) * 1.0 * 1.0;
  const area = (h * h * width * depth) / areaStd;
  return {
    h: +h.toFixed(4),
    width, depth,
    girth: +girth.toFixed(4),
    hit: +hit.toFixed(4),
    bulk: +bulk.toFixed(4),
    area: +area.toFixed(4),
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * 模板 → 属性乘数。**属性是推导出来的，不是逐个手写**，但每个模板可以用 `stats` 字段微调
 * （例如老兵近战 +4%、运动员速度 +3%），用来表达"体型之外"的身份差异。
 * @param {object|string} defOrId
 * @returns {{bulk:number, area:number, health:number, stamina:number, staminaDrain:number,
 *            speed:number, carry:number, melee:number, noise:number, jump:number, power:number, profile:object}}
 */
export function deriveStats(defOrId) {
  const def = typeof defOrId === 'string' ? findTemplate(defOrId) : defOrId;
  if (!def) return null;
  const p = physicsOf(def);
  const b = p.bulk - 1;   // 0 = 标准体格

  const out = {
    // 块头 → 血量/负重/近战/噪音（线性，然后夹紧；宁可温和也别让巨汉无敌）
    health: clamp(1 + 0.30 * b, 0.86, 1.20),
    stamina: clamp(1 + 0.10 * b, 0.92, 1.10),
    staminaDrain: clamp(1 + 0.35 * b, 0.85, 1.20),
    carry: clamp(1 + 0.30 * b, 0.85, 1.22),
    melee: clamp(1 + 0.32 * b, 0.85, 1.20),
    noise: clamp(1 + 0.40 * b, 0.80, 1.25),
    // 速度：腿长（身高）给一点加成，体重扣分更多 —— 矮壮/发福/巨汉都该慢下来
    speed: clamp(1 + 0.09 * (p.h - 1) - 0.26 * b, 0.86, 1.08),
    // 后坐力控制：块头越大，枪的后坐越压得住（这是"大块头"在射击玩法里的正面筹码）
    recoil: clamp(1 + 0.22 * b, 0.86, 1.16),
    // 跳跃：个子高一点弹得高，体重大扣
    jump: clamp(1 + 0.05 * (p.h - 1) - 0.10 * b, 0.88, 1.06),
  };

  // 模板自带微调（只允许小幅，避免把推导出来的平衡打破）
  const over = def.stats || {};
  for (const k of Object.keys(out)) {
    const v = Number(over[k]);
    if (Number.isFinite(v) && v > 0) out[k] = clamp(out[k] * v, 0.8, 1.3);
  }

  // 平衡分：8 项属性取 log 求和，再扣掉"被命中面积变大"的代价（0 = 没有净优势）。
  // 只用于展示与测试，不影响玩法；权重 0.5 是经验值（体积惩罚比属性收益更直观）。
  const keys = STAT_KEYS.map((s) => s.key);
  const power = keys.reduce((s, k) => s + Math.log(out[k]), 0) / keys.length
    - 0.5 * Math.log(p.area);
  const res = { bulk: p.bulk, area: p.area, power: r3(power), profile: p };
  for (const k of keys) res[k] = r3(out[k]);
  return res;
}

/** 给"展示用"的一句话评价（预览页/创建页里显示）。 */
export function describeStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.health >= 1.06) parts.push('厚血');
  else if (stats.health <= 0.95) parts.push('脆皮');
  if (stats.speed >= 1.03) parts.push('腿快');
  else if (stats.speed <= 0.95) parts.push('笨重');
  if (stats.carry >= 1.06) parts.push('能背');
  if (stats.melee >= 1.06) parts.push('重拳');
  if (stats.noise >= 1.06) parts.push('吵');
  else if (stats.noise <= 0.95) parts.push('轻脚');
  if (stats.area >= 1.1) parts.push('好打中');
  else if (stats.area <= 0.92) parts.push('难打中');
  return parts.join(' · ');
}

/** 模板是否合法（供测试与编辑器校验）。返回问题列表。 */
export function validateTemplate(t) {
  const out = [];
  if (!t || typeof t !== 'object') return ['模板不是对象'];
  if (!t.id || typeof t.id !== 'string') out.push('缺少 id');
  if (!t.name) out.push('缺少 name');
  if (!(t.height >= 1.4 && t.height <= 2.2)) out.push(`height 越界: ${t.height}`);
  for (const k of ['width', 'depth']) {
    if (!(t[k] >= 0.7 && t[k] <= 1.5)) out.push(`${k} 越界: ${t[k]}`);
  }
  if (!t.body || typeof t.body !== 'object') out.push('缺少 body');
  else {
    for (const k of ['shoulder', 'chest', 'waist', 'belly', 'arm', 'leg', 'neck', 'head']) {
      const v = t.body[k];
      if (!(v >= 0.6 && v <= 1.6)) out.push(`body.${k} 越界: ${v}`);
    }
  }
  if (!t.hair || !HAIR_BY_KEY.has(t.hair.style)) out.push(`未知发型: ${t.hair && t.hair.style}`);
  if (!t.beard || !BEARD_BY_KEY.has(t.beard.style)) out.push(`未知胡子: ${t.beard && t.beard.style}`);
  if (!Number.isFinite(t.skin)) out.push('缺少 skin 颜色');
  return out;
}

// ── 头部量测 ────────────────────────────────────────────

const frameCache = new Map();

/**
 * 量头部：给出发型/胡子用的锚点，以及一份"头部顶点在头骨局部空间里的坐标 + 三角形表"。
 *
 * 必须走真实蒙皮公式：这份 FBX 载入后的姿势和烘焙的 bind 姿态不一致，
 * 直接拿顶点坐标当"静止姿态"会量到脚底去（踩过这个坑）。
 * 顶点表是给胡子用的：胡子不是飘在脸前面的方块，而是**照着脸上的三角面**生成的一层壳
 * （见 buildBeardShell），这样才贴得住下颌线。
 * @returns {{x0,x1,y0,y1,z0,z1,source:string, hv?:Float32Array, tris?:Uint32Array, center?:number[]}}
 */
export function measureHeadFrame(THREE, model) {
  const cacheKey = (model && (model.templateKey || (model.mesh && model.mesh.geometry && model.mesh.geometry.uuid))) || null;
  if (cacheKey && frameCache.has(cacheKey)) return frameCache.get(cacheKey);

  const mesh = model && model.mesh;
  const head = model && model.bones && model.bones.head;
  const frame = (() => {
    if (!mesh || !head || !mesh.isSkinnedMesh || !mesh.geometry) return null;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const si = geo.getAttribute('skinIndex');
    const sw = geo.getAttribute('skinWeight');
    const skel = mesh.skeleton;
    if (!pos || !si || !sw || !skel || !skel.bones.length) return null;

    // 整棵树的矩阵都要是最新的：蒙皮公式要用到每根影响骨骼的 matrixWorld，
    // 只更新 head 的祖先是不够的（量出来整个人会掉到脚底 —— 踩过这个坑）。
    if (model.group && model.group.updateMatrixWorld) model.group.updateMatrixWorld(true);
    else mesh.updateWorldMatrix(true, false);
    skel.update();
    head.updateWorldMatrix(true, false);
    const headInv = head.matrixWorld.clone().invert();
    const bind = mesh.bindMatrix;
    const bindInv = mesh.bindMatrixInverse;
    const mw = mesh.matrixWorld;

    const p = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const acc = new THREE.Vector3();
    const box = new THREE.Box3();
    // 原顶点索引 → 头局部坐标（只有"主导骨骼是 Head 且权重 > 0.5"的顶点收进来）
    const local = new Float32Array(pos.count * 3);
    const isHead = new Uint8Array(pos.count);
    let count = 0;
    for (let i = 0; i < pos.count; i += 1) {
      const ws = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
      const bi = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)];
      let best = -1; let bestW = -1;
      for (let k = 0; k < 4; k += 1) if (ws[k] > bestW) { bestW = ws[k]; best = bi[k]; }
      const bone = skel.bones[best];
      if (!bone || !/^head$/i.test(bone.name || '') || bestW <= 0.5) continue;
      p.fromBufferAttribute(pos, i).applyMatrix4(bind);
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k += 1) {
        if (!ws[k]) continue;
        const b2 = skel.bones[bi[k]];
        if (!b2) continue;
        tmp.copy(p).applyMatrix4(skel.boneInverses[bi[k]]).applyMatrix4(b2.matrixWorld);
        acc.addScaledVector(tmp, ws[k]);
      }
      acc.applyMatrix4(bindInv).applyMatrix4(mw).applyMatrix4(headInv);
      box.expandByPoint(acc);
      local[i * 3] = acc.x; local[i * 3 + 1] = acc.y; local[i * 3 + 2] = acc.z;
      isHead[i] = 1;
      count += 1;
    }
    if (count < 50 || !Number.isFinite(box.min.y)) return null;
    const size = box.getSize(new THREE.Vector3());
    if (!(size.x > 1e-3 && size.y > 1e-3 && size.z > 1e-3)) return null;

    // 三角形表：整个三角面都在头部（三个顶点都是 Head 主导）才收
    const idx = geo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const hv = new Float32Array(count * 3);
    const remap = new Int32Array(pos.count).fill(-1);
    let n = 0;
    const keep = [];
    for (let t = 0; t < triCount; t += 1) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      if (!isHead[i0] || !isHead[i1] || !isHead[i2]) continue;
      keep.push(i0, i1, i2);
      for (const v of [i0, i1, i2]) {
        if (remap[v] < 0) {
          remap[v] = n;
          hv[n * 3] = local[v * 3]; hv[n * 3 + 1] = local[v * 3 + 1]; hv[n * 3 + 2] = local[v * 3 + 2];
          n += 1;
        }
      }
    }
    const tris = new Uint32Array(keep.length);
    for (let k = 0; k < keep.length; k += 1) tris[k] = remap[keep[k]];

    return {
      x0: box.min.x, x1: box.max.x,
      y0: box.min.y, y1: box.max.y,
      z0: box.min.z, z1: box.max.z,
      source: 'measured',
      hv: hv.subarray(0, n * 3),
      tris,
      center: [(box.min.x + box.max.x) * 0.5, box.min.y + size.y * 0.45, (box.min.z + box.max.z) * 0.5],
    };
  })();

  const out = frame || { ...HEAD_FRAME_FALLBACK };
  if (cacheKey) frameCache.set(cacheKey, out);
  return out;
}

/** 头部量测 → 发型/胡子构造用的锚点。 */
export function anchorsFromFrame(frame) {
  const f = frame || HEAD_FRAME_FALLBACK;
  const W = f.x1 - f.x0;
  const H = f.y1 - f.y0;
  const D = f.z1 - f.z0;
  return {
    W, H, D,
    cx: (f.x0 + f.x1) * 0.5,
    left: f.x0, right: f.x1,
    chin: f.y0, top: f.y1,
    back: f.z0, front: f.z1,
    // 实测比例：下巴 0.00、嘴 0.162H、鼻尖 0.295H、眼 0.465H（男性四个模型都一样）
    mouth: f.y0 + H * 0.162,
  };
}

// ── 骨骼变形 ────────────────────────────────────────────

/** 骨骼局部轴在模型空间的方向（归一化，缩放不影响方向）。
 *  缓存一次：一旦父骨骼被非均匀缩放，子骨骼的 matrixWorld 轴会被拉歪，
 *  第二次套模板就会算出不同的结果（不幂等）。骨骼的**朝向**在被缩放前是固定的，取第一次的即可。 */
const axesCache = new WeakMap();
function boneAxes(THREE, bone) {
  const hit = axesCache.get(bone);
  if (hit) return hit;
  bone.updateWorldMatrix(true, false);
  const e = bone.matrixWorld.elements;
  const v = (i) => new THREE.Vector3(e[i], e[i + 1], e[i + 2]).normalize();
  const axes = [v(0), v(4), v(8)];
  axesCache.set(bone, axes);
  return axes;
}

/** 模板里某根骨骼的期望世界轴倍数。 */
function targetFor(def, boneName) {
  const spec = BONE_MORPH[boneName];
  if (!spec) return null;
  const b = def.body || {};
  const pick = (k) => {
    const v = Number(b[spec[k]]);
    return Number.isFinite(v) ? Math.min(1.6, Math.max(0.6, v)) : 1;
  };
  return [
    spec.x ? pick('x') : 1,
    spec.y ? pick('y') : 1,
    spec.z ? pick('z') : 1,
  ];
}

/**
 * 按模板改骨骼缩放，做出体型差异。
 * 自顶向下累积"祖先已经施加了多少世界轴缩放"，再把剩余量分到当前骨骼的局部轴上 ——
 * 这样"加宽胸"不会连带把胳膊和头一起放大（实测那是最容易出错的点）。
 * @returns {{applied: object, warnings: string[]}}
 */
export function applyBodyMorph(THREE, model, def) {
  const applied = {};
  const worldFactors = {};
  const warnings = [];
  const bones = (model && model.bones) || {};
  const factors = new Map(); // bone(Object3D) → [x,y,z] 已施加的世界轴倍数

  const inheritedOf = (bone) => {
    const out = [1, 1, 1];
    let p = bone.parent;
    let guard = 0;
    while (p && guard < 64) {
      const f = factors.get(p);
      if (f) { out[0] *= f[0]; out[1] *= f[1]; out[2] *= f[2]; }
      p = p.parent;
      guard += 1;
    }
    return out;
  };

  for (const name of MORPH_ORDER) {
    const bone = bones[name];
    const target = targetFor(def, name);
    if (!bone || !target) continue;
    if (![target[0], target[1], target[2]].every(Number.isFinite)) { warnings.push(`${name}: 倍数非法`); continue; }

    const inherited = inheritedOf(bone);
    const axes = boneAxes(THREE, bone);
    // 骨骼局部轴不一定和世界轴对齐（上臂的局部 X 其实朝着世界 +Z，Z 朝着世界 +X）。
    // 做法：每个局部轴按"最接近哪个世界轴"领取那一轴的目标倍数，再补偿已继承的量。
    const need = [0, 1, 2].map((k) => {
      const ax = axes[k];
      let best = 0;
      let bestAbs = -1;
      for (let j = 0; j < 3; j += 1) {
        const a = Math.abs(ax.getComponent(j));
        if (a > bestAbs) { bestAbs = a; best = j; }
      }
      const t = target[best] / (inherited[best] || 1);
      return Math.min(2.2, Math.max(0.45, t));
    });
    bone.scale.set(need[0], need[1], need[2]);
    // 该骨骼在世界上实际产生的倍数：A = R·D·Rᵀ 的对角线长度（近似，轴近似正交时够准）
    const world = [0, 1, 2].map((j) => {
      let s = 0;
      for (let k = 0; k < 3; k += 1) {
        const c = axes[k].getComponent(j) * need[k];
        s += c * c;
      }
      return Math.sqrt(s);
    });
    factors.set(bone, [inherited[0] * world[0], inherited[1] * world[1], inherited[2] * world[2]]);
    applied[name] = need.map((n) => +n.toFixed(3));
    // 对外报的是"世界轴上的有效倍数"（已经把祖先继承算进去），模板里写多少它就该是多少
    worldFactors[name] = factors.get(bone).map((n) => +n.toFixed(3));
  }

  for (const name of MORPH_ORDER) {
    const t = targetFor(def, name);
    if (t && !bones[name]) warnings.push(`模板 ${def.id}: 骨架缺 ${name}，该部位不生效`);
  }
  return { applied, worldFactors, warnings };
}

// ── 材质染色 ────────────────────────────────────────────

function eachMaterial(mesh, fn) {
  if (!mesh) return;
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  list.forEach(fn);
}

function applyLook(THREE, model, def, hairStyle) {
  const skin = new THREE.Color(Number.isFinite(def.skin) ? def.skin : 0xd3a173);
  const hairColor = new THREE.Color(Number.isFinite(def.hair.color) ? def.hair.color : 0x2b1d14);
  const beardColor = new THREE.Color(Number.isFinite(def.beard.color) ? def.beard.color : 0x2b1d14);
  const capColor = hairStyle && hairStyle.cap === 'skin' ? skin : hairColor;
  const touched = { skin: 0, hair: 0, eyes: 0 };

  const visit = (mesh) => eachMaterial(mesh, (m) => {
    if (!m || !m.name) return;
    if (/^skin$/i.test(m.name)) { m.color.copy(skin); touched.skin += 1; }
    else if (/^hair/i.test(m.name)) { m.color.copy(capColor); m.flatShading = false; touched.hair += 1; }
    // Eyes / Shirt / Pants / Socks / Shoes 不动：球衣是 applyKitTexture 的地盘，动了会串色。
  });
  visit(model.mesh);
  (model.skinnedMeshes || []).forEach((m) => { if (m !== model.mesh) visit(m); });
  return { skin, hairColor, beardColor, capColor, touched };
}

// ── 发型 / 胡子几何 ─────────────────────────────────────

function boxesToGeometry(THREE, boxes) {
  const geos = [];
  for (const b of boxes) {
    if (!b) continue;
    const w = Math.max(0.004, b.w || 0.01);
    const h = Math.max(0.004, b.h || 0.01);
    const d = Math.max(0.004, b.d || 0.01);
    const g = new THREE.BoxGeometry(w, h, d);
    if (b.rx) g.rotateX(b.rx);
    if (b.ry) g.rotateY(b.ry);
    if (b.rz) g.rotateZ(b.rz);
    g.translate(b.x || 0, b.y || 0, b.z || 0);
    geos.push(g);
  }
  if (!geos.length) return null;
  // 手动合并（这几种盒子都是非索引的 36 顶点，合并后仍是 1 个 draw call）
  let total = 0;
  const parts = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    total += ng.getAttribute('position').count;
    return ng;
  });
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let off = 0;
  for (const g of parts) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    position.set(p.array, off * 3);
    normal.set(n.array, off * 3);
    off += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.computeBoundingSphere();
  return out;
}

/**
 * 胡子壳：把脸上"命中判定"的那一层三角面挑出来，沿"从头心往外"的方向推出去一点点。
 * 为什么这么做：低多边形脸的下颌线是斜的，用盒子拼永远会露出"口罩感"；
 * 借用脸本身的三角面，胡子就自然贴着下巴。判定走三角形重心，边界跟着网格走（正好符合硬边风格）。
 */
function buildBeardShell(THREE, frame, spec, anchors) {
  if (!spec || !frame || !frame.hv || !frame.tris || !frame.center) return null;
  const hv = frame.hv;
  const tris = frame.tris;
  const [cx, cy, cz] = frame.center;
  const off = Number.isFinite(spec.offset) ? spec.offset : 0.008;
  const out = [];
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t] * 3; const ib = tris[t + 1] * 3; const ic = tris[t + 2] * 3;
    // 用重心判定：整片三角面要么算胡子要么不算，避免在面内切出锯齿
    const mx = (hv[ia] + hv[ib] + hv[ic]) / 3;
    const my = (hv[ia + 1] + hv[ib + 1] + hv[ic + 1]) / 3;
    const mz = (hv[ia + 2] + hv[ib + 2] + hv[ic + 2]) / 3;
    if (!spec.pred(mx, my, mz, anchors)) continue;
    for (const i of [ia, ib, ic]) {
      const x = hv[i]; const y = hv[i + 1]; const z = hv[i + 2];
      let dx = x - cx; let dy = y - cy; let dz = z - cz;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      out.push(x + dx * off, y + dy * off, z + dz * off);
    }
  }
  if (!out.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return { geo, tris: out.length / 9 };
}

/**
 * 挂发型/胡子：几何长在「头骨局部空间」里，作为 Head 骨骼的子节点 —— 头转到哪它跟到哪，
 * 不像之前那版把盒子钉在世界坐标上跟着头骨"平移"（那样一低头就穿帮）。
 */
function buildHeadgear(THREE, model, def, frame) {
  const head = model && model.bones && model.bones.head;
  if (!head) return { ok: false, reason: '没有 head 骨骼' };
  const hairStyle = HAIR_BY_KEY.get(def.hair.style) || HAIR_BY_KEY.get('short');
  const beardStyle = BEARD_BY_KEY.get(def.beard.style) || BEARD_BY_KEY.get('none');
  const a = anchorsFromFrame(frame);

  const hairBoxes = hairStyle.boxes ? (hairStyle.boxes(a) || []) : [];
  const beardBoxes = beardStyle.boxes ? (beardStyle.boxes(a) || []) : [];
  const hairGeo = boxesToGeometry(THREE, hairBoxes);
  const beardBoxGeo = boxesToGeometry(THREE, beardBoxes);
  const shell = buildBeardShell(THREE, frame, beardStyle.shell, a);
  // 注意：染色必须在"没有额外几何就提前返回"之前做 —— 寸头/光头配无胡子时没有挂件，
  // 但肤色和发色照样要按模板刷（少年模板就是 寸头+无胡子，漏了这步会留成模型原始深肤色）。
  const look = applyLook(THREE, model, def, hairStyle);
  if (!hairGeo && !beardBoxGeo && !shell) {
    return { ok: true, boxes: 0, hairBoxes: 0, beardBoxes: 0, beardTris: 0, root: null, frame, hairStyle: hairStyle.key, beardStyle: beardStyle.key, look };
  }

  const root = new THREE.Group();
  root.name = 'headgear';
  const stat = { hairBoxes: 0, beardBoxes: 0, beardTris: 0 };
  const add = (geo, color, name) => {
    if (!geo) return null;
    const mat = new THREE.MeshLambertMaterial({
      color: color.clone(),
      flatShading: true,
      // 贴脸的胡子壳和脸几乎共面：polygonOffset 往镜头方向拉一点深度，避免 z-fighting 斑块
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = false;
    m.frustumCulled = true;
    root.add(m);
    return m;
  };
  add(hairGeo, look.hairColor, 'hair');
  add(beardBoxGeo, look.beardColor, 'beard');
  if (shell) add(shell.geo, look.beardColor, 'beardShell');
  stat.hairBoxes = hairBoxes.length;
  stat.beardBoxes = beardBoxes.length;
  stat.beardTris = shell ? shell.tris : 0;

  head.add(root);
  return { ok: true, root, ...stat, frame, hairStyle: hairStyle.key, beardStyle: beardStyle.key, look };
}

// ── 主入口 ──────────────────────────────────────────────

/**
 * 把一个模板套到 CharacterFactory.create() 出来的模型上。
 * 可重复调用（会先清掉上一次的 headgear；骨骼缩放是绝对值，不会累乘）。
 * @param {object} THREE
 * @param {object} model 工厂 create() 的返回值
 * @param {object|string} template 模板对象或模板 id
 * @param {object} opts { skipHeadgear?:boolean }
 * @returns {{ok:boolean, reason?:string, template:string, height:number, warnings:string[], report:object}}
 */
export function applyMaleTemplate(THREE, model, template, opts = {}) {
  const warnings = [];
  if (!model || !model.group) return { ok: false, reason: '模型不可用', template: null, warnings };
  const def = typeof template === 'string' ? findTemplate(template) : (template || findTemplate('standard'));
  if (!def) return { ok: false, reason: `找不到模板: ${template}`, template: null, warnings };

  const problems = validateTemplate(def);
  if (problems.length) warnings.push(...problems);

  const baseHeight = Number(model.baseHeight) > 0.5 ? Number(model.baseHeight)
    : (Number(model.height) > 0.5 ? Number(model.height) : 1.78);
  // 记住"未套模板时的高度"：换模板/重复套用都要以它为基准，否则第二次会把 1.95 当成原始身高再缩一次。
  if (!(Number(model.baseHeight) > 0.5)) model.baseHeight = baseHeight;
  const heightScale = def.height / baseHeight;
  const baseEye = Number(model.baseEyeHeight) > 0.5 ? Number(model.baseEyeHeight)
    : (Number(model.eyeHeight) > 0.5 ? Number(model.eyeHeight) : baseHeight * 0.93);
  if (!(Number(model.baseEyeHeight) > 0.5)) model.baseEyeHeight = baseEye;

  // ① 先量头（缩放之前量，量到的才是"干净"的头骨局部坐标）
  const frame = measureHeadFrame(THREE, model);

  // ② 体型：骨骼级世界轴缩放
  const morph = applyBodyMorph(THREE, model, def);
  warnings.push(...morph.warnings);

  // ③ 身高 / 整体宽厚：外层缩放（世界对齐，不影响蒙皮）
  const g = model.group;
  const sx = heightScale * (def.width || 1);
  const sy = heightScale;
  const sz = heightScale * (def.depth || 1);
  g.scale.set(sx, sy, sz);
  model.height = def.height;
  model.eyeHeight = baseEye * heightScale;
  model.userData = Object.assign({}, model.userData, {
    maleTemplate: def.id,
    maleTemplateHeight: def.height,
    maleTemplateScale: [sx, sy, sz],
  });

  // ④ 形态属性：挂在 model 上，玩家/NPC 建号时直接读，不用再算一遍
  const statsNow = deriveStats(def);
  model.templateStats = statsNow;

  // ⑤ 头发/胡子（旧的要先拆掉，避免叠加）
  let gear = null;
  if (!opts.skipHeadgear) {
    const old = model.bones && model.bones.head && model.bones.head.getObjectByName('headgear');
    if (old) {
      old.parent.remove(old);
      old.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      if (Array.isArray(model.attachments)) {
        const i = model.attachments.indexOf(old);
        if (i >= 0) model.attachments.splice(i, 1);
      }
    }
    gear = buildHeadgear(THREE, model, def, frame);
    if (!gear.ok) warnings.push(gear.reason);
    else if (gear.root) {
      model.attachments = model.attachments || [];
      model.attachments.push(gear.root);
    }
  } else {
    applyLook(THREE, model, def, HAIR_BY_KEY.get(def.hair.style));
  }

  // 让包围盒/骨骼矩阵立刻是对的（角色当帧就要能正确剔除与命中）
  g.updateMatrixWorld(true);

  return {
    ok: true,
    template: def.id,
    name: def.name,
    height: def.height,
    warnings,
    report: {
      template: def.id,
      height: +def.height.toFixed(3),
      scale: [+sx.toFixed(3), +sy.toFixed(3), +sz.toFixed(3)],
      bones: morph.applied,
      worldFactors: morph.worldFactors,
      headFrame: { w: +(frame.x1 - frame.x0).toFixed(4), h: +(frame.y1 - frame.y0).toFixed(4), d: +(frame.z1 - frame.z0).toFixed(4), source: frame.source },
      hair: def.hair.style,
      beard: def.beard.style,
      stats: statsNow,
      hairBoxes: gear ? gear.hairBoxes : 0,
      beardBoxes: gear ? gear.beardBoxes : 0,
    },
  };
}

export default {
  MALE_TEMPLATES, MALE_TEMPLATE_KEYS, HAIR_STYLES, BEARD_STYLES, HEAD_FRAME_FALLBACK, STAT_KEYS,
  findTemplate, pickTemplate, randomTemplate, validateTemplate,
  physicsOf, deriveStats, describeStats,
  measureHeadFrame, anchorsFromFrame, applyBodyMorph, applyMaleTemplate,
};
