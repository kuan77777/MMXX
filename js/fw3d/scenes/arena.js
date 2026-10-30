// FW3D · 球场场景（P1/P2）：程序化球场 + 第一人称控制 + 镜头物理
// 数据来源：FW.state 中球员所属俱乐部的 stadium.capacity / colors / city
import { createPlayerModel } from '../character.js';
// 场上主裁判（低模，复用球员身体 + 红黄牌道具）
import { createReferee } from '../referee.js';
// 边裁（荧光黄衫 + 旗，沿边线跟球、举旗示意越位/界外球）
import { createLinesman } from '../linesman.js';
import { refAnchor } from '../ai/features.js';
// [players-subsystem] 外观数据层：真实球员资料覆盖 + NPC 确定性生成
import { appearanceFor, toMeshLook } from '../players/appearance.js';
import { likenessOf } from '../players/real-likeness.js';
import { buildStadiumByKind, pickKind, stadiumDerived, resolveVomitory } from '../stadium-kinds.js';
// 自由观赛（spectate）：可行走世界 + 替补席几何。roam.js 是纯逻辑（可 Node 直测），
// dugout.js 只画盒子 —— 两者的落位数字都来自 roam.dugoutLayout()，不各写一套。
import { buildRoam, ROAM, DUG, dugoutLayout, boardGapsFor } from '../roam.js';
import { buildDugout } from './dugout.js';
import { createTeamBrain } from '../ai/decision.js';
import { createConfig, applyDifficulty, applyStyle, STYLE_PRESETS } from '../ai/config.js';
import { createMatchState } from '../ai/match-state.js';
import { reducedShape } from '../ai/roles.js';
import { stepPlayer, maxSpeedOf, moveKindOf, tunedAttrs, motorProfile, ARCADE_TUNING } from '../ai/motor.js';
import { solvePass, solveShot, solveClear, solveLoft, keeperDistribution, headerDecision, resolveGoalFrame, ROLL_DECEL } from '../ai/kick.js';
import { judgeExit, setPieceTargets, isOffside, handballChance, HAND, trapZone } from '../ai/rules.js';
import { buildSnapshot } from '../ai/snapshot.js';
import { createDebugHud } from '../ai/debug.js';
import { deriveAttrs, fallbackAttrs } from '../ai/attrs.js';
import { tackleChance, DUEL, foulChance, freeKickWall, aerialDuel, secondSaveChance, slideTackleChance, getUpTime, SLIDE } from '../ai/duel.js';
import { cardChance, rollCard, addCard, bookOf, sentOffIds, cardTotals, isDogso } from '../ai/cards.js';
import { PENALTY, inPenaltyArea, penaltySpot, planPenalty, keeperGuessed, penaltyRing } from '../ai/penalty.js';
import { createShootout, nextShooter, recordKick, shootoutSummary, needsShootout, shootoutDecision, competitionKindOf, competitionRule } from '../ai/shootout.js';
import { addCardToRecord, normalize as normalizeDiscipline, isSuspended, filterAvailable, disciplineSummary } from '../ai/suspensions.js';
import { shouldSub, pickSub, SUBS } from '../ai/subs.js';
import { techOf } from '../ai/attrs.js';
import { sat, clamp } from '../ai/mathx.js';
import { buildPitchCore, PITCH as PITCH_SPEC } from '../pitch-core.js';
import { lightingFor } from '../atmosphere.js';
import { createInput, isTouchDevice } from '../input.js';

export async function start({ THREE, host, opts }) {
  // 设备分档：手机/平板自动降观众与阴影
  // 注意：横屏手机的内宽可能 >760，只看宽度会把横屏手机当高配；
  // 所以补一条「触摸设备」判据（平板横屏同理，按低配跑更稳）。
  const isMobile = (window.innerWidth || 1200) < 760 || isTouchDevice();
  const lowSpec = isMobile || (navigator.hardwareConcurrency || 8) <= 4;
  const deviceTier = lowSpec ? 'low' : 'high';

  // ── GPU 探测：软件渲染（SwiftShader / llvmpipe / 基本显示驱动）必须直接走最低画质，
  //    否则一帧要上百毫秒（实测 SwiftShader 下 7 FPS）。同时软件渲染关掉 MSAA：
  //    antialias 在 DPR 2 上是 4 倍采样 × 4 倍像素，是最大的一块填充率开销。
  //    探测用的临时 WebGL 上下文用完立刻释放，不会占用正式上下文的槽位。
  const gpuProbe = (function () {
    const out = { name: '', software: false };
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl') || null;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        out.name = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) {}
    out.software = /swiftshader|llvmpipe|softpipe|basic render|software rasterizer|microsoft basic/i.test(out.name);
    return out;
  })();
  const softwareGPU = gpuProbe.software;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);
  scene.fog = new THREE.Fog(0x0a0e14, 150, 460);

  const renderer = new THREE.WebGLRenderer({ antialias: !softwareGPU, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  renderer.shadowMap.enabled = !lowSpec;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(74, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.1, 500);
  camera.position.set(0, 1.68, 18);

  // ── 取俱乐部数据
  const FW = window.FW;
  let club = null;
  try {
    const p = FW && FW.state && FW.state.player;
    const id = (opts && opts.clubId) || (p && p.clubId);
    club = id && FW.state.clubs[id] ? FW.state.clubs[id] : null;
  } catch (e) {}
  const capacity = (club && club.stadium && club.stadium.capacity) || 30000;
  // 队色：opts 显式传入优先（换装/客场/多队配色测试），否则取主队颜色。
  // 球场配色由这两色派生（见 stadium-kinds.js 的 pal），所以这里必须是唯一入口。
  const primary = (opts && opts.primary) || (club && club.colors && club.colors.primary) || '#1f7a3f';
  const secondary = (opts && opts.secondary) || (club && club.colors && club.colors.secondary) || '#f2f4f7';

  // ── 草皮与标线：共用 PitchCore（设计包 00/05：三档协调绿 + 沿长轴修剪条纹 + 连续标线）
  // 注意：本文件后面还有一个名为 PITCH 的"场地包围盒"常量（AI 用），这里用 PITCH_SPEC 避免重名。
  const W = PITCH_SPEC.w, L = PITCH_SPEC.l;
  // ── 模式（自由观赛=以替补席第一视角看比赛，场上是 22 名 AI，玩家不参与）
  //    这里提前定，因为广告板/替补席的几何一旦建出来就不能再改（boardGaps 要传给 buildStadiumByKind）。
  const spectateMode = !!(opts && opts.mode === 'spectate');
  const SPECTATE_DUGZ = { '-1': 12, '1': 12 };   // 主队替补席在西侧、客队在东侧，都放在 z=12（正对，且离通道口 9 m，坐席左前方不会被通道墙糊住）
  const pitchCore = buildPitchCore(THREE, { w: W, l: L });
  scene.add(pitchCore.group);

  // ── 球门 7.32 × 2.44
  const postMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f8, roughness: 0.4 });
  const goalGroup = (z) => {
    const g = new THREE.Group();
    const h = 2.44, w = 7.32 / 2, r = 0.06;
    const post = (x) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), postMat);
      m.position.set(x, h / 2, 0); m.castShadow = true; g.add(m);
    };
    post(-w); post(w);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w * 2, 10), postMat);
    bar.rotation.z = Math.PI / 2; bar.position.set(0, h, 0); g.add(bar);
    const net = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, h, 1, 1), new THREE.MeshBasicMaterial({ color: 0xcfd8e2, transparent: true, opacity: 0.14, side: THREE.DoubleSide }));
    net.position.set(0, h / 2, -0.9); g.add(net);
    g.position.set(0, 0, z);
    return g;
  };
  const g1 = goalGroup(-L / 2), g2 = goalGroup(L / 2);
  g1.userData.mine = true; g2.userData.mine = true;
  scene.add(g1); scene.add(g2);

  // ── 球场：由容量选出类型（bowl / oval / athletics / community），配色取主队球衣
  const stadiumKind = (opts && opts.stadiumKind) || (club && club.stadium && club.stadium.kind) || pickKind(capacity);
  // 「可行走世界」的派生尺寸：与看台几何同一份真源（stadium-kinds.stadiumDerived），
  // 自由观赛按它解析地面高度/碰撞，不在这里另写一套数字。
  const spec = stadiumDerived(stadiumKind);
  const specVom = resolveVomitory({}, { w: W, l: L });
  // 广告板上的「技术区豁口」：只有自由观赛要（默认 null ⇒ 其它模式的球场几何完全不变）
  const spectateGaps = spectateMode
    ? boardGapsFor(W, spec.baseInset, [{ side: -1, z: SPECTATE_DUGZ['-1'] }, { side: 1, z: SPECTATE_DUGZ['1'] }], specVom ? specVom.half : 0, spec.track)
    : null;
  let built = null;
  let useTaishan = !!(opts && (opts.stadium === 'taishan' || opts.useTaishan));
  if (useTaishan) {
    try {
      const ts = await import('../taishan-stadium.js');
      const t = await ts.buildTaishanStadium(THREE, renderer);
      if (t && t.ok) {
        scene.add(t.group);
        built = { group: t.group, label: '泰山球场（真实几何）', stats: { halfW: W / 2 + 12, halfL: L / 2 + 14 } };
      }
    } catch (e) { useTaishan = false; }
  }
  // 泰山模式：隐藏我自己的草皮与球门，避免重叠
  const hideMine = !!(opts && (opts.stadium === 'taishan' || opts.useTaishan));
  if (!built) built = buildStadiumByKind(THREE, {
    kind: stadiumKind, capacity, primary: primary, secondary: secondary, detail: !!(opts && opts.detail),
    boardGaps: spectateGaps,
  });
  if (!useTaishan) scene.add(built.group);
  // ── 天空/雾统一：让远处看台溶进天际线，而不是撞到一块黑边（见 atmosphere.js）
  if (built.atmosphere) {
    try {
      scene.background = new THREE.Color(built.atmosphere.sky);
      if (scene.fog) { scene.fog.color.set(built.atmosphere.fog); scene.fog.near = 150; scene.fog.far = 420; }
    } catch (e) { /* 氛围层失败不影响比赛 */ }
  }
  // ── 观众：坐在**真实台阶面**上（此前是 y 随机 2.2–5.4 的悬空盒子，远看像撒在空中的白纸片）。
  // 行/排位置由 stadium-kinds 的 seatRows 提供。
  let crowdMesh = null;
  (function buildCrowd() {
    const rows = (built.stats && built.stats.seatRows) || [];
    const vom2 = (built.stats && built.stats.vomitory) || null;
    const seats = Math.max(400, Math.min(3200, Math.round(capacity / 12)));
    const geo = new THREE.BoxGeometry(0.36, 0.52, 0.30);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    crowdMesh = new THREE.InstancedMesh(geo, mat, seats);
    crowdMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const rnd = (a, b) => a + Math.random() * (b - a);
    // 观众配色：主队主色掺深灰/藏青/暗红，亮度压低且方差小。
    // 之前是 60% 主色 + 40% 近白（secondary）再乘 0.5–1.0，远处就是一片高对比白噪点。
    const shirt = new THREE.Color(primary).lerp(new THREE.Color(secondary), 0.18);
    const palette = [
      shirt, shirt.clone().multiplyScalar(0.82), new THREE.Color('#2b3138'),
      new THREE.Color('#1d2a3a'), new THREE.Color('#3a2b2b'), new THREE.Color('#46505c'),
    ];
    let placed = 0;
    if (rows.length) {
      for (let i = 0; i < seats; i++) {
        const row = rows[(Math.random() * rows.length) | 0];
        const along = rnd(-row.span, row.span);
        let x, z;
        if (row.k === 'end') { x = along; z = row.side * row.base; }
        else { x = row.side * row.base; z = along; }
        // 通道口附近不坐人（否则人墙浮在洞口上空）
        if (vom2 && row.k === 'side' && row.side * vom2.side > 0 && Math.abs(z - vom2.at) < vom2.half + 0.9) continue;
        m4.makeTranslation(x, row.y + 0.26, z);
        crowdMesh.setMatrixAt(placed, m4);
        col.copy(palette[(Math.random() * palette.length) | 0]).multiplyScalar(rnd(0.86, 1.06));
        crowdMesh.setColorAt(placed, col);
        placed++;
      }
    }
    // 没有 seatRows（例如泰山球场这类外部几何）时退化为环形分布，但同样贴地不悬空
    if (!placed) {
      const halfW = (built.stats && built.stats.halfW) || 40;
      const halfL = (built.stats && built.stats.halfL) || 58;
      for (let i = 0; i < seats; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const onEnd = (i % 4) < 2;
        const x = onEnd ? rnd(-halfW + 1, halfW - 1) : side * rnd(halfW - 2.5, halfW - 0.5);
        const z = onEnd ? side * rnd(halfL - 2.5, halfL - 0.5) : rnd(-halfL + 1, halfL - 1);
        m4.makeTranslation(x, rnd(2.2, 5.4), z);
        crowdMesh.setMatrixAt(placed, m4);
        col.copy(palette[(Math.random() * palette.length) | 0]).multiplyScalar(rnd(0.86, 1.06));
        crowdMesh.setColorAt(placed, col);
        placed++;
      }
    }
    crowdMesh.count = placed;
    crowdMesh.castShadow = false;
    crowdMesh.receiveShadow = false;
    crowdMesh.instanceMatrix.needsUpdate = true;
    if (crowdMesh.instanceColor) crowdMesh.instanceColor.needsUpdate = true;
    scene.add(crowdMesh);
  })();

  const bounds = built.stats || { halfW: W / 2, halfL: L / 2 };

  // ═══════════════════════════════════════════════════════════
  // 自由观赛（spectate）：可行走世界 + 走道地面 + 两个替补席
  //   · roam.js 给出「脚下多高 / 哪里是墙 / 哪里进不去」（纯逻辑，已经 Node 回归过）；
  //   · 这里只做两件场景事：补一块草皮外的走道地面（否则走到边线外脚下是天空），
  //     以及把替补席几何摆到 roam 算出来的同一个位置上。
  // ═══════════════════════════════════════════════════════════
  const VOMT = (built.stats && built.stats.vomitory) || { side: -1, at: 0, half: 3.0, inner: W / 2 + 1, outer: W / 2 + 17 };
  let roam = null, apronGroup = null;
  const dugoutObjs = [];
  if (spectateMode) {
    roam = buildRoam({
      w: W, l: L, track: spec.track,
      boardOff: spec.boardOff, baseInset: spec.baseInset,
      tiers: spec.tiers, rows: spec.rows, rowDepth: spec.rowDepth, rowRise: spec.rowRise,
      // 通道：与 arena 自己那段通道的几何一致（洞口外端 VOMT.outer，走廊半宽 2.6）
      tunnel: { x0: -VOMT.outer, x1: -VOMT.inner, half: 2.6 },
      dugouts: [{ side: -1, z: SPECTATE_DUGZ['-1'] }, { side: 1, z: SPECTATE_DUGZ['1'] }],
      gaps: spectateGaps,
    });
    // ── 草皮外的地面：草皮(到边线) → 走道/技术区 → 看台前沿。
    //    有跑道的球场（athletics）跑道本身已经铺到看台前沿，只补跑道外那一圈；
    //    没有跑道的球场从边线外就要补，否则人站在广告板边上时脚下是雾色天空。
    (function buildApron() {
      apronGroup = new THREE.Group();
      const innerX = spec.track ? W / 2 + 8 : W / 2;       // 跑道宽 8 m（stadium-kinds 的 trackW = W + 16）
      const innerZ = spec.track ? L / 2 + 8 : L / 2;
      const outerX = W / 2 + spec.baseInset + 2;
      const outerZ = L / 2 + spec.baseInset + 2;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(primary).multiplyScalar(0.30),
        roughness: 0.96, metalness: 0.02,
      });
      const slab = (w, d, x, z) => {
        // 用平面而不是薄盒子：草皮才是 0 面，走道抬高 12 mm 刚好在草皮之上、又不会和
        // 通道地面（0）打架；ROAM.apronY=0.02 让脚下比画面高 8 mm，肉眼看不出来。
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0.012, z);
        m.receiveShadow = true;
        apronGroup.add(m);
      };
      const wHalf = outerX - innerX, zLen = innerZ * 2;
      slab(wHalf, zLen, -(innerX + wHalf / 2), 0);         // 西
      slab(wHalf, zLen, innerX + wHalf / 2, 0);            // 东
      slab(outerX * 2, outerZ - innerZ, 0, innerZ + (outerZ - innerZ) / 2);    // 北
      slab(outerX * 2, outerZ - innerZ, 0, -(innerZ + (outerZ - innerZ) / 2)); // 南
      // 边线外那一圈（技术区/看台前沿）本该是连通的，四个角由上面四块自己 overlap 补上
      scene.add(apronGroup);
    })();
    // ── 两个替补席（主队在西侧、客队在东侧，位置由 roam.dugoutLayout 给出）
    for (const d of roam.dugouts) {
      const layout = dugoutLayout(W, spec.baseInset, d.side, d.z, { track: spec.track });
      const label = d.side < 0 ? ((club && club.name) || '主队') : '客队';
      const builtDug = buildDugout(THREE, {
        layout,
        primary: d.side < 0 ? primary : '#4a5568',
        secondary: secondary,
        title: label,
        sub: d.side < 0 ? 'DUGOUT · HOME' : 'DUGOUT · AWAY',
      });
      scene.add(builtDug.group);
      dugoutObjs.push({ side: d.side, layout, built: builtDug });
    }
  }

  // ── 灯光（色温跟随主场球衣，见 atmosphere.js 的 lightingFor）
  // 曝光修正（本轮）：原 1.45 + 2.4 = 3.85 的总照度把草坪绿通道推到接近 1.0，
  // 修剪条纹与看台明暗全被压平（截图里草坪是一整块平绿）。降到 1.15 + 2.0 = 3.15 后
  // 草纹、球员投影和看台的明暗关系才读得出来；泛光灯保持原亮度（夜场感来源）。
  // 颜色：队色只占 12–45%，太阳/泛光灯仍是白光为主，保证草皮还是绿的、球衣颜色不被带走。
  const LT = lightingFor(primary, secondary);
  const hemi = new THREE.HemisphereLight(new THREE.Color(LT.sky), new THREE.Color(LT.ground), 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(new THREE.Color(LT.sun), 2.0);
  sun.position.set(48, 70, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
  sun.shadow.camera.left = -45; sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
  scene.add(sun);
  for (const s of [-1, 1]) {
    const flood = new THREE.SpotLight(new THREE.Color(LT.flood), 520, 190, Math.PI / 4.2, 0.55, 1.4);
    flood.position.set(s * 40, 34, s * 40);
    flood.target.position.set(0, 0, 0);
    scene.add(flood); scene.add(flood.target);
  }

  // ── 足球（物理参数见设计文档 §10.1）
  const BALL = { r: 0.11, mass: 0.43, restitution: 0.72, rollDamp: 0.35, dragK: 0.0016, magnus: 0.00042, maxSpeed: 35 };
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL.r, 20, 16), new THREE.MeshStandardMaterial({ color: 0xf7f9fb, roughness: 0.6 }));
  ballMesh.castShadow = true;
  ballMesh.position.set(0, BALL.r, 0);
  scene.add(ballMesh);
  const ball = { pos: ballMesh.position, vel: new THREE.Vector3(), spin: new THREE.Vector3() };

  // ── 球员通道
  // 旧版沿 -z 从球门正后方出来（x=0, z 到 -L/2-1）：一是整根埋在看台实体里，出场视角被看台板
  // 完全遮死（整屏一块绿色）；二是出口正好落在球门中央，人会从球网里穿出来。
  // 现在改为真实球场做法：通道在西侧边线（中线位置）穿看台而出，看台上由 stadium-kinds
  // 用 vomitory 参数真的挖出洞口；通道本体沿 x 铺，出口底部对齐边线。
  const VOM = (built.stats && built.stats.vomitory) || { side: -1, at: 0, half: 3.0, top: 4.7, inner: W / 2 + 1, outer: W / 2 + 26 };
  const TW = 5.2, TH = 4.4;                  // 通道净宽 / 净高（与 ART_STYLE_GUIDE 一致）
  const TX_IN = -VOM.inner;                  // 洞口内端（靠球场）
  const TX_OUT = -VOM.outer;                 // 洞口外端（更深处，通道末端）
  const TZ = VOM.at;                         // 通道中心线所在 z（中线）
  const tunnelGroup = new THREE.Group();
  const tunnelLights = [];           // 通道灯默认关闭：前向渲染下每盏灯都会参与所有材质的逐片元光照
  scene.add(tunnelGroup);
  (function buildTunnel() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.92 });
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 0.85 });
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0x22272e, roughness: 0.95 });
    const len = Math.abs(TX_IN - TX_OUT);
    const cx = (TX_IN + TX_OUT) / 2;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(len, 0.2, TW), floorMat);
    floor.position.set(cx, -0.1, TZ); floor.receiveShadow = true; tunnelGroup.add(floor);
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(len, 0.2, TW), ceilMat);
    ceil.position.set(cx, TH, TZ); tunnelGroup.add(ceil);
    for (const sz of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(len, TH, 0.24), wallMat);
      wall.position.set(cx, TH / 2, TZ + sz * (TW / 2));
      wall.castShadow = true; wall.receiveShadow = true; tunnelGroup.add(wall);
      // 墙上的灯带（引导视觉向出口）
      for (let i = 0; i < 5; i++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.16, 0.06),
          new THREE.MeshBasicMaterial({ color: 0xfff0c8 }));
        strip.position.set(TX_OUT + 3 + i * (len / 5), 2.4, TZ + sz * (TW / 2 - 0.16));
        tunnelGroup.add(strip);
      }
    }
    // 末端封板：通道尽头不能看到外面的虚空
    const capMat = new THREE.MeshStandardMaterial({ color: 0x1c222a, roughness: 0.95 });
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.3, TH, TW), capMat);
    cap.position.set(TX_OUT - 0.15, TH / 2, TZ);
    tunnelGroup.add(cap);
    // 出口地面的入场标识（队色条带，便宜且能在第一人称里提供"到出口了"的锚点）
    const doorBand = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, TW - 0.6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(primary).getHex() }));
    doorBand.position.set(TX_IN - 0.7, 0.011, TZ);
    tunnelGroup.add(doorBand);
    // 出口光（发亮的门框，两端竖框 + 上框，避免"贴一张半透明面片"的廉价感）
    const archMat = new THREE.MeshBasicMaterial({ color: 0xdff0ff });
    for (const sz of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.12, TH - 0.4, 0.12), archMat);
      jamb.position.set(TX_IN, (TH - 0.4) / 2, TZ + sz * (TW / 2 - 0.12));
      tunnelGroup.add(jamb);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, TW - 0.2), archMat);
    lintel.position.set(TX_IN, TH - 0.4, TZ);
    tunnelGroup.add(lintel);
    // ── 标识与指引（真实俱乐部通道都有：队徽/队名 + 方向指引 + 比赛信息）
    // 用一张画布贴图做两块墙板，不引入外部素材；颜色沿用队色，保持全局配色一致。
    const clubLabel = (() => { try { return (club && club.name) || 'HOME'; } catch (e) { return 'HOME'; } })();
    const signTex = (title, sub) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 200;
      const g2 = c.getContext('2d');
      g2.fillStyle = '#' + new THREE.Color(primary).multiplyScalar(0.55).getHexString();
      g2.fillRect(0, 0, 512, 200);
      g2.fillStyle = '#' + new THREE.Color(primary).getHexString();
      g2.fillRect(0, 0, 18, 200);                     // 队色竖条
      g2.fillStyle = '#eef4fb';
      g2.font = '700 46px "Microsoft YaHei",system-ui,sans-serif';
      g2.textAlign = 'left'; g2.textBaseline = 'middle';
      g2.fillText(title, 40, 78);
      g2.fillStyle = 'rgba(226,236,248,.78)';
      g2.font = '600 30px "Microsoft YaHei",system-ui,sans-serif';
      g2.fillText(sub, 40, 138);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 2;
      return t;
    };
    const wallPanel = (tex, zSide, y) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.17),
        new THREE.MeshBasicMaterial({ map: tex }));
      // 贴在 z = TZ ± TW/2 的内侧墙面上，朝向走廊中心
      m.position.set(TX_OUT + len * 0.42, y, TZ + zSide * (TW / 2 - 0.14));
      m.rotation.y = zSide > 0 ? Math.PI : 0;
      tunnelGroup.add(m);
    };
    wallPanel(signTex(clubLabel, '→ 球场 PITCH'), 1, 1.95);
    wallPanel(signTex(clubLabel, 'MATCH DAY'), -1, 1.95);
    // 出口上方的方向指引（面向走廊内部，玩家朝出口走时正面读到）
    const dirBoard = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.02),
      new THREE.MeshBasicMaterial({ map: signTex('↑ 出场', 'TUNNEL EXIT') }));
    dirBoard.position.set(TX_IN - 0.3, TH - 0.62, TZ);
    dirBoard.rotation.y = -Math.PI / 2;
    tunnelGroup.add(dirBoard);
    // 沿走廊布光（暖色顶灯跟队色，出口冷光取辅色 → 与场内主光同一套色温体系）
    for (let i = 0; i < 4; i++) {
      const lamp = new THREE.PointLight(new THREE.Color(LT.warm), 9, 14, 2);
      lamp.position.set(TX_OUT + 4 + i * (len / 4), 3.6, TZ);
      tunnelGroup.add(lamp);
      tunnelLights.push(lamp);
    }
    const glow = new THREE.PointLight(new THREE.Color(LT.rim), 16, 22, 2);
    glow.position.set(TX_IN + 2.5, 2.6, TZ);
    tunnelGroup.add(glow);
    tunnelLights.push(glow);
    for (const l of tunnelLights) l.visible = false;
  })();

  // ── 玩家个性化（号码/姓名/球鞋/肤色/惯用脚/庆祝动作）
  const persona0 = Object.assign({
    number: null, name: '', boot: '#14161a', skin: '#b0805e', dominantFoot: 'right', celebrate: 'arms'
  }, (opts && opts.appearance) || {});
  const persona = persona0;
  function hexToNum(v, fallback) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v)) return parseInt(v.replace('#', ''), 16);
    return fallback;
  }

  // ── 场上球员：双方各 11 人。阵容来自真实俱乐部名单（FW.state.players），
  //    站位是 4-3-3 基准点，实际位置由 AI 的 PlayerMotor 驱动（见文件末尾 ai 段）。
  const SLOTS = ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'AM', 'LW', 'ST', 'RW'];
  const SHAPE_HOME = [
    [0, -46], [-22, -28], [-8, -30], [8, -30], [22, -28],
    [-16, -10], [0, -12], [16, -10], [-2.6, 2], [0, 3.2], [14, 8],
  ];
  const chars = [];
  // 自由观赛用：替补席上坐着的人（不进 agents，不参与 AI / 碰撞，只是"坐着看球"）
  const sitting = [];
  let meBench = null;          // 你自己的坐姿身体（第一人称下隐藏，V 检视时才看得到）
  const agents = [];
  const agentsById = Object.create(null);
  const AI_ENABLED = true;              // 关掉就回到旧的"原地巡逻"演示
  let homeLabel = '主队', awayLabel = '客队';
  // 场上主裁判实例（比赛模式创建；只在场景外层声明，内部赋值，供 foulExit / giveCard / update 使用）
  let referee = null;
  // 两名边裁（+x / -x 边线各一名）
  const linesmen = [];
  // 替补席（每队最多 3 个换人名额）：外层声明，供 doSubNow / autoSubTick / 自检读取
  const bench = { home: [], away: [] };
  // 队服/共享缓存引用（在比赛模式块内创建，外层 makeSubAgent 也要用；避免再踩一次作用域坑）
  let kitCtx = null;

  // 赛事类型（决定能不能点球大战）：显式标记 > 时间线的赛事名 > 默认按联赛
  // **规定：联赛/友谊赛没有点球大战，平局就是平局。**
  function competitionKind() {
    try {
      if (window.__FW3D_COMP_KIND) return competitionKindOf({ kind: String(window.__FW3D_COMP_KIND) });
      const tl = window.__FW3D_TIMELINE || (window.FW && FW.matchTimeline ? FW.matchTimeline() : null);
      if (tl) return competitionKindOf({ competition: tl.competition, knockout: tl.knockout });
    } catch (e) {}
    return 'league';
  }

  // 纪律档案（牌面跨场累积）：存在 FW.state.fw3dDiscipline 里。
  // FW.saveState() 会把整个 FW.state 序列化，所以它天然随存档走，不需要另开存储。
  function disciplineStore() {
    try {
      const st = window.FW && FW.state;
      if (!st) return {};
      if (!st.fw3dDiscipline || typeof st.fw3dDiscipline !== 'object') st.fw3dDiscipline = {};
      return st.fw3dDiscipline;
    } catch (e) { return {}; }
  }
  (function spawnSquad() {
    const FWd = window.FW;
    const db = (FWd && FWd.state && FWd.state.players) || {};
    const meP = (FWd && FWd.state && FWd.state.player) || null;
    const POS_PREF = {
      GK: ['GK'], LB: ['LB', 'CB', 'CM'], CB: ['CB', 'LB', 'RB', 'CM'], RB: ['RB', 'CB', 'CM'],
      CM: ['CM', 'AM', 'CB'], AM: ['AM', 'CM', 'ST', 'LW', 'RW'], LW: ['LW', 'RW', 'AM', 'ST'],
      ST: ['ST', 'AM', 'LW', 'RW'], RW: ['RW', 'LW', 'AM', 'ST'],
    };
    function pickXI(club, skipId) {
      // 停赛的球员不选（牌面跨场累积存在 FW.state.fw3dDiscipline，随存档一起走）
      const reg = disciplineStore();
      const ids = (club && club.playerIds) || [];
      const allowed = filterAvailable(ids, reg).available;
      const pool = allowed.map((id) => db[id]).filter(Boolean)
        .filter((p) => !skipId || p.id !== skipId);      // 自由观赛：你自己坐在替补席，不占首发
      if (!pool.length) { const raw = ids.map((id) => db[id]).filter(Boolean); pool.push(...raw); }
      const used = Object.create(null);
      return SLOTS.map((pos) => {
        let best = null, bestScore = -1;
        for (const p of pool) {
          if (used[p.id]) continue;
          const idx = (POS_PREF[pos] || []).indexOf(p.position);
          if (idx < 0) continue;
          const score = 100 - idx * 12 + (Number(p.ca) || 50) * 0.1;
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (!best) {
          for (const p of pool) {
            if (used[p.id]) continue;
            const score = Number(p.ca) || 50;
            if (score > bestScore) { bestScore = score; best = p; }
          }
        }
        if (best) used[best.id] = 1;
        return { pos, src: best };
      });
    }
    // 对手：优先取最近一场联赛的对手俱乐部，否则取同联赛另一支
    let awayClub = null;
    try {
      const st = FWd && FWd.state;
      const clubId = club && club.id;
      const list = ((st && st.matches) || []).filter((m) => !m.national && (m.homeClubId === clubId || m.awayClubId === clubId));
      const last = list[list.length - 1];
      let oppId = last ? (last.homeClubId === clubId ? last.awayClubId : last.homeClubId) : null;
      if (!oppId && club && st) {
        const lg = (st.leagues || []).find((l) => l.id === club.leagueId);
        oppId = (lg && (lg.clubIds || []).find((id) => id !== clubId)) || null;
      }
      awayClub = (oppId && st.clubs[oppId]) || null;
    } catch (e) {}

    const lum = (hex) => { const c = new THREE.Color(hex); return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; };
    let awayPrimary = (awayClub && awayClub.colors && awayClub.colors.primary) || '#243040';
    if (Math.abs(lum(awayPrimary) - lum(primary)) < 0.16) awayPrimary = '#1b2430';
    const awayShortsHex = (awayClub && awayClub.colors && awayClub.colors.secondary) || '#12181f';
    homeLabel = (club && club.name) || '主队';
    awayLabel = (awayClub && awayClub.name) || '客队';

    const shirts = {
      home: new THREE.Color(primary).getHex(),
      away: new THREE.Color(awayPrimary).getHex(),
    };
    // 球员模型共享缓存（材质按颜色/粗糙度、几何按尺寸复用）；随场景 dispose 一起丢弃
    const modelCache = new Map();
    const shorts = { home: new THREE.Color(secondary).getHex(), away: new THREE.Color(awayShortsHex).getHex() };
    const skins = [0xb0805e, 0x8d5f43, 0xd9ae86, 0x6f4a33];
    kitCtx = { shirts, shorts, skins, modelCache };   // 外层 makeSubAgent 复用（替补也用同队队服/同一份材质缓存）
    // 自由观赛：首发里必须没有"你"（你坐在替补席），所以按 id 排除；其它模式照旧
    const xi = { home: pickXI(club, spectateMode && meP ? meP.id : null), away: pickXI(awayClub) };
    // 换人名单（每队最多 3 个名额）：本队名单里排除首发、停赛、门将后的高能力球员
    // 注意：bench 在外层已声明（const bench = { home: [], away: [] }），这里只赋值，避免作用域丢失
    try {
      const reg = disciplineStore();
      for (const teamKey of ['home', 'away']) {
        const c = teamKey === 'home' ? club : awayClub;
        const xiIds = new Set(xi[teamKey].map((s) => (s && s.src && s.src.id) || null).filter(Boolean));
        bench[teamKey] = (((c && c.playerIds) || []).map((id) => db[id]).filter(Boolean))
          .filter((p) => !xiIds.has(p.id) && !isSuspended(reg[p.id]) && String(p.position || '').toUpperCase() !== 'GK')
          .sort((a, b) => (Number(b.ca) || 0) - (Number(a.ca) || 0))
          .slice(0, 6);
      }
    } catch (e) { bench.home = []; bench.away = []; }
    // 场上主裁判（低模）：与球员共用材质/几何缓存；用 mid 细节省 draw call
    try {
      if (!opts || opts.referee !== false) {
        referee = createReferee(THREE, { cache: modelCache, detail: 'mid' });
        scene.add(referee.object);
        referee.object.position.set(3.2, 0, -6);
      }
      // 两名边裁（荧光黄衫 + 旗）：沿两条边线跟球、举旗示意越位/界外球/角球
      if (!opts || opts.linesmen !== false) {
        for (const sd of [1, -1]) {
          const lm = createLinesman(THREE, { side: sd, cache: modelCache, detail: 'mid' });
          scene.add(lm.object);
          linesmen.push(lm);
        }
      }
    } catch (e) { referee = null; }

    // ── 自由观赛：替补席上真的要坐人（每边 4 名替补 + 你自己坐主队第 1 个位子）
    //    他们不进 agents（不参与 AI、不吃碰撞），只做"坐着看球"的静态角色 + 坐姿动画。
    if (spectateMode) {
      try {
        for (const d of dugoutObjs) {
          const teamKey = d.side < 0 ? 'home' : 'away';
          const list = (bench[teamKey] || []).slice(0, 4);
          list.forEach((p, i) => {
            const seat = d.built.seats[i + 1];
            if (!seat) return;
            const c = makeSitter(teamKey, p, seat, false);
            if (c) d.built.group.add(c.model.object);
          });
        }
        const homeDug = dugoutObjs.find((d) => d.side < 0);
        if (homeDug && homeDug.built.seats[0]) {
          meBench = makeSitter('home', meP || { name: '你', number: 9, position: 'ST' }, homeDug.built.seats[0], true);
          if (meBench) homeDug.built.group.add(meBench.model.object);
        }
      } catch (e) { /* 替补席上的人失败不影响比赛 */ }
    }

    for (const teamKey of ['home', 'away']) {
      const shape = teamKey === 'home' ? SHAPE_HOME : SHAPE_HOME.map(([x, z]) => [-x, -z]);
      xi[teamKey].forEach((slot, i) => {
        const isMe = !spectateMode && teamKey === 'home' && i === 9;
        const pos = slot.pos;
        const isGk = pos === 'GK';
        const src = slot.src;
        let attrs, name, number;
        if (isMe && meP) {
          attrs = deriveAttrs(meP);
          name = String(persona.name || meP.name || '你');
          number = Number(persona.number || meP.number || 9);
        } else if (src) {
          attrs = deriveAttrs(src);
          name = src.name || '';
          number = Number(src.number) || (i + 1);
        } else {
          attrs = fallbackAttrs(teamKey.charCodeAt(0) * 100 + i, pos);
          name = '';
          number = i + 1;
        }
        const model = createPlayerModel(THREE, {
          jersey: isMe ? 0xf2f5f8 : shirts[teamKey],
          shorts: shorts[teamKey],
          number,
          name: isMe ? name : '',
          skin: isMe ? hexToNum(persona.skin, 0xb0805e) : skins[i % 4],
          boot: isMe ? hexToNum(persona.boot, 0x14161a) : 0x14161a,
          dominantFoot: isMe ? (persona.dominantFoot || 'right') : 'right',
          cache: modelCache,          // 22 人共享材质/几何（每场一份，随场景释放）
          // [players-subsystem] 每名球员一份确定性外观（同 id 同外观，跨场景/读档不变）
          appearance: (() => {
            const rec = src || { id: (teamKey === 'home' ? 'H' : 'A') + '-slot' + i, position: pos, age: 25 };
            const id = rec.id || ((teamKey === 'home' ? 'H' : 'A') + '-slot' + i);
            const app = appearanceFor(Object.assign({}, rec, { id }), {
              overrides: likenessOf(rec),   // 记录对象优先用 realPlayerId（P326 → REAL-erling-haaland）
              kit: {
                jersey: isMe ? 0xf2f5f8 : shirts[teamKey],
                shorts: shorts[teamKey],
                accent: isMe ? 0x2c3440 : shorts[teamKey],
                boot: isMe ? hexToNum(persona.boot, 0x14161a) : 0x14161a,
                socks: 0x14161a,
                number,
                gk: isGk,
              },
            });
            // 玩家在「外观设置」里手改的项优先（肤色/发型），否则沿用生成结果
            if (isMe) {
              if (typeof persona.skin === 'string' && /^#?[0-9a-f]{6}$/i.test(persona.skin)) app.skin_tone = parseInt(persona.skin.replace('#', ''), 16);
              if (persona.hairStyle && persona.hairStyle !== 'short') app.hair_style = persona.hairStyle === 'none' ? 'bald' : persona.hairStyle;
              app.source = 'user';
            }
            return app;
          })(),
          detail: (teamKey === 'home' && i === 9) ? 'full' : 'full',
        });
        const [x, z] = shape[i];
        model.object.position.set(x, 0, z);
        const facing = teamKey === 'home' ? 0 : Math.PI;
        model.object.rotation.y = facing;
        scene.add(model.object);
        const agent = {
          id: teamKey + '-' + i,
          team: teamKey, slot: i, pos, name, number,
          x, z, vx: 0, vz: 0, facing,
          stamina: 100, attrs,
          isUser: isMe, isGk,
          shape: { x, z },
          animT: i * 0.7,
          model,
        };
        agents.push(agent);
        agentsById[agent.id] = agent;
        chars.push({
          model, agent, isMe, team: teamKey,
          walk: 0.6 + (i % 3) * 0.5, base: z, phase: i * 0.7,
        });
      });
    }
  })();
  // ── 头顶姓名牌：己方白字 / 对手红字（玩家本人不标，避免镜头贴脸时糊屏）
  // 名字取自 records（真实球员给的是中文名），所以 3D 里看到的就是"厄德高""张琳芃"这种。
  let nameTagMode = 'all';   // all | team | off  （N 键循环）
  const applyNameTags = () => {
    const me = agents.find(function (a) { return a.isUser; });
    const myTeam = me ? me.team : null;
    for (const a of agents) {
      try {
        if (!a.model || !a.model.setNameTag) continue;
        const isMyTeam = myTeam && a.team === myTeam;
        const color = isMyTeam ? '#f4f7fa' : '#e88079';
        if (!a.name) { a.model.setNameTag(''); continue; }
        if (a.isUser || nameTagMode === 'off' || (nameTagMode === 'team' && !isMyTeam)) {
          a.model.showNameTag(false);
        } else {
          a.model.setNameTag(a.name, color);
          a.model.showNameTag(true);
        }
      } catch (e) {}
    }
  };
  const cycleNameTags = () => {
    nameTagMode = nameTagMode === 'all' ? 'team' : nameTagMode === 'team' ? 'off' : 'all';
    applyNameTags();
    return nameTagMode;
  };
  const nameTagState = () => {
    let total = 0, visible = 0;
    for (const a of agents) {
      if (!a.model || !a.model.hasNameTag || !a.model.hasNameTag()) continue;
      total++;
      const info = a.model.nameTagInfo ? a.model.nameTagInfo() : null;
      if (info && info.visible) visible++;
    }
    return { mode: nameTagMode, tagged: visible, visible: visible, total: total };
  };
  applyNameTags();   // 开场即挂好姓名牌
  // 姓名牌随距离缩放：屏幕占用尽量恒定，远了也能读；超过 70 m 直接隐藏（避免糊成一片）
  let nameTagTimer = 0;
  const NAME_TAG_NEAR = 0.7, NAME_TAG_FAR = 3.6;
  // 姓名牌隐藏距离由画质档位控制（低画质只显示近处，省 draw call）
  let nameTagHide = 62;
  const updateNameTagScale = (dt, cam) => {
    nameTagTimer += (dt || 0);
    if (nameTagTimer < 0.2 || !cam) return;
    nameTagTimer = 0;
    for (const a of agents) {
      if (!a.model || !a.model.setNameTagScale || !a.model.hasNameTag || !a.model.hasNameTag()) continue;
      if (a.isUser || nameTagMode === 'off' || (nameTagMode === 'team' && !isMyTeamAgent(a))) continue;
      const p = a.model.object.position;
      const dx = cam.position.x - p.x, dy = cam.position.y - (p.y + 2.04), dz = cam.position.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > nameTagHide) { a.model.showNameTag(false); continue; }
      a.model.showNameTag(true);
      a.model.setNameTagScale(Math.max(NAME_TAG_NEAR, Math.min(NAME_TAG_FAR, d * 0.072)));
    }
  };
  const isMyTeamAgent = (agent) => {
    const me = agents.find(function (x) { return x.isUser; });
    return !!(me && agent.team === me.team);
  };
  let elapsed = 0;
  let lodTimer = 0;   // [players-subsystem] LOD 采样计时

  // ── 第一人称控制器（§10.2）
  const P = {
    speedAttr: 70,
    walk: 1.6, jog: 4.0, sprint: 8.5,
    accel: 0.6, stopDist: 1.2, radius: 0.32, eye: 1.68,
    turnInertia: 0.14,
  };
  try {
    const pl = FW && FW.state && FW.state.player;
    if (pl && pl.stats) P.speedAttr = Number(pl.stats.speed) || 70;
  } catch (e) {}
  const sprMax = P.sprint * (0.72 + P.speedAttr / 100 * 0.5);
  const tunnelMode = (opts && opts.mode === 'tunnel' || opts && opts.mode === 'match');
  const matchMode = (opts && opts.mode === 'match');
  const tourMode = (opts && opts.mode === 'tour');
  // 只保留"哪些时间线事件已经播过"的打点；比赛时间/比分权威在 matchState（见文件末尾 ai 段）
  const matchClock = { fired: null };
  // 操控档位：full=全程操控，key=关键时刻才交还控制，cinematic=只控视角
  let savedControl = null;
  try { savedControl = localStorage.getItem('fw3d.control'); } catch (e) {}
  let ctrlMode = (opts && opts.control) || window.__FW3D_CONTROL || savedControl || 'full';
  const keyMoment = { active: false, t: 0 };
  let autonomousTarget = null;   // 1 秒约 1.6 分钟
  let scoreHud = null, fullTimeHud = null, tacticsHud = null, specHint = null;
  if (matchMode || spectateMode) {
    scoreHud = document.createElement('div');
    scoreHud.style.cssText = 'position:absolute;top:52px;left:50%;transform:translateX(-50%);display:flex;gap:14px;align-items:center;padding:7px 18px;border-radius:12px;background:rgba(6,9,14,.72);border:1px solid rgba(255,255,255,.12);color:#e8eef8;font:600 15px/1 system-ui,sans-serif;z-index:3';
    host.appendChild(scoreHud);
    fullTimeHud = document.createElement('div');
    fullTimeHud.style.cssText = 'position:absolute;inset:0;display:none;place-items:center;background:rgba(4,6,10,.72);z-index:4;color:#eef3fb;font:700 34px/1.4 system-ui,sans-serif;text-align:center';
    host.appendChild(fullTimeHud);
    // 战术胶囊：战术只在"比赛进行中"才有意义，所以放在这里而不是 2D 主界面。
    // 显示当前风格 + T 键提示，点击也能切换（触屏没有键盘）。
    tacticsHud = document.createElement('div');
    tacticsHud.id = 'fw3d-tactics-hud';
    tacticsHud.style.cssText = 'position:absolute;top:52px;right:14px;display:flex;align-items:center;gap:8px;'
      + 'padding:7px 12px;border-radius:11px;background:rgba(6,9,14,.72);border:1px solid rgba(255,255,255,.14);'
      + 'color:#dfe6f2;font:600 12.5px/1 system-ui,sans-serif;z-index:3;cursor:pointer;user-select:none';
    tacticsHud.onclick = () => { cycleStyle(); };
    host.appendChild(tacticsHud);
  }
  // 自由观赛的轻提示条：坐/站切换、撞到禁区、进球裁定都走这里（不新增常驻 UI）
  if (spectateMode) {
    specHint = document.createElement('div');
    specHint.id = 'fw3d-spectate-hint';
    specHint.style.cssText = 'position:absolute;left:50%;bottom:62px;transform:translateX(-50%);'
      + 'padding:7px 14px;border-radius:10px;background:rgba(6,9,14,.66);border:1px solid rgba(255,255,255,.12);'
      + 'color:#dfe6f2;font:600 12.5px/1.45 system-ui,sans-serif;z-index:3;pointer-events:none;'
      + 'opacity:0;transition:opacity .2s;text-align:center;max-width:78vw';
    host.appendChild(specHint);
  }
  /** 观赛提示（同一条 DOM，多次触发只刷新文字与计时） */
  function toast(msg, ms) {
    if (!specHint) return null;
    specHint.textContent = msg;
    specHint.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { if (specHint) specHint.style.opacity = '0'; }, ms || 2200);
    return msg;
  }
  /** 同步战术胶囊文案（setTactics / T 键 / 开场都要调） */
  function syncTacticsHud() {
    if (!tacticsHud) return;
    const key = (A && A.team && A.team.style) || 'balanced';
    const label = (STYLE_PRESETS[key] || {}).label || key;
    const press = A && A.team ? Math.round((A.team.pressMul || 1) * 100) : 100;
    tacticsHud.innerHTML = '<span style="opacity:.6;letter-spacing:.06em">战术</span>'
      + '<b style="font-size:13px">' + label + '</b>'
      + '<span style="opacity:.5">压迫 ' + press + '%</span>'
      + '<span style="opacity:.38">T 切换</span>';
    tacticsHud.title = '战术风格：' + label + '（点击或按 T 切换）';
  }
  const ctrl = {
    // 通道模式从通道末端起步，朝 +x（球场方向）走；yaw=-π/2 ⇒ forward=(1,0,0)
    pos: new THREE.Vector3(tunnelMode ? (TX_OUT + 2.4) : 20, 0, tunnelMode ? TZ : 20),
    vel: new THREE.Vector3(),
    yaw: tunnelMode ? -Math.PI / 2 : 0, pitch: 0,
    keys: Object.create(null),
    stamina: 100,
    // 自由观赛专用：脚下地面高度 / 本帧被什么挡住（其它模式恒为 0 与 null）
    groundY: 0, hit: null, lastHit: null, lastHitAt: 0,
    // 跳跃产生的离地高度（米）。玩家没有这条通道就永远顶不到 1.4 m 以上的球：
    // 以前 ctrl.pos.y 从来不参与，头球又硬排除了 isUser，所以"玩家头球"在系统里不存在。
    air: 0,
  };
  const camState = { bobT: 0, fov: 74, shake: 0, eye: P.eye };
  // 跳跃参数：0.62 s 起跳—落地，最高 0.52 m（够到 2.1 m 左右的头球点）。
  // 纯运动学抛物线，不进物理积分 —— 足球游戏里的跳跃本来就是"表现 + 判定窗口"，不是真弹道。
  const JUMP = { dur: 0.62, h: 0.52 };
  const jump = { active: false, t: 0 };

  // ── 自由观赛：出生在本队替补席上（坐着看球），C 键起立/坐下
  const seatHome = spectateMode && roam && roam.seats.home ? roam.seats.home : null;
  let seated = !!seatHome;
  if (seatHome) {
    ctrl.pos.set(seatHome.seatX, 0, seatHome.z);
    ctrl.groundY = seatHome.platform;
    ctrl.yaw = seatHome.yaw;
    camState.eye = ROAM.eyeSit;
  }
  /** 找最近的座位（只认替补席上的 5 个座位，2.4 m 内才算"想坐下"） */
  function nearestSeat(x, z) {
    let best = null, bd = 1e9;
    for (const d of dugoutObjs) {
      for (const s of d.built.seats) {
        const dd = Math.hypot(s.x - x, s.z - z);
        if (dd < bd) { bd = dd; best = { seat: s, dug: d }; }
      }
    }
    return best && bd <= 2.4 ? best : null;
  }
  function sitDown() {
    if (!spectateMode) return { ok: false, reason: 'not-spectate' };
    if (seated) return { ok: true, seated: true, already: true };
    const hit = nearestSeat(ctrl.pos.x, ctrl.pos.z);
    if (!hit) {
      // 只认"走回替补席"这一种坐下的方式 —— 站在场边按 C 不该瞬移回座位
      toast('要坐回替补席才能坐下（走到替补席前按 C）', 2400);
      return { ok: false, reason: 'far', x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2) };
    }
    const s = hit.seat;
    ctrl.pos.set(s.x, 0, s.z);
    ctrl.vel.set(0, 0, 0);
    ctrl.groundY = s.y;
    ctrl.yaw = s.yaw;
    ctrl.pitch = Math.max(-0.45, Math.min(0.45, ctrl.pitch));
    seated = true;
    try { input.sitLabel(true); } catch (e) {}
    toast('坐下 · C 起立 · 左右转头看看四周');
    return { ok: true, seated: true, x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2), y: s.y };
  }
  function standUp() {
    if (!spectateMode) return { ok: false, reason: 'not-spectate' };
    if (!seated) return { ok: true, seated: false, already: true };
    const hit = nearestSeat(ctrl.pos.x, ctrl.pos.z);
    const dug = hit ? hit.dug : (dugoutObjs.find((d) => d.side < 0) || null);
    const standX = dug ? dug.layout.standX : (seatHome ? seatHome.standX : 20);
    const z = hit ? hit.seat.z : (seatHome ? seatHome.z : 0);
    seated = false;
    const g = roam.ground(standX, z) || { y: ROAM.apronY };
    ctrl.pos.set(standX, 0, z);
    ctrl.groundY = g.y;
    ctrl.vel.set(0, 0, 0);
    try { input.sitLabel(false); } catch (e) {}
    toast('起立 · WASD 走动 · 场上进不去 · C 坐回替补席');
    return { ok: true, seated: false, x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2), y: g.y };
  }
  function toggleSit() { return seated ? standUp() : sitDown(); }


  const charge = { on: false, t: 0, max: 0.95 };
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:50%;bottom:74px;transform:translateX(-50%);width:220px;height:8px;background:rgba(255,255,255,.16);border-radius:99px;overflow:hidden;opacity:0;transition:opacity .16s;z-index:3';
  const hudFill = document.createElement('div');
  hudFill.style.cssText = 'height:100%;width:0;background:linear-gradient(90deg,#5ad1a0,#ffd166,#ff6b6b);border-radius:99px';
  hud.appendChild(hudFill);
  const hudMark = document.createElement('div');
  hudMark.style.cssText = 'position:absolute;top:-3px;width:3px;height:14px;background:#fff;border-radius:2px;opacity:0';
  hud.appendChild(hudMark);
  const hudZone = document.createElement('div');
  let diffWindow = 0.18;
  try { if (window.FW && FW.difficultyProfile) diffWindow = FW.difficultyProfile().window || 0.18; } catch (e) {}
  hudZone.style.cssText = 'position:absolute;top:0;height:100%;left:' + ((0.5 - diffWindow) * 100) + '%;width:' + (diffWindow * 200) + '%;background:rgba(90,209,160,.55)';
  hud.appendChild(hudZone);
  host.appendChild(hud);

  const ballFlat = () => TMP_A.set(ball.pos.x, 0, ball.pos.z);
  const myFlat = () => TMP_B.set(ctrl.pos.x, 0, ctrl.pos.z);
  // 玩家的"脚下"半径：出脚与「我有没有球」共用同一个数。
  // 旧实现里 tryKick 写死 2.2，而 playerOnBall 只看 ownerId，两个判据不是一回事 ——
  // 结果就是「能踢但界面说你无球」，手机端射门键因此长期是滑铲键。
  const PLAYER_REACH = 2.2;
  // 出脚保护窗口：这段时间球权不回到自己身上。
  // 否则带球吸附会在出脚后的下一帧把球按回脚下，表现为「按了射门却没出脚」。
  const PLAYER_KICK_LOCK = 0.5;
  // 射门的出脚方式（电脑 / 平板 / 手机通用）：
  //   球高于 HEAD_SHOT_MIN_Y → 一定是头球（这种高度用脚根本够不着，是旧实现的一个漏洞：
  //   tryKick 只按水平距离判定，2 m 高的球也能"用脚踢"）；
  //   低球则按 HEAD_SHOT_CHANCE 掷一次骰子 → 玩家的射门不再永远是一个摆腿动画。
  // 想调"头球多不多"只改这两个数。
  const HEAD_SHOT_MIN_Y = 1.2;
  const HEAD_SHOT_CHANCE = 0.35;

  function canShoot() {
    if (spectateMode) return false;      // 观赛：你不是场上球员 —— 球滚到脚边也不能踢
    if (ctrlMode === 'full') return true;
    if (ctrlMode === 'cinematic') return false;
    return keyMoment.active;
  }

  // 玩家出脚后的统一登记：射门 / 短传 / 长传共用。
  // 旧实现的射门一件都没做，于是玩家的每一次触球在比赛状态里都不存在：
  //   ① 清球权：否则带球吸附会在下一帧把球拉回脚下（表现为「按了射门却没出脚」）
  //   ② 最后触球：否则球出了边线，界外球/角球/球门球仍判给上一位触球的 AI（判罚会反过来）
  //   ③ 出脚时间：PLAYER_KICK_LOCK 的起点
  function registerUserKick(kind, power, noPose) {
    const me = playerAgent();
    if (me) {
      setOwner(null);
      ball.lastKicker = me.id;
      ball.lastKickAt = elapsed;
      ms.touch(me.id, me.team, elapsed, kind || 'userKick');
    }
    actionStats.userKick = (actionStats.userKick || 0) + 1;
    if (kind && kind !== 'userKick') actionStats[kind] = (actionStats[kind] || 0) + 1;
    // 头球有自己的颈部动作，不要再叠一个踢球摆腿（两个 one-shot 会互相抢关节）
    if (noPose) return;
    const m = chars.find((c) => c.isMe);
    if (m && m.model && m.model.kick) m.model.kick(power == null ? 0.7 : power);
  }

  // 射门：出脚方式在「头球 / 脚踢」之间二选一（球高决定下限，低球随机）。
  // forceFoot=true 用于"轻推传球"那种需要脚出球的场合，不参与掷骰子。
  function tryKick(ratio, accuracy, forceFoot) {
    if (!canShoot()) return false;
    if (ballFlat().distanceTo(myFlat()) > PLAYER_REACH) return false;
    const acc = accuracy == null ? 0.8 : accuracy;
    const err = (1 - acc) * 0.42;                 // 最大 ±24°
    const dir = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() * 2 - 1) * err);
    const power = 12 + ratio * 23;
    const headShot = !forceFoot && (ball.pos.y >= HEAD_SHOT_MIN_Y || Math.random() < HEAD_SHOT_CHANCE);
    if (headShot) {
      // 触球面 'head'：垂直分量小（+1.4）、旋转衰减到 40% —— 头球本来就比脚背球更"死"
      kickBall(dir, power * 0.9, 'head');
      registerUserKick('userKick', 0.8, true);    // noPose：不播摆腿，改播颈部前甩
      const mh = chars.find((c) => c.isMe);
      if (mh && mh.model && mh.model.headerPose) mh.model.headerPose();
      actionStats.userHeadShot = (actionStats.userHeadShot || 0) + 1;
    } else {
      const surface = ratio > 0.66 ? 'back' : ratio > 0.33 ? 'inside' : 'outside';
      kickBall(dir, power, surface);
      registerUserKick('userKick', 0.6 + ratio * 0.8);
      actionStats.userFootShot = (actionStats.userFootShot || 0) + 1;
    }
    return true;
  }

  // ── 玩家传球（第②项补的能力：以前玩家只会"朝前踢一脚"，没有任何目标选择）────
  //   短传（F / 左键）：视线锥内挑一名队友，走 solvePass 的地滚球解算；没人可传就朝视线方向轻推
  //   长传（G / 中键）：不论距离一律走 solveLoft 的抛射解算，可以过顶、可以传中
  //   传中：在进攻三区的边路按长传 → 如果禁区里没人接应，落点自动送到点球点附近
  function playerPassingAttrs(me) {
    return {
      attrs: me.attrs,
      pressure: clamp((me.pressure == null ? 0.35 : me.pressure), 0, 1),
      cfg: A,
    };
  }
  // 视线锥内挑一名队友：越靠前、越空、越在视野中央、线路上越没人越好
  function pickPassTarget(long) {
    const me = playerAgent();
    if (!me) return null;
    const lookX = -Math.sin(ctrl.yaw), lookZ = -Math.cos(ctrl.yaw);
    const maxD = long ? 62 : 32;
    const minDot = long ? 0.15 : -0.35;      // 短传允许回做（侧后方），长传只朝前
    const attackZ = me.team === 'home' ? 1 : -1;
    let best = null;
    for (const a of agents) {
      if (a === me || a.team !== me.team || a.isGk || a.off || a.subbedOff) continue;
      const dx = a.x - me.x, dz = a.z - me.z;
      const d = Math.hypot(dx, dz);
      if (d < 2.5 || d > maxD) continue;
      const dot = (dx * lookX + dz * lookZ) / (d || 1);
      if (dot < minDot) continue;
      // 推进价值（按进攻方向归一）、接球空间、视野中心度、线路被挡程度
      const prog = clamp(((a.z - me.z) * attackZ) / 35, -1, 1);
      const space = sat((a.oppDist == null ? 3 : a.oppDist) / 7);
      const lane = passLaneOpen(me, a);
      const score = 0.40 * (0.5 + 0.5 * dot) + 0.28 * sat(prog + 0.35) + 0.18 * space + 0.14 * lane;
      if (!best || score > best.score) best = { agent: a, d, dot, score, point: { x: a.x, z: a.z } };
    }
    return best;
  }
  // 传球线路是否干净（0=被封死 1=完全空）：取对手到传球线段的最短距离 / 2.2 m
  function passLaneOpen(from, to) {
    const vx = to.x - from.x, vz = to.z - from.z;
    const L2 = vx * vx + vz * vz;
    if (L2 < 1) return 0;
    let open = 1;
    for (const o of agents) {
      if (o.team === from.team || o.off) continue;
      const t = clamp(((o.x - from.x) * vx + (o.z - from.z) * vz) / L2, 0, 1);
      const dpx = from.x + vx * t - o.x, dpz = from.z + vz * t - o.z;
      const v = Math.hypot(dpx, dpz) / 2.2;
      if (v < open) open = v;
    }
    return sat(open);
  }
  // 提前量：朝接球者跑动方向送球，长传给得多一点
  function leadPoint(t, long) {
    const a = t.agent;
    const lead = long ? clamp(t.d / 22, 0, 1.1) : clamp(t.d / 30, 0, 0.6);
    return { x: a.x + (a.vx || 0) * lead, z: a.z + (a.vz || 0) * lead };
  }
  // 传中落点：进攻三区边路 → 点球点附近（对方球门方向）
  function crossPoint() {
    const me = playerAgent();
    const attackZ = me && me.team === 'away' ? -1 : 1;
    const goalZ = attackZ > 0 ? L / 2 : -L / 2;
    return { x: clamp(ctrl.pos.x * 0.22, -8, 8), z: goalZ - attackZ * 11 };
  }
  function playerPass(long) {
    if (!canShoot()) return { ok: false, reason: 'control' };
    if (playerIsDown()) return { ok: false, reason: 'down' };
    const me = playerAgent();
    if (!me) return { ok: false, reason: 'no-agent' };
    if (ballFlat().distanceTo(myFlat()) > PLAYER_REACH) return { ok: false, reason: 'far' };
    const base = playerPassingAttrs(me);
    const target = pickPassTarget(long);

    if (!target) {
      if (!long) {
        // 没人可传：退回"朝视线方向轻推一脚"，手感与旧版一致。
        // forceFoot=true：轻推必须用脚，不能随机变成一颗头球。
        return { ok: tryKick(0.28, 0.8, true), kind: 'nudge' };
      }
      // 长传没人可接：进攻三区边路 → 传中；否则朝前场大脚
      const inFinalThird = me.team === 'home' ? me.z > L * 0.17 : me.z < -L * 0.17;
      const wide = Math.abs(ctrl.pos.x) > 13;
      const isCross = inFinalThird && wide;
      const point = isCross ? crossPoint() : {
        x: clamp(ctrl.pos.x - Math.sin(ctrl.yaw) * 34, -PITCH.halfW + 3, PITCH.halfW - 3),
        z: clamp(ctrl.pos.z - Math.cos(ctrl.yaw) * 34, -PITCH.halfL + 3, PITCH.halfL - 3),
      };
      const solved = solveLoft(Object.assign({ from: { x: me.x, z: me.z }, to: point, sigmaMul: 1.15 }, base));
      applyUserKick(solved, 'userLongPass', 1);
      return { ok: true, kind: isCross ? 'cross' : 'long', point, lofted: true, apex: +solved.apex.toFixed(2) };
    }

    const point = leadPoint(target, long);
    const solved = long
      ? solveLoft(Object.assign({ from: { x: me.x, z: me.z }, to: point }, base))
      : solvePass(Object.assign({ from: { x: me.x, z: me.z }, to: point }, base));
    applyUserKick(solved, long ? 'userLongPass' : 'userPass', long ? 1 : 0.62);
    return {
      ok: true, kind: long ? 'long' : 'pass', to: target.agent.id, dist: +target.d.toFixed(1),
      point, lofted: !!solved.lofted, apex: solved.apex ? +solved.apex.toFixed(2) : 0,
      flightTime: solved.flightTime ? +solved.flightTime.toFixed(2) : 0,
    };
  }
  // 把解算结果落到球上（与 kickFrom 同一套，但只记玩家的统计，不污染 AI 的传球/射门计数）
  function applyUserKick(solved, kind, power, noPose) {
    ball.vel.set(solved.vx, solved.vy || 0, solved.vz);
    ball.spin.set(
      solved.spin ? solved.spin.x || 0 : 0,
      solved.spin ? solved.spin.y || 0 : 0,
      solved.spin ? solved.spin.z || 0 : 0
    );
    if ((solved.vy || 0) > 0.4) ball.pos.y = Math.max(ball.pos.y, BALL.r + 0.03);
    registerUserKick(kind, power, noPose);
  }

  // ── 玩家抢断 / 滑铲 / 射门语义（有球 vs 无球）─────────────────────────────
  //   桌面：左键=有球轻推 / 无球抢断（指针未锁定时这一下只用于锁定，避免误触）
  //         右键=射门（按住蓄力；空格保留为等价键）  X=滑铲  E=抢断（左键的键盘等价键，指针锁定不可用时用）
  //   手机：射门键=有球射门/无球滑铲；传球键=有球传球/无球抢断（由 input.js 转发成同一套 key）
  //   倒地：滑铲后 downUntil 生效，期间不能移动/出脚（与 NPC 共用 getUpTime）
  function playerAgent() { return agents.find((a) => a.isUser) || null; }
  function playerOnBall() {
    const me = playerAgent();
    if (!me) return false;
    if (ball.ownerId === me.id) return true;        // 已经登记在你名下
    if (ball.ownerId) return false;                 // 球被别人占着
    // 没有登记球权，但球就在脚下 → 也算「有球」。
    // 这是手机端两个双语义键（射门↔滑铲、传球↔抢断）的唯一判据：旧实现只认 ownerId，
    // 而玩家几乎永远拿不到 ownerId，于是「射门」键在整场比赛里都是「滑铲」。
    if (spectateMode) return false;
    return Math.hypot(ball.pos.x - ctrl.pos.x, ball.pos.z - ctrl.pos.z) <= PLAYER_REACH;
  }
  function playerDownInfo() {
    const me = playerAgent();
    if (!me) return { down: false, remain: 0 };
    const remain = me.downUntil ? Math.max(0, me.downUntil - elapsed) : 0;
    return { down: remain > 0, remain: +remain.toFixed(2), until: me.downUntil || 0 };
  }
  function playerIsDown() { return playerDownInfo().down; }
  // 是否在空中（跳跃中且已经离地）：头球判定用它决定够球高度与争顶半径
  function playerAirborne() { return !!(jump.active && ctrl.air > 0.1); }
  // 起跳（J / 手机「起跳」键）：倒地、观赛、已在空中时无效。
  // 跳跃不做成"真弹道"，只提供 0.62 s / 0.52 m 的一段垂直位移 + 判定窗口。
  function startJump() {
    if (spectateMode || jump.active) return false;
    if (playerDownInfo().down) return false;
    jump.active = true; jump.t = 0;
    const m = chars.find((c) => c.isMe);
    if (m && m.model && m.model.jumpPose) m.model.jumpPose();
    actionStats.jump = (actionStats.jump || 0) + 1;
    return true;
  }
  function opponentCarrier() {
    const owner = ball.ownerId ? agentsById[ball.ownerId] : null;
    const me = playerAgent();
    if (!owner || !me || owner.team === me.team) return null;
    return owner;
  }
  // 抢断（贴身）：一对一模型 × 1.35（主动上抢给一点优势）；失败 = 自己失位 0.6 s
  function playerTackle() {
    if (!canShoot()) return { ok: false, reason: 'control' };
    if (playerIsDown()) return { ok: false, reason: 'down' };
    if (playerOnBall()) return { ok: false, reason: 'has-ball' };
    const me = playerAgent(), owner = opponentCarrier();
    if (!me || !owner) return { ok: false, reason: 'no-carrier' };
    const d = Math.hypot(me.x - owner.x, me.z - owner.z);
    const reach = (A.ball.tackleRadius || 1.9) + 0.35;
    if (d > reach) return { ok: false, reason: 'far', dist: +d.toFixed(2) };
    if ((tackleCd[me.id] || 0) > elapsed) return { ok: false, reason: 'cooldown' };
    tackleCd[me.id] = elapsed + DUEL.cooldown;
    const tackling = techOf(me.attrs, 'tackling');
    const chance = clamp(
      tackleChance({ tackler: me, carrier: owner, shielding: false, tacklerStamina: me.stamina, carrierStamina: owner.stamina, helpers: 0 }) * 1.35,
      0.12, 0.95);
    actionStats.steal = (actionStats.steal || 0) + 1;
    const win = Math.random() < chance;
    if (win) {
      setOwner(me);
      me.stamina = Math.max(0, me.stamina - 3);
      owner.stamina = Math.max(0, owner.stamina - 5);
      if (owner.model && owner.model.stumblePose) owner.model.stumblePose();
      actionStats.stealWin = (actionStats.stealWin || 0) + 1;
      aiState.lastTackle = { by: me.id, win: true, at: +elapsed.toFixed(1) };
    } else {
      me.offUntil = elapsed + 0.6;
      if (me.model && me.model.stumblePose) me.model.stumblePose();
      ctrl.vel.multiplyScalar(0.35);
      actionStats.stealFail = (actionStats.stealFail || 0) + 1;
      aiState.lastTackle = { by: me.id, win: false, at: +elapsed.toFixed(1) };
    }
    return { ok: true, win, chance: +chance.toFixed(3), dist: +d.toFixed(2), tackling: +tackling.toFixed(2) };
  }
  // 滑铲：1.0–2.6 m 内可下脚；铲空 = 自己倒地（0.95–1.15 s，getUpTime 随抢断技术缩短）
  function playerSlide(forceMiss) {
    if (!canShoot()) return { ok: false, reason: 'control' };
    if (playerIsDown()) return { ok: false, reason: 'down' };
    if (playerOnBall()) return { ok: false, reason: 'has-ball' };
    const me = playerAgent();
    if (me && me.offUntil && elapsed < me.offUntil) return { ok: false, reason: 'off-balance' };
    const owner = opponentCarrier();
    if (!me || !owner) return { ok: false, reason: 'no-carrier' };
    const d = Math.hypot(me.x - owner.x, me.z - owner.z);
    if (d < SLIDE.minDist - 0.25 || d > SLIDE.maxDist + 0.35) return { ok: false, reason: 'range', dist: +d.toFixed(2) };
    const toOwner = { x: me.x - owner.x, z: me.z - owner.z };
    const tl = Math.hypot(toOwner.x, toOwner.z) || 1;
    const angleCos = (toOwner.x * Math.sin(owner.facing) + toOwner.z * Math.cos(owner.facing)) / tl;
    const tackling = techOf(me.attrs, 'tackling');
    const res = doSlideTackle(me, owner, { angleCos, tackling, forceMiss: !!forceMiss });
    me.downUntil = elapsed + getUpTime({ failed: !res.win, tackling });
    return { ok: true, win: !!res.win, foul: !!res.foul, dist: +d.toFixed(2), down: +Math.max(0, me.downUntil - elapsed).toFixed(2) };
  }
  // 射门蓄力：空格 / 鼠标右键共用
  function beginCharge() {
    if (!canShoot() || playerIsDown()) return false;
    charge.on = true; charge.t = 0; charge.dir = 1; charge.sweep = 0;
    return true;
  }
  function releaseCharge() {
    if (!charge.on) return false;
    charge.on = false; hud.style.opacity = '0'; hudMark.style.opacity = '0';
    hudDomState.chargeOpacity = '0';
    const pct = Math.max(0, Math.min(1, charge.sweep));
    const acc = Math.max(0, 1 - Math.max(0, Math.abs(pct - 0.5) - diffWindow) / Math.max(0.01, 0.5 - diffWindow));
    const ratio = Math.min(1, charge.t / charge.max);
    const shot = tryKick(ratio, acc);
    window.__FW3D_LAST_SHOT = { accuracy: +acc.toFixed(2), power: +(12 + ratio * 23).toFixed(1), onTarget: acc > 0.55, kicked: !!shot };
    if (shot && window.FW && FW.applyKeyMoment) {
      try { window.__FW3D_LAST_MOMENT = FW.applyKeyMoment({ onTarget: acc > 0.55, accuracy: acc }); } catch (e) {}
    }
    return !!shot;
  }

  function onKey(e, down) {
    const k = e.key.toLowerCase();
    if (k === ' ' && down && !e.repeat) beginCharge();
    if (k === ' ' && !down) releaseCharge();
    // F = 短传（有目标就传给最有价值的队友，没人可传就朝视线轻推）
    if (k === 'f' && down && !e.repeat && !playerIsDown()) { try { playerPass(false); } catch (er) {} }
    // G = 长传 / 传中（一定离地；边路进攻三区自动改判为传中）
    if (k === 'g' && down && !e.repeat && !playerIsDown()) { try { playerPass(true); } catch (er) {} }
    // J = 起跳（空中球靠它够到 2.55 m 以上的头球点；落地前顶到球就是头球）
    if (k === 'j' && down && !e.repeat) { try { startJump(); } catch (er) {} }
    if (k === 'x' && down && !e.repeat) { try { playerSlide(false); } catch (er) {} }
    if (k === 'e' && down && !e.repeat) { try { playerTackle(); } catch (er) {} }
    // S：请求换人（体力最低的场上球员 → 同位置能力最高的替补，最多 3 次）
    if (k === 's' && down && !e.repeat) { try { doSubNow('home'); } catch (er) {} }
    if (k === 'b' && down && !e.repeat) { try { debugHud.toggle(); } catch (er) {} }
    // N：头顶姓名牌 —— 全部 / 只看己方 / 关闭（团战里认人用）
    if (k === 'n' && down && !e.repeat) {
      try {
        const mode = cycleNameTags();
        const tipEl = document.getElementById('fw3d-tip');
        const label = mode === 'all' ? '全部显示' : mode === 'team' ? '只看己方' : '已关闭';
        if (tipEl) tipEl.textContent = '头顶姓名：' + label + '（N 切换） · ' + tipEl.textContent;
      } catch (er) {}
    }
    if (k === 't' && down && !e.repeat) {
      // 切换战术风格：balanced → possession → counter → press → low（会记住）
      // 注意：旧实现写的是 `this.cycleTactics()`，而 onKey 是普通函数调用（ESM 严格模式），
      // this 是 undefined —— T 键其实从来没生效过。现在直接调本地 cycleStyle()。
      try {
        const next = cycleStyle();
        const tipEl = document.getElementById('fw3d-tip');
        if (tipEl && next) {
          const lab = (STYLE_PRESETS[next] || {}).label || next;
          tipEl.textContent = '战术风格：' + lab + '（T 切换） · '
            + tipEl.textContent.replace(/^战术风格：[^·]*· /, '');
        }
      } catch (er) {}
    }
    if (k === 'q') { ctrl.shield = down; }
    // 自由观赛：C 起立 / 坐下（手机上由 input.js 的「起身」键转发同一个 c）
    if (k === 'c' && down && !e.repeat && spectateMode) { try { toggleSit(); } catch (er) {} }
    if (['w', 'a', 's', 'd', 'shift', ' ', 'f'].includes(k) || k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright') {
      ctrl.keys[k] = down;
      if (down) e.preventDefault();
    }
  }
  const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);

  // ── 鼠标：右键=射门（按住蓄力）、左键=有球短传 / 无球抢断、中键=长传/传中
  //    左键只在「指针已锁定」时触发动作：第一次点击用于锁定/开始拖拽，避免误传球。
  //    指针锁定不可用的浏览器请用 F（短传）/ G（长传）/ E（抢断）/ X（滑铲）。
  const cvsEl = renderer.domElement;
  const mouseDown = (e) => {
    const locked = document.pointerLockElement === cvsEl;
    if (e.button === 2) { e.preventDefault(); beginCharge(); return; }
    if (e.button === 1) { e.preventDefault(); if (!playerIsDown()) { try { playerPass(true); } catch (er) {} } return; }
    if (e.button !== 0) return;
    if (!locked && !window.__FW3D_LEFTCLICK_ALWAYS) return;
    if (playerIsDown()) return;
    if (playerOnBall()) { try { playerPass(false); } catch (er) {} }   // 有球：短传
    else playerTackle();                                                // 无球：抢断
  };
  const mouseUp = (e) => { if (e.button === 2) releaseCharge(); };
  const noMenu = (e) => { if (e.target === cvsEl) e.preventDefault(); };
  window.addEventListener('mousedown', mouseDown);
  window.addEventListener('mouseup', mouseUp);
  window.addEventListener('contextmenu', noMenu);

  // ── 统一输入层（js/fw3d/input.js）
  //    旧实现只有「按住左键拖拽」一条路：用户按 PC 习惯直接移动鼠标时毫无反应，
  //    表现就是「电脑端无法通过鼠标转动视角」；手机端则完全没有触摸输入。
  //    现在：电脑端点击画面进入指针锁定，移动鼠标即转头（拒绝/不可用时自动退回拖拽）；
  //          手机端左下摇杆移动、右半屏滑动看四周、右下动作键。
  //    回滚：删掉下面 createInput 一段，并恢复 mousedown/mousemove 三行监听即可。
  const el = renderer.domElement;
  const input = createInput({
    el,
    host,
    onKey: (fakeEvt, down) => onKey(fakeEvt, down),   // 触摸按钮复用键盘逻辑，不新增玩法分支
    playerOnBall: () => playerOnBall(),               // 手机端两个双语义键（射门↔滑铲、传球↔抢断）
  });
  // 自由观赛：手机端多一个「起身/坐下」键；其它模式不显示
  try { input.spectate(spectateMode); input.sitLabel(seated); } catch (e) {}

  // 自动跑位：把球当成目标，保持 2.5 m 跟随距离
  function autoSeek(dt) {
    const toBall = new THREE.Vector3(ball.pos.x - ctrl.pos.x, 0, ball.pos.z - ctrl.pos.z);
    const d = toBall.length();
    if (d > 2.6) {
      toBall.normalize();
      const sp = 4.6 * Math.min(1, (d - 2.6) / 6 + 0.35);
      ctrl.vel.x += (toBall.x * sp - ctrl.vel.x) * Math.min(1, dt * 3);
      ctrl.vel.z += (toBall.z * sp - ctrl.vel.z) * Math.min(1, dt * 3);
      ctrl.pos.addScaledVector(ctrl.vel, dt);
      ctrl.yaw = Math.atan2(-toBall.x, -toBall.z);
    } else {
      ctrl.vel.multiplyScalar(Math.exp(-dt * 4));
    }
    ctrl.pos.x = Math.max(-bounds.halfW + 1.2, Math.min(bounds.halfW - 1.2, ctrl.pos.x));
    ctrl.pos.z = Math.max(-L / 2 + 2.2, Math.min(L / 2 + 12, ctrl.pos.z));
  }

  // ── 玩家运动模型开关（第二阶段）：false = 旧的 updateMovement（默认，手感不变）
  //    改成 true 即让玩家共用 NPC 的 PlayerMotor（同一份加速/制动/转身/体力规则）。
  //    回滚：把下面一行改回 false 即可，两套路径都保留、互不影响。
  const USE_MOTOR_FOR_PLAYER = false;
  // 玩家本帧运动信息（供后续侧移/后退姿态按"移动方向 vs 朝向"选姿态）
  let playerMove = { model: 'legacy', speed: 0 };
  let playerTuned = null;   // 玩家电机补偿属性（只在开关打开时创建一次）

  // ── 自由观赛的走位：直接走 roam 的解析世界（没有球员电机、没有体力、没有球权）
  //    参数手感：步行 3.4 m/s、按住 Shift 5.4 m/s，制动比加速快一档 —— 要能停在边线上看球。
  function spectateMove(dt) {
    if (!roam) return;                                   // 球场没建成时退化成"站着不动"
    if (seated) { ctrl.vel.set(0, 0, 0); return; }
    const k = ctrl.keys;
    const fwd = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
    const right = new THREE.Vector3(Math.cos(ctrl.yaw), 0, -Math.sin(ctrl.yaw));
    const wish = new THREE.Vector3();
    if (k.w || k.arrowup) wish.add(fwd);
    if (k.s || k.arrowdown) wish.sub(fwd);
    if (k.d || k.arrowright) wish.add(right);
    if (k.a || k.arrowleft) wish.sub(right);
    const stick = input.move();
    if (stick.x || stick.y) {
      wish.addScaledVector(fwd, stick.y);
      wish.addScaledVector(right, stick.x);
    }
    const sprinting = (!!k.shift || input.sprinting()) && wish.lengthSq() > 0;
    const maxSpeed = sprinting ? 5.4 : ROAM.walk;
    if (wish.lengthSq() > 0) wish.normalize();
    const desired = wish.multiplyScalar(maxSpeed);
    const s = 1 - Math.exp(-dt * (desired.lengthSq() > 0 ? 9 : 12));
    ctrl.vel.x += (desired.x - ctrl.vel.x) * s;
    ctrl.vel.z += (desired.z - ctrl.vel.z) * s;
    if (ctrl.vel.lengthSq() < 1e-6) ctrl.vel.set(0, 0, 0);
    const r = roam.resolve(ctrl.pos.x + ctrl.vel.x * dt, ctrl.pos.z + ctrl.vel.z * dt,
      ctrl.pos.x, ctrl.pos.z, ctrl.groundY);
    ctrl.pos.x = r.x; ctrl.pos.z = r.z;
    if (r.ok) ctrl.groundY = r.y;
    else ctrl.vel.multiplyScalar(0.2);        // 上不去/出界：泄力，避免顶着墙抖
    ctrl.hit = r.hit || null;
    if (ctrl.hit && ctrl.hit !== ctrl.lastHit && elapsed - (ctrl.lastHitAt || -9) > 1.6) {
      ctrl.lastHitAt = elapsed;
      toast(hintForHit(ctrl.hit));
    }
    ctrl.lastHit = ctrl.hit;
  }
  function hintForHit(kind) {
    if (kind === 'pitch') return '比赛进行中 · 不能走进球场';
    if (kind === 'board') return '广告板挡着 · 从替补席前的豁口进出';
    if (kind === 'ring') return '看台层之间的地方过不去';
    if (kind === 'step') return '这里太高，上不去';
    if (kind === 'dugout' || kind === 'bench') return '替补席挡着';
    return '这边过不去';
  }

  function updateMovement(dt) {
    if (spectateMode) { spectateMove(dt); return; }   // 观赛：走 roam 的可行走世界，不走球员电机
    if (ctrlMode !== 'full') { autoSeek(dt); return; }
    const k = ctrl.keys;
    const fwd = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
    const right = new THREE.Vector3(Math.cos(ctrl.yaw), 0, -Math.sin(ctrl.yaw));
    const wish = new THREE.Vector3();
    if (k.w || k.arrowup) wish.add(fwd);
    if (k.s || k.arrowdown) wish.sub(fwd);
    if (k.d || k.arrowright) wish.add(right);
    if (k.a || k.arrowleft) wish.sub(right);
    // 手机摇杆：等价地叠加进同一个 wish 向量（x=右、y=前），不新增第二套运动模型
    const stickVec = input.move();
    if (stickVec.x || stickVec.y) {
      wish.addScaledVector(fwd, stickVec.y);
      wish.addScaledVector(right, stickVec.x);
    }
    const wantSprint = !!k.shift || input.sprinting();
    const sprinting = wantSprint && wish.lengthSq() > 0 && ctrl.stamina > 5;
    const targetSpeed = wish.lengthSq() > 0 ? (sprinting ? sprMax : P.jog) : 0;
    if (wish.lengthSq() > 0) wish.normalize();
    const meA = USE_MOTOR_FOR_PLAYER ? agents.find((a) => a.isUser) : null;
    if (meA) {
      // ── 与 NPC 完全同一条电机路径（第二阶段的对照组）
      meA.x = ctrl.pos.x; meA.z = ctrl.pos.z;
      meA.vx = ctrl.vel.x; meA.vz = ctrl.vel.z;
      meA.stamina = ctrl.stamina;
      // 补偿到街机手感：tunedAttrs 覆盖 phys.maxSpeed/accel（克隆，不改原属性），
      // 冲刺时再乘 sprintMul 把期望速度补到 ~8.0 m/s（见 ai/motor.js 的 ARCADE_TUNING）
      if (!playerTuned) playerTuned = tunedAttrs(meA.attrs, ARCADE_TUNING);
      meA.attrs = playerTuned;
      const intent = targetSpeed > 0
        ? { x: ctrl.pos.x + wish.x * 6, z: ctrl.pos.z + wish.z * 6, pace: sprinting ? 1 : 0.62, sprintMul: sprinting ? ARCADE_TUNING.sprintMul : 1 }
        : { x: ctrl.pos.x, z: ctrl.pos.z, pace: 0 };
      stepPlayer(meA, intent, dt, A, null, null);
      ctrl.pos.x = meA.x; ctrl.pos.z = meA.z;
      ctrl.vel.set(meA.vx, 0, meA.vz);
      ctrl.stamina = meA.stamina;
      playerMove = { model: 'motor', speed: Math.hypot(meA.vx, meA.vz) };
    } else {
      // ── 旧模型（原样保留，开关关闭时走这里）
      // 加速：0 → 全速 0.6 s（起步前 0.2 s 只给 40%）
      const accelRate = targetSpeed / Math.max(0.12, P.accel);
      const desired = wish.multiplyScalar(targetSpeed);
      const smooth = 1 - Math.exp(-dt * (accelRate / Math.max(1, targetSpeed)) * 6);
      ctrl.vel.x += (desired.x - ctrl.vel.x) * smooth;
      ctrl.vel.z += (desired.z - ctrl.vel.z) * smooth;
      if (targetSpeed === 0) {
        // 急停滑行
        const drag = Math.exp(-dt * 5.5);
        ctrl.vel.multiplyScalar(drag);
      }
      ctrl.pos.addScaledVector(ctrl.vel, dt);
      playerMove = { model: 'legacy', speed: Math.hypot(ctrl.vel.x, ctrl.vel.z) };
    }
    // 边界：留在球场内 + 通道区
    // 边界：全部基于当前球场尺寸（bounds），管道/探访各有额外余量
    const halfW = bounds.halfW || W / 2;
    const halfL = bounds.halfL || L / 2;
    // 通道现在沿 x 通向边线（中线处），所以"在通道里"的判据从 z 改成 x：
    // 只有通道模式、且还没跨过边线时才收窄。否则一进通道就会被旧的 z 判据误关。
    const inTunnel = tunnelMode && !tourMode && ctrl.pos.x < -(W / 2 + 0.5) && Math.abs(ctrl.pos.z - TZ) < TW / 2 + 2.5;
    if (tourMode) {
      // 探访：允许走到看台外围 26 m，左右对称
      ctrl.pos.x = Math.max(-halfW - 26, Math.min(halfW + 26, ctrl.pos.x));
      ctrl.pos.z = Math.max(-halfL - 26, Math.min(halfL + 26, ctrl.pos.z));
    } else if (inTunnel) {
      // 通道内收窄到走廊宽度（留 0.4 m 余量，避免贴墙穿模）
      ctrl.pos.x = Math.max(TX_OUT + 0.8, Math.min(-(W / 2 + 0.2), ctrl.pos.x));
      ctrl.pos.z = Math.max(TZ - (TW / 2 - 0.45), Math.min(TZ + (TW / 2 - 0.45), ctrl.pos.z));
    } else {
      ctrl.pos.x = Math.max(-halfW + 1.2, Math.min(halfW - 1.2, ctrl.pos.x));
      ctrl.pos.z = Math.max(tunnelMode ? (-halfL - 25) : (-halfL + 2.2), Math.min(halfL + 12, ctrl.pos.z));
    }
    // 电机路径自带体力规则；旧路径仍用原来的增耗（两套不叠加）
    if (!meA) ctrl.stamina = Math.max(0, Math.min(100, ctrl.stamina + (sprinting ? -12 : 7) * dt));
  }

  const wind = new THREE.Vector3(0, 0, 0);
  // 撞框飞行记录：记录命中瞬间的真实速度（自检用，避免"读到的已经是之后的带球速度"）
  let frameHitLog = null;
  function updateBall(dt) {
    const v = ball.vel;
    v.y -= 9.81 * dt;
    const sp = v.length();
    if (sp > 0.001) v.addScaledVector(v.clone().multiplyScalar(-BALL.dragK * sp), dt);
    // 马格努斯：ω × v，弧线与下坠的来源
    if (ball.spin.lengthSq() > 0.0001) {
      const mag = new THREE.Vector3().crossVectors(ball.spin, v).multiplyScalar(BALL.magnus);
      v.addScaledVector(mag, dt);
    }
    v.addScaledVector(wind, dt);
    if (v.length() > BALL.maxSpeed) v.setLength(BALL.maxSpeed);
    const prevPos = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z };
    ball.pos.addScaledVector(v, dt);
    // 门柱 / 横梁：撞框反弹（不影响判进球的逻辑，进球仍由 judgeExit 判）
    // 传 prevPos 做连续判定：单帧位移可能大于判定窗口，只采样会让快球穿过门柱。
    for (const gz of [-L / 2, L / 2]) {
      const fr = resolveGoalFrame({ x: ball.pos.x, y: ball.pos.y, z: ball.pos.z, vx: v.x, vy: v.y, vz: v.z }, gz, prevPos);
      if (fr.hit) {
        frameHitLog = {
          kind: fr.hit,
          zBefore: +ball.pos.z.toFixed(2), vzBefore: +v.z.toFixed(2),
          zAfter: +((fr.point && fr.point.z) || ball.pos.z).toFixed(2), vzAfter: +fr.vz.toFixed(2),
        };
        v.x = fr.vx; v.y = fr.vy; v.z = fr.vz;
        // 连续判定命中时球已越过门线，必须放回接触点，否则 judgeExit 会误判进球
        if (fr.point && fr.point.z !== ball.pos.z) ball.pos.set(fr.point.x, Math.max(BALL.r, fr.point.y), fr.point.z);
        actionStats.frameHit = (actionStats.frameHit || 0) + 1;
        try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
      }
    }

    if (ball.pos.y < BALL.r) {
      ball.pos.y = BALL.r;
      if (v.y < -0.4) {
        v.y = -v.y * BALL.restitution;
        // 落地冲击损失水平速度（草坪形变），否则长传会一直弹跳、球永远停不下来
        v.x *= 0.86; v.z *= 0.86;
        v.x += ball.spin.y * 0.06;
        v.z -= ball.spin.x * 0.06;
        ball.spin.multiplyScalar(0.82);
      } else v.y = 0;
      // 地滚：线性减速度（与 ai/kick.js 的 ROLL_DECEL 必须一致，AI 按它反解传球初速）
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.001) {
        const dec = Math.max(0, hs - ROLL_DECEL * dt) / hs;
        v.x *= dec; v.z *= dec;
      }
      if (Math.abs(v.y) < 0.06) {
        ball.spin.x = v.z / BALL.r;
        ball.spin.z = -v.x / BALL.r;
        ball.spin.y *= Math.exp(-dt * 2.2);
      }
      if (Math.abs(v.x) < 0.05 && Math.abs(v.z) < 0.05) { v.x = 0; v.z = 0; }
    } else {
      ball.spin.multiplyScalar(Math.exp(-dt * 0.25));
    }
    ballMesh.rotation.x += ball.spin.x * dt;
    ballMesh.rotation.y += ball.spin.y * dt;
    ballMesh.rotation.z += ball.spin.z * dt;
  }

  // 触球：方向 + 力量 + 触球面（决定旋转）
  function kickBall(dir, power, surface) {
    const d = dir.clone().normalize();
    const speed = Math.max(0, Math.min(BALL.maxSpeed, power));
    ball.vel.copy(d).multiplyScalar(speed);
    ball.vel.y += surface === 'chip' ? 4.2 : surface === 'head' ? 1.4 : 0.6;
    const side = surface === 'inside' ? 1 : surface === 'outside' ? -1 : 0;
    const right = new THREE.Vector3(-d.z, 0, d.x);
    ball.spin.copy(right).multiplyScalar(side * speed * 1.6);
    ball.spin.y += surface === 'back' ? speed * 0.9 : 0;
    if (surface === 'head') ball.spin.multiplyScalar(0.4);
    try { if (window.FWSound && FWSound.play) FWSound.play(speed > 18 ? 'whistle' : 'tap'); } catch (e) {}
  }

  let orbitView = false, orbitAngle = 0, orbitTarget = 'me';   // 'me' 围着玩家 / 'ref' 围着主裁（自检出图用）
  let tunnelLit = false;
  const celebrate = { t: 0, phase: 0, ang0: Math.PI * 0.72 };   // >0 时进入庆祝第三人称
  const actionStats = { receive: 0, shield: 0, turn: 0, stumble: 0, lastBallSpeed: 0 };
  let prevVel = new THREE.Vector3();
  // 每帧临时向量池：旧实现每帧都 new 若干 Vector3（第一触球/护球/转身/带球），
  // 60 FPS 下持续制造垃圾 → 周期性 GC 卡顿。这里复用同一批对象，不动任何判定逻辑。
  const TMP_A = new THREE.Vector3(), TMP_B = new THREE.Vector3();
  let ME_CHAR = null;          // 每帧只查一次自己的角色模型（旧实现每帧 find 6–7 次）
  const keyV = (e) => { if (e.key === 'v' || e.key === 'V') orbitView = !orbitView; };
  window.addEventListener('keydown', keyV);

  // 转播级庆祝镜头（第三人称）：分三段硬切，做"实况集锦"的感觉
  //   ① 0–0.75 s  高位远景（看台侧向俯瞰，能看到整块半场和跑向角旗的庆祝人群）
  //   ② 0.75–2.6 s 切近景：对准进球者 3/4 前侧、胸口高度，缓慢绕行 + 轻推 + 手持微晃
  //   ③ 2.6–3.8 s 拉回：从近景退到球后方，FOV 收回去，交还第一人称
  function celebrationCamera(dt) {
    celebrate.t = Math.max(0, celebrate.t - dt);
    celebrate.phase += dt;
    const P = celebrate.phase;
    // 焦点：优先进球者，其次球，最后玩家
    const scorer = celebrate.scorerId ? agentsById[celebrate.scorerId] : null;
    const fx = scorer ? scorer.x : (celebrate.teamId === 'away' ? ball.pos.x : ctrl.pos.x);
    const fz = scorer ? scorer.z : (celebrate.teamId === 'away' ? ball.pos.z : ctrl.pos.z);
    const side = celebrate.teamId === 'away' ? -1 : 1;
    const shakeX = Math.sin(celebrate.phase * 7.3) * 0.05;
    const shakeY = Math.cos(celebrate.phase * 5.9) * 0.04;

    if (P < 0.75) {
      // ① 高位远景：看台侧向，横向跟着焦点滑动
      const k = P / 0.75;
      const x = side * (W / 2 - 3.5) * (0.72 + 0.1 * k);
      const z = fz * 0.35 + side * 12;
      camera.position.set(x, 10.5 - 0.6 * k, z);
      camera.fov = 58;
      camera.updateProjectionMatrix();
      camera.lookAt(0, 0.5, fz * 0.55);
    } else if (P < 2.6) {
      // ② 近景：围绕进球者 3/4 前侧，半径 5.0→3.8 m，高度 2.2→1.7 m
      const k = Math.min(1, (P - 0.75) / 1.85);
      const ease = 1 - Math.pow(1 - k, 2.2);
      const r = 5.0 - 1.2 * ease;
      const h = 2.2 - 0.5 * ease;
      const ang = celebrate.ang0 + 0.22 * (1 - ease) + P * 0.1;   // 缓慢绕行
      camera.position.set(
        fx + Math.sin(ang) * r + shakeX * 0.6,
        h + shakeY * 0.6,
        fz + Math.cos(ang) * r
      );
      camera.fov = 40;
      camera.updateProjectionMatrix();
      camera.lookAt(fx, 1.2, fz);
    } else {
      // ③ 拉回：退到球/玩家后方，接近第一人称视角，避免切回时跳变
      const k = Math.min(1, (P - 2.6) / 1.2);
      const ease = k * k * (3 - 2 * k);
      const fromX = fx + Math.sin(celebrate.ang0 + 0.42) * 4.2;
      const fromZ = fz + Math.cos(celebrate.ang0 + 0.42) * 4.2;
      const toX = ctrl.pos.x + Math.sin(ctrl.yaw) * 0.6;
      const toZ = ctrl.pos.z + Math.cos(ctrl.yaw) * 0.6;
      camera.position.set(fromX + (toX - fromX) * ease, 1.7 + (P.eye - 1.7) * ease, fromZ + (toZ - fromZ) * ease);
      camera.fov = 40 + (camState.fov - 40) * ease;
      camera.updateProjectionMatrix();
      camera.lookAt(toX, 1.25, toZ);
    }
  }

  // ── 第一人称「低头看见自己的脚」：相机挂载的腿部代理，只在俯视时显示
  const ownLegs = new THREE.Group();
  (function buildOwnLegs() {
    const bootColor = hexToNum(persona.boot, 0x14161a);
    const skinColor = hexToNum(persona.skin, 0xb0805e);
    const shortColor = 0x2c3440;
    const mk = (x) => {
      const g = new THREE.Group();
      g.position.set(x, 0, 0);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.34, 0.18), new THREE.MeshStandardMaterial({ color: shortColor, roughness: 0.85 }));
      thigh.position.set(0, -0.17, 0); g.add(thigh);
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.34, 0.15), new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.86 }));
      shin.position.set(0, -0.5, 0.02); g.add(shin);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.09, 0.3), new THREE.MeshStandardMaterial({ color: bootColor, roughness: 0.7 }));
      boot.position.set(0, -0.7, 0.09); g.add(boot);
      return g;
    };
    ownLegs.add(mk(-0.13)); ownLegs.add(mk(0.13));
    ownLegs.visible = false;
    scene.add(ownLegs);   // 世界空间摆放，每帧对齐到相机前下方
  })();

  // 每帧投影矩阵只在 fov / 宽高比真的变化时才重算：原来无条件 updateProjectionMatrix()
  // 会每帧重算矩阵并让 Three 重新上传相机 uniform（静止站桩时纯浪费）。
  let camFovApplied = -1, camAspectApplied = -1;
  function applyProjectionIfNeeded() {
    if (Math.abs(camera.fov - camFovApplied) < 0.02 && camera.aspect === camAspectApplied) return;
    camFovApplied = camera.fov; camAspectApplied = camera.aspect;
    camera.updateProjectionMatrix();
  }
  // 低头腿部剪影 / 底部提示条的 DOM 只在取值变化时写：
  // 旧实现每帧都写 4 次 style + dataset，页面一直处于"样式待重算"状态。
  const feetDomState = { opacity: null, transform: null, tipHidden: null };
  // 比赛 HUD 的写 DOM 缓存（比分条 / 蓄力条）：值没变就不写，避免每帧样式重算
  const hudDomState = { score: null, chargeOpacity: null, markLeft: null, fillWidth: null };
  let tipElCached = null;
  function tipElement() {
    if (!tipElCached || tipElCached.isConnected === false) tipElCached = document.getElementById('fw3d-tip');
    return tipElCached;
  }

  function updateCamera(dt) {
    const speed = ctrl.vel.length();
    // 自由观赛：坐/站的眼高切换（0.35 s 左右升/降，像真的站起来）
    if (spectateMode) {
      const eyeTarget = seated ? ROAM.eyeSit : P.eye;
      camState.eye += (eyeTarget - camState.eye) * Math.min(1, dt * 7);
    }
    camState.bobT += dt * (2.2 + speed * 0.22) * Math.PI * 2;
    const bobAmp = Math.min(0.075, speed * 0.011);
    const bobY = Math.abs(Math.sin(camState.bobT)) * bobAmp;
    const targetFov = 74 + Math.min(8, speed * 1.05);
    camState.fov += (targetFov - camState.fov) * Math.min(1, dt * 3.2);
    camera.fov = orbitView ? 52 : camState.fov;
    applyProjectionIfNeeded();
    // 第一人称：隐藏自身模型；俯视时显示自己的腿
    const meChar = ME_CHAR || chars.find((c) => c.isMe);
    const fp = !(celebrate.t > 0) && !orbitView;
    if (meChar && meChar.model && meChar.model.object) meChar.model.object.visible = !fp;
    // 自由观赛：坐在替补席上的"你自己"同样在第一人称下隐藏（V 检视时才看得见坐姿）
    if (meBench && meBench.model && meBench.model.object) meBench.model.object.visible = !fp;
    ownLegs.visible = fp && !seated && ctrl.pitch < -0.32;
    if (feetOverlay) {
      const show = fp && !seated && ctrl.pitch < -0.26;
      const k = show ? Math.min(1, (-ctrl.pitch - 0.26) / 0.45) : 0;
      const opacity = String(k * 0.95);
      if (opacity !== feetDomState.opacity) { feetOverlay.style.opacity = opacity; feetDomState.opacity = opacity; }
      const transform = 'translate(-50%,' + (40 - k * 40) + '%)';
      if (transform !== feetDomState.transform) { feetOverlay.style.transform = transform; feetDomState.transform = transform; }
      const tipEl = tipElement();
      if (tipEl) {
        const hidden = k > 0.25;
        if (hidden !== feetDomState.tipHidden) {
          feetDomState.tipHidden = hidden;
          tipEl.style.transition = 'opacity .15s';
          tipEl.style.opacity = hidden ? '0' : '1';
          tipEl.dataset.tipHidden = hidden ? '1' : '0';
        }
      }
    }
    if (ownLegs.visible) {
      const fwdDir = TMP_A.set(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
      // 放在视锥内：更靠前、略高，避免落到画面下缘之外
      const ahead = 0.72;
      ownLegs.position.set(
        ctrl.pos.x + fwdDir.x * ahead,
        P.eye - 0.52,
        ctrl.pos.z + fwdDir.z * ahead
      );
      ownLegs.rotation.set(0, ctrl.yaw, 0);
    }
    if (ownLegs.visible) {
      const look = Math.min(1, Math.max(0, (-ctrl.pitch - 0.32) / 0.5));
      ownLegs.position.y = -0.28 - look * 0.22;
      ownLegs.rotation.x = -look * 0.35;
    }

    if (celebrate.t > 0) {
      celebrationCamera(dt);
      return;
    }
    if (orbitView) {
      orbitAngle += dt * 0.42;
      const target = ME_CHAR || chars[0];
      let tp = target ? target.model.object.position : ctrl.pos;
      let radius = 3.4, height = 1.55, lookY = 1.05;
      if (orbitTarget === 'ref' && referee) tp = referee.object.position;
      else if (orbitTarget === 'linesman0' && linesmen[0]) { tp = linesmen[0].object.position; radius = 5.4; height = 3.4; lookY = 2.0; }
      else if (orbitTarget === 'linesman1' && linesmen[1]) { tp = linesmen[1].object.position; radius = 5.4; height = 3.4; lookY = 2.0; }
      else if (orbitTarget && orbitTarget !== 'me') {
        const ag = agentsById[orbitTarget];
        if (ag && ag.model && ag.model.object) tp = ag.model.object.position;
      }
      camera.position.set(tp.x + Math.sin(orbitAngle) * radius, height, tp.z + Math.cos(orbitAngle) * radius);
      camera.lookAt(tp.x, lookY, tp.z);
    } else {
      // 自由观赛时脚下有高度（替补席台座 / 看台台阶），其它模式 ctrl.groundY 恒为 0
      // 自由观赛时脚下有高度（替补席台座 / 看台台阶），其它模式 ctrl.groundY 恒为 0；
      // ctrl.air 是起跳产生的离地高度（第一人称要有"跳起来"的视野变化，否则跳跃毫无反馈）
      camera.position.set(ctrl.pos.x, ctrl.groundY + camState.eye + bobY + ctrl.air, ctrl.pos.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(ctrl.pitch, ctrl.yaw, 0);
    }
  }

  // ── 音效（WebAudio 合成，无需素材；首次手势后启动）
  const fw3dAudio = (function () {
    let ctx = null, ambience = null;
    function init() {
      if (ctx) return ctx;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        // 看台环境声：棕噪声 + 低通
        const len = ctx.sampleRate * 2;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620;
        const g = ctx.createGain(); g.gain.value = 0.06;
        src.connect(lp); lp.connect(g); g.connect(ctx.destination); src.start();
        ambience = g;
      } catch (e) { ctx = null; }
      return ctx;
    }
    function whistle(strong) {
      if (!init()) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = strong ? 2350 : 1900;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(strong ? 0.16 : 0.1, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (strong ? 0.5 : 0.28));
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.6);
    }
    function cheer() {
      if (!init()) return;
      const t = ctx.currentTime;
      const len = Math.floor(ctx.sampleRate * 1.6);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const env = Math.sin((i / len) * Math.PI);
        d[i] = (Math.random() * 2 - 1) * env * env * 0.5;
      }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
      const g = ctx.createGain(); g.gain.value = 0.22;
      src.connect(bp); bp.connect(g); g.connect(ctx.destination); src.start(t);
    }
    function boost(mul) { if (ambience) ambience.gain.value = Math.min(0.18, 0.06 * mul); }
    return { init, whistle, cheer, boost, ready: () => !!ctx };
  })();
  window.addEventListener('pointerdown', function once() { fw3dAudio.init(); }, { once: true });
  window.addEventListener('click', function once() { fw3dAudio.init(); }, { once: true });

  // ── 画质档位（只影响渲染开销，不改任何玩法数值）
  //    3 最高 → 0 最低。软件渲染直接用 0；手机/低配从 1 开始；正常从 3 开始。
  //    每一档同时决定：像素比、阴影、观众密度、姓名牌显示距离、场馆补光与记分屏灯。
  //    注意：切阴影/灯光会让 Three 重新编译材质（一次性卡顿），所以只在降级瞬间发生。
  const QUALITY_STEPS = [
    { dpr: 0.75, shadows: false, crowd: 0.25, stadiumLights: false, boardLight: false, tagHide: 34, lodBias: 2.5 },
    { dpr: 1.0, shadows: false, crowd: 0.45, stadiumLights: true, boardLight: true, tagHide: 45, lodBias: 1.8 },
    { dpr: 1.5, shadows: true, crowd: 0.75, stadiumLights: true, boardLight: true, tagHide: 55, lodBias: 1.2 },
    { dpr: 2.0, shadows: true, crowd: 1.0, stadiumLights: true, boardLight: true, tagHide: 62, lodBias: 1.0 },
  ];
  let CROWD_FULL = 0;   // 原始观众实例数（第一次应用画质时记录）
  const adaptiveQuality = { fps: 60, low: 0, level: softwareGPU ? 0 : (lowSpec ? 1 : 3), last: 0, frames: 0 };
  function applyQuality(level) {
    const n = Math.max(0, Math.min(QUALITY_STEPS.length - 1, Number(level) || 0));
    const q = QUALITY_STEPS[n];
    adaptiveQuality.level = n;
    try {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
      renderer.shadowMap.enabled = !!q.shadows && !lowSpec;
      if (crowdMesh) {
        if (!CROWD_FULL) CROWD_FULL = crowdMesh.count;
        crowdMesh.count = Math.max(0, Math.floor(CROWD_FULL * q.crowd));
      }
      const lights = (built && built.lights) || [];
      for (const l of lights) l.visible = !!q.stadiumLights;
      if (scoreboard && scoreboard.light) scoreboard.light.visible = !!q.boardLight;
      nameTagHide = q.tagHide;
    } catch (e) {}
    const tipEl = document.getElementById('fw3d-stat');
    if (tipEl) {
      tipEl.dataset.quality = String(n);
      tipEl.dataset.gpu = softwareGPU ? 'software' : (lowSpec ? 'low' : 'high');
    }
    return n;
  }
  function degrade(fps) {
    if (adaptiveQuality.level <= 0) return;
    // 帧率极低（<20）时一步降两档：少一次"降一档还卡"的反复，也就少一次材质重编译
    const step = (fps != null && fps < 20) ? 2 : 1;
    applyQuality(Math.max(0, adaptiveQuality.level - step));
  }
  function tickQuality(dt) {
    adaptiveQuality.frames++;
    adaptiveQuality.low += dt;
    if (adaptiveQuality.low >= (adaptiveQuality.level >= 3 ? 1.2 : 1.6)) {
      const fps = adaptiveQuality.frames / adaptiveQuality.low;
      adaptiveQuality.fps = fps;
      // 32 FPS 以下降档；软件渲染（一帧上百毫秒）继续降到最低档
      if (fps < 32 && adaptiveQuality.level > 0) degrade(fps);
      adaptiveQuality.low = 0;
      adaptiveQuality.frames = 0;
    }
  }

  // ── 2D 腿部剪影：低头时从画面底部升起（比 3D 代理可靠）
  const feetOverlay = document.createElement('div');
  (function buildFeetOverlay() {
    const boot = (persona.boot && /^#?[0-9a-f]{6}$/i.test(persona.boot)) ? persona.boot : '#14161a';
    const skin = (persona.skin && /^#?[0-9a-f]{6}$/i.test(persona.skin)) ? persona.skin : '#b0805e';
    feetOverlay.style.cssText = 'position:absolute;left:50%;bottom:86px;transform:translate(-50%,40%);width:380px;height:250px;pointer-events:none;z-index:2;opacity:0;transition:opacity .12s';
    const leg = (dx) => '<div style="position:absolute;left:' + (110 + dx) + 'px;bottom:0;width:52px;height:200px">'
      + '<div style="position:absolute;left:0;top:0;width:52px;height:104px;background:#222a35;border-radius:10px 10px 4px 4px"></div>'
      + '<div style="position:absolute;left:6px;top:96px;width:40px;height:78px;background:' + skin + ';border-radius:6px"></div>'
      + '<div style="position:absolute;left:2px;top:168px;width:48px;height:20px;background:#1b2430;border-radius:4px"></div>'
      + '<div style="position:absolute;left:-2px;top:184px;width:58px;height:30px;background:' + boot + ';border-radius:12px 16px 8px 8px"></div>'
      + '</div>';
    feetOverlay.innerHTML = leg(-46) + leg(46);
    host.appendChild(feetOverlay);
  })();

  // 进球转播字幕
  let goalCard = null;
  function goalOverlay(ev) {
    if (!goalCard) {
      goalCard = document.createElement('div');
      goalCard.style.cssText = 'position:absolute;left:36px;bottom:96px;padding:10px 18px 12px;border-radius:10px;background:linear-gradient(90deg,rgba(8,12,18,.92),rgba(8,12,18,.55));border-left:3px solid #5ad1a0;color:#eef4fb;font:600 15px/1.35 system-ui,sans-serif;z-index:4;opacity:0;transition:opacity .22s';
      host.appendChild(goalCard);
    }
    const minute = ev && ev.minute != null ? ev.minute + "'" : '';
    const who = (ev && ev.scorer) ? ev.scorer : '你';
    goalCard.innerHTML = '<div style="font-size:11px;letter-spacing:.2em;color:#5ad1a0">GOAL · ' + minute + '</div>'
      + '<div style="font-size:19px;margin-top:2px">' + who + '</div>';
    goalCard.style.opacity = '1';
    clearTimeout(goalOverlay._t);
    goalOverlay._t = setTimeout(() => { if (goalCard) goalCard.style.opacity = '0'; }, 3200);
  }

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  const info = () => (club ? ('[' + (built.label || stadiumKind) + '] ') + club.name + ' · ' + (club.stadium && club.stadium.name ? club.stadium.name : '主场') + ' · ' + capacity.toLocaleString() + ' 座' : '训练场')
    + (softwareGPU ? ' · 软件渲染（建议在浏览器设置里开启"硬件加速"）' : '');
  // 操作提示按设备给出——电脑端必须明确告诉用户「点一下画面锁定鼠标」，否则会以为不能转头
  const tipBase = spectateMode
    ? '自由观赛：坐在替补席上 · C 起立/坐下 · 场上进不去 · '
    : (tourMode ? '主场探访：随便走走看看 · ' : (tunnelMode ? '球员通道：W 向前走出通道 · ' : ''));
  document.getElementById('fw3d-tip').textContent = tipBase + (input.isMobile()
    ? (spectateMode
      ? '左摇杆走动 · 右半屏滑动看四周 · 起身/坐下用右下角按钮 · Esc 退出'
      : '左摇杆移动 · 右半屏看四周 · 有球：射门（按住蓄力）/传球 · 无球：滑铲/抢断 · 冲刺/护球 · Esc 退出')
    : (spectateMode
      ? '点击画面锁定鼠标即可转头 · WASD 走动 · Shift 快走 · C 坐/站 · T 战术 · N 队员名字 · Esc 退出'
      : '点击画面锁定鼠标即可转头 · WASD 移动 · Shift 冲刺 · 右键蓄力射门 · 左键：有球轻推/无球抢断 · X 滑铲 · Q 护球 · V 检视 · T 战术 · N 队员名字 · Esc 退出'));
  input.setExtraHint(info());

  // ═══════════════════════════════════════════════════════════
  // 队伍 AI（第三阶段）：WorldSnapshot → TeamPlan → Utility AI → PlayerMotor → KickResolver
  // 原则：AI 只产生意图；位置由 motor 改；球速由 kick.js 解算；球权/阶段只在 matchState 一处维护。
  // ═══════════════════════════════════════════════════════════
  const aiCfg0 = createConfig();
  try { if (FW && FW.difficultyProfile) applyDifficulty(aiCfg0, FW.difficultyProfile()); } catch (e) {}
  const brain = createTeamBrain(aiCfg0);
  const A = brain.cfg;                       // 唯一配置源（电机/球权/踢球都用它）
  // 战术风格：优先级 = 调用方显式传入（赛前"比赛计划"映射而来）> 上次记忆 > 均衡。
  // 旧顺序是 localStorage 先于 opts，导致"赛前选了高位压迫，进场还是上次的控球"。
  const STYLE_ORDER = ['balanced', 'possession', 'counter', 'press', 'low'];
  try {
    if (opts && opts.style && STYLE_PRESETS[opts.style]) applyStyle(A, opts.style);
    else {
      const saved = localStorage.getItem('fw3d.style');
      if (saved && STYLE_PRESETS[saved]) applyStyle(A, saved);
    }
  } catch (e) {}
  /** 循环切换战术（T 键 / HUD 点击 / 自检 cycleTactics 三处共用同一实现） */
  function cycleStyle() {
    const i = STYLE_ORDER.indexOf(A.team.style);
    const next = STYLE_ORDER[(i + 1) % STYLE_ORDER.length];
    applyStyle(A, next);
    try { localStorage.setItem('fw3d.style', next); } catch (e) {}
    syncTacticsHud();
    return next;
  }
  syncTacticsHud();     // 开场就把当前风格显示出来（来自赛前比赛计划或上次记忆）
  const ms = createMatchState({ phase: 'preMatch', rate: (opts && opts.rate) || (spectateMode ? 0.9 : 1.6) });
  const debugHud = createDebugHud(host, A);
  const PITCH = { halfW: W / 2, halfL: L / 2 };
  const aiState = {
    accum: 0, intents: [], kicks: 0, pass: 0, shoot: 0, clear: 0, dribble: 0, restarts: 0,
    lastDebug: null, lastDribbleT: 0,
    book: Object.create(null),     // 红黄牌记录：playerId -> {y,r,off}
  };
  let restart = null;          // {teamId, until, type}
  let matchStarted = false;
  ball.ownerId = null; ball.ownerTeam = null; ball.lastKicker = null; ball.lastKickAt = -9;

  // ═══════════════════════════════════════════════════════════
  // 自由观赛：比分由**引擎时间线**驱动 —— 你在 3D 里看的必须就是 2D 结算的那一场
  //   脚本到点 → 把"脚本进球者"摆到门前真踢一脚 → 进球裁定：
  //     · 落在脚本事件窗口内（±9 s）且球队一致 → 记分 + 庆祝 + 字幕写脚本进球者
  //     · 其它任何进球 → 判「进球无效」（越位/犯规），球门球重开，比分不动
  //   偶发的 AI 进球因此不会把比分带偏，而"进球被吹"在足球里本来就是常态。
  const specScript = { events: [], idx: 0, pending: null, ready: false, fired: 0, disallowed: 0, forced: 0 };

  function timelineObj() {
    try { return window.__FW3D_TIMELINE || (window.FW && FW.matchTimeline ? FW.matchTimeline() : null); } catch (e) { return null; }
  }
  function initSpectateScript() {
    const tl = timelineObj();
    specScript.events = ((tl && tl.events) || []).slice()
      .sort((a, b) => (a.minute || 0) - (b.minute || 0));
    specScript.idx = 0; specScript.pending = null; specScript.ready = true;
    ms.setScore(0, 0);
    return specScript.events.length;
  }

  /** 把一次脚本进球记进比分并播庆祝（force=true 用于"踢飞了也补上"，保证终场比分一定对） */
  function creditScriptedGoal(team, scorerName, minute, force) {
    ms.goal(team, elapsed);
    specScript.pending = null;
    if (force) specScript.forced++;
    try { fw3dAudio.cheer(); fw3dAudio.boost(2.2); setTimeout(function () { fw3dAudio.boost(1); }, 2600); } catch (e) {}
    goalOverlay({ minute: Math.floor(minute || ms.state.minute), scorer: scorerName || (team === 'home' ? homeLabel : awayLabel) });
    // 观赛不切庆祝镜头：你就站在场边，视角不该被夺走（只留字幕 + 欢呼）
    if (!spectateMode) startCelebration(team);
    return true;
  }

  /** 到点就把脚本进球"演"出来：把脚本进球者摆到门前，真踢一脚（走物理与门将判定） */
  function fireScriptedGoal(ev) {
    const team = ev.team === 'away' ? 'away' : 'home';
    const goalZ = team === 'home' ? L / 2 : -L / 2;
    const s = goalZ > 0 ? 1 : -1;
    let actor = ev.scorerId ? agentsById[ev.scorerId] : null;
    if (!actor || actor.team !== team || actor.off || actor.isGk) actor = null;
    if (!actor) {
      // 脚本进球者不在场上（例如 2D 里记的是替补/你的人）→ 由最靠前的同队球员代打
      let bd = 1e9;
      for (const a of agents) {
        if (a.team !== team || a.off || a.isGk) continue;
        const d = Math.abs(a.z - goalZ);
        if (d < bd) { bd = d; actor = a; }
      }
    }
    if (!actor) return null;
    const bx = Math.max(-11, Math.min(11, (actor.x || 0) * 0.3 + (Math.random() - 0.5) * 3));
    const bz = goalZ - s * 13;
    actor.x = bx; actor.z = bz; actor.vx = 0; actor.vz = 0;
    actor.facing = s > 0 ? 0 : Math.PI;
    ball.pos.set(bx, BALL.r, bz + s * 0.55);
    ball.vel.set(0, 0, 0);
    ball.spin.set(0, 0, 0);
    setOwner(null);
    restart = null;
    let solved = null;
    try {
      solved = solveShot({
        from: { x: bx, z: bz },
        goal: { x: (Math.random() - 0.5) * 2.2, z: goalZ },
        attrs: actor.attrs, pressure: 0.12, power: 24, cfg: A,
      });
    } catch (e) { solved = null; }
    if (!solved) { creditScriptedGoal(team, ev.scorer, ev.minute, true); return null; }
    kickFrom(actor, solved, 'shoot');
    specScript.pending = {
      team, at: elapsed, minute: ev.minute || 0,
      scorer: ev.scorer || (actor.name || null), scorerId: ev.scorerId || actor.id || null, mine: !!ev.mine,
    };
    specScript.fired++;
    return specScript.pending;
  }

  /** 每帧调用：到点演下一脚；踢飞/被扑出超过 9 s 就补记（保证比分收敛到 2D 结果） */
  function scriptedGoalsTick() {
    if (!spectateMode || !specScript.ready) return;
    const p = specScript.pending;
    if (p && elapsed - p.at > 9) { creditScriptedGoal(p.team, p.scorer, p.minute, true); return; }
    if (specScript.idx >= specScript.events.length) return;
    if (restart || ms.state.phase !== 'inPlay') return;      // 死球/庆祝中先不演
    const ev = specScript.events[specScript.idx];
    if (ms.state.minute < (ev.minute || 0)) return;
    specScript.idx++;
    fireScriptedGoal(ev);
  }


  // 大屏：把真实队名/比分/时间写进泰山记分牌（否则它会一直显示移植时的 6:0）
  const scoreboard = (built && built.scoreboard) || null;
  const sbMeta = { minute: -1, home: -1, away: -1 };
  // 记分屏每秒重绘一次 1024×576 画布 + 上传贴图（约 2–6 ms 的主线程尖峰，
  // 在高帧率下会表现为"每秒抖一帧"）。屏幕不在相机视锥里时跳过重绘，时钟照常走。
  const sbFrustum = new THREE.Frustum();
  const sbMatrix = new THREE.Matrix4();
  let sbVisible = true, sbVisTimer = 1;
  function scoreboardOnScreen(dt) {
    if (!scoreboard || !scoreboard.group) return true;
    sbVisTimer += dt || 0;
    if (sbVisTimer >= 0.4) {
      sbVisTimer = 0;
      try {
        scoreboard.group.getWorldPosition(TMP_A);
        sbMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        sbFrustum.setFromProjectionMatrix(sbMatrix);
        sbVisible = sbFrustum.containsPoint(TMP_A);
      } catch (e) { sbVisible = true; }
    }
    return sbVisible;
  }
  (function initScoreboard() {
    if (!scoreboard || !scoreboard.setData) return;
    let comp = '热身赛';
    try {
      const lg = (FW && FW.state && FW.state.leagues || []).find((l) => l.id === (club && club.leagueId));
      if (lg && lg.name) comp = lg.name;
    } catch (e) {}
    try {
      scoreboard.setData({
        homeName: homeLabel, homeEnglish: '', awayName: awayLabel, awayEnglish: '',
        homeScore: 0, awayScore: 0, clockSeconds: 0, clockRunning: false,
        competition: comp, venue: (club && club.stadium && club.stadium.name) || '主场',
        period: '上半场', status: '比赛进行',
      });
    } catch (e) {}
  })();
  function syncScoreboard(dt) {
    if (!scoreboard) return;
    try {
      if (scoreboard.update) scoreboard.update(dt, elapsed, !scoreboardOnScreen(dt));
      const min = Math.floor(ms.state.minute);
      if (min !== sbMeta.minute || ms.state.score.home !== sbMeta.home || ms.state.score.away !== sbMeta.away) {
        sbMeta.minute = min; sbMeta.home = ms.state.score.home; sbMeta.away = ms.state.score.away;
        scoreboard.setData({
          homeScore: ms.state.score.home, awayScore: ms.state.score.away,
          clockSeconds: min * 60,
          period: min < 45 ? '上半场' : '下半场',
          status: ms.state.over ? '比赛结束' : (ms.state.phase === 'goalPause' ? '进球' : '比赛进行'),
        });
      }
    } catch (e) {}
  }

  function setOwner(agent) {
    if (!agent) {
      ball.ownerId = null; ball.ownerTeam = null;
      ms.setPossession(null, null, 0, elapsed);
      return null;
    }
    ball.ownerId = agent.id;
    ball.ownerTeam = agent.team;
    agent.ownerSince = elapsed;
    ms.setPossession(agent.id, agent.team, 1, elapsed);
    return agent;
  }

  // 唯一改球速的入口（KickResolver 解算结果落地）
  function kickFrom(agent, solved, type) {
    ball.vel.set(solved.vx, solved.vy || 0, solved.vz);
    ball.spin.set(
      solved.spin ? solved.spin.x || 0 : 0,
      solved.spin ? solved.spin.y || 0 : 0,
      solved.spin ? solved.spin.z || 0 : 0
    );
    if ((solved.vy || 0) > 0.4) ball.pos.y = Math.max(ball.pos.y, BALL.r + 0.03);
    ball.lastKicker = agent.id;
    ball.lastKickAt = elapsed;
    setOwner(null);
    ms.touch(agent.id, agent.team, elapsed, type);
    if (agent.model && agent.model.kick) agent.model.kick(type === 'shoot' ? 1 : 0.62);
    if (type === 'pass') aiState.pass++;
    else if (type === 'shoot') aiState.shoot++;
    else if (type === 'clear') aiState.clear++;
    aiState.kicks++;
    actionStats.npcPass = aiState.pass;
    actionStats.npcShot = aiState.shoot;
    actionStats.npcDribble = aiState.dribble;
    try { if (window.FWSound && FWSound.play) FWSound.play((solved.speed || 0) > 18 ? 'whistle' : 'tap'); } catch (e) {}
  }

  // ── 自由观赛：把一名替补"放"到座位上（只建模型 + 坐姿，不建 agent）
  //    与 makeSubAgent 用同一份 kit / 材质缓存，所以队服、肤色、脸型都跟场上队友一致。
  function makeSitter(teamKey, src, seat, isMe) {
    const kit = kitCtx || { shirts: { home: 0xe8eef5, away: 0x243040 }, shorts: { home: 0xffffff, away: 0x1b2430 }, skins: [0xb0805e], modelCache: null };
    const number = Number((src && src.number) || (isMe ? 9 : 0)) || (isMe ? 9 : 20 + sitting.length);
    const jersey = isMe ? 0xf2f5f8 : kit.shirts[teamKey];
    const lookRec = Object.assign({}, src || {}, { id: String((src && src.id) || ('sit-' + sitting.length)) });
    const app = appearanceFor(lookRec, {
      overrides: likenessOf(src || {}),
      kit: { jersey, shorts: kit.shorts[teamKey], accent: kit.shorts[teamKey], boot: 0x14161a, socks: 0x14161a, number, gk: false },
    });
    if (isMe) {
      // 与场上「你」同一套个性化：肤色 / 发型优先用手动设置
      if (typeof persona.skin === 'string' && /^#?[0-9a-f]{6}$/i.test(persona.skin)) app.skin_tone = parseInt(persona.skin.replace('#', ''), 16);
      if (persona.hairStyle && persona.hairStyle !== 'short') app.hair_style = persona.hairStyle === 'none' ? 'bald' : persona.hairStyle;
      app.source = 'user';
    }
    const model = createPlayerModel(THREE, {
      jersey, shorts: kit.shorts[teamKey], number,
      name: isMe ? String(persona.name || (src && src.name) || '你') : '',
      skin: isMe ? hexToNum(persona.skin, 0xb0805e) : kit.skins[sitting.length % kit.skins.length],
      boot: isMe ? hexToNum(persona.boot, 0x14161a) : 0x14161a,
      dominantFoot: isMe ? (persona.dominantFoot || 'right') : 'right',
      cache: kit.modelCache, appearance: app, detail: 'mid',
    });
    model.object.position.set(seat.x, seat.y, seat.z);
    model.object.rotation.y = seat.yaw + Math.PI;      // 与 meAgent.facing = yaw + π 同一套约定
    if (model.sitPose) model.sitPose(true);
    const rec = { model, seat, isMe: !!isMe, team: teamKey, phase: Math.random() * 3 };
    sitting.push(rec);
    return rec;
  }

  // ── 红黄牌（第六阶段）：给牌 → 记账 → 两黄/直红罚下（场上人数真的减一）
  let cardHud = null, cardT = 0;
  function showCardHud(kind, name) {
    try {
      if (!cardHud) {
        cardHud = document.createElement('div');
        cardHud.style.cssText = 'position:absolute;top:52px;right:14px;padding:6px 12px;border-radius:8px;background:rgba(8,10,14,.8);border:1px solid rgba(255,255,255,.16);color:#f4f7fb;font:600 13px/1.25 system-ui,sans-serif;z-index:4;opacity:0;transition:opacity .18s;pointer-events:none';
        host.appendChild(cardHud);
      }
      const label = kind === 'red' ? '🟥 红牌罚下'
        : kind === 'handball' ? '✋ 手球 · 判任意球'
          : kind === 'penalty' ? '⚽ 判罚点球'
            : kind === 'sub' ? '🔁 换人'
              : '🟨 黄牌';
      cardHud.textContent = label + (name ? ' · ' + name : '');
      cardHud.style.opacity = '1';
      cardT = 2.4;
    } catch (e) {}
  }

  // ── 点球（第六阶段）：禁区内的犯规/手球 → 罚球点；2.4 s 后由 takePenalty 真实罚出。
  // 进不进**不在这里判**：球飞出去之后仍走 updateBall / keeperTick / judgeExit 那条链路。
  function awardPenalty(offenderTeam, point, why) {
    const attackTeam = offenderTeam === 'home' ? 'away' : 'home';
    const goalZ = attackTeam === 'home' ? L / 2 : -L / 2;     // 攻方要打的球门 = 犯规方守的门
    const spot = penaltySpot(goalZ);
    ball.pos.set(spot.x, BALL.r, spot.z);
    ball.vel.set(0, 0, 0);
    ball.spin.set(0, 0, 0);
    setOwner(null);
    aiState.wall = null;
    aiState.wallTeam = null;
    restart = { teamId: attackTeam, until: elapsed + 2.4, type: 'penalty', point: spot, goalZ };
    ms.setPhase('setPiece', elapsed);
    actionStats.penaltyAward = (actionStats.penaltyAward || 0) + 1;
    actionStats.lastPenaltyAward = { team: attackTeam, offenderTeam, why: why || 'foul', x: +spot.x.toFixed(1), z: +spot.z.toFixed(1) };
    showCardHud('penalty', null);
    try { fw3dAudio.whistle(true); } catch (e) {}
    return { team: attackTeam, offenderTeam, spot, goalZ };
  }

  // 罚出点球：射手（射门属性最好的非门将）打 planPenalty 解算的方向，门将按其"猜向"先移动并做扑救姿态。
  function takePenalty(attackTeam) {
    const team = attackTeam === 'home' ? 'home' : 'away';
    const goalZ = team === 'home' ? L / 2 : -L / 2;
    const spot = penaltySpot(goalZ);
    const sgn = goalZ >= 0 ? 1 : -1;
    const mates = agents.filter((a) => a.team === team && !a.isGk && !a.isUser && !a.off);
    const taker = mates.slice().sort((a, b) => techOf(b.attrs, 'shooting') - techOf(a.attrs, 'shooting'))[0] || null;
    const gk = agents.find((a) => a.isGk && a.team !== team && !a.off) || null;
    if (!taker) return null;
    const plan = planPenalty({
      shooting: techOf(taker.attrs, 'shooting'),
      composure: (taker.attrs && taker.attrs.iq) ? taker.attrs.iq.composure : 0.5,
      keeperAgility: gk && gk.attrs && gk.attrs.phys ? gk.attrs.phys.agility : 0.6,
    });
    // 门将：按猜向先挪一点，再做扑救动作（扑到没扑到交给 keeperTick 的真实 reach 判定）
    if (gk) {
      gk.x = plan.keeperSide * 1.1;
      gk.z = goalZ + sgn * 0.4;
      gk.facing = sgn > 0 ? 0 : Math.PI;
      if (gk.model && gk.model.divePose) gk.model.divePose(plan.keeperSide >= 0 ? 1 : -1, plan.aimY > 1.2);
    }
    // 球：从罚球点飞向 (aimSide*3.0, aimY, goalZ)，初速按飞行时间解算（重力补偿）
    const tx = plan.aimSide * PENALTY.aimSpread;
    const dz = goalZ - spot.z;
    const dist = Math.hypot(tx, dz);
    const t = Math.max(0.25, dist / plan.power);
    ball.pos.set(spot.x, BALL.r, spot.z);
    ball.vel.set(tx / t, (plan.aimY - BALL.r) / t + 0.5 * 9.81 * t, dz / t);
    ball.spin.set(0, 0, 0);
    ball.lastKicker = taker.id;
    ball.lastKickAt = elapsed;
    setOwner(null);
    if (taker.model && taker.model.kick) taker.model.kick(1);
    ms.touch(taker.id, team, elapsed, 'penalty');
    actionStats.penalty = (actionStats.penalty || 0) + 1;
    actionStats.lastPenalty = {
      team, taker: taker.name || taker.id, gk: gk ? (gk.name || gk.id) : null,
      aimSide: plan.aimSide, keeperSide: plan.keeperSide, guessRight: keeperGuessed(plan),
      aimY: plan.aimY, power: plan.power, wild: plan.wild,
    };
    restart = null;
    if (!ms.state.over) ms.resume(elapsed);
    return actionStats.lastPenalty;
  }

  // 红牌后按人数重排阵型（10 人 → 4-4-1；9 人 → 4-3-1）。只改目标点 shape，不动当前位置/属性/动作。
  function rebalanceShape(team) {
    const active = agents.filter((a) => a.team === team && !a.off);
    const pts = reducedShape(active.length, team === 'home' ? 1 : -1);
    if (!pts) return null;
    const gk = active.find((a) => a.isGk);
    if (gk) gk.shape = { x: pts[0].x, z: pts[0].z };
    const outfield = active.filter((a) => !a.isGk).sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < outfield.length && i + 1 < pts.length; i++) {
      outfield[i].shape = { x: pts[i + 1].x, z: pts[i + 1].z };
    }
    actionStats.formation = { team, count: active.length };
    return pts;
  }

  // 罚下：模型移出场、不可见，并从快照/AI/球权判定里消失（不是"隐身但还在踢"）
  function sendOff(agent, why) {
    agent.off = true;
    agent.vx = 0; agent.vz = 0;
    agent.x = (agent.team === 'home' ? -1 : 1) * (W / 2 + 6);
    agent.z = -(L / 2 + 8);
    if (ball.ownerId === agent.id) setOwner(null);
    if (agent.model && agent.model.object) agent.model.object.visible = false;
    actionStats.sentOff = (actionStats.sentOff || 0) + 1;
    actionStats['sentOff_' + agent.team] = (actionStats['sentOff_' + agent.team] || 0) + 1;
    actionStats.lastCard = { id: agent.id, name: agent.name || agent.id, kind: 'red', why: why || '' };
    rebalanceShape(agent.team);   // 少一人 → 整队按 10 人重排（4-4-1）
  }

  function giveCard(agent, kind, why) {
    if (!agent || agent.off || (kind !== 'yellow' && kind !== 'red')) return null;
    const e = addCard(aiState.book, agent.id, kind);
    if (!e) return null;
    if (kind === 'yellow') actionStats.cardYellow = (actionStats.cardYellow || 0) + 1;
    else actionStats.cardRed = (actionStats.cardRed || 0) + 1;
    const shown = (kind === 'yellow' && e.off) ? 'red' : kind;   // 两黄变红按红牌提示
    showCardHud(shown, agent.name || agent.id);
    actionStats.lastCard = { id: agent.id, name: agent.name || agent.id, kind: shown, why: why || '' };
    // 牌面跨场累积：立刻写进 FW.state.fw3dDiscipline（随存档），下场选人时按停赛过滤
    const engineId = agent.attrs && agent.attrs.id != null ? String(agent.attrs.id) : null;
    if (engineId) {
      const reg = disciplineStore();
      const secondYellow = (kind === 'yellow' && e.off);
      reg[engineId] = addCardToRecord(reg[engineId], kind, { secondYellow });
      actionStats.lastDiscipline = { id: engineId, name: agent.name || agent.id, ...normalizeDiscipline(reg[engineId]) };
    }
    try { fw3dAudio.whistle(true); } catch (er) {}
    // 裁判掏牌：亮给被罚的球员（红牌时直接展红牌）
    if (referee) {
      const dist = Math.hypot(agent.x - referee.x, agent.z - referee.z);
      if (dist > 6) referee.task = { x: agent.x, z: agent.z, until: elapsed + 1.6 };
      referee.card(shown);
      actionStats.refCard = { kind: shown, at: +elapsed.toFixed(1), dist: +dist.toFixed(1) };
      // 两名最近的队友围上去抗议（摊手）
      const mates = agents
        .filter((a) => a.team === agent.team && a !== agent && !a.isGk && !a.off)
        .sort((a, b) => Math.hypot(a.x - agent.x, a.z - agent.z) - Math.hypot(b.x - agent.x, b.z - agent.z))
        .slice(0, 2);
      for (const m of mates) { if (m.model && m.model.appealPose) m.model.appealPose(); }
      if (mates.length) actionStats.appeal = (actionStats.appeal || 0) + mates.length;
    }
    if (e.off) sendOff(agent, why);
    return e;
  }

  // ── 换人（P3）：替补登场 / 体力换下 ─────────────────────────────────────────
  const subs = { home: 0, away: 0, inIds: Object.create(null) };
  let subSerial = 0;
  function benchOf(teamKey) { return (bench[teamKey] || []).filter((p) => !subs.inIds[p.id]); }

  // 建一名替补（从边线外侧跑进场）
  function makeSubAgent(teamKey, src) {
    const s = teamKey === 'home' ? 1 : -1;
    subSerial += 1;
    const kit = kitCtx || { shirts: { home: 0xe8eef5, away: 0x243040 }, shorts: { home: 0xffffff, away: 0x1b2430 }, skins: [0xb0805e], modelCache: null };
    const pos = String((src && src.position) || 'CM').toUpperCase();
    const number = Number(src && src.number) || (20 + subSerial);
    const model = createPlayerModel(THREE, {
      jersey: kit.shirts[teamKey], shorts: kit.shorts[teamKey], number,
      name: '', skin: kit.skins[subSerial % kit.skins.length], boot: 0x14161a,
      cache: kit.modelCache,
      appearance: appearanceFor(Object.assign({}, src || {}, { id: (src && src.id) || ('sub' + subSerial) }), {
        overrides: likenessOf(src || {}),
        kit: { jersey: kit.shirts[teamKey], shorts: kit.shorts[teamKey], accent: kit.shorts[teamKey], boot: 0x14161a, socks: 0x14161a, number, gk: false },
      }),
      detail: 'mid',
    });
    const edgeX = s * (W / 2 - 0.8);
    const z0 = Math.max(-24, Math.min(24, (Math.random() - 0.5) * 18));
    model.object.position.set(edgeX, 0, z0);
    scene.add(model.object);
    const agent = {
      id: teamKey + '-sub' + subSerial, team: teamKey, slot: 20 + subSerial, pos,
      name: (src && src.name) || '', number,
      x: edgeX, z: z0, vx: 0, vz: 0, facing: teamKey === 'home' ? 0 : Math.PI,
      stamina: 100, attrs: deriveAttrs(src), isUser: false, isGk: false,
      shape: { x: edgeX * 0.55, z: z0 * 0.6 }, animT: Math.random() * 2, model, subbedIn: true,
    };
    agents.push(agent);
    agentsById[agent.id] = agent;
    chars.push({ model, agent, isMe: false, team: teamKey, walk: 0.8, base: z0, phase: Math.random() * 3 });
    return agent;
  }

  // 执行一次换人：走真实的 pickSub 判定（体力/时间/名额/停赛都在纯逻辑里）
  function doSubNow(teamKey) {
    const t = teamKey === 'away' ? 'away' : 'home';
    const lineup = agents
      .filter((a) => a.team === t && !a.off && !a.subbedOff && !a.isUser)
      .map((a) => ({ id: a.id, position: a.pos, stamina: a.stamina, isGk: a.isGk, off: a.off }));
    const benchList = benchOf(t).map((p) => ({
      id: p.id, position: String(p.position || '').toUpperCase(), ca: Number(p.ca) || 60, banned: false,
    }));
    const pick = pickSub({ minute: ms.state.minute, subsMade: subs[t], maxSubs: SUBS.max, lineup, bench: benchList });
    if (!pick) return { ok: false, reason: (benchList.length ? '不需要换（体力/时间未到）' : '没有替补可用'), subs: subs[t], bench: benchList.length };
    const out = agentsById[pick.offId];
    const src = benchOf(t).find((p) => p.id === pick.onId) || null;
    if (!out || !src) return { ok: false, reason: 'missing', subs: subs[t] };
    // 换下：标记离场（不参与快照/AI/抢断），模型挪到边线外再隐藏
    out.subbedOff = true;
    out.off = true;
    if (out.model) {
      const s = t === 'home' ? 1 : -1;
      out.model.object.visible = false;
      out.x = s * (W / 2 - 0.3);
      out.z = Math.max(-30, Math.min(30, out.z));
    }
    const inn = makeSubAgent(t, src);
    subs[t] += 1;
    subs.inIds[src.id] = true;
    actionStats.subs = (actionStats.subs || 0) + 1;
    actionStats.lastSub = {
      team: t, off: out.name || out.id, on: inn.name || inn.id,
      minute: +ms.state.minute.toFixed(0), reason: pick.reason, samePosition: !!pick.samePosition,
    };
    showCardHud('sub', (out.name || out.id) + ' → ' + (inn.name || inn.id));
    return { ok: true, off: out.id, on: inn.id, minute: +ms.state.minute.toFixed(0), subs: subs[t], reason: pick.reason };
  }

  // 体力：跑动 / 冲刺消耗（门将消耗慢），体力低到阈值后 motor 会自动降速
  function staminaTick(dt) {
    for (const a of agents) {
      if (a.off || a.isUser) continue;
      const sp = Math.hypot(a.vx, a.vz);
      a.stamina = Math.max(0, a.stamina - (0.75 + Math.min(1, sp / 8) * 0.95) * (a.isGk ? 0.35 : 1) * dt);
    }
  }

  // AI 换人：每 3 秒看一次，谁该下就下（最多 3 个）
  let subTickT = 0;
  function autoSubTick(dt) {
    subTickT += dt;
    if (subTickT < 3) return;
    subTickT = 0;
    for (const t of ['home', 'away']) {
      if (subs[t] >= SUBS.max) continue;
      if (!(bench[t] || []).length) continue;
      const lowest = agents.filter((a) => a.team === t && !a.off && !a.subbedOff && !a.isGk && !a.isUser)
        .sort((a, b) => a.stamina - b.stamina)[0];
      if (!lowest) continue;
      const d = shouldSub({ minute: ms.state.minute, stamina: lowest.stamina, subsMade: subs[t], maxSubs: SUBS.max });
      if (d.sub) doSubNow(t);
    }
  }

  function pitchInput() {
    return {
      t: elapsed, dt: 0, tick: 0,
      ball: {
        x: ball.pos.x, y: ball.pos.y, z: ball.pos.z,
        vx: ball.vel.x, vz: ball.vel.z,
        speed: Math.hypot(ball.vel.x, ball.vel.z),
        ownerId: ball.ownerId || null, ownerTeam: ball.ownerTeam || null,
        lastTouchId: ms.state.lastTouch.playerId, lastTouchTeam: ms.state.lastTouch.teamId,
      },
      players: agents.filter((a) => !a.off),   // 被罚下的不进入快照 → AI/角色/阵型自动按少一人算
      pitch: PITCH,
      teams: { home: { attackZ: 1, label: homeLabel }, away: { attackZ: -1, label: awayLabel } },
      match: ms.snapshot(),
    };
  }

  function applyIntents(dt, intents) {
    for (const it of intents) {
      const agent = agentsById[it.id];
      if (!agent || agent.isUser) continue;
      // 倒地/起身期间不能跑（滑铲后要在草上缓一下）
      if (agent.downUntil && elapsed < agent.downUntil) {
        agent.vx *= 0.85; agent.vz *= 0.85;
        stepPlayer(agent, { x: agent.x, z: agent.z, pace: 0 }, dt, A, PITCH, agents);
        continue;
      }
      stepPlayer(agent, it, dt, A, PITCH, agents);
      // 急停变向：高速下朝向突变 > 66° → 播 cutPose（重心下沉、外侧腿摆出去）
      const sp = Math.hypot(agent.vx, agent.vz);
      if (sp > 5) {
        let dAng = agent.facing - (agent.prevFacing == null ? agent.facing : agent.prevFacing);
        while (dAng > Math.PI) dAng -= Math.PI * 2;
        while (dAng < -Math.PI) dAng += Math.PI * 2;
        if (Math.abs(dAng) > 1.15 && agent.model && agent.model.cutPose) {
          agent.model.cutPose(dAng >= 0 ? 1 : -1);
          actionStats.cut = (actionStats.cut || 0) + 1;
        }
      }
      agent.prevFacing = agent.facing;
    }
  }

  // 触球窗口到了才真正出脚（出脚前再校验一次"球还在脚下"）
  function tryAiKick(k) {
    const agent = agentsById[k.playerId];
    if (!agent || agent.isUser || restart) return;
    if (ball.ownerId !== agent.id) return;
    if (Math.hypot(ball.pos.x - agent.x, ball.pos.z - agent.z) > 2.1) return;
    const from = { x: agent.x, z: agent.z };
    let solved = null;
    if (k.type === 'pass') {
      if (!k.targetId || !agentsById[k.targetId]) return;
      // 越位：传球给越位位置的队友 → 判越位，改判守方后场任意球（吹哨 + 重开）
      const snap = brain.lastSnapshot();
      if (snap && isOffside(snap, k.targetId)) {
        const rec = agentsById[k.targetId];
        setOwner(null);
        ball.pos.set(rec.x, BALL.r, rec.z);
        ball.vel.set(0, 0, 0); ball.spin.set(0, 0, 0);
        restart = { teamId: agent.team === 'home' ? 'away' : 'home', until: elapsed + 2.2, type: 'freeKick', point: { x: rec.x, z: rec.z } };
        ms.setPhase('setPiece', elapsed);
        actionStats.offside = (actionStats.offside || 0) + 1;
        // 边裁举旗（越位方那张边线上的人）：先朝越位位置跑，再举旗
        if (linesmen.length) {
          const lm = linesmen.reduce((a, b) => (Math.abs(a.z - rec.z) <= Math.abs(b.z - rec.z) ? a : b));
          lm.flag('offside');
          actionStats.linesmanFlag = (actionStats.linesmanFlag || 0) + 1;
        }
        try { fw3dAudio.whistle(true); } catch (e) {}
        return;
      }
      solved = solvePass({ from, to: k.point, attrs: agent.attrs, pressure: k.pressure, cfg: A });
    } else if (k.type === 'shoot') {
      solved = solveShot({ from, goal: k.point, attrs: agent.attrs, pressure: k.pressure, power: k.power, cfg: A });
    } else if (k.type === 'clear') {
      solved = solveClear({ from, point: k.point, attrs: agent.attrs, pressure: k.pressure, cfg: A, attackZ: agent.team === 'home' ? 1 : -1 });
    }
    if (!solved) return;
    kickFrom(agent, solved, k.type);
  }

  function aiTick(dt) {
    aiState.accum += dt;
    const step = 1 / Math.max(1, A.rates.snapshotHz);
    if (aiState.accum >= step || !aiState.intents.length) {
      aiState.accum = 0;
      const out = brain.update(pitchInput(), Math.max(dt, step * 0.5));
      aiState.intents = out.intents || [];
      aiState.lastDebug = out.debug;
      // 定位球：开球方最近 3 人按规则站位（界外球一近一远、角球前点后点、球门球两翼）
      // 任意球人墙：守方最近两人站到球前 9.15 m
      if (restart && restart.type === 'freeKick' && aiState.wall && aiState.intents.length) {
        const wallMates = agents
          .filter((a) => a.team === aiState.wallTeam && !a.isGk && !a.isUser && !a.off)
          .sort((a, b) => Math.hypot(a.x - restart.point.x, a.z - restart.point.z) - Math.hypot(b.x - restart.point.x, b.z - restart.point.z));
        for (let i = 0; i < Math.min(aiState.wall.length, wallMates.length); i++) {
          const it = aiState.intents.find((x) => x.id === wallMates[i].id);
          if (it) { it.x = aiState.wall[i].x; it.z = aiState.wall[i].z; it.pace = 0.6; it.setPiece = 'wall'; }
        }
      }
      if (restart && restart.type === 'penalty' && aiState.intents.length) {
        // 点球：除主罚者外，双方球员都退到禁区外（禁区深 16.5 m），门将留在门线上
        const goalZ = restart.goalZ != null ? restart.goalZ : (restart.teamId === 'home' ? L / 2 : -L / 2);
        const s = goalZ >= 0 ? 1 : -1;
        const attackers = agents.filter((a) => a.team === restart.teamId && !a.isGk && !a.isUser && !a.off);
        const taker = attackers.slice().sort((x, y) => techOf(y.attrs, 'shooting') - techOf(x.attrs, 'shooting'))[0] || null;
        const defenders = agents.filter((a) => a.team !== restart.teamId && !a.isGk && !a.isUser && !a.off);
        const ringA = penaltyRing(goalZ, Math.max(1, attackers.length - 1));
        const ringD = penaltyRing(goalZ, defenders.length);
        let ia = 0, id = 0;
        for (const mate of attackers) {
          const it = aiState.intents.find((x) => x.id === mate.id);
          if (!it) continue;
          if (taker && mate.id === taker.id) {
            it.x = restart.point.x; it.z = restart.point.z - s * 2.0; it.pace = 0.25; it.setPiece = 'taker';
          } else {
            const p = ringA[ia++ % ringA.length];
            it.x = p.x; it.z = p.z; it.pace = 0.55; it.setPiece = 'penaltyRing';
          }
        }
        for (const d of defenders) {
          const it = aiState.intents.find((x) => x.id === d.id);
          if (!it) continue;
          const p = ringD[id++ % ringD.length];
          it.x = p.x; it.z = p.z; it.pace = 0.55; it.setPiece = 'penaltyRing';
        }
      } else if (restart && restart.type !== 'goal' && aiState.intents.length) {
        const pts = setPieceTargets(restart.type, restart.point, PITCH);
        const mates = agents
          .filter((a) => a.team === restart.teamId && !a.isGk && !a.isUser && !a.off)
          .sort((a, b) => Math.hypot(a.x - restart.point.x, a.z - restart.point.z) - Math.hypot(b.x - restart.point.x, b.z - restart.point.z));
        for (let i = 0; i < Math.min(pts.length, mates.length); i++) {
          const it = aiState.intents.find((x) => x.id === mates[i].id);
          if (it) { it.x = pts[i].x; it.z = pts[i].z; it.pace = 0.7; it.setPiece = pts[i].role; }
        }
      }
      for (const k of (out.kicks || [])) tryAiKick(k);
      debugHud.update(out.snapshot, out.debug);
    }
    applyIntents(dt, aiState.intents);
  }

  // 第一脚接球质量（0–1）：正面迎着来球、球不太快 → 停得稳；背面/高速 → 容易弹开
  function firstTouchQuality(agent, inSpeed) {
    const sp = Math.max(0.01, inSpeed);
    const bx = -ball.vel.x / sp, bz = -ball.vel.z / sp;       // 来球飞行的反方向（球从哪来）
    const fx = Math.sin(agent.facing), fz = Math.cos(agent.facing);
    const align = Math.max(0, fx * bx + fz * bz);             // 正面接球更好
    const pace = Math.max(0, 1 - Math.min(1, sp / 26));       // 球越快越难停
    return Math.max(0, Math.min(1, align * 0.65 + pace * 0.45));
  }

  // 第一脚接球（NPC 与玩家共用）：接球姿态 + 停球分档 + 球速吸收。
  // 抽出来是因为玩家现在也会接管球权 —— 之前这段只写给 NPC，玩家接球是另一份重复实现
  // （arena 末尾的 firstTouch IIFE），两边的吸收率早晚会漂移。
  // 返回 null 表示球太慢、不需要"接"这一次。
  function receiveBall(agent) {
    const inSpeed = Math.hypot(ball.vel.x, ball.vel.z);
    if (inSpeed <= 3.5) return null;
    const q = firstTouchQuality(agent, inSpeed);
    if (agent.model && agent.model.receivePose) agent.model.receivePose(q);
    // 停球分档：高球用胸/大腿停，低球用脚（动作不同，视觉上能看出来）
    const zone = trapZone(ball.pos.y);
    if (agent.model && zone === 'chest' && agent.model.trapChestPose) agent.model.trapChestPose();
    else if (agent.model && zone === 'thigh' && agent.model.trapThighPose) agent.model.trapThighPose();
    // 胸部/大腿停球吸得更多（球更贴脚）
    const absorb = clamp(0.3 + q * 0.5 + (zone === 'chest' ? 0.12 : zone === 'thigh' ? 0.07 : 0), 0.3, 0.95);
    ball.vel.x *= (1 - absorb);
    ball.vel.z *= (1 - absorb);
    ms.touch(agent.id, agent.team, elapsed, 'receive');
    return { q, zone };
  }

  // 球权判定 + 带球（都只用速度约束，不瞬移球的位置）
  function ballTick(dt) {
    // 门将抱球：球贴在手上，任何人不许抢；到时自动手抛球
    const hold = aiState.gkHold;
    if (hold) {
      const gk = agentsById[hold.id];
      if (!gk || elapsed >= hold.until) {
        aiState.gkHold = null;
        if (gk) {
          // 分球：25 m 内有队友 → 手抛球；否则开大脚到前场
          const dist = keeperDistribution(gk, agents.filter((a) => a.team === gk.team && !a.isGk));
          if (dist.mode === 'punt') {
            const nx = dist.point.x - gk.x, nz = dist.point.z - gk.z;
            const nl = Math.hypot(nx, nz) || 1;
            ball.vel.set(nx / nl * dist.speed, dist.loft, nz / nl * dist.speed);
            ball.spin.set(0, 0, 0);
            ball.lastKicker = gk.id;
            ball.lastKickAt = elapsed;
            setOwner(null);
            ms.touch(gk.id, gk.team, elapsed, 'keeperPunt');
            actionStats.keeperPunt = (actionStats.keeperPunt || 0) + 1;
            if (gk.model && gk.model.kick) gk.model.kick(1);
            try { if (window.FWSound && FWSound.play) FWSound.play('whistle'); } catch (e) {}
            return;
          }
          let mate = null, bd = 1e9;
          for (const a of agents) {
            if (a === gk || a.isGk || a.team !== gk.team) continue;
            const d = Math.hypot(a.x - gk.x, a.z - gk.z);
            if (d < bd) { bd = d; mate = a; }
          }
          if (mate) {
            const nx = (mate.x - gk.x) / (bd || 1), nz = (mate.z - gk.z) / (bd || 1);
            ball.vel.set(nx * 12, 1.6, nz * 12);
            ball.spin.set(0, 0, 0);
            ball.lastKicker = gk.id;
            ball.lastKickAt = elapsed;
            setOwner(null);
            ms.touch(gk.id, gk.team, elapsed, 'keeperThrow');
            actionStats.keeperThrow = (actionStats.keeperThrow || 0) + 1;
            if (gk.model && gk.model.kick) gk.model.kick(0.5);
            try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
          }
        }
        return;
      }
      if (gk) {
        ball.pos.set(gk.x + Math.sin(gk.facing) * 0.42, BALL.r + 0.55, gk.z + Math.cos(gk.facing) * 0.42);
        ball.vel.set(0, 0, 0);
        return;
      }
    }
    const sp = Math.hypot(ball.vel.x, ball.vel.z);
    // 只有"脚下到胸口"这个高度带才谈得上接管球权：更高的球应该用头去顶（headerTick），
    // 否则会出现"用头顶停球"——玩家起跳后球被自己的停球逻辑吸走，永远顶不出去。
    if (!ball.ownerId && sp < A.ball.controlMaxSpeed && ball.pos.y < 1.6) {
      const userDist = Math.hypot(ctrl.pos.x - ball.pos.x, ctrl.pos.z - ball.pos.z);
      let best = null, bd = A.ball.controlRadius;
      for (const a of agents) {
        if (a.isUser || a.isGk || a.off) continue;
        if (restart && a.team !== restart.teamId) continue;
        if (a.id === ball.lastKicker && elapsed - ball.lastKickAt < 0.5) continue;
        if (userDist < A.ball.protectUserRadius) break;    // 玩家脚下不抢球
        const d = Math.hypot(a.x - ball.pos.x, a.z - ball.pos.z);
        if (d < bd) { bd = d; best = a; }
      }
      if (best) {
        // 第一脚接球（第四阶段）：动作与吸收率统一由 receiveBall 处理（NPC/玩家共用）
        const rec = receiveBall(best);
        if (rec) {
          actionStats.npcReceive = (actionStats.npcReceive || 0) + 1;
          actionStats.npcReceiveQ = +rec.q.toFixed(2);
          actionStats.npcReceiveZone = rec.zone;
        }
        setOwner(best);
      }
    }
    // ── 玩家接管球权：上面的循环按设计跳过 isUser（避免 AI 与玩家抢同一脚），
    //    所以「球在你脚下」这件事只能在这里登记。登记之后带球吸附、对手抢断、
    //    以及比赛状态里的控球率与最后触球才都认得你 —— 手机端双语义键的判据也由此而来。
    //    高度闸门必须和 AI 那条一模一样：漏掉它，玩家会"用头顶停球"（2 m 的球被自己的
    //    停球逻辑吸到脚下），头球判定永远看不到高球 —— 这一条曾经把玩家头球整个堵死。
    if (!ball.ownerId && sp < A.ball.controlMaxSpeed && ball.pos.y < 1.6) {
      const me = playerAgent();
      const freshKick = me && me.id === ball.lastKicker && elapsed - ball.lastKickAt < PLAYER_KICK_LOCK;
      const down = me && me.downUntil && elapsed < me.downUntil;
      const mine = me && (!restart || restart.teamId === me.team);   // 与 AI 同一条重开球规则
      const dMe = Math.hypot(ctrl.pos.x - ball.pos.x, ctrl.pos.z - ball.pos.z);
      if (me && !freshKick && !down && mine && dMe < A.ball.controlRadius) {
        const rec = receiveBall(me);
        if (rec) {
          actionStats.userReceive = (actionStats.userReceive || 0) + 1;
          actionStats.userReceiveQ = +rec.q.toFixed(2);
          actionStats.userReceiveZone = rec.zone;
        }
        setOwner(me);
      }
    }
    const owner = ball.ownerId ? agentsById[ball.ownerId] : null;
    if (!owner) return;
    const d = Math.hypot(ball.pos.x - owner.x, ball.pos.z - owner.z);
    if (d > 2.5) { setOwner(null); return; }
    if (elapsed - (aiState.lastDribbleT || 0) > 0.4) { aiState.dribble++; aiState.lastDribbleT = elapsed; }
    const dirx = Math.sin(owner.facing), dirz = Math.cos(owner.facing);
    const tx = owner.x + dirx * A.ball.dribbleAhead;
    const tz = owner.z + dirz * A.ball.dribbleAhead;
    const os = Math.hypot(owner.vx, owner.vz);
    const cap = Math.max(2.2, os * A.ball.dribbleSpeed + A.ball.dribbleBase);
    let wvx = (tx - ball.pos.x) * 9, wvz = (tz - ball.pos.z) * 9;
    const l = Math.hypot(wvx, wvz) || 1;
    const sv = Math.min(cap, l);
    const k = Math.min(1, dt * 14);
    ball.vel.x += (wvx / l * sv - ball.vel.x) * k;
    ball.vel.z += (wvz / l * sv - ball.vel.z) * k;
    ball.vel.y = 0;
    ball.pos.y = BALL.r;
  }

  // 犯规出口（贴身抢断 / 滑铲共用）：禁区内 → 点球，禁区外 → 任意球 + 人墙；顺带出牌、裁判示意
  function foulExit(offender, victim, angleCos, why) {
    const pt = { x: victim.x, z: victim.z };
    const offenderGoalZ = offender.team === 'home' ? -L / 2 : L / 2;
    const inBox = inPenaltyArea(pt.x, pt.z, offenderGoalZ);
    if (inBox) {
      awardPenalty(offender.team, pt, why || '禁区内犯规');
    } else {
      ball.pos.set(pt.x, BALL.r, pt.z);
      ball.vel.set(0, 0, 0); ball.spin.set(0, 0, 0);
      setOwner(null);
      restart = { teamId: victim.team, until: elapsed + 2.2, type: 'freeKick', point: pt };
      aiState.wall = freeKickWall(pt, victim.attackZ, 2);
      aiState.wallTeam = offender.team;
      ms.setPhase('setPiece', elapsed);
    }
    actionStats.foul = (actionStats.foul || 0) + 1;
    // 裁判：跑到球边、指方向（点球时指球门）
    if (referee) {
      referee.point(victim.attackZ >= 0 ? 1 : -1);
      referee.task = { x: pt.x, z: pt.z, until: elapsed + 2.2 };
    }
    // 红黄牌（第六阶段）：破坏明显进球机会以红为主，背后/冲刺黄概率高；判定全部走 ai/cards.js
    const goalZ = victim.team === 'home' ? L / 2 : -L / 2;
    let blockers = 0;
    for (const a of agents) {
      if (a.off || a.team === victim.team) continue;
      const dx = 0 - victim.x, dz = goalZ - victim.z;
      const L2 = dx * dx + dz * dz;
      if (L2 < 1) continue;
      const tt2 = ((a.x - victim.x) * dx + (a.z - victim.z) * dz) / L2;
      if (tt2 < 0.05 || tt2 > 0.95) continue;
      const px = victim.x + dx * tt2, pz = victim.z + dz * tt2;
      if (Math.hypot(a.x - px, a.z - pz) < 2.2) blockers++;
    }
    const speedNow = Math.hypot(offender.vx, offender.vz);
    const dogso = isDogso({
      distToGoal: Math.hypot(victim.x, victim.z - goalZ),
      blockers,
      depth: (victim.z * victim.attackZ + L / 2) / L,
    });
    const card = rollCard(cardChance({
      angleCos,
      speed: speedNow,
      reckless: angleCos < -0.5 && speedNow > 6,
      deniedGoal: dogso,
    }));
    if (card !== 'none') {
      giveCard(offender, card, dogso ? '破坏明显进球机会' : (why || (angleCos < -0.15 ? '背后犯规' : '战术犯规')));
    }
    try { fw3dAudio.whistle(true); } catch (e) {}
    if (referee) referee.whistle();
    return { inBox, card };
  }

  // 滑铲：铲到球 → 球被铲出去 + 对方失衡；铲空 → 自己倒地；滑铲更容易犯规
  function doSlideTackle(tackler, carrier, info) {
    const i = info || {};
    const angleCos = isFinite(i.angleCos) ? i.angleCos : -0.3;
    const skill = isFinite(i.tackling) ? i.tackling : techOf(tackler.attrs, 'tackling');
    const side = Math.sign(tackler.x - carrier.x) || 1;
    if (tackler.model && tackler.model.slide) tackler.model.slide();
    const hitP = clamp(0.42 + skill * 0.40 - Math.max(0, angleCos) * 0.2, 0.2, 0.9);
    const foulP = clamp(
      foulChance({ angleCos, speed: Math.hypot(tackler.vx, tackler.vz), tackling: skill })
      + (angleCos < 0 ? SLIDE.foulBonus : SLIDE.foulBonus * 0.45), 0.02, 0.9);
    const fouled = i.forceMiss ? false : (Math.random() < foulP);
    const gotBall = i.forceMiss ? false : (!fouled && Math.random() < hitP);
    actionStats.slide = (actionStats.slide || 0) + 1;
    tackler.downUntil = elapsed + getUpTime({ failed: !gotBall, tackling: skill });
    if (tackler.model && tackler.model.downPose) {
      // 铲完接着在草上滑停（滑铲动作 0.9 s 内部已播完，这里接 0.4 s 起身前的缓冲）
      setTimeout(() => { try { tackler.model.getUpPose(side); } catch (e) {} }, Math.max(200, (tackler.downUntil - elapsed) * 1000 - 350));
    }
    if (gotBall) {
      setOwner(null);
      const out = 3.4 + Math.random() * 2.6;
      ball.vel.x = side * out * (0.5 + Math.random() * 0.5) + carrier.vx * 0.2;
      ball.vel.z = (Math.random() < 0.5 ? -1 : 1) * out * 0.55 + carrier.vz * 0.15;
      ball.vel.y = 0.9 + Math.random();
      if (carrier.model && carrier.model.stumblePose) carrier.model.stumblePose();
      actionStats.slideWin = (actionStats.slideWin || 0) + 1;
      aiState.lastSlide = { by: tackler.id, win: true, foul: false, at: +elapsed.toFixed(1) };
      ms.touch(tackler.id, tackler.team, elapsed, 'slide');
      try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
    } else {
      // 铲空：倒地的是铲球者自己；只有犯规（铲到人）才让持球者失衡
      if (tackler.model && tackler.model.stumblePose) tackler.model.stumblePose();
      if (fouled && carrier.model && carrier.model.stumblePose) carrier.model.stumblePose();
      aiState.lastSlide = { by: tackler.id, win: false, foul: !!fouled, at: +elapsed.toFixed(1) };
      if (fouled) foulExit(tackler, carrier, angleCos, '滑铲犯规');
    }
    return { win: gotBall, foul: fouled, getUpAt: tackler.downUntil };
  }

  // 一对一对抗：防守方贴身时按"抢断 vs 盘带"判定能否断下来（第五阶段收尾）
  const tackleCd = Object.create(null);
  let lastStealT = -9;
  function tackleTick(dt) {
    if (restart || ms.state.phase === 'goalPause' || aiState.gkHold) return;
    const owner = ball.ownerId ? agentsById[ball.ownerId] : null;
    if (owner) {
      let best = null, bd = A.ball.tackleRadius;
      for (const a of agents) {
        if (a.team === owner.team || a.isGk) continue;
        const d = Math.hypot(a.x - owner.x, a.z - owner.z);
        if (d < bd) { bd = d; best = a; }
      }
      if (!best || (tackleCd[best.id] || 0) > elapsed) return;
      tackleCd[best.id] = elapsed + DUEL.cooldown;
      // 协防包夹：统计同队其它人在持球者 doubleRadius 内的数量
      let helpers = 0;
      for (const a of agents) {
        if (a === best || a.team !== best.team || a.isGk) continue;
        if (Math.hypot(a.x - owner.x, a.z - owner.z) < DUEL.doubleRadius) helpers++;
      }
      // ── 滑铲（P0）：距离稍远、从侧后方追上来时，可能选择铲球而不是贴身抢断
      if (!(best.downUntil && elapsed < best.downUntil) && bd > SLIDE.minDist && bd < SLIDE.maxDist) {
        const toOwner = { x: best.x - owner.x, z: best.z - owner.z };
        const tl = Math.hypot(toOwner.x, toOwner.z) || 1;
        const fx = Math.sin(owner.facing), fz = Math.cos(owner.facing);
        const slideCos = (toOwner.x * fx + toOwner.z * fz) / tl;
        const tackleSkill = techOf(best.attrs, 'tackling');
        const slideP = slideTackleChance({
          dist: bd, angleCos: slideCos, speed: Math.hypot(best.vx, best.vz), tackling: tackleSkill,
        });
        if (Math.random() < slideP) {
          doSlideTackle(best, owner, { angleCos: slideCos, tackling: tackleSkill });
          return;
        }
      }
      // 玩家现在会被登记为持球者，护球（按住 Q）必须继续生效 —— 旧实现里"玩家护球"只在
      // 另一条 !ownerId 的分支里读过 ctrl.shield，玩家一有球权就丢了护球效果。
      const shielding = !!(owner.isUser && ctrl.shield);
      const p = tackleChance({ tackler: best, carrier: owner, shielding, tacklerStamina: best.stamina, carrierStamina: owner.stamina, helpers });
      if (Math.random() < p) {
        setOwner(best);
        best.stamina = Math.max(0, best.stamina - 3);
        owner.stamina = Math.max(0, owner.stamina - 5);
        if (owner.model && owner.model.stumblePose) owner.model.stumblePose();
        actionStats.tackle = (actionStats.tackle || 0) + 1;
        ms.touch(best.id, best.team, elapsed, 'tackle');
        try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
      } else if (Math.random() < DUEL.loseBalanceChance) {
        // 上抢失败 → 自己失位，给持球者一点空间；同时按角度/速度判定是否犯规
        const toT = { x: best.x - owner.x, z: best.z - owner.z };
        const tl = Math.hypot(toT.x, toT.z) || 1;
        const fx = Math.sin(owner.facing), fz = Math.cos(owner.facing);
        const angleCos = (toT.x * fx + toT.z * fz) / tl;
        const foul = foulChance({ angleCos, speed: Math.hypot(best.vx, best.vz), tackling: techOf(best.attrs, 'tackling') });
        if (Math.random() < foul) {
          foulExit(best, owner, angleCos, angleCos < -0.15 ? '背后犯规' : '战术犯规');
          return;
        }
        best.vx *= 0.35; best.vz *= 0.35;
        if (best.model && best.model.turnPose) best.model.turnPose(Math.random() < 0.5 ? 1 : -1);
      }
      return;
    }
    // 球在玩家脚下：对手贴身时有几率抢走（按住 Q 护球会大幅降低）
    const userD = Math.hypot(ctrl.pos.x - ball.pos.x, ctrl.pos.z - ball.pos.z);
    if (userD > 1.05 || elapsed - lastStealT < 0.9) return;
    let opp = null, od = 1.15;
    for (const a of agents) {
      if (a.team !== 'away' || a.isGk || a.off) continue;
      const d = Math.hypot(a.x - ctrl.pos.x, a.z - ctrl.pos.z);
      if (d < od) { od = d; opp = a; }
    }
    if (!opp) return;
    lastStealT = elapsed;
    const meA = agents.find((a) => a.isUser);
    const p = tackleChance({ tackler: opp, carrier: meA, shielding: !!ctrl.shield, tacklerStamina: opp.stamina, carrierStamina: ctrl.stamina });
    if (Math.random() < p * 0.8) {
      setOwner(opp);
      actionStats.steal = (actionStats.steal || 0) + 1;
      actionStats.tackle = (actionStats.tackle || 0) + 1;
      ms.touch(opp.id, opp.team, elapsed, 'tackle');
      try { fw3dAudio.whistle(false); } catch (e) {}
    } else {
      // 抢断失败：可能犯规（对玩家），判玩家一方任意球，必要时出牌（红黄牌对玩家同样生效）
      const toT = { x: opp.x - ctrl.pos.x, z: opp.z - ctrl.pos.z };
      const tl = Math.hypot(toT.x, toT.z) || 1;
      const pf = meA ? meA.facing : (ctrl.yaw + Math.PI);
      const fsx = Math.sin(pf), fsz = Math.cos(pf);
      const angleCos = (toT.x * fsx + toT.z * fsz) / tl;
      const oppSpeed = Math.hypot(opp.vx, opp.vz);
      const foulP = foulChance({ angleCos, speed: oppSpeed, tackling: techOf(opp.attrs, 'tackling') });
      if (Math.random() < foulP) {
        const pt = { x: ball.pos.x, z: ball.pos.z };
        ball.vel.set(0, 0, 0); ball.spin.set(0, 0, 0);
        setOwner(null);
        const myTeam = meA ? meA.team : 'home';
        restart = { teamId: myTeam, until: elapsed + 2.2, type: 'freeKick', point: pt };
        aiState.wall = freeKickWall(pt, myTeam === 'home' ? 1 : -1, 2);
        aiState.wallTeam = myTeam === 'home' ? 'away' : 'home';
        ms.setPhase('setPiece', elapsed);
        actionStats.foul = (actionStats.foul || 0) + 1;
        const card = rollCard(cardChance({ angleCos, speed: oppSpeed, reckless: angleCos < -0.5 && oppSpeed > 6 }));
        if (card !== 'none') giveCard(opp, card, '对玩家犯规');
        try { fw3dAudio.whistle(true); } catch (e) {}
      } else {
        opp.vx *= 0.5; opp.vz *= 0.5;
      }
    }
  }

  // 开始庆祝：记下进球者 → 第三人称转播镜头 + 进球者庆祝动作（滑跪/张臂/指天）
  function startCelebration(teamId, kindOverride) {
    const scorerId = ms.state.lastTouch && ms.state.lastTouch.playerId ? ms.state.lastTouch.playerId : null;
    celebrate.t = 3.8;
    celebrate.phase = 0;
    celebrate.teamId = teamId || 'home';
    celebrate.scorerId = scorerId;
    // 从进球者"正面偏 20°"起镜（3/4 前侧，能看到脸和号码正面）
    // 注意：模型局部正面是 -z，所以相机要先转到 facing + π 才是他的正前方
    const scorer = scorerId ? agentsById[scorerId] : null;
    const f = scorer ? scorer.facing : 0;
    celebrate.ang0 = f + Math.PI + (celebrate.teamId === 'away' ? -0.35 : 0.35);
    actionStats.celebrate = (actionStats.celebrate || 0) + 1;
    // 进球者自己庆祝 + 最近的 2 名队友一起冲过来（不同庆祝动作，看起来像真的在庆祝）
    const kinds = ['arms', 'sky', 'slid', 'knee'];
    // 庆祝动作要和 3.8 s 的转播镜头等长，否则近景推到位时人已经停了
    if (scorer && scorer.model && scorer.model.celebratePose) {
      scorer.model.celebratePose(kindOverride || (celebrate.teamId === 'home' ? (persona.celebrate || 'arms') : 'arms'), 3.6);
    }
    const mates = agents
      .filter((a) => a.team === celebrate.teamId && a !== scorer && !a.isGk && !a.off)
      .sort((a, b) => Math.hypot(a.x - (scorer ? scorer.x : 0), a.z - (scorer ? scorer.z : 0))
        - Math.hypot(b.x - (scorer ? scorer.x : 0), b.z - (scorer ? scorer.z : 0)))
      .slice(0, 2);
    mates.forEach((m, i) => {
      if (m.model && m.model.celebratePose) m.model.celebratePose(kinds[(i + 1) % kinds.length], 3.0);
    });
    celebrate.mates = mates.length;
    return { scorerId, teamId: celebrate.teamId, mates: mates.length, ang0: +celebrate.ang0.toFixed(2) };
  }

  // 出界 / 进球 / 重开球（规则判定在 ai/rules.js，比分权威仍在引擎时间线）
  function checkOutOfPlay() {
    if (restart) {
      if (elapsed >= restart.until) {
        const ended = restart;
        restart = null;
        // 点球：时间到了先助跑 0.5 s，再真的罚（进不进由物理 + 门将判定，不在这里改比分）
        if (ended.type === 'penalty') { startPenaltyRunUp(ended); return; }
        if (ended.type === 'penaltyRun') { takePenalty(ended.teamId); return; }
        // 界外球：时间到了由最近的队友把球掷进场（有掷球动作，不是凭空放到脚下）
        if (ended.type === 'throwIn') { takeThrowIn(ended); return; }
        if (!ms.state.over) ms.resume(elapsed);
      }
      return;
    }
    const exit = judgeExit({
      ball: { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z },
      pitch: PITCH,
      lastTouchTeam: ms.state.lastTouch.teamId,
    });
    if (!exit) return;
    const pt = exit.type === 'goal' ? { x: 0, z: 0 } : exit.point;
    ball.pos.set(pt.x, BALL.r, pt.z);
    ball.vel.set(0, 0, 0);
    ball.spin.set(0, 0, 0);
    setOwner(null);
    const team = exit.type === 'goal' ? (exit.teamId === 'home' ? 'away' : 'home') : exit.teamId;
    restart = { teamId: team, until: elapsed + 2.2, type: exit.type, point: pt };
    // 界外球指定掷球者（离球最近的队友）：2.2 s 内走到边线，时间到 takeThrowIn 掷进场
    if (exit.type === 'throwIn') {
      const cand = agents
        .filter((a) => a.team === team && !a.isGk && !a.isUser && !a.off)
        .sort((a, b) => Math.hypot(a.x - pt.x, a.z - pt.z) - Math.hypot(b.x - pt.x, b.z - pt.z));
      if (cand[0]) restart.takerId = cand[0].id;
      // 边裁举旗示意界外球方向
      if (linesmen.length) linesmen[pt.x >= 0 ? 0 : 1].flag('throwIn');
    } else if (exit.type === 'corner') {
      if (linesmen.length) linesmen[pt.x >= 0 ? 0 : 1].flag('corner');
    }
    aiState.restarts++;
    actionStats.restarts = aiState.restarts;
    actionStats['restart_' + exit.type] = (actionStats['restart_' + exit.type] || 0) + 1;
    ms.setPhase(exit.type === 'goal' ? 'goalPause' : 'setPiece', elapsed);
    if (exit.type === 'goal') {
      // ── 自由观赛：进球要过「脚本裁定」——3D 的比分必须等于 2D 已经算出的结果
      if (spectateMode) {
        const p = specScript.pending;
        const credited = !!(p && p.team === exit.teamId && (elapsed - p.at) < 9);
        if (!credited) {
          // 不是脚本里那一脚 → 判进球无效（越位/进攻方犯规），球门球重开，比分不动
          const def = exit.teamId === 'home' ? 'away' : 'home';
          const gz = (exit.teamId === 'home' ? 1 : -1) * (L / 2 - 5.5);
          restart = { teamId: def, until: elapsed + 2.4, type: 'goalKick', point: { x: 0, z: gz } };
          ball.pos.set(0, BALL.r, gz);
          ball.vel.set(0, 0, 0);
          ball.spin.set(0, 0, 0);
          setOwner(null);
          ms.setPhase('setPiece', elapsed);
          specScript.pending = null;
          specScript.disallowed++;
          try { fw3dAudio.whistle(false); } catch (e) {}
          toast('进球无效 · 越位在先（比分以官方为准）', 2600);
          return;
        }
        creditScriptedGoal(exit.teamId, p.scorer, p.minute, false);
        return;
      }
      try { fw3dAudio.cheer(); fw3dAudio.boost(2.2); setTimeout(function () { fw3dAudio.boost(1); }, 2600); } catch (e) {}
      goalOverlay({ minute: Math.floor(ms.state.minute), scorer: exit.teamId === 'home' ? homeLabel : awayLabel });
      // 庆祝镜头：**两队都切第三视角**（进球方欢呼、失球方也能看到回放式的近景）
      if (matchMode) startCelebration(exit.teamId);
      ms.goal(exit.teamId, elapsed);
    } else {
      try { fw3dAudio.whistle(false); } catch (e) {}
    }
  }

  // 界外球：把球放到掷球者手里，掷向最近的队友（8–14 m），带弧线
  function takeThrowIn(info) {
    const taker = info && info.takerId ? agentsById[info.takerId] : null;
    if (!taker) { if (!ms.state.over) ms.resume(elapsed); return null; }
    if (taker.model && taker.model.throwInPose) taker.model.throwInPose();
    const inside = (p) => Math.abs(p.x) < PITCH.halfW - 1 && Math.abs(p.z) < PITCH.halfL - 1;
    const mates = agents.filter((a) => a.team === taker.team && a !== taker && !a.isGk && !a.off && inside(a));
    const target = mates.slice().sort((a, b) => Math.hypot(a.x - taker.x, a.z - taker.z) - Math.hypot(b.x - taker.x, b.z - taker.z))[0] || null;
    const towardIn = -Math.sign(taker.x || 1);          // 往场内掷
    const tx = target ? target.x : taker.x + towardIn * 9;
    const tz = target ? target.z : taker.z + (Math.random() - 0.5) * 6;
    ball.pos.set(taker.x + towardIn * 0.25, 1.35, taker.z);   // 球在手上
    const dx = tx - ball.pos.x, dz = tz - ball.pos.z;
    const d = Math.max(3, Math.hypot(dx, dz));
    const sp = clamp(6.5 + d * 0.55, 7, 13);            // 距离越远掷得越用力
    ball.vel.set(dx / d * sp, 2.4, dz / d * sp);
    ball.spin.set(0, 0, 0);
    ball.lastKicker = taker.id;
    ball.lastKickAt = elapsed;
    setOwner(null);
    ms.touch(taker.id, taker.team, elapsed, 'throwIn');
    actionStats.throwIn = (actionStats.throwIn || 0) + 1;
    actionStats.lastThrowIn = { by: taker.id, to: target ? target.id : null, dist: +d.toFixed(1), speed: +sp.toFixed(1) };
    if (!ms.state.over) ms.resume(elapsed);
    return actionStats.lastThrowIn;
  }

  // 点球助跑：先把主罚者摆到球后 2.2 m、门将压低重心，0.5 s 冲刺 + takePenalty 真踢
  function startPenaltyRunUp(info) {
    const team = info.teamId;
    const goalZ = info.goalZ != null ? info.goalZ : (team === 'home' ? L / 2 : -L / 2);
    const s = goalZ >= 0 ? 1 : -1;
    const mates = agents.filter((a) => a.team === team && !a.isGk && !a.isUser && !a.off);
    const taker = mates.slice().sort((a, b) => techOf(b.attrs, 'shooting') - techOf(a.attrs, 'shooting'))[0] || null;
    if (!taker) { takePenalty(team); return null; }
    taker.x = info.point.x; taker.z = info.point.z - s * 2.2;
    taker.facing = s > 0 ? 0 : Math.PI;
    if (taker.model && taker.model.runUpPose) taker.model.runUpPose();
    const gk = agents.find((a) => a.isGk && a.team !== team && !a.off);
    if (gk && gk.model && gk.model.crouchPose) gk.model.crouchPose();
    restart = { type: 'penaltyRun', teamId: team, until: elapsed + 0.5, point: info.point, goalZ, takerId: taker.id };
    actionStats.runUp = (actionStats.runUp || 0) + 1;
    return { taker: taker.id };
  }

  // 守门员：射正门框内的球被扑出（第七阶段基础版；不做飞身动画，只做"够得到的挡球"）
  const keeperCd = { home: -9, away: -9 };
  function keeperTick(dt) {
    if (restart || ms.state.phase === 'goalPause') return;
    for (const gk of agents) {
      if (!gk.isGk || gk.off) continue;
      const goalZ = gk.team === 'home' ? -L / 2 : L / 2;
      const vz = ball.vel.z;
      if (Math.abs(vz) < 5) continue;
      const t = (goalZ - ball.pos.z) / vz;
      if (!(t > 0 && t < 1.8)) continue;                    // 1.8 s 内不会到门线
      const crossX = ball.pos.x + ball.vel.x * t;
      if (Math.abs(crossX) > 3.9) continue;                 // 射偏了，不用管
      const reach = 1.5 + (gk.attrs && gk.attrs.phys ? gk.attrs.phys.agility : 0.7) * 0.9
        + (aiState.secondSave && aiState.secondSave.gkId === gk.id && elapsed < aiState.secondSave.until ? 0.7 : 0);
      if (Math.abs(crossX - gk.x) > reach) continue;        // 够不到
      // 高球 + 贴身：门将选择拳击球（比扑救更稳，把球打出边线/禁区外）
      const highBall = ball.pos.y > 1.9 && Math.abs(ball.pos.z - gk.z) < 6;
      if (highBall && Math.random() < 0.55) {
        if (gk.model && gk.model.punchPose) gk.model.punchPose();
        const side = Math.sign(crossX - gk.x) || 1;
        setOwner(null);
        ball.pos.set(gk.x + side * 0.7, 1.6, gk.z + (gk.team === 'home' ? 0.6 : -0.6));
        ball.vel.set(side * (7 + Math.random() * 4), 3.2, (gk.team === 'home' ? 1 : -1) * (5 + Math.random() * 4));
        ball.spin.set(0, 0, 0);
        aiState.secondSave = null;
        keeperCd[gk.team] = elapsed;
        actionStats.punch = (actionStats.punch || 0) + 1;
        if (gk.model && gk.model.receivePose) gk.model.receivePose(0.5);
        continue;
      }
      // 二次扑救窗口内要再掷一次骰：成功率明显低于第一次
      const inSecond = !!(aiState.secondSave && aiState.secondSave.gkId === gk.id && elapsed < aiState.secondSave.until);
      if (inSecond) {
        if (Math.random() > secondSaveChance(0.62)) continue;
        actionStats.saveSecond = (actionStats.saveSecond || 0) + 1;
        aiState.secondSave = null;
      }
      if (elapsed - (keeperCd[gk.team] || -9) < 0.35) continue;
      keeperCd[gk.team] = elapsed;
      // 挡出：球回到门前，向场内弹出
      ball.pos.x = gk.x + (crossX - gk.x) * 0.5;
      ball.pos.z = gk.z + (gk.team === 'home' ? 1.1 : -1.1);
      ball.pos.y = Math.max(BALL.r, ball.pos.y * 0.6);
      ball.vel.z = -vz * 0.42;
      ball.vel.x = (ball.pos.x - gk.x) * 3 + (Math.random() - 0.5) * 4;
      ball.vel.y = 3.0;
      ball.spin.set(0, 0, 0);
      setOwner(null);
      gk.stamina = Math.max(0, gk.stamina - 2);
      if (gk.model && gk.model.receivePose) gk.model.receivePose(0.8);
      // 侧扑动画：按球在门将哪一侧、以及高度决定
      const side = Math.sign(crossX - gk.x) || 1;
      const high = ball.pos.y > 1.2;
      if (gk.model && gk.model.divePose) gk.model.divePose(side, high);
      actionStats.saveDive = (actionStats.saveDive || 0) + 1;
      // 打开 0.6 s 二次反应窗口（若球还在门前，门将可以再扑一次）
      aiState.secondSave = inSecond ? null : { gkId: gk.id, until: elapsed + 0.6 };
      // 抱球：门将把球控制住 1.4 s，期间不可抢断，随后手抛球
      if (Math.hypot(ball.pos.x - gk.x, ball.pos.z - gk.z) < 1.6) {
        aiState.gkHold = { id: gk.id, until: elapsed + 1.4 };
        actionStats.gkHold = (actionStats.gkHold || 0) + 1;
        setOwner(null);
      }
      actionStats.save = (actionStats.save || 0) + 1;
      ms.touch(gk.id, gk.team, elapsed, 'save');
      try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
      return;
    }
  }

  // 手球（第六阶段最后一块规则）：球打在手臂/手上 → 判对方任意球；挡出必进球再给红牌。
  // 几何用低模比例：横向偏移 0.30–0.62 m（躯干外沿到手臂最远）、球高 0.80–1.55 m。
  const handCd = Object.create(null);
  function handTick() {
    if (restart || aiState.gkHold) return;
    if (ms.state.phase !== 'inPlay') return;
    const sp = Math.hypot(ball.vel.x, ball.vel.z);
    if (sp < 6) return;
    if (ball.pos.y < HAND.minY || ball.pos.y > HAND.maxY) return;
    for (const a of agents) {
      if (a.isGk || a.isUser || a.off) continue;
      if (a.id === ball.lastKicker && elapsed - ball.lastKickAt < 0.45) continue;   // 自己刚踢的不算
      if ((handCd[a.id] || 0) > elapsed) continue;
      const dx = ball.pos.x - a.x, dz = ball.pos.z - a.z;
      const fx = Math.sin(a.facing), fz = Math.cos(a.facing);
      const rx = Math.cos(a.facing), rz = -Math.sin(a.facing);
      const lateral = dx * rx + dz * rz;
      const forward = dx * fx + dz * fz;
      if (Math.abs(forward) > 0.65) continue;                                        // 不在身体侧前方
      if (Math.abs(lateral) < HAND.torsoHalf || Math.abs(lateral) > HAND.armReach) continue;
      // 是否挡出必进球：球朝本方球门飞、过线点在门框内、距离 < 12 m
      const myGoalZ = a.team === 'home' ? -L / 2 : L / 2;
      let denied = false;
      if (Math.abs(ball.vel.z) > 2) {
        const t = (myGoalZ - ball.pos.z) / ball.vel.z;
        if (t > 0 && t < 0.9) {
          const crossX = ball.pos.x + ball.vel.x * t;
          const crossY = ball.pos.y + ball.vel.y * t - 0.5 * 9.81 * t * t;
          denied = Math.abs(crossX) < 3.66 && crossY < 2.44 && Math.abs(ball.pos.z - myGoalZ) < 12;
        }
      }
      handCd[a.id] = elapsed + 1.2;
      const p = handballChance({ ballY: ball.pos.y, lateral, ballSpeed: sp, raised: Math.abs(lateral) > 0.42, deniedGoal: denied });
      if (p <= 0 || Math.random() >= p) return;
      // 判手球：禁区内 → 点球；禁区外 → 对方在球点开任意球
      const pt = { x: ball.pos.x, z: ball.pos.z };
      const otherTeam = a.team === 'home' ? 'away' : 'home';
      const ownGoalZ = a.team === 'home' ? -L / 2 : L / 2;
      const inBox = inPenaltyArea(pt.x, pt.z, ownGoalZ);
      ball.vel.set(0, 0, 0);
      ball.spin.set(0, 0, 0);
      ball.pos.set(pt.x, BALL.r, pt.z);
      setOwner(null);
      actionStats.handball = (actionStats.handball || 0) + 1;
      actionStats.lastHandball = { id: a.id, name: a.name || a.id, denied: !!denied, inBox };
      if (inBox) {
        awardPenalty(a.team, pt, denied ? '禁区内手球挡出必进球' : '禁区内手球');
      } else {
        restart = { teamId: otherTeam, until: elapsed + 2.2, type: 'freeKick', point: pt };
        aiState.wall = freeKickWall(pt, otherTeam === 'home' ? 1 : -1, 2);
        aiState.wallTeam = a.team;
        ms.setPhase('setPiece', elapsed);
        showCardHud('handball', a.name || a.id);
      }
      if (a.model && a.model.stumblePose) a.model.stumblePose();
      if (denied) giveCard(a, 'red', '手球挡出必进球');
      try { fw3dAudio.whistle(true); } catch (e) {}
      return;
    }
  }

  // 头球：球在 1.4 m 以上、有球员贴身且球速足够 → 攻门或解围
  // 第③项：把玩家放进来（以前这一行写着 `a.isUser` 直接跳过，所以玩家永远顶不到球），
  // 并且用起跳高度决定"够得到多高"——不跳只能顶到 2.55 m，起跳后到 3.1 m 且争顶半径更大。
  // headerDbg：把每道闸门的通过/拦下情况记下来，自检里"为什么没顶到"不用猜。
  const headerDbg = { calls: 0, early: null, cands: 0, fired: 0, lastY: 0, lastSp: 0, error: null };
  const headerCd = Object.create(null);  function headerTick() {
    headerDbg.calls++;
    headerDbg.lastY = +ball.pos.y.toFixed(2);
    headerDbg.lastSp = +Math.hypot(ball.vel.x, ball.vel.z).toFixed(2);
    if (restart || aiState.gkHold) { headerDbg.early = restart ? 'restart' : 'gkHold'; return; }
    if (ball.pos.y < 1.4 || ball.pos.y > 3.15) { headerDbg.early = 'height'; return; }
    if (Math.hypot(ball.vel.x, ball.vel.z) < 4) { headerDbg.early = 'slow'; return; }
    headerDbg.early = null;
    const airborne = playerAirborne();
    let cands = [];
    for (const a of agents) {
      if (a.isGk || a.off) continue;
      const isUser = !!a.isUser;
      const maxY = isUser ? (airborne ? 3.1 : 2.25) : 2.8;
      if (ball.pos.y > maxY) continue;
      const reach = isUser && airborne ? 1.7 : 1.35;
      const d = Math.hypot(a.x - ball.pos.x, a.z - ball.pos.z);
      if (d < reach) cands.push({ a, d, posQuality: sat(1 - d / (reach + 0.25)) });
    }
    headerDbg.cands = cands.length;
    if (!cands.length) return;
    cands.sort((x, y) => y.posQuality - x.posQuality);
    let who = cands[0].a;
    if (cands.length > 1) {
      // 两人以上同点争顶：用身体对抗 + 位置决定归属
      const p = aerialDuel(cands[0], cands[1]);
      if (Math.random() > p) who = cands[1].a;
      actionStats.aerialDuel = (actionStats.aerialDuel || 0) + 1;
    }
    if ((headerCd[who.id] || 0) > elapsed) return;
    headerCd[who.id] = elapsed + 0.8;
    try {
    const goalZ = who.team === 'home' ? L / 2 : -L / 2;
    const kind = headerDecision({ x: who.x, z: who.z, speed: Math.abs(who.vx) + Math.abs(who.vz), goalZ });
    const solved = kind === 'shot'
      ? solveShot({ from: { x: who.x, z: who.z }, goal: { x: 0, z: goalZ }, attrs: who.attrs, pressure: 0.4, power: 19, cfg: A })
      : solveClear({ from: { x: who.x, z: who.z }, point: { x: who.x * 0.5, z: who.z + (who.team === 'home' ? 30 : -30) }, attrs: who.attrs, pressure: 0.6, cfg: A, attackZ: who.team === 'home' ? 1 : -1 });
    if (who.isUser) {
      // 玩家的头球：走玩家那条登记（最后触球/球权/统计），但不播踢球摆腿 —— 头球有自己的颈部动作
      applyUserKick(solved, kind === 'shot' ? 'userHeaderShot' : 'userHeaderClear', 1, true);
      actionStats.userHeader = (actionStats.userHeader || 0) + 1;
    } else {
      kickFrom(who, solved, kind === 'shot' ? 'headerShot' : 'headerClear');
    }
    if (kind === 'clear' && who.model && who.model.headerClearPose) {
      // 防守解围甩头：在自家禁区里 → 用甩头解围的动作（不是头球攻门）
      who.model.headerClearPose();
      actionStats.headerClearPose = (actionStats.headerClearPose || 0) + 1;
    } else if (who.model && who.model.headerPose) who.model.headerPose();
    actionStats.header = (actionStats.header || 0) + 1;
    actionStats[kind === 'shot' ? 'headerShot' : 'headerClear'] = (actionStats[kind === 'shot' ? 'headerShot' : 'headerClear'] || 0) + 1;
    headerDbg.fired++;
    } catch (e) { headerDbg.error = String((e && e.message) || e); }
  }

  // 初始画质：软件渲染 / 手机 直接落到对应档位，避免进比赛先卡几秒再自动降级
  applyQuality(adaptiveQuality.level);

  return {
    lookDown: (v) => { ctrl.pitch = (v == null ? -0.75 : v); return ctrl.pitch; },
    // ── 输入层自检（电脑 / 手机）：返回真实内部状态，不伪造
    //    testLook / testStick 注入的是和真实指针/触摸完全相同的增量通道，
    //    因此断言的是「输入 → 视角/位移」整条链路，而不是某个局部变量。
    inputDebug: () => input.debug(),
    inputTestLook: (dx, dy) => input.testLook(dx, dy),
    inputTestStick: (x, y) => input.testStick(x, y),
    inputHint: () => input.hintText(),
    inputView: () => ({ yaw: +ctrl.yaw.toFixed(4), pitch: +ctrl.pitch.toFixed(4), x: +ctrl.pos.x.toFixed(3), z: +ctrl.pos.z.toFixed(3) }),
    inputForceMobile(on) { window.__FW3D_FORCE_MOBILE = !!on; return !!window.__FW3D_FORCE_MOBILE; },
    actions: () => ({ ...actionStats }),
    // AI 状态（自检 / 调试用）
    ai: () => ({
      enabled: AI_ENABLED,
      players: agents.length,
      intents: aiState.intents.length,
      kicks: aiState.kicks, pass: aiState.pass, shoot: aiState.shoot, clear: aiState.clear, dribbles: aiState.dribble,
      restarts: aiState.restarts,
      phase: ms.state.phase,
      minute: +ms.state.minute.toFixed(1),
      owner: ball.ownerId,
      score: { home: ms.state.score.home, away: ms.state.score.away },
      behaviors: aiState.lastDebug ? aiState.lastDebug.players.map((p) => p.behavior) : [],
      roles: aiState.lastDebug ? aiState.lastDebug.players.map((p) => p.role) : [],
      debugVisible: debugHud.visible(),
      active: agents.filter((a) => !a.off).length,          // 场上实到人数（罚下后 < 22）
      cards: cardTotals(aiState.book),                       // {yellow, red, off}
      book: aiState.book,
      sbFound: !!scoreboard,
      sbName: scoreboard && scoreboard.data ? scoreboard.data.homeName : null,
      sbScore: scoreboard && scoreboard.data ? (scoreboard.data.homeScore + ':' + scoreboard.data.awayScore) : null,
    }),
    // 赛事类型与规则（**联赛/友谊赛没有点球大战**）
    competition() {
      const kind = competitionKind();
      const rule = competitionRule(kind);
      return {
        kind, label: rule.label,
        allowsShootout: !!rule.allowsShootout,
        allowsDraw: !!rule.allowsDraw,
        legs: rule.legs || 1,
      };
    },
    // 自检用：跑一场**真实**的点球大战——每一脚都走 takePenalty 的物理与 keeperTick，
    // 轮次/先后/终止条件交给 ai/shootout.js；为了自检速度把摆球等待从 2.4 s 缩到 0.15 s。
    // 注意：点球大战的进球不计入本场比分，结束时把 ms.score 复原。
    // 赛事类型由 competitionKind() 决定；联赛/友谊赛直接拒绝（力参数 o.force 只给调试用）。
    async debugShootout(opts) {
      const o = opts || {};
      const kind = o.kind ? competitionKindOf({ kind: o.kind }) : competitionKind();
      const decision = shootoutDecision({
        kind,
        scoreA: isFinite(o.scoreA) ? o.scoreA : ms.state.score.home,
        scoreB: isFinite(o.scoreB) ? o.scoreB : ms.state.score.away,
        aggA: o.aggA, aggB: o.aggB, knockout: o.knockout,
      });
      if (!decision.needed && !o.force) {
        return { refused: true, kind, reason: decision.reason, rule: competitionRule(kind) };
      }
      const st = createShootout({ first: o.first === 'away' ? 'away' : 'home' });
      const log = [];
      const sc0 = { home: ms.state.score.home, away: ms.state.score.away };
      const sleep = (ms2) => new Promise((r) => setTimeout(r, ms2));
      for (let i = 0; i < 40 && !st.done; i++) {
        const team = nextShooter(st);
        const goalZ = team === 'home' ? L / 2 : -L / 2;
        const spot = penaltySpot(goalZ);
        aiState.gkHold = null;
        aiState.secondSave = null;
        restart = { teamId: team, until: elapsed + 0.15, type: 'penalty', point: spot, goalZ };
        ms.setPhase('setPiece', elapsed);
        const pk0 = actionStats.penalty || 0;
        for (let k = 0; k < 30 && (actionStats.penalty || 0) === pk0; k++) await sleep(60);
        const g0 = ms.state.score.home + ms.state.score.away;
        const sv0 = actionStats.save || 0;
        const fh0 = actionStats.frameHit || 0;
        let scored = false, settled = false;
        for (let k = 0; k < 40 && !settled; k++) {
          await sleep(60);
          if (ms.state.score.home + ms.state.score.away > g0) { scored = true; settled = true; }
          else if ((actionStats.save || 0) > sv0 || (actionStats.frameHit || 0) > fh0) { scored = false; settled = true; }
          else if (k > 22) { scored = false; settled = true; }   // 兜底：偏出/停住（既没进也没扑）
        }
        recordKick(st, scored);
        log.push({ n: log.length + 1, team, scored, goals: { ...st.goals } });
        restart = null;
        if (ms.state.phase === 'goalPause' || ms.state.phase === 'setPiece') { if (!ms.state.over) ms.resume(elapsed); }
        ball.pos.set(0, BALL.r, 0); ball.vel.set(0, 0, 0); ball.spin.set(0, 0, 0); setOwner(null);
      }
      ms.setScore(sc0.home, sc0.away);   // 自检不污染比分
      return Object.assign(shootoutSummary(st) || {}, {
        log, kind, rule: competitionRule(kind),
        decision: shootoutDecision({ kind, scoreA: 1, scoreB: 1 }),
        needsShootout: shootoutDecision({ kind, scoreA: 1, scoreB: 1 }).needed,
      });
    },
    // 纪律档案（牌面跨场累积，存在 FW.state.fw3dDiscipline → 随存档）给 HUD / 自检读
    discipline() {
      const reg = disciplineStore();
      const ids = agents.map((a) => (a.attrs && a.attrs.id != null ? String(a.attrs.id) : a.id));
      const f = filterAvailable(ids, reg);
      return {
        registry: reg,
        counts: disciplineSummary(reg),
        suspended: f.suspended,
        available: f.available.length,
        persisted: !!(window.FW && FW.state && window.FW.state.fw3dDiscipline),
      };
    },
    // 自检用：给某队一名球员连记 3 张黄（走真实的 addCardToRecord 档案写入 → 累计到阈值就停赛）
    debugSuspensionNow(team) {
      const t = team === 'home' ? 'home' : 'away';
      const target = agents.find((a) => a.team === t && !a.isGk && !a.isUser && !a.off);
      if (!target) return { ok: false, reason: 'no target' };
      const engineId = target.attrs && target.attrs.id != null ? String(target.attrs.id) : null;
      if (!engineId) return { ok: false, reason: 'no engine id' };
      const reg = disciplineStore();
      // 自检从"干净档案"开始：这个球员可能已在 2D 联赛里吃过牌（那会干扰"累计 3 黄"的断言）
      const before = { yellow: 0, red: 0, ban: 0, yellowTotal: 0, redTotal: 0, matches: 0 };
      reg[engineId] = before;
      for (let i = 0; i < 3; i++) reg[engineId] = addCardToRecord(reg[engineId], 'yellow');
      actionStats.cardYellow = (actionStats.cardYellow || 0) + 3;
      const after = normalizeDiscipline(reg[engineId]);
      return { ok: true, id: engineId, agentId: target.id, name: target.name || target.id, before, after };
    },
    // 自检用：把比赛时钟拨到指定分钟（后面的自检步骤需要时间预算，避免中途打满 90 分钟自动关场景）
    debugSetMinute(m) {      const v = isFinite(m) ? Math.max(0, Math.min(89, Number(m))) : 20;
      ms.state.minute = v;
      if (v < 90) ms.state.over = false;
      return { minute: +ms.state.minute.toFixed(2), over: !!ms.state.over };
    },
    // 自检用：把某队体力最低的场上球员的体力压到指定值（模拟比赛末段疲劳，换人判定的前置条件）
    debugDrain(team, stamina) {
      const t = team === 'away' ? 'away' : 'home';
      const v = isFinite(stamina) ? Math.max(0, Math.min(100, Number(stamina))) : 18;
      const p = agents.filter((a) => a.team === t && !a.off && !a.isGk && !a.isUser)
        .sort((a, b) => a.stamina - b.stamina)[0];
      if (!p) return { ok: false };
      p.stamina = v;
      return { ok: true, id: p.id, name: p.name || p.id, stamina: v };
    },
    // 自检用：换人（走真实的 pickSub 判定；返回换下/换上/剩余名额/是否同位置）
    debugSubNow(team) {
      const before = agents.filter((a) => !a.off).length;
      const r = doSubNow(team === 'away' ? 'away' : 'home');
      const active = agents.filter((a) => !a.off).length;
      const t = team === 'away' ? 'away' : 'home';
      const on = r && r.on ? agentsById[r.on] : null;
      return Object.assign({}, r, {
        activeBefore: before, activeAfter: active,
        onName: on ? (on.name || on.id) : null,
        onVisible: !!(on && on.model && on.model.object && on.model.object.visible),
        subs: subs[t], subsLeft: SUBS.max - subs[t],
        bench: (bench[t] || []).length,
      });
    },
    // 自检用：替补席与换人名额
    benchInfo() {
      return {
        home: { bench: (bench.home || []).map((p) => p.name || p.id), subs: subs.home, left: SUBS.max - subs.home },
        away: { bench: (bench.away || []).map((p) => p.name || p.id), subs: subs.away, left: SUBS.max - subs.away },
        active: agents.filter((a) => !a.off).length,
        agents: agents.length,
      };
    },
    // 自检用：手边相机状态（第三人称庆祝镜头是不是真的切了）
    cameraInfo() {
      return {
        x: +camera.position.x.toFixed(2), y: +camera.position.y.toFixed(2), z: +camera.position.z.toFixed(2),
        fov: +camera.fov.toFixed(1),
        celebrating: celebrate.t > 0, phase: +celebrate.phase.toFixed(2),
        teamId: celebrate.teamId || null, scorerId: celebrate.scorerId || null,
        playerEye: { x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2) },
      };
    },
    // 自检用：手动触发一次进球庆祝（第三人称转播镜头 + 进球者庆祝动作）
    debugCelebration(team, kind) {
      const t = team === 'away' ? 'away' : 'home';
      const k = ['arms', 'sky', 'slid', 'knee'].indexOf(kind) >= 0 ? kind : null;
      const info = startCelebration(t, k);
      return Object.assign({ ok: true }, info, { state: this.celebrateState ? this.celebrateState() : null });
    },
    // 自检用：边裁状态（两名，位置/是否举旗/姿态）
    linesmenInfo() {
      return linesmen.map((lm) => lm.info());
    },
    // 自检用：让靠近某 z 的边裁举旗（offside / throwIn / corner）
    debugLinesmanFlag(kind, z) {
      if (!linesmen.length) return { ok: false, present: false };
      const zz = isFinite(z) ? z : 0;
      const lm = linesmen.reduce((a, b) => (Math.abs(a.z - zz) <= Math.abs(b.z - zz) ? a : b));
      const k = lm.flag(kind === 'throwIn' ? 'throwIn' : kind === 'corner' ? 'corner' : 'offside');
      actionStats.linesmanFlag = (actionStats.linesmanFlag || 0) + 1;
      return { ok: true, kind: k, side: lm.side, info: lm.info() };
    },
    refereeInfo() {
      if (!referee) return { ok: false, present: false };
      return Object.assign({ ok: true, present: true, target: referee.task || null }, referee.info());
    },
    // 自检用：让裁判掏牌（走真实的 cardPose，牌真的出现在右手上）
    debugRefCard(kind) {
      if (!referee) return { ok: false, present: false };
      const k = kind === 'red' ? 'red' : 'yellow';
      referee.card(k);
      return { ok: true, kind: k, info: referee.info() };
    },
    // 自检用：直接把球送过边线 → 走真实 judgeExit → 界外球 → takeThrowIn（掷球动作 + 球掷进场）
    debugThrowInNow() {
      aiState.gkHold = null;
      // 自检前置：清掉之前可能挂着的重开球，否则 checkOutOfPlay 会先处理那个 restart（不是伪造结果，只是复位）
      restart = null;
      aiState.wall = null;
      aiState.wallTeam = null;
      ms.touch(agents[0] ? agents[0].id : null, 'home', elapsed, 'debug');   // 最后触球方 = 主队 → 客队掷
      ball.pos.set(PITCH.halfW + 0.6, 0.3, 4);
      ball.vel.set(1.5, 0, 0);
      ball.spin.set(0, 0, 0);
      setOwner(null);
      checkOutOfPlay();
      const r = restart || null;
      return {
        ok: !!r && r.type === 'throwIn',
        type: r ? r.type : null,
        takerId: r ? (r.takerId || null) : null,
        point: r ? { x: +r.point.x.toFixed(1), z: +r.point.z.toFixed(1) } : null,
        wait: r ? +(r.until - elapsed).toFixed(2) : null,
      };
    },
    // 自检用：给某队一个界外球并立刻掷出（不等 2.2 s），返回掷球者姿态与球速
    debugThrowNow() {
      const r = this.debugThrowInNow();
      if (!r.ok) return r;
      const before = actionStats.throwIn || 0;
      const info = takeThrowIn(restart);
      const taker = info && info.by ? agentsById[info.by] : null;
      return {
        ok: !!info, taker: info && info.by, to: info && info.to, dist: info && info.dist,
        throwIn: (actionStats.throwIn || 0) - before,
        pose: taker && taker.model && taker.model.poseState ? taker.model.poseState() : null,
        ball: { y: +ball.pos.y.toFixed(2), speed: +Math.hypot(ball.vel.x, ball.vel.z).toFixed(1) },
      };
    },
    // 自检用：点球助跑（摆球 → 助跑 0.5 s → takePenalty 真踢）
    debugRunUpNow(team) {
      const t = team === 'home' ? 'home' : 'away';
      const goalZ = t === 'home' ? L / 2 : -L / 2;
      const spot = penaltySpot(goalZ);
      const before = actionStats.runUp || 0;
      const r = startPenaltyRunUp({ teamId: t, goalZ, point: spot });
      const taker = r && r.taker ? agentsById[r.taker] : null;
      const gk = agents.find((a) => a.isGk && a.team !== t && !a.off);
      return {
        ok: !!r, taker: r && r.taker, runUp: (actionStats.runUp || 0) - before,
        pose: taker && taker.model && taker.model.poseState ? taker.model.poseState() : null,
        gkPose: gk && gk.model && gk.model.poseState ? gk.model.poseState() : null,
        takerZ: taker ? +taker.z.toFixed(1) : null, spotZ: +spot.z.toFixed(1),
      };
    },
    // 自检用：让某队一名防守球员对最近的对手持球者滑铲（走真实 doSlideTackle）
    debugSlideNow(team) {
      const t = team === 'home' ? 'home' : 'away';
      const carrier = agents.find((a) => a.team !== t && !a.isGk && !a.off && ball.ownerId === a.id)
        || agents.find((a) => a.team !== t && !a.isGk && !a.off);
      const tackler = agents.find((a) => a.team === t && !a.isGk && !a.isUser && !a.off);
      if (!carrier || !tackler) return { ok: false, reason: 'no pair' };
      tackler.x = carrier.x + 1.7; tackler.z = carrier.z + 0.4;
      tackler.vx = 4; tackler.vz = 1;
      setOwner(carrier);
      const before = actionStats.slide || 0;
      const r = doSlideTackle(tackler, carrier, { angleCos: -0.55, tackling: techOf(tackler.attrs, 'tackling') });
      return {
        ok: true, tackler: tackler.id, carrier: carrier.id,
        slide: (actionStats.slide || 0) - before,
        win: !!(r && r.win), foul: !!(r && r.foul),
        downUntil: +(tackler.downUntil || 0).toFixed(1),
        pose: tackler.model && tackler.model.poseState ? tackler.model.poseState() : null,
      };
    },
    // 自检用：走真实的记账/罚下路径发一张牌（不伪造计数器；两黄会真的变红并把人罚下）
    debugCardNow(kind, team) {
      const t = team === 'home' ? 'home' : 'away';
      const target = agents.find((a) => a.team === t && !a.isGk && !a.isUser && !a.off);
      if (!target) return { ok: false };
      const e = giveCard(target, kind === 'red' ? 'red' : 'yellow', 'debug');
      return {
        ok: !!e,
        id: target.id,
        name: target.name || target.id,
        book: bookOf(aiState.book, target.id),
        sentOff: sentOffIds(aiState.book),
        active: agents.filter((a) => !a.off).length,
        cards: cardTotals(aiState.book),
        visible: target.model && target.model.object ? target.model.object.visible : null,
        pitchPlayers: agents.filter((a) => !a.off).length,
        // 罚下后的阵型目标点（用于断言"10 人真的重排成 4-4-1"）
        formation: agents.filter((a) => a.team === t && !a.off).map((a) => [+a.shape.x.toFixed(0), +a.shape.z.toFixed(0)]),
        pose: target.model && target.model.poseState ? target.model.poseState() : null,
      };
    },
    // 自检用：在指定球队的禁区内造一次犯规 → 走真实的 awardPenalty 路径（2.4 s 后自动罚出）
    debugPenaltyNow(offenderTeam) {
      const t = offenderTeam === 'home' ? 'home' : 'away';
      const goalZ = t === 'home' ? -L / 2 : L / 2;          // 该队自己守的门
      const pt = { x: 1.5, z: goalZ + (t === 'home' ? 9 : -9) };
      const box = inPenaltyArea(pt.x, pt.z, goalZ);
      const r = awardPenalty(t, pt, 'debug 禁区内犯规');
      return { ok: !!r && box, box, team: r && r.team, spot: r && r.spot, before: actionStats.penalty || 0 };
    },
    // 自检用：把球贴着某队一名防守球员的手臂飞过（球高 1.2 m、横向 0.5 m、沿身体前后轴 8 m/s），
    // 下一帧起由真实的 handTick 判定（可能不出牌/不判，所以调用方要重试几次）
    debugHandNow(team) {
      const t = team === 'home' ? 'home' : 'away';
      const a = agents.find((x) => x.team === t && !x.isGk && !x.isUser && !x.off);
      if (!a) return { ok: false };
      const fx = Math.sin(a.facing), fz = Math.cos(a.facing);
      const rx = Math.cos(a.facing), rz = -Math.sin(a.facing);
      aiState.gkHold = null;
      restart = null;
      // 12 m/s：高于 controlMaxSpeed（9.5），否则 ballTick 会先接管球权、球被压到地面，手球带永远不成立
      ball.pos.set(a.x + rx * 0.5 - fx * 0.55, 1.2, a.z + rz * 0.5 - fz * 0.55);
      ball.vel.set(fx * 12, 0, fz * 12);
      ball.spin.set(0, 0, 0);
      ball.lastKicker = null;
      ball.lastKickAt = -9;
      handCd[a.id] = 0;                 // 允许重试时立刻重新判定
      setOwner(null);
      if (!ms.state.over) ms.resume(elapsed);
      return { ok: true, id: a.id, before: actionStats.handball || 0 };
    },
    // 自检用：走真实的"判犯规 → 任意球 → 排人墙"路径（不伪造计数器）
    debugFoulNow() {
      const owner = (ball.ownerId && agentsById[ball.ownerId]) || agents.find((a) => !a.isGk && a.team === 'home') || null;
      const atk = owner && owner.team === 'away' ? -1 : 1;
      const team = owner ? owner.team : 'home';
      const pt = owner ? { x: owner.x, z: owner.z } : { x: 0, z: 0 };
      ball.pos.set(pt.x, BALL.r, pt.z);
      ball.vel.set(0, 0, 0);
      ball.spin.set(0, 0, 0);
      setOwner(null);
      restart = { teamId: team, until: elapsed + 2.2, type: 'freeKick', point: pt };
      aiState.wall = freeKickWall(pt, atk, 2);
      aiState.wallTeam = team === 'home' ? 'away' : 'home';
      ms.setPhase('setPiece', elapsed);
      actionStats.foul = (actionStats.foul || 0) + 1;
      try { fw3dAudio.whistle(true); } catch (e) {}
      return { fouls: actionStats.foul, phase: ms.state.phase, wall: aiState.wall.map((w) => [+w.x.toFixed(1), +w.z.toFixed(1)]) };
    },
    // 自检用：用真实 agent 位置构造两次快照，验证越位判定（把客队前锋临时挪到越位线之后）
    debugOffsideNow() {
      const striker = agents.find((a) => a.team === 'away' && !a.isGk && a.slot === 9) || agents.find((a) => a.team === 'away' && !a.isGk);
      if (!striker) return { ok: false };
      const savedZ = striker.z;
      const s0 = buildSnapshot(pitchInput());
      // 客队朝 -z 进攻 → "越过越位线"是 z 更小
      striker.z = s0.teams.away.offsideLine - 4;
      const s1 = buildSnapshot(pitchInput());
      const offside = isOffside(s1, striker.id);
      const line = s1.teams.away.offsideLine;
      striker.z = savedZ;
      return { ok: true, offside, line: +line.toFixed(1), testZ: +(line - 4).toFixed(1) };
    },
    // 自检用：正对 -z 球门的一脚 19 m/s 射门，用来验证门将扑救
    debugShotAtGoal() {
      ms.touch('away-9', 'away', elapsed, 'shot');
      ball.pos.set(0, BALL.r + 0.35, -L / 2 + 15);
      ball.vel.set(0, 0, -19);
      ball.spin.set(0, 0, 0);
      setOwner(null);
      restart = null;
      // 上一球如果刚进过，比赛还停在 goalPause；这里必须恢复 inPlay，
      // 否则门将逻辑（goalPause 时直接 return）根本不会执行。
      if (!ms.state.over) ms.resume(elapsed);
      return { z: ball.pos.z, saves: actionStats.save || 0, phase: ms.state.phase };
    },
    aiDebug: () => aiState.lastDebug,
    // 只读球状态（自检/调试用）
    ballInfo: () => ({
      x: +ball.pos.x.toFixed(2), y: +ball.pos.y.toFixed(2), z: +ball.pos.z.toFixed(2),
      vx: +ball.vel.x.toFixed(2), vy: +ball.vel.y.toFixed(2), vz: +ball.vel.z.toFixed(2),
    }),
    // 最近一次撞门柱/横梁的飞行记录（命中瞬间的速度，不受之后的带球/抢断影响）
    debugFrameLog: () => frameHitLog,
    // 玩家本帧运动信息（模型来源/速度；侧移后退姿态会用到）
    playerMove: () => ({ ...playerMove }),
    // 截图/核对用：强制第三人称环绕视角并指定角度（只改相机，不影响输入与物理）
    debugOrbit(angle, target) {
      orbitView = true;
      orbitAngle = Number(angle) || 0;
      // 'me' 玩家 / 'ref' 裁判 / 球员 id（如 'away-1'）——自检出图用
      orbitTarget = typeof target === 'string' && target ? target : 'me';
      return { orbitView, orbitAngle: +orbitAngle.toFixed(2), orbitTarget };
    },
    // ── 抢断 / 滑铲：自检接口（同时给外部调试用）
    // 自检用：把球直接给玩家（验证手机端两个双语义键的文案与行为）
    debugGiveBallNow() {
      const me = playerAgent();
      if (!me) return { ok: false };
      aiState.gkHold = null;
      ball.pos.set(me.x, BALL.r, me.z);
      ball.vel.set(0, 0, 0);
      setOwner(me);
      return { ok: true, owner: ball.ownerId, onBall: playerOnBall() };
    },
    // 自检用：把球放到玩家脚边并把球权清空 —— 验证「玩家能不能自己把球捡起来」。
    // 旧版本这里必然失败：ballTick 的接管循环跳过 isUser，而 playerOnBall 只认 ownerId，
    // 于是整场比赛里系统都认为玩家"没球"（手机端射门键因此长期是滑铲键）。
    debugDropBallAtFeet() {
      const me = playerAgent();
      if (!me) return { ok: false, reason: 'no-user-agent' };
      aiState.gkHold = null;
      restart = null;
      me.downUntil = 0; me.offUntil = 0;
      // 先把贴身对手挪到 4.5 m 外：这个钩子问的是"球在你脚下会发生什么"，
      // 而别的自检步骤可能刚好在玩家旁边摆了个对手，那样一抢球断言就变成掷骰子了。
      let moved = 0;
      for (const a of agents) {
        if (a.team === me.team || a.off) continue;
        const dx = a.x - ctrl.pos.x, dz = a.z - ctrl.pos.z;
        const d = Math.hypot(dx, dz);
        if (d >= 3.5) continue;
        const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
        a.x = ctrl.pos.x + nx * 4.5;
        a.z = ctrl.pos.z + nz * 4.5;
        a.vx = 0; a.vz = 0;
        moved++;
      }
      const fx = -Math.sin(ctrl.yaw), fz = -Math.cos(ctrl.yaw);
      ball.pos.set(ctrl.pos.x + fx * 0.9, BALL.r, ctrl.pos.z + fz * 0.9);
      ball.vel.set(0, 0, 0);
      ball.spin.set(0, 0, 0);
      ball.lastKicker = null;
      ball.lastKickAt = -9;
      setOwner(null);
      return { ok: true, ownerCleared: ball.ownerId === null, dist: 0.9, movedOpponents: moved };
    },
    // 自检用：玩家直接出脚（跳过蓄力条），验证「出脚后清球权 + 登记最后触球」这条链路
    debugPlayerKick(ratio) {
      const r = isFinite(ratio) ? ratio : 0.5;
      const ok = tryKick(r, 0.8);
      return { ok, owner: ball.ownerId, lastTouch: Object.assign({}, ms.state.lastTouch) };
    },
    // 自检用：玩家长传 / 传中（跳过蓄力）。
    // 传了 point 就按该落点解算（自检要的是"球能不能离地"这件物理事实，
    // 用固定落点可以避免目标选择的随机性）；不传 point 则走真实的玩家逻辑。
    debugPlayerLongPass(point) {
      const me = playerAgent();
      if (me && point && isFinite(point.x) && isFinite(point.z)) {
        const solved = solveLoft({ from: { x: me.x, z: me.z }, to: point, attrs: me.attrs, pressure: 0.3, cfg: A });
        applyUserKick(solved, 'userLongPass', 1);
        return {
          ok: true, kind: 'forced', point,
          lofted: true, apex: +solved.apex.toFixed(2), vy: +solved.vy.toFixed(2),
          flightTime: +solved.flightTime.toFixed(2), speed: +solved.speed.toFixed(2),
        };
      }
      const r = playerPass(true);
      return Object.assign({ ballY: +ball.pos.y.toFixed(2), vy: +ball.vel.y.toFixed(2), speed: +Math.hypot(ball.vel.x, ball.vel.z).toFixed(2) }, r);
    },
    // 自检用：玩家短传（走目标选择）
    debugPlayerShortPass() {
      const r = playerPass(false);
      return Object.assign({ ballY: +ball.pos.y.toFixed(2), vy: +ball.vel.y.toFixed(2), speed: +Math.hypot(ball.vel.x, ball.vel.z).toFixed(2) }, r);
    },
    // 自检用：玩家起跳（返回离地高度，供断言"真的有垂直位移"）
    debugPlayerJump() {
      const ok = startJump();
      return { ok, air: +ctrl.air.toFixed(3), active: !!jump.active };
    },
    // 自检用：当前离地高度
    playerAir: () => ({ air: +ctrl.air.toFixed(3), active: !!jump.active, airborne: playerAirborne() }),
    // 自检用：把一颗高球送到玩家头顶前方（验证"玩家能头球"）。
    // 水平速度必须 >= 4 才会进头球判定，所以这里给球一个朝玩家飞来的速度。
    debugAerialBall(opts) {
      const o = opts || {};
      const me = playerAgent();
      if (!me) return { ok: false, reason: 'no-user-agent' };
      aiState.gkHold = null;
      restart = null;
      me.downUntil = 0; me.offUntil = 0;
      const fx = -Math.sin(ctrl.yaw), fz = -Math.cos(ctrl.yaw);
      const dd = isFinite(o.dist) ? o.dist : 0.9;
      const yy = isFinite(o.y) ? o.y : 2.0;
      const sp = isFinite(o.speed) ? o.speed : 6;
      ball.pos.set(ctrl.pos.x + fx * dd, yy, ctrl.pos.z + fz * dd);
      ball.vel.set(-fx * sp, 0, -fz * sp);
      ball.spin.set(0, 0, 0);
      ball.lastKicker = null;
      ball.lastKickAt = -9;
      setOwner(null);
      return { ok: true, y: +ball.pos.y.toFixed(2), speed: sp, dist: dd };
    },
    // 自检用：头球判定的现场快照（"为什么没顶到"一眼能看出来，不靠猜）
    headerDebug() {
      const me = playerAgent();
      return {
        restart: !!restart, restartType: restart && restart.type, gkHold: !!aiState.gkHold,
        y: +ball.pos.y.toFixed(2),
        hSpeed: +Math.hypot(ball.vel.x, ball.vel.z).toFixed(2),
        owner: ball.ownerId || null,
        airborne: playerAirborne(), air: +ctrl.air.toFixed(2), jumping: !!jump.active,
        meDist: me ? +Math.hypot(me.x - ball.pos.x, me.z - ball.pos.z).toFixed(2) : null,
        meX: me ? +me.x.toFixed(1) : null, meZ: me ? +me.z.toFixed(1) : null,
        phase: ms.state.phase,
        header: Object.assign({}, headerDbg),
      };
    },
    // 自检用：把球放到指定高度再射一脚，返回这一脚走的是头球还是脚踢
    // （射门的出脚方式本来就是随机的，这个钩子让自检可以确定性地验证两条分支）
    debugPlayerKickAt(y) {
      const me = playerAgent();
      if (!me) return { ok: false, reason: 'no-user-agent' };
      aiState.gkHold = null;
      restart = null;
      me.downUntil = 0; me.offUntil = 0;
      const fx = -Math.sin(ctrl.yaw), fz = -Math.cos(ctrl.yaw);
      const h0 = actionStats.userHeadShot || 0;
      const f0 = actionStats.userFootShot || 0;
      ball.pos.set(ctrl.pos.x + fx * 0.9, isFinite(y) ? y : BALL.r, ctrl.pos.z + fz * 0.9);
      ball.vel.set(0, 0, 0);
      ball.spin.set(0, 0, 0);
      ball.lastKicker = null;
      ball.lastKickAt = -9;
      setOwner(null);
      const ok = tryKick(0.5, 0.8);
      return {
        ok,
        head: (actionStats.userHeadShot || 0) > h0,
        foot: (actionStats.userFootShot || 0) > f0,
        vy: +ball.vel.y.toFixed(2),
        speed: +Math.hypot(ball.vel.x, ball.vel.z).toFixed(2),
      };
    },
    // 自检用：把一名客队球员摆到玩家前方 dist 米并让他持球（不触发任何动作）
    debugPlaceCarrier(dist) {
      const me = playerAgent();
      const opp = agents.find((a) => a.team === 'away' && !a.isGk && !a.off) || agents.find((a) => a.team === 'away');
      if (!me || !opp) return { ok: false };
      aiState.gkHold = null;
      const d = isFinite(dist) ? dist : 2.0;
      opp.x = ctrl.pos.x + d; opp.z = ctrl.pos.z; opp.vx = 0; opp.vz = 0; opp.facing = Math.PI;
      me.x = ctrl.pos.x; me.z = ctrl.pos.z; me.downUntil = 0; me.offUntil = 0;
      tackleCd[me.id] = 0;
      ball.pos.set(opp.x, BALL.r, opp.z); ball.vel.set(0, 0, 0); ball.spin.set(0, 0, 0);
      setOwner(opp);
      return { ok: true, carrier: opp.id, dist: d, onBall: playerOnBall() };
    },
    chargeState() { return { on: !!charge.on, t: +charge.t.toFixed(2), sweep: +charge.sweep.toFixed(2) }; },
    playerOnBall() { return playerOnBall(); },
    playerDown() { return playerDownInfo(); },
    playerPos() { return { x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2) }; },
    debugPlayerTackleNow() {
      const before = actionStats.steal || 0;
      const me = playerAgent();
      const opp = agents.find((a) => a.team === 'away' && !a.isGk && !a.off) || agents.find((a) => a.team === 'away');
      if (!me || !opp) return { ok: false, reason: 'no-agent' };
      aiState.gkHold = null;
      const px = ctrl.pos.x, pz = ctrl.pos.z;
      opp.x = px + 0.9; opp.z = pz; opp.vx = 0; opp.vz = 0; opp.facing = Math.PI;
      me.x = px; me.z = pz;
      ball.pos.set(opp.x, BALL.r, opp.z); ball.vel.set(0, 0, 0); ball.spin.set(0, 0, 0);
      setOwner(opp);
      tackleCd[me.id] = 0;
      const result = playerTackle();
      return { ok: true, before, after: actionStats.steal || 0, result };
    },
    debugPlayerSlideNow() {
      const before = actionStats.slide || 0;
      const me = playerAgent();
      const opp = agents.find((a) => a.team === 'away' && !a.isGk && !a.off) || agents.find((a) => a.team === 'away');
      if (!me || !opp) return { ok: false, reason: 'no-agent' };
      aiState.gkHold = null;
      me.downUntil = 0; me.offUntil = 0;
      const px = ctrl.pos.x, pz = ctrl.pos.z;
      opp.x = px + 2.0; opp.z = pz; opp.vx = 0; opp.vz = 0; opp.facing = Math.PI;
      me.x = px; me.z = pz;
      ball.pos.set(opp.x, BALL.r, opp.z); ball.vel.set(0, 0, 0); ball.spin.set(0, 0, 0);
      setOwner(opp);
      const result = playerSlide(true);      // 强制铲空 → 自己倒地
      return { ok: true, before, after: actionStats.slide || 0, result, down: playerDownInfo() };
    },
    // 自检用：把球以 8 m/s 送到一名非门将队友脚下，走真实的 ballTick 接管 → 第一脚接球路径
    debugNpcReceive() {
      const mate = agents.find((a) => !a.isGk && !a.isUser && a.team === 'home');
      if (!mate) return { ok: false };
      aiState.gkHold = null;
      ball.pos.set(mate.x + Math.sin(mate.facing) * 0.8, BALL.r, mate.z + Math.cos(mate.facing) * 0.8);
      ball.vel.set(-Math.sin(mate.facing) * 8, 0, -Math.cos(mate.facing) * 8);
      ball.spin.set(0, 0, 0);
      setOwner(null);
      restart = null;
      if (!ms.state.over) ms.resume(elapsed);
      return { ok: true, id: mate.id, before: actionStats.npcReceive || 0, facing: +mate.facing.toFixed(2) };
    },
    // 某名球员模型的姿态状态（自检用：证明一次性动作真的在播）
    debugPoseOf(id) {
      const c = chars.find((x) => x.agent && x.agent.id === id);
      return c && c.model && c.model.poseState ? c.model.poseState() : null;
    },
    // 玩家模型当前步态种类与速度（冒烟/截图核对"侧移=strafe、后退=back"）
    debugPlayerGait: () => {
      const c = chars.find((x) => x.isMe);
      return c && c.model && c.model.moveKind
        ? { kind: c.model.moveKind(), speed: +Math.hypot(ctrl.vel.x, ctrl.vel.z).toFixed(2), x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2) }
        : null;
    },
    // 第二阶段手感对照：两套运动模型各跑一遍"起步→全速→急停"，返回可比数字（纯计算，不动真实玩家）
    playerMotorAB() {
      const me = agents.find((a) => a.isUser);
      const dt = 1 / 60;
      // ① 旧模型：与 updateMovement 的公式逐字一致（平滑加速 + 指数急停）
      const top = sprMax;
      const accelRate = top / Math.max(0.12, P.accel);
      const smooth = 1 - Math.exp(-dt * (accelRate / Math.max(1, top)) * 6);
      let lv = 0, lt80 = null, ltop = 0, lrun = 0;
      for (let i = 0; i < 300; i++) {
        lv += (top - lv) * smooth;
        ltop = Math.max(ltop, lv);
        lrun += lv * dt;
        if (lt80 == null && lv >= top * 0.8) lt80 = (i + 1) * dt;
      }
      let lst = 0, lsd = 0;
      while (lv > 0.2 && lst < 5) { lv *= Math.exp(-dt * 5.5); lsd += lv * dt; lst += dt; }
      const legacy = { top: +ltop.toFixed(2), t80: +(lt80 || 0).toFixed(2), run: +lrun.toFixed(1), stop: +lsd.toFixed(2), stopT: +lst.toFixed(2) };
      // ② 电机模型：与 NPC 完全同一份 stepPlayer
      const a = { x: 0, z: 0, vx: 0, vz: 0, facing: 0, stamina: 100, attrs: me ? me.attrs : fallbackAttrs(7, 'ST') };
      const cap = maxSpeedOf(a, A);
      let mt80 = null, mtop = 0, mrun = 0;
      for (let i = 0; i < 300; i++) {
        stepPlayer(a, { x: 0, z: 100, pace: 1 }, dt, A, null, null);
        const sp = Math.hypot(a.vx, a.vz);
        mtop = Math.max(mtop, sp);
        mrun += sp * dt;
        if (mt80 == null && sp >= cap * 0.8) mt80 = (i + 1) * dt;
      }
      let mst = 0, msd = 0;
      while (Math.hypot(a.vx, a.vz) > 0.2 && mst < 5) {
        stepPlayer(a, { x: a.x, z: a.z, pace: 0 }, dt, A, null, null);
        msd += Math.hypot(a.vx, a.vz) * dt;
        mst += dt;
      }
      const motor = { top: +mtop.toFixed(2), cap: +cap.toFixed(2), t80: +(mt80 || 0).toFixed(2), run: +mrun.toFixed(1), stop: +msd.toFixed(2), stopT: +mst.toFixed(2) };
      // ③ 电机 + 玩家属性补偿（ARCADE_TUNING）：用来回答"切了电机会不会变肉"
      const tuned = motorProfile(tunedAttrs(me ? me.attrs : fallbackAttrs(7, 'ST'), ARCADE_TUNING), A, { sprintMul: ARCADE_TUNING.sprintMul });
      return { enabled: USE_MOTOR_FOR_PLAYER, legacy, motor, tuned, tuning: ARCADE_TUNING };
    },
    // 自检用：以 11 m/s 射向 -z 球门右柱（x=+3.66），验证撞柱反弹且不计分。
    // 11 m/s 高于 A.ball.controlMaxSpeed（9.5），球不会被中途接管；把主队门将挪到左柱侧，
    // 让它够不到（|3.66-(-3.2)|=6.86 m > reach）。单帧位移 > 判定窗口，走的是连续判定分支。
    debugPostShot() {
      const goalZ = -L / 2;
      for (const a of agents) if (a.isGk && a.team === 'home') a.x = -3.2;
      aiState.gkHold = null;
      aiState.secondSave = null;
      frameHitLog = null;
      ball.pos.set(3.66, BALL.r + 0.02, goalZ + 1.2);
      ball.vel.set(0, 0, -11);
      ball.spin.set(0, 0, 0);
      setOwner(null);
      restart = null;
      if (!ms.state.over) ms.resume(elapsed);
      return { goalZ, z0: ball.pos.z, frameHit: actionStats.frameHit || 0, score: { home: ms.state.score.home, away: ms.state.score.away } };
    },
    // 战术风格：balanced / possession / counter / press / low
    setTactics(name) {
      applyStyle(A, name);
      try { localStorage.setItem('fw3d.style', A.team.style); } catch (e) {}
      syncTacticsHud();
      return A.team.style;
    },
    cycleTactics() {
      return cycleStyle();
    },
    // 头顶姓名牌（自检/工具用）
    cycleNameTags: () => cycleNameTags(),
    nameTagState: () => nameTagState(),
    // 切换姓名牌字体（auto / serif / sans / kai / jinling / xqn）：立即重建所有牌
    setNameTagFont: (key) => {
      let k = key;
      for (const a of agents) {
        try { if (a.model && a.model.setNameTagFont) k = a.model.setNameTagFont(key); } catch (e) {}
      }
      applyNameTags();
      return k;
    },
    nameTagFont: () => { const x = agents.find(function (b) { return b.model && b.model.nameTagFontKey; }); return x ? x.model.nameTagFontKey() : null; },
    nameTagDetail: () => agents.map(function (a) {
      const info = a.model && a.model.nameTagInfo ? a.model.nameTagInfo() : null;
      return info ? { name: a.name, team: a.team, isUser: !!a.isUser, tag: info } : null;
    }).filter(Boolean),
        tactics: () => ({ style: A.team.style, label: (STYLE_PRESETS[A.team.style] || {}).label || A.team.style, pressMul: A.team.pressMul, risk: A.team.riskAppetite }),
    // 自检用：把球放进 +z 球门内，走真实的 judgeExit → ms.goal → HUD 链路（下一帧生效）
    debugScoreGoal() {
      ms.touch('home-7', 'home', elapsed, 'shot');
      ball.pos.set(0, BALL.r + 0.5, L / 2 + 0.4);
      ball.vel.set(0, 0, 0);
      ball.spin.set(0, 0, 0);
      setOwner(null);
      restart = null;
      return { scoreBefore: { home: ms.state.score.home, away: ms.state.score.away } };
    },
    aiToggleDebug: () => debugHud.toggle(),
    // 性能与几何统计（设计包 06：基线要可测量，不靠截图 FPS 猜）
    // 调试/性能对照：把天空穹从场景里摘掉（仅供 tools/probe_sky.js 做同进程 A/B，
    // 不参与任何玩法逻辑；摘掉后画面会退回纯黑背景，正是"加天空之前"的样子）
    debugToggleSky(off) {
      const s = scene.getObjectByName('sky-dome');
      if (!s) return 'no-sky';
      if (off && s.parent) { s.parent.remove(s); return 'removed'; }
      return 'present';
    },
    perf: () => {
      let lights = 0, meshes = 0;
      const mats = new Set();
      scene.traverse((o) => {
        if (o.isLight && o.visible) lights++;
        if (o.isMesh) meshes++;
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m));
          else mats.add(o.material);
        }
      });
      return {
        calls: renderer.info.render.calls,
        tris: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs ? renderer.info.programs.length : null,
        lights,
        meshes,
        materials: mats.size,
        crowd: crowdMesh ? crowdMesh.count : 0,
        agents: agents.length,
        pitch: pitchCore.stats,
        dividers: (built && built.group && built.group.userData) ? built.group.userData.dividers : null,
        fps: window.__FW3D_FPS || 0,
        kind: stadiumKind,
      };
    },
    matchState: () => ms.snapshot(),
    // ── 自由观赛（spectate）：自检 / 调试接口（返回真实内部状态，不伪造）
    spectate() {
      const g = roam ? roam.ground(ctrl.pos.x, ctrl.pos.z) : null;
      const seat = roam && roam.seats.home ? roam.seats.home : null;
      return {
        mode: spectateMode, active: !!roam,
        seated, eye: +camState.eye.toFixed(2),
        x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2), groundY: +ctrl.groundY.toFixed(2),
        kind: g ? g.kind : null, hit: ctrl.hit, canShoot: canShoot(),
        seat: seat ? { x: +seat.seatX.toFixed(2), z: +seat.z.toFixed(2), y: seat.platform, standX: +seat.standX.toFixed(2) } : null,
        dugouts: dugoutObjs.map((d) => ({
          side: d.side, z: d.layout.z, seats: d.built.seats.length,
          seatX: +d.layout.seatX.toFixed(2), standX: +d.layout.standX.toFixed(2), platform: d.layout.platform,
        })),
        stadium: { baseInset: spec.baseInset, boardOff: spec.boardOff, rows: spec.rows, rowDepth: spec.rowDepth, rowRise: spec.rowRise, tiers: spec.tiers },
        sitters: sitting.length,
        script: {
          events: specScript.events.length, idx: specScript.idx, fired: specScript.fired,
          disallowed: specScript.disallowed, forced: specScript.forced, ready: specScript.ready,
          pending: specScript.pending ? specScript.pending.team : null,
        },
        score: { home: ms.state.score.home, away: ms.state.score.away },
        minute: +ms.state.minute.toFixed(1),
      };
    },
    /** 坐/站：不传=切换，true=坐下，false=起立 */
    spectateSit(on) { return on === true ? sitDown() : (on === false ? standUp() : toggleSit()); },
    /** 自检用：从当前点朝 (x,z) 走一步（仍然过 roam 的碰撞/禁区，不瞬移穿墙） */
    spectateWalk(x, z) {
      if (!roam) return { ok: false, reason: 'not-spectate' };
      const r = roam.resolve(Number(x), Number(z), ctrl.pos.x, ctrl.pos.z, ctrl.groundY);
      ctrl.pos.x = r.x; ctrl.pos.z = r.z;
      if (r.ok) ctrl.groundY = r.y;
      return { ok: r.ok, x: +ctrl.pos.x.toFixed(2), z: +ctrl.pos.z.toFixed(2), y: +ctrl.groundY.toFixed(2), hit: r.hit || null };
    },
    /** 自检用：把球"传"给时间线下一个脚本进球（跳过物理），用于验证比分收敛 */
    spectateForceGoal(team) {
      if (!spectateMode) return null;
      return creditScriptedGoal(team === 'away' ? 'away' : 'home', '自检进球', ms.state.minute, true);
    },
    /** 自检用：把比赛时钟直接推到 90' 之前的一刻（不跑完整场） */
    spectateEnd() {
      if (!spectateMode) return null;
      ms.state.minute = 90; ms.state.over = true;
      return { minute: 90, score: { home: ms.state.score.home, away: ms.state.score.away } };
    },

    // 开球：球放中圈，清空球权（自检与后续阶段的开球逻辑都用它，不靠瞬移球假装传球）
    kickoff() {
      ball.pos.set(0, BALL.r, 0);
      ball.vel.set(0, 0, 0);
      ball.spin.set(0, 0, 0);
      ball.lastKicker = null;
      ball.lastKickAt = -9;
      setOwner(null);
      restart = null;
      ms.kickoff(elapsed);
      if (!matchMode) ms.resume(elapsed);
      return { ok: true, x: 0, z: 0 };
    },
    teams: () => ({ home: homeLabel, away: awayLabel, homeCount: agents.filter((a) => a.team === 'home').length, awayCount: agents.filter((a) => a.team === 'away').length }),
    // ── [players-subsystem] 外观自检接口：22 人是否都带外观/脸型是否互不相同/材质带宽/LOD
    appearance() {
      const models = chars.map((c) => c.model).filter(Boolean);
      const looks = models.map((m) => m.look).filter(Boolean);
      const faceKeys = new Set(looks.map((l) => [l.head.w, l.head.jaw, l.head.cheek, l.head.brow, l.hair.style, l.beard.style, Math.round(l.face.eyeSpacing * 10)].join('|')));
      const mats = [];
      for (const m of models) { const inf = m.info ? m.info() : null; if (inf) mats.push(inf.materials); }
      return {
        count: chars.length, withAppearance: looks.length, uniqueFaces: faceKeys.size,
        materials: mats.slice(0, 3), maxMaterials: mats.length ? Math.max.apply(null, mats) : 0,
        drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        heights: looks.map((l) => l.summary && l.summary.height),
        hairStyles: Array.from(new Set(looks.map((l) => l.hair.style))),
        // 每人网格/材质数（定位 draw call 用；只读）
        meshesPer: models.map((m) => { const inf = m.info ? m.info() : null; return inf ? { meshes: inf.meshes, materials: inf.materials, triangles: inf.triangles, detail: inf.detail } : null; }).filter(Boolean),
      };
    },
    setAllDetail(level) { let n = 0; for (const c of chars) if (c.model && c.model.setDetail) { c.model.setDetail(level); n++; } return n; },
    renderOnce() { try { renderer.render(scene, camera); } catch (e) {} return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; },
    quality: () => {
      let lightsVisible = 0;
      try { scene.traverse((o) => { if (o.isLight && o.visible) lightsVisible++; }); } catch (e) {}
      return {
        level: adaptiveQuality.level,
        fps: (window.__FW3D_FPS || Math.round(adaptiveQuality.fps)),
        shadows: renderer.shadowMap.enabled,
        crowd: (typeof crowdMesh !== 'undefined' && crowdMesh) ? crowdMesh.count : 0,
        dpr: +renderer.getPixelRatio().toFixed(2),
        gpu: softwareGPU ? 'software' : (lowSpec ? 'low' : 'high'),
        gpuName: gpuProbe.name || null,
        calls: renderer.info.render.calls,
        lights: lightsVisible,
      };
    },
    // 自检/调参用：直接设定画质档位（0 最低 … 3 最高），返回实际档位
    setQuality: (level) => applyQuality(level),
    // 记分屏单次重绘成本（强制 N 次重绘并计时；只读诊断，不参与玩法）
    debugBoardCost(n) {
      if (!scoreboard || !scoreboard.update) return null;
      const N = Math.max(1, Math.min(200, Number(n) || 60));
      const before = scoreboard.data ? scoreboard.data.clockSeconds : null;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        if (scoreboard.data) scoreboard.data.clockSeconds = 1000 + i * 1.37;
        scoreboard.update(0.016, i * 0.016);
      }
      const ms = performance.now() - t0;
      if (scoreboard.data && before != null) scoreboard.data.clockSeconds = before;
      return { n: N, totalMs: +ms.toFixed(1), perDrawMs: +(ms / N).toFixed(2) };
    },
    boardOnScreen: () => sbVisible,
    // 渲染分组统计：定位"到底是谁在吃 draw call"（只读）
    perfGroups: () => {
      const playerRoots = new Set();
      for (const c of chars) if (c.model && c.model.object) playerRoots.add(c.model.object);
      const inside = (o, root) => { let p = o; while (p) { if (p === root) return true; p = p.parent; } return false; };
      const groups = { players: 0, nameTags: 0, stadium: 0, pitch: 0, other: 0 };
      const visible = { players: 0, nameTags: 0, stadium: 0, pitch: 0, other: 0 };
      scene.traverse((o) => {
        if (!o.isMesh) return;
        let key = 'other';
        if (o.name === 'nameTag') key = 'nameTags';
        else {
          for (const r of playerRoots) { if (inside(o, r)) { key = 'players'; break; } }
          if (key === 'other' && built && built.group && inside(o, built.group)) key = 'stadium';
          if (key === 'other' && pitchCore && pitchCore.group && inside(o, pitchCore.group)) key = 'pitch';
        }
        groups[key]++;
        if (o.visible) visible[key]++;
      });
      return { groups, visible, calls: renderer.info.render.calls };
    },
    controlMode: () => ctrlMode,
    setControlMode: (m) => { if (['full','key','cinematic'].indexOf(m) >= 0) ctrlMode = m; window.__FW3D_CONTROL = m; try { localStorage.setItem('fw3d.control', m); } catch (e) {} return ctrlMode; },
    keyMomentActive: () => keyMoment.active,
    celebrateState: () => ({ t: +celebrate.t.toFixed(2), phase: +celebrate.phase.toFixed(2) }),
    celebrate() {
      celebrate.t = 3.4; celebrate.phase = 0;
      const m = chars.find((c) => c.isMe);
      if (m && m.model && m.model.celebratePose) m.model.celebratePose(persona.celebrate || 'arms');
    },
    teleportToBall() { ball.pos.set(ctrl.pos.x, BALL.r, ctrl.pos.z - 1.2); ball.vel.set(0, 0, 0); },
    // 直接站到球场里（跳过通道出场；自检和调试用，比赛时钟会随即开始）
    // 位置改为"从西侧边线内侧走进场"，与新通道出口方向一致，避免瞬移方向与入场演出冲突。
    enterPitch() {
      ctrl.pos.set(-(W / 2 - 4), 0, TZ);
      ctrl.vel.set(0, 0, 0);
      ctrl.yaw = -Math.PI / 2;   // 面向 +x（球场中央）
      ctrl.pitch = 0;
      return { x: ctrl.pos.x, z: ctrl.pos.z };
    },
    update(dt) {
      elapsed += dt;
      ME_CHAR = chars.find((c) => c.isMe) || null;
      if (cardT > 0) { cardT -= dt; if (cardT <= 0 && cardHud) cardHud.style.opacity = '0'; }
      tickQuality(dt);
      // ── 输入层 → 视角：电脑（指针锁定/拖拽）与手机（右半屏滑动）的唯一出口。
      //    takeLook() 返回本次累计的弧度增量，在这里一次性落到 ctrl.yaw/pitch；
      //    随后的 updateMovement / updateCamera 用的就是最新朝向。
      const lookDelta = input.takeLook();
      if (lookDelta.dx || lookDelta.dy) {
        ctrl.yaw -= lookDelta.dx;
        // 观赛时抬头看观众/回身看教练的幅度要大一些（球员视角只需要看球）
        const pitchMax = spectateMode ? 1.25 : 0.9;
        ctrl.pitch = Math.max(-pitchMax, Math.min(pitchMax, ctrl.pitch - lookDelta.dy));
      }
      // ── 玩家第一人称：位置立刻同步到自己的 agent（AI 传给"你"的球会落到你的真实位置）
      // 注意：按 isUser 查找，不写死 'home-9'（阵型顺序一旦调整，写死会静默失效）
      const meAgent = agents.find((a) => a.isUser);
      // 跳跃推进：0.62 s 的抛物线，只改"离地高度"，不参与水平运动与物理积分。
      // 放在这里（每帧、与输入无关）而不是 updateMovement 里，观赛/电影模式也不会漏掉收尾。
      if (jump.active) {
        jump.t += dt;
        const u = Math.min(1, jump.t / JUMP.dur);
        ctrl.air = JUMP.h * 4 * u * (1 - u);
        if (u >= 1) { jump.active = false; jump.t = 0; ctrl.air = 0; }
      }
      if (meAgent) {
        meAgent.x = ctrl.pos.x; meAgent.z = ctrl.pos.z;
        meAgent.vx = ctrl.vel.x; meAgent.vz = ctrl.vel.z;
        meAgent.facing = ctrl.yaw + Math.PI;
        meAgent.stamina = ctrl.stamina;
        meAgent.y = ctrl.air;
      }
      // 滑铲铲空后倒地：期间限制移动（与 NPC 同一时长，见 getUpTime），只保留惯性滑停
      if (meAgent && meAgent.downUntil && elapsed < meAgent.downUntil) {
        ctrl.vel.multiplyScalar(Math.exp(-dt * 8));
        ctrl.pos.addScaledVector(ctrl.vel, dt);
      } else {
        updateMovement(dt);
      }
      // 手机端按钮文案随「有球/无球」切换（射门↔滑铲、传球↔抢断）
      try { input.ballState(playerOnBall()); } catch (er) {}
      if (meAgent) {
        meAgent.x = ctrl.pos.x; meAgent.z = ctrl.pos.z;
        meAgent.vx = ctrl.vel.x; meAgent.vz = ctrl.vel.z;
        meAgent.stamina = ctrl.stamina;
        meAgent.y = ctrl.air;
      }
      if (charge.on) {
        charge.t = Math.min(charge.max, charge.t + dt);
        charge.sweep += charge.dir * dt * 1.35;
        if (charge.sweep > 1) { charge.sweep = 1; charge.dir = -1; }
        if (charge.sweep < 0) { charge.sweep = 0; charge.dir = 1; }
        // 同值不写 DOM（蓄力条每帧都在动，但最大值没变时不必重设）
        if (hudDomState.chargeOpacity !== '1') { hudMark.style.opacity = '1'; hud.style.opacity = '1'; hudDomState.chargeOpacity = '1'; }
        const markLeft = (charge.sweep * 100) + '%';
        if (markLeft !== hudDomState.markLeft) { hudMark.style.left = markLeft; hudDomState.markLeft = markLeft; }
        const fillWidth = Math.round((charge.t / charge.max) * 100) + '%';
        if (fillWidth !== hudDomState.fillWidth) { hudFill.style.width = fillWidth; hudDomState.fillWidth = fillWidth; }
      }
      // 通道灯只在场内看不到时才关掉；走进通道自动点亮（省下 5 盏逐片元光源）
      if (tunnelLights.length) {
        // 通道沿 x 铺，所以判据是"在边线以外、且靠近中线"
        const lit = ctrl.pos.x < -(W / 2 + 0.5) && Math.abs(ctrl.pos.z - TZ) < TW / 2 + 3;
        if (lit !== tunnelLit) {
          tunnelLit = lit;
          for (const l of tunnelLights) l.visible = lit;
        }
      }
      // ── 队伍 AI：快照 → 角色 → 行为 → 运动 → 出脚；然后是球权与带球
      if (AI_ENABLED) {
        aiTick(dt);
        ballTick(dt);
        tackleTick(dt);
        keeperTick(dt);
        headerTick();
      } else {
        legacyNpcBrain();
      }
      // ── 球员模型：位置/朝向/步频都来自 agent（不再用正弦巡逻）
      for (const c of chars) {
        const a = c.agent;
        if (!a) continue;
        if (a.off) continue;                 // 罚下的球员不再参与渲染/动画更新
        c.model.object.position.x = a.x;
        c.model.object.position.y = a.y || 0;      // 起跳（玩家）/ 其它球员恒为 0
        c.model.object.position.z = a.z;
        c.model.object.rotation.y = a.facing;
        const sp = Math.hypot(a.vx, a.vz);
        a.animT += dt * (0.55 + sp * 0.62);
        // 步态种类：速度方向 vs 身体朝向（第一阶段：侧移/后退专用姿态）
        if (c.model.setMoveKind) {
          const mk = moveKindOf(a.vx, a.vz, a.facing);
          c.model.setMoveKind(mk.kind, mk.side);
        }
        c.model.update(dt, sp, a.animT);
      }
      // ── 替补席上的坐姿角色（自由观赛）：只播坐姿循环，位置不动
      for (const s of sitting) s.model.update(dt, 0, elapsed + s.phase);
      // ── [players-subsystem] LOD：按与镜头的距离切细节（远景隐面部细节与号码贴图）
      lodTimer += dt;
      if (lodTimer > 0.4) {
        lodTimer = 0;
        // 低画质档位把 LOD 距离整体拉近（远处球员提前丢掉面部细节与号码，省 draw call）
        const lodBias = (QUALITY_STEPS[adaptiveQuality.level] || {}).lodBias || 1;
        const lowD2 = 3025 * lodBias, midD2 = 400 * lodBias;
        for (const c of chars) {
          if (!c.model.setDetail || !c.model.object) continue;
          const dx = c.model.object.position.x - camera.position.x;
          const dz = c.model.object.position.z - camera.position.z;
          const d2 = dx * dx + dz * dz;
          const lvl = d2 > lowD2 ? 'low' : d2 > midD2 ? 'mid' : 'full';   // 基数 55m / 20m
          if (c.model.detail() !== lvl) c.model.setDetail(lvl);
        }
      }
      if (!AI_ENABLED) (function patrol() {
        for (const c of chars) {
          const t = elapsed + c.phase;
          const bob = Math.sin(t * 0.55) * 2.2;
          c.model.object.position.z = c.base + bob * 0.4;
          c.model.object.position.x = Math.sin(t * 0.31) * 1.2;
          c.model.object.rotation.y = Math.PI + Math.sin(t * 0.31) * 0.25;
          c.model.update(dt, Math.abs(Math.cos(t * 0.55)) * c.walk, t);
        }
      })();
      // ── 旧版：最近者持球（AI_ENABLED=false 时的降级路径，保留以免丢失演示行为）
      function legacyNpcBrain() {
        if (!matchMode && !tourMode && !(opts && opts.detail)) { /* 训练/探访也允许 */ }
        let owner = null, best = 5.0;
        for (const c of chars) {
          if (c.isMe) continue;
          const d = Math.hypot(c.model.object.position.x - ball.pos.x, c.model.object.position.z - ball.pos.z);
          if (d < best) { best = d; owner = c; }
        }
        if (!owner) return;
        const me = chars.find((c) => c.isMe);
        const now = performance.now();
        if (!legacyNpcBrain.next || now - legacyNpcBrain.next > 700) {
          legacyNpcBrain.next = now;
          const ownerPos = new THREE.Vector3().copy(owner.model.object.position);
          const toMe = me ? ownerPos.distanceTo(me.model.object.position) : 99;
          const pressure = chars.reduce((acc, c) => {
            if (c === owner || c.isMe) return acc;
            const d = Math.hypot(c.model.object.position.x - ownerPos.x, c.model.object.position.z - ownerPos.z);
            return acc + (d < 4 ? 1 : 0);
          }, 0);
          const goalDist = Math.abs(-34 - ownerPos.z);
          // 效用：传给你 = 距离适中 + 你更靠前；带球 = 空间大；射门 = 靠近球门
          const passScore = me ? (toMe > 4 && toMe < 26 ? 1.2 : 0.3) + (me.model.object.position.z < ownerPos.z ? 0.5 : 0) - pressure * 0.15 : 0;
          const dribbleScore = 0.9 - pressure * 0.35;
          const shootScore = goalDist < 22 ? 1.1 : 0.1;
          const pick = Math.max(passScore, dribbleScore, shootScore);
          if (pick === passScore && me) {
            const dir = new THREE.Vector3(me.model.object.position.x - ball.pos.x, 0, me.model.object.position.z - ball.pos.z).normalize();
            ball.vel.copy(dir).multiplyScalar(14 + Math.random() * 4);
            ball.vel.y = 1.0;
            actionStats.npcPass = (actionStats.npcPass || 0) + 1;
            owner.model.kick && owner.model.kick(0.7);
          } else if (pick === shootScore) {
            const dir = new THREE.Vector3(-ball.pos.x * 0.02, 0, -34 - ball.pos.z).normalize();
            ball.vel.copy(dir).multiplyScalar(22);
            ball.vel.y = 1.4;
            actionStats.npcShot = (actionStats.npcShot || 0) + 1;
            owner.model.kick && owner.model.kick(1);
          } else {
            const dir = new THREE.Vector3(-Math.sin(owner.model.object.rotation.y), 0, -Math.cos(owner.model.object.rotation.y));
            ball.vel.copy(dir).multiplyScalar(6.5);
            actionStats.npcDribble = (actionStats.npcDribble || 0) + 1;
          }
        }
      }

      // ── 第一触球：球高速接近时触发接球动作，质量取决于来球速度与朝向
      (function firstTouch() {
        const me = ME_CHAR;
        if (!me || !me.model) return;
        const d = Math.hypot(ball.pos.x - ctrl.pos.x, ball.pos.z - ctrl.pos.z);
        const speed = ball.vel.length();
        // 两个前置条件，旧实现都没有 —— 于是「玩家刚踢出去的球」在下一帧被自己的停球逻辑
        // 吸收了 70% 的速度（射门/传球软绵绵的真正根因，不是出脚力量不够）：
        //   ① 球必须朝自己飞来（来球速度与「球→人」方向反向），飞走的球不算第一触球；
        //   ② 刚出脚的 0.5 s 内一律不判（PLAYER_KICK_LOCK，与球权接管共用同一窗口）。
        const toBall = TMP_A.set(ball.pos.x - ctrl.pos.x, 0, ball.pos.z - ctrl.pos.z);
        const gap = toBall.length();
        const approaching = gap > 1e-6 ? -(toBall.x * ball.vel.x + toBall.z * ball.vel.z) / gap : 0;
        const fresh = !!(ball.lastKicker && me.agent && ball.lastKicker === me.agent.id
          && elapsed - ball.lastKickAt < PLAYER_KICK_LOCK);
        if (d < 1.35 && speed > 6 && approaching > 0.5 && !fresh && !me.receiving) {
          const facing = TMP_B.set(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
          toBall.normalize();
          const align = Math.max(0, facing.dot(toBall));          // 正面接球最好
          const q = Math.max(0, Math.min(1, align * 0.7 + (1 - Math.min(1, speed / 26)) * 0.5));
          me.receiving = true;
          if (me.model.receivePose) me.model.receivePose(q);
          actionStats.receive++;
          actionStats.lastBallSpeed = +speed.toFixed(1);
          // 停球：质量高吸收更多速度，质量低球弹开
          const absorb = 0.25 + q * 0.6;
          ball.vel.multiplyScalar(1 - absorb);
          ball.vel.x += toBall.x * (1 - q) * 6;
          ball.vel.z += toBall.z * (1 - q) * 6;
          setTimeout(() => { me.receiving = false; }, 450);
        }
      })();

      // ── 护球：按住 Q 时转身用身体挡住球，移动变慢但球更贴脚
      if (ctrl.shield) {
        const me = ME_CHAR;
        if (me && me.model && me.model.shieldPose) me.model.shieldPose(true);
        actionStats.shield = Math.min(999, actionStats.shield + 1);
        if (ball.pos.distanceTo(TMP_B.set(ctrl.pos.x, ball.pos.y, ctrl.pos.z)) < 1.2) {
          ball.vel.x *= 0.82; ball.vel.z *= 0.82;
        }
      } else {
        const me = ME_CHAR;
        if (me && me.model && me.model.shieldPose) me.model.shieldPose(false);
      }

      // ── 转身：速度方向与朝向夹角骤变时触发
      (function turning() {
        const dv = TMP_A.copy(ctrl.vel).sub(prevVel);
        if (dv.length() > 3.4) {
          const me = ME_CHAR;
          if (me && me.model && me.model.turnPose) me.model.turnPose(dv.x > 0 ? 1 : -1);
          actionStats.turn++;
        }
        prevVel.copy(ctrl.vel);
      })();

      // ── 失衡：高速带球且贴近其他球员时，有概率被撞失衡并掉球
      (function challenge() {
        if (ball.vel.length() < 3) return;
        const sp = ctrl.vel.length();
        if (sp < 4.5) return;
        for (const c of chars) {
          if (c.isMe) continue;
          const d = Math.hypot(c.model.object.position.x - ctrl.pos.x, c.model.object.position.z - ctrl.pos.z);
          if (d < 1.5 && Math.random() < 0.02) {
            const me = ME_CHAR;
            if (me && me.model && me.model.stumblePose) me.model.stumblePose();
            actionStats.stumble++;
            ball.vel.x += (Math.random() - 0.5) * 5;
            ball.vel.z += (Math.random() - 0.5) * 5;
            ctrl.vel.multiplyScalar(0.4);
            try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
            break;
          }
        }
      })();

      // 带球：球在脚边且慢速时，顺着前进方向轻推
      if (ball.pos.distanceTo(TMP_B.set(ctrl.pos.x, ball.pos.y, ctrl.pos.z)) < 0.9 && ball.vel.length() < 4.5) {
        const push = TMP_A.set(ctrl.vel.x, 0, ctrl.vel.z);
        if (push.lengthSq() > 0.4) {
          ball.vel.x = push.x * 0.92 + ball.vel.x * 0.25;
          ball.vel.z = push.z * 0.92 + ball.vel.z * 0.25;
        }
      }
      // ── 比赛时钟：唯一权威在 matchState（ms）， HUD 只读它
      // 开球：比分从 0-0 开始（引擎时间线里的比分是"已踢完那场"的结果，只作赛前情报，
      // 不再直接当作 3D 比赛的实时比分显示）
      if (matchMode && !matchStarted && Math.abs(ctrl.pos.x) < W / 2 - 1 && Math.abs(ctrl.pos.z) < L / 2 - 1) {
        matchStarted = true;
        ms.setScore(0, 0);
        ms.resume(elapsed);
        try { fw3dAudio.whistle(true); fw3dAudio.boost(1.6); } catch (e) {}
      }
      // 自由观赛：不靠"走进球场"开表（球场本来就进不去），进场即开球
      if (spectateMode && !matchStarted) {
        matchStarted = true;
        const n = initSpectateScript();
        ms.resume(elapsed);
        try { fw3dAudio.whistle(true); fw3dAudio.boost(1.4); } catch (e) {}
        toast('坐在替补席上 · 比赛开始 · C 起立走走', 3400);
        actionStats.spectateScript = n;
      }
      if (ctrlMode === 'key' && matchMode && matchStarted && !ms.state.over) {
        if (!keyMoment.active && Math.floor(ms.state.minute) % 20 === 0) { keyMoment.active = true; keyMoment.t = 6; }
        if (keyMoment.active) { keyMoment.t -= dt; if (keyMoment.t <= 0) keyMoment.active = false; }
      }
      if ((matchMode || spectateMode) && matchStarted && !ms.state.over) {
        var tl = window.__FW3D_TIMELINE;
        // 比赛模式才用"时间线字幕"盖在 3D 比分上；观赛模式由脚本进球自己出字幕，避免两套字幕打架
        if (!spectateMode) {
          if (tl && tl.events && tl.events.length && !matchClock.fired) matchClock.fired = {};
          if (tl && tl.events) {
            tl.events.forEach(function (ev) {
              if (matchClock.fired && !matchClock.fired[ev.minute] && ms.state.minute >= ev.minute) {
                matchClock.fired[ev.minute] = true;
                if (fullTimeHud) {
                  try { if (ev.mine) { celebrate.t = 3.4; celebrate.phase = 0; celebrate.ang0 = Math.PI * 0.72; goalOverlay(ev); fw3dAudio.cheer(); fw3dAudio.boost(2.2); setTimeout(function(){fw3dAudio.boost(1);},3000); } else { fw3dAudio.whistle(false); } } catch (e) {}
                  fullTimeHud.style.display = 'grid';
                  fullTimeHud.innerHTML = '<div style="color:' + (ev.mine ? '#9ef2c2' : '#e8eef8') + '">' + (ev.mine ? '你进球了！' : '进球') + '<br><span style="font-size:20px;opacity:.8">' + ev.minute + "'  " + (ev.scorer || '') + '</span></div>';
                  setTimeout(function () { fullTimeHud.style.display = 'none'; }, 1200);
                }
              }
            });
          }
        }
        ms.tick(dt, elapsed);
        if (spectateMode) scriptedGoalsTick();
        var m = Math.min(90, Math.floor(ms.state.minute));
        // 比分唯一来源：MatchState（第六阶段）。球进网由 checkOutOfPlay 判入 ms.goal，
        // 不再读引擎时间线的 __FW3D_SCORE，避免两套比分互相矛盾。
        var scoreTxt = ms.state.score.home + ' - ' + ms.state.score.away;
        // 只在文本真的变了才写 DOM：textContent 每帧赋值会重建文本节点并触发重排
        var scoreLine = m + "'   " + scoreTxt;
        if (scoreLine !== hudDomState.score) { hudDomState.score = scoreLine; scoreHud.textContent = scoreLine; }
        if (ms.state.over || ms.state.minute >= 90) {
          try { fw3dAudio.whistle(true); } catch (e) {}
          if (spectateMode) {
            // 终场前把没演完的脚本进球补齐，保证 3D 终场比分 = 2D 结果
            while (specScript.idx < specScript.events.length) {
              const ev = specScript.events[specScript.idx++];
              creditScriptedGoal(ev.team === 'away' ? 'away' : 'home', ev.scorer, ev.minute, true);
            }
            scoreTxt = ms.state.score.home + ' - ' + ms.state.score.away;
          }
          fullTimeHud.style.display = 'grid';
          fullTimeHud.innerHTML = '<div>全场结束<br><span style="font-size:22px;opacity:.8">' + scoreTxt + '</span><br><span style="font-size:14px;opacity:.6">'
            + (spectateMode ? '4 秒后回到文字界面' : '3 秒后回到文字界面') + '</span></div>';
          setTimeout(function () { if (window.FW3D && FW3D.close) FW3D.close(); }, spectateMode ? 4000 : 3000);
        }
      }
      updateBall(dt);
      handTick();
      checkOutOfPlay();
      // 体力 + 换人（P3）：体力随跑动消耗；AI 到点/到阈值自动换人
      if (matchMode) { staminaTick(dt); autoSubTick(dt); }
      // 裁判：有任务点（判罚后跑向球）就去任务点，否则按"球后方 7 m、横向偏 3.2 m"跟随
      if (referee) {
        let target;
        if (referee.task && elapsed < referee.task.until) target = { x: referee.task.x, z: referee.task.z };
        else {
          referee.task = null;
          target = refAnchor(ball.pos, { attackSide: 1, behind: 7, lateral: 3.2 });
        }
        referee.update(dt, target, elapsed);
      }
      for (const lm of linesmen) lm.update(dt, ball.pos, elapsed, PITCH);
      syncScoreboard(dt);
      updateCamera(dt);
      try { updateNameTagScale(dt, camera); } catch (e) {}
      renderer.render(scene, camera);
    },
    info,
    dispose() {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keydown', keyV);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('mousedown', mouseDown);
      window.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('resize', resize);
      // 输入层必须在场景销毁时摘除：否则每次进出 3D 都会在 document/window 上留一份监听，
      // 旧场景的 mousemove 会继续改已销毁场景的 ctrl.yaw（这也是过去「越玩越飘」的隐患）。
      try { input.dispose(); } catch (e) {}
      try { debugHud.dispose(); } catch (e) {}
      // 战术胶囊也是 host 里的 DOM，必须一起摘掉，否则退出再进会叠出第二个
      try { if (tacticsHud && tacticsHud.parentNode) tacticsHud.parentNode.removeChild(tacticsHud); } catch (e) {}
      // 自由观赛提示条同理（外加把它的延时清掉，避免退出后还去改已销毁的 DOM）
      try { clearTimeout(toast._t); if (specHint && specHint.parentNode) specHint.parentNode.removeChild(specHint); } catch (e) {}
      try { if (scoreHud && scoreHud.parentNode) scoreHud.parentNode.removeChild(scoreHud); } catch (e) {}
      try { if (fullTimeHud && fullTimeHud.parentNode) fullTimeHud.parentNode.removeChild(fullTimeHud); } catch (e) {}
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
