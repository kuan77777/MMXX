// 真实地形：把 bake-terrain 烘焙出来的高程 / 土地覆盖 / 河网变成可玩的地形。
//
// 数据来源（详见 docs/TERRAIN.md）：
//   · 高程   Copernicus DEM GLO-30（30m）
//   · 覆盖   ESA WorldCover 10m 2021 v200
//   · 河网   HydroRIVERS v1.0
//
// 设计要点：
//   · 世界 y=0 = 城镇地面（bake 时把镇子范围垫平到基准海拔），玩家出生在 y≈0，
//     真实海拔只用来显示（meta.elevation.base），避免 700+ 的绝对高程进物理；
//   · 高度查询 heightAt() 是纯数学、无 three.js 依赖，Node 里可以直接测；
//   · 网格是**索引化**的：flatShading 靠片元着色器的导数算法线，不需要展成非索引几何，
//     300×300 的图只有 9 万个顶点 / 18 万三角面，1 次 draw call；
//   · 顶点色 = 土地覆盖类别色，顶点之间自然插值，所以 10m 覆盖图不会出现锯齿马赛克。
/** 小尺寸确定性随机（地形撒树/顶点抖色都用它，保证同 seed 同一张图）。 */
export function mulberry32(a) {
  let t = a >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** ESA WorldCover 类别 → 低多边形配色（取值偏灰、压低饱和，跟现有 PALETTE 风格一致）。 */
export const LANDCOVER_COLORS = {
  10: 0x3f5f3a, // 树本覆盖
  20: 0x556a3d, // 灌木
  30: 0x5e7a46, // 草地
  40: 0x7d7f4b, // 耕地
  50: 0x6f6d66, // 建成区
  60: 0x8a7f69, // 裸地 / 稀疏植被
  70: 0xdde7ee, // 冰雪
  80: 0x35566b, // 永久水体
  90: 0x4f7a68, // 湿地
  95: 0x35513f, // 红树林
  100: 0x6a7257, // 苔藓地衣
  12: 0x777168, // 裸岩（bake 时按坡度/海拔修正出来的扩展码）
};

export const LANDCOVER_LABELS = {
  10: '林地', 20: '灌木', 30: '草地', 40: '耕地', 50: '建成区', 60: '裸地',
  70: '冰雪', 80: '水体', 90: '湿地', 95: '红树林', 100: '苔原', 12: '裸岩',
};

/** 会撒树的类别（WorldCover 的木质植被 + 湿地边缘）。 */
const FOREST_CLASSES = new Set([10, 20]);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Terrain {
  /**
   * @param {object} data {meta, heights:Int16Array, landcover:Uint8Array, rivers:Array}
   */
  constructor(data) {
    this.meta = data.meta;
    this.rivers = data.rivers || [];
    this.cols = this.meta.grid.cols;
    this.rows = this.meta.grid.rows;
    this.cell = this.meta.grid.cellSize;
    this.size = this.meta.grid.size;
    this.half = this.size / 2;
    this.bounds = { minX: -this.half, maxX: this.half, minZ: -this.half, maxZ: this.half };
    this.baseElevation = this.meta.elevation.base;

    // 分米 → 米，直接存 Float32，查询时省一次乘法
    const n = this.cols * this.rows;
    this.height = new Float32Array(n);
    for (let i = 0; i < n; i += 1) this.height[i] = data.heights[i] / 10;
    this.cover = data.landcover;

    // 节点高度（(cols+1)×(rows+1)）：把格心高度平均到四个角，地形面更顺
    this.nodes = new Float32Array((this.cols + 1) * (this.rows + 1));
    for (let r = 0; r <= this.rows; r += 1) {
      for (let c = 0; c <= this.cols; c += 1) {
        let sum = 0, cnt = 0;
        for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || cc >= this.cols || rr < 0 || rr >= this.rows) continue;
          sum += this.height[rr * this.cols + cc];
          cnt += 1;
        }
        this.nodes[r * (this.cols + 1) + c] = cnt ? sum / cnt : 0;
      }
    }
  }

  /** 世界坐标 → 格心索引（不裁剪）。 */
  _cellIndex(x, z) {
    const c = Math.floor((x + this.half) / this.cell);
    const r = Math.floor((z + this.half) / this.cell);
    return { c: Math.min(this.cols - 1, Math.max(0, c)), r: Math.min(this.rows - 1, Math.max(0, r)) };
  }

  /** 格心高度（米，相对城镇地面）。 */
  cellHeight(c, r) { return this.height[r * this.cols + c]; }

  /** 任意点的地表高度（米，相对城镇地面）：先在节点网格上双线性插值。 */
  heightAt(x, z) {
    const fx = (x + this.half) / this.cell;
    const fz = (z + this.half) / this.cell;
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fz);
    const tx = fx - c0;
    const tz = fz - r0;
    const nc = this.cols + 1;
    const at = (c, r) => {
      const cc = c < 0 ? 0 : c > this.cols ? this.cols : c;
      const rr = r < 0 ? 0 : r > this.rows ? this.rows : r;
      return this.nodes[rr * nc + cc];
    };
    const h00 = at(c0, r0), h10 = at(c0 + 1, r0);
    const h01 = at(c0, r0 + 1), h11 = at(c0 + 1, r0 + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** 该点所在格的 ESA WorldCover 类别码。 */
  coverAt(x, z) {
    const { c, r } = this._cellIndex(x, z);
    return this.cover[r * this.cols + c];
  }

  /** 坡度（无量纲，= 高差/水平距离）。 */
  slopeAt(x, z) {
    const d = this.cell;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return Math.hypot(hx, hz) / (2 * d);
  }

  /** 真实海拔（米），给 UI / 调试用。 */
  elevationAt(x, z) { return this.baseElevation + this.heightAt(x, z); }

  /** 是否在水里（离河道中线足够近）。用于出生点校验和"别把树插进河里"。 */
  waterAt(x, z) {
    for (const r of this.rivers) {
      const halfW = r.w / 2;
      const p = r.p;
      for (let i = 0; i < p.length - 2; i += 2) {
        const x0 = p[i], z0 = p[i + 1], x1 = p[i + 2], z1 = p[i + 3];
        const dx = x1 - x0, dz = z1 - z0;
        const len2 = dx * dx + dz * dz || 1e-9;
        let t = ((x - x0) * dx + (z - z0) * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = x0 + dx * t, pz = z0 + dz * t;
        if ((x - px) ** 2 + (z - pz) ** 2 < halfW * halfW) return true;
      }
    }
    return false;
  }

  /** 统计：给 loading/HUD 显示"这是一张什么地图"。 */
  summary() {
    const counts = {};
    for (let i = 0; i < this.cover.length; i += 1) {
      const c = this.cover[i];
      counts[c] = (counts[c] || 0) + 1;
    }
    const total = this.cover.length;
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([c, n]) => ({ cls: Number(c), label: LANDCOVER_LABELS[c] || String(c), pct: Math.round((n / total) * 100) }));
    return {
      size: this.size,
      cell: this.cell,
      grid: [this.cols, this.rows],
      baseElevation: this.baseElevation,
      minElevation: this.meta.elevation.min,
      maxElevation: this.meta.elevation.max,
      rivers: this.rivers.length,
      top,
    };
  }

  // ── three.js ────────────────────────────────────────────────────────────
  /**
   * 建地形网格。顶点色来自土地覆盖 + 海拔/坡度微调。
   * @param {object} THREE three 命名空间
   * @param {{name?:string}} [opts]
   */
  buildMesh(THREE, opts = {}) {
    const cols = this.cols;
    const rows = this.rows;
    const nc = cols + 1;
    const nr = rows + 1;
    const half = this.half;
    const cell = this.cell;
    const nv = nc * nr;

    const positions = new Float32Array(nv * 3);
    const colors = new Float32Array(nv * 3);
    const uvs = new Float32Array(nv * 2);
    const color = new THREE.Color();
    const rng = mulberry32(0x51a7f00d);
    // 视觉上把地形整体压低 10cm：道路(y=0.02)/室内地板(y=0.03)/路缘石 都铺在镇内，
    // 与地形共面会 z-fighting（build.js 里那条"地面把道路自我遮挡成黑带"的老问题）。
    // 物理用的 still heightAt()，玩家脚底比看到的草皮高 10cm —— 肉眼不可见。
    const SINK = 0.1;

    for (let r = 0; r < nr; r += 1) {
      for (let c = 0; c < nc; c += 1) {
        const i = r * nc + c;
        const y = this.nodes[i];
        positions[i * 3] = -half + c * cell;
        positions[i * 3 + 1] = y - SINK;
        positions[i * 3 + 2] = -half + r * cell;
        uvs[i * 2] = c / cols;
        uvs[i * 2 + 1] = r / rows;

        // 取四邻覆盖里出现最多的类别，避免顶点正好落在边界上时抖色
        const votes = new Map();
        for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
          const cc = c + dc, rr = r + dr;
          if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
          const cls = this.cover[rr * cols + cc];
          votes.set(cls, (votes.get(cls) || 0) + 1);
        }
        let bestCls = 30, bestN = -1;
        for (const [cls, n] of votes) if (n > bestN) { bestN = n; bestCls = cls; }
        if (!this.nodeClass) this.nodeClass = new Uint8Array(nv);
        this.nodeClass[i] = bestCls;
        const hex = LANDCOVER_COLORS[bestCls] || 0x6b6b6b;
        color.setHex(hex);
        // 极轻的随机明暗 + 高处稍微提亮（空气透视的廉价版本），让大片同色不生硬
        const jitter = 0.93 + rng() * 0.14;
        const lift = 1 + clamp01(y / 900) * 0.1;
        if (!this.nodeTint) this.nodeTint = new Float32Array(nv);
        this.nodeTint[i] = jitter * lift;
        colors[i * 3] = color.r * jitter * lift;
        colors[i * 3 + 1] = color.g * jitter * lift;
        colors[i * 3 + 2] = color.b * jitter * lift;
      }
    }

    const indices = new Uint32Array(cols * rows * 6);
    let k = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const v00 = r * nc + c;
        const v10 = v00 + 1;
        const v01 = v00 + nc;
        const v11 = v01 + 1;
        indices[k++] = v00; indices[k++] = v01; indices[k++] = v11;
        indices[k++] = v00; indices[k++] = v11; indices[k++] = v10;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = opts.name || 'ground';
    mesh.userData.terrain = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /** 建水面：沿河段铺四边形带，高度取烘焙好的水面高程（下游单调下降）。 */
  buildWater(THREE) {
    const group = new THREE.Group();
    group.name = 'water';
    const positions = [];
    const colors = [];
    const color = new THREE.Color();
    let quads = 0;

    for (const r of this.rivers) {
      const p = r.p;
      const wy = r.wy;
      const n = p.length / 2;
      if (n < 2) continue;
      const halfW = r.w / 2;
      for (let i = 0; i < n - 1; i += 1) {
        const x0 = p[i * 2], z0 = p[i * 2 + 1];
        const x1 = p[i * 2 + 2], z1 = p[i * 2 + 3];
        const y0 = wy[i] + 0.06;
        const y1 = wy[i + 1] + 0.06;
        const dx = x1 - x0, dz = z1 - z0;
        const len = Math.hypot(dx, dz) || 1e-6;
        // 左法线（右手系：(dx,dz) 的垂直向量取 (-dz, dx)）
        const nx = (-dz / len) * halfW;
        const nz = (dx / len) * halfW;
        // 两个三角
        positions.push(
          x0 - nx, y0, z0 - nz, x0 + nx, y0, z0 + nz, x1 + nx, y1, z1 + nz,
          x0 - nx, y0, z0 - nz, x1 + nx, y1, z1 + nz, x1 - nx, y1, z1 - nz,
        );
        color.setHex(r.d >= 1.6 ? 0x2b5d80 : 0x35708f);
        for (let v = 0; v < 6; v += 1) colors.push(color.r, color.g, color.b);
        quads += 1;
      }
    }
    if (quads) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({
        vertexColors: true, flatShading: true, transparent: true, opacity: 0.88,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'waterSurface';
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      group.add(mesh);
    }
    group.userData = { quads, rivers: this.rivers.length };
    return group;
  }

  /** 河道栏栅数据：给 HUD/调试用（"图幅内有 N 条河"）。 */
  riverInfo() {
    return this.rivers.map((r, i) => ({
      index: i, width: r.w, depth: r.d, order: r.o, discharge: r.q, points: r.p.length / 2,
    }));
  }

  /**
   * 换季重刷地形顶点色：冬季往雪色混、秋季往枯草色混，春/夏基本不变。
   * 地形顶点色是绝对色，所以不能像平地那样只改材质 color —— 必须重写颜色属性。
   * 9 万个顶点、一次几毫秒，换季才跑一次，不值得为它做增量。
   * @param {object} THREE
   * @param {object} mesh buildMesh() 出来的 mesh
   * @param {string} season
   */
  recolor(THREE, mesh, season) {
    if (!this.nodeClass || !this.nodeTint) return 0;
    const attr = mesh.geometry.getAttribute('color');
    if (!attr) return 0;
    const base = new THREE.Color();
    const snow = new THREE.Color(0xe4ecf1);
    const dry = new THREE.Color(0x8d7a48);
    const blend = { spring: 0, summer: 0, autumn: 0.1, winter: 0.62 }[season] || 0;
    const tint = season === 'winter' ? snow : dry;
    for (let i = 0; i < this.nodeClass.length; i += 1) {
      const cls = this.nodeClass[i];
      base.setHex(LANDCOVER_COLORS[cls] || 0x6b6b6b);
      // 水体/冰雪/裸岩不参与换季混色（水不会变白，雪本来也白）
      if (cls !== 80 && cls !== 70 && cls !== 12) base.lerp(tint, blend);
      const j = this.nodeTint[i];
      attr.setXYZ(i, base.r * j, base.g * j, base.b * j);
    }
    attr.needsUpdate = true;
    return this.nodeClass.length;
  }

  dispose() { this.height = null; this.nodes = null; this.cover = null; this.nodeClass = null; this.nodeTint = null; }
}

/**
 * 载入烘焙数据。
 * @param {string} baseUrl 例如 'data/terrain/dujiangyan'
 * @param {{fetchImpl?:Function}} [opts]
 */
export async function loadTerrain(baseUrl, opts = {}) {
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('没有可用的 fetch');
  const url = (name) => `${baseUrl.replace(/\/$/, '')}/${name}`;
  const getJson = async (name) => {
    const res = await f(url(name));
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return res.json();
  };
  const getBin = async (name) => {
    const res = await f(url(name));
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return res.arrayBuffer();
  };
  const [meta, heightsBuf, coverBuf, rivers] = await Promise.all([
    getJson('meta.json'), getBin('heights.bin'), getBin('landcover.bin'), getJson('rivers.json'),
  ]);
  const heights = new Int16Array(heightsBuf);
  const cover = new Uint8Array(coverBuf);
  const expect = meta.grid.cols * meta.grid.rows;
  if (heights.length !== expect || cover.length !== expect) {
    throw new Error(`地形数据尺寸不符：期望 ${expect}，实得 h=${heights.length} c=${cover.length}`);
  }
  return new Terrain({ meta, heights, landcover: cover, rivers });
}

/**
 * 地形网格的季节/天气调制色。
 * 地形用的是**绝对**顶点色（草地绿、雪白、水蓝分得很清），所以环境色不能直接盖上去，
 * 只能用"相对比值"当乘数：把环境地面色 / 该季节标准草地色，钳到 [0.45, 1.55]。
 */
export function terrainTint(envGroundHex, seasonGroundHex) {
  const ch = (hex, sh) => ((hex >> sh) & 0xff) / 255;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const sh = 16 - i * 8;
    const e = ch(envGroundHex, sh);
    const s = Math.max(0.02, ch(seasonGroundHex, sh));
    out[i] = Math.min(1.55, Math.max(0.45, e / s));
  }
  return out;
}

/**
 * 按土地覆盖撒树（林地/灌木），供 buildTreeInstances 复用。
 * @param {Terrain} terrain
 * @param {{count?:number, models?:string[], species?:string[], rng?:Function,
 *          excludeTownHalf?:number, minElevation?:number, maxSlope?:number}} [opts]
 */
export function forestTrees(terrain, opts = {}) {
  const count = opts.count || 0;
  if (!count) return [];
  const rng = opts.rng || mulberry32(0x7ea5eed);
  const exclude = opts.excludeTownHalf || 200;
  const maxSlope = opts.maxSlope == null ? 0.55 : opts.maxSlope;
  const pickModel = opts.pickModel || null;
  const pickTree = opts.pickTree || null; // 一次给出 {model, species, dead}（trees.js 的 pickTreeModel 就是这形状）
  const models = opts.models || [];
  const species = opts.species || [];
  const out = [];
  let tries = 0;
  const maxTries = count * 60;
  while (out.length < count && tries < maxTries) {
    tries += 1;
    const x = (rng() * 2 - 1) * (terrain.half - 8);
    const z = (rng() * 2 - 1) * (terrain.half - 8);
    if (Math.abs(x) < exclude && Math.abs(z) < exclude) continue; // 镇子里已经有自己的树
    if (!FOREST_CLASSES.has(terrain.coverAt(x, z))) continue;
    if (terrain.slopeAt(x, z) > maxSlope) continue;
    if (terrain.waterAt(x, z)) continue;
    // 别把树种在路面上（真实路网是后加的，卫星数据里的"林地"格可能正好压在道路上）
    if (opts.reject && opts.reject(x, z)) continue;
    const picked = pickTree ? pickTree(rng) : null;
    const k = picked ? 0 : Math.floor(rng() * Math.max(1, models.length)) % Math.max(1, models.length);
    const model = picked ? picked.model : (pickModel ? pickModel(rng) : (models[k] || null));
    out.push({
      x,
      z,
      // 地势高度再压 12cm：地形网格整体下沉了 0.1（见 buildMesh 的 SINK），
      // 树根稍微埋进地里，坡地上才不会看到树干悬空
      y: terrain.heightAt(x, z) - 0.12,
      model,
      species: picked ? picked.species : (opts.speciesOf ? opts.speciesOf(model) : (species[k] || 'common')),
      // 中国树种 id（地区混交才有）：渲染时用它决定"常绿树秋天不换橙叶"
      cn: picked ? (picked.cn || null) : null,
      scale: 0.85 + rng() * 0.3,
      rotY: rng() * Math.PI * 2,
      dead: picked ? !!picked.dead : rng() < 0.08,
      wild: true,
    });
  }
  return out;
}

export default { Terrain, loadTerrain, terrainTint, forestTrees, LANDCOVER_COLORS, LANDCOVER_LABELS };
