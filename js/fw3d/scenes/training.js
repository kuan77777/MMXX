// FW3D · 训练场（模式 training）
// 空场练射门：走近球按空格射向球门，命中计分，30 秒挑战
import { createPlayerModel } from '../character.js';
import { buildSkyDome, SKY_PRESETS } from '../atmosphere.js';

export function start({ THREE, host, opts }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1219);
  scene.fog = new THREE.Fog(0x0d1219, 60, 200);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(74, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.1, 300);
  camera.position.set(0, 1.68, 18);

  // 半场训练区 68 × 50
  const W = 68, L = 50;
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ color: 0x337f45, roughness: 0.95 }));
  grass.rotation.x = -Math.PI / 2; grass.position.z = -L / 2 + 6; grass.receiveShadow = true; scene.add(grass);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xdfe9e2 });
  const line = (w, l, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.01, z); scene.add(m); };
  line(W, 0.12, 0, 6); line(0.12, L, -W / 2, -L / 2 + 6); line(0.12, L, W / 2, -L / 2 + 6);
  line(W, 0.12, 0, -L + 6);

  // 球门（训练用小门 5 × 2）
  const postMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f8, roughness: 0.4 });
  const gw = 2.5, gh = 2.0;
  const goal = new THREE.Group();
  for (const x of [-gw, gw]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, gh, 8), postMat);
    p.position.set(x, gh / 2, 0); goal.add(p);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, gw * 2, 8), postMat);
  bar.rotation.z = Math.PI / 2; bar.position.y = gh; goal.add(bar);
  const net = new THREE.Mesh(new THREE.PlaneGeometry(gw * 2, gh), new THREE.MeshBasicMaterial({ color: 0xcfd8e2, transparent: true, opacity: 0.16, side: THREE.DoubleSide }));
  net.position.set(0, gh / 2, -0.35); goal.add(net);
  goal.position.set(0, 0, -34); scene.add(goal);

  // 标志桶
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xe8642a, roughness: 0.7 });
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 8), coneMat);
    c.position.set(-12 + (i % 4) * 8, 0.21, -8 - Math.floor(i / 4) * 6); scene.add(c);
  }

  scene.add(new THREE.HemisphereLight(0xe6eeff, 0x1e2a20, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9); sun.position.set(40, 70, 30); scene.add(sun);
  // 天空穹：与其他球场同一套大气规则（训练场用更淡的日间预设），避免"亮光照在黑天上"
  const sky = buildSkyDome(THREE, SKY_PRESETS.training, { radius: 260 });
  scene.add(sky.mesh);
  scene.background = new THREE.Color(sky.horizonColor);
  scene.fog.color.set(sky.fogColor);

  // 球
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xf7f9fb, roughness: 0.6 });
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.11, 18, 14), ballMat);
  ballMesh.position.set(0, 0.11, 0); scene.add(ballMesh);
  const ball = { pos: ballMesh.position, vel: new THREE.Vector3() };

  // 玩家模型（第三人称身后跟随，训练场便于看动作）
  const me = createPlayerModel(THREE, { playerId: (typeof window !== 'undefined' && window.FW && FW.state && FW.state.player && FW.state.player.id) || 'PUSER', jersey: 0xf2f5f8, shorts: 0x2c3440, number: 9, name: '你', accent: 0x2c3440, hairStyle: 'short', captain: true });
  scene.add(me.object);

  // 朝向球门（球门在 z=-34）。早期 yaw=Math.PI 让第三人称镜头绕到身后朝 +z，
  // 开局看不到任何球门，玩家不知道该往哪踢；现在镜头在 +z 侧、视线朝 -z。
  const ctrl = { pos: new THREE.Vector3(0, 0, 2), yaw: 0, pitch: -0.02, keys: Object.create(null), vel: new THREE.Vector3() };
  const kd = (e) => { const k = e.key.toLowerCase(); ctrl.keys[k] = true; if (k === ' ') shoot(); };
  const ku = (e) => { ctrl.keys[e.key.toLowerCase()] = false; };
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  let dragging = false, lx = 0, ly = 0;
  renderer.domElement.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    ctrl.yaw -= (e.clientX - lx) * 0.0026;
    ctrl.pitch = Math.max(-0.7, Math.min(0.5, ctrl.pitch - (e.clientY - ly) * 0.0022));
    lx = e.clientX; ly = e.clientY;
  });

  // HUD：命中数 / 射门数 / 剩余时间
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;top:52px;left:50%;transform:translateX(-50%);padding:9px 18px;border-radius:12px;background:rgba(6,9,14,.76);border:1px solid rgba(255,255,255,.12);color:#e9eff8;font:600 14px/1 system-ui,sans-serif;z-index:3';
  host.appendChild(hud);
  const state = { hits: 0, shots: 0, time: 45, done: false };

  function shoot() {
    if (state.done) return;
    const d = Math.hypot(ball.pos.x - ctrl.pos.x, ball.pos.z - ctrl.pos.z);
    if (d > 2.6) return;
    state.shots++;
    const dir = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
    // 精度：面朝球门方向越好越准
    const toGoal = new THREE.Vector3(0 - ball.pos.x, 0, -34 - ball.pos.z).normalize();
    const align = Math.max(0, dir.dot(toGoal));
    const err = (1 - align) * 0.5;
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() * 2 - 1) * err);
    ball.vel.copy(dir).multiplyScalar(22 + Math.random() * 6);
    ball.vel.y = 1.2;
    me.kick(1);
    try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
  }

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  const tip = document.getElementById('fw3d-tip');
  if (tip) tip.textContent = '训练场：WASD 跑动 · 走近球按空格射门 · 45 秒挑战 · Esc 退出';

  let elapsed = 0;
  return {
    info: () => '训练场 · ' + state.hits + '/' + state.shots,
    update(dt) {
      elapsed += dt;
      if (!state.done) {
        state.time -= dt;
        if (state.time <= 0) {
          state.done = true;
          hud.textContent = '时间到 · 命中 ' + state.hits + '/' + state.shots;
          setTimeout(() => { if (window.FW3D && FW3D.close) FW3D.close(); }, 2600);
        }
      }
      hud.textContent = state.done ? ('时间到 · 命中 ' + state.hits + '/' + state.shots) : (Math.ceil(state.time) + 's · 命中 ' + state.hits + '/' + state.shots);

      const k = ctrl.keys;
      const fwd = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
      const right = new THREE.Vector3(Math.cos(ctrl.yaw), 0, -Math.sin(ctrl.yaw));
      const wish = new THREE.Vector3();
      if (k.w || k.arrowup) wish.add(fwd);
      if (k.s || k.arrowdown) wish.sub(fwd);
      if (k.d || k.arrowright) wish.add(right);
      if (k.a || k.arrowleft) wish.sub(right);
      const speed = k.shift ? 7.4 : 4.2;
      if (wish.lengthSq() > 0) { wish.normalize().multiplyScalar(speed * dt); ctrl.pos.add(wish); }
      ctrl.pos.x = Math.max(-W / 2 + 1, Math.min(W / 2 - 1, ctrl.pos.x));
      ctrl.pos.z = Math.max(-L + 8, Math.min(6, ctrl.pos.z));

      // 球物理
      ball.vel.y -= 9.81 * dt;
      ball.pos.addScaledVector(ball.vel, dt);
      if (ball.pos.y < 0.11) {
        ball.pos.y = 0.11;
        if (ball.vel.y < 0) ball.vel.y = -ball.vel.y * 0.6;
        ball.vel.x *= 0.94; ball.vel.z *= 0.94;
        if (Math.abs(ball.vel.y) < 0.4) ball.vel.y = 0;
      }
      // 进门判定
      if (Math.abs(ball.pos.x) < 2.5 && ball.pos.z < -33.2 && ball.pos.z > -35 && ball.pos.y < 2.0 && !state.done) {
        state.hits++;
        ball.pos.set(ctrl.pos.x - Math.sin(ctrl.yaw) * 1.4, 0.11, ctrl.pos.z - Math.cos(ctrl.yaw) * 1.4);
        ball.vel.set(0, 0, 0);
        try { if (window.FWSound && FWSound.play) FWSound.play('confirm'); } catch (e) {}
      }
      if (Math.abs(ball.pos.x) > W / 2 || ball.pos.z < -L - 4 || ball.pos.z > 8) {
        ball.pos.set(ctrl.pos.x - Math.sin(ctrl.yaw) * 1.4, 0.11, ctrl.pos.z - Math.cos(ctrl.yaw) * 1.4);
        ball.vel.set(0, 0, 0);
      }

      // 玩家模型跟随
      me.object.position.set(ctrl.pos.x, 0, ctrl.pos.z);
      me.object.rotation.y = ctrl.yaw + Math.PI;
      me.update(dt, wish.lengthSq() > 0 ? speed : 0, elapsed);

      // 第三人称跟随镜头
      const camBack = 4.2, camUp = 2.1;
      camera.position.set(
        ctrl.pos.x + Math.sin(ctrl.yaw) * camBack,
        camUp + Math.sin(ctrl.pitch) * 1.4,
        ctrl.pos.z + Math.cos(ctrl.yaw) * camBack
      );
      camera.lookAt(ctrl.pos.x, 1.2, ctrl.pos.z - 2);
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
