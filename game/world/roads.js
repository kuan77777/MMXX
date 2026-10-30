// 道路模块化拼接（**纯数据，不依赖 three.js**，因此可以在 Node 里直接单测）。
//
// 输入：world/layout.js 生成的 `layout.roads`（每条路是一个"长条矩形"：
//   {id, x0, x1, z0, z1, axis:'x'|'z'}）。输出：一串模块实例
//   {key, x, y, z, rotY, sx, sy, sz} + 路灯/路牌/信号灯的位置。
// world/build.js 只负责把这份计划塞进 three.js（按 key 各建一个 InstancedMesh）。
//
// ── 模块约定（实测自 `道具包/道路/OBJ`，源单位）──
//   · 每个路面模块占 2×2 单位、以自身中心为原点：沥青面 y=0.1，人行道面 y=0.15，底面 y=-0.1；
//   · 直道（Street_Straight）：沥青带沿本地 X 铺满、宽 2/3 单位 = 模块宽的 1/3，
//     两侧各 1/3 是人行道；路中一条白线，沿长度方向**没有重复花纹**，
//     所以拉伸长度是免费的（本文件就是靠这点把一条路切成少量长模块）；
//   · 十字（Street_4Way）/尽头（Street_Deadend）：同一个 2×2 底面；
//     尽头模块的"封闭边"在本地 +X（沥青只铺到 x=+0.36），开口朝本地 -X。
//
// ── 尺寸策略 ──
// 模块宽 2 单位 → 铺装总宽 = 2×scale，沥青宽 = (2/3)×scale，两侧人行道各 (2/3)×scale。
// 取 scale = roadWidth×(2/3) 时（roadWidth 9 → scale 6）：
//   铺装总宽 12m（比 9m 的道路带每侧多出 1.5m 的马路牙子），沥青 4m，人行道各 4m。
// 沥青是正常的两车道宽度，人行道又不会宽到压到街区里的建筑（建筑离道路带 ≥ 6m）。

export const STREET_MODULES = {
  straight: 'street_straight',
  junction: 'street_4way',
  deadend: 'street_deadend',
  streetlight: 'streetlight',
  sign: 'sign_stop',
  trafficLight: 'traffic_light',
};

export const MODULE_UNITS = 2;         // 源模型边长（拼接单位）
export const ROAD_TOP_Y = 0.1;         // 源模型里沥青面的高度
export const ASPHALT_FRACTION = 1 / 3; // 沥青带 / 模块宽
export const PAVEMENT_RATIO = 4 / 3;   // 铺装总宽 / layout 的道路带宽
export const LAMP_HEAD_Y = 6.05;       // 路灯灯头高度（模型高 6.5m，灯头在 ~0.93 处）
const EPS = 1e-6;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** scale（模块半宽，米）→ 自动值：roadWidth × 2/3。 */
export function moduleScaleFor(roadWidth, override) {
  if (Number.isFinite(override) && override > 0) return override;
  const w = num(roadWidth, 9);
  return (w > 0 ? w : 9) * (2 / 3);
}

/** 铺装半宽（米）：模块半宽。 */
export function pavementHalfWidth(roadWidth, override) {
  return moduleScaleFor(roadWidth, override);
}

/** 本文件只会产生 rotY ∈ {0, ±π/2}，所以包围盒天然轴对齐。 */
function rectOf(piece) {
  const aligned = Math.abs(Math.cos(piece.rotY)) > 0.5;
  const hx = aligned ? piece.sx : piece.sz;
  const hz = aligned ? piece.sz : piece.sx;
  return { minX: piece.x - hx, maxX: piece.x + hx, minZ: piece.z - hz, maxZ: piece.z + hz };
}

/**
 * 生成整个路网的模块化拼接计划。
 * @param {object} layout generateLayout() 的返回值（只用 roads / roadWidth / bounds）
 * @param {object} [opts]
 * @param {number} [opts.scale]           模块半宽（米），默认 roadWidth×2/3
 * @param {number} [opts.tileLength]      单个直道模块的目标长度（米），默认 2×scale×2
 * @param {boolean} [opts.endCaps]        路两端是否用尽头模块收口（默认 true）
 * @param {boolean} [opts.streetlights]   是否沿路摆路灯（默认 true）
 * @param {number} [opts.streetlightStep] 路灯间距（米），默认 44
 * @param {boolean} [opts.signs]          交叉口是否放停车牌（默认 true）
 * @param {boolean} [opts.trafficLights]  中心交叉口是否放红绿灯（默认 true）
 */
export function planStreets(layout, opts = {}) {
  const roads = Array.isArray(layout && layout.roads) ? layout.roads : [];
  const roadWidth = num(layout && layout.roadWidth, 9);
  const scale = moduleScaleFor(roadWidth, opts.scale);
  const half = scale;                              // 铺装半宽
  const asphaltHalf = half * ASPHALT_FRACTION;     // 沥青半宽
  const sidewalkCenter = (asphaltHalf + half) / 2; // 人行道中心线离路中心
  const tileLength = num(opts.tileLength, 0) > 0 ? num(opts.tileLength, 0) : Math.max(4, 4 * half);
  const y = -ROAD_TOP_Y;                           // 下沉模块，让沥青面正好落在 y=0
  const endCaps = opts.endCaps !== false;
  const pieces = [];
  const junctions = [];
  const seenJunction = new Set();

  // ── 1. 交叉口：X 向路 × Z 向路 的矩形交集中心（网格路网里每个交叉点只算一次）
  const xRoads = [];
  const zRoads = [];
  for (const r of roads) {
    if (r.axis === 'x') xRoads.push(r);
    else if (r.axis === 'z') zRoads.push(r);
  }
  for (const a of xRoads) {
    for (const b of zRoads) {
      const cx = (b.x0 + b.x1) / 2;
      const cz = (a.z0 + a.z1) / 2;
      // 交叉口必须能整个放进两条路里（否则说明是贴地图边的半截路，不做十字模块）
      if (cx - half < a.x0 - EPS || cx + half > a.x1 + EPS) continue;
      if (cz - half < b.z0 - EPS || cz + half > b.z1 + EPS) continue;
      const id = `${Math.round(cx * 100)}:${Math.round(cz * 100)}`;
      if (seenJunction.has(id)) continue;
      seenJunction.add(id);
      junctions.push({ x: cx, z: cz });
      pieces.push({
        role: 'junction', key: STREET_MODULES.junction, x: cx, y, z: cz,
        rotY: 0, sx: scale, sy: 1, sz: scale,
      });
    }
  }

  const nearJunction = (t, center, isX) => {
    for (const j of junctions) {
      const jt = isX ? j.x : j.z;
      const jc = isX ? j.z : j.x;
      if (Math.abs(jc - center) > 0.5) continue;
      if (Math.abs(t - jt) < half + 1.5) return true;
    }
    return false;
  };

  // ── 2. 每条路：端头收口 → 交叉口 → 交叉口之间的直道
  const stats = { straight: 0, junction: junctions.length, deadend: 0 };
  const deadends = [];
  for (const r of roads) {
    const isX = r.axis === 'x';
    const t0 = isX ? r.x0 : r.z0;
    const t1 = isX ? r.x1 : r.z1;
    const center = isX ? (r.z0 + r.z1) / 2 : (r.x0 + r.x1) / 2;
    const axisLen = t1 - t0;
    let start = t0;
    let end = t1;

    // 端头模块长 2×half：沥青开口朝内。两条端头之间至少要留一点直道，否则跳过收口。
    if (endCaps && axisLen > 4 * half + 1) {
      const caps = [
        { t: t0 + half, inward: 1 },   // 低坐标端：开口朝 +t
        { t: t1 - half, inward: -1 },  // 高坐标端：开口朝 -t
      ];
      for (const cap of caps) {
        // 尽头模块本地 -X 是开口；rotY 把它转到"朝内"
        let rotY;
        if (isX) rotY = cap.inward > 0 ? Math.PI : 0;
        else rotY = cap.inward > 0 ? Math.PI / 2 : -Math.PI / 2;
        const piece = {
          role: 'deadend', key: STREET_MODULES.deadend,
          x: isX ? cap.t : center,
          y,
          z: isX ? center : cap.t,
          rotY, sx: scale, sy: 1, sz: scale,
        };
        pieces.push(piece);
        deadends.push(piece);
        stats.deadend += 1;
      }
      start = t0 + 2 * half;
      end = t1 - 2 * half;
    }

    // 属于这条路、并且能整个放进 [start, end] 的交叉口
    const stops = [];
    if (start < end) {
      for (const j of junctions) {
        const jt = isX ? j.x : j.z;
        const jc = isX ? j.z : j.x;
        if (Math.abs(jc - center) > 0.5) continue;
        if (jt - half < start - EPS || jt + half > end + EPS) continue;
        stops.push(jt);
      }
      stops.sort((p, q) => p - q);
    }

    const addSpan = (a, b) => {
      const len = b - a;
      if (len <= 1e-3) return;
      // 直道模块沿长度方向没有花纹，可以随便拉长：切得越少，三角形越少
      const n = Math.max(1, Math.round(len / tileLength));
      const segLen = len / n;
      for (let i = 0; i < n; i += 1) {
        const tc = a + segLen * (i + 0.5);
        pieces.push({
          role: 'straight', key: STREET_MODULES.straight,
          x: isX ? tc : center,
          y,
          z: isX ? center : tc,
          rotY: isX ? 0 : -Math.PI / 2,
          sx: segLen / MODULE_UNITS, sy: 1, sz: scale,
        });
      }
      stats.straight += n;
    };

    let cursor = start;
    for (const t of stops) {
      addSpan(cursor, t - half);
      cursor = t + half;
    }
    addSpan(cursor, end);
  }

  // ── 3. 路灯：沿每条路交替两侧，落在人行道中心线上；交叉口范围内不放
  const streetlights = [];
  if (opts.streetlights !== false) {
    const step = Math.max(8, num(opts.streetlightStep, 44));
    for (const r of roads) {
      const isX = r.axis === 'x';
      const t0 = isX ? r.x0 : r.z0;
      const t1 = isX ? r.x1 : r.z1;
      const center = isX ? (r.z0 + r.z1) / 2 : (r.x0 + r.x1) / 2;
      let side = 1;
      for (let t = t0 + step * 0.5; t <= t1 - step * 0.4; t += step) {
        if (nearJunction(t, center, isX)) continue;
        const off = side * sidewalkCenter;
        side = -side;
        streetlights.push({
          key: STREET_MODULES.streetlight, y: 0,
          x: isX ? t : center + off,
          z: isX ? center + off : t,
          rotY: isX ? 0 : Math.PI / 2,
        });
      }
    }
  }

  // ── 4. 停车牌：每个交叉口一块，在人行道转角、面向 -X 方向的车流（中心交叉口留给红绿灯）
  const signs = [];
  if (opts.signs !== false) {
    const hasLights = opts.trafficLights !== false && junctions.some((j) => Math.abs(j.x) < 1 && Math.abs(j.z) < 1);
    for (const j of junctions) {
      if (hasLights && Math.abs(j.x) < 1 && Math.abs(j.z) < 1) continue;
      signs.push({
        key: STREET_MODULES.sign, y: 0,
        x: j.x + sidewalkCenter,
        z: j.z - sidewalkCenter,
        rotY: 0,
      });
    }
  }

  // ── 5. 红绿灯：只在中心交叉口的四个转角（玩家出生点就在旁边，一眼能看到）
  const trafficLights = [];
  if (opts.trafficLights !== false) {
    const d = sidewalkCenter;
    for (const j of junctions) {
      if (Math.abs(j.x) > 1 || Math.abs(j.z) > 1) continue;
      trafficLights.push(
        { key: STREET_MODULES.trafficLight, y: 0, x: j.x + d, z: j.z + d, rotY: 0 },
        { key: STREET_MODULES.trafficLight, y: 0, x: j.x - d, z: j.z - d, rotY: Math.PI },
        { key: STREET_MODULES.trafficLight, y: 0, x: j.x + d, z: j.z - d, rotY: Math.PI / 2 },
        { key: STREET_MODULES.trafficLight, y: 0, x: j.x - d, z: j.z + d, rotY: -Math.PI / 2 },
      );
    }
  }

  return {
    scale, halfWidth: half, asphaltHalf, sidewalkCenter, tileLength, y,
    pieces, streetlights, signs, trafficLights, junctions, deadends,
    stats: {
      pieces: pieces.length,
      ...stats,
      streetlights: streetlights.length,
      signs: signs.length,
      trafficLights: trafficLights.length,
    },
  };
}

/** 计划 → 每块路面模块的世界包围盒（测试/调试用）。 */
export function pavementRects(plan) {
  return plan.pieces.map((p) => ({ ...rectOf(p), role: p.role, key: p.key, x: p.x, z: p.z, rotY: p.rotY }));
}

/** 路灯光晕/点光用的灯头世界坐标（高度用 LAMP_HEAD_Y）。 */
export function lampHeads(plan) {
  return (plan && plan.streetlights ? plan.streetlights : []).map((s) => ({ x: s.x, y: LAMP_HEAD_Y, z: s.z }));
}

/**
 * 挑离 (x,z) 最近的 count 盏路灯（纯函数，便于单测）。
 * 夜里只用**少量池化点光**点亮最近的几盏，而不是给 50 盏灯各配一盏灯。
 * @returns {Array<{x:number,y:number,z:number,d:number}>} 按距离升序，超出 maxDist 的丢掉
 */
export function nearestLamps(lamps, x, z, count = 3, maxDist = 40) {
  const list = [];
  for (const L of lamps || []) {
    const d = Math.hypot(L.x - x, L.z - z);
    if (d <= maxDist) list.push({ x: L.x, y: L.y, z: L.z, d });
  }
  list.sort((a, b) => a.d - b.d);
  return list.slice(0, Math.max(0, count));
}

export default { planStreets, pavementRects, nearestLamps, lampHeads, STREET_MODULES, ROAD_TOP_Y, LAMP_HEAD_Y };
