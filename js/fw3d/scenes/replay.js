// FW3D · 回放与侦察（模式 replay）
// 看台视角看一场别人的比赛：按事件流依次播放关键片段，结束后给出一条情报
import { createPlayerModel } from '../character.js';
import { buildSkyDome, SKY_PRESETS } from '../atmosphere.js';

export function start({ THREE, host, opts }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f15);
  scene.fog = new THREE.Fog(0x0b0f15, 70, 220);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
  host.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(62, (host.clientWidth || window.innerWidth) / (host.clientHeight || window.innerHeight), 0.1, 400);

  const W = 68, L = 105;
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ color: 0x2f7d42, roughness: 0.95 }));
  pitch.rotation.x = -Math.PI / 2; pitch.receiveShadow = true; scene.add(pitch);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xdfe9e2 });
  const line = (w, l, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.01, z); scene.add(m); };
  line(0.12, L, -W / 2, 0); line(0.12, L, W / 2, 0);
  line(W, 0.12, 0, -L / 2); line(W, 0.12, 0, L / 2); line(W, 0.12, 0, 0);

  // 看台（围绕）
  const standMat = new THREE.MeshStandardMaterial({ color: 0x232e3b, roughness: 0.9 });
  for (const s of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(W + 26, 9, 3), standMat);
    st.position.set(0, 4.5, s > 0 ? L / 2 + 12 : -L / 2 - 12); scene.add(st);
    const sd = new THREE.Mesh(new THREE.BoxGeometry(3, 9, L + 20), standMat);
    sd.position.set(s * (W / 2 + 12), 4.5, 0); scene.add(sd);
  }
  scene.add(new THREE.HemisphereLight(0xe6eeff, 0x1e2a20, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(40, 70, 30); scene.add(sun);
  // 天空穹 + 同色雾：与其他球场共用 atmosphere.js 的规则，
  // 否则看台机位后面是一整片纯黑，回放看起来像悬空的绿色板块。
  const sky = buildSkyDome(THREE, SKY_PRESETS.dayStadium, { radius: 380 });
  scene.add(sky.mesh);
  scene.background = new THREE.Color(sky.horizonColor);
  scene.fog.color.set(sky.fogColor);

  // 场上 8 人
  const actors = [];
  for (let i = 0; i < 8; i++) {
    const m = createPlayerModel(THREE, { playerId: 'REPLAY-' + i, jersey: i % 2 ? 0x2f5e42 : 0xf2f5f8, shorts: 0x2a3038, number: i + 2, name: '' });
    m.object.position.set(-24 + i * 7, 0, -20 + (i % 4) * 12);
    scene.add(m.object);
    actors.push({ m, phase: i * 0.7, x0: m.object.position.x, z0: m.object.position.z });
  }

  // 看台机位
  camera.position.set(-18, 9.5, 62);
  camera.lookAt(0, 0, 0);

  // 数据
  let tl = null;
  try { tl = (window.FW && FW.matchTimeline) ? FW.matchTimeline(opts && opts.matchId) : null; } catch (e) {}
  const events = (tl && tl.events) ? tl.events.slice(0, 6) : [];
  const scout = (() => {
    try { return (window.FW && FW.scoutingReport && tl && tl.home) ? null : null; } catch (e) { return null; }
  })();

  // HUD
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;top:52px;left:50%;transform:translateX(-50%);min-width:280px;padding:10px 18px;border-radius:12px;background:rgba(6,9,14,.76);border:1px solid rgba(255,255,255,.12);color:#e9eff8;font:600 14px/1.5 system-ui,sans-serif;text-align:center;z-index:3';
  const score = (tl && tl.score) ? tl.score : { home: 0, away: 0 };
  hud.textContent = (tl ? (tl.home + ' ' + score.home + ' - ' + score.away + ' ' + tl.away) : '回放') + ' · 关键片段';
  host.appendChild(hud);

  let idx = 0, timer = 0, done = false;
  const DUR = 2.6;

  function showEvent(ev) {
    hud.innerHTML = '<div style="font-size:11px;letter-spacing:.16em;opacity:.7">REPLAY</div>'
      + '<div style="margin:6px 0 2px">' + ev.minute + "'  " + (ev.scorer || '进球') + (ev.mine ? '（你）' : '') + '</div>'
      + '<div style="opacity:.7;font-size:12px">' + (ev.team === 'home' ? '主队' : '客队') + '进球</div>';
    try { if (window.FWSound && FWSound.play) FWSound.play('tap'); } catch (e) {}
  }

  function finishReplay() {
    if (done) return;
    done = true;
    let intel = null;
    try {
      const p = window.FW && FW.state && FW.state.player;
      const club = p && p.clubId ? FW.state.clubs[p.clubId] : null;
      const lg = club ? FW.state.leagues.find((l) => l.id === club.leagueId) : null;
      const opp = lg ? FW.state.clubs[(lg.clubIds || []).find((id) => id !== club.id)] : null;
      if (opp && window.FW.scoutingReport) intel = FW.scoutingReport(opp.id);
    } catch (e) {}
    hud.innerHTML = '<div style="font-size:11px;letter-spacing:.16em;opacity:.7">SCOUTING</div>'
      + '<div style="margin:8px 0 4px;font-weight:600">' + (intel ? intel.intel : '没有可用的情报') + '</div>'
      + '<div style="opacity:.6;font-size:12px">3 秒后关闭</div>';
    setTimeout(() => { if (window.FW3D && FW3D.close) FW3D.close(); }, 3000);
  }

  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  const tip = document.getElementById('fw3d-tip');
  if (tip) tip.textContent = '回放：看台机位观看关键片段 · 结束后给出对手情报 · Esc 退出';

  let elapsed = 0;
  return {
    info: () => '回放 · ' + events.length + ' 个片段',
    update(dt) {
      elapsed += dt;
      if (events.length && !done) {
        timer += dt;
        if (idx < events.length && timer >= DUR) { timer = 0; showEvent(events[idx]); idx++; }
        if (idx >= events.length && timer >= DUR) finishReplay();
      } else if (!events.length && !done && elapsed > 2.4) finishReplay();

      for (const a of actors) {
        const t = elapsed + a.phase;
        a.m.object.position.x = a.x0 + Math.sin(t * 0.42) * 8;
        a.m.object.position.z = a.z0 + Math.sin(t * 0.31 + 1) * 6;
        a.m.object.rotation.y = Math.sin(t * 0.42) * 0.6;
        a.m.update(dt, 3.2, t);
      }
      // 缓慢横移的转播机位
      const px = -18 + Math.sin(elapsed * 0.12) * 10;
      camera.position.set(px, 9.5, 62);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('resize', resize);
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); } });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    },
  };
}
