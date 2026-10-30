// FW3D · 替补席（模式 bench）
// 坐在边线后第一人称看球；按 W 热身，热身满格后教练叫你上场（切到比赛模式）。
import { createPlayerModel } from '../character.js';
import { buildSkyDome, SKY_PRESETS } from '../atmosphere.js';

export function start({ THREE, host, opts }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1118);
  scene.fog = new THREE.Fog(0x0c1118, 60, 190);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(72, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.1, 400);
  camera.position.set(0, 1.35, 4.2);

  // 球场（简版：草皮 + 中线 + 边线 + 对面看台）
  const W = 68, L = 105;
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ color: 0x2f7d42, roughness: 0.95 }));
  pitch.rotation.x = -Math.PI / 2; pitch.position.z = -L / 2 + 3; pitch.receiveShadow = true; scene.add(pitch);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xdfe9e2 });
  const line = (w, l, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.01, z); scene.add(m); };
  line(0.12, L, -W / 2, -L / 2 + 3); line(0.12, L, W / 2, -L / 2 + 3);
  line(W, 0.12, 0, 3); line(W, 0.12, 0, -L + 3);
  const standMat = new THREE.MeshStandardMaterial({ color: 0x243140, roughness: 0.9 });
  for (const s of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(W + 14, 7, 2.4), standMat);
    st.position.set(0, 3.5, s > 0 ? -L - 6 : 12); scene.add(st);
  }
  scene.add(new THREE.HemisphereLight(0xe6eeff, 0x1e2a20, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(40, 60, 20); scene.add(sun);
  // 天空穹 + 同色雾（与球场/训练/回放同一套大气规则）
  const sky = buildSkyDome(THREE, SKY_PRESETS.dayStadium, { radius: 380 });
  scene.add(sky.mesh);
  scene.background = new THREE.Color(sky.horizonColor);
  scene.fog.color.set(sky.fogColor);

  // 场上的队友（远处跑动）
  const actors = [];
  let squad = [];
  try {
    const p = window.FW && FW.state && FW.state.player;
    const club = p && p.clubId ? FW.state.clubs[p.clubId] : null;
    if (club) squad = (club.playerIds || []).map((id) => FW.state.players[id]).filter(Boolean).slice(0, 6);
  } catch (e) { squad = []; }
  squad.forEach((pl, i) => {
    const m = createPlayerModel(THREE, { player: pl || null, playerId: (pl && pl.id) || ('BENCH-' + i), jersey: 0xf2f5f8, shorts: 0x2c3440, number: Number(pl.number) || i + 2, name: String(pl.name || ''), detail: 'mid' });
    m.object.position.set(-16 + i * 6, 0, -18 - (i % 3) * 8);
    m.object.rotation.y = Math.PI;
    scene.add(m.object);
    actors.push({ m, phase: i * 0.9, x0: m.object.position.x, z0: m.object.position.z });
  });

  // 替补席：长凳 + 身边两名替补
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x2b3644, roughness: 0.8 });
  const bench = new THREE.Mesh(new THREE.BoxGeometry(6, 0.12, 0.8), benchMat);
  bench.position.set(0, 0.5, 3.4); scene.add(bench);
  for (const x of [-2.6, 0, 2.6]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.6), benchMat);
    leg.position.set(x, 0.25, 3.4); scene.add(leg);
  }

  // HUD：比分、时间、热身进度
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;top:52px;left:50%;transform:translateX(-50%);display:flex;gap:16px;align-items:center;padding:9px 18px;border-radius:12px;background:rgba(6,9,14,.75);border:1px solid rgba(255,255,255,.12);color:#e8eef8;font:600 14px/1 system-ui,sans-serif;z-index:3';
  host.appendChild(hud);
  const warmWrap = document.createElement('div');
  warmWrap.style.cssText = 'position:absolute;left:50%;bottom:78px;transform:translateX(-50%);width:200px;height:8px;border-radius:99px;background:rgba(255,255,255,.16);overflow:hidden;z-index:3';
  const warmFill = document.createElement('div');
  warmFill.style.cssText = 'height:100%;width:0;background:linear-gradient(90deg,#5ad1a0,#ffd166);border-radius:99px';
  warmWrap.appendChild(warmFill);
  host.appendChild(warmWrap);

  let tl = null;
  try { tl = (window.FW && FW.matchTimeline) ? FW.matchTimeline() : null; } catch (e) {}
  const score = (tl && tl.score) ? tl.score : { home: 0, away: 0 };
  const warm = { v: 0 };

  const ctrl = { yaw: 0, pitch: 0, keys: Object.create(null) };
  const kd = (e) => { ctrl.keys[e.key.toLowerCase()] = true; };
  const ku = (e) => { ctrl.keys[e.key.toLowerCase()] = false; };
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  let dragging = false, lx = 0, ly = 0;
  renderer.domElement.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    ctrl.yaw = Math.max(-0.9, Math.min(0.9, ctrl.yaw - (e.clientX - lx) * 0.002));
    ctrl.pitch = Math.max(-0.5, Math.min(0.5, ctrl.pitch - (e.clientY - ly) * 0.0018));
    lx = e.clientX; ly = e.clientY;
  });

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  const tip = document.getElementById('fw3d-tip');
  if (tip) tip.textContent = '替补席：按住 W 热身（热身满格后教练会让你上场）· 拖拽转头 · Esc 退出';

  let elapsed = 0, called = false;
  return {
    info: () => '替补席 · 热身 ' + Math.round(warm.v) + '%',
    update(dt) {
      elapsed += dt;
      // 热身
      if (ctrl.keys.w) warm.v = Math.min(100, warm.v + dt * 34);
      else warm.v = Math.max(0, warm.v - dt * 6);
      warmFill.style.width = warm.v + '%';
      const min = Math.min(90, Math.floor(elapsed * 1.2));
      hud.textContent = min + "'   " + score.home + ' - ' + score.away + '   热身 ' + Math.round(warm.v) + '%';

      if (!called && warm.v >= 100) {
        called = true;
        hud.textContent = '教练：热身好了，准备上！';
        setTimeout(() => { if (window.FW3D && FW3D.open) FW3D.open({ mode: 'match' }); }, 1600);
      }

      // 场上队友跑动
      for (const a of actors) {
        const t = elapsed + a.phase;
        a.m.object.position.x = a.x0 + Math.sin(t * 0.5) * 6;
        a.m.object.position.z = a.z0 + Math.sin(t * 0.37 + 1) * 5;
        a.m.object.rotation.y = Math.PI + Math.sin(t * 0.5) * 0.5;
        a.m.update(dt, 3.4, t);
      }

      camera.position.set(0, 1.35, 4.2);
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
      if (warmWrap.parentNode) warmWrap.parentNode.removeChild(warmWrap);
    },
  };
}
