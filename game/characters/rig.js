// 程序化低多边形人体：**真骨骼**（THREE.Bone 层级 + THREE.Skeleton + SkinnedMesh），
// 不是把静态模型生硬平移。每个部件刚性绑定到唯一骨骼（skinWeight = 1），
// 因此是"骨骼驱动的硬边低多边形"，符合 Unturned 一路的美术语言，也不会有蒙皮权重穿模问题。
//
// 全部部件合并进 **一个** SkinnedMesh：一次 draw call / 角色。
// 颜色用顶点色；球衣图案用一张 256×256 canvas 图集（见 appearance/kit.js），
// 非球衣部件 UV 落在图集的纯白区，于是"顶点色 × 白"= 顶点色。
//
// 这个模块只依赖 three，不依赖游戏其余部分，方便单独测试骨骼/动画。

import { makeKit, KIT_UV } from '../appearance/kit.js';

// 骨骼顺序固定：动画、GLB 重定向、外部工具都按名字找骨骼。
export const BONE_ORDER = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'lowerArmL', 'handL',
  'shoulderR', 'upperArmR', 'lowerArmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
];

// 静止姿态（T 姿态的手臂改成自然下垂）：单位米，父骨骼局部坐标。
// 站立总高约 1.70m（脚底 ~y=0），再按 appearance.height 整体缩放。
const REST = {
  hips: [0, 0.98, 0],
  spine: [0, 0.10, 0],
  chest: [0, 0.20, 0],
  neck: [0, 0.20, 0],
  head: [0, 0.10, 0],
  shoulderL: [0.055, 0.145, 0],
  upperArmL: [0.115, 0, 0],
  lowerArmL: [0, -0.27, 0],
  handL: [0, -0.25, 0],
  shoulderR: [-0.055, 0.145, 0],
  upperArmR: [-0.115, 0, 0],
  lowerArmR: [0, -0.27, 0],
  handR: [0, -0.25, 0],
  thighL: [0.095, -0.06, 0],
  shinL: [0, -0.43, 0],
  footL: [0, -0.41, 0],
  thighR: [-0.095, -0.06, 0],
  shinR: [0, -0.43, 0],
  footR: [0, -0.41, 0],
};

const DEG = Math.PI / 180;

/** 外观 → 体格乘数。appearanceFor() 的 body 字段是 0.9~1.1 的比例，这里夹紧到安全范围。 */
function proportions(appearance) {
  const b = (appearance && appearance.body) || {};
  const f = (v, d) => (Number.isFinite(Number(v)) ? Math.min(1.4, Math.max(0.62, Number(v))) : d);
  return {
    scale: Math.min(1.16, Math.max(0.9, (Number(appearance && appearance.height) || 172) / 172)),
    shoulder: f(b.shoulderWidth, 1),
    chest: f(b.chestDepth, 1),
    waist: f(b.waist, 1),
    hip: f(b.hipWidth, 1),
    thigh: f(b.thigh, 1),
    calf: f(b.calf, 1),
    arm: f(b.armLength, 1),
    leg: f(b.legProportion, 1),
    neck: f(b.neck, 1),
    muscle: Math.min(1.3, Math.max(0.75, Number(b.muscle) || 1)),
  };
}

function hexColor(THREE, hex, fallback) {
  const n = Number(hex);
  const c = new THREE.Color(Number.isFinite(n) ? n : fallback);
  return c;
}

/** 一个 8 参数的 UV 矩形，带内缩，避免采样到相邻区域。 */
function uvRect(rect, inset = 0.004) {
  return {
    u0: rect.u0 + inset, u1: rect.u1 - inset,
    v0: rect.v0 + inset, v1: rect.v1 - inset,
  };
}

const UV_PATTERN = uvRect(KIT_UV.pattern, 0.002);
const UV_WHITE = uvRect(KIT_UV.white, 0.01);
const UV_BACK = uvRect(KIT_UV.back, 0.0);

class GeoBuilder {
  constructor(THREE, boneMatrices) {
    this.THREE = THREE;
    // 每根骨骼在**静止姿态**下的世界矩阵。几何是按"骨骼局部坐标"写的（例如躯干在 chest 的
    // 原点附近 0.045 处），蒙皮却要求顶点在 bind 空间（即静止姿态的模型空间）。
    // 所以必须在这里把每个部件用所属骨骼的静止世界矩阵烘焙到模型空间 —— 少这一步，
    // 所有部件都会堆在原点，角色变成脚边的一团方块（浏览器截图里就是这个现象）。
    this.boneMats = boneMatrices || null;
    this.position = [];
    this.normal = [];
    this.uv = [];
    this.color = [];
    this.skinIndex = [];
    this.skinWeight = [];
    this.count = 0;
    this._m = new THREE.Matrix4();
    this._nm = new THREE.Matrix3();
    this._v = new THREE.Vector3();
  }

  /**
   * @param {THREE.BufferGeometry} geom 源几何（会被 toNonIndexed 并释放）
   * @param {number[]} skin 四元组 [boneIdx,0,0,0]
   * @param {THREE.Color} color
   * @param {'fill'|'flat'|'rect'} uvMode fill=把 0..1 映射进 rect；flat=整块用 rect 中心
   * @param {object} rect uv 矩形
   */
  add(geom, skin, color, uvMode, rect) {
    const THREE = this.THREE;
    const g = geom.index ? geom.toNonIndexed() : geom;
    if (g !== geom) geom.dispose();
    // 骨骼局部坐标 → 模型（bind）空间
    const bm = this.boneMats ? this.boneMats[skin[0]] : null;
    if (bm) g.applyMatrix4(bm);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uvs = g.getAttribute('uv');
    const cu = (rect.u0 + rect.u1) * 0.5;
    const cv = (rect.v0 + rect.v1) * 0.5;
    for (let i = 0; i < pos.count; i += 1) {
      this.position.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nor) this.normal.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      else this.normal.push(0, 1, 0);
      if (uvMode === 'fill' && uvs) {
        const u = uvs.getX(i);
        const v = uvs.getY(i);
        // 注意：贴图 flipY，BoxGeometry 的 uv v 已按面正确朝上，这里直接线性映射
        this.uv.push(rect.u0 + (rect.u1 - rect.u0) * u, rect.v0 + (rect.v1 - rect.v0) * v);
      } else {
        this.uv.push(cu, cv);
      }
      this.color.push(color.r, color.g, color.b);
      this.skinIndex.push(skin[0], 0, 0, 0);
      this.skinWeight.push(1, 0, 0, 0);
      this.count += 1;
    }
    g.dispose();
  }

  box(boneIdx, color, uvMode, rect, { w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 }) {
    const THREE = this.THREE;
    const g = new THREE.BoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d));
    if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
    if (x || y || z) g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z));
    this.add(g, [boneIdx, 0, 0, 0], color, uvMode, rect);
  }

  quad(boneIdx, color, rect, { w, h, x = 0, y = 0, z = 0, ry = 0 }) {
    const THREE = this.THREE;
    const g = new THREE.PlaneGeometry(w, h);
    if (ry) g.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
    if (x || y || z) g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z));
    this.add(g, [boneIdx, 0, 0, 0], color, 'fill', rect);
  }

  build() {
    const THREE = this.THREE;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinWeight, 4));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * 构造一个带骨骼的人物。
 * @param {THREE} THREE
 * @param {object} opts { appearance, kit, zombie, materialFactory }
 * @returns {{group: THREE.Group, mesh: THREE.SkinnedMesh, skeleton: THREE.Skeleton, bones: object, boneList: THREE.Bone[], kit: object, boneIndexOf: (name:string)=>number, dispose: Function}}
 */
export function buildHumanoid(THREE, opts = {}) {
  const app = opts.appearance || {};
  const P = proportions(app);
  const kit = opts.kit || makeKit({ playerId: app.playerId });
  const isZombie = !!opts.zombie;

  const skinColor = hexColor(THREE, app.skin_tone, 0xc9a27b);
  const hairColor = hexColor(THREE, app.hair_color, 0x20180f);
  // 僵尸：皮肤偏灰绿、衣服脏化 —— 但保留球衣底色，这样"谁被感染了"仍然可辨认
  const grey = new THREE.Color(0x7d8b74);
  const zombieSkin = skinColor.clone().lerp(grey, 0.55);
  const bodySkin = isZombie ? zombieSkin : skinColor;
  const shirtWhite = new THREE.Color(0xffffff);
  const shortsColor = new THREE.Color(kit.shorts);
  const socksColor = new THREE.Color(kit.socks);
  const bootsColor = new THREE.Color(0x1b1b1f);
  const eyeColor = new THREE.Color(isZombie ? 0xd94a4a : 0x14161a);

  // ── 骨骼
  const boneList = [];
  const bones = {};
  for (const name of BONE_ORDER) {
    const b = new THREE.Bone();
    b.name = name;
    const r = REST[name];
    b.position.set(r[0], r[1], r[2]);
    bones[name] = b;
    boneList.push(b);
  }
  const parentOf = {
    spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
    shoulderL: 'chest', upperArmL: 'shoulderL', lowerArmL: 'upperArmL', handL: 'lowerArmL',
    shoulderR: 'chest', upperArmR: 'shoulderR', lowerArmR: 'upperArmR', handR: 'lowerArmR',
    thighL: 'hips', shinL: 'thighL', footL: 'shinL',
    thighR: 'hips', shinR: 'thighR', footR: 'shinR',
  };
  for (const [child, parent] of Object.entries(parentOf)) {
    bones[parent].add(bones[child]);
  }

  // 体格 → 骨骼静止位微调（肩宽/腿长/臂长）
  const legK = P.leg;
  const armK = P.arm;
  bones.shoulderL.position.x = 0.055 * P.shoulder;
  bones.shoulderR.position.x = -0.055 * P.shoulder;
  bones.upperArmL.position.x = 0.115 * P.shoulder;
  bones.upperArmR.position.x = -0.115 * P.shoulder;
  bones.lowerArmL.position.y = -0.27 * armK;
  bones.lowerArmR.position.y = -0.27 * armK;
  bones.handL.position.y = -0.25 * armK;
  bones.handR.position.y = -0.25 * armK;
  bones.thighL.position.y = -0.06 * legK;
  bones.thighR.position.y = -0.06 * legK;
  bones.shinL.position.y = -0.43 * legK;
  bones.shinR.position.y = -0.43 * legK;
  // 腿长变化时脚必须仍然落在 y≈0（否则角色会浮空/陷地）
  const legDelta = (bones.thighL.position.y + 0.06) + (bones.shinL.position.y + 0.43);
  bones.footL.position.y = -0.41 * legK - legDelta * 0;
  bones.footR.position.y = -0.41 * legK;

  const idx = (name) => BONE_ORDER.indexOf(name);

  // 先算一次静止姿态下每根骨骼的世界矩阵，供几何烘焙使用
  bones.hips.updateMatrixWorld(true);
  const restWorld = BONE_ORDER.map((n) => bones[n].matrixWorld.clone());

  const G = new GeoBuilder(THREE, restWorld);

  const bw = P.muscle; // 粗壮度

  // ── 骨盆 / 短裤
  G.box(idx('hips'), shortsColor, 'flat', UV_WHITE,
    { w: 0.30 * P.hip * bw, h: 0.20, d: 0.20 * P.chest, y: -0.02 });
  // ── 腰 / 上衣下摆
  G.box(idx('spine'), shirtWhite, 'fill', UV_PATTERN,
    { w: 0.32 * P.waist * bw, h: 0.19, d: 0.21 * P.chest, y: 0.01 });
  // ── 胸 / 上衣
  G.box(idx('chest'), shirtWhite, 'fill', UV_PATTERN,
    { w: 0.38 * P.shoulder * bw, h: 0.27, d: 0.23 * P.chest, y: 0.045 });
  // 肩部圆角块：低多边形里"一根斜切"能显著改善轮廓
  G.box(idx('chest'), shirtWhite, 'fill', UV_PATTERN,
    { w: 0.15 * P.shoulder, h: 0.10, d: 0.21 * P.chest, x: 0.16 * P.shoulder, y: 0.165, rz: -18 * DEG });
  G.box(idx('chest'), shirtWhite, 'fill', UV_PATTERN,
    { w: 0.15 * P.shoulder, h: 0.10, d: 0.21 * P.chest, x: -0.16 * P.shoulder, y: 0.165, rz: 18 * DEG });

  // 背号面板（贴在胸前骨骼的背面），UV 指到图集背号区
  G.quad(idx('chest'), shirtWhite, UV_BACK,
    { w: 0.30 * P.shoulder, h: 0.22, z: -(0.23 * P.chest) / 2 - 0.004, ry: Math.PI });

  // ── 脖子 / 头 / 头发 / 眼睛
  G.box(idx('neck'), bodySkin, 'flat', UV_WHITE, { w: 0.10 * P.neck, h: 0.09, d: 0.10 * P.neck, y: 0.01 });
  const headW = 0.19, headH = 0.23, headD = 0.21;
  G.box(idx('head'), bodySkin, 'flat', UV_WHITE, { w: headW, h: headH, d: headD, y: 0.055 });
  // 下颌稍窄
  G.box(idx('head'), bodySkin, 'flat', UV_WHITE, { w: headW * 0.86, h: 0.05, d: headD * 0.92, y: -0.065 });
  const hairStyle = app.hair_style || 'short';
  const bald = hairStyle === 'bald';
  if (!bald) {
    const longHair = hairStyle === 'long' || hairStyle === 'bun' || hairStyle === 'ponytail' || hairStyle === 'afro' || hairStyle === 'curly';
    const capH = hairStyle === 'afro' ? 0.13 : 0.075;
    G.box(idx('head'), hairColor, 'flat', UV_WHITE,
      { w: headW * (hairStyle === 'afro' ? 1.18 : 1.04), h: capH, d: headD * (hairStyle === 'afro' ? 1.18 : 1.03), y: 0.055 + headH * 0.5 - capH * 0.35 });
    if (longHair) {
      G.box(idx('head'), hairColor, 'flat', UV_WHITE,
        { w: headW * 1.02, h: 0.14, d: 0.06, y: 0.0, z: -headD * 0.5 });
    }
    if (hairStyle === 'mohawk') {
      G.box(idx('head'), hairColor, 'flat', UV_WHITE, { w: 0.05, h: 0.06, d: headD * 0.95, y: 0.055 + headH * 0.5 + 0.01 });
    }
  }
  // 眼睛（两个很小的深色块，低多边形里足以表达朝向）
  G.box(idx('head'), eyeColor, 'flat', UV_WHITE, { w: 0.032, h: 0.022, d: 0.012, x: 0.045, y: 0.075, z: headD * 0.5 + 0.002 });
  G.box(idx('head'), eyeColor, 'flat', UV_WHITE, { w: 0.032, h: 0.022, d: 0.012, x: -0.045, y: 0.075, z: headD * 0.5 + 0.002 });

  // ── 手臂：上臂（衣袖 + 皮肤）、前臂、手
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const shoulder = `upperArm${side}`;
    const lower = `lowerArm${side}`;
    const hand = `hand${side}`;
    // 衣袖（球衣图案）
    G.box(idx(shoulder), shirtWhite, 'fill', UV_PATTERN,
      { w: 0.105 * bw, h: 0.13, d: 0.115 * bw, y: 0.065 });
    // 上臂皮肤
    G.box(idx(shoulder), bodySkin, 'flat', UV_WHITE,
      { w: 0.082 * bw, h: 0.15, d: 0.09 * bw, y: -0.085 });
    // 前臂
    G.box(idx(lower), bodySkin, 'flat', UV_WHITE,
      { w: 0.072 * bw, h: 0.235 * armK, d: 0.078 * bw, y: -0.11 });
    // 手（拳头形状，略宽，方便之后挂武器）
    G.box(idx(hand), bodySkin, 'flat', UV_WHITE,
      { w: 0.085, h: 0.10, d: 0.075, y: -0.045 });

    // ── 腿：大腿（短裤）、小腿（球袜）、球鞋
    const thigh = `thigh${side}`;
    const shin = `shin${side}`;
    const foot = `foot${side}`;
    G.box(idx(thigh), shortsColor, 'flat', UV_WHITE,
      { w: 0.145 * P.thigh * bw, h: 0.19, d: 0.155 * P.thigh, y: -0.09 });
    G.box(idx(thigh), bodySkin, 'flat', UV_WHITE,
      { w: 0.128 * P.thigh * bw, h: 0.24 * legK, d: 0.135 * P.thigh, y: -0.30 * legK });
    G.box(idx(shin), bodySkin, 'flat', UV_WHITE,
      { w: 0.105 * P.calf * bw, h: 0.15 * legK, d: 0.11 * P.calf, y: -0.10 * legK });
    G.box(idx(shin), socksColor, 'flat', UV_WHITE,
      { w: 0.108 * P.calf * bw, h: 0.255 * legK, d: 0.112 * P.calf, y: -0.30 * legK });
    G.box(idx(foot), bootsColor, 'flat', UV_WHITE,
      { w: 0.105, h: 0.075, d: 0.235, y: -0.045, z: 0.028 });
    void sx;
  }

  const geometry = G.build();

  // ── 材质：每个 kit 一份（缓存在外部），这里允许注入工厂以便共享
  const material = opts.material
    ? opts.material
    : (opts.materialFactory
      ? opts.materialFactory(kit, THREE)
      : new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }));

  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  // 骨骼动画会改变包围球，交给距离剔除自己管，避免角色在屏幕边缘突然消失
  mesh.frustumCulled = false;
  mesh.name = 'humanoid';

  // Skeleton 需要最新的 matrixWorld 才能算 boneInverses
  // 注意：此时骨骼尚未挂到 mesh 上，boneInverses 就是"静止姿态的世界矩阵的逆"，
  // 与烘焙几何用的 restWorld 严格互逆，所以静止姿态下 boneMatrix = I（顶点不动）。
  bones.hips.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);
  mesh.add(bones.hips);
  // 显式传单位 bindMatrix：几何已经在模型空间，绑定空间 == 模型空间。
  mesh.bind(skeleton, new THREE.Matrix4());

  const group = new THREE.Group();
  group.name = 'humanoidRoot';
  group.add(mesh);
  group.scale.setScalar(P.scale);
  // 眼高（米）供第一人称/瞄准使用
  const eyeHeight = 1.62 * P.scale;

  return {
    group,
    mesh,
    skeleton,
    bones,
    boneList,
    kit,
    eyeHeight,
    boneIndexOf: idx,
    dispose() {
      geometry.dispose();
      // 材质/贴图由材质缓存统一释放，这里不动。
    },
  };
}

export default { buildHumanoid, BONE_ORDER };
