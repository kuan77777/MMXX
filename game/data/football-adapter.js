// 足球数据适配层：把原项目的俱乐部/球员数据翻译成游戏里的阵营、幸存者身份与球衣。
//
// 数据来源有两种，优先级如下：
//   1) 页面里已经加载了原版 `dist/world.js`（window.FW.state）→ 直接读实时数据；
//   2) 否则读构建脚本生成的 `football-index.js`（world.js 的只读投影，ID 与关联关系一致）。
// 两条路径都**不改动**原始足球数据库：游戏专属属性（HP/阵营/职业）只存在于游戏侧。
//
// 外观复用原项目的 players/appearance.js（同一个球员 ID → 同一张脸/同一个体格），
// 因此"球员 ID 保持角色外观稳定"这条要求是直接满足的，而不是我另写一套随机。

import { FOOTBALL_INDEX } from './football-index.js';
import { makeKit, stableShirtNumber } from '../appearance/kit.js';
import { selectFactionClubs, hashInt } from './faction-select.js';

let appearanceModule = null;
let appearanceLoadError = null;

/** 懒加载原项目的 appearance.js（它是纯 ESM，无外部依赖）。 */
async function loadAppearanceModule() {
  if (appearanceModule || appearanceLoadError) return appearanceModule;
  try {
    appearanceModule = await import('../../js/fw3d/players/appearance.js');
  } catch (e) {
    appearanceLoadError = e;
    console.warn('[football] 无法加载原项目 appearance.js，将使用内置兜底外观', e && e.message);
  }
  return appearanceModule;
}

const FALLBACK_APPEARANCE = {
  height: 174, skin_tone: 0xc9a27b, hair_color: 0x20180f, hair_style: 'short',
  body: { shoulderWidth: 1, chestDepth: 1, waist: 1, hipWidth: 1, thigh: 1, calf: 1, armLength: 1, legProportion: 1, neck: 1, muscle: 1 },
};

export class FootballData {
  constructor(index) {
    this.index = index || FOOTBALL_INDEX || null;
    this.loaded = false;
    this.source = 'none';
    this.clubs = new Map();
    this.players = new Map();
    this.leagues = new Map();
    this.factions = [];
    this._squads = new Map();   // clubId -> player[]
    this.counts = { clubs: 0, players: 0, leagues: 0 };
    this.originalTotals = { clubs: 0, players: 0, leagues: 0 };
    this._appearanceCache = new Map();
  }

  /**
   * 加载数据。优先用 window.FW（完整 18k 球员），否则用投影索引。
   * @param {{preferRuntime?:boolean}} opts
   */
  async load(opts = {}) {
    const fw = typeof window !== 'undefined' ? window.FW : null;

    if (!fw && !this.index) {
      console.warn('[football] 既没有 window.FW 也没有 football-index.js，使用空数据（游戏仍可运行）');
      this.loaded = true;
      this.source = 'empty';
      await loadAppearanceModule();
      return this;
    }

    const state = opts.preferRuntime !== false && fw && fw.state ? fw.state : null;
    if (state && Object.keys(state.clubs || {}).length) {
      this.source = 'runtime:FW.state';
      for (const c of Object.values(state.clubs)) {
        this.clubs.set(c.id, {
          id: c.id, name: c.name, leagueId: c.leagueId, countryId: c.countryId,
          primary: c.colors && c.colors.primary, secondary: c.colors && c.colors.secondary,
          reputation: c.management && c.management.reputation, city: c.city || null,
          stadiumCapacity: c.stadium && c.stadium.capacity,
        });
      }
      for (const l of state.leagues || []) this.leagues.set(l.id, { id: l.id, name: l.name, short: l.short, countryId: l.countryId, tier: l.tier });
      for (const p of Object.values(state.players || {})) {
        this.players.set(p.id, {
          id: p.id, name: p.name, nameEn: p.nameEn, realPlayerId: p.realPlayerId,
          isRealPlayer: p.isRealPlayer === true, position: p.position, age: p.age,
          nationality: p.nationality, clubId: p.clubId, ca: p.ca, pa: p.pa,
        });
      }
      this.originalTotals = {
        clubs: this.clubs.size,
        players: Object.keys(state.players || {}).length,
        leagues: (state.leagues || []).length,
      };
    } else {
      this.source = 'index:football-index.js';
      const idx = this.index;
      for (const c of idx.clubs || []) {
        this.clubs.set(c.id, {
          id: c.id, name: c.n, leagueId: c.l, countryId: c.c,
          primary: c.p, secondary: c.s, reputation: c.r, city: c.city, stadiumCapacity: c.cap,
        });
      }
      for (const l of idx.leagues || []) this.leagues.set(l.id, { id: l.id, name: l.n, short: l.s, countryId: l.c, tier: l.tier });
      for (const p of idx.players || []) {
        this.players.set(p.id, {
          id: p.id, name: p.n, nameEn: p.ne, realPlayerId: p.r,
          isRealPlayer: p.rp === 1, position: p.pos, age: p.age,
          nationality: p.nat, clubId: p.club, ca: p.ca, pa: p.pa,
        });
      }
      this.originalTotals = idx.sourceTotals || this.originalTotals;
    }

    // 阵容索引
    for (const p of this.players.values()) {
      if (!p.clubId) continue;
      const arr = this._squads.get(p.clubId) || [];
      arr.push(p);
      this._squads.set(p.clubId, arr);
    }
    // 阵容排序：按位置（门将/后卫/中场/前锋）再按 id，保证"第几个 survivor"稳定
    const posRank = { GK: 0, CB: 1, LB: 2, RB: 3, CM: 4, AM: 5, LW: 6, RW: 7, ST: 8 };
    for (const arr of this._squads.values()) {
      arr.sort((a, b) => ((posRank[a.position] || 9) - (posRank[b.position] || 9)) || (numId(a.id) - numId(b.id)));
    }

    // ── 阵营
    const picks = selectFactionClubs([...this.clubs.values()].map((c) => ({ id: c.id, countryId: c.countryId, rep: c.reputation, name: c.name })));
    this.factions = picks.map((p, i) => {
      const club = this.clubs.get(p.clubId) || null;
      return {
        id: `faction_${i}`,
        index: i,
        clubId: p.clubId,
        role: p.role,
        name: p.name,
        color: (club && club.primary) || '#3d6b52',
        secondary: (club && club.secondary) || '#e8e3d6',
        clubName: club ? club.name : '未知俱乐部',
        country: club ? club.countryId : '—',
        squad: (this._squads.get(p.clubId) || []).length,
      };
    });

    this.counts = { clubs: this.clubs.size, players: this.players.size, leagues: this.leagues.size };

    await loadAppearanceModule();
    this.loaded = true;
    return this;
  }

  get appearanceAvailable() { return !!appearanceModule; }

  factionById(id) { return this.factions.find((f) => f.id === id) || null; }
  factionByIndex(i) { return this.factions[i] || null; }

  /** 某阵营的阵容（真实球员）。 */
  squadOf(factionIndex) {
    const f = this.factionByIndex(factionIndex);
    if (!f) return [];
    return this._squads.get(f.clubId) || [];
  }

  /** 全部可当幸存者的球员（阵营阵容合集）。 */
  get survivorPool() {
    const out = [];
    for (const f of this.factions) out.push(...(this._squads.get(f.clubId) || []));
    return out;
  }

  /**
   * 生成一个"幸存者身份"：玩家/友好 NPC/敌对 NPC 都用它，保证同类 NPC 有稳定外观。
   * @param {number} factionIndex
   * @param {number} slot 该阵营内的槽位（同一个 slot 永远得到同一个球员）
   */
  survivorIdentity(factionIndex, slot = 0) {
    const f = this.factionByIndex(factionIndex);
    const squad = this.squadOf(factionIndex);
    if (!f || !squad.length) {
      // 数据缺失：返回一个可用的兜底身份（不崩、不空白）
      return {
        playerId: `anon_${factionIndex}_${slot}`,
        name: `幸存者 ${slot + 1}`,
        clubId: f ? f.clubId : null,
        clubName: f ? f.clubName : '无归属',
        factionId: f ? f.id : null,
        factionName: f ? f.name : '无阵营',
        role: f ? f.role : 'friendly',
        primary: f ? f.color : '#3d6b52',
        secondary: f ? f.secondary : '#e8e3d6',
        player: null,
        kit: makeKit({ clubId: f ? f.clubId : null, playerId: `anon_${factionIndex}_${slot}`, primary: f ? f.color : null, secondary: f ? f.secondary : null, name: `幸存者${slot + 1}` }),
      };
    }
    const player = squad[((slot % squad.length) + squad.length) % squad.length];
    const kit = makeKit({
      clubId: f.clubId,
      playerId: player.id,
      primary: f.color,
      secondary: f.secondary,
      number: stableShirtNumber(player.id),
      name: player.name || `球员${player.id}`,
    });
    return {
      playerId: player.id,
      name: player.name || `球员 ${player.id}`,
      nameEn: player.nameEn || null,
      position: player.position,
      age: player.age,
      clubId: f.clubId,
      clubName: f.clubName,
      factionId: f.id,
      factionName: f.name,
      role: f.role,
      primary: f.color,
      secondary: f.secondary,
      player,
      kit,
    };
  }

  /**
   * 外观：同一个 playerId 永远得到同一份外观（原项目 appearance.js 的保证）。
   * @returns {object} appearance（含 skin_tone / hair_color / body / height …）
   */
  appearanceFor(identity) {
    const key = identity && identity.playerId ? String(identity.playerId) : 'anon';
    const cached = this._appearanceCache.get(key);
    if (cached) return cached;
    let app;
    if (appearanceModule && appearanceModule.appearanceFor) {
      const rec = identity && identity.player
        ? { id: identity.playerId, realPlayerId: identity.player.realPlayerId, position: identity.player.position, age: identity.player.age, nationality: identity.player.nationality }
        : { id: key };
      try {
        app = appearanceModule.appearanceFor(rec);
      } catch (e) {
        app = null;
      }
    }
    if (!app) app = Object.assign({ playerId: key }, FALLBACK_APPEARANCE);
    this._appearanceCache.set(key, app);
    return app;
  }

  /** 给 UI 用的摘要（证明"原有足球数据仍可读取"）。 */
  summary() {
    return {
      source: this.source,
      loaded: this.loaded,
      clubs: this.counts.clubs,
      players: this.counts.players,
      leagues: this.counts.leagues,
      original: this.originalTotals,
      factions: this.factions.map((f) => ({ id: f.id, name: f.name, club: f.clubName, color: f.color, role: f.role, squad: f.squad, country: f.country })),
      appearance: this.appearanceAvailable,
    };
  }

  /** 随机取一个阵营的"编号种子"，用于刷 NPC 时错开外观。 */
  pickSlot(factionIndex, seed) {
    const squad = this.squadOf(factionIndex);
    if (!squad.length) return 0;
    return hashInt(`${seed}:${factionIndex}`, squad.length);
  }
}

function numId(id) {
  const m = String(id || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

export default { FootballData };
