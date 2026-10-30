// FW3D · 球员外观数据层（纯逻辑：不 import THREE、不碰 DOM）
// 目的：把「球员是谁」翻译成「这个人长什么样」的一组可控参数，供 character.js 建低模几何体。
//
// 设计要点（与任务书对应）：
//  1. 确定性：同一个 playerId + 同一份 SALT 永远生成同一套外观（不用 Math.random），
//     存档里不需要存外观，也不会因为读档而换脸（要求三.7/8）。
//  2. 可追溯：每个字段标 provenance = 'source' | 'estimate' | 'procedural'，
//     只有真实资料能写成 'source'；没资料的一律 'procedural'，绝不把猜测写成事实。
//  3. 与能力完全解耦：本文件不读取 ca/pa/stats。外观只看 id、位置、年龄、身高（如有）。
//  4. 可控随机：makeRng(seed) 是 mulberry32，同种子可重放，便于测试与批量生成。
//  5. 分布约束：身高/体型按位置与年龄给先验，极端值被 clamp；组合上避免畸形比例。
//
// 字段命名尽量贴合任务书（head_shape / skin_tone / hair_style / body_type / leg_proportion…），
// 同时保留本项目既有语义（kit/accessories）。

import { likenessOf } from './real-likeness.js';

export const APPEARANCE_VERSION = 2;   // v2：加入脸型模板（HEAD_TEMPLATES），脸型由"离散类型 + 连续抖动"组成
// 换这个常量 = 全库重掷外观（确定性地重掷）。改它必须写进 PLAYER_MODEL_WORK_LOG.md。
export const APPEARANCE_SALT = 'fw3d-look-2026-v1';

// ─────────────────────────────────────────────────────────────
// 0. 随机与哈希
// ─────────────────────────────────────────────────────────────

// FNV-1a 32bit：稳定、与平台无关、不为 0（0 会让某些 RNG 退化）
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) || 0x9e3779b9;
}

// mulberry32：32 位状态、快、同种子完全可重放
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.state = () => a;
  return rng;
}

export function seedFor(playerId, salt) {
  return hashString(String(playerId == null ? 'anon' : playerId) + '|' + (salt || APPEARANCE_SALT));
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = (v, n) => { const p = Math.pow(10, n || 0); return Math.round(v * p) / p; };
const lerp = (a, b, t) => a + (b - a) * t;

// 近似正态（三段均匀和）：足球身高这类数据用正态比均匀更像真的，又不用 Box-Muller。
// 三段均匀均值 u 的标准差是 1/6，所以 (u-0.5) 要乘 6*sd 才能得到 ±sd 的真实标准差。
function gauss(rng, mean, sd) {
  const u = (rng() + rng() + rng()) / 3;
  return mean + (u - 0.5) * 6 * sd;
}

function pickWeighted(rng, list) {
  let total = 0;
  for (const it of list) total += it.weight;
  let x = rng() * total;
  for (const it of list) { x -= it.weight; if (x <= 0) return it; }
  return list[list.length - 1];
}

// ─────────────────────────────────────────────────────────────
// 1. 调色板（低模风格：颜色分区而不是贴图，所以肤色/发色是「可辨识」的第一层）
// ─────────────────────────────────────────────────────────────

// 肤色：12 档，横跨从浅到深，全部是中性描述，不带地域标签
export const SKIN_TONES = [
  { key: 'tone-01', hex: 0xf3d3bc, label: '很浅' },
  { key: 'tone-02', hex: 0xe8c0a2, label: '浅' },
  { key: 'tone-03', hex: 0xd9ae86, label: '浅偏暖' },   // 项目原色之一
  { key: 'tone-04', hex: 0xc99a72, label: '暖调' },
  { key: 'tone-05', hex: 0xb0805e, label: '中等' },     // 项目原色之一（旧默认）
  { key: 'tone-06', hex: 0x9a6b4c, label: '中等偏深' },
  { key: 'tone-07', hex: 0x8d5f43, label: '棕' },       // 项目原色之一
  { key: 'tone-08', hex: 0x7a4f37, label: '深棕' },
  { key: 'tone-09', hex: 0x6f4a33, label: '深' },       // 项目原色之一
  { key: 'tone-10', hex: 0x5c3a28, label: '很深' },
  { key: 'tone-11', hex: 0x482c1e, label: '黑褐' },
  { key: 'tone-12', hex: 0x36201a, label: '最深' },
];

export const HAIR_COLORS = [
  { key: 'jet-black', hex: 0x14100e, weight: 26 },
  { key: 'black', hex: 0x1d1712, weight: 22 },
  { key: 'dark-brown', hex: 0x2b1d14, weight: 18 },
  { key: 'brown', hex: 0x3f2a1c, weight: 13 },
  { key: 'chestnut', hex: 0x54351f, weight: 8 },
  { key: 'auburn', hex: 0x6b3a22, weight: 5 },
  { key: 'dark-blonde', hex: 0x8a6a3f, weight: 4 },
  { key: 'blonde', hex: 0xb89355, weight: 2.5 },
  { key: 'ginger', hex: 0x8a4a22, weight: 1.2 },
  { key: 'grey', hex: 0x6d6a66, weight: 0.2 },
];

export const EYE_COLORS = [
  { key: 'dark-brown', hex: 0x2a1a12, weight: 46 },
  { key: 'brown', hex: 0x4a2c18, weight: 26 },
  { key: 'hazel', hex: 0x6b4a20, weight: 12 },
  { key: 'green', hex: 0x3f5b32, weight: 7 },
  { key: 'grey-blue', hex: 0x4a5c66, weight: 5 },
  { key: 'blue', hex: 0x35517a, weight: 4 },
];

// 发型：几何复杂度都在低模预算内（每种 1–8 个方块的组合）
export const HAIR_STYLES = [
  { key: 'buzz', label: '寸头', weight: 16, minAge: 0 },
  { key: 'short', label: '短发', weight: 22, minAge: 0 },
  { key: 'crop', label: '短碎发', weight: 12, minAge: 0 },
  { key: 'side', label: '侧分', weight: 11, minAge: 12 },
  { key: 'curly', label: '卷发', weight: 9, minAge: 0 },
  { key: 'afro', label: '圆蓬发', weight: 5, minAge: 0 },
  { key: 'long', label: '长发', weight: 6, minAge: 0 },
  { key: 'bun', label: '丸子头', weight: 3, minAge: 14 },
  { key: 'ponytail', label: '马尾', weight: 3, minAge: 12 },
  { key: 'receding', label: '后移发际线', weight: 6, minAge: 30 },
  { key: 'bald', label: '光头', weight: 4, minAge: 24 },
  { key: 'mohawk', label: '莫西干', weight: 1.5, minAge: 14 },
];

export const FACIAL_HAIR = [
  { key: 'none', label: '无', weight: 40, minAge: 0 },
  { key: 'stubble', label: '胡茬', weight: 22, minAge: 19 },
  { key: 'mustache', label: '上唇胡', weight: 9, minAge: 20 },
  { key: 'goatee', label: '山羊胡', weight: 9, minAge: 21 },
  { key: 'beard', label: '短络腮胡', weight: 14, minAge: 22 },
  { key: 'fullbeard', label: '络腮胡', weight: 6, minAge: 24 },
];

// ─────────────────────────────────────────────────────────────
// 2. 位置先验（只影响身高/体型的分布，与能力无关）
// ─────────────────────────────────────────────────────────────

export const POSITION_PROFILES = {
  GK: { h: [189, 4.6], build: [0.58, 0.13], leg: [1.03, 0.035], label: '门将' },
  CB: { h: [187, 4.4], build: [0.64, 0.13], leg: [1.02, 0.035], label: '中卫' },
  LB: { h: [177, 4.0], build: [0.44, 0.13], leg: [1.00, 0.045], label: '左后卫' },
  RB: { h: [177, 4.0], build: [0.44, 0.13], leg: [1.00, 0.045], label: '右后卫' },
  DM: { h: [182, 4.4], build: [0.56, 0.13], leg: [1.00, 0.04], label: '后腰' },
  CM: { h: [179, 4.4], build: [0.48, 0.13], leg: [1.00, 0.045], label: '中场' },
  AM: { h: [176, 4.4], build: [0.42, 0.13], leg: [0.99, 0.045], label: '前腰' },
  LW: { h: [175, 4.2], build: [0.38, 0.12], leg: [0.98, 0.05], label: '左边锋' },
  RW: { h: [175, 4.2], build: [0.38, 0.12], leg: [0.98, 0.05], label: '右边锋' },
  ST: { h: [183, 4.8], build: [0.58, 0.14], leg: [1.01, 0.04], label: '中锋' },
  DEFAULT: { h: [180, 5.0], build: [0.50, 0.14], leg: [1.00, 0.05], label: '球员' },
};

export function positionProfile(position) {
  return POSITION_PROFILES[String(position || '').toUpperCase()] || POSITION_PROFILES.DEFAULT;
}

const BODY_TYPE_BANDS = [
  { max: 0.28, key: 'lean', label: '纤细' },
  { max: 0.55, key: 'athletic', label: '匀称' },
  { max: 0.78, key: 'powerful', label: '力量型' },
  { max: 1.01, key: 'stocky', label: '厚实' },
];
export function bodyTypeOf(build) {
  for (const b of BODY_TYPE_BANDS) if (build < b.max) return b.key;
  return 'stocky';
}

// ─────────────────────────────────────────────────────────────
// 2.5 脸型模板（离散类型 + 连续抖动）
// ─────────────────────────────────────────────────────────────
// 为什么要离散：纯连续倍率能生成"互不相同"的脸，但很难形成"记得住"的类型感。
// 先抽一个模板（方/圆/长/心形/窄/宽/菱形/椭圆），再在模板内小幅抖动，
// 既能保持个体差异，又能让玩家把"方脸+浓眉"记成一个具体的人。
// 每个模板的数值是**低模几何倍率**，不是真实人类测量值。
export const HEAD_TEMPLATES = [
  { key: 'oval', label: '椭圆脸', weight: 18, head: { width: 0.98, length: 1.03, depth: 1.00, jaw: 0.90, chin: 1.02, cheek: 1.00, brow: 0.95, forehead: 1.00, cheekbone: 0.40, taper: 0.45 } },
  { key: 'square', label: '方脸', weight: 16, head: { width: 1.06, length: 0.99, depth: 1.04, jaw: 1.00, chin: 0.99, cheek: 1.06, brow: 1.10, forehead: 1.02, cheekbone: 0.62, taper: 0.18 } },
  { key: 'long', label: '长脸', weight: 14, head: { width: 0.94, length: 1.08, depth: 0.98, jaw: 0.92, chin: 1.08, cheek: 0.98, brow: 0.90, forehead: 1.03, cheekbone: 0.38, taper: 0.42 } },
  { key: 'round', label: '圆脸', weight: 12, head: { width: 1.04, length: 0.95, depth: 1.03, jaw: 0.96, chin: 0.94, cheek: 1.06, brow: 0.85, forehead: 0.98, cheekbone: 0.50, taper: 0.55 } },
  { key: 'heart', label: '心形脸', weight: 11, head: { width: 1.02, length: 1.01, depth: 1.00, jaw: 0.84, chin: 1.06, cheek: 1.08, brow: 0.95, forehead: 1.04, cheekbone: 0.70, taper: 0.70 } },
  { key: 'wide', label: '宽脸', weight: 10, head: { width: 1.09, length: 0.97, depth: 1.05, jaw: 0.98, chin: 0.97, cheek: 1.09, brow: 1.15, forehead: 1.01, cheekbone: 0.58, taper: 0.30 } },
  { key: 'narrow', label: '窄脸', weight: 10, head: { width: 0.92, length: 1.05, depth: 0.96, jaw: 0.86, chin: 1.05, cheek: 0.95, brow: 0.90, forehead: 0.98, cheekbone: 0.34, taper: 0.60 } },
  { key: 'diamond', label: '菱形脸', weight: 9, head: { width: 0.99, length: 1.04, depth: 1.00, jaw: 0.88, chin: 1.04, cheek: 1.10, brow: 1.00, forehead: 0.97, cheekbone: 0.78, taper: 0.66 } },
];

export function headTemplateOf(key) {
  return HEAD_TEMPLATES.find((t) => t.key === key) || null;
}

// ─────────────────────────────────────────────────────────────
// 3. 生成
// ─────────────────────────────────────────────────────────────

/**
 * 生成一套外观参数。
 * @param {object} player 至少 { id }；可选 { position, age, nationality, height /*cm*\/, number, isRealPlayer, name }
 * @param {object} opts  { salt, overrides, kit, seed, region }
 * @returns {object} appearance（见文件头字段说明）
 */
export function appearanceFor(player, opts = {}) {
  const p = player || {};
  const id = p.id != null ? String(p.id) : 'anon-' + hashString(JSON.stringify(p));
  // 真实球员在游戏里的实体 id 是 P326 这种数字 id，资料库 id 在 realPlayerId 上；
  // 用资料库 id 当种子，保证同一个真实球员无论内部 id 怎么变都是同一张脸。
  const lid = p.realPlayerId ? String(p.realPlayerId) : id;
  const seed = opts.seed != null ? (opts.seed >>> 0) : seedFor(lid, opts.salt);
  const rng = makeRng(seed);

  const ageRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  // 年龄缺省时用独立随机流：这样「传了年龄」和「没传年龄」不会把后续所有字段的随机序列挤歪，
  // 同一个人在不同调用点（有/无 age 字段）仍然是同一张脸。
  const age = Number.isFinite(Number(p.age)) && Number(p.age) > 0 ? Number(p.age) : 25 + Math.floor(ageRng() * 8);
  const pos = String(p.position || '').toUpperCase();
  const prof = positionProfile(pos);

  // ── 身高：位置先验 + 年龄微调（18 岁以下还没长开）
  let height = gauss(rng, prof.h[0], prof.h[1]);
  if (age <= 18) height -= 2.5 - (age - 16) * 0.6;
  else if (age >= 34) height -= Math.min(1.5, (age - 33) * 0.25);
  height = clamp(Math.round(height), 163, 205);

  // ── 体型：位置先验 + 年龄（老将更容易偏厚重）+ 身高轻微相关
  let build = gauss(rng, prof.build[0], prof.build[1]);
  if (age >= 31) build += Math.min(0.14, (age - 30) * 0.02);
  if (age <= 20) build -= 0.07;
  build += (height - 180) * 0.004;
  build = clamp(build, 0, 1);
  const bodyType = bodyTypeOf(build);

  // ── 腿长比例：0.95（短腿厚实）..1.06（长腿），与 build 负相关
  let legProportion = clamp(gauss(rng, prof.leg[0], prof.leg[1]) - build * 0.03, 0.94, 1.07);

  // ── 肩宽：与 build 正相关，但避免「窄肩厚身」的违和组合
  const shoulderWidth = clamp(0.90 + build * 0.18 + (rng() - 0.5) * 0.06, 0.88, 1.16);

  // ── 体重：由身高与体型推（BMI 风格，非实测）
  const bmi = lerp(21.0, 25.6, build) + (rng() - 0.5) * 0.9;
  const weight = Math.round(Math.pow(height / 100, 2) * bmi);

  // ── 肤色：默认全局均匀（不做国籍→肤色映射，避免以貌推人）
  const skinIdx = pickSkinIndex(rng, opts);
  const skinTone = SKIN_TONES[skinIdx];

  // ── 年龄对毛发的影响：老将更容易发际线后移/光头、鬓角发灰
  const hairStyle = pickHairStyle(rng, age);
  let hairColor = pickWeighted(rng, HAIR_COLORS);
  if (age >= 40 && rng() < 0.55) hairColor = { key: 'grey', hex: 0x8b877f, weight: 1 };
  else if (age >= 34 && rng() < 0.22) hairColor = { key: 'grey-mix', hex: 0x5d5a55, weight: 1 };

  const facialHairStyle = pickFacialHair(rng, age);
  const facialHairColor = age >= 38 && rng() < 0.4 ? 0x6f6b64 : hairColor.hex;

  // ── 头部轮廓：辨识度的主载体（宽度/长度/下颌/颧骨/眉弓/下巴）
  // 先抽一个"脸型模板"（离散、可记忆的类型），再在模板内抖动。
  // 纯连续倍率的组合太多，反而记不住；有了类型感之后，人类更容易把"方脸+浓眉"记成一个具体的人。
  const tpl = pickWeighted(rng, HEAD_TEMPLATES);
  const jit = (base, sd, lo, hi) => round(clamp(base + (rng() - 0.5) * 2 * sd, lo, hi), 3);
  const head = {
    width: jit(tpl.head.width + build * 0.02, 0.030, 0.90, 1.12),
    length: jit(tpl.head.length + (height - 180) * 0.0012, 0.028, 0.93, 1.09),
    depth: jit(tpl.head.depth, 0.032, 0.90, 1.12),
    jaw: jit(tpl.head.jaw + build * 0.03, 0.040, 0.80, 1.02),        // 下颌宽度（相对头部宽度）
    chin: jit(tpl.head.chin, 0.050, 0.84, 1.16),                     // 下巴长度
    cheek: jit(tpl.head.cheek, 0.040, 0.90, 1.20),                   // 颧骨宽度
    brow: jit(tpl.head.brow, 0.120, 0.55, 1.45),                     // 眉弓突出
    forehead: jit(tpl.head.forehead, 0.035, 0.92, 1.10),             // 额头高度
    cheekbone: jit(tpl.head.cheekbone, 0.140, 0, 1),                 // 颧骨侧向突出
    taper: jit(tpl.head.taper, 0.120, 0, 1),                         // 上宽下窄程度
  };

  // ── 五官：眉眼/鼻/嘴/耳
  const face = {
    eyeSpacing: round(clamp(gauss(rng, 1.0, 0.06), 0.88, 1.14), 3),
    eyeSize: round(clamp(gauss(rng, 1.0, 0.11), 0.82, 1.24), 3),
    eyeTilt: round(clamp(gauss(rng, 0, 0.07), -0.18, 0.18), 3),
    browThickness: round(clamp(gauss(rng, 1.0, 0.17), 0.55, 1.55), 3),
    browAngle: round(clamp(gauss(rng, 0.05, 0.09), -0.22, 0.30), 3),
    noseWidth: round(clamp(gauss(rng, 1.0, 0.10), 0.78, 1.26), 3),
    noseLength: round(clamp(gauss(rng, 1.0, 0.09), 0.84, 1.20), 3),
    noseBridge: round(clamp(gauss(rng, 0.45, 0.24), 0, 1), 3),
    mouthWidth: round(clamp(gauss(rng, 1.0, 0.08), 0.84, 1.18), 3),
    mouthFull: round(clamp(gauss(rng, 0.45, 0.22), 0, 1), 3),
    earSize: round(clamp(gauss(rng, 1.0, 0.09), 0.80, 1.22), 3),
    earOut: round(clamp(gauss(rng, 0.35, 0.25), 0, 1), 3),
    eyeColor: pickWeighted(rng, EYE_COLORS).hex,
    browColor: hairColor.hex,
  };

  // ── 身体细分
  const body = {
    bodyType,
    build: round(build, 3),
    shoulderWidth: round(shoulderWidth, 3),
    chestDepth: round(clamp(0.92 + build * 0.16 + (rng() - 0.5) * 0.05, 0.90, 1.14), 3),
    waist: round(clamp(1.0 - build * 0.06 + (rng() - 0.5) * 0.05, 0.88, 1.08), 3),
    hipWidth: round(clamp(0.94 + build * 0.10 + (rng() - 0.5) * 0.05, 0.90, 1.12), 3),
    thigh: round(clamp(0.94 + build * 0.18 + (rng() - 0.5) * 0.05, 0.90, 1.16), 3),
    calf: round(clamp(0.95 + build * 0.12 + (rng() - 0.5) * 0.05, 0.90, 1.14), 3),
    armLength: round(clamp(gauss(rng, 1.0, 0.025), 0.95, 1.05), 3),
    legProportion: round(legProportion, 3),
    neck: round(clamp(0.94 + build * 0.14 + (rng() - 0.5) * 0.05, 0.90, 1.14), 3),
    muscle: round(clamp(build * 0.7 + rng() * 0.3, 0, 1), 3),
  };

  // ── 配件（按位置/年龄给不同的出现率；门将手套只在 GK 上出现）
  const accessories = {
    headband: rng() < (pos === 'GK' ? 0.05 : 0.035) ? (rng() < 0.5 ? 0x101318 : 0xd8dde3) : null,
    wristTape: rng() < 0.12,
    undershirt: rng() < 0.18,
    gloves: pos === 'GK' ? (rng() < 0.8 ? [0x2b2f36, 0xd8dde3, 0xc9a227][Math.floor(rng() * 3)] : null) : null,
    armband: false,          // 由场景按队长身份设置（不在这里猜）
    sockTape: rng() < 0.10,
    longSleeve: rng() < 0.04,
  };

  const appearance = {
    v: APPEARANCE_VERSION,
    playerId: id,
    seed,
    source: p.isRealPlayer ? 'real:procedural' : 'npc:procedural',
    height,
    weight,
    heightBand: height >= 193 ? 'tall' : height >= 186 ? 'upper' : height >= 178 ? 'mid' : height >= 172 ? 'lower' : 'short',
    legProportion: body.legProportion,
    bodyType,
    shoulderWidth: body.shoulderWidth,
    build,
    skin_tone: skinTone.hex,
    skinKey: skinTone.key,
    skinLabel: skinTone.label,
    head_shape: head,
    headTemplate: tpl.key,   // 脸型模板（离散，便于"记得住"）
    headLabel: tpl.label,
    face,
    hair_style: hairStyle.key,
    hair_label: hairStyle.label,
    hair_color: hairColor.hex,
    hairColorKey: hairColor.key,
    facial_hair: facialHairStyle.key,
    facial_hair_color: facialHairColor,
    body,
    accessories,
    kit: opts.kit || null,
    kitNumber: p.number != null ? Number(p.number) : (opts.kit && opts.kit.number != null ? Number(opts.kit.number) : null),
    position: pos || null,
    age,
    // 逐字段来源：默认全是程序生成；真实资料覆盖后由 overrides 改写
    provenance: {
      height: 'procedural', weight: 'procedural', skin_tone: 'procedural', hair_style: 'procedural',
      hair_color: 'procedural', facial_hair: 'procedural', head_shape: 'procedural',
      body: 'procedural', face: 'procedural', accessories: 'procedural',
    },
    sourceRefs: {},
    notes: [],
  };

  // 真实资料覆盖（每字段独立 + 逐字段来源标注）
  // 默认自动按 realPlayerId/id 查表：任何场景只要把球员记录交给生成器就能拿到真实外观。
  // （之前因为每个调用点各自传 overrides，有一处漏传就导致 13 名真实球员的覆盖在游戏内完全没生效。）
  const baseOv = (opts.overrides !== undefined) ? opts.overrides : (opts.noLikeness ? null : likenessOf(lid));
  // 玩家自己的外观覆盖：游戏内「自定义外观」写入 player.appearanceOverride（随存档持久化）。
  // 优先级：调用方显式传的 overrides > player.appearanceOverride > 真实资料 likeness。
  // 这样 2D 头像、3D 模型、资料卡读到的是同一份外观，不会出现"2D 一张脸、3D 另一张脸"。
  const ownOv = (player && player.appearanceOverride && typeof player.appearanceOverride === 'object')
    ? player.appearanceOverride : null;
  const ov = (baseOv || ownOv) ? Object.assign({}, ownOv || {}, baseOv || {}) : null;
  if (ov && typeof ov === 'object') {
    applyOverrides(appearance, ov);
  }
  return appearance;
}

function pickSkinIndex(rng, opts) {
  // 刻意：默认从全局 12 档里均匀抽，不做「国籍/联赛 → 肤色」的映射。
  // 理由写在 PLAYER_MODEL_LICENSES.md / REAL_PLAYER_LIKENESS_REPORT.md：
  // 由姓名或国籍推族裔外观既不准也不合适，游戏世界允许用 opts.skinBias 显式指定先验。
  const bias = opts && opts.skinBias;
  if (Array.isArray(bias) && bias.length === SKIN_TONES.length) {
    const list = bias.map((w, i) => ({ i, weight: Math.max(0, w) }));
    return pickWeighted(rng, list).i;
  }
  const idx = Math.floor(rng() * SKIN_TONES.length);
  return clamp(idx, 0, SKIN_TONES.length - 1);
}

function pickHairStyle(rng, age) {
  // 年龄越大，越可能后移发际线/光头
  const list = HAIR_STYLES.filter((h) => age >= h.minAge).map((h) => {
    let weight = h.weight;
    if (h.key === 'bald' || h.key === 'receding') weight *= 1 + Math.max(0, age - 30) * 0.16;
    if (h.key === 'buzz' || h.key === 'short' || h.key === 'crop') weight *= 1 + Math.max(0, age - 26) * 0.03;
    if ((h.key === 'afro' || h.key === 'curly' || h.key === 'long' || h.key === 'ponytail') && age > 32) weight *= 0.85;
    return { key: h.key, label: h.label, weight };
  });
  const picked = pickWeighted(rng, list);
  return { key: picked.key, label: picked.label };
}

function pickFacialHair(rng, age) {
  const list = FACIAL_HAIR.filter((f) => age >= f.minAge).map((f) => {
    let weight = f.weight;
    if (f.key !== 'none' && age < 24) weight *= 0.6;
    if (f.key === 'stubble') weight *= 1.1;
    if (f.key !== 'none' && age >= 34) weight *= 1.15;
    return { key: f.key, label: f.label, weight };
  });
  const picked = pickWeighted(rng, list);
  return { key: picked.key, label: picked.label };
}

/**
 * 把真实资料覆盖到生成结果上。只允许在 overrides 里写「有来源」的事实，
 * 每个被覆盖的字段必须在 provenance 里注明来源等级。
 */
export function applyOverrides(appearance, ov) {
  const prov = ov.provenance || {};
  const refs = ov.sourceRefs || {};
  const setProv = (field) => {
    appearance.provenance[field] = prov[field] || 'estimate';
    if (refs[field]) appearance.sourceRefs[field] = refs[field];
  };

  if (Number.isFinite(ov.height)) {
    appearance.height = clamp(Math.round(ov.height), 150, 220);
    appearance.heightBand = appearance.height >= 193 ? 'tall' : appearance.height >= 186 ? 'upper' : appearance.height >= 178 ? 'mid' : appearance.height >= 172 ? 'lower' : 'short';
    setProv('height');
    appearance.source = ov.source || 'real:curated';
  }
  if (Number.isFinite(ov.weight)) { appearance.weight = clamp(Math.round(ov.weight), 45, 130); setProv('weight'); }

  if (ov.skin_tone != null) {
    const tone = (typeof ov.skin_tone === 'string') ? SKIN_TONES.find((t) => t.key === ov.skin_tone) : null;
    const hex = tone ? tone.hex : (Number.isFinite(ov.skin_tone) ? ov.skin_tone : null);
    if (hex != null) {
      appearance.skin_tone = hex;
      const near = tone || nearestPalette(hex, SKIN_TONES);
      appearance.skinKey = near ? near.key : appearance.skinKey;
      appearance.skinLabel = near ? near.label : appearance.skinLabel;
      setProv('skin_tone');
    }
  }
  if (ov.hair_style && HAIR_STYLES.some((h) => h.key === ov.hair_style)) {
    appearance.hair_style = ov.hair_style;
    appearance.hair_label = (HAIR_STYLES.find((h) => h.key === ov.hair_style) || {}).label || ov.hair_style;
    setProv('hair_style');
  }
  if (Number.isFinite(ov.hair_color)) {
    appearance.hair_color = ov.hair_color;
    const near = nearestPalette(ov.hair_color, HAIR_COLORS);
    if (near) appearance.hairColorKey = near.key; else appearance.hairColorKey = 'custom';
    setProv('hair_color');
  }
  if (ov.facial_hair && FACIAL_HAIR.some((f) => f.key === ov.facial_hair)) {
    appearance.facial_hair = ov.facial_hair; setProv('facial_hair');
    if (ov.facial_hair === 'none') appearance.facial_hair_color = appearance.hair_color;
  }
  if (ov.head_shape && typeof ov.head_shape === 'object') {
    for (const k of ['width', 'length', 'depth', 'jaw', 'chin', 'cheek', 'brow', 'forehead', 'cheekbone', 'taper']) {
      if (Number.isFinite(ov.head_shape[k])) appearance.head_shape[k] = ov.head_shape[k];
    }
    setProv('head_shape');
  }
  if (ov.face && typeof ov.face === 'object') {
    for (const k of Object.keys(ov.face)) if (Number.isFinite(ov.face[k])) appearance.face[k] = ov.face[k];
    setProv('face');
  }
  if (ov.body && typeof ov.body === 'object') {
    for (const k of Object.keys(ov.body)) {
      if (Number.isFinite(ov.body[k])) appearance.body[k] = ov.body[k];
    }
    if (Number.isFinite(ov.body.build)) appearance.build = ov.body.build;
    if (ov.body.bodyType) appearance.bodyType = ov.body.bodyType;
    setProv('body');
  }
  if (ov.accessories && typeof ov.accessories === 'object') {
    Object.assign(appearance.accessories, ov.accessories);
    setProv('accessories');
  }
  if (Array.isArray(ov.notes)) appearance.notes.push(...ov.notes.map(String));
  if (ov.label) appearance.label = String(ov.label);
  if (ov.source) appearance.source = ov.source;
  else if (appearance.source !== 'user') appearance.source = 'real:curated';
  return appearance;
}

// ─────────────────────────────────────────────────────────────
// 4. 指纹 / 去重 / 校验
// ─────────────────────────────────────────────────────────────

// 用于判重的"脸部+身形"指纹：取真正影响观感的粗粒度分档，
// 太细会把「几乎一样的脸」判成不同，太粗又会误杀。
export function appearanceKey(a) {
  if (!a) return 'null';
  const q = (v, n) => Math.round((Number(v) || 0) * (n || 10));
  const h = a.head_shape || {};
  const f = a.face || {};
  const b = a.body || {};
  return [
    q(a.skin_tone / 0x10000, 1) === 0 ? 'x' : (a.skinKey || ''),
    a.hair_style, a.hairColorKey || q(a.hair_color, 1),
    a.facial_hair,
    q(h.width, 16), q(h.length, 16), q(h.depth, 16), q(h.jaw, 16), q(h.cheek, 12), q(h.chin, 14),
    q(f.eyeSpacing, 12), q(f.noseWidth, 12), q(f.mouthWidth, 12), q(f.browThickness, 10),
    q(b.shoulderWidth, 14), q(b.chestDepth, 12), q(b.legProportion, 20), q(a.height, 2),
  ].join('|');
}

/**
 * 批量生成（带去重）。同一 seed 下结果完全相同。
 * @param {number} count
 * @param {object} opts { salt, prefix, position?, ageRange?, kit?, playerFor?(i), avoidKeys? }
 */
export function generateMany(count, opts = {}) {
  const out = [];
  const seen = new Set(opts.avoidKeys || []);
  const salt = opts.salt || APPEARANCE_SALT;
  for (let i = 0; i < count; i++) {
    let attempt = 0, a = null, key = null;
    while (attempt < 12) {
      const id = (opts.playerFor && opts.playerFor(i)) || ((opts.prefix || 'NPC') + '-' + String(i).padStart(4, '0'));
      const player = Object.assign({}, opts.playerTemplate || {}, { id: attempt === 0 ? id : id + '#' + attempt });
      if (opts.position) player.position = opts.position;
      else if (Array.isArray(opts.positions) && opts.positions.length) {
        player.position = opts.positions[i % opts.positions.length];
      }
      if (opts.ageRange) {
        const r = makeRng(hashString(id + '|age'));
        player.age = Math.round(lerp(opts.ageRange[0], opts.ageRange[1], r()));
      }
      a = appearanceFor(player, { salt, kit: opts.kit, skinBias: opts.skinBias });
      key = appearanceKey(a);
      if (!seen.has(key)) break;
      attempt++;
    }
    seen.add(key);
    out.push(a);
  }
  return out;
}

export const RANGES = {
  height: [150, 220],
  weight: [45, 130],
  headWidth: [0.90, 1.12],
  headLength: [0.93, 1.09],
  headDepth: [0.90, 1.12],
  jaw: [0.80, 1.02],
  chin: [0.84, 1.16],
  cheek: [0.90, 1.20],
  brow: [0.55, 1.45],
  shoulderWidth: [0.88, 1.16],
  chestDepth: [0.90, 1.14],
  hipWidth: [0.90, 1.12],
  legProportion: [0.94, 1.07],
  build: [0, 1],
};

/** 结构校验：返回 { ok, issues[] }。给 node 测试与浏览器自检共用。 */
export function validateAppearance(a) {
  const issues = [];
  const need = (cond, msg) => { if (!cond) issues.push(msg); };
  need(a && a.v === APPEARANCE_VERSION, 'v 版本不符');
  need(a && typeof a.playerId === 'string' && a.playerId.length > 0, 'playerId 缺失');
  need(a && Number.isFinite(a.seed), 'seed 缺失');
  const inRange = (v, r, name) => need(Number.isFinite(v) && v >= r[0] && v <= r[1], name + ' 越界: ' + v);
  inRange(a.height, RANGES.height, 'height');
  inRange(a.weight, RANGES.weight, 'weight');
  inRange(a.build, RANGES.build, 'build');
  inRange(a.shoulderWidth, RANGES.shoulderWidth, 'shoulderWidth');
  inRange(a.legProportion, RANGES.legProportion, 'legProportion');
  inRange(a.skin_tone, [0, 0xffffff], 'skin_tone');
  inRange(a.hair_color, [0, 0xffffff], 'hair_color');
  need(HAIR_STYLES.some((h) => h.key === a.hair_style), 'hair_style 未知: ' + a.hair_style);
  need(FACIAL_HAIR.some((f) => f.key === a.facial_hair), 'facial_hair 未知: ' + a.facial_hair);
  const h = a.head_shape || {};
  inRange(h.width, RANGES.headWidth, 'head.width');
  inRange(h.length, RANGES.headLength, 'head.length');
  inRange(h.depth, RANGES.headDepth, 'head.depth');
  inRange(h.jaw, RANGES.jaw, 'head.jaw');
  inRange(h.chin, RANGES.chin, 'head.chin');
  inRange(h.cheek, RANGES.cheek, 'head.cheek');
  inRange(h.brow, RANGES.brow, 'head.brow');
  const b = a.body || {};
  inRange(b.chestDepth, RANGES.chestDepth, 'body.chestDepth');
  inRange(b.hipWidth, RANGES.hipWidth, 'body.hipWidth');
  // 比例合理性：腿长与身高、体型不能互相矛盾（避免畸形身材）
  need(a.legProportion > 0.9 && a.legProportion < 1.1, '腿长比例不合理');
  need(!(a.bodyType === 'lean' && a.shoulderWidth > 1.1), '纤细体型配过宽肩');
  for (const k of Object.keys(a.provenance || {})) {
    need(['source', 'estimate', 'procedural'].includes(a.provenance[k]), 'provenance 值非法: ' + k);
  }
  return { ok: issues.length === 0, issues };
}

/** 是否与足球能力解耦：本函数根本不读 stats —— 这里给出显式断言用的字段白名单。 */
export const APPEARANCE_INPUTS = ['id', 'position', 'age', 'nationality', 'height', 'number', 'isRealPlayer'];

// ─────────────────────────────────────────────────────────────
// 5. 外观 → 建模参数（仍不依赖 THREE，便于 node 里直接断言）
// ─────────────────────────────────────────────────────────────

// 发型的几何"预算"：低模风格下每种发型只用 1–8 个方块，帽高/capH 是头顶毛发块的高度（米）
const HAIR_GEOMETRY = {
  bald:     { capH: 0,     sides: 0,   back: 0,   top: 0,    front: 0 },
  buzz:     { capH: 0.028, sides: 0.2, back: 0.1, top: 0,    front: 0 },
  short:    { capH: 0.075, sides: 0.5, back: 0.3, top: 0,    front: 0.2 },
  crop:     { capH: 0.062, sides: 0.45, back: 0.35, top: 1,  front: 0.6 },
  side:     { capH: 0.080, sides: 0.55, back: 0.35, top: 1,  front: 0.9 },
  curly:    { capH: 0.085, sides: 0.5, back: 0.4, top: 5,    front: 0.4 },
  afro:     { capH: 0.130, sides: 0.7, back: 0.6, top: 2,    front: 0.3 },
  long:     { capH: 0.080, sides: 1,   back: 1,   top: 0,    front: 0.2 },
  bun:      { capH: 0.070, sides: 0.5, back: 0.4, top: 1,    front: 0.3 },
  ponytail: { capH: 0.070, sides: 0.45, back: 0.5, top: 1,   front: 0.3 },
  receding: { capH: 0.048, sides: 0.35, back: 0.5, top: 0,   front: 0 },
  mohawk:   { capH: 0.090, sides: 0.05, back: 0.05, top: 1,  front: 0.5 },
};

/**
 * 把外观参数翻译成 character.js 能直接用的「倍率 + 颜色」表。
 * 全部是相对 180cm 基准模型的无量纲倍率，或米制的小尺寸细节。
 * 纯函数：同外观同结果；不含 THREE。
 */
export function toMeshLook(a) {
  if (!a) return null;
  const b = a.body || {};
  const h = a.head_shape || {};
  const f = a.face || {};
  const acc = a.accessories || {};
  const build = Number.isFinite(b.build) ? b.build : (Number.isFinite(a.build) ? a.build : 0.5);
  const hairGeo = HAIR_GEOMETRY[a.hair_style] || HAIR_GEOMETRY.short;

  // 发型细节抖动：用外观自己的 seed 派生，保证「同一球员同一发型形状」
  const rng = makeRng((a.seed >>> 0) ^ 0x5bf03635);
  const tufts = [];
  for (let i = 0; i < 6; i++) {
    tufts.push({
      x: round((rng() - 0.5) * 0.9, 3),
      y: round(rng() * 0.6, 3),
      z: round((rng() - 0.5) * 0.9, 3),
      s: round(0.7 + rng() * 0.6, 3),
    });
  }

  // 胡茬色 = 发色本身（黑发 → 黑色胡茬）。不做任何混色/提亮处理：
  // 之前往肤色里混会变成褐色（"肉色胡子"），再往上抬亮度又会和发块糊在一起 —— 都不需要。
  const stubbleMix = (a.hair_color == null ? 0x222222 : a.hair_color);

  return {
    v: a.v,
    playerId: a.playerId,
    // 颜色
    skin: a.skin_tone,
    // 注意：这里必须是 hairColor 而不是 hair —— 返回对象末尾还有一个 `hair: {几何参数}`
    // （style/capH/sides/back/top/front/tufts）。两个同名字段会让**后者覆盖前者**，
    // 发色被静默丢掉；body.js 再把 L.hair（几何对象）当颜色传给材质，
    // THREE.Color.set(object) 不匹配任何分支 → 材质保持默认白色 → 渲染出来就是"光头/白头"。
    hairColor: a.hair_color,
    brow: a.face && a.face.browColor != null ? a.face.browColor : a.hair_color,
    eye: a.face && a.face.eyeColor != null ? a.face.eyeColor : 0x241a14,
    beardColor: a.facial_hair_color != null ? a.facial_hair_color : a.hair_color,
    stubbleColor: stubbleMix,
    // 整体
    heightScale: round(clamp(a.height / 180, 0.88, 1.15), 3),
    // 腿部
    leg: {
      hip: round(clamp(b.legProportion || 1, 0.94, 1.07), 3),
      thigh: round(b.thigh || 1, 3),
      calf: round(b.calf || 1, 3),
      hipX: round(clamp((b.hipWidth || 1) * 0.12, 0.10, 0.14), 3),
    },
    // 躯干/肩
    torso: {
      w: round(clamp(0.92 + build * 0.20, 0.90, 1.14), 3),
      d: round(clamp(b.chestDepth || 1, 0.90, 1.14), 3),
      waist: round(clamp(b.waist || 1, 0.88, 1.08), 3),
      shoulderX: round(clamp(0.92 + ((b.shoulderWidth || 1) - 1) * 1.15, 0.88, 1.12), 3),
      neck: round(clamp(b.neck || 1, 0.90, 1.14), 3),
    },
    arm: { len: round(clamp(b.armLength || 1, 0.95, 1.05), 3), w: round(clamp(0.94 + build * 0.14, 0.92, 1.10), 3) },
    // 头部轮廓
    head: {
      w: round(h.width || 1, 3),
      h: round(h.length || 1, 3),
      d: round(h.depth || 1, 3),
      jaw: round(h.jaw || 0.92, 3),
      cheek: round(h.cheek || 1, 3),
      brow: round(h.brow == null ? 0.95 : h.brow, 3),
      chin: round(h.chin || 1, 3),
      forehead: round(h.forehead || 1, 3),
      cheekbone: round(h.cheekbone == null ? 0.45 : h.cheekbone, 3),
      taper: round(h.taper == null ? 0.5 : h.taper, 3),
    },
    // 五官
    face: {
      eyeSpacing: round(f.eyeSpacing || 1, 3),
      eyeSize: round(f.eyeSize || 1, 3),
      eyeTilt: round(f.eyeTilt || 0, 3),
      browThickness: round(f.browThickness || 1, 3),
      browAngle: round(f.browAngle || 0, 3),
      noseWidth: round(f.noseWidth || 1, 3),
      noseLength: round(f.noseLength || 1, 3),
      noseBridge: round(f.noseBridge == null ? 0.45 : f.noseBridge, 3),
      mouthWidth: round(f.mouthWidth || 1, 3),
      mouthFull: round(f.mouthFull == null ? 0.45 : f.mouthFull, 3),
      earSize: round(f.earSize || 1, 3),
      earOut: round(f.earOut == null ? 0.35 : f.earOut, 3),
    },
    // 毛发
    hair: Object.assign({ style: a.hair_style, tufts }, hairGeo),
    beard: { style: a.facial_hair || 'none' },
    // 配件
    access: {
      headband: acc.headband == null ? null : acc.headband,
      wristTape: !!acc.wristTape,
      undershirt: !!acc.undershirt,
      gloves: acc.gloves == null ? null : acc.gloves,
      armband: !!acc.armband,
      sockTape: !!acc.sockTape,
      longSleeve: !!acc.longSleeve,
    },
    flags: { gk: !!(a.kit && a.kit.gk) },
    // 便于 UI / 排错
    summary: {
      height: a.height, weight: a.weight, bodyType: a.bodyType,
      hair: a.hair_label || a.hair_style, facialHair: a.facial_hair,
      skin: a.skinLabel || a.skinKey, legProportion: a.legProportion,
    },
  };
}

// 找到调色板里最接近的颜色项（覆盖真实资料时用数值 hex，需要回填 key/label）
function nearestPalette(hex, list) {
  let best = null, bestD = Infinity;
  for (const it of list) {
    const dr = ((it.hex >> 16) & 255) - ((hex >> 16) & 255);
    const dg = ((it.hex >> 8) & 255) - ((hex >> 8) & 255);
    const db = (it.hex & 255) - (hex & 255);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
}

function mixHex(c1, c2, t) {
  const a = (c1 == null ? 0x222222 : c1) >>> 0, b = (c2 == null ? 0xcccccc : c2) >>> 0;
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

export default {
  APPEARANCE_VERSION, APPEARANCE_SALT, SKIN_TONES, HAIR_COLORS, HAIR_STYLES, FACIAL_HAIR,
  POSITION_PROFILES, hashString, makeRng, seedFor, appearanceFor, applyOverrides,
  appearanceKey, generateMany, validateAppearance, bodyTypeOf, toMeshLook,
};
