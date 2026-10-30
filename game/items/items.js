// 物品 / 背包 / 战利品系统：纯数据 + 纯逻辑，不依赖 three（可在 Node 里完整单测）。
//
// 设计要点：
// · 每个物品有**稳定 ID**（i_xxx），绝不靠显示名识别；存档只存 id + 数量 + 耐久等数值状态。
// · 搜刮表按"地点类型"配置概率；住宅偏食物/衣物/工具，医疗点偏药品，警局/军用偏枪弹。
// · 重量与数量限制是可配置规则（config.items），超重时 pickUp 返回明确原因而不是静默失败。
// · 枪械外观只来自 Ultimate Guns，Survival Pack 只贡献非枪械物品（见 ASSET_CATALOG.md）。

export const ITEM_KINDS = ['weapon', 'ammo', 'food', 'drink', 'medical', 'tool', 'material', 'clothing', 'misc'];

/** 物品总表。weight 单位 kg，stack 为最大堆叠数。 */
export const ITEMS = {
  // ── 武器（外观对应 Ultimate Guns / Survival Pack 的近战斧）
  i_w_pistol: { id: 'i_w_pistol', name: '手枪', kind: 'weapon', weaponId: 'w_pistol_9mm', weight: 1.1, stack: 1, icon: 'gun', desc: '可靠的近战自卫武器。' },
  i_w_rifle: { id: 'i_w_rifle', name: '步枪', kind: 'weapon', weaponId: 'w_rifle_556', weight: 3.6, stack: 1, icon: 'rifle', desc: '中远距离的主力枪械。' },
  i_w_shotgun: { id: 'i_w_shotgun', name: '霰弹枪', kind: 'weapon', weaponId: 'w_shotgun_12g', weight: 4.2, stack: 1, icon: 'shotgun', desc: '近距离威力极大。' },
  i_w_smg: { id: 'i_w_smg', name: '冲锋枪', kind: 'weapon', weaponId: 'w_smg_9mm', weight: 2.6, stack: 1, icon: 'gun', desc: '射速极高，压制成群的感染者。' },
  i_w_sniper: { id: 'i_w_sniper', name: '狙击步枪', kind: 'weapon', weaponId: 'w_sniper_762', weight: 5.2, stack: 1, icon: 'rifle', desc: '一发穿两三个，但换弹很慢。' },
  i_w_axe: { id: 'i_w_axe', name: '消防斧', kind: 'weapon', weaponId: 'w_melee_axe', weight: 2.2, stack: 1, icon: 'crowbar', desc: 'Survival Pack 里的斧子：劈砍够狠，也能砸开木箱。' },
  // 旧的"球棒"：道具包里没有球棒模型（只有斧/刀/铲），所以停止掉落，只保留定义，
  // 让还带着它的旧存档能正常读取（没有模型时退回程序化球棒外观）。
  i_w_bat: { id: 'i_w_bat', name: '球棒', kind: 'weapon', weaponId: 'w_melee_bat', weight: 1.4, stack: 1, icon: 'bat', desc: '球场看台上捡来的球棒。' },

  // ── 弹药（物品 id 约定为 i_<ammoId>，见 player.ammoItemId）
  i_ammo_9mm: { id: 'i_ammo_9mm', name: '9mm 子弹', kind: 'ammo', ammoId: 'ammo_9mm', weight: 0.012, stack: 60, icon: 'ammo' },
  i_ammo_556: { id: 'i_ammo_556', name: '5.56 子弹', kind: 'ammo', ammoId: 'ammo_556', weight: 0.012, stack: 90, icon: 'ammo' },
  i_ammo_12g: { id: 'i_ammo_12g', name: '12 号霰弹', kind: 'ammo', ammoId: 'ammo_12g', weight: 0.05, stack: 40, icon: 'ammo' },
  i_ammo_762: { id: 'i_ammo_762', name: '7.62 子弹', kind: 'ammo', ammoId: 'ammo_762', weight: 0.024, stack: 30, icon: 'ammo' },

  // ── 食物 / 饮水（Ultimate Food；尺寸与重量按现实物件）
  // effects = 完整功效（见 items/consumables.js）：即时四项 + 持续 buff + 风险。
  // 顶层的 hunger/thirst 保留（旧代码/存档/测试都读它），数值与 effects 保持一致。
  i_food_can: {
    id: 'i_food_can', name: '罐头', kind: 'food', weight: 0.4, stack: 8, icon: 'can',
    hunger: 42,
    desc: '过期了，但还能吃。',
    effects: { hunger: 42, health: 2, buff: 'b_well_fed', risk: { poison: 0.1, reason: '罐头过期了' } },
  },
  i_food_bread: {
    id: 'i_food_bread', name: '面包', kind: 'food', weight: 0.35, stack: 4, icon: 'bar',
    hunger: 34,
    desc: '压得有点扁，但管饱。',
    effects: { hunger: 34, stamina: 4, buff: 'b_well_fed' },
  },
  i_food_bar: {
    id: 'i_food_bar', name: '能量棒', kind: 'food', weight: 0.12, stack: 10, icon: 'bar',
    hunger: 18, thirst: -3,
    desc: '热量密度高，就是有点干。',
    effects: { hunger: 18, thirst: -3, stamina: 12, buff: 'b_sugar_rush' },
  },
  i_food_chocolate: {
    id: 'i_food_chocolate', name: '巧克力', kind: 'food', weight: 0.1, stack: 10, icon: 'bar',
    hunger: 22, thirst: -4,
    desc: '热量很高，也很耐放。',
    effects: { hunger: 22, thirst: -4, stamina: 18, buff: 'b_sugar_rush' },
  },
  i_food_apple: {
    id: 'i_food_apple', name: '苹果', kind: 'food', weight: 0.18, stack: 10, icon: 'apple',
    hunger: 14, thirst: 8,
    desc: '脆、水分足，还能顶一会儿饿。',
    effects: { hunger: 14, thirst: 8, health: 3, buff: 'b_hydrated' },
  },
  i_food_orange: {
    id: 'i_food_orange', name: '橙子', kind: 'food', weight: 0.2, stack: 10, icon: 'apple',
    hunger: 12, thirst: 12,
    desc: '有点酸，但水分足。',
    effects: { hunger: 12, thirst: 12, health: 4, buff: 'b_citrus' },
  },
  i_food_banana: {
    id: 'i_food_banana', name: '香蕉', kind: 'food', weight: 0.16, stack: 10, icon: 'apple',
    hunger: 16, thirst: 4,
    desc: '钾含量高，跑起来不容易腿软。',
    effects: { hunger: 16, thirst: 4, stamina: 8, buff: 'b_potassium' },
  },
  i_food_pizza: {
    id: 'i_food_pizza', name: '披萨', kind: 'food', weight: 0.22, stack: 6, icon: 'pizza',
    hunger: 32, thirst: 2,
    desc: '冷掉的披萨，但比罐头香。',
    effects: { hunger: 32, thirst: 2, stamina: 6, health: 4, buff: 'b_well_fed' },
  },
  i_food_sushi: {
    id: 'i_food_sushi', name: '寿司', kind: 'food', weight: 0.2, stack: 6, icon: 'sushi',
    hunger: 26, thirst: 6,
    desc: '放了不知道多久的生鱼……',
    effects: { hunger: 26, thirst: 6, stamina: 8, health: 2, buff: 'b_well_fed', risk: { poison: 0.15, reason: '生鱼不新鲜' } },
  },
  i_food_icecream: {
    id: 'i_food_icecream', name: '冰淇淋', kind: 'food', weight: 0.14, stack: 4, icon: 'icecream',
    hunger: 10, thirst: 10,
    desc: '化了一半，但在热天里是真舒服。',
    effects: { hunger: 10, thirst: 10, stamina: 10, buff: 'b_chill' },
  },
  i_drink_water: {
    id: 'i_drink_water', name: '瓶装水', kind: 'drink', weight: 0.55, stack: 6, icon: 'water',
    thirst: 45,
    desc: '最可靠的东西，别浪费。',
    effects: { thirst: 45, buff: 'b_hydrated' },
  },
  i_drink_soda: {
    id: 'i_drink_soda', name: '汽水', kind: 'drink', weight: 0.42, stack: 6, icon: 'soda',
    thirst: 26, hunger: 3,
    desc: '糖分能顶一阵，但越喝越渴。',
    effects: { thirst: 26, hunger: 3, stamina: 6, buff: 'b_sugar_rush' },
  },

  // ── 医疗（treat = 治疗功效，见 items/medical.js；heal 与 treat.healHp 保持一致）
  // 定位：绷带止血（快、便宜）、急救包通吃（慢、重）、止痛药止痛（有耐受）、
  //       抗生素消炎（伤胃）、夹板正骨（只管骨折）
  i_med_bandage: {
    id: 'i_med_bandage', name: '绷带', kind: 'medical', weight: 0.1, stack: 10, icon: 'bandage',
    heal: 12,
    desc: '止血用的，别指望它把伤口长好。',
    treat: { stopBleed: 0.6, healHp: 12, pain: 0.1, duration: 1.5 },
  },
  i_med_kit: {
    id: 'i_med_kit', name: '急救包', kind: 'medical', weight: 0.7, stack: 3, icon: 'medkit',
    heal: 55,
    desc: '绷带 + 止血钳 + 夹板，什么都能顶一下，就是慢。',
    treat: { stopBleed: 1, healHp: 55, pain: 0.3, fracture: 0.15, duration: 3 },
  },
  i_med_pills: {
    id: 'i_med_pills', name: '止痛药', kind: 'medical', weight: 0.08, stack: 8, icon: 'pills',
    heal: 6,
    desc: '立刻压住疼痛，但是药三分毒——连着吃会越来越不灵。',
    treat: { pain: 0.7, healHp: 6, stamina: 15, duration: 0.6, painkiller: true },
  },
  i_med_antibiotics: {
    id: 'i_med_antibiotics', name: '抗生素', kind: 'medical', weight: 0.12, stack: 6, icon: 'medkit',
    heal: 8,
    desc: '专治感染。伤胃，吃完更饿。',
    treat: { infection: 0.8, healHp: 8, duration: 2, sideEffects: { hunger: 8 } },
  },
  i_med_splint: {
    id: 'i_med_splint', name: '夹板', kind: 'medical', weight: 0.35, stack: 4, icon: 'wood',
    heal: 0,
    desc: '两块木板加布条，能把断腿固定住（只管骨折，不回血）。',
    treat: { fracture: 0.9, pain: 0.2, duration: 2.5 },
  },

  // ── 工具 / 材料
  i_tool_flashlight: { id: 'i_tool_flashlight', name: '手电筒', kind: 'tool', weight: 0.35, stack: 1, icon: 'flashlight', desc: '室内照明。' },
  i_tool_crowbar: { id: 'i_tool_crowbar', name: '撬棍', kind: 'tool', weight: 1.6, stack: 1, icon: 'crowbar', desc: '可以撬开容器。' },
  // 汽油桶：车辆的唯一"续命"资源。给车加油 = 消耗一桶（见 docs/VEHICLES.md）
  i_tool_fuel_can: { id: 'i_tool_fuel_can', name: '汽油桶', kind: 'tool', weight: 3.2, stack: 2, icon: 'fuel', desc: '给汽车加油（一桶 +45%）。很重，别背太多。' },
  i_mat_scrap: { id: 'i_mat_scrap', name: '废金属', kind: 'material', weight: 0.5, stack: 20, icon: 'scrap', desc: '修车/修理都要它。' },
  i_mat_wood: { id: 'i_mat_wood', name: '木板', kind: 'material', weight: 0.8, stack: 12, icon: 'wood' },
  i_mat_cloth: { id: 'i_mat_cloth', name: '布料', kind: 'material', weight: 0.2, stack: 20, icon: 'cloth' },
  i_mat_battery: { id: 'i_mat_battery', name: '电池', kind: 'material', weight: 0.15, stack: 8, icon: 'battery' },

  // ── 衣物（与球衣系统联动：战利品里的球衣是"可换装"的外观来源）
  i_cloth_jersey: { id: 'i_cloth_jersey', name: '旧球衣', kind: 'clothing', weight: 0.3, stack: 3, icon: 'jersey', desc: '某支球队的旧球衣。' },
  i_cloth_jacket: { id: 'i_cloth_jacket', name: '防风外套', kind: 'clothing', weight: 0.9, stack: 1, icon: 'jacket' },
  i_misc_radio: { id: 'i_misc_radio', name: '对讲机', kind: 'misc', weight: 0.4, stack: 1, icon: 'radio', desc: '还能收到零星的求救信号。' },
  i_misc_photo: { id: 'i_misc_photo', name: '旧照片', kind: 'misc', weight: 0.02, stack: 1, icon: 'photo' },
};

export function itemById(id) { return ITEMS[id] || null; }

/** 按"地点类型"配置的战利品表：每一项是 [物品id, 权重, 最小数量, 最大数量]。 */
export const LOOT_TABLES = {
  residential: [
    ['i_food_can', 16, 1, 2], ['i_food_bar', 14, 1, 3], ['i_drink_water', 14, 1, 1],
    ['i_food_orange', 9, 1, 2], ['i_food_banana', 8, 1, 2], ['i_food_bread', 7, 1, 1],
    ['i_food_pizza', 5, 1, 1], ['i_food_icecream', 4, 1, 1],
    ['i_med_bandage', 10, 1, 2], ['i_mat_cloth', 12, 1, 3], ['i_mat_wood', 8, 1, 3],
    ['i_cloth_jersey', 8, 1, 1], ['i_cloth_jacket', 4, 1, 1], ['i_misc_photo', 3, 1, 1],
    ['i_ammo_9mm', 6, 4, 12], ['i_tool_flashlight', 3, 1, 1],
  ],
  commercial: [
    ['i_food_can', 12, 1, 3], ['i_food_bar', 10, 1, 3], ['i_drink_soda', 12, 1, 2],
    ['i_drink_water', 8, 1, 2], ['i_food_chocolate', 10, 1, 2], ['i_food_bread', 6, 1, 1],
    ['i_food_pizza', 9, 1, 2], ['i_food_sushi', 7, 1, 2], ['i_food_icecream', 6, 1, 1],
    ['i_mat_battery', 9, 1, 3], ['i_med_bandage', 8, 1, 2],
    ['i_tool_crowbar', 4, 1, 1], ['i_ammo_9mm', 8, 6, 16], ['i_mat_scrap', 8, 1, 4],
    ['i_misc_radio', 3, 1, 1],
  ],
  medical: [
    ['i_med_bandage', 26, 1, 4], ['i_med_kit', 12, 1, 2], ['i_med_pills', 16, 1, 3],
    ['i_med_antibiotics', 10, 1, 2], ['i_med_splint', 8, 1, 1],
    ['i_drink_water', 8, 1, 1], ['i_mat_cloth', 10, 1, 3], ['i_mat_battery', 4, 1, 2],
  ],
  industrial: [
    ['i_mat_scrap', 24, 2, 6], ['i_mat_wood', 16, 1, 4], ['i_mat_battery', 10, 1, 2],
    ['i_tool_crowbar', 10, 1, 1], ['i_tool_flashlight', 6, 1, 1], ['i_ammo_9mm', 8, 4, 12],
    ['i_ammo_556', 6, 4, 10], ['i_food_bar', 6, 1, 2], ['i_w_axe', 4, 1, 1],
    ['i_tool_fuel_can', 9, 1, 1],
  ],
  military: [
    ['i_ammo_556', 22, 8, 24], ['i_ammo_12g', 16, 4, 12], ['i_ammo_9mm', 14, 8, 20],
    ['i_ammo_762', 10, 5, 15],
    ['i_w_rifle', 6, 1, 1], ['i_w_shotgun', 5, 1, 1], ['i_w_pistol', 8, 1, 1],
    ['i_w_smg', 5, 1, 1], ['i_w_sniper', 3, 1, 1],
    ['i_med_kit', 8, 1, 1], ['i_tool_flashlight', 5, 1, 1],
  ],
  // 车里/工具箱（也是后备箱战利品表）
  vehicle: [
    ['i_ammo_9mm', 10, 3, 9], ['i_tool_crowbar', 8, 1, 1], ['i_mat_scrap', 12, 1, 3],
    ['i_food_bar', 8, 1, 2], ['i_med_bandage', 6, 1, 2], ['i_mat_battery', 6, 1, 1],
    ['i_tool_fuel_can', 7, 1, 1],
  ],
};

export const LOOT_TABLE_IDS = Object.keys(LOOT_TABLES);

function mulberry32(a) {
  let t = a >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按权重从战利品表抽一次。
 * @param {string} tableId
 * @param {() => number} rng
 * @param {number} luck 0..2，>1 时倾向多抽
 */
export function rollLoot(tableId, rng = Math.random, luck = 1) {
  const table = LOOT_TABLES[tableId] || LOOT_TABLES.residential;
  const total = table.reduce((s, e) => s + e[1], 0);
  let r = rng() * total;
  let entry = table[table.length - 1];
  for (const e of table) {
    r -= e[1];
    if (r <= 0) { entry = e; break; }
  }
  const [itemId, , minN, maxN] = entry;
  const def = ITEMS[itemId];
  if (!def) return null;
  const span = Math.max(0, (maxN || 1) - (minN || 1));
  const count = Math.max(1, Math.round((minN || 1) + rng() * span * luck));
  return { itemId, count: Math.min(def.stack || 99, count) };
}

/** 一个容器抽 0..n 件。空容器是允许的（真实感 + 让玩家知道"这箱搜过了"）。 */
export function rollContainer(tableId, rng = Math.random, opts = {}) {
  const minRolls = opts.minRolls != null ? opts.minRolls : 1;
  const maxRolls = opts.maxRolls != null ? opts.maxRolls : 3;
  const luck = Number.isFinite(opts.luck) ? opts.luck : 1;
  const rolls = Math.floor(minRolls + rng() * (maxRolls - minRolls + 1));
  const out = [];
  const seen = new Map();
  for (let i = 0; i < rolls; i += 1) {
    if (rng() < 0.12) continue; // 空抽
    const roll = rollLoot(tableId, rng, luck);
    if (!roll) continue;
    const prev = seen.get(roll.itemId);
    if (prev) prev.count = Math.min((ITEMS[roll.itemId].stack || 99), prev.count + roll.count);
    else { seen.set(roll.itemId, roll); out.push(roll); }
  }
  return out;
}

/** 按地点类型推战利品表（layout 里已经给容器指定了，这里作为兜底）。 */
export function tableForDistrict(district) {
  switch (district) {
    case 'industrial': return 'military';
    case 'commercial': return 'commercial';
    case 'plaza': return 'commercial';
    case 'park': return 'residential';
    default: return 'residential';
  }
}

// ─────────────────────────────────────────────────────────────
// 背包
// ─────────────────────────────────────────────────────────────

export class Inventory {
  /**
   * @param {object} opts { maxWeight, stackSize, quickSlots, onChange }
   */
  constructor(opts = {}) {
    this.maxWeight = Number.isFinite(opts.maxWeight) ? opts.maxWeight : 24;
    this.quickSlots = Number.isFinite(opts.quickSlots) ? opts.quickSlots : 6;
    this.onChange = opts.onChange || null;
    // slots: 固定长度数组，元素为 {itemId, count} 或 null
    this.slots = new Array(Number.isFinite(opts.slotCount) ? opts.slotCount : 30).fill(null);
    this.quick = new Array(this.quickSlots).fill(null);
    this.activeQuick = 0;
  }

  _changed() { if (this.onChange) this.onChange(this); }

  get weight() {
    let w = 0;
    for (const s of this.slots) if (s) w += (ITEMS[s.itemId] ? ITEMS[s.itemId].weight : 0) * s.count;
    for (const s of this.quick) if (s) w += (ITEMS[s.itemId] ? ITEMS[s.itemId].weight : 0) * s.count;
    return Math.round(w * 100) / 100;
  }

  get isOverweight() { return this.weight > this.maxWeight + 1e-6; }

  /** 剩余可容纳的重量。 */
  get freeWeight() { return Math.max(0, this.maxWeight - this.weight); }

  countItem(itemId) {
    let n = 0;
    for (const s of this.slots) if (s && s.itemId === itemId) n += s.count;
    for (const s of this.quick) if (s && s.itemId === itemId) n += s.count;
    return n;
  }

  /**
   * 添加物品。返回 {added, left, reason}。
   * 重量检查按"实际能放进去的数量"算，不做全有全无，避免玩家看着 0.1kg 的东西放不进去。
   */
  add(itemId, count = 1, opts = {}) {
    const def = ITEMS[itemId];
    if (!def) return { added: 0, left: count, reason: 'unknown_item' };
    const stack = Math.max(1, def.stack || 1);
    let left = Math.max(0, Math.floor(count));
    let added = 0;
    let weightLimited = false;
    const ignoreWeight = opts.ignoreWeight === true;

    const tryPut = (arr, index) => {
      const slot = arr[index];
      if (slot && slot.itemId === itemId && slot.count < stack) {
        const canByWeight = ignoreWeight ? Infinity : Math.floor((this.maxWeight - this.weight) / (def.weight || 0.0001));
        if (canByWeight <= 0) weightLimited = true;
        const space = Math.min(stack - slot.count, left, Math.max(0, canByWeight));
        if (space > 0) { slot.count += space; left -= space; added += space; }
        return space > 0;
      }
      return false;
    };

    // 先填已有堆叠
    for (let i = 0; i < this.slots.length && left > 0; i += 1) tryPut(this.slots, i);
    for (let i = 0; i < this.quick.length && left > 0; i += 1) tryPut(this.quick, i);
    // 再开新格（快捷栏优先）
    for (let i = 0; i < this.quick.length && left > 0; i += 1) {
      if (this.quick[i]) continue;
      const canByWeight = ignoreWeight ? Infinity : Math.floor((this.maxWeight - this.weight) / (def.weight || 0.0001));
      if (canByWeight <= 0) { weightLimited = true; break; }
      const put = Math.min(stack, left, canByWeight);
      if (put <= 0) break;
      this.quick[i] = { itemId, count: put };
      left -= put; added += put;
    }
    for (let i = 0; i < this.slots.length && left > 0; i += 1) {
      if (this.slots[i]) continue;
      const canByWeight = ignoreWeight ? Infinity : Math.floor((this.maxWeight - this.weight) / (def.weight || 0.0001));
      if (canByWeight <= 0) { weightLimited = true; break; }
      const put = Math.min(stack, left, canByWeight);
      if (put <= 0) break;
      this.slots[i] = { itemId, count: put };
      left -= put; added += put;
    }

    if (added) this._changed();
    // 放不进去的原因要准确：是重量限制还是格子满了（任务书要求"返回明确原因"）
    const reason = left > 0 ? (weightLimited || this.isOverweight ? 'overweight' : 'full') : null;
    return { added, left, reason };
  }

  /** 移除指定数量（跨格）。返回实际移除数。 */
  remove(itemId, count = 1) {
    let need = Math.max(0, Math.floor(count));
    let removed = 0;
    const take = (arr) => {
      for (let i = 0; i < arr.length && need > 0; i += 1) {
        const s = arr[i];
        if (!s || s.itemId !== itemId) continue;
        const n = Math.min(s.count, need);
        s.count -= n; need -= n; removed += n;
        if (s.count <= 0) arr[i] = null;
      }
    };
    take(this.quick);
    take(this.slots);
    if (removed) this._changed();
    return removed;
  }

  removeAt(listName, index, count = 1) {
    const arr = listName === 'quick' ? this.quick : this.slots;
    const s = arr[index];
    if (!s) return 0;
    const n = Math.min(s.count, Math.max(0, Math.floor(count)));
    s.count -= n;
    if (s.count <= 0) arr[index] = null;
    if (n) this._changed();
    return n;
  }

  getActiveQuick() { return this.quick[this.activeQuick] || null; }

  setActiveQuick(i) {
    if (i < 0 || i >= this.quick.length) return null;
    this.activeQuick = i;
    this._changed();
    return this.getActiveQuick();
  }

  /** 存档：只保留稳定 ID 与数量。 */
  serialize() {
    const enc = (arr) => arr.map((s) => (s ? [s.itemId, s.count] : null));
    return { maxWeight: this.maxWeight, activeQuick: this.activeQuick, slots: enc(this.slots), quick: enc(this.quick) };
  }

  static deserialize(data, opts = {}) {
    const inv = new Inventory({ maxWeight: data && data.maxWeight, quickSlots: opts.quickSlots, slotCount: opts.slotCount, onChange: opts.onChange });
    const dec = (arr, target) => {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < target.length && i < arr.length; i += 1) {
        const s = arr[i];
        if (!s || !Array.isArray(s)) continue;
        const [itemId, count] = s;
        if (!ITEMS[itemId]) continue; // 旧版本/被删除的物品直接丢弃，不让存档读崩
        const c = Math.max(1, Math.min(ITEMS[itemId].stack || 99, Math.floor(Number(count) || 0)));
        target[i] = { itemId, count: c };
      }
    };
    dec(data && data.slots, inv.slots);
    dec(data && data.quick, inv.quick);
    inv.activeQuick = Number.isFinite(data && data.activeQuick) ? Math.max(0, Math.min(inv.quick.length - 1, data.activeQuick)) : 0;
    return inv;
  }
}

/** 容器刷新：同一个容器 id + 轮次 → 同一批战利品（可复现，方便测试）。 */
export function lootForContainer(container, round = 0, opts = {}) {
  const table = container.lootTable || 'residential';
  const seed = hashString(`${container.id}:${round}`);
  const rng = mulberry32(seed);
  const items = rollContainer(table, rng, opts);
  return { items, table, seed };
}

export function hashString(str) {
  let h = 2166136261;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export default { ITEMS, LOOT_TABLES, Inventory, rollLoot, rollContainer, lootForContainer };
