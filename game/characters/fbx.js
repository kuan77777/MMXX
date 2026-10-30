// FBX 角色适配：把 Quaternius 的 FBX 角色接进游戏的 Character 系统。
//
// 实测到的事实（用 dist/asset-audit.html 跑出来的，不是猜的）：
//   · 僵尸 5 段动画：ZombieIdle / ZombieWalk / ZombieRun / ZombieBite / ZombieCrawl
//     **没有** Death / Hit 片段 —— 倒地与受击由本模块合成（见 makeFallClip / makeFlinchClip）
//   · 男女各 11 段：*_Idle / Walk / Run / Jump / RunningJump / Death / Punch / SwordSlash / Standing / Sitting / Clapping
//   · 两套骨架命名不同（僵尸是 Mixamo 的 Spine/Spine1/Spine2，男女是 Abdomen/Torso/Palm）
//   · 动画轨道是纯骨骼名（Hips.quaternion…），mixer 能正确绑定（已实测 delta 0.19rad）
//   · 单位不是米：角色高 480~815 单位 → 必须按实测高度归一化
//   · **僵尸没有贴图**：角色包只发了 .fbx，材质是一个指向缺失贴图的白色 "Texture" 材质。
//     直接渲染就是纯白假人，所以这里按骨骼权重做程序化顶点着色（见 applyZombieSkin）。
//
// 因此这个模块负责：归一化尺寸/落脚点、骨骼名解析、动画→游戏状态的映射（含明确回退）、
// 缺失动作的程序化补齐、无贴图角色的程序化着色、克隆。

import { auditBones, resolveBoneName } from './loader.js';
import { ZOMBIE_PALETTES, paletteFor, buildZombieAccessories } from './zombie-look.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/** 游戏需要的 15 个动画状态。 */
export const STATES = ['idle', 'walk', 'run', 'sprint', 'jump', 'fall', 'crouch', 'aim', 'fire', 'reload', 'melee', 'hit', 'death', 'interact', 'carry'];

/** 片段名 → 状态。**顺序有意义**（RunningJump 必须先于 Run 命中）。 */
const CLIP_RULES = [
  [/runningjump|running_jump|runjump/i, 'jump'],
  [/crawl/i, 'crouch'],
  [/death|dying|die$/i, 'death'],
  [/bite|slash|punch|swing|attack|melee/i, 'melee'],
  [/idle/i, 'idle'],
  [/standing/i, 'idle'],
  [/walk/i, 'walk'],
  [/run/i, 'run'],
  [/jump/i, 'jump'],
  [/sit|clap|dance/i, null],       // 明确不使用
];

/** 模型缺某个动作时的回退链（任务书 5.3 要求"明确的回退策略"）。 */
const FALLBACK = {
  sprint: ['run', 'walk'],
  fall: ['jump', 'idle'],
  land: ['jump', 'idle'],
  aim: ['idle'],
  fire: ['melee', 'idle'],
  reload: ['idle'],
  hit: ['idle'],
  interact: ['melee', 'idle'],
  carry: ['idle'],
  crouch: ['walk', 'idle'],
  walk: ['run', 'idle'],
  run: ['walk', 'idle'],
  jump: ['idle'],
  melee: ['fire', 'idle'],
  death: ['idle'],
  idle: [],
};

/** 不同状态播同一段动画时用不同速度，避免"冲刺和走路一样快"。 */
export const STATE_SPEED = { sprint: 1.35, walk: 0.95, run: 1.0, crouch: 0.7 };

/** 合成动画（倒地/受击）挂在这个节点上：它是"以脚底为支点"的枢轴，绕它旋转整个人。 */
export const PIVOT_NODE = 'charPivot';

// ── 僵尸外观 ─────────────────────────────────────────────
// 角色包的僵尸 FBX 只有一个白色 "Texture" 材质，贴图文件根本没随之提供（包内只有两个 .fbx）。
// 直接渲染 = 纯白假人。这里按「权重最大的骨骼」把三角面分到身体部位并上色，
// 再按位置哈希叠污渍/血渍 —— 不依赖任何外部贴图，也不依赖模型自带 UV（那些 UV 指向缺失的图集）。
// 四季变种只是换一套调色板（见 characters/zombie-look.js），着色算法完全一样。
export const ZOMBIE_REGION_COLORS = ZOMBIE_PALETTES.base;

/** 骨骼名 → 身体部位（不要求精确匹配，混过 Mixamo / Quaternius 两套命名）。 */
export function regionForBone(rawName) {
  const n = String(rawName || '').toLowerCase();
  if (/toe|foot/.test(n)) return 'boots';
  if (/leg|thigh|shin|calf/.test(n)) return 'pants';
  if (/forearm|hand|finger|thumb|palm/.test(n)) return 'skin';
  if (/head|neck/.test(n)) return 'head';
  if (/arm|shoulder|clavicle/.test(n)) return 'shirt';
  if (/spine|chest|torso|abdomen|hips|pelvis/.test(n)) return 'shirt';
  return 'skin';
}

const POSITION_HASH = (x, y, z) => {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * 给"没有贴图"的角色做程序化顶点着色（只对僵尸调用）。
 * 每个三角面统一一个颜色（低多边形：避免顶点插值把身体染成渐变色）。
 * @param {string} [paletteName] 四季调色板名（spring/summer/autumn/winter；缺省 = base）
 * @returns {{ok:boolean, reason?:string, triangles?:number, regions?:object, palette?:string}}
 */
export function applyZombieSkin(THREE, root, paletteName = null) {
  let mesh = null;
  root.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
  if (!mesh || !mesh.geometry) return { ok: false, reason: '没有蒙皮网格' };
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (mats.some((m) => m && m.map)) return { ok: false, reason: '模型自带贴图，保留原材质' };
  if (mats.some((m) => m && m.vertexColors)) return { ok: false, reason: '模型已有顶点色' };

  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const pos = src.getAttribute('position');
  const si = src.getAttribute('skinIndex');
  const sw = src.getAttribute('skinWeight');
  const bones = (mesh.skeleton && mesh.skeleton.bones) || [];
  if (!pos || !si || !sw || !bones.length) return { ok: false, reason: '缺少蒙皮属性或骨架' };

  const palette = paletteFor(paletteName);
  const regionNames = Object.keys(ZOMBIE_PALETTES.base);
  const regionColors = regionNames.map((r) => new THREE.Color(palette[r] != null ? palette[r] : ZOMBIE_PALETTES.base[r]));
  const green = new THREE.Color(palette.green != null ? palette.green : 0x6f7d5c);
  const blood = new THREE.Color(palette.blood != null ? palette.blood : 0x5f241f);
  const tmp = new THREE.Color();

  // 顶点 → 权重最大的骨骼 → 部位
  const vertRegion = new Uint8Array(pos.count);
  for (let i = 0; i < pos.count; i += 1) {
    const ws = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
    const idx = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)];
    let bestW = -1;
    let bestBone = -1;
    for (let k = 0; k < 4; k += 1) {
      if (ws[k] > bestW) { bestW = ws[k]; bestBone = idx[k]; }
    }
    const bone = bones[bestBone];
    vertRegion[i] = Math.max(0, regionNames.indexOf(regionForBone(bone && bone.name)));
  }

  const colors = new Float32Array(pos.count * 3);
  const stats = { head: 0, skin: 0, shirt: 0, pants: 0, boots: 0, blood: 0 };
  for (let i = 0; i < pos.count; i += 3) {
    const a = vertRegion[i];
    const b = vertRegion[i + 1];
    const c = vertRegion[i + 2];
    const r = (a === b || a === c) ? a : (b === c ? b : a);
    const region = regionNames[r];
    // 三角面中心 → 稳定伪随机（同位置永远同色，克隆出来的僵尸长得一样）
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const n1 = POSITION_HASH(cx, cy, cz);
    const n2 = POSITION_HASH(cy + 7.7, cx - 3.1, cz + 1.9);

    tmp.copy(regionColors[r]).multiplyScalar(0.86 + n1 * 0.26);
    if (region === 'head' || region === 'skin') {
      tmp.lerp(green, n2 * 0.22);            // 皮肤病态的绿斑
      if (n2 > 0.955) { tmp.lerp(blood, 0.4); stats.blood += 1; }
    } else if (region === 'shirt') {
      if (n2 > 0.86) { tmp.lerp(blood, 0.55); stats.blood += 1; }
      else if (n2 < 0.12) tmp.multiplyScalar(0.78); // 泥污
    } else if (region === 'pants') {
      if (n2 > 0.93) { tmp.lerp(blood, 0.35); stats.blood += 1; }
      else if (n1 < 0.2) tmp.multiplyScalar(0.85);
    }
    stats[region] += 1;

    for (let k = 0; k < 3; k += 1) {
      colors[(i + k) * 3] = tmp.r;
      colors[(i + k) * 3 + 1] = tmp.g;
      colors[(i + k) * 3 + 2] = tmp.b;
    }
  }

  src.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  src.computeBoundingBox();
  src.computeBoundingSphere();
  mesh.geometry = src;
  return {
    ok: true,
    triangles: pos.count / 3,
    regions: stats,
    palette: paletteName || 'base',
  };
}

// ── 缺失动作的程序化补齐 ─────────────────────────────────
function makePivotClip(THREE, name, keys) {
  const times = keys.map((k) => k.t);
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const quats = [];
  for (const k of keys) {
    euler.set(k.rot[0], k.rot[1], k.rot[2], 'XYZ');
    quat.setFromEuler(euler);
    quats.push(quat.x, quat.y, quat.z, quat.w);
  }
  const tracks = [new THREE.QuaternionKeyframeTrack(`${PIVOT_NODE}.quaternion`, times, quats)];
  if (keys.some((k) => k.pos)) {
    const pos = [];
    for (const k of keys) pos.push(...(k.pos || [0, 0, 0]));
    tracks.push(new THREE.VectorKeyframeTrack(`${PIVOT_NODE}.position`, times, pos));
  }
  return new THREE.AnimationClip(name, times[times.length - 1], tracks);
}

/**
 * 合成"倒地"动画：绕脚底枢轴向前扑倒（僵尸模型没有 Death 片段，不补的话会站着死去）。
 * +Z 是角色正面，绕 +X 正角 = 头向 +Z 倒；position 的 +Y 是"抬起量"——
 * 人体有厚度（模型前后 0.67m），绕脚底转到水平时前胸/手会插进地面，所以越倒越要抬一点。
 */
export function makeFallClip(THREE) {
  return makePivotClip(THREE, 'death__procedural_fall', [
    { t: 0.00, rot: [0, 0, 0], pos: [0, 0, 0] },
    { t: 0.16, rot: [-0.10, 0, 0.03], pos: [0, 0.01, 0] },
    { t: 0.52, rot: [0.55, 0.04, 0.09], pos: [0, 0.10, 0] },
    { t: 0.92, rot: [1.26, 0.10, 0.15], pos: [0, 0.23, 0] },
    { t: 1.26, rot: [1.36, 0.12, 0.16], pos: [0, 0.28, 0] },
  ]);
}

/** 合成"受击"动画：整个人向后一顿（没有 Hit 片段时用）。 */
export function makeFlinchClip(THREE) {
  return makePivotClip(THREE, 'hit__procedural_flinch', [
    { t: 0.00, rot: [0, 0, 0] },
    { t: 0.08, rot: [-0.17, 0, 0.05] },
    { t: 0.22, rot: [-0.05, 0, -0.01] },
    { t: 0.42, rot: [0, 0, 0] },
  ]);
}


/**
 * 剔掉"恒为 1"的 scale 轨道。
 *
 * 为什么必须剔：Quaternius 这套 FBX 每根骨骼都带一条 scale 轨道，值全是 (1,1,1)
 * （只有根对象 HumanArmature 是 100）。AnimationMixer 只要看见轨道，就会每帧把
 * `bone.scale` 写成轨道里的值 —— 于是「男性体型模板靠改骨骼缩放做出来的宽肩/粗胳膊」
 * 会在第一帧被抹平，模型原地变回标准体格（见 characters/male-templates.js）。
 * 这些轨道本来就是常量，删掉不改变任何观感；非恒定（真在动画里缩放）的轨道保留。
 * @param {THREE.AnimationClip} clip
 * @returns {{removed:string[], kept:number}}
 */
export function stripConstantScaleTracks(clip) {
  const removed = [];
  if (!clip || !Array.isArray(clip.tracks)) return { removed, kept: 0 };
  const kept = [];
  for (const t of clip.tracks) {
    if (!/\.scale$/.test(t.name) || !t.values || !t.values.length) { kept.push(t); continue; }
    let unit = true;
    for (let i = 0; i < t.values.length; i += 1) {
      // 容差放到 1e-3：FBX 里 UpperLegL/R 的 scale 是 1.000006/1.000009（float32 噪声），
      // 按 1e-6 判会漏掉它们，结果体型模板给腿加粗后又被这条轨道写回 1。
      if (Math.abs(t.values[i] - 1) > 1e-3) { unit = false; break; }
    }
    if (unit) removed.push(t.name); else kept.push(t);
  }
  if (removed.length) clip.tracks = kept;
  return { removed, kept: kept.length };
}

/**
 * 把模型自带的动画片段映射到游戏状态。
 * @param {THREE.AnimationClip[]} animations
 * @returns {{clips: Record<string,THREE.AnimationClip>, mapping: object, fallbacks: object, missing: string[], scaleTracksRemoved: number}}
 */
export function mapClipsToStates(animations) {
  const direct = {};
  const unmapped = [];
  let scaleTracksRemoved = 0;
  for (const clip of animations || []) {
    scaleTracksRemoved += stripConstantScaleTracks(clip).removed.length;
    let target = null;
    for (const [re, state] of CLIP_RULES) {
      if (re.test(clip.name)) { target = state; break; }
    }
    if (!target) { unmapped.push(clip.name); continue; }
    if (!direct[target]) direct[target] = clip;
  }

  const clips = {};
  const fallbacks = {};
  const missing = [];
  for (const state of STATES) {
    if (direct[state]) { clips[state] = direct[state]; continue; }
    let got = null;
    for (const alt of FALLBACK[state] || []) {
      if (direct[alt]) { got = alt; break; }
    }
    if (got) {
      // 克隆一份：不同状态必须各自有独立的 action，否则 crossfade 会被同一个 action 吃掉
      const c = direct[got].clone();
      c.name = `${state}__from_${got}`;
      clips[state] = c;
      fallbacks[state] = got;
    } else {
      missing.push(state);
    }
  }
  // land 不在 STATES 里，但动画机需要它
  if (direct.jump) {
    const c = direct.jump.clone();
    c.name = 'land__from_jump';
    clips.land = c;
  } else if (direct.idle) {
    const c = direct.idle.clone();
    c.name = 'land__from_idle';
    clips.land = c;
  }
  return { clips, mapping: direct, fallbacks, missing, unmapped, scaleTracksRemoved };
}

const _v = { x: 0, y: 0, z: 0 };

/** 用真实蒙皮公式算"当前姿态下的世界包围盒"（几何包围盒是 bind 姿态，不可靠）。 */
function measureSkinnedWorld(THREE, root) {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const acc = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.geometry || !o.skeleton) return;
    const geo = o.geometry;
    const pos = geo.getAttribute('position');
    const si = geo.getAttribute('skinIndex');
    const sw = geo.getAttribute('skinWeight');
    if (!pos || !si || !sw) return;
    const skel = o.skeleton;
    skel.update();
    const bind = o.bindMatrix;
    const inv = o.bindMatrixInverse;
    // 顶点太多时抽样，够算包围盒
    const step = pos.count > 4000 ? 3 : 1;
    for (let i = 0; i < pos.count; i += step) {
      p.fromBufferAttribute(pos, i).applyMatrix4(bind);
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k += 1) {
        const w = k === 0 ? sw.getX(i) : k === 1 ? sw.getY(i) : k === 2 ? sw.getZ(i) : sw.getW(i);
        if (!w) continue;
        const bi = k === 0 ? si.getX(i) : k === 1 ? si.getY(i) : k === 2 ? si.getZ(i) : si.getW(i);
        const bone = skel.bones[bi];
        const boneInv = skel.boneInverses[bi];
        if (!bone) continue;
        tmp.copy(p).applyMatrix4(boneInv).applyMatrix4(bone.matrixWorld);
        acc.addScaledVector(tmp, w);
      }
      acc.applyMatrix4(inv).applyMatrix4(o.matrixWorld);
      box.expandByPoint(acc);
    }
  });
  return box;
}

function convertMaterials(THREE, root, opts = {}) {
  const cache = new Map();
  const convertOne = (src) => {
    if (!src) return new THREE.MeshLambertMaterial({ color: 0xcccccc });
    const key = `${src.color ? src.color.getHexString() : 'x'}|${!!src.vertexColors}|${src.map ? 'map' : ''}|${!!opts.zombie}|${!!opts.vertexColors}`;
    let mat = cache.get(key);
    if (mat) return mat;
    const col = new THREE.Color(src.color ? src.color.getHex() : 0xcccccc);
    if (opts.vertexColors) col.setHex(0xffffff);            // 顶点色已经是最终颜色，材质色不能再压暗
    else if (opts.zombie) col.lerp(new THREE.Color(0x6f7d68), 0.45); // 有贴图/无顶点色时才用整体偏灰绿
    mat = new THREE.MeshLambertMaterial({
      color: col,
      vertexColors: !!src.vertexColors || !!opts.vertexColors,
      map: src.map || null,
      flatShading: false,
    });
    // 保留材质名（Skin/Eyes/Hair/Shirt/Dress）——球衣替换就是按名字找 "Shirt" 的，
    // 丢了名字就找不到该换哪一件（第一版就是空名字导致 applyKitTexture 直接报"没找到球衣材质"）。
    mat.name = src.name || '';
    cache.set(key, mat);
    return mat;
  };
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    o.frustumCulled = false;
    // 关键：Quaternius 角色是「一个 SkinnedMesh + 多材质数组（Skin/Eyes/Hair/Shirt）」，
    // 只取 material[0] 会把整身刷成皮肤色（第一版就是这个 bug）。
    // 材质数组与 geometry.groups 的下标一一对应，必须整体转换、保持顺序。
    if (Array.isArray(o.material)) o.material = o.material.map(convertOne);
    else o.material = convertOne(o.material);
  });
}

/**
 * 角色模板库：预加载一次，之后每个 NPC 用 SkeletonUtils.clone（共享几何，独立骨架）。
 */
export class CharacterFactory {
  constructor(THREE, loader, models) {
    this.THREE = THREE;
    this.loader = loader;
    this.models = models || {};
    this.templates = new Map();
    this.errors = [];
    this.ready = false;
  }

  async preload(onProgress) {
    const keys = Object.keys(this.models);
    let done = 0;
    for (const key of keys) {
      const def = this.models[key];
      try {
        // 先取出（缓存的）原始模型，再为每个模板**克隆**一份：
        // 四季僵尸共用同一个 FBX，但调色板不同 → 几何不能共享；骨架也必须独立，
        // 否则五套模板会互相覆盖顶点色/骨骼。
        const baseObj = await this.loader.loadFBX(def.url);
        const obj = SkeletonUtils.clone(baseObj);
        const mapped = mapClipsToStates(obj.animations);

        // 模型缺 Death / Hit 时补合成动作（僵尸就是这种情况：只有 Idle/Walk/Run/Bite/Crawl）。
        // 注意：必须在 preload 里建一次、所有克隆共享，否则每个 NPC 都会造一份片段。
        const synthetic = [];
        if (!mapped.mapping.death) {
          mapped.clips.death = makeFallClip(this.THREE);
          mapped.fallbacks.death = 'procedural-fall';
          synthetic.push('death');
        }
        if (!mapped.mapping.hit) {
          mapped.clips.hit = makeFlinchClip(this.THREE);
          mapped.fallbacks.hit = 'procedural-flinch';
          synthetic.push('hit');
        }

        // 僵尸没有贴图：按骨骼权重做程序化顶点色（每个模板独立一份几何，调色板不同）
        const zombieSkin = def.kind === 'zombie' ? applyZombieSkin(this.THREE, obj, def.palette) : null;

        // 用 idle 姿态量尺寸：bind 姿态可能是张开的 T-pose，直接量会偏
        if (mapped.clips.idle) {
          const mixer = new this.THREE.AnimationMixer(obj);
          mixer.clipAction(mapped.clips.idle).play();
          mixer.update(0.25);
          obj.updateMatrixWorld(true);
        }
        const box = measureSkinnedWorld(this.THREE, obj);
        const size = new this.THREE.Vector3();
        box.getSize(size);
        const height = size.y > 1e-3 ? size.y : 1;
        const scale = (def.targetHeight || 1.75) / height;
        const centerX = (box.min.x + box.max.x) / 2;
        const centerZ = (box.min.z + box.max.z) / 2;
        const minY = box.min.y;

        // 变种挂件（孢子囊/菌伞/冰壳）：尺寸按"米"写，再换算成模板单位（1/scale）
        const accessories = def.kind === 'zombie' && def.accessories
          ? buildZombieAccessories(this.THREE, obj, def.accessories, { unit: 1 / scale })
          : null;

        // 骨骼解析
        const boneNames = [];
        obj.traverse((o) => { if (o.isBone) boneNames.push(o.name); });
        const audit = auditBones(boneNames);

        this.templates.set(key, {
          key, def, obj, mapped, scale,
          offset: { x: -centerX * scale, y: -minY * scale, z: -centerZ * scale },
          measured: { height: size.y, width: size.x, depth: size.z, minY },
          boneNames, audit, synthetic, zombieSkin, accessories,
          targetHeight: def.targetHeight || 1.75,
        });
        if (!audit.ok) {
          this.errors.push({ key, error: `缺少关键骨骼: ${audit.missingRequired.join(',')}（该角色会回退到程序化模型）` });
        }
        if (def.kind === 'zombie' && zombieSkin && !zombieSkin.ok) {
          // 不是错误：模型自带贴图时本来就不该再刷顶点色。只是记录原因，排查"纯白僵尸"时看这里。
          this.warnings = this.warnings || [];
          this.warnings.push({ key, warning: `僵尸未使用程序化着色：${zombieSkin.reason}` });
        }
        if (mapped.missing.length) {
          this.errors.push({ key, error: `缺少动画状态且无回退: ${mapped.missing.join(',')}` });
        }
      } catch (e) {
        this.errors.push({ key, error: String(e && e.message ? e.message : e) });
      }
      done += 1;
      if (onProgress) onProgress(done / keys.length, key);
    }
    this.ready = true;
    return this;
  }

  /** 这个 key 是否可用（缺关键骨骼的模板视为不可用）。 */
  canUse(key) { const t = this.templates.get(key); return !!(t && t.audit.ok); }

  get availableKeys() { return [...this.templates.keys()].filter((k) => this.canUse(k)); }

  /**
   * 克隆一个可用的角色模型。
   * @returns {{group, bones, mesh, clips, stateSpeed, eyeHeight, height, kind:'fbx', templateKey, mapped}|null}
   */
  create(key) {
    const t = this.templates.get(key);
    if (!t || !t.audit.ok) return null;
    const THREE = this.THREE;
    const obj = SkeletonUtils.clone(t.obj);
    convertMaterials(THREE, obj, {
      zombie: t.def.kind === 'zombie',
      vertexColors: !!(t.zombieSkin && t.zombieSkin.ok),
    });

    // 归一化：外层 wrapper 承担缩放与落脚点，内层保持资源原始变换。
    // 注意 matrix 顺序是 T * R * S：obj.position 在父空间里，不带 obj.scale，
    // 所以「原始位置要跟着缩放、再叠加归一化偏移」，两件事都按世界单位算。
    // （曾经把已经乘过 scale 的 offset 又除了一次 scale，模型被推到 7 米外，第三人称看不到人。）
    const p0 = obj.position.clone();
    obj.scale.multiplyScalar(t.scale);
    obj.position.set(
      p0.x * t.scale + t.offset.x,
      p0.y * t.scale + t.offset.y,
      p0.z * t.scale + t.offset.z,
    );

    // 枢轴：合成动画（倒地/受击）绕它旋转，支点在脚底。
    // 模型自带这两段动画时它是恒等变换，不影响任何东西。
    const pivot = new THREE.Group();
    pivot.name = PIVOT_NODE;
    pivot.add(obj);

    const wrapper = new THREE.Group();
    wrapper.name = `char_${key}`;
    wrapper.add(pivot);

    // 骨骼名解析（在克隆体上重新找，SkeletonUtils 会保留名字）
    const boneMap = {};
    let firstSkinnedMesh = null;
    obj.traverse((o) => {
      if (o.isBone) {
        const std = resolveBoneName(o.name);
        if (std && !boneMap[std]) boneMap[std] = o;
      }
      if (!firstSkinnedMesh && o.isSkinnedMesh) firstSkinnedMesh = o;
    });

    return {
      group: wrapper,
      pivot,
      inner: obj,
      bones: boneMap,
      boneNames: t.boneNames,
      mesh: firstSkinnedMesh,
      clips: t.mapped.clips,
      stateSpeed: STATE_SPEED,
      eyeHeight: t.targetHeight * 0.93,
      height: t.targetHeight,
      kind: 'fbx',
      templateKey: key,
      mapped: t.mapped,
      skinnedMeshes: (() => { const a = []; obj.traverse((o) => { if (o.isSkinnedMesh) a.push(o); }); return a; })(),
      skeleton: firstSkinnedMesh ? firstSkinnedMesh.skeleton : null,
    };
  }

  report() {
    return {
      ready: this.ready,
      templates: [...this.templates.values()].map((t) => ({
        key: t.key,
        kind: t.def.kind || 'human',
        clips: Object.keys(t.mapped.mapping),
        synthetic: t.synthetic || [],
        fallbacks: t.mapped.fallbacks,
        missing: t.mapped.missing,
        unmapped: t.mapped.unmapped,
        look: t.zombieSkin
          ? (t.zombieSkin.ok
            ? `程序化顶点色[${t.zombieSkin.palette || 'base'}]（${t.zombieSkin.triangles} 面 / 血渍 ${t.zombieSkin.regions.blood} 处）`
            : `原始材质（${t.zombieSkin.reason}）`)
          : '模型自带材质',
        palette: t.def.palette || null,
        accessories: t.accessories ? t.accessories.names : [],
        bones: t.boneNames.length,
        missingBones: t.audit.missingRequired,
        measuredHeight: Math.round(t.measured.height),
        scale: +t.scale.toFixed(5),
      })),
      errors: this.errors,
      warnings: this.warnings || [],
    };
  }
}

export default {
  CharacterFactory, mapClipsToStates, STATES, STATE_SPEED,
  applyZombieSkin, regionForBone, makeFallClip, makeFlinchClip, PIVOT_NODE,
  ZOMBIE_REGION_COLORS,
};
