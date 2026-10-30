// FW3D · 更衣室（模式 dressing）
// 一个房间：储物柜、长凳、队友 NPC。走近队友按 E 说话。
import { createPlayerModel } from '../character.js';

export function start({ THREE, host, opts }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171d);
  scene.fog = new THREE.Fog(0x14171d, 16, 40);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  renderer.shadowMap.enabled = true;
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(70, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.05, 120);
  camera.position.set(0, 1.66, 3.4);

  // 房间 12 × 9 × 3.2
  const W = 12, D = 9, H = 3.2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.95 });
  const box = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || wallMat);
    m.position.set(x, y, z); m.receiveShadow = true; scene.add(m); return m;
  };
  box(W, H, 0.3, 0, H / 2, -D / 2);
  box(W, H, 0.3, 0, H / 2, D / 2);
  box(0.3, H, D, -W / 2, H / 2, 0);
  box(0.3, H, D, W / 2, H / 2, 0);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x1a1e25 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = H; scene.add(ceil);

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x14171d, 0.85));
  for (let i = 0; i < 3; i++) {
    const l = new THREE.PointLight(0xf2f6ff, 26, 12, 2);
    l.position.set(-3.6 + i * 3.6, 2.7, 0); scene.add(l);
  }

  // 储物柜（一排柜门）
  const lockerMat = new THREE.MeshStandardMaterial({ color: 0x38424f, roughness: 0.7, metalness: 0.25 });
  for (let i = 0; i < 6; i++) {
    const x = -4.5 + i * 1.8;
    box(1.5, 2.0, 0.5, x, 1.0, -D / 2 + 0.45, lockerMat);
    box(0.06, 0.3, 0.04, x + 0.55, 1.05, -D / 2 + 0.72, new THREE.MeshStandardMaterial({ color: 0xb9c3d0, metalness: 0.6, roughness: 0.3 }));
  }
  // 长凳
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.85 });
  box(9, 0.12, 0.7, 0, 0.5, -D / 2 + 1.6, benchMat);
  for (const x of [-4, 0, 4]) box(0.14, 0.5, 0.6, x, 0.25, -D / 2 + 1.6, benchMat);

  // 队友
  let squad = [];
  try {
    const p = window.FW && FW.state && FW.state.player;
    const club = p && p.clubId ? FW.state.clubs[p.clubId] : null;
    if (club) {
      squad = (club.playerIds || []).map((id) => FW.state.players[id]).filter((x) => x && x.id !== 'PUSER').slice(0, 5);
    }
  } catch (e) { squad = []; }

  const mates = [];
  squad.forEach((pl, i) => {
    const model = createPlayerModel(THREE, {
      player: pl || null,
      playerId: (pl && pl.id) || ('DRESS-' + i),
      jersey: 0x2f5e42, shorts: 0xe9e9e0, skin: [0xb0805e, 0x8d5f43, 0xd9ae86][i % 3],
      number: Number(pl.number) || i + 2, name: String(pl.name || ''),
    });
    const x = -3.2 + i * 1.6;
    model.object.position.set(x, 0, -D / 2 + 2.3);
    model.object.rotation.y = Math.PI;
    scene.add(model.object);
    mates.push({ model, pl, phase: i * 1.3, baseZ: model.object.position.z });
  });

  // 交互提示
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:50%;bottom:80px;transform:translateX(-50%);max-width:70%;padding:9px 16px;border-radius:10px;background:rgba(6,9,14,.78);border:1px solid rgba(255,255,255,.12);color:#e8eef8;font:13px/1.5 system-ui,sans-serif;text-align:center;display:none;z-index:3';
  host.appendChild(hud);

  // 朝向指向储物柜与队友（-z 侧）。早期是 Math.PI（正对 +z 墙，距墙 1.1 m）→ 进更衣室只看到一面灰墙。
  const ctrl = { pos: new THREE.Vector3(0, 0, 3.4), yaw: 0, pitch: 0, keys: Object.create(null) };
  const kd = (e) => {
    const k = e.key.toLowerCase();
    ctrl.keys[k] = true;
    if (k === 'e') talk();
  };
  const ku = (e) => { ctrl.keys[e.key.toLowerCase()] = false; };
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  let dragging = false, lx = 0, ly = 0;
  renderer.domElement.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    ctrl.yaw -= (e.clientX - lx) * 0.0026;
    ctrl.pitch = Math.max(-0.7, Math.min(0.7, ctrl.pitch - (e.clientY - ly) * 0.0022));
    lx = e.clientX; ly = e.clientY;
  });

  let near = null;
  const LINES = [
    '今天状态不错，别急，先控住球。',
    '对面右后卫转身慢，你多往那边跑。',
    '别管外面怎么说，我们信你。',
    '教练今天话不多，看他的脸就知道想赢。',
    '上一次那球我该传的，这次看我的。',
  ];
  function talk() {
    if (!near) return;
    const i = mates.indexOf(near);
    hud.style.display = 'block';
    hud.textContent = (near.pl.name || '队友') + '：' + LINES[i % LINES.length];
    clearTimeout(talk._t);
    talk._t = setTimeout(() => { hud.style.display = 'none'; }, 3200);
  }

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  const tip = document.getElementById('fw3d-tip');
  if (tip) tip.textContent = '更衣室：WASD 走动 · 走近队友按 E 说话 · 拖拽转头 · Esc 退出';

  let elapsed = 0;
  return {
    info: () => '更衣室 · ' + mates.length + ' 名队友',
    update(dt) {
      elapsed += dt;
      const k = ctrl.keys;
      const fwd = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
      const right = new THREE.Vector3(Math.cos(ctrl.yaw), 0, -Math.sin(ctrl.yaw));
      const wish = new THREE.Vector3();
      if (k.w || k.arrowup) wish.add(fwd);
      if (k.s || k.arrowdown) wish.sub(fwd);
      if (k.d || k.arrowright) wish.add(right);
      if (k.a || k.arrowleft) wish.sub(right);
      if (wish.lengthSq() > 0) { wish.normalize().multiplyScalar(3.1 * dt); ctrl.pos.add(wish); }
      ctrl.pos.x = Math.max(-W / 2 + 1, Math.min(W / 2 - 1, ctrl.pos.x));
      ctrl.pos.z = Math.max(-D / 2 + 1.6, Math.min(D / 2 - 1, ctrl.pos.z));

      // 最近的队友
      near = null;
      let best = 1.7;
      for (const m of mates) {
        const d = Math.hypot(m.model.object.position.x - ctrl.pos.x, m.model.object.position.z - ctrl.pos.z);
        if (d < best) { best = d; near = m; }
        m.model.update(dt, 0, elapsed + m.phase);
      }
      if (near && hud.style.display === 'none') {
        hud.style.display = 'block';
        hud.textContent = near.pl.name + ' · 按 E 说话';
        talk._prompt = true;
      } else if (!near && hud.style.display !== 'none' && !talk._t) {
        hud.style.display = 'none';
      }

      camera.position.set(ctrl.pos.x, 1.66, ctrl.pos.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(ctrl.pitch, ctrl.yaw, 0);
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('resize', resize);
      clearTimeout(talk._t);
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); } });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    },
  };
}
