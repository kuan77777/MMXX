// 地图渲染层（小地图 + 大地图）。
//
// 分工：ui/map-data.js 出数据（纯函数、可单测），这里只做 canvas 绘制与交互。
// 绘制模型：
//   · 底图（地形/土地覆盖/河网）是一次性烘好的位图，每帧只画一次 drawImage；
//   · 矢量要素（道路/建筑/树/围栏）在"米空间"里按当前视图变换直接画，
//     所以放大不会糊，缩小也不会消失；
//   · 动态标记（玩家/感染者/车辆/地点）在屏幕空间里画，尺寸固定、不随缩放变粗。
//
// 交互：小地图点一下 = 打开大地图；大地图拖动画布平移、滚轮缩放、双击回到玩家。
// 大地图打开时游戏会暂停（见 core/game.js 的 paused 判定），和背包/搜刮保持一致。

import {
  MAP_LIMITS, MAP_PALETTE, MARKER_STYLE, DISTRICT_FILL, DISTRICT_LABELS,
  makeMapBounds, bakeTerrainRaster, collectStaticFeatures, buildMarkers,
  makeView, rectInAabb, pointInAabb, districtStyle, formatDistance,
} from './map-data.js';

const TAU = Math.PI * 2;
const FONT = 'ui-monospace, "Cascadia Mono", Consolas, "Noto Sans SC", monospace';
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function pixelRatio() {
  if (typeof window === 'undefined') return 1;
  return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

const LEGEND_ROWS = [
  { color: MAP_PALETTE.player, shape: 'arrow', label: '你（朝向 = 镜头方向）' },
  { color: MAP_PALETTE.zombie, shape: 'dot', label: '感染者（游荡）' },
  { color: MAP_PALETTE.zombieAlert, shape: 'dot', label: '感染者（已惊动，正在追你）' },
  { color: MAP_PALETTE.hostile, shape: 'dot', label: '掠夺者' },
  { color: MAP_PALETTE.friendly, shape: 'dot', label: '幸存者' },
  { color: MAP_PALETTE.carDrivable, shape: 'square', label: '可驾驶车辆' },
  { color: MAP_PALETTE.car, shape: 'square', label: '报废车辆' },
  { color: MAP_PALETTE.poi, shape: 'diamond', label: '地点' },
  { color: MAP_PALETTE.quest, shape: 'star', label: '任务目标' },
];

const LEGEND_TERRAIN = [
  { color: '#344a34', label: '林地' },
  { color: '#4c5e3e', label: '草地 / 灌木' },
  { color: '#606042', label: '耕地' },
  { color: '#646460', label: '建成区' },
  { color: '#2e5266', label: '水体' },
];

// 街区图例直接从配色表生成：改 DISTRICT_FILL 时图例不会忘改
const LEGEND_DISTRICTS = Object.entries(DISTRICT_FILL)
  .map(([k, v]) => ({ color: v.fill, label: DISTRICT_LABELS[k] || k }));

const LEGEND_ROADS = [
  { color: '#c9a96b', label: '高速 / 国道' },
  { color: '#9a9a8a', label: '县道 / 街道' },
  { color: '#5b6761', label: '小路 / 步行道' },
  { color: '#41474b', label: '镇内街区道路' },
];

export class MapSystem {
  /**
   * @param {object} handlers {
   *   onRequestOpen(): 玩家点了小地图
   *   onRequestClose(): 玩家点了大地图的关闭按钮
   * }
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.root = null;
    this.mmEl = null;
    this.mmCanvas = null;
    this.mmStatsEl = null;
    this.screenEl = null;
    this.mapCanvas = null;
    this.mapStatsEl = null;
    this.mapCoordsEl = null;
    this._zoomEl = null;
    this._built = false;

    this.bounds = null;
    this.features = null;
    this.terrain = null;
    this.rasterSummary = null;
    this._rasterCanvas = null;
    this._ready = false;
    this._buildingsByDistrict = new Map();

    this.open = false;
    this.center = { x: 0, z: 0 };
    this.zoom = 1;
    this._fitScale = 1;
    this.mapSize = { w: 900, h: 560 };
    this._follow = true;
    this._panIntent = { right: 0, up: 0 };
    this._t = 0;
    this._mmAcc = 0;
    this._mapAcc = 0;
    this._markers = [];
    this._markersFull = [];
    this._stats = this._emptyStats();
    this._statsFull = this._emptyStats();
    this._lastPlayer = { x: 0, z: 0, yaw: 0 };
    this._edgeZombies = [];
    this._view = null;
    this._dragging = null;
    this._hover = null;
    this._onResize = null;
    this._onPointerDown = null;
    this._onPointerMove = null;
    this._onPointerUp = null;
    this._onWheel = null;
    this._onDblClick = null;
  }

  _emptyStats() {
    return { zombies: 0, alert: 0, hostiles: 0, friendlies: 0, cars: 0, nearestZombie: null, nearestHostile: null };
  }

  get ready() { return this._ready; }

  // ── DOM ───────────────────────────────────────────────
  /**
   * @param {HTMLElement} root   #dd-root
   * @param {HTMLElement} hud    小地图挂进 HUD（这样隐藏 HUD 时小地图一起隐藏）
   */
  mount(root, hud) {
    if (this._built) return this;
    this.root = root;
    const size = MAP_LIMITS.minimapSize;

    const mm = document.createElement('div');
    mm.className = 'dd-minimap';
    mm.id = 'dd-minimap';
    mm.title = '小地图 · 点击或按 M 打开大地图';
    mm.innerHTML = `
      <canvas class="dd-minimap-canvas" id="dd-minimap-canvas" width="${size}" height="${size}"></canvas>
      <div class="dd-minimap-rim" aria-hidden="true"></div>
      <div class="dd-minimap-key"><span class="dd-kbd">M</span>地图</div>
      <div class="dd-minimap-stats" id="dd-minimap-stats">未载入</div>`;
    (hud || root).appendChild(mm);
    this.mmEl = mm;
    this.mmCanvas = mm.querySelector('#dd-minimap-canvas');
    this.mmStatsEl = mm.querySelector('#dd-minimap-stats');

    const screen = document.createElement('div');
    screen.className = 'dd-map-screen';
    screen.id = 'dd-map-screen';
    screen.style.display = 'none';
    screen.innerHTML = `
      <div class="dd-map-box dd-panel">
        <div class="dd-map-head">
          <div class="dd-map-title">
            <div class="dd-title">区域地图</div>
            <div class="dd-map-stats" id="dd-map-stats">—</div>
          </div>
          <div class="dd-map-tools">
            <button class="dd-btn dd-map-btn" data-act="zoom-out" title="缩小（滚轮向下）">−</button>
            <span class="dd-map-zoom" id="dd-map-zoom">1.0×</span>
            <button class="dd-btn dd-map-btn" data-act="zoom-in" title="放大（滚轮向上）">+</button>
            <button class="dd-btn" data-act="center" title="回到玩家（双击画布同效）">回到玩家</button>
            <button class="dd-btn" data-act="close" title="关闭（M / Esc）">关闭</button>
          </div>
        </div>
        <div class="dd-map-body">
          <div class="dd-map-canvas-wrap">
            <canvas class="dd-map-canvas" id="dd-map-canvas"></canvas>
            <div class="dd-map-coords" id="dd-map-coords">把鼠标移到地图上查看坐标</div>
          </div>
          <div class="dd-map-side">
            ${this._legendHtml()}
          </div>
        </div>
        <div class="dd-map-foot">
          拖动平移 · 滚轮缩放 · <span class="dd-kbd">W</span><span class="dd-kbd">A</span><span class="dd-kbd">S</span><span class="dd-kbd">D</span> 平移 ·
          双击回到玩家 · <span class="dd-kbd">M</span> / <span class="dd-kbd">Esc</span> 关闭（打开地图时游戏暂停）
        </div>
      </div>`;
    (root || document.body).appendChild(screen);
    this.screenEl = screen;
    this.mapCanvas = screen.querySelector('#dd-map-canvas');
    this.mapStatsEl = screen.querySelector('#dd-map-stats');
    this.mapCoordsEl = screen.querySelector('#dd-map-coords');
    this._zoomEl = screen.querySelector('#dd-map-zoom');

    this._bindDom(mm, screen);
    this._built = true;
    return this;
  }

  _legendHtml() {
    const dot = (color, shape) => `<span class="dd-map-swatch dd-map-shape-${shape}" style="--sw:${color}"></span>`;
    const box = (color) => `<span class="dd-map-swatch" style="--sw:${color}"></span>`;
    const rows = (list, fmt) => list.map((r) => `<div class="dd-map-leg-row">${fmt(r)}<span>${r.label}</span></div>`).join('');
    return `
      <div class="dd-map-leg">
        <div class="dd-section">标记</div>
        ${rows(LEGEND_ROWS, (r) => dot(r.color, r.shape))}
        <div class="dd-section">地形</div>
        ${rows(LEGEND_TERRAIN, (r) => box(r.color))}
        <div class="dd-section">街区（建筑底色）</div>
        ${rows(LEGEND_DISTRICTS, (r) => box(r.color))}
        <div class="dd-section">道路</div>
        ${rows(LEGEND_ROADS, (r) => box(r.color))}
      </div>`;
  }

  _bindDom(mm, screen) {
    mm.addEventListener('click', () => { if (this.h.onRequestOpen) this.h.onRequestOpen(); });

    screen.addEventListener('click', (e) => {
      // 点面板外面（暗色遮罩）也关掉，和大多数全屏面板的习惯一致
      if (e.target === screen) { if (this.h.onRequestClose) this.h.onRequestClose(); return; }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'close') { if (this.h.onRequestClose) this.h.onRequestClose(); }
      else if (act === 'zoom-in') this.zoomBy(1);
      else if (act === 'zoom-out') this.zoomBy(-1);
      else if (act === 'center') this.recenter();
    });

    const cv = this.mapCanvas;
    this._onPointerDown = (e) => {
      if (!this.open || e.button !== 0) return;
      this._dragging = { x: e.clientX, y: e.clientY, cx: this.center.x, cz: this.center.z };
      this._follow = false;
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 少数浏览器不支持 */ } }
      e.preventDefault();
    };
    this._onPointerMove = (e) => {
      if (!this.open) return;
      const rect = cv.getBoundingClientRect();
      if (this._dragging) {
        const scale = this._fitScale * this.zoom;
        this.center = {
          x: this._dragging.cx - (e.clientX - this._dragging.x) / scale,
          z: this._dragging.cz - (e.clientY - this._dragging.y) / scale,
        };
        this._clampCenter();
        return;
      }
      this._hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._updateCoords();
    };
    this._onPointerUp = (e) => {
      if (!this._dragging) return;
      this._dragging = null;
      if (cv.releasePointerCapture) { try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    };
    this._onWheel = (e) => {
      if (!this.open) return;
      e.preventDefault();
      // 必须拦住冒泡：输入层也在 document 上听 wheel（拿来切枪），
      // 不拦的话一次滚轮会被缩放两次。
      e.stopPropagation();
      this.zoomBy(e.deltaY > 0 ? -1 : 1);
    };
    this._onDblClick = () => { if (this.open) this.recenter(); };

    cv.addEventListener('pointerdown', this._onPointerDown);
    cv.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    cv.addEventListener('wheel', this._onWheel, { passive: false });
    cv.addEventListener('dblclick', this._onDblClick);

    this._onResize = () => { if (this.open) this._syncCanvasSize(true); };
    window.addEventListener('resize', this._onResize);
  }

  // ── 世界数据 ──────────────────────────────────────────
  /**
   * 把一张新地图烘成底图 + 矢量要素。新开一局/读档都会重来一次。
   * 一次性的开销（约 100~200ms，全在加载界面里），之后每帧只画标记。
   */
  async prepare({ layout, terrain, roadNet, seed } = {}) {
    this._ready = false;
    this._rasterCanvas = null;
    this.bounds = makeMapBounds({ terrain, layout, roadNet });
    this.features = collectStaticFeatures({ layout, terrain, roadNet, bounds: this.bounds });
    this.terrain = terrain || null;

    this._buildingsByDistrict = new Map();
    for (const b of this.features.buildings) {
      const key = b.district || 'residential';
      if (!this._buildingsByDistrict.has(key)) this._buildingsByDistrict.set(key, []);
      this._buildingsByDistrict.get(key).push(b);
    }

    const raster = bakeTerrainRaster(terrain, this.bounds, { seed });
    // 让"绘制地图…"这行加载文案先刷出来，再干重活
    await new Promise((r) => (typeof setTimeout === 'function' ? setTimeout(r, 0) : r()));

    if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas');
      cv.width = raster.width;
      cv.height = raster.height;
      const ctx = cv.getContext('2d');
      if (ctx && ctx.createImageData) {
        const img = ctx.createImageData(raster.width, raster.height);
        img.data.set(raster.pixels);
        ctx.putImageData(img, 0, 0);
        this._rasterCanvas = cv;
      }
    }

    this.rasterSummary = { width: raster.width, height: raster.height, hasTerrain: raster.hasTerrain };
    this.center = { x: 0, z: 0 };
    this.zoom = 1;
    this._follow = true;
    this._ready = true;
    if (this.open) this._syncCanvasSize(true);
    return this.rasterSummary;
  }

  clear() {
    this._ready = false;
    this._rasterCanvas = null;
    this.features = null;
    this.bounds = null;
    this.rasterSummary = null;
    this._markers = [];
    this._markersFull = [];
    this._stats = this._emptyStats();
    this._statsFull = this._emptyStats();
    this._edgeZombies = [];
    if (this.mmStatsEl) {
      this.mmStatsEl.textContent = '未载入';
      this.mmStatsEl.classList.remove('dd-alert');
    }
    if (this.mmEl) this.mmEl.classList.remove('dd-danger', 'dd-hunt');
    this.hide();
  }

  /** 供 selfTest / 测试读取的一份摘要（"地图上到底画了多少东西"）。 */
  summary() {
    const f = this.features;
    return {
      ready: this._ready,
      source: this.bounds ? this.bounds.source : null,
      size: this.bounds ? Math.round(this.bounds.width) : 0,
      raster: this.rasterSummary || null,
      buildings: f ? f.buildings.length : 0,
      streets: f ? f.streets.length : 0,
      roads: f ? f.netRoads.length : 0,
      trees: f ? f.trees.length : 0,
      pois: f ? f.pois.length : 0,
      markers: this._markersFull.length,
      zombies: this._statsFull.zombies,
    };
  }

  // ── 开 / 关 ───────────────────────────────────────────
  show(state) {
    if (!this._ready || !this.screenEl) return false;
    if (state) this._ingest(state);
    this.open = true;
    this.screenEl.style.display = 'flex';
    if (this.mmEl) this.mmEl.classList.add('dd-hidden');
    this._follow = true;
    this.center = { x: this._lastPlayer.x, z: this._lastPlayer.z };
    this._syncCanvasSize(true);
    this.zoom = this._defaultZoom();
    this._clampCenter();
    this.drawBigMap();
    this._updatePanel();
    return true;
  }

  hide() {
    if (!this.open) return false;
    this.open = false;
    this._dragging = null;
    if (this.screenEl) this.screenEl.style.display = 'none';
    if (this.mmEl) this.mmEl.classList.remove('dd-hidden');
    this._mmAcc = 1; // 下一帧立刻补画一次小地图（关闭大地图后不能停在旧画面上）
    return true;
  }

  recenter() {
    this._follow = true;
    this.center = { x: this._lastPlayer.x, z: this._lastPlayer.z };
    this._clampCenter();
    if (this.open) this.drawBigMap();
  }

  zoomBy(steps) {
    if (!steps) return;
    this.zoom = clamp(this.zoom * Math.pow(1.18, steps), MAP_LIMITS.zoomMin, MAP_LIMITS.zoomMax);
    if (this.open) { this.drawBigMap(); this._updateZoomLabel(); }
  }

  /** -1..1 的平移意图（WASD 按住时由 game.js 每帧写进来）。 */
  setPanIntent(right, up) {
    this._panIntent = { right: right || 0, up: up || 0 };
  }

  get metersPerPixel() { return 1 / Math.max(1e-6, this._fitScale * this.zoom); }

  _defaultZoom() {
    // 打开时让"镇区 + 周边"占满视野（约 520m 宽），而不是一上来就是 2.4km 的一张纸
    const want = Math.min(this.mapSize.w, this.mapSize.h) / 520;
    return clamp(want / Math.max(1e-6, this._fitScale), MAP_LIMITS.zoomMin, MAP_LIMITS.zoomMax);
  }

  _clampCenter() {
    const b = this.bounds;
    if (!b) return;
    this.center.x = clamp(this.center.x, b.minX, b.maxX);
    this.center.z = clamp(this.center.z, b.minZ, b.maxZ);
  }

  _syncCanvasSize(force = false) {
    const cv = this.mapCanvas;
    if (!cv || !this.bounds) return;
    const w = Math.max(120, Math.round(cv.clientWidth || 900));
    const h = Math.max(120, Math.round(cv.clientHeight || 560));
    if (!force && w === this.mapSize.w && h === this.mapSize.h) return;
    this.mapSize = { w, h };
    const dpr = pixelRatio();
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    this._fitScale = Math.min(w / Math.max(1, this.bounds.width), h / Math.max(1, this.bounds.depth));
    this.drawBigMap();
    this._updateZoomLabel();
  }

  // ── 每帧 ──────────────────────────────────────────────
  /**
   * @param {number} dt 真实帧间隔（暂停时也要传，否则地图不动）
   * @param {object} state {player, npcs, cars, poi, quest, driving}
   */
  update(dt, state) {
    if (!this._ready) return;
    this._t += dt;
    // 玩家位置/朝向每帧都要新鲜（跟随时视口不能抖），标记按 30Hz 重建就够了
    if (state) this._ingestPlayer(state);

    if (this.open) {
      const pan = this._panIntent;
      if (pan.right || pan.up) {
        // 平移速度按"屏幕像素/秒"换算成米，缩放越大走得越慢（手感才一致）
        const speed = 620 * this.metersPerPixel * dt;
        this.center = {
          x: this.center.x + pan.right * speed,
          z: this.center.z - pan.up * speed,
        };
        this._follow = false;
        this._clampCenter();
      }
      this._panIntent = { right: 0, up: 0 };
      this._mapAcc += dt;
      if (this._mapAcc >= 1 / MAP_LIMITS.bigmapHz) {
        this._mapAcc = 0;
        if (state) this._ingestMarkers(state);
        this.drawBigMap();
        this._updatePanel();
      }
    }

    this._mmAcc += dt;
    // 大地图打开时小地图是隐藏的，没必要还画一遍
    if (!this.open && this._mmAcc >= 1 / MAP_LIMITS.minimapHz) {
      this._mmAcc = 0;
      if (state) this._ingestMarkers(state);
      this.drawMinimap();
      this._updateMinimapStats();
    }
  }

  _ingestPlayer(state) {
    const p = (state && state.player) || {};
    this._lastPlayer = {
      x: Number.isFinite(p.x) ? p.x : this._lastPlayer.x,
      z: Number.isFinite(p.z) ? p.z : this._lastPlayer.z,
      yaw: Number.isFinite(p.yaw) ? p.yaw : this._lastPlayer.yaw,
    };
    if (this._follow && this.open) this.center = { x: this._lastPlayer.x, z: this._lastPlayer.z };
  }

  _ingest(state) {
    this._ingestPlayer(state);
    this._ingestMarkers(state);
  }

  _ingestMarkers(state) {
    const near = buildMarkers(state, { range: MAP_LIMITS.minimapRange });
    this._markers = near.markers;
    this._stats = near.stats;
    const full = buildMarkers(state, { range: null });
    this._markersFull = full.markers;
    this._statsFull = full.stats;

    // 小地图外圈的"小地图之外还有感染者"指示（只看最近的 6 个，避免刷屏）
    const out = [];
    const p = this._lastPlayer;
    for (const n of state.npcs || []) {
      if (!n || n.alive === false || n.type !== 'zombie') continue;
      if (!Number.isFinite(n.x) || !Number.isFinite(n.z)) continue;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d <= MAP_LIMITS.minimapRange || d > MAP_LIMITS.minimapRange * 2.2) continue;
      out.push({ x: n.x, z: n.z, d, alert: n.state === 'chase' || n.state === 'attack' || n.state === 'engage' });
    }
    out.sort((a, b) => a.d - b.d);
    this._edgeZombies = out.slice(0, 6);
  }

  // ── 小地图 ────────────────────────────────────────────
  drawMinimap() {
    const cv = this.mmCanvas;
    if (!cv || !this._ready || !this.bounds) return;
    const size = MAP_LIMITS.minimapSize;
    const dpr = pixelRatio();
    const pw = Math.round(size * dpr);
    if (cv.width !== pw || cv.height !== pw) { cv.width = pw; cv.height = pw; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const half = size / 2;
    const p = this._lastPlayer;
    const range = MAP_LIMITS.minimapRange;
    const scale = (half - 6) / range;
    const view = makeView({
      bounds: this.bounds, center: { x: p.x, z: p.z },
      scale, rotation: p.yaw + Math.PI, width: size, height: size,
    });

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 3, 0, TAU);
    ctx.clip();
    ctx.fillStyle = MAP_PALETTE.void;
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    view.applyToContext(ctx, dpr);
    this._drawStatic(ctx, view, 'minimap');
    ctx.restore();

    // 边缘压暗：让中心（玩家周围）更清楚
    const grad = ctx.createRadialGradient(half, half, half * 0.52, half, half, half);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    this._drawMarkers(ctx, view, { labels: false, edge: true, full: false });
    ctx.restore();

    // 边框 + 北向刻度
    ctx.beginPath();
    ctx.arc(half, half, half - 3, 0, TAU);
    ctx.strokeStyle = 'rgba(150, 175, 190, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const n = view.worldToScreen(p.x, p.z - 100);
    const nd = { x: n.x - half, y: n.y - half };
    const nlen = Math.hypot(nd.x, nd.y) || 1;
    const nx = half + (nd.x / nlen) * (half - 11);
    const ny = half + (nd.y / nlen) * (half - 11);
    ctx.font = `bold 9px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = MAP_PALETTE.shadow;
    ctx.fillText('N', nx + 0.5, ny + 0.5);
    ctx.fillStyle = 'rgba(224, 163, 74, 0.95)';
    ctx.fillText('N', nx, ny);
  }

  _updateMinimapStats() {
    if (!this.mmStatsEl) return;
    const s = this._stats;
    if (!this._ready) { this.mmStatsEl.textContent = '未载入'; return; }
    const near = s.nearestZombie == null ? '' : ` · 最近 ${formatDistance(s.nearestZombie)}`;
    const danger = s.zombies > 0;
    const hunting = s.alert > 0;
    this.mmStatsEl.classList.toggle('dd-alert', danger);
    // 边框：附近有感染者 → 泛红；有感染者正在追你 → 更亮的红 + 呼吸光晕
    if (this.mmEl) {
      this.mmEl.classList.toggle('dd-danger', danger);
      this.mmEl.classList.toggle('dd-hunt', hunting);
    }
    this.mmStatsEl.innerHTML = `感染者 <b>${s.zombies}</b>${s.alert ? `（追 <b>${s.alert}</b>）` : ''}${near}`;
    this.mmStatsEl.title = `半径 ${MAP_LIMITS.minimapRange}m 内：感染者 ${s.zombies} 个（其中 ${s.alert} 个正在追你）· `
      + `掠夺者 ${s.hostiles} · 幸存者 ${s.friendlies} · 车辆 ${s.cars}`;
  }

  // ── 大地图 ────────────────────────────────────────────
  drawBigMap() {
    const cv = this.mapCanvas;
    if (!cv || !this._ready || !this.bounds) return;
    const { w, h } = this.mapSize;
    const dpr = pixelRatio();
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const scale = this._fitScale * this.zoom;
    const view = makeView({
      bounds: this.bounds, center: this.center, scale, rotation: 0, width: w, height: h,
    });
    this._view = view;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = MAP_PALETTE.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.save();
    view.applyToContext(ctx, dpr);
    this._drawStatic(ctx, view, 'full');
    ctx.restore();

    this._drawGrid(ctx, view);
    // 标记随缩放略微变大：拉到 6× 时 4px 的小点贴在 20px 的房子旁边会显得太小
    const scaleK = clamp(0.55 + view.scale * 0.7, 1, 1.8);
    this._drawMarkers(ctx, view, { labels: true, edge: false, full: true, scaleK });
    this._drawScaleBar(ctx, view);
    this._drawNorth(ctx);
    ctx.restore();
    this._updateZoomLabel();
    this._updateCoords();
  }

  _drawGrid(ctx, view) {
    const aabb = view.visibleBounds();
    const step = MAP_LIMITS.gridStep;
    const drawLines = (spacing, color, width) => {
      ctx.beginPath();
      const x0 = Math.ceil(aabb.minX / spacing) * spacing;
      for (let x = x0; x <= aabb.maxX; x += spacing) {
        const a = view.worldToScreen(x, aabb.minZ);
        const b = view.worldToScreen(x, aabb.maxZ);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      const z0 = Math.ceil(aabb.minZ / spacing) * spacing;
      for (let z = z0; z <= aabb.maxZ; z += spacing) {
        const a = view.worldToScreen(aabb.minX, z);
        const b = view.worldToScreen(aabb.maxX, z);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    // 网格密度随缩放降级，别把地图糊成一张信纸
    if (view.scale > 0.55) drawLines(step, MAP_PALETTE.grid, 1);
    drawLines(step * 5, MAP_PALETTE.gridMajor, 1);
  }

  _drawScaleBar(ctx, view) {
    const nice = [10, 25, 50, 100, 250, 500, 1000, 2000];
    let meters = nice[0];
    for (const m of nice) if (m * view.scale <= 190) meters = m;
    const px = meters * view.scale;
    const x = 14;
    const y = view.height - 18;
    ctx.strokeStyle = 'rgba(217, 226, 232, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(217, 226, 232, 0.85)';
    ctx.fillText(meters >= 1000 ? `${meters / 1000}km` : `${meters}m`, x + 4, y - 6);
  }

  _drawNorth(ctx) {
    const x = this.mapSize.w - 26;
    const y = 26;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, TAU);
    ctx.fillStyle = 'rgba(10, 15, 18, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 175, 190, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x + 4, y + 4);
    ctx.lineTo(x, y + 1);
    ctx.lineTo(x - 4, y + 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(224, 163, 74, 0.9)';
    ctx.fill();
    ctx.font = `9px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(217, 226, 232, 0.7)';
    ctx.fillText('N', x, y + 7);
  }

  // ── 静态要素 ──────────────────────────────────────────
  /** 在"米空间"里画底图与矢量要素（调用前必须已经 view.applyToContext）。 */
  _drawStatic(ctx, view, detail) {
    const b = this.bounds;
    const f = this.features;
    if (!b || !f) return;
    const aabb = view.visibleBounds();
    const low = detail === 'minimap';

    if (this._rasterCanvas) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this._rasterCanvas, b.minX, b.minZ, b.width, b.depth);
    } else {
      ctx.fillStyle = '#25301f';
      ctx.fillRect(b.minX, b.minZ, b.width, b.depth);
    }

    // 危险区（僵尸刷新区）：只在大地图上给一层很淡的暖色底纹
    if (!low && f.dangerZones.length) {
      for (const z of f.dangerZones) {
        if (!pointInAabb(z.x, z.z, aabb, z.radius)) continue;
        ctx.beginPath();
        ctx.arc(z.x, z.z, z.radius, 0, TAU);
        ctx.fillStyle = z.tier === 'high' ? 'rgba(196, 84, 60, 0.10)' : 'rgba(196, 120, 60, 0.07)';
        ctx.fill();
      }
    }

    // 镇区轮廓
    if (f.town && !low) {
      const t = f.town;
      if (rectInAabb(t.x0, t.z0, t.x1, t.z1, aabb)) {
        ctx.save();
        ctx.setLineDash([6 / view.scale, 5 / view.scale]);
        ctx.lineWidth = 1.4 / view.scale;
        ctx.strokeStyle = MAP_PALETTE.townEdge;
        ctx.strokeRect(t.x0, t.z0, t.x1 - t.x0, t.z1 - t.z0);
        ctx.restore();
      }
    }

    // 镇内街区道路（模块化街道）
    if (f.streets.length) {
      ctx.beginPath();
      let maxW = 6;
      for (const s of f.streets) {
        if (!rectInAabb(s.x0, s.z0, s.x1, s.z1, aabb)) continue;
        const w = s.axis === 'x' ? s.z1 - s.z0 : s.x1 - s.x0;
        if (w > maxW) maxW = w;
        if (s.axis === 'x') {
          const cz = (s.z0 + s.z1) / 2;
          ctx.moveTo(s.x0, cz);
          ctx.lineTo(s.x1, cz);
        } else {
          const cx = (s.x0 + s.x1) / 2;
          ctx.moveTo(cx, s.z0);
          ctx.lineTo(cx, s.z1);
        }
      }
      // 比"建成区"底色更深，格子才看得出是沥青而不是一片灰
      ctx.strokeStyle = '#41474b';
      ctx.lineWidth = Math.max(2, maxW);
      ctx.lineCap = 'butt';
      ctx.stroke();
    }

    // OSM 真实道路：按线宽（米）画，小路用虚线
    for (const rd of f.netRoads) {
      if (!this._roadVisible(rd, aabb)) continue;
      ctx.beginPath();
      ctx.moveTo(rd.pts[0].x, rd.pts[0].z);
      for (let i = 1; i < rd.pts.length; i += 1) ctx.lineTo(rd.pts[i].x, rd.pts[i].z);
      ctx.strokeStyle = rd.color;
      ctx.lineWidth = Math.max(rd.width, low ? 3.2 : 2);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (rd.dash) {
        const k = low ? 1.6 : 1;
        ctx.setLineDash([rd.dash[0] * k, rd.dash[1] * k]);
      } else if (ctx.setLineDash) {
        ctx.setLineDash([]);
      }
      ctx.stroke();
    }
    if (ctx.setLineDash) ctx.setLineDash([]);

    // 围栏
    if (f.fences.length) {
      ctx.beginPath();
      for (const fe of f.fences) {
        if (!rectInAabb(fe.x0, fe.z0, fe.x1, fe.z1, aabb)) continue;
        ctx.moveTo(fe.x0, fe.z0);
        ctx.lineTo(fe.x1, fe.z1);
      }
      ctx.strokeStyle = MAP_PALETTE.fence;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }

    // 古建街区
    if (f.heritage && !low) {
      const h = f.heritage;
      if (rectInAabb(h.x0, h.z0, h.x1, h.z1, aabb)) {
        ctx.fillStyle = 'rgba(224, 163, 74, 0.14)';
        ctx.fillRect(h.x0, h.z0, h.x1 - h.x0, h.z1 - h.z0);
        ctx.strokeStyle = 'rgba(224, 163, 74, 0.6)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(h.x0, h.z0, h.x1 - h.x0, h.z1 - h.z0);
      }
    }

    // 建筑：按街区配色分组批量填，减少状态切换
    for (const [district, list] of this._buildingsByDistrict) {
      const style = districtStyle(district);
      ctx.beginPath();
      let any = false;
      for (const bl of list) {
        if (!rectInAabb(bl.x0, bl.z0, bl.x1, bl.z1, aabb)) continue;
        ctx.rect(bl.x0, bl.z0, bl.x1 - bl.x0, bl.z1 - bl.z0);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = style.fill;
      ctx.fill();
      if (!low) {
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = 0.55;
        ctx.stroke();
      }
    }

    // 门洞：在大地图上画一小段琥珀色短线，玩家一眼能看出"从哪边进得去"
    if (!low) {
      ctx.beginPath();
      for (const bl of f.buildings) {
        if (!bl.door) continue;
        if (!rectInAabb(bl.x0, bl.z0, bl.x1, bl.z1, aabb)) continue;
        const half = Math.max(0.9, bl.door.width / 2);
        const side = bl.door.side;
        if (side === 'north' || side === 'south') {
          const z = side === 'north' ? bl.z0 : bl.z1;
          ctx.moveTo(bl.door.center - half, z);
          ctx.lineTo(bl.door.center + half, z);
        } else {
          const x = side === 'west' ? bl.x0 : bl.x1;
          ctx.moveTo(x, bl.door.center - half);
          ctx.lineTo(x, bl.door.center + half);
        }
      }
      ctx.strokeStyle = MAP_PALETTE.door;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    // 树：批量画圆点（小地图上就是一层绿色噪点，看起来像林地）
    if (f.trees.length) {
      ctx.beginPath();
      for (const t of f.trees) {
        if (!pointInAabb(t.x, t.z, aabb, 3)) continue;
        ctx.moveTo(t.x + t.r, t.z);
        ctx.arc(t.x, t.z, t.r, 0, TAU);
      }
      ctx.fillStyle = low ? 'rgba(58, 82, 54, 0.85)' : MAP_PALETTE.tree;
      ctx.fill();
    }
  }

  _roadVisible(rd, aabb) {
    for (const p of rd.pts) if (pointInAabb(p.x, p.z, aabb, rd.width + 8)) return true;
    return false;
  }

  // ── 动态标记 ──────────────────────────────────────────
  _drawMarkers(ctx, view, { labels = false, edge = false, full = false, scaleK = 1 } = {}) {
    const list = full ? this._markersFull : this._markers;
    const t = this._t;

    for (const m of list) {
      if (m.kind === 'player' || m.kind === 'player-car') continue;
      const style = MARKER_STYLE[m.kind] || MARKER_STYLE.zombie;
      const s = view.worldToScreen(m.x, m.z);
      if (s.x < -24 || s.y < -24 || s.x > view.width + 24 || s.y > view.height + 24) continue;
      this._drawMarkerShape(ctx, s, style, m, t, scaleK);
      if (labels && m.label) this._drawLabel(ctx, s, m.label, style.color);
    }

    // 玩家：视锥 + 箭头（放最后，永远压在最上面）
    const player = list.find((m) => m.kind === 'player' || m.kind === 'player-car');
    if (player) this._drawPlayer(ctx, view, player, { labels, scaleK });

    if (edge) this._drawEdgeZombies(ctx, view);
  }

  _drawPlayer(ctx, view, player, { labels = false, scaleK = 1 } = {}) {
    const s = view.worldToScreen(player.x, player.z);
    const yaw = player.yaw || 0;
    const fwd = view.worldToScreen(player.x + Math.sin(yaw), player.z + Math.cos(yaw));
    const ang = Math.atan2(fwd.y - s.y, fwd.x - s.x);
    const coneR = clamp(28 * view.scale, 16, 110);
    // 视野扇形
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.arc(s.x, s.y, coneR, ang - 0.55, ang + 0.55);
    ctx.closePath();
    ctx.fillStyle = MAP_PALETTE.playerCone;
    ctx.fill();
    // 箭头
    const style = MARKER_STYLE[player.kind] || MARKER_STYLE.player;
    const r = style.size * scaleK;
    ctx.beginPath();
    ctx.moveTo(s.x + Math.cos(ang) * r, s.y + Math.sin(ang) * r);
    ctx.lineTo(s.x + Math.cos(ang + 2.5) * r * 0.9, s.y + Math.sin(ang + 2.5) * r * 0.9);
    ctx.lineTo(s.x + Math.cos(ang) * r * 0.5, s.y + Math.sin(ang) * r * 0.5);
    ctx.lineTo(s.x + Math.cos(ang - 2.5) * r * 0.9, s.y + Math.sin(ang - 2.5) * r * 0.9);
    ctx.closePath();
    ctx.fillStyle = style.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(8, 12, 15, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // "你"标签挂在箭头下面：放右边会和 POI 标签（中央广场之类）撞在一起
    if (labels) this._drawLabel(ctx, { x: s.x + 2, y: s.y + 15 }, player.label || '你', style.color);
  }

  _drawMarkerShape(ctx, s, style, m, t, scaleK = 1) {
    const size = style.size * scaleK;
    const pulse = style.pulse ? 0.5 + 0.5 * Math.sin(t * 7 + (m.x || 0) * 0.25) : 0;
    if (style.pulse) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, size + 3 + pulse * 4, 0, TAU);
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = 0.42 * (1 - pulse * 0.55);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (style.ring) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, size + 2.5, 0, TAU);
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (style.shape === 'square') {
      ctx.fillStyle = style.color;
      ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
      ctx.strokeStyle = 'rgba(8, 12, 15, 0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x - size / 2, s.y - size / 2, size, size);
      return;
    }
    if (style.shape === 'diamond' || style.shape === 'star') {
      const r = size * (style.shape === 'star' ? 1.15 : 1);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r * 0.82, s.y);
      ctx.lineTo(s.x, s.y + r);
      ctx.lineTo(s.x - r * 0.82, s.y);
      ctx.closePath();
      ctx.fillStyle = style.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8, 12, 15, 0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    // dot
    ctx.beginPath();
    ctx.arc(s.x, s.y, size, 0, TAU);
    ctx.fillStyle = style.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(8, 12, 15, 0.8)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }

  _drawLabel(ctx, s, text, color) {
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width;
    const x = s.x + 9;
    const y = s.y;
    ctx.fillStyle = 'rgba(8, 12, 15, 0.72)';
    roundRectPath(ctx, x - 3, y - 8, w + 6, 16, 3);
    ctx.fill();
    ctx.fillStyle = color || MAP_PALETTE.text;
    ctx.fillText(text, x, y);
  }

  _drawEdgeZombies(ctx, view) {
    if (!this._edgeZombies.length) return;
    const half = MAP_LIMITS.minimapSize / 2;
    const rim = half - 8;
    for (const z of this._edgeZombies) {
      const s = view.worldToScreen(z.x, z.z);
      const dx = s.x - half;
      const dy = s.y - half;
      const len = Math.hypot(dx, dy) || 1;
      const px = half + (dx / len) * rim;
      const py = half + (dy / len) * rim;
      const ang = Math.atan2(dy, dx);
      const a = clamp(0.75 - z.d / (MAP_LIMITS.minimapRange * 2.6), 0.25, 0.7);
      ctx.save();
      ctx.globalAlpha = z.alert ? a + 0.15 : a * 0.85;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(ang) * 5, py + Math.sin(ang) * 5);
      ctx.lineTo(px + Math.cos(ang + 2.4) * 4, py + Math.sin(ang + 2.4) * 4);
      ctx.lineTo(px + Math.cos(ang - 2.4) * 4, py + Math.sin(ang - 2.4) * 4);
      ctx.closePath();
      ctx.fillStyle = z.alert ? MAP_PALETTE.zombieAlert : MAP_PALETTE.zombie;
      ctx.fill();
      ctx.restore();
    }
  }

  // ── 面板文字 ──────────────────────────────────────────
  _updatePanel() {
    if (!this.mapStatsEl) return;
    const s = this._statsFull;
    const near = s.nearestZombie == null ? '附近无感染者' : `最近感染者 ${formatDistance(s.nearestZombie)}`;
    this.mapStatsEl.innerHTML = `全图：感染者 <b>${s.zombies}</b>（惊动 <b>${s.alert}</b>）· 掠夺者 <b>${s.hostiles}</b> · `
      + `幸存者 <b>${s.friendlies}</b> · 车辆 <b>${s.cars}</b> · ${near}`;
  }

  _updateZoomLabel() {
    if (this._zoomEl) this._zoomEl.textContent = `${this.zoom.toFixed(1)}×`;
  }

  _updateCoords() {
    if (!this.mapCoordsEl) return;
    if (!this.open || !this._view) return;
    if (!this._hover) { this.mapCoordsEl.textContent = '把鼠标移到地图上查看坐标'; return; }
    const w = this._view.screenToWorld(this._hover.x, this._hover.y);
    const elev = this.terrain && typeof this.terrain.elevationAt === 'function'
      ? ` · 海拔 ${Math.round(this.terrain.elevationAt(w.x, w.z))}m`
      : '';
    const mpp = (Math.round(this._view.metersPerPixel * 100) / 100).toFixed(2);
    this.mapCoordsEl.textContent = `X ${Math.round(w.x)} · Z ${Math.round(w.z)}${elev} · 比例 ${mpp} m/px`;
  }

  dispose() {
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
    const cv = this.mapCanvas;
    if (cv) {
      cv.removeEventListener('pointerdown', this._onPointerDown);
      cv.removeEventListener('pointermove', this._onPointerMove);
      cv.removeEventListener('wheel', this._onWheel);
      cv.removeEventListener('dblclick', this._onDblClick);
    }
    if (this.mmEl && this.mmEl.parentNode) this.mmEl.parentNode.removeChild(this.mmEl);
    if (this.screenEl && this.screenEl.parentNode) this.screenEl.parentNode.removeChild(this.screenEl);
    this._built = false;
    this.open = false;
    this._ready = false;
  }
}

export default { MapSystem };
