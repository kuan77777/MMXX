// 四季环境 —— 只负责"季节看起来是什么天气"：天空/雾、地面颜色、阳光与补光的色温、以及树材质色调。
// 几何**不**在这里：树用哪套 OBJ 由 world/trees.js 的 season 键决定，渲染由 buildTreeInstances 按季节取。
//
// 设计要点：
//   · 一个季节 = 一组颜色 + 几个光照/雾的倍率，全部可热切换（不重建几何、不重建世界）；
//   · 白天/黑夜仍由 game._updateTimeOfDay 控制，这里只提供"白天该是什么颜色"的基准，
//     夜间的压暗曲线四季共用 —— 否则冬天夜里会黑得看不见路；
//   · 只有地面上色是"乘法"：地板/路面的顶点色只存明暗相对值，材质 color 才是季节色，
//     所以冬天把地面调成雪白不会有额外几何。
import * as THREE from 'three';
import { SEASONS, SEASON_LABELS, DEFAULT_SEASON } from './trees.js';
import { mixHex } from './weather.js';

/**
 * 每个季节的调色板。字段：
 *   sky / fog        白天天空与雾的颜色（夜间会按时间轴自己压暗）
 *   ground           地面材质主色（草地绿 / 枯草黄 / 雪白）
 *   sun / hemiSky / hemiGround / ambient  光源颜色
 *   treeTint         树材质颜色（顶点色的乘数；四季几何不同，色调只做轻微季节化）
 *   sunMul / hemiMul / ambientMul / fogMul  相对基准的倍率
 */
export const SEASON_ENV = {
  spring: {
    label: '春',
    // 道具包里没有"春天专用"的树几何，所以春天靠**色调**做区分：
    // 地面偏嫩绿、天光更亮更蓝一点、树叶往黄绿推（顶点色乘一个偏黄的 tint）
    sky: 0xa9c3d6, ground: 0x6f9a5b,
    sun: 0xfff7e2, hemiSky: 0xdfeef9, hemiGround: 0x55604a, ambient: 0x3f4a52,
    treeTint: 0xdcf5bd,           // 新叶偏嫩黄绿
    sunMul: 1.05, hemiMul: 1.18, ambientMul: 1.08, fogMul: 0.92,
  },
  summer: {
    label: '夏',
    sky: 0x8fa6b8, ground: 0x4a6b46,
    sun: 0xffe9c4, hemiSky: 0xcfe0f0, hemiGround: 0x4a5446, ambient: 0x3a434a,
    treeTint: 0xffffff,           // 原色
    sunMul: 1.0, hemiMul: 1.0, ambientMul: 1.0, fogMul: 1.0,
  },
  autumn: {
    label: '秋',
    sky: 0xb0a08c, ground: 0x7a6f45,
    sun: 0xffdba6, hemiSky: 0xe6dcc8, hemiGround: 0x554a3a, ambient: 0x3b352e,
    treeTint: 0xfff4e6,           // 秋色几何本身就是橙的，这里只做一点点暖化
    sunMul: 0.95, hemiMul: 1.0, ambientMul: 1.0, fogMul: 1.15,
  },
  winter: {
    label: '冬',
    sky: 0xa9b7c6, ground: 0xc9d4da,
    sun: 0xe8f2fb, hemiSky: 0xd8e6f4, hemiGround: 0x5a6470, ambient: 0x2f3742,
    treeTint: 0xf2f8ff,           // 雪几何 + 冷调
    sunMul: 0.85, hemiMul: 1.05, ambientMul: 1.0, fogMul: 1.3,
  },
};

/** 取季节环境（未知季节回落到夏）。 */
export function seasonEnv(season) {
  return SEASON_ENV[season] || SEASON_ENV[DEFAULT_SEASON];
}

/** 第 n 天（1 起）属于哪个季节；daysPerSeason 是每个季节持续的天数。 */
export function seasonForDay(day, daysPerSeason = 3) {
  const per = Math.max(1, Math.floor(daysPerSeason || 1));
  const d = Math.max(1, Math.floor(day || 1));
  return SEASONS[Math.floor((d - 1) / per) % SEASONS.length];
}

/**
 * 把季节环境套到正在运行的游戏上：光源颜色、雾密度、地面颜色。
 * 天空/雾的**亮度**由 game._updateTimeOfDay 按时间算，这里只给颜色基准（写进 game.seasonEnv）。
 * @returns 实际生效的季节名
 */
export function applySeasonEnvironment(game, season) {
  const name = SEASON_ENV[season] ? season : DEFAULT_SEASON;
  const env = SEASON_ENV[name];
  game.season = name;
  game.seasonEnv = env;

  if (game.sun) game.sun.color.setHex(env.sun);
  if (game.hemi) {
    game.hemi.color.setHex(env.hemiSky);
    if (game.hemi.groundColor) game.hemi.groundColor.setHex(env.hemiGround);
  }
  if (game.ambient) game.ambient.color.setHex(env.ambient);
  if (game.scene && game.scene.fog && game.config && game.config.render) {
    game.scene.fog.density = game.config.render.fogDensity * env.fogMul;
  }
  const ground = game.world && game.world.group ? game.world.group.getObjectByName('ground') : null;
  if (ground && ground.material && ground.material.color) {
    const terrainObj = ground.userData && ground.userData.terrainObj;
    if (terrainObj && typeof terrainObj.recolor === 'function') {
      // 真实地形：顶点色是绝对色（林地/水体/冰雪各不同），只能重刷顶点色 + 材质保持白色调制
      terrainObj.recolor(THREE, ground, name);
      ground.material.color.setHex(0xffffff);
    } else {
      ground.material.color.setHex(env.ground);
    }
  }
  return name;
}

/** 季节名（未知值返回 undefined，方便调用方自己决定回退）。 */
export function isSeason(name) {
  return SEASONS.includes(name);
}

// ── 季节过渡 ────────────────────────────────────────────
// 换季时几何是"咔"一下换掉的（树几何不能插值），但颜色可以：把两个季节的色板按 t 插值，
// 再由 game 每帧写进灯光/雾/地面，玩家看到的是"天色慢慢变"而不是整屏跳一下。
const ENV_NUM_KEYS = ['sunMul', 'hemiMul', 'ambientMul', 'fogMul'];
const ENV_COLOR_KEYS = ['sky', 'ground', 'sun', 'hemiSky', 'hemiGround', 'ambient', 'treeTint'];

/**
 * 两个季节色板之间的插值结果。返回的是**新对象**（不修改 SEASON_ENV）。
 * 未知季节回落到夏。
 */
export function blendSeasonEnv(from, to, t) {
  const a = SEASON_ENV[from] ? SEASON_ENV[from] : SEASON_ENV[DEFAULT_SEASON];
  const b = SEASON_ENV[to] ? SEASON_ENV[to] : SEASON_ENV[DEFAULT_SEASON];
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const out = { label: k < 0.5 ? a.label : b.label };
  for (const key of ENV_NUM_KEYS) out[key] = (a[key] || 1) + ((b[key] || 1) - (a[key] || 1)) * k;
  for (const key of ENV_COLOR_KEYS) out[key] = mixHex(a[key] || 0, b[key] || 0, k);
  return out;
}

export { SEASONS, SEASON_LABELS, DEFAULT_SEASON };
export default {
  SEASONS, SEASON_LABELS, DEFAULT_SEASON, SEASON_ENV, seasonEnv, seasonForDay, applySeasonEnvironment, isSeason,
  blendSeasonEnv,
};
