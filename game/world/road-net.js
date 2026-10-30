// 真实路网渲染：把 bake-roads 烘焙出来的道路网络（节点 + 边 + 高程剖面）变成 three.js 网格。
//
// ── 与道具包「道路」的关系（任务书 §2 的优先级）──
// 道具包是 **2×2 单位、沥青占 1/3、人行道各 1/3** 的方格模块（见 tools/analyze-road-templates.mjs
// 实测输出与 dist/data/roads/templates.json）。真实道路是曲线的、宽度按等级变化的，
// 直接拿方格模块去铺会断裂、错缝，所以这里按任务书允许的
// **第二/第三/第四优先级**：改尺寸（按等级重算断面）→ 组合（沥青+路缘+标线+护栏分开拼）
// → 重新生成（曲线用样条挤出面），并且**沿用模板的配色与断面比例**：
//   · 沥青 #3a3434（模板 Kd 线性值 0.0418 换算出来的实测色）
//   · 人行道/路缘 #8a8c90（Grey）
//   · 标线 #eeeeee（White）
// 路灯 / 信号灯 / 站牌仍然**直接用道具包的模型**（instanced，见 build.js 的 propGeometry）。
//
// 数据流：
//   dist/data/roads/<name>.json ──loadRoadNet──► net {nodes, edges, classes, stats}
//   net ──buildRoadNet(THREE, net, opts)──► { group, props, stats, connectors }
//   build.js 只负责把 group 加进场景、把 props 塞进 InstancedMesh。
import { mulberry32 } from './terrain.js';

/** 模板实测配色（见 tools/analyze-road-templates.mjs 与 docs/ROAD-TEMPLATES.md）。 */
export const ROAD_COLORS = {
  asphalt: 0x3a3434,      // 模板 Black（Kd 0.0418）
  asphaltWorn: 0x453e3e,  // 高频磨损带（视觉层次）
  pavement: 0x8a8c90,     // 模板 Grey
  curb: 0x9a9ca0,
  lineWhite: 0xf2f2f0,    // 模板 White（路面漆的白，比纯白暗一点点）
  lineYellow: 0xe8b81c,   // 路面漆的黄（GB 5768 的黄线是饱和黄，不是土黄）
  gravel: 0x6f6558,
  paving: 0x7d7a74,
  dirt: 0x6a5a44,
  barrier: 0x9aa0a6,
  pier: 0x7c8087,
};

/**
 * 标线尺寸（米）。依据《GB 5768 道路交通标志和标线》：
 *   车行道分界线宽 15cm（城市道路 10~15cm，公路 15cm）；
 *   双黄线两道各 15cm、间距 15cm；
 *   车行道边缘线宽 15cm，距路面边缘 0.3~0.5m；
 *   高速公路车道分界虚线 6m 线 + 9m 空；城市道路 4m 线 + 6m 空。
 */
export const MARKING = {
  line: 0.15,
  gap: 0.15,
  edgeInset: 0.35,
  dashHighway: [6, 9],
  dashUrban: [4, 6],
};

/** 车行/步行道路的绘制参数（width 等断面值来自烘焙数据里的 classes 表）。 */
const MARKINGS_STYLE = {
  motorway: { kind: 'divided' },
  arterial: { kind: 'divided' },
  centre: { kind: 'centre' },
  none: null,
};

/**
 * 标线布局（纯函数，可单测）：返回这条路上该画哪几条线。
 *
 * 关键规则（之前画错的都在这）：
 *   · **单向路**（高速每一幅、单行道）中间不是"对向分隔"，所以：
 *     左侧（靠中央分隔带/对向车道那侧）一条**黄色实线**，右侧一条**白色实线**；
 *   · **双向路**才是中间双黄线（两道 15cm、间距 15cm）+ 两侧白边线；
 *   · 车道分界虚线按**车道数**算偏移（不是写死 ±3.4m），单向路从最左侧车道往右排。
 *
 * `nx/nz` 方向约定：`n = (-dz, dx)`，对行进方向来说是**右手边**，
 * 所以左侧 = 负 offset。
 *
 * @param {object} e 边（用 lanes / oneway / markings / class）
 * @param {number} halfW 沥青半宽（米）
 * @returns {Array<{offset:number,width:number,color:'yellow'|'white',dashed:boolean,dash:number[],kind:string}>}
 */
export function markingLayout(e, halfW) {
  const style = MARKINGS_STYLE[e.markings || 'none'];
  if (!style || !(e.lanes > 0)) return [];
  const lanes = Math.max(1, Math.floor(e.lanes));
  const laneW = (halfW * 2) / lanes;
  const W = MARKING.line;
  const dash = (e.class === 'motorway' || e.class === 'trunk') ? MARKING.dashHighway : MARKING.dashUrban;
  const out = [];
  const push = (offset, width, color, dashed, kind) => {
    out.push({ offset, width, color, dashed: !!dashed, dash, kind });
  };

  if (e.oneway) {
    // 单向幅：左黄右白，中间按车道数加虚线
    push(-(halfW - MARKING.edgeInset), W, 'yellow', false, 'median-yellow');
    push(halfW - MARKING.edgeInset, W, 'white', false, 'edge-white');
    for (let k = 1; k < lanes; k += 1) {
      push(-halfW + k * laneW, W, 'white', true, 'lane-dash');
    }
  } else if (style.kind === 'divided') {
    const halfGapLine = MARKING.gap / 2 + W / 2;   // 双黄线中线到路中心
    push(-halfGapLine, W, 'yellow', false, 'double-yellow-left');
    push(halfGapLine, W, 'yellow', false, 'double-yellow-right');
    push(-(halfW - MARKING.edgeInset), W, 'white', false, 'edge-white');
    push(halfW - MARKING.edgeInset, W, 'white', false, 'edge-white');
    for (let k = 1; k < lanes / 2; k += 1) {
      push(-k * laneW, W, 'white', true, 'lane-dash');
      push(k * laneW, W, 'white', true, 'lane-dash');
    }
  } else {
    push(0, W, 'white', true, 'centre-dash');
    push(-(halfW - MARKING.edgeInset), 0.12, 'white', false, 'edge-white');
    push(halfW - MARKING.edgeInset, 0.12, 'white', false, 'edge-white');
  }
  return out;
}

const STEP = 8;              // 中心线重采样步长（米）
const SKIRT_DROP = 3.0;      // 路肩裙边向下扎多少米（用来遮住地形起伏的缝隙）
const MARK_Y = 0.035;        // 标线比沥青高多少
const CURB_H = 0.12;         // 路缘石高度
const PORTAL_H = 6.2;        // 隧道洞门净高
const BORE_LEN = 34;         // 洞身画多深（再往里是黑的，不需要更远）
const BORE_COLOR = 0x1c1a1a;
const VOID_COLOR = 0x0b0a0a;

/** 载入烘焙好的路网数据。 */
export async function loadRoadNet(url, opts = {}) {
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('没有可用的 fetch');
  const res = await f(url);
  if (!res.ok) throw new Error(`路网数据 HTTP ${res.status}`);
  const net = await res.json();
  if (!net || !Array.isArray(net.edges)) throw new Error('路网数据格式不对');
  return new RoadNet(net);
}

export class RoadNet {
  constructor(data) {
    this.data = data;
    this.edges = data.edges || [];
    this.nodes = data.nodes || [];
    this.classes = data.classes || {};
    this.stats = data.stats || {};
    this.issues = data.issues || [];
    this.extent = data.extent || { half: 1200, townHalf: 175 };
    this.byId = new Map(this.edges.map((e) => [e.id, e]));
    this.nodeById = new Map(this.nodes.map((n) => [n.id, n]));
    this._index = null;
  }

  /**
   * 空间索引：32m 一格的桶，桶里放"边序号 + 起始点序号"。
   * 用途只有一个但很重要：**路面要能站人**。
   * 道路的高程剖面是"挖填后的平台"，和原地形不重合（可能高 1~3m，桥更高），
   * 所以玩家的落地高度不能只查地形，还要查路面 —— 见 game.js 的 groundHeightAt()。
   */
  _buildIndex() {
    if (this._index) return this._index;
    const cell = 32;
    const grid = new Map();
    const key = (cx, cz) => `${cx},${cz}`;
    for (let i = 0; i < this.edges.length; i += 1) {
      const e = this.edges[i];
      if (e.tunnel) continue; // 隧道不画路面，也不站人
      const spec = this.classes[e.class] || {};
      const reach = (e.width || spec.width || 7) / 2 + Math.max(0, spec.sidewalk || 0) + 2;
      for (let k = 0; k < e.p.length - 2; k += 2) {
        const x0 = e.p[k], z0 = e.p[k + 1], x1 = e.p[k + 2], z1 = e.p[k + 3];
        const cx0 = Math.floor((Math.min(x0, x1) - reach) / cell);
        const cx1 = Math.floor((Math.max(x0, x1) + reach) / cell);
        const cz0 = Math.floor((Math.min(z0, z1) - reach) / cell);
        const cz1 = Math.floor((Math.max(z0, z1) + reach) / cell);
        for (let cx = cx0; cx <= cx1; cx += 1) {
          for (let cz = cz0; cz <= cz1; cz += 1) {
            const k2 = key(cx, cz);
            let arr = grid.get(k2);
            if (!arr) { arr = []; grid.set(k2, arr); }
            arr.push(i, k);
          }
        }
      }
    }
    this._index = { cell, grid };
    return this._index;
  }

  /**
   * 路面高度（米，相对城镇地面）：不在任何道路上返回 null。
   * 桥面按烘焙时抬起来的高度算，所以走上桥是真的会高起来。
   */
  heightAt(x, z) {
    const { cell, grid } = this._buildIndex();
    const arr = grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`);
    if (!arr) return null;
    let best = null;
    for (let i = 0; i < arr.length; i += 2) {
      const e = this.edges[arr[i]];
      const k = arr[i + 1];
      const spec = this.classes[e.class] || {};
      const halfW = ((e.width || spec.width || 7) / 2) + Math.max(0, spec.sidewalk || 0) * 0.9;
      const x0 = e.p[k], z0 = e.p[k + 1], x1 = e.p[k + 2], z1 = e.p[k + 3];
      const dx = x1 - x0, dz = z1 - z0;
      const len2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - x0) * dx + (z - z0) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x0 + dx * t, pz = z0 + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d > halfW) continue;
      const y = e.y[k] + (e.y[k + 1] - e.y[k]) * t;
      if (best == null || y > best) best = y;
    }
    return best == null ? null : best + 0.02; // +2cm：和可见路面（lift）对齐
  }

  /** 该节点上接的边（用来判断路口等级/是否有红绿灯）。 */
  edgesAt(nodeId) {
    return this.edges.filter((e) => e.a === nodeId || e.b === nodeId);
  }

  summary() {
    const byClass = this.stats.byClass || {};
    const top = Object.entries(byClass).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, v]) => `${k}×${v}`);
    return {
      edges: this.edges.length,
      nodes: this.nodes.length,
      length: Math.round(this.edges.reduce((a, e) => a + e.length, 0)),
      bridges: this.stats.bridges || 0,
      tunnels: this.stats.tunnels || 0,
      top,
      issues: this.issues.length,
    };
  }
}

// ── 几何工具 ───────────────────────────────────────────────────────────────

/** Catmull-Rom 重采样：把折线变成等距点，让弯道不再是硬折角。 */
function resamplePath(p, y, step) {
  const n = p.length / 2;
  if (n < 2) return { pts: [], length: 0 };
  const at = (i) => {
    const c = Math.max(0, Math.min(n - 1, i));
    return [p[c * 2], p[c * 2 + 1], y[Math.min(y.length - 1, c)]];
  };
  const out = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (segLen < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(segLen / step));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull-Rom（张力 0.5）；y 用线性插值，避免竖向过冲把路拱起来
      const cr = (a0, a1, a2, a3) => 0.5 * ((2 * a1) + (-a0 + a2) * t
        + (2 * a0 - 5 * a1 + 4 * a2 - a3) * t2 + (-a0 + 3 * a1 - 3 * a2 + a3) * t3);
      out.push({
        x: cr(p0[0], p1[0], p2[0], p3[0]),
        z: cr(p0[1], p1[1], p2[1], p3[1]),
        y: p1[2] + (p2[2] - p1[2]) * t,
        s: acc + segLen * t,
      });
    }
    acc += segLen;
  }
  const last = at(n - 1);
  out.push({ x: last[0], z: last[1], y: last[2], s: acc });
  return { pts: out, length: acc };
}

/** 采样点的切线方向与左法线。 */
function frames(pts) {
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    pts[i].dx = dx;
    pts[i].dz = dz;
    pts[i].nx = -dz;
    pts[i].nz = dx;
  }
  return pts;
}

/** sRGB 0..255 → 线性 0..1（three.js 的颜色管理要求顶点色是线性空间的值）。 */
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 折线上按弧长取点（位置/法线一起线性插值）。 */
function pointAtS(pts, s) {
  if (!pts.length) return null;
  if (s <= pts[0].s) return pts[0];
  if (s >= pts[pts.length - 1].s) return pts[pts.length - 1];
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s <= s) lo = mid; else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
  const nx = a.nx + (b.nx - a.nx) * t;
  const nz = a.nz + (b.nz - a.nz) * t;
  const nl = Math.hypot(nx, nz) || 1;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    y: a.y + (b.y - a.y) * t,
    nx: nx / nl,
    nz: nz / nl,
  };
}

/**
 * 一条标线要画哪些弧长区间：
 *   · 虚线按 dash/gap 严格切（按弧长算，不按采样点，所以 6m 线 / 9m 空是准的）；
 *   · 路口附近（半径 = 该路口最宽路的一半 + 2.5m）断开展平，真实道路标线到路口就停。
 */
function markingRanges(pts, total, spec, junctionAt) {
  const out = [];
  const step = 0.5;
  const [dl, gl] = spec.dash || [6, 9];
  const period = dl + gl;
  let start = null;
  const isOn = (s) => {
    if (spec.dashed && (s % period) > dl) return false;
    const q = pointAtS(pts, s);
    return !junctionAt(q.x, q.z);
  };
  for (let s = 0; s <= total + 1e-6; s += step) {
    const on = isOn(Math.min(s, total));
    if (on && start == null) start = s;
    if (!on && start != null) {
      out.push([start, Math.max(start, s - step)]);
      start = null;
    }
  }
  if (start != null) out.push([start, total]);
  return out.filter(([a, b]) => b - a > 0.4);
}

/** 把一条标线（在 offset 处、width 宽）画进 bucket。 */
function drawMarking(pts, spec, ranges, bucket, yOff) {
  const hex = spec.color === 'yellow' ? ROAD_COLORS.lineYellow : ROAD_COLORS.lineWhite;
  const w = spec.width / 2;
  for (const [s0, s1] of ranges) {
    const L = [];
    const R = [];
    const pushAt = (q) => {
      const ax = q.x + q.nx * spec.offset;
      const az = q.z + q.nz * spec.offset;
      L.push([ax + q.nx * w, q.y + yOff, az + q.nz * w]);
      R.push([ax - q.nx * w, q.y + yOff, az - q.nz * w]);
    };
    pushAt(pointAtS(pts, s0));
    for (const p of pts) if (p.s > s0 && p.s < s1) pushAt(p);
    pushAt(pointAtS(pts, s1));
    if (L.length >= 2) bucket.strip(L, R, hex);
  }
}

/** 把若干三角形塞进一个"按材质分桶"的收集器；顶点色直接写死，省一份材质表。 */
class Bucket {
  constructor() {
    this.pos = [];
    this.col = [];
  }

  tri(a, b, c, hex) {
    const r = srgbToLinear((hex >> 16) & 255);
    const g = srgbToLinear((hex >> 8) & 255);
    const bl = srgbToLinear(hex & 255);
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.col.push(r, g, bl, r, g, bl, r, g, bl);
  }

  /** 一条带：左右两条边（每边一串点），朝向 +Y（顺序已按右手系校对过）。 */
  strip(left, right, hex) {
    for (let i = 0; i < left.length - 1; i += 1) {
      const L0 = left[i], L1 = left[i + 1], R0 = right[i], R1 = right[i + 1];
      this.tri(L0, L1, R1, hex);
      this.tri(L0, R1, R0, hex);
    }
  }

  quad(a, b, c, d, hex) {
    this.tri(a, b, c, hex);
    this.tri(a, c, d, hex);
  }

  get empty() { return this.pos.length === 0; }

  toGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 建整个真实路网。
 * @param {object} THREE
 * @param {RoadNet} net
 * @param {{townRoads?:Array, townHalf?:number, lights?:boolean, signs?:boolean,
 *          tunnelStubs?:boolean, seed?:number}} [opts]
 * @returns {{group, props, stats, connectors}}
 */
export function buildRoadNet(THREE, net, opts = {}) {
  const seed = (opts.seed || 20260801) >>> 0;
  const rng = mulberry32(seed ^ 0x5ea1f00d);
  const surfaces = new Bucket();   // 沥青 + 硬质路面
  const curbs = new Bucket();      // 路缘石 / 护栏 / 桥墩（竖直面）
  const marks = new Bucket();      // 标线
  const skirts = new Bucket();     // 路肩裙边（扎进地形，遮缝）
  const group = new THREE.Group();
  group.name = 'roadNet';

  const props = [];
  const stats = {
    edges: net.edges.length, drawn: 0, tunnels: 0, bridges: 0, footpaths: 0,
    asphaltLength: 0, quads: 0, props: 0, junctions: 0, connectors: 0, markingLines: 0,
  };
  const connectors = [];
  const tunnelEdges = [];
  const townRoads = Array.isArray(opts.townRoads) ? opts.townRoads : [];
  const townHalf = opts.townHalf || net.extent.townHalf || 175;

  // ── 路口范围（标线要在路口处断开）
  // 半径 = 该节点上最宽那条路的一半 + 2.5m，够把补面圆盘整个盖住。
  const junctionPts = (() => {
    const degree = new Map();
    for (const e of net.edges) {
      if (e.tunnel || e.vehicle === false || !(e.lanes > 0)) continue;
      degree.set(e.a, (degree.get(e.a) || 0) + 1);
      degree.set(e.b, (degree.get(e.b) || 0) + 1);
    }
    const maxW = new Map();
    for (const e of net.edges) {
      if (e.tunnel) continue;
      const w = e.width || 7;
      for (const id of [e.a, e.b]) if (!maxW.has(id) || w > maxW.get(id)) maxW.set(id, w);
    }
    const out = [];
    for (const [id, d] of degree) {
      if (d < 3) continue;
      const nd = net.nodeById.get(id);
      if (!nd) continue;
      out.push({ x: nd.x, z: nd.z, r: (maxW.get(id) || 7) / 2 + 2.5 });
    }
    return out;
  })();
  const nearJunction = (x, z) => {
    for (let i = 0; i < junctionPts.length; i += 1) {
      const j = junctionPts[i];
      const dx = x - j.x;
      const dz = z - j.z;
      if (dx * dx + dz * dz <= j.r * j.r) return true;
    }
    return false;
  };

  // 在镇界断点处，把真实道路接到镇上最近的一条街（"城市道路入口"）
  function nearestTownRoad(x, z) {
    let best = null;
    for (const r of townRoads) {
      // layout.roads 是一堆矩形长条：取它中心线上的最近点
      const horizontal = r.axis === 'x';
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      let px, pz;
      if (horizontal) { px = Math.max(r.x0, Math.min(r.x1, x)); pz = cz; }
      else { px = cx; pz = Math.max(r.z0, Math.min(r.z1, z)); }
      const d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { x: px, z: pz, d, road: r };
    }
    return best && best.d < 90 ? best : null;
  }

  for (const e of net.edges) {
    if (e.tunnel) { stats.tunnels += 1; tunnelEdges.push(e); continue; }
    const spec = (net.classes && net.classes[e.class]) || {};
    const width = e.width || spec.width || 7;
    const sidewalk = spec.sidewalk != null ? spec.sidewalk : (e.sidewalk || 0);
    const halfW = width / 2;
    const isVehicle = e.vehicle !== false && (e.lanes || 0) > 0;
    const { pts } = resamplePath(e.p, e.y, STEP);
    if (pts.length < 2) continue;
    frames(pts);

    const color = e.surface === 'gravel' ? ROAD_COLORS.gravel
      : e.surface === 'paving' ? ROAD_COLORS.paving
        : e.surface === 'dirt' ? ROAD_COLORS.dirt
          : ROAD_COLORS.asphalt;
    const lift = 0.02;  // 比地形面略高一点（地形网格本身整体下沉了 0.1）

    // 路面（沥青/步行道）：左右两条边
    const left = pts.map((p) => [p.x + p.nx * halfW, p.y + lift, p.z + p.nz * halfW]);
    const right = pts.map((p) => [p.x - p.nx * halfW, p.y + lift, p.z - p.nz * halfW]);
    surfaces.strip(left, right, color);
    stats.quads += (pts.length - 1);
    stats.asphaltLength += e.length || 0;

    // 人行道（城市/国道有，乡道没有）
    if (sidewalk > 0.4 && isVehicle) {
      for (const side of [1, -1]) {
        const outer = pts.map((p) => [
          p.x + p.nx * side * (halfW + sidewalk), p.y + lift + CURB_H, p.z + p.nz * side * (halfW + sidewalk),
        ]);
        const inner = pts.map((p) => [
          p.x + p.nx * side * halfW, p.y + lift + CURB_H, p.z + p.nz * side * halfW,
        ]);
        if (side > 0) surfaces.strip(outer, inner, ROAD_COLORS.pavement);
        else surfaces.strip(inner, outer, ROAD_COLORS.pavement);
        // 路缘石立面（沥青面 → 人行道面）
        for (let i = 0; i < pts.length - 1; i += 1) {
          const a = [inner[i][0], inner[i][1] - CURB_H, inner[i][2]];
          const b = [inner[i + 1][0], inner[i + 1][1] - CURB_H, inner[i + 1][2]];
          const c = inner[i + 1];
          const d = inner[i];
          if (side > 0) curbs.quad(a, b, c, d, ROAD_COLORS.curb);
          else curbs.quad(d, c, b, a, ROAD_COLORS.curb);
        }
        // 裙边：从人行道外沿往下扎，遮住地形起伏的缝
        for (let i = 0; i < pts.length - 1; i += 1) {
          const a = outer[i];
          const b = outer[i + 1];
          const c = [b[0], b[1] - SKIRT_DROP, b[2]];
          const d = [a[0], a[1] - SKIRT_DROP, a[2]];
          if (side > 0) skirts.quad(a, b, c, d, color);
          else skirts.quad(d, c, b, a, color);
        }
      }
    } else if (isVehicle) {
      // 没人行道：也要裙边（乡道/村道贴地）
      for (const side of [1, -1]) {
        const edge = side > 0 ? left : right;
        for (let i = 0; i < pts.length - 1; i += 1) {
          const a = edge[i];
          const b = edge[i + 1];
          const c = [b[0], b[1] - SKIRT_DROP, b[2]];
          const d = [a[0], a[1] - SKIRT_DROP, a[2]];
          if (side > 0) skirts.quad(a, b, c, d, color);
          else skirts.quad(d, c, b, a, color);
        }
      }
    }

    // 标线：布局由 markingLayout() 决定（单向路左黄右白、双向路中间双黄），
    // 虚实/路口断开由 markingRanges() 决定，这里只负责把线挤出来。
    const markTotal = pts.length ? pts[pts.length - 1].s : 0;
    if (isVehicle) {
      const specs = markingLayout(e, halfW);
      for (const spec of specs) {
        const ranges = markingRanges(pts, markTotal, spec, nearJunction);
        drawMarking(pts, spec, ranges, marks, lift + MARK_Y);
      }
      stats.markingLines += specs.length;
    }

    // 桥：护栏 + 桥墩（桥面高度在烘焙时已经抬起来了）
    if (e.bridge) {
      stats.bridges += 1;
      for (const side of [1, -1]) {
        for (let i = 0; i < pts.length - 1; i += 1) {
          const p0 = pts[i], p1 = pts[i + 1];
          const o0 = halfW + 0.25, o1 = halfW + 0.25;
          const a = [p0.x + p0.nx * side * o0, p0.y + lift, p0.z + p0.nz * side * o0];
          const b = [p1.x + p1.nx * side * o1, p1.y + lift, p1.z + p1.nz * side * o1];
          const c = [b[0], b[1] + 1.0, b[2]];
          const d = [a[0], a[1] + 1.0, a[2]];
          if (side > 0) curbs.quad(a, b, c, d, ROAD_COLORS.barrier);
          else curbs.quad(d, c, b, a, ROAD_COLORS.barrier);
        }
      }
      // 桥墩：沿桥每 16m 一对
      for (let i = 4; i < pts.length - 4; i += Math.max(2, Math.round(16 / STEP))) {
        const p = pts[i];
        const groundY = p.y - Math.max(3, (e.bridgeDeck ? 6 : 4));
        for (const side of [1, -1]) {
          const cx = p.x + p.nx * side * (halfW * 0.55);
          const cz = p.z + p.nz * side * (halfW * 0.55);
          const r = 0.55;
          const top = p.y;
          const bot = Math.min(groundY, p.y - 1.2);
          // 一根方柱：4 个侧面
          const s = r;
          const c1 = [cx - s, top, cz - s], c2 = [cx + s, top, cz - s], c3 = [cx + s, top, cz + s], c4 = [cx - s, top, cz + s];
          const b1 = [cx - s, bot, cz - s], b2 = [cx + s, bot, cz - s], b3 = [cx + s, bot, cz + s], b4 = [cx - s, bot, cz + s];
          curbs.quad(b1, b2, c2, c1, ROAD_COLORS.pier);
          curbs.quad(b2, b3, c3, c2, ROAD_COLORS.pier);
          curbs.quad(b3, b4, c4, c3, ROAD_COLORS.pier);
          curbs.quad(b4, b1, c1, c4, ROAD_COLORS.pier);
        }
      }
    }

    stats.drawn += 1;
    if (!isVehicle) stats.footpaths += 1;

    // 路灯 / 信号灯 / 站牌（用道具包模型，只给"有名字或有等级"的路摆，避免野路一堆灯）
    const urban = sidewalk >= 1.2 && isVehicle && ['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified'].includes(e.class);
    if (urban && opts.lights !== false) {
      const step = 46;
      for (let s = step * 0.5; s < (e.length || 0); s += step) {
        const idx = pts.findIndex((p) => p.s >= s);
        if (idx < 0 || idx >= pts.length) continue;
        const p = pts[idx];
        const side = (Math.floor(s / step) % 2) ? 1 : -1;
        const off = halfW + sidewalk - 0.6;
        const px = p.x + p.nx * side * off;
        const pz = p.z + p.nz * side * off;
        const lim = (net.extent.half || 1200) - 2;
        if (Math.abs(px) > lim || Math.abs(pz) > lim) continue; // 别把灯杆立到图幅外
        props.push({
          key: 'streetlight', x: px, y: p.y, z: pz,
          rotY: Math.atan2(p.nx * side, p.nz * side),
        });
      }
    }
  }

  // 区间补面：真实折线在路口处会有缝，用一块圆盘沥青把节点填平
  const vehicleNodes = new Map();
  for (const e of net.edges) {
    if (e.tunnel || e.vehicle === false || !(e.lanes > 0)) continue;
    for (const key of [e.a, e.b]) {
      const spec = (net.classes && net.classes[e.class]) || {};
      const w = e.width || spec.width || 7;
      const rec = vehicleNodes.get(key) || { node: net.nodeById.get(key), w: 0, n: 0, edges: [] };
      rec.w = Math.max(rec.w, w);
      rec.n += 1;
      rec.edges.push(e);
      vehicleNodes.set(key, rec);
    }
  }
  for (const [key, rec] of vehicleNodes) {
    if (rec.n < 3 || !rec.node) continue;
    const node = rec.node;
    const groundY = Math.max(...rec.edges.map((e) => (e.y && e.y.length ? Math.max(...e.y) : 0)), 0);
    const y = (rec.edges[0].y && rec.edges[0].y.length) ? rec.edges.reduce((a, e) => a + e.y[0], 0) / rec.edges.length : groundY;
    const R = rec.w / 2 + 1.4;
    const seg = 14;
    const ring = [];
    for (let i = 0; i <= seg; i += 1) {
      const ang = (i / seg) * Math.PI * 2;
      // 路口不按地形抖：用节点附近边端点的平均高度，避免圆盘歪掉
      ring.push([node.x + Math.cos(ang) * R, y + 0.02, node.z + Math.sin(ang) * R]);
    }
    for (let i = 0; i < seg; i += 1) {
      // 圆心 + 相邻两点：注意绕序（ring 是逆时针生成的话要反过来才是 +Y 法线）
      surfaces.tri([node.x, y + 0.02, node.z], ring[i + 1], ring[i], ROAD_COLORS.asphaltWorn);
    }
    stats.junctions += 1;

    // 信号灯：三岔以上且接了大路
    const big = rec.edges.some((e) => ['trunk', 'primary', 'secondary', 'tertiary'].includes(e.class));
    if (big && opts.signs !== false) {
      props.push({ key: 'traffic_light', x: node.x + 2.2, y, z: node.z + 2.2, rotY: rng() * Math.PI * 2 });
    } else if (opts.signs !== false) {
      props.push({ key: 'sign_stop', x: node.x + 2.0, y, z: node.z + 2.0, rotY: Math.atan2(-node.z, -node.x) });
    }
  }

  // 镇界断点 → 接到镇上最近一条街（城市道路入口）
  if (townRoads.length && opts.connectors !== false) {
    for (const e of net.edges) {
      for (const end of ['a', 'b']) {
        if (e.endReason && e.endReason[end] !== 'town') continue;
        const pt = end === 'a' ? [e.p[0], e.p[1]] : [e.p[e.p.length - 2], e.p[e.p.length - 1]];
        const target = nearestTownRoad(pt[0], pt[1]);
        if (!target) continue;
        const w = e.width || 7;
        const halfW = w / 2;
        const dx = target.x - pt[0];
        const dz = target.z - pt[1];
        const len = Math.hypot(dx, dz);
        if (len < 1.5 || len > 90) continue;
        const nx = -dz / len;
        const nz = dx / len;
        const y0 = e.y ? (end === 'a' ? e.y[0] : e.y[e.y.length - 1]) : 0;
        const a = [pt[0] + nx * halfW, y0 + 0.02, pt[1] + nz * halfW];
        const b = [pt[0] - nx * halfW, y0 + 0.02, pt[1] - nz * halfW];
        const c = [target.x - nx * halfW, y0 + 0.02, target.z - nz * halfW];
        const d = [target.x + nx * halfW, y0 + 0.02, target.z + nz * halfW];
        surfaces.quad(a, b, c, d, ROAD_COLORS.asphalt);
        connectors.push({ edge: e.id, end, from: pt, to: [target.x, target.z], length: Math.round(len * 10) / 10 });
        stats.connectors += 1;
      }
    }
  }

  // ── 隧道洞门 + 洞身
  // 道具包「道路」没有隧道结构，最接近的是 `Street_Bridge_Underpass`（路从结构下方穿过），
  // 所以这里**按它的结构关系改装**：路面在下、上方压一层过街结构、两侧是挡墙。
  // 洞门位置取隧道边的端点（隧道边在 OSM 里就是"从山体下面穿过"的那一段），
  // 洞身只画 34m —— 再往里是黑的，画多了纯浪费。
  const portalStats = { portals: 0, bores: 0 };
  for (const e of tunnelEdges) {
    const spec = (net.classes && net.classes[e.class]) || {};
    const width = Math.max(6, (e.width || spec.width || 8) + 1.2);
    const halfW = width / 2;
    // 洞身不能比隧道本身长：否则短隧道的洞身会从另一头"戳"出去，变成一截露在外面的黑管子
    const boreLen = Math.min(BORE_LEN, Math.max(6, e.length || BORE_LEN));
    const portalH = e.vehicle ? PORTAL_H : 3.2;   // 步行隧道不要 6m 高的门
    const n = e.p.length / 2;
    // 两端各判断一次：这一端是不是"洞口"（另一端接的是地面上能走的路）
    for (const end of ['a', 'b']) {
      const nodeId = e[end];
      const others = net.edges.filter((x) => x !== e && !x.tunnel && (x.a === nodeId || x.b === nodeId));
      if (!others.length) continue;                       // 两端都在洞里，不是洞口
      const isA = end === 'a';
      const px = isA ? e.p[0] : e.p[(n - 1) * 2];
      const pz = isA ? e.p[1] : e.p[(n - 1) * 2 + 1];
      const qx = isA ? e.p[2] : e.p[(n - 2) * 2];         // 往洞里走的下一个点
      const qz = isA ? e.p[3] : e.p[(n - 2) * 2 + 1];
      let ix = qx - px;
      let iz = qz - pz;
      const il = Math.hypot(ix, iz) || 1;
      ix /= il; iz /= il;                                  // 指**进洞**方向
      const ox = -ix, oz = -iz;                            // 指出洞方向
      const nx = -iz, nz = ix;                             // 洞口横向
      const y0 = e.y ? (isA ? e.y[0] : e.y[e.y.length - 1]) : 0;
      // 关键判据：地形到底盖不盖住这条路？
      // 盖住 → 真隧道，画洞门 + 洞身；盖不住 → 只是"从路/堤下面穿过"的下穿，
      // 上面的路本来就已经画好了，再套洞身会变成一截黑管子戳在草坡上（截图抓到过）。
      const midIdx = Math.floor(n / 2);
      const midX = e.p[midIdx * 2];
      const midZ = e.p[midIdx * 2 + 1];
      const midY = e.y ? e.y[midIdx] : 0;
      const terrainAbove = opts.terrain && typeof opts.terrain.heightAt === 'function'
        ? opts.terrain.heightAt(midX, midZ)
        : midY + 999; // 没有地形数据时按"真隧道"处理（宁可画）
      const covered = terrainAbove > midY + 2.5;
      if (!covered) continue;
      const wallT = 1.5;                                   // 洞门墙厚
      const wingD = 5.0;                                   // 洞门纵深
      const portalW = halfW + wallT;

      const box = (cx, cy, cz, sx, sy, sz, hex, bucket) => {
        // 轴对齐盒：沿 (ix,iz) 展开 sx，横向 sz
        const corners = [
          [cx - ix * sx / 2 - nx * sz / 2, cz - iz * sx / 2 - nz * sz / 2],
          [cx + ix * sx / 2 - nx * sz / 2, cz + iz * sx / 2 - nz * sz / 2],
          [cx + ix * sx / 2 + nx * sz / 2, cz + iz * sx / 2 + nz * sz / 2],
          [cx - ix * sx / 2 + nx * sz / 2, cz - iz * sx / 2 + nz * sz / 2],
        ];
        const bot = corners.map(([x, z]) => [x, cy, z]);
        const top = corners.map(([x, z]) => [x, cy + sy, z]);
        // 顶面
        bucket.quad(top[0], top[1], top[2], top[3], hex);
        // 四个侧面
        for (let i = 0; i < 4; i += 1) {
          const j = (i + 1) % 4;
          bucket.quad(bot[i], bot[j], top[j], top[i], hex);
        }
      };

      // 两侧门柱（洞门挡墙）
      for (const side of [1, -1]) {
        const cx = px + nx * side * (halfW + wallT / 2) + ox * 0.6;
        const cz = pz + nz * side * (halfW + wallT / 2) + oz * 0.6;
        box(cx, y0 - 0.4, cz, wingD, portalH + 2.6, wallT, ROAD_COLORS.pavement, curbs);
      }
      // 门楣（压顶）
      box(px + ox * 0.6, y0 + portalH, pz + oz * 0.6, wingD, 1.5, portalW * 2, ROAD_COLORS.pavement, curbs);
      // 洞口的黑（从洞门往里 1.2m 放一片黑，读作"洞")
      const vx = px + ix * 1.2;
      const vz = pz + iz * 1.2;
      const vy = y0 + 0.05;
      surfaces.quad(
        [vx + nx * halfW, vy, vz + nz * halfW],
        [vx + nx * halfW, vy + portalH, vz + nz * halfW],
        [vx - nx * halfW, vy + portalH, vz - nz * halfW],
        [vx - nx * halfW, vy, vz - nz * halfW],
        VOID_COLOR,
      );
      // 洞身：地面 + 两侧墙 + 顶（只画 BORE_LEN 米，往前越来越黑）
      const segs = Math.max(2, Math.ceil(boreLen / STEP));
      const borePts = [];
      for (let i = 0; i <= segs; i += 1) {
        const d = (i / segs) * boreLen;
        const sag = Math.max(0, 1 - i / segs) * 0.0; // 占位：洞身不随地形起伏
        borePts.push({ x: px + ix * d, z: pz + iz * d, y: y0 + sag });
      }
      for (let i = 0; i < borePts.length - 1; i += 1) {
        const p0 = borePts[i];
        const p1 = borePts[i + 1];
        const L0 = [p0.x + nx * halfW, p0.y, p0.z + nz * halfW];
        const R0 = [p0.x - nx * halfW, p0.y, p0.z - nz * halfW];
        const L1 = [p1.x + nx * halfW, p1.y, p1.z + nz * halfW];
        const R1 = [p1.x - nx * halfW, p1.y, p1.z - nz * halfW];
        surfaces.quad(L0, L1, R1, R0, BORE_COLOR);                      // 地面
        const CL0 = [L0[0], L0[1] + portalH, L0[2]];
        const CL1 = [L1[0], L1[1] + portalH, L1[2]];
        const CR0 = [R0[0], R0[1] + portalH, R0[2]];
        const CR1 = [R1[0], R1[1] + portalH, R1[2]];
        curbs.quad(CL0, CL1, L1, L0, BORE_COLOR);                        // 左墙
        curbs.quad(R0, R1, CR1, CR0, BORE_COLOR);                        // 右墙
        curbs.quad(CL1, CL0, CR0, CR1, BORE_COLOR);                      // 顶
      }
      // 洞口照明：门楣下一条黄色灯带（隧道口的常见做法；发光感靠亮色顶点色）
      marks.quad(
        [px + ix * 1.0 + nx * (halfW - 0.4), y0 + portalH - 0.35, pz + iz * 1.0 + nz * (halfW - 0.4)],
        [px + ix * 1.0 + nx * (halfW - 0.4), y0 + portalH - 0.05, pz + iz * 1.0 + nz * (halfW - 0.4)],
        [px + ix * 1.0 - nx * (halfW - 0.4), y0 + portalH - 0.05, pz + iz * 1.0 - nz * (halfW - 0.4)],
        [px + ix * 1.0 - nx * (halfW - 0.4), y0 + portalH - 0.35, pz + iz * 1.0 - nz * (halfW - 0.4)],
        ROAD_COLORS.lineYellow,
      );
      // 洞口标志（道具包 Sign_Triangle 当"隧道注意"警告牌）
      if (opts.signs !== false) {
        props.push({ key: 'sign_stop', x: px + nx * -(halfW + 2.4), y: y0, z: pz + nz * -(halfW + 2.4), rotY: Math.atan2(ox, oz) });
      }
      portalStats.portals += 1;
      portalStats.bores += 1;
    }
  }
  stats.portals = portalStats.portals;

  // ── 高速/国道的护栏
  // 道具包「道路」没有独立护栏构件，`Street_Bridge` 自带的那条边梁（高 1.0m）就是参照，
  // 这里按同样的高度沿路两侧生成：立柱每 4m 一根 + 上下两根横梁。
  let railStats = 0;
  for (const e of net.edges) {
    if (e.tunnel || e.bridge || !e.vehicle || !(e.lanes > 0)) continue;
    if (!['motorway', 'trunk'].includes(e.class)) continue;
    const spec = (net.classes && net.classes[e.class]) || {};
    if ((spec.sidewalk || 0) > 0.5) continue;   // 城市段有人行道，不摆护栏
    const halfW = (e.width || spec.width || 15) / 2;
    const { pts } = resamplePath(e.p, e.y, STEP);
    if (pts.length < 2) continue;
    frames(pts);
    for (const side of [1, -1]) {
      const off = halfW + 0.45;
      // 横梁：上下两根
      for (const [hy, thick] of [[0.75, 0.18], [0.42, 0.12]]) {
        for (let i = 0; i < pts.length - 1; i += 1) {
          const p0 = pts[i];
          const p1 = pts[i + 1];
          const a = [p0.x + p0.nx * side * off, p0.y + hy, p0.z + p0.nz * side * off];
          const b = [p1.x + p1.nx * side * off, p1.y + hy, p1.z + p1.nz * side * off];
          const c = [b[0], b[1] + thick, b[2]];
          const d = [a[0], a[1] + thick, a[2]];
          if (side > 0) curbs.quad(a, b, c, d, ROAD_COLORS.barrier);
          else curbs.quad(d, c, b, a, ROAD_COLORS.barrier);
        }
      }
      // 立柱：每 ~4m
      const postStep = Math.max(1, Math.round(4 / STEP));
      for (let i = 0; i < pts.length; i += postStep) {
        const p = pts[i];
        const cx = p.x + p.nx * side * off;
        const cz = p.z + p.nz * side * off;
        const s = 0.09;
        const c1 = [cx - s, p.y + 0.95, cz - s], c2 = [cx + s, p.y + 0.95, cz - s];
        const c3 = [cx + s, p.y + 0.95, cz + s], c4 = [cx - s, p.y + 0.95, cz + s];
        const b1 = [cx - s, p.y - 0.1, cz - s], b2 = [cx + s, p.y - 0.1, cz - s];
        const b3 = [cx + s, p.y - 0.1, cz + s], b4 = [cx - s, p.y - 0.1, cz + s];
        curbs.quad(b1, b2, c2, c1, ROAD_COLORS.pier);
        curbs.quad(b2, b3, c3, c2, ROAD_COLORS.pier);
        curbs.quad(b3, b4, c4, c3, ROAD_COLORS.pier);
        curbs.quad(b4, b1, c1, c4, ROAD_COLORS.pier);
        railStats += 1;
      }
    }
  }
  stats.railPosts = railStats;

  // ── 合并成 mesh（每种材质 1 次 draw call） ──
  // 水平面用 FrontSide（省一半填充），竖直面（路缘/裙边/桥墩/护栏）用 DoubleSide，
  // 免得个别面的绕序不对时从侧面看穿。
  const matFlat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const matVert = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  const addBucket = (bucket, name, material, receive = true) => {
    if (bucket.empty) return null;
    const mesh = new THREE.Mesh(bucket.toGeometry(THREE), material);
    mesh.name = name;
    mesh.receiveShadow = receive;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    return mesh;
  };
  addBucket(surfaces, 'roads:surface', matFlat);
  addBucket(curbs, 'roads:curb', matVert);
  addBucket(marks, 'roads:markings', matFlat);
  addBucket(skirts, 'roads:skirt', matVert);

  stats.triangles = Math.round((surfaces.pos.length + curbs.pos.length + marks.pos.length + skirts.pos.length) / 9);
  stats.props = props.length;
  group.userData = { stats };

  return { group, props, stats, connectors };
}

export default { loadRoadNet, buildRoadNet, RoadNet, ROAD_COLORS };

