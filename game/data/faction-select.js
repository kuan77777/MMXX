// 阵营选择：把俱乐部映射成幸存者阵营的规则。
// 这个模块必须保持"纯函数 + 确定性"：Node 侧的构建脚本（tools/build-football-index.mjs）
// 和浏览器侧的适配层（football-adapter.js）会各跑一遍，两边必须选出完全相同的俱乐部，
// 否则索引里没有某个阵营的球员，游戏里就会出现空阵营。
// 只依赖俱乐部记录本身，不 import 任何东西。
//
// 现行规则（按用户要求）：阵营 = 中超 16 队。
// 这 16 队在本仓库足球库里本来就存在（C231~C248），所以球员身份/阵容直接沿用现有数据；
// 每队也都能在球衣包里找到对应的 2026 主场球衣图（见 appearance/csl-kits.js）。
// 前 10 队为友好幸存者营地，后 6 队为敌对人类掠夺者，阵营名直接用队名。

/** 中超 16 队（顺序固定，保证索引与运行时一致）。 */
export const CSL_FACTION_CLUBS = [
  { clubId: 'C231', name: '上海海港' },
  { clubId: 'C232', name: '上海申花' },
  { clubId: 'C234', name: '北京国安' },
  { clubId: 'C233', name: '成都蓉城' },
  { clubId: 'C235', name: '山东泰山' },
  { clubId: 'C237', name: '浙江队' },
  { clubId: 'C236', name: '天津津门虎' },
  { clubId: 'C242', name: '云南玉昆' },
  { clubId: 'C238', name: '青岛西海岸' },
  { clubId: 'C240', name: '河南队' },
  { clubId: 'C243', name: '大连英博' },
  { clubId: 'C241', name: '深圳新鹏城' },
  { clubId: 'C244', name: '青岛海牛' },
  { clubId: 'C239', name: '武汉三镇' },
  { clubId: 'C247', name: '辽宁铁人' },
  { clubId: 'C248', name: '重庆铜梁龙' },
];

/** 前 10 队友好、后 6 队敌对。 */
export const CSL_FRIENDLY_COUNT = 10;

/** 备用规则：数据里若没有中超球队，退回"每国派一队"。 */
export const FACTION_COUNTRIES = ['英格兰', '西班牙', '意大利', '德国', '法国', '荷兰'];
const CREW_NAMES = {
  friendly: ['南看台守夜人', '草皮维护组', '更衣室同盟', '青年梯队残部', '替补席流浪团', '队医小队'],
  hostile: ['北看台清算队', '奖金猎人', '球场承包商', '客场劫掠团'],
};

function idNum(id) {
  const m = String(id || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function repOf(club) {
  const r = club && club.rep;
  return Number.isFinite(Number(r)) ? Number(r) : 50;
}

/**
 * 从俱乐部列表里挑选阵营。
 * @param {Array<{id:string,countryId:string,rep?:number,name?:string}>} clubs
 * @returns {Array<{clubId:string, role:'friendly'|'hostile', name:string, index:number}>}
 */
export function selectFactionClubs(clubs) {
  const list = Array.isArray(clubs) ? clubs.slice() : [];
  const byId = new Map();
  for (const c of list) if (c && c.id) byId.set(String(c.id), c);

  // ── 首选：中超 16 队（只要数据里存在就用）
  const csl = CSL_FACTION_CLUBS.filter((t) => byId.has(t.clubId));
  if (csl.length >= 4) {
    return csl.map((t, i) => ({
      clubId: t.clubId,
      role: i < CSL_FRIENDLY_COUNT ? 'friendly' : 'hostile',
      name: t.name,
      index: i,
    }));
  }

  // ── 备用：每国一队（原逻辑）
  const byCountry = new Map();
  for (const c of list) {
    if (!c || !c.id || !c.countryId) continue;
    const arr = byCountry.get(c.countryId) || [];
    arr.push(c);
    byCountry.set(c.countryId, arr);
  }
  for (const arr of byCountry.values()) {
    arr.sort((a, b) => (repOf(b) - repOf(a)) || (idNum(a.id) - idNum(b.id)));
  }
  const out = [];
  const used = new Set();
  for (let i = 0; i < FACTION_COUNTRIES.length; i += 1) {
    const pool = byCountry.get(FACTION_COUNTRIES[i]) || [];
    const pick = pool[Math.min(pool.length - 1, i % 2)];
    if (!pick || used.has(pick.id)) continue;
    used.add(pick.id);
    out.push({ clubId: pick.id, index: out.length });
  }
  return out.map((f, i) => {
    const role = i < 4 ? 'friendly' : 'hostile';
    const names = CREW_NAMES[role];
    const nth = out.slice(0, i).filter((x, k) => (k < 4 ? 'friendly' : 'hostile') === role).length;
    return { clubId: f.clubId, role, name: names[nth % names.length], index: i };
  });
}

/** 稳定地把任意字符串映射到 [0,n)。 */
export function hashInt(str, n) {
  let h = 2166136261;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  return n > 0 ? h % n : 0;
}
