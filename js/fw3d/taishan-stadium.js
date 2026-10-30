// 泰山球场适配器：把 buildStadium 的产出翻译成 arena 需要的结构
// 用法：const st = await buildTaishanStadium(THREE, renderer); st.group / st.colliders / st.spawn
export async function buildTaishanStadium(THREE, renderer) {
  const mod = await import('./vendor/taishan/stadium.js');
  const mats = await import('./vendor/taishan/materials.js');

  const textures = {};
  const safe = (fn, ...args) => {
    try { return typeof mats[fn] === 'function' ? mats[fn](...args) : null; } catch (e) { return null; }
  };
  textures.pitch = safe('createPitchTexture', 1024);
  textures.track = safe('createTrackTexture', 512);
  textures.ad = safe('createAdTexture', 'FOOTBALL WORLD');
  textures.banner = safe('createStadiumBanner', 'FOOTBALL WORLD');
  textures.gate = safe('createGatePanelTexture', 'HOME');
  textures.exit = safe('createExitSign', 'EXIT');

  const built = mod.buildStadium({ textures, renderer });
  return {
    group: built.group,
    colliders: built.colliders || [],
    interactables: built.interactables || [],
    spawn: built.spawn || { position: new THREE.Vector3(0, 0, 26), yaw: 0, pitch: 0 },
    fog: built.fog || null,
    background: built.background || null,
    ok: !!(built.group && built.group.children && built.group.children.length),
    children: built.group ? built.group.children.length : 0,
  };
}
