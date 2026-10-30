// 天气的"看得见"部分 —— 降水粒子、树木风摆、雷电闪光。
// 与 world/weather.js 的分工：那边只有数字与状态机，这边**只读**参数、不决定天气。
//
// 为什么自己写 ShaderMaterial 而不是引第三方粒子库：
//   · 项目零构建、零依赖（three.js 之外不引任何库），粒子库基本都要打包器；
//   · 只需要"绕着相机的一盒雨/雪"，用 mod() 在 GPU 里循环，一个 draw call 就够，
//     比 CPU 每帧写几千个顶点省得多，也不会有"粒子用完了"的问题；
//   · 雨的"拉丝"、雪的"飘"都是两行 shader 的事，不需要贴图（项目里也没有贴图文件）。
//
// 三个效果：
//   1. 雨：LineSegments，每滴 2 个顶点（头/尾），尾长与倾斜随风速变化；
//   2. 雪：Points，每个点按自身随机相位做正弦飘移，尺寸随距离衰减；
//   3. 风：给树木 InstancedMesh 的材质注入顶点位移（越高摆幅越大），
//      换季重建树之后要再调一次 syncTrees()，否则新材质没有风。
// 雷电闪光本身不在这里画：它只是把 flashLevel 报给 game，由 game 加在灯光/天空上，
// 这样"闪"和"时间/季节的环境色"用同一条路径，不会互相覆盖。

const WIND_CHUNK = `
  uniform float uWindTime;
  uniform float uWindStrength;
`;

/**
 * 把一棵树（或一组实例化树）的材质接上风。
 * 顶点位移在**物体空间**：树的几何已经按世界米烘焙、实例只有 Y 旋转与等比缩放，
 * 所以直接按顶点高度加水平偏移就等价于世界空间的风摆，不需要逆矩阵。
 */
function patchWindMaterial(mat, uniforms) {
  if (!mat || mat.userData.__windPatched) return false;
  mat.userData.__windPatched = true;
  // 不同材质的 shader 程序要能区分开（否则会命中 three 的程序缓存，风只对第一个材质生效）
  mat.customProgramCacheKey = () => 'dd-wind-v1';
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    shader.uniforms.uWindTime = uniforms.uWindTime;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.vertexShader = WIND_CHUNK + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        // 用实例位置当相位，相邻的树不会齐步走
        vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float phase = iPos.x * 0.37 + iPos.z * 0.29;
        float h = max(transformed.y, 0.0);
        float sway = sin(uWindTime * 1.7 + phase) * 0.62
                   + sin(uWindTime * 2.9 + phase * 1.7) * 0.38;
        // h 是"米"，树高 7~10m：系数 0.018 让树梢在狂风里晃 ~15cm，低多边形下刚好看得出来
        transformed.x += sway * uWindStrength * h * 0.018;
        transformed.z += sway * uWindStrength * h * 0.012;
      #endif`,
    );
  };
  mat.needsUpdate = true;
  return true;
}

const RAIN_VS = `
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform float uTime;
  uniform float uFall;
  uniform vec2 uWind;
  uniform float uLen;
  uniform float uOpacity;
  uniform float uFade;
  attribute vec3 aSeed;
  attribute float aTail;
  varying float vAlpha;
  void main() {
    vec3 p;
    // 盒子以相机为中心、但**在 Y 上贴地**：雨滴从地面 0m 落到盒顶，不会有一半粒子在地底
    p.x = mod(aSeed.x * uBox.x + uWind.x * uTime, uBox.x) - uBox.x * 0.5;
    p.z = mod(aSeed.z * uBox.z + uWind.y * uTime, uBox.z) - uBox.z * 0.5;
    p.y = mod(aSeed.y * uBox.y - uFall * uTime, uBox.y);
    vec3 world = vec3(uCenter.x + p.x, p.y, uCenter.z + p.z);
    // 尾巴向上，并顺着风向斜一点（风越大雨越斜）
    world += normalize(vec3(-uWind.x * 0.06, 1.0, -uWind.y * 0.06)) * (aTail * uLen);
    vec4 mv = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = -mv.z;
    // 太近的雨点会糊在镜头上，太远的看不见：两端都淡出
    vAlpha = uOpacity * smoothstep(0.4, 2.2, d) * (1.0 - smoothstep(uFade * 0.72, uFade, d));
  }
`;

const RAIN_FS = `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.004) discard;
    gl_FragColor = vec4(uColor, vAlpha);
  }
`;

const SNOW_VS = `
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform float uTime;
  uniform float uFall;
  uniform vec2 uWind;
  uniform float uSize;
  uniform float uOpacity;
  uniform float uFade;
  attribute vec3 aSeed;
  attribute float aRand;
  varying float vAlpha;
  void main() {
    float sp = 0.55 + aRand * 0.8;
    float sx = sin(uTime * (0.5 + aRand * 0.7) + aSeed.x * 31.0) * (0.35 + uWind.x * 1.6);
    float sz = cos(uTime * (0.4 + aRand * 0.6) + aSeed.z * 23.0) * (0.35 + uWind.y * 1.6);
    vec3 p;
    p.x = mod(aSeed.x * uBox.x + uWind.x * uTime + sx, uBox.x) - uBox.x * 0.5;
    p.z = mod(aSeed.z * uBox.z + uWind.y * uTime + sz, uBox.z) - uBox.z * 0.5;
    p.y = mod(aSeed.y * uBox.y - uFall * sp * uTime, uBox.y);
    // 与雨一样贴地：雪从地面 0m 飘到盒顶
    vec4 mv = viewMatrix * vec4(uCenter.x + p.x, p.y, uCenter.z + p.z, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = -mv.z;
    vAlpha = uOpacity * smoothstep(0.3, 1.8, d) * (1.0 - smoothstep(uFade * 0.7, uFade, d));
    // 点尺寸必须夹住：不夹的话近处一片雪花能盖住半个屏幕（几十万像素的 overdraw）
    gl_PointSize = min(uSize * (14.0 / max(0.6, d)) * (0.7 + aRand * 0.6), 16.0);
  }
`;

const SNOW_FS = `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c);
    if (r > 0.5 || vAlpha < 0.004) discard;
    float a = vAlpha * smoothstep(0.5, 0.18, r);
    gl_FragColor = vec4(uColor, a);
  }
`;

// ── 云 ────────────────────────────────────────────────
// 低多边形场景里做云，最划算的是"贴着相机的一圈公告板"：20 个面片、1 个 draw call、
// 一张 128×128 的程序化噪声贴图（不引入任何图片文件）。
// 位置是世界锚定的（按相机位置取最近的周期副本），所以云会随玩家移动产生视差，
// 而不是像贴纸一样糊在镜头上。
function makeCloudTexture(THREE, size = 128) {
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    const u = smooth(xf);
    const v = smooth(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, y) => {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < 5; i += 1) {
      sum += noise(x * f, y * f) * amp;
      f *= 2;
      amp *= 0.5;
    }
    return sum;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;
      // 边缘淡出 + 圆形径向淡出：公告板是块方片，只做边缘淡出的话四角仍会露出方框，
      // 叠两片云就能看到直线接缝。径向遮罩把每片云压成"圆团"，接缝就看不出来了。
      const edge = Math.min(1, Math.min(nx, 1 - nx) * 4) * Math.min(1, Math.min(ny, 1 - ny) * 4);
      const dx = nx - 0.5;
      const dy = ny - 0.5;
      const radial = Math.max(0, 1 - Math.hypot(dx, dy) * 2.1);
      const n = fbm(nx * 4.5, ny * 4.5) * 1.7;
      let a = (n - 0.5) * 2.6;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      a = a * a * (3 - 2 * a);                 // smoothstep：云的边缘是软的，不是剪纸
      a *= Math.pow(radial, 0.85) * edge;
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, a * 1.15) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// 雨滴落地溅射：固定在一圈地面上的点，相位随时间循环 → 扩散环 + 淡出。
// 没有它的话"下雨"只有空中拉丝，低头看地面是干的，雨会显得很薄。
const SPLASH_VS = `
  uniform vec3 uCenter;
  uniform float uBox;
  uniform float uTime;
  uniform float uOpacity;
  attribute vec3 aSeed;
  varying float vPhase;
  varying float vAlpha;
  void main() {
    float phase = fract(uTime * 0.85 + aSeed.z);
    float x = mod(aSeed.x * uBox, uBox) - uBox * 0.5;
    float z = mod(aSeed.y * uBox, uBox) - uBox * 0.5;
    vec4 mv = viewMatrix * vec4(uCenter.x + x, 0.06, uCenter.z + z, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = -mv.z;
    vPhase = phase;
    vAlpha = uOpacity * smoothstep(0.6, 2.0, d) * (1.0 - smoothstep(16.0, 28.0, d));
    gl_PointSize = (2.0 + phase * 5.0) * (10.0 / max(0.8, d));
  }
`;

const SPLASH_FS = `
  varying float vPhase;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c);
    float ring = 0.08 + vPhase * 0.34;
    float band = smoothstep(0.045, 0.0, abs(r - ring));
    float a = band * vAlpha * (1.0 - vPhase);
    if (a < 0.01) discard;
    gl_FragColor = vec4(0.78, 0.86, 0.94, a);
  }
`;

/** 每种画质下的粒子预算：低画质不是"关掉天气"，而是粒子少一半。 */
const PARTICLE_BUDGET = {
  low: { rain: 620, snow: 520, splash: 130, clouds: 12, box: [26, 20, 26], fade: 34 },
  medium: { rain: 1300, snow: 1000, splash: 260, clouds: 20, box: [34, 24, 34], fade: 52 },
  high: { rain: 2100, snow: 1600, splash: 420, clouds: 28, box: [42, 28, 42], fade: 78 },
};

/** 电弧的折线段数：12 段看起来已经足够"劈开天空"，再多只是白花顶点。 */
const BOLT_SEGMENTS = 12;
/** 电弧从多高劈下来（米）。低多边形场景里 58m 已经够"从云里下来"。 */
const BOLT_TOP_Y = 58;

export class WeatherFx {
  /**
   * @param {object} THREE
   * @param {object} opts { scene, camera, quality, treeGroup }
   */
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.scene = opts.scene || null;
    this.camera = opts.camera || null;
    this.quality = opts.quality || 'medium';
    this.stats = { rain: 0, snow: 0, splash: 0, bolts: 0, clouds: 0, windMaterials: 0, drawCalls: 0, lightning: 0 };
    this.flashLevel = 0;
    this._windUniforms = { uWindTime: { value: 0 }, uWindStrength: { value: 0 } };
    this._windMats = [];
    this._disposed = false;
    this._rain = null;
    this._snow = null;
    this._splash = null;
    this._bolt = null;
    this._clouds = null;
    this._cloudDrift = 0;
    this._boltLife = 0;
    this._budget = PARTICLE_BUDGET[this.quality] || PARTICLE_BUDGET.medium;
    this._rainLevel = 0;
    this._snowLevel = 0;
    this._buildRain();
    this._buildSnow();
    this._buildSplash();
    this._buildBolt();
    this._buildClouds();
    this.syncTrees(opts.treeGroup || null);
  }

  // ── 构建 ──
  _newSeed(N) {
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i += 1) seeds[i] = Math.random();
    return seeds;
  }

  _buildRain() {
    const THREE = this.THREE;
    if (!THREE || !this.scene) return;
    const N = this._budget.rain;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 2 * 3);
    const seeds = new Float32Array(N * 2 * 3);
    const tails = new Float32Array(N * 2);
    const base = this._newSeed(N);
    for (let i = 0; i < N; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        const v = i * 2 + j;
        seeds[v * 3] = base[i * 3];
        seeds[v * 3 + 1] = base[i * 3 + 1];
        seeds[v * 3 + 2] = base[i * 3 + 2];
        tails[v] = j;            // 0 = 头，1 = 尾
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aTail', new THREE.BufferAttribute(tails, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(...this._budget.box) },
        uTime: { value: 0 },
        uFall: { value: 22 },
        uWind: { value: new THREE.Vector2(0.4, 0.4) },
        uLen: { value: 0.9 },
        uOpacity: { value: 0 },
        uFade: { value: this._budget.fade },
        uColor: { value: new THREE.Color(0xc7d8e6) },
      },
      vertexShader: RAIN_VS,
      fragmentShader: RAIN_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.name = 'weather:rain';
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    this.scene.add(mesh);
    this._rain = mesh;
    this.stats.rain = N;
  }

  _buildSnow() {
    const THREE = this.THREE;
    if (!THREE || !this.scene) return;
    const N = this._budget.snow;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const seeds = new Float32Array(N * 3);
    const rand = new Float32Array(N);
    const base = this._newSeed(N);
    for (let i = 0; i < N; i += 1) {
      seeds[i * 3] = base[i * 3];
      seeds[i * 3 + 1] = base[i * 3 + 1];
      seeds[i * 3 + 2] = base[i * 3 + 2];
      rand[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(this._budget.box[0] * 1.1, this._budget.box[1], this._budget.box[2] * 1.1) },
        uTime: { value: 0 },
        uFall: { value: 2.2 },
        uWind: { value: new THREE.Vector2(0.3, 0.3) },
        uSize: { value: 3.4 },
        uOpacity: { value: 0 },
        uFade: { value: this._budget.fade },
        uColor: { value: new THREE.Color(0xf2f7fc) },
      },
      vertexShader: SNOW_VS,
      fragmentShader: SNOW_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Points(geo, mat);
    mesh.name = 'weather:snow';
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    this.scene.add(mesh);
    this._snow = mesh;
    this.stats.snow = N;
  }

  /** 雨滴落地溅射（Points + 圆环 fragment）。只在雨天、室外、地面没被雪盖住时显示。 */
  _buildSplash() {
    const THREE = this.THREE;
    if (!THREE || !this.scene) return;
    const N = this._budget.splash;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const seeds = this._newSeed(N);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: 20 },
        uTime: { value: 0 },
        uOpacity: { value: 0 },
      },
      vertexShader: SPLASH_VS,
      fragmentShader: SPLASH_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Points(geo, mat);
    mesh.name = 'weather:splash';
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.visible = false;
    this.scene.add(mesh);
    this._splash = mesh;
    this.stats.splash = N;
  }

  /** 可见电弧：一条折线，从云高度劈到地面；只在雷击那一刻生成，0.26 秒淡出。 */
  _buildBolt() {
    const THREE = this.THREE;
    if (!THREE || !this.scene) return;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(BOLT_SEGMENTS * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.LineBasicMaterial({
      color: 0xd8e9ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.name = 'weather:bolt';
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    mesh.visible = false;
    this.scene.add(mesh);
    this._bolt = mesh;
    this._boltLife = 0;
  }

  /** 云：一圈世界锚定的公告板，1 个 draw call；厚度用两张叠片不太划算，就用单张大贴图。 */
  _buildClouds() {
    const THREE = this.THREE;
    if (!THREE || !this.scene) return;
    const N = this._budget.clouds || 0;
    if (!N) return;
    const tex = makeCloudTexture(THREE);
    // 用圆盘而不是方片：方片无论怎么淡出边缘，斜看时四条直边仍会露出来；
    // 圆盘 + 径向 alpha 贴图，从任何角度看边缘都是软的。
    const geo = new THREE.CircleGeometry(0.5, 28);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      // 云不参与地面雾：否则阴天/雨天的雾会先把云吃光（雾是按距离累加的），
      // 抬头只剩一片纯色天。云的"距离感"由覆盖度 + 天色 + 云层高度自己表达。
      fog: false,
      toneMapped: false,
    });
    const inst = new THREE.InstancedMesh(geo, mat, N);
    inst.name = 'weather:clouds';
    inst.frustumCulled = false;
    inst.renderOrder = -1;   // 先画云，再画世界：树/建筑会正确遮挡它
    inst.visible = false;
    this._cloudData = [];
    for (let i = 0; i < N; i += 1) {
      this._cloudData.push({
        // 云层铺得比可视距离还远，远端被雾吃掉，所以"云层边界"不会变成一条硬直线。
        // 高度别太高：雾是按距离累加的，太高的云在阴天里就先被雾吃没了。
        x: (Math.random() - 0.5) * 900,
        z: (Math.random() - 0.5) * 900,
        y: 80 + Math.random() * 70,
        s: 380 + Math.random() * 320,
        a: 0.55 + Math.random() * 0.45,
      });
    }
    // 云面片是**水平**的（法线朝上/下），不是朝向相机的竖公告板：
    // 抬头看云时竖公告板会变成一条边、出现横贯屏幕的直线接缝；水平面才是"从下往上看云顶"。
    this._cloudRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    this._cloudM4 = new THREE.Matrix4();
    this._cloudP = new THREE.Vector3();
    this._cloudS = new THREE.Vector3();
    this.scene.add(inst);
    this._clouds = inst;
    this.stats.clouds = N;
  }

  /**
   * 更新云：位置按"离相机最近的周期副本"取，所以云固定在世界里、又总有一份在附近；
   * 只绕 Y 轴朝向相机（不整体 lookAt，否则云会跟着俯仰翻起来）。
   */
  _updateClouds(dt, cover, fogMul, wind, camPos) {
    const inst = this._clouds;
    if (!inst || !camPos) return;
    const show = cover > 0.05;
    inst.visible = show;
    if (!show) return;
    this._cloudDrift += dt * (0.4 + wind * 2.2);
    const box = 900;
    const mat = inst.material;
    // 雾越大云越"化"进天里（天气的 fogMul 已经包含季节倍率）
    const fogFade = Math.max(0.2, 1 - Math.max(0, fogMul - 1) * 0.3);
    mat.opacity = Math.min(0.92, cover * 0.92) * fogFade;
    const shade = 1 - 0.32 * cover;
    mat.color.setRGB(shade, shade * 0.99, shade * 0.96);
    const q = this._cloudRot;
    const m4 = this._cloudM4;
    const p = this._cloudP;
    const s = this._cloudS;
    for (let i = 0; i < this._cloudData.length; i += 1) {
      const c = this._cloudData[i];
      const baseX = c.x + this._cloudDrift;
      const baseZ = c.z;
      const x = baseX + Math.round((camPos.x - baseX) / box) * box;
      const z = baseZ + Math.round((camPos.z - baseZ) / box) * box;
      p.set(x, c.y, z);
      s.set(c.s, c.s, 1);
      m4.compose(p, q, s);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
  }

  /**
   * 打一条闪电（视觉，不含伤害）。位置由 game 传入世界坐标 + 天气事件的 angle/distance。
   * 折线中点横向抖动，末端收敛到落点，所以看起来是"劈"下来的而不是一条斜线。
   */
  strike(px, pz, ev = {}) {
    if (!this._bolt || this._disposed) return this;
    const dist = Math.max(28, Math.min(240, Number(ev.distance) || 90));
    const ang = Number.isFinite(ev.angle) ? ev.angle : Math.random() * Math.PI * 2;
    const gx = px + Math.cos(ang) * dist;
    const gz = pz + Math.sin(ang) * dist;
    // 顶端往回偏一点：闪电是从斜上方劈下来的，正上方一条竖线反而假
    const topX = gx - Math.cos(ang) * dist * 0.16;
    const topZ = gz - Math.sin(ang) * dist * 0.16;
    const attr = this._bolt.geometry.getAttribute('position');
    let prevX = topX;
    let prevY = BOLT_TOP_Y;
    let prevZ = topZ;
    for (let i = 1; i <= BOLT_SEGMENTS; i += 1) {
      const t = i / BOLT_SEGMENTS;
      const spread = 9 * (1 - t * 0.65);   // 越靠近地面抖动越小
      const nx = topX + (gx - topX) * t + (Math.random() - 0.5) * spread;
      const nz = topZ + (gz - topZ) * t + (Math.random() - 0.5) * spread;
      const ny = BOLT_TOP_Y * (1 - t);
      const v = (i - 1) * 2;
      attr.setXYZ(v, prevX, prevY, prevZ);
      attr.setXYZ(v + 1, nx, ny, nz);
      prevX = nx; prevY = ny; prevZ = nz;
    }
    attr.needsUpdate = true;
    this._bolt.visible = true;
    this._bolt.material.opacity = 0.95;
    this._boltLife = 0.26;
    this.stats.bolts += 1;
    return this;
  }

  // ── 树木风 ──
  /** 换季会重建树材质，所以 setSeason 之后要再调一次；重复调用是安全的。 */
  syncTrees(treeGroup) {
    this._windMats.length = 0;
    if (!treeGroup) return this;
    const seen = new Set();
    treeGroup.traverse((o) => {
      if (!o.isInstancedMesh || !o.material || seen.has(o.material)) return;
      seen.add(o.material);
      if (patchWindMaterial(o.material, this._windUniforms)) this._windMats.push(o.material);
    });
    this.stats.windMaterials = this._windMats.length;
    return this;
  }

  setQuality(quality) {
    if (!PARTICLE_BUDGET[quality] || quality === this.quality) return this;
    this.quality = quality;
    this._budget = PARTICLE_BUDGET[quality];
    // 粒子数量在建造时定了：画质切换只改预算里的可视距离与盒子尺寸，不重建几何
    if (this._rain) {
      this._rain.material.uniforms.uFade.value = this._budget.fade;
      this._rain.material.uniforms.uBox.value.set(...this._budget.box);
    }
    if (this._snow) {
      this._snow.material.uniforms.uFade.value = this._budget.fade;
      this._snow.material.uniforms.uBox.value.set(this._budget.box[0] * 1.1, this._budget.box[1], this._budget.box[2] * 1.1);
    }
    // 溅射只覆盖玩家脚边一小圈：盒子太大反而看不出"雨点砸在地上"
    if (this._splash) this._splash.material.uniforms.uBox.value = Math.max(14, this._budget.box[0] * 0.7);
    return this;
  }

  /** 闪电闪光包络（由 game 根据 weather 事件调用，1 = 最亮）。 */
  flash(power = 1) {
    this.flashLevel = Math.max(this.flashLevel, Math.min(1, power));
    this.stats.lightning += 1;
    return this;
  }

  /**
   * 预热：把雨/雪的 shader 在**进游戏时**编译掉，而不是等第一场雨。
   * 第一次下雨卡 200ms 是"天气系统看起来卡"的最常见原因（材质/程序编译发生在渲染线程）。
   * 做法：临时可见 + renderer.compile()，然后恢复隐藏。
   */
  warmup(renderer) {
    if (!renderer || !this._rain || !this._snow || this._disposed) return this;
    const rainWas = this._rain.visible;
    const snowWas = this._snow.visible;
    const rainOp = this._rain.material.uniforms.uOpacity.value;
    const snowOp = this._snow.material.uniforms.uOpacity.value;
    const cloudsWas = this._clouds ? this._clouds.visible : false;
    const cloudsOp = this._clouds ? this._clouds.material.opacity : 0;
    this._rain.visible = true;
    this._snow.visible = true;
    this._rain.material.uniforms.uOpacity.value = 0;
    this._snow.material.uniforms.uOpacity.value = 0;
    if (this._clouds) {
      this._clouds.visible = true;
      this._clouds.material.opacity = 0;
    }
    try {
      if (renderer.compile) renderer.compile(this.scene, this.camera);
    } catch (e) {
      console.warn('[weather] shader 预热失败（不影响玩法）', e);
    }
    this._rain.visible = rainWas;
    this._snow.visible = snowWas;
    this._rain.material.uniforms.uOpacity.value = rainOp;
    this._snow.material.uniforms.uOpacity.value = snowOp;
    if (this._clouds) {
      this._clouds.visible = cloudsWas;
      this._clouds.material.opacity = cloudsOp;
    }
    this.stats.warmed = true;
    return this;
  }

  /**
   * 每帧更新。只读 params：
   * @param {number} dt
   * @param {object} params WeatherSystem.params
   * @param {{indoor?:boolean, snowCover?:number}} [ctx]
   */
  update(dt, params, ctx = {}) {
    if (this._disposed) return;
    const p = params || {};
    const cam = this.camera;
    const camPos = cam ? cam.position : null;
    // 积雪覆盖由 game 传进来（它是天气系统的慢变量，不在 params 里）
    this._snowCoverNow = Math.max(0, Math.min(1, Number(ctx.snowCover) || 0));

    // 闪光衰减：指数式，两次闪电之间不会互相叠加成常亮
    if (this.flashLevel > 0) this.flashLevel = Math.max(0, this.flashLevel - dt * 3.4);

    // 风：室内也保留一点（窗外有树），但整体减弱
    const wind = Math.max(0, Math.min(1, p.wind || 0)) * (ctx.indoor ? 0.35 : 1);
    this._windUniforms.uWindTime.value += dt * (0.55 + wind * 1.9);
    this._windUniforms.uWindStrength.value = wind * 1.25;

    const rainLevel = p.precip === 'rain' ? Math.max(0, Math.min(1, p.precipAmount || 0)) : 0;
    const snowLevel = p.precip === 'snow' ? Math.max(0, Math.min(1, p.precipAmount || 0)) : 0;

    // 降水强度变化是有惯性的：雨不会一帧内从 0 变满
    this._rainLevel += (rainLevel - this._rainLevel) * Math.min(1, dt * 1.6);
    this._snowLevel += (snowLevel - this._snowLevel) * Math.min(1, dt * 1.2);

    if (this._rain && camPos) {
      const m = this._rain.material;
      const show = this._rainLevel > 0.02 && !ctx.indoor;
      this._rain.visible = show;
      if (show) {
        const u = m.uniforms;
        u.uCenter.value.copy(camPos);
        u.uTime.value += dt * (0.9 + (p.wind || 0) * 0.4);
        u.uWind.value.set((p.wind || 0) * 4.5, (p.wind || 0) * 2.0);
        u.uFall.value = 18 + 8 * (p.precipAmount || 0);
        u.uLen.value = 0.55 + 0.85 * (p.precipAmount || 0);
        u.uOpacity.value = 0.22 + 0.3 * this._rainLevel;
        u.uFade.value = this._budget.fade;
      }
    }
    if (this._snow && camPos) {
      const m = this._snow.material;
      const show = this._snowLevel > 0.02 && !ctx.indoor;
      this._snow.visible = show;
      if (show) {
        const u = m.uniforms;
        u.uCenter.value.copy(camPos);
        u.uTime.value += dt;
        u.uWind.value.set((p.wind || 0) * 3.2, (p.wind || 0) * 2.4);
        u.uFall.value = 1.6 + 1.6 * (p.precipAmount || 0);
        u.uSize.value = 2.6 + 2.0 * this._snowLevel;
        u.uOpacity.value = 0.5 + 0.35 * this._snowLevel;
      }
    }

    // 溅射：雨才溅，雪天/室内不溅。地面已经被雪盖住时也基本看不见，所以淡出。
    if (this._splash && camPos) {
      const snow = Math.max(0, Math.min(1, this._snowCoverNow || 0));
      const show = this._rainLevel > 0.05 && !ctx.indoor && snow < 0.6;
      this._splash.visible = show;
      if (show) {
        const u = this._splash.material.uniforms;
        u.uCenter.value.copy(camPos);
        u.uTime.value += dt;
        u.uOpacity.value = (0.35 + 0.45 * this._rainLevel) * (1 - snow / 0.6);
      }
    }
    // 电弧：只剩一条 0.26 秒的生命，指数式收尾
    if (this._bolt) {
      if (this._boltLife > 0) {
        this._boltLife = Math.max(0, this._boltLife - dt);
        this._bolt.material.opacity = Math.min(1, this._boltLife / 0.2);
        if (this._boltLife <= 0) this._bolt.visible = false;
      }
    }

    // 云：跟着相机"复制最近的一份"，所以云是固定在世界里的，玩家走动有视差
    if (this._clouds && camPos) {
      this._updateClouds(dt, p.cloud || 0, p.fogMul || 1, p.wind || 0, camPos);
    }

    let calls = 0;
    for (const m of [this._rain, this._snow, this._splash, this._bolt, this._clouds]) if (m && m.visible) calls += 1;
    this.stats.drawCalls = calls;
  }

  dispose() {
    this._disposed = true;
    for (const mat of this._windMats) {
      if (!mat) continue;
      mat.onBeforeCompile = () => {};
      mat.customProgramCacheKey = null;
      mat.needsUpdate = true;
    }
    this._windMats.length = 0;
    for (const mesh of [this._rain, this._snow, this._splash, this._bolt, this._clouds]) {
      if (!mesh) continue;
      if (mesh.parent) mesh.parent.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
      }
    }
    this._rain = null;
    this._snow = null;
    this._splash = null;
    this._bolt = null;
    this._clouds = null;
    this.stats.rain = 0;
    this.stats.snow = 0;
    this.stats.clouds = 0;
    this.stats.splash = 0;
  }
}

export default { WeatherFx, patchWindMaterial, PARTICLE_BUDGET };
