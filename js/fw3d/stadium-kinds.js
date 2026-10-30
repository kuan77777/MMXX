// FW3D · 参数化球场生成器：四种形态，配色取主队球衣主色
// kind: 'bowl' 专业碗形 | 'oval' 大型椭圆 | 'athletics' 综合体育场（带跑道）| 'community' 紧凑社区场

export const STADIUM_KINDS = {
  bowl: { label: '专业碗形球场', tiers: 2, track: false, roof: 'membrane', screens: 4, minCap: 30000, rows: 8 },
  oval: { label: '大型椭圆球场', tiers: 3, track: false, roof: 'shell', screens: 4, minCap: 60000, rows: 8 },
  athletics: { label: '综合体育场', tiers: 2, track: true, roof: 'partial', screens: 2, minCap: 18000, rows: 7 },
  community: { label: '紧凑社区球场', tiers: 1, track: false, roof: 'none', screens: 0, minCap: 0, rows: 4 },
};

export function pickKind(capacity) {
  const c = Number(capacity) || 0;
  if (c >= 60000) return 'oval';
  if (c >= 30000) return 'bowl';
  if (c >= 18000) return 'athletics';
  return 'community';
}

/**
 * 建造时用到的派生尺寸，供外部（自由观赛 roam.js / 自检）按同一份规则算地面与碰撞。
 * 这些量原本散在 buildStadiumByKind 内部（baseInset / off / ROWS / ROW_DEPTH / ROW_RISE），
 * 自由观赛要按它们解析求地面高度，所以在这里收成唯一真源 —— 改这里等于同时改几何与碰撞。
 */
export function stadiumDerived(kind) {
  const cfg = STADIUM_KINDS[kind] || STADIUM_KINDS.bowl;
  const rows = cfg.rows || 8;
  const rowDepth = 1.65;
  const rowRise = 1.25;
  const baseInset = cfg.track ? 18 : 8;
  return {
    kind: STADIUM_KINDS[kind] ? kind : 'bowl',
    tiers: cfg.tiers,
    track: !!cfg.track,
    rows, rowDepth, rowRise,
    baseInset,
    boardOff: cfg.track ? 11 : 3.2,   // 场边广告板离边线的距离
    tierGap: rows * rowDepth,
    tierH: rows * rowRise,
  };
}

import { makeCanvasTexture } from './vendor/taishan/utils.js';
import { createDynamicScoreboard } from './vendor/taishan/scoreboard.js';
import { buildSkyDome, skyForKind, lightingFor } from './atmosphere.js';
// 只借一个纯函数（区间挖洞）：广告板要按"技术区豁口"断开，自由观赛才走得进替补席。
// roam.js 不 import 本文件，因此没有循环依赖。
import { subtractSpans } from './roam.js';

/**
 * 球员通道口（vomitory）参数。参考真实球场的"看台出入口"：通道从看台底部穿出，
 * 在看台上切出一个洞，洞口上方仍有看台座位（即通道顶板 < 看台高度）。
 * 返回 null 表示这个球场类型不做通道口。
 */
export function resolveVomitory(spec, dims) {
  if (!spec) return null;
  const s = typeof spec === 'object' ? spec : {};
  const W = dims.W, L = dims.L;
  return {
    axis: 'x',                                   // 通道沿 x 方向（从西侧看台底穿到边线）
    side: s.side == null ? -1 : s.side,          // -1 = -x 侧（西）
    at: s.at == null ? 0 : s.at,                 // 沿长轴的位置（0 = 中线，与边线垂直）
    half: s.half == null ? 3.0 : s.half,         // 洞口半宽（通道净宽 5.2 → 留 0.4 余量）
    top: s.top == null ? 4.7 : s.top,            // 洞口净高（通道净高 4.4 + 顶板）
    inner: W / 2 + 1,                            // 洞口内端：边线外 1 m
    outer: W / 2 + (s.out == null ? 17 : s.out), // 洞口外端：更深处（通道自身接上去）
  };
}

export function buildStadiumByKind(THREE, opts = {}) {
  const kind = STADIUM_KINDS[opts.kind] ? opts.kind : pickKind(opts.capacity);
  const cfg = STADIUM_KINDS[kind];
  const W = 68, L = 105;
  const primary = new THREE.Color(opts.primary || '#1f7a3f');
  const secondary = new THREE.Color(opts.secondary || '#f2f4f7');
  const cap = Number(opts.capacity) || 30000;

  const group = new THREE.Group();
  const colliders = [];

  // ── 球场配色：**全部由主队球衣主色/辅色派生**（用户要求：不这样就看不出球队多样性）
  // 早期实现里 bowl 的座席是写死的 #d7dbe2、trim 是写死的 #eceff4、oval 的强调色是写死的洋红，
  // athletics 还把主色混进了固定的 #8d2f2a —— 结果是"不管哪支球队，球场都长一个颜色"。
  //
  // 现在的规则：
  //   · 座席（看台最大面积）= 主色提亮一档 → 一眼看出是哪队主场
  //   · 结构/立面 = 主色压暗两档 → 与座席分层，不是同一块色
  //   · 走道 = 主色压暗三档
  //   · 栏杆压顶 / 层间 LED / 旗帜 第二色 = 辅色（若辅色过接近白或黑，自动混主色保证可见）
  //   · 强调色（仅 oval 灯带）= 主色与洋红混色，保留"大型封闭场馆"身份但仍属于该队
  // 场馆之间的差异靠**形制**（层数/跑道/屋盖/屏数），不靠换一套色板。
  const hsl = { h: 0, s: 0, l: 0 };
  const clamp01 = (v) => Math.max(0.02, Math.min(0.98, v));
  /** 沿 HSL 明度/饱和度移动一档，色相不变（保证还是"这个球队的颜色"） */
  const shade = (c, dl, ds) => {
    const o = c.clone();
    o.getHSL(hsl);
    o.setHSL(hsl.h, clamp01(hsl.s + (ds || 0)), clamp01(hsl.l + dl));
    return o;
  };
  const mix = (a, b, t) => a.clone().lerp(b, t);
  const isNearWhite = secondary.getHSL(hsl) && hsl.l > 0.86;
  // 辅色太浅时不能直接拿来当线条色（会过曝成白条），混一点主色压回来
  const accent = isNearWhite ? mix(secondary, primary, 0.42) : secondary.clone();

  const pal = {
    // 看台立面结构：主色压暗（bowl 更浅，因为它是"专业球场"的干净感）
    stand: kind === 'bowl' ? shade(primary, -0.12, -0.10) : shade(primary, -0.20, -0.06),
    // 座席：主色提亮一档 —— 这是画面里占比最大的颜色，必须就是队色
    // 注意：oval（最大规格）原来在这里混了 10% 写死洋红，导致座席永远偏粉，已去掉。
    seat: shade(primary, 0.10, -0.05),
    // 屋盖：主色压暗三档（bowl 用辅色压暗，白灰顶棚更像专业球场）
    roof: kind === 'bowl' ? shade(accent, -0.28, -0.08) : shade(primary, -0.34, -0.04),
    // 栏杆压顶 / 环形 LED 灯带 / 旗帜第二色：辅色为主。
    // oval 原来写死"主色混 55% 洋红 #e86bb4"当身份色 —— 结果是最大那个球场不管哪支球队
    // 都是粉红灯带（用户："我是说最大规格的那个球场的灯光"）。现在环场灯带直接吃辅色，
    // 大场馆的身份改由形制承担：三层看台 + 壳体屋盖 + 内外两道环场灯带 + 径向主梁。
    trim: accent.clone(),
  };

  const standMat = new THREE.MeshStandardMaterial({ color: pal.stand, roughness: 0.82, metalness: 0.04 });
  const seatMat = new THREE.MeshStandardMaterial({ color: pal.seat, roughness: 0.9 });
  // 屋盖底面在太阳底下是背光面，只被"半球光的地面色"照到 → 不管基色多浅都会渲成近黑。
  // 给一点自发光把它从"黑洞"抬到"钢结构底面"的亮度（不新增光源，只加一个材质系数）。
  const roofMat = new THREE.MeshStandardMaterial({
    color: pal.roof, roughness: 0.7, metalness: 0.15,
    emissive: pal.roof.clone().multiplyScalar(0.55), emissiveIntensity: 1,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: pal.trim, roughness: 0.55, metalness: 0.2 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa6b4, roughness: 0.5, metalness: 0.5 });
  // 灯光色板：与 arena.js 用同一个 atmosphere.lightingFor，保证场内主光与场馆灯同色温
  const LT = lightingFor('#' + primary.getHexString(), '#' + secondary.getHexString());
  // 夜场照明改为 2 盏（原先 4 盏点光，实测是主要 GPU 开销之一）
  const spots = [];
  for (const sz of [-1, 1]) {
    const l = new THREE.PointLight(new THREE.Color(LT.warm), 900, 120, 2);
    l.position.set(0, 32, sz * 62);
    group.add(l);
    spots.push(l);
  }

  // 跑道（综合体育场）
  if (cfg.track) {
    const trackOuter = new THREE.Mesh(new THREE.RingGeometry(0, 1, 4), new THREE.MeshStandardMaterial({ color: 0x9c3b2e, roughness: 0.95 }));
    trackOuter.visible = false; // 用矩形跑道替代，避免 RingGeometry 变形
    const trackW = W + 16, trackL = L + 16;
    const track = new THREE.Mesh(new THREE.PlaneGeometry(trackW, trackL), new THREE.MeshStandardMaterial({ color: 0x9c3b2e, roughness: 0.95 }));
    track.rotation.x = -Math.PI / 2;
    track.position.y = -0.02;
    group.add(track);
    const inner = new THREE.Mesh(new THREE.PlaneGeometry(W + 2, L + 2), new THREE.MeshStandardMaterial({ color: 0x2f7d42, roughness: 0.95 }));
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0;
    group.add(inner);
  }

  // ── 看台几何：由"排数 / 排深 / 每排升高"三个可解释的量推导（不再各自写死）
  // 用户反馈：层间距按进深推导后，整座球场进深被撑到 ~59 m，从场内是一整片向上收的斜面，"更大了"。
  // 这里把参数收敛成一组自洽的数字，并按场馆类型给不同排数：
  //   · 坡比 = ROW_RISE / ROW_DEPTH = 1.25 / 1.65 ≈ 37°（和之前一致，视觉不突变）
  //   · 每层高度 = 排数 × 每排升高；层间距 = 排数 × 排深  → 上下层自然首尾相接，不会再有缝
  //   · 排数按类型给：大场馆 8 排、综合场 7 排、社区 4 排（社区本来就该矮）
  const ROWS = cfg.rows || 8;
  const ROW_DEPTH = 1.65;
  const ROW_RISE = 1.25;
  const tierH = ROWS * ROW_RISE;
  const tierGap = ROWS * ROW_DEPTH;
  const baseInset = cfg.track ? 18 : 8;
  const boardOff = cfg.track ? 11 : 3.2;      // 场边广告板离边线的距离（自由观赛的禁区/走道按它分界）
  // ── 广告板/围墙的「技术区豁口」：只有自由观赛模式会传 boardGaps，默认没有（其它模式几何不变）
  const gapsFor = (side) => {
    const g = (opts && opts.boardGaps) || null;
    if (!g) return [];
    return g[String(side)] || g[side] || [];
  };
  const cutGaps = (segs, side, pad) => subtractSpans(segs, gapsFor(side).map(([a, b]) => [a - (pad || 0), b + (pad || 0)]));
  // 台阶面用"座席色"、走道用更暗的队色：
  // 原来台阶是主色 ×1.05 的深色，三层看台在 80–110 m 外直接糊成一大块暗板，看上去就是"围了一圈墙"。
  // 现在台阶 = 队色座席（pal.seat，已提亮一档），走道 = 队色压暗三档，层与层之间才有台阶感。
  const stepMat = new THREE.MeshStandardMaterial({ color: pal.seat, roughness: 0.88 });
  const walkMat = new THREE.MeshStandardMaterial({ color: shade(primary, -0.30, -0.04), roughness: 0.9 });

  const unit = new THREE.BoxGeometry(1, 1, 1);
  // ── 先收集再实例化（本轮改动）
  // 早期是"先算死数量、边算边塞"，所以没法在不破坏 instances 数的前提下"挖洞"，
  // 结果球员通道只能整根埋在看台实体里 —— 第一人称出场时整屏被看台板挡住。
  // 现在先产出盒子列表，通道口可以真的从看台上切掉一块，数量在最后按实际长度创建。
  const vom = resolveVomitory(opts.vomitory === false ? null : (opts.vomitory || {}), { W, L });
  const standBoxes = [];   // { w,h,d,x,y,z }
  const walkBoxes = [];
  const seatBoxes = [];
  const seatRows = [];     // 观众实例用：真实台阶面（不是随机悬空的 y）

  const m4 = new THREE.Matrix4();
  const setBox = (inst, i, w, h, d, x, y, z) => {
    m4.makeScale(w, h, d);
    m4.setPosition(x, y, z);
    inst.setMatrixAt(i, m4);
  };

  /** 通道口是否切到这一段看台：只切"同一侧、且高度低于洞口顶"的那些排 */
  const vomits = (sideX, yBottom, yTop, zSpan) => {
    if (!vom) return false;
    if (sideX * vom.side <= 0) return false;                 // 只切通道所在的那一侧
    if (yBottom >= vom.top || yTop <= 0) return false;       // 洞口以上的座位保留（通道在看台底下）
    // z 方向必须与洞口区间重叠
    return zSpan[0] < vom.at + vom.half && zSpan[1] > vom.at - vom.half;
  };

  for (let t = 0; t < cfg.tiers; t++) {
    const inset = baseInset + t * tierGap;
    const baseY = t * tierH;
    const rowH = tierH / ROWS;
    for (let r = 0; r < ROWS; r++) {
      const y = baseY + (r + 0.5) * rowH;
      const insetR = inset + r * ROW_DEPTH;
      const depth = ROW_DEPTH;
      const yB = baseY + r * rowH, yT = baseY + (r + 1) * rowH;
      for (const side of [-1, 1]) {
        // 底线侧的长排（沿 x 展开）
        standBoxes.push({ w: W + insetR * 2, h: rowH, d: depth, x: 0, y, z: side * (L / 2 + insetR) });
        seatRows.push({ k: 'end', side, y: yT, base: L / 2 + insetR, span: W / 2 + insetR });
        // 边线侧的长排（沿 z 展开）：通道口只可能切到这里
        const halfZ = L / 2 + insetR;
        const xSide = side * (W / 2 + insetR);
        if (vomits(xSide, yB, yT, [-halfZ, halfZ])) {
          const a = -halfZ, b = vom.at - vom.half, c = vom.at + vom.half, d2 = halfZ;
          if (b - a > 0.2) standBoxes.push({ w: depth, h: rowH, d: b - a, x: xSide, y, z: (a + b) / 2 });
          if (d2 - c > 0.2) standBoxes.push({ w: depth, h: rowH, d: d2 - c, x: xSide, y, z: (c + d2) / 2 });
        } else {
          standBoxes.push({ w: depth, h: rowH, d: L + insetR * 2, x: xSide, y, z: 0 });
        }
        seatRows.push({ k: 'side', side, y: yT, base: W / 2 + insetR, span: L / 2 + insetR });
      }
    }
    // 层与层的交接平台：做成 1.7 m 高的实心"环廊墙"，而不是 0.7 m 的薄板。
    // 作用有二：①把上下两层看台在视觉上明确分层（否则连成一个连续斜面，像一堵墙）；
    // ②封住层与层之间的那道缝，不让空气/天空从缝里透出来。
    const ringY = baseY + tierH + 0.2;
    for (const side of [-1, 1]) {
      walkBoxes.push({ w: W + (inset + ROWS * ROW_DEPTH) * 2, h: 1.7, d: 2.4, x: 0, y: ringY, z: side * (L / 2 + inset + ROWS * ROW_DEPTH) });
      walkBoxes.push({ w: 2.4, h: 1.7, d: L + (inset + ROWS * ROW_DEPTH) * 2, x: side * (W / 2 + inset + ROWS * ROW_DEPTH), y: ringY, z: 0 });
      seatBoxes.push({ w: W + (inset + ROWS * ROW_DEPTH) * 2, h: 0.35, d: 1.05, x: 0, y: baseY + tierH - 0.2, z: side * (L / 2 + inset + (ROWS - 1) * ROW_DEPTH) });
      seatBoxes.push({ w: 1.05, h: 0.35, d: L + (inset + ROWS * ROW_DEPTH) * 2, x: side * (W / 2 + inset + (ROWS - 1) * ROW_DEPTH), y: baseY + tierH - 0.2, z: 0 });
    }
  }
  const mkInstanced = (list, mat) => {
    const inst = new THREE.InstancedMesh(unit, mat, Math.max(1, list.length));
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    list.forEach((b, i) => setBox(inst, i, b.w, b.h, b.d, b.x, b.y, b.z));
    inst.instanceMatrix.needsUpdate = true;
    inst.count = list.length;
    return inst;
  };
  const standInstanced = mkInstanced(standBoxes, stepMat);
  const walkInstanced = mkInstanced(walkBoxes, walkMat);
  const seatInstanced = mkInstanced(seatBoxes, seatMat);
  group.add(standInstanced, walkInstanced, seatInstanced);
  group.userData.instanced = true;
  group.userData.vomitory = vom;     // 供 arena 放置通道本体与出场点

  // ── 看台前沿：栏杆 + 旗帜 + 层间横幅（替代原来的"竖向分段大板"）
  // 原实现每 11–13 m 就往看台上立一块 0.6 × ~12 × 17 m 的实心板，远看就是"一圈竖墙块"，
  // 和真实球场完全不像。真实球场同一位置是这四样东西一起构成"球场标志"：
  //   ① 安全栏杆（细杆 + 立柱）② 悬挂旗帜 ③ 层间横幅/前沿板 ④ 观众 + 场边广告牌（已有）。
  // 三角面与 draw call 都更省：栏杆/旗帜/横幅各 1 个 InstancedMesh。
  (function standFront() {
    const railMat = steelMat;                                  // 涂装金属：全局复用，不新建
    // 层间"环形 LED 带"：不吃光照的纯色带，远距离一秒能认出是球场
    const fasciaMat = new THREE.MeshBasicMaterial({ color: pal.trim.clone().multiplyScalar(0.92) });
    const flagMat = new THREE.MeshStandardMaterial({
      roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    });
    const RAIL_H = 0.95, RAIL_T = 0.08, POST_STEP = 3.2;
    // 横幅按"能看见"的尺寸走：80 m 外 2.4 × 1.5 m 才勉强有几个像素，
    // 所以栏杆保持细（近景可信），真正承担"球场标志"的是下面的大横幅与 LED 带。
    const FLAG_W = 2.4, FLAG_H = 1.5, FLAG_STEP = 12;
    const bars = [];    // 横杆 + 立柱（同一材质 → 同一 InstancedMesh）
    const flags = [];   // { x, y, z, ry, tone }
    const fascias = []; // 层间 LED 带

    const segsFor = (side) => {
      // 通道口所在侧的栏杆/横幅要断开，否则会横穿洞口
      const half = L / 2;
      if (vom && side * vom.side > 0) {
        return [[-half, vom.at - vom.half], [vom.at + vom.half, half]];
      }
      return [[-half, half]];
    };

    for (let t = 0; t < cfg.tiers; t++) {
      const inset = baseInset + t * tierGap;
      const y0 = t * tierH;                        // 该层看台起始高度
      const rx = W / 2 + inset;                    // 前沿半宽（x）
      const rz = L / 2 + inset;                    // 前沿半长（z）
      for (const side of [-1, 1]) {
        // ── 沿 x 的两条前沿（球门后方）
        for (const yy of [RAIL_H, RAIL_H * 0.52]) {
          bars.push({ w: rx * 2, h: RAIL_T, d: RAIL_T, x: 0, y: y0 + yy, z: side * rz });
        }
        for (let x = -rx + 1.6; x <= rx - 1.6; x += POST_STEP) {
          bars.push({ w: 0.06, h: RAIL_H, d: 0.06, x, y: y0 + RAIL_H / 2, z: side * rz });
        }
        // 大横幅：挂在栏杆顶下方，朝向球场（尺寸按"80 m 外能看见"定）
        for (let x = -rx + FLAG_STEP * 0.6; x <= rx - FLAG_STEP * 0.6; x += FLAG_STEP) {
          flags.push({ x, y: y0 + RAIL_H - FLAG_H / 2 - 0.06, z: side * (rz + 0.1), ry: 0, tone: Math.abs(Math.round(x / FLAG_STEP)) % 2 });
        }
        // ── 沿 z 的两条前沿（边线侧），被通道口切成两段
        for (const [z0, z1] of segsFor(side)) {
          const len = z1 - z0;
          if (len <= 0.6) continue;
          const cz = (z0 + z1) / 2;
          for (const yy of [RAIL_H, RAIL_H * 0.52]) {
            bars.push({ w: RAIL_T, h: RAIL_T, d: len, x: side * rx, y: y0 + yy, z: cz });
          }
          for (let z = z0 + 1.6; z <= z1 - 1.6; z += POST_STEP) {
            bars.push({ w: 0.06, h: RAIL_H, d: 0.06, x: side * rx, y: y0 + RAIL_H / 2, z });
          }
          for (let z = z0 + FLAG_STEP * 0.6; z <= z1 - FLAG_STEP * 0.6; z += FLAG_STEP) {
            flags.push({ x: side * (rx + 0.1), y: y0 + RAIL_H - FLAG_H / 2 - 0.06, z, ry: Math.PI / 2, tone: Math.abs(Math.round(z / FLAG_STEP)) % 2 });
          }
        }
        // ── 层间环形 LED 带：第二层及以上才做（第一层贴地，用场边广告牌就够）
        if (t > 0) {
          for (const [z0, z1] of segsFor(side)) {
            const len = z1 - z0;
            if (len <= 1) continue;
            fascias.push({ w: 0.22, h: 0.9, d: len, x: side * rx, y: y0 + 0.45, z: (z0 + z1) / 2 });
          }
          fascias.push({ w: rx * 2, h: 0.9, d: 0.22, x: 0, y: y0 + 0.45, z: side * rz });
        }
      }
    }

    const addInst = (list, mat, mk) => {
      if (!list.length) return null;
      const inst = new THREE.InstancedMesh(unit, mat, list.length);
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      list.forEach((b, i) => mk(inst, b, i));
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
      return inst;
    };
    addInst(bars, railMat, (inst, b, i) => setBox(inst, i, b.w, b.h, b.d, b.x, b.y, b.z));
    addInst(fascias, fasciaMat, (inst, b, i) => setBox(inst, i, b.w, b.h, b.d, b.x, b.y, b.z));

    // 大横幅：单位平面按实例缩放 + 逐实例颜色（主色/辅色交替）
    if (flags.length) {
      const geo = new THREE.PlaneGeometry(FLAG_W, FLAG_H);
      const inst = new THREE.InstancedMesh(geo, flagMat, flags.length);
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3(1, 1, 1);
      const m = new THREE.Matrix4();
      const cA = primary.clone().lerp(secondary, 0.12);
      const cB = secondary.clone().lerp(primary, 0.25);
      flags.forEach((f, i) => {
        e.set(0, f.ry, 0);
        q.setFromEuler(e);
        pos.set(f.x, f.y, f.z);
        m.compose(pos, q, scl);
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, f.tone ? cB : cA);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      group.add(inst);
      group.userData.flags = flags.length;
    }

    // ── 看台正面巨幅队名横幅：四面各一条，尺寸够大（14 × 2.4 m），
    // 是"这块场地是谁的主场"最直接的视觉答案（比一堆装饰块有用得多）。
    (function clubBanners() {
      const label = String(opts.clubName || 'FOOTBALL WORLD');
      const tex = makeCanvasTexture(1024, 176, (ctx, w, h) => {
        ctx.fillStyle = '#' + new THREE.Color(primary).multiplyScalar(0.82).getHexString();
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#' + new THREE.Color(secondary).getHexString();
        ctx.fillRect(0, 0, w, 10);
        ctx.fillRect(0, h - 10, w, 10);
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 96px "Microsoft YaHei",system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label.slice(0, 12), w / 2, h / 2);
      });
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      const bw = 14, bh = 2.4;
      const inset0 = baseInset;
      const y = 1.2 + bh / 2;
      for (const side of [-1, 1]) {
        // 球门后方两条
        const b1 = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), mat);
        b1.position.set(0, y, side * (L / 2 + inset0 - 0.35));
        b1.rotation.y = side > 0 ? Math.PI : 0;
        group.add(b1);
        // 边线侧两条（避开通道口 → 放在 +x 侧或偏移到 -x 侧远离中线处）
        const b2 = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), mat);
        const zOff = (vom && side * vom.side > 0) ? 26 : 0;
        b2.position.set(side * (W / 2 + inset0 - 0.35), y, zOff);
        b2.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        group.add(b2);
      }
      group.userData.clubBanners = 4;
    })();
    group.userData.railPosts = bars.length;
    group.userData.fascias = fascias.length;
    group.userData.dividers = 0;   // 旧字段保留：竖向大板已移除（arena.perf() 仍在读）
  })();

  // ── 社区球场：低矮围墙（底座/墙身/浅色压顶）+ 护栏 + 替补席；不扩建为大场馆
  if (kind === 'community') {
    const wallBase = new THREE.MeshStandardMaterial({ color: pal.stand.clone().multiplyScalar(0.62), roughness: 0.95 });
    const wallTop = new THREE.MeshStandardMaterial({ color: pal.trim, roughness: 0.7 });
    const off = boardOff, h = 1.5;
    // 侧墙沿 z 展开；通道口所在侧要留出洞口，否则通道头会顶在围墙上
    const zSegments = (side) => {
      const half = L / 2 + off;
      if (vom && side * vom.side > 0) {
        return [[-half, vom.at - vom.half], [vom.at + vom.half, half]];
      }
      return [[-half, half]];
    };
    for (const side of [-1, 1]) {
      const wb = new THREE.Mesh(new THREE.BoxGeometry(W + off * 2, 0.35, 0.5), wallBase);
      wb.position.set(0, 0.17, side * (L / 2 + off));
      const wt = new THREE.Mesh(new THREE.BoxGeometry(W + off * 2, 0.12, 0.62), wallTop);
      wt.position.set(0, h, side * (L / 2 + off));
      const ww = new THREE.Mesh(new THREE.BoxGeometry(W + off * 2, h - 0.4, 0.34), wallBase);
      ww.position.set(0, (h + 0.3) / 2, side * (L / 2 + off));
      group.add(wb, wt, ww);
      for (const [z0, z1] of cutGaps(zSegments(side), side)) {
        const len = z1 - z0;
        if (len <= 0.4) continue;
        const cz = (z0 + z1) / 2;
        const sb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, len), wallBase);
        sb.position.set(side * (W / 2 + off), 0.17, cz);
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, len), wallTop);
        st.position.set(side * (W / 2 + off), h, cz);
        const sw = new THREE.Mesh(new THREE.BoxGeometry(0.34, h - 0.4, len), wallBase);
        sw.position.set(side * (W / 2 + off), (h + 0.3) / 2, cz);
        group.add(sb, st, sw);
      }
    }
    // 替补席（两侧各一个，避开球门）
    // 注意：自由观赛（传了 boardGaps）会另建真正的替补席（roam.dugoutLayout + dugout.js），
    // 这两个只是社区球场的装饰方块，会挡在球门后的人行道上，所以那种模式下不再生成。
    if (!(opts && opts.boardGaps)) {
      for (const side of [-1, 1]) {
        const dug = new THREE.Mesh(new THREE.BoxGeometry(7, 1.5, 2.2), wallBase);
        dug.position.set(side * 16, 0.75, -(L / 2 + 1.6));
        const roofD = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.16, 2.5), wallTop);
        roofD.position.set(side * 16, 1.62, -(L / 2 + 1.6));
        group.add(dug, roofD);
      }
    }
  }

  // ── 红色主题：场边主题广告带 + 墙面竖向凹槽（低模分段，不用细碎线条）
  if (kind === 'athletics') {
    const bandMat = new THREE.MeshStandardMaterial({ color: pal.roof, roughness: 0.8 });
    for (const side of [-1, 1]) {
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, 1.3, 0.35), bandMat);
      b1.position.set(0, 2.0, side * (L / 2 + 6.5));
      group.add(b1);
      // 侧向广告带：通道口 / 技术区（替补席）所在处要断开，否则横穿通道、也挡住坐在替补席上的视线。
      // 这里比广告板再多让 3.5 m：这块带子在 2 m 高、1.3 m 厚，正对替补席坐着的人就是一道墙。
      const half = L * 0.98 / 2;
      const segs = (vom && side * vom.side > 0)
        ? [[-half, vom.at - vom.half], [vom.at + vom.half, half]]
        : [[-half, half]];
      for (const [z0, z1] of cutGaps(segs, side, 3.5)) {
        const len = z1 - z0;
        if (len <= 0.4) continue;
        const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.3, len), bandMat);
        b2.position.set(side * (W / 2 + 6.5), 2.0, (z0 + z1) / 2);
        group.add(b2);
      }
    }
  }

  // ── 屋盖（顶棚）
  // 高度：必须落在最后一层看台顶上，否则屋顶会插进看台里。
  // 平面位置：必须"罩住最后一层看台"。
  //  旧式子是 roofInset = baseInset + tiers*tierGap + 2 —— 按"最外沿再往外 2 m"摆，
  //  在层间距 7–8 m 时刚好压在上层看台上；改成 17.1 m 之后，屋盖被推到看台外 20 m，
  //  从场内看就"顶棚设计没有了"（其实还在，只是挂在球场外面）。
  //  现在按"最高一层看台的内沿"定位，向内悬挑 OVERHANG，进深一直覆盖到最外沿 + 2 m。
  const topH = cfg.tiers * tierH + 0.6;
  const topTierInset = baseInset + (cfg.tiers - 1) * tierGap;   // 最高层看台前沿
  const OVERHANG = 4.5;                                          // 向场内悬挑
  const roofInner = Math.max(2, topTierInset - OVERHANG);        // 屋盖内沿
  const roofOuter = baseInset + cfg.tiers * tierGap + 2;         // 屋盖外沿（看台外 2 m）
  const roofDepth = Math.max(12, roofOuter - roofInner);
  if (cfg.roof === 'membrane' || cfg.roof === 'shell') {
    const isShell = cfg.roof === 'shell';
    const thick = isShell ? 1.2 : 0.7;
    const y = topH + 2.0;
    for (const side of [-1, 1]) {
      // 两端（球门后方）：沿 x 展开的一条环形屋带
      const roof = new THREE.Mesh(new THREE.BoxGeometry(W + roofOuter * 2, thick, roofDepth), roofMat);
      roof.position.set(0, y, side * (L / 2 + roofInner + roofDepth / 2));
      roof.castShadow = true;
      group.add(roof);
      // 两侧（边线）：沿 z 展开
      const roofS = new THREE.Mesh(new THREE.BoxGeometry(roofDepth, thick, L + roofOuter * 2), roofMat);
      roofS.position.set(side * (W / 2 + roofInner + roofDepth / 2), y, 0);
      group.add(roofS);
    }
    // 环形灯带（大型封闭场馆）：外沿深色压边 + 内外两条灯带，体现屋顶厚度而不是单薄平面
    if (cfg.roof === 'shell') {
      const rEdge = L / 2 + roofOuter - 0.6;
      const edge = new THREE.Mesh(new THREE.TorusGeometry(rEdge + 1.2, 1.0, 6, 64), roofMat);
      edge.rotation.x = Math.PI / 2;
      edge.position.y = y + 0.5;
      group.add(edge);
      const rIn = L / 2 + roofInner + 2.2;
      for (const [rr, yy, op] of [[rEdge, y + 0.2, 0.95], [rIn, y - 0.1, 0.8]]) {
        const strip = new THREE.Mesh(
          new THREE.TorusGeometry(rr, 0.32, 6, 64),
          new THREE.MeshBasicMaterial({ color: pal.trim.clone().multiplyScalar(op).getHex() })
        );
        strip.rotation.x = Math.PI / 2;
        strip.position.y = yy;
        group.add(strip);
      }
      // 径向主梁：架在内沿与外沿之间，让顶棚有结构感
      const beamMat = new THREE.MeshStandardMaterial({ color: pal.roof.clone().multiplyScalar(1.2), roughness: 0.6, metalness: 0.25 });
      const beamR = L / 2 + roofInner + roofDepth / 2;
      const beamLen = roofDepth + 2;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const bm = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, beamLen), beamMat);
        bm.position.set(Math.sin(a) * beamR, y + 0.6, Math.cos(a) * beamR);
        bm.rotation.y = a;
        group.add(bm);
      }
    }
  } else if (cfg.roof === 'partial') {
    // 半顶棚（综合体育场）：只罩住上层看台的一半进深，场内仍能看到天空
    const depth = Math.max(10, roofDepth * 0.55);
    for (const side of [-1, 1]) {
      const roof = new THREE.Mesh(new THREE.BoxGeometry(W + (roofInner + depth) * 2, 0.55, depth), roofMat);
      roof.position.set(0, topH + 1.6, side * (L / 2 + roofInner + depth / 2));
      group.add(roof);
      const roofS = new THREE.Mesh(new THREE.BoxGeometry(depth, 0.55, L + (roofInner + depth) * 2), roofMat);
      roofS.position.set(side * (W / 2 + roofInner + depth / 2), topH + 1.6, 0);
      group.add(roofS);
    }
  }

  // 屏幕：**已删除**（用户反馈"怎么有两个比分牌，把那个小的去掉"）
  // 这里原来在 cfg.screens>0 时摆 2–4 块 9×5 的"装饰屏"（只有一块深色板 + 一张近白的发光贴片），
  // 其中 [0,-1] 那一块正好和下面 createDynamicScoreboard 生成的真记分牌同 x/z，
  // 只是高度更高（topH+2.4 ≈ 36 m vs 14 m）→ 从场内看就是"大比分牌上方又挂了一块小牌子"。
  // 场馆身份现在由层间环形 LED 带 + 队名巨幅横幅承担，不再需要这类低信息量的装饰屏。
  // 如果将来要恢复"四面大屏"，正确做法是让它们显示同一份比赛数据（setData），并避开真记分牌的位置。

  // 灯柱（非社区球场）
  if (cfg.tiers >= 2) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 30, 8), steelMat);
      mast.position.set(sx * (W / 2 + baseInset + cfg.tiers * tierGap + 6), 15, sz * (L / 2 + baseInset + cfg.tiers * tierGap + 6));
      group.add(mast);
      // 泛光灯头：发光色也跟队色（辅色 72% 白 + 28% 辅色），与泛光灯本体同色温
      const head = new THREE.Mesh(new THREE.BoxGeometry(7, 2.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xf2f6ff, emissive: new THREE.Color(LT.flood), emissiveIntensity: 2.2 }));
      head.position.set(mast.position.x, 30.4, mast.position.z);
      head.lookAt(0, 0, 0);
      group.add(head);
    }
  }

  // ── 广告板：借用泰山的 makeCanvasTexture 画队名 + 主色底
  (function adBoards() {
    const label = (opts.clubName || 'FOOTBALL WORLD');
    const tex = makeCanvasTexture(1024, 128, (ctx, w, h) => {
      ctx.fillStyle = '#' + primary.getHexString();
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 64px "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, w / 2, h / 2);
    });
    const boardMat = new THREE.MeshBasicMaterial({ map: tex });
    const off = boardOff;
    for (const side of [-1, 1]) {
      const b1 = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.9, 1.1), boardMat);
      b1.position.set(0, 0.55, side * (L / 2 + off));
      b1.rotation.y = side > 0 ? Math.PI : 0;
      group.add(b1);
      // 侧向广告板：通道口所在侧断开（否则整块板横穿通道）
      const half = L * 0.9 / 2;
      const segs = (vom && side * vom.side > 0)
        ? [[-half, vom.at - vom.half], [vom.at + vom.half, half]]
        : [[-half, half]];
      for (const [z0, z1] of cutGaps(segs, side)) {
        const len = z1 - z0;
        if (len <= 0.4) continue;
        const b2 = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.1), boardMat);
        b2.position.set(side * (W / 2 + off), 0.55, (z0 + z1) / 2);
        b2.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        group.add(b2);
      }
    }
  })();

  // ── 记分牌：借用泰山的 createDynamicScoreboard（自带屏幕位置与比例，不要再改 group 变换）
  // 注意：它返回的是 { group, screen, setData, update, data... }，早期代码误写 sb.position.set / sb.scale
  // 导致抛异常被静默吞掉 —— 既没定位成功，也拿不到引用，屏幕上一直显示移植时写死的 6:0。
  //
  // 本轮改造：
  // 1) 删掉原来 `cfg.screens` 那 4 块 9×5 的"小屏"（只有一块深色板 + 一张近白发光贴片）。
  //    它们和这块真记分牌**同位置叠在一起**，从场内看就是"大比分牌上方还有一块小牌子"。
  //    场馆身份现在由层间 LED 带 + 队名巨幅横幅承担，不需要这些低信息量的装饰屏。
  // 2) 记分牌配色改为由队色派生（原来红/蓝底写死，不管哪队主场都一个色）。
  let scoreboard = null;
  (function scoreboardBuild() {
    if (cfg.tiers < 2) return;   // 社区球场没有大屏
    try {
      const sb = createDynamicScoreboard({
        textures: {},
        parent: group,
        palette: {
          body0: '#' + shade(primary, 0.16).getHexString(),
          body1: '#' + primary.getHexString(),
          body2: '#' + shade(primary, -0.20).getHexString(),
          stripe: '#' + accent.getHexString(),
          head0: '#' + shade(accent, -0.06).getHexString(),
          head1: '#' + shade(accent, -0.30).getHexString(),
          headStroke: 'rgba(255,255,255,0.55)',
          headText: '#ffffff',
          headSub: 'rgba(255,255,255,0.72)',
          headSide: 'rgba(255,255,255,0.80)',
          scoreGlow: '#' + accent.getHexString(),
          period: '#' + shade(accent, 0.10).getHexString(),
          foot0: '#' + shade(primary, -0.10).getHexString(),
          foot1: '#' + shade(primary, -0.36).getHexString(),
          crest0: '#' + shade(accent, 0.16).getHexString(),
          crest1: '#' + shade(accent, 0.04).getHexString(),
          crest2: '#' + shade(primary, -0.16).getHexString(),
          crestText: '#' + shade(primary, -0.34).getHexString(),
          accentRing: '#' + shade(accent, 0.12).getHexString(),
          // 队徽：主队 = 队色实心圆 + 辅色粗描边；客队 = 辅色圆 + 队色描边。
          // 填充用"原始队色"而不是提亮档：提亮后在深色牌面上会读成一块发白的小圆点。
          homeFill0: '#' + primary.getHexString(),
          homeFill1: '#' + shade(primary, -0.16).getHexString(),
          homeRing: '#' + accent.getHexString(),
          awayFill0: '#' + accent.getHexString(),
          awayFill1: '#' + shade(accent, -0.20).getHexString(),
          awayRing: '#' + primary.getHexString(),
        },
        brand: {
          league: String(opts.clubName || 'FOOTBALL WORLD').slice(0, 14),
          leagueEn: 'FOOTBALL WORLD · MATCHDAY',
          leagueTag: 'MATCHDAY',
          side: '',
          venue: '',
        },
      });
      scoreboard = sb || null;
    } catch (e) { scoreboard = null; /* 静默降级 */ }
  })();

  // ── 通道口：已由 arena.js 的边线通道 + 上面的 resolveVomitory() 洞口统一实现。
  // 这里原来还有一条 legacy 支路（opts.detail 时把 vendor/taishan/tunnel.js 摆在 -z 球门后），
  // 它会和新通道**同时出现**（两条通道），而且位置正好压在球门/新洞口上。
  // 本轮删除该支路；`buildTunnel` 的导入也一并去掉（见文件头）。
  // 如果将来要恢复"看台下方的室内通道细节"，正确做法是给 resolveVomitory 增加洞口内侧的装饰层，
  // 而不是再摆一个独立的通道模型。

  // ── 角旗
  (function cornerFlags() {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xf0f4f8, roughness: 0.5 });
    const flagMat = new THREE.MeshStandardMaterial({ color: primary, roughness: 0.8, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), poleMat);
      pole.position.set(sx * (W / 2 - 0.3), 0.8, sz * (L / 2 - 0.3));
      group.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), flagMat);
      flag.position.set(sx * (W / 2 - 0.55), 1.42, sz * (L / 2 - 0.3));
      group.add(flag);
    }
  })();

  // 碰撞体：四条边线
  const halfW = W / 2 + baseInset - 2, halfL = L / 2 + baseInset - 2;
  colliders.push({ min: [-halfW, 0, -halfL], max: [halfW, 0, halfL] });

  // ── 天空与雾：四类球场共用同一套"顶部深、地平线浅"的结构，只换地平线色相，
  // 解决"亮光照在黑天上、看台像漂在虚空里"的割裂感。1 个穹顶 = 1 draw call。
  const skyPreset = skyForKind(kind);
  const sky = buildSkyDome(THREE, skyPreset, { radius: 420 });
  group.add(sky.mesh);

  return {
    kind,
    label: cfg.label,
    group,
    colliders,
    scoreboard,
    // 场馆补光（2 盏暖色点光）：暴露给 arena 的画质档位，
    // 低画质时关掉它们可以把逐片元光源从 7 盏降到 5 盏（纯渲染开销，不影响玩法）。
    lights: spots,
    spawn: { position: new THREE.Vector3(0, 0, halfL - 4), yaw: Math.PI, pitch: 0 },
    // arena 用它统一 fog / background：远处看台要溶进天际线，而不是撞到一块黑边
    atmosphere: { sky: sky.skyColor, horizon: sky.horizonColor, fog: sky.fogColor, dispose: sky.dispose },
    stats: {
      kinds: cfg, capacity: cap, halfW, halfL,
      seatRows,                            // 观众实例的真实台阶面（arena 用它让人坐进看台）
      vomitory: vom,                       // 通道口：arena 据此摆通道本体与出场点
      standDepth: ROWS * ROW_DEPTH,
      // ── 自由观赛（roam.js）用的派生尺寸：与几何同一份真源，不在 arena 里另写一套数字
      tiers: cfg.tiers, track: !!cfg.track,
      rows: ROWS, rowDepth: ROW_DEPTH, rowRise: ROW_RISE,
      baseInset, boardOff, tierGap, tierH,
      boardGaps: (opts && opts.boardGaps) || null,
    },
  };
}
