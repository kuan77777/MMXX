// 程序化动画片段：不依赖任何外部动画文件，全部用 THREE.AnimationClip 的关键帧生成。
// 每个片段都完整写出 **全部骨骼** 的四元数轨道 —— 这样任意两个状态之间做 crossfade 时，
// 不会因为"某个骨骼只在 A 片段里有轨道"而残留上一帧姿态（那正是动画跳变的常见来源）。
//
// 旋转约定（角色朝 +Z，手臂自然下垂）：
//   · 四肢绕 X 轴摆动：负角度 = 向前摆（朝 +Z）
//   · 膝盖只能向后弯：shin 用正角度
//   · 手肘向前弯：lowerArm 用负角度
//   · 手臂外展：L 用正 Z 角，R 用负 Z 角

import { BONE_ORDER } from './rig.js';

const DEG = Math.PI / 180;
const V = (rx = 0, ry = 0, rz = 0) => [rx * DEG, ry * DEG, rz * DEG];

const HIPS_Y = 0.98;

/** 完整的静止姿态（所有骨骼显式为 0，避免遗留）。 */
function basePose() {
  const p = {};
  for (const b of BONE_ORDER) p[b] = [0, 0, 0];
  return p;
}

function withArmsDown(extra = {}) {
  const p = basePose();
  return Object.assign(p, extra);
}

function finalize(THREE, name, duration, keys, opts = {}) {
  const times = keys.map((k) => k.t);
  const tracks = [];
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();

  for (const bone of BONE_ORDER) {
    const values = [];
    let dirty = false;
    for (const k of keys) {
      const rot = (k.pose && k.pose[bone]) || [0, 0, 0];
      if (rot[0] || rot[1] || rot[2]) dirty = true;
      euler.set(rot[0], rot[1], rot[2], 'XYZ');
      quat.setFromEuler(euler);
      values.push(quat.x, quat.y, quat.z, quat.w);
    }
    // 即使整段都不动也写进去：保证 crossfade 时该骨骼被显式复位
    if (dirty || bone === 'hips') {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
    }
  }

  // 髋部位置（含上下起伏）：所有片段都写，避免姿势互相污染
  const pos = [];
  for (const k of keys) {
    const y = Number.isFinite(k.hipsY) ? k.hipsY : HIPS_Y;
    const z = Number.isFinite(k.hipsZ) ? k.hipsZ : 0;
    pos.push(0, y, z);
  }
  tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, pos));

  const clip = new THREE.AnimationClip(name, duration, tracks);
  clip.userData = Object.assign({ loop: true, oneShot: false }, opts);
  if (opts.oneShot) {
    clip.userData.loop = false;
  }
  clip.optimize();
  return clip;
}

/** 循环片段：按采样点数把 pose(phase) 采样成关键帧，首尾对齐。 */
function cyclic(THREE, name, duration, samples, fn, opts = {}) {
  const keys = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = (i / samples) * duration;
    const phase = i / samples;
    const out = fn(phase) || {};
    keys.push({ t, pose: out.pose || out, hipsY: out.hipsY, hipsZ: out.hipsZ });
  }
  return finalize(THREE, name, duration, keys, Object.assign({ loop: true }, opts));
}

function keyframes(THREE, name, duration, frames, opts = {}) {
  const keys = frames.map((f) => ({
    t: f.t * duration,
    pose: f.pose,
    hipsY: f.hipsY,
    hipsZ: f.hipsZ,
  }));
  return finalize(THREE, name, duration, keys, opts);
}

// 瞄准基准姿态：持枪时右臂前伸、左臂托枪，躯干略转向左侧（让枪在右肩前）
function aimPose(t = 0) {
  const sway = Math.sin(t * Math.PI * 2) * 1.1;
  const p = basePose();
  p.chest = V(-4 + sway * 0.3, -12, 0);
  p.spine = V(-2, -4, 0);
  p.head = V(2, 10, 0);
  p.shoulderR = V(-6, 0, -8);
  p.upperArmR = V(-72 + sway, -6, -10);
  p.lowerArmR = V(-28, 0, 0);
  p.handR = V(0, 0, 0);
  p.shoulderL = V(-4, 0, 6);
  p.upperArmL = V(-64 + sway * 0.8, 12, 16);
  p.lowerArmL = V(-52, 0, 0);
  p.handL = V(0, -10, 0);
  p.thighL = V(-6, 0, 2);
  p.thighR = V(4, 0, -2);
  p.shinL = V(10, 0, 0);
  p.shinR = V(8, 0, 0);
  return p;
}

/**
 * 生成全部动画片段。
 * @returns {Record<string, THREE.AnimationClip>}
 */
export function buildClips(THREE) {
  const clips = {};

  // ── Idle：轻微呼吸 + 重心左右微移
  clips.idle = cyclic(THREE, 'idle', 3.0, 12, (p) => {
    const s = Math.sin(p * Math.PI * 2);
    const pose = basePose();
    pose.spine = V(-1.2 + s * 0.8, 0, 0);
    pose.chest = V(-1.5 - s * 1.2, s * 1.2, 0);
    pose.head = V(s * 1.2, s * 2.4, 0);
    pose.upperArmL = V(-2 - s * 1.5, 0, 4 + s * 1.2);
    pose.upperArmR = V(-2 - s * 1.5, 0, -4 - s * 1.2);
    pose.lowerArmL = V(-6 - s * 2, 0, 0);
    pose.lowerArmR = V(-6 - s * 2, 0, 0);
    pose.thighL = V(0, 0, 1.5);
    pose.thighR = V(0, 0, -1.5);
    return { pose, hipsY: HIPS_Y + s * 0.006 };
  });

  // ── Walk / Run / Sprint 共用同一个步态函数，只改振幅与频率
  const gait = (THREE, name, duration, amp, kneeAmp, armAmp, lean, bob) => cyclic(
    THREE, name, duration, 14,
    (p) => {
      const ph = p * Math.PI * 2;
      const s = Math.sin(ph);
      const c = Math.cos(ph);
      const pose = basePose();
      // 腿
      pose.thighL = V(-amp * s, 0, 2);
      pose.thighR = V(amp * s, 0, -2);
      pose.shinL = V(kneeAmp * (0.35 + Math.max(0, Math.sin(ph - 1.9))), 0, 0);
      pose.shinR = V(kneeAmp * (0.35 + Math.max(0, Math.sin(ph - 1.9 + Math.PI))), 0, 0);
      pose.footL = V(8 * s, 0, 0);
      pose.footR = V(-8 * s, 0, 0);
      // 手臂反相摆动
      pose.upperArmL = V(armAmp * s, 0, 5);
      pose.upperArmR = V(-armAmp * s, 0, -5);
      pose.lowerArmL = V(-18 - Math.max(0, armAmp * s * 0.5), 0, 0);
      pose.lowerArmR = V(-18 - Math.max(0, -armAmp * s * 0.5), 0, 0);
      // 躯干：前倾 + 反向扭转
      pose.spine = V(-lean * 0.35, -s * 3, 0);
      pose.chest = V(-lean * 0.65, s * 5, c * 1.2);
      pose.hips = V(0, -s * 4, 0);
      pose.neck = V(lean * 0.4, 0, 0);
      pose.head = V(lean * 0.25, s * 1.5, 0);
      const hipsY = HIPS_Y - bob * 0.5 + Math.cos(ph * 2) * bob;
      return { pose, hipsY };
    },
    { speedHint: name },
  );

  clips.walk = gait(THREE, 'walk', 1.05, 26, 34, 20, 4, 0.012);
  clips.run = gait(THREE, 'run', 0.78, 40, 58, 34, 9, 0.022);
  clips.sprint = gait(THREE, 'sprint', 0.63, 54, 74, 46, 15, 0.03);

  // ── Jump：下蹲蓄力 → 伸展起跳
  clips.jump = keyframes(THREE, 'jump', 0.52, [
    { t: 0, hipsY: HIPS_Y, pose: basePose() },
    { t: 0.28, hipsY: HIPS_Y - 0.16, pose: withArmsDown({ thighL: V(-42, 0, 3), thighR: V(-42, 0, -3), shinL: V(72, 0, 0), shinR: V(72, 0, 0), upperArmL: V(38, 0, 8), upperArmR: V(38, 0, -8), spine: V(-14, 0, 0), chest: V(-10, 0, 0) }) },
    { t: 0.62, hipsY: HIPS_Y + 0.06, pose: withArmsDown({ thighL: V(6, 0, 3), thighR: V(6, 0, -3), shinL: V(6, 0, 0), shinR: V(6, 0, 0), upperArmL: V(-108, 0, 14), upperArmR: V(-108, 0, -14), spine: V(4, 0, 0) }) },
    { t: 1, hipsY: HIPS_Y + 0.02, pose: withArmsDown({ thighL: V(-14, 0, 3), thighR: V(-6, 0, -3), shinL: V(26, 0, 0), shinR: V(16, 0, 0), upperArmL: V(-72, 0, 16), upperArmR: V(-72, 0, -16), spine: V(-4, 0, 0) }) },
  ], { oneShot: true });

  // ── Fall：滞空，双臂上扬，双腿微屈
  clips.fall = cyclic(THREE, 'fall', 0.9, 8, (p) => {
    const s = Math.sin(p * Math.PI * 2);
    return {
      pose: withArmsDown({
        upperArmL: V(-120 + s * 6, 0, 22), upperArmR: V(-120 - s * 6, 0, -22),
        lowerArmL: V(-34, 0, 0), lowerArmR: V(-34, 0, 0),
        thighL: V(-22 + s * 4, 0, 4), thighR: V(-6 - s * 4, 0, -4),
        shinL: V(38, 0, 0), shinR: V(18, 0, 0),
        spine: V(6, 0, 0), chest: V(4, s * 2, 0), head: V(-6, 0, 0),
      }),
      hipsY: HIPS_Y + 0.01,
    };
  });

  // ── Land：落地缓冲
  clips.land = keyframes(THREE, 'land', 0.34, [
    { t: 0, hipsY: HIPS_Y, pose: basePose() },
    { t: 0.45, hipsY: HIPS_Y - 0.13, pose: withArmsDown({ thighL: V(-34, 0, 3), thighR: V(-34, 0, -3), shinL: V(58, 0, 0), shinR: V(58, 0, 0), upperArmL: V(24, 0, 12), upperArmR: V(24, 0, -12), spine: V(-10, 0, 0) }) },
    { t: 1, hipsY: HIPS_Y, pose: basePose() },
  ], { oneShot: true });

  // ── Crouch：蹲伏（持续态）
  clips.crouch = cyclic(THREE, 'crouch', 2.2, 8, (p) => {
    const s = Math.sin(p * Math.PI * 2);
    return {
      pose: withArmsDown({
        thighL: V(-64, 0, 5), thighR: V(-64, 0, -5),
        shinL: V(96, 0, 0), shinR: V(96, 0, 0),
        footL: V(-32, 0, 0), footR: V(-32, 0, 0),
        spine: V(-18, 0, 0), chest: V(-10 + s * 0.6, 0, 0),
        upperArmL: V(-28, 0, 14), upperArmR: V(-28, 0, -14),
        lowerArmL: V(-44, 0, 0), lowerArmR: V(-44, 0, 0),
        head: V(14, 0, 0),
      }),
      hipsY: HIPS_Y - 0.36 + s * 0.004,
    };
  });

  // ── Aim：持枪瞄准（呼吸级微动）
  clips.aim = cyclic(THREE, 'aim', 2.4, 8, (p) => ({
    pose: aimPose(p),
    hipsY: HIPS_Y - 0.02,
  }));

  // ── Fire：以瞄准姿态为基准的后坐，一帧回到瞄准 → crossfade 回 aim 看不出跳变
  clips.fire = keyframes(THREE, 'fire', 0.26, [
    { t: 0, hipsY: HIPS_Y - 0.02, pose: aimPose(0) },
    {
      t: 0.16,
      hipsY: HIPS_Y - 0.015,
      pose: (() => {
        const p = aimPose(0);
        p.upperArmR = V(-84, -6, -10);
        p.lowerArmR = V(-14, 0, 0);
        p.chest = V(-8, -12, 0);
        p.head = V(-2, 10, 0);
        return p;
      })(),
    },
    { t: 1, hipsY: HIPS_Y - 0.02, pose: aimPose(0) },
  ], { oneShot: true });

  // ── Reload：左手下探取弹匣 → 回位
  clips.reload = keyframes(THREE, 'reload', 1.5, [
    { t: 0, hipsY: HIPS_Y - 0.02, pose: aimPose(0) },
    {
      t: 0.25,
      hipsY: HIPS_Y - 0.05,
      pose: (() => {
        const p = aimPose(0);
        p.upperArmL = V(-24, 10, 20);
        p.lowerArmL = V(-96, 0, 0);
        p.chest = V(-6, -18, 0);
        p.head = V(10, 6, 0);
        return p;
      })(),
    },
    {
      t: 0.62,
      hipsY: HIPS_Y - 0.03,
      pose: (() => {
        const p = aimPose(0);
        p.upperArmL = V(-58, 12, 18);
        p.lowerArmL = V(-70, 0, 0);
        p.chest = V(-8, -14, 0);
        return p;
      })(),
    },
    { t: 1, hipsY: HIPS_Y - 0.02, pose: aimPose(0) },
  ], { oneShot: true });

  // ── Melee：右手横扫
  clips.melee = keyframes(THREE, 'melee', 0.55, [
    { t: 0, hipsY: HIPS_Y, pose: basePose() },
    {
      t: 0.22,
      hipsY: HIPS_Y - 0.01,
      pose: withArmsDown({ chest: V(-4, 22, 0), upperArmR: V(-40, 0, -46), lowerArmR: V(-70, 0, 0), upperArmL: V(12, 0, 14), spine: V(-4, 12, 0), head: V(0, -14, 0) }),
    },
    {
      t: 0.42,
      hipsY: HIPS_Y - 0.02,
      pose: withArmsDown({ chest: V(-8, -26, 0), upperArmR: V(-86, 0, 16), lowerArmR: V(-30, 0, 0), upperArmL: V(20, 0, 10), spine: V(-6, -14, 0), head: V(0, 16, 0) }),
    },
    { t: 1, hipsY: HIPS_Y, pose: basePose() },
  ], { oneShot: true });

  // ── Hit：受击后仰
  clips.hit = keyframes(THREE, 'hit', 0.38, [
    { t: 0, hipsY: HIPS_Y, pose: basePose() },
    {
      t: 0.24,
      hipsY: HIPS_Y - 0.02,
      pose: withArmsDown({ spine: V(12, 0, 0), chest: V(10, 0, 0), head: V(16, 0, 0), upperArmL: V(26, 0, 16), upperArmR: V(26, 0, -16), thighL: V(10, 0, 2), thighR: V(-6, 0, -2) }),
    },
    { t: 1, hipsY: HIPS_Y, pose: basePose() },
  ], { oneShot: true });

  // ── Death：向后倒地（ClampWhenFinished，由动画系统停在最后一帧）
  clips.death = keyframes(THREE, 'death', 1.25, [
    { t: 0, hipsY: HIPS_Y, pose: basePose() },
    {
      t: 0.22,
      hipsY: HIPS_Y - 0.04,
      pose: withArmsDown({ spine: V(14, 0, 0), chest: V(16, 0, 0), head: V(22, 0, 0), upperArmL: V(48, 0, 26), upperArmR: V(48, 0, -26), thighL: V(-18, 0, 4), thighR: V(-14, 0, -4), shinL: V(30, 0, 0), shinR: V(26, 0, 0) }),
    },
    {
      t: 0.62,
      hipsY: 0.42,
      pose: withArmsDown({ hips: V(62, 0, 0), spine: V(8, 0, 0), chest: V(6, 0, 0), head: V(10, 0, 0), upperArmL: V(66, 0, 30), upperArmR: V(66, 0, -30), thighL: V(-34, 0, 6), thighR: V(-30, 0, -6), shinL: V(52, 0, 0), shinR: V(48, 0, 0) }),
    },
    {
      t: 1,
      hipsY: 0.20,
      pose: withArmsDown({ hips: V(88, 0, 0), spine: V(2, 0, 0), chest: V(0, 0, 0), head: V(-12, 0, 0), upperArmL: V(28, 0, 42), upperArmR: V(24, 0, -42), thighL: V(-12, 0, 8), thighR: V(-8, 0, -8), shinL: V(22, 0, 0), shinR: V(18, 0, 0) }),
    },
  ], { oneShot: true, clamp: true });

  // ── Interact：弯腰/伸手（拾取、开门）
  clips.interact = keyframes(THREE, 'interact', 0.72, [
    { t: 0, hipsY: HIPS_Y, pose: basePose() },
    {
      t: 0.4,
      hipsY: HIPS_Y - 0.07,
      pose: withArmsDown({ spine: V(-16, 6, 0), chest: V(-12, 8, 0), head: V(10, 0, 0), upperArmR: V(-58, 0, -8), lowerArmR: V(-30, 0, 0), thighL: V(-14, 0, 3), thighR: V(-10, 0, -3), shinL: V(22, 0, 0), shinR: V(18, 0, 0) }),
    },
    { t: 1, hipsY: HIPS_Y, pose: basePose() },
  ], { oneShot: true });

  // ── Carry：双手搬抬（后续扩展用，先保证片段存在且可用）
  clips.carry = cyclic(THREE, 'carry', 1.8, 8, (p) => {
    const s = Math.sin(p * Math.PI * 2);
    return {
      pose: withArmsDown({
        upperArmL: V(-78 + s * 1.5, 0, 22), upperArmR: V(-78 + s * 1.5, 0, -22),
        lowerArmL: V(-46, 0, 0), lowerArmR: V(-46, 0, 0),
        spine: V(-6, 0, 0), chest: V(-4, 0, 0),
        thighL: V(-8, 0, 3), thighR: V(-8, 0, -3), shinL: V(14, 0, 0), shinR: V(14, 0, 0),
      }),
      hipsY: HIPS_Y - 0.06,
    };
  });

  return clips;
}

/** 游戏状态 → 动画片段名。缺片段时 animator 会自动回退到这个表里的 fallback。 */
export const STATE_CLIPS = {
  idle: 'idle', walk: 'walk', run: 'run', sprint: 'sprint',
  jump: 'jump', fall: 'fall', land: 'land', crouch: 'crouch',
  aim: 'aim', fire: 'fire', reload: 'reload', melee: 'melee',
  hit: 'hit', death: 'death', interact: 'interact', carry: 'carry',
};

export const ONE_SHOT = new Set(['jump', 'land', 'fire', 'reload', 'melee', 'hit', 'interact']);

export default { buildClips, STATE_CLIPS, ONE_SHOT };
