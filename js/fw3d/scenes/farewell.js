// FW3D · 告别（模式 farewell）
// 清柜子 → 走出通道 → 站到球场中央 → 生涯总结
export function start({ THREE, host, opts }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d12);
  scene.fog = new THREE.Fog(0x0a0d12, 40, 160);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(72, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.1, 300);
  camera.position.set(0, 1.66, 22);

  const W = 68, L = 105;
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ color: 0x2b7440, roughness: 0.95 }));
  pitch.rotation.x = -Math.PI / 2; pitch.position.z = -L / 2; scene.add(pitch);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xdfe9e2 });
  const line = (w, l, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.01, z); scene.add(m); };
  line(W, 0.12, 0, 0); line(0.12, L, -W / 2, -L / 2); line(0.12, L, W / 2, -L / 2);

  // 通道（通往球场）
  const tw = 5.2, th = 4.2, tz0 = 4, tz1 = 26;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x262c34, roughness: 0.92 });
  const len = tz1 - tz0;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(tw, 0.2, len), new THREE.MeshStandardMaterial({ color: 0x1a1f26 }));
  floor.position.set(0, -0.1, (tz0 + tz1) / 2); scene.add(floor);
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.24, th, len), wallMat);
    wall.position.set(sx * (tw / 2), th / 2, (tz0 + tz1) / 2); scene.add(wall);
  }
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(tw, 0.2, len), new THREE.MeshStandardMaterial({ color: 0x20252c }));
  ceil.position.set(0, th, (tz0 + tz1) / 2); scene.add(ceil);

  scene.add(new THREE.HemisphereLight(0xe6eeff, 0x1a2a1e, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(50, 70, 30); scene.add(sun);
  for (let i = 0; i < 3; i++) {
    const l = new THREE.PointLight(0xfff0cc, 12, 12, 2);
    l.position.set(0, 3.4, tz0 + 3 + i * 6); scene.add(l);
  }

  // 柜子（在通道起点旁）
  const lockerMat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.7, metalness: 0.2 });
  const locker = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.0, 0.5), lockerMat);
  locker.position.set(-1.6, 1.0, tz1 - 2.6); scene.add(locker);

  // HUD
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:50%;bottom:78px;transform:translateX(-50%);max-width:74%;padding:10px 16px;border-radius:10px;background:rgba(6,9,14,.8);border:1px solid rgba(255,255,255,.12);color:#e9eff8;font:13px/1.6 system-ui,sans-serif;text-align:center;z-index:3';
  hud.textContent = '走到柜子旁按 E 清空柜子';
  host.appendChild(hud);

  // 朝向通道纵深与球场（-z 侧）。早期是 Math.PI → 正对 z=26 的通道尽头墙，距墙 1.4 m，整屏全黑。
  // 现在站在通道入口内侧，柜子（z=tz1-2.6）就在左手前方 1.2 m，符合"先清柜再走向球场"的顺序。
  const ctrl = { pos: new THREE.Vector3(-1.2, 0, tz1 - 1.4), yaw: 0, pitch: 0, keys: Object.create(null) };
  let cleared = false, finished = false;

  const kd = (e) => {
    const k = e.key.toLowerCase();
    ctrl.keys[k] = true;
    if (k === 'e') tryClear();
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

  function tryClear() {
    if (cleared) return;
    const d = Math.hypot(ctrl.pos.x - locker.position.x, ctrl.pos.z - locker.position.z);
    if (d > 2.4) { hud.textContent = '再靠近柜子一点'; return; }
    cleared = true;
    hud.textContent = '柜子空了。走到球场中央，和这里告别。';
    try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
  }

  function careerSummary() {
    try {
      const p = window.FW && FW.state && FW.state.player;
      const rec = (p && window.FW.careerRecords) ? FW.careerRecords(p) : null;
      if (!rec) return '生涯结束';
      const t = rec.totals || {};
      return '出场 ' + (t.apps || 0) + ' · 进球 ' + (t.goals || 0) + ' · 助攻 ' + (t.assists || 0) + ' · 荣誉 ' + (t.honoursTotal || 0) + ' 项';
    } catch (e) { return '生涯结束'; }
  }

  function finish() {
    if (finished) return;
    finished = true;
    hud.innerHTML = '<div style="font-size:11px;letter-spacing:.16em;opacity:.7">FAREWELL</div>'
      + '<div style="margin:8px 0 4px;font-weight:600;font-size:15px">你最后一次走过这片草皮</div>'
      + '<div style="opacity:.85">' + careerSummary() + '</div>'
      + '<div style="margin-top:8px;opacity:.55;font-size:12px">3 秒后关闭</div>';
    setTimeout(() => { if (window.FW3D && FW3D.close) FW3D.close(); }, 3000);
  }

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  const tip = document.getElementById('fw3d-tip');
  if (tip) tip.textContent = '告别：W 走向球场 · 柜子旁按 E 清空柜子 · 拖拽转头 · Esc 退出';

  return {
    info: () => '告别 · ' + (cleared ? '已清柜' : '未清柜'),
    update(dt) {
      const k = ctrl.keys;
      const fwd = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
      const right = new THREE.Vector3(Math.cos(ctrl.yaw), 0, -Math.sin(ctrl.yaw));
      const wish = new THREE.Vector3();
      if (k.w || k.arrowup) wish.add(fwd);
      if (k.s || k.arrowdown) wish.sub(fwd);
      if (k.d || k.arrowright) wish.add(right);
      if (k.a || k.arrowleft) wish.sub(right);
      if (wish.lengthSq() > 0) { wish.normalize().multiplyScalar(3.4 * dt); ctrl.pos.add(wish); }
      ctrl.pos.x = Math.max(-tw / 2 + 0.7, Math.min(tw / 2 - 0.7, ctrl.pos.x));
      ctrl.pos.z = Math.max(-18, Math.min(tz1 - 0.6, ctrl.pos.z));

      // 走到球场中央 → 结束
      if (!finished && ctrl.pos.z < -16) finish();
      camera.position.set(ctrl.pos.x, 1.66, ctrl.pos.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(ctrl.pitch, ctrl.yaw, 0);
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('resize', resize);
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); } });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    },
  };
}
