// 地图数据层：把 layout / terrain / roadNet 变成"能画的东西"。
//
// 三条硬约束：
//   1. **纯数据 + 纯数学**：不 import three.js，也不碰 DOM，所以 Node 里可以直接单测
//      （tests/map.test.mjs）。渲染层（ui/map.js）只负责 ctx.* 调用。
//   2. 世界坐标一律是"米"，投影只做平移（minX/minZ）；缩放与旋转交给 makeView()。
//      这样同一份要素既能画小地图（跟着人转）又能画大地图（正北朝上），不需要两套数据。
//   3. 静态要素（地形底图/建筑/道路/树/围栏/地点）只提取一次；动态标记（玩家/僵尸/车）
//      每帧重建。两者都不做 DOM 操作。
//
// 地图朝向约定（和游戏里「+Z 是前方」一致）：
//   · 画布 x = 世界 x（东 → 右），画布 y = 世界 z（北 = -Z → 上）；
//   · 所以"正北朝上"就是 rotation = 0，小地图"前方朝上"就是 rotation = yaw + π。

/** 小地图 / 大地图的尺度限制（各处渲染共用一套数字，避免两处算得不一样）。 */
export const MAP_LIMITS = {
  minimapSize: 176,        // 小地图 CSS 尺寸（px）
  minimapRange: 120,       // 小地图显示半径（米）
  minimapHz: 30,           // 小地图重绘频率
  bigmapHz: 30,            // 大地图重绘频率
  zoomMin: 1,              // 大地图缩放（1 = 整幅铺满画布）
  zoomMax: 14,
  rasterPixelsPerMeter: 0.34, // 地形底图分辨率（2400m 图幅 → 816px）
  rasterMaxSize: 1024,
  gridStep: 100,           // 大地图网格间隔（米）
};

/** 地图配色：整体压暗、低饱和，和 HUD 的深青灰 + 暖琥珀保持一致。 */
export const MAP_PALETTE = {
  bg: '#0c1216',
  void: '#0a0f12',
  grid: 'rgba(140, 172, 192, 0.10)',
  gridMajor: 'rgba(150, 186, 206, 0.20)',
  townEdge: 'rgba(224, 163, 74, 0.55)',
  townFill: 'rgba(224, 163, 74, 0.05)',
  water: [46, 82, 108],
  tree: '#3f5c3d',
  treeDead: '#4a4038',
  fence: 'rgba(150, 160, 165, 0.45)',
  buildingStroke: 'rgba(228, 236, 242, 0.35)',
  door: '#ffd166',
  player: '#f4ead6',
  playerCone: 'rgba(240, 230, 210, 0.13)',
  zombie: '#b8483c',
  zombieAlert: '#ff6a4d',
  hostile: '#d4692f',
  friendly: '#79b46a',
  car: '#5a8ac0',
  carDrivable: '#7dc0e6',
  poi: '#e0a34a',
  quest: '#ffd166',
  text: '#d9e2e8',
  textDim: 'rgba(217, 226, 232, 0.62)',
  shadow: 'rgba(0, 0, 0, 0.75)',
};

/** ESA WorldCover 类别 → 地图底图色（比 3D 场景里的颜色更暗，好让道路/建筑压在上面看得清）。 */
const COVER_MAP_COLORS = {
  10: [52, 74, 52],    // 林地
  20: [62, 82, 54],    // 灌木
  30: [76, 94, 62],    // 草地
  40: [96, 96, 66],    // 耕地
  50: [100, 100, 96],  // 建成区
  60: [110, 104, 94],  // 裸地
  70: [196, 208, 216], // 冰雪
  80: [44, 78, 102],   // 水体
  90: [58, 88, 80],    // 湿地
  95: [44, 66, 58],    // 红树林
  100: [84, 90, 76],   // 苔原
  12: [100, 98, 94],   // 裸岩
};
const COVER_FALLBACK = [86, 94, 80];

/** 街区类型 → 建筑填充/描边（和 3D 里的调色板呼应：住宅砖红、商业灰、工业金属绿）。
 *  填充比 3D 场景亮一档：地图是暗底，太暗的话建筑会糊进地形里。 */
export const DISTRICT_FILL = {
  residential: { fill: 'rgba(152, 100, 82, 0.96)', stroke: 'rgba(236, 186, 154, 0.6)' },
  commercial: { fill: 'rgba(120, 130, 146, 0.96)', stroke: 'rgba(206, 222, 236, 0.6)' },
  industrial: { fill: 'rgba(106, 128, 118, 0.96)', stroke: 'rgba(178, 220, 198, 0.6)' },
  park: { fill: 'rgba(92, 124, 82, 0.96)', stroke: 'rgba(184, 224, 152, 0.6)' },
  plaza: { fill: 'rgba(140, 130, 112, 0.96)', stroke: 'rgba(232, 218, 184, 0.6)' },
};
const DISTRICT_FALLBACK = { fill: 'rgba(110, 118, 128, 0.96)', stroke: 'rgba(200, 210, 220, 0.55)' };

/** 街区 → 中文名（图例与地图面板共用）。 */
export const DISTRICT_LABELS = {
  residential: '住宅区',
  commercial: '商业区',
  industrial: '工业区',
  park: '公园',
  plaza: '广场',
};

/**
 * OSM 道路等级 → 画法。
 * width 是**世界里该画多宽（米）**，不是像素：画在米空间里，缩放时自动跟着变。
 * minW 是"最细也要有这么宽"，否则小路在缩小的地图上会消失。
 */
export const ROAD_CLASS_STYLE = {
  motorway: { color: '#c9a96b', minW: 9, dash: null },
  trunk: { color: '#c2a878', minW: 8, dash: null },
  primary: { color: '#b5a17c', minW: 7, dash: null },
  secondary: { color: '#a89a80', minW: 6, dash: null },
  tertiary: { color: '#9a9a8a', minW: 5, dash: null },
  residential: { color: '#8d9296', minW: 4.5, dash: null },
  unclassified: { color: '#8a8f93', minW: 4.5, dash: null },
  living_street: { color: '#828789', minW: 4, dash: null },
  road: { color: '#8a8f93', minW: 4.5, dash: null },
  service: { color: '#797e82', minW: 3.4, dash: null },
  pedestrian: { color: '#6f7679', minW: 3, dash: null },
  track: { color: '#6d6a58', minW: 2.4, dash: [7, 6] },
  path: { color: '#5f6b58', minW: 2, dash: [5, 5] },
  footway: { color: '#5b6761', minW: 2, dash: [4, 5] },
  steps: { color: '#5b6761', minW: 2, dash: [2, 3] },
  unknown: { color: '#7d8488', minW: 3, dash: null },
};

export function roadStyleFor(cls) {
  return ROAD_CLASS_STYLE[cls] || ROAD_CLASS_STYLE.unknown;
}

export function districtStyle(district) {
  return DISTRICT_FILL[district] || DISTRICT_FALLBACK;
}

/** 标记样式：size 是屏幕像素（不随缩放变），形状由渲染层解释。 */
export const MARKER_STYLE = {
  player: { color: MAP_PALETTE.player, size: 8, shape: 'arrow', z: 100 },
  'player-car': { color: MAP_PALETTE.carDrivable, size: 7, shape: 'arrow', z: 99 },
  zombie: { color: MAP_PALETTE.zombie, size: 4, shape: 'dot', z: 60 },
  'zombie-alert': { color: MAP_PALETTE.zombieAlert, size: 5, shape: 'dot', z: 70, pulse: true },
  hostile: { color: MAP_PALETTE.hostile, size: 4.5, shape: 'dot', z: 65, ring: true },
  friendly: { color: MAP_PALETTE.friendly, size: 4.5, shape: 'dot', z: 62 },
  car: { color: MAP_PALETTE.car, size: 4, shape: 'square', z: 40 },
  'car-drivable': { color: MAP_PALETTE.carDrivable, size: 4.5, shape: 'square', z: 41 },
  poi: { color: MAP_PALETTE.poi, size: 6, shape: 'diamond', z: 30 },
  quest: { color: MAP_PALETTE.quest, size: 7.5, shape: 'star', z: 80, pulse: true },
  base: { color: MAP_PALETTE.friendly, size: 7, shape: 'diamond', z: 35 },
  danger: { color: MAP_PALETTE.hostile, size: 6, shape: 'diamond', z: 30 },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 世界坐标 → 米空间像素（1px = 1 米，只平移不缩放）。 */
export function worldToLocal(x, z, bounds) {
  return { x: x - bounds.minX, y: z - bounds.minZ };
}

export function localToWorld(px, py, bounds) {
  return { x: px + bounds.minX, z: py + bounds.minZ };
}

/**
 * 地图覆盖范围：优先用真实地形图幅（2400m），其次 OSM 路网范围，最后退回镇区。
 * 地图**永远比镇子大**——玩家能走出镇子，小地图不能只画 340m 的方框。
 */
export function makeMapBounds({ terrain, layout, roadNet } = {}) {
  if (terrain && terrain.bounds) {
    const b = terrain.bounds;
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, width: b.maxX - b.minX, depth: b.maxZ - b.minZ, source: 'terrain' };
  }
  if (roadNet && roadNet.extent && isNum(roadNet.extent.half) && roadNet.extent.half > 0) {
    const h = roadNet.extent.half;
    return { minX: -h, maxX: h, minZ: -h, maxZ: h, width: h * 2, depth: h * 2, source: 'roads' };
  }
  if (layout && layout.bounds) {
    const b = layout.bounds;
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, width: b.maxX - b.minX, depth: b.maxZ - b.minZ, source: 'layout' };
  }
  return { minX: -170, maxX: 170, minZ: -170, maxZ: 170, width: 340, depth: 340, source: 'default' };
}

/** 底图栅格尺寸：按"每米多少像素"算，再把长边压到 rasterMaxSize 以内。 */
export function rasterSizeFor(bounds, opts = {}) {
  const ppm = isNum(opts.pixelsPerMeter) ? opts.pixelsPerMeter : MAP_LIMITS.rasterPixelsPerMeter;
  const cap = isNum(opts.maxSize) ? opts.maxSize : MAP_LIMITS.rasterMaxSize;
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxZ - bounds.minZ);
  let W = Math.round(w * ppm);
  let H = Math.round(h * ppm);
  const k = Math.min(1, cap / Math.max(W, H));
  W = Math.max(32, Math.round(W * k));
  H = Math.max(32, Math.round(H * k));
  return { width: W, height: H };
}

// ── 小噪声（没有真实地形时给底图一点质感，不然就是一块纯色） ──────────────
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
/** 两三个倍频就够了：地图底图只要"不是一片死色"，不需要真的地形质感。 */
export function mapNoise(x, z, seed = 7) {
  return valueNoise(x * 0.011, z * 0.011, seed) * 0.62
    + valueNoise(x * 0.045, z * 0.045, seed + 11) * 0.28
    + valueNoise(x * 0.17, z * 0.17, seed + 29) * 0.1;
}

function coverColor(code) {
  return COVER_MAP_COLORS[code] || COVER_FALLBACK;
}

/**
 * 烘焙地形底图：RGBA 像素数组（不是 canvas，渲染层再 putImageData）。
 *  · 有真实地形：土地覆盖配色 + 山体阴影（西北光）+ 河网；
 *  · 没有真实地形（?terrain=0）：用噪声铺一层草地，镇子轮廓靠矢量建筑/道路体现。
 *
 * @returns {{width:number,height:number,pixels:Uint8ClampedArray,hasTerrain:boolean}}
 */
export function bakeTerrainRaster(terrain, bounds, opts = {}) {
  const { width: W, height: H } = rasterSizeFor(bounds, opts);
  const pixels = new Uint8ClampedArray(W * H * 4);
  const worldW = bounds.maxX - bounds.minX;
  const worldH = bounds.maxZ - bounds.minZ;

  if (!terrain || typeof terrain.heightAt !== 'function') {
    fillFlatRaster(pixels, W, H, bounds, opts);
    return { width: W, height: H, pixels, hasTerrain: false };
  }

  const heights = new Float32Array(W * H);
  const covers = new Uint8Array(W * H);
  const hasCover = typeof terrain.coverAt === 'function';
  for (let y = 0; y < H; y += 1) {
    const wz = bounds.minZ + ((y + 0.5) / H) * worldH;
    for (let x = 0; x < W; x += 1) {
      const wx = bounds.minX + ((x + 0.5) / W) * worldW;
      const i = y * W + x;
      heights[i] = terrain.heightAt(wx, wz);
      covers[i] = hasCover ? terrain.coverAt(wx, wz) : 0;
    }
  }

  const px = worldW / W;
  const pz = worldH / H;
  // 光从西北上方来（和 3D 里的太阳方向大致一致，看起来才像同一张图）
  const lx = -0.55, ly = 0.72, lz = -0.42;
  for (let y = 0; y < H; y += 1) {
    const rowUp = Math.max(0, y - 1) * W;
    const rowDn = Math.min(H - 1, y + 1) * W;
    const row = y * W;
    for (let x = 0; x < W; x += 1) {
      const i = row + x;
      const hL = heights[row + Math.max(0, x - 1)];
      const hR = heights[row + Math.min(W - 1, x + 1)];
      const hU = heights[rowUp + x];
      const hD = heights[rowDn + x];
      const nx = -(hR - hL) / (2 * Math.max(0.001, px));
      const nz = -(hD - hU) / (2 * Math.max(0.001, pz));
      const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
      const dot = (nx * lx + ly + nz * lz) * inv;
      const shade = clamp(0.62 + 0.58 * dot, 0.4, 1.35);
      const base = coverColor(covers[i]);
      const o = i * 4;
      pixels[o] = clamp(base[0] * shade, 0, 255);
      pixels[o + 1] = clamp(base[1] * shade, 0, 255);
      pixels[o + 2] = clamp(base[2] * shade, 0, 255);
      pixels[o + 3] = 255;
    }
  }

  stampRivers(pixels, W, H, bounds, terrain.rivers);
  return { width: W, height: H, pixels, hasTerrain: true };
}

function fillFlatRaster(pixels, W, H, bounds, opts = {}) {
  const worldW = bounds.maxX - bounds.minX;
  const worldH = bounds.maxZ - bounds.minZ;
  const seed = isNum(opts.seed) ? opts.seed : 7;
  for (let y = 0; y < H; y += 1) {
    const wz = bounds.minZ + ((y + 0.5) / H) * worldH;
    for (let x = 0; x < W; x += 1) {
      const wx = bounds.minX + ((x + 0.5) / W) * worldW;
      const n = mapNoise(wx, wz, seed);
      // 草地 → 土黄的插值，压暗一点，和道路/建筑对比够
      const r = 58 + n * 46;
      const g = 74 + n * 40;
      const b = 52 + n * 30;
      const o = (y * W + x) * 4;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
      pixels[o + 3] = 255;
    }
  }
}

/** 把河网烙进底图（沿折线盖软边圆斑），比逐像素查 waterAt 快一个数量级。 */
function stampRivers(pixels, W, H, bounds, rivers) {
  if (!Array.isArray(rivers) || !rivers.length) return;
  const worldW = bounds.maxX - bounds.minX;
  const worldH = bounds.maxZ - bounds.minZ;
  const sx = W / worldW;
  const sz = H / worldH;
  const water = MAP_PALETTE.water;
  const blend = (px, py, a) => {
    if (px < 0 || py < 0 || px >= W || py >= H || a <= 0) return;
    const o = (py * W + px) * 4;
    const k = a > 1 ? 1 : a;
    pixels[o] = pixels[o] * (1 - k) + water[0] * k;
    pixels[o + 1] = pixels[o + 1] * (1 - k) + water[1] * k;
    pixels[o + 2] = pixels[o + 2] * (1 - k) + water[2] * k;
  };
  for (const r of rivers) {
    if (!r || !Array.isArray(r.p) || r.p.length < 4) continue;
    const halfM = Math.max(1, (isNum(r.w) ? r.w : 4) / 2);
    const halfPx = Math.max(0.8, halfM * ((sx + sz) / 2));
    for (let i = 0; i < r.p.length - 2; i += 2) {
      const x0 = r.p[i], z0 = r.p[i + 1], x1 = r.p[i + 2], z1 = r.p[i + 3];
      const ax = (x0 - bounds.minX) * sx, ay = (z0 - bounds.minZ) * sz;
      const bx = (x1 - bounds.minX) * sx, by = (z1 - bounds.minZ) * sz;
      const minX = Math.floor(Math.min(ax, bx) - halfPx - 2);
      const maxX = Math.ceil(Math.max(ax, bx) + halfPx + 2);
      const minY = Math.floor(Math.min(ay, by) - halfPx - 2);
      const maxY = Math.ceil(Math.max(ay, by) + halfPx + 2);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-6;
      for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
          let t = ((px - ax) * dx + (py - ay) * dy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = ax + dx * t, cy = ay + dy * t;
          const d = Math.hypot(px - cx, py - cy);
          if (d > halfPx + 1.2) continue;
          blend(px, py, clamp((halfPx + 1.2 - d) / 1.6, 0, 1));
        }
      }
    }
  }
}

/**
 * 静态要素提取：建筑 / 镇内街道 / OSM 真实道路 / 树 / 围栏 / 地点 / 刷新区 / 古建街区。
 * 全部保留世界坐标（米），渲染层自己做裁剪与投影。
 */
export function collectStaticFeatures(input = {}) {
  const layout = input.layout || {};
  const roadNet = input.roadNet || null;

  const buildings = [];
  for (const b of layout.buildings || []) {
    if (!b || !b.rect) continue;
    const r = b.rect;
    const door = Array.isArray(b.doors) && b.doors.length ? b.doors[0] : null;
    buildings.push({
      x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1,
      district: b.district || 'residential',
      type: b.type || 'house',
      name: b.name || '',
      danger: isNum(b.danger) ? b.danger : 0.3,
      door: door ? { side: door.side, center: door.center, width: door.width } : null,
    });
  }

  const streets = [];
  for (const r of layout.roads || []) {
    if (!r) continue;
    streets.push({ axis: r.axis || 'x', x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 });
  }

  const netRoads = [];
  if (roadNet && Array.isArray(roadNet.edges)) {
    for (const e of roadNet.edges) {
      if (!e || e.tunnel || !Array.isArray(e.p) || e.p.length < 4) continue;
      const pts = [];
      for (let i = 0; i < e.p.length - 1; i += 2) pts.push({ x: e.p[i], z: e.p[i + 1] });
      if (pts.length < 2) continue;
      const style = roadStyleFor(e.class);
      netRoads.push({
        id: e.id || '',
        cls: e.class || 'unknown',
        color: style.color,
        width: Math.max(style.minW, isNum(e.width) ? e.width : style.minW),
        dash: style.dash,
        bridge: !!e.bridge,
        name: e.name || null,
        ref: e.ref || null,
        pts,
      });
    }
  }

  const trees = [];
  for (const t of layout.trees || []) {
    if (!t) continue;
    trees.push({
      x: t.x, z: t.z,
      r: Math.max(1.1, 1.5 * (isNum(t.scale) ? t.scale : 1)),
      dead: !!t.dead,
    });
  }

  const fences = [];
  for (const f of layout.fences || []) {
    if (!f) continue;
    fences.push({ x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1 });
  }

  const pois = [];
  for (const p of layout.poi || []) {
    if (!p || !isNum(p.x) || !isNum(p.z)) continue;
    pois.push({
      id: p.id || '', name: p.name || '地点', kind: p.kind || 'poi',
      x: p.x, z: p.z, radius: isNum(p.radius) ? p.radius : 10,
      danger: isNum(p.danger) ? p.danger : 0.3,
    });
  }

  // 刷新区只保留"僵尸区"：给大地图一个"这片区域危险"的底纹，不暴露 NPC 位置。
  const dangerZones = [];
  for (const z of layout.spawnZones || []) {
    if (!z || z.type !== 'zombie' || !isNum(z.x) || !isNum(z.z)) continue;
    dangerZones.push({
      id: z.id || '', x: z.x, z: z.z,
      radius: isNum(z.radius) ? z.radius : 20,
      tier: z.tier || 'mid',
    });
  }

  const town = layout.bounds
    ? { x0: layout.bounds.minX, z0: layout.bounds.minZ, x1: layout.bounds.maxX, z1: layout.bounds.maxZ }
    : null;
  const heritage = layout.heritage && layout.heritage.block ? { ...layout.heritage.block } : null;

  const cars = (layout.cars || []).map((c) => ({
    id: c.id || '', x: c.x, z: c.z, drivable: !!c.drivable, kind: c.kind || 'car',
  }));

  return { buildings, streets, netRoads, trees, fences, pois, dangerZones, town, heritage, cars };
}

/**
 * 动态标记：玩家 / 感染者 / 掠夺者 / 幸存者 / 车 / 地点 / 任务点。
 * @param {object} state {player:{x,z,yaw}, npcs:[], cars:[], poi:[], quest:{x,z,label}|null, driving:bool}
 * @param {object} opts  {range:number|null} range=null 表示不按距离过滤（大地图）
 * @returns {{markers:Array, stats:object}}
 */
export function buildMarkers(state = {}, opts = {}) {
  const player = state.player || { x: 0, z: 0, yaw: 0 };
  const px = isNum(player.x) ? player.x : 0;
  const pz = isNum(player.z) ? player.z : 0;
  const range = isNum(opts.range) && opts.range > 0 ? opts.range : null;
  const markers = [];
  const stats = { zombies: 0, alert: 0, hostiles: 0, friendlies: 0, cars: 0, nearestZombie: null, nearestHostile: null };

  const distOf = (x, z) => Math.hypot(x - px, z - pz);
  const within = (x, z, mul = 1) => range == null || distOf(x, z) <= range * mul;

  markers.push({
    kind: state.driving ? 'player-car' : 'player',
    x: px, z: pz, yaw: isNum(player.yaw) ? player.yaw : 0,
    label: state.driving ? '你（车内）' : '你',
  });

  for (const n of state.npcs || []) {
    if (!n || n.alive === false) continue;
    if (!isNum(n.x) || !isNum(n.z)) continue;
    if (!within(n.x, n.z)) continue;
    const d = distOf(n.x, n.z);
    if (n.type === 'zombie') {
      const alert = n.state === 'chase' || n.state === 'attack' || n.state === 'engage';
      stats.zombies += 1;
      if (alert) stats.alert += 1;
      if (stats.nearestZombie == null || d < stats.nearestZombie) stats.nearestZombie = d;
      markers.push({ kind: alert ? 'zombie-alert' : 'zombie', x: n.x, z: n.z, yaw: n.yaw || 0, dist: d, state: n.state || '' });
    } else if (n.type === 'hostile') {
      stats.hostiles += 1;
      if (stats.nearestHostile == null || d < stats.nearestHostile) stats.nearestHostile = d;
      markers.push({ kind: 'hostile', x: n.x, z: n.z, yaw: n.yaw || 0, dist: d, state: n.state || '' });
    } else if (n.type === 'friendly') {
      stats.friendlies += 1;
      markers.push({ kind: 'friendly', x: n.x, z: n.z, yaw: n.yaw || 0, dist: d, name: n.name || '' });
    }
  }

  for (const c of state.cars || []) {
    if (!c || !isNum(c.x) || !isNum(c.z)) continue;
    if (!within(c.x, c.z, 1.6)) continue;
    stats.cars += 1;
    markers.push({ kind: c.drivable ? 'car-drivable' : 'car', x: c.x, z: c.z, dist: distOf(c.x, c.z), id: c.id });
  }

  for (const p of state.poi || []) {
    if (!p || !isNum(p.x) || !isNum(p.z)) continue;
    if (!within(p.x, p.z, 2)) continue;
    let kind = 'poi';
    if (p.kind === 'base') kind = 'base';
    else if (p.kind === 'danger') kind = 'danger';
    markers.push({ kind, x: p.x, z: p.z, label: p.name || '', poiKind: p.kind || '', radius: p.radius || 0, dist: distOf(p.x, p.z) });
  }

  const q = state.quest;
  if (q && isNum(q.x) && isNum(q.z) && within(q.x, q.z, 4)) {
    markers.push({ kind: 'quest', x: q.x, z: q.z, label: q.label || '任务', dist: distOf(q.x, q.z) });
  }

  markers.sort((a, b) => (MARKER_STYLE[a.kind] ? MARKER_STYLE[a.kind].z : 0) - (MARKER_STYLE[b.kind] ? MARKER_STYLE[b.kind].z : 0));
  return { markers, stats };
}

/**
 * 视图变换：世界米 → 画布 CSS 像素。
 *   sx = W/2 + (dx·cos − dz·sin)
 *   sy = H/2 + (dx·sin + dz·cos)       dx = (x − cx)·scale, dz = (z − cz)·scale
 * rotation = 0 → 正北朝上；rotation = yaw + π → 玩家前方朝上（小地图）。
 */
export function makeView({ bounds, center, scale, rotation = 0, width, height }) {
  const cx = isNum(center && center.x) ? center.x : 0;
  const cz = isNum(center && center.z) ? center.z : 0;
  const s = isNum(scale) && scale > 0 ? scale : 1;
  const rot = isNum(rotation) ? rotation : 0;
  const W = Math.max(1, isNum(width) ? width : 1);
  const H = Math.max(1, isNum(height) ? height : 1);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const hw = W / 2;
  const hh = H / 2;

  const worldToScreen = (x, z) => {
    const dx = (x - cx) * s;
    const dz = (z - cz) * s;
    return { x: hw + dx * cos - dz * sin, y: hh + dx * sin + dz * cos };
  };
  const screenToWorld = (sx, sy) => {
    const dx = sx - hw;
    const dy = sy - hh;
    const wx = dx * cos + dy * sin;
    const wz = -dx * sin + dy * cos;
    return { x: cx + wx / s, z: cz + wz / s };
  };
  /** 当前视图在世界里的 AABB（用来裁掉画不到的东西）。 */
  const visibleBounds = () => {
    const half = Math.hypot(hw, hh) / s;
    return { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
  };
  /** 把 canvas 变换设成"米空间"：之后所有绘制都用世界坐标 + 米做单位。 */
  const applyToContext = (ctx, dpr = 1) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(hw, hh);
    ctx.rotate(rot);
    ctx.scale(s, s);
    ctx.translate(-cx, -cz);
  };
  return {
    bounds, center: { x: cx, z: cz }, scale: s, rotation: rot, width: W, height: H,
    metersPerPixel: 1 / s,
    worldToScreen, screenToWorld, visibleBounds, applyToContext,
  };
}

/** 矩形是否与 AABB 相交（渲染裁剪用）。 */
export function rectInAabb(x0, z0, x1, z1, aabb) {
  return !(x1 < aabb.minX || x0 > aabb.maxX || z1 < aabb.minZ || z0 > aabb.maxZ);
}

/** 点是否在 AABB 内（带外扩）。 */
export function pointInAabb(x, z, aabb, pad = 0) {
  return x >= aabb.minX - pad && x <= aabb.maxX + pad && z >= aabb.minZ - pad && z <= aabb.maxZ + pad;
}

export function formatDistance(meters) {
  if (!isNum(meters)) return '—';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}

export default {
  MAP_LIMITS, MAP_PALETTE, DISTRICT_FILL, DISTRICT_LABELS, ROAD_CLASS_STYLE, MARKER_STYLE,
  worldToLocal, localToWorld, makeMapBounds, rasterSizeFor, bakeTerrainRaster,
  collectStaticFeatures, buildMarkers, makeView, rectInAabb, pointInAabb,
  roadStyleFor, districtStyle, formatDistance, mapNoise,
};
