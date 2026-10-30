// 四季感染者"外形"：调色板 + 程序化骨挂件。
//
// 为什么不用新模型：角色包只发了 1 个僵尸 FBX（无贴图），四季差异只能靠
//   ① 按身体部位换调色板（顶点色，见 characters/fbx.js 的 applyZombieSkin）；
//   ② 在骨骼上挂低模小件（孢子囊 / 菌伞 / 腐叶 / 冰壳）做剪影差异；
//   ③ 每个变种模板用不同的 targetHeight（命中盒与眼高会自动跟着模板走）。
// 挂件全部用顶点色合并成"每根骨骼 1 个 mesh"，算上 30% 的变种占比，额外 draw call 很少。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** 调色板：字段与 fbx.js 的 applyZombieSkin 一一对应（sRGB 写法，写进顶点色时由 THREE.Color 转线性）。 */
export const ZOMBIE_PALETTES = {
  base: {
    head: 0x9dab86, skin: 0x94a27e, shirt: 0x655c4a, pants: 0x3d434a, boots: 0x24262b,
    blood: 0x5f241f, green: 0x6f7d5c,
  },
  spring: {
    head: 0xa9bd8a, skin: 0x9fb583, shirt: 0x5f6b45, pants: 0x3e4a3a, boots: 0x2a2f2a,
    blood: 0x5a2a22, green: 0x7f9a5c,
  },
  summer: {
    head: 0xc08a63, skin: 0xb57c55, shirt: 0x7a5a42, pants: 0x4a4240, boots: 0x2b2624,
    blood: 0x6a2b1f, green: 0x8a7a55,
  },
  autumn: {
    head: 0xa88a5e, skin: 0x9c7f55, shirt: 0x6b4a32, pants: 0x3f3a2f, boots: 0x2a2620,
    blood: 0x5e2a1c, green: 0x7a6a42,
  },
  winter: {
    head: 0xb9c9d6, skin: 0xaebfcc, shirt: 0x4a5560, pants: 0x39424c, boots: 0x22282e,
    blood: 0x4a2a30, green: 0x6b7d86,
  },
};

export function paletteFor(name) {
  return ZOMBIE_PALETTES[name] || ZOMBIE_PALETTES.base;
}

/** 挂件种类（对应 manifest 里的 accessories 字段）。 */
export const ACCESSORY_KINDS = ['spores', 'mushroom', 'ice'];

/** 能找到"胸/头/左右上臂"的骨骼名匹配（僵尸是 Mixamo 命名）。 */
const BONE_MATCHERS = {
  chest: [/^spine2$/i, /^spine_?0?2$/i, /^chest$/i, /spine1/i],
  head: [/^head$/i, /head/i],
  armL: [/^leftarm$/i, /leftarm/i, /upper_?arm_?l/i],
  armR: [/^rightarm$/i, /rightarm/i, /upper_?arm_?r/i],
};

function findBone(root, key) {
  const matchers = BONE_MATCHERS[key] || [];
  for (const re of matchers) {
    let found = null;
    root.traverse((o) => { if (!found && o.isBone && re.test(o.name)) found = o; });
    if (found) return found;
  }
  return null;
}

/** 给几何体刷一层常量顶点色（合并不同颜色的小件时用）。 */
function paint(THREE, geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * 变种挂件定义（尺寸单位 = 米；offset 是相对骨骼原点的**世界方向**偏移，单位米）。
 * 之所以用"世界方向偏移"：不同骨架的骨骼局部轴不一样，用世界方向更好摆；
 * 挂到骨骼上时会自动换算成局部坐标（见 attachParts）。
 */
const ACCESSORY_SPECS = {
  spores: {
    bone: 'chest',
    emissive: 0x1f2a08,
    parts: [
      { geo: ['ico', 0.055], off: [-0.10, 0.10, -0.10], color: 0xcfe08a },
      { geo: ['ico', 0.055], off: [0.10, 0.10, -0.10], color: 0xcfe08a },
      { geo: ['ico', 0.045], off: [-0.05, 0.19, -0.13], color: 0xbfd46f },
      { geo: ['ico', 0.045], off: [0.05, 0.19, -0.13], color: 0xbfd46f },
    ],
  },
  mushroom: {
    bone: 'head',
    emissive: 0x000000,
    parts: [
      { geo: ['cyl', 0.024, 0.032, 0.11, 6], off: [0, 0.20, -0.01], color: 0xd8cdb4 },
      { geo: ['hemi', 0.17, 10, 5], off: [0, 0.27, -0.01], scale: [1, 0.55, 1], color: 0xc9552e },
      { geo: ['ico', 0.016], off: [0.06, 0.30, 0.06], color: 0xf0e6d2 },
      { geo: ['ico', 0.014], off: [-0.05, 0.31, -0.02], color: 0xf0e6d2 },
      { geo: ['ico', 0.013], off: [0.02, 0.29, -0.08], color: 0xf0e6d2 },
    ],
  },
  ice: {
    bone: 'chest',
    emissive: 0x0e2a3c,
    parts: [
      { geo: ['cone', 0.07, 0.26, 5], off: [-0.16, 0.16, -0.06], rot: [0.1, 0, 0.55], color: 0xbfe6ff },
      { geo: ['cone', 0.06, 0.22, 5], off: [0.16, 0.18, -0.04], rot: [0.1, 0, -0.5], color: 0xbfe6ff },
      { geo: ['cone', 0.08, 0.30, 5], off: [0, 0.02, -0.14], rot: [-0.45, 0, 0], color: 0xa9d8f2 },
    ],
    extra: [
      { bone: 'armL', name: 'acc_ice_1', emissive: 0x0e2a3c, parts: [
        { geo: ['cone', 0.05, 0.18, 5], off: [0, -0.16, -0.02], rot: [0.2, 0, 0.25], color: 0xbfe6ff },
      ] },
      { bone: 'armR', name: 'acc_ice_2', emissive: 0x0e2a3c, parts: [
        { geo: ['cone', 0.05, 0.18, 5], off: [0, -0.16, -0.02], rot: [0.2, 0, -0.25], color: 0xbfe6ff },
      ] },
    ],
  },
};

function makeGeometry(THREE, spec) {
  const [kind, a, b, c, d] = spec;
  switch (kind) {
    case 'ico': return new THREE.IcosahedronGeometry(a, 0);
    case 'cyl': return new THREE.CylinderGeometry(a, b, c, d);
    case 'hemi': return new THREE.SphereGeometry(a, b, c, 0, Math.PI * 2, 0, Math.PI / 2);
    case 'cone': return new THREE.ConeGeometry(a, b, c);
    default: return new THREE.IcosahedronGeometry(0.03, 0);
  }
}

/**
 * 把一组小件合并成 1 个 mesh 挂到骨骼上。
 * @param {object} THREE
 * @param {THREE.Object3D} root 角色根（模板，未缩放）
 * @param {THREE.Bone} bone
 * @param {Array} parts 见 ACCESSORY_SPECS
 * @param {number} unit 1 米 = 多少模板单位（= 1/scale）
 * @param {object} opts { name, emissive }
 */
function attachParts(THREE, root, bone, parts, unit, opts = {}) {
  if (!bone) return null;
  root.updateMatrixWorld(true);
  const inv = bone.matrixWorld.clone().invert();
  const boneWorld = new THREE.Vector3();
  bone.getWorldPosition(boneWorld);
  const geos = [];
  for (const p of parts) {
    const geo = makeGeometry(THREE, p.geo);
    if (p.scale) geo.scale(p.scale[0], p.scale[1], p.scale[2]);
    paint(THREE, geo, p.color);
    const rot = p.rot || [0, 0, 0];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const pos = new THREE.Vector3(
      boneWorld.x + (p.off ? p.off[0] : 0) * unit,
      boneWorld.y + (p.off ? p.off[1] : 0) * unit,
      boneWorld.z + (p.off ? p.off[2] : 0) * unit,
    );
    const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(unit, unit, unit));
    geo.applyMatrix4(inv.clone().multiply(m));
    geos.push(geo);
  }
  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (!merged) return null;
  for (const g of geos) if (g !== merged) g.dispose();
  merged.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    emissive: opts.emissive || 0x000000,
    emissiveIntensity: 1,
  });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = opts.name || 'acc';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  bone.add(mesh);
  return mesh;
}

/**
 * 给一个（未缩放的）角色模板挂上变种小件。
 * @returns {{meshes:Array, names:string[]}|null}
 */
export function buildZombieAccessories(THREE, root, kind, opts = {}) {
  const spec = ACCESSORY_SPECS[kind];
  if (!spec) return null;
  const unit = Number.isFinite(opts.unit) && opts.unit > 0 ? opts.unit : 1;
  const meshes = [];
  const main = attachParts(THREE, root, findBone(root, spec.bone), spec.parts, unit, {
    name: `acc_${kind}`, emissive: spec.emissive,
  });
  if (main) meshes.push(main);
  for (const extra of spec.extra || []) {
    const m = attachParts(THREE, root, findBone(root, extra.bone), extra.parts, unit, {
      name: extra.name, emissive: extra.emissive,
    });
    if (m) meshes.push(m);
  }
  return { meshes, names: meshes.map((m) => m.name) };
}

export default { ZOMBIE_PALETTES, paletteFor, ACCESSORY_KINDS, buildZombieAccessories };
