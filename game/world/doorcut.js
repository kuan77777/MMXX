// 门洞切割：把建筑模型上"门所在的那块"整整齐齐地切掉。
//
// 为什么需要切割：道具包的房子是**封闭外壳**，门只是画在墙上的贴图（实测门洞处墙面完全平，
// 没有真实开口）。游戏要能走进去，就必须在墙上开洞。
//
// 做法：用门洞的 6 个平面对每个三角面做**平面切分**（逐面切，切完的碎片各自记住"
// 已经落在哪几个平面的内侧"），最后丢掉落在全部 6 个平面内侧的碎片。
// 因为切分是沿平面精确进行的，洞口的四条边正好落在平面上 —— 不会出现三角面锯齿。
//
// 本文件是纯函数（不依赖 three.js），所以能在 Node 里直接单测（tests/logic.test.mjs）。

const EPS = 1e-7;

/** 门洞盒：世界坐标的轴对齐盒（建筑都绕 Y 转 90° 的整数倍，所以盒子一定轴对齐）。 */
export function doorBox(rect, door, depth = 1.6) {
  const halfW = Math.max(0.2, door.width) / 2;
  const h = Math.max(0.5, door.height || 2.2);
  const half = Math.max(0.4, depth) / 2;
  if (door.side === 'north' || door.side === 'south') {
    const z = door.side === 'north' ? rect.z0 : rect.z1;
    return {
      x0: door.center - halfW, x1: door.center + halfW,
      y0: -0.5, y1: h,
      z0: z - half, z1: z + half,
    };
  }
  const x = door.side === 'west' ? rect.x0 : rect.x1;
  return {
    x0: x - half, x1: x + half,
    y0: -0.5, y1: h,
    z0: door.center - halfW, z1: door.center + halfW,
  };
}

function triBboxHitsBox(pos, o, b) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < 9; i += 3) {
    const x = pos[o + i], y = pos[o + i + 1], z = pos[o + i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return maxX > b.x0 && minX < b.x1 && maxY > b.y0 && minY < b.y1 && maxZ > b.z0 && minZ < b.z1;
}

const PLANES = [
  (p, b) => p[0] - b.x0,   // 内侧 = x >= x0
  (p, b) => b.x1 - p[0],   // 内侧 = x <= x1
  (p, b) => p[1] - b.y0,
  (p, b) => b.y1 - p[1],
  (p, b) => p[2] - b.z0,
  (p, b) => b.z1 - p[2],
];

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * 切掉落在 box 内部的三角面碎片。
 * @param {ArrayLike<number>} positions 每 9 个数一个三角面（x,y,z × 3）
 * @param {ArrayLike<number>} colors    每 9 个数一个三角面（r,g,b × 3，同一面同色）
 * @param {{x0,x1,y0,y1,z0,z1}} box
 * @returns {{positions: Float32Array, colors: Float32Array, inputTriangles: number, outputTriangles: number, removed: number}}
 */
export function cutBox(positions, colors, box) {
  const triCount = Math.floor(positions.length / 9);
  const outPos = [];
  const outCol = [];
  let removed = 0;

  for (let t = 0; t < triCount; t += 1) {
    const o = t * 9;
    const p = [
      [positions[o], positions[o + 1], positions[o + 2]],
      [positions[o + 3], positions[o + 4], positions[o + 5]],
      [positions[o + 6], positions[o + 7], positions[o + 8]],
    ];
    const cr = colors[o], cg = colors[o + 1], cb = colors[o + 2];
    // 远离门洞的面直接原样保留（绝大多数）
    if (!triBboxHitsBox(positions, o, box)) {
      outPos.push(p[0][0], p[0][1], p[0][2], p[1][0], p[1][1], p[1][2], p[2][0], p[2][1], p[2][2]);
      outCol.push(cr, cg, cb, cr, cg, cb, cr, cg, cb);
      continue;
    }

    let frags = [{ poly: p, mask: 0 }];
    for (let k = 0; k < 6; k += 1) {
      const signed = PLANES[k];
      const next = [];
      for (const f of frags) {
        const poly = f.poly;
        const d = poly.map((v) => signed(v, box));
        let anyIn = false;
        let anyOut = false;
        for (const x of d) {
          if (x >= -EPS) anyIn = true;
          if (x < -EPS) anyOut = true;
        }
        if (!anyOut) { next.push({ poly, mask: f.mask | (1 << k) }); continue; }
        if (!anyIn) { next.push({ poly, mask: f.mask }); continue; }
        const inPoly = [];
        const outPoly = [];
        for (let i = 0; i < poly.length; i += 1) {
          const j = (i + 1) % poly.length;
          const di = d[i];
          const dj = d[j];
          if (di >= -EPS) inPoly.push(poly[i]);
          else outPoly.push(poly[i]);
          if ((di > EPS && dj < -EPS) || (di < -EPS && dj > EPS)) {
            const tt = di / (di - dj);
            const q = lerp3(poly[i], poly[j], tt);
            inPoly.push(q);
            outPoly.push(q);
          }
        }
        if (inPoly.length >= 3) next.push({ poly: inPoly, mask: f.mask | (1 << k) });
        if (outPoly.length >= 3) next.push({ poly: outPoly, mask: f.mask });
      }
      frags = next;
      if (!frags.length) break;
    }

    let kept = false;
    for (const f of frags) {
      if (f.mask === 63) continue;   // 6 个平面全部在内侧 = 挖掉
      const poly = f.poly;
      for (let i = 1; i + 1 < poly.length; i += 1) {
        const a = poly[0], b2 = poly[i], c2 = poly[i + 1];
        // 丢掉退化的碎片（切在顶点上会产生零面积三角形）
        const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2];
        const vx = c2[0] - a[0], vy = c2[1] - a[1], vz = c2[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * nx + ny * ny + nz * nz < 1e-12) continue;
        outPos.push(a[0], a[1], a[2], b2[0], b2[1], b2[2], c2[0], c2[1], c2[2]);
        outCol.push(cr, cg, cb, cr, cg, cb, cr, cg, cb);
        kept = true;
      }
    }
    if (!kept) removed += 1;
  }

  return {
    positions: new Float32Array(outPos),
    colors: new Float32Array(outCol),
    inputTriangles: triCount,
    outputTriangles: Math.floor(outPos.length / 9),
    removed,
  };
}

export default { cutBox, doorBox };
