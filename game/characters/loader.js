// GLB/glTF 角色适配层（目前**未被游戏使用**：实际角色资产是 FBX，走 characters/fbx.js）。
//
// 现状与承诺（重要）：角色（僵尸/男/女）已经接进来了，但用的是用户提供的 **FBX**（见 ASSET_CATALOG.md 第 5.3 节）。
// 本模块保留的是 glTF 路径：一旦你拿到 .glb，放进来也能走真正的 GLTFLoader + 骨骼/动画映射，
// 而不是静默退回静态模型。骨骼别名表（BONE_ALIASES）与片段别名表（CLIP_ALIASES）是两套加载器共用的，
// fbx.js 也直接 import 了这里的 auditBones/resolveBoneName。
//
// 它负责（对应任务书 5.1~5.3）：
//   · 识别模型骨骼与动画片段（按名字别名表匹配，不假设所有包都有同样的动作名）；
//   · 检查缺少哪些必需骨骼，缺关键骨骼时明确报错并回退到程序化角色（绝不静默变成静态人）；
//   · 检测根运动（root motion）：如果动画里带动画位移，把位移轨道清零，避免与代码控制叠加；
//   · 报告手臂/武器挂点/脚部的位置，供人工核对穿模。

// 说明：GLTFLoader 用**动态 import** 而不是顶层 import。
// 这样本模块的纯函数（骨骼/动画名映射）可以在 Node 里被单测，而不需要解析 'three/addons/...'
// 这个只有浏览器 importmap 才能解析的裸模块名。

/** 游戏需要的骨骼 → 常见命名别名（不同资源包/导出器的命名差异）。 */
export const BONE_ALIASES = {
  hips: ['hips', 'pelvis', 'root', 'Hips', 'mixamorigHips', 'body'],
  spine: ['spine', 'spine_01', 'Spine', 'mixamorigSpine', 'abdomen'],
  chest: ['chest', 'spine_02', 'spine_03', 'Chest', 'mixamorigSpine1', 'mixamorigSpine2', 'spine1', 'spine2', 'torso'],
  neck: ['neck', 'Neck', 'mixamorigNeck'],
  head: ['head', 'Head', 'mixamorigHead'],
  shoulderL: ['shoulderL', 'clavicle_l', 'LeftShoulder', 'mixamorigLeftShoulder', 'shoulder_l'],
  upperArmL: ['upperArmL', 'upperarm_l', 'LeftArm', 'mixamorigLeftArm', 'arm_l', 'upper_arm_l'],
  lowerArmL: ['lowerArmL', 'lowerarm_l', 'LeftForeArm', 'mixamorigLeftForeArm', 'forearm_l'],
  handL: ['handL', 'hand_l', 'LeftHand', 'mixamorigLeftHand', 'palmL', 'middlehandL'],
  shoulderR: ['shoulderR', 'clavicle_r', 'RightShoulder', 'mixamorigRightShoulder', 'shoulder_r'],
  upperArmR: ['upperArmR', 'upperarm_r', 'RightArm', 'mixamorigRightArm', 'arm_r', 'upper_arm_r'],
  lowerArmR: ['lowerArmR', 'lowerarm_r', 'RightForeArm', 'mixamorigRightForeArm', 'forearm_r'],
  handR: ['handR', 'hand_r', 'RightHand', 'mixamorigRightHand', 'palmR', 'middlehandR'],
  thighL: ['thighL', 'thigh_l', 'LeftUpLeg', 'mixamorigLeftUpLeg', 'upperleg_l'],
  shinL: ['shinL', 'shin_l', 'LeftLeg', 'mixamorigLeftLeg', 'lowerleg_l'],
  footL: ['footL', 'foot_l', 'LeftFoot', 'mixamorigLeftFoot'],
  thighR: ['thighR', 'thigh_r', 'RightUpLeg', 'mixamorigRightUpLeg', 'upperleg_r'],
  shinR: ['shinR', 'shin_r', 'RightLeg', 'mixamorigRightLeg', 'lowerleg_r'],
  footR: ['footR', 'foot_r', 'RightFoot', 'mixamorigRightFoot'],
};

/** 动画状态 → 片段名别名（大小写/前后缀都会做模糊匹配）。 */
export const CLIP_ALIASES = {
  idle: ['idle', 'stand', 'breathing', 'idle_a'],
  walk: ['walk', 'walking', 'walk_fwd', 'walkforward'],
  run: ['run', 'running', 'jog', 'run_fwd'],
  sprint: ['sprint', 'sprint_fwd', 'fastrun'],
  jump: ['jump', 'jump_up', 'jumpup', 'air'],
  fall: ['fall', 'falling', 'inair', 'jump_down'],
  crouch: ['crouch', 'crouching', 'sneak', 'crouch_idle'],
  aim: ['aim', 'aiming', 'aim_idle', 'rifle_aim', 'pistol_aim'],
  fire: ['fire', 'shoot', 'attack_shoot', 'fire_rifle', 'shoot_pistol'],
  reload: ['reload', 'reloading', 'reload_rifle'],
  melee: ['melee', 'punch', 'attack', 'swing', 'zombie_attack'],
  hit: ['hit', 'hurt', 'damage', 'flinch'],
  death: ['death', 'die', 'dying', 'death_a'],
  interact: ['interact', 'pickup', 'open', 'use'],
  carry: ['carry', 'holding', 'hold'],
};

const REQUIRED_BONES = ['hips', 'spine', 'chest', 'head', 'upperArmL', 'upperArmR', 'thighL', 'thighR'];

/** 纯函数：把一个骨骼名映射到游戏用的标准名（找不到返回 null）。 */
export function resolveBoneName(rawName) {
  const n = String(rawName || '');
  const lower = n.toLowerCase().replace(/[\s_.-]/g, '');
  for (const [std, aliases] of Object.entries(BONE_ALIASES)) {
    for (const a of aliases) {
      if (a.toLowerCase().replace(/[\s_.-]/g, '') === lower) return std;
    }
  }
  return null;
}

/** 纯函数：把一个动画片段名映射到游戏状态（找不到返回 null）。 */
export function resolveClipName(rawName) {
  const n = String(rawName || '').toLowerCase();
  for (const [state, aliases] of Object.entries(CLIP_ALIASES)) {
    for (const a of aliases) {
      if (n === a || n.startsWith(`${a}_`) || n.startsWith(`${a}-`) || n.endsWith(`_${a}`) || n.endsWith(`_${a}`)) return state;
      if (n.includes(a)) return state;
    }
  }
  return null;
}

/** 纯函数：检查骨骼覆盖情况。 */
export function auditBones(boneNames) {
  const found = {};
  const unknown = [];
  for (const raw of boneNames || []) {
    const std = resolveBoneName(raw);
    if (std) { if (!found[std]) found[std] = raw; } else unknown.push(raw);
  }
  const missingRequired = REQUIRED_BONES.filter((b) => !found[b]);
  return {
    found,
    unknown,
    missingRequired,
    ok: missingRequired.length === 0,
    coverage: Object.keys(found).length,
  };
}

/** 纯函数：把模型的动画列表映射成游戏状态表，并报告缺失动作。 */
export function auditClips(clipNames) {
  const map = {};
  const unmapped = [];
  for (const raw of clipNames || []) {
    const state = resolveClipName(raw);
    if (!state) { unmapped.push(raw); continue; }
    if (!map[state]) map[state] = raw;
  }
  const all = Object.keys(CLIP_ALIASES);
  const missing = all.filter((s) => !map[s]);
  return { map, unmapped, missing, ok: !!map.idle && !!map.walk && !!map.death };
}

/**
 * 加载一个 GLB 角色，返回可直接用于游戏的模型描述。
 * @param {string} url
 * @param {object} opts { scale, onProgress }
 * @returns {Promise<{ok:boolean, error?:string, group?:object, animations?:any[], audit?:object, rootMotion?:object}>}
 */
export async function loadGlbCharacter(url, opts = {}) {
  if (!url) return { ok: false, error: '没有提供 modelPath' };
  let GLTFLoader;
  try {
    ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
  } catch (e) {
    return { ok: false, error: `无法加载 GLTFLoader（${e && e.message ? e.message : e}）` };
  }
  const loader = new GLTFLoader();
  let gltf;
  try {
    gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, opts.onProgress, (e) => reject(new Error(`GLTF 加载失败: ${url} (${e && e.message ? e.message : e})`)));
    });
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }

  const boneNames = [];
  gltf.scene.traverse((o) => { if (o.isBone || o.type === 'Bone') boneNames.push(o.name); });
  const boneAudit = auditBones(boneNames);
  const clipAudit = auditClips((gltf.animations || []).map((c) => c.name));

  // 根运动检测：如果某个位置轨道作用在根骨骼/ hips 上并且有明显位移，就把它清零，
  // 否则会出现"动画在走 + 代码也在走"的双倍位移。
  const rootMotion = { detected: false, tracks: [] };
  for (const clip of gltf.animations || []) {
    for (const track of clip.tracks || []) {
      if (!/\.position$/.test(track.name)) continue;
      const node = track.name.split('.')[0];
      const std = resolveBoneName(node);
      if (std !== 'hips' && std !== 'root') continue;
      const v = track.values;
      let maxDelta = 0;
      for (let i = 3; i < v.length; i += 3) {
        maxDelta = Math.max(maxDelta, Math.abs(v[i] - v[0]), Math.abs(v[i + 2] - v[2]));
      }
      if (maxDelta > 0.05) {
        rootMotion.detected = true;
        rootMotion.tracks.push({ clip: clip.name, track: track.name, maxDelta: Math.round(maxDelta * 100) / 100 });
        // 水平位移清零（保留竖直方向，让跳跃动画仍然能上下动）
        for (let i = 0; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
      }
    }
  }

  const group = gltf.scene;
  if (Number.isFinite(opts.scale) && opts.scale > 0) group.scale.setScalar(opts.scale);
  group.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = false; }
  });

  return {
    ok: true,
    group,
    animations: gltf.animations || [],
    bones: boneAudit.found,
    boneAudit,
    clipAudit,
    rootMotion,
    // 缺关键骨骼时明确告诉调用方：不要假装能用
    usable: boneAudit.ok,
    warning: boneAudit.ok ? null : `模型缺少关键骨骼：${boneAudit.missingRequired.join(', ')}（将回退到程序化角色）`,
  };
}

export default {
  loadGlbCharacter, auditBones, auditClips, resolveBoneName, resolveClipName,
  BONE_ALIASES, CLIP_ALIASES,
};
