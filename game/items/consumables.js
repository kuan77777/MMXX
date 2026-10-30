// 食物 / 饮水的「功效」系统：纯数据 + 纯逻辑，不依赖 three，可在 Node 里完整单测。
//
// 设计目标（详见 docs/食物功效设计.md）：
//   · 食物不只是"回饱食度的药水"：每件食物有 ①填饱 ②补水 ③补体力/生命 ④持续 buff ⑤风险 五件事；
//   · buff 按 id 刷新时长、不叠加；不同类型可共存；中毒/吃撑是"坏 buff"（红色）；
//   · 食物中毒是概率事件（过期罐头 / 生食），用 dot（每秒掉血）实现；
//   · 饱食度已经很高时再猛吃会"吃撑"（短时间体力恢复变慢），避免站着狂吃刷体力；
//   · 配置在 cfg.player.foodEffects，关掉它整个系统退回旧的"只加饱食/水分"行为。
//
// 这里只负责"算出该加什么"，真正改数值在 Player 里做（applyConsume），方便单测与回放。

/** 全部 buff 定义。dur 单位秒；mods 里乘法项默认 1，加法项默认 0。 */
export const BUFF_DEFS = {
  // ── 好 buff
  b_well_fed: {
    id: 'b_well_fed', name: '饱腹', dur: 240, bad: false,
    mods: { hungerMul: 0.75 },
    note: '饥饿速度 -25%',
  },
  b_sugar_rush: {
    id: 'b_sugar_rush', name: '糖分冲刺', dur: 90, bad: false,
    mods: { staminaRegenMul: 1.4, thirstMul: 1.3 },
    note: '体力恢复 +40%，口渴 +30%',
  },
  b_hydrated: {
    id: 'b_hydrated', name: '补水', dur: 180, bad: false,
    mods: { thirstMul: 0.7 },
    note: '口渴速度 -30%',
  },
  b_citrus: {
    id: 'b_citrus', name: '维生素', dur: 150, bad: false,
    mods: { thirstMul: 0.75, healthRegenAdd: 0.35 },
    note: '口渴 -25%，自然回血 +0.35/s',
  },
  b_potassium: {
    id: 'b_potassium', name: '钾盐', dur: 120, bad: false,
    mods: { sprintMul: 0.9 },
    note: '冲刺体力消耗 -10%',
  },
  b_chill: {
    id: 'b_chill', name: '冰凉', dur: 120, bad: false,
    mods: { sprintMul: 0.85, thirstMul: 1.2 },
    note: '冲刺消耗 -15%，口渴 +20%',
  },
  // ── 坏 buff
  b_stuffed: {
    id: 'b_stuffed', name: '吃撑', dur: 60, bad: true,
    mods: { staminaRegenMul: 0.8, sprintMul: 1.1 },
    note: '体力恢复 -20%，冲刺消耗 +10%',
  },
  b_poisoned: {
    id: 'b_poisoned', name: '食物中毒', dur: 12, bad: true,
    mods: { staminaRegenMul: 0.5 },
    dot: 1.4,
    note: '每秒 -1.4 生命，体力恢复 -50%',
  },
};

/** 同屏最多显示 / 同时存在几个 buff（超出替换最早获得的一个）。 */
export const MAX_BUFFS = 4;

/** 默认的玩法参数（cfg.player.foodEffects 可以逐项覆盖）。 */
export const DEFAULT_FOOD_EFFECTS = {
  enabled: true,
  lowHunger: 25,          // 饱食低于它 → 体力恢复变慢
  lowHungerRegenMul: 0.7,
  lowThirst: 25,          // 口渴低于它 → 冲刺更累
  lowThirstSprintMul: 1.15,
  starvingDps: 1.2,       // 饱食/口渴归零时的掉血（每秒）
  overeatAbove: 85,       // 饱食高于它再进食 → 吃撑
  overeatStamina: 8,      // 吃撑立刻扣的体力
  overeatThirst: 6,       // 吃撑立刻加的口渴
  naturalRegen: 0.9,      // 吃饱喝足时的自然回血（每秒）
};

const EMPTY_MODS = Object.freeze({
  hungerMul: 1, thirstMul: 1, staminaRegenMul: 1, sprintMul: 1, healthRegenAdd: 0,
});

/** 把外部配置（可能缺项）补全成安全值。 */
export function foodEffectConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_FOOD_EFFECTS };
  for (const k of Object.keys(DEFAULT_FOOD_EFFECTS)) {
    if (typeof DEFAULT_FOOD_EFFECTS[k] === 'boolean') out[k] = src[k] === undefined ? out[k] : !!src[k];
    else if (Number.isFinite(Number(src[k]))) out[k] = Number(src[k]);
  }
  return out;
}

/**
 * buff 列表：id 唯一、刷新时长、限制数量。
 * 时间推进由 Player 每帧调用 tick(dt)。
 */
export class BuffList {
  constructor(max = MAX_BUFFS) {
    this.max = Math.max(1, Math.floor(max) || MAX_BUFFS);
    this.entries = new Map();   // id -> { left, total }
  }

  /** 获得 buff：已存在则刷新到满时长（不叠加），否则新增；超出上限时踢掉最早获得的。 */
  add(id) {
    const def = BUFF_DEFS[id];
    if (!def) return null;
    const existed = this.entries.has(id);
    if (!existed && this.entries.size >= this.max) {
      // Map 保持插入顺序：第一个就是最早获得的；坏 buff 优先保留（中毒不能被好 buff 挤掉）
      const firstId = this.entries.keys().next().value;
      const firstDef = BUFF_DEFS[firstId];
      if (!(firstDef && firstDef.bad && !def.bad)) this.entries.delete(firstId);
      else return null;   // 满身坏 buff 时，新的好 buff 不生效（避免互相挤掉中毒）
    }
    this.entries.set(id, { left: def.dur, total: def.dur });
    return def;
  }

  remove(id) { this.entries.delete(id); }
  clear() { this.entries.clear(); }
  has(id) { return this.entries.has(id); }

  tick(dt) {
    const expired = [];
    for (const [id, e] of this.entries) {
      e.left -= dt;
      if (e.left <= 0) expired.push(id);
    }
    for (const id of expired) this.entries.delete(id);
    return expired;
  }

  /** 聚合后的乘数/加数。 */
  mods() {
    let hungerMul = 1, thirstMul = 1, staminaRegenMul = 1, sprintMul = 1, healthRegenAdd = 0;
    for (const [id] of this.entries) {
      const m = BUFF_DEFS[id] && BUFF_DEFS[id].mods;
      if (!m) continue;
      if (m.hungerMul) hungerMul *= m.hungerMul;
      if (m.thirstMul) thirstMul *= m.thirstMul;
      if (m.staminaRegenMul) staminaRegenMul *= m.staminaRegenMul;
      if (m.sprintMul) sprintMul *= m.sprintMul;
      if (m.healthRegenAdd) healthRegenAdd += m.healthRegenAdd;
    }
    return { hungerMul, thirstMul, staminaRegenMul, sprintMul, healthRegenAdd };
  }

  /** 每秒持续伤害（中毒）。 */
  dot() {
    let v = 0;
    for (const [id] of this.entries) if (BUFF_DEFS[id] && BUFF_DEFS[id].dot) v += BUFF_DEFS[id].dot;
    return v;
  }

  /** 给 UI 用：[{ id, name, left, total, bad, note }]，按剩余时间降序。 */
  list() {
    const out = [];
    for (const [id, e] of this.entries) {
      const def = BUFF_DEFS[id];
      if (!def) continue;
      out.push({ id, name: def.name, left: Math.max(0, e.left), total: e.total, bad: !!def.bad, note: def.note || '' });
    }
    return out.sort((a, b) => b.left - a.left);
  }

  serialize() { return [...this.entries].map(([id, e]) => [id, Math.round(e.left * 10) / 10]); }
  restore(arr) {
    this.entries.clear();
    if (!Array.isArray(arr)) return;
    for (const rec of arr) {
      if (!Array.isArray(rec)) continue;
      const def = BUFF_DEFS[rec[0]];
      if (!def) continue;
      this.entries.set(rec[0], { left: Math.max(0.1, Math.min(def.dur, Number(rec[1]) || def.dur)), total: def.dur });
    }
  }
}

/** 物品的 effects 对象（老物品没有该字段时，用顶层 hunger/thirst 兜底）。 */
export function effectsOf(def) {
  if (!def) return null;
  if (def.effects && typeof def.effects === 'object') return def.effects;
  if (def.kind !== 'food' && def.kind !== 'drink') return null;
  return { hunger: def.hunger || 0, thirst: def.thirst || 0 };
}

/**
 * 计算一次进食/饮水的效果（纯函数，不改任何状态）。
 * @param {object} o
 * @param {object} o.def       物品定义（ITEMS[id]）
 * @param {object} o.stats     { hunger, maxHunger, thirst, maxThirst, stamina, maxStamina, health, maxHealth }
 * @param {object} o.buffs     BuffList（要读"是否已经中毒"）
 * @param {object} o.cfg       foodEffectConfig(...) 的结果
 * @param {() => number} o.rng 随机源（测试可注入）
 * @returns {{ok:boolean, deltas:{hunger:number,thirst:number,stamina:number,health:number},
 *            buffIds:string[], poison:boolean, stuffed:boolean, messages:string[], def:object}}
 */
export function consumeEffects({ def, stats, buffs, cfg, rng = Math.random }) {
  const cfgv = cfg || DEFAULT_FOOD_EFFECTS;
  const eff = effectsOf(def);
  if (!eff || (def.kind !== 'food' && def.kind !== 'drink')) {
    return { ok: false, deltas: zeroDeltas(), buffIds: [], poison: false, stuffed: false, messages: [], def };
  }
  const deltas = zeroDeltas();
  const messages = [];
  const buffIds = [];

  // ① 填饱 / 补水
  deltas.hunger = Number(eff.hunger) || 0;
  deltas.thirst = Number(eff.thirst) || 0;
  deltas.stamina = Number(eff.stamina) || 0;
  deltas.health = Number(eff.health) || 0;

  // ② 吃撑：饱食已经很高还硬塞固态食物
  const isDrink = def.kind === 'drink';
  let stuffed = false;
  if (cfgv.enabled && !isDrink && (stats.hunger || 0) >= cfgv.overeatAbove) {
    stuffed = true;
    deltas.stamina -= cfgv.overeatStamina;
    deltas.thirst = (Number(eff.thirst) || 0) - cfgv.overeatThirst;   // 吃撑额外口渴
    buffIds.push('b_stuffed');
    messages.push(`吃得太撑（体力 -${cfgv.overeatStamina}、口渴 +${cfgv.overeatThirst}）`);
  }

  // ③ buff
  if (cfgv.enabled && eff.buff) {
    const list = Array.isArray(eff.buff) ? eff.buff : [eff.buff];
    for (const id of list) {
      if (!BUFF_DEFS[id]) continue;
      buffIds.push(id);
      messages.push(`获得「${BUFF_DEFS[id].name}」${fmtDur(BUFF_DEFS[id].dur)}`);
    }
  }

  // ④ 风险：食物中毒（概率；已经中毒时不重复判定，避免"毒上加毒"）
  let poison = false;
  const risk = eff.risk || null;
  if (cfgv.enabled && risk && Number(risk.poison) > 0 && !(buffs && buffs.has && buffs.has('b_poisoned'))) {
    const chance = Math.max(0, Math.min(1, Number(risk.poison)));
    if (rng() < chance) {
      poison = true;
      buffIds.push('b_poisoned');
      messages.push(risk.reason ? `${risk.reason} —— 食物中毒！` : '食物中毒！');
    }
  }

  return { ok: true, deltas, buffIds, poison, stuffed, messages, def };
}

function zeroDeltas() { return { hunger: 0, thirst: 0, stamina: 0, health: 0 }; }
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`;
}

/**
 * 把一次进食应用到玩家对象上（Player.useItem 调它）。
 * 只依赖 player 上的字段：hunger/thirst/stamina/health 与 max*、buffs、cfg。
 */
export function applyConsume(player, def, opts = {}) {
  const cfg = foodEffectConfig(player.cfg && player.cfg.player && player.cfg.player.foodEffects);
  const plan = consumeEffects({
    def,
    stats: {
      hunger: player.hunger, maxHunger: player.maxHunger,
      thirst: player.thirst, maxThirst: player.maxThirst,
      stamina: player.stamina, maxStamina: player.maxStamina,
      health: player.health, maxHealth: player.maxHealth,
    },
    buffs: player.buffs,
    cfg,
    rng: opts.rng || Math.random,
  });
  if (!plan.ok) return plan;

  const d = plan.deltas;
  player.hunger = clamp(player.hunger + d.hunger, 0, player.maxHunger);
  player.thirst = clamp(player.thirst + d.thirst, 0, player.maxThirst);
  player.stamina = clamp(player.stamina + d.stamina, 0, player.maxStamina);
  if (d.health > 0) player.heal(d.health);

  if (cfg.enabled && player.buffs) for (const id of plan.buffIds) player.buffs.add(id);

  // 文案：吃到什么、加了多少
  const parts = [];
  if (d.hunger) parts.push(`饱食 ${signed(d.hunger)}`);
  if (d.thirst) parts.push(`水分 ${signed(d.thirst)}`);
  if (d.stamina) parts.push(`体力 ${signed(d.stamina)}`);
  if (d.health) parts.push(`生命 ${signed(d.health)}`);
  const verb = def.kind === 'drink' ? '喝了' : '吃了';
  plan.message = [`${verb}${def.name}${parts.length ? '：' + parts.join('，') : ''}`, ...plan.messages].join('；');
  return plan;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const signed = (v) => (v > 0 ? `+${Math.round(v * 10) / 10}` : String(Math.round(v * 10) / 10));

/**
 * 给 UI 的"功效说明"：一行短文案 + 是否有风险。
 * 例：'饱食 +42 · 生命 +2 · 饱腹 4:00'
 */
export function describeEffects(def) {
  const eff = effectsOf(def);
  if (!eff) return { text: '', risk: '' };
  const parts = [];
  if (eff.hunger) parts.push(`饱食 ${signed(eff.hunger)}`);
  if (eff.thirst) parts.push(`水分 ${signed(eff.thirst)}`);
  if (eff.stamina) parts.push(`体力 ${signed(eff.stamina)}`);
  if (eff.health) parts.push(`生命 ${signed(eff.health)}`);
  const buffs = eff.buff ? (Array.isArray(eff.buff) ? eff.buff : [eff.buff]) : [];
  for (const id of buffs) {
    const b = BUFF_DEFS[id];
    if (b) parts.push(`${b.name} ${fmtDur(b.dur)}`);
  }
  let risk = '';
  if (eff.risk && eff.risk.poison > 0) risk = `⚠ 有 ${Math.round(eff.risk.poison * 100)}% 概率食物中毒`;
  return { text: parts.join(' · '), risk };
}

export default {
  BUFF_DEFS, MAX_BUFFS, DEFAULT_FOOD_EFFECTS, BuffList,
  foodEffectConfig, effectsOf, consumeEffects, applyConsume, describeEffects, fmtDur,
};
