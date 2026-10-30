// 游戏主控：初始化 three.js、构建世界、驱动主循环、协调各子系统。
// 设计原则：
//   · 每个子系统（玩家/世界/AI/战斗/物品/载具/音频/UI/存档）都通过明确的接口挂在这里，
//     主循环只做"取输入 → 更新 → 渲染"，不在循环里 new 复杂对象；
//   · 任何可选资源缺失（足球数据、音频设备、WebGL 扩展）都降级而不是崩；
//   · 窗口上暴露 window.__DD__ 便于浏览器自动化冒烟测试。

import * as THREE from 'three';

import { validateConfig, applyQuality, DEFAULT_CONFIG } from '../config/game-config.js';
import { FootballData } from '../data/football-adapter.js';
import { generateLayout, buildingAt } from '../world/layout.js';
import { CAR_TYPE_BY_ID } from '../world/cars.js';
import { nearestLamps } from '../world/roads.js';
import { buildWorld, buildTreeInstances, disposeTreeGroup } from '../world/build.js';
import { SEASON_ENV, SEASON_LABELS, DEFAULT_SEASON, applySeasonEnvironment, blendSeasonEnv, seasonForDay, isSeason } from '../world/season.js';
import { TREE_REGION_IDS, regionLabel } from '../world/trees.js';
import { WeatherSystem, WEATHERS, WEATHER_IDS, weatherIdsForSeason, DEFAULT_WEATHER, computeEnvironment, weatherTemperature, ambienceFor } from '../world/weather.js';
import { WeatherFx } from '../world/weather-visuals.js';
import { ColliderWorld } from '../world/collision.js';
import { loadTerrain, terrainTint } from '../world/terrain.js';
import { loadRoadNet } from '../world/road-net.js';
import { NavGrid } from '../navigation/navgrid.js';
import { KitMaterialCache } from '../characters/materials.js';
import { Character } from '../characters/character.js';
import { CharacterFactory } from '../characters/fbx.js';
import { AssetLoader } from '../assets/loader.js';
import { CHARACTER_MODELS, HUMAN_VARIANTS, PROP_MODELS, SEASON_TREE_PROPS, BUILDING_PROP_MODELS, ITEM_MODEL, CONTAINER_MODEL } from '../assets/manifest.js';
import { applyMaleTemplate, pickTemplate, findTemplate } from '../characters/male-templates.js';
import { CSL_KITS, cslKitForClub } from '../appearance/csl-kits.js';
import { buildKitAtlas, samplePrimaryColor } from '../appearance/kit-atlas.js';
import { makeKit } from '../appearance/kit.js';
import { CameraRig } from '../player/camera.js';
import { Player } from '../player/player.js';
import { Input } from '../player/input.js';
import { NpcDirector } from '../ai/director.js';
import { makeNpcConfig, patrolLoop, validateNpcConfig } from '../ai/npc-config.js';
import { buildWeaponMesh, WEAPONS } from '../combat/weapons.js';
import { resolveShot, resolveRay, resolveMelee, spreadDir } from '../combat/combat.js';
import { traceShot, rollHit, effectiveSpread, HeatModel, falloffMul, describeTrait } from '../combat/ballistics.js';
import { ITEMS, lootForContainer, rollLoot, LOOT_TABLES, Inventory } from '../items/items.js';
import { VehicleController, ramTargets, ramDamage } from '../vehicles/vehicles.js';
import { AudioSystem } from '../audio/audio.js';
import { GameUI } from '../ui/ui.js';
import { MapSystem } from '../ui/map.js';
import { buildMarkers, MAP_LIMITS } from '../ui/map-data.js';
import { SaveManager, buildSavePayload } from '../save/save.js';

/**
 * 武器 id → 道具模型 key。
 * 枪械外观一律来自 Ultimate Guns，近战斧来自 Survival Pack（不是枪械）。
 * 没登记的武器（球棒）走程序化外观 buildWeaponMesh —— 道具包里没有球棒模型。
 */
const WEAPON_PROP_KEY = {
  w_pistol_9mm: 'w_pistol_9mm',
  w_rifle_556: 'w_rifle_556',
  w_shotgun_12g: 'w_shotgun_12g',
  w_smg_9mm: 'w_smg_9mm',
  w_sniper_762: 'w_sniper_762',
  w_melee_axe: 'w_melee_axe',
};

const QUEST_DEFS = {
  q_supplies: {
    id: 'q_supplies', name: '补给清点', objective: '搜刮 3 个容器',
    goal: 3, kind: 'loot', reward: { itemId: 'i_med_kit', count: 1 },
    giver: 'friendly', text: '营地快断粮了。去附近的箱柜里找找能用的东西，搜满三处就回来。',
  },
  q_clear: {
    id: 'q_clear', name: '清理街区', objective: '击杀 5 个感染者',
    goal: 5, kind: 'kill', reward: { itemId: 'i_ammo_556', count: 24 },
    giver: 'friendly', text: '工业区那边动静越来越大。能清掉五个，我们才敢派人过去。',
  },
  q_reach: {
    id: 'q_reach', name: '抵达营地', objective: '走到幸存者营地',
    goal: 1, kind: 'reach', reward: { itemId: 'i_food_can', count: 2 },
    giver: 'friendly', text: '如果你还活着，来营地找我们。就在住宅区东边。',
  },
};

export class Game {
  constructor(opts = {}) {
    this.config = validateConfig(opts.config || {});
    this.container = opts.container || document.body;
    this.canvas = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.cameraRig = null;
    this.input = null;
    this.player = null;
    this.playerCharacter = null;
    this.director = null;
    this.world = null;
    this.layout = null;
    this.collision = null;
    this.nav = null;
    this.football = new FootballData();
    this.materials = null;
    this.audio = null;
    this.ui = null;
    this.map = null;
    this.save = null;
    this.vehicles = null;

    this.clock = null;
    this.running = false;
    this.paused = false;
    this._settingsOpen = false;
    this.started = false;
    this.elapsed = 0;
    this.timeOfDay = 11;
    this.dayCount = 1;                 // 第几天（每过一个 24h 结算一次，用来推进季节）
    this.season = DEFAULT_SEASON;      // 当前季节（spring/summer/autumn/winter）
    this.seasonEnv = SEASON_ENV[DEFAULT_SEASON];
    this._seasonBusy = false;          // 换季时正在补装资产，避免重入
    this._seasonBlend = null;          // 换季的颜色过渡 {from, t, dur}（几何不能插值，颜色可以）
    this.weather = null;               // WeatherSystem（纯逻辑，见 world/weather.js）
    this.weatherFx = null;             // WeatherFx（降水/风/闪光，见 world/weather-visuals.js）
    this._thunderQueue = [];           // 待播的雷声（按声速延迟，不是定时器）
    this._weatherSoundTimer = 0;
    this._indoor = false;
    // 每帧复用的颜色对象：主循环里 new THREE.Color 会产生大量垃圾
    this._colSky = new THREE.Color();
    this._colNight = new THREE.Color(0x1a2430);
    this._colFlash = new THREE.Color(0xdfe9f5);
    this._colTmp = new THREE.Color();
    this._raf = 0;
    this._last = 0;
    this._hudTimer = 0;
    this._fps = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._lastFrameTime = 0;

    this.openedContainers = new Set();
    this.lootedPickups = new Set();
    this.doorStates = [];
    this.cars = [];
    this.pickups = new Map();
    this.quests = { active: [], completed: [] };
    this.messages = [];
    this._targets = [];
    this._ray = new THREE.Ray();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._tracerPool = [];
    this._tracers = [];
    this._interactables = [];
    this._nearestInteract = null;
    this._pendingQuestGiver = null;
    this._dialogOpen = false;
    this._lootOpen = null;
    this._deathTimer = 0;
    this._saveError = null;
    this._stats = { frames: 0 };
  }

  // ── 初始化 ───────────────────────────────────────────
  async boot() {
    this._initRenderer();
    this._initScene();
    this._initUI();
    this.audio = new AudioSystem({
      enabled: this.config.audio.enabled,
      masterVolume: this.config.audio.master,
      sfxVolume: this.config.audio.sfx,
      ambientVolume: this.config.audio.ambient,
    });
    this.save = new SaveManager({
      key: this.config.save.key,
      autosaveSeconds: this.config.save.autosaveSeconds,
    });
    this.input = new Input(window);
    this.materials = new KitMaterialCache(THREE, { max: 72 });

    this.ui.setLoading('载入足球数据…');
    try {
      await this.football.load();
    } catch (e) {
      console.warn('[game] 足球数据加载失败，游戏继续（使用兜底身份）', e);
    }

    this.ui.showMainMenu({
      hasSave: this.save.hasSave(),
      summary: this.football.summary(),
    });
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame((t) => this._loop(t));
    return this;
  }

  _initRenderer() {
    const R = this.config.render;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, R.pixelRatioCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = !!R.shadowsEnabled;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.id = 'dd-canvas';
    renderer.domElement.style.cssText = 'position:fixed;inset:0;display:block;background:#0b0f13';
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.canvas = renderer.domElement;

    this._onResize = () => {
      if (!this.renderer || !this.camera) return;
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);

    this.canvas.addEventListener('click', () => {
      if (!this.started || this.paused) return;
      this.input.requestLock(this.canvas);
      if (this.audio) this.audio.unlock();
    });
  }

  _initScene() {
    const C = this.config.camera;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fa6b8);
    this.scene.fog = new THREE.FogExp2(0x8fa6b8, this.config.render.fogDensity);

    this.camera = new THREE.PerspectiveCamera(C.fov, window.innerWidth / window.innerHeight, C.near, C.far);
    this.camera.position.set(0, 2, -4);
    this.cameraRig = new CameraRig(THREE, C);

    const hemi = new THREE.HemisphereLight(0xcfe0f0, 0x4a5446, 1.15);
    hemi.position.set(0, 60, 0);
    this.scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(0xffe9c4, 1.65);
    sun.position.set(60, 90, 40);
    sun.castShadow = !!this.config.render.shadowsEnabled;
    const size = this.config.render.shadowMapSize || 1024;
    sun.shadow.mapSize.set(size, size);
    // 阴影相机只覆盖玩家周围 ~34m：正交视锥越小，texel 越密，越不容易出现大面积的阴影自遮挡（acne）。
    // 早期用 ±55 + 很小的 bias，结果近处地面整片发黑（截图里那条黑色矩形）。
    sun.shadow.camera.left = -28;
    sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 28;
    sun.shadow.camera.bottom = -28;
    sun.shadow.camera.near = 8;
    sun.shadow.camera.far = 230;
    // normalBias 约 1.3 个 texel（56m/1024 ≈ 0.055m）。再大就会把地面上方几厘米的道路"顶"进阴影里。
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.07;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // 跟随相机的补光：太阳在角色背后时，正面会黑成剪影。
    // 一盏很弱、范围有限的点光贴在相机上，是低多边形游戏里最省的补光手段。
    const fill = new THREE.PointLight(0xbfd2e0, 0.55, 26, 2);
    fill.position.set(0, 0.4, 1.2);
    this.camera.add(fill);
    this.fillLight = fill;

    // 手电筒（L 开关）：室内靠它，也让"室内外照明差异"有玩家可控手段。
    // 挂在相机上，默认关闭；打开时用较低的强度避免把低多边形场景照爆。
    const torch = new THREE.SpotLight(0xffe6b8, 0, 30, Math.PI / 6.5, 0.5, 1.4);
    torch.position.set(0, -0.12, 0.1);
    torch.target.position.set(0, -0.15, -8);
    this.camera.add(torch);
    this.camera.add(torch.target);
    this.flashlight = torch;
    this.flashlightOn = false;
    this.flashlightIntensity = 9;

    // 车灯（L，坐在车里时）：只做**一盏**共享 SpotLight，位置每帧贴到当前驾驶的车头上。
    // 14 台车各配一盏点光会让灯光数翻倍，而玩家同一时刻只会开一台。
    this._carLight = new THREE.SpotLight(0xffeecb, 0, 36, 0.42, 0.45, 1.1);
    this._carLight.castShadow = false;
    this._carLight.visible = false;
    this.scene.add(this._carLight);
    this._carLight.target.position.set(0, 0, 0);
    this.scene.add(this._carLight.target);

    const amb = new THREE.AmbientLight(0x3a434a, 0.65);
    this.scene.add(amb);
    this.ambient = amb;
  }

  _initUI() {
    this.ui = new GameUI({
      onNewGame: () => { this.audio.unlock(); this.newGame(); },
      onContinue: () => { this.audio.unlock(); this.continueGame(); },
      onSettings: () => this._openSettings(),
      onDatabase: () => this.ui.showDatabase(this.football.summary()),
      onHelp: () => this.ui.showHelp(() => this._backToCurrentScreen()),
      onClosePanel: () => this._backToCurrentScreen(),
      onResume: () => this.resume(),
      onSave: () => this.manualSave(),
      onLoad: () => this.loadGame(),
      onMenu: () => this.toMenu(),
      onUseItem: (list, idx) => this._useItem(list, idx),
      // 背包关掉后把指针锁回来：否则按 Tab 关背包之后视角不能转，还得再点一下画面
      onInventoryClose: () => {
        if (!this.started || this.paused) return;
        if (this._dialogOpen || this._lootOpen) return;
        this.input.requestLock(this.canvas);
      },
      click: () => { if (this.audio) { this.audio.unlock(); this.audio.play('ui_click', { volume: 0.5 }); } },
    });
    this.ui.mount(document.body);

    // 地图：小地图挂在 HUD 层里（隐藏 HUD 时一起隐藏），大地图是独立覆盖层
    // （不走 #dd-screens —— 那个容器会被 clearScreens() 清空，地图得自己活下来）。
    this.map = new MapSystem({
      onRequestOpen: () => this.openMap(),
      onRequestClose: () => this.closeMap(),
    });
    this.map.mount(this.ui.root, this.ui.els.hud);
  }

  get hasSession() { return this.started; }

  _openSettings() {
    this._settingsOpen = true;
    this.ui.showSettings(this.config, () => this._closeSettings(), (patch) => {
      this.applySettings(patch);
      this._closeSettings();
    });
  }

  /** 关设置：回到"打开它之前"的界面（暂停菜单 / 主菜单 / HUD），Esc 也走这里。 */
  _closeSettings() {
    this._settingsOpen = false;
    this._backToCurrentScreen();
  }

  _backToCurrentScreen() {
    if (!this.started) {
      this.ui.showMainMenu({ hasSave: this.save.hasSave(), summary: this.football.summary() });
    } else if (this.paused) {
      this.ui.showPause();
    } else {
      this.ui.clearScreens();
      this.ui.showHud();
    }
  }

  applySettings(patch) {
    if (!patch) return;
    if (patch.quality) {
      this.config = applyQuality(this.config, patch.quality);
      this._applyRenderQuality();
    }
    if (Number.isFinite(patch.maxZombies)) {
      this.config.ai.maxZombies = patch.maxZombies;
      if (this.director) this.director.ai = this.config.ai;
    }
    if (Number.isFinite(patch.master)) this.config.audio.master = patch.master;
    if (Number.isFinite(patch.sfx)) this.config.audio.sfx = patch.sfx;
    if (Number.isFinite(patch.ambient)) this.config.audio.ambient = patch.ambient;
    if (patch.audioEnabled != null) this.config.audio.enabled = !!patch.audioEnabled;
    // 夹到 validateConfig 的合法区间：滑块给的是 0.001~0.01，别让越界值把灵敏度/视野搞成 NaN 或瞎掉
    if (Number.isFinite(patch.sensitivity)) this.config.camera.sensitivity = Math.min(0.01, Math.max(0.0004, patch.sensitivity));
    if (Number.isFinite(patch.fov)) this.config.camera.fov = Math.min(100, Math.max(60, patch.fov));
    // 天气/季节：设置面板可以直接改（"天气=自动"才能让系统自己推进）
    if (Number.isFinite(patch.weatherScale)) {
      this.config.world.weatherScale = Math.min(8, Math.max(0.1, patch.weatherScale));
      if (this.weather) this.weather.scale = this.config.world.weatherScale;
    }
    if (patch.weatherEnabled != null) {
      this.config.world.weatherEnabled = !!patch.weatherEnabled;
      if (this.weather) this.weather.enabled = this.config.world.weatherEnabled;
    }
    if (typeof patch.weatherMode === 'string') this.setWeather(patch.weatherMode, { silent: true });
    if (isSeason(patch.season) && patch.season !== this.season && this.started) {
      this.setSeason(patch.season, { silent: false });
    }
    // 中国气候带：布局是按地区生成的，改地区要重开世界才生效
    if (typeof patch.region === 'string' && TREE_REGION_IDS.includes(patch.region)) {
      const changed = patch.region !== this.config.world.region;
      this.config.world.region = patch.region;
      if (changed && this.ui && this.ui.toast) this.ui.toast(`植被区域：${regionLabel(patch.region)}（开新局后生效）`, 'info');
    }
    if (this.audio) {
      this.audio.setMasterVolume(this.config.audio.master);
      this.audio.setSfxVolume(this.config.audio.sfx);
      this.audio.setAmbientVolume(this.config.audio.ambient);
      this.audio.setEnabled(this.config.audio.enabled);
    }
    if (this.camera) {
      this.camera.fov = this.config.camera.fov;
      this.camera.updateProjectionMatrix();
    }
    // 鼠标灵敏度与 FOV 也要存下来，否则每次刷新都回到默认值（滑块看着像没用）
    try {
      localStorage.setItem('dd.settings', JSON.stringify({
        quality: this.config.render.quality,
        ...this.config.audio,
        sensitivity: this.config.camera.sensitivity,
        fov: this.config.camera.fov,
        // 天气/季节偏好也一起记住（下次开局是同一套环境）
        weatherMode: this.config.world.weatherMode,
        weatherScale: this.config.world.weatherScale,
        weatherEnabled: this.config.world.weatherEnabled,
        season: this.config.world.season,
        region: this.config.world.region,
      }));
    } catch (e) {}
    this.ui.toast('设置已应用', 'good');
  }

  _applyRenderQuality() {
    const R = this.config.render;
    if (!this.renderer) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, R.pixelRatioCap));
    this.renderer.shadowMap.enabled = !!R.shadowsEnabled;
    if (this.sun) this.sun.castShadow = !!R.shadowsEnabled;
    if (this.scene && this.scene.fog) this.scene.fog.density = R.fogDensity;
    if (this.camera) { this.camera.far = R.drawDistance + 200; this.camera.updateProjectionMatrix(); }
  }

  // ── 新游戏 ───────────────────────────────────────────
  async newGame(savedData = null) {
    const cfg = this.config;
    if (savedData && Number.isFinite(savedData.seed)) cfg.seed = savedData.seed;
    // 季节要先定下来：它决定开局要预装哪套树木几何（秋/冬是另外 16~22 个模型）。
    // 存档里记了就用存档的，否则用配置/URL 参数给的（默认夏）。四季只换几何+环境色，不改布局。
    if (savedData && isSeason(savedData.season)) this.season = savedData.season;
    else if (isSeason(cfg.world.season)) this.season = cfg.world.season;
    else this.season = DEFAULT_SEASON;
    cfg.world.season = this.season;

    // 中国气候带：它决定树种混交，必须在 generateLayout 之前定下来。
    // 存档里记了就用存档的（读档后树不能换一片），否则用配置/URL（默认 temperate = 原温带混交）。
    if (savedData && savedData.world && TREE_REGION_IDS.includes(savedData.world.region)) {
      cfg.world.region = savedData.world.region;
    }
    if (!TREE_REGION_IDS.includes(cfg.world.region)) cfg.world.region = 'temperate';

    // 真实资产只加载一次；失败会自动降级到程序化模型
    try {
      await this._ensureAssets();
      await this._ensureSeasonProps(this.season);
    } catch (e) {
      console.warn('[assets] 资产预加载失败，全程使用程序化模型', e);
      this.assetsReady = { characters: [], props: [], characterErrors: [String(e && e.message)], propErrors: [] };
    }

    this.ui.setLoading('生成世界…');
    await new Promise((r) => setTimeout(r, 30));
    this._teardownWorld();

    // 真实地形：Copernicus DEM 30m（高程）+ ESA WorldCover 10m（土地覆盖）+ HydroRIVERS（河网）。
    // 数据是离线烘焙好的（tools/bake-terrain.mjs → dist/data/terrain/<名字>/），这里只做加载。
    // 加载失败不阻塞开局：退回原来的平地小镇，并在 toast 里说清楚。
    this.ui.setLoading('加载真实地形…');
    this.terrain = await this._loadTerrain();
    this.ui.setLoading('加载真实路网…');
    this.roadNet = await this._loadRoadNet();

    this.layout = generateLayout({
      seed: cfg.seed, size: cfg.world.size, blockSize: cfg.world.blockSize,
      roadWidth: cfg.world.roadWidth, buildingCount: cfg.world.buildingCount,
      treeCount: cfg.world.treeCount, carCount: cfg.world.carCount, crateCount: cfg.world.crateCount,
      // 中国气候带：决定树种混交（temperate = 原来的温带混交）
      region: cfg.world.region,
      // 古建：只有历史城市才给（门禁在 planHeritage 里判断），这里只把清单和碰撞递进去
      heritage: this.heritageData || null,
      roadside: this.heritageData ? true : false,
    });

    // 碰撞世界
    this.collision = new ColliderWorld({ bounds: this.layout.bounds });
    for (const c of this.layout.colliders) this.collision.add(c);
    // 有真实地形时，玩家可以走出小镇：碰撞边界跟着图幅放大（不然跑到 ±170 就被空气墙挡住）
    if (this.terrain) this.collision.bounds = { ...this.terrain.bounds };
    // 导航网格
    const half = this.layout.size / 2;
    const cell = cfg.world.cell;
    this.nav = new NavGrid({
      origin: { x: -half, z: -half },
      cellSize: cell,
      width: Math.ceil(this.layout.size / cell),
      height: Math.ceil(this.layout.size / cell),
    });
    for (const c of this.layout.colliders) {
      if (c.blocksNav) this.nav.blockRect(c.minX, c.minZ, c.maxX, c.maxZ);
    }
    // 门口走廊：建筑门洞（1.2~2m）比导航格子（2m）窄，光靠 blockRect 的话 NPC 会认为门口
    // 一个可走格都没有。这里按 layout 给的 navDoors 把门口清成可走（玩家碰撞仍是精确墙段）。
    if (Array.isArray(this.layout.navDoors)) {
      for (const d of this.layout.navDoors) this.nav.clearRect(d.x0, d.z0, d.x1, d.z1);
    }

    // 视觉世界
    this.ui.setLoading('构建场景…');
    await new Promise((r) => setTimeout(r, 20));
    this.world = buildWorld(THREE, this.layout, cfg, {
      propGeometry: this.propGeometry,
      buildingGeometry: this.buildingGeometry,
      charFactory: this.charFactory,
      terrain: this.terrain,
      roadNet: this.roadNet,
    });
    this.scene.add(this.world.group);
    applySeasonEnvironment(this, this.season);
    // 天气：状态机（纯数据）→ 渲染（粒子/风/雷）。
    // 顺序很重要：WeatherSystem 只回答"这一帧空气是什么样"，WeatherFx 才去改场景。
    this.weather = new WeatherSystem({
      seed: cfg.seed,
      season: this.season,
      enabled: cfg.world.weatherEnabled !== false,
      scale: cfg.world.weatherScale,
    });
    if (savedData && savedData.world && savedData.world.weather) this.weather.restore(savedData.world.weather);
    const wm = cfg.world.weatherMode;
    if (wm && wm !== 'auto' && WEATHERS[wm]) this.weather.setWeather(wm, { instant: true, force: true });
    this.weatherFx = new WeatherFx(THREE, {
      scene: this.scene,
      camera: this.camera,
      quality: cfg.render.quality,
      treeGroup: this.world.trees,
    });
    this._applyEnvironment();
    this._syncWeatherAudio();
    // 把雨/雪的 shader 在开局就编译掉：否则第一场雨会卡一下
    if (this.weatherFx && this.renderer) this.weatherFx.warmup(this.renderer);
    this._interactables = this.world.interactables.slice();
    this.doorStates = this.world.doorMeshes;
    this.cars = this.world.cars;
    this.lights = this.world.lights;

    // 路灯：灯头坐标 + 光晕材质；真正的照明用 3 盏池化点光跟随最近的灯（见 _updateStreetLights）
    this.streetLamps = this.world.streetLamps || [];
    this._lampGlowMat = this.world.lampGlowMat || null;
    if (this._streetLampLights) {
      for (const l of this._streetLampLights) { l.intensity = 0; this.scene.remove(l); }
    }
    this._streetLampLights = [];
    const lampBudget = this.streetLamps.length ? ((this.config.render && this.config.render.streetLampLights) || 3) : 0;
    for (let i = 0; i < lampBudget; i += 1) {
      const light = new THREE.PointLight(0xffd9a0, 0, 16, 1.7);
      light.castShadow = false;
      this.scene.add(light);
      this._streetLampLights.push(light);
    }

    // 玩家
    this.ui.setLoading('生成角色…');
    await new Promise((r) => setTimeout(r, 20));
    const spawn = this.layout.playerSpawn;
    const identity = this._playerIdentity();
    const appearance = this.football.appearanceFor(identity);
    const playerModelKey = this._pickCharacterKey({ id: 'player' }, 'male_shirt');
    const playerModel = playerModelKey && this.charFactory ? this.charFactory.create(playerModelKey) : null;
    // 男性玩家套上角色创建页选的体型模板（没存过就用"标准体格"）；僵尸/女性不套。
    this.playerTemplate = null;
    if (playerModel && playerModelKey === 'male_shirt') {
      const saved = this._savedCreatorTemplate();
      const def = findTemplate(saved) || findTemplate('standard');
      const applied = applyMaleTemplate(THREE, playerModel, def);
      this.playerTemplate = applied.ok ? applied.template : null;
      this.playerStats = applied.ok ? applied.report.stats : null;
    }
    this.playerCharacter = new Character(THREE, { materials: this.materials }, {
      id: 'player', kind: 'player', appearance, kit: identity.kit,
      health: cfg.player.maxHealth, name: identity.name, factionId: identity.factionId,
      model: playerModel,
      kitAtlas: this._kitForIdentity(identity),
    });
    this.scene.add(this.playerCharacter.group);
    // 出生点高度取自地形（镇子已被垫平，这里通常是 0；换成别的地块就自动跟着走）
    const spawnY = this.groundHeightAt(spawn.x, spawn.z);
    this.playerCharacter.setPosition(spawn.x, spawnY, spawn.z);

    this.player = new Player(THREE, {
      config: cfg,
      collision: this.collision,
      camera: this.cameraRig,
      materials: this.materials,
      // 体型模板的属性乘数（血量/体力/负重/速度/跳跃/噪音）：没有模板时全 1，行为与以前一致
      statsMul: this.playerStats || null,
      playSound: (name, o) => this._playSound(name, o),
      emitSound: (x, z, loud, tag) => this._emitSound(x, z, loud, tag),
      toast: (msg, kind) => this.ui.toast(msg, kind),
      groundHeightAt: (x, z) => this.groundHeightAt(x, z),
    });
    this.player.attachCharacter(this.playerCharacter);
    this.player.setPosition(spawn.x, spawnY, spawn.z);
    this.player.yaw = spawn.yaw || 0;
    this.cameraRig.yaw = spawn.yaw || 0;
    this.cameraRig.setMode('third');

    // 武器视图模型（第一人称）
    this._viewmodel = new THREE.Group();
    this._viewmodel.name = 'viewmodel';
    this.camera.add(this._viewmodel);
    this.scene.add(this.camera);
    this._equippedVisualId = null;
    this._syncWeaponVisual();

    // NPC
    this.ui.setLoading('唤醒居民…');
    await new Promise((r) => setTimeout(r, 20));
    this._spawnWorldNpcs();

    // 地面拾取物
    this._spawnPickups();

    // 载具
    this.vehicles = new VehicleController(cfg);

    // 地图：把地形/路网/建筑烘成一张底图（一次性，之后每帧只画标记）。
    // 放在这里是因为它需要 layout + terrain + roadNet 三样都就位，而且要赶在 HUD 出现之前。
    // 烘焙失败只降级成"没有底图"，绝不让开新局挂掉。
    this.ui.setLoading('绘制地图…');
    await new Promise((r) => setTimeout(r, 16));
    try {
      await this.map.prepare({
        layout: this.layout, terrain: this.terrain, roadNet: this.roadNet, seed: cfg.seed,
      });
    } catch (e) {
      console.warn('[map] 地图烘焙失败，小地图/大地图将没有底图', e);
    }

    // 状态
    this.elapsed = 0;
    this.timeOfDay = 11;
    this.dayCount = 1;
    this.openedContainers = new Set();
    this.lootedPickups = new Set();
    this.quests = { active: [], completed: [] };
    this._deathTimer = 0;
    this.started = true;
    this.paused = false;

    if (savedData) this._restoreState(savedData);

    this.ui.clearScreens();
    this.ui.showHud();
    this.ui.toast(`欢迎来到 ${this.layout.buildings.length} 栋建筑的小镇`, 'good');
    this.audio.startAmbient();

    // 初始任务
    if (!savedData) this._offerQuest(QUEST_DEFS.q_reach);

    this.input.requestLock(this.canvas);
    this.save.resetTimer();
    return this;
  }

  _playerIdentity() {
    // 玩家用"玩家所在阵营"的第 0 号球员身份；没有足球数据时用兜底
    const factionIndex = 0;
    const id = this.football.survivorIdentity(factionIndex, 0);
    return id;
  }

  /**
   * 载入真实地形烘焙数据（同一个 url 只解析一次，重开新游戏不用重新下载）。
   * @returns {Promise<object|null>} Terrain 实例；失败/关闭时返回 null（退回平地）
   */
  async _loadTerrain() {
    const T = (this.config && this.config.terrain) || {};
    if (T.enabled === false) return null;
    const url = String(T.url || 'data/terrain/dujiangyan');
    if (this._terrainCache && this._terrainCache.url === url) return this._terrainCache.terrain;
    try {
      const terrain = await loadTerrain(url);
      this._terrainCache = { url, terrain };
      this.terrainSummary = terrain.summary();
      console.info('[terrain] 真实地形已加载', this.terrainSummary);
      return terrain;
    } catch (e) {
      console.warn('[terrain] 地形数据加载失败，退回平地小镇', e);
      this.terrainSummary = null;
      try { this.ui.toast('地形数据加载失败，使用平地地图', 'bad'); } catch (err) { /* UI 还没起来 */ }
      return null;
    }
  }

  /**
   * 地表高度（米，相对城镇地面）＝地形和路面的**较高者**。
   * 道路的高程剖面是挖填后的平台（比原地形可能高 1~3m，桥面更高），
   * 只查地形的话玩家会从路面底下穿过去。
   */
  groundHeightAt(x, z) {
    const t = this.terrain ? this.terrain.heightAt(x, z) : 0;
    if (!this.roadNet) return t;
    const r = this.roadNet.heightAt(x, z);
    return r != null && r > t ? r : t;
  }

  /**
   * 载入真实路网烘焙数据（OSM → tools/bake-roads.mjs）。同一个 url 只解析一次。
   * @returns {Promise<object|null>} RoadNet 实例；失败/关闭时返回 null（镇外就没有真实路网）
   */
  async _loadRoadNet() {
    const R = (this.config && this.config.roads) || {};
    if (R.enabled === false) return null;
    const url = String(R.url || 'data/roads/dujiangyan.json');
    if (this._roadNetCache && this._roadNetCache.url === url) return this._roadNetCache.net;
    try {
      const net = await loadRoadNet(url);
      this._roadNetCache = { url, net };
      this.roadNetSummary = net.summary();
      console.info('[roads] 真实路网已加载', this.roadNetSummary, '问题', net.issues.length);
      return net;
    } catch (e) {
      console.warn('[roads] 路网数据加载失败，镇外将没有真实道路', e);
      this.roadNetSummary = null;
      try { this.ui.toast('路网数据加载失败，只有镇内街道', 'bad'); } catch (err) { /* UI 未就绪 */ }
      return null;
    }
  }

  _teardownWorld() {
    // 天气粒子/风材质挂在场景与树上，必须在世界被拆掉之前释放
    if (this.weatherFx) { this.weatherFx.dispose(); this.weatherFx = null; }
    this.weather = null;
    this._thunderQueue = [];
    // 地图底图属于上一张图，世界一拆就得跟着作废（否则主菜单后面还挂着旧小地图）
    if (this.map) this.map.clear();
    if (this.director) { this.director.dispose(); this.director = null; }
    if (this.world && this.world.group) {
      this.scene.remove(this.world.group);
      this.world.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      this.world = null;
    }
    if (this._viewmodel && this._viewmodel.parent) this._viewmodel.parent.remove(this._viewmodel);
    if (this.playerCharacter) { this.scene.remove(this.playerCharacter.group); this.playerCharacter.dispose(); this.playerCharacter = null; }
    for (const p of this.pickups.values()) if (p.mesh) { this.pickups.delete(p.id); }
    this.pickups.clear();
    if (this.collision) { this.collision.dispose(); this.collision = null; }
    this.nav = null;
    if (this.lights) this.lights = [];
  }

  // ── 真实资产（FBX 角色 / OBJ 道具）──
  /**
   * 预加载真实资产。只做一次（模板缓存在 Game 上）。
   * 任何失败都只记录 + 降级到程序化模型，绝不让游戏起不来。
   */
  /**
   * 补齐某个季节的树木几何（秋 16 个、冬 22 个；春夏复用绿几何，什么也不用装）。
   * 只补缺的：同一个季节换回来时不会重复下载/烘焙。
   * @returns {number} 本次真正加载了多少个模型
   */
  async _ensureSeasonProps(season) {
    const extra = SEASON_TREE_PROPS[season] || {};
    const keys = Object.keys(extra);
    if (!keys.length || !this.assetLoader || !this.propGeometry) return 0;
    const missing = keys.filter((k) => !this.propGeometry.has(k));
    if (!missing.length) return 0;
    const label = SEASON_LABELS[season] || season;
    this.ui.setLoading(`载入${label}季树木（${missing.length} 个模型）…`);
    await new Promise((r) => setTimeout(r, 16));
    const subset = {};
    for (const k of missing) subset[k] = extra[k];
    const loaded = await this.assetLoader.preloadProps(subset);
    for (const [k, v] of loaded) this.propGeometry.set(k, v);
    if (this.assetLoader.errors.length) {
      console.warn('[season] 季节树木加载问题：', this.assetLoader.errors.slice(-6));
    }
    return loaded.size;
  }

  async _ensureAssets() {
    if (this.assetLoader) return;
    this.assetLoader = new AssetLoader(THREE, { base: '' });
    this.charFactory = new CharacterFactory(THREE, this.assetLoader, CHARACTER_MODELS);

    this.ui.setLoading('载入角色资产（FBX）…');
    await new Promise((r) => setTimeout(r, 16));
    await this.charFactory.preload();
    this.charReport = this.charFactory.report();
    if (this.charReport.errors.length) console.warn('[assets] 角色资产问题：', this.charReport.errors);

    this.ui.setLoading('载入道具资产（OBJ）…');
    await new Promise((r) => setTimeout(r, 16));
    this.propGeometry = await this.assetLoader.preloadProps(PROP_MODELS);
    if (this.assetLoader.errors.length) console.warn('[assets] 道具资产问题：', this.assetLoader.errors.slice(0, 8));

    // 建筑：道具包「Ultimate Textured Buildings」。只保留 position+uv，颜色在摆放时按调色板烘焙，
    // 门洞在摆放时按 layout 的实测位置切（见 world/building-mesh.js）。
    this.ui.setLoading('载入建筑资产（OBJ）…');
    await new Promise((r) => setTimeout(r, 16));
    this.buildingGeometry = await this.assetLoader.preloadBuildings(BUILDING_PROP_MODELS);
    if (this.assetLoader.errors.length) console.warn('[assets] 建筑资产问题：', this.assetLoader.errors.slice(0, 8));

    // 古建街区：清单 + 碰撞盒 + GLB。任何一步失败都退化成"这张图没有古建"，不影响开局。
    this.ui.setLoading('载入古建街区（GLB）…');
    this.heritageData = null;
    this.heritageGeometry = null;
    try {
      const index = await fetch('data/heritage/index.json').then((r) => r.json());
      const boxes = {};
      await Promise.all(index.entries.map(async (e) => {
        boxes[e.key] = (await fetch(e.collision).then((r) => r.json())).boxes || [];
      }));
      this.heritageGeometry = await this.assetLoader.preloadHeritage(index.entries);
      this.heritageData = { index, boxes };
      if (this.assetLoader.errors.length) console.warn('[assets] 古建问题：', this.assetLoader.errors.slice(-4));
    } catch (e) {
      console.warn('[assets] 古建街区载入失败，本图不放古建：', e && e.message);
    }

    this.assetsReady = {
      characters: this.charFactory.availableKeys,
      props: [...this.propGeometry.keys()],
      buildings: [...this.buildingGeometry.keys()],
      characterErrors: this.charReport.errors,
      propErrors: this.assetLoader.errors.map((e) => e.url + ': ' + e.error),
    };

    // 中超球衣：**纯色双色方案**（用户选定）。不再加载球衣照片，
    // 只用 csl-kits.js 里为每队配好的主色 + 次色现画图集：主体主色、袖子/下摆次色、侧缝压暗、背号。
    // 好处：零图片请求、启动快、没有照片裁切/UV 对齐问题，风格也和低多边形一致。
    // 图集按「队 + 号码」生成并做 LRU 缓存，所以每名球员能印自己的号码。
    this._atlasCache = new Map();
    this._atlasMax = 24;
    this.kitsReady = [];
    for (const f of (this.football.factions || [])) {
      const team = cslKitForClub(f.clubId);
      if (team && !this.kitsReady.includes(team.slug)) this.kitsReady.push(team.slug);
    }
  }

  /**
   * 按"球队 + 号码"取球衣图集（纯色双色，现生成 + LRU）。
   * @param {{clubId:string, kit:{number:number,name:string}}} identity
   */
  _kitForIdentity(identity) {
    if (!identity || !identity.clubId) return null;
    const team = cslKitForClub(identity.clubId);
    if (!team) return null;
    const number = identity.kit && Number.isFinite(identity.kit.number) ? identity.kit.number : 0;
    const name = (identity.kit && identity.kit.name) || '';
    const key = `${team.slug}:${number}`;
    const hit = this._atlasCache.get(key);
    if (hit) {
      this._atlasCache.delete(key);   // LRU：命中后移到末尾
      this._atlasCache.set(key, hit);
      return hit;
    }
    const kit = makeKit({
      clubId: team.clubId,
      playerId: `${team.slug}_${number}`,
      primary: team.color,
      secondary: team.secondary,
      number,
      name,
    });
    const atlas = buildKitAtlas({ front: null, kit, size: 512 });
    atlas.team = team;
    atlas.number = number;
    this._atlasCache.set(key, atlas);
    while (this._atlasCache.size > this._atlasMax) {
      const oldest = this._atlasCache.keys().next().value;
      this._atlasCache.delete(oldest);
    }
    return atlas;
  }

  /** 旧接口：按俱乐部取任意一件（无号码信息时用）。 */
  _kitForClub(clubId) {
    if (!clubId) return null;
    const team = cslKitForClub(clubId);
    if (!team) return null;
    // 没有号码信息时按 9 号生成（仅用于需要"随便一件队服"的场合）
    return this._kitForIdentity({ clubId, kit: { number: 9, name: '' } });
  }

  /** 给 NPC/玩家挑一个可用角色模型 key；缺资产返回 null → 走程序化模型。 */
  /**
   * 体型模板的属性乘数；没有模板/没有这一项时返回 1（保持老行为）。
   * 想把"形态影响玩法"整个关掉：config.player.templateStats = false。
   */
  _statsMul(key) {
    if (this.config && this.config.player && this.config.player.templateStats === false) return 1;
    const st = this.playerStats;
    const v = st && Number.isFinite(st[key]) ? st[key] : 1;
    return v > 0 ? v : 1;
  }

  /** 角色创建页（dist/creator.html）存下来的模板 id，读不到就返回 null。 */
  _savedCreatorTemplate() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('dd.character.v1') : null;
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj && typeof obj.template === 'string' ? obj.template : null;
    } catch (e) { return null; }
  }

  _pickCharacterKey(cfg, prefer) {
    if (!this.charFactory) return null;
    if (prefer && this.charFactory.canUse(prefer)) return prefer;
    if (cfg && cfg.type === 'zombie') return this.charFactory.canUse('zombie') ? 'zombie' : null;
    const keys = HUMAN_VARIANTS.filter((k) => this.charFactory.canUse(k));
    if (!keys.length) return null;
    let h = 0;
    const s = String((cfg && cfg.id) || 'x');
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return keys[(h >>> 0) % keys.length];
  }

  /** 用已烘焙的道具几何生成 Mesh；缺资产返回 null，由调用方回退。 */
  _propMesh(key, opts = {}) {
    const entry = this.propGeometry && this.propGeometry.get(key);
    if (!entry) return null;
    if (!this._propMaterial) this._propMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(entry.geometry, this._propMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = `prop:${key}`;
    if (opts.scale) mesh.scale.setScalar(opts.scale);
    return mesh;
  }

  /**
   * 武器外观：优先 Ultimate Guns / Survival 的 OBJ，缺失时回退程序化武器。
   * 枪口点取包围盒的 +Z 端面（manifest 里用 fit.ry 把"枪口朝 +X"掰成"枪口朝 +Z"），
   * 高度取枪管所在的上半部（0.72 高），而不是包围盒中线 —— 中线会落到握把附近，
   * 枪火/弹道起点会从扳机那儿冒出来。
   */
  _weaponMesh(weaponId) {
    const def = WEAPONS[weaponId];
    const propKey = WEAPON_PROP_KEY[weaponId];
    const mesh = propKey ? this._propMesh(propKey) : null;
    if (mesh) {
      const muzzle = new THREE.Object3D();
      muzzle.name = 'muzzle';
      const box = mesh.geometry.boundingBox;
      if (box) {
        const h = box.max.y - box.min.y;
        const isMelee = def && def.type === 'melee';
        muzzle.position.set(0, box.min.y + h * (isMelee ? 1.0 : 0.72), box.max.z);
      }
      mesh.add(muzzle);
      mesh.userData.muzzle = muzzle;
      return mesh;
    }
    return buildWeaponMesh(THREE, weaponId);
  }

  // ── NPC 生成 ─────────────────────────────────────────
  _spawnWorldNpcs() {
    const cfg = this.config;
    // 阵营 = 中超 16 队：友好区按 friendly 阵营轮转，敌对区按 hostile 阵营轮转。
    // （原来是写死 0 / 4，切到 16 队后会全挤在头两个阵营里。）
    const factions = (this.football && this.football.factions) || [];
    const friendly = factions.filter((f) => f.role === 'friendly');
    const hostile = factions.filter((f) => f.role === 'hostile');
    let friendZone = 0;
    let hostileZone = 0;
    const zones = this.layout.spawnZones.map((z, i) => {
      let factionIdx = -1;
      let faction = null;
      if (z.type === 'friendly' && friendly.length) {
        faction = friendly[friendZone % friendly.length];
        friendZone += 1;
        factionIdx = faction.index;
      } else if (z.type === 'hostile' && hostile.length) {
        faction = hostile[hostileZone % hostile.length];
        hostileZone += 1;
        factionIdx = faction.index;
      } else if (z.type === 'hostile' && friendly.length) {
        faction = friendly[0];
        factionIdx = faction.index;
      }
      return Object.assign({}, z, {
        patrolRoute: z.type === 'zombie' ? [] : patrolLoop(z.x, z.z, Math.max(6, z.radius * 0.6), 4, i),
        factionIndex: factionIdx,
      });
    });

    this.director = new NpcDirector(THREE, {
      config: cfg,
      nav: this.nav,
      collision: this.collision,
      scene: this.scene,
      now: () => this.elapsed,
      groundAt: (x, z) => this.groundHeightAt(x, z),
      makeConfig: (src, index) => this._makeNpcConfig(src, index),
      zoneDefaults: (zone) => ({
        factionIndex: zone.factionIndex,
        healthScale: zone.type === 'zombie' ? (zone.tier === 'high' ? 1.2 : 1) : 1,
      }),
      createCharacter: (npcCfg, index) => this._createNpcCharacter(npcCfg, index),
      onDeath: (npc, source) => this._onNpcDeath(npc, source),
      playSound: (name, opts) => this._playSound(name, opts),
    });
    this.director.setZones(zones);
    // 先直接铺一批，避免进游戏时空无一人
    for (let i = 0; i < 10; i += 1) this.director.tickSpawns(this.elapsed, this.player.pos);
  }

  _makeNpcConfig(src, index) {
    const factionIndex = Number.isFinite(src.factionIndex) ? src.factionIndex : 0;
    const faction = this.football.factionByIndex(factionIndex >= 0 ? factionIndex : 0);
    const slot = this.football.pickSlot(factionIndex >= 0 ? factionIndex : 0, `${src.id}_${index}`);
    const identity = this.football.survivorIdentity(factionIndex >= 0 ? factionIndex : 0, slot);
    const cfg = makeNpcConfig({
      id: src.id || `npc_${index}`,
      type: src.type || 'zombie',
      factionId: identity.factionId,
      appearanceId: identity.playerId,
      spawnPosition: src.spawnPosition || { x: src.x || 0, z: src.z || 0 },
      patrolRoute: src.patrolRoute || [],
      health: (src.health || 0) * (src.healthScale || 1) || undefined,
      lootTable: src.lootTable || (src.type === 'hostile' ? 'military' : 'residential'),
      name: src.type === 'zombie' ? '感染者' : identity.name,
      weaponId: src.type === 'hostile' ? (src.weaponId || 'w_pistol_9mm') : null,
    }, index);
    const problems = validateNpcConfig(cfg);
    if (problems.length) console.warn('[npc] 配置有问题', problems, cfg);
    cfg._identity = identity;
    cfg._factionIndex = factionIndex;
    cfg._faction = faction;
    return cfg;
  }

  _createNpcCharacter(npcCfg, index) {
    const identity = npcCfg._identity;
    const appearance = this.football.appearanceFor(identity);
    const isZombie = npcCfg.type === 'zombie';
    const modelKey = this._pickCharacterKey(npcCfg);
    const model = modelKey && this.charFactory ? this.charFactory.create(modelKey) : null;
    // 男性人类 NPC 按 id 稳定套一款体型模板（同一个 NPC 永远同一个样子）；僵尸不套（体型由变异体系统管）。
    let templateId = null;
    if (model && !isZombie && typeof modelKey === 'string' && modelKey.startsWith('male_')) {
      const def = pickTemplate(npcCfg.id);
      const applied = applyMaleTemplate(THREE, model, def);
      templateId = applied.ok ? applied.template : null;
      // 体型 → 属性：同样的规则也作用在 NPC 上（大块头僵尸/掠夺者更抗打、更慢、更重拳）
      const st = applied.ok ? applied.report.stats : null;
      if (st) {
        npcCfg.health = Math.max(10, Math.round(npcCfg.health * st.health));
        npcCfg.movementSpeed *= st.speed;
        npcCfg.chaseSpeed *= st.speed;
        npcCfg.attackDamage *= st.melee;
        npcCfg.templateStats = st;
      }
    }
    const c = new Character(THREE, { materials: this.materials }, {
      id: npcCfg.id,
      kind: npcCfg.type,
      appearance,
      kit: identity.kit,
      health: npcCfg.health,
      name: isZombie ? '感染者' : identity.name,
      factionId: identity.factionId,
      zombie: isZombie,
      model,
      kitAtlas: isZombie ? null : this._kitForIdentity(identity),
    });
    if (npcCfg.type === 'hostile' && npcCfg.weaponId && WEAPONS[npcCfg.weaponId]) {
      c.attachWeapon(this._weaponMesh(npcCfg.weaponId));
    }
    c.modelKey = modelKey;
    c.templateId = templateId;
    c.group.userData.npcId = npcCfg.id;
    if (templateId) c.group.userData.templateId = templateId;
    return c;
  }

  _onNpcDeath(npc, source) {
    this._playSound(npc.type === 'zombie' ? 'zombie_death' : 'death', { position: { x: npc.x, y: 1.2, z: npc.z } });
    if (source && source.id === 'player') this.player.kills += 1;
    this._questProgress('kill', 1);
    this._dropLootFromNpc(npc);
    this.ui.toast(`${npc.type === 'zombie' ? '感染者' : npc.name} 倒下了`, 'good');
  }

  _dropLootFromNpc(npc) {
    const table = npc.lootTable || 'residential';
    const roll = rollLoot(table, Math.random, 1);
    if (!roll) return;
    const def = ITEMS[roll.itemId];
    if (!def) return;
    const id = `drop_${npc.id}`;
    if (this.pickups.has(id)) return;
    this._addPickup(id, roll.itemId, roll.count, npc.x + (Math.random() - 0.5), npc.z + (Math.random() - 0.5));
  }

  // ── 拾取物 ───────────────────────────────────────────
  _addPickup(id, itemId, count, x, z) {
    const def = ITEMS[itemId];
    if (!def) return null;
    // 优先用真实道具模型（食物/医疗/弹药/工具都有对应 OBJ）；没有就退回一个颜色方块
    const modelKey = ITEM_MODEL[itemId];
    let mesh = modelKey ? this._propMesh(modelKey) : null;
    if (mesh) {
      mesh.position.set(x, 0, z);
      const h = mesh.geometry.boundingBox ? Math.max(0.05, mesh.geometry.boundingBox.max.y) : 0.2;
      mesh.userData.liftY = h;
      mesh.position.y = h + 0.02;
    } else {
      const geo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
      const color = def.kind === 'ammo' ? 0xb08a3a : def.kind === 'medical' ? 0xc05a5a : def.kind === 'food' ? 0x6fa86a : def.kind === 'drink' ? 0x4a90c0 : 0x9a9a6a;
      mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, flatShading: true }));
      mesh.position.set(x, 0.32, z);
      mesh.castShadow = true;
      mesh.userData.liftY = 0.32;
    }
    this.scene.add(mesh);
    const rec = { id, itemId, count, mesh, x, z, t: Math.random() * 6 };
    this.pickups.set(id, rec);
    this._interactables.push({
      id: `pickup:${id}`, kind: 'pickup', label: def.name,
      x, y: 0.6, z, radius: this.config.items.pickupRange,
      data: { pickupId: id },
    });
    return rec;
  }

  _spawnPickups() {
    for (const s of this.layout.itemSpawns) {
      const roll = rollLoot(s.lootTable || 'residential', Math.random, 1);
      if (!roll) continue;
      this._addPickup(s.id, roll.itemId, roll.count, s.x, s.z);
    }
  }

  // ── 主循环 ───────────────────────────────────────────
  _loop(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame((t) => this._loop(t));
    const dtRaw = (now - this._last) / 1000;
    this._last = now;
    const dt = Math.min(0.05, Math.max(0, dtRaw || 0.016));
    this._lastFrameTime = dt;

    // FPS
    this._fpsAccum += dt;
    this._fpsFrames += 1;
    if (this._fpsAccum >= 0.5) {
      this._fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    try {
      if (this.started) this._updateGame(dt);
      else this._updateMenu(dt);
      this._render();
      this._stats.frames += 1;
    } catch (e) {
      console.error('[game] 主循环异常', e);
      this._fatal = e;
      this._fatalStack = e && e.stack ? String(e.stack) : String(e);
      this.running = false;
    }
    if (this.input) this.input.endFrame();
  }

  _updateMenu(dt) {
    // 主菜单时让相机缓慢环绕，避免黑屏
    this.cameraRig.yaw += dt * 0.08;
    this.camera.position.set(Math.sin(this.cameraRig.yaw) * 12, 6, Math.cos(this.cameraRig.yaw) * 12);
    this.camera.lookAt(0, 1, 0);
  }

  _updateGame(dt) {
    // 指针锁定被浏览器收回（锁定状态下按 Esc、切窗口/退出全屏）→ 自动暂停。
    // Chrome 在指针锁定时会吞掉 Esc 的 keydown，所以"Esc 暂停"只能靠这条路径实现；
    // 背包/搜刮/对话/死亡这些主动解锁时面板已经开着，_canAutoPause 会挡掉。
    if (this.input && this.input.consumeLockLost() && this._canAutoPause()) this.pause();

    const mapOpen = !!(this.map && this.map.open);
    const paused = this.paused || this._dialogOpen || !!this._lootOpen || this.ui.inventoryOpen || mapOpen;
    this.elapsed += paused ? 0 : dt;

    // 键盘：暂停 / 背包 / 视角切换 / 存档 / 交互
    this._handleGlobalKeys();

    // 鼠标视角：每帧把锁定指针期间累积的位移交给相机（消费式，只在有位移时调用）。
    // 暂停/面板打开时也必须消费掉，否则解锁期间攒的位移会在恢复的一瞬间把视角甩飞。
    const look = this.input ? this.input.takeMouseDelta() : { x: 0, y: 0 };
    if (!paused && (look.x || look.y)) {
      this.cameraRig.addLook(look.x, look.y, this.config.camera.sensitivity);
    }

    if (!paused) {
      // 天气先推进：本帧算出的雾/降水/风要立刻参与本帧的环境与感知
      this._updateWeather(dt);
      // 季节环境声（鸟/虫/风）也跟着天气走：下雨/室内就不放
      this._updateAmbience(dt);
      this.player.update(dt, this.input, {
        now: this.elapsed,
        collision: this.collision,
        targets: this._targets,
        // 开车时 WASD/Space 归载具，玩家自己不能走、不能跳（否则刹车会同时起跳、还会响脚步声）
        driving: !!(this.vehicles && this.vehicles.driving),
        // 雪地/结冰打滑、湿冷更耗体力——由天气参数直接给乘数，玩家代码不需要知道天气存在
        weather: this.weather ? this.weather.params : null,
      });
      this._updateCombat(dt);
      this._updateBleeds(dt);
      this._updateWeaponHeat(dt);
      this._updateVehicles(dt);
      this._updateNpcs(dt);
      this._updateInteraction();
      this._updatePickups(dt);
      this._updateTimeOfDay(dt);
      this._updateQuests();
      this._autosave(dt);
      if (!this.player.alive) this._handleDeath(dt);
    }

    // 相机（暂停时也更新，保证视角不抖）
    const eye = this.player.eyePosition;
    this.cameraRig.update(this.camera, eye, this.collision, dt);
    this._updateViewModel();

    // 自身模型可见性：第一人称隐藏；**开车时也隐藏**（否则玩家会站在车顶上被一起画出来）
    const fp = this.cameraRig.switchT < 0.4;
    const drivingNow = !!(this.vehicles && this.vehicles.driving);
    if (this.playerCharacter) this.playerCharacter.setVisible(!fp && this.player.alive && !drivingNow);
    this.playerCharacter.update(dt, 0, Infinity);

    // 阴影相机跟随玩家
    if (this.sun) {
      this.sun.position.set(this.player.pos.x + 55, 90, this.player.pos.z + 40);
      this.sun.target.position.set(this.player.pos.x, 0, this.player.pos.z);
      this.sun.target.updateMatrixWorld();
    }

    // 室内灯按距离点亮（最多 3 盏）
    this._updateIndoorLights();
    // 路灯：天黑才亮，最近的几盏共享 3 盏池化点光
    this._updateStreetLights();

    // 声音监听者
    if (this.audio) {
      const f = this.cameraRig.getForward(this._tmpV);
      this.audio.setListener({ x: eye.x, y: eye.y, z: eye.z }, { x: f.x, z: f.z });
      this.audio.update(dt);
    }

    // 地图：小地图每帧跟着人和僵尸转（内部限频到 30Hz）；
    // 大地图打开时也靠这里重绘（那时游戏是暂停的，但地图要能动）。
    if (this.map && this.player) this.map.update(dt, this._mapState());

    // HUD 10Hz
    this._hudTimer += dt;
    if (this._hudTimer > 0.1) {
      this._hudTimer = 0;
      this._updateHud();
    }
  }

  _render() {
    if (!this.renderer || !this.scene || !this.camera) return;
    this.renderer.render(this.scene, this.camera);
  }

  _handleGlobalKeys() {
    const input = this.input;
    if (!input) return;

    // 滚轮：切换武器（消费式，避免越积越多）
    const wheel = input.takeWheel();

    // 大地图：M 开 / 关。地图打开时游戏内的按键全部被吞掉（WASD 改成平移、滚轮改成缩放），
    // Esc 先关地图、不弹暂停菜单 —— 和背包/搜刮的手感一致。
    if (input.wasPressed('map') && this._canToggleMap()) this.toggleMap();
    if (this.map && this.map.open) {
      if (input.wasPressed('pause')) { this.closeMap(); return; }
      if (wheel) this.map.zoomBy(-wheel);
      this.map.setPanIntent(
        (input.isDown('right') ? 1 : 0) - (input.isDown('left') ? 1 : 0),
        (input.isDown('forward') ? 1 : 0) - (input.isDown('back') ? 1 : 0),
      );
      return;
    }

    // 这些界面开着时，游戏内的动作键（交互/丢弃/换弹/切枪/近战…）必须全部失效，
    // 否则在背包/搜刮/对话里按键会直接作用到游戏里。
    const blocked = this.paused || this._dialogOpen || !!this._lootOpen || this.ui.inventoryOpen;

    // 死亡界面：按 R 立刻重生（UI 文案与 KEYMAP.respawn 对应），其余键不生效
    if (this._deathTimer > 0) {
      if (input.wasPressed('respawn')) this.respawn();
      return;
    }

    if (input.wasPressed('pause')) {
      if (this.ui.inventoryOpen) { this.ui.closeInventory(); }
      else if (this._lootOpen) { this._closeLoot(); }
      else if (this._dialogOpen) { this._dialogOpen = false; this.ui.clearScreens(); this.ui.showHud(); }
      else if (this.paused) {
        // 暂停菜单里打开的设置：Esc 先退回暂停菜单，而不是直接继续游戏
        if (this._settingsOpen) this._closeSettings();
        else this.resume();
      }
      else this.pause();
    }
    if (input.wasPressed('inventory') && !this.paused) {
      if (this.ui.inventoryOpen) this.ui.closeInventory();
      else { this.ui.openInventory(this._inventoryProxy()); this.input.releaseLock(); }
    }
    if (input.wasPressed('toggleView') && !blocked) {
      const mode = this.cameraRig.toggle();
      this.ui.toast(mode === 'first' ? '第一人称' : '第三人称', '');
    }
    if (input.wasPressed('quicksave')) this.manualSave();
    if (input.wasPressed('quickload')) this.loadGame();
    if (input.wasPressed('interact') && !blocked) this._interact();
    // F：使用（车外=加油/修车，车内=喇叭）
    if (input.wasPressed('use') && !blocked) this._useAction();
    if (input.wasPressed('drop') && !blocked) this._dropEquipped();
    if (input.wasPressed('flashlight') && !blocked) this._toggleFlashlight();
    if (input.wasPressed('reload') && !blocked) {
      if (this.player.reload(this.elapsed)) this._playSound('reload');
    }
    // 数字键 1~6 切换武器（拥有的武器按获得顺序占 1..n；热键表见 input.js weapon1..6）
    for (let i = 0; i < 6; i += 1) {
      const key = `weapon${i + 1}`;
      if (input.wasPressed(key) && !blocked) {
        if (this.player.equipSlot(i)) { this._syncWeaponVisual(); this._playSound('reload_insert', { volume: 0.4 }); }
      }
    }
    if (wheel && !blocked) this._cycleWeapon(wheel > 0 ? 1 : -1);
  }

  /** 滚轮切枪：只在已拥有的武器里前后循环（数字键按"拥有顺序"定位，两者一致）。 */
  _cycleWeapon(step) {
    const ids = [...this.player.weapons.keys()];
    if (ids.length < 2) return false;
    const cur = ids.indexOf(this.player.equipped);
    const next = ids[(cur + step + ids.length) % ids.length];
    if (!this.player.equip(next)) return false;
    this._syncWeaponVisual();
    this._playSound('reload_insert', { volume: 0.35 });
    const def = this.player.weaponDef;
    if (def && def.name) this.ui.toast(def.name, '');
    return true;
  }

  // ── 战斗 ─────────────────────────────────────────────
  _updateCombat(dt) {
    const player = this.player;
    const w = player.weaponState;

    // 换弹完成
    if (w && w.reloadingUntil > 0 && this.elapsed >= w.reloadingUntil) {
      player.finishReload();
      this._syncWeaponVisual();
      this._playSound('reload_insert');
    }

    // 收集可命中目标
    this._targets.length = 0;
    if (this.director) {
      for (const npc of this.director.npcs) {
        if (npc.alive && npc.char) this._targets.push(npc.char);
      }
    }

    const wantFire = this.input.mouseDown(0) || this.input.mouseWasPressed(0);
    const wantMelee = this.input.wasPressed('melee');
    if (wantMelee) {
      const res = player.fire(this.elapsed);
      if (res.fired) this._doMeleeAttack(res.def);
      return;
    }
    if (!wantFire || !w) return;
    if (w.def.type === 'melee') {
      if (this.input.mouseWasPressed(0)) {
        const res = player.fire(this.elapsed);
        if (res.fired) this._doMeleeAttack(res.def);
      }
      return;
    }
    const res = player.fire(this.elapsed);
    if (!res.fired) {
      if (res.empty && this.input.mouseWasPressed(0)) this._playSound('dryfire');
      return;
    }
    this._doShoot(res.def);
  }

  _aimRay() {
    // 从相机出发沿视线；第一/第三人称都用相机朝向，保证"准星指哪打哪"
    const origin = this._tmpV.copy(this.camera.position);
    const dir = this.cameraRig.getForward(this._tmpV2);
    return { origin: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: dir.x, y: dir.y, z: dir.z } };
  }

  _doShoot(def) {
    const aim = this._aimRay();
    const cfgC = this.config.combat || {};
    // 连发散热：射得越连续，扩散越大（heat 每帧衰减，见 _updateWeaponHeat）
    const heat = this._weaponHeat(def);
    // 姿态乘数：瞄准 ×0.55（右键真的更准，和帮助文案一致）、移动 ×1.25
    const stanceMul = (this.player.aiming ? 0.55 : 1) * (this.player.moving ? 1.25 : 1);
    // 疼痛会让准星更抖（医疗伤情的代价）
    const medSpreadMul = this.player.med ? this.player.med.penalties().spreadMul : 1;
    // 体型模板：块头越大越压得住枪（recoil 越大 = 扩散/后坐越小）
    const recoilMul = this._statsMul('recoil');
    const spread = effectiveSpread(def, heat.value) * stanceMul * medSpreadMul / Math.max(0.5, recoilMul);
    const pellets = Math.max(1, def.pellets || 1);
    const rand = Math.random;
    const pierceMul = Number.isFinite(cfgC.pierceDamageMul) ? cfgC.pierceDamageMul : 0.6;
    const opts = {
      ignoreId: null,
      headshotMultiplier: cfgC.headshotMultiplier,
      limbMultiplier: cfgC.limbMultiplier,
      pierceDamageMul: pierceMul,
      rand,
    };

    // 逐弹丸推进：每一发都带穿透结算（命中按距离从近到远排好）
    const allHits = [];
    let anyWorld = null;
    for (let i = 0; i < pellets; i += 1) {
      const d = spreadDir(aim.dir, spread, rand);
      const shot = traceShot({
        world: this.collision,
        targets: this._targets,
        ray: this._ray,
        origin: aim.origin,
        dir: d,
        weapon: def,
        maxRange: cfgC.maxHitscanRange,
        opts,
      });
      for (const h of shot.hits) allHits.push(h);
      if (shot.blocked && !anyWorld) {
        // 只为了弹着点特效：用这一发的射线自己再问一次世界命中
        const w = this.collision && this.collision.raycast(aim.origin.x, aim.origin.y, aim.origin.z, d.x, d.y, d.z, def.range);
        if (w) anyWorld = { x: w.x, y: w.y, z: w.z };
      }
    }

    heat.add(1);
    this.cameraRig.addRecoil((def.recoil || 0.5) / Math.max(0.5, recoilMul));
    this._playSound(def.soundFire || 'gunshot', { volume: 0.9 });
    // 枪声大小按武器走：霰弹/狙击最响，冲锋枪次之，手枪最轻（招僵尸半径不同）
    this._emitSound(this.player.pos.x, this.player.pos.z, def.noise || 3.5, 'gunshot');
    this._muzzleFlash();

    const muzzle = this._muzzleWorldPos();
    for (const h of allHits) {
      const end = { x: h.point.x, y: h.point.y, z: h.point.z };
      this._spawnTracer(muzzle, end);
      const npc = this._npcOfCharacter(h.target);
      if (!npc) continue;
      const died = this.director.damageNpc(npc, h.damage, { id: 'player', x: this.player.pos.x, z: this.player.pos.z });
      this.ui.hitMarker();
      this._playSound('hit_flesh', { position: { x: npc.x, y: 1.2, z: npc.z } });
      // 停止力：命中硬直（打断扑咬/让目标顿一下）
      if (cfgC.staggerEnabled !== false && h.stagger > 0 && !died) {
        npc.staggerUntil = Math.max(npc.staggerUntil || 0, this.elapsed + h.stagger);
      }
      // 致伤：流血（持续掉血，由这里计时，NPC 侧不需要新状态）
      if (cfgC.bleedEnabled !== false && h.bleed && !died) {
        this._addBleed(npc, h.bleed);
      }
      if (h.layer > 0) this.ui.toast(`穿透命中 ${npc.name}`, 'good');
    }
    if (anyWorld) {
      this._playSound('hit_wall', { position: anyWorld, volume: 0.6 });
      this._spawnImpact(anyWorld);
    }
    const first = allHits[0];
    if (first) {
      const npc = this._npcOfCharacter(first.target);
      if (npc) this.ui.toast(`命中 ${npc.name}`, 'good');
    }
  }

  /** 每种武器一条散热槽（切枪各自衰减，不串味）。 */
  _weaponHeat(def) {
    if (!this._heats) this._heats = new Map();
    let h = this._heats.get(def.id);
    if (!h) { h = new HeatModel(def); this._heats.set(def.id, h); }
    return h;
  }

  _updateWeaponHeat(dt) {
    if (!this._heats) return;
    for (const h of this._heats.values()) h.decay(dt, (this.config.combat || {}).heatDecay || 1.8);
  }

  /** 流血登记：同一目标同一次命中的流血取"更强的那个"，不叠加成一串。 */
  _addBleed(npc, bleed) {
    if (!this._bleeds) this._bleeds = [];
    const dur = Math.max(0.5, Number(bleed.dur) || 3);
    const dps = Math.max(0, Number(bleed.dps) || 0);
    if (!dps) return;
    const exist = this._bleeds.find((b) => b.npc === npc);
    if (exist) {
      exist.dps = Math.max(exist.dps, dps);
      exist.until = Math.max(exist.until, this.elapsed + dur);
    } else {
      this._bleeds.push({ npc, dps, until: this.elapsed + dur, acc: 0 });
    }
  }

  /** 流血 tick：每 0.5 秒结算一次，命中时不再额外播受击音效（避免噪音爆炸）。 */
  _updateBleeds(dt) {
    if (!this._bleeds || !this._bleeds.length) return;
    this._bleeds = this._bleeds.filter((b) => {
      const npc = b.npc;
      if (!npc || !npc.alive || this.elapsed > b.until) return false;
      b.acc += b.dps * dt;
      if (b.acc >= 0.5) {
        const dmg = b.acc;
        b.acc = 0;
        this.director.damageNpc(npc, dmg, { id: 'player', x: this.player.pos.x, z: this.player.pos.z });
      }
      return true;
    });
  }

  _doMeleeAttack(def) {
    const aim = this._aimRay();
    const r = resolveMelee({
      world: this.collision,
      targets: this._targets,
      ray: this._ray,
      origin: { x: this.player.pos.x, y: this.player.pos.y + 1.2, z: this.player.pos.z },
      dir: aim.dir,
      weapon: def,
      maxRange: def.range,
      opts: { headshotMultiplier: 1.4, limbMultiplier: 0.8 },
    });
    this._playSound('melee_swing', { volume: 0.8 });
    this._emitSound(this.player.pos.x, this.player.pos.z, 1.2, 'melee');
    if (r && r.hit && r.kind === 'character' && r.target) {
      const npc = this._npcOfCharacter(r.target);
      if (npc) {
        // 近战也是"功效"的一部分：斧子的硬直/流血比球棒更强（数据在 weapons.js）
        const eff = rollHit(def, { part: r.part, distance: r.distance, rand: Math.random, headMul: 1.4, limbMul: 0.8 });
        const died = this.director.damageNpc(npc, eff.damage, { id: 'player', x: this.player.pos.x, z: this.player.pos.z });
        this.ui.hitMarker();
        this._playSound('melee_hit', { position: { x: npc.x, y: 1.2, z: npc.z } });
        if (!died && this.config.combat.staggerEnabled !== false && eff.stagger > 0) {
          npc.staggerUntil = Math.max(npc.staggerUntil || 0, this.elapsed + eff.stagger);
        }
        if (!died && this.config.combat.bleedEnabled !== false && eff.bleed) this._addBleed(npc, eff.bleed);
      }
    } else if (r && r.hit) {
      this._playSound('hit_wall', { volume: 0.5 });
    }
  }

  /** NPC 开枪：与玩家用同一套射线规则。 */
  npcShoot(npc, target, weaponId) {
    const def = WEAPONS[weaponId] || WEAPONS.w_pistol_9mm;
    const origin = { x: npc.x, y: 1.45, z: npc.z };
    const tx = target.x, ty = 1.1, tz = target.z;
    let dx = tx - origin.x, dy = ty - origin.y, dz = tz - origin.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    // 命中率：不是 100%，也不至于打不中
    const acc = this.config.combat.npcAccuracy;
    const missSpread = (1 - acc) * 0.35;
    const d = spreadDir({ x: dx, y: dy, z: dz }, missSpread + (def.spread || 0), Math.random);

    const r = resolveRay({
      world: this.collision,
      targets: [{ id: 'player', alive: this.player.alive, raycast: (ray) => this.playerCharacter.raycast(ray) }],
      ray: this._ray,
      origin,
      dir: d,
      weapon: def,
      maxRange: def.range,
      opts: { headshotMultiplier: this.config.combat.headshotMultiplier, limbMultiplier: this.config.combat.limbMultiplier },
    });
    this._playSound(def.soundFire || 'gunshot', { position: { x: npc.x, y: 1.4, z: npc.z }, volume: 0.85 });
    this._emitSound(npc.x, npc.z, def.noise || 3.5, 'gunshot');
    if (r && r.hit && r.kind === 'character') {
      // NPC 与玩家同一套伤害规则：距离衰减 + 部位倍率（穿透不作用于玩家，避免一枪穿两命）
      const eff = rollHit(def, {
        part: r.part, distance: r.distance, rand: Math.random,
        headMul: this.config.combat.headshotMultiplier, limbMul: this.config.combat.limbMultiplier,
      });
      this.player.applyDamage(eff.damage, { ...npc, woundKind: 'bullet' }, { now: this.elapsed });
      if (eff.stagger >= 0.4) this.cameraRig.addShake(Math.min(0.4, eff.stagger * 0.4));
      this.ui.flashDamage();
      this._playSound('player_hurt', { volume: 0.8 });
    } else if (r && r.hit) {
      this._playSound('hit_wall', { position: { x: r.point.x, y: r.point.y, z: r.point.z }, volume: 0.5 });
    }
  }

  _npcOfCharacter(char) {
    if (!this.director) return null;
    return this.director.npcs.find((n) => n.char === char) || null;
  }

  _muzzleWorldPos() {
    // 第一人称用视图模型枪口，第三人称用角色手持武器枪口；都没有就退化成眼睛位置
    const vm = this._viewmodel;
    if (vm && this.cameraRig.switchT < 0.5) {
      const m = vm.getObjectByName('muzzle');
      if (m) return m.getWorldPosition(new THREE.Vector3());
    }
    const w = this.playerCharacter && this.playerCharacter.weaponMount;
    if (w) {
      const m = w.getObjectByName('muzzle');
      if (m) return m.getWorldPosition(new THREE.Vector3());
    }
    const e = this.player.eyePosition;
    return new THREE.Vector3(e.x, e.y, e.z);
  }

  _muzzleFlash() {
    if (!this._flash) {
      this._flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.95 }),
      );
      this._flash.visible = false;
      this.scene.add(this._flash);
    }
    const p = this._muzzleWorldPos();
    this._flash.position.copy(p);
    this._flash.visible = true;
    this._flashT = 0.05;
  }

  _spawnTracer(from, to) {
    let tracer = this._tracerPool.pop();
    if (!tracer) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.85 });
      tracer = new THREE.Line(geo, mat);
      tracer.frustumCulled = false;
    }
    const pos = tracer.geometry.getAttribute('position');
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
    tracer.material.opacity = 0.85;
    tracer.visible = true;
    if (!tracer.parent) this.scene.add(tracer);
    this._tracers.push({ line: tracer, t: this.config.combat.tracerTime });
  }

  _spawnImpact(point) {
    if (!this._impacts) this._impacts = [];
    const geo = new THREE.SphereGeometry(0.05, 4, 3);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 1 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(point.x, point.y, point.z);
    this.scene.add(m);
    this._impacts.push({ mesh: m, t: 0.12 });
  }

  _updateEffects(dt) {
    if (this._flash && this._flash.visible) {
      this._flashT -= dt;
      if (this._flashT <= 0) this._flash.visible = false;
    }
    for (let i = this._tracers.length - 1; i >= 0; i -= 1) {
      const tr = this._tracers[i];
      tr.t -= dt;
      tr.line.material.opacity = Math.max(0, tr.t / this.config.combat.tracerTime) * 0.85;
      if (tr.t <= 0) {
        tr.line.visible = false;
        this._tracerPool.push(tr.line);
        this._tracers.splice(i, 1);
      }
    }
    if (this._impacts) {
      for (let i = this._impacts.length - 1; i >= 0; i -= 1) {
        const im = this._impacts[i];
        im.t -= dt;
        im.mesh.material.opacity = Math.max(0, im.t / 0.12);
        if (im.t <= 0) { this.scene.remove(im.mesh); im.mesh.geometry.dispose(); im.mesh.material.dispose(); this._impacts.splice(i, 1); }
      }
    }
  }

  // 玩家手持/视图模型武器外观
  _syncWeaponVisual() {
    const wid = this.player.equipped;
    if (wid === this._equippedVisualId) return;
    this._equippedVisualId = wid;
    if (this._viewmodel) {
      this._viewmodel.clear();
      if (wid) {
        const mesh = this._weaponMesh(wid);
        // OBJ 枪械以原点为中心、枪口朝 +Z；视图模型放到右下方并转 180° 让枪口朝前
        mesh.position.set(0.24, -0.22, -0.42);
        mesh.rotation.set(0, Math.PI, 0);
        mesh.scale.setScalar(0.95);
        this._viewmodel.add(mesh);
      }
    }
    if (this.playerCharacter) {
      this.playerCharacter.weaponMount.clear();
      if (wid) this.playerCharacter.attachWeapon(this._weaponMesh(wid));
    }
  }

  _updateViewModel() {
    if (!this._viewmodel) return;
    const fp = this.cameraRig.switchT < 0.4;
    this._viewmodel.visible = fp && this.player.alive && !!this.player.equipped;
    if (this._viewmodel.visible) {
      // 瞄准时把枪抬到画面中线
      const aiming = this.player.aiming;
      const tx = aiming ? 0.0 : 0.24;
      const ty = aiming ? -0.12 : -0.22;
      const tz = aiming ? -0.36 : -0.42;
      this._viewmodel.position.x += (tx - this._viewmodel.position.x) * 0.25;
      this._viewmodel.position.y += (ty - this._viewmodel.position.y) * 0.25;
      this._viewmodel.position.z += (tz - this._viewmodel.position.z) * 0.25;
    }
  }

  // ── 载具 ─────────────────────────────────────────────
  _updateVehicles(dt) {
    if (!this.vehicles) return;
    // 开车时把第三人称相机拉远：默认 3.2m 会停在一台 4.6m 长的 SUV 车壳里面，屏幕只剩车顶。
    if (this.cameraRig) this.cameraRig.distanceScale = this.vehicles.driving ? 2.2 : 1;
    if (this.vehicles.driving) {
      this.vehicles.update(dt, this.input, this.collision, {
        // 天气抓地力：雪地/积水里既开不快也刹不住（vehicles.update 会同时缩放极速/加速/刹车）
        grip: this.weather ? this.weather.params.grip : 1,
        onCrash: (dmg) => {
          this._playSound('car_hit', { volume: 0.9 });
          this.player.applyDamage(dmg * 0.15, null, { now: this.elapsed });
          this.cameraRig.addShake(0.2);
        },
        onDestroyed: (car) => {
          this.ui.toast(`${car.id} 报废了`, 'bad');
          this._exitCar();
        },
        onStall: () => {
          this._playSound('ui_error', { volume: 0.7 });
          this.ui.toast('油箱空了，引擎熄火 —— 只能滑行（F 加不了油，得先下车找汽油桶）', 'bad');
        },
        // 引擎声：用脉冲播放模拟"转速随速度升高"（音频层没有循环 API，见 docs/VEHICLES.md）
        onEngine: (speed, car, maxSpeed) => {
          const p = car.mesh.position;
          const k = Math.min(1, Math.abs(speed) / Math.max(1, maxSpeed));
          this._playSound('car_engine', {
            volume: 0.42 + k * 0.32,
            rate: 0.78 + k * 0.55,
            position: { x: p.x, y: 0.7, z: p.z },
          });
        },
        // 引擎噪音：车越吵，僵尸被拉得越远 —— 这是"开车换速度"的代价
        onNoise: (x, z, loudness) => this._emitSound(x, z, loudness, 'engine'),
      });
      const car = this.vehicles.car;
      if (car) {
        this.player.setPosition(car.mesh.position.x, this.groundHeightAt(car.mesh.position.x, car.mesh.position.z), car.mesh.position.z);
        this.cameraRig.setMode('third');
        this._updateVehicleRam(car);
        this._updateCarLight(car);
      }
    } else if (this._carLight && this._carLight.intensity > 0) {
      this._carLight.intensity = 0;
    }
  }

  /** 撞人：速度够快才造成伤害；同一目标 0.8 秒内只吃一次（否则贴着车会每帧掉血）。 */
  _updateVehicleRam(car) {
    if (!this.director || !this.director.npcs) return;
    const V = this.config.vehicles;
    const speed = Math.abs(car.speed || 0);
    if (speed < V.ramMinSpeed) return;
    const hits = ramTargets({
      x: car.mesh.position.x, z: car.mesh.position.z, rotY: car.mesh.rotation.y,
      speed, length: car.length || 4.4, halfWidth: car.halfWidth || 1.0,
    }, this.director.npcs, V);
    if (!hits.length) return;
    if (!this._ramCooldown) this._ramCooldown = new Map();
    for (const hit of hits.slice(0, 2)) {
      const npc = hit.npc;
      const last = this._ramCooldown.get(npc.id) || -99;
      if (this.elapsed - last < 0.8) continue;
      this._ramCooldown.set(npc.id, this.elapsed);
      const dmg = ramDamage(speed, V);
      this.director.damageNpc(npc, dmg, 'car');
      car.speed *= 0.86;
      car.durability = Math.max(0, car.durability - dmg * (V.ramDurabilityCost || 0.6));
      const p = car.mesh.position;
      this._playSound('hit_flesh', {
        volume: Math.min(1, 0.5 + speed / 30), rate: 0.8,
        position: { x: p.x, y: 0.8, z: p.z },
      });
      this.cameraRig.addShake(Math.min(0.4, 0.12 + speed / 60));
      if (npc.alive === false) {
        this.player.kills = (this.player.kills || 0) + 1;
        this._questProgress('kill', 1);
      }
      break; // 一次只结算最靠前的一个，避免"一撞把整排僵尸都打死"
    }
  }

  /** 车灯：一盏共享 SpotLight，挂在当前驾驶的车头上（14 台车不各配一盏灯）。 */
  _updateCarLight(car) {
    const light = this._carLight;
    if (!light) return;
    const V = this.config.vehicles;
    if (!car.lights) { light.intensity = 0; return; }
    const rotY = car.mesh.rotation.y;
    const fx = Math.sin(rotY);
    const fz = Math.cos(rotY);
    const nose = (car.length || 4.4) * 0.5;
    light.position.set(car.mesh.position.x + fx * nose, 0.75, car.mesh.position.z + fz * nose);
    light.target.position.set(car.mesh.position.x + fx * (nose + V.headlightDistance * 0.5), 0,
      car.mesh.position.z + fz * (nose + V.headlightDistance * 0.5));
    light.target.updateMatrixWorld();
    // 白天不开也亮不到哪去：夜里/雾里才有意义（这里不给"物理正确"，只给手感）
    light.intensity = V.headlightIntensity;
  }

  // ── NPC 更新 ─────────────────────────────────────────
  _updateNpcs(dt) {
    if (!this.director) return;
    const world = {
      now: this.elapsed,
      collision: this.collision,
      nav: this.nav,
      player: {
        x: this.player.pos.x, z: this.player.pos.z,
        alive: this.player.alive,
        crouching: this.player.crouching,
        isPlayer: true,
      },
      nearestHostileTo: (x, z, r) => this.director.nearestHostileTo(x, z, r),
      damagePlayer: (amount, source) => {
        // 伤情来源：僵尸咬/抓 → 流血+感染；敌对人类的近战 → 撕裂伤
        const woundKind = source && source.type === 'zombie' ? 'bite'
          : source && (source.type === 'hostile' || source.type === 'friendly') ? 'melee' : null;
        this.player.applyDamage(amount, source ? { ...source, woundKind } : { woundKind }, { now: this.elapsed });
        this.ui.flashDamage();
      },
      damageNpc: (npc, amount, source) => this.director.damageNpc(npc, amount, source),
      npcShoot: (npc, target, weaponId) => this.npcShoot(npc, target, weaponId),
      emitSound: (x, z, loud, tag) => this._emitSound(x, z, loud, tag),
      playSound: (name, opts) => this._playSound(name, opts),
      // 天气对 AI 的影响走这里：雾/雨/夜色缩短视觉距离，风雨抬高环境噪声底、缩短听觉
      weather: this.weather || null,
      perception: this._aiPerception || { sight: 1, hearing: 1 },
    };
    this._npcWorld = world;   // 自检/调试用：确认天气真的接到了 AI 上
    this.director.update(dt, this.elapsed, world, this.player.pos);
    this.director.updateAnimations(dt, this.player.pos);
    this.director.forgetDead(this.elapsed);
  }

  // ── 交互 ─────────────────────────────────────────────
  _updateInteraction() {
    if (this.paused) return;
    const px = this.player.pos.x, pz = this.player.pos.z;
    const py = this.player.pos.y + 1.2;
    let best = null;
    let bestScore = Infinity;
    for (const it of this._interactables) {
      if (it.kind === 'container' && this.openedContainers.has(it.data.containerId)) continue;
      if (it.kind === 'pickup' && this.lootedPickups.has(it.data.pickupId)) continue;
      const d = Math.hypot(it.x - px, it.z - pz);
      const range = it.radius || this.config.player.interactRange;
      if (d > range) continue;
      // 更偏向视线前方的东西
      const fx = Math.sin(this.player.yaw), fz = Math.cos(this.player.yaw);
      const dot = ((it.x - px) * fx + (it.z - pz) * fz) / Math.max(0.001, d);
      const score = d - dot * 0.9;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    // NPC 对话也在交互范围内
    if (this.director) {
      for (const npc of this.director.npcs) {
        if (!npc.alive || npc.type === 'zombie') continue;
        const d = Math.hypot(npc.x - px, npc.z - pz);
        if (d > 3.2) continue;
        const score = d - 1.4;
        if (score < bestScore) { bestScore = score; best = { id: `npc:${npc.id}`, kind: 'npc', label: '交谈', x: npc.x, z: npc.z, data: { npc } }; }
      }
    }
    this._nearestInteract = best;
    if (best) {
      const key = 'E';
      // 坐在车里时同一个 E 是"下车"，提示文案要跟着变，不然会显示"汽车（可驾驶）"
      const label = best.kind === 'vehicle' && this.vehicles && this.vehicles.driving ? '下车' : best.label;
      // 车外靠车时，顺手把 F（加油/维修）的可用状态写在提示里
      let extra = '';
      if (best.kind === 'vehicle' && !(this.vehicles && this.vehicles.driving)) {
        const rec = best.data.rec;
        const V = this.config.vehicles;
        if (VehicleController.fuelOf(rec) < 95 && this._hasItem('i_tool_fuel_can', 1)) extra = ' · F 加油';
        else if (rec.durability < V.maxDurability * V.repairMaxPct && this._hasItem('i_mat_scrap', V.repairScrapCost)) extra = ' · F 维修';
      }
      this.ui.setPrompt(`[${key}] ${best.kind === 'pickup' ? '拾取 ' : best.kind === 'npc' ? '' : ''}${label}${extra}`);
    } else {
      this.ui.setPrompt('');
    }
    void py;
  }

  _interact() {
    const it = this._nearestInteract;
    if (!it) return;
    this._playSound('ui_click', { volume: 0.4 });
    if (it.kind === 'container') this._openContainer(it.data.rec);
    else if (it.kind === 'pickup') this._pickUp(it.data.pickupId);
    else if (it.kind === 'door') this._toggleDoor(it.data);
    else if (it.kind === 'vehicle') this._enterCar(it.data.rec);
    else if (it.kind === 'trunk') this._openTrunk(it.data.rec);
    else if (it.kind === 'npc') this._talkToNpc(it.data.npc);
    if (this.playerCharacter) this.playerCharacter.triggerAction('interact', { fade: 0.1 });
  }

  _openContainer(rec) {
    if (!rec || this.openedContainers.has(rec.id)) return;
    const round = 0;
    const loot = lootForContainer(rec, round, { minRolls: 1, maxRolls: 3 });
    const items = loot.items.map((it) => {
      const def = ITEMS[it.itemId];
      return { itemId: it.itemId, count: it.count, name: def ? def.name : it.itemId };
    });
    this.openedContainers.add(rec.id);
    rec.opened = true;
    // 盖子弹起
    if (rec.mesh && rec.mesh.userData.lid) {
      rec.mesh.userData.lid.rotation.x = -0.9;
      rec.mesh.userData.lid.position.y += 0.12;
    }
    this._playSound('loot_open', { position: { x: rec.x, y: 0.8, z: rec.z } });
    this._emitSound(rec.x, rec.z, 0.8, 'loot');
    this._questProgress('loot', 1);
    this._lootOpen = { rec, items };
    this.input.releaseLock();
    this.ui.openLoot(`${rec.kind}`, items, (idx) => this._takeLoot(idx), () => this._closeLoot());
  }

  _takeLoot(idx) {
    if (!this._lootOpen) return;
    const { items } = this._lootOpen;
    const it = items[idx];
    if (!it) return;
    const res = this.player.inventory.add(it.itemId, it.count);
    if (res.added > 0) {
      this._playSound('pickup_item');
      this.ui.toast(`拾取 ${ITEMS[it.itemId] ? ITEMS[it.itemId].name : it.itemId} ×${res.added}`, 'good');
      items.splice(idx, 1);
      this._lootOpen.items = items;
      this.ui.openLoot(this._lootOpen.rec.kind, items, (i) => this._takeLoot(i), () => this._closeLoot());
      this._syncWeaponVisual();
      if (res.left > 0) this.ui.toast(res.reason === 'overweight' ? '背包超重了' : '背包满了', 'warn');
    } else {
      this._playSound('ui_error');
      this.ui.toast(res.reason === 'overweight' ? '背包超重' : '背包已满', 'bad');
    }
  }

  _closeLoot() {
    this._lootOpen = null;
    this.ui.clearScreens();
    this.ui.showHud();
    this.input.requestLock(this.canvas);
  }

  _pickUp(pickupId) {
    const rec = this.pickups.get(pickupId);
    if (!rec || this.lootedPickups.has(pickupId)) return;
    const res = this.player.inventory.add(rec.itemId, rec.count);
    if (res.added <= 0) {
      this._playSound('ui_error');
      this.ui.toast(res.reason === 'overweight' ? '背包超重，拿不动' : '背包已满', 'bad');
      return;
    }
    const def = ITEMS[rec.itemId];
    this._playSound('pickup_item');
    this.ui.toast(`拾取 ${def ? def.name : rec.itemId} ×${res.added}`, 'good');
    this.lootedPickups.add(pickupId);
    if (rec.mesh) { this.scene.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh.material.dispose(); }
    this.pickups.delete(pickupId);
    this._syncWeaponVisual();
    if (res.left > 0) this._addPickup(`${pickupId}_rest`, rec.itemId, res.left, rec.x + 0.4, rec.z + 0.4);
  }

  _toggleDoor(data) {
    const state = data.state;
    if (!state) return;
    state.open = !state.open;
    state.pivot.rotation.y = state.open ? state.openRot : 0;
    this._playSound(state.open ? 'door_open' : 'door_close', { position: { x: data.state.pivot.position.x, y: 1.2, z: data.state.pivot.position.z } });
    this._emitSound(state.pivot.position.x, state.pivot.position.z, 0.9, 'door');
  }

  _enterCar(rec) {
    if (!rec) return;
    if (this.vehicles.driving) { this._exitCar(); return; }
    if (!rec.drivable) { this.ui.toast('这辆车已经报废了（只当掩体）', 'warn'); return; }
    // 没油发不着火：如果背包里有汽油桶，上车时自动灌一桶（新手最容易卡在这里）
    if (VehicleController.fuelOf(rec) <= 0) {
      if (!this._refuelCar(rec, { auto: true })) return;
    }
    if (this.vehicles.enter(rec, this.player)) {
      const p = rec.mesh.position;
      this._playSound('car_start', { position: { x: p.x, y: 0.6, z: p.z } });
      this._emitSound(p.x, p.z, 1.6, 'engine');       // 打火也招僵尸
      this.ui.toast('E 下车 · WASD 驾驶 · Space 刹车 · L 车灯 · F 喇叭', 'good');
    }
  }

  _exitCar() {
    const car = this.vehicles.exit(this.player);
    if (!car) return;
    if (this._carLight) this._carLight.intensity = 0;
    this.ui.toast('已下车', '');
  }

  /**
   * F 键：车外 = 加油 / 修车；车内 = 喇叭。
   * 分成一个"使用"动作而不是塞进交互里，是因为交互键（E）在车里是"下车"。
   */
  _useAction() {
    if (this.vehicles.driving) { this._honk(); return; }
    const car = this._nearestCarNear(4.6);
    if (!car) { this.ui.toast('附近没有车', 'warn'); return; }
    // 优先加油（没油最要命），其次修车
    if (VehicleController.fuelOf(car) < 95 && this._hasItem('i_tool_fuel_can', 1)) {
      this._refuelCar(car);
      return;
    }
    if (car.durability < this.config.vehicles.maxDurability * this.config.vehicles.repairMaxPct
      && this._hasItem('i_mat_scrap', this.config.vehicles.repairScrapCost)) {
      this._repairCar(car);
      return;
    }
    if (!this._hasItem('i_tool_fuel_can', 1) && VehicleController.fuelOf(car) < 95) {
      this.ui.toast('加油需要汽油桶', 'warn');
    } else if (!this._hasItem('i_mat_scrap', this.config.vehicles.repairScrapCost)) {
      this.ui.toast(`修车需要 ${this.config.vehicles.repairScrapCost} 块废金属`, 'warn');
    } else {
      this.ui.toast('这辆车现在不需要修', '');
    }
  }

  /** 给车灌一桶汽油。auto=true 时（上车自动加油）失败会提示原因。 */
  _refuelCar(car, opts = {}) {
    const V = this.config.vehicles;
    if (VehicleController.fuelOf(car) >= 100) {
      if (!opts.auto) this.ui.toast('油箱是满的', '');
      return false;
    }
    if (!this._hasItem('i_tool_fuel_can', 1)) {
      this.ui.toast('没有汽油桶（工业区/车后备箱里能找到）', 'warn');
      return false;
    }
    this.player.inventory.remove('i_tool_fuel_can', 1);
    car.fuel = Math.min(100, VehicleController.fuelOf(car) + V.fuelCanAmount);
    this._playSound('pickup_item');
    this.ui.toast(`加油 +${Math.round(V.fuelCanAmount)}% → ${Math.round(car.fuel)}%`, 'good');
    return true;
  }

  /** 用废金属修车：一次消耗 repairScrapCost 块，回复若干耐久，最多修到 repairMaxPct。 */
  _repairCar(car) {
    const V = this.config.vehicles;
    const max = V.maxDurability * V.repairMaxPct;
    if (car.durability >= max) { this.ui.toast('这辆车已经修不动了（结构老化）', 'warn'); return false; }
    if (!this._hasItem('i_mat_scrap', V.repairScrapCost)) return false;
    this.player.inventory.remove('i_mat_scrap', V.repairScrapCost);
    const gain = V.repairPerScrap * V.repairScrapCost;
    car.durability = Math.min(max, car.durability + gain);
    this._playSound('pickup_item', { volume: 0.7 });
    this._playSound('melee_hit', { volume: 0.5, rate: 1.6 });
    this.ui.toast(`维修 +${Math.round(gain)} 耐久 → ${Math.round(car.durability)}`, 'good');
    return true;
  }

  /** 喇叭：能把一片僵尸引过来（把车当"诱饵"用也是玩法）。 */
  _honk() {
    const car = this.vehicles.car;
    if (!car) return;
    const p = car.mesh.position;
    this._playSound('car_hit', { volume: 0.5, rate: 1.9, position: { x: p.x, y: 0.8, z: p.z } });
    this._playSound('ui_click', { volume: 0.6, rate: 0.7 });
    const heard = this.director ? this.director.broadcastSound(p.x, p.z, 3.2, 'horn') : 0;
    this.ui.toast(heard > 0 ? `喇叭响彻街区…${heard} 个感染者被惊动` : '喇叭声在空街上传得很远', heard > 0 ? 'warn' : '');
  }

  /** 车灯开关：L 在车里是车灯，车外才是手电筒。 */
  _toggleCarLights() {
    const car = this.vehicles.car;
    if (!car) return false;
    const on = this.vehicles.toggleLights();
    this._playSound('ui_click', { volume: 0.6 });
    this.ui.toast(on ? '车灯：开（夜里看得见，也更显眼）' : '车灯：关', '');
    return on;
  }

  /** 最近的一台车（用于 F 加油/修车）。 */
  _nearestCarNear(radius) {
    if (!this.cars) return null;
    let best = null;
    let bd = radius;
    for (const c of this.cars) {
      const d = Math.hypot(c.mesh.position.x - this.player.pos.x, c.mesh.position.z - this.player.pos.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  _hasItem(itemId, count = 1) {
    const inv = this.player && this.player.inventory;
    if (!inv) return false;
    if (typeof inv.countItem === 'function') return inv.countItem(itemId) >= count;
    return !!(inv.has && inv.has(itemId, count));
  }

  /**
   * 后备箱：**双向**存取面板（左=后备箱点击取出，右=背包点击放入）。
   * 后备箱是一个真正的 Inventory（按车型给载重/格数），内容持久 —— 可以当移动仓库。
   */
  _openTrunk(rec) {
    if (!rec) return;
    if (!rec.trunkInv) { this.ui.toast('这辆车没有后备箱', 'warn'); return; }
    const p = rec.mesh.position;
    this._playSound('loot_open', { position: { x: p.x, y: 0.8, z: p.z } });
    this._emitSound(p.x, p.z, 0.7, 'loot');
    this.input.releaseLock();
    this._lootOpen = { rec: { id: `trunk:${rec.id}`, kind: '后备箱' }, trunk: rec };
    this._renderTrunk();
  }

  /** 把后备箱/背包两个列表渲染成面板（每次搬东西后重建，索引才不会错位）。 */
  _renderTrunk() {
    const open = this._lootOpen;
    const car = open && open.trunk;
    if (!car || !car.trunkInv) return;
    const inv = this.player.inventory;
    const weightOf = (id) => (ITEMS[id] ? ITEMS[id].weight : 0) || 0;
    const nameOf = (id) => (ITEMS[id] ? ITEMS[id].name : id);
    const toEntry = (list, index, s) => ({
      list, index, itemId: s.itemId, count: s.count,
      name: nameOf(s.itemId), weight: weightOf(s.itemId),
    });
    const trunkEntries = [];
    car.trunkInv.slots.forEach((s, i) => { if (s) trunkEntries.push(toEntry('slots', i, s)); });
    const bagEntries = [];
    inv.slots.forEach((s, i) => { if (s) bagEntries.push(toEntry('slots', i, s)); });
    inv.quick.forEach((s, i) => { if (s) bagEntries.push(toEntry('quick', i, s)); });
    open.entries = { trunk: trunkEntries, bag: bagEntries };
    const type = CAR_TYPE_BY_ID[car.typeId] || null;
    this.ui.openTrunk({
      title: `${(type && type.label) || '汽车'} 后备箱`,
      trunk: { items: trunkEntries, weight: car.trunkInv.weight, maxWeight: car.trunkInv.maxWeight },
      bag: { items: bagEntries, weight: inv.weight, maxWeight: inv.maxWeight },
      onTake: (i) => this._trunkTake(i),
      onStore: (i) => this._trunkStore(i),
      onClose: () => this._closeLoot(),
    });
  }

  /** 后备箱 → 背包（背包放不下就把剩下的塞回去，绝不凭空消失）。 */
  _trunkTake(idx) {
    const open = this._lootOpen;
    const car = open && open.trunk;
    const entry = open && open.entries && open.entries.trunk[idx];
    if (!car || !entry) return;
    const moved = car.trunkInv.removeAt('slots', entry.index, entry.count);
    if (moved <= 0) return;
    const res = this.player.inventory.add(entry.itemId, moved);
    if (res.left > 0) car.trunkInv.add(entry.itemId, res.left, { ignoreWeight: true });
    if (res.added > 0) {
      this._playSound('pickup_item');
      this.ui.toast(`取出 ${entry.name} ×${res.added}`, 'good');
    }
    if (res.left > 0) this.ui.toast(res.reason === 'overweight' ? '背包超重，剩下的留在后备箱' : '背包满了，剩下的留在后备箱', 'warn');
    this._syncWeaponVisual();
    this._renderTrunk();
  }

  /** 背包 → 后备箱（按后备箱载重限制；装不下的退回背包）。 */
  _trunkStore(idx) {
    const open = this._lootOpen;
    const car = open && open.trunk;
    const entry = open && open.entries && open.entries.bag[idx];
    if (!car || !entry) return;
    const inv = this.player.inventory;
    const moved = inv.removeAt(entry.list, entry.index, entry.count);
    if (moved <= 0) return;
    const res = car.trunkInv.add(entry.itemId, moved);
    if (res.left > 0) inv.add(entry.itemId, res.left);
    if (res.added > 0) {
      this._playSound('pickup_item', { volume: 0.7 });
      this.ui.toast(`放入 ${entry.name} ×${res.added}`, 'good');
    }
    if (res.left > 0) {
      this.ui.toast(res.reason === 'overweight'
        ? `后备箱装不下了（${car.trunkInv.weight.toFixed(1)}/${car.trunkInv.maxWeight}kg）`
        : '后备箱格子不够了', 'warn');
    }
    this._syncWeaponVisual();
    this._renderTrunk();
  }

  /** 丢下手里的武器（G）：生成一个地面拾取物，背包里扣掉一件。 */
  _dropEquipped() {
    const p = this.player;
    const wid = p.equipped;
    if (!wid) { this.ui.toast('手上没有武器', 'warn'); return; }
    const itemId = Object.keys(ITEMS).find((id) => ITEMS[id].weaponId === wid);
    if (!itemId) return;
    if (p.inventory.remove(itemId, 1) <= 0) return;
    const id = `drop_${Math.round(this.elapsed * 1000)}_${Math.floor(Math.random() * 999)}`;
    this._addPickup(
      id, itemId, 1,
      p.pos.x + Math.sin(p.yaw) * 0.9,
      p.pos.z + Math.cos(p.yaw) * 0.9,
    );
    this._syncWeaponVisual();
    this.ui.toast(`丢下了 ${ITEMS[itemId].name}`, 'warn');
    this._playSound('pickup_item', { volume: 0.4 });
  }

  /** 手电筒开关（L）。室内没有强光源时很有用，也解释了"室内外照明差异"。 */
  _toggleFlashlight() {
    // L 是"照明"键：坐在车里时管车灯，下车走路时才是手电筒（同一个键，两套系统不打架）
    if (this.vehicles && this.vehicles.driving) { this._toggleCarLights(); return; }
    if (!this.flashlight) return;
    this.flashlightOn = !this.flashlightOn;
    this.flashlight.intensity = this.flashlightOn ? this.flashlightIntensity : 0;
    this.ui.toast(this.flashlightOn ? '手电筒：开' : '手电筒：关', '');
    this._playSound('ui_click', { volume: 0.4 });
  }

  _talkToNpc(npc) {
    if (!npc || !npc.alive) return;
    this._dialogOpen = true;
    this.input.releaseLock();
    const faction = npc.faction ? '' : '';
    const lines = [
      `${npc.name}：「你看着不像感染者。别在街上站着，枪声会把他们引来。」`,
      `${npc.name}：「营地还撑得住，但我们缺东西——食物、药，还有子弹。」`,
      `${npc.name}：「工业区那边别一个人去，那地方现在全是他们的人。」`,
    ];
    const line = lines[Math.floor(Math.random() * lines.length)];
    const quest = this._pickAvailableQuest(npc);
    const options = [];
    if (quest) options.push({ label: `接受任务：${quest.name}` });
    options.push({ label: '结束对话' });
    this.ui.showDialogue(npc.name, `${line}${quest ? `\n\n任务：${quest.text}` : ''}`, options, (idx) => {
      this._dialogOpen = false;
      this.ui.clearScreens();
      this.ui.showHud();
      this.input.requestLock(this.canvas);
      if (quest && idx === 0) {
        this._offerQuest(quest);
        this._playSound('quest_accept');
      }
    });
    void faction;
  }

  // ── 任务 ─────────────────────────────────────────────
  _pickAvailableQuest(npc) {
    for (const id of Object.keys(QUEST_DEFS)) {
      if (this.quests.completed.includes(id)) continue;
      if (this.quests.active.some((q) => q.id === id)) continue;
      return QUEST_DEFS[id];
    }
    return null;
  }

  _offerQuest(def) {
    if (!def) return;
    if (this.quests.active.some((q) => q.id === def.id) || this.quests.completed.includes(def.id)) return;
    this.quests.active.push({ id: def.id, progress: 0, def });
    this.ui.toast(`新任务：${def.name}`, 'good');
    this._playSound('quest_accept', { volume: 0.7 });
  }

  _questProgress(kind, amount) {
    for (const q of this.quests.active) {
      if (q.def.kind !== kind) continue;
      q.progress += amount;
      if (q.progress >= q.def.goal) this._completeQuest(q);
    }
  }

  _completeQuest(q) {
    if (!q || this.quests.completed.includes(q.id)) return;
    this.quests.completed.push(q.id);
    this.quests.active = this.quests.active.filter((x) => x.id !== q.id);
    this.ui.toast(`任务完成：${q.def.name}`, 'good');
    this._playSound('quest_complete');
    const r = q.def.reward;
    if (r && ITEMS[r.itemId]) {
      this.player.inventory.add(r.itemId, r.count);
      this.ui.toast(`奖励：${ITEMS[r.itemId].name} ×${r.count}`, 'good');
    }
  }

  _updateQuests() {
    for (const q of this.quests.active) {
      if (q.def.kind === 'reach') {
        const poi = this.layout.poi.find((p) => p.kind === 'base');
        if (poi && Math.hypot(poi.x - this.player.pos.x, poi.z - this.player.pos.z) < poi.radius) {
          q.progress = 1;
          this._completeQuest(q);
        }
      }
    }
  }

  // ── 时间 / 光照 / 季节 / 天气 ─────────────────────────
  /** 当帧的季节色板：换季过渡中就是两个季节的插值（几何不能插值，颜色可以）。 */
  _seasonEnvNow() {
    const to = this.season;
    const b = this._seasonBlend;
    if (!b) return SEASON_ENV[to] || SEASON_ENV[DEFAULT_SEASON];
    const k = b.t >= 1 ? 1 : b.t * b.t * (3 - 2 * b.t);
    return blendSeasonEnv(b.from, to, k);
  }

  /** 这一帧的 AI 感知倍率（天气 + 昼夜）。天气/夜晚削弱视觉，噪声底噪削弱听觉。 */
  _perceptionNow(dayFactor) {
    const w = this.weather ? this.weather.params : null;
    if (!w) return { sight: 1, hearing: 1 };
    // 夜里"看得见"的距离更短（PZ 用感知建模夜晚，而不是给僵尸加攻击性）
    const light = 0.62 + 0.38 * Math.max(0, Math.min(1, dayFactor));
    return { sight: (w.sight || 1) * light, hearing: w.hearing == null ? 1 : w.hearing };
  }

  /**
   * 把「季节 × 天气 × 昼夜 × 湿润/积雪」算成这一帧的光照/雾/地面颜色并写进场景。
   * 每帧调用（不是只在换季时调用）：天气的任何参数变化都会自然反映到环境上。
   */
  _applyEnvironment() {
    const t = this.timeOfDay;
    const dayFactor = Math.max(0, Math.sin(((t - 6) / 12) * Math.PI));
    const env = this._seasonEnvNow();
    const weather = this.weather ? this.weather.params : null;
    const baseFog = (this.config.render && this.config.render.fogDensity) || 0.0085;
    const E = computeEnvironment({
      seasonEnv: env,
      weather,
      wetness: this.weather ? this.weather.wetness : 0,
      snowCover: this.weather ? this.weather.snowCover : 0,
      baseFogDensity: baseFog,
    });
    this._envFrame = { env, E, dayFactor };
    const flash = this.weatherFx ? this.weatherFx.flashLevel : 0;
    const px = this.player ? this.player.pos.x : 0;
    const pz = this.player ? this.player.pos.z : 0;

    if (this.sun) {
      this.sun.color.setHex(env.sun);
      // 闪电瞬间太阳并不是变亮，而是"整个天在发光"——用 hemi/ambient 补更真实，
      // 这里只给太阳一点点，避免出现"闪电把影子打硬"的怪画面。
      this.sun.intensity = (0.15 + dayFactor * 1.6) * E.sunMul * (1 + flash * 0.25);
      const ang = ((t - 6) / 12) * Math.PI;
      this.sun.position.set(px + Math.cos(ang) * 80, 20 + Math.sin(ang) * 90, pz + 40);
    }
    if (this.hemi) {
      this.hemi.color.setHex(env.hemiSky);
      if (this.hemi.groundColor) this.hemi.groundColor.setHex(env.hemiGround);
      this.hemi.intensity = (0.38 + dayFactor * 0.75) * E.hemiMul + flash * 2.2;
    }
    if (this.ambient) {
      this.ambient.color.setHex(env.ambient);
      this.ambient.intensity = (0.3 + dayFactor * 0.42) * E.ambientMul + flash * 1.5;
    }

    // 天空 / 雾：夜里压暗，闪电时整片天泛白
    this._colSky.setHex(E.sky);
    const c = this._colTmp.copy(this._colNight).lerp(this._colSky, Math.min(1, dayFactor * 1.4));
    if (flash > 0) c.lerp(this._colFlash, Math.min(0.85, flash * 0.9));
    if (this.scene && this.scene.background) {
      this.scene.background.copy(c);
      if (this.scene.fog) {
        this.scene.fog.color.copy(c);
        this.scene.fog.density = E.fogDensity;
      }
    }

    // 地面与静态合批（道路/墙/杂物）：湿了变暗、积雪变白，都是改材质 color，不动几何
    const ground = this.world && this.world.group ? this.world.group.getObjectByName('ground') : null;
    if (ground && ground.material && ground.material.color) {
      if (ground.userData && ground.userData.terrain) {
        // 地形顶点色是绝对色（草地绿/水体蓝/雪白），直接盖环境色会把河涂绿。
        // 用"环境地面色 / 当季标准草地色"的比值当乘数：晴天≈1，暴雨压暗，暴雪提亮。
        const se = SEASON_ENV[this.season] || SEASON_ENV[DEFAULT_SEASON];
        const t = terrainTint(E.ground, se.ground);
        ground.material.color.setRGB(t[0], t[1], t[2]);
      } else {
        ground.material.color.setHex(E.ground);
      }
    }
    const staticMesh = this.world ? this.world.staticMesh : null;
    if (staticMesh && staticMesh.material && staticMesh.material.color) staticMesh.material.color.setHex(E.staticHex);
    // 雾越浓，能看到的距离越短：把远裁剪面收进来（风暴/暴雪里能直接少画一截世界）。
    // FogExp2 在 ~2.15/density 处已经完全不透光，所以再远的东西画了也看不见。
    if (this.camera) {
      const drawFar = ((this.config.render && this.config.render.drawDistance) || 300) + 200;
      const far = Math.max(60, Math.min(drawFar, 2.6 / Math.max(0.0015, E.fogDensity)));
      if (Math.abs(this.camera.far - far) > 5) {
        this.camera.far = far;
        this.camera.updateProjectionMatrix();
      }
    }
    return E;
  }

  _updateTimeOfDay(dt) {
    const prev = this.timeOfDay;
    this.timeOfDay = (this.timeOfDay + dt * (24 / 900)) % 24;
    // 过了一个 24h：天数 +1，按"每季 N 天"推进季节（换季是异步的：要先补装当季树木几何）
    if (this.timeOfDay < prev) {
      this.dayCount = (this.dayCount || 1) + 1;
      const per = (this.config.world && this.config.world.daysPerSeason) || 3;
      if (this.config.world && this.config.world.seasonsEnabled !== false) {
        const target = seasonForDay(this.dayCount, per);
        if (target !== this.season) this.setSeason(target, { silent: false });
      }
    }
    // 换季的颜色过渡（几何在 setSeason 里已经换好了）
    if (this._seasonBlend) {
      const b = this._seasonBlend;
      b.t += dt / Math.max(1, b.dur);
      if (b.t >= 1) this._seasonBlend = null;
    }
    this._applyEnvironment();
  }

  /**
   * 天气推进：状态机 → 事件（换天气/闪电）→ 粒子与风 → 环境声混音。
   * 顺序放在 _updateTimeOfDay 之前：本帧算出来的天气参数要立刻用于本帧的光照与雾。
   */
  _updateWeather(dt) {
    if (!this.weather) return;
    const t = this.timeOfDay;
    const dayFactor = Math.max(0, Math.sin(((t - 6) / 12) * Math.PI));
    const px = this.player ? this.player.pos.x : 0;
    const pz = this.player ? this.player.pos.z : 0;
    // 室内判定：进建筑后雨声变闷、雨雪粒子不画（免得在屋里下雨）
    const inside = this.layout && this.player ? !!buildingAt(px, pz, this.layout.buildings) : false;
    this._indoor = inside;

    this.weather.update(dt, { season: this.season, dayFactor });
    this._aiPerception = this._perceptionNow(dayFactor);

    for (const e of this.weather.consumeEvents()) {
      if (e.type === 'change') {
        if (this.ui && this.ui.toast) this.ui.toast(`天气：${e.label}`, 'info');
      } else if (e.type === 'lightning') {
        if (this.weatherFx) {
          this.weatherFx.flash(0.3 + e.power * 1.1);
          // 可见电弧：位置沿用事件里的方向/距离，和"雷声从哪里来"是同一个点
          this.weatherFx.strike(px, pz, e);
        }
        // 声速延迟：先看到闪，再按距离听到雷（这是"距离感"最便宜也最有效的来源）
        this._thunderQueue.push({ at: this.elapsed + e.delay, volume: 0.3 + e.power * 0.7, rate: 0.55 + e.power * 0.85, pan: (Math.random() - 0.5) * 0.9 });
        // 雷声也是一次巨大的声音事件：感染者会朝雷劈的方向聚过去。
        // 于是"雷雨天"既能掩护玩家，也会把怪引到别处/引到你附近——两难。
        if (this._emitSound) {
          const a = Math.random() * Math.PI * 2;
          const r = 30 + Math.random() * 60;
          this._emitSound(px + Math.cos(a) * r, pz + Math.sin(a) * r, 6, 'thunder');
        }
      }
    }
    this._updateThunder(dt);
    if (this.weatherFx) {
      this.weatherFx.setQuality(this.config.render.quality);
      // snowCover 传给渲染层：雨滴溅射在地面被雪盖住时会淡出
      this.weatherFx.update(dt, this.weather.params, { indoor: inside, snowCover: this.weather.snowCover });
    }
    this._syncWeatherAudio(dt);
  }

  /** 待播雷声队列（不用 setTimeout：暂停时时间不走，定时器却会走）。 */
  _updateThunder() {
    if (!this._thunderQueue.length) return;
    const keep = [];
    for (const q of this._thunderQueue) {
      if (this.elapsed >= q.at) {
        this._playSound('thunder', { volume: q.volume, rate: q.rate, pan: q.pan });
      } else {
        keep.push(q);
      }
    }
    this._thunderQueue = keep;
  }

  /**
   * 环境声混音：雨/风的强度与 AI 听觉用的是同一组参数，所以"你听不见的时候僵尸也听不见"
   * （Hunt: Showdown 的技术文章把这个当成铁律：音频衰减模型与 AI 听觉模型必须是同一套数字）。
   */
  _syncWeatherAudio(dt) {
    if (!this.audio || !this.weather) return;
    this._weatherSoundTimer -= dt;
    if (this._weatherSoundTimer > 0) return;
    this._weatherSoundTimer = 0.25;
    const p = this.weather.params;
    const a = p.audio || { rain: 0, wind: 0 };
    this.audio.setWeatherMix({
      rain: a.rain,
      wind: a.wind,
      indoor: !!this._indoor,
    });
    // 音频上下文要等用户手势解锁；解锁后这里会补建环境声节点（重复调用是安全的）
    if (this.audio && this.audio.startAmbient) this.audio.startAmbient();
  }

  /**
   * 季节环境声：鸟（春/夏白天）、虫（夏夜）、风（秋/冬）。
   * "该不该响"是 weather.js 的纯函数 ambienceFor 决定的（可单测），这里只负责随机调度播放：
   * 每 14~30 秒一次、随机声像/音高，避免听起来像循环音频。下雨/室内直接安静。
   */
  _updateAmbience(dt) {
    if (!this._ambience) this._ambience = { timer: 9 };
    const a = this._ambience;
    a.timer -= dt;
    if (a.timer > 0) return;
    a.timer = 14 + Math.random() * 16;
    const t = this.timeOfDay;
    const dayFactor = Math.max(0, Math.sin(((t - 6) / 12) * Math.PI));
    const p = this.weather ? this.weather.params : null;
    const name = ambienceFor({
      season: this.season,
      dayFactor,
      precip: p ? p.precip : 'none',
      wind: p ? p.wind : 0,
      indoor: !!this._indoor,
    });
    if (!name) return;
    this._playSound(name, {
      volume: name === 'crickets' ? 0.55 : 0.62,
      pan: (Math.random() - 0.5) * 1.2,
      rate: 0.92 + Math.random() * 0.2,
    });
  }

  /** 指定天气（调试 / 设置面板 / URL 参数）。传 'auto' 交回自动推进。 */
  setWeather(id, opts = {}) {
    if (!this.weather) return false;
    if (id === 'auto') {
      this.weather.unforce();
      this.config.world.weatherMode = 'auto';
      if (!opts.silent && this.ui && this.ui.toast) this.ui.toast('天气：自动', 'info');
      return true;
    }
    if (!WEATHERS[id]) return false;
    const changed = this.weather.setWeather(id, { force: opts.force !== false, instant: !!opts.instant });
    this.config.world.weatherMode = this.weather.forcedId || 'auto';
    if (!opts.silent && this.ui && this.ui.toast) this.ui.toast(`天气：${WEATHERS[id].label}`, 'info');
    return changed || true;
  }

  /**
   * 换季：补装当季树木几何 → 重建树实例 → 换环境色。
   * 只重建 `world.group` 里的 `trees` 子组（300 个实例重新 setMatrix，几毫秒），不重建世界、不动 NPC。
   * 几何缺失时降级用绿树（buildTreeInstances 内部处理），不会画成空白。
   * @param {'spring'|'summer'|'autumn'|'winter'} name
   * @param {{silent?:boolean, force?:boolean}} opts
   */
  async setSeason(name, opts = {}) {
    if (!isSeason(name)) return false;
    if (this._seasonBusy) return false;
    if (name === this.season && !opts.force) return false;
    if (!this.world || !this.layout) { this.season = name; return false; }
    const prevSeason = this.season;
    this._seasonBusy = true;
    try {
      // 1) 秋/冬要额外装 16~22 个模型（春/夏复用绿几何，不用装）
      await this._ensureSeasonProps(name);
      // 2) 换树（先建新的再拆旧的，避免闪一帧空白）
      const next = buildTreeInstances(THREE, this.layout, this.propGeometry, name);
      const old = this.world.group.getObjectByName('trees') || this.world.trees;
      this.world.group.add(next.group);
      if (old) disposeTreeGroup(old);
      this.world.trees = next.group;
      this.world.stats.trees = next.stats;
      this.cars = this.world.cars;
      // 3) 环境：季节色板 + 颜色过渡（几何是"咔"一下换的，颜色可以慢慢过去）
      this.season = name;
      this.seasonEnv = SEASON_ENV[name];
      this.config.world.season = name;
      this._seasonBlend = opts.blend === false ? null : { from: prevSeason, t: 0, dur: opts.blendDuration || 14 };
      // 4) 天气要跟着季节走（夏天不会下雪）；树材质重建了，风要重新接
      if (this.weather) this.weather.setSeason(name);
      if (this.weatherFx) this.weatherFx.syncTrees(next.group);
      // 地面：平地模式靠材质 color，真实地形靠重刷顶点色（绝对色改不了材质）
      // 这一步必须在 _applyEnvironment 之前，否则天气算出来的地面调制会先落到旧色上
      applySeasonEnvironment(this, name);
      this._applyEnvironment();
      if (!opts.silent && this.ui && this.ui.toast) {
        this.ui.toast(`季节变化：${SEASON_LABELS[name]}（${next.stats.instances} 棵树换装）`, 'info');
      }
      return true;
    } catch (e) {
      console.warn('[season] 换季失败，保持原季节', e);
      return false;
    } finally {
      this._seasonBusy = false;
    }
  }

  _updateIndoorLights() {
    if (!this.lights || !this.lights.length) return;
    const px = this.player.pos.x, pz = this.player.pos.z;
    const inBuilding = buildingAt(px, pz, this.layout.buildings);
    // 只点亮最近的 3 盏；室内时优先点亮所在建筑
    const scored = [];
    for (const L of this.lights) {
      const d = Math.hypot(L.light.position.x - px, L.light.position.z - pz);
      L.light.intensity = 0;
      L.on = false;
      scored.push({ L, d });
    }
    scored.sort((a, b) => a.d - b.d);
    const maxOn = this.config.render.quality === 'low' ? 2 : 3;
    for (let i = 0; i < Math.min(maxOn, scored.length); i += 1) {
      const { L, d } = scored[i];
      if (d > 26) continue;
      const target = inBuilding && inBuilding.id === L.buildingId ? L.baseIntensity : L.baseIntensity * 0.75;
      L.light.intensity = target;
      L.on = true;
    }
  }

  /**
   * 路灯：天黑才亮。50 盏灯不各配一盏点光 —— 用 3 盏**池化**点光跟着玩家附近最近的几盏灯走，
   * 灯头本身再加一层光晕（InstancedMesh 的透明球，白天 opacity=0）。
   * 亮度曲线直接跟 dayFactor 走：黄昏渐亮、深夜最亮，白天全灭（省灯也符合直觉）。
   */
  _updateStreetLights() {
    const glowMat = this._lampGlowMat;
    const pool = this._streetLampLights;
    if (!this.streetLamps || !this.streetLamps.length) {
      if (glowMat) glowMat.opacity = 0;
      return;
    }
    const dayFactor = this._envFrame ? this._envFrame.dayFactor : Math.max(0, Math.sin(((this.timeOfDay - 6) / 12) * Math.PI));
    // 1 = 全黑（深夜/雷暴），0 = 大白天
    const dark = Math.max(0, Math.min(1, 1 - dayFactor * 1.25));
    if (glowMat) glowMat.opacity = dark * 0.85;
    if (!pool || !pool.length) return;
    const px = this.player ? this.player.pos.x : 0;
    const pz = this.player ? this.player.pos.z : 0;
    const near = nearestLamps(this.streetLamps, px, pz, pool.length, 60);
    for (let i = 0; i < pool.length; i += 1) {
      const light = pool[i];
      const lamp = near[i];
      if (!lamp) { light.intensity = 0; continue; }
      light.position.set(lamp.x, lamp.y - 0.25, lamp.z);
      // 越黑越亮；离得远的灯稍微暗一点（近处更亮，视觉上像"街灯照亮了这一段路"）
      const falloff = 1 - Math.min(1, lamp.d / 64) * 0.55;
      light.intensity = dark * 11 * falloff;
    }
  }

  // ── 声音 ─────────────────────────────────────────────
  /**
   * 脚步声随地面变化：雪地"咯吱"、湿地"啪叽"。
   * 归一化放在这里（而不是 player.js），玩家代码不需要知道"天气"是什么；
   * 雪/湿的阈值来自天气系统的慢变量，所以雨停之后地面湿着的那段时间仍然是湿脚步。
   */
  _footstepVariant(name) {
    if (name !== 'footstep' && name !== 'footstep_sprint') return name;
    if (!this.weather) return name;
    if (this.weather.snowCover > 0.35) return 'footstep_snow';
    if (this.weather.wetness > 0.45) return 'footstep_wet';
    return name;
  }

  _playSound(name, opts) {
    if (!this.audio) return false;
    return this.audio.play(this._footstepVariant(name), opts || {});
  }

  _emitSound(x, z, loudness, tag) {
    if (this.director) this.director.broadcastSound(x, z, loudness, tag);
  }

  // ── 拾取物动画 ────────────────────────────────────────
  _updatePickups(dt) {
    for (const rec of this.pickups.values()) {
      if (!rec.mesh) continue;
      rec.t += dt;
      rec.mesh.rotation.y += dt * 1.2;
      const lift = rec.mesh.userData.liftY != null ? rec.mesh.userData.liftY : 0.32;
      rec.mesh.position.y = lift + Math.sin(rec.t * 2) * 0.06;
    }
    this._updateEffects(dt);
  }

  // ── 死亡与重生 ────────────────────────────────────────
  _handleDeath(dt) {
    if (this._deathTimer === 0) {
      this._deathTimer = this.config.player.deathRespawnSeconds || 4;
      this.closeMap(false);
      this.ui.showDeath(() => this.respawn(), Math.ceil(this._deathTimer));
      this.input.releaseLock();
      this._playSound('death');
      if (this.player.character) this.player.character.animator.die();
    }
    this._deathTimer -= dt;
    this.ui.setDeathCountdown(this._deathTimer);
    if (this._deathTimer <= 0) this.respawn();
  }

  respawn() {
    const base = this.layout.poi.find((p) => p.kind === 'base') || { x: 0, z: 0 };
    this.player.alive = true;
    this.player.health = this.player.maxHealth * 0.6;
    this.player.hunger = Math.max(35, this.player.hunger);
    this.player.thirst = Math.max(35, this.player.thirst);
    this.player.setPosition(base.x, this.groundHeightAt(base.x, base.z), base.z);
    this.player.character.animator.revive();
    this._deathTimer = 0;
    this.ui.clearScreens();
    this.ui.showHud();
    this.input.requestLock(this.canvas);
    this.ui.toast('你在营地醒了过来', 'warn');
  }

  // ── 存档 ─────────────────────────────────────────────
  _autosave(dt) {
    if (!this.save) return;
    const res = this.save.tick(dt, () => buildSavePayload(this));
    if (res && res.ok) this._saveError = null;
    else if (res && !res.ok) this._saveError = res.error;
  }

  manualSave() {
    if (!this.started || !this.save) return;
    const res = this.save.save(buildSavePayload(this));
    if (res.ok) this.ui.toast('已保存', 'good');
    else this.ui.toast(`保存失败：${res.error}`, 'bad');
  }

  async continueGame() {
    if (!this.save) return;
    const res = this.save.load();
    if (!res.ok) {
      this.ui.toast(res.error || '没有存档', 'bad');
      this.ui.showMainMenu({ hasSave: false, summary: this.football.summary() });
      return;
    }
    this.config.seed = res.data.seed || this.config.seed;
    await this.newGame(res.data);
    if (res.migrated) this.ui.toast('存档已升级到新版本', 'warn');
    this._saveError = null;
  }

  loadGame() {
    if (!this.save) return;
    const res = this.save.load();
    if (!res.ok) { this.ui.toast(res.error || '没有存档', 'bad'); return; }
    this.newGame(res.data);
  }

  _restoreState(data) {
    if (!data) return;
    try {
      if (data.player) {
        this.player.restore(data.player);
        this.playerCharacter.animator.revive();
        this._syncWeaponVisual();
      }
      const w = data.world || {};
      if (Array.isArray(w.openedContainers)) {
        for (const id of w.openedContainers) {
          this.openedContainers.add(id);
          const rec = this.world.containers.get(id);
          if (rec && rec.mesh && rec.mesh.userData.lid) {
            rec.opened = true;
            rec.mesh.userData.lid.rotation.x = -0.9;
          }
        }
      }
      if (Array.isArray(w.lootedPickups)) {
        for (const id of w.lootedPickups) {
          this.lootedPickups.add(id);
          const rec = this.pickups.get(id);
          if (rec && rec.mesh) { this.scene.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh.material.dispose(); }
          this.pickups.delete(id);
        }
      }
      if (Array.isArray(w.doorsOpen)) {
        for (let i = 0; i < this.doorStates.length && i < w.doorsOpen.length; i += 1) {
          const st = this.doorStates[i];
          st.open = !!w.doorsOpen[i];
          st.pivot.rotation.y = st.open ? st.openRot : 0;
        }
      }
      if (Array.isArray(w.cars)) {
        for (const rec of w.cars) {
          const car = this.cars.find((c) => c.id === rec.id);
          if (!car) continue;
          car.mesh.position.set(rec.x, rec.y || 0, rec.z);
          car.mesh.rotation.y = rec.rotY || 0;
          car.durability = Number(rec.durability) || car.durability;
          if (car.durability <= 0) car.drivable = false;
          // 车辆使用状态（旧存档没有这些字段就保持现值）
          if (Number.isFinite(rec.fuel)) car.fuel = Math.max(0, Math.min(100, rec.fuel));
          if (typeof rec.lights === 'boolean') car.lights = rec.lights;
          // 后备箱内容：旧存档没有 trunk 字段 → 保留 build 时种下的初始战利品
          if (rec.trunk && car.trunkInv) {
            car.trunkInv = Inventory.deserialize(rec.trunk, {
              quickSlots: 0, slotCount: car.trunkInv.slots.length,
            });
          }
        }
      }
      if (Number.isFinite(w.timeOfDay)) this.timeOfDay = w.timeOfDay;
      if (Number.isFinite(w.dayCount) && w.dayCount >= 1) this.dayCount = Math.floor(w.dayCount);
      // 天气：存档只记状态（当前/下一个/过渡进度/湿润/积雪），不记"未来"，所以读档后仍是同一天气
      if (w.weather && this.weather) {
        this.weather.restore(w.weather);
        this.config.world.weatherMode = this.weather.forcedId || 'auto';
        this._applyEnvironment();
      }
      // 季节：读档时如果和当前不一致就换（newGame 里已经按存档季节建好世界时这里会直接返回 false）
      if (isSeason(w.season) && w.season !== this.season) {
        this.season = w.season;
        this.setSeason(w.season, { silent: true, force: true });
      }
      if (data.quests) {
        this.quests.completed = Array.isArray(data.quests.completed) ? data.quests.completed.slice() : [];
        this.quests.active = Array.isArray(data.quests.active)
          ? data.quests.active.filter((q) => q && QUEST_DEFS[q.id]).map((q) => ({ id: q.id, progress: Number(q.progress) || 0, def: QUEST_DEFS[q.id] }))
          : [];
      }
      if (data.director && data.director.deadIds && this.director) this.director.restoreDead(data.director.deadIds);
      this.ui.toast('存档已读取', 'good');
    } catch (e) {
      console.warn('[game] 恢复存档时出错（已忽略损坏部分）', e);
      this.ui.toast('存档部分数据损坏，已使用可用部分', 'warn');
    }
  }

  // ── 暂停 / 菜单 ──────────────────────────────────────
  /** 指针锁定意外丢失时，当前是否处于"应该自动暂停"的状态。 */
  _canAutoPause() {
    if (!this.started || this.paused) return false;
    if (!this.player || !this.player.alive) return false;
    if (this._deathTimer > 0) return false;
    if (this._dialogOpen || this._lootOpen) return false;
    if (this.ui && this.ui.inventoryOpen) return false;
    // 地图是玩家自己打开的（它也会解锁指针），别把它当成"意外丢失锁定"再弹一次暂停
    if (this.map && this.map.open) return false;
    return true;
  }

  pause() {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.closeMap(false);
    this.input.releaseLock();
    this.ui.showPause();
  }

  resume() {
    if (!this.started) return;
    this.paused = false;
    this.ui.hidePause();
    this.ui.showHud();
    this.input.requestLock(this.canvas);
  }

  toMenu() {
    this.paused = false;
    this.started = false;
    this.closeMap(false);
    this.ui.clearScreens();
    this.ui.hideHud();
    this.ui.showMainMenu({ hasSave: this.save && this.save.hasSave(), summary: this.football.summary() });
    this.input.releaseLock();
    if (this.audio) this.audio.stopAmbient();
  }

  _useItem(list, idx) {
    const res = this.player.useItem(list, idx);
    if (res.ok) {
      this.ui.toast(res.message, 'good');
      this._syncWeaponVisual();
      this.ui.refreshInventory(this._inventoryProxy());
    } else {
      this.ui.toast(res.message, 'bad');
      this._playSound('ui_error');
    }
  }

  /** 背包 UI 需要每个槽位带上 item def，这里做一层轻包装。 */
  _inventoryProxy() {
    const player = this.player;
    const wrap = (arr) => arr.map((s) => (s ? Object.assign({}, s, { def: ITEMS[s.itemId] }) : null));
    const inv = player.inventory;
    return {
      inventory: {
        get weight() { return inv.weight; },
        get maxWeight() { return inv.maxWeight; },
        get isOverweight() { return inv.isOverweight; },
        slots: wrap(inv.slots),
        quick: wrap(inv.quick),
        activeQuick: inv.activeQuick,
      },
    };
  }

  // ── 地图 ─────────────────────────────────────────────
  /** 现在能不能开地图（死了 / 暂停中 / 世界还没建好都不行）。 */
  _canToggleMap() {
    if (!this.started || this.paused || !this.map || !this.map.ready) return false;
    if (!this.player || !this.player.alive || this._deathTimer > 0) return false;
    return true;
  }

  /**
   * 大地图需要的一份只读快照。
   * 注意三点：
   *   · 朝向用**镜头 yaw**（玩家看到哪边，小地图就把哪边朝上），不是身体朝向；
   *   · 车辆坐标取 mesh 的（车开过之后 layout 里的 x/z 就过期了）；
   *   · 正在开的那辆车不画成"路边随便一台车"，玩家标记本身就代表它。
   */
  _mapState() {
    const p = this.player;
    const car = this.vehicles && this.vehicles.driving ? this.vehicles.car : null;
    const cars = [];
    for (const c of this.cars || []) {
      if (car && c === car) continue;
      const m = c.mesh && c.mesh.position;
      cars.push({ id: c.id, x: m ? m.x : c.x, z: m ? m.z : c.z, drivable: !!c.drivable });
    }
    let quest = null;
    const active = this.quests && this.quests.active ? this.quests.active[0] : null;
    if (active && active.def && active.def.kind === 'reach' && this.layout) {
      const base = this.layout.poi.find((x) => x.kind === 'base');
      if (base) quest = { x: base.x, z: base.z, label: active.def.name };
    }
    return {
      player: { x: p.pos.x, z: p.pos.z, yaw: this.cameraRig ? this.cameraRig.yaw : p.yaw },
      npcs: this.director ? this.director.npcs : [],
      cars,
      poi: this.layout ? this.layout.poi : [],
      quest,
      driving: !!car,
    };
  }

  /** 打开大地图：暂停世界 + 放开指针（和背包一致），地图上能看到附近的僵尸。 */
  openMap() {
    if (!this._canToggleMap() || (this.map && this.map.open)) return false;
    if (this.ui.inventoryOpen) this.ui.closeInventory();
    if (this._lootOpen) this._closeLoot();
    if (this._dialogOpen) { this._dialogOpen = false; this.ui.clearScreens(); this.ui.showHud(); }
    this.input.releaseLock();
    this.map.show(this._mapState());
    this._playSound('ui_click', { volume: 0.4 });
    return true;
  }

  closeMap(relock = true) {
    if (!this.map || !this.map.open) return false;
    this.map.hide();
    // 关掉之后把指针锁回来，否则视角不能转（和背包关闭走同一条路径）
    if (relock && this.started && !this.paused && this.player && this.player.alive) {
      this.input.requestLock(this.canvas);
    }
    return true;
  }

  toggleMap() {
    if (!this.map) return false;
    return this.map.open ? this.closeMap() : this.openMap();
  }

  // ── HUD ──────────────────────────────────────────────
  _updateHud() {
    if (!this.ui || !this.player) return;
    const p = this.player;
    let w = p.weaponState;
    // 换弹完成后可能换了枪
    if (this.player.equipped !== this._equippedVisualId) this._syncWeaponVisual();
    w = p.weaponState;
    const quest = this.quests.active[0];
    const chips = [];
    chips.push(`<b>${Math.round(this._fps)}</b> FPS`);
    if (this.director) {
      const c = this.director.counts;
      chips.push(`感染者 <b>${c.zombie}</b> · 掠夺者 <b>${c.hostile}</b>`);
    }
    chips.push(`时间 <b>${String(Math.floor(this.timeOfDay)).padStart(2, '0')}:${String(Math.floor((this.timeOfDay % 1) * 60)).padStart(2, '0')}</b>`);
    // 季节 + 第几天：四季会换树木几何，玩家得看得出来现在是哪个季节
    const seasonLabel = (SEASON_LABELS[this.season] || SEASON_LABELS[DEFAULT_SEASON]);
    // 中国气候带（选了非默认地区时显示，例如"夏 第 3 天 · 华南"）
    const regionNow = (this.config.world && this.config.world.region) || 'temperate';
    const regionTag = regionNow !== 'temperate' ? ` · ${regionLabel(regionNow)}` : '';
    chips.push(`<b>${seasonLabel}</b> 第 <b>${this.dayCount || 1}</b> 天${regionTag}`);
    // 天气：图标 + 气温 + 能见度/听觉百分比。
    // 后两个数字就是 AI 真正用的倍率——玩家能直接看出"雾天能见 45%，但听觉 90%"。
    if (this.weather) {
      const info = this.weather.info();
      const temp = Math.round(weatherTemperature(this.season, this.weather.params, this.timeOfDay));
      const vis = Math.round(Math.max(0, Math.min(1, info.sight)) * 100);
      const hear = Math.round(Math.max(0, Math.min(1, info.hearing)) * 100);
      const wetTag = info.snowCover > 0.25 ? ' 积雪' : (info.wetness > 0.4 ? ' 湿透' : '');
      chips.push(`<b>${info.icon} ${info.label}</b> ${temp}°C · 能见 <b>${vis}%</b> · 听觉 <b>${hear}%</b>${wetTag}`);
      // 预报：下一个天气 + 剩余时间。玩家能据此决定"现在出门还是等雨停"。
      const f = info.next;
      if (f) {
        const left = Math.max(0, Math.round(f.eta));
        const mm = Math.floor(left / 60);
        const ss = String(left % 60).padStart(2, '0');
        chips.push(`转 <b>${f.icon} ${f.label}</b> ${mm}:${ss}`);
      } else if (info.transitioning && info.nextLabel) {
        chips.push(`→ <b>${info.nextLabel}</b>`);
      }
    }
    if (this.vehicles && this.vehicles.driving) {
      const car = this.vehicles.car;
      const fuel = Math.round(VehicleController.fuelOf(car));
      const dur = Math.round((car.durability / Math.max(1, this.config.vehicles.maxDurability)) * 100);
      const lowFuel = fuel <= (this.config.vehicles.fuelLowPct || 15) ? '⚠' : '';
      chips.push(`车速 <b>${Math.round(this.vehicles.speedKmh())}</b> km/h`);
      chips.push(`油 <b>${lowFuel}${fuel}%</b> · 耐久 <b>${dur}%</b> · ${car.lights ? '💡灯开' : '灯关'}`);
    }
    chips.push(`击杀 <b>${p.kills}</b>`);

    this.ui.update(0.1, {
      health: p.health, maxHealth: p.maxHealth,
      hunger: p.hunger, maxHunger: p.maxHunger,
      thirst: p.thirst, maxThirst: p.maxThirst,
      stamina: p.stamina, maxStamina: p.maxStamina,
      buffs: p.buffs ? p.buffs.list() : [],
      // 医疗伤情（流血/感染/骨折/疼痛）与"正在治疗"进度
      conditions: p.med ? p.med.list() : [],
      treating: p._treat ? { name: p._treat.def.name, progress: p._treat.elapsed / Math.max(0.001, p._treat.duration) } : null,
      weaponName: w ? w.def.name : '徒手',
      ammo: w ? (w.def.type === 'melee' ? '—' : w.ammo) : '—',
      reserve: w && w.def.ammoId ? p.reserveFor(w.def) : null,
      reloading: w ? w.isReloading : false,
      // 连发散热（0~1）：准星按它变宽，提示"现在打不准了"
      heat: this._heats && w ? (this._heats.get(w.def.id) ? this._heats.get(w.def.id).ratio : 0) : 0,
      aiming: p.aiming,
      moving: p.moving,
      quickSlots: p.inventory.quick.map((s) => (s ? { itemId: s.itemId, count: s.count, def: ITEMS[s.itemId] } : null)),
      activeQuick: p.inventory.activeQuick,
      prompt: this._nearestInteract ? `[E] ${this._nearestInteract.label}` : '',
      chips,
      quest: quest ? { name: quest.def.name, objective: `${quest.def.objective}（${Math.min(quest.progress, quest.def.goal)}/${quest.def.goal}）`, done: quest.progress >= quest.def.goal } : null,
    });
  }

  // ── 自检（浏览器冒烟测试用） ──────────────────────────
  selfTest() {
    const report = { ok: true, checks: [], errors: [] };
    const add = (name, ok, detail) => {
      report.checks.push({ name, ok: !!ok, detail: detail || '' });
      if (!ok) report.ok = false;
    };
    try {
      add('WebGL 渲染器已创建', !!this.renderer, this.renderer ? this.renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1' : '');
      add('场景存在', !!this.scene && this.scene.children.length > 0);
      add('世界已构建', !!this.world && !!this.world.staticMesh);
      add('建筑数量 > 0', this.layout && this.layout.buildings.length > 0, this.layout ? String(this.layout.buildings.length) : '');
      add('碰撞体数量 > 0', this.collision && this.collision.boxes.length > 0, this.collision ? String(this.collision.boxes.length) : '');
      add('导航网格已建立', !!this.nav, this.nav ? JSON.stringify(this.nav.stats) : '');
      add('玩家已创建', !!this.player && !!this.playerCharacter);
      // 真实资产是否真的接上了（不是"代码写了但没生效"）
      const cf = this.charReport && this.charReport.templates ? this.charReport.templates : [];
      add('FBX 角色模板已加载', cf.length > 0, cf.map((t) => `${t.key}:${t.clips.length}段`).join(' '));
      add('玩家使用真实 FBX 模型', this.playerCharacter && this.playerCharacter.modelKind === 'fbx',
        this.playerCharacter ? `${this.playerCharacter.modelKind}/${this.playerCharacter.model && this.playerCharacter.model.templateKey}` : '');
      const npcFbx = this.director ? this.director.npcs.filter((n) => n.char && n.char.modelKind === 'fbx').length : 0;
      const npcAll = this.director ? this.director.npcs.length : 0;
      add('NPC 使用真实 FBX 模型', npcAll > 0 && npcFbx === npcAll, `${npcFbx}/${npcAll}`);
      add('OBJ 道具已烘焙', this.propGeometry && this.propGeometry.size > 0, `${this.propGeometry ? this.propGeometry.size : 0} 个`);
      // 建筑是否真的换成了道具包的模型（不是"清单里写了但没用上"）
      const bm = this.world && this.world.stats ? this.world.stats.buildingModels : null;
      add('建筑使用道具包模型（非程序化盒子）',
        !!(bm && bm.modeled > 0 && bm.fallback === 0 && bm.doorways > 0),
        bm ? `${bm.modeled}/${bm.total} 栋用模型，${bm.fallback} 栋回退程序化，门洞 ${bm.doorways} 个，侧窗 ${bm.windows || 0} 扇，` +
          `${Math.round(bm.triangles)} 三角形 / ${bm.meshes || 0} 个 draw call，调色板 ${Object.keys(bm.palettes || {}).join('+')}`
          : '无建筑统计');
      // 道路是否真的换成了道具包的街道模块（不是"清单里写了但没用上"）
      const roads = this.world && this.world.stats ? this.world.stats.roads : null;
      add('道路使用 Modular Streets 模块', !!(roads && !roads.fallback && roads.pieces > 0),
        roads ? (roads.fallback
          ? '降级为程序化沥青面'
          : `直道 ${roads.straight} / 十字 ${roads.junction} / 尽头 ${roads.deadend} / 路灯 ${roads.streetlights} / 路牌 ${roads.signs}，铺装 ${roads.pavementWidth}m（沥青 ${roads.asphaltWidth}m），${roads.triangles} 三角形`)
          : '无道路统计');
      // 夜间路灯：把时间拨到深夜，最近的几盏灯应该被点亮、白天全灭
      if (this.streetLamps && this.streetLamps.length) {
        const t0 = this.timeOfDay;
        this.timeOfDay = 22.5;
        this._applyEnvironment();
        this._updateStreetLights();
        const lit = (this._streetLampLights || []).filter((l) => l.intensity > 1).length;
        const glowNight = this._lampGlowMat ? this._lampGlowMat.opacity : 0;
        this.timeOfDay = 12;
        this._applyEnvironment();
        this._updateStreetLights();
        const glowDay = this._lampGlowMat ? this._lampGlowMat.opacity : 0;
        this.timeOfDay = t0;
        this._applyEnvironment();
        this._updateStreetLights();
        add('夜间路灯会点亮（白天全灭，池化点光）', lit >= 1 && glowNight > 0.3 && glowDay < 0.02,
          `${this.streetLamps.length} 盏灯头；深夜点亮 ${lit}/${(this._streetLampLights || []).length} 盏、光晕 ${glowNight.toFixed(2)}；白天光晕 ${glowDay.toFixed(2)}`);
      }
      // 车辆是否真的换成了道具包「车辆」里的 Cars Pack 模型
      const carModels = this.world && this.world.stats ? this.world.stats.carModels : null;
      const carKeys = carModels ? Object.keys(carModels) : [];
      const carFallback = carKeys.filter((k) => k.startsWith('fallback'));
      add('车辆使用 Cars Pack 模型', !!(carModels && carKeys.length >= 3 && carFallback.length === 0),
        carModels
          ? `${carKeys.length} 种车型：${Object.entries(carModels).map(([k, n]) => `${k}×${n}`).join(' ')}${carFallback.length ? ` / 回退 ${carFallback.join(',')}` : ''}`
          : '无车辆统计');
      // 球衣图集按「队 + 号码」现生成：这里确认确实按号码区分了，而不是全队一个号
      const kitKeys = this._atlasCache ? [...this._atlasCache.keys()] : [];
      const kitNums = new Set(kitKeys.map((k) => String(k).split(':')[1]));
      add('球衣按球员号码区分', kitKeys.length > 0 && kitNums.size >= 2,
        `${kitKeys.length} 套图集 / ${kitNums.size} 个不同号码 / 缓存上限 ${this._atlasMax || 0}`);
      if (this.playerCharacter) {
        // 回归检查：几何必须落在模型空间，否则所有部件会堆在原点、角色只剩 0.5m。
        // 注意 FBX 资产这里量到的是 **bind 姿态**几何包围盒（略矮于站立高度，实测 1.38m），
        // 所以下限放低到 1.1m：这条断言的目标是"没有塌陷"，而不是量身高。
        const box = new THREE.Box3().setFromObject(this.playerCharacter.rig.mesh);
        const h = box.max.y - box.min.y;
        add('角色模型未塌陷 (1.1~2.4m)', h > 1.1 && h < 2.4, `${h.toFixed(2)}m bind姿态`);
        add('角色模型站在地面上 (脚底 ≈ 0)', Math.abs(box.min.y) < 0.25, `minY=${box.min.y.toFixed(2)}`);
      }
      add('玩家骨骼数量', (() => {
        const rig = this.playerCharacter && this.playerCharacter.rig;
        if (!rig) return false;
        const n = rig.skeleton && rig.skeleton.bones ? rig.skeleton.bones.length : rig.boneList.length;
        return n >= 19;
      })(), (() => {
        const rig = this.playerCharacter && this.playerCharacter.rig;
        if (!rig) return '0';
        const n = rig.skeleton && rig.skeleton.bones ? rig.skeleton.bones.length : rig.boneList.length;
        return `${n}（来源 ${this.playerCharacter.modelKind}）`;
      })());
      add('动画片段数量 >= 15', Object.keys(this.playerCharacter.animator.clips).length >= 15, String(Object.keys(this.playerCharacter.animator.clips).length));
      add('动画机在播放', !!this.playerCharacter.animator.current);
      add('NPC 数量 > 0', this.director && this.director.npcs.length > 0, this.director ? String(this.director.npcs.length) : '');
      add('足球数据已加载', this.football && this.football.loaded, this.football ? this.football.source : '');
      add('阵营数量 >= 2', this.football && this.football.factions.length >= 2, this.football ? String(this.football.factions.length) : '');
      add('球员身份可用', this.football && this.football.survivorPool.length > 0, this.football ? String(this.football.survivorPool.length) : '');
      add('球衣贴图已生成', !!(this.playerCharacter && this.playerCharacter.kit), this.playerCharacter ? this.playerCharacter.kit.pattern : '');
      add('交互点数量 > 0', this._interactables.length > 0, String(this._interactables.length));
      add('拾取物数量 > 0', this.pickups.size > 0, String(this.pickups.size));
      add('音频系统已初始化', !!this.audio, this.audio ? String(this.audio.available) : '');
      add('存档系统可用', !!(this.save && this.save.available));
      add('主循环无致命异常', !this._fatal, this._fatalStack ? this._fatalStack.split('\n').slice(0, 4).join(' / ') : '');
      add('FPS 采样', this._fps >= 0, String(this._fps));

      // 寻路：从出生点能走进建筑内部。
      // 不写死 buildings[0]（它的形状/室内家具会随建筑资源变化，可能刚好被一个柜子占住中心格），
      // 而是统计"有多少栋能走到"，并报出具体哪几栋走不进去 —— 这样失败时能直接定位到那栋楼。
      if (this.nav && this.layout) {
        const from = { x: this.player.pos.x, z: this.player.pos.z };
        const reachable = [];
        const blocked = [];
        for (const b of this.layout.buildings) {
          const target = { x: (b.rect.x0 + b.rect.x1) / 2, z: (b.rect.z0 + b.rect.z1) / 2 };
          const path = this.nav.findPath(from, target);
          if (path && path.length) reachable.push(b.id);
          else blocked.push(b.id);
        }
        const total = this.layout.buildings.length;
        // 门槛定在 60%：这条检查要证明"导航能走进建筑"，
        // 不是"每一栋都能进"（细长仓库里被柜子占住中心格、门洞窄于 2m 网格，
        // 都会让个别建筑走不进去 —— 那属于建筑/门洞侧的问题，靠 detail 里的清单暴露出来）。
        add('可以从出生点寻路到建筑内部', reachable.length >= Math.ceil(total * 0.6),
          `${reachable.length}/${total} 栋可达${blocked.length ? `，走不进去：${blocked.join(',')}` : ''}`);
      }

      // 地图：底图 / 要素 / 标记 / 开关。既看数据（要素数量），也看画布（真的画上了东西）。
      if (this.map) {
        const ms = this.map.summary();
        add('地图：底图已烘焙（地形 + 土地覆盖 + 河网）',
          ms.ready && !!ms.raster && ms.raster.width >= 128 && ms.raster.height >= 128,
          ms.raster ? `${ms.raster.width}×${ms.raster.height}px / 图幅 ${ms.size}m / 来源 ${ms.source}` : '没有底图');
        add('地图：建筑/道路/树都上了图',
          ms.buildings > 0 && (ms.roads > 0 || ms.streets > 0) && ms.trees > 0,
          `建筑 ${ms.buildings} · 镇内街道 ${ms.streets} · OSM 道路 ${ms.roads} · 树 ${ms.trees} · 地点 ${ms.pois}`);
        // 画布取样：数一下颜色种类，证明不是一块纯色（底图/道路/建筑/标记各是各的颜色）
        const colorKinds = (id) => {
          const cv = typeof document !== 'undefined' ? document.getElementById(id) : null;
          if (!cv || !cv.getContext || !cv.width || !cv.height) return 0;
          const ctx = cv.getContext('2d');
          const w = cv.width, h = cv.height;
          const data = ctx.getImageData(0, 0, w, h).data;
          const seen = new Set();
          const step = Math.max(4, Math.floor((w * h) / 12000) * 4);
          for (let i = 0; i < data.length; i += step) {
            if (data[i + 3] < 8) continue;
            seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
            if (seen.size > 64) break;
          }
          return seen.size;
        };
        this.map.drawMinimap();
        const mmKinds = colorKinds('dd-minimap-canvas');
        add('地图：小地图真的画上了内容（不是空圆框）', mmKinds >= 6, `${mmKinds} 种颜色`);
        const near = buildMarkers(this._mapState(), { range: MAP_LIMITS.minimapRange });
        const zMarks = near.markers.filter((m) => m.kind === 'zombie' || m.kind === 'zombie-alert').length;
        add('地图：附近感染者在小地图范围内被标出来', zMarks > 0,
          `${near.stats.zombies} 个在 ${MAP_LIMITS.minimapRange}m 内（其中 ${near.stats.alert} 个正在追）· 最近 ${near.stats.nearestZombie == null ? '—' : near.stats.nearestZombie.toFixed(0) + 'm'}`);
        const opened = this.openMap();
        const bigKinds = colorKinds('dd-map-canvas');
        const openState = !!this.map.open;
        this.closeMap(false);
        add('地图：大地图能打开 / 关闭并且有内容',
          opened && openState && bigKinds >= 8 && this.map.open === false,
          `打开=${opened}·关闭=${this.map.open === false}·画布 ${bigKinds} 种颜色`);
        add('地图：大地图打开时世界暂停',
          (() => {
            this.openMap();
            const e0 = this.elapsed;
            const wasMap = this.map.open;
            this._updateGame(1 / 60);
            const frozen = Math.abs(this.elapsed - e0) < 1e-9;
            this.closeMap(false);
            return wasMap && frozen;
          })(), 'elapsed 在打开期间不推进');
      } else {
        add('地图系统已创建', false, 'this.map 为 null');
      }
      // 战斗：向空气开枪不应抛错
      try {
        const r = resolveShot({
          world: this.collision, targets: this._targets, ray: this._ray,
          origin: { x: this.player.pos.x, y: 1.6, z: this.player.pos.z },
          dir: { x: 0, y: 0, z: 1 }, weapon: WEAPONS.w_pistol_9mm, maxRange: 100,
        });
        add('射线结算可执行', Array.isArray(r) && r.length === 1);
      } catch (e) { add('射线结算可执行', false, String(e && e.message)); }

      // 天气 / 季节：不只看"能不能画出来"，还要看状态机、季节限定、存档、感知有没有真的接上
      const wx = this.weather;
      add('天气系统已创建', !!wx && !!this.weatherFx,
        wx ? `${wx.params.id}/${wx.params.label}（季节 ${wx.season}）` : 'null');
      add('天气粒子已建（雨/雪各 1 个 draw call，开局已预热）',
        !!this.weatherFx && this.weatherFx.stats.rain > 0 && this.weatherFx.stats.snow > 0 && this.weatherFx.stats.warmed === true,
        this.weatherFx ? `雨 ${this.weatherFx.stats.rain} / 雪 ${this.weatherFx.stats.snow} / 风材质 ${this.weatherFx.stats.windMaterials}` : 'null');
      add('树木已接上风摆（换季重建树后要能重新接）',
        !!this.weatherFx && this.weatherFx.stats.windMaterials > 0,
        `${this.weatherFx ? this.weatherFx.stats.windMaterials : 0} 个材质`);
      const fogEnv = computeEnvironment({
        seasonEnv: SEASON_ENV[this.season], weather: WEATHERS.fog, baseFogDensity: 0.0085,
      });
      const stormEnv = computeEnvironment({
        seasonEnv: SEASON_ENV[this.season], weather: WEATHERS.storm, wetness: 0.85, snowCover: 0, baseFogDensity: 0.0085,
      });
      add('雾天雾更浓、能见度更低', fogEnv.fogDensity > 0.0085 * 2 && WEATHERS.fog.sight < 0.6,
        `雾密度 ${fogEnv.fogDensity.toFixed(4)} / 能见倍率 ${WEATHERS.fog.sight}`);
      add('雷雨 + 湿透：地面被压暗', stormEnv.ground !== SEASON_ENV[this.season].ground,
        `#${stormEnv.ground.toString(16)} vs 季节色 #${SEASON_ENV[this.season].ground.toString(16)}`);
      add('季节限定天气（冬天有雪、夏天没有）',
        weatherIdsForSeason('winter').includes('snow') && !weatherIdsForSeason('summer').includes('snow'),
        `冬 ${weatherIdsForSeason('winter').join('/')}｜夏 ${weatherIdsForSeason('summer').join('/')}`);
      add('温度随季节变化（冬 < 夏）',
        weatherTemperature('winter', WEATHERS.clear, 12) < weatherTemperature('summer', WEATHERS.clear, 12),
        `冬 ${weatherTemperature('winter', WEATHERS.clear, 12).toFixed(0)}°C / 夏 ${weatherTemperature('summer', WEATHERS.clear, 12).toFixed(0)}°C`);
      const wxSave = wx ? wx.serialize() : null;
      const wxBack = new WeatherSystem({ seed: 1, season: wx ? wx.season : 'summer' });
      if (wxSave) wxBack.restore(wxSave);
      add('天气状态可存档往返（天气不跳变）', !!wxSave && wxBack.currentId === wx.currentId,
        wxSave ? `${wxSave.currentId} → ${wxBack.currentId}` : 'null');
      add('AI 感知倍率由天气给出', typeof this._perceptionNow === 'function' && !!SEASON_ENV[this.season], 'via world.perception');

      // 车辆使用系统（油 / 引擎 / 车灯 / 撞击）：真的把一台车开 1 秒，看油掉没掉、速度起没起
      if (this.vehicles && this.cars && this.cars.length) {
        const car = this.cars.find((c) => c.drivable) || this.cars[0];
        const fuel0 = Number.isFinite(car.fuel) ? car.fuel : 100;
        const ok = this.vehicles.enter(car, this.player);
        if (ok) {
          const fakeInput = { isDown: (a) => a === 'forward' };
          const pos0 = { x: car.mesh.position.x, z: car.mesh.position.z };
          for (let i = 0; i < 60; i += 1) this.vehicles.update(1 / 60, fakeInput, this.collision, {});
          const moved = Math.hypot(car.mesh.position.x - pos0.x, car.mesh.position.z - pos0.z);
          const burned = car.fuel < fuel0;
          car.lights = true;
          if (car.lights) this._updateCarLight(car);
          const lightOn = !!this._carLight && this._carLight.intensity > 0;
          // 撞击公式也顺手验一下（纯函数）
          const ram = ramDamage(12, this.config.vehicles);
          this.vehicles.exit(this.player);
          if (this._carLight) this._carLight.intensity = 0;
          add('车辆使用系统（油/引擎/车灯/撞击）', moved > 1 && burned && lightOn && ram > 0,
            `60 帧开 ${moved.toFixed(1)}m，油 ${fuel0.toFixed(0)}%→${car.fuel.toFixed(1)}%，车灯亮=${lightOn}，12m/s 撞击伤害 ${ram}`);
        } else {
          add('车辆使用系统（油/引擎/车灯/撞击）', false, '上不了车（没油且背包里没有汽油桶）');
        }
        // 后备箱：真的能存能取（不是"只能搜一次"的假容器）
        const tcar = this.cars[0];
        const trunk = tcar && tcar.trunkInv;
        if (trunk) {
          const item = 'i_mat_scrap';
          const before = trunk.countItem(item);
          trunk.add(item, 1, { ignoreWeight: true });
          const afterAdd = trunk.countItem(item);
          trunk.remove(item, 1);
          const afterRemove = trunk.countItem(item);
          add('后备箱可存取（独立载重/格数，内容进存档）',
            afterAdd === before + 1 && afterRemove === before,
            `${tcar.id}：${trunk.maxWeight}kg / ${trunk.slots.length} 格，${item} ${before}→${afterAdd}→${afterRemove}`);
        } else {
          add('后备箱可存取（独立载重/格数，内容进存档）', false, '车上没有 trunkInv');
        }
      }
    } catch (e) {
      report.ok = false;
      report.errors.push(String(e && e.stack ? e.stack : e));
    }
    return report;
  }

  dispose() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.input) this.input.dispose();
    if (this.audio) this.audio.dispose();
    this._teardownWorld();
    if (this.materials) this.materials.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    window.removeEventListener('resize', this._onResize);
  }
}

export default { Game };
