// FW3D · 参数化低模身体构造（只造几何 + 绑定的关节组，不含任何动画代码）
//
// 为什么单独一个文件：
//  · character.js 里的动画（跑/待机/射门/扑救/庆祝…）已经成熟，不能动；它只认 rig 结构：
//    { torso, head, armL:{shoulder,forearm}, armR:{...}, legL:{hip,shin,foot}, legR:{...} }
//  · 本文件负责按 look（players/appearance.js 产出的倍率表）把这套关节组装出来，
//    返回结构完全兼容的 rig → 动画、AI、比赛逻辑零改动。
//  · 性能：每个刚体组里的方块合并进一个 BufferGeometry，颜色写顶点色 → 每组 1 个 Mesh、共用 1 个材质。
//    旧版每人约 20 个 Mesh / 18 个材质；本路径每人 12–14 个 Mesh、全队共用 1 个材质。
//  · 面部细节（眼/眉/耳/鼻/嘴/胡须/发带）单独合并成 headDetail，可按距离整块隐藏（LOD）。

const SHARED = new WeakMap();

function sharedOf(THREE) {
  let s = SHARED.get(THREE);
  if (s) return s;
  // 顶点色材质：所有球员、所有方块共用（材质数 1，GPU 状态切换几乎归零）
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02 });
  material.name = 'fw3d-player-vertexcolor';
  const unit = new THREE.BoxGeometry(1, 1, 1);
  s = { material, uPos: unit.attributes.position.array, uNor: unit.attributes.normal.array, uIdx: unit.index.array, unit };
  SHARED.set(THREE, s);
  return s;
}

function createBaker(THREE, share) {
  const parts = [];
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const tmpNM = new THREE.Matrix3();
  const tmpC = new THREE.Color();

  const api = {
    add(w, h, d, x, y, z, color, rx, ry, rz) {
      if (!(w > 0) || !(h > 0) || !(d > 0)) return api;     // 丢弃退化方块，避免 NaN
      parts.push({ w, h, d, x, y, z, color, rx: rx || 0, ry: ry || 0, rz: rz || 0 });
      return api;
    },
    count: () => parts.length,
    bake(parent) {
      const n = parts.length;
      if (!n) return null;
      const pos = new Float32Array(n * 72);
      const nor = new Float32Array(n * 72);
      const col = new Float32Array(n * 72);
      const idx = n * 24 > 65535 ? new Uint32Array(n * 36) : new Uint16Array(n * 36);
      const up = share.uPos, un = share.uNor, ui = share.uIdx;
      for (let i = 0; i < n; i++) {
        const b = parts[i];
        tmpE.set(b.rx, b.ry, b.rz, 'XYZ');
        tmpQ.setFromEuler(tmpE);
        tmpP.set(b.x, b.y, b.z);
        tmpS.set(b.w, b.h, b.d);
        tmpM.compose(tmpP, tmpQ, tmpS);
        tmpNM.getNormalMatrix(tmpM);
        tmpC.set(b.color == null ? 0xffffff : b.color);
        const o = i * 72;
        for (let k = 0; k < 24; k++) {
          const k3 = k * 3;
          tmpV.set(up[k3], up[k3 + 1], up[k3 + 2]).applyMatrix4(tmpM);
          pos[o + k3] = tmpV.x; pos[o + k3 + 1] = tmpV.y; pos[o + k3 + 2] = tmpV.z;
          tmpV.set(un[k3], un[k3 + 1], un[k3 + 2]).applyMatrix3(tmpNM).normalize();
          nor[o + k3] = tmpV.x; nor[o + k3 + 1] = tmpV.y; nor[o + k3 + 2] = tmpV.z;
          col[o + k3] = tmpC.r; col[o + k3 + 1] = tmpC.g; col[o + k3 + 2] = tmpC.b;
        }
        const io = i * 36;
        for (let k = 0; k < 36; k++) idx[io + k] = ui[k] + i * 24;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, share.material);
      mesh.castShadow = true;
      mesh.name = 'fw3d-part';
      parent.add(mesh);
      return mesh;
    },
  };
  return api;
}

/**
 * 造一个参数化低模球员的身体。
 * @param {*} THREE three 模块
 * @param {object} L toMeshLook() 的结果
 * @param {object} kit { jersey, shorts, accent, boot, socks, captain }
 * @returns {{torso,head,armL,armR,legL,legR,hipY,dims,meshes,detailMesh,boxCount}}
 */
export function buildParametricBody(THREE, L, kit = {}) {
  const share = sharedOf(THREE);
  const jersey = kit.jersey == null ? 0x2f5e42 : kit.jersey;
  const shorts = kit.shorts == null ? 0xefeee4 : kit.shorts;
  const accent = kit.accent == null ? shorts : kit.accent;
  const boot = kit.boot == null ? 0x14161a : kit.boot;
  const sock = kit.socks == null ? 0x14161a : kit.socks;
  const skin = L.skin;

  const HIP = 0.95 * L.leg.hip;
  const TORSO_W = 0.44 * L.torso.w;
  const TORSO_D = 0.24 * L.torso.d;
  const TORSO_H = 0.52;
  const SHOULDER_X = 0.27 * L.torso.shoulderX;
  const SHOULDER_Y = 0.46;
  const HEAD_Y = 0.575;
  const meshes = [];

  // ── 躯干
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.y = HIP;
  const torsoB = createBaker(THREE, share);
  torsoB.add(TORSO_W, TORSO_H, TORSO_D, 0, 0.26, 0, jersey);
  torsoB.add(0.045, 0.50, TORSO_D * 1.015, -(TORSO_W / 2 - 0.008), 0.26, 0, accent);   // 侧条
  torsoB.add(0.045, 0.50, TORSO_D * 1.015, (TORSO_W / 2 - 0.008), 0.26, 0, accent);
  torsoB.add(TORSO_W * 0.98, 0.10, TORSO_D * 1.01, 0, 0.02, 0, shorts);                 // 腰带
  torsoB.add(0.20 * L.torso.neck, 0.09, 0.18 * L.torso.neck, 0, 0.535, 0, skin);        // 脖子
  if (L.access.undershirt) torsoB.add(0.170 * L.torso.neck, 0.022, 0.190 * L.torso.neck, 0, 0.556, 0, 0xcdd4dc);
  meshes.push(torsoB.bake(torso));

  // ── 头
  const HW = 0.26 * L.head.w;
  const HH = 0.28 * L.head.h;
  const HD = 0.24 * L.head.d;
  const HCY = 0.12;
  const TOP_Y = HCY + HH * 0.5;
  const FRONT_Z = HD * 0.5;

  const head = new THREE.Group();
  head.name = 'head';
  head.position.y = HEAD_Y;
  torso.add(head);
  const headB = createBaker(THREE, share);
  const detailB = createBaker(THREE, share);

  // 胡须类型在"建下颌"之前就要知道（下面的胡须贴片要用），但**不对下颌做任何染色**：
  // 胡茬就是一块贴面薄片，简单处理即可（用户要求：胡子不要有多余的设计）。
  const B = L.beard.style;
  const beardC = L.beardColor;

  // 颅骨 / 中脸 / 下颌：三段叠加形成脸型（宽、长、下颌收窄、下巴突出）
  headB.add(HW, HH * 0.72, HD, 0, HCY + HH * 0.06, 0, skin);
  headB.add(HW * (0.94 + (L.head.cheek - 1) * 0.55), HH * 0.22, HD * (0.97 + L.head.brow * 0.03), 0, HCY - HH * 0.16, 0, skin);
  // taper：上宽下窄程度。下颌宽度 = 头宽 × jaw × taper 收窄系数
  const jawW = HW * L.head.jaw * (0.96 + (L.head.cheek - 1) * 0.35) * (1 - L.head.taper * 0.14);
  // 下颌的正面比中脸**略凸 1.5 mm**：完全齐平会让两个盒子的正面共面 → z-fighting
  // （表现就是"下颌那块颜色忽隐忽现/出现虚线"）。略微凸出既符合下颌轮廓，也能让胡茬色稳定显示。
  const JAW_D = HD * 0.93;
  const JAW_Z = FRONT_Z + 0.0015 - JAW_D / 2;
  headB.add(jawW, HH * 0.24 * L.head.chin, JAW_D, 0, HCY - HH * 0.36, JAW_Z, skin);
  // 下巴凸起：只在明显时补一小块，**且必须齐平**（原来 z=FRONT_Z*0.62、y=-0.47，整块挂在下颌下方，
  // 就是这个球员"嘴下面很奇怪"的主要来源）
  if (L.head.chin > 1.03) {
    const CHIN_D = HD * 0.30;
    headB.add(jawW * 0.58, HH * 0.10, CHIN_D, 0, HCY - HH * 0.435, FRONT_Z + 0.003 - CHIN_D / 2, skin);
  }
  // 额头只在高额头时补一块，并且做成与颅骨齐平（避免出现一道台阶）
  if (L.head.forehead > 1.04) headB.add(HW * 0.995, HH * 0.05, HD * 0.995, 0, HCY + HH * 0.31, 0, skin);
  // 颧骨侧向突出：厚度极薄的一层，只在明显时出现（近景增加脸型辨识度，远景几乎无成本）
  if (L.head.cheekbone > 0.55) {
    const cx = HW * (0.5 + (L.head.cheek - 1) * 0.12);
    const ch = HH * 0.13 * (0.7 + L.head.cheekbone * 0.6);
    headB.add(0.014, ch, HD * 0.52, -cx, HCY - HH * 0.12, HD * 0.04, skin);
    headB.add(0.014, ch, HD * 0.52, cx, HCY - HH * 0.12, HD * 0.04, skin);
  }

  // ── 毛发
  const HG = L.hair;                                   // 发型几何参数（style/capH/sides/back/top/front/tufts）
  const hairCol = L.hairColor != null ? L.hairColor : 0x14100e;   // 发色（此前误用了 L.hair → 材质变白 → 看起来像光头）
  if (HG.capH > 0) {
    const capH = HG.capH * (0.85 + L.head.h * 0.2);
    const capY = TOP_Y - capH * 0.35 + (HG.style === 'receding' ? 0.012 : 0);
    const capZ = HG.style === 'receding' ? -0.014 : 0;
    headB.add(HW * 1.045, capH, HD * 1.045, 0, capY, capZ, hairCol);
    if (HG.sides > 0.1) {
      const sh = HH * 0.30 * HG.sides;
      const sy = HCY + HH * 0.20;
      headB.add(0.022, sh, HD * 0.86, -(HW * 0.5 + 0.004), sy, 0, hairCol);
      headB.add(0.022, sh, HD * 0.86, (HW * 0.5 + 0.004), sy, 0, hairCol);
    }
    if (HG.back > 0.1) headB.add(HW * 0.98, HH * 0.34 * HG.back, 0.03, 0, TOP_Y - HH * 0.20, -(FRONT_Z + 0.006), hairCol);
    if (HG.front > 0.1) {
      const sx = HG.style === 'side' ? HW * 0.12 : 0;   // 侧分：发片偏一侧（不对称 = 辨识度）
      headB.add(HW * (0.72 + HG.front * 0.18), 0.012 + 0.032 * HG.front, HD * 0.22, sx, TOP_Y - capH * 0.85, FRONT_Z * 0.42, hairCol);
    }
    if (HG.top > 0) {
      const tufts = HG.tufts || [];
      for (let i = 0; i < Math.min(HG.top, tufts.length); i++) {
        const t = tufts[i];
        const s = 0.05 * t.s;
        headB.add(s, s * 0.9, s, t.x * HW * 0.7, TOP_Y + t.y * 0.02, t.z * HD * 0.7, hairCol);
      }
    }
    if (HG.style === 'afro') {
      headB.add(HW * 1.22, 0.06, HD * 1.20, 0, TOP_Y + 0.03, 0, hairCol);
      headB.add(HW * 1.30, 0.05, HD * 1.26, 0, TOP_Y - 0.02, -0.01, hairCol);
    }
    if (HG.style === 'bun') headB.add(0.085, 0.085, 0.085, 0, TOP_Y + 0.02, -(FRONT_Z * 0.9), hairCol);
    if (HG.style === 'ponytail') {
      headB.add(0.06, 0.055, 0.06, 0, TOP_Y - 0.02, -(FRONT_Z + 0.02), hairCol);
      headB.add(0.055, 0.17, 0.05, 0, TOP_Y - 0.15, -(FRONT_Z + 0.035), hairCol);
    }
    if (HG.style === 'long') {
      headB.add(HW * 0.99, HH * 0.62, 0.052, 0, TOP_Y - HH * 0.42, -(FRONT_Z + 0.012), hairCol);
      headB.add(0.05, HH * 0.46, HD * 0.92, -(HW * 0.5 + 0.008), TOP_Y - HH * 0.34, 0, hairCol);
      headB.add(0.05, HH * 0.46, HD * 0.92, (HW * 0.5 + 0.008), TOP_Y - HH * 0.34, 0, hairCol);
    }
    if (HG.style === 'mohawk') headB.add(HW * 0.30, HG.capH * 1.5, HD * 0.88, 0, TOP_Y + 0.012, 0, hairCol);
  }
  if (L.access.headband != null) headB.add(HW * 1.07, 0.022, HD * 1.07, 0, TOP_Y - (HG.capH || 0.03) - 0.004, 0, L.access.headband);

  // ── 五官（单独合并 → LOD 可整块隐藏）
  // 近景可读性调整：眼睛整体缩小约 15%、眼白压暗一点、瞳孔略放大、眉毛变细并下压、
  // 嘴巴更细更淡。原来的配置在 3.4 m 检视距离上是"巨大白眼 + 细线嘴"，
  // 再叠加丢色的白发，就会读成"光头 + 娃娃脸"，观感偏诡异。
  //
  // 另一个必须遵守的约束：**所有贴面细节都只能比皮肤表面凸出 1–2 mm**。
  // 原来眼睛/嘴/胡茬都是 CENTER = FRONT_Z + 0.004、厚 0.010–0.012，
  // 等于在脸前浮着 10 mm 的方块和 4.5 mm 的胡子片 —— 近看就是"贴在脸上的积木"，
  // 而且会在下方投出一条硬阴影，看起来像脸裂了。现在统一用 FACE_Z 贴面基准：
  const FACE_Z = FRONT_Z - 0.002;      // 细节块的中心面（约 1–2 mm 凸出皮肤）
  const F = L.face;
  const eyeW = 0.036 * F.eyeSize;
  const eyeH = 0.025 * F.eyeSize;
  const eyeX = HW * 0.225 * F.eyeSpacing;
  const eyeY = HCY + HH * 0.055;
  const eyeZ = FACE_Z;
  for (const s of [-1, 1]) {
    // 眼睛：浅色眼白 + 深色瞳孔。低模下纯深色方块在深肤色上几乎看不见（可辨识度直接损失），
    // 加一层眼白能让所有肤色都有眼神，同时保持方块风格。
    detailB.add(eyeW, eyeH, 0.008, s * eyeX, eyeY, eyeZ, 0xd8d1c4, 0, 0, s * F.eyeTilt * 0.25);
    detailB.add(eyeW * 0.52, eyeH * 0.82, 0.006, s * (eyeX + eyeW * 0.05), eyeY, eyeZ + 0.0015, L.eye, 0, 0, s * F.eyeTilt * 0.25);
    detailB.add(eyeW * 1.06 * F.browThickness, 0.010, 0.010, s * eyeX, eyeY + eyeH * 1.05, eyeZ, L.brow, 0, 0, s * F.browAngle);
    detailB.add(0.018 * F.earSize, 0.048 * F.earSize, 0.040 * F.earSize,
      s * (HW * 0.5 + 0.006 + F.earOut * 0.014), HCY + HH * 0.02, -HD * 0.02, skin);
  }
  detailB.add(HW * 0.62, 0.022, 0.020 + L.head.brow * 0.016, 0, eyeY + eyeH * 1.25, FACE_Z - 0.004, skin);   // 眉弓
  const noseW = 0.030 * F.noseWidth;
  const noseH = 0.062 * F.noseLength;
  const noseD = 0.030 + F.noseBridge * 0.022;
  // 鼻子是唯一允许明显前凸的面部件：底面嵌进脸部（-noseD*0.15），前端凸出约 4–6 mm
  detailB.add(noseW, noseH, noseD, 0, HCY - HH * 0.005, FRONT_Z + noseD * 0.22, skin);
  detailB.add(noseW * 1.5, noseH * 0.28, noseD * 0.9, 0, HCY - HH * 0.075, FRONT_Z + noseD * 0.16, skin);
  detailB.add(0.054 * F.mouthWidth, 0.008 + F.mouthFull * 0.007, 0.006, 0, HCY - HH * 0.215, FACE_Z + 0.001, 0x5a3a2c);

  // ── 胡须（贴合下颌表面：正面薄片 + 两侧下颌线，避免"一整块板"或埋进头里）
  const bc = beardC;
  const jawHalf = jawW * 0.5;
  const jawBottom = HCY - HH * (0.36 + 0.12 * L.head.chin);   // 下颌底面
  const lowFaceY = HCY - HH * 0.38;
  if (B === 'stubble') {
    // 胡茬：最简单的一块贴面薄片 + 两条下颌线，颜色 = 发色（黑发 → 黑色胡茬）。
    // 不做颗粒、不做羽化、不给下颌染色 —— 保持低模干净（用户要求：胡子不要有多余的设计）。
    detailB.add(jawW * 0.94, HH * 0.26, 0.004, 0, lowFaceY, FRONT_Z + 0.0025, L.stubbleColor);
    detailB.add(0.010, HH * 0.20, HD * 0.46, -(jawHalf + 0.004), lowFaceY, HD * 0.10, L.stubbleColor);
    detailB.add(0.010, HH * 0.20, HD * 0.46, (jawHalf + 0.004), lowFaceY, HD * 0.10, L.stubbleColor);
  } else if (B === 'mustache') {
    detailB.add(0.052, 0.012, 0.010, 0, HCY - HH * 0.14, FRONT_Z + 0.008, bc);
  } else if (B === 'goatee') {
    detailB.add(0.052, 0.012, 0.010, 0, HCY - HH * 0.14, FRONT_Z + 0.008, bc);
    detailB.add(jawW * 0.40, HH * 0.20, 0.010, 0, HCY - HH * 0.44, FRONT_Z + 0.005, bc);   // 下巴一撮
    detailB.add(jawW * 0.30, 0.012, HD * 0.24, 0, jawBottom, HD * 0.16, bc);                // 颏下
  } else if (B === 'beard' || B === 'fullbeard') {
    const grow = B === 'fullbeard' ? 1.18 : 1;
    detailB.add(jawW * 0.98, HH * 0.30 * grow, 0.010, 0, lowFaceY, FRONT_Z + 0.003, bc);   // 正面下半脸
    for (const s of [-1, 1]) {
      detailB.add(0.012, HH * 0.34 * grow, HD * 0.82, s * (jawHalf + 0.005), HCY - HH * 0.30, HD * 0.05, bc);  // 下颌线
      detailB.add(0.016, HH * 0.15 * grow, HD * 0.28, s * (jawHalf - 0.012), HCY - HH * 0.12, HD * 0.22, bc);   // 鬓角
    }
    detailB.add(jawW * 0.72 * grow, 0.012, HD * 0.34, 0, jawBottom, HD * 0.14, bc);        // 颏下
    detailB.add(0.054, 0.013, 0.011, 0, HCY - HH * 0.14, FRONT_Z + 0.009, bc);             // 上唇
  }

  const headMesh = headB.bake(head);
  const detailMesh = detailB.bake(head);
  meshes.push(headMesh, detailMesh);

  // ── 手臂
  const makeArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.name = side < 0 ? 'armL.shoulder' : 'armR.shoulder';
    shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
    torso.add(shoulder);
    const sb = createBaker(THREE, share);
    const aw = L.arm.w;
    sb.add(0.112 * aw, 0.28, 0.122 * aw, 0, -0.14, 0, jersey);
    sb.add(0.100 * aw, 0.10, 0.110 * aw, 0, -0.30, 0, skin);
    if (kit.captain || L.access.armband) sb.add(0.122 * aw, 0.030, 0.132 * aw, 0, -0.075, 0, 0xf2c14e);
    meshes.push(sb.bake(shoulder));

    const forearm = new THREE.Group();
    forearm.name = side < 0 ? 'armL.forearm' : 'armR.forearm';
    forearm.position.y = -0.32;
    shoulder.add(forearm);
    const fb = createBaker(THREE, share);
    if (L.access.longSleeve) fb.add(0.098 * aw, 0.16, 0.108 * aw, 0, -0.08, 0, jersey);
    fb.add(0.092 * aw, 0.26, 0.102 * aw, 0, -0.13, 0, skin);
    if (L.access.wristTape) fb.add(0.100 * aw, 0.030, 0.110 * aw, 0, -0.215, 0, 0xf0f3f7);
    const handCol = L.access.gloves != null ? L.access.gloves : skin;
    const hs = L.access.gloves != null ? 1.08 : 1;
    fb.add(0.100 * hs, 0.100 * hs, 0.110 * hs, 0, -0.28, 0.01, handCol);
    meshes.push(fb.bake(forearm));
    return { shoulder, forearm };
  };
  const armL = makeArm(-1), armR = makeArm(1);

  // ── 腿
  const makeLeg = (side) => {
    const hip = new THREE.Group();
    hip.name = side < 0 ? 'legL.hip' : 'legR.hip';
    hip.position.set(side * L.leg.hipX, -0.01, 0);
    torso.add(hip);
    const tb = createBaker(THREE, share);
    tb.add(0.155 * L.leg.thigh, 0.30, 0.17 * L.leg.thigh, 0, -0.16, 0, shorts);
    meshes.push(tb.bake(hip));

    const shin = new THREE.Group();
    shin.name = side < 0 ? 'legL.shin' : 'legR.shin';
    shin.position.y = -0.44;
    hip.add(shin);
    const sb = createBaker(THREE, share);
    sb.add(0.135 * L.leg.calf, 0.40, 0.15 * L.leg.calf, 0, -0.20, 0, skin);
    sb.add(0.140 * L.leg.calf, 0.16, 0.155 * L.leg.calf, 0, -0.40, 0, sock);
    sb.add(0.145 * L.leg.calf, 0.035, 0.160 * L.leg.calf, 0, -0.335, 0, accent);
    if (L.access.sockTape) sb.add(0.148 * L.leg.calf, 0.028, 0.162 * L.leg.calf, 0, -0.30, 0, 0xf0f3f7);
    meshes.push(sb.bake(shin));

    const foot = new THREE.Group();
    foot.name = side < 0 ? 'legL.foot' : 'legR.foot';
    foot.position.y = -0.48;
    shin.add(foot);
    const fb = createBaker(THREE, share);
    fb.add(0.145, 0.090, 0.300, 0, 0.02, 0.07, boot);
    fb.add(0.128, 0.055, 0.105, 0, -0.005, 0.205, boot);
    meshes.push(fb.bake(foot));
    return { hip, shin, foot };
  };
  const legL = makeLeg(-1), legR = makeLeg(1);

  return {
    torso, head, armL, armR, legL, legR,
    hipY: HIP,
    dims: { torsoD: TORSO_D, torsoW: TORSO_W, shoulderX: SHOULDER_X, headW: HW, headH: HH, headD: HD, heightScale: L.heightScale },
    meshes: meshes.filter(Boolean),
    detailMesh,
    boxCount: torsoB.count() + headB.count() + detailB.count(),
  };
}

export const __sharedMaterial = (THREE) => sharedOf(THREE).material;

export default { buildParametricBody };
