// 路旁遗存：**单个**古建构件在普通道路边出现，但要"不突兀"。
//
// 规则（对应需求："完整古建只进历史古城；平时道路沿途可以单个出现，但别突兀"）：
//   ① 只用**小体量、能独立存在**的构件：月亮门 / 一段院墙 / 台基 + 台阶。
//      城门楼、大殿、连廊这种"建筑"绝不允许单独出现在路边（一眼假）。
//   ② 稀疏：沿路每 70~110m 才有一个候选，命中率 ~35%，且彼此间距 ≥ 60m。
//   ③ 贴着路但不上路：离路中心 9~12m（沥青带只有 4m 宽），并且落在路的一侧，朝路。
//   ④ 不突兀的"配景"：每处都带一块铺装地坪 + 2~4 块散落残石 + 1~2 棵树，
//      这样看起来是"被田地围住的旧物"，而不是凭空插在麦田里的门。
//   ⑤ 避开：路口、建筑、已有的古建院落、地形太陡的地方。
//
// 纯数据模块（不 import three.js），所以能在 Node 里直接单测。

import { pickTreeModel } from './trees.js';
import { compactHeritageColliders } from './heritage.js';

/** 允许在路边单独出现的构件（白名单，键名对应 dist/data/heritage/index.json）。 */
export const RELIC_WHITELIST = {
  moon_gate_chuanxi: { label: '月洞门残迹', footprint: [4.1, 0.7], needsWallStub: true, weight: 3 },
  wall_chuanxi: { label: '残墙', footprint: [4.1, 0.7], weight: 3 },
  platform: { label: '旧台基', footprint: [4.1, 4.1], weight: 2 },
  steps: { label: '石阶残迹', footprint: [4.2, 2.2], weight: 1 },
};

/** 绝对禁止单独出现在路边的（哪怕在历史城市里也要成组）。 */
export const RELIC_FORBIDDEN = ['gate_tower', 'hall', 'walkway_chuanxi'];

export function mulberry32(a) {
  let t = a >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const rotFor = (axis, sign) => {
  if (axis === 'x') return sign > 0 ? Math.PI / 2 : -Math.PI / 2;   // 路沿 X：正面朝 ±Z
  return sign > 0 ? 0 : Math.PI;                                      // 路沿 Z：正面朝 ±Z/+Z
};

/**
 * @param {object} layout  generateLayout() 结果（用 roads / buildings / bounds）
 * @param {object} opts    { seed, index, boxes, heritageRect, spacing, hitRate, terrain }
 */
export function planRoadsideRelics(layout, opts = {}) {
  const roads = layout?.roads || [];
  const buildings = layout?.buildings || [];
  const rng = mulberry32((opts.seed ?? 20260801) ^ 0x9e3779b9);
  const spacing = opts.spacing ?? 78;
  const jitter = opts.jitter ?? 18;
  const hitRate = opts.hitRate ?? 0.35;
  const minGap = opts.minGap ?? 60;
  const roadWidth = layout?.roadWidth ?? 9;
  const halfW = roadWidth / 2;

  const blocks = [];
  const relics = [];
  const dressing = [];
  const colliders = [];
  const poi = [];
  const warnings = [];
  let skipped = { junction: 0, building: 0, gap: 0, slope: 0, heritage: 0 };

  const overlapsRect = (a, b, pad = 0) => !(a.x1 + pad <= b.x0 || a.x0 - pad >= b.x1 || a.z1 + pad <= b.z0 || a.z0 - pad >= b.z1);

  for (const road of roads) {
    const isX = road.axis === 'x';
    const t0 = isX ? road.x0 : road.z0;
    const t1 = isX ? road.x1 : road.z1;
    const center = isX ? (road.z0 + road.z1) / 2 : (road.x0 + road.x1) / 2;
    // 路口（另一方向路与它相交的位置）附近不放：那里已经是景观焦点
    const crossings = roads.filter((o) => o.axis !== road.axis).map((o) => (isX ? (o.x0 + o.x1) / 2 : (o.z0 + o.z1) / 2));

    for (let t = t0 + 26; t <= t1 - 26; t += spacing) {
      const tt = t + (rng() - 0.5) * jitter;
      if (crossings.some((c) => Math.abs(tt - c) < 14)) { skipped.junction += 1; continue; }
      const side = rng() < 0.5 ? -1 : 1;
      const off = halfW + 4.5 + rng() * 3.5;       // 离路中心 9~12.5m
      const x = isX ? tt : center + side * off;
      const z = isX ? center + side * off : tt;
      const rotY = rotFor(road.axis, side);

      // 太靠近已有建筑/古建院落 → 跳过
      const foot = { x0: x - 5, x1: x + 5, z0: z - 5, z1: z + 5 };
      if (buildings.some((b) => overlapsRect(foot, b.rect, 2.5))) { skipped.building += 1; continue; }
      if (opts.heritageRect && overlapsRect(foot, opts.heritageRect, 8)) { skipped.heritage += 1; continue; }
      if (relics.some((r) => Math.hypot(r.x - x, r.z - z) < minGap)) { skipped.gap += 1; continue; }
      // 地形太陡 → 跳过（门/墙立在斜坡上很假）
      if (opts.terrain && typeof opts.terrain.heightAt === 'function') {
        const h = opts.terrain.heightAt(x, z);
        const hx = opts.terrain.heightAt(x + 3, z), hz = opts.terrain.heightAt(x, z + 3);
        const slope = Math.max(Math.abs(hx - h), Math.abs(hz - h)) / 3;
        if (slope > 0.09) { skipped.slope += 1; continue; }
        if (Math.abs(h) > 1.2) { skipped.slope += 1; continue; }   // 也别放在明显高出地面的地方
      }
      if (rng() > hitRate) continue;                                // 稀疏：不是每个点都长东西

      // 选类型（按权重）
      const pool = Object.entries(RELIC_WHITELIST).filter(([, v]) => !RELIC_FORBIDDEN.includes(v.label));
      const total = pool.reduce((s, [, v]) => s + v.weight, 0);
      let r = rng() * total, pick = pool[0][0];
      for (const [k, v] of pool) { r -= v.weight; if (r <= 0) { pick = k; break; } }

      const group = [];
      const push = (key, dx, dz, rY = rotY, note = '') => {
        group.push({ key, x: +(x + dx).toFixed(2), z: +(z + dz).toFixed(2), rotY: rY, y: 0, note });
      };
      // 各类型的"组内构成"：单个构件 + 必要的搭子（残墙段）
      if (pick === 'moon_gate_chuanxi') {
        push('moon_gate_chuanxi', 0, 0, rotY, '月洞门残迹');
        // 两侧各接一小段残墙，避免"孤零零一个门框"
        const dx = isX ? 2.4 : 0, dz = isX ? 0 : 2.4;
        push('wall_chuanxi', -dx, -dz, rotY, '西残墙');
        push('wall_chuanxi', dx, dz, rotY, '东残墙');
      } else if (pick === 'wall_chuanxi') {
        const dx = isX ? 4.1 : 0, dz = isX ? 0 : 4.1;
        push('wall_chuanxi', -dx * 0.5, -dz * 0.5, rotY, '残墙段');
        push('wall_chuanxi', dx * 0.5, dz * 0.5, rotY, '残墙段');
        push('wall_chuanxi', dx * 1.5, dz * 1.5, rotY, '残墙段');
      } else if (pick === 'platform') {
        push('platform', 0, 0, rotY, '旧台基');
        push('steps', isX ? 0 : 2.2, isX ? 2.2 : 0, rotY, '石阶');
      } else {
        push('steps', 0, 0, rotY, '石阶残迹');
      }

      // 配景：地坪 + 散落残石 + 树
      const apronN = pick === 'platform' ? 2 : 1;
      for (let i = 0; i < apronN; i += 1) {
        const dx = isX ? (i - (apronN - 1) / 2) * 4 : 0;
        const dz = isX ? 0 : (i - (apronN - 1) / 2) * 4;
        dressing.push({ kind: 'apron', x: +(x + dx).toFixed(2), z: +(z + dz).toFixed(2), rotY: 0 });
      }
      const rubbleN = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < rubbleN; i += 1) {
        const a = rng() * Math.PI * 2, rr = 1.6 + rng() * 2.4;
        dressing.push({
          kind: 'rubble', x: +(x + Math.cos(a) * rr).toFixed(2), z: +(z + Math.sin(a) * rr).toFixed(2),
          size: +(0.35 + rng() * 0.55).toFixed(2), y: 0,
        });
      }
      const treeN = 1 + Math.round(rng());
      for (let i = 0; i < treeN; i += 1) {
        const a = rng() * Math.PI * 2, rr = 3.2 + rng() * 2.2;
        const chosen = pickTreeModel(rng);
        dressing.push({
          kind: 'tree', x: +(x + Math.cos(a) * rr).toFixed(2), z: +(z + Math.sin(a) * rr).toFixed(2),
          rotY: rng() * Math.PI * 2, scale: 0.85 + rng() * 0.3,
          model: chosen.model, species: chosen.species, dead: chosen.dead,
        });
      }

      const relic = {
        id: `RELIC${relics.length + 1}`,
        type: pick, label: RELIC_WHITELIST[pick].label,
        x: +x.toFixed(2), z: +z.toFixed(2), rotY,
        roadId: road.id, side, roadAxis: road.axis,
        instances: group,
      };
      // 碰撞：只给"构件本体"（白名单构件在 index 里都有碰撞盒），配景不挡路
      if (opts.boxes) {
        for (const inst of group) {
          const src = opts.boxes[inst.key] || [];
          for (const b of src) {
            const c = Math.round(Math.cos(inst.rotY)), s = Math.round(Math.sin(inst.rotY));
            const pts = [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.min[0], b.max[2]], [b.max[0], b.max[2]]]
              .map(([px, pz]) => [px * c + pz * s + inst.x, -px * s + pz * c + inst.z]);
            const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
            if (b.min[1] > 2.2) continue;                        // 头顶以上不参与行走碰撞
            colliders.push({
              minX: Math.min(...xs), minZ: Math.min(...zs),
              maxX: Math.max(...xs), maxZ: Math.max(...zs), maxY: b.max[1],
              tag: 'relic', blocksNav: true,
            });
          }
        }
      }
      relics.push(relic);
      poi.push({ id: `POI_${relic.id}`, kind: 'relic', name: `路旁遗存·${relic.label}`, x, z, radius: 9, danger: 0.2 });
    }
  }

  // 和古建街区同一套压缩：只留高度带内 + 沿轴合并（不然 4 处遗存就能堆出 500 多个盒体）
  let finalColliders = colliders;
  if (colliders.length) {
    const compact = compactHeritageColliders(colliders.map((c) => ({
      min: [c.minX, 0, c.minZ], max: [c.maxX, c.maxY, c.maxZ],
    })));
    finalColliders = compact.boxes.map((b) => ({
      minX: b.min[0], minZ: b.min[2], maxX: b.max[0], maxZ: b.max[2], maxY: b.max[1],
      tag: 'relic', blocksNav: true,
    }));
  }

  if (!opts.boxes) warnings.push('没有传碰撞盒（opts.boxes），路旁遗存只有视觉没有碰撞');

  return {
    ok: true,
    relics,
    dressing,
    colliders: finalColliders,
    poi,
    warnings,
    stats: {
      relics: relics.length,
      instances: relics.reduce((s, r) => s + r.instances.length, 0),
      dressing: dressing.length,
      colliders: finalColliders.length, rawColliders: colliders.length,
      skipped,
    },
  };
}

export default { planRoadsideRelics, RELIC_WHITELIST, RELIC_FORBIDDEN };
