// 历史街区（古建地块）：**纯数据**规划器，不 import three.js —— 所以导航、碰撞、测试都能直接用它。
//
// 设计要点：
//   · 一个 46×46m 的方形院落，放在城镇某块空地上（world/layout.js 里指定地块）；
//   · 构件全部来自「中国古建库」（China_Building_Library）打包进来的 7 个 GLB，见 dist/data/heritage/index.json；
//   · **城市门禁**：只有 index.cityInfo.allowsAncient 为真（都江堰 = T2/川西）才放古建，
//     且套组必须包含 imperial（官式）或 chuanxi（川西），否则整个街区不生成 —— 这是"古建只出现在历史城市"的强制点；
//   · 碰撞用库里 baked 的 collision.json（列扫掠 + 连通裁剪），按摆放的 rotY 变换后并入 layout.colliders；
//   · 月亮门是"挖过洞的通行版"，所以门口要清一块 navDoor 走廊，NPC 才能穿过去。
//
// 坐标：y=0 地面；front 面向 +Z（游戏里 yaw=0 的正前方）。

/** 院落尺寸（米）。与 index.json 的 block 字段一致。 */
export const HERITAGE_BLOCK = { width: 46, depth: 46 };

/** 模块默认尺寸来自库（单位米），这里只用到"沿墙方向的宽度"做排布。 */
const MODULE_WIDTH = {
  wall_chuanxi: 4.10,
  moon_gate_chuanxi: 4.10,
  gate_tower: 11.20,
  platform: 4.14,
  steps: 4.20,
  walkway_chuanxi: 4.10,
  hall: 16.20,
};

const HALF_PI = Math.PI / 2;

/** 绕 Y 旋转 + 平移一个盒体；rotY 只取 0/±90/180，所以结果仍是轴对齐盒。 */
export function transformBox(box, rotY, tx, tz) {
  const c = Math.round(Math.cos(rotY)), s = Math.round(Math.sin(rotY));
  const pts = [[box.min[0], box.min[2]], [box.max[0], box.min[2]], [box.min[0], box.max[2]], [box.max[0], box.max[2]]]
    .map(([x, z]) => [x * c + z * s + tx, -x * s + z * c + tz]);
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  return {
    min: [Math.min(...xs), box.min[1], Math.min(...zs)],
    max: [Math.max(...xs), box.max[1], Math.max(...zs)],
  };
}


/**
 * 把古建的碰撞盒压到游戏能接受的数量。
 * 库里是"列扫掠 + 连通裁剪"的高精度盒（一个院落 1.5 万个），对离线烘焙合适，对每帧碰撞不合适。
 * 这里做两件事：
 *   ① 只保留与玩家高度带 [−0.2, 2.0] 相交的盒（屋顶/梁架对走路没意义，视觉上仍然挡视线）；
 *   ② 沿 X / Z 相邻且 Y 区间一致的盒合并（同宽同高的墙段并成长条）。
 */
export function compactHeritageColliders(boxes, opts = {}) {
  const yLo = opts.yLo ?? -0.2, yHi = opts.yHi ?? 2.0, eps = opts.eps ?? 0.06;
  const kept = boxes.filter((b) => b.max[1] > yLo && b.min[1] < yHi);
  const mergeAxis = (list, axis) => {
    const other = [0, 1, 2].filter((a) => a !== axis);
    const groups = new Map();
    for (const b of list) {
      const key = `${b.min[other[0]]}:${b.max[other[0]]}:${b.min[other[1]]}:${b.max[other[1]]}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const out = [];
    for (const g of groups.values()) {
      g.sort((p, q) => p.min[axis] - q.min[axis]);
      let cur = null;
      for (const b of g) {
        if (cur && b.min[axis] - cur.max[axis] <= eps) cur.max[axis] = Math.max(cur.max[axis], b.max[axis]);
        else { if (cur) out.push(cur); cur = { min: b.min.slice(), max: b.max.slice() }; }
      }
      if (cur) out.push(cur);
    }
    return out;
  };
  let cur = kept.map((b) => ({ min: b.min.slice(), max: b.max.slice() }));
  for (let round = 0; round < 2; round += 1) {
    cur = mergeAxis(cur, 0);
    cur = mergeAxis(cur, 2);
    cur = mergeAxis(cur, 1);
  }
  return { boxes: cur, before: boxes.length, kept: kept.length, after: cur.length };
}

/**
 * 规划一个历史街区。
 * @param {object} index  dist/data/heritage/index.json
 * @param {object} opts   { x, z, city, style } —— x/z 是院落中心
 * @returns {{ok:boolean, reason?:string, instances:Array, colliders:Array, navDoors:Array, poi?:object, warnings:Array}}
 */
export function planHeritage(index, opts = {}) {
  const warnings = [];
  if (!index || !Array.isArray(index.entries)) return { ok: false, reason: '没有历史街区清单', instances: [], colliders: [], navDoors: [], warnings };

  // ── 城市门禁（硬性）：非历史城市 / 套组不含官式或川西 → 不生成
  const info = index.cityInfo || {};
  const city = opts.city || index.city;
  if (!info.allowsAncient) {
    return { ok: false, reason: `${city} 不是历史文化名城（tier=${info.tier}），禁止古建`, instances: [], colliders: [], navDoors: [], warnings };
  }
  const allowed = new Set(info.allowedSets || []);
  if (!allowed.has('imperial') && !allowed.has('chuanxi')) {
    return { ok: false, reason: `${city} 允许的套组是 [${[...allowed].join(',')}]，没有官式/川西构件`, instances: [], colliders: [], navDoors: [], warnings };
  }
  const entry = Object.fromEntries(index.entries.map((e) => [e.key, e]));
  if (!opts.boxes) warnings.push('没有传碰撞盒（opts.boxes），古建只有视觉没有碰撞');
  for (const k of ['gate_tower', 'wall_chuanxi', 'moon_gate_chuanxi', 'platform', 'steps', 'walkway_chuanxi', 'hall']) {
    if (!entry[k]) warnings.push(`缺构件 ${k}（对应的摆放会跳过）`);
  }

  const W = (opts.block && opts.block.width) || index.block?.width || HERITAGE_BLOCK.width;
  const D = (opts.block && opts.block.depth) || index.block?.depth || HERITAGE_BLOCK.depth;
  const cx = Number.isFinite(opts.x) ? opts.x : 0;
  const cz = Number.isFinite(opts.z) ? opts.z : 0;
  const x0 = cx - W / 2, x1 = cx + W / 2;
  const z0 = cz - D / 2, z1 = cz + D / 2;

  const instances = [];
  const add = (key, x, z, rotY = 0, note = '') => {
    if (!entry[key]) return null;
    const inst = { key, x: +x.toFixed(3), z: +z.toFixed(3), rotY, y: 0, note };
    instances.push(inst);
    return inst;
  };

  // ── 南侧（临街）：城门楼居中，两侧院墙
  const gateW = MODULE_WIDTH.gate_tower;
  add('gate_tower', cx, z1 - 3.6, 0, '临街主入口');
  const southWallSpan = (W / 2) - gateW / 2 - 0.2;
  const nSeg = Math.max(2, Math.floor(southWallSpan / MODULE_WIDTH.wall_chuanxi));
  for (let i = 0; i < nSeg; i += 1) {
    const off = gateW / 2 + 1.2 + i * MODULE_WIDTH.wall_chuanxi;
    if (off + MODULE_WIDTH.wall_chuanxi / 2 > W / 2 - 0.1) break;
    add('wall_chuanxi', cx - off, z1 - 0.4, 0, '南墙西段');
    add('wall_chuanxi', cx + off, z1 - 0.4, 0, '南墙东段');
  }

  // ── 东西两侧院墙（沿进深方向排）
  const sideSeg = Math.max(2, Math.floor((D - 14) / MODULE_WIDTH.wall_chuanxi));
  for (let i = 0; i < sideSeg; i += 1) {
    const z = z0 + 6 + i * MODULE_WIDTH.wall_chuanxi;
    if (z > z1 - 4) break;
    add('wall_chuanxi', x0 + 0.4, z, HALF_PI, '西墙');
    add('wall_chuanxi', x1 - 0.4, z, -HALF_PI, '东墙');
  }

  // ── 北侧：月亮门居中，两侧院墙
  add('moon_gate_chuanxi', cx, z0 + 0.4, Math.PI, '后院月亮门（通行版）');
  for (let i = 1; i <= 3; i += 1) {
    const off = i * MODULE_WIDTH.wall_chuanxi;
    if (off + MODULE_WIDTH.wall_chuanxi / 2 > W / 2 - 0.1) break;
    add('wall_chuanxi', cx - off, z0 + 0.4, Math.PI, '北墙西段');
    add('wall_chuanxi', cx + off, z0 + 0.4, Math.PI, '北墙东段');
  }

  // ── 院内：台基 + 台阶 + 大殿（北侧），连廊沿东侧内院
  const hallZ = z0 + 12;
  add('platform', cx - MODULE_WIDTH.platform, hallZ, 0, '台基西');
  add('platform', cx, hallZ, 0, '台基中');
  add('platform', cx + MODULE_WIDTH.platform, hallZ, 0, '台基东');
  add('steps', cx, hallZ + 3.2, 0, '台阶');
  add('hall', cx, hallZ - 5.6, 0, '大殿');
  for (let i = 0; i < 2; i += 1) {
    add('walkway_chuanxi', x1 - 4.2, cz - 2 + i * MODULE_WIDTH.walkway_chuanxi, -HALF_PI, '东侧连廊');
  }

  // ── 碰撞：把每个构件 baked 的 collision.json 盒体按 rotY 变换进来，先保持 {min,max} 便于压缩
  const rawBoxes = [];
  for (const inst of instances) {
    const e = entry[inst.key];
    const src = (opts.boxes && opts.boxes[inst.key]) || e.collisionBoxes || [];
    for (const b of src) rawBoxes.push(transformBox(b, inst.rotY, inst.x, inst.z));
  }

  // ── 导航走廊：城门楼门洞 + 月亮门（通行版）各清一块
  const navDoors = [
    { x0: cx - 1.4, x1: cx + 1.4, z0: z1 - 3.6 - 1.6, z1: z1 - 3.6 + 1.6, note: '城门楼门洞' },
    { x0: cx - 1.2, x1: cx + 1.2, z0: z0 - 1.0, z1: z0 + 1.8, note: '月亮门（通行版）' },
  ];

  const compact = compactHeritageColliders(rawBoxes);
  const finalColliders = compact.boxes.map((b) => ({
    minX: b.min[0], minZ: b.min[2], maxX: b.max[0], maxZ: b.max[2],
    maxY: b.max[1], tag: 'heritage', blocksNav: true,
  }));

  const poi = {
    id: 'POI_HERITAGE', kind: 'heritage', name: `${city}·古建院落`,
    x: cx, z: cz, radius: Math.max(W, D) / 2, danger: 0.35,
    style: info.style, tier: info.tier,
  };

  return {
    ok: true,
    city, tier: info.tier, style: info.style,
    block: { x0, z0, x1, z1, width: W, depth: D },
    instances, colliders: finalColliders, navDoors, poi, warnings,
    summary: { instances: instances.length, colliders: finalColliders.length, rawColliders: compact.before, keptColliders: compact.kept, passableDoors: navDoors.length },
  };
}

/**
 * 在旧城里挑一块空地放历史街区：不压建筑、不压道路、不压出生点。
 * 从内向外扫（越靠近镇中心越像"老城"），找不到就返回 null（这张图不放）。
 */
export function pickHeritageSite(layout, index, opts = {}) {
  const W = index?.block?.width || HERITAGE_BLOCK.width;
  const D = index?.block?.depth || HERITAGE_BLOCK.depth;
  const buildings = layout?.buildings || [];
  const roads = layout?.roads || [];
  const spawn = layout?.playerSpawn || { x: 0, z: 0 };
  const hit = (a, b, pad = 0) => !(a.x1 + pad <= b.x0 || a.x0 - pad >= b.x1 || a.z1 + pad <= b.z0 || a.z0 - pad >= b.z1);
  const half = ((layout?.size || 340) / 2) - W / 2 - 6;
  for (let r = 0; r <= half; r += 8) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      const rect = { x0: x - W / 2, x1: x + W / 2, z0: z - D / 2, z1: z + D / 2 };
      if (Math.hypot(x - spawn.x, z - spawn.z) < (W + D) / 2) continue;
      if (buildings.some((b) => hit(rect, b.rect, 2))) continue;
      if (roads.some((rr) => hit(rect, rr, 1))) continue;
      return { x, z, rect };
    }
  }
  return null;
}

export default { planHeritage, pickHeritageSite, transformBox, compactHeritageColliders, HERITAGE_BLOCK };
