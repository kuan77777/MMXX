// FW3D · 自由观赛（spectate）的「可行走世界」
//
// 为什么单独一个文件：
//   3D 层此前的第一人称一直只有「x/z 各夹一下」的矩形边界（arena.js 的 updateMovement），
//   脚下永远是 y=0 —— 因为玩家只会在草皮上跑。自由观赛要能坐在替补席、穿过技术区、
//   绕场去对面替补席、走上看看台，就必须回答三个问题：
//     ① 这块地多高（草皮 / 走道 / 替补席平台 / 看台台阶）
//     ② 哪里是墙（广告板 / 看台层间环廊墙 / 球门 / 替补席框架 / 通道侧墙）
//     ③ 哪里不许进（球场草皮）
//   看台几何完全由 rows / rowDepth / rowRise / baseInset 四个量推导（见 stadium-kinds.js），
//   所以以上三问都能解析求出，不需要网格、不需要射线 —— 也因此能在 Node 里直接回归。
//
// 约定（务必保持）：
//   · 不 import THREE、不碰场景状态，只回答「这个坐标能不能站、站多高」；
//   · 坐标系与 arena 一致：x 横（球场宽 W）、z 纵（球场长 L）、y 向上，草皮面 y=0；
//   · 唯一的几何真源是 stadiumDerived() 的返回值（arena 与 test_roam 都传它进来）。

/** 与第一人称控制器共用的身体参数（arena 只读，不另建一套） */
export const ROAM = {
  stepMax: 1.32,     // 能直接跨上去的最大高差（看台每级 1.25 → 可上；层间环廊墙 1.05 由墙处理）
  radius: 0.34,      // 玩家身体半径（碰撞用）
  eyeSit: 1.18,      // 坐姿眼高（相对脚下地面）
  eyeStand: 1.68,    // 站姿眼高（与 arena 的 P.eye 一致）
  apronY: 0.02,      // 草皮外的走道/技术区地面高度（2 cm 薄台，避免与草皮共面闪烁）
  walk: 3.4,         // 观赛时的步行速度上限（m/s，比球员慢，但不至于像散步）
};

/** 替补席的固定尺寸（dugout.js 与 roam.js 必须用同一份） */
export const DUG = {
  len: 8.4,          // 沿边线方向的长度（z）
  depth: 2.2,        // 进深（x）
  backGap: 0.55,     // 背墙与看台前沿之间留的空隙
  platform: 0.16,    // 混凝土台座高度（比走道高一级台阶）
  benchInset: 0.42,  // 长凳中线到背墙的距离
  benchDepth: 0.58,  // 长凳进深（也是碰撞盒进深）
  canopy: 2.55,      // 顶棚高度
};

/** 替补席在某个球场的实际落位（侧别 side=-1 西 / +1 东；z 为中心线）
 *  · 无跑道球场：在广告板外的外环里（背靠看台前沿，前面留 2 m 走道）
 *  · 带跑道球场：**直接摆在跑道上**、贴着边线（用户口径：跑道后面有空间就放广告牌，
 *    没空间就直接是观众席）。跑道本身 8 m 宽，2.2 m 进深放得下，且不会挡视线。
 */
export function dugoutLayout(W, baseInset, side, z, opts) {
  const track = !!(opts && opts.track);
  const back = track
    ? (W / 2 + 1.2 + DUG.depth)                       // 跑道内侧：前沿离边线 1.2 m
    : (W / 2 + baseInset - DUG.backGap);              // 外环：背靠看台前沿
  const front = back - DUG.depth;                     // 靠球场一侧
  const x0 = Math.min(side * front, side * back);
  const x1 = Math.max(side * front, side * back);
  const benchX = side * (back - DUG.benchInset);         // 长凳中线
  const benchIn = side * (back - DUG.benchInset - DUG.benchDepth);   // 长凳靠球场的那条边
  return {
    side, z, track,
    x0, x1, front: side * front, back: side * back,
    z0: z - DUG.len / 2, z1: z + DUG.len / 2,
    benchX, benchIn,
    benchX0: Math.min(benchX, benchIn), benchX1: Math.max(benchX, benchIn),
    seatX: benchX,
    // 座位朝向：坐在西侧看球场要朝 +x ⇒ yaw = -π/2（arena 的 forward = (-sin yaw, -cos yaw)）
    yaw: side < 0 ? -Math.PI / 2 : Math.PI / 2,
    // 站起来时站在长凳前 0.55 m，避免刚起身就被长凳碰撞盒顶住
    standX: side * (back - DUG.benchInset - DUG.benchDepth - 0.55),
    platform: DUG.platform,
    // 广告板要在这里断开：
    //   无跑道 → 就断在替补席正前方（技术区大门，人从这里进出内圈）
    //   有跑道 → 替补席本身在内圈里，挡不住板前的通路，所以把豁口开在替补席南侧 9 m
    //            （否则人坐在凳子上会把唯一的口子堵死，走不到外环和看台）
    gap: track
      ? [z - DUG.len / 2 - 9.2, z - DUG.len / 2 - 1.2]
      : [z - DUG.len / 2 - 0.6, z + DUG.len / 2 + 0.6],
  };
}

/** 广告板豁口（{'-1':[[z0,z1]...], '1':[...]}），stadium-kinds 据此切板、roam 据此放墙 */
export function boardGapsFor(W, baseInset, dugouts, tunnelHalf, track) {
  const out = { '-1': [], '1': [] };
  if (tunnelHalf) out['-1'].push([-tunnelHalf, tunnelHalf]);
  for (const d of dugouts || []) {
    const L = dugoutLayout(W, baseInset, d.side, d.z, { track });
    out[String(d.side)].push(L.gap);
  }
  return out;
}

/** 从 [a,b] 段里挖掉若干 [c,d] 区间（区间可以是乱的，内部会排序合并） */
export function subtractSpans(spans, holes) {
  let segs = (spans || []).slice();
  const hs = (holes || []).slice().sort((a, b) => a[0] - b[0]);
  for (const h of hs) {
    const next = [];
    for (const s of segs) {
      const a = s[0], b = s[1];
      if (h[1] <= a || h[0] >= b) { next.push(s); continue; }
      if (h[0] > a) next.push([a, Math.min(b, h[0])]);
      if (h[1] < b) next.push([Math.max(a, h[1]), b]);
    }
    segs = next;
  }
  return segs.filter((s) => s[1] - s[0] > 0.12);
}

/**
 * 建造「可行走世界」。
 * @param {object} spec 必填：w/l/baseInset/boardOff/tiers/rows/rowDepth/rowRise
 *                      选填：tunnel {x0,x1,half}、dugouts [{side,z}]、gaps（不传则按 dugouts 推）
 * @returns {{ground,resolve,walls,dugouts,seats,path,info,stepMax,radius}}
 */
export function buildRoam(spec) {
  const o = Object.assign({
    w: 68, l: 105, boardOff: 3.2, baseInset: 8, track: false,
    tiers: 1, rows: 8, rowDepth: 1.65, rowRise: 1.25,
    tunnel: null, dugouts: [], gaps: null,
  }, spec || {});
  const W = o.w, L = o.l, hw = W / 2, hl = L / 2;
  const tierGap = o.rows * o.rowDepth;
  const tierH = o.rows * o.rowRise;
  const stepMax = ROAM.stepMax, radius = ROAM.radius;

  const dugouts = (o.dugouts || []).map((d) => dugoutLayout(W, o.baseInset, d.side, d.z, { track: o.track }));
  const gaps = o.gaps || boardGapsFor(W, o.baseInset, o.dugouts, o.tunnel ? o.tunnel.half : 0, o.track);

  // ── 墙：AABB（x0,x1,z0,z1）+ 种类。都是「永远挡住」，不做跨上判定 —— 我们没有跳跃。
  const walls = [];
  const wall = (x0, z0, x1, z1, kind) => walls.push({
    x0: Math.min(x0, x1), x1: Math.max(x0, x1),
    z0: Math.min(z0, z1), z1: Math.max(z0, z1), kind,
  });

  // ① 广告板：外侧边（-x / +x）逐段；板厚 0.24，高 1.1（跨不上去，算墙）
  const boardX = hw + o.boardOff, boardZ = hl + o.boardOff;
  for (const side of [-1, 1]) {
    const segs = subtractSpans([[-boardZ, boardZ]], gaps[String(side)]);
    for (const [a, b] of segs) wall(side * boardX - 0.12, a, side * boardX + 0.12, b, 'board');
  }
  // ② 球门后广告板（两个底线方向，整段；球门框另外单独挡）
  for (const side of [-1, 1]) {
    wall(-boardX, side * boardZ - 0.12, boardX, side * boardZ + 0.12, 'board');
  }

  // ③ 看台层间环廊墙：每层外沿一道 2.4 m 厚的矮墙（stadium-kinds 的 walkBoxes），1.7 m 高
  for (let t = 0; t < o.tiers; t++) {
    const e = o.baseInset + (t + 1) * tierGap;   // 该层外沿
    for (const side of [-1, 1]) {
      wall(side * (hw + e - 1.2), -(hl + e), side * (hw + e + 1.2), hl + e, 'ring');
      wall(-(hw + e), side * (hl + e - 1.2), hw + e, side * (hl + e + 1.2), 'ring');
    }
  }

  // ④ 球门框（门柱/横梁所在的 0.24 m 薄片）：站到底线外也不许从门框里穿过去。
  //    只挡门框本身 —— 网在这个项目里是一张平面，不占进深，所以人可以从门后绕过去。
  for (const side of [-1, 1]) {
    wall(-3.9, side * (hl - 0.12), 3.9, side * (hl + 0.12), 'goal');
  }

  // ⑤ 替补席：背墙 + 两侧挡板 + 长凳（长凳当墙，人就站在凳前，不会站进凳子里）
  for (const d of dugouts) {
    wall(d.back - d.side * 0.14, d.z0, d.back + d.side * 0.02, d.z1, 'dugout');      // 背墙
    wall(d.x0, d.z0, d.x1, d.z0 + 0.14, 'dugout');                                    // 侧挡板
    wall(d.x0, d.z1 - 0.14, d.x1, d.z1, 'dugout');
    wall(d.benchX0, d.z0 + 0.3, d.benchX1, d.z1 - 0.3, 'bench');                       // 长凳
  }

  // ⑥ 通道侧墙（走进去也不会穿墙）
  if (o.tunnel) {
    const tn = o.tunnel;
    for (const side of [-1, 1]) {
      wall(tn.x0, side * tn.half, tn.x1, side * (tn.half + 0.24), 'tunnel');
    }
  }

  // ── 地面：返回 {y, kind} 或 null（世界之外 → 不可站）
  function standTop(ax, az) {
    let best = null;
    for (let t = 0; t < o.tiers; t++) {
      const baseY = t * tierH;
      const inset0 = o.baseInset + t * tierGap;
      for (let r = 0; r < o.rows; r++) {
        const inset = inset0 + r * o.rowDepth;
        const top = baseY + (r + 1) * o.rowRise;
        const onSide = ax >= hw + inset && ax <= hw + inset + o.rowDepth && az <= hl + inset;
        const onEnd = az >= hl + inset && az <= hl + inset + o.rowDepth && ax <= hw + inset;
        if ((onSide || onEnd) && (!best || top > best.y)) best = { y: top, kind: 'stand', tier: t, row: r };
      }
    }
    return best;
  }

  function ground(x, z) {
    const ax = Math.abs(x), az = Math.abs(z);
    // 替补席台座（先判，因为它压在走道上面）
    for (const d of dugouts) {
      if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return { y: d.platform, kind: 'dugout' };
    }
    // 球员通道（沿 x 的走廊，地面 0）
    if (o.tunnel) {
      const tn = o.tunnel;
      if (x >= tn.x0 && x <= tn.x1 && az <= tn.half) return { y: 0, kind: 'tunnel' };
    }
    // 草皮：不许站
    if (ax < hw && az < hl) return { y: 0, kind: 'pitch' };
    // 看台台阶
    const st = standTop(ax, az);
    if (st) return st;
    // 草皮外到看台前沿：走道 / 技术区 / 外环
    if (ax <= hw + o.baseInset + 0.01 && az <= hl + o.baseInset + 0.01) {
      return { y: ROAM.apronY, kind: (ax > boardX || az > boardZ) ? 'concourse' : 'apron' };
    }
    return null;
  }

  function overlaps(x, z, b) {
    return x + radius > b.x0 && x - radius < b.x1 && z + radius > b.z0 && z - radius < b.z1;
  }
  function pushOut(x, z, b, px, pz) {
    // 先按「上一帧在哪一侧」决定往哪边推：薄板/长凳/环廊墙这些盒子，如果只按"穿透最小的轴"推，
    // 人会被推到盒子的另一侧去（走进长凳里、或者翻到环廊墙外面），也就是穿模。方向优先，穿透兜底。
    if (px <= b.x0 + 1e-6) return { x: b.x0 - radius, z };
    if (px >= b.x1 - 1e-6) return { x: b.x1 + radius, z };
    if (pz <= b.z0 + 1e-6) return { x, z: b.z0 - radius };
    if (pz >= b.z1 - 1e-6) return { x, z: b.z1 + radius };
    // 兜底：真的从盒子内部出发（例如传送进来）时，沿穿透最小的那条轴推出去
    const px1 = b.x1 + radius - x, px0 = x - (b.x0 - radius);
    const pz1 = b.z1 + radius - z, pz0 = z - (b.z0 - radius);
    const m = Math.min(px1, px0, pz1, pz0);
    if (m === px1) return { x: b.x1 + radius, z };
    if (m === px0) return { x: b.x0 - radius, z };
    if (m === pz1) return { x, z: b.z1 + radius };
    return { x, z: b.z0 - radius };
  }

  /** 试走一步：先推墙、再挡草皮、最后判高度差。返回是否可站与该点地面高度 */
  function attempt(x, z, px, pz, prevY) {
    let hit = null;
    for (let it = 0; it < 2; it++) {
      for (const b of walls) {
        if (!overlaps(x, z, b)) continue;
        const p = pushOut(x, z, b, px, pz);
        x = p.x; z = p.z;
        if (!hit) hit = b.kind;
      }
    }
    // 草皮禁区：贴线推回，留出身体半径
    if (Math.abs(x) < hw + radius && Math.abs(z) < hl + radius) {
      const dx = (hw + radius) - Math.abs(x);
      const dz = (hl + radius) - Math.abs(z);
      if (dx <= dz) x = (x < 0 ? -1 : 1) * (hw + radius);
      else z = (z < 0 ? -1 : 1) * (hl + radius);
      hit = hit || 'pitch';
    }
    const g = ground(x, z);
    if (!g) return { ok: false, x, z, y: prevY, hit: hit || 'edge' };
    if (g.y - prevY > stepMax) return { ok: false, x, z, y: prevY, hit: hit || 'step' };
    return { ok: true, x, z, y: g.y, kind: g.kind, hit };
  }

  /**
   * 把「想去的点」解算成「能站的点」。
   * @param {number} x 目标 x
   * @param {number} z 目标 z
   * @param {number} px 上一帧 x（用于墙面滑动的退让）
   * @param {number} pz 上一帧 z
   * @param {number} py 上一帧脚下高度
   */
  function resolve(x, z, px, pz, py) {
    let r = attempt(x, z, px, pz, py);
    if (r.ok) return r;
    // 撞墙/上不去：拆成两条轴分别试，沿墙滑
    const rx = attempt(x, pz, px, pz, py);
    if (rx.ok) return rx;
    const rz = attempt(px, z, px, pz, py);
    if (rz.ok) return rz;
    return { ok: false, x: px, z: pz, y: py, hit: (rx.hit || rz.hit || r.hit) };
  }

  const seats = {};
  for (const d of dugouts) seats[d.side < 0 ? 'home' : 'away'] = d;

  /**
   * 沿折线走一遍（自检/截图用）：每 0.25 m 取一个采样点走 resolve。
   * 返回 {ok, reached, stuckAt, trail}。
   */
  function path(points) {
    let px = points[0][0], pz = points[0][1];
    let py = (ground(px, pz) || { y: 0 }).y;
    const trail = [[+px.toFixed(2), +pz.toFixed(2), +py.toFixed(2)]];
    for (let i = 1; i < points.length; i++) {
      const [tx, tz] = points[i];
      for (let guard = 0; guard < 4000; guard++) {
        const dx = tx - px, dz = tz - pz;
        const d = Math.hypot(dx, dz);
        if (d < 0.2) break;
        const step = Math.min(0.25, d);
        const r = resolve(px + dx / d * step, pz + dz / d * step, px, pz, py);
        if (!r.ok || (Math.abs(r.x - px) < 1e-4 && Math.abs(r.z - pz) < 1e-4 && step > 0.05)) {
          return { ok: false, reached: i - 1, stuckAt: [+px.toFixed(2), +pz.toFixed(2)], hit: r.hit, trail };
        }
        px = r.x; pz = r.z; py = r.y;
        trail.push([+px.toFixed(2), +pz.toFixed(2), +py.toFixed(2)]);
        if (d <= step) break;
      }
    }
    return { ok: true, reached: points.length - 1, stuckAt: null, trail };
  }

  return {
    spec: o, W, L, hw, hl, tierGap, tierH,
    stepMax, radius, walls, dugouts, seats,
    ground, resolve, standTop, path,
    info: () => ({
      kind: 'roam', stadium: { w: W, l: L, baseInset: o.baseInset, boardOff: o.boardOff, tiers: o.tiers, rows: o.rows },
      walls: walls.length, dugouts: dugouts.map((d) => ({ side: d.side, z: d.z, seat: [+d.seatX.toFixed(2), d.platform, +d.z.toFixed(2)] })),
      stepMax, radius,
    }),
  };
}
