// 资产加载层：FBX（角色，带烘焙动画）+ OBJ/MTL（道具，MTL 里是纯色，无贴图）。
// 设计要点：
//   · 只加载清单里显式列出的文件，加载失败会记在 errors 里并让调用方降级，绝不静默变空白；
//   · OBJ 烘焙成**带顶点色的单一几何**：Quaternius 道具是 MTL 纯色，烘焙后可以合批/实例化，
//     一次 draw call 画一片树，也不必为每个道具维护多材质；
//   · 所有资源都按包围盒归一到目标米制尺寸，避免不同包单位不一致（实测 FBX 里角色高 480~810 单位）。

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _v = { x: 0, y: 0, z: 0 };

/**
 * 清洗 OBJ 文本：丢掉孤立线段（`l`）和孤立点（`p`）。
 * 原因：three 的 OBJLoader 遇到 `l`/`p` 会把这个物体整体标记成 Line/Points，
 * **同一个 o 里的三角面也会被一起塞进 LineSegments** —— 结果既不渲染成面，
 * 烘焙顶点色时又因为不是 Mesh 被丢掉。Quaternius 的 Street_4Way.obj 末尾就带 4 条
 * 这样的孤立线段（实测），不清洗的话整块十字路口会消失。
 */
export function sanitizeObjText(text) {
  if (!text || typeof text !== 'string') return '';
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    const head = line.charCodeAt(0);
    // 'l' = 108, 'p' = 112，且后面必须是空白，避免误伤没有的其它指令
    if ((head === 108 || head === 112) && (line.length === 1 || line.charCodeAt(1) <= 32)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 取出索引区间 [start, start+count) 的三角形并转成非索引几何。
 * OBJLoader 对**多材质** OBJ（树 = 树干+树叶+雪）只返回一个 Mesh，
 * 材质挂在 `mesh.material` 数组 + `geometry.groups` 上；顶点色必须按 group 取材质，
 * 否则整棵树会被涂成同一个颜色（曾经的真实 bug）。
 */
function extractRange(THREE, geo, start, count) {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const index = geo.index;
  const total = index ? index.count : pos.count;
  const from = Math.max(0, Math.min(total, start | 0));
  const to = Math.max(from, Math.min(total, from + (count | 0)));
  const n = Math.floor((to - from) / 3) * 3;
  if (!n) return null;
  const idx = index ? index.array : null;
  const out = new THREE.BufferGeometry();
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const vi = idx ? idx[from + i] : (from + i);
    positions[i * 3] = pos.getX(vi);
    positions[i * 3 + 1] = pos.getY(vi);
    positions[i * 3 + 2] = pos.getZ(vi);
  }
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const nor = geo.getAttribute('normal');
  if (nor) {
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const vi = idx ? idx[from + i] : (from + i);
      arr[i * 3] = nor.getX(vi); arr[i * 3 + 1] = nor.getY(vi); arr[i * 3 + 2] = nor.getZ(vi);
    }
    out.setAttribute('normal', new THREE.BufferAttribute(arr, 3));
  }
  const uv = geo.getAttribute('uv');
  if (uv) {
    const arr = new Float32Array(n * 2);
    for (let i = 0; i < n; i += 1) {
      const vi = idx ? idx[from + i] : (from + i);
      arr[i * 2] = uv.getX(vi); arr[i * 2 + 1] = uv.getY(vi);
    }
    out.setAttribute('uv', new THREE.BufferAttribute(arr, 2));
  }
  return out;
}

export class AssetLoader {
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.base = opts.base || '';
    this.fbxCache = new Map();
    this.objCache = new Map();
    this.errors = [];
    this.stats = { fbx: 0, obj: 0, bytesText: 0 };
  }

  _url(p) { return p && p.startsWith('http') ? p : `${this.base}${p}`; }

  async loadFBX(url) {
    const key = this._url(url);
    if (this.fbxCache.has(key)) return this.fbxCache.get(key);
    const THREE = this.THREE;
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    const loader = new FBXLoader();
    const obj = await new Promise((resolve, reject) => {
      loader.load(key, resolve, undefined, (e) => reject(new Error(`FBX 加载失败: ${key} (${e && e.message ? e.message : e})`)));
    });
    this.fbxCache.set(key, obj);
    this.stats.fbx += 1;
    return obj;
  }

  async loadOBJ(url, mtlUrl) {
    const key = this._url(url);
    if (this.objCache.has(key)) return this.objCache.get(key);
    const THREE = this.THREE;
    const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
      import('three/addons/loaders/OBJLoader.js'),
      import('three/addons/loaders/MTLLoader.js'),
    ]);
    const objLoader = new OBJLoader();
    if (mtlUrl) {
      try {
        const mtlLoader = new MTLLoader();
        const mats = await new Promise((resolve, reject) => {
          mtlLoader.load(this._url(mtlUrl), resolve, undefined, (e) => reject(e));
        });
        mats.preload();
        objLoader.setMaterials(mats);
      } catch (e) {
        // MTL 缺失不是致命错误：OBJ 仍能加载，只是没有颜色
        this.errors.push({ url: mtlUrl, error: `MTL 加载失败（将使用默认灰色）: ${e && e.message ? e.message : e}` });
      }
    }
    // 这里不用 objLoader.load()：需要先清洗文本（见 sanitizeObjText），
    // 否则带孤立线段/点的 OBJ 会被 OBJLoader 整个当成 Line/Points，三角面跟着一起消失。
    let group;
    try {
      const res = await fetch(key);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = sanitizeObjText(await res.text());
      this.stats.bytesText += text.length;
      const path = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
      group = objLoader.parse(text, path);
    } catch (e) {
      throw new Error(`OBJ 加载失败: ${key} (${e && e.message ? e.message : e})`);
    }
    this.objCache.set(key, group);
    this.stats.obj += 1;
    return group;
  }

  /**
   * 把一个 OBJ/MTL 组烘焙成"带顶点色的单一几何"，并按 fit 归一到目标尺寸。
   * @param {THREE.Object3D} group
   * @param {{mode:'height'|'longest'|'raw'|'none', size:number, scale?:number[], base?:'center'|'trunk'}} fit
   *   raw   = 完全不归一（街道模块：原点=拼接单元中心，沥青面 y=0.1）
   *   base  = 'trunk' 时水平居中改用树干底部重心（树木用，见 world/trees.js）
   *   mtlLinear = true 时把 MTLLoader 的 sRGB→线性转换还原（Blender 导出的 Kd 本来是线性）
   * @returns {{geometry: THREE.BufferGeometry, height:number, width:number, depth:number}}
   */
  bakeGeometry(group, fit = { mode: 'height', size: 1 }) {
    const THREE = this.THREE;
    const parts = [];
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const geo = o.geometry;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const groups = (geo.groups && geo.groups.length)
        ? geo.groups
        : [{ start: 0, count: geo.index ? geo.index.count : geo.getAttribute('position').count, materialIndex: 0 }];
      for (const g of groups) {
        const src = extractRange(THREE, geo, g.start, g.count);
        if (!src) continue;
        if (!src.getAttribute('normal')) src.computeVertexNormals();
        if (!src.getAttribute('uv')) {
          src.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(src.getAttribute('position').count * 2), 2));
        }
        // 材质颜色 → 顶点色（按材质分组取色，见 extractRange 的注释）
        const m = mats[g.materialIndex] || mats[0];
        const col = new THREE.Color();
        if (m && m.color) col.copy(m.color); else col.setHex(0x9a9a9a);
        // 颜色空间：three 的 MTLLoader 把 MTL 里的 Kd 当 **sRGB** 转进线性工作空间，
        // 但 Blender(v2.79) 导出的 Kd 本来就是线性值 —— 照搬会让这些模型整体偏暗
        // （实测树叶渲染出来只剩 rgb(31,43,35)，几乎是黑的）。fit.mtlLinear 把这次转换还原，
        // 让顶点色 = 作者写的 Kd（线性反照率）。见 ASSET_CATALOG.md「树林」一节。
        if (fit.mtlLinear) col.convertLinearToSRGB();
        const n = src.getAttribute('position').count;
        const colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i += 1) {
          colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
        }
        src.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        // 只保留合并需要的属性，避免属性集合不一致导致 mergeGeometries 失败
        for (const name of Object.keys(src.attributes)) {
          if (!['position', 'normal', 'uv', 'color'].includes(name)) src.deleteAttribute(name);
        }
        src.applyMatrix4(o.matrixWorld);
        parts.push(src);
      }
    });
    if (!parts.length) return null;
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const p of parts) p.dispose();
    if (!merged) return null;

    // 朝向修正（弧度，可选）：Quaternius 的枪械 OBJ 是「枪口朝 +X、枪身沿 X 轴」，
    // 而武器挂点和第一人称视图模型都假定「枪口朝 +Z」。清单里写 fit.ry = -Math.PI/2 就能掰正。
    // 放在缩放/归零**之前**，所以 fit 的尺寸按旋转后的包围盒算（长边=枪身长度），
    // 烘焙出的几何与程序化占位枪（buildWeaponMesh，枪口 +Z）完全同构，可以互相替换。
    if (fit.rx || fit.ry || fit.rz) {
      if (fit.rz) merged.rotateZ(fit.rz);
      if (fit.ry) merged.rotateY(fit.ry);
      if (fit.rx) merged.rotateX(fit.rx);
    }

    // mode:'raw' = 保留作者坐标，不做"底部归零 / 水平居中"的归一化。
    // 街道模块必须这样：它的原点就是 2×2 的拼接单元中心，沥青面固定在 y=0.1，
    // 一旦被居中归零，相邻模块就对不上了（拼接计划见 world/roads.js）。
    if (fit.mode === 'raw') {
      const s = Array.isArray(fit.scale) ? fit.scale : [1, 1, 1];
      const sx = Number.isFinite(s[0]) ? s[0] : 1;
      const sy = Number.isFinite(s[1]) ? s[1] : 1;
      const sz = Number.isFinite(s[2]) ? s[2] : 1;
      if (sx !== 1 || sy !== 1 || sz !== 1) merged.scale(sx, sy, sz);
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const b = merged.boundingBox;
      const dim = new THREE.Vector3();
      b.getSize(dim);
      return {
        geometry: merged, raw: true,
        height: dim.y, width: dim.x, depth: dim.z,
        minY: b.min.y, maxY: b.max.y,
      };
    }

    merged.computeBoundingBox();
    const box = merged.boundingBox;
    const size = new THREE.Vector3();
    box.getSize(size);
    let scale = 1;
    if (fit.mode === 'height' && size.y > 1e-6) scale = fit.size / size.y;
    else if (fit.mode === 'longest') {
      const longest = Math.max(size.x, size.y, size.z);
      if (longest > 1e-6) scale = fit.size / longest;
    }
    if (scale !== 1) merged.scale(scale, scale, scale);
    // 归位：脚底 y=0，水平居中。
    // 默认按包围盒居中；fit.base === 'trunk' 时按**树干底部重心**居中 ——
    // 树冠偏心/树干倾斜的模型（道具包里 Willow_2 的树干离包围盒中心 3.4m！）
    // 若按包围盒居中，实例绕 Y 旋转时树干会绕着原点画圈，碰撞体也和看得见的树干对不上。
    merged.computeBoundingBox();
    const b2 = merged.boundingBox;
    let cx = (b2.min.x + b2.max.x) / 2;
    let cz = (b2.min.z + b2.max.z) / 2;
    if (fit.base === 'trunk') {
      const p = merged.getAttribute('position');
      const cut = b2.min.y + (b2.max.y - b2.min.y) * 0.06;
      let sx = 0, sz = 0, cnt = 0;
      for (let i = 0; i < p.count; i += 1) {
        if (p.getY(i) > cut) continue;
        sx += p.getX(i); sz += p.getZ(i); cnt += 1;
      }
      if (cnt) { cx = sx / cnt; cz = sz / cnt; }
    }
    merged.translate(-cx, -b2.min.y, -cz);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const out = new THREE.Vector3();
    merged.boundingBox.getSize(out);
    return { geometry: merged, height: out.y, width: out.x, depth: out.z };
  }

  /** 预加载若干道具，返回 key → {geometry,height,...}；失败记入 errors。 */
  async preloadProps(models, onProgress) {
    const out = new Map();
    const keys = Object.keys(models || {});
    const total = keys.length || 1;
    let done = 0;
    let cursor = 0;
    // 有限并发：树木一口气 22 个模型，串行加载会让开局多等好几秒（每个都要走一遍网络 + 烘焙）。
    const CONCURRENCY = 6;
    const worker = async () => {
      while (cursor < keys.length) {
        const key = keys[cursor];
        cursor += 1;
        const def = models[key];
        try {
          const group = await this.loadOBJ(def.url, def.mtl);
          const baked = this.bakeGeometry(group, def.fit);
          if (baked) out.set(key, baked);
          else this.errors.push({ url: def.url, error: '烘焙后没有几何数据' });
        } catch (e) {
          this.errors.push({ url: def.url, error: String(e && e.message ? e.message : e) });
        }
        done += 1;
        if (onProgress) onProgress(done / total, key);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, () => worker()));
    return out;
  }

  /**
   * 预加载建筑模型（道具包 Ultimate Textured Buildings）。
   * 和道具不同，建筑**不烘焙材质色**：它的 MTL 里只有一个灰材质，真实配色是 UV 指向
   * 32×32 的 4×4 纯色调色板（world/buildings.js 的 BUILDING_PALETTES）。
   * 所以这里只保留 position + uv，交给 world/building-mesh.js 按"每面取一格"上色 ——
   * 这样同一份几何能换调色板、能挖门洞、还能和世界其余静态几何合批。
   * 归一化：水平居中 + 地面 y=0（模型单位不动，缩放由 layout 按目标宽度算）。
   */
  bakeBuildingGeometry(group) {
    const THREE = this.THREE;
    const parts = [];
    let missingUV = 0;
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const geo = o.geometry;
      const groups = (geo.groups && geo.groups.length)
        ? geo.groups
        : [{ start: 0, count: geo.index ? geo.index.count : geo.getAttribute('position').count }];
      for (const g of groups) {
        const src = extractRange(THREE, geo, g.start, g.count);
        if (!src) continue;
        if (!src.getAttribute('uv')) { missingUV += 1; src.dispose(); continue; }
        // 只留合并需要的属性：颜色是按 UV 现场算的，法线在挖完门洞后统一重算
        for (const name of Object.keys(src.attributes)) {
          if (name !== 'position' && name !== 'uv') src.deleteAttribute(name);
        }
        src.applyMatrix4(o.matrixWorld);
        parts.push(src);
      }
    });
    if (!parts.length) return null;
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const p of parts) p.dispose();
    if (!merged) return null;

    merged.computeBoundingBox();
    const b = merged.boundingBox;
    // 水平居中（包围盒中心）+ 地面贴 y=0
    merged.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const size = new THREE.Vector3();
    merged.boundingBox.getSize(size);
    return {
      geometry: merged,
      width: size.x, height: size.y, depth: size.z,
      missingUV,
    };
  }

  /** 预加载建筑模型，返回 key → {geometry,width,height,depth}；失败记入 errors。 */
  /**
   * 古建构件（GLB）：库里导出的多材质 GLB，贴图是 ../_textures/*.png 相对路径，
   * GLTFLoader 会按 GLB 的 URL 解析，所以换贴图不用重出 GLB。
   * 返回 Map<key, {scene, key}>；失败的条目记进 errors，由调用方决定是否跳过。
   */
  async preloadHeritage(entries, onProgress) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const out = new Map();
    let done = 0;
    for (const e of entries || []) {
      try {
        const gltf = await loader.loadAsync(this._url(e.glb));
        out.set(e.key, { key: e.key, scene: gltf.scene, label: e.label });
      } catch (err) {
        this.errors.push({ url: e.glb, error: String(err && err.message ? err.message : err) });
      }
      done += 1;
      if (onProgress) onProgress(done, entries.length);
    }
    this.stats.heritage = out.size;
    return out;
  }

  async preloadBuildings(models, onProgress) {
    const out = new Map();
    const keys = Object.keys(models || {});
    const total = keys.length || 1;
    let done = 0;
    let cursor = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
      while (cursor < keys.length) {
        const key = keys[cursor];
        cursor += 1;
        const def = models[key];
        try {
          const group = await this.loadOBJ(def.url);
          const baked = this.bakeBuildingGeometry(group);
          if (baked) {
            out.set(key, baked);
            if (baked.missingUV) {
              this.errors.push({ url: def.url, error: `${baked.missingUV} 个网格缺少 UV（无法取色）` });
            }
          } else {
            this.errors.push({ url: def.url, error: '建筑模型烘焙后没有几何数据' });
          }
        } catch (e) {
          this.errors.push({ url: def.url, error: String(e && e.message ? e.message : e) });
        }
        done += 1;
        if (onProgress) onProgress(done / total, key);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, () => worker()));
    return out;
  }

  get ok() { return this.errors.length === 0; }
  dispose() {
    this.fbxCache.clear();
    this.objCache.clear();
  }
}

export default { AssetLoader };
