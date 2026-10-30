// 建筑网格：把道具包的房子摆进世界并挖出门洞。
//
// 和 world/trees.js + world/roads.js 一样，这里只做"几何"这一层，摆放数据来自 layout：
//   layout.buildings[i].model  → 模型键 / 缩放 / 朝向 / 门的位置（纯数据，可单测）
//   build.js                   → 调这里的函数拿到世界坐标几何，塞进静态合批
//
// 三个要点：
//   1) 颜色来自调色板顶点色（不是贴图）：每个三角面的 UV 落在 4×4 调色板同一格里，
//      所以按面取色和原贴图逐像素一致（实测 26 个模型跨格面为 0），这样建筑能和世界其余
//      静态几何一起合批成 1 个 draw call。
//   2) 门洞用 world/doorcut.js 精确切出来：房子是封闭外壳，门只是画上去的，必须开洞才能进。
//   3) 房子没有内表面。所以在 build.js 里把同一份几何用 BackSide 再画一遍当"室内墙面"，
//      几何复用、只多 1 次 draw call，室内看到的就是这栋楼自己的墙（窗户也天然是通的）。

import { doorBox, cutBox } from './doorcut.js';
import { BUILDING_MODELS, buildingPalette, buildingRotation, paletteCellIndex } from './buildings.js';

/**
 * 生成一栋楼的世界坐标几何（带调色板顶点色 + 已挖好门洞）。
 * @param {*} THREE
 * @param {{geometry}} entry  AssetLoader 烘焙好的模型几何（模型单位、居中、地面 y=0、带 uv）
 * @param {object} b          layout.buildings[i]（用 model / modelScale / modelRotY / palette / rect / doors[0]）
 * @returns {{geometry, triangles, cut, palette}}
 */
export function buildingGeometry(THREE, entry, b) {
  const m = b.model && BUILDING_MODELS[b.model];
  if (!entry || !entry.geometry || !m) return null;
  const s = b.modelScale || 1;
  const ys = b.modelYScale || m.ys || 1;
  const rotY = Number.isFinite(b.modelRotY) ? b.modelRotY : buildingRotation(b.doors[0].side);
  const cx = (b.rect.x0 + b.rect.x1) / 2;
  const cz = (b.rect.z0 + b.rect.z1) / 2;

  const src = entry.geometry.index ? entry.geometry.toNonIndexed() : entry.geometry.clone();
  const pos = src.getAttribute('position');
  const uv = src.getAttribute('uv');
  const triCount = Math.floor(pos.count / 3);

  // 调色板 → 线性色（three 的颜色管理：顶点色按线性工作空间解释）
  const paletteHex = buildingPalette(b.palette);
  const paletteLin = paletteHex.map((hex) => {
    const c = new THREE.Color();
    c.setStyle(hex, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
  });

  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  const positions = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t += 1) {
    const o = t * 9;
    // 一个三角面取一个调色板格子：用三个角的 UV 均值（同格，实测无跨格面）
    let uSum = 0;
    let vSum = 0;
    for (let k = 0; k < 3; k += 1) {
      const vi = t * 3 + k;
      uSum += uv.getX(vi);
      vSum += uv.getY(vi);
    }
    const cell = paletteCellIndex(uSum / 3, vSum / 3);
    const col = paletteLin[cell];
    for (let k = 0; k < 3; k += 1) {
      const vi = t * 3 + k;
      const x = pos.getX(vi) * s;
      const y = pos.getY(vi) * s * ys;
      const z = pos.getZ(vi) * s;
      const j = o + k * 3;
      positions[j] = cx + x * cos + z * sin;
      positions[j + 1] = y;
      positions[j + 2] = cz - x * sin + z * cos;
      colors[j] = col[0]; colors[j + 1] = col[1]; colors[j + 2] = col[2];
    }
  }
  if (src !== entry.geometry) src.dispose();

  // 门洞：和 layout 用的是同一个 doors[0] 与 buildingSpec，所以必然对齐
  const door = b.doors && b.doors[0];
  let positionsOut = positions;
  let colorsOut = colors;
  let cutStats = null;
  if (door) {
    const box = doorBox(b.rect, door, 1.8);
    const cut = cutBox(positions, colors, box);
    positionsOut = cut.positions;
    colorsOut = cut.colors;
    cutStats = { box, removed: cut.removed, triangles: cut.outputTriangles };
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positionsOut, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colorsOut, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return {
    geometry: geo,
    triangles: positionsOut.length / 9,
    cut: cutStats,
    palette: b.palette,
  };
}

/** 门板（可开合）的尺寸：按门洞尺寸做，别再用"整面墙高"当门板。 */
export function doorPanelSpec(door) {
  const width = Math.max(0.6, door.width * 0.94);
  const height = Math.max(1.2, door.height - 0.08);
  return { width, height };
}

/**
 * 给**没有细节的三面墙**贴模块化窗户（道具包 Base Modular Parts/Window）。
 *
 * 为什么需要：道具包的成品楼只有正面（+Z）画了窗和门，侧面/背面是素砖墙 —— 它本来是"沿街拼接"的街屋。
 * 摆进开放世界后从街角看会是一堵大素墙，所以用同一个包里的 Window 构件补窗，让四面都像有人住。
 *
 * 摆放规则（全部相对建筑尺寸算，不写死）：
 *   · 只在**非门**的三面墙上贴；
 *   · 每层一排：一层窗台 1.75m，二层（层高够时）4.35m；
 *   · 沿墙按 (i+1)/(n+1) 均分，两端留 1.1m 不贴到墙角；
 *   · 窗面比墙面外凸 0.04m，避免和墙共面 z-fighting。
 * @returns {{geometry: THREE.BufferGeometry|null, count:number}}
 */
export function sideWindows(THREE, partEntry, b, spec) {
  if (!partEntry || !partEntry.geometry) return { geometry: null, count: 0 };
  const m = b.model ? BUILDING_MODELS[b.model] : null;
  if (!m) return { geometry: null, count: 0 };
  const s = spec.scale;
  const ys = spec.yScale;
  const paletteHex = buildingPalette(b.palette);
  const paletteLin = paletteHex.map((hex) => {
    const c = new THREE.Color();
    c.setStyle(hex, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
  });
  const src = partEntry.geometry.index ? partEntry.geometry.toNonIndexed() : partEntry.geometry.clone();
  const pos = src.getAttribute('position');
  const uv = src.getAttribute('uv');
  const triCount = Math.floor(pos.count / 3);
  if (!triCount) return { geometry: null, count: 0 };

  // 窗的原始尺寸（模型单位）→ 世界尺寸；窗本身按建筑缩放
  const pw = partEntry.width * s;
  const ph = partEntry.height * s * ys;

  const rect = b.rect;
  const w = rect.x1 - rect.x0;
  const d = rect.z1 - rect.z0;
  const doorSide = b.doors[0].side;
  const sides = [
    { side: 'south', len: w, rot: 0, place: (t, out) => ({ x: rect.x0 + t, z: rect.z1 + out }), ydepth: d },
    { side: 'north', len: w, rot: Math.PI, place: (t, out) => ({ x: rect.x1 - t, z: rect.z0 - out }), ydepth: d },
    { side: 'east', len: d, rot: Math.PI / 2, place: (t, out) => ({ x: rect.x1 + out, z: rect.z1 - t }), ydepth: w },
    { side: 'west', len: d, rot: -Math.PI / 2, place: (t, out) => ({ x: rect.x0 - out, z: rect.z0 + t }), ydepth: w },
  ];

  const out = [];
  const colors = [];
  const levels = [];
  const h = spec.height;
  if (h >= 2.6) levels.push(1.75);
  if (h >= 5.6) levels.push(4.35);
  if (h >= 8.2) levels.push(6.85);

  for (const face of sides) {
    if (face.side === doorSide) continue;         // 门那一面本来就有窗
    if (face.len < 2.6) continue;
    const margin = Math.min(1.1, face.len * 0.2);
    const usable = face.len - margin * 2;
    const n = Math.max(1, Math.min(3, Math.floor(usable / 2.2)));
    for (const y of levels) {
      if (y + ph / 2 > h - 0.5) continue;
      for (let i = 0; i < n; i += 1) {
        const t = margin + ((i + 0.5) / n) * usable;
        const at = face.place(t, 0.04);
        const cos = Math.cos(face.rot);
        const sin = Math.sin(face.rot);
        for (let tr = 0; tr < triCount; tr += 1) {
          const o = tr * 9;
          let uSum = 0;
          let vSum = 0;
          for (let k = 0; k < 3; k += 1) {
            uSum += uv.getX(tr * 3 + k);
            vSum += uv.getY(tr * 3 + k);
          }
          const col = paletteLin[paletteCellIndex(uSum / 3, vSum / 3)];
          for (let k = 0; k < 3; k += 1) {
            const vi = tr * 3 + k;
            const x = pos.getX(vi) * s;
            const wy = pos.getY(vi) * s * ys + y;
            const z = pos.getZ(vi) * s;
            out.push(at.x + x * cos + z * sin, wy, at.z - x * sin + z * cos);
            colors.push(col[0], col[1], col[2]);
          }
        }
      }
    }
  }
  if (src !== partEntry.geometry) src.dispose();
  if (!out.length) return { geometry: null, count: 0 };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  const count = out.length / 9 / triCount;
  return { geometry: geo, count, windowWidth: pw, windowHeight: ph };
}

export default { buildingGeometry, buildingRotation, doorPanelSpec, sideWindows };
