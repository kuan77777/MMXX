// 世界视觉构建：把 layout 的纯数据 blueprint 变成 three.js 场景。
// 性能策略：
//   · 全部静态几何（墙/地板/屋顶/家具）合并成 **一个** 带顶点色的 mesh → 1 次 draw call；
//   · 道路用 Quaternius Modular Streets，每类模块一个 InstancedMesh（6 次 draw call 铺满整张图）；
//   · 树用 InstancedMesh（每个季节一套几何，按具体模型分桶；见 buildTreeInstances）；
//   · 地面单独一个 mesh（换季只改材质颜色）；
//   · 只有真正需要动画/交互的东西（门、容器、车、拾取物）才是独立对象。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { planStreets, STREET_MODULES, lampHeads } from './roads.js';
import { CAR_TYPE_BY_ID, CAR_MODEL_BY_KIND } from './cars.js';
import { Inventory, lootForContainer } from '../items/items.js';
import { buildingGeometry, sideWindows } from './building-mesh.js';
import { DEFAULT_SEASON, treeSeasonKey, pickTreeModel, treeSpeciesOf, cnSpecies } from './trees.js';
import { seasonEnv } from './season.js';
import { forestTrees, mulberry32 } from './terrain.js';
import { buildRoadNet } from './road-net.js';

const PALETTE = {
  grass: 0x4a6b46,
  grassDark: 0x3d5a3b,
  asphalt: 0x3a3d42,
  sidewalk: 0x6b6f73,
  concrete: 0x8a8578,
  brick: 0x8c5a4a,
  metal: 0x6e7a80,
  wood: 0x7a5c42,
  roofDark: 0x3f4449,
  roofRed: 0x6b3f35,
  roofGrey: 0x4a4e57,
  floor: 0x6a6455,
  trunk: 0x4a3a2c,
  leafPine: 0x2f5a3a,
  leafBroad: 0x3f6b40,
  crate: 0x8a6a42,
  barrel: 0x5a6b52,
  metalBox: 0x7a8288,
};

const DISTRICT_STYLE = {
  residential: { wall: PALETTE.brick, roof: PALETTE.roofRed },
  commercial: { wall: PALETTE.concrete, roof: PALETTE.roofGrey },
  industrial: { wall: PALETTE.metal, roof: PALETTE.roofDark },
  park: { wall: PALETTE.wood, roof: PALETTE.roofDark },
  plaza: { wall: PALETTE.concrete, roof: PALETTE.roofGrey },
};

class Batcher {
  constructor(THREE) {
    this.THREE = THREE;
    this.parts = [];
    this._colorCache = new Map();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3(1, 1, 1);
    this._p = new THREE.Vector3();
  }

  _color(hex) {
    let c = this._colorCache.get(hex);
    if (!c) { c = new this.THREE.Color(hex); this._colorCache.set(hex, c); }
    return c;
  }

  /** 以中心点 + 尺寸加一个盒子。rotY 只支持绕 Y 旋转（低多边形城镇够用）。 */
  box(w, h, d, x, y, z, hex, rotY = 0) {
    const THREE = this.THREE;
    const g = new THREE.BoxGeometry(Math.max(0.02, w), Math.max(0.02, h), Math.max(0.02, d));
    if (rotY) {
      this._e.set(0, rotY, 0);
      this._q.setFromEuler(this._e);
      this._m.compose(this._p.set(x, y, z), this._q, this._v);
    } else {
      this._m.makeTranslation(x, y, z);
    }
    g.applyMatrix4(this._m);
    return this.addGeometry(g, hex);
  }

  /** 水平面（地面/地板/屋顶）。 */
  plane(w, d, x, y, z, hex) {
    const THREE = this.THREE;
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    return this.addGeometry(g, hex);
  }

  addGeometry(g, hex) {
    const THREE = this.THREE;
    const col = this._color(hex);
    const count = g.getAttribute('position').count;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    // 统一属性集合，mergeGeometries 才不会报错
    if (!g.getAttribute('uv')) {
      const uv = new Float32Array(count * 2);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (g.index) {
      // 保持 indexed，merge 更省内存
    }
    this.parts.push(g);
    return g;
  }

  /** 直接收一段**已经带顶点色**的几何（建筑模型：颜色是调色板烘焙出来的）。 */
  addColoredGeometry(g) {
    const THREE = this.THREE;
    const count = g.getAttribute('position').count;
    if (!g.getAttribute('color')) {
      const arr = new Float32Array(count * 3);
      arr.fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    this.parts.push(g);
    return g;
  }

  /** 合并成一个几何（不建 Mesh：建筑要把同一份几何用 FrontSide/BackSide 各画一遍）。 */
  buildGeometry() {
    if (!this.parts.length) return null;
    // mergeGeometries 要求 indexed/非 indexed 一致，这里统一转成非 indexed 更稳
    const list = this.parts.map((g) => (g.index ? g.toNonIndexed() : g));
    for (let i = 0; i < this.parts.length; i += 1) {
      if (list[i] !== this.parts[i]) this.parts[i].dispose();
    }
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    this.parts.length = 0;
    return merged;
  }

  build(material) {
    const THREE = this.THREE;
    const merged = this.buildGeometry();
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'staticWorld';
    return mesh;
  }
}

function treeGeometry(THREE, kind) {
  const parts = [];
  const add = (g, hex) => {
    const col = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const trunk = new THREE.CylinderGeometry(0.16, 0.22, 2.2, 5);
  trunk.translate(0, 1.1, 0);
  add(trunk, PALETTE.trunk);
  if (kind === 'pine') {
    for (let i = 0; i < 3; i += 1) {
      const cone = new THREE.ConeGeometry(1.5 - i * 0.35, 1.9, 6);
      cone.translate(0, 2.3 + i * 1.05, 0);
      add(cone, i % 2 ? PALETTE.leafPine : PALETTE.leafBroad);
    }
  } else {
    const s = new THREE.IcosahedronGeometry(1.55, 0);
    s.translate(0, 3.1, 0);
    add(s, PALETTE.leafBroad);
    const s2 = new THREE.IcosahedronGeometry(1.1, 0);
    s2.translate(0.7, 2.4, 0.4);
    add(s2, PALETTE.leafPine);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}

function carMesh(THREE, kind, color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.62, 4.1),
    new THREE.MeshLambertMaterial({ color, flatShading: true }),
  );
  body.position.y = 0.66;
  body.castShadow = true;
  g.add(body);
  const cabinH = kind === 'van' ? 0.95 : 0.66;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.66, cabinH, kind === 'van' ? 3.0 : 2.0),
    new THREE.MeshLambertMaterial({ color: 0x2b3038, flatShading: true }),
  );
  cabin.position.set(0, 0.96 + cabinH / 2 - 0.3, kind === 'pickup' ? 0.5 : -0.15);
  cabin.castShadow = true;
  g.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 8);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1c1f22, flatShading: true });
  const wheels = [];
  for (const [sx, sz] of [[-0.92, 1.35], [0.92, 1.35], [-0.92, -1.35], [0.92, -1.35]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(sx, 0.36, sz);
    w.castShadow = false;
    g.add(w);
    wheels.push(w);
  }
  g.userData.wheels = wheels;
  return g;
}

const CONTAINER_COLORS = {
  crate: PALETTE.crate, barrel: PALETTE.barrel, dumpster: 0x4a5b4a,
  backpack: 0x6b5a3a, cabinet: PALETTE.wood, drawer: PALETTE.wood,
  locker: PALETTE.metalBox, toolbox: 0x9a6a3a, milcase: 0x4a5a3a,
};

/** 容器外观（独立 mesh：打开时要做盖子弹起动画）。 */
function containerMesh(THREE, kind, colorHex) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: colorHex, flatShading: true });
  if (kind === 'barrel') {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.95, 8), mat);
    b.position.y = 0.48;
    b.castShadow = true;
    g.add(b);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.08, 8), new THREE.MeshLambertMaterial({ color: 0x3a4a3a, flatShading: true }));
    lid.position.y = 0.98;
    g.add(lid);
    g.userData.lid = lid;
  } else {
    const h = kind === 'locker' || kind === 'cabinet' ? 1.55 : 0.75;
    const w = kind === 'locker' ? 0.7 : 0.9;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, Math.max(0.5, w * 0.66)), mat);
    body.position.y = h / 2;
    body.castShadow = true;
    g.add(body);
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(w * 1.04, 0.08, Math.max(0.52, w * 0.7)),
      new THREE.MeshLambertMaterial({ color: 0x4a3a2a, flatShading: true }),
    );
    lid.position.set(0, h + 0.02, 0);
    g.add(lid);
    g.userData.lid = lid;
  }
  return g;
}

/**
 * 用道具包的 Modular Streets 模块铺整张图的路网。
 * 每类模块（直道 / 十字 / 尽头 / 路灯 / 路牌 / 红绿灯）各一个 InstancedMesh，
 * 所以整张路网只多出 6 次 draw call；实例的缩放与朝向全部来自 world/roads.js 的拼接计划。
 * 返回 null 表示资产不可用，调用方退回程序化沥青面。
 */
function buildStreets(THREE, layout, cfg, assets) {
  const world = (cfg && cfg.world) || {};
  if (world.streetKit === false) return null;
  const propGeo = assets && assets.propGeometry;
  if (!propGeo) return null;
  // 没有"直道 + 十字"就没法拼路，直接降级
  if (!propGeo.has(STREET_MODULES.straight) || !propGeo.has(STREET_MODULES.junction)) return null;

  const plan = planStreets(layout, {
    scale: world.streetScale,
    streetlightStep: world.streetlightStep,
    streetlights: world.streetlights,
    endCaps: propGeo.has(STREET_MODULES.deadend),
  });

  const group = new THREE.Group();
  group.name = 'streets';
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const buckets = new Map();
  const pushItem = (item) => {
    if (!item || !propGeo.has(item.key)) return;
    let list = buckets.get(item.key);
    if (!list) { list = []; buckets.set(item.key, list); }
    list.push(item);
  };
  for (const p of plan.pieces) pushItem(p);
  for (const s of plan.streetlights) pushItem(s);
  for (const s of plan.signs) pushItem(s);
  for (const t of plan.trafficLights) pushItem(t);

  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  let triangles = 0;
  for (const [key, list] of buckets) {
    const entry = propGeo.get(key);
    const inst = new THREE.InstancedMesh(entry.geometry, mat, list.length);
    inst.name = `street:${key}`;
    inst.castShadow = true;
    inst.receiveShadow = true;
    // 实例散布在整张地图上，包围球不准，关掉视锥剔除免得站在路口时整片路面消失
    inst.frustumCulled = false;
    for (let i = 0; i < list.length; i += 1) {
      const it = list[i];
      euler.set(0, it.rotY || 0, 0);
      quat.setFromEuler(euler);
      pos.set(it.x, it.y || 0, it.z);
      scl.set(it.sx || 1, it.sy || 1, it.sz || 1);
      m4.compose(pos, quat, scl);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    const posAttr = entry.geometry.getAttribute('position');
    triangles += (posAttr ? posAttr.count / 3 : 0) * list.length;
  }
  if (!buckets.size) return null;

  // ── 路灯灯头的光晕（夜里才看得见）
  // 一盏真正的点光给 50 盏灯太贵，所以：几何上只加**一个小球光晕**（1 个 InstancedMesh），
  // 真正的照明由 game 里 3 盏池化点光跟随"最近的几盏灯"完成（见 game._updateStreetLights）。
  const heads = lampHeads(plan);
  const lampGlowMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const glowGeo = new THREE.SphereGeometry(0.17, 6, 4);
  const glow = new THREE.InstancedMesh(glowGeo, lampGlowMat, Math.max(1, heads.length));
  glow.name = 'street:lampGlow';
  glow.count = heads.length;
  glow.frustumCulled = false;
  for (let i = 0; i < heads.length; i += 1) {
    pos.set(heads[i].x, heads[i].y, heads[i].z);
    quat.identity();
    scl.set(1, 1, 1);
    m4.compose(pos, quat, scl);
    glow.setMatrixAt(i, m4);
  }
  glow.instanceMatrix.needsUpdate = true;
  group.add(glow);

  return { group, plan, triangles, lampGlow: lampGlowMat, lampHeads: heads };
}

/**
 * 树木实例化（按**具体模型**分桶，一桶 = 一次 draw call）。
 * 季节只决定"取哪套几何 + 材质色调"：位置/缩放/朝向全部来自 layout，所以同一张地图四季通用，
 * 换季时只要 `disposeTreeGroup(旧组)` + 再调一次本函数即可（见 game.setSeason）。
 *
 * @param {object} propGeometry 已烘焙的几何表（来自 AssetLoader.preloadProps）
 * @param {'spring'|'summer'|'autumn'|'winter'} season
 * @returns {{group, stats}}
 */
export function buildTreeInstances(THREE, layout, propGeometry, season = DEFAULT_SEASON) {
  const env = seasonEnv(season);
  const group = new THREE.Group();
  group.name = 'trees';
  group.userData.season = season;

  const stats = {
    season, total: layout.trees.length,
    dead: 0, seasons: 0, downgraded: 0, fallback: 0, instances: 0, buckets: 0,
    species: {},
  };
  const assetMat = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, color: env.treeTint,
  });
  const fallbackMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const fallbackGeo = { pine: null, broad: null };
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const buckets = new Map();
  for (const t of layout.trees) {
    const plant = t.model;
    const shape = (t.species === 'pine' || t.kind === 'pine') ? 'pine' : 'broad';
    const seasonKey = plant ? treeSeasonKey(plant, season, t.cn || null) : null;
    // 优先该季节的几何；缺（例如只装了绿）就退回绿几何，至少还是这棵树
    let key = seasonKey && propGeometry && propGeometry.has(seasonKey) ? seasonKey : null;
    if (!key && plant && propGeometry && propGeometry.has(plant)) {
      key = plant;
      if (seasonKey && seasonKey !== plant) stats.downgraded += 1;
    }
    const entry = key ? propGeometry.get(key) : null;
    const bucketKey = entry ? key : `fallback:${shape}`;
    stats.species[t.species || shape] = (stats.species[t.species || shape] || 0) + 1;
    if (t.dead) stats.dead += 1;
    if (!entry) stats.fallback += 1;
    if (entry && key !== plant) stats.seasons += 1;
    let bucket = buckets.get(bucketKey);
    if (!bucket) { bucket = { key: bucketKey, shape, entry, items: [] }; buckets.set(bucketKey, bucket); }
    bucket.items.push(t);
  }

  buckets.forEach((bucket) => {
    const items = bucket.items;
    let geo = bucket.entry && bucket.entry.geometry;
    let mat = assetMat;
    if (!geo) {
      // 资源缺失时的回退：程序化树（保证世界永远画得出来）
      if (!fallbackGeo[bucket.shape]) fallbackGeo[bucket.shape] = treeGeometry(THREE, bucket.shape);
      geo = fallbackGeo[bucket.shape];
      mat = fallbackMat;
    }
    const inst = new THREE.InstancedMesh(geo, mat, items.length);
    inst.castShadow = true;
    inst.receiveShadow = false;
    for (let i = 0; i < items.length; i += 1) {
      const t = items[i];
      euler.set(0, t.rotY || 0, 0);
      quat.setFromEuler(euler);
      pos.set(t.x, t.y || 0, t.z);
      // 模型已按目标高度烘焙，这里只做 ±15% 的高矮变化（树干碰撞用了同一个 scale）
      const s = t.scale || 1;
      scl.set(s, s, s);
      m4.compose(pos, quat, scl);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.name = bucket.entry ? `trees:${bucket.key}` : `trees:fallback_${bucket.shape}`;
    inst.userData.ownedGeometry = !bucket.entry;   // 回退几何是本函数造的，换季时要 dispose
    group.add(inst);
    stats.instances += items.length;
    stats.buckets += 1;
  });

  return { group, stats };
}

/** 释放一组树木实例（几何来自资产表时**不**释放，那是共享缓存；材质与实例缓冲要释放）。 */
export function disposeTreeGroup(group) {
  if (!group) return;
  const owned = new Set();
  group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    if (o.userData.ownedGeometry && o.geometry) owned.add(o.geometry);
    o.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m && m.dispose) m.dispose();
  });
  for (const g of owned) g.dispose();
  if (group.parent) group.parent.remove(group);
}


/**
 * 构建整个世界。
 * @returns {{group, staticMesh, interactables, containers, doorMeshes, lights, cars, stats}}
 */
export function buildWorld(THREE, layout, cfg = {}, assets = {}) {
  const group = new THREE.Group();
  group.name = 'world';

  const staticMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const B = new Batcher(THREE);
  const half = layout.size / 2;

  // ── 地面
  // 优先用**真实地形**（world/terrain.js：Copernicus DEM 30m 烘焙的高程 + ESA WorldCover 10m
  // 的顶点色 + HydroRIVERS 的水面）。没有地形数据时退回原来那块平地，保证世界永远画得出来。
  //
  // 注意 y 分层：地面 / 道路 / 地板之间要拉开 ≥8cm。早期只差 3cm，配合阴影 normalBias
  // 会让地面把道路"自我遮挡"成一条近处的黑带（截图排查出来的问题）。
  // 平地版本的顶点色只存**明暗相对值**（1.0 / 0.75），主色交给材质 color —— 换季时改一次
  // 材质颜色就整片换掉；地形版本的顶点色是**绝对色**（林地绿/水体蓝/冰雪白各不相同），
  // 换季与天气只能按"相对比值"去乘（见 terrain.js 的 terrainTint / recolor）。
  const terrain = assets.terrain || null;
  let groundMesh = null;
  let waterGroup = null;
  if (terrain) {
    groundMesh = terrain.buildMesh(THREE, { name: 'ground' });
    groundMesh.userData.terrainObj = terrain;
    groundMesh.material.color.setHex(0xffffff);
    group.add(groundMesh);
    waterGroup = terrain.buildWater(THREE);
    if (waterGroup && waterGroup.children.length) group.add(waterGroup);
  } else {
    const GB = new Batcher(THREE);
    GB.plane(layout.size + 40, layout.size + 40, 0, -0.06, 0, 0xffffff);
    // 一圈更暗的外围草地（视觉边界，不参与碰撞）
    GB.plane(80, layout.size + 40, -half - 20, -0.07, 0, 0xbfbfbf);
    GB.plane(80, layout.size + 40, half + 20, -0.07, 0, 0xbfbfbf);
    const groundSeason = cfg.world && cfg.world.season;
    const groundMat = new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true,
      // seasonEnv() 已带"未知季节回落到夏"的兜底（season.js），这里不要直接索引 SEASON_ENV
      color: seasonEnv(groundSeason).ground,
    });
    groundMesh = GB.build(groundMat);
    if (groundMesh) {
      groundMesh.name = 'ground';
      groundMesh.castShadow = false;
      groundMesh.receiveShadow = true;
      group.add(groundMesh);
    }
  }

  // ── 道路
  // 优先用道具包里的 Quaternius Modular Streets（直道/十字/尽头 + 路灯/路牌/红绿灯），
  // 每类模块一个 InstancedMesh；资产缺失时退回"沥青面 + 路缘石"的程序化版本。
  const streets = buildStreets(THREE, layout, cfg, assets);
  if (streets) {
    group.add(streets.group);
  } else {
    for (const r of layout.roads) {
      const w = r.x1 - r.x0;
      const d = r.z1 - r.z0;
      B.plane(w, d, (r.x0 + r.x1) / 2, 0.02, (r.z0 + r.z1) / 2, PALETTE.asphalt);
      // 路缘石
      if (r.axis === 'x') {
        B.box(w, 0.14, 0.5, (r.x0 + r.x1) / 2, 0.07, r.z0 - 0.25, PALETTE.sidewalk);
        B.box(w, 0.14, 0.5, (r.x0 + r.x1) / 2, 0.07, r.z1 + 0.25, PALETTE.sidewalk);
      } else {
        B.box(0.5, 0.14, d, r.x0 - 0.25, 0.07, (r.z0 + r.z1) / 2, PALETTE.sidewalk);
        B.box(0.5, 0.14, d, r.x1 + 0.25, 0.07, (r.z0 + r.z1) / 2, PALETTE.sidewalk);
      }
    }
  }

  // ── 真实路网（镇外）
  // 镇内是道具包「道路」拼出来的网格街区（buildStreets 上面那段）；
  // 镇外是 OSM 的真实道路：国道/省道/县道/村道/高速，按等级套断面，
  // 桥/隧道/匝道按 OSM 的 bridge/tunnel/layer 处理，镇界处接一条引道进镇。
  // 见 world/road-net.js 与 docs/ROAD-NETWORK.md。
  let roadNetResult = null;
  if (assets.roadNet) {
    roadNetResult = buildRoadNet(THREE, assets.roadNet, {
      townRoads: layout.roads,
      townHalf: layout.size / 2 + 6,
      seed: cfg.seed,
      terrain: assets.terrain || null,
      lights: !(cfg.roads && cfg.roads.lights === false),
      signs: !(cfg.roads && cfg.roads.signs === false),
      connectors: !(cfg.roads && cfg.roads.connectors === false),
    });
    group.add(roadNetResult.group);
    // 灯杆/信号灯/站牌：还是道具包「道路」里的模型，按 key 各建一个 InstancedMesh
    const propGroup = buildRoadPropInstances(THREE, roadNetResult.props, assets.propGeometry);
    if (propGroup) group.add(propGroup);
  }

  // ── 建筑
  // 外观来自道具包「建筑」（Quaternius Ultimate Textured Buildings，CC0 1.0，见 ASSET_CATALOG.md）：
  //   · 楼体 = 模型几何：调色板顶点色 + 按 layout 的实测门洞位置精确切出来的门洞；
  //   · 室内墙面 = **同一份几何**用 BackSide 再画一遍 —— 道具包的房子没有内表面，
  //     但背面向内看正好就是这栋楼自己的墙（窗户也天然是通的），几何复用、只多 1 次 draw call；
  //   · 资源缺失时退回旧版的程序化盒子（墙/屋顶/门框全程序化），保证世界永远画得出来。
  const interactables = [];
  const doorMeshes = [];
  const buildingBatch = new Batcher(THREE);
  const buildingStats = {
    total: layout.buildings.length, modeled: 0, fallback: 0,
    triangles: 0, doorways: 0, models: {}, palettes: {},
  };
  for (const b of layout.buildings) {
    const style = DISTRICT_STYLE[b.district] || DISTRICT_STYLE.residential;
    const { rect, wallH } = b;
    const w = rect.x1 - rect.x0;
    const d = rect.z1 - rect.z0;
    const cx = (rect.x0 + rect.x1) / 2;
    const cz = (rect.z0 + rect.z1) / 2;

    const entry = b.model && assets.buildingGeometry ? assets.buildingGeometry.get(b.model) : null;
    let usedModel = false;
    if (entry) {
      const built = buildingGeometry(THREE, entry, b);
      if (built && built.geometry) {
        buildingBatch.addColoredGeometry(built.geometry);
        usedModel = true;
        buildingStats.modeled += 1;
        buildingStats.triangles += built.triangles;
        buildingStats.models[b.model] = (buildingStats.models[b.model] || 0) + 1;
        buildingStats.palettes[b.palette] = (buildingStats.palettes[b.palette] || 0) + 1;
        if (built.cut) buildingStats.doorways += 1;
        // 侧面/背面补模块化窗户（道具包的成品楼只有正面画了窗）
        const partEntry = assets.buildingGeometry.get('part_window');
        if (partEntry) {
          const win = sideWindows(THREE, partEntry, b, {
            scale: b.modelScale, yScale: b.modelYScale, height: b.wallH,
          });
          if (win.geometry) {
            buildingBatch.addColoredGeometry(win.geometry);
            buildingStats.windows = (buildingStats.windows || 0) + win.count;
          }
        }
      }
    }

    // 地板（模型自带底面朝下，室内看到的是它的背面，单独铺一层地板更稳）
    B.plane(w - 0.3, d - 0.3, cx, 0.03, cz, PALETTE.floor);

    if (!usedModel) {
      buildingStats.fallback += 1;
      // 屋顶（悬出一点，挡雨/挡视线）
      B.box(w + 0.5, 0.22, d + 0.5, cx, wallH + 0.11, cz, style.roof);
      // 屋顶女儿墙（低多边形轮廓）
      B.box(w + 0.5, 0.35, 0.35, cx, wallH + 0.4, rect.z0 - 0.1, style.roof);
      B.box(w + 0.5, 0.35, 0.35, cx, wallH + 0.4, rect.z1 + 0.1, style.roof);
      B.box(0.35, 0.35, d + 0.5, rect.x0 - 0.1, wallH + 0.4, cz, style.roof);
      B.box(0.35, 0.35, d + 0.5, rect.x1 + 0.1, wallH + 0.4, cz, style.roof);

      // 墙体（按 layout 的墙段来，保证视觉与碰撞完全一致）
      for (const c of layout.colliders) {
        if (c.tag !== 'wall') continue;
        if (c.minX < rect.x0 - 0.01 || c.maxX > rect.x1 + 0.01) continue;
        if (c.minZ < rect.z0 - 0.01 || c.maxZ > rect.z1 + 0.01) continue;
        const ww = c.maxX - c.minX;
        const dd = c.maxZ - c.minZ;
        B.box(ww, wallH, dd, (c.minX + c.maxX) / 2, wallH / 2, (c.minZ + c.maxZ) / 2, style.wall);
      }
    }

    // 门框 + 可开合门板
    for (const door of b.doors) {
      const horizontal = door.side === 'north' || door.side === 'south';
      const px = horizontal ? door.center : (door.side === 'west' ? rect.x0 + 0.12 : rect.x1 - 0.12);
      const pz = horizontal ? (door.side === 'north' ? rect.z0 + 0.12 : rect.z1 - 0.12) : door.center;
      // 用模型时门洞高度是实测值；程序化回退时整面墙都留了缺口，门框就得顶到墙高
      const doorH = usedModel && door.height ? door.height : Math.max(2.2, wallH - 0.06);
      const frameW = door.width + 0.2;
      if (horizontal) {
        B.box(frameW, 0.16, 0.34, px, doorH + 0.08, pz, 0x3a3a40);
        B.box(0.16, doorH, 0.34, px - door.width / 2 - 0.05, doorH / 2, pz, 0x3a3a40);
        B.box(0.16, doorH, 0.34, px + door.width / 2 + 0.05, doorH / 2, pz, 0x3a3a40);
      } else {
        B.box(0.34, 0.16, frameW, px, doorH + 0.08, pz, 0x3a3a40);
        B.box(0.34, doorH, 0.16, px, doorH / 2, pz - door.width / 2 - 0.05, 0x3a3a40);
        B.box(0.34, doorH, 0.16, px, doorH / 2, pz + door.width / 2 + 0.05, 0x3a3a40);
      }
      // 门板：合页装在门洞的一侧（不是门中心），绕 Y 转 100° 就是"开"，且一定朝屋外开。
      // 老代码把合页放在门中心、门板向一侧伸出，关上门只盖住半个门洞 —— 门洞变小以后会很明显。
      const panelW = door.width * 0.94;
      const panelH = Math.max(1.1, doorH - 0.14);
      const pivot = new THREE.Group();
      pivot.position.set(horizontal ? px - panelW / 2 : px, 0, horizontal ? pz : pz - panelW / 2);
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(horizontal ? panelW : 0.09, panelH, horizontal ? 0.09 : panelW),
        new THREE.MeshLambertMaterial({ color: 0x6a5a48, flatShading: true }),
      );
      panel.position.set(horizontal ? panelW / 2 : 0, panelH / 2, horizontal ? 0 : panelW / 2);
      panel.castShadow = true;
      pivot.add(panel);
      group.add(pivot);
      // 绕 Y 旋转的正方向：+Z → +X。所以朝南（+Z）的门要负角、朝北要正角，
      // 朝东（+X）正角、朝西负角 —— 四种朝向都不会把门开进屋里。
      const openRot = (door.side === 'north' || door.side === 'east') ? Math.PI * 0.52 : -Math.PI * 0.52;
      const doorState = { open: true, pivot, panel, openRot };
      pivot.rotation.y = doorState.open ? doorState.openRot : 0;
      doorMeshes.push(doorState);
      door.pivotIndex = doorMeshes.length - 1;
      interactables.push({
        id: `door:${b.id}`, kind: 'door', label: '门',
        x: px, y: 1.1, z: pz, radius: 2.4,
        data: { buildingId: b.id, doorIndex: doorMeshes.length - 1, state: doorState },
      });
    }

    // 室内家具
    for (const f of b.furniture) {
      const wood = PALETTE.wood;
      if (f.kind === 'table') {
        B.box(1.0, 0.08, 0.7, f.x, 0.72, f.z, wood, f.rotY);
        B.box(0.1, 0.7, 0.1, f.x - 0.4, 0.35, f.z - 0.28, wood);
        B.box(0.1, 0.7, 0.1, f.x + 0.4, 0.35, f.z + 0.28, wood);
      } else if (f.kind === 'chair') {
        B.box(0.42, 0.06, 0.42, f.x, 0.44, f.z, wood, f.rotY);
        B.box(0.42, 0.5, 0.06, f.x, 0.7, f.z - 0.18, wood, f.rotY);
      } else if (f.kind === 'bed') {
        B.box(0.95, 0.35, 1.9, f.x, 0.2, f.z, 0x5a5f66, f.rotY);
        B.box(0.9, 0.16, 0.5, f.x, 0.45, f.z - 0.7, 0xb0a892, f.rotY);
      } else if (f.kind === 'sofa') {
        B.box(1.5, 0.62, 0.8, f.x, 0.31, f.z, 0x5a4a5a, f.rotY);
        B.box(1.5, 0.4, 0.2, f.x, 0.6, f.z - 0.3, 0x5a4a5a, f.rotY);
      } else if (f.kind === 'shelf') {
        B.box(1.2, 1.7, 0.4, f.x, 0.85, f.z, wood, f.rotY);
      }
    }
    // 室内灯泡（只有几何，真实光源按距离动态点亮）
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0xffe0a0 }),
    );
    bulb.position.set(cx, Math.min(wallH - 0.5, 3.3), cz);
    group.add(bulb);
  }

  // 建筑几何合并：所有楼合成一份几何，外壳（FrontSide）画一次、室内（BackSide）再画一次。
  // 这样 26 栋楼 = 2 次 draw call，而不是每个模型一次。
  const buildingGeo = buildingBatch.buildGeometry();
  if (buildingGeo) {
    buildingStats.triangles = buildingGeo.getAttribute('position').count / 3;
    const shell = new THREE.Mesh(buildingGeo, staticMat);
    shell.name = 'buildings';
    shell.castShadow = true;
    shell.receiveShadow = true;
    group.add(shell);
    // 室内墙面：同一份几何的背面，整体压暗一点，屋里才有"阴影里"的感觉
    const interiorMat = new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true, side: THREE.BackSide, color: 0x8f887c,
    });
    const interior = new THREE.Mesh(buildingGeo, interiorMat);
    interior.name = 'buildingInteriors';
    interior.castShadow = false;
    interior.receiveShadow = true;
    group.add(interior);
    buildingStats.meshes = 2;
  }

  // ── 围栏
  for (const f of layout.fences) {
    const w = Math.abs(f.x1 - f.x0);
    const len = Math.max(w, Math.abs(f.z1 - f.z0));
    const horizontal = w >= Math.abs(f.z1 - f.z0);
    B.box(horizontal ? len : 0.12, f.h, horizontal ? 0.12 : len,
      (f.x0 + f.x1) / 2, f.h / 2, (f.z0 + f.z1) / 2, 0x5a5a52);
  }

  // ── 路旁遗存的配景（地坪 + 散落残石）并进静态批：这是"不突兀"的关键，
  // 光有构件没有台坪和碎石，看起来就是凭空插在田里的门。
  for (const d of layout.relicDressing || []) {
    if (d.kind === 'apron') B.plane(3.6, 3.6, d.x, 0.025, d.z, PALETTE.concrete);
    else if (d.kind === 'rubble') {
      const s = d.size || 0.5;
      B.box(s, s * 0.72, s, d.x, s * 0.36, d.z, PALETTE.concrete, (d.x + d.z) % 1.6);
    }
  }

  // ── 静态几何合并
  const staticMesh = B.build(staticMat);
  if (staticMesh) group.add(staticMesh);

  // ── 历史街区 + 路旁遗存（GLB 多材质网格）
  // 每个实例克隆一份 gltf.scene；贴图是 GLB 里的相对 URI，加载时已经解析好。
  // 这里的实例数很少（一个院落 ~37 件 + 4 处遗存 ~9 件），所以不合并、直接挂在组里，方便以后做剔除/LOD。
  const heritageGroup = new THREE.Group();
  heritageGroup.name = 'heritage';
  const addInstances = (list, tag) => {
    for (const inst of list || []) {
      const entry = assets.heritage && assets.heritage.get(inst.key);
      if (!entry || !entry.scene) continue;
      const obj = entry.scene.clone(true);
      obj.position.set(inst.x, 0, inst.z);
      obj.rotation.y = inst.rotY || 0;
      obj.name = tag + ':' + inst.key;
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      heritageGroup.add(obj);
    }
  };
  if (layout.heritage && layout.heritage.ok) addInstances(layout.heritage.instances, 'heritage');
  if (layout.roadside && layout.roadside.ok) for (const r of layout.roadside.relics) addInstances(r.instances, 'relic');
  if (heritageGroup.children.length) group.add(heritageGroup);

  // ── 树（每个具体模型一个 InstancedMesh）
  // 树木来自道具包「树木」（Quaternius Ultimate Nature，CC0），摆放/高度/树干半径见 world/trees.js。
  // 单独抽成函数：换季时只要重建这一组 InstancedMesh，不用重建整个世界。
  // 真实地形模式下再按 ESA WorldCover 的林地/灌木格撒一批"野树"（镇子外面才有），
  // 于是"走进山里"是货真价实的森林，而不是空地。
  const wildTrees = buildWildTrees(terrain, cfg, layout, assets.roadNet);
  const treeLayout = wildTrees.length ? { ...layout, trees: layout.trees.concat(wildTrees) } : layout;
  const trees = buildTreeInstances(THREE, treeLayout, assets.propGeometry, cfg.world && cfg.world.season);
  group.add(trees.group);
  const treeStats = trees.stats;

  // ── 容器
  const containers = new Map();
  for (const c of layout.containers) {
    const mesh = containerMesh(THREE, c.kind, CONTAINER_COLORS[c.kind] || PALETTE.crate);
    mesh.position.set(c.x, c.y || 0, c.z);
    mesh.rotation.y = c.rotY || 0;
    mesh.name = `container:${c.id}`;
    group.add(mesh);
    const rec = { ...c, mesh, opened: false };
    containers.set(c.id, rec);
    interactables.push({
      id: `container:${c.id}`, kind: 'container', label: kindLabel(c.kind),
      x: c.x, y: 0.8, z: c.z, radius: 2.2,
      data: { containerId: c.id, rec },
    });
  }

  // ── 车辆
  // 车型来自道具包「车辆」的 7 台车（数据源 world/cars.js）。layout 已经把 model / typeId 绑好，
  // 这里只负责把几何放上去；资产缺失时退回程序化低模车（仍然能开、也有轮子）。
  const cars = [];
  const carColors = [0x8a3a3a, 0x3a5a8a, 0x6a6a6a, 0x4a6a4a, 0x8a7a4a, 0x5a4a6a];
  const carAssetMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const carModelStats = {};
  for (const c of layout.cars) {
    let mesh;
    const assetKey = c.model || CAR_MODEL_BY_KIND[c.kind] || 'car_normal';
    const entry = assets.propGeometry ? assets.propGeometry.get(assetKey) : null;
    carModelStats[entry ? assetKey : `fallback:${c.kind}`] = (carModelStats[entry ? assetKey : `fallback:${c.kind}`] || 0) + 1;
    if (entry) {
      // 真实车辆模型：OBJ 没有独立车轮节点，所以不会转轮子（VehicleController 会自动跳过）
      mesh = new THREE.Mesh(entry.geometry, carAssetMat);
      mesh.castShadow = true;
      mesh.userData.assetKey = assetKey;
      mesh.name = `car:${c.id}`;
    } else {
      mesh = carMesh(THREE, c.kind, carColors[cars.length % carColors.length]);
    }
    mesh.position.set(c.x, 0, c.z);
    mesh.rotation.y = c.rotY || 0;
    mesh.name = `car:${c.id}`;
    group.add(mesh);
    const type = CAR_TYPE_BY_ID[c.typeId] || null;
    // 后备箱 = 一个真正的 Inventory（按车型给载重/格数，比背包 24kg 大得多 → 车就是移动仓库）。
    // 初始战利品用 container 的"同 id 同轮次 → 同结果"机制生成，可复现、可测试。
    const trunkCap = {
      weight: (type && type.trunkWeight) || 40,
      slots: (type && type.trunkSlots) || 8,
    };
    const trunkInv = new Inventory({ maxWeight: trunkCap.weight, slotCount: trunkCap.slots, quickSlots: 0 });
    const trunkSeed = lootForContainer(
      { id: `trunk:${c.id}`, lootTable: (type && type.trunk) || 'vehicle' }, 0,
      { minRolls: cfg.vehicles ? cfg.vehicles.trunkRollsMin || 1 : 1, maxRolls: cfg.vehicles ? cfg.vehicles.trunkRollsMax || 2 : 2 },
    );
    for (const it of trunkSeed.items) trunkInv.add(it.itemId, it.count, { ignoreWeight: true });
    const rec = {
      ...c, mesh, driving: false, speed: 0,
      perf: type ? type.perf : null,
      // 车辆的使用状态（见 docs/VEHICLES.md）：油 / 车灯 / 引擎 / 后备箱
      // 油量不消耗 rng()（布局的随机序列不能动），用序号确定性摊在 25~80%
      fuel: Number.isFinite(c.fuel) ? c.fuel : 25 + ((cars.length * 37) % 56),
      lights: false,
      engineOn: false,
      trunk: (type && type.trunk) || 'vehicle',
      trunkInv,
      trunkCap,
      length: (type && type.length) || 4.4,
      halfWidth: (type && type.halfWidth) || 1.0,
      durability: (c.durability || 0.7) * (cfg.vehicles ? cfg.vehicles.maxDurability : 180),
    };
    cars.push(rec);
    if (c.drivable) {
      interactables.push({
        id: `vehicle:${c.id}`, kind: 'vehicle',
        label: `${(type && type.label) || '汽车'}（可驾驶）`,
        x: c.x, y: 1.0, z: c.z, radius: 3.2, data: { carId: c.id, rec },
      });
    }
    // 后备箱：车尾独立一个交互点（站在车尾 E 就是翻后备箱，站在车侧 E 才上车）。
    // 半径比车身交互点小，靠"离得近的那个赢"来区分。
    const back = (rec.length || 4.4) * 0.5 + 0.5;
    interactables.push({
      id: `trunk:${c.id}`, kind: 'trunk', label: '后备箱',
      x: c.x - Math.sin(c.rotY || 0) * back,
      y: 0.9,
      z: c.z - Math.cos(c.rotY || 0) * back,
      radius: 1.7, data: { carId: c.id, rec },
    });
  }

  // ── 室内灯
  const lights = [];
  for (const L of layout.lights) {
    const light = new THREE.PointLight(L.color, 0, L.distance, 1.6);
    light.position.set(L.x, L.y, L.z);
    light.castShadow = false;
    group.add(light);
    lights.push({ light, buildingId: L.buildingId, baseIntensity: L.intensity, on: false });
  }

  return {
    group,
    staticMesh,
    groundMesh,
    waterGroup,
    terrain,
    roadNet: roadNetResult,
    trees: trees.group,
    interactables,
    containers,
    doorMeshes,
    lights,
    cars,
    heritage: heritageGroup,
    // 路灯：灯头坐标（给池化点光用）+ 光晕材质（夜里调透明度）
    streetLamps: streets ? streets.lampHeads : [],
    lampGlowMat: streets ? streets.lampGlow : null,
    stats: {
      staticTriangles: staticMesh && staticMesh.geometry ? staticMesh.geometry.getAttribute('position').count / 3 : 0,
      trees: treeStats,
      roads: streets
        ? {
            ...streets.plan.stats,
            triangles: Math.round(streets.triangles),
            moduleScale: streets.plan.scale,
            asphaltWidth: streets.plan.asphaltHalf * 2,
            pavementWidth: streets.plan.halfWidth * 2,
          }
        : { fallback: true, pieces: 0 },
      containers: containers.size,
      cars: cars.length,
      carModels: carModelStats,
      buildings: layout.buildings.length,
      heritage: heritageGroup.children.length,
      buildingModels: buildingStats,
      roadNet: roadNetResult ? roadNetResult.stats : null,
    },
  };
}

/**
 * 按土地覆盖在林地里撒野树（镇子外）。返回可直接喂给 buildTreeInstances 的树条目，
 * 每条带 y（地形高度），否则树会整齐地插在 y=0 的"地下/天上"。
 */
function buildWildTrees(terrain, cfg, layout, roadNet) {
  const count = Math.max(0, Math.round((cfg.world && cfg.world.wildTrees != null ? cfg.world.wildTrees : 12000)));
  if (!terrain || !count) return [];
  const seed = ((Number(cfg.seed) || 20260801) ^ 0x7ea5eed) >>> 0;
  const rng = mulberry32(seed);
  // 中国气候带：镇内和镇外的野树必须用同一套地区混交，否则"镇里是香樟、城外是白桦"。
  const region = cfg.world && cfg.world.region && cfg.world.region !== 'temperate' ? cfg.world.region : null;
  // 道路走廊（含人行道）上不长树：路面本身 + 路肩 4m
  const reject = roadNet ? (x, z) => {
    if (roadNet.heightAt(x, z) != null) return true;
    for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
      if (roadNet.heightAt(x + dx, z + dz) != null) return true;
    }
    return false;
  } : null;
  return forestTrees(terrain, {
    count,
    rng,
    excludeTownHalf: layout.size / 2 + 70,
    maxSlope: 0.62,
    reject,
    // pickTreeModel() 一次给全 {model, species, dead}；只传 pickModel 的话会拿到一个对象，
    // propGeometry 里查不到 → 整片野树退化成程序化树（浏览器验收抓到过）。
    pickTree: (r) => pickTreeModel(r, region ? { region } : undefined),
    speciesOf: (model) => treeSpeciesOf(model),
  }).map((t) => {
    // 中国树种的体型系数（榕树更大、侧柏更小）也要作用到野树上
    const rec = t.cn ? cnSpecies(t.cn) : null;
    return rec && rec.scaleMul ? { ...t, scale: t.scale * rec.scaleMul } : t;
  });
}

/**
 * 真实路网的灯杆/信号灯/站牌：按模型 key 各建一个 InstancedMesh。
 * 几何来自道具包「道路」（streetlight / traffic_light / sign_stop，fit mode 'height'，
 * 原点在底部），所以这里只要摆位置 + 绕 Y 旋转。
 */
function buildRoadPropInstances(THREE, items, propGeometry) {
  if (!items || !items.length || !propGeometry) return null;
  const buckets = new Map();
  for (const it of items) {
    const entry = propGeometry.get(it.key);
    if (!entry || !entry.geometry) continue;   // 资产缺失就跳过（不画假灯杆）
    if (!buckets.has(it.key)) buckets.set(it.key, { entry, items: [] });
    buckets.get(it.key).items.push(it);
  }
  if (!buckets.size) return null;
  const group = new THREE.Group();
  group.name = 'roadProps';
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  let total = 0;
  buckets.forEach(({ entry, items: list }, key) => {
    const inst = new THREE.InstancedMesh(entry.geometry, mat, list.length);
    inst.castShadow = true;
    inst.receiveShadow = false;
    for (let i = 0; i < list.length; i += 1) {
      const it = list[i];
      e.set(0, it.rotY || 0, 0);
      q.setFromEuler(e);
      m4.compose(p.set(it.x, it.y || 0, it.z), q, s);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.name = `roadProps:${key}`;
    group.add(inst);
    total += list.length;
  });
  group.userData = { count: total, kinds: buckets.size };
  return total ? group : null;
}

function kindLabel(kind) {
  const map = {
    crate: '木箱', barrel: '油桶', dumpster: '垃圾箱', backpack: '背包',
    cabinet: '柜子', drawer: '抽屉', locker: '储物柜', toolbox: '工具箱', milcase: '军用箱',
  };
  return map[kind] || '容器';
}

export { PALETTE, DISTRICT_STYLE };
export default { buildWorld, buildTreeInstances, disposeTreeGroup, PALETTE };
