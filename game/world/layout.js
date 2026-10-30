// 地图布局生成器：**纯数据、无 three.js**，因此可以在 Node 里直接单测
// （建筑是否重叠、门是否通向街道、每个建筑是否都能走到、战利品点是否落在建筑内部…）。
// 视觉构建在 world/build.js 里按这份 blueprint 生成，二者严格分离。
//
// 一张 340×340 的城镇：路网 + 5×5 街区 + 26 栋可进入建筑 + 树林环 + 兴趣点 + 刷新区。
// 所有随机都来自 seed，同 seed 一定得到同一张地图（存档/复现依赖这一点）。

import { pickTreeModel, treeTrunkRadius, cnSpecies } from './trees.js';
import { planHeritage, pickHeritageSite } from './heritage.js';
import { planRoadsideRelics } from './roadside.js';
import { carTypeForSlot } from './cars.js';
import {
  BUILDING_MODELS, buildingSpec, buildingRotation, pickBuildingModel, pickBuildingPalette,
} from './buildings.js';

export const DISTRICT_TYPES = ['residential', 'commercial', 'industrial', 'park', 'plaza'];

// 街区类型 → 建筑外观/战利品倾向
const DISTRICT_INFO = {
  residential: { label: '住宅区', buildingTypes: ['house', 'apartment'], loot: ['residential', 'residential', 'medical'], danger: 0.25 },
  commercial: { label: '商业区', buildingTypes: ['shop', 'office'], loot: ['commercial', 'commercial', 'residential'], danger: 0.45 },
  industrial: { label: '工业区', buildingTypes: ['warehouse', 'factory'], loot: ['industrial', 'military', 'industrial'], danger: 0.8 },
  park: { label: '公园', buildingTypes: ['shed'], loot: ['residential'], danger: 0.3 },
  plaza: { label: '广场', buildingTypes: ['shop', 'office'], loot: ['commercial', 'medical'], danger: 0.5 },
};

const BUILDING_NAMES = {
  house: ['民居', '独栋小楼', '红顶住宅', '街角小屋', '两层民宅'],
  apartment: ['公寓楼', '职工宿舍', '旧住宅楼'],
  shop: ['便利店', '五金店', '杂货铺', '小超市', '面包房'],
  office: ['市政办事处', '邮局', '诊疗所', '社区中心', '派出所'],
  warehouse: ['仓库', '物流站', '冷库', '维修车间'],
  factory: ['旧工厂', '加工车间', '配电房'],
  shed: ['工具棚', '更衣室', '看台储物间'],
};

function mulberry32(a) {
  let t = a >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const rand = (rng, a, b) => a + rng() * (b - a);
const randInt = (rng, a, b) => Math.floor(rand(rng, a, b + 1));

const WALL_T = 0.28;

/** 墙段：门洞把一面墙切成两段，其余三面完整。 */
function wallSegments(x0, z0, x1, z1, doorSide, doorCenter, doorWidth, height) {
  const segs = [];
  const t = WALL_T;
  const push = (minX, minZ, maxX, maxZ) => {
    if (maxX - minX < 0.02 || maxZ - minZ < 0.02) return;
    segs.push({ minX, minZ, maxX, maxZ, maxY: height, tag: 'wall' });
  };
  const half = doorWidth / 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // 北/南墙：沿 X 方向，门洞切出两段
  const splitX = (z) => {
    const a = clamp(doorCenter - half, x0 + t, x1 - t);
    const b = clamp(doorCenter + half, x0 + t, x1 - t);
    push(x0, z, a, z + t);
    push(b, z, x1, z + t);
  };
  // 东/西墙：沿 Z 方向
  const splitZ = (x) => {
    const a = clamp(doorCenter - half, z0 + t, z1 - t);
    const b = clamp(doorCenter + half, z0 + t, z1 - t);
    push(x, z0, x + t, a);
    push(x, b, x + t, z1);
  };

  if (doorSide === 'north') splitX(z0); else push(x0, z0, x1, z0 + t);
  if (doorSide === 'south') splitX(z1 - t); else push(x0, z1 - t, x1, z1);
  if (doorSide === 'west') splitZ(x0); else push(x0, z0, x0 + t, z1);
  if (doorSide === 'east') splitZ(x1 - t); else push(x1 - t, z0, x1, z1);

  return segs;
}

/**
 * 门口走廊（导航用）：门洞只有 1.2~2m，而导航格子是 2m —— 光靠 blockRect，NPC 会认为
 * 门口"没格子可站"，A* 永远进不了屋。所以对每个门显式清出一小块可走区域：
 * 沿门洞宽、跨墙 ±1m。玩家碰撞仍然走精确的墙段，不受影响。
 */
function doorNavRect(rect, door) {
  const half = door.width / 2 + 0.35;
  if (door.side === 'north' || door.side === 'south') {
    const z = door.side === 'north' ? rect.z0 : rect.z1;
    return { x0: door.center - half, x1: door.center + half, z0: z - 1.1, z1: z + 1.1 };
  }
  const x = door.side === 'west' ? rect.x0 : rect.x1;
  return { x0: x - 1.1, x1: x + 1.1, z0: door.center - half, z1: door.center + half };
}

export function generateLayout(config = {}) {
  const size = Number.isFinite(config.size) ? config.size : 340;
  const seed = Number.isFinite(config.seed) ? config.seed : 20260801;
  const blockSize = Number.isFinite(config.blockSize) ? config.blockSize : 52;
  const roadWidth = Number.isFinite(config.roadWidth) ? config.roadWidth : 9;
  const targetBuildings = Number.isFinite(config.buildingCount) ? config.buildingCount : 26;
  const rng = mulberry32(seed);

  const half = size / 2;
  const bounds = { minX: -half, maxX: half, minZ: -half, maxZ: half };
  const pitch = blockSize + roadWidth;
  const gridN = Math.floor((half - 20) / pitch); // 每侧几个街区

  const roads = [];
  const blocks = [];
  // 路网：南北向 + 东西向
  for (let k = -gridN; k <= gridN; k += 1) {
    const c = k * pitch;
    roads.push({ id: `roadx${k}`, x0: -half + 12, x1: half - 12, z0: c - roadWidth / 2, z1: c + roadWidth / 2, axis: 'x' });
    roads.push({ id: `roadz${k}`, x0: c - roadWidth / 2, x1: c + roadWidth / 2, z0: -half + 12, z1: half - 12, axis: 'z' });
  }

  // 街区（在两条路之间）
  for (let ix = -gridN; ix <= gridN - 1; ix += 1) {
    for (let iz = -gridN; iz <= gridN - 1; iz += 1) {
      const x0 = ix * pitch + roadWidth / 2;
      const x1 = (ix + 1) * pitch - roadWidth / 2;
      const z0 = iz * pitch + roadWidth / 2;
      const z1 = (iz + 1) * pitch - roadWidth / 2;
      if (x1 - x0 < 12 || z1 - z0 < 12) continue;
      // 中心街区是广场；由内向外按环分配类型，保证住宅/商业/工业都出现
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const ring = Math.max(Math.abs(ix + 0.5), Math.abs(iz + 0.5));
      let district;
      if (ring <= 0.5) district = (ix === 0 && iz === 0) ? 'plaza' : 'commercial';
      else if (Math.abs(ix + 0.5) > 1 && Math.abs(iz + 0.5) > 1) district = ((ix < 0) === (iz < 0)) ? 'industrial' : 'park';
      else district = (((ix * 7 + iz * 13) % 4 + 4) % 4 === 0) ? 'park' : 'residential';
      blocks.push({ id: `B${ix}_${iz}`, ix, iz, x0, z0, x1, z1, district, ring, dist: Math.hypot(cx, cz) });
    }
  }

  const colliders = [];
  const buildings = [];
  const containers = [];
  const itemSpawns = [];
  const props = [];
  const lights = [];
  const navDoors = [];        // 门口走廊（给导航清格子用，见 doorNavRect）
  const buildingsPerBlock = [];
  let bIdx = 0, cIdx = 0, sIdx = 0, pIdx = 0;

  /**
   * 摆一栋楼。**尺寸来自道具包模型**：先按类型挑模型与目标宽度，进深/层高按模型比例算出来，
   * 所以 rect 不是随机宽 —— 窄的街屋就是窄的、宽的仓库就是宽的，门洞位置也直接取模型实测值
   * （见 world/buildings.js）。这样渲染（building-mesh）和这里用的是同一组数字。
   */
  const addBuilding = (block, rect, type, doorSide, modelKey, spec, palette) => {
    const info = DISTRICT_INFO[block.district] || DISTRICT_INFO.residential;
    const wallH = spec.height;
    const nameBase = pick(rng, BUILDING_NAMES[type] || BUILDING_NAMES.house);
    // 门在正面上的位置（模型实测偏移）→ 换到世界坐标；再夹一下，别让门洞顶到墙角
    const alongX = doorSide === 'north' || doorSide === 'south';
    const mid = alongX ? (rect.x0 + rect.x1) / 2 : (rect.z0 + rect.z1) / 2;
    let signedOffset = spec.door.offset;
    if (doorSide === 'north' || doorSide === 'west') signedOffset = -signedOffset;
    const half = spec.door.width / 2;
    const lo = (alongX ? rect.x0 : rect.z0) + WALL_T + half + 0.15;
    const hi = (alongX ? rect.x1 : rect.z1) - WALL_T - half - 0.15;
    const doorCenter = Math.min(hi, Math.max(lo, mid + signedOffset));
    const segs = wallSegments(rect.x0, rect.z0, rect.x1, rect.z1, doorSide, doorCenter, spec.door.width, wallH);
    for (const s of segs) colliders.push({ ...s, blocksNav: true });

    const id = `BD${++bIdx}`;
    const doorHeight = spec.door.height;
    const doors = [{ side: doorSide, center: doorCenter, width: spec.door.width, height: doorHeight, open: true }];
    const loot = info.loot;
    const lootSpots = [];
    const furn = [];

    const w = rect.x1 - rect.x0;
    const d = rect.z1 - rect.z0;
    // 室内可用范围（避开墙厚），家具/箱子随机摆放的范围随房子大小缩，别摆到门洞里
    const inset = Math.min(1.3, Math.max(0.65, Math.min(w, d) * 0.16));
    const inX0 = rect.x0 + inset;
    const inX1 = rect.x1 - inset;
    const inZ0 = rect.z0 + inset;
    const inZ1 = rect.z1 - inset;
    // 门洞正前方 1.2m 内不放东西，否则一进门就顶在箱子上
    const nearDoor = (x, z) => {
      if (doorSide === 'north') return Math.abs(x - doorCenter) < spec.door.width * 0.5 + 0.6 && z < rect.z0 + 1.7;
      if (doorSide === 'south') return Math.abs(x - doorCenter) < spec.door.width * 0.5 + 0.6 && z > rect.z1 - 1.7;
      if (doorSide === 'west') return Math.abs(z - doorCenter) < spec.door.width * 0.5 + 0.6 && x < rect.x0 + 1.7;
      return Math.abs(z - doorCenter) < spec.door.width * 0.5 + 0.6 && x > rect.x1 - 1.7;
    };

    // 室内家具/容器：数量随面积
    const area = w * d;
    const nContainers = Math.max(1, Math.min(4, Math.round(area / 45)));
    for (let i = 0; i < nContainers; i += 1) {
      const kind = pick(rng, type === 'warehouse' || type === 'factory'
        ? ['crate', 'toolbox', 'locker', 'milcase']
        : ['cabinet', 'crate', 'drawer', 'locker']);
      const table = pick(rng, loot);
      let px = rand(rng, inX0, inX1);
      let pz = rand(rng, inZ0, inZ1);
      for (let tries = 0; tries < 6 && nearDoor(px, pz); tries += 1) {
        px = rand(rng, inX0, inX1);
        pz = rand(rng, inZ0, inZ1);
      }
      if (nearDoor(px, pz)) continue;
      const cid = `LC${++cIdx}`;
      containers.push({
        id: cid, kind, x: px, z: pz, y: 0, rotY: rand(rng, 0, Math.PI * 2),
        lootTable: table, buildingId: id, opened: false,
      });
      lootSpots.push(cid);
      // 容器本身是一个小碰撞体（可以挡住玩家，也说明"搜刮要绕过去"）
      // blocksNav 必须与碰撞一致：否则 NPC 会以为能走，然后被卡在箱子前面反复重算路径
      colliders.push({ minX: px - 0.35, minZ: pz - 0.35, maxX: px + 0.35, maxZ: pz + 0.35, maxY: 0.9, tag: 'prop', id: cid, blocksNav: true });
      // 家具贴墙摆放
      if (rng() < 0.75) {
        const fy = rand(rng, 0.35, 0.45);
        let fx = rand(rng, inX0, inX1);
        let fz = rand(rng, inZ0, inZ1);
        for (let tries = 0; tries < 4 && nearDoor(fx, fz); tries += 1) {
          fx = rand(rng, inX0, inX1);
          fz = rand(rng, inZ0, inZ1);
        }
        const fkind = pick(rng, ['table', 'chair', 'shelf', 'bed', 'sofa']);
        furn.push({ kind: fkind, x: fx, y: 0, z: fz, rotY: rand(rng, 0, Math.PI * 2) });
        if (fkind === 'table' || fkind === 'shelf' || fkind === 'bed' || fkind === 'sofa') {
          colliders.push({ minX: fx - 0.5, minZ: fz - 0.5, maxX: fx + 0.5, maxZ: fz + 0.5, maxY: fy + 0.7, tag: 'prop', blocksNav: true });
        }
      }
    }
    // 地面散落物：建筑内 + 门口
    const nItems = randInt(rng, 0, 2);
    for (let i = 0; i < nItems; i += 1) {
      itemSpawns.push({
        id: `IS${++sIdx}`,
        x: rand(rng, inX0, inX1),
        z: rand(rng, inZ0, inZ1),
        y: 0,
        lootTable: pick(rng, loot),
        buildingId: id,
        respawnAt: 0,
      });
    }

    // 室内灯（构建时只把最近的几盏真的点亮，见 build.js）
    // 道具包的房子层高偏高，灯挂在 min(层高-0.7, 3.4m) 才不会黑得像地窖。
    lights.push({
      x: (rect.x0 + rect.x1) / 2, y: Math.min(wallH - 0.7, 3.4), z: (rect.z0 + rect.z1) / 2,
      color: 0xffd9a0, intensity: 12, distance: Math.max(8, Math.min(18, area / 12)),
      buildingId: id,
    });

    buildings.push({
      id, type, district: block.district,
      name: `${nameBase}${buildings.filter((b) => b.type === type).length + 1}`,
      rect, wallH, wallT: WALL_T, doors, lootSpots, furniture: furn,
      // 外观：道具包模型 + 缩放 + 朝向 + 调色板（build.js / building-mesh.js 直接读这些字段）
      model: modelKey,
      modelScale: spec.scale,
      modelYScale: spec.yScale,
      modelRotY: buildingRotation(doorSide),
      palette,
      blockId: block.id, danger: info.danger,
    });
    navDoors.push(doorNavRect(rect, doors[0]));
    return buildings[buildings.length - 1];
  };

  /** 按模型算出"这栋楼在地图上的矩形"（以 (cx,cz) 为中心）。 */
  const rectFor = (spec, cx, cz) => ({
    x0: cx - spec.width / 2, x1: cx + spec.width / 2,
    z0: cz - spec.depth / 2, z1: cz + spec.depth / 2,
  });
  const specFor = (choice) => buildingSpec(choice.key, choice.width / BUILDING_MODELS[choice.key].size.w);
  /** 门朝最近的街：比较四个方向到街区边缘的距离。 */
  const doorSideFor = (block, rect) => {
    const dN = rect.z0 - block.z0;
    const dS = block.z1 - rect.z1;
    const dW = rect.x0 - block.x0;
    const dE = block.x1 - rect.x1;
    const m = Math.min(dN, dS, dW, dE);
    return m === dN ? 'north' : m === dS ? 'south' : m === dW ? 'west' : 'east';
  };

  // 把建筑摆进街区。
  // 与旧版（10~20m 的大方块）不同：道具包的房子是 5~14m 的窄街屋，所以槽位更细。
  // 每个街区最多放 maxPerBlock 栋，把总数摊到整张图上，而不是全挤在前几个街区。
  const maxPerBlock = Math.max(1, Math.ceil(targetBuildings / Math.max(1, blocks.length)));
  const SLOT = 12;
  for (const block of blocks) {
    const info = DISTRICT_INFO[block.district];
    const bw = block.x1 - block.x0;
    const bh = block.z1 - block.z0;
    if (block.district === 'park') {
      // 公园里只放一个小棚子 + 树（树在下面统一撒）
      if (rng() < 0.55) {
        const choice = pickBuildingModel(rng, 'shed');
        const spec = specFor(choice);
        if (bw > spec.width + 4 && bh > spec.depth + 4) {
          const rect = rectFor(spec, block.x0 + bw * 0.5, block.z0 + bh * 0.5);
          addBuilding(block, rect, 'shed', pick(rng, ['north', 'south', 'east', 'west']), choice.key, spec, pickBuildingPalette(rng, block.district));
        }
      }
      continue;
    }
    const cols = Math.max(1, Math.floor(bw / SLOT));
    const rows = Math.max(1, Math.floor(bh / SLOT));
    const cellW = bw / cols;
    const cellH = bh / rows;
    let placed = 0;
    for (let ix = 0; ix < cols && placed < maxPerBlock; ix += 1) {
      for (let iz = 0; iz < rows && placed < maxPerBlock; iz += 1) {
        if (buildings.length >= targetBuildings) break;
        if (rng() < 0.24) continue; // 留空地
        const type = pick(rng, info.buildingTypes);
        const choice = pickBuildingModel(rng, type);
        const spec = specFor(choice);
        if (spec.width > cellW - 1.2 || spec.depth > cellH - 1.2) continue;
        const cx = block.x0 + (ix + 0.5) * cellW + rand(rng, -0.7, 0.7);
        const cz = block.z0 + (iz + 0.5) * cellH + rand(rng, -0.7, 0.7);
        const rect = rectFor(spec, cx, cz);
        addBuilding(block, rect, type, doorSideFor(block, rect), choice.key, spec, pickBuildingPalette(rng, block.district));
        placed += 1;
      }
    }
    if (buildings.length >= targetBuildings) break;
  }
  // 目标数量没凑够：在空地补几栋（保证"可进入建筑"数量稳定，测试也好断言）
  let guard = 0;
  while (buildings.length < targetBuildings && guard < 400) {
    guard += 1;
    const block = blocks[Math.floor(rng() * blocks.length)];
    const type = pick(rng, DISTRICT_INFO[block.district].buildingTypes);
    const choice = pickBuildingModel(rng, type);
    const spec = specFor(choice);
    const bw = block.x1 - block.x0;
    const bh = block.z1 - block.z0;
    if (bw < spec.width + 5 || bh < spec.depth + 5) continue;
    const x0 = block.x0 + rand(rng, 2.5, bw - spec.width - 2.5);
    const z0 = block.z0 + rand(rng, 2.5, bh - spec.depth - 2.5);
    const rect = { x0, z0, x1: x0 + spec.width, z1: z0 + spec.depth };
    // 不能和已有建筑重叠
    const overlaps = buildings.some((b) => !(rect.x1 + 2.5 < b.rect.x0 || rect.x0 - 2.5 > b.rect.x1 || rect.z1 + 2.5 < b.rect.z0 || rect.z0 - 2.5 > b.rect.z1));
    if (overlaps) continue;
    addBuilding(block, rect, type, pick(rng, ['north', 'south', 'east', 'west']), choice.key, spec, pickBuildingPalette(rng, block.district));
  }

  // ── 树：镇外丛林 + 镇内零星绿化
  // 每棵树绑一个道具包「树木」里的具体模型（world/trees.js），树干碰撞半径用它实测的树干半径。
  const trees = [];
  const treeCount = Number.isFinite(config.treeCount) ? config.treeCount : 300;
  // 中国气候带（可选）：'northeast' / 'north' / 'jiangnan' / 'south' / 'southwest' / 'northwest'；
  // 'temperate' 或不传 = 原来的温带混交（老地图/老存档的树完全不变）。
  const treeRegion = config.region && config.region !== 'temperate' ? config.region : null;
  // 空间哈希做最小间距检查：树干不许叠在一起，树冠允许交叠 —— 这样子才像林子。
  const TREE_CELL = 8;
  const treeGrid = new Map();
  const treeTooClose = (x, z, gap) => {
    const gx = Math.floor(x / TREE_CELL), gz = Math.floor(z / TREE_CELL);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const list = treeGrid.get(`${gx + dx},${gz + dz}`);
        if (!list) continue;
        for (const p of list) if (Math.hypot(p[0] - x, p[1] - z) < gap) return true;
      }
    }
    return false;
  };
  const addTree = (x, z) => {
    // region 决定"这张图是中国的哪个气候带"（华北/江南/华南/东北/西南/西北）。
    // 不给 region（temperate）时和旧版本完全一致：温带混交、随机数消耗序列都不变。
    const chosen = pickTreeModel(rng, treeRegion ? { region: treeRegion } : undefined);
    const cnRec = chosen.cn ? cnSpecies(chosen.cn) : null;
    const scale = rand(rng, 0.88, 1.18) * (cnRec && cnRec.scaleMul ? cnRec.scaleMul : 1);
    trees.push({
      x, z, rotY: rand(rng, 0, Math.PI * 2), scale,
      model: chosen.model, species: chosen.species, dead: chosen.dead,
      cn: chosen.cn || null,
    });
    const key = `${Math.floor(x / TREE_CELL)},${Math.floor(z / TREE_CELL)}`;
    let list = treeGrid.get(key);
    if (!list) { list = []; treeGrid.set(key, list); }
    list.push([x, z]);
  };

  // 1) 树丛：南北两片林地（对应 POI_WOODS / SZ_FOREST_N/S）+ 镇外几片随机树林。
  //    全图均匀撒点在 340×340 上会稀稀拉拉，成组才有"走进林子"的观感。
  const groves = [
    { x: 0, z: -140, radius: 26, count: 34 },
    { x: 0, z: 145, radius: 22, count: 26 },
  ];
  for (let i = 0; i < 6; i += 1) {
    const a = rng() * Math.PI * 2;
    const rr = rand(rng, 96, 152);
    groves.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, radius: rand(rng, 14, 24), count: 12 + Math.floor(rng() * 16) });
  }
  for (const g of groves) {
    let added = 0;
    for (let attempt = 0; added < g.count && attempt < g.count * 8 && trees.length < treeCount; attempt += 1) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * g.radius;
      const x = g.x + Math.cos(a) * r;
      const z = g.z + Math.sin(a) * r;
      if (x < bounds.minX + 4 || x > bounds.maxX - 4 || z < bounds.minZ + 4 || z > bounds.maxZ - 4) continue;
      if (insideAnyBuilding(x, z, buildings, 2.2)) continue;
      if (onRoad(x, z, roads, 2)) continue;
      if (treeTooClose(x, z, 3.2)) continue;
      addTree(x, z);
      added += 1;
    }
  }

  // 2) 散树：镇外均匀撒点，镇内只留 18%（街边绿化）；树丛已经用掉的名额从这里补。
  let tGuard = 0;
  while (trees.length < treeCount && tGuard < treeCount * 14) {
    tGuard += 1;
    const x = rand(rng, bounds.minX + 6, bounds.maxX - 6);
    const z = rand(rng, bounds.minZ + 6, bounds.maxZ - 6);
    const inTown = Math.hypot(x, z) < 132;
    if (inTown && rng() > 0.18) continue;
    // 出生点周围留空：别让玩家一开局就卡在树干里
    if (Math.hypot(x, z - 6) < 10) continue;
    if (insideAnyBuilding(x, z, buildings, 2.2)) continue;
    if (onRoad(x, z, roads, 2)) continue;
    if (treeTooClose(x, z, 2.4)) continue;
    addTree(x, z);
  }
  // 树干作为细碰撞体（让人绕树走，但不影响子弹）
  for (const t of trees) {
    const r = treeTrunkRadius(t.model, t.scale);
    colliders.push({ minX: t.x - r, minZ: t.z - r, maxX: t.x + r, maxZ: t.z + r, maxY: 5, tag: 'deco', blocksNav: true });
  }

  // ── 围栏：工业区外围
  const fences = [];
  for (const block of blocks.filter((b) => b.district === 'industrial')) {
    if (rng() < 0.5) continue;
    const side = pick(rng, ['north', 'south']);
    const z = side === 'north' ? block.z0 + 1.2 : block.z1 - 1.2;
    const x0 = block.x0 + 2;
    const x1 = block.x1 - 2;
    fences.push({ x0, z0: z, x1, z1: z + 0.25, h: 1.8 });
    colliders.push({ minX: x0, minZ: z, maxX: x1, maxZ: z + 0.25, maxY: 1.8, tag: 'fence', blocksNav: true });
  }

  // ── 车辆：沿路边随机摆放（部分可驾驶）
  // 横向偏移只取 ±(roadWidth×0.09)：视觉路面用的是 Modular Streets 模块，
  // 沥青带只有 roadWidth×4/9 宽（9m 的路上是 4m）；车宽 1.8~2.35m，
  // 偏移 0.81m 时最宽的 SUV 外侧 (0.81+1.18=1.99m) 仍在沥青里 —— 车"贴路缘停"，
  // 不会跨到比沥青高 5cm 的人行道上（跨上去轮子会陷进去）。
  //
  // 朝向：道具包里的 7 台车**车长沿本地 Z、车头朝 +Z**（用前/尾灯材质重心测出来的，见 world/cars.js），
  // 所以"车顺着路停"要做的是：横路（axis:x）→ rotY = ±90°，纵路（axis:z）→ rotY = 0/180°。
  // 以前这里写反了（横路给 0/180°），车会横在马路中间。
  const cars = [];
  const carCount = Number.isFinite(config.carCount) ? config.carCount : 14;
  const carOffset = Math.max(0.5, roadWidth * 0.09);
  // 交叉口和路的两头（尽头模块）不放车：车横在十字路口或停在收口的人行道上很怪
  const crossingsOf = (road) => roads
    .filter((o) => o.axis !== road.axis)
    .map((o) => (road.axis === 'x' ? (o.x0 + o.x1) / 2 : (o.z0 + o.z1) / 2));
  let carGuard = 0;
  while (cars.length < carCount && carGuard < carCount * 20) {
    carGuard += 1;
    const road = roads[Math.floor(rng() * roads.length)];
    const alongX = road.axis === 'x';
    // 两端各留 14m：6m 的尽头模块 + 车长的一半 + 余量
    const tMin = (alongX ? road.x0 : road.z0) + 14;
    const tMax = (alongX ? road.x1 : road.z1) - 14;
    const t = rand(rng, tMin, tMax);
    const x = alongX ? t : (road.x0 + road.x1) / 2 + rand(rng, -carOffset, carOffset);
    const z = alongX ? (road.z0 + road.z1) / 2 + rand(rng, -carOffset, carOffset) : t;
    if (insideAnyBuilding(x, z, buildings, 3)) continue;
    if (crossingsOf(road).some((c0) => Math.abs(t - c0) < 12)) continue;
    if (cars.some((c) => Math.hypot(c.x - x, c.z - z) < 8)) continue;
    // 车型：前 7 台各出一次（保证 7 种车都见得到），之后按权重随机。
    // carTypeForSlot 内部仍会消耗一次 rng()，随机序列与改动前一致。
    const type = carTypeForSlot(cars.length, rng);
    cars.push({
      id: `CAR${cars.length + 1}`, x, z, y: 0,
      rotY: alongX ? (rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2) : (rng() < 0.5 ? 0 : Math.PI),
      drivable: rng() < 0.55,
      kind: type.kind,
      model: type.model,
      typeId: type.id,
      typeLength: type.length,
      durability: 0.4 + rng() * 0.6,
    });
  }

  // ── 露天木箱/油桶（镇内补给点）
  const crateCount = Number.isFinite(config.crateCount) ? config.crateCount : 40;
  let crateGuard = 0;
  const outdoorLoot = [];
  while (outdoorLoot.length < crateCount && crateGuard < crateCount * 15) {
    crateGuard += 1;
    const x = rand(rng, -138, 138);
    const z = rand(rng, -138, 138);
    if (insideAnyBuilding(x, z, buildings, 1.6)) continue;
    if (onRoad(x, z, roads, -1.5)) continue;
    const kind = pick(rng, ['crate', 'barrel', 'dumpster', 'backpack']);
    const id = `LC${++cIdx}`;
    containers.push({ id, kind, x, z, y: 0, rotY: rand(rng, 0, Math.PI * 2), lootTable: pick(rng, ['residential', 'commercial', 'industrial', 'medical']), buildingId: null, opened: false });
    colliders.push({ minX: x - 0.45, minZ: z - 0.45, maxX: x + 0.45, maxZ: z + 0.45, maxY: 0.95, tag: 'prop', id, blocksNav: false });
    outdoorLoot.push(id);
  }
  for (let i = 0; i < Math.min(24, crateCount / 2); i += 1) {
    const c = containers.find((x) => x.id === outdoorLoot[i]);
    if (!c) continue;
    itemSpawns.push({ id: `IS${++sIdx}`, x: c.x + rand(rng, -1.6, 1.6), z: c.z + rand(rng, -1.6, 1.6), y: 0, lootTable: 'residential', buildingId: null, respawnAt: 0 });
  }

  // ── 兴趣点 & 刷新区
  const center = { x: 0, z: 0 };
  const industrialBlock = blocks.find((b) => b.district === 'industrial') || blocks[0];
  const residentialBlock = blocks.find((b) => b.district === 'residential') || blocks[blocks.length - 1];
  const poi = [
    { id: 'POI_PLAZA', kind: 'plaza', name: '中央广场', x: center.x, z: center.z, radius: 16, danger: 0.3 },
    { id: 'POI_MARKET', kind: 'supply', name: '临时补给站', x: residentialBlock.x0 + 6, z: residentialBlock.z0 + 6, radius: 10, danger: 0.2 },
    { id: 'POI_WORKS', kind: 'danger', name: '工业区废墟', x: industrialBlock.x0 + 10, z: industrialBlock.z0 + 10, radius: 22, danger: 0.95 },
    { id: 'POI_WOODS', kind: 'forest', name: '北侧林地', x: 0, z: -140, radius: 30, danger: 0.55 },
    { id: 'POI_BASE', kind: 'base', name: '幸存者营地', x: residentialBlock.x1 - 8, z: residentialBlock.z1 - 8, radius: 12, danger: 0.1 },
  ];

  const spawnZones = [
    { id: 'SZ_WORKS', type: 'zombie', x: industrialBlock.x0 + 10, z: industrialBlock.z0 + 10, radius: 26, count: 10, tier: 'high' },
    { id: 'SZ_FOREST_N', type: 'zombie', x: 0, z: -140, radius: 34, count: 8, tier: 'mid' },
    { id: 'SZ_FOREST_S', type: 'zombie', x: 0, z: 145, radius: 30, count: 7, tier: 'mid' },
    { id: 'SZ_TOWN_W', type: 'zombie', x: -95, z: 20, radius: 30, count: 8, tier: 'mid' },
    { id: 'SZ_TOWN_E', type: 'zombie', x: 95, z: -30, radius: 30, count: 8, tier: 'mid' },
    { id: 'SZ_BASE', type: 'friendly', x: residentialBlock.x1 - 8, z: residentialBlock.z1 - 8, radius: 9, count: 5, tier: 'low' },
    { id: 'SZ_RAIDERS', type: 'hostile', x: industrialBlock.x1 - 6, z: industrialBlock.z1 - 6, radius: 14, count: 4, tier: 'high' },
  ];

  // 玩家出生点：广场中心，朝向北（+Z 是前方，这里朝 +Z）
  const playerSpawn = { x: 0, y: 0, z: 6, yaw: 0 };

  // ── 历史街区（古建院落）与路旁遗存 ──
  // 两者都是纯数据规划器（world/heritage.js / roadside.js），这里只负责把它们并进 layout。
  // 门禁在 planHeritage() 里硬判断：非历史城市一个构件都不生成。
  let heritage = null;
  const hcfg = config.heritage;
  if (hcfg && hcfg.index) {
    const site = pickHeritageSite({ buildings, roads, bounds, playerSpawn, size }, hcfg.index);
    if (site) {
      const plan = planHeritage(hcfg.index, { x: site.x, z: site.z, boxes: hcfg.boxes });
      if (plan.ok) {
        heritage = plan;
        colliders.push(...plan.colliders);
        navDoors.push(...plan.navDoors);
        poi.push(plan.poi);
      } else if (plan.reason) console.warn('[heritage]', plan.reason);
    } else {
      console.warn('[heritage] 旧城里没有放得下院落的空地，跳过');
    }
  }

  let roadside = null;
  if (config.roadside !== false && hcfg && hcfg.boxes) {
    const plan = planRoadsideRelics({ roads, buildings, bounds, roadWidth, size }, {
      seed, boxes: hcfg.boxes, heritageRect: heritage ? heritage.block : null,
    });
    if (plan.ok) {
      roadside = plan;
      colliders.push(...plan.colliders);
      poi.push(...plan.poi);
      // 配景树并进树表（树是统一实例化渲染的），并补树干碰撞
      for (const d of plan.dressing) {
        if (d.kind !== 'tree') continue;
        trees.push({ x: d.x, z: d.z, rotY: d.rotY, scale: d.scale, model: d.model, species: d.species, dead: d.dead });
        const r2 = treeTrunkRadius(d.model, d.scale);
        colliders.push({ minX: d.x - r2, minZ: d.z - r2, maxX: d.x + r2, maxZ: d.z + r2, maxY: 5, tag: 'deco', blocksNav: true });
      }
    }
  }

  return {
    seed, size, bounds, blockSize, roadWidth, gridN,
    roads, blocks, buildings, containers, itemSpawns, props, trees, fences, cars,
    colliders, lights, navDoors, poi, spawnZones, playerSpawn,
    heritage, roadside, relicDressing: roadside ? roadside.dressing.filter((d) => d.kind !== 'tree') : [],
    districts: blocks.map((b) => b.district),
    counts: {
      buildings: buildings.length, containers: containers.length,
      itemSpawns: itemSpawns.length, trees: trees.length, cars: cars.length,
      colliders: colliders.length,
      heritage: heritage ? heritage.summary.instances : 0,
      relics: roadside ? roadside.relics.length : 0,
    },
  };
}

function onRoad(x, z, roads, pad = 0) {
  for (const r of roads) {
    if (x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad) return true;
  }
  return false;
}

function insideAnyBuilding(x, z, buildings, pad = 0) {
  for (const b of buildings) {
    if (x >= b.rect.x0 - pad && x <= b.rect.x1 + pad && z >= b.rect.z0 - pad && z <= b.rect.z1 + pad) return true;
  }
  return false;
}

/** 找到某个点所属的建筑（用于室内判定/室内光照/是否下雨）。 */
export function buildingAt(x, z, buildings) {
  for (const b of buildings) {
    if (x > b.rect.x0 && x < b.rect.x1 && z > b.rect.z0 && z < b.rect.z1) return b;
  }
  return null;
}

export default { generateLayout, buildingAt, DISTRICT_TYPES };
