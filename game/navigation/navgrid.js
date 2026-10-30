// 导航网格（无依赖、可在浏览器 / Node 直接运行）。
// 提供：格子坐标换算、动态可走性、8 连通 A*（octile 启发 + 二叉堆 + 闭集）、
// 视线检测、路径光顺，以及一个轻量的路径跟随器。
// 本文件不引用 three.js、不触碰 window / document。

const SQRT2 = Math.SQRT2;

// 8 邻接方向：前 4 个正交，后 4 个对角；斜走代价 √2
const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

// octile 距离：正交 1、对角 √2，与 8 邻接的步进代价一致，可采纳且一致
function octile(ax, az, bx, bz) {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx;
}

// 二叉最小堆：扁平类型数组，零分配；同一格多次入堆由闭集惰性跳过
class MinHeap {
  constructor(capacity = 64) {
    this._nodes = new Int32Array(capacity);
    this._costs = new Float64Array(capacity);
    this.size = 0;
  }

  clear() {
    this.size = 0;
  }

  _grow() {
    const cap = this._nodes.length * 2;
    const nodes = new Int32Array(cap);
    nodes.set(this._nodes);
    const costs = new Float64Array(cap);
    costs.set(this._costs);
    this._nodes = nodes;
    this._costs = costs;
  }

  push(node, cost) {
    if (this.size >= this._nodes.length) this._grow();
    const nodes = this._nodes;
    const costs = this._costs;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (costs[p] <= cost) break;
      nodes[i] = nodes[p];
      costs[i] = costs[p];
      i = p;
    }
    nodes[i] = node;
    costs[i] = cost;
  }

  // 返回最小值节点（格子索引）；空堆返回 -1
  pop() {
    if (this.size === 0) return -1;
    const nodes = this._nodes;
    const costs = this._costs;
    const top = nodes[0];
    const last = --this.size;
    if (last > 0) {
      const node = nodes[last];
      const cost = costs[last];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= last) break;
        if (c + 1 < last && costs[c + 1] < costs[c]) c++;
        if (costs[c] >= cost) break;
        nodes[i] = nodes[c];
        costs[i] = costs[c];
        i = c;
      }
      nodes[i] = node;
      costs[i] = cost;
    }
    return top;
  }
}

/**
 * 2D 导航网格：origin 是格子 (0,0) 的世界坐标“角点”，格子中心在
 * origin + (i + 0.5) * cellSize。worldToCell 用 floor，越界坐标原样返回。
 */
export class NavGrid {
  /**
   * @param {object} opts
   * @param {{x:number,z:number}} opts.origin  (0,0) 格子的世界坐标角点
   * @param {number} [opts.cellSize=1]         格子边长（世界单位）
   * @param {number} opts.width                +X 方向格数
   * @param {number} opts.height               +Z 方向格数
   * @param {(ix:number,iz:number)=>boolean} [opts.isBlocked]  初始化时逐格询问是否阻挡
   */
  constructor(opts = {}) {
    const { origin, cellSize = 1, width, height, isBlocked } = opts;
    const ox = origin && Number.isFinite(origin.x) ? origin.x : 0;
    const oz = origin && Number.isFinite(origin.z) ? origin.z : 0;
    const cs = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 1;
    const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;

    this.origin = { x: ox, z: oz };
    this.cellSize = cs;
    this.width = w;
    this.height = h;

    // 1 = 可走，0 = 阻挡
    const n = w * h;
    this._walk = new Uint8Array(n);
    let blocked = 0;
    for (let iz = 0; iz < h; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const walk = typeof isBlocked === 'function' && isBlocked(ix, iz) ? 0 : 1;
        this._walk[iz * w + ix] = walk;
        if (!walk) blocked++;
      }
    }
    this._blocked = blocked;

    // A* 复用的扁平数组（g / cameFrom / closed / 堆），按网格尺寸惰性创建
    this._scratch = null;
  }

  /** 世界坐标 -> 格子索引（可能越界，不做钳制） */
  worldToCell(x, z) {
    const cs = this.cellSize;
    return {
      ix: Math.floor((x - this.origin.x) / cs),
      iz: Math.floor((z - this.origin.z) / cs),
    };
  }

  /** 格子索引 -> 该格中心的世界坐标 */
  cellToWorld(ix, iz) {
    const cs = this.cellSize;
    return {
      x: this.origin.x + (ix + 0.5) * cs,
      z: this.origin.z + (iz + 0.5) * cs,
    };
  }

  /** 是否在本网格范围内 */
  inBounds(ix, iz) {
    return ix >= 0 && ix < this.width && iz >= 0 && iz < this.height;
  }

  /** 设置格子可走性；返回状态是否真的发生了变化（越界 / 非整数 -> false） */
  setWalkable(ix, iz, walk) {
    if (!Number.isInteger(ix) || !Number.isInteger(iz)) return false;
    if (!this.inBounds(ix, iz)) return false;
    const v = walk ? 1 : 0;
    const k = iz * this.width + ix;
    if (this._walk[k] === v) return false;
    this._walk[k] = v;
    this._blocked += v ? -1 : 1;
    return true;
  }

  /** 格子是否可走（越界返回 false） */
  isWalkableCell(ix, iz) {
    if (ix < 0 || ix >= this.width || iz < 0 || iz >= this.height) return false;
    return this._walk[iz * this.width + ix] === 1;
  }

  /** 世界坐标是否落在可走格内 */
  isWalkableWorld(x, z) {
    const c = this.worldToCell(x, z);
    return this.isWalkableCell(c.ix, c.iz);
  }

  /**
   * 阻挡世界空间 AABB；包含两个角点所在格子（含 max 边界所在的格子）。
   * @returns {number} 实际改变的格子数
   */
  blockRect(minX, minZ, maxX, maxZ) {
    return this._rect(minX, minZ, maxX, maxZ, false);
  }

  /** 清除世界空间 AABB 内的阻挡（语义同 blockRect） */
  clearRect(minX, minZ, maxX, maxZ) {
    return this._rect(minX, minZ, maxX, maxZ, true);
  }

  _rect(minX, minZ, maxX, maxZ, walk) {
    if (!Number.isFinite(minX) || !Number.isFinite(minZ) ||
        !Number.isFinite(maxX) || !Number.isFinite(maxZ)) return 0;
    const cs = this.cellSize;
    const loX = Math.min(minX, maxX);
    const hiX = Math.max(minX, maxX);
    const loZ = Math.min(minZ, maxZ);
    const hiZ = Math.max(minZ, maxZ);
    let ix0 = Math.floor((loX - this.origin.x) / cs);
    let ix1 = Math.floor((hiX - this.origin.x) / cs);
    let iz0 = Math.floor((loZ - this.origin.z) / cs);
    let iz1 = Math.floor((hiZ - this.origin.z) / cs);
    if (ix1 < 0 || iz1 < 0 || ix0 >= this.width || iz0 >= this.height) return 0;
    if (ix0 < 0) ix0 = 0;
    if (iz0 < 0) iz0 = 0;
    if (ix1 >= this.width) ix1 = this.width - 1;
    if (iz1 >= this.height) iz1 = this.height - 1;
    let changed = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (this.setWalkable(ix, iz, walk)) changed++;
      }
    }
    return changed;
  }

  /**
   * 找离 (x,z) 最近的可走点。
   * 查询点本身可走时原样返回（不吸附到格心），否则按环向外扩，返回最近格心。
   * @param {number} [maxRadius=12] 最大搜索半径（单位：格）
   * @returns {{x:number,z:number}|null}
   */
  nearestWalkable(x, z, maxRadius = 12) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const c = this.worldToCell(x, z);
    if (this.isWalkableCell(c.ix, c.iz)) return { x, z };

    const maxR = Number.isFinite(maxRadius) ? Math.max(0, Math.floor(maxRadius)) : 12;
    for (let r = 1; r <= maxR; r++) {
      let best = null;
      let bestD = Infinity;
      for (let iz = c.iz - r; iz <= c.iz + r; iz++) {
        for (let ix = c.ix - r; ix <= c.ix + r; ix++) {
          // 只扫当前环的边
          if (Math.abs(ix - c.ix) !== r && Math.abs(iz - c.iz) !== r) continue;
          if (!this.isWalkableCell(ix, iz)) continue;
          const w = this.cellToWorld(ix, iz);
          const d = (w.x - x) * (w.x - x) + (w.z - z) * (w.z - z);
          if (d < bestD) {
            bestD = d;
            best = w;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * 直线可行走测试（格子级视线）。沿线段做 DDA 遍历每个经过的格子；
   * 正好穿过格角时要求两侧正交格都可走（不允许切角）。
   */
  lineWalkable(ax, az, bx, bz) {
    if (!Number.isFinite(ax) || !Number.isFinite(az) ||
        !Number.isFinite(bx) || !Number.isFinite(bz)) return false;
    const cs = this.cellSize;
    const ox = this.origin.x;
    const oz = this.origin.z;
    let ix = Math.floor((ax - ox) / cs);
    let iz = Math.floor((az - oz) / cs);
    const ex = Math.floor((bx - ox) / cs);
    const ez = Math.floor((bz - oz) / cs);
    if (!this.isWalkableCell(ix, iz) || !this.isWalkableCell(ex, ez)) return false;
    if (ix === ex && iz === ez) return true;

    const dx = bx - ax;
    const dz = bz - az;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? cs / Math.abs(dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? cs / Math.abs(dz) : Infinity;
    let tMaxX = stepX !== 0
      ? (ox + (ix + (stepX > 0 ? 1 : 0)) * cs - ax) / dx
      : Infinity;
    let tMaxZ = stepZ !== 0
      ? (oz + (iz + (stepZ > 0 ? 1 : 0)) * cs - az) / dz
      : Infinity;

    // 步数上界：两轴格差之和即可覆盖，多给 8 步防止浮点误差
    const guard = Math.abs(ex - ix) + Math.abs(ez - iz) + 8;
    for (let n = 0; n < guard; n++) {
      if (ix === ex && iz === ez) return true;
      if (tMaxX < tMaxZ) {
        ix += stepX;
        tMaxX += tDeltaX;
        if (!this.isWalkableCell(ix, iz)) return false;
      } else if (tMaxZ < tMaxX) {
        iz += stepZ;
        tMaxZ += tDeltaZ;
        if (!this.isWalkableCell(ix, iz)) return false;
      } else {
        // 正穿格角：两侧正交格都必须可走，否则视为切角
        if (!this.isWalkableCell(ix + stepX, iz) || !this.isWalkableCell(ix, iz + stepZ)) return false;
        ix += stepX;
        iz += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
        if (!this.isWalkableCell(ix, iz)) return false;
      }
    }
    return ix === ex && iz === ez;
  }

  /**
   * 8 连通 A* 寻路，返回世界坐标航点数组（不含起点格，最后一点为目标）。
   * @param {{x:number,z:number}} from
   * @param {{x:number,z:number}} to
   * opts.maxNodes 默认 20000；opts.allowPartial 为 true 时，预算耗尽或证明不可达
   * 都会返回“走到离目标最近处”的部分路径（末点为格子中心，不保证等于 to）。
   * @param {{maxNodes?:number, smooth?:boolean, allowPartial?:boolean}} [opts]
   * @returns {Array<{x:number,z:number}>|null} 已在目标格 -> []；不可达 -> null
   */
  findPath(from, to, opts = {}) {
    if (!from || !to) return null;
    if (!Number.isFinite(from.x) || !Number.isFinite(from.z) ||
        !Number.isFinite(to.x) || !Number.isFinite(to.z)) return null;

    const o = opts || {};
    const smooth = o.smooth !== false;
    const allowPartial = o.allowPartial === true;
    const maxNodes = Number.isFinite(o.maxNodes) ? Math.max(0, Math.floor(o.maxNodes)) : 20000;

    const sc = this.worldToCell(from.x, from.z);
    const gc = this.worldToCell(to.x, to.z);
    let sx = sc.ix, sz = sc.iz;
    let gx = gc.ix, gz = gc.iz;
    let goalExact = true;

    // 起点 / 终点落在阻挡格时退到最近可走格，避免直接判死
    if (!this.isWalkableCell(sx, sz)) {
      const p = this.nearestWalkable(from.x, from.z);
      if (!p) return null;
      const c = this.worldToCell(p.x, p.z);
      sx = c.ix;
      sz = c.iz;
    }
    if (!this.isWalkableCell(gx, gz)) {
      const p = this.nearestWalkable(to.x, to.z);
      if (!p) return null;
      const c = this.worldToCell(p.x, p.z);
      gx = c.ix;
      gz = c.iz;
      goalExact = false;
    }

    const width = this.width;
    const height = this.height;
    const startIdx = sz * width + sx;
    const goalIdx = gz * width + gx;
    if (startIdx === goalIdx) return [];

    const n = width * height;
    const sc2 = this._scratch && this._scratch.n === n ? this._scratch : this._makeScratch(n);
    this._scratch = sc2;
    const g = sc2.g;
    const came = sc2.from;
    const closed = sc2.closed;
    const heap = sc2.heap;
    g.fill(Infinity);
    came.fill(-1);
    closed.fill(0);
    heap.clear();

    const walk = this._walk;
    g[startIdx] = 0;
    let bestH = octile(sx, sz, gx, gz);
    let bestIdx = -1;
    let reached = -1;
    let expanded = 0;
    heap.push(startIdx, bestH);

    while (heap.size > 0) {
      if (expanded >= maxNodes) break;
      const cur = heap.pop();
      if (closed[cur]) continue;      // 惰性删除：重复入堆的旧条目
      closed[cur] = 1;
      if (cur === goalIdx) {
        reached = cur;
        break;
      }
      expanded++;
      const cx = cur % width;
      const cz = (cur - cx) / width;
      const gCur = g[cur];
      for (let d = 0; d < 8; d++) {
        const nb = NEIGHBORS[d];
        const nx = cx + nb[0];
        const nz = cz + nb[1];
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
        const nIdx = nz * width + nx;
        if (walk[nIdx] === 0 || closed[nIdx]) continue;
        // 对角步：两侧正交格都必须可走（禁止切角）
        if (d >= 4 && (walk[cz * width + nx] === 0 || walk[nz * width + cx] === 0)) continue;
        const ng = gCur + nb[2];
        if (ng < g[nIdx]) {
          g[nIdx] = ng;
          came[nIdx] = cur;
          const hh = octile(nx, nz, gx, gz);
          if (hh < bestH) {
            bestH = hh;
            bestIdx = nIdx;
          }
          heap.push(nIdx, ng + hh);
        }
      }
    }

    let endIdx = reached;
    let exact = goalExact;
    if (endIdx < 0) {
      // 预算耗尽：allowPartial 时退到“离目标最近”的已生成格
      if (!allowPartial || bestIdx < 0) return null;
      endIdx = bestIdx;
      exact = false;
    }

    // 回溯：闭集里的节点串成格子链，再转成世界点（跳过起点格）
    const cells = [];
    let cur = endIdx;
    let guard = 0;
    while (cur >= 0 && guard++ <= n) {
      cells.push(cur);
      if (cur === startIdx) break;
      cur = came[cur];
    }
    cells.reverse();

    const pts = [];
    for (let k = 1; k < cells.length; k++) {
      const c = cells[k];
      const ix = c % width;
      const iz = (c - ix) / width;
      if (k === cells.length - 1 && exact) pts.push({ x: to.x, z: to.z });
      else pts.push(this.cellToWorld(ix, iz));
    }
    if (pts.length === 0) return null;

    return smooth ? this._stringPull(from.x, from.z, pts) : pts;
  }

  // 视线光顺（string pulling）：从当前锚点尽量连到最远的可见航点
  _stringPull(ax, az, pts) {
    const out = [];
    const last = pts.length - 1;
    let i = 0;
    while (i <= last) {
      let pick = -1;
      for (let j = last; j > i; j--) {
        if (this.lineWalkable(ax, az, pts[j].x, pts[j].z)) {
          pick = j;
          break;
        }
      }
      // 一个都看不见时至少走下一个点，保证前进且不死循环
      if (pick < 0) pick = i;
      const p = pts[pick];
      out.push(p);
      ax = p.x;
      az = p.z;
      i = pick + 1;
    }
    return out;
  }

  _makeScratch(n) {
    return {
      n,
      g: new Float32Array(n),
      from: new Int32Array(n),
      closed: new Uint8Array(n),
      heap: new MinHeap(Math.max(64, Math.min(n, 1 << 15))),
    };
  }

  /** 网格统计（只读快照） */
  get stats() {
    return {
      width: this.width,
      height: this.height,
      cellSize: this.cellSize,
      blocked: this._blocked,
    };
  }
}

/**
 * 路径跟随器：每帧把“朝下一个航点的单位方向”作为转向请求交给外部移动逻辑。
 * 航点在 arriveRadius 内即切换；走完最后一个航点后 done 常驻 true。
 * 卡住（有路径但位置长时间几乎不动）只上报一次 failed，并置 needsRepath，
 * 由 AI 自己重新调用 nav.findPath。
 */
export class PathFollower {
  /**
   * @param {object} opts
   * @param {NavGrid} [opts.nav]              仅用于周期性视线校验（可省略）
   * @param {number} [opts.arriveRadius=0.6]
   * @param {number} [opts.repathInterval=0.5] 视线校验间隔（秒）
   * @param {number} [opts.stuckTime=1.6]      判定卡住所需的“几乎不动”时长（秒）
   */
  constructor(opts = {}) {
    const { nav, arriveRadius = 0.6, repathInterval = 0.5, stuckTime = 1.6 } = opts;
    this.nav = nav || null;
    this.arriveRadius = Number.isFinite(arriveRadius) ? Math.max(0, arriveRadius) : 0.6;
    this.repathInterval = Number.isFinite(repathInterval) ? Math.max(0.01, repathInterval) : 0.5;
    this.stuckTime = Number.isFinite(stuckTime) ? Math.max(0, stuckTime) : 1.6;

    this._path = [];
    this._idx = 0;
    this._done = false;
    this._failed = false;
    this._failReported = false;
    this._needsRepath = false;

    this._still = 0;         // 原地不动累计时长
    this._lastX = 0;
    this._lastZ = 0;
    this._hasLast = false;
    this._losTimer = 0;      // 视线校验计时
    // “几乎不动”的位移阈值：与到达半径挂钩，避免单位量级假设
    this._moveEps = Math.max(1e-3, this.arriveRadius * 0.05);
  }

  /** 设置新路径（世界坐标航点数组）；会清空失败 / 卡住状态 */
  setPath(path) {
    this._path = Array.isArray(path) ? path.slice() : [];
    this._idx = 0;
    this._done = false;
    this._failed = false;
    this._failReported = false;
    this._needsRepath = false;
    this._still = 0;
    this._hasLast = false;
    this._losTimer = 0;
  }

  /** 清空路径与全部状态 */
  clear() {
    this._path = [];
    this._idx = 0;
    this._done = false;
    this._failed = false;
    this._failReported = false;
    this._needsRepath = false;
    this._still = 0;
    this._hasLast = false;
    this._losTimer = 0;
  }

  /** 还有未走完的航点（完成后即为 false） */
  get hasPath() {
    return !this._failed && this._path.length > 0 && this._idx < this._path.length;
  }

  /** 当前正在逼近的航点；走完后返回最后一个航点，空路径返回 null */
  get goal() {
    if (this._path.length === 0) return null;
    const i = this._idx < this._path.length ? this._idx : this._path.length - 1;
    return this._path[i];
  }

  /** 需要重新寻路（卡住 / 失败 / 航点被新障碍挡住） */
  get needsRepath() {
    return this._needsRepath;
  }

  /**
   * 推进一帧。
   * @param {number} dt 秒
   * @param {{x:number,z:number}} position 当前世界坐标
   * @returns {{done:boolean, failed:boolean, dir:{x:number,z:number}, moved:boolean}}
   *   dir 为单位方向；moved 表示本帧是否产出了有效位移请求。
   */
  update(dt, position) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const p = position || {};
    const x = p.x;
    const z = p.z;
    const zero = { done: false, failed: false, dir: { x: 0, z: 0 }, moved: false };

    if (!this.hasPath) {
      // 失败只上报一次，之后靠 needsRepath 让 AI 重算
      if (this._failed && !this._failReported) {
        this._failReported = true;
        zero.failed = true;
      }
      zero.done = this._done && !this._failed;
      return zero;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) return zero;

    // 到达判定：可以一帧内跨过多个航点
    let wp = this._path[this._idx];
    let d = Math.hypot(wp.x - x, wp.z - z);
    let advanced = false;
    while (d <= this.arriveRadius) {
      this._idx++;
      advanced = true;
      if (this._idx >= this._path.length) {
        this._done = true;
        this._still = 0;
        zero.done = true;
        return zero;
      }
      wp = this._path[this._idx];
      d = Math.hypot(wp.x - x, wp.z - z);
    }
    if (advanced) {
      this._still = 0;
      this._losTimer = 0;
    }

    // 卡住检测：有路径但位置几乎不动，累计够时长后一次性失败
    if (this._hasLast) {
      const moved = Math.hypot(x - this._lastX, z - this._lastZ);
      if (moved < this._moveEps) this._still += step;
      else this._still = 0;
    }
    this._hasLast = true;
    this._lastX = x;
    this._lastZ = z;
    if (this.stuckTime > 0 && this._still >= this.stuckTime) {
      this._failed = true;
      this._failReported = true;
      this._needsRepath = true;
      zero.failed = true;
      return zero;
    }

    // 周期性检查：当前航点的直线是否被新增障碍挡住
    if (this.nav && typeof this.nav.lineWalkable === 'function') {
      this._losTimer += step;
      if (this._losTimer >= this.repathInterval) {
        this._losTimer = 0;
        if (!this.nav.lineWalkable(x, z, wp.x, wp.z)) this._needsRepath = true;
      }
    }

    // 退化保护：不产生 NaN / 零长方向
    if (!(d > 1e-9)) return zero;
    const inv = 1 / d;
    zero.dir.x = (wp.x - x) * inv;
    zero.dir.z = (wp.z - z) * inv;
    zero.moved = true;
    return zero;
  }
}
