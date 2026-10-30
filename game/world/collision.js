// 碰撞世界：全部用**纯数字**实现，不依赖 three.js。
// 理由：移动、命中、视线遮挡都是每帧高频路径，纯数学版本既快又能在 Node 里直接单测。
//
// 世界模型：地面是 y=0 的平面（低多边形城镇），所有障碍是**轴对齐盒**（AABB）。
//   · 水平移动：半径 r 的圆 vs AABB 脚印，按轴分离求解 → 自然产生"贴墙滑动"，不会卡死；
//   · 射线：3D 线段 vs 3D AABB（带 slab 法），可正确表达"隔墙打不中""矮墙可以打过头顶"；
//   · 宽相：8m 的空间哈希，避免每帧遍历全部障碍。

const EPS = 1e-4;
const CELL = 8;

// 数值 key：|坐标| < 4000 时唯一（世界 340m / 8m 格子只有 ±43，远在安全范围内）
const KEY_STRIDE = 8192;
function keyOf(cx, cz) { return cx * KEY_STRIDE + cz; }

export class ColliderWorld {
  constructor(opts = {}) {
    this.boxes = [];
    this.grid = new Map();
    this.cell = opts.cell || CELL;
    this.bounds = opts.bounds || { minX: -170, maxX: 170, minZ: -170, maxZ: 170 };
    this.groundY = 0;
    this.version = 0;
  }

  /** @param {{minX:number,minZ:number,maxX:number,maxZ:number,minY?:number,maxY?:number,tag?:string,id?:string,ref?:any,blocksNav?:boolean}} box */
  add(box) {
    const b = {
      minX: Math.min(box.minX, box.maxX),
      maxX: Math.max(box.minX, box.maxX),
      minZ: Math.min(box.minZ, box.maxZ),
      maxZ: Math.max(box.minZ, box.maxZ),
      minY: Number.isFinite(box.minY) ? box.minY : 0,
      maxY: Number.isFinite(box.maxY) ? box.maxY : 3,
      tag: box.tag || 'wall',
      id: box.id || null,
      ref: box.ref || null,
      blocksNav: box.blocksNav !== false,
      _index: this.boxes.length,
    };
    // 修正 minZ/maxZ 已在上面的对象字面量里显式计算，这里无需再改
    this.boxes.push(b);
    this._insert(b);
    this.version += 1;
    return b;
  }

  _cells(b) {
    const c = this.cell;
    const x0 = Math.floor(b.minX / c);
    const x1 = Math.floor(b.maxX / c);
    const z0 = Math.floor(b.minZ / c);
    const z1 = Math.floor(b.maxZ / c);
    return { x0, x1, z0, z1 };
  }

  _insert(b) {
    const { x0, x1, z0, z1 } = this._cells(b);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cz = z0; cz <= z1; cz += 1) {
        const k = keyOf(cx, cz);
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(b);
      }
    }
  }

  /** 半径 r 的圆在 (x,z) 附近可能碰到的盒子（去重）。 */
  query(x, z, r) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c);
    const x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c);
    const z1 = Math.floor((z + r) / c);
    const out = [];
    const seen = new Set();
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cz = z0; cz <= z1; cz += 1) {
        const arr = this.grid.get(keyOf(cx, cz));
        if (!arr) continue;
        for (const b of arr) {
          if (seen.has(b._index)) continue;
          seen.add(b._index);
          out.push(b);
        }
      }
    }
    return out;
  }

  /** 圆是否与盒子相交（XZ 平面）。 */
  static circleHitsBox(x, z, r, b) {
    const cx = x < b.minX ? b.minX : (x > b.maxX ? b.maxX : x);
    const cz = z < b.minZ ? b.minZ : (z > b.maxZ ? b.maxZ : z);
    const dx = x - cx;
    const dz = z - cz;
    return dx * dx + dz * dz < r * r;
  }

  /** 竖直圆柱体在高度 y..y+h 之间是否被挡住（用于"矮墙可以跨过去"和子弹高度判断）。 */
  blockedAt(x, z, r, y = 0, h = 1.7) {
    const near = this.query(x, z, r + 0.001);
    for (const b of near) {
      if (b.maxY <= y + 0.02) continue;      // 完全在脚下（可跨越/已越过）
      if (b.minY >= y + h) continue;          // 完全在头顶之上
      if (ColliderWorld.circleHitsBox(x, z, r, b)) return b;
    }
    return null;
  }

  /**
   * 运动求解：先 X 后 Z 分轴推进，撞到就贴面停下。结果是"沿墙滑动"而不是卡住。
   * 大位移会被拆成不超过 0.9r 的小步 —— 否则一帧走 5m 时会直接跨过 0.28m 厚的墙（穿模）。
   * @returns {{x:number,z:number,hitX:boolean,hitZ:boolean,hit:object|null}}
   */
  move(x, z, r, dx, dz, y = 0, h = 1.7) {
    const maxStep = Math.max(0.06, r * 0.9);
    const dist = Math.max(Math.abs(dx), Math.abs(dz));
    const steps = Math.max(1, Math.min(24, Math.ceil(dist / maxStep)));
    let cx = x;
    let cz = z;
    let hitX = false;
    let hitZ = false;
    let hit = null;

    for (let i = 0; i < steps; i += 1) {
      const res = this._moveOnce(cx, cz, r, dx / steps, dz / steps, y, h);
      cx = res.x; cz = res.z;
      if (res.hitX) hitX = true;
      if (res.hitZ) hitZ = true;
      if (res.hit) hit = hit || res.hit;
    }

    // 世界边界（防止掉出地图）
    const B = this.bounds;
    const pad = r + 0.5;
    if (cx < B.minX + pad) { cx = B.minX + pad; hitX = true; }
    if (cx > B.maxX - pad) { cx = B.maxX - pad; hitX = true; }
    if (cz < B.minZ + pad) { cz = B.minZ + pad; hitZ = true; }
    if (cz > B.maxZ - pad) { cz = B.maxZ - pad; hitZ = true; }

    return { x: cx, z: cz, hitX, hitZ, hit };
  }

  _moveOnce(x, z, r, dx, dz, y = 0, h = 1.7) {
    let nx = x;
    let nz = z;
    let hitX = false;
    let hitZ = false;
    let hit = null;

    if (dx) {
      nx = x + dx;
      const near = this.query(nx, z, r + Math.abs(dx) + 0.01);
      for (let pass = 0; pass < 2; pass += 1) {
        for (const b of near) {
          if (b.maxY <= y + 0.02) continue;
          if (b.minY >= y + h) continue;
          if (!ColliderWorld.circleHitsBox(nx, z, r, b)) continue;
          hitX = true;
          hit = hit || b;
          nx = dx > 0 ? Math.min(nx, b.minX - r - EPS) : Math.max(nx, b.maxX + r + EPS);
        }
      }
    }
    if (dz) {
      nz = z + dz;
      const near = this.query(nx, nz, r + Math.abs(dz) + 0.01);
      for (let pass = 0; pass < 2; pass += 1) {
        for (const b of near) {
          if (b.maxY <= y + 0.02) continue;
          if (b.minY >= y + h) continue;
          if (!ColliderWorld.circleHitsBox(nx, nz, r, b)) continue;
          hitZ = true;
          hit = hit || b;
          nz = dz > 0 ? Math.min(nz, b.minZ - r - EPS) : Math.max(nz, b.maxZ + r + EPS);
        }
      }
    }
    return { x: nx, z: nz, hitX, hitZ, hit };
  }

  /**
   * 3D 射线求交（最近命中）。
   * @param {number} ox,oy,oz 起点
   * @param {number} dx,dy,dz 方向（不必归一，内部会归一）
   * @param {number} maxDist 最大距离
   * @param {string[]|null} skipTags 忽略的 tag
   * @returns {{distance:number,x:number,y:number,z:number,nx:number,ny:number,nz:number,tag:string,id:string,ref:any}|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 200, skipTags = null) {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return null;
    const ix = dx / len, iy = dy / len, iz = dz / len;
    const invX = 1 / (ix || 1e-12);
    const invY = 1 / (iy || 1e-12);
    const invZ = 1 / (iz || 1e-12);

    let best = null;
    let bestT = maxDist;

    for (const b of this.boxes) {
      if (skipTags && skipTags.indexOf(b.tag) >= 0) continue;
      // slab 法
      let tmin = 0;
      let tmax = bestT;
      let nx = 0, ny = 0, nzAxis = 0;

      // X
      let t1 = (b.minX - ox) * invX;
      let t2 = (b.maxX - ox) * invX;
      let sign = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sign = 1; }
      if (t1 > tmin) { tmin = t1; nx = sign; ny = 0; nzAxis = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;

      // Y
      t1 = (b.minY - oy) * invY;
      t2 = (b.maxY - oy) * invY;
      sign = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sign = 1; }
      if (t1 > tmin) { tmin = t1; nx = 0; ny = sign; nzAxis = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;

      // Z
      t1 = (b.minZ - oz) * invZ;
      t2 = (b.maxZ - oz) * invZ;
      sign = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sign = 1; }
      if (t1 > tmin) { tmin = t1; nx = 0; ny = 0; nzAxis = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;

      if (tmin < 0 || tmin >= bestT) continue;
      bestT = tmin;
      best = {
        distance: tmin,
        x: ox + ix * tmin,
        y: oy + iy * tmin,
        z: oz + iz * tmin,
        nx, ny, nz: nzAxis,
        tag: b.tag,
        id: b.id,
        ref: b.ref,
      };
    }
    return best;
  }

  /** 视线检测：两点之间是否有遮挡（默认忽略地面/装饰）。 */
  lineOfSight(ax, ay, az, bx, by, bz, skipTags = ['ground', 'deco']) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    const hit = this.raycast(ax, ay, az, dx, dy, dz, dist - 0.05, skipTags);
    return !hit;
  }

  /** 给导航网格用：世界坐标点是否被挡。 */
  static pointBlocked(boxes, x, z, pad = 0) {
    for (const b of boxes) {
      if (!b.blocksNav) continue;
      if (x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad) return true;
    }
    return false;
  }

  dispose() {
    this.boxes.length = 0;
    this.grid.clear();
  }
}

export default { ColliderWorld };
