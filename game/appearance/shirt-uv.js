// B′ 方案：不新建球衣网格，而是给模型**自带的球衣三角面**程序化生成 UV，然后贴中超图集。
//
// 为什么必须自己做 UV：实测这四套 Quaternius FBX 角色的几何体**没有任何 uv 属性**（uv=NONE），
// 所以"直接给 Shirt 材质换个贴图"是不可能的，没有坐标空间可贴。
//
// 做法：
//   1. 按材质名找到球衣那一段（Shirt / Dress / Torso / Cloth）；
//   2. 只统计这一段顶点的 Y 范围，得到球衣在身上的高度带；
//   3. 对全部顶点算圆柱 UV：u 由绕身体轴的角度决定（正面 0..0.5 → 图集 FRONT 区，背面 0.5..1 → BACK 区），
//      v 由在球衣高度带里的相对高度决定 —— 只影响球衣材质，皮肤/头发不贴图所以无副作用；
//   4. 给球衣材质换一张 MeshLambertMaterial + 图集贴图。
//
// 优点：贴合度 100%（就是模型自己的衣服），不需要处理骨骼绑定空间，不会出现"衣服飘在身体外"。

import { ATLAS_SLOTS } from './kit-atlas.js';

const D2R = Math.PI / 180;
const norm180 = (deg) => { let d = deg % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

/** 角度 + 相对高度 → 图集 UV（正面 0..0.5 落到 FRONT 区，背面 0.5..1 落到 BACK 区）。 */
export function uvForAngle(deg, vFrac) {
  const front = deg > -90 && deg < 90;
  const slot = front ? ATLAS_SLOTS.front : ATLAS_SLOTS.back;
  let u;
  if (front) u = (norm180(deg) + 90) / 180;
  else {
    let d = deg % 360;
    if (d < 0) d += 360;
    u = (d - 90) / 180;
  }
  return [
    slot.u0 + (slot.u1 - slot.u0) * Math.min(1, Math.max(0, u)),
    slot.v0 + (slot.v1 - slot.v0) * Math.min(1, Math.max(0, vFrac)),
  ];
}

const SHIRT_RE = /shirt|dress|torso|cloth|jersey|kit/i;

/**
 * 给模型的球衣材质换贴图（程序化生成 UV）。
 * @param {object} THREE
 * @param {object} model CharacterFactory.create() 的返回值
 * @param {HTMLCanvasElement} atlasCanvas kit-atlas.buildKitAtlas() 的产物
 * @returns {{ok:boolean, reason?:string, shirtIndex?:number, material?:object, texture?:object, stats?:object}}
 */
export function applyKitTexture(THREE, model, atlasCanvas) {
  if (!THREE || !model || !model.mesh || !model.mesh.geometry) return { ok: false, reason: 'no mesh' };
  const mesh = model.mesh;
  const geo = mesh.geometry;
  const mats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];
  // Quaternius 角色把球衣拆成两件：Shirt（主体）+ Shirt2（中间撞色片），
  // 只换第一件会留下一条没换的深色条（第一次验证就是这个现象），所以全部匹配。
  const shirtIndices = mats
    .map((m, i) => (m && SHIRT_RE.test(m.name || '') ? i : -1))
    .filter((i) => i >= 0);
  if (!shirtIndices.length) {
    return { ok: false, reason: `没找到球衣材质（现有：${mats.map((m) => m && m.name).join(',')}）` };
  }
  const shirtIndex = shirtIndices[0];
  const groups = geo.groups || [];
  const idx = geo.index;
  const pos = geo.getAttribute('position');
  if (!pos) return { ok: false, reason: 'no position' };

  // 1) 找出**所有球衣材质**用到的顶点与它们的 Y 范围
  const shirtVerts = new Set();
  for (const g of groups) {
    if (!shirtIndices.includes(g.materialIndex)) continue;
    for (let k = g.start; k < g.start + g.count; k += 1) {
      shirtVerts.add(idx ? idx.getX(k) : k);
    }
  }
  if (!shirtVerts.size) return { ok: false, reason: '球衣 group 为空' };
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const vi of shirtVerts) {
    const y = pos.getY(vi);
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    const x = pos.getX(vi), z = pos.getZ(vi);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const spanY = Math.max(1e-6, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // 2) 写 UV（圆柱投影）。非球衣顶点也一起写，但它们不贴图，无影响。
  //
  // 关键：不能用几何空间的 +Y 当作"上"。这套 FBX 的网格自带旋转（bindMatrix 里带 -90°X 之类），
  // 几何空间的"上"未必是 +Y —— 早期直接用 pos.getY() 算高度，结果号码被压成腰后一条细横条。
  // 正确做法：把世界空间的 上(0,1,0) / 前(0,0,1) 用网格矩阵的逆变换回几何空间，再投影。
  const m3 = new THREE.Matrix3().setFromMatrix4(mesh.matrix).invert();
  const up = new THREE.Vector3(0, 1, 0).applyMatrix3(m3).normalize();
  const fwd = new THREE.Vector3(0, 0, 1).applyMatrix3(m3).normalize();
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);

  // 用球衣顶点的质心作为圆柱轴心
  let cxm = 0, cym = 0, czm = 0;
  for (const vi of shirtVerts) {
    cxm += pos.getX(vi); cym += pos.getY(vi); czm += pos.getZ(vi);
  }
  const inv = 1 / shirtVerts.size;
  const center = new THREE.Vector3(cxm * inv, cym * inv, czm * inv);

  // 沿"真实上方向"统计球衣的高度范围
  const p = new THREE.Vector3();
  let hMin = Infinity;
  let hMax = -Infinity;
  for (const vi of shirtVerts) {
    p.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).sub(center);
    const h = p.dot(up);
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  const hSpan = Math.max(1e-6, hMax - hMin);

  const uvArr = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(center);
    const h = p.dot(up);                                   // 沿"上"方向的高度
    const vFrac = (h - hMin) / hSpan;
    const deg = Math.atan2(p.dot(right), p.dot(fwd)) / D2R; // 0 = 正面
    const [u, v] = uvForAngle(deg, vFrac);
    uvArr[i * 2] = u;
    uvArr[i * 2 + 1] = v;
  }
  const uvAttr = new THREE.Float32BufferAttribute(uvArr, 2);
  geo.setAttribute('uv', uvAttr);

  // 3) 换材质（所有球衣材质共用一个 kit 材质实例）
  let tex = null;
  if (atlasCanvas) {
    tex = new THREE.CanvasTexture(atlasCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
  }
  const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
  mat.name = `kit:${mats[shirtIndex].name}`;
  for (const i of shirtIndices) mats[i] = mat;
  mesh.material = mats;
  geo.needsUpdate = true;

  return {
    ok: true,
    shirtIndex,
    shirtIndices,
    material: mat,
    texture: tex,
    stats: {
      shirtMaterials: shirtIndices.map((i) => (mats[i] && mats[i].name) || ''),
      shirtVerts: shirtVerts.size,
      shirtYRange: [+minY.toFixed(3), +maxY.toFixed(3)],
      totalVerts: pos.count,
      hasMap: !!tex,
    },
  };
}

export default { applyKitTexture, uvForAngle };
