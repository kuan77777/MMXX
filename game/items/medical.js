// 医疗「功效」系统：伤情状态 + 治疗结算，纯逻辑、不依赖 three。
//
// 设计目标（详见 docs/医疗功效设计.md）：
//   · 伤害不等于"少几点血"：被打/被咬/摔下来会留下**伤情**（流血 / 感染 / 骨折 / 疼痛），
//     不同伤情有不同的惩罚，需要不同的医疗品来处理；
//   · 医疗品不是"加血的药水"：绷带止血、夹板正骨、抗生素消炎、止痛药压疼、急救包通吃但慢；
//   · 治疗要花时间（1~3.5 秒），受伤/冲刺会打断 —— 医疗是战斗中的战术决策；
//   · 药有耐受：短时间内连吃止痛药效果递减（防止"狂磕药"）。
//
// 伤情严重度统一用 0~1，便于调参与显示。

export const WOUND_KINDS = ['bleeding', 'infection', 'fracture', 'pain'];

export const WOUND_INFO = {
  bleeding: {
    id: 'bleeding', name: '流血', icon: '✚',
    note: '持续掉血、并把伤口变成感染源（用绷带/急救包止血）',
    hpDrain: (s) => s * (0.6 + 2.0 * s),     // 满级约 2.6 HP/s
    decay: 0.02,                              // 不处理会慢慢凝血（但会感染）
    color: 'bad',
  },
  infection: {
    id: 'infection', name: '感染', icon: '☠',
    note: '慢慢掉血、更容易饿渴、体力恢复变慢（用抗生素）',
    hpDrain: (s) => s * (0.25 + 0.9 * s),     // 满级约 1.15 HP/s
    decay: 0.01,
    color: 'bad',
  },
  fracture: {
    id: 'fracture', name: '骨折', icon: '⚣',
    note: '移速与跳跃受限、更容易累（用夹板固定）',
    hpDrain: () => 0,
    decay: 0.002,                             // 基本只能靠夹板
    color: 'bad',
  },
  pain: {
    id: 'pain', name: '疼痛', icon: '✖',
    note: '准星更抖、体力恢复变慢（止痛药可压制，会自然消退）',
    hpDrain: () => 0,
    decay: 0.05,
    color: 'warn',
  },
};

/** 止痛药耐受：连续使用效果递减，停一段时间后恢复。 */
export const TOLERANCE = {
  perDose: 0.28,
  decayPerSec: 0.01,
  max: 0.75,
};

/** 伤情状态机：只存四个严重度 + 耐受，tick 时返回惩罚与掉血。 */
export class MedicalState {
  constructor() {
    this.bleeding = 0;
    this.infection = 0;
    this.fracture = 0;
    this.pain = 0;
    this.tolerance = 0;
    this.treating = null;   // { itemId, until, duration, list, index } 由玩家层维护
  }

  get any() { return this.bleeding > 0.01 || this.infection > 0.01 || this.fracture > 0.01 || this.pain > 0.01; }

  /** 增加伤情（0~1）。返回实际增加值。 */
  add(kind, amount) {
    if (!WOUND_KINDS.includes(kind)) return 0;
    const before = this[kind];
    this[kind] = clamp01(before + Math.max(0, Number(amount) || 0));
    return this[kind] - before;
  }

  /** 减少伤情（治疗）。返回实际治好多少。 */
  cure(kind, amount) {
    if (!WOUND_KINDS.includes(kind)) return 0;
    const before = this[kind];
    this[kind] = clamp01(before - Math.max(0, Number(amount) || 0));
    return before - this[kind];
  }

  clear() {
    this.bleeding = 0; this.infection = 0; this.fracture = 0; this.pain = 0;
    this.tolerance = 0; this.treating = null;
  }

  /**
   * 推进时间。返回 { hpDrain, thirstMul, hungerMul }。
   * 感染的来源是"伤口没处理"：流血越重，感染越快。
   */
  tick(dt) {
    const d = Math.max(0, Math.min(0.25, Number(dt) || 0));
    // 疼痛随时间消退；耐受也会慢慢降下来
    this.pain = Math.max(0, this.pain - WOUND_INFO.pain.decay * d);
    this.tolerance = Math.max(0, this.tolerance - TOLERANCE.decayPerSec * d);
    // 流血：不处理会自己凝血，但期间在把伤口"泡"成感染
    if (this.bleeding > 0) {
      if (this.bleeding > 0.15) this.infection = clamp01(this.infection + 0.02 * this.bleeding * d);
      this.bleeding = Math.max(0, this.bleeding - 0.02 * d);
    } else if (this.infection > 0) {
      // 没有开放伤口时，免疫系统会慢慢压下去
      this.infection = Math.max(0, this.infection - 0.01 * d);
    }
    if (this.fracture > 0) this.fracture = Math.max(0, this.fracture - 0.002 * d);

    const hpDrain = (this.bleeding > 0 ? WOUND_INFO.bleeding.hpDrain(this.bleeding) : 0)
      + (this.infection > 0 ? WOUND_INFO.infection.hpDrain(this.infection) : 0);
    return {
      hpDrain,
      thirstMul: 1 + 0.35 * this.infection,
      hungerMul: 1 + 0.25 * this.infection,
    };
  }

  /** 当前惩罚（玩家层每帧取用）。 */
  penalties() {
    const { bleeding, infection, fracture, pain } = this;
    return {
      moveMul: clamp(1 - 0.3 * fracture - 0.08 * pain, 0.45, 1),
      spreadMul: 1 + 0.8 * pain + 0.25 * fracture,
      staminaRegenMul: clamp(1 - 0.4 * infection - 0.15 * pain, 0.35, 1),
      sprintMul: 1 + 0.5 * fracture + 0.2 * pain,
      jumpCostMul: 1 + 0.6 * fracture,
      hpDrainPerSec: (bleeding > 0 ? WOUND_INFO.bleeding.hpDrain(bleeding) : 0)
        + (infection > 0 ? WOUND_INFO.infection.hpDrain(infection) : 0),
    };
  }

  /** 给 HUD 用：[{ id, name, icon, severity, note }]，只列 >1% 的。 */
  list() {
    const out = [];
    for (const kind of WOUND_KINDS) {
      const s = this[kind];
      if (s <= 0.01) continue;
      const info = WOUND_INFO[kind];
      out.push({ id: kind, name: info.name, icon: info.icon, severity: Math.round(s * 100) / 100, note: info.note, bad: true });
    }
    return out;
  }

  serialize() {
    return {
      bleeding: round2(this.bleeding), infection: round2(this.infection),
      fracture: round2(this.fracture), pain: round2(this.pain), tolerance: round2(this.tolerance),
    };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return;
    this.bleeding = clamp01(Number(data.bleeding) || 0);
    this.infection = clamp01(Number(data.infection) || 0);
    this.fracture = clamp01(Number(data.fracture) || 0);
    this.pain = clamp01(Number(data.pain) || 0);
    this.tolerance = clamp(Math.max(0, Number(data.tolerance) || 0), 0, TOLERANCE.max);
  }
}

/**
 * 一件医疗品的"功效画像"（纯数据，给 UI/测试/文档共用）。
 * treat 字段：
 *   stopBleed 止血量   healHp 回血量   pain 止痛量   infection 消炎量   fracture 复位量
 *   stamina 立刻回体力  duration 治疗耗时（秒）  risk 副作用（如抗生素伤胃：临时降低饱食）
 */
export function treatOf(def) {
  if (!def || def.kind !== 'medical') return null;
  const t = def.treat && typeof def.treat === 'object' ? def.treat : null;
  if (!t) return { healHp: Number(def.heal) || 0, duration: 0 };
  return {
    stopBleed: Number(t.stopBleed) || 0,
    healHp: Number.isFinite(Number(t.healHp)) ? Number(t.healHp) : (Number(def.heal) || 0),
    pain: Number(t.pain) || 0,
    infection: Number(t.infection) || 0,
    fracture: Number(t.fracture) || 0,
    stamina: Number(t.stamina) || 0,
    duration: Math.max(0, Number(t.duration) || 0),
    painkiller: !!t.painkiller,
    sideEffects: t.sideEffects || null,
  };
}

/**
 * 计算一次治疗的效果（纯函数，不改状态）。
 * @param {object} o
 * @param {object} o.def 物品定义
 * @param {MedicalState} o.med 当前伤情
 * @param {object} o.stats { health, maxHealth, stamina, maxStamina }
 * @param {number} [o.progress] 0~1：治疗被打断时按进度给部分效果（默认 1）
 * @returns {{ok:boolean, cured:object, healedHp:number, stamina:number, messages:string[], tolerance:number, duration:number}}
 */
export function planTreatment({ def, med, stats, progress = 1 }) {
  const t = treatOf(def);
  if (!t) return { ok: false, cured: {}, healedHp: 0, stamina: 0, messages: [], tolerance: 0, duration: 0 };
  const k = clamp01(Number(progress) || 0);
  const messages = [];
  const cured = {};

  // 止痛药：耐受越高越不灵（最少保留 35% 效果）
  let painMul = 1;
  if (t.painkiller) {
    painMul = Math.max(0.35, 1 - (med ? med.tolerance : 0));
    if (painMul < 0.99) messages.push(`止痛药耐受（效果 ${Math.round(painMul * 100)}%）`);
  }

  const apply = (kind, amount) => {
    const want = Math.max(0, amount) * k;
    const got = med ? Math.min(med[kind] || 0, want) : 0;
    if (got > 0.001) { cured[kind] = round2(got); messages.push(`${WOUND_INFO[kind].name} -${Math.round(got * 100)}%`); }
  };
  apply('bleeding', t.stopBleed);
  apply('pain', t.pain * painMul);
  apply('infection', t.infection);
  apply('fracture', t.fracture);

  const healedHp = Math.max(0, t.healHp) * k;
  if (healedHp > 0.5) messages.push(`生命 +${Math.round(healedHp)}`);
  const stamina = Math.max(0, t.stamina) * k;

  // 耐受：只有止痛药积累
  const tolerance = t.painkiller && med
    ? Math.min(TOLERANCE.max, med.tolerance + TOLERANCE.perDose * k)
    : (med ? med.tolerance : 0);

  return {
    ok: true, cured, healedHp, stamina, messages, tolerance,
    duration: t.duration, sideEffects: t.sideEffects, def,
  };
}

/** 把治疗计划真正落到状态上（玩家层调用）。 */
export function applyTreatment(plan, med, player) {
  if (!plan || !plan.ok) return plan;
  for (const [kind, amount] of Object.entries(plan.cured)) med.cure(kind, amount);
  med.tolerance = plan.tolerance;
  if (plan.healedHp > 0 && player) player.heal(plan.healedHp);
  if (plan.stamina > 0 && player) player.stamina = Math.min(player.maxStamina, player.stamina + plan.stamina);
  if (plan.sideEffects && player) {
    // 副作用：例如抗生素"伤胃"——直接压一点饱食度
    if (plan.sideEffects.hunger) player.hunger = Math.max(0, player.hunger - plan.sideEffects.hunger);
    if (plan.sideEffects.thirst) player.thirst = Math.max(0, player.thirst - plan.sideEffects.thirst);
  }
  return plan;
}

/** 伤情从哪来：伤害类型 → 伤情（纯函数，方便调参与测试）。 */
export const WOUND_RULES = {
  bite: { bleeding: 0.45, infection: 0.3, pain: 0.35, fracture: 0 },      // 僵尸咬/抓
  bullet: { bleeding: 0.35, infection: 0.05, pain: 0.25, fracture: 0.04 }, // 中枪
  melee: { bleeding: 0.15, infection: 0.02, pain: 0.2, fracture: 0.05 },   // 被钝器打
  fall: { bleeding: 0.1, infection: 0.02, pain: 0.25, fracture: 0.35 },    // 摔伤（按高度缩放）
  vehicle: { bleeding: 0.2, infection: 0.03, pain: 0.3, fracture: 0.2 },
};

/**
 * 按伤害类型施加伤情，severity 0~1 是"轻重"（通常 = 伤害/最大生命，再乘个系数）。
 * @returns {{bleeding:number, infection:number, fracture:number, pain:number}} 实际增加量
 */
export function applyWound(med, kind, severity = 1) {
  const rule = WOUND_RULES[kind];
  if (!med || !rule) return null;
  const s = clamp(severity, 0, 1);
  const added = {};
  for (const w of WOUND_KINDS) {
    const amount = (rule[w] || 0) * s;
    if (amount > 0) added[w] = round2(med.add(w, amount));
  }
  return added;
}

/** UI 文案：'止血 100% · 生命 +55 · 3.0s' */
export function describeTreat(def) {
  const t = treatOf(def);
  if (!t) return { text: '', note: '' };
  const parts = [];
  if (t.stopBleed) parts.push(`止血 ${Math.round(t.stopBleed * 100)}%`);
  if (t.infection) parts.push(`消炎 ${Math.round(t.infection * 100)}%`);
  if (t.fracture) parts.push(`复位 ${Math.round(t.fracture * 100)}%`);
  if (t.pain) parts.push(`止痛 ${Math.round(t.pain * 100)}%`);
  if (t.healHp) parts.push(`生命 +${Math.round(t.healHp)}`);
  if (t.stamina) parts.push(`体力 +${Math.round(t.stamina)}`);
  if (t.duration > 0) parts.push(`${t.duration.toFixed(1)}s`);
  const note = t.painkiller ? '（有耐受：短时间内连用效果递减）' : (t.sideEffects && t.sideEffects.hunger ? '（伤胃：饱食 -8）' : '');
  return { text: parts.join(' · '), note };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const clamp01 = (v) => clamp(v, 0, 1);
const round2 = (v) => Math.round(v * 100) / 100;

export default {
  WOUND_KINDS, WOUND_INFO, TOLERANCE, MedicalState, treatOf, planTreatment, applyTreatment,
  applyWound, WOUND_RULES, describeTreat,
};
