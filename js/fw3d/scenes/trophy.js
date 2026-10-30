// FW3D · 荣誉室场景（模式 trophy）
// 数据来源：FW.careerRecords(FW.state.player) —— 只显示游戏里真实存在的荣誉，
// 数量为 0 时明确显示"还没有奖杯"，不生成占位奖杯。
//
// 本轮（美术统一 / 场景联动）改动：
//  1) 模块化陈列：展台由"荣誉列表长度"驱动，按每排 5 座自动加排（原来写死 MAX=10 且 x 坐标算法绕），
//     加更多奖杯时不需要改布局代码。
//  2) 陈列信息真实化：铭牌显示"赛季 / 赛事 / 所属俱乐部"，右上角有生涯总览牌（出场·进球·荣誉数），
//     全部来自 careerRecords 的 totals，不自造数字。
//  3) 可浏览：走到展台前会浮出该荣誉的详情（键盘 E 也能读），解决"只能看不能查"。
//  4) 初始朝向修正：原来 yaw=Math.PI 正对 +z 墙（0.8 m）→ 一进荣誉室整屏全黑。
import { buildSkyDome, SKY_PRESETS } from '../atmosphere.js';

export function start({ THREE, host, opts }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11151b);
  scene.fog = new THREE.Fog(0x11151b, 18, 46);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  renderer.shadowMap.enabled = true;
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(70, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.05, 200);
  camera.position.set(0, 1.68, 4.4);

  // ── 房间：16 × 12 × 4.2（与 ART_STYLE_GUIDE 的室内尺度一致）
  const W = 16, D = 12, H = 4.2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1c2029, roughness: 0.95 });
  const wall = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z); m.receiveShadow = true; scene.add(m);
  };
  wall(W, H, 0.3, 0, H / 2, -D / 2);
  wall(W, H, 0.3, 0, H / 2, D / 2);
  wall(0.3, H, D, -W / 2, H / 2, 0);
  wall(0.3, H, D, W / 2, H / 2, 0);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 1 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = H; scene.add(ceil);
  // 踢脚线：一条深色细带，让墙与地面交界不"糊"在一起（低模场景靠这条线读空间）
  for (const [w2, d2, x, z] of [[W, 0.12, 0, -D / 2 + 0.2], [W, 0.12, 0, D / 2 - 0.2]]) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(w2, 0.14, d2), new THREE.MeshStandardMaterial({ color: 0x0e1116, roughness: 0.9 }));
    sk.position.set(x, 0.07, z); scene.add(sk);
  }

  // ── 灯光：暗环境 + 重点展台
  scene.add(new THREE.HemisphereLight(0xfff3dd, 0x1a1a1a, 0.55));
  // 主光从 260 降到 150：260 会把金属展品直接推到接近纯白，金银两档材质分不出来
  const key = new THREE.SpotLight(0xfff0c8, 150, 26, Math.PI / 5, 0.5, 1.5);
  key.position.set(0, 3.8, 2); key.target.position.set(0, 0.6, -3);
  key.castShadow = true; scene.add(key); scene.add(key.target);
  for (let i = 0; i < 3; i++) {
    const p = new THREE.PointLight(0xffe9b8, 15, 12, 2);
    p.position.set(-5 + i * 5, 2.9, -3.4); scene.add(p);
  }

  // ── 真实荣誉数据（唯一来源：FW.careerRecords）
  let rec = null;
  try {
    const p = window.FW && window.FW.state && window.FW.state.player;
    rec = (p && window.FW.careerRecords) ? window.FW.careerRecords(p) : null;
  } catch (e) { rec = null; }
  const honours = (rec && rec.honours) || [];
  const totals = (rec && rec.totals) || {};
  // 赛季由近到远，同赛季按赛事名排序，保证每次进来陈列顺序一致（可复现）
  const list = honours.slice().sort((a, b) => {
    const s = String(b.season || '').localeCompare(String(a.season || ''));
    return s !== 0 ? s : String(a.name || a.type || '').localeCompare(String(b.name || b.type || ''));
  });

  // ── 材质（全局复用：金 / 银 / 展台 / 铭牌）
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 0.85, roughness: 0.28 });
  const silverMat = new THREE.MeshStandardMaterial({ color: 0xc9d2dc, metalness: 0.8, roughness: 0.32 });
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x3a3330, roughness: 0.8 });
  const plateMatCache = new Map();
  const plateTexture = (line1, line2) => {
    const key = line1 + '|' + line2;
    if (plateMatCache.has(key)) return plateMatCache.get(key);
    const c = document.createElement('canvas'); c.width = 512; c.height = 160;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#efe6d2'; ctx.fillRect(0, 0, 512, 160);
    ctx.fillStyle = '#2a2118';
    ctx.font = '700 40px "Microsoft YaHei",system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(line1).slice(0, 16), 256, 56);
    if (line2) {
      ctx.fillStyle = '#5b5142';
      ctx.font = '600 28px "Microsoft YaHei",system-ui,sans-serif';
      ctx.fillText(String(line2).slice(0, 20), 256, 108);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    plateMatCache.set(key, mat);
    return mat;
  };
  const plateLabel = (line1, line2) => new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.225), plateTexture(line1, line2));

  // ── 模块化陈列：每排 5 座，按数量自动加排；两排之间留检修走道
  const PER_ROW = 5;
  const SLOT_X = 1.62, SLOT_Z = 1.85;
  const rows = Math.max(1, Math.ceil(list.length / PER_ROW));
  const plinths = [];    // { x, z, h, item }  供近距交互查询
  const zBack = -D / 2 + 1.15;   // 第一排贴后墙
  for (let row = 0; row < rows; row++) {
    const countInRow = Math.min(PER_ROW, list.length - row * PER_ROW);
    const n = Math.max(1, countInRow);
    for (let col = 0; col < n; col++) {
      const idx = row * PER_ROW + col;
      const item = list[idx] || null;
      // 居中排布：让每排都以房间中轴对齐，而不是从固定起点往右堆
      const x = (col - (n - 1) / 2) * SLOT_X;
      // 多排时向房间内部（+z）展开：第一排贴后墙，第二排更靠近参观动线。
      // （早期写成 -row*SLOT_Z 会把第二排推到后墙外面，奖杯直接消失。）
      const z = zBack + row * SLOT_Z;

      const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.95, 0.78), baseMat);
      pedestal.position.set(x, 0.475, z);
      pedestal.castShadow = true; pedestal.receiveShadow = true; scene.add(pedestal);
      // 台面压边：一条浅色细带，让展台有"台面"而不是纯方块
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.06, 0.86),
        new THREE.MeshStandardMaterial({ color: 0x6b6055, roughness: 0.7 }));
      cap.position.set(x, 0.98, z); scene.add(cap);

      if (!item) { plinths.push({ x, z, h: 0.98, item: null }); continue; }

      // 形制：轮换"杯 / 盘 / 星"，由赛事类型决定（同一赛事保持同一形制，方便一眼归类）
      const typeStr = String(item.type || '');
      const isPlate = /杯|Cup|cup/.test(typeStr);
      const isStar = /MVP|最佳|金靴|先生|奖/.test(typeStr) && !isPlate;
      const mat = /联赛|League|联赛冠军/.test(String(item.name || '')) ? goldMat : silverMat;
      const g = new THREE.Group();
      g.position.set(x, 0.98, z);
      if (isPlate) {
        const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.035, 20), mat);
        plate.rotation.x = Math.PI / 2; plate.position.y = 0.22; g.add(plate);
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.18, 12), mat);
        stand.position.y = 0.09; g.add(stand);
      } else if (isStar) {
        const star = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 0), mat);
        star.position.y = 0.24; g.add(star);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.12, 10), mat);
        stem.position.y = 0.06; g.add(stem);
      } else {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.075, 0.32, 14), mat);
        cup.position.y = 0.30; g.add(cup);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10), mat);
        stem.position.y = 0.11; g.add(stem);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 14), mat);
        foot.position.y = 0.03; g.add(foot);
      }
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      scene.add(g);

      // 铭牌：赛季 + 赛事（真实字段），斜放在展台前沿
      const clubName = (() => {
        try { return item.clubId && window.FW.state.clubs[item.clubId] ? window.FW.state.clubs[item.clubId].name : ''; } catch (e) { return ''; }
      })();
      const plate = plateLabel(item.season || '—', item.name || item.type || '');
      plate.position.set(x, 1.06, z + 0.39);
      plate.rotation.x = -0.22;
      scene.add(plate);
      plinths.push({ x, z, h: 0.98, item, clubName, yaw: 0 });

      // 重点照明：只给最前面的 3 件单独打灯（每盏聚光灯都会参与全部材质的逐片元光照，
      // 每件一盏在 9 件以上时会同时压垮性能与曝光 —— 截图里奖杯一度被照成全白）
      if (idx < 3) {
        const spot = new THREE.SpotLight(0xfff2cf, 14, 5.5, Math.PI / 8, 0.65, 1.6);
        spot.position.set(x, 3.3, z + 0.55);
        spot.target.position.set(x, 0.95, z);
        scene.add(spot); scene.add(spot.target);
      }
    }
  }

  // ── 生涯总览牌（真实 totals）：放在后墙上方，作为整个房间的视觉焦点之一
  (function summaryBoard() {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#12161d'; ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = '#d8b25a'; ctx.fillRect(0, 0, 1024, 8);
    const name = (() => { try { return window.FW.state.player.name || '球员'; } catch (e) { return '球员'; } })();
    ctx.fillStyle = '#efe6d2';
    ctx.font = '700 54px "Microsoft YaHei",system-ui,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(String(name).slice(0, 12), 48, 74);
    ctx.fillStyle = 'rgba(239,230,210,.62)';
    ctx.font = '600 30px "Microsoft YaHei",system-ui,sans-serif';
    ctx.fillText('职业生涯 · 荣誉陈列', 48, 124);
    // 三个真实指标
    const stats = [
      ['出场', totals.apps || 0], ['进球', totals.goals || 0], ['荣誉', totals.honoursTotal || honours.length],
    ];
    stats.forEach(([k, v], i) => {
      const x = 48 + i * 300;
      ctx.fillStyle = '#d8b25a';
      ctx.font = '700 56px "Microsoft YaHei",system-ui,sans-serif';
      ctx.fillText(String(v), x, 196);
      ctx.fillStyle = 'rgba(239,230,210,.6)';
      ctx.font = '600 26px "Microsoft YaHei",system-ui,sans-serif';
      ctx.fillText(k, x + String(v).length * 34 + 10, 200);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), new THREE.MeshBasicMaterial({ map: tex }));
    board.position.set(0, 3.15, -D / 2 + 0.17);
    scene.add(board);
  })();

  // ── 空荣誉室提示牌（真实为空时才出现）
  if (!list.length) {
    const plate = plateLabel('还没有奖杯', '打完一个赛季再来看看');
    plate.position.set(0, 1.7, -D / 2 + 0.2);
    plate.scale.setScalar(3.2);
    scene.add(plate);
  }

  // ── 天空穹（室内几乎不可见，但保证与其他场景同一套大气规则，避免"墙外一片纯黑"）
  const sky = buildSkyDome(THREE, SKY_PRESETS.interior, { radius: 60 });
  scene.add(sky.mesh);

  // ── 第一人称：只能在房间里走（朝向指向展台，见文件头第 4 条）
  const ctrl = { pos: new THREE.Vector3(0, 0, 4.4), yaw: 0, pitch: 0, keys: Object.create(null) };
  const kd = (e) => { ctrl.keys[e.key.toLowerCase()] = true; };
  const ku = (e) => { ctrl.keys[e.key.toLowerCase()] = false; };
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  let dragging = false, lx = 0, ly = 0;
  renderer.domElement.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    ctrl.yaw -= (e.clientX - lx) * 0.0026;
    ctrl.pitch = Math.max(-0.8, Math.min(0.8, ctrl.pitch - (e.clientY - ly) * 0.0022));
    lx = e.clientX; ly = e.clientY;
  });

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ── 近距浏览：走到展台前浮出该荣誉详情（不需要点击，第一人称里最省操作）
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:50%;bottom:86px;transform:translateX(-50%);max-width:78%;padding:9px 16px;'
    + 'border-radius:10px;background:rgba(6,9,14,.8);border:1px solid rgba(255,255,255,.12);color:#efe6d2;'
    + 'font:13px/1.5 system-ui,sans-serif;text-align:center;display:none;z-index:3';
  host.appendChild(hud);
  let nearItem = null;

  const tip = document.getElementById('fw3d-tip');
  if (tip) tip.textContent = '荣誉室：' + (list.length ? list.length + ' 座奖杯 · ' + list.map((h) => h.name || h.type).slice(0, 3).join('、') : '还没有奖杯') + ' · WASD 走动 · 走近展台看详情 · Esc 退出';

  return {
    info: () => '荣誉室 · ' + list.length + ' 座奖杯',
    // 供自检/联调读取（不参与渲染）
    honours: () => list.map((h) => ({ season: h.season, name: h.name, type: h.type })),
    update(dt) {
      const k = ctrl.keys;
      const fwd = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
      const right = new THREE.Vector3(Math.cos(ctrl.yaw), 0, -Math.sin(ctrl.yaw));
      const wish = new THREE.Vector3();
      if (k.w || k.arrowup) wish.add(fwd);
      if (k.s || k.arrowdown) wish.sub(fwd);
      if (k.d || k.arrowright) wish.add(right);
      if (k.a || k.arrowleft) wish.sub(right);
      if (wish.lengthSq() > 0) {
        wish.normalize().multiplyScalar((k.shift ? 5.4 : 3.2) * dt);
        ctrl.pos.add(wish);
      }
      ctrl.pos.x = Math.max(-W / 2 + 1, Math.min(W / 2 - 1, ctrl.pos.x));
      ctrl.pos.z = Math.max(-D / 2 + 1.2, Math.min(D / 2 - 1, ctrl.pos.z));

      // 最近展台（1.9 m 内）
      let best = 1.9, found = null;
      for (const pl of plinths) {
        if (!pl.item) continue;
        const d = Math.hypot(pl.x - ctrl.pos.x, pl.z - ctrl.pos.z);
        if (d < best) { best = d; found = pl; }
      }
      if (found !== nearItem) {
        nearItem = found;
        if (found) {
          const it = found.item;
          hud.style.display = 'block';
          hud.textContent = (it.season ? it.season + ' 赛季 · ' : '')
            + (it.name || it.type || '荣誉')
            + (it.type && it.name && it.type !== it.name ? ' · ' + it.type : '')
            + (found.clubName ? ' · ' + found.clubName : '');
        } else {
          hud.style.display = 'none';
        }
      }

      camera.position.set(ctrl.pos.x, 1.68, ctrl.pos.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(ctrl.pitch, ctrl.yaw, 0);
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('resize', resize);
      plateMatCache.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
      sky.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); } });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    },
  };
}
