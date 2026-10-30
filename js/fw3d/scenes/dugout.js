// FW3D · 替补席（自由观赛模式用）
//
// 只做几何，不做逻辑：位置/尺寸全部来自 roam.js 的 dugoutLayout()，
// 保证「看到的长凳」和「能坐/能站的碰撞体」是同一份数字（两边各写一套必然对不上）。
//
// 造型沿用场馆现有的语言（见 docs/ART_STYLE_GUIDE.md）：
//   · 深灰金属框架 + 深色顶棚，与球员通道同一族材质色（0x2a3038 / 0x22272e）；
//   · 队色只用在「强调」上：顶棚前沿的细灯带 + 地面出场条带 + 背墙队名板；
//   · 全部是盒子，与看台/通道/广告板同一个颗粒度，不引入新的曲面或贴图素材。
import { DUG } from '../roam.js';

function tex(THREE, title, sub, primary) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#' + new THREE.Color(primary).multiplyScalar(0.55).getHexString();
  g.fillRect(0, 0, 512, 200);
  g.fillStyle = '#' + new THREE.Color(primary).getHexString();
  g.fillRect(0, 0, 18, 200);
  g.fillStyle = '#eef4fb';
  g.font = '700 46px "Microsoft YaHei",system-ui,sans-serif';
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(title, 40, 78);
  g.fillStyle = 'rgba(226,236,248,.78)';
  g.font = '600 30px "Microsoft YaHei",system-ui,sans-serif';
  g.fillText(sub, 40, 138);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  return t;
}

/**
 * @param {object} THREE
 * @param {object} o { layout, primary, secondary, title, sub }
 *   layout 由 roam.dugoutLayout() 产出（world 坐标：x0/x1/z0/z1/front/back/benchX/...）
 * @returns {{group, seats:Array<{x,y,z,yaw}>, seatCount:number}}
 */
export function buildDugout(THREE, o) {
  const L = o.layout;
  const primary = o.primary || '#1f7a3f';
  const group = new THREE.Group();
  const put = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const matFrame = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9, metalness: 0.12 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x22272e, roughness: 0.94 });
  const matBench = new THREE.MeshStandardMaterial({ color: 0x2b3644, roughness: 0.82, metalness: 0.16 });
  const matTeam = new THREE.MeshStandardMaterial({ color: new THREE.Color(primary), roughness: 0.6, metalness: 0.1 });
  const matFloor = new THREE.MeshStandardMaterial({ color: new THREE.Color(primary).multiplyScalar(0.62), roughness: 0.9 });

  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  const depth = L.x1 - L.x0;
  const len = L.z1 - L.z0;
  const inward = L.side < 0 ? 1 : -1;      // 从替补席指向球场的方向
  // 网格朝向 = 角色/平面的 rotation.y。角色模型的正面是 +z，所以 rotation.y = yaw + π（与 arena 的
  // meAgent.facing = ctrl.yaw + π 同一套约定）；座位锚点存的是「控制器 yaw」，由 arena 直接消费。
  const meshYaw = L.yaw + Math.PI;

  // ── 台座（比走道高 0.16 m 的一级台阶，也是 ground() 里的 dugout 高度）
  put(new THREE.BoxGeometry(depth + 0.5, DUG.platform, len + 0.5), matFloor, cx, DUG.platform / 2, cz);
  // 台座前沿的队色条带（与通道出口地面条带同一套语言）
  put(new THREE.BoxGeometry(0.16, 0.03, len + 0.5), matTeam, L.front + inward * 0.25, DUG.platform + 0.005, cz);

  // ── 背墙 + 两侧挡板（与 roam 的碰撞盒一致：0.14 厚）
  put(new THREE.BoxGeometry(0.14, 2.2, len), matFrame, L.back - inward * 0.07, DUG.platform + 1.1, cz);
  for (const z of [L.z0 + 0.07, L.z1 - 0.07]) {
    put(new THREE.BoxGeometry(depth, 2.2, 0.14), matFrame, cx, DUG.platform + 1.1, z);
  }

  // ── 长凳：坐面 + 靠背 + 四腿（坐面高度 0.45，正好是"人坐下来髋部"的高度）
  const seatY = DUG.platform + 0.45;
  put(new THREE.BoxGeometry(DUG.benchDepth, 0.14, len - 0.7), matBench, L.benchX, seatY - 0.07, cz);
  put(new THREE.BoxGeometry(0.1, 0.38, len - 0.7), matBench, L.back + inward * 0.22, seatY + 0.2, cz);
  for (let i = 0; i < 4; i++) {
    const z = cz + (i < 2 ? -1 : 1) * (len / 2 - 0.6);
    put(new THREE.BoxGeometry(0.4, 0.45, 0.08), matFrame, L.benchX, DUG.platform + 0.22, z + (i % 2 ? 0.1 : -0.1));
  }

  // ── 立柱 + 顶棚（2.55 m，比球员高一头；前沿一道队色灯带做身份）
  const postH = DUG.canopy;
  for (const z of [L.z0 + 0.18, L.z1 - 0.18]) {
    put(new THREE.BoxGeometry(0.09, postH, 0.09), matFrame, L.front + inward * 0.2, DUG.platform + postH / 2, z);
  }
  put(new THREE.BoxGeometry(depth + 0.6, 0.12, len + 0.6), matDark, cx - inward * 0.05, DUG.platform + postH, cz);
  put(new THREE.BoxGeometry(0.2, 0.2, len + 0.6), matTeam, L.front + inward * 0.22, DUG.platform + postH - 0.16, cz);

  // ── 背墙队名板（朝球场一面）
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 0.8),
    new THREE.MeshBasicMaterial({ map: tex(THREE, o.title || '替补席', o.sub || 'DUGOUT', primary) })
  );
  plate.position.set(L.back + inward * 0.16, DUG.platform + 1.62, cz);
  plate.rotation.y = meshYaw;
  group.add(plate);

  // ── 座位锚点：沿长凳等距铺开（第 0 个留给玩家，其余给替补）
  const seats = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const z = cz + (i - (n - 1) / 2) * ((len - 1.8) / (n - 1));
    seats.push({ x: L.seatX, y: DUG.platform, z, yaw: L.yaw, sit: true });
  }
  return { group, seats, seatCount: seats.length, benchTop: seatY };
}
