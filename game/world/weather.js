// 天气系统 —— 纯逻辑（零 THREE 依赖，Node 里可直接单测；渲染在 world/weather-visuals.js）。
//
// 设计要点（与 world/season.js 的关系）：
//   · 季节决定"基准色"和"能出现哪些天气"（夏天不下雪、冬天不下暴雨）；
//   · 天气决定"今天的空气"：云量、雾、降水、风、雷、地面湿滑/积雪；
//   · 两者都只是数值/颜色，真正改场景的是 game._updateTimeOfDay 里的 computeEnvironment()
//     与 world/weather-visuals.js 里的粒子/风。天气系统自己**不碰**任何 THREE 对象，
//     所以"天气怎么变"可以在 Node 测试里完全确定性地验证（见 tests/weather.test.mjs）。
//
// 状态机很简单，但刻意写成"可暂停、可存档、可复现"：
//   稳态(steady) --剩余时间到--> 过渡(transition, N 秒，参数按平滑曲线插值) --> 新稳态
//   · 持续时间/下一个天气都用 mulberry32 种子随机，存档只存 id + 计时 + 湿润/积雪，
//     不存"未来"，所以读档不会出现"天气自己跳"或者"每次读档天气都不同"。
//   · 降水强度、云量、雾、风、雷、能见度、听觉、抓地力全部是同一组可插值参数，
//     因此"雨刚起时是毛毛雨、十分钟后变成暴雨"是免费得到的，不需要额外状态。
//
// 玩法耦合（都在这一个文件里定义，方便调平衡）：
//   sight / hearing  乘到 AI 的视觉/听觉距离上（雾、雨、暴雪会削弱感染的感知）
//   grip             玩家移速乘数（雪地/结冰打滑）
//   staminaMul / regenMul  体力消耗/恢复乘数（湿冷更累）
//   strikesPerMin    雷电频率；雷声本身是一次巨大的"声音事件"，会把感染者引过去
//   temp             温度（摄氏度，仅用于 HUD 与季节氛围，不直接伤血）

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 季节 → 温度基准（摄氏度，白天）。 */
const SEASON_TEMP = { spring: 15, summer: 27, autumn: 12, winter: 0 };

/** 季节 → 天气权重。0 / 缺省 = 该季节不会出现这种天气。 */
export const WEATHER_SEASON_WEIGHTS = {
  spring: { clear: 18, cloudy: 24, overcast: 15, drizzle: 17, rain: 11, storm: 3, fog: 9, snow: 0, blizzard: 0 },
  summer: { clear: 30, cloudy: 24, overcast: 7, drizzle: 5, rain: 9, storm: 15, fog: 2, snow: 0, blizzard: 0 },
  autumn: { clear: 13, cloudy: 18, overcast: 18, drizzle: 17, rain: 11, storm: 5, fog: 15, snow: 2, blizzard: 0 },
  winter: { clear: 17, cloudy: 15, overcast: 15, drizzle: 2, rain: 2, storm: 0, fog: 8, snow: 29, blizzard: 12 },
};

/**
 * 天气表。字段含义见文件头。
 *   hold         该天气持续的秒数区间（会乘 config.world.weatherScale）
 *   transition   从别的天气切进来要几秒（剧烈的天气来得更"顿"一些）
 *   sky/ground/static*  颜色与混合权重（0 = 完全用季节色）
 *   wetRate/snowRate    每秒湿润/积雪增量（可为负 = 蒸发/融化）
 */
export const WEATHERS = {
  clear: {
    id: 'clear', label: '晴', icon: '☀',
    precip: 'none', precipAmount: 0, cloud: 0,
    fogMul: 0.9, sunMul: 1.06, hemiMul: 1.0, ambientMul: 1.0,
    sky: 0x8fa6b8, skyMix: 0, ground: 0x4a6b46, groundMix: 0,
    staticColor: 0xffffff, staticMix: 0,
    wetRate: -0.03, snowRate: -0.04,
    wind: 0.12, strikesPerMin: 0,
    sight: 1.05, hearing: 1.0, grip: 1.0, staminaMul: 1.0, regenMul: 1.05,
    temp: 3,
    audio: { rain: 0, wind: 0.35 },
    hold: [180, 320], transition: 18,
  },
  cloudy: {
    id: 'cloudy', label: '多云', icon: '⛅',
    precip: 'none', precipAmount: 0, cloud: 0.35,
    fogMul: 1.05, sunMul: 0.95, hemiMul: 1.02, ambientMul: 1.02,
    sky: 0xa9b6c4, skyMix: 0.28, ground: 0x4a6b46, groundMix: 0,
    staticColor: 0xffffff, staticMix: 0,
    wetRate: -0.01, snowRate: -0.02,
    wind: 0.25, strikesPerMin: 0,
    sight: 1.0, hearing: 1.0, grip: 1.0, staminaMul: 1.0, regenMul: 1.0,
    temp: 1,
    audio: { rain: 0, wind: 0.5 },
    hold: [140, 260], transition: 20,
  },
  overcast: {
    id: 'overcast', label: '阴', icon: '☁',
    precip: 'none', precipAmount: 0, cloud: 0.65,
    fogMul: 1.15, sunMul: 0.78, hemiMul: 1.08, ambientMul: 1.05,
    sky: 0x93a1ad, skyMix: 0.5, ground: 0x4a6b46, groundMix: 0.05,
    staticColor: 0xf0f2f4, staticMix: 0.05,
    wetRate: 0.004, snowRate: 0.004,
    wind: 0.3, strikesPerMin: 0,
    sight: 0.92, hearing: 0.98, grip: 0.99, staminaMul: 1.0, regenMul: 0.98,
    temp: -1,
    audio: { rain: 0, wind: 0.6 },
    hold: [110, 220], transition: 22,
  },
  fog: {
    id: 'fog', label: '雾', icon: '🌫',
    precip: 'none', precipAmount: 0, cloud: 0.55,
    fogMul: 3.2, sunMul: 0.6, hemiMul: 1.05, ambientMul: 1.15,
    sky: 0xb4bcc0, skyMix: 0.62, ground: 0x4a6b46, groundMix: 0.08,
    staticColor: 0xffffff, staticMix: 0,
    wetRate: 0.02, snowRate: 0,
    wind: 0.1, strikesPerMin: 0,
    sight: 0.45, hearing: 0.9, grip: 1.0, staminaMul: 1.0, regenMul: 1.0,
    temp: -2,
    audio: { rain: 0, wind: 0.25 },
    hold: [90, 180], transition: 30,
  },
  drizzle: {
    id: 'drizzle', label: '小雨', icon: '🌦',
    precip: 'rain', precipAmount: 0.35, cloud: 0.7,
    fogMul: 1.25, sunMul: 0.68, hemiMul: 1.05, ambientMul: 1.06,
    sky: 0x94a2ad, skyMix: 0.55, ground: 0x40573c, groundMix: 0.18,
    staticColor: 0xcfd6da, staticMix: 0.2,
    wetRate: 0.06, snowRate: 0,
    wind: 0.25, strikesPerMin: 0,
    sight: 0.82, hearing: 0.85, grip: 0.98, staminaMul: 1.05, regenMul: 0.95,
    temp: -2,
    audio: { rain: 0.28, wind: 0.4 },
    hold: [100, 200], transition: 18,
  },
  rain: {
    id: 'rain', label: '雨', icon: '🌧',
    precip: 'rain', precipAmount: 0.65, cloud: 0.85,
    fogMul: 1.7, sunMul: 0.5, hemiMul: 1.0, ambientMul: 1.05,
    sky: 0x7f8f9c, skyMix: 0.68, ground: 0x35492f, groundMix: 0.26,
    staticColor: 0xaeb8be, staticMix: 0.32,
    wetRate: 0.12, snowRate: 0,
    wind: 0.35, strikesPerMin: 0,
    sight: 0.68, hearing: 0.72, grip: 0.95, staminaMul: 1.12, regenMul: 0.85,
    temp: -3,
    audio: { rain: 0.62, wind: 0.5 },
    hold: [90, 180], transition: 16,
  },
  storm: {
    id: 'storm', label: '雷雨', icon: '⛈',
    precip: 'rain', precipAmount: 1, cloud: 1,
    fogMul: 2.1, sunMul: 0.3, hemiMul: 0.95, ambientMul: 1.0,
    sky: 0x5e6b78, skyMix: 0.85, ground: 0x2c3b28, groundMix: 0.32,
    staticColor: 0x8e989e, staticMix: 0.45,
    wetRate: 0.22, snowRate: 0,
    wind: 0.85, strikesPerMin: 7,
    sight: 0.55, hearing: 0.6, grip: 0.9, staminaMul: 1.25, regenMul: 0.7,
    temp: -4,
    audio: { rain: 1, wind: 0.9 },
    hold: [60, 140], transition: 20,
  },
  snow: {
    id: 'snow', label: '雪', icon: '🌨',
    precip: 'snow', precipAmount: 0.55, cloud: 0.75,
    fogMul: 1.5, sunMul: 0.6, hemiMul: 1.1, ambientMul: 1.1,
    sky: 0xb9c6d2, skyMix: 0.6, ground: 0x8e998f, groundMix: 0.18,
    staticColor: 0xdfe6ec, staticMix: 0.25,
    wetRate: 0.01, snowRate: 0.06,
    wind: 0.2, strikesPerMin: 0,
    sight: 0.78, hearing: 0.92, grip: 0.88, staminaMul: 1.15, regenMul: 0.9,
    temp: -6,
    audio: { rain: 0, wind: 0.35 },
    hold: [120, 240], transition: 25,
  },
  blizzard: {
    id: 'blizzard', label: '暴雪', icon: '❄',
    precip: 'snow', precipAmount: 1, cloud: 0.95,
    fogMul: 3.0, sunMul: 0.35, hemiMul: 1.0, ambientMul: 1.05,
    sky: 0xa9b7c4, skyMix: 0.9, ground: 0xcfd9e0, groundMix: 0.35,
    staticColor: 0xf0f5f9, staticMix: 0.45,
    wetRate: 0, snowRate: 0.18,
    wind: 1, strikesPerMin: 0,
    sight: 0.38, hearing: 0.7, grip: 0.78, staminaMul: 1.35, regenMul: 0.65,
    temp: -10,
    audio: { rain: 0, wind: 1 },
    hold: [60, 120], transition: 25,
  },
};

export const WEATHER_IDS = Object.keys(WEATHERS);
export const DEFAULT_WEATHER = 'clear';

/** 天气详情（未知 id 回落到晴；返回的是表里的只读对象，不要改）。 */
export function weatherDef(id) {
  return WEATHERS[id] || WEATHERS[DEFAULT_WEATHER];
}

/** 某季节能出现的天气 id 列表（权重 > 0）。 */
export function weatherIdsForSeason(season) {
  const w = WEATHER_SEASON_WEIGHTS[season] || WEATHER_SEASON_WEIGHTS.spring;
  return WEATHER_IDS.filter((id) => (w[id] || 0) > 0);
}

/** 某天气在某季节的权重（0 = 不会出现）。 */
export function weatherWeight(season, id) {
  const w = WEATHER_SEASON_WEIGHTS[season] || WEATHER_SEASON_WEIGHTS.spring;
  return w[id] || 0;
}

/** mulberry32：确定性随机源（与 layout/npcs 用的是同一套思路）。
 *  额外暴露 getState/setState：存档要把随机数状态一起存下来，
 *  否则读档后"下一次抽天气"会走另一条分支（同种子不同结果）。 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  const rng = function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => a;
  rng.setState = (v) => { a = (Number(v) | 0) || 1; };
  return rng;
}

// ── 颜色工具（纯整数，不依赖 THREE） ───────────────────────
export function mixHex(a, b, t) {
  const k = clamp01(t);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/** 明暗缩放：k<1 变暗、k>1 变亮（会夹到 0..255）。 */
export function shadeHex(hex, k) {
  const ar = (hex >> 16) & 255, ag = (hex >> 8) & 255, ab = hex & 255;
  const r = Math.max(0, Math.min(255, Math.round(ar * k)));
  const g = Math.max(0, Math.min(255, Math.round(ag * k)));
  const b = Math.max(0, Math.min(255, Math.round(ab * k)));
  return (r << 16) | (g << 8) | b;
}

// ── 参数插值 ────────────────────────────────────────────
const NUM_KEYS = [
  'cloud', 'fogMul', 'sunMul', 'hemiMul', 'ambientMul',
  'skyMix', 'groundMix', 'staticMix', 'precipAmount',
  'wetRate', 'snowRate', 'wind', 'strikesPerMin',
  'sight', 'hearing', 'grip', 'staminaMul', 'regenMul', 'temp',
];
const COLOR_KEYS = ['sky', 'ground', 'staticColor'];

/**
 * 两个天气参数之间插值（过渡用）。数值/颜色按 t 插值；字符串字段（id/label/icon/precip）
 * 直接取目标天气 —— 过渡一开始 HUD 就写"雨"、降水也开始淡入，而不是等过半才换名字。
 */
export function lerpWeather(a, b, t) {
  const k = clamp01(t);
  const out = {};
  for (const key of NUM_KEYS) {
    const av = Number(a[key]) || 0;
    const bv = Number(b[key]) || 0;
    out[key] = av + (bv - av) * k;
  }
  for (const key of COLOR_KEYS) {
    out[key] = mixHex(Number(a[key]) || 0, Number(b[key]) || 0, k);
  }
  out.audio = {
    rain: (a.audio ? a.audio.rain : 0) + ((b.audio ? b.audio.rain : 0) - (a.audio ? a.audio.rain : 0)) * k,
    wind: (a.audio ? a.audio.wind : 0) + ((b.audio ? b.audio.wind : 0) - (a.audio ? a.audio.wind : 0)) * k,
  };
  const src = b;                    // 过渡中 HUD/降水类型直接显示"要去的那一边"
  out.id = src.id;
  out.label = src.label;
  out.icon = src.icon;
  out.precip = src.precip;
  out.hold = src.hold;
  out.transition = src.transition;
  return out;
}

/** 过渡缓动（smoothstep）：开头结尾都软，看不出"切"的那一帧。 */
export function easeWeather(t) {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
}

/**
 * 把「季节基准」和「天气」合成为这一帧真正要用的环境参数。纯函数，可直接单测。
 * 返回的 sky / ground / staticHex 都是 0xRRGGBB 整数，由 game 写进材质与 fog。
 *
 * @param {object} o
 * @param {object} o.seasonEnv  SEASON_ENV[season]（season.js）
 * @param {object} o.weather    WeatherSystem.params（已插值）
 * @param {number} [o.wetness]  地面湿润度 0..1
 * @param {number} [o.snowCover] 积雪覆盖 0..1
 * @param {number} [o.baseFogDensity] config.render.fogDensity
 */
export function computeEnvironment(o = {}) {
  const env = o.seasonEnv || {};
  const w = o.weather || weatherDef(DEFAULT_WEATHER);
  const wet = clamp01(o.wetness || 0);
  const snow = clamp01(o.snowCover || 0);

  const sunMul = (env.sunMul || 1) * (w.sunMul || 1);
  const hemiMul = (env.hemiMul || 1) * (w.hemiMul || 1);
  const ambientMul = (env.ambientMul || 1) * (w.ambientMul || 1);
  const fogMul = (env.fogMul || 1) * (w.fogMul || 1);

  // 天空：先按天气的 skyMix 拉向天气色，再按云量整体压暗一点
  const baseSky = env.sky == null ? 0x8fa6b8 : env.sky;
  let sky = mixHex(baseSky, w.sky == null ? baseSky : w.sky, clamp01(w.skyMix || 0));
  sky = shadeHex(sky, 1 - 0.18 * clamp01(w.cloud || 0));

  // 地面：季节色 → 天气色 → 湿润压暗（湿土更黑）→ 积雪拉白
  const baseGround = env.ground == null ? 0x4a6b46 : env.ground;
  let ground = mixHex(baseGround, w.ground == null ? baseGround : w.ground, clamp01(w.groundMix || 0));
  ground = shadeHex(ground, 1 - 0.24 * wet);
  ground = mixHex(ground, 0xe2ebf2, snow * 0.92);

  // 静态合批（道路/墙/杂物）：湿润变暗、积雪提亮。树不在里面（树有自己的材质与雪几何）。
  let staticHex = mixHex(0xffffff, w.staticColor == null ? 0xffffff : w.staticColor, clamp01(w.staticMix || 0));
  staticHex = shadeHex(staticHex, 1 - 0.2 * wet);
  staticHex = mixHex(staticHex, 0xf4f8fb, snow * 0.35);

  const fogDensity = (o.baseFogDensity == null ? 0.0085 : o.baseFogDensity) * fogMul;
  return { sunMul, hemiMul, ambientMul, fogMul, fogDensity, sky, ground, staticHex, cloud: clamp01(w.cloud || 0) };
}

/**
 * 温度（摄氏度）：季节基准 + 天气偏移 + 日内曲线。
 * 日内最高在 16:00、最低在 04:00（Project Zomboid / Vintage Story 都是这个相位），
 * 所以在 15 分钟一天里，温度自己就会"下午最热、凌晨最冷"。
 * @param {string} season
 * @param {object} weather 已插值的天气参数（读 temp 字段）
 * @param {number} timeOfDay 0..24（不传则按正午算）
 */
export function weatherTemperature(season, weather, timeOfDay = 12) {
  const base = SEASON_TEMP[season] == null ? 15 : SEASON_TEMP[season];
  const delta = weather && Number.isFinite(weather.temp) ? weather.temp : 0;
  const t = Number.isFinite(timeOfDay) ? timeOfDay : 12;
  // 16 点最高：-cos((t-4)/24*2π) 在 t=16 取 +1、t=4 取 -1
  const diurnal = -Math.cos(((t - 4) / 24) * Math.PI * 2) * 4;
  return base + delta + diurnal;
}

/** 环境噪声底（1 = 安静，越低越"吵"）。AI 听觉与音频混音共用这一个数字。 */
export function ambientNoise(weather) {
  if (!weather) return 1;
  const v = Number.isFinite(weather.hearing) ? weather.hearing : 1;
  return v < 0.1 ? 0.1 : v > 1.2 ? 1.2 : v;
}

/**
 * 这一刻"该放什么环境声"（纯函数，便于单测；真正播放由 game 调度）。
 * 规则尽量简单，但要能听出季节：
 *   · 春/夏的白天、不下雨 → 鸟叫
 *   · 夏夜、不下雨 → 虫鸣
 *   · 秋/冬、有风 → 阵风（wind_gust 已经在音效表里）
 *   · 下雨/下雪 → null（雨声已经盖过环境，别叠）
 *   · 室内 → null（室内是房间混响，不是野外环境声）
 * @param {{season?:string, dayFactor?:number, precip?:string, wind?:number, indoor?:boolean}} o
 * @returns {string|null} 音效名
 */
export function ambienceFor(o = {}) {
  if (o.indoor) return null;
  const season = o.season || 'summer';
  const day = Number.isFinite(o.dayFactor) ? o.dayFactor : 1;
  const wind = Number.isFinite(o.wind) ? o.wind : 0;
  const wet = o.precip === 'rain' || o.precip === 'snow';
  if (wet) return null;
  const isDay = day > 0.35;
  const isNight = day < 0.18;
  if (isDay && (season === 'spring' || season === 'summer')) return 'birds';
  if (isNight && (season === 'summer' || season === 'spring')) return 'crickets';
  if ((season === 'autumn' || season === 'winter') && wind >= 0.25) return 'wind_gust';
  // 秋天无风的大白天：也放鸟（迁徙季），冬天则保持安静
  if (isDay && season === 'autumn') return 'birds';
  return null;
}

/**
 * 天气状态机。只做时间推进与参数输出，不改场景。
 * 事件通过 consumeEvents() 取走：{type:'change'|'lightning', ...}
 */
export class WeatherSystem {
  /**
   * @param {object} o { seed, season, enabled, scale }
   */
  constructor(o = {}) {
    this.seed = Number.isFinite(o.seed) ? o.seed : 20260801;
    this.season = o.season || 'summer';
    this.enabled = o.enabled !== false;
    this.scale = clamp(Number(o.scale) || 1, 0.05, 20);
    this._rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);

    this.currentId = this._pick(this.season, null);
    this.nextId = this._pick(this.season, this.currentId);   // 提前抽好：HUD 要能做"预报"
    this.targetId = null;         // 过渡中的目标天气（null = 稳态）
    this.blend = 0;               // 0..1 过渡进度
    this.blendDuration = 1;
    this.remain = this._holdFor(this.currentId);
    this.wetness = 0;
    this.snowCover = 0;
    this.windPhase = 0;
    this.strikeTimer = 3;
    this.forcedId = null;         // 玩家/调试指定的天气（自动推进暂停）
    this.elapsed = 0;
    this._events = [];
    this._lastInfo = null;
  }

  // ── 查询 ──
  get transitioning() { return !!this.targetId; }

  /** 当前插值后的天气参数（过渡中就是两个天气的混合）。 */
  get params() {
    if (!this.targetId) return WEATHERS[this.currentId] || WEATHERS[DEFAULT_WEATHER];
    return lerpWeather(
      WEATHERS[this.currentId] || WEATHERS[DEFAULT_WEATHER],
      WEATHERS[this.targetId] || WEATHERS[DEFAULT_WEATHER],
      easeWeather(this.blend),
    );
  }

  /** 给 HUD / 存档 / 音频用的摘要。 */
  info() {
    const p = this.params;
    return {
      id: p.id, label: p.label, icon: p.icon,
      precip: p.precip, precipAmount: p.precipAmount,
      wind: p.wind, cloud: p.cloud,
      sight: p.sight, hearing: p.hearing, grip: p.grip,
      wetness: this.wetness, snowCover: this.snowCover,
      transitioning: this.transitioning,
      nextId: this.targetId,
      nextLabel: this.targetId ? WEATHERS[this.targetId].label : null,
      // 预报：稳态时才是"真的下一个"，过渡中/被指定天气时没有意义
      next: this.forecast(),
      forced: this.forcedId,
    };
  }

  /**
   * 天气预报：下一个天气 + 还有多少秒。
   * 这是**提前抽好**的（到达当前天气时就抽），所以 HUD 能显示"转雨 · 2:30"，
   * 也意味着玩家可以据此决定"现在出不出门"，而不是被天气突袭。
   */
  forecast() {
    if (this.forcedId || this.targetId || !this.nextId) return null;
    const def = WEATHERS[this.nextId];
    return { id: this.nextId, label: def.label, icon: def.icon, eta: Math.max(0, Math.round(this.remain)) };
  }

  // ── 状态推进 ──
  /**
   * @param {number} dt 秒
   * @param {{season?:string, dayFactor?:number}} ctx
   */
  update(dt, ctx = {}) {
    if (!Number.isFinite(dt) || dt <= 0) return this;
    const step = Math.min(0.25, dt);        // 掉帧/切后台回来时不要一次推进几分钟
    this.elapsed += step;
    if (ctx.season && ctx.season !== this.season) this.setSeason(ctx.season);

    if (this.enabled) {
      // 指定天气：先朝它过渡，到达后停住（过渡本身仍要走 blend 推进，见下）
      if (this.forcedId && this.currentId !== this.forcedId && this.targetId !== this.forcedId) {
        this._begin(this.forcedId);
      }
      if (this.targetId) {
        this.blendDuration = Math.max(0.5, this.blendDuration);
        this.blend += step / this.blendDuration;
        if (this.blend >= 1) {
          const arrived = this.targetId;
          this.currentId = arrived;
          this.targetId = null;
          this.blend = 0;
          // 到达后立刻把"下一个"抽出来：HUD 因此能显示"转雨 · 2:30"
          this.nextId = this._pick(this.season, arrived);
          this.remain = this._holdFor(arrived);
          this._events.push({ type: 'change', id: arrived, label: WEATHERS[arrived].label });
        }
      } else if (!this.forcedId) {
        this.remain -= step;
        if (this.remain <= 0) {
          const nid = this.nextId || this._pick(this.season, this.currentId);
          this.nextId = null;
          this._begin(nid);
        }
      }
    }

    const p = this.params;
    // 湿润 / 积雪：慢慢累积、慢慢干（不会因为切天气瞬间干透）
    this.wetness = clamp01(this.wetness + (p.wetRate || 0) * step);
    this.snowCover = clamp01(this.snowCover + (p.snowRate || 0) * step);
    this.windPhase = (this.windPhase + step * (0.6 + (p.wind || 0) * 2.2)) % 1000;

    // 雷：按 strikesPerMin 做指数间隔（比"每帧随机"更自然，也不会一帧劈好几次）
    const rate = Math.max(0, p.strikesPerMin || 0);
    if (rate > 0) {
      this.strikeTimer -= step;
      if (this.strikeTimer <= 0) {
        const distance = 180 + this._rng() * 1500;
        this.strikeTimer = Math.max(0.6, -Math.log(1 - this._rng() * 0.999) * (60 / rate));
        this._events.push({
          type: 'lightning',
          distance,
          power: clamp01(1 - distance / 1700),
          // 声速 343m/s：远处的雷总是慢半拍，这是"距离感"的最大来源
          delay: distance / 343,
          // 方向（弧度）：渲染层据此在玩家附近画一条可见的电弧
          angle: this._rng() * Math.PI * 2,
        });
      }
    } else {
      this.strikeTimer = Math.max(this.strikeTimer, 0.5);
    }
    return this;
  }

  /** 取走累计事件（调用方负责播声音/闪光）。 */
  consumeEvents() {
    const out = this._events;
    this._events = [];
    return out;
  }

  /** 季节变化：换掉当前/目标里"这个季节不该出现"的天气。 */
  setSeason(season) {
    if (!season || season === this.season) return this;
    this.season = season;
    const allowed = weatherIdsForSeason(season);
    const ok = (id) => id && allowed.includes(id);
    if (!ok(this.currentId)) {
      this._begin(this._pick(season, null));
    } else if (this.targetId && !ok(this.targetId)) {
      this._begin(this._pick(season, this.currentId));
    }
    // 预报也要跟着季节走：夏天不该在 HUD 上预报"转雪"
    if (!ok(this.nextId)) this.nextId = this._pick(season, this.currentId);
    return this;
  }

  /** 立刻或渐变到某个天气。id 非法时忽略。 */
  setWeather(id, opts = {}) {
    if (!WEATHERS[id]) return false;
    if (opts.instant) {
      this.currentId = id;
      this.targetId = null;
      this.nextId = this._pick(this.season, id);
      this.blend = 0;
      this.remain = this._holdFor(id);
      this.forcedId = opts.force ? id : null;
      this._events.push({ type: 'change', id, label: WEATHERS[id].label });
      return true;
    }
    if (opts.force) this.forcedId = id;
    if (this.currentId === id && !this.targetId) {
      if (opts.force) this.forcedId = id;
      return false;
    }
    this.nextId = null;   // 正在手动切换：预报暂时没有意义
    this._begin(id);
    return true;
  }

  /** 解除"指定天气"，回到自动推进。 */
  unforce() {
    this.forcedId = null;
    if (!this.targetId) {
      if (!this.nextId) this.nextId = this._pick(this.season, this.currentId);
      this.remain = this._holdFor(this.currentId);
    }
    return this;
  }

  /** 季节点（调试用）：随机换一个更强的天气。 */
  worsen() {
    const p = this.params;
    const order = ['clear', 'cloudy', 'overcast', 'drizzle', 'rain', 'storm'];
    const idx = order.indexOf(p.id);
    const next = order[Math.min(order.length - 1, Math.max(0, idx) + 1)];
    return this.setWeather(next, { force: true });
  }

  // ── 存档 ──
  serialize() {
    return {
      currentId: this.currentId,
      nextId: this.nextId,
      targetId: this.targetId,
      blend: Math.round(this.blend * 1000) / 1000,
      blendDuration: Math.round(this.blendDuration * 100) / 100,
      remain: Math.round(this.remain * 100) / 100,
      wetness: Math.round(this.wetness * 1000) / 1000,
      snowCover: Math.round(this.snowCover * 1000) / 1000,
      strikeTimer: Math.round(this.strikeTimer * 100) / 100,
      forcedId: this.forcedId,
      season: this.season,
      // 随机数状态也要存：否则读档后下一次抽天气会走另一条分支
      rngState: this._rng.getState ? this._rng.getState() : 0,
    };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return this;
    const ok = (id) => (WEATHERS[id] ? id : null);
    const cur = ok(data.currentId);
    if (cur) this.currentId = cur;
    const nxt = ok(data.nextId);
    if (nxt) this.nextId = nxt;
    this.targetId = ok(data.targetId);
    if (this.targetId === this.currentId) this.targetId = null;
    if (Number.isFinite(data.blend)) this.blend = clamp01(data.blend);
    if (Number.isFinite(data.blendDuration) && data.blendDuration > 0) this.blendDuration = data.blendDuration;
    if (Number.isFinite(data.remain)) this.remain = Math.max(1, data.remain);
    if (Number.isFinite(data.wetness)) this.wetness = clamp01(data.wetness);
    if (Number.isFinite(data.snowCover)) this.snowCover = clamp01(data.snowCover);
    if (Number.isFinite(data.strikeTimer)) this.strikeTimer = Math.max(0.2, data.strikeTimer);
    this.forcedId = ok(data.forcedId);
    if (typeof data.season === 'string') this.season = data.season;
    // 读档要恢复随机数状态，否则"同一天气状态"之后会走向不同分支
    if (Number.isFinite(data.rngState) && this._rng.setState) this._rng.setState(data.rngState);
    return this;
  }

  // ── 内部 ──
  _holdFor(id) {
    const def = weatherDef(id);
    const range = Array.isArray(def.hold) ? def.hold : [120, 240];
    const lo = Math.max(5, range[0]);
    const hi = Math.max(lo, range[1]);
    return (lo + this._rng() * (hi - lo)) * this.scale;
  }

  _begin(id) {
    if (!WEATHERS[id]) return;
    const def = weatherDef(id);
    this.targetId = id;
    this.blend = 0;
    this.blendDuration = Math.max(1, (def.transition || 20)) * (this.scale < 0.5 ? 0.5 : 1);
  }

  /** 按季节权重挑下一个天气；避免连续两次同一个（权重打折而不是硬排除）。 */
  _pick(season, exclude) {
    const weights = WEATHER_SEASON_WEIGHTS[season] || WEATHER_SEASON_WEIGHTS.spring;
    let total = 0;
    const entries = [];
    for (const id of WEATHER_IDS) {
      let w = weights[id] || 0;
      if (w <= 0) continue;
      if (id === exclude) w *= 0.25;
      entries.push([id, w]);
      total += w;
    }
    if (!entries.length) return DEFAULT_WEATHER;
    let r = this._rng() * total;
    for (const [id, w] of entries) {
      r -= w;
      if (r <= 0) return id;
    }
    return entries[entries.length - 1][0];
  }
}

/** 天气系统默认参数（config 里的默认值也走这里，避免两边不一致）。 */
export const WEATHER_DEFAULTS = {
  enabled: true,
  mode: 'auto',      // 'auto' 或具体天气 id
  scale: 1,          // 持续时间倍率（越大天气越"赖着不走"）
};

export default {
  WEATHERS, WEATHER_IDS, WEATHER_SEASON_WEIGHTS, WEATHER_DEFAULTS, DEFAULT_WEATHER,
  weatherDef, weatherIdsForSeason, weatherWeight, mulberry32,
  mixHex, shadeHex, lerpWeather, easeWeather, computeEnvironment, weatherTemperature, ambientNoise, ambienceFor,
  WeatherSystem,
};
