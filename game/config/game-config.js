// 游戏全部可调参数的唯一来源。原则：
// 1) 每个字段都有默认值 —— 任何模块拿不到配置也能跑；
// 2) 数值型字段统一经过 num() 夹紧，避免 NaN 传进主循环把场景炸掉；
// 3) 画质/NPC 数量等"性能旋钮"集中在这里，UI 设置面板直接改这里并存档。

export const CONFIG_VERSION = 4;

/** 季节名（与 world/trees.js 的 SEASONS 一致；这里不 import 是为了让配置模块保持零依赖）。 */
const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'];

/** 天气 id（与 world/weather.js 的 WEATHERS 一致；同样为了零依赖在这里复制一份）。 */
const WEATHER_NAMES = ['clear', 'cloudy', 'overcast', 'fog', 'drizzle', 'rain', 'storm', 'snow', 'blizzard'];

/** 中国地区（与 world/trees.js 的 TREE_REGIONS 一致；零依赖所以在这里复制一份键名）。 */
const REGION_NAMES = ['temperate', 'northeast', 'north', 'jiangnan', 'south', 'southwest', 'northwest'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** 容忍字符串/NaN/undefined 的数字解析。 */
export function num(v, fallback, lo = -Infinity, hi = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, lo, hi);
}

export function bool(v, fallback) {
  if (v === true || v === 'true' || v === 1) return true;
  if (v === false || v === 'false' || v === 0) return false;
  return fallback;
}

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  seed: 20260801,

  world: {
    size: 340,            // 地图边长（米），正方
    cell: 2,              // 导航网格格子边长
    townRadius: 130,      // 城镇半径
    buildingCount: 44,    // 可进入建筑数量（道具包的房子是 5~14m 的窄街屋，比原来的 10~20m 方块小，所以要更多才像镇子）
    roadWidth: 9,
    blockSize: 52,        // 街区尺寸
    treeCount: 300,       // 镇子里的树（真实树木模型 8~10m 高，密度按 Area 适中）
    wildTrees: 12000,     // 镇外按土地覆盖撒的"野树"（真实地形模式才有；实例化渲染，几乎不花 draw call）
    carCount: 14,
    crateCount: 40,
    districtCount: 4,
    streetKit: true,      // 用道具包的 Modular Streets 铺路面（false 则退回程序化沥青面）
    streetScale: 0,       // 街道模块半宽（米）；0 = 自动（roadWidth × 2/3）
    streetlightStep: 44,  // 路灯间距（米），0 附近会自动夹到最小 8
    streetlights: true,   // 是否沿路摆路灯
    // ── 四季（只换树木几何 + 环境色，不改布局；见 world/season.js）
    season: 'summer',     // 开局季节：spring / summer / autumn / winter
    seasonsEnabled: true, // 是否随天数自动推进季节
    daysPerSeason: 3,     // 每个季节持续几个游戏日（1 天 = 15 分钟实时）
    // ── 天气（纯数值状态机 + GPU 粒子；见 world/weather.js / weather-visuals.js）
    weatherEnabled: true, // 关掉后永远晴天（粒子、雾、雷都不工作）
    weatherMode: 'auto',  // 'auto' = 按季节权重自动推进；也可以是天气 id（固定天气，调试/截图用）
    weatherScale: 1,      // 天气持续时长倍率（0.2 = 天气换得很快，4 = 一整天都很阴）
    // ── 中国气候带（决定树的物种混交；见 world/trees.js 的 TREE_REGIONS 与 docs/CHINA-TREES.md）
    // temperate = 原来的温带混交（默认，老地图不变）；其余六个是中国地区。
    region: 'temperate',
  },

  // ── 真实地形（Copernicus DEM 30m + ESA WorldCover 10m + HydroRIVERS，见 docs/TERRAIN.md）
  // 数据由 tools/bake-terrain.mjs 离线烘焙到 dist/data/terrain/<名字>/，运行时只加载 3 个小文件。
  // 关掉（enabled:false）或数据缺失 → 自动退回原来那块平地，不影响其它玩法。
  terrain: {
    enabled: true,
    url: 'data/terrain/dujiangyan', // 相对 dist/ 的路径
  },

  // ── 真实路网（OpenStreetMap → tools/bake-roads.mjs → dist/data/roads/）
  // 镇内仍然是道具包「道路」的模块化街网；镇外是 OSM 的真实道路（国道/省道/县道/村道/高速），
  // 按等级自动套用断面与模板风格，桥/隧道/匝道按 OSM 的 bridge/tunnel/layer 处理。
  // 见 docs/ROAD-NETWORK.md
  roads: {
    enabled: true,
    url: 'data/roads/dujiangyan.json',
    lights: true,     // 沿城镇道路摆路灯（用道具包的 Streetlight 模型）
    signs: true,      // 路口放信号灯/停车牌（用道具包的 TrafficLight / Sign_Stop 模型）
    connectors: true, // 镇界断点接一条引道到镇上最近一条街（"城市道路入口"）
  },

  player: {
    eyeHeight: 1.62,
    crouchEyeHeight: 1.05,
    radius: 0.34,
    height: 1.75,
    walkSpeed: 3.1,
    runSpeed: 5.6,
    sprintSpeed: 8.2,
    crouchSpeed: 1.7,
    aimSpeed: 1.5,
    jumpVelocity: 6.2,
    gravity: 20,
    stepHeight: 0.45,
    maxHealth: 100,
    maxHunger: 100,
    maxThirst: 100,
    // 饥饿/口渴速率：0.105/s ≈ 16 分钟见底、0.15/s ≈ 11 分钟见底，
    // 一次正餐（罐头 42）约顶 6~7 分钟 —— 具体见 docs/食物功效设计.md 的节奏预算。
    hungerRate: 0.105,
    thirstRate: 0.15,
    sprintStaminaCost: 18,
    staminaRegen: 12,
    maxStamina: 100,
    // 食物功效系统（items/consumables.js）：关掉 enabled 就退回"只加饱食/水分"的旧行为
    foodEffects: {
      enabled: true,
      lowHunger: 25,          // 饱食低于它 → 体力恢复变慢（低血糖）
      lowHungerRegenMul: 0.7,
      lowThirst: 25,          // 口渴低于它 → 冲刺更累（脱水）
      lowThirstSprintMul: 1.15,
      starvingDps: 1.2,       // 饱食/口渴归零的掉血
      overeatAbove: 85,       // 饱食高于它还硬吃 → 吃撑
      overeatStamina: 8,
      overeatThirst: 6,
      naturalRegen: 0.9,      // 吃饱喝足的自然回血
    },
    interactRange: 2.6,
    fallDamagePerMeter: 9,
    deathRespawnSeconds: 4,
  },

  camera: {
    fov: 72,
    near: 0.06,
    far: 520,
    thirdDistance: 3.2,
    thirdHeight: 0.35,
    shoulderOffset: 0.55,
    minPitch: -1.15,
    maxPitch: 1.15,
    sensitivity: 0.0022,
    tpCollisionPadding: 0.35,
    switchLerpSpeed: 9,
  },

  ai: {
    maxZombies: 34,
    maxFriendlies: 10,
    maxHostiles: 8,
    spawnRadiusMin: 26,
    spawnRadiusMax: 95,
    despawnRadius: 130,
    nearUpdateDistance: 26,     // 米内：高频
    midUpdateDistance: 65,      // 米内：中频
    nearHz: 20,
    midHz: 6,
    farHz: 1.5,
    animDistance: 45,           // 超出后停骨骼动画
    sightRange: 28,
    sightFov: 2.2,              // 弧度，约 126 度
    hearingRange: 22,
    loseSightGrace: 4.5,
    searchTime: 9,
    corpseLifetime: 45,
    meleeReach: 1.9,
    attackCooldown: 1.1,
  },

  combat: {
    headshotMultiplier: 2.1,
    limbMultiplier: 0.72,
    npcAccuracy: 0.62,
    maxHitscanRange: 220,      // 要装得下狙击枪的 220m 有效射程
    tracerTime: 0.06,
    // ── 枪械功效（结算在 combat/ballistics.js，参数在 weapons.js）──
    pierceDamageMul: 0.6,      // 每穿透一层目标，伤害乘这个数
    bleedEnabled: true,        // 流血 DOT 总开关
    staggerEnabled: true,      // 命中硬直总开关
    heatDecay: 1.8,            // 连发散热速度（每秒）
  },

  items: {
    maxWeight: 24,             // 公斤
    stackSize: 12,
    quickSlots: 6,
    lootRespawnSeconds: 150,
    pickupRange: 2.8,
  },

  vehicles: {
    maxSpeed: 19,
    reverseSpeed: 7,
    acceleration: 11,
    brakeForce: 18,
    drag: 0.72,
    steerRate: 1.7,
    maxDurability: 180,
    crashDamageSpeed: 7,

    // ── 使用系统（docs/VEHICLES.md）：油 / 引擎噪音 / 撞击 / 车灯 / 维修 ──
    fuelBurnIdle: 0.10,        // %/秒：引擎怠速（原地不动也在烧）
    fuelBurnPerSpeed: 0.022,   // %/秒，每 1 m/s → 19m/s 时约 0.52%/s（满箱 ≈ 3~4 公里）
    fuelCanAmount: 45,         // 一桶汽油加 45%
    fuelLowPct: 15,            // 低于这个油量 HUD 变红、并且发动会提示
    refuelRange: 3.8,          // 站多近才能给车加油
    repairScrapCost: 2,        // 一次维修消耗几块废金属
    repairPerScrap: 18,        // 每块废金属回复多少耐久
    repairMaxPct: 0.85,        // 维修最多修到 85%（永远修不成新车）
    repairRange: 3.8,
    ramMinSpeed: 4.5,          // 低于此速度只是"顶开"，不造成伤害
    ramDamagePerSpeed: 9,      // 伤害 = (速度 - ramMinSpeed) × 9
    ramDurabilityCost: 0.6,    // 每撞一次自身掉的耐久系数
    ramKnockback: 1.5,
    engineNoiseInterval: 1.1,  // 秒：每隔这么久向 AI 广播一次引擎噪音
    engineNoiseIdle: 0.9,      // 噪音强度（1=脚步，4=枪声）
    engineNoiseDrive: 1.9,     // 全速时的噪音强度
    enginePulseInterval: 0.46, // 引擎声脉冲间隔（秒）
    headlightIntensity: 3.2,
    headlightDistance: 36,
    headlightAngle: 0.42,
    trunkRollsMin: 1,
    trunkRollsMax: 2,
  },

  render: {
    quality: 'medium',         // low | medium | high
    shadows: true,
    shadowMapSize: 1024,
    shadowsEnabled: true,
    pixelRatioCap: 1.6,
    fogDensity: 0.0085,
    drawDistance: 300,
    grassTufts: 160,
    // 夜里路灯：池化点光数量（0 = 只有灯头光晕、不打真光；低画质只为省灯）
    streetLampLights: 3,
  },

  audio: {
    enabled: true,
    master: 0.8,
    sfx: 1,
    ambient: 0.6,
  },

  save: {
    key: 'fwdeadworld.save.v3',
    autosaveSeconds: 60,
  },

  debug: {
    showColliders: false,
    showNav: false,
    showAiState: false,
    godMode: false,
  },
};

/** 深合并（数组直接替换），未知字段保留，缺失字段补默认值。 */
export function mergeConfig(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isObj(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = mergeConfig(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 把外部（存档 / URL / 设置面板）传进来的配置规整成安全值。 */
export function validateConfig(cfg) {
  const c = mergeConfig(DEFAULT_CONFIG, cfg || {});
  const P = c.player, C = c.camera, A = c.ai, W = c.world, I = c.items, V = c.vehicles, R = c.render;

  c.seed = Math.floor(num(c.seed, DEFAULT_CONFIG.seed, 0, 2 ** 31));
  W.size = num(W.size, 340, 120, 800);
  W.cell = num(W.cell, 2, 1, 8);
  W.buildingCount = Math.floor(num(W.buildingCount, 44, 4, 80));
  W.treeCount = Math.floor(num(W.treeCount, 300, 0, 900));
  W.wildTrees = Math.floor(num(W.wildTrees, DEFAULT_CONFIG.world.wildTrees, 0, 40000));
  W.carCount = Math.floor(num(W.carCount, 14, 0, 40));
  W.crateCount = Math.floor(num(W.crateCount, 40, 0, 160));
  W.streetKit = bool(W.streetKit, true);
  W.streetlights = bool(W.streetlights, true);
  W.streetScale = num(W.streetScale, 0, 0, 60);
  W.streetlightStep = num(W.streetlightStep, 44, 0, 160);
  W.season = SEASON_NAMES.includes(W.season) ? W.season : 'summer';
  W.seasonsEnabled = bool(W.seasonsEnabled, true);
  W.daysPerSeason = Math.floor(num(W.daysPerSeason, 3, 1, 60));
  W.weatherEnabled = bool(W.weatherEnabled, true);
  W.weatherMode = WEATHER_NAMES.includes(W.weatherMode) ? W.weatherMode : 'auto';
  W.weatherScale = num(W.weatherScale, 1, 0.1, 8);
  W.region = REGION_NAMES.includes(W.region) ? W.region : 'temperate';

  // 真实地形：只校验"开关 / 地址"，数据本身的合法性由 loader 兜底
  const TN = c.terrain;
  TN.enabled = bool(TN.enabled, true);
  TN.url = typeof TN.url === 'string' && TN.url.trim() ? TN.url.trim() : DEFAULT_CONFIG.terrain.url;

  // 真实路网：同上，只校验开关/地址；数据里的 classes 表才是断面权威
  const RD = c.roads;
  RD.enabled = bool(RD.enabled, true);
  RD.url = typeof RD.url === 'string' && RD.url.trim() ? RD.url.trim() : DEFAULT_CONFIG.roads.url;
  RD.lights = bool(RD.lights, true);
  RD.signs = bool(RD.signs, true);
  RD.connectors = bool(RD.connectors, true);

  P.radius = num(P.radius, 0.34, 0.15, 1.2);
  P.height = num(P.height, 1.75, 1.2, 2.4);
  P.eyeHeight = num(P.eyeHeight, 1.62, 0.8, P.height);
  P.walkSpeed = num(P.walkSpeed, 3.1, 0.5, 12);
  P.runSpeed = num(P.runSpeed, 5.6, P.walkSpeed, 16);
  P.sprintSpeed = num(P.sprintSpeed, 8.2, P.runSpeed, 22);
  P.jumpVelocity = num(P.jumpVelocity, 6.2, 1, 14);
  P.gravity = num(P.gravity, 20, 4, 60);
  P.maxHealth = num(P.maxHealth, 100, 10, 1000);
  // 生存节奏（食物功效的速率）：太快的饥饿会让玩家每两分钟就要吃一次
  P.hungerRate = num(P.hungerRate, 0.105, 0.01, 3);
  P.thirstRate = num(P.thirstRate, 0.15, 0.01, 3);
  if (!isObj(P.foodEffects)) P.foodEffects = {};
  P.foodEffects.enabled = bool(P.foodEffects.enabled, true);
  P.foodEffects.lowHunger = num(P.foodEffects.lowHunger, 25, 0, 100);
  P.foodEffects.lowHungerRegenMul = num(P.foodEffects.lowHungerRegenMul, 0.7, 0.1, 1);
  P.foodEffects.lowThirst = num(P.foodEffects.lowThirst, 25, 0, 100);
  P.foodEffects.lowThirstSprintMul = num(P.foodEffects.lowThirstSprintMul, 1.15, 1, 4);
  P.foodEffects.starvingDps = num(P.foodEffects.starvingDps, 1.2, 0, 20);
  P.foodEffects.overeatAbove = num(P.foodEffects.overeatAbove, 85, 0, 100);
  P.foodEffects.overeatStamina = num(P.foodEffects.overeatStamina, 8, 0, 100);
  P.foodEffects.overeatThirst = num(P.foodEffects.overeatThirst, 6, 0, 100);
  P.foodEffects.naturalRegen = num(P.foodEffects.naturalRegen, 0.9, 0, 20);

  C.fov = num(C.fov, 72, 40, 120);
  C.thirdDistance = num(C.thirdDistance, 3.2, 1, 12);
  C.sensitivity = num(C.sensitivity, 0.0022, 0.0004, 0.01);

  // 枪械功效：伤害倍率与开关（存档/URL 传入的脏数据不能把关卡玩坏）
  const CB = c.combat;
  CB.headshotMultiplier = num(CB.headshotMultiplier, 2.1, 1, 6);
  CB.limbMultiplier = num(CB.limbMultiplier, 0.72, 0.1, 1);
  CB.maxHitscanRange = num(CB.maxHitscanRange, 220, 20, 600);
  CB.pierceDamageMul = num(CB.pierceDamageMul, 0.6, 0.05, 1);
  CB.heatDecay = num(CB.heatDecay, 1.8, 0.1, 20);
  CB.bleedEnabled = bool(CB.bleedEnabled, true);
  CB.staggerEnabled = bool(CB.staggerEnabled, true);

  A.maxZombies = Math.floor(num(A.maxZombies, 34, 0, 200));
  A.maxFriendlies = Math.floor(num(A.maxFriendlies, 10, 0, 60));
  A.maxHostiles = Math.floor(num(A.maxHostiles, 8, 0, 40));
  A.sightRange = num(A.sightRange, 28, 4, 120);
  A.sightFov = num(A.sightFov, 2.2, 0.4, 3.15);
  A.nearHz = num(A.nearHz, 20, 1, 60);
  A.midHz = num(A.midHz, 6, 0.5, A.nearHz);
  A.farHz = num(A.farHz, 1.5, 0.2, A.midHz);

  I.maxWeight = num(I.maxWeight, 24, 1, 500);
  I.quickSlots = Math.floor(num(I.quickSlots, 6, 1, 10));
  V.maxSpeed = num(V.maxSpeed, 19, 4, 60);
  V.fuelBurnIdle = num(V.fuelBurnIdle, 0.1, 0, 2);
  V.fuelBurnPerSpeed = num(V.fuelBurnPerSpeed, 0.022, 0, 0.5);
  V.fuelCanAmount = num(V.fuelCanAmount, 45, 1, 100);
  V.refuelRange = num(V.refuelRange, 3.8, 1, 12);
  V.repairScrapCost = Math.max(1, Math.floor(num(V.repairScrapCost, 2, 1, 10)));
  V.repairPerScrap = num(V.repairPerScrap, 18, 1, 100);
  V.repairMaxPct = num(V.repairMaxPct, 0.85, 0.2, 1);
  V.ramMinSpeed = num(V.ramMinSpeed, 4.5, 1, 20);
  V.ramDamagePerSpeed = num(V.ramDamagePerSpeed, 9, 0, 60);
  V.engineNoiseInterval = num(V.engineNoiseInterval, 1.1, 0.2, 5);

  R.pixelRatioCap = num(R.pixelRatioCap, 1.6, 0.5, 3);
  R.streetLampLights = Math.floor(num(R.streetLampLights, 3, 0, 8));
  if (!['low', 'medium', 'high'].includes(R.quality)) R.quality = 'medium';

  c.audio.master = num(c.audio.master, 0.8, 0, 1);
  c.audio.sfx = num(c.audio.sfx, 1, 0, 1);
  c.audio.ambient = num(c.audio.ambient, 0.6, 0, 1);
  c.audio.enabled = bool(c.audio.enabled, true);

  return c;
}

/** 画质预设：只是把上面那些旋钮成组地改掉。 */
export const QUALITY_PRESETS = {
  low: { render: { shadows: false, shadowsEnabled: false, pixelRatioCap: 1, drawDistance: 180, fogDensity: 0.012, grassTufts: 40, quality: 'low' }, ai: { maxZombies: 16, maxFriendlies: 5, maxHostiles: 3, animDistance: 30 } },
  medium: { render: { shadows: true, shadowsEnabled: true, pixelRatioCap: 1.5, drawDistance: 300, fogDensity: 0.0085, grassTufts: 160, quality: 'medium' }, ai: { maxZombies: 34, maxFriendlies: 10, maxHostiles: 8, animDistance: 45 } },
  high: { render: { shadows: true, shadowsEnabled: true, pixelRatioCap: 2, drawDistance: 460, fogDensity: 0.006, grassTufts: 320, quality: 'high' }, ai: { maxZombies: 52, maxFriendlies: 14, maxHostiles: 12, animDistance: 70 } },
};

export function applyQuality(cfg, tier) {
  const preset = QUALITY_PRESETS[tier];
  if (!preset) return cfg;
  return validateConfig(mergeConfig(cfg, preset));
}

export default DEFAULT_CONFIG;
