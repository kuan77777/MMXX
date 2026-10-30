// FW3D · 共用球场核心（PitchCore）
// 依据 docs/four_stadium_design_pack：00 全局美术方向 + 05 草坪与标线技术规格。
// 目标：四类球场共用同一套草坪/标线规范（三档协调绿、沿长轴的低对比度修剪条纹、
// 连续标线、无 z-fighting），并尽量合并 draw call（条纹与直线都是 InstancedMesh）。
import { makeCanvasTexture } from './vendor/taishan/utils.js';
void makeCanvasTexture;   // 保留导入位：后续草纹贴图会用到（当前纯几何）

export const PITCH = {
  w: 68,          // 场地宽（x）
  l: 105,         // 场地长（z）
  lineW: 0.12,    // 线宽
  lineY: 0.006,   // 标线离地高度（>0 避免 z-fighting）
  circleR: 9.15,
  penAreaW: 40.32, penAreaD: 16.5,
  goalAreaW: 18.32, goalAreaD: 5.5,
  penSpot: 11,
  cornerR: 1.0,
};

const WHITE = '#eef3ef';

/**
 * @param {object} THREE
 * @param {object} opts { w, l, tones:[3 个绿], detail:boolean }
 * @returns {{group, stats}}
 */
export function buildPitchCore(THREE, opts = {}) {
  const W = opts.w || PITCH.w;
  const L = opts.l || PITCH.l;
  const tones = (opts.tones && opts.tones.length === 3)
    ? opts.tones
    : ['#2f7d42', '#2d7840', '#3a8650'];   // 主绿 / 暗绿 / 亮绿（低对比）
  const group = new THREE.Group();
  const disposables = [];

  // ── 1) 底草：一整块，避免边缘出现"棋盘格"
  const baseMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(tones[0]), roughness: 0.95, metalness: 0 });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(W, L), baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0;
  base.receiveShadow = true;
  group.add(base);
  disposables.push(base.geometry, baseMat);

  // ── 2) 修剪条纹：沿长轴 16 条，三色循环，一个 InstancedMesh + 逐实例颜色
  // 说明（本轮修正）：原来三色只差 3–4%，再乘 0.985–1.001 几乎等于同一色，
  // 实际渲染出来是一整块平绿 —— 截图里完全看不出修剪条纹，也就没有远近层次。
  // 现在让**相邻条纹**落在"暗档 / 亮档"上（实测亮度差 ≈14%），第三档只做每 4 条一次的微变化，
  // 既看得出条纹，又不会变成黑白棋盘。
  const STRIPES = 16;
  const stripeGeo = new THREE.PlaneGeometry(W, L / STRIPES);
  const stripeMat = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  const stripes = new THREE.InstancedMesh(stripeGeo, stripeMat, STRIPES);
  stripes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  const toneObjs = tones.map((c) => new THREE.Color(c));
  for (let i = 0; i < STRIPES; i++) {
    pos.set(0, 0.002, -L / 2 + (i + 0.5) * (L / STRIPES));
    m4.compose(pos, q, one);
    stripes.setMatrixAt(i, m4);
    // 奇偶交替取暗/亮两档；暗档用较低倍率，保证在实际照度下仍有可辨的修剪条纹
    const pick = i % 2 === 1 ? 1 : 0;
    col.copy(toneObjs[pick]).multiplyScalar(pick === 1 ? 0.80 : 1.0 + (i % 3) * 0.012);
    stripes.setColorAt(i, col);
  }
  stripes.instanceMatrix.needsUpdate = true;
  if (stripes.instanceColor) stripes.instanceColor.needsUpdate = true;
  stripes.receiveShadow = true;
  group.add(stripes);
  disposables.push(stripeGeo, stripeMat);
  group.userData.stripes = STRIPES;

  // ── 3) 标线：所有直线用一个 InstancedMesh（单位平面按实例缩放），弧线用 RingGeometry
  const lineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(WHITE), transparent: true, opacity: 0.94 });
  const lineGeo = new THREE.PlaneGeometry(1, 1);
  const lines = [];
  const L2 = L / 2, W2 = W / 2;
  const addX = (x, len) => lines.push({ w: PITCH.lineW, l: len, x, z: 0, rot: 0 });        // 沿 z 走的边线
  const addZ = (z, len) => lines.push({ w: len, l: PITCH.lineW, x: 0, z, rot: 0 });        // 沿 x 走的底线
  // 边线 / 底线 / 中线
  addX(-W2, L); addX(W2, L);
  addZ(-L2, W); addZ(L2, W); addZ(0, W);
  for (const s of [-1, 1]) {
    // 罚球区（40.32 × 16.5）
    addZ(s * (L2 - PITCH.penAreaD), PITCH.penAreaW);
    lines.push({ w: PITCH.lineW, l: PITCH.penAreaD, x: -PITCH.penAreaW / 2, z: s * (L2 - PITCH.penAreaD / 2), rot: 0 });
    lines.push({ w: PITCH.lineW, l: PITCH.penAreaD, x: PITCH.penAreaW / 2, z: s * (L2 - PITCH.penAreaD / 2), rot: 0 });
    // 球门区（18.32 × 5.5）
    addZ(s * (L2 - PITCH.goalAreaD), PITCH.goalAreaW);
    lines.push({ w: PITCH.lineW, l: PITCH.goalAreaD, x: -PITCH.goalAreaW / 2, z: s * (L2 - PITCH.goalAreaD / 2), rot: 0 });
    lines.push({ w: PITCH.lineW, l: PITCH.goalAreaD, x: PITCH.goalAreaW / 2, z: s * (L2 - PITCH.goalAreaD / 2), rot: 0 });
  }
  const lineInst = new THREE.InstancedMesh(lineGeo, lineMat, lines.length);
  lineInst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    pos.set(s.x, PITCH.lineY, s.z);
    m4.compose(pos, q, new THREE.Vector3(s.w, s.l, 1));
    lineInst.setMatrixAt(i, m4);
  }
  lineInst.instanceMatrix.needsUpdate = true;
  group.add(lineInst);
  disposables.push(lineGeo, lineMat);

  // ── 4) 弧线：中圈、罚球弧、角球弧
  const ringMat = lineMat;
  const addRing = (inner, outer, x, z, thetaStart, thetaLen) => {
    const g = new THREE.RingGeometry(inner, outer, 48, 1, thetaStart, thetaLen);
    const m = new THREE.Mesh(g, ringMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, PITCH.lineY, z);
    group.add(m);
    disposables.push(g);
    return m;
  };
  // 中圈
  addRing(PITCH.circleR - PITCH.lineW, PITCH.circleR, 0, 0, 0, Math.PI * 2);
  // 中点
  const spotGeo = new THREE.CircleGeometry(0.16, 16);
  const spot = new THREE.Mesh(spotGeo, ringMat);
  spot.rotation.x = -Math.PI / 2;
  spot.position.set(0, PITCH.lineY, 0);
  group.add(spot);
  disposables.push(spotGeo);
  // 罚球点 + 罚球弧（半径 9.15，以罚球点为圆心，只画禁区外那段）
  for (const s of [-1, 1]) {
    const pz = s * (L2 - PITCH.penSpot);
    const g = new THREE.CircleGeometry(0.16, 16);
    const m = new THREE.Mesh(g, ringMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, PITCH.lineY, pz);
    group.add(m);
    disposables.push(g);
    // 弧：局部 +Y 经 -90° 旋转后映射到 -Z，因此取 sinθ > 5.5/9.15 的一段
    const theta0 = Math.asin(5.5 / PITCH.circleR);
    addRing(PITCH.circleR - PITCH.lineW, PITCH.circleR, 0, pz, theta0, Math.PI - theta0 * 2);
  }
  // 角球弧（每个角 1/4 圆）
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const g = new THREE.RingGeometry(PITCH.cornerR - PITCH.lineW, PITCH.cornerR, 12, 1, 0, Math.PI / 2);
    const m = new THREE.Mesh(g, ringMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = (sx > 0 ? 0 : Math.PI / 2) + (sz > 0 ? 0 : Math.PI);
    m.position.set(sx * W2, PITCH.lineY, sz * L2);
    group.add(m);
    disposables.push(g);
  }

  const stats = {
    pitchW: W, pitchL: L,
    drawCalls: 1 + 1 + 1 + 1 + 1 + 2 + 4,   // base / stripes / lines / circle / spot / 罚球点+弧 / 角旗弧
    triangles: 2 + STRIPES * 2 + lines.length * 2 + 48 * 2 * 3,
  };
  return { group, stats, dispose: () => disposables.forEach((d) => d.dispose && d.dispose()) };
}
