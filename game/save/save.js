// 本地存档：版本号 + 迁移/校验 + 明确的错误信息。
// 原则：只存稳定 ID 与数值状态，绝不把 THREE 对象写进存档（那些对象循环引用，JSON 化会直接爆）。
// 写入时机由 game.js 控制（定时 + 关键事件），绝不每帧写。

export const SAVE_VERSION = 3;
export const SAVE_KEY = 'fwdeadworld.save.v3';

/** 合法存档的基本骨架检查。 */
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * 校验并（必要时）迁移存档。
 * @returns {{ok:boolean, data:object|null, error:string|null, migrated:boolean}}
 */
export function validateSave(raw, nowVersion = SAVE_VERSION) {
  if (raw == null) return { ok: false, data: null, error: '没有存档', migrated: false };
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) {
      return { ok: false, data: null, error: '存档不是合法 JSON（可能已损坏）', migrated: false };
    }
  }
  if (!isObj(obj)) return { ok: false, data: null, error: '存档格式不正确', migrated: false };
  const v = Number(obj.version);
  if (!Number.isFinite(v) || v < 1) return { ok: false, data: null, error: '存档缺少版本号', migrated: false };
  if (v > nowVersion) {
    return { ok: false, data: null, error: `存档版本 ${v} 高于当前游戏版本 ${nowVersion}，请更新游戏`, migrated: false };
  }

  let migrated = false;
  let data = obj;
  if (v < nowVersion) {
    try {
      data = migrate(obj, v, nowVersion);
      migrated = true;
    } catch (e) {
      return { ok: false, data: null, error: `存档迁移失败：${e && e.message}`, migrated: false };
    }
  }

  // 关键字段兜底：缺了也能进游戏，但会用默认值
  if (!isObj(data.player)) data.player = null;
  if (!isObj(data.world)) data.world = {};
  if (!Array.isArray(data.world.openedContainers)) data.world.openedContainers = [];
  if (!Array.isArray(data.world.npcsDead)) data.world.npcsDead = [];
  if (!isObj(data.quests)) data.quests = { active: [], completed: [] };
  if (!Array.isArray(data.quests.active)) data.quests.active = [];
  if (!Array.isArray(data.quests.completed)) data.quests.completed = [];
  if (!Number.isFinite(Number(data.seed))) data.seed = 20260801;
  data.version = nowVersion;
  return { ok: true, data, error: null, migrated };
}

function migrate(data, from, to) {
  const d = JSON.parse(JSON.stringify(data));
  let v = from;
  // v1 → v2：容器状态从 {id:true} 改成数组
  if (v < 2) {
    if (isObj(d.world) && isObj(d.world.openedContainers)) {
      d.world.openedContainers = Object.keys(d.world.openedContainers);
    }
    v = 2;
  }
  // v2 → v3：玩家武器状态改为数组 + 记录 equipped
  if (v < 3) {
    if (isObj(d.player) && isObj(d.player.weapons) && !Array.isArray(d.player.weapons)) {
      d.player.weapons = Object.keys(d.player.weapons).map((id) => ({ id, ammo: Number(d.player.weapons[id]) || 0 }));
    }
    v = 3;
  }
  if (v > to) throw new Error(`无法迁移到 ${to}`);
  return d;
}

export class SaveManager {
  /**
   * @param {object} opts { storage, key, autosaveSeconds }
   */
  constructor(opts = {}) {
    this.key = opts.key || SAVE_KEY;
    this.storage = opts.storage || safeStorage();
    this.autosaveSeconds = Number.isFinite(opts.autosaveSeconds) ? opts.autosaveSeconds : 60;
    this._timer = 0;
    this.lastSavedAt = 0;
    this.lastError = null;
    this.saveCount = 0;
  }

  get available() { return !!this.storage; }

  /** @returns {{ok:boolean, error?:string, bytes?:number}} */
  save(payload) {
    if (!this.storage) return { ok: false, error: '浏览器不支持本地存储' };
    try {
      const data = Object.assign({}, payload, {
        version: SAVE_VERSION,
        savedAt: Date.now(),
      });
      // 提前序列化，确保任何循环引用在这里就报错，而不是写坏存储
      const json = JSON.stringify(data);
      this.storage.setItem(this.key, json);
      this.lastSavedAt = Date.now();
      this.saveCount += 1;
      this.lastError = null;
      return { ok: true, bytes: json.length };
    } catch (e) {
      this.lastError = e && e.message ? e.message : String(e);
      console.warn('[save] 写入失败', e);
      return { ok: false, error: this.lastError };
    }
  }

  /** @returns {{ok:boolean, data:object|null, error:string|null, migrated:boolean, savedAt:number}} */
  load() {
    if (!this.storage) return { ok: false, data: null, error: '浏览器不支持本地存储', migrated: false, savedAt: 0 };
    let raw = null;
    try { raw = this.storage.getItem(this.key); } catch (e) {
      return { ok: false, data: null, error: '读取存档失败', migrated: false, savedAt: 0 };
    }
    if (!raw) return { ok: false, data: null, error: null, migrated: false, savedAt: 0 };
    const v = validateSave(raw);
    if (!v.ok) return { ok: false, data: null, error: v.error, migrated: false, savedAt: 0 };
    return { ok: true, data: v.data, error: null, migrated: v.migrated, savedAt: Number(v.data.savedAt) || 0 };
  }

  hasSave() {
    if (!this.storage) return false;
    try { return !!this.storage.getItem(this.key); } catch (e) { return false; }
  }

  clear() {
    if (!this.storage) return false;
    try { this.storage.removeItem(this.key); this.lastSavedAt = 0; return true; } catch (e) { return false; }
  }

  /** 由 game 每帧调用，累计到间隔才真正写盘。 */
  tick(dt, payloadFn) {
    this._timer += dt;
    if (this._timer < this.autosaveSeconds) return null;
    this._timer = 0;
    const payload = payloadFn ? payloadFn() : null;
    if (!payload) return null;
    return this.save(payload);
  }

  resetTimer() { this._timer = 0; }
}

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__fwdeadworld_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch (e) {
    return null;
  }
}

/** 从游戏状态里挑出"该存的东西"（白名单，避免把 three 对象带进去）。 */
export function buildSavePayload(game) {
  const p = game.player;
  const npcs = game.director ? game.director.npcs : [];
  return {
    seed: game.config.seed,
    elapsed: Math.round(game.elapsed || 0),
    player: p ? p.serialize() : null,
    world: {
      openedContainers: [...game.openedContainers],
      lootedPickups: [...(game.lootedPickups || [])],
      doorsOpen: game.doorStates ? game.doorStates.map((d) => d.open) : [],
      cars: game.cars ? game.cars.map((c) => ({
        id: c.id,
        x: Math.round(c.mesh.position.x * 100) / 100,
        y: Math.round(c.mesh.position.y * 100) / 100,
        z: Math.round(c.mesh.position.z * 100) / 100,
        rotY: Math.round(c.mesh.rotation.y * 1000) / 1000,
        durability: Math.round(c.durability),
        // 车辆使用状态：油量 / 车灯 / 后备箱内容（见 docs/VEHICLES.md）
        fuel: Math.round(Number.isFinite(c.fuel) ? c.fuel : 100),
        lights: !!c.lights,
        trunk: c.trunkInv ? c.trunkInv.serialize() : null,
      })) : [],
      npcsDead: npcs.filter((n) => !n.alive).map((n) => n.id),
      timeOfDay: game.timeOfDay != null ? game.timeOfDay : 12,
      // 季节与天数是"玩法状态"的一部分：读档要回到同一天、同一个季节
      season: game.season || 'summer',
      dayCount: game.dayCount || 1,
      // 中国气候带：它决定树种混交，读档必须回到同一片林子
      region: (game.config && game.config.world && game.config.world.region) || 'temperate',
      // 天气：只存状态机（当前/下一个/过渡进度/湿润/积雪），不存未来天气，
      // 所以读档不会"天气跳变"，也不会让每次读档的天气不一样。
      weather: game.weather ? game.weather.serialize() : null,
    },
    quests: {
      active: game.quests ? game.quests.active.map((q) => ({ id: q.id, progress: q.progress })) : [],
      completed: game.quests ? [...game.quests.completed] : [],
    },
    settings: {
      quality: game.config.render ? game.config.render.quality : 'medium',
      audio: { enabled: game.config.audio.enabled, master: game.config.audio.master, sfx: game.config.audio.sfx, ambient: game.config.audio.ambient },
    },
  };
}

export default { SaveManager, SAVE_VERSION, SAVE_KEY, validateSave, buildSavePayload };
