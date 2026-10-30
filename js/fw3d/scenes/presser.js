// FW3D · 发布会（模式 presser）
// 坐在桌前，三选一回答；选择写回引擎（媒体声望/球迷支持/教练信任）
import { createPlayerModel } from '../character.js';

export function start({ THREE, host, opts }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);
  scene.fog = new THREE.Fog(0x10141a, 14, 40);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  renderer.shadowMap.enabled = true;
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(68, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.05, 100);
  camera.position.set(0, 1.45, 2.6);

  // 房间
  const W = 12, D = 10, H = 3.4;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.95 });
  const box = (w, h, d, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || wallMat); m.position.set(x, y, z); scene.add(m); return m; };
  box(W, H, 0.3, 0, H / 2, -D / 2);
  box(0.3, H, D, -W / 2, H / 2, 0);
  box(0.3, H, D, W / 2, H / 2, 0);
  scene.add(new THREE.HemisphereLight(0xe8eeff, 0x14171d, 0.7));
  for (let i = 0; i < 3; i++) {
    const l = new THREE.PointLight(0xf6f8ff, 22, 12, 2);
    l.position.set(-3 + i * 3, 2.8, 0); scene.add(l);
  }

  // 发布桌
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x2f3a48, roughness: 0.6, metalness: 0.15 });
  box(4.2, 0.1, 1.2, 0, 0.75, -0.6, deskMat);
  box(0.12, 0.75, 0.12, -1.9, 0.38, -0.6, deskMat);
  box(0.12, 0.75, 0.12, 1.9, 0.38, -0.6, deskMat);
  // 麦克风
  for (const x of [-0.7, 0, 0.7]) {
    const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.34, 8), new THREE.MeshStandardMaterial({ color: 0x1a1d22 }));
    mic.position.set(x, 0.95, -0.5); scene.add(mic);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshStandardMaterial({ color: 0x33383f, metalness: 0.6, roughness: 0.4 }));
    head.position.set(x, 1.14, -0.5); scene.add(head);
  }
  // 背景板
  const board = new THREE.Mesh(new THREE.PlaneGeometry(6, 2.2), new THREE.MeshStandardMaterial({ color: 0x1f3b2e }));
  board.position.set(0, 1.9, -D / 2 + 0.2); scene.add(board);

  // 记者
  const press = [];
  for (let i = 0; i < 5; i++) {
    const m = createPlayerModel(THREE, { playerId: 'PRESS-' + i, detail: 'mid', jersey: 0x39424e, shorts: 0x2a3038, skin: [0xb0805e, 0x8d5f43, 0xd9ae86, 0x6f4a33, 0xc79b76][i], number: null, name: '' });
    const x = -3.2 + i * 1.6;
    m.object.position.set(x, 0, 2.4 + (i % 2) * 0.6);
    m.object.rotation.y = Math.PI;
    scene.add(m.object);
    press.push({ m, phase: i * 0.8 });
  }

  // 题卡与选项
  const panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;left:50%;top:64px;transform:translateX(-50%);width:min(560px,86%);padding:16px 18px;border-radius:14px;background:rgba(8,11,16,.86);border:1px solid rgba(255,255,255,.14);color:#e9eff8;font:14px/1.6 system-ui,sans-serif;z-index:3';
  panel.innerHTML = '<div style="font-size:11px;letter-spacing:.16em;opacity:.7">PRESS CONFERENCE</div>'
    + '<div style="margin:8px 0 14px;font-weight:600">记者：这场比赛之后，你怎么评价自己的表现？</div>'
    + '<div id="press-options" style="display:flex;flex-direction:column;gap:8px"></div>';
  host.appendChild(panel);

  const optsBox = panel.querySelector('#press-options');
  const choices = (window.FW && FW.pressChoices) ? FW.pressChoices() : [{ id: 'humble', label: '把功劳给队友' }, { id: 'confident', label: '我就是最好的' }, { id: 'deflect', label: '只谈下一场' }];
  let answered = false;
  function answer(id, btn) {
    if (answered) return;
    answered = true;
    let res = null;
    try { res = (window.FW && FW.pressConference) ? FW.pressConference(id) : null; } catch (e) {}
    panel.innerHTML = '<div style="font-size:11px;letter-spacing:.16em;opacity:.7">PRESS CONFERENCE</div>'
      + '<div style="margin:10px 0 6px;font-weight:600">' + (res && res.note ? res.note : '发布会结束') + '</div>'
      + '<div style="opacity:.8;font-size:13px">媒体声望 ' + (res ? res.media : '—') + ' · 球迷支持 ' + (res ? res.fan : '—') + '</div>'
      + '<div style="margin-top:12px;opacity:.6;font-size:12px">2 秒后回到文字界面</div>';
    setTimeout(() => { if (window.FW3D && FW3D.close) FW3D.close(); }, 2000);
  }
  choices.forEach((c, i) => {
    const b = document.createElement('button');
    b.textContent = (i + 1) + '. ' + c.label;
    b.style.cssText = 'text-align:left;padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e9eff8;font:14px/1.4 system-ui,sans-serif;cursor:pointer';
    b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,.13)'; };
    b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,.06)'; };
    b.onclick = () => answer(c.id, b);
    optsBox.appendChild(b);
  });

  // 键盘 1/2/3 也能选
  const kd = (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= choices.length) answer(choices[n - 1].id);
  };
  window.addEventListener('keydown', kd);

  let dragging = false, lx = 0, ly = 0;
  const look = { yaw: 0, pitch: 0 };
  renderer.domElement.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    look.yaw = Math.max(-0.5, Math.min(0.5, look.yaw - (e.clientX - lx) * 0.0016));
    look.pitch = Math.max(-0.35, Math.min(0.35, look.pitch - (e.clientY - ly) * 0.0014));
    lx = e.clientX; ly = e.clientY;
  });

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  const tip = document.getElementById('fw3d-tip');
  if (tip) tip.textContent = '发布会：点选项或按 1/2/3 回答 · 拖拽转头 · Esc 退出';

  let elapsed = 0;
  return {
    info: () => '发布会 · ' + choices.length + ' 种回答',
    update(dt) {
      elapsed += dt;
      for (const r of press) r.m.update(dt, 0, elapsed + r.phase);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(look.pitch, look.yaw, 0);
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('resize', resize);
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); } });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    },
  };
}
