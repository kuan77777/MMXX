// 球衣系统（数据层）：把"俱乐部配色 + 号码 + 姓名 + 图案"整理成一份 **与模型无关** 的 kit 描述，
// 再由各渲染端点各自适配：
//   · 3D 角色   → createKitTexture() 生成 canvas 图集，贴在 SkinnedMesh 的 UV 图集上；
//   · 2D 预览   → kitPreviewDataURL()，UI/背包里直接显示。
// 这样即使将来接 MiniJersey 的模型/编辑器，也只需要共享这份 descriptor（颜色/图案/号码），
// 不必让球衣编辑器与游戏角色共用同一套网格。
//
// 图集布局（v 轴从上到下）：pattern 上衣图案 | white 兜底白区 | back 背号区

const clamp01 = (v, f) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : f);

export const KIT_PATTERNS = ['solid', 'stripes', 'hoops', 'sash', 'halves', 'shoulders'];

export const KIT_UV = {
  pattern: { u0: 0, u1: 1, v0: 0.5, v1: 1.0 },
  white: { u0: 0, u1: 1, v0: 0.25, v1: 0.5 },
  back: { u0: 0, u1: 1, v0: 0.0, v1: 0.25 },
};

// 缺省配色：低饱和的"废土绿/灰"，与整体低多边形色调一致。
const FALLBACK_PRIMARY = '#3d6b52';
const FALLBACK_SECONDARY = '#e8e3d6';
const SUM = 0;

function parseHex(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const m = v.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h.toLowerCase()}`;
}

function hexToRgb(hex) {
  const h = parseHex(hex, FALLBACK_PRIMARY).slice(1);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function relLum(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 前景色自动取"能看清"的那个。 */
export function contrastOn(bgHex, a = '#ffffff', b = '#14161a') {
  return relLum(bgHex) > 0.42 ? b : a;
}

function hash32(str) {
  let h = 2166136261;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 球员没有号码字段（原始足球数据里就没有）→ 用 ID 派生一个稳定号码。 */
export function stableShirtNumber(playerId) {
  const n = hash32(`num:${playerId}`) % 40;
  return n === 0 ? 1 : n + 1; // 2..40
}

export function stableKitPattern(clubId, playerId) {
  return KIT_PATTERNS[hash32(`pat:${clubId}:${playerId}`) % KIT_PATTERNS.length];
}

/**
 * 构造 kit 描述。所有入参都可缺失。
 * @param {object} src {clubId, playerId, primary, secondary, number, name, pattern}
 */
export function makeKit(src = {}) {
  const primary = parseHex(src.primary, FALLBACK_PRIMARY);
  const secondary = parseHex(src.secondary, FALLBACK_SECONDARY);
  const pattern = KIT_PATTERNS.includes(src.pattern) ? src.pattern : stableKitPattern(src.clubId, src.playerId);
  const number = Number.isFinite(Number(src.number)) && Number(src.number) > 0
    ? Math.min(999, Math.floor(Number(src.number)))
    : stableShirtNumber(src.playerId);
  const name = (typeof src.name === 'string' && src.name.trim()) ? src.name.trim().slice(0, 12) : '幸存者';
  const shirt = primary;
  // 短裤/球袜取次色，但次色常常是纯白 —— 白色球袜在低多边形里很跳，压暗一点更统一
  const shorts = src.shorts ? parseHex(src.shorts, secondary) : secondary;
  const socks = src.socks ? parseHex(src.socks, secondary) : secondary;
  return {
    clubId: src.clubId != null ? String(src.clubId) : null,
    playerId: src.playerId != null ? String(src.playerId) : null,
    primary, secondary, shirt, shorts, socks,
    trim: src.trim ? parseHex(src.trim, secondary) : secondary,
    pattern, number, name,
    numberColor: src.numberColor ? parseHex(src.numberColor, '#ffffff') : contrastOn(shirt),
    nameColor: src.nameColor ? parseHex(src.nameColor, '#ffffff') : contrastOn(shirt, '#ffffff', '#e8e3d6'),
    // 皮肤/头发不在这里，属于 appearance（appearance.js 负责）
  };
}

/** 头像/球衣小预览用的纯色（2D 页面与 3D 用同一份取色逻辑）。 */
export function kitPreview(kit) {
  return { shirt: kit.shirt, shorts: kit.shorts, socks: kit.socks, number: kit.number, name: kit.name, pattern: kit.pattern };
}

function drawPattern(ctx, w, h, kit) {
  const { primary, secondary, pattern } = kit;
  ctx.fillStyle = primary;
  ctx.fillRect(0, 0, w, h);
  switch (pattern) {
    case 'stripes': {
      const bars = 9;
      const bw = w / bars;
      ctx.fillStyle = secondary;
      for (let i = 0; i < bars; i += 2) ctx.fillRect(i * bw, 0, bw, h);
      break;
    }
    case 'hoops': {
      const bars = 5;
      const bh = h / bars;
      ctx.fillStyle = secondary;
      for (let i = 0; i < bars; i += 2) ctx.fillRect(0, i * bh, w, bh);
      break;
    }
    case 'sash': {
      ctx.save();
      ctx.fillStyle = secondary;
      ctx.beginPath();
      ctx.moveTo(-w * 0.1, h);
      ctx.lineTo(w * 0.45, 0);
      ctx.lineTo(w * 0.75, 0);
      ctx.lineTo(w * 0.2, h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'halves': {
      ctx.fillStyle = secondary;
      ctx.fillRect(w / 2, 0, w / 2, h);
      break;
    }
    case 'shoulders': {
      ctx.fillStyle = secondary;
      ctx.fillRect(0, 0, w, h * 0.28);
      break;
    }
    case 'solid':
    default:
      break;
  }
  // 袖口/下摆细边：让纯色球衣也有"球衣感"
  ctx.fillStyle = kit.trim;
  ctx.fillRect(0, h - Math.max(2, h * 0.06), w, Math.max(2, h * 0.06));
}

function drawBackPanel(ctx, x, y, w, h, kit) {
  ctx.fillStyle = kit.shirt;
  ctx.fillRect(x, y, w, h);
  // 号码
  const numSize = Math.floor(h * 0.66);
  ctx.fillStyle = kit.numberColor;
  ctx.font = `bold ${numSize}px system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(kit.number), x + w * 0.5, y + h * 0.6);
  // 姓名（小字，压在号码上方）
  const nameSize = Math.max(9, Math.floor(h * 0.16));
  ctx.font = `600 ${nameSize}px system-ui, "Segoe UI", sans-serif`;
  ctx.fillStyle = kit.nameColor;
  ctx.fillText(kit.name, x + w * 0.5, y + h * 0.14);
}

/**
 * 把 kit 画进 256×256 图集。3D 与 2D 共用同一份绘制代码，保证"编辑器里看到的"和"角色身上穿的"一致。
 * @returns {HTMLCanvasElement}
 */
export function drawKitAtlas(kit, size = 256) {
  const canvas = (typeof document !== 'undefined')
    ? document.createElement('canvas')
    : null;
  if (!canvas) return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // 上半 = 图案区（v 0.5..1 → canvas y 0..size/2）
  drawPattern(ctx, size, size * 0.5, kit);
  // 第二块 = 纯白兜底区（所有非球衣部件的 UV 都落在这一块，配合顶点色出颜色）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, size * 0.5, size, size * 0.25);
  // 底部 = 背号区
  drawBackPanel(ctx, 0, size * 0.75, size, size * 0.25, kit);
  return canvas;
}

/** 供 UI 用的 dataURL 预览（带球衣轮廓，不含人体）。 */
export function kitPreviewDataURL(kit, size = 96) {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = kit.shorts;
  ctx.fillRect(size * 0.28, size * 0.52, size * 0.44, size * 0.34);
  ctx.fillStyle = kit.shirt;
  ctx.beginPath();
  ctx.moveTo(size * 0.22, size * 0.24);
  ctx.lineTo(size * 0.36, size * 0.16);
  ctx.lineTo(size * 0.64, size * 0.16);
  ctx.lineTo(size * 0.78, size * 0.24);
  ctx.lineTo(size * 0.7, size * 0.34);
  ctx.lineTo(size * 0.7, size * 0.58);
  ctx.lineTo(size * 0.3, size * 0.58);
  ctx.lineTo(size * 0.3, size * 0.34);
  ctx.closePath();
  ctx.fill();
  if (kit.pattern !== 'solid') {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = kit.secondary;
    if (kit.pattern === 'stripes' || kit.pattern === 'hoops') {
      for (let i = 0; i < 4; i += 1) {
        if (kit.pattern === 'stripes') ctx.fillRect(size * (0.3 + i * 0.12), size * 0.16, size * 0.06, size * 0.44);
        else ctx.fillRect(size * 0.22, size * (0.2 + i * 0.1), size * 0.6, size * 0.05);
      }
    }
    ctx.restore();
  }
  ctx.fillStyle = kit.numberColor;
  ctx.font = `bold ${Math.floor(size * 0.16)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(kit.number), size * 0.5, size * 0.4);
  return c.toDataURL('image/png');
}

/**
 * Three.js 贴图。**必须同步**：调用方直接把它赋给 material.map，
 * 如果这里返回 Promise，three 会把 Promise 当 Texture 用并在渲染时崩
 * （浏览器测试当时报的就是 Matrix3.copy(undefined)）。
 */
export function createKitTexture(kit, THREE, size = 256) {
  const canvas = drawKitAtlas(kit, size);
  if (!canvas || !THREE) return null;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export default { makeKit, KIT_PATTERNS, KIT_UV, drawKitAtlas, createKitTexture, stableShirtNumber, kitPreviewDataURL };
