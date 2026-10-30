// FW3D AI · 数学工具（无 THREE 依赖，可在 Node 直接跑）
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const sat = (v) => clamp(v, 0, 1);
export const norm = (v, a, b) => sat((v - a) / ((b - a) || 1));
export const lerp = (a, b, t) => a + (b - a) * t;
export const inv = (v) => 1 - sat(v);
export const len = (x, z) => Math.hypot(x, z);
export const dist = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);
export const distOf = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
export const rand = (a, b) => a + Math.random() * (b - a);
export const smoothstep = (t) => { const x = sat(t); return x * x * (3 - 2 * x); };

// 钟形：中心 best，半宽 width，超出为 0
export const bell = (v, best, width) => sat(1 - Math.abs(v - best) / (width || 1));

// 两角差（-π..π）
export const angDiff = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
export const angLerp = (a, b, t) => a + angDiff(a, b) * sat(t);

// 稳定伪随机 0..1：同一个 seed 每次都一样（用于球员属性抖动，不能用 Math.random）
export function hash01(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 标准正态（执行误差用）
export function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 朝目标靠近但不超过
export const approach = (cur, target, maxDelta) => {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
};

// 归一化后的加权和：weights 自动归一，缺项按 0 计
export function blend(parts) {
  let sum = 0, wsum = 0;
  for (const p of parts) {
    if (!p || !isFinite(p.w) || p.w <= 0) continue;
    const v = isFinite(p.v) ? sat(p.v) : 0;
    sum += v * p.w; wsum += p.w;
  }
  return wsum > 0 ? sat(sum / wsum) : 0;
}

// 二维向量工具
export const vadd = (a, bx, bz) => ({ x: a.x + bx, z: a.z + bz });
export const vsub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
export const vmul = (a, k) => ({ x: a.x * k, z: a.z * k });
export const vlen = (a) => Math.hypot(a.x, a.z);
export function vnorm(a) {
  const l = Math.hypot(a.x, a.z);
  return l < 1e-6 ? { x: 0, z: 0 } : { x: a.x / l, z: a.z / l };
}
export const vdot = (a, b) => a.x * b.x + a.z * b.z;
export const vlerp = (a, b, t) => ({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
export const vdist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
// 绕 Y 轴旋转（与 Three.js 的 Y 轴旋转同向）
export const vrot = (a, ang) => ({
  x: a.x * Math.cos(ang) - a.z * Math.sin(ang),
  z: a.x * Math.sin(ang) + a.z * Math.cos(ang),
});
