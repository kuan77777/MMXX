// FW3D · 共用氛围层（Atmosphere）
// 目的：让"球场 / 回放 / 训练 / 替补席"共用同一套天空与雾的取色规则，消除"亮光照在黑天上、
// 草坪像漂在虚空里"的割裂感。低成本做法：1 个天空穹（1 draw call，不吃雾、不写深度）+ 一张
// 垂直渐变画布贴图，不使用 shader 注入或后处理，符合项目"低模、无后处理"的既定方向。
//
// 用法：
//   import { SKY_PRESETS, buildSkyDome } from '../atmosphere.js';
//   const sky = buildSkyDome(THREE, SKY_PRESETS.dayStadium, { radius: 440 });
//   scene.add(sky.mesh);
//   scene.fog = new THREE.Fog(sky.fogColor, 150, 440);
//   scene.background = new THREE.Color(sky.horizonColor);

/**
 * 天空预设。所有预设都遵循同一条规则：
 *   - top 最深（天顶），horizon 最浅（地平线雾霾），glow 是地平线附近的一圈低强度暖/冷光。
 *   - fog 与 horizon 接近，保证远处看台能"溶进"天际线，而不是撞到一块黑边。
 * 四个球场共用 dayStadium 的明度结构，只在地平线色相上区分身份（见 stadium-kinds.js）。
 */
export const SKY_PRESETS = {
  // 日间球场：与 arena.js 现有 hemi 1.45 / dir 2.4 的"白天光照"匹配
  dayStadium: { top: '#4d84b8', mid: '#8fb6d6', horizon: '#d3e2ec', glow: '#fff2d8', fog: '#c2d3e0' },
  // 黄昏球场：低角度暖光，社区球场用
  duskStadium: { top: '#2a3b5e', mid: '#7a6c86', horizon: '#e0a273', glow: '#ffcf9a', fog: '#8e8a94' },
  // 夜场：泛光灯比赛用（当前场地光照偏亮，这个预设有意保留给后续"夜场模式"）
  nightStadium: { top: '#070c14', mid: '#101c2c', horizon: '#22384f', glow: '#7fb3e0', fog: '#16212e' },
  // 训练场：日间但更淡、更少对比，避免长时间盯着刺眼
  training: { top: '#6d9ecb', mid: '#a9c8de', horizon: '#dde9ef', glow: '#fffaf0', fog: '#cfe0e8' },
  // 室内（荣誉室 / 更衣室）：几乎没有天空，只有一点环境渐变，用在墙壁外的"虚拟远景"
  interior: { top: '#0c0f14', mid: '#141922', horizon: '#1d232d', glow: '#2a3340', fog: '#12161d' },
};

/**
 * 生成天空穹。返回 { mesh, fogColor, horizonColor, skyColor, dispose }。
 * @param {object} THREE
 * @param {object} preset SKY_PRESETS 里的一项
 * @param {object} [opts] { radius=420, segments=24, bands=[...] } bands 覆盖渐变停靠点
 */
export function buildSkyDome(THREE, preset, opts = {}) {
  const p = preset || SKY_PRESETS.dayStadium;
  const radius = opts.radius || 420;

  // 1 × 256 垂直渐变：v=0 在地平线，v=1 在天顶（THREE.SphereGeometry 的 uv.y 从南极到北极）
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, H, 0, 0);   // 0 行 = 地平线（贴图底部）
  g.addColorStop(0, p.horizon);
  g.addColorStop(0.28, p.horizon);
  g.addColorStop(0.46, p.mid);
  g.addColorStop(1, p.top);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, H);

  // 地平线光带：低强度，只在 0..0.22 段加一点点色温，模拟城市/看台反光
  if (p.glow) {
    const g2 = ctx.createLinearGradient(0, H, 0, H * 0.78);
    g2.addColorStop(0, hexAlpha(p.glow, 0.30));
    g2.addColorStop(1, hexAlpha(p.glow, 0));
    ctx.fillStyle = g2;
    ctx.fillRect(0, H * 0.78, 2, H * 0.22);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  const geo = new THREE.SphereGeometry(radius, opts.segments || 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.56);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.BackSide,
    depthWrite: false,     // 不写深度：永远在最后面，不参与遮挡
    fog: false,            // 不吃雾：否则远距离会整块糊成雾色
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    skyColor: p.top,
    horizonColor: p.horizon,
    fogColor: p.fog || p.horizon,
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}

/** #rrggbb + alpha → rgba() 字符串（只用于画布渐变，不涉及渲染材质） */
function hexAlpha(hex, a) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  return 'rgba(' + r + ',' + gg + ',' + b + ',' + a + ')';
}

/**
 * 球场身份 → 天空预设。四个球场共用同一套明度结构，只改地平线色相：
 * community 黄昏暖、athletics 日间中性、bowl 日间偏冷、oval 夜里偏冷紫。
 * 目的：风格统一（同一款游戏）但一眼能认出场馆。
 */
export function skyForKind(kind) {
  if (kind === 'dusk' || kind === 'community') return SKY_PRESETS.duskStadium;
  if (kind === 'night') return SKY_PRESETS.nightStadium;
  if (kind === 'training') return SKY_PRESETS.training;
  if (kind === 'interior') return SKY_PRESETS.interior;
  return SKY_PRESETS.dayStadium;
}

// ─────────────────────────────────────────────────────────────
// 灯光取色：也和主场球衣颜色走（用户要求"灯光设计也要和主场球衣主色调一致"）
// 原则：队色只作为**色温偏移**，不把整场染成一块颜色 ——
//   太阳/泛光灯仍是白光为主（保留 80–88% 中性白），队色占 12–20%；
//   半球光的天空色 / 地面反弹色队色占比稍高（20–45%），因为它是"环境气氛"。
//   这样四支球队的场地一眼能感到"光线不一样"，但草皮仍是绿的、球员颜色不会被带偏。
// ─────────────────────────────────────────────────────────────

/** 两个 #rrggbb 按 t 混合（t=0 取 a，t=1 取 b）。不依赖 THREE，纯字符串运算。 */
export function mixHex(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  const k = Math.max(0, Math.min(1, t));
  const c = (i) => Math.round(pa[i] * (1 - k) + pb[i] * k);
  const hex = (v) => v.toString(16).padStart(2, '0');
  return '#' + hex(c(0)) + hex(c(1)) + hex(c(2));
}

function parseHex(h) {
  const s = String(h == null ? '#ffffff' : h).replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 由队色派生灯光色板。
 * @param {string} primary 主色（球衣主色）
 * @param {string} secondary 辅色（球衣次色）
 * @returns {{sun:string, sky:string, ground:string, flood:string, warm:string, rim:string}}
 */
export function lightingFor(primary, secondary) {
  const p = primary || '#1f7a3f';
  const s = secondary || '#f2f4f7';
  return {
    // 主光：白光 88% + 队色 12%，只做色温偏移
    sun: mixHex(p, '#fff6e8', 0.88),
    // 半球光天空色：队色 20%
    sky: mixHex(p, '#e6eeff', 0.80),
    // 半球光地面反弹：队色 45%，让看台与草皮的暗部带上主场色
    ground: mixHex(p, '#203018', 0.55),
    // 泛光灯：辅色 28%（球衣次色常常是白/亮色，泛光灯偏它更自然）
    flood: mixHex(s, '#e8f2ff', 0.72),
    // 场馆暖光（看台顶灯/通道顶灯）：队色 20%
    warm: mixHex(p, '#fff2d6', 0.80),
    // 出口/边缘光：辅色 45%
    rim: mixHex(s, '#ffffff', 0.55),
  };
}
