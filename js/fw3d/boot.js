// FW3D · 3D 层入口（P1：能力检测 / 开关 / 渲染循环 / 场景调度）
// 原则：3D 是可选附加层，任何失败都不能影响 2D 游戏。
(function () {
  const VERSION = 'p1-0.1';
  const state = {
    supported: null,
    enabled: false,
    active: false,
    scene: null,
    stats: { fps: 0, frames: 0, last: 0 },
    error: null,
  };

  function detect() {
    if (state.supported != null) return state.supported;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      state.supported = !!(gl && typeof gl.getParameter === 'function');
    } catch (e) {
      state.supported = false;
    }
    return state.supported;
  }

  function preferEnabled() {
    try {
      const v = localStorage.getItem('fw3d.enabled');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch (e) {}
    return true;
  }

  state.available = function () { return detect(); };
  state.isEnabled = function () { return state.enabled && state.supported; };
  state.setEnabled = function (on) {
    state.enabled = !!on && !!state.supported;
    try { localStorage.setItem('fw3d.enabled', state.enabled ? '1' : '0'); } catch (e) {}
    if (!state.enabled && state.active) close();
    return state.enabled;
  };

  // 舞台容器
  let root = null, canvasHost = null, raf = 0, loop = null;

  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'fw3d-root';
    root.style.cssText = 'position:fixed;inset:0;z-index:9000;background:#05070a;display:none;'
      // 手机端：3D 全屏时不能跟着页面滚、也不能被双击/捏合缩放（否则「滑动看四周」会被浏览器抢走）
      + 'touch-action:none;overscroll-behavior:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none';
    canvasHost = document.createElement('div');
    canvasHost.style.cssText = 'position:absolute;inset:0';
    root.appendChild(canvasHost);
    const bar = document.createElement('div');
    bar.id = 'fw3d-bar';
    bar.style.cssText = 'position:absolute;left:0;right:0;top:0;display:flex;gap:10px;align-items:center;padding:10px 14px;color:#cfd6e4;font:12px/1.4 system-ui,sans-serif;background:linear-gradient(180deg,rgba(4,6,10,.82),transparent);z-index:3';
    bar.innerHTML = '<b style="letter-spacing:.14em;font-size:11px">FOOTBALL WORLD · 3D</b>'
      + '<span id="fw3d-stat" style="opacity:.7"></span>'
      + '<span style="flex:1"></span>'
      // 手机端没有 Esc 键，标题也放不下：文案与布局都在下面的 .fw3d-touch-ui 规则里收窄
      + '<button id="fw3d-close" style="border:0;border-radius:8px;padding:5px 12px;background:rgba(255,255,255,.12);color:#e8edf6;cursor:pointer">'
      + (isTouchNow() ? '退出' : '退出 3D（Esc）') + '</button>';
    root.appendChild(bar);
    const tip = document.createElement('div');
    tip.id = 'fw3d-tip';
    tip.style.cssText = 'position:absolute;left:50%;bottom:28px;transform:translateX(-50%);color:#dfe6f2;font:12.5px/1.5 system-ui,sans-serif;background:rgba(6,9,14,.72);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px 16px;z-index:3';
    tip.textContent = 'WASD 移动 · 鼠标转头 · Shift 冲刺 · Esc 退出';
    root.appendChild(tip);
    document.body.appendChild(root);
    root.querySelector('#fw3d-close').onclick = () => close();
    return root;
  }

  function setStat(text) {
    const el = root && root.querySelector('#fw3d-stat');
    if (el) el.textContent = text;
  }

  // ── 个性化：号码、姓名、球鞋、肤色、惯用脚、庆祝动作
  function loadAppearance() {
    try { return JSON.parse(localStorage.getItem('fw3d.appearance') || 'null') || {}; } catch (e) { return {}; }
  }
  function saveAppearance(a) {
    try { localStorage.setItem('fw3d.appearance', JSON.stringify(a || {})); } catch (e) {}
    return a;
  }

  async function open(opts) {
    if (!detect()) {
      return { ok: false, reason: 'no-webgl' };
    }
    // file:// 下浏览器会拦截动态 import，直接给出可执行的提示
    if (location.protocol === 'file:') {
      return { ok: false, reason: 'file-protocol', hint: '请用 start.cmd 或本地服务器打开（3D 需要 http 协议）' };
    }
    state.enabled = true;
    if (opts && opts.mode === 'match') { try { if (window.FW3D && window.FW3D.autoTimeline) window.FW3D.autoTimeline(); } catch (e) {} }
    ensureRoot();
    root.style.display = 'block';
    state.active = true;
    document.documentElement.style.overflow = 'hidden';
    try {
      // 动态 import 本地内置的 three（file:// 下也能用）
      const THREE = await import('./vendor/three.module.min.js');
      const MODES = { trophy: './scenes/trophy.js', dressing: './scenes/dressing.js', bench: './scenes/bench.js', presser: './scenes/presser.js', farewell: './scenes/farewell.js', replay: './scenes/replay.js', training: './scenes/training.js' };
      const scenePath = MODES[(opts && opts.mode) || ''] || './scenes/arena.js';
      const mod = await import(scenePath);
      const merged = Object.assign({}, opts || {}, { appearance: loadAppearance() });
      // 比赛模式：把"赛前比赛计划"里的战术映射成 3D 风格传进去（B 方案）。
      // 调用方显式给的 opts.style 优先，其次才是计划；都没有时 arena 回落到记忆值。
      if ((merged.mode === 'match' || merged.mode === 'spectate') && !merged.style) {
        const s = planStyle();
        if (s) merged.style = s;
      }
      const ctx = await mod.start({ THREE, host: canvasHost, opts: merged });
      state.scene = ctx;
      state.stats.last = performance.now();
      const tick = () => {
        if (!state.active) return;
        raf = requestAnimationFrame(tick);
        const now = performance.now();
        const dt = Math.min(0.05, (now - state.stats.last) / 1000);
        state.stats.last = now;
        state.stats.frames++;
        if (now - (state.stats.fpsAt || 0) > 1000) {
          const elapsed = (now - (state.stats.fpsAt || now - 1000)) / 1000;
          state.stats.fps = Math.max(0, Math.round(state.stats.frames / elapsed));
          window.__FW3D_FPS = state.stats.fps;
          state.stats.frames = 0;
          state.stats.fpsAt = now;
          setStat(state.stats.fps + ' FPS · ' + (ctx.info ? ctx.info() : ''));
        }
        try { ctx.update(dt, now); } catch (e) { state.error = e; }
      };
      raf = requestAnimationFrame(tick);
      return { ok: true, version: VERSION };
    } catch (err) {
      // 注意：这里曾残留着调用自检作用域里 note() 的代码，一旦真实错误发生，
      // catch 里自己又抛 ReferenceError，把原始错误信息吞掉（排查时极难定位）。现在只记录与返回。
      state.error = err;
      console.error('[FW3D] 启动失败', err);
      const detail = (err && (err.stack || err.message)) || String(err);
      try { close(); } catch (e) {}
      return { ok: false, reason: 'error', error: detail };
    }
  }

  function close() {
    state.active = false;
    if (raf) cancelAnimationFrame(raf), raf = 0;
    try { state.scene && state.scene.dispose && state.scene.dispose(); } catch (e) {}
    state.scene = null;
    if (root) root.style.display = 'none';
    document.documentElement.style.overflow = '';
    // 退出 3D 时把全屏与横屏锁定一起还给系统，否则会卡在横屏全屏回不去 2D
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        const p = document.exitFullscreen();
        if (p && p.catch) p.catch(function () {});
      }
      const so = window.screen && window.screen.orientation;
      if (so && so.unlock) so.unlock();
    } catch (e) {}
    fullscreenRequested = false;
    if (typeof window.__FWAPP !== 'undefined' && window.__FWAPP.render) {
      try { window.__FWAPP.render(); } catch (e) {}
    }
  }

  function toggle() {
    if (state.active) { close(); return { ok: true, closed: true }; }
    return open({});
  }

  // Esc 退出（3D 激活时接管，避免和 2D 快捷键冲突）
  document.addEventListener('keydown', (e) => {
    if (!state.active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);

  // 常驻入口：3D 可用时在右下角显示
  function mountLauncher() {
    if (!detect()) return;
    if (document.getElementById('fw3d-launch')) return;
    // 所有 3D 入口放进一个容器：桌面=右下竖排；手机=底部导航上方一行可横滑（避免压住导航）
    let wrap = document.getElementById('fw3d-launchers');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'fw3d-launchers';
      wrap.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:8000;display:flex;flex-direction:column;align-items:flex-end;gap:9px;max-height:calc(100vh - 40px)';
      document.body.appendChild(wrap);
    }
    // 手机端：把入口条插到「FOOTBALL WORLD 标志下方、卡片内的返回按钮上方」，并用 sticky 保持可见。
    // 注意：页面每次 setView 都会重建 #app 内容，所以用 MutationObserver 把它插回去（幂等，不会重复）。
    const FW3D_WRAP_CSS = wrap.style.cssText;
    const fw3dPhone = () => { try { return window.matchMedia('(max-width:760px)').matches; } catch (e) { return false; } };
    const placeLaunchers = () => {
      try {
        if (fw3dPhone()) {
          const shell = document.querySelector('#app .shell') || document.querySelector('.shell');
          let topBlock = null;
          if (shell) for (const c of shell.children) { if (c.classList && c.classList.contains('top')) { topBlock = c; break; } }
          if (shell && topBlock) {
            wrap.style.cssText = 'position:sticky;top:0;z-index:60;display:flex;flex-direction:row;align-items:center;gap:6px;'
              + 'overflow-x:auto;overflow-y:hidden;width:100%;max-height:none;padding:6px 0 8px;margin:0 0 8px;'
              + 'background:rgba(250,250,251,.92);border-bottom:1px solid rgba(40,42,46,.08);'
              + '-webkit-backdrop-filter:blur(18px) saturate(130%);backdrop-filter:blur(18px) saturate(130%);scrollbar-width:none';
            if (topBlock.nextSibling !== wrap) shell.insertBefore(wrap, topBlock.nextSibling);
            return;
          }
        }
        if (wrap.style.cssText !== FW3D_WRAP_CSS) wrap.style.cssText = FW3D_WRAP_CSS;
        if (wrap.parentElement !== document.body) document.body.appendChild(wrap);
      } catch (e) {}
    };
    placeLaunchers();
    window.addEventListener('resize', placeLaunchers);
    try {
      let queued = false;
      const obs = new MutationObserver(() => { if (queued) return; queued = true; setTimeout(() => { queued = false; placeLaunchers(); }, 30); });
      const appEl = document.getElementById('app') || document.body;
      obs.observe(appEl, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(placeLaunchers, 1500);
    const el = document.createElement('button');
    el.id = 'fw3d-launch';
    el.textContent = '走进球场 3D';
    el.style.cssText = 'z-index:8000;border:1px solid rgba(20,24,32,.12);'
      + 'background:#12161d;color:#eaf0f8;font:600 12.5px/1 system-ui,sans-serif;letter-spacing:.04em;'
      + 'padding:11px 16px;border-radius:12px;cursor:pointer;box-shadow:0 10px 26px rgba(10,14,20,.28)';
    el.onmouseenter = () => { el.style.background = '#1b2130'; };
    el.onmouseleave = () => { el.style.background = '#12161d'; };
    el.onclick = () => { if (state.active) close(); else open({}); };
    const el2 = document.createElement('button');
    el2.id = 'fw3d-launch-tunnel';
    el2.textContent = '通道出场';
    el2.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:66px') + ';background:#25303f';
    el2.onclick = () => { if (state.active) close(); else open({ mode: 'tunnel' }); };
    el2.onmouseenter = () => { el2.style.background = '#2f3d4f'; };
    el2.onmouseleave = () => { el2.style.background = '#25303f'; };
    wrap.appendChild(el2);
    const el3 = document.createElement('button');
    el3.id = 'fw3d-launch-tour';
    el3.textContent = '走进主场';
    el3.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:114px') + ';background:#2a2f3a';
    el3.onmouseenter = () => { el3.style.background = '#39404e'; };
    el3.onmouseleave = () => { el3.style.background = '#2a2f3a'; };
    el3.onclick = () => { if (state.active) close(); else open({ mode: 'tour' }); };
    wrap.appendChild(el3);
    const el4 = document.createElement('button');
    el4.id = 'fw3d-launch-trophy';
    el4.textContent = '荣誉室';
    el4.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:162px') + ';background:#3a3226';
    el4.onmouseenter = () => { el4.style.background = '#4d4231'; };
    el4.onmouseleave = () => { el4.style.background = '#3a3226'; };
    el4.onclick = () => { if (state.active) close(); else open({ mode: 'trophy' }); };
    wrap.appendChild(el4);
    const el5 = document.createElement('button');
    el5.id = 'fw3d-launch-dressing';
    el5.textContent = '更衣室';
    el5.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:210px') + ';background:#22303c';
    el5.onmouseenter = () => { el5.style.background = '#2e4050'; };
    el5.onmouseleave = () => { el5.style.background = '#22303c'; };
    el5.onclick = () => { if (state.active) close(); else open({ mode: 'dressing' }); };
    wrap.appendChild(el5);
    const el6 = document.createElement('button');
    el6.id = 'fw3d-launch-bench';
    el6.textContent = '替补席';
    el6.title = '自由观赛：坐在替补席看球，可起立走动、到场边 / 对面替补席 / 看台';
    el6.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:258px') + ';background:#2a3a2e';
    el6.onmouseenter = () => { el6.style.background = '#364c3b'; };
    el6.onmouseleave = () => { el6.style.background = '#2a3a2e'; };
    // 「替补席」入口现在开的是自由观赛（arena 的 spectate 模式）：
    // 旧 bench.js 只有简版草皮、机位钉死，已被它取代（文件保留、自检仍在跑，入口 id 不变）。
    el6.onclick = () => { if (state.active) close(); else open({ mode: 'spectate' }); };
    wrap.appendChild(el6);
    const el7 = document.createElement('button');
    el7.id = 'fw3d-launch-presser';
    el7.textContent = '发布会';
    el7.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:306px') + ';background:#332a3a';
    el7.onmouseenter = () => { el7.style.background = '#42354c'; };
    el7.onmouseleave = () => { el7.style.background = '#332a3a'; };
    el7.onclick = () => { if (state.active) close(); else open({ mode: 'presser' }); };
    wrap.appendChild(el7);
    const el8 = document.createElement('button');
    el8.id = 'fw3d-launch-farewell';
    el8.textContent = '告别';
    el8.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:354px') + ';background:#3a2b2b';
    el8.onmouseenter = () => { el8.style.background = '#4c3838'; };
    el8.onmouseleave = () => { el8.style.background = '#3a2b2b'; };
    el8.onclick = () => { if (state.active) close(); else open({ mode: 'farewell' }); };
    wrap.appendChild(el8);
    const el9 = document.createElement('button');
    el9.id = 'fw3d-launch-replay';
    el9.textContent = '回放/侦察';
    el9.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:402px') + ';background:#22333a';
    el9.onmouseenter = () => { el9.style.background = '#2e454e'; };
    el9.onmouseleave = () => { el9.style.background = '#22333a'; };
    el9.onclick = () => { if (state.active) close(); else open({ mode: 'replay' }); };
    wrap.appendChild(el9);
    const elT = document.createElement('button');
    elT.id = 'fw3d-launch-training';
    elT.textContent = '训练场';
    elT.style.cssText = el.style.cssText.replace('bottom:18px', 'bottom:450px') + ';background:#2b3a2c';
    elT.onmouseenter = () => { elT.style.background = '#384c3a'; };
    elT.onmouseleave = () => { elT.style.background = '#2b3a2c'; };
    elT.onclick = () => { if (state.active) close(); else open({ mode: 'training' }); };
    wrap.appendChild(elT);
    // ── 战术风格：**已从主界面移除**
    // 原在这里挂了一个 `#fw3d-tactics` + `#fw3d-style` 下拉（均衡/控球/反击/高压/低位）。
    // 问题：它只作用于可选的 3D 层，2D 生涯结算完全不读它；而 2D 赛前"比赛计划"里
    // 已经有一套真正生效的战术（平衡/进攻/防守/控球，见 app.js 的 playerMatchPlan）。
    // 两套词汇并存 + 主界面点完没有任何可见反馈 = 误导性 UI。
    // 现在改为：战术只在 3D 比赛里出现（HUD 胶囊 + T 键），出场时从"比赛计划"映射过来。
    // 见 arena.js 的 mountTacticsHud()/styleFromPlan() 与 boot.js 的 planStyle()。
    wrap.appendChild(el);
    // 手机端：桌面那 10 个竖排按钮在窄屏上会顶到屏幕外、也太小点不中，
    // 换成「一个 3D 悬浮球 + 底部场景面板」；桌面端保持原样（相关 id 全部保留）。
    try { if (isTouchNow()) mountMobileEntry(); } catch (e) { /* 入口失败不影响 2D */ }
  }

  // ── 战术：以 2D 赛前"比赛计划"为唯一权威，映射到 3D 的 5 档 AI 风格。
  // playerMatchPlan.tactic ∈ {平衡, 进攻, 防守, 控球}（app.js 赛前页设置，比赛结束后自动清除）；
  // 3D 的 STYLE_PRESETS ∈ {balanced, possession, counter, press, low}。
  // 这里只做映射，不引入第三个数据源。
  const PLAN_TO_STYLE = {
    平衡: 'balanced', 控球: 'possession', 进攻: 'press', 防守: 'low', 反击: 'counter',
    均衡: 'balanced', 高压: 'press', 低位: 'low',
  };
  function planStyle() {
    try {
      const plan = window.FW && FW.state && FW.state.playerMatchPlan;
      if (plan && plan.tactic && PLAN_TO_STYLE[plan.tactic]) return PLAN_TO_STYLE[plan.tactic];
    } catch (e) {}
    return null;   // 没有计划 → 由 arena 回落到上次记忆的风格
  }
  state.planStyle = planStyle;
  // 触摸设备判据：与 js/fw3d/input.js 的 isTouchDevice 保持一致（此处不 import，避免 boot 变模块）
  function isTouchNow() {
    try {
      if (window.__FW3D_FORCE_MOBILE != null) return !!window.__FW3D_FORCE_MOBILE;
      const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
      const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
      const small = (window.innerWidth || 1200) < 760;
      return !!(touch && (coarse || small));
    } catch (e) { return false; }
  }

  // 手机端入口：FAB + 底部面板（大按钮、避开安全区）
  const MOBILE_SCENES = [
    ['match', '比赛'], ['spectate', '替补席观赛'], ['tunnel', '通道出场'], ['tour', '主场探访'],
    ['training', '训练场'], ['trophy', '荣誉室'], ['dressing', '更衣室'], ['presser', '发布会'],
    ['farewell', '告别'], ['replay', '回放/侦察'],
  ];

  function mountMobileEntry() {
    document.body.classList.add('fw3d-touch-ui');
    // 桌面按钮在手机端隐藏（id 保留，桌面行为与自动化测试完全不受影响）
    const hide = document.createElement('style');
    hide.id = 'fw3d-mobile-hide';
    hide.textContent = 'body.fw3d-touch-ui #fw3d-launch,body.fw3d-touch-ui #fw3d-launch-tunnel,'
      + 'body.fw3d-touch-ui #fw3d-launch-tour,body.fw3d-touch-ui #fw3d-launch-trophy,'
      + 'body.fw3d-touch-ui #fw3d-launch-dressing,body.fw3d-touch-ui #fw3d-launch-bench,'
      + 'body.fw3d-touch-ui #fw3d-launch-presser,body.fw3d-touch-ui #fw3d-launch-farewell,'
      + 'body.fw3d-touch-ui #fw3d-launch-replay,body.fw3d-touch-ui #fw3d-launch-training{display:none!important}'
      + 'body.fw3d-touch-ui #fw3d-tactics{bottom:calc(10px + env(safe-area-inset-bottom,0px));left:10px;font-size:11px;padding:6px 8px}'
      // ── 手机端顶栏：390 px 宽下原样式会换行并和「视角」键压在一起，这里收窄成单行
      + 'body.fw3d-touch-ui #fw3d-bar{padding:8px 10px;gap:6px;font-size:11px;align-items:center}'
      + 'body.fw3d-touch-ui #fw3d-bar>b{display:none}'
      + 'body.fw3d-touch-ui #fw3d-stat{font-size:11px;line-height:1.3;max-width:52vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + 'body.fw3d-touch-ui #fw3d-close{padding:7px 11px;font-size:11px;white-space:nowrap}'
      // 手机端底部提示由 input.js 自己的 #fw3d-touch-hint 承担，
      // 原来那条 #fw3d-tip 会与动作键重叠（截图验收时确认过），必须隐藏
      + 'body.fw3d-touch-ui #fw3d-tip{display:none!important}';
    document.head.appendChild(hide);

    if (document.getElementById('fw3d-launch-mobile')) return;

    const fab = document.createElement('button');
    fab.id = 'fw3d-launch-mobile';
    fab.textContent = '3D';
    fab.style.cssText = 'position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:8000;'
      + 'width:58px;height:58px;border-radius:50%;border:1px solid rgba(255,255,255,.22);'
      + 'background:linear-gradient(160deg,#1b2634,#0f141c);color:#eaf0f8;'
      + 'font:700 15px/1 system-ui,sans-serif;letter-spacing:.04em;cursor:pointer;'
      + 'box-shadow:0 10px 26px rgba(6,10,16,.45);touch-action:manipulation';
    fab.onclick = () => toggleSheet(true);
    document.body.appendChild(fab);

    const sheet = document.createElement('div');
    sheet.id = 'fw3d-mobile-sheet';
    sheet.style.cssText = 'position:fixed;inset:0;z-index:8500;display:none;align-items:flex-end;'
      + 'background:rgba(4,7,11,.62);backdrop-filter:blur(3px)';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:100%;max-height:82vh;overflow:auto;border-radius:18px 18px 0 0;'
      + 'background:#111721;border-top:1px solid rgba(255,255,255,.1);'
      + 'padding:14px 14px calc(18px + env(safe-area-inset-bottom,0px));'
      + 'font:600 13px/1.2 system-ui,sans-serif;color:#dfe6f2';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 4px 12px';
    head.innerHTML = '<b style="letter-spacing:.14em;font-size:11px;opacity:.8">FOOTBALL WORLD · 3D</b>'
      + '<span style="font-size:11px;color:#9fb0c6">· 建议横屏游玩</span><span style="flex:1"></span>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = 'border:0;border-radius:9px;padding:8px 14px;background:rgba(255,255,255,.12);color:#e8edf6;font:600 12px/1 system-ui,sans-serif';
    closeBtn.onclick = () => toggleSheet(false);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px';
    for (const [mode, label] of MOBILE_SCENES) {
      const b = document.createElement('button');
      b.dataset.scene = mode;
      b.textContent = label;
      b.style.cssText = 'min-height:56px;border-radius:13px;border:1px solid rgba(255,255,255,.12);'
        + 'background:#1a2230;color:#eaf0f8;font:600 14px/1 system-ui,sans-serif;cursor:pointer;touch-action:manipulation';
      b.onclick = () => {
        toggleSheet(false);
        if (state.active) close();
        // 手机/平板：3D 按横屏设计。全屏 + 横屏锁定必须在这个用户手势里发起，
        // 放进 open() 里（await 之后）浏览器已经不认这个手势了，会锁不上。
        try { if (isTouchNow()) { ensureRoot(); requestLandscapeFullscreen(); } } catch (e) {}
        open(mode === 'match' ? { mode: 'match' } : { mode: mode });
      };
      grid.appendChild(b);
    }
    panel.appendChild(grid);
    sheet.appendChild(panel);
    sheet.addEventListener('click', (ev) => { if (ev.target === sheet) toggleSheet(false); });
    document.body.appendChild(sheet);
  }

  function toggleSheet(on) {
    const s = document.getElementById('fw3d-mobile-sheet');
    if (!s) return;
    s.style.display = on ? 'flex' : 'none';
  }

  // 手机/平板进 3D：尽力切横屏。能锁就锁；锁不了（iOS Safari 无 orientation.lock）
  // 就由 js/fw3d/input.js 的竖屏遮罩提示用户手动横过来。
  let fullscreenRequested = false;
  function requestLandscapeFullscreen() {
    const lock = () => {
      try {
        const so = window.screen && window.screen.orientation;
        if (so && so.lock) { const p = so.lock('landscape'); if (p && p.catch) p.catch(function () {}); }
      } catch (e) {}
    };
    try {
      if (root && root.requestFullscreen && !document.fullscreenElement) {
        const p = root.requestFullscreen({ navigationUI: 'hide' });
        fullscreenRequested = true;
        if (p && p.then) p.then(lock).catch(function () {});
        else lock();
        return;
      }
    } catch (e) {}
    lock();
  }
  try { if (/([?&])fw3d=selftest/.test(location.search)) setTimeout(runSelfTest, 1200); } catch (e) {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountLauncher);
  else setTimeout(mountLauncher, 300);

  state.enabled = preferEnabled() && detect();

  async function runSelfTest() {
    const out = { steps: [] };
    const note = (k, v, extra) => out.steps.push({ step: k, ok: !!v, value: v, extra: extra === undefined ? null : extra });
    // 按"帧"等待，而不是按毫秒：没有 GPU 的机器上（SwiftShader 软件渲染）
    // 一帧可能要 150 ms，场景的 dt 又被钳在 0.05 s —— 于是「等 450 ms」实际只推进了 0.15 s 的模拟时间，
    // 所有依赖缓动/位移的断言都会假失败（walk 0.76 m vs 2.32 m、yaw 0→0 就是这么来的）。
    // 这个助手保证至少推进 n 帧；rAF 被节流时用 200 ms 超时兜底，绝不会把自检吊死。
    const waitFrames = async (n) => {
      for (let i = 0; i < n; i++) {
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (!done) { done = true; res(); } };
          try { requestAnimationFrame(fin); } catch (e) {}
          setTimeout(fin, 200);
        });
      }
    };
    try {
      note('webgl', detect());
      const r = await open({});
      note('open', r && r.ok, r && (r.reason || 'ok'));
      await new Promise((res) => setTimeout(res, 900));

      if (state.scene && state.scene.teleportToBall) { state.scene.teleportToBall(); note('teleport', true); }

      let tl = null;
      try { tl = (window.FW3D && window.FW3D.autoTimeline) ? window.FW3D.autoTimeline() : null; } catch (e) {}
      note('timeline', !!tl, tl ? (tl.events || []).length : 0);
      note('eventplay', !!(tl && tl.events && tl.events.length && typeof tl.events[0].minute === 'number'));

      // 操控三档位：依次切换，最后回到 full
      let modesOk = !!(state.scene && state.scene.setControlMode);
      if (modesOk) {
        for (const m of ['full', 'key', 'cinematic']) {
          state.scene.setControlMode(m);
          if (state.scene.controlMode() !== m) modesOk = false;
        }
        state.scene.setControlMode('full');
      }
      note('control', modesOk, modesOk ? 'full/key/cinematic' : 'missing');

      await new Promise((res) => setTimeout(res, 200));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await new Promise((res) => setTimeout(res, 480));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
      await new Promise((res) => setTimeout(res, 500));
      out.shot = window.__FW3D_LAST_SHOT || null;
      out.moment = window.__FW3D_LAST_MOMENT || null;
      note('shot', out.shot && out.shot.kicked);
      // 关键瞬间回写：用确定性的输入验证（避免依赖射门随机精度）
      let credited = false;
      try {
        const r2 = (window.FW && FW.applyKeyMoment) ? FW.applyKeyMoment({ onTarget: true, accuracy: 1 }) : null;
        credited = !!(r2 && r2.ok && r2.credited);
      } catch (e) {}
      note('credited', credited);
      note('fps', state.stats.fps > 0 ? state.stats.fps : null);
      try { const q = (state.scene && state.scene.quality) ? state.scene.quality() : null; note('quality', !!q, q ? ('level' + q.level + ' fps' + q.fps) : 'missing'); } catch (e) { note('quality', false); }
      try { const a = (state.scene && state.scene.actions) ? state.scene.actions() : null; note('actions', !!a, a ? Object.keys(a).length : 'missing'); } catch (e) { note('actions', false); }

      // ── 队伍 AI（第三阶段）：22 人 agent、角色/行为、出球与调试可视化
      try {
        if (state.scene && state.scene.kickoff) state.scene.kickoff();
        await new Promise((res) => setTimeout(res, 4200));
        const ai = state.scene && state.scene.ai ? state.scene.ai() : null;
        const teams = state.scene && state.scene.teams ? state.scene.teams() : null;
        note('aiTeams', !!(teams && teams.homeCount === 11 && teams.awayCount === 11), teams ? (teams.homeCount + 'v' + teams.awayCount) : 'missing');
        note('aiIntents', !!(ai && ai.intents >= 20), ai ? ai.intents : 'missing');
        const kinds = Array.from(new Set((ai && ai.behaviors) || []));
        note('aiBehaviors', kinds.length >= 3, kinds.slice(0, 6).join('/'));
        const roles = Array.from(new Set((ai && ai.roles) || []));
        note('aiRoles', roles.some((r) => r === 'presser' || r === 'support' || r === 'cover' || r === 'mark'), roles.join('/'));
        note('aiPlay', !!(ai && (ai.kicks > 0 || ai.owner || ai.restarts > 0)), ai ? ('kicks' + ai.kicks + ' owner' + ai.owner + ' restarts' + ai.restarts) : 'missing');
        let dbgOn = false;
        try { dbgOn = !!(state.scene.aiToggleDebug && state.scene.aiToggleDebug() === true); } catch (e) {}
        note('aiDebug', dbgOn && !!(state.scene.ai && state.scene.ai().debugVisible), dbgOn ? 'on' : 'off');
        try { state.scene.aiToggleDebug(); } catch (e) {}
        const dbg = state.scene.aiDebug ? state.scene.aiDebug() : null;
        note('aiExplain', !!(dbg && dbg.players.length >= 20 && dbg.players.every((r) => r.behavior && typeof r.reason === 'string' && r.reason.length > 2 && isFinite(r.score))), dbg ? dbg.players.length : 'missing');
        const st = window.FW3D && window.FW3D.status ? window.FW3D.status() : null;
        note('runtimeError', !!(st && !st.error), st ? (st.error || 'none') : 'missing');
      } catch (e) { note('aiTeams', false); }
      try {
        const rr = (window.FW && FW.restartLastMatch) ? FW.restartLastMatch() : null;
        note('restart', !!(rr && rr.ok), rr ? rr.reason || 'ok' : 'missing');
      } catch (e) { note('restart', false); }
      try {
        const before = FW3D.appearance();
        FW3D.setAppearance({ number: 7, celebrate: 'sky', boot: '#ffcc00', dominantFoot: 'left' });
        const after = FW3D.appearance();
        const okA = after && after.number === 7 && after.celebrate === 'sky';
        FW3D.setAppearance(before || {});
        note('appearance', okA, after ? after.celebrate : null);
      } catch (e) { note('appearance', false); }
      // ── [players-subsystem] 外观数据层：确定性 / 合法性 / 多样性 / 真实球员覆盖
      try {
        const A = await import('./players/appearance.js');
        const R = await import('./players/real-likeness.js');
        const P1 = { id: 'SELFTEST-LOOK-A', position: 'ST', age: 24 };
        const a1 = A.appearanceFor(P1), a2 = A.appearanceFor(P1);
        const v1 = A.validateAppearance(a1);
        // 对外 API（2D 界面会用它取同一张脸）必须与内部生成结果一致
        let viaApi = null;
        try { viaApi = await window.FW3D.appearanceOf(P1); } catch (e) {}
        const apiOk = !!(viaApi && A.appearanceKey(viaApi) === A.appearanceKey(a1));
        note('appearanceParams', A.appearanceKey(a1) === A.appearanceKey(a2) && v1.ok && apiOk,
          'det=' + (A.appearanceKey(a1) === A.appearanceKey(a2)) + ' api=' + apiOk + ' issues=' + v1.issues.length + ' ' + a1.hair_style + '/' + a1.height + 'cm');
        const POS = ['GK', 'CB', 'LB', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST'];
        const batch = A.generateMany(120, { prefix: 'SELFTEST-NPC', positions: POS });
        const keys = new Set(batch.map(A.appearanceKey));
        note('appearanceUnique', keys.size >= batch.length - 2, keys.size + '/' + batch.length);
        const looks = batch.map(A.toMeshLook);
        const heads = new Set(looks.map((l) => [l.head.w, l.head.jaw, l.head.cheek, l.head.brow, l.hair.style, l.beard.style, Math.round(l.face.eyeSpacing * 10)].join('|')));
        const invalid = batch.filter((b) => !A.validateAppearance(b).ok).length;
        note('appearanceHeads', heads.size >= Math.floor(batch.length * 0.8) && invalid === 0, heads.size + '/' + looks.length + ' invalid=' + invalid);
        const realIds = Object.keys(R.REAL_LIKENESS);
        const like = R.likenessOf('REAL-erling-haaland');
        const erl = A.appearanceFor({ id: 'REAL-erling-haaland', position: 'ST', age: 26 }, { overrides: like });
        // 关键回归：游戏内实体 id 是 P326 这类数字 id，资料库 id 在 realPlayerId 上。
        // 这里必须验证「只给记录、不显式传 overrides」也能命中（曾经这里漏掉，导致覆盖在游戏里从未生效）。
        const liveRec = { id: 'P-SELFTEST', realPlayerId: 'REAL-erling-haaland', isRealPlayer: true, position: 'ST', age: 26 };
        const live = A.appearanceFor(liveRec);
        const liveOk = live.height === like.height && live.source === 'real:curated' && A.appearanceKey(live) === A.appearanceKey(erl);
        note('appearanceReal', realIds.length >= 8 && erl.height === like.height && erl.provenance.height !== 'procedural' && liveOk,
          realIds.length + ' players / ' + erl.height + 'cm / prov=' + erl.provenance.height + ' / live=' + (liveOk ? 'hit' : 'MISS'));
      } catch (e) { note('appearanceParams', false, String(e && e.message)); }

      // 庆祝切镜（必须在 close 之前）
      try { if (state.scene && state.scene.celebrate) { state.scene.celebrate(); note('celebrate', true); } else note('celebrate', false); } catch (e) { note('celebrate', false); }

      try {
        close();
        const t2 = await open({ mode: 'tour' });
        note('tour', !!(t2 && t2.ok));
        close();
        const t3 = await open({ mode: 'trophy' });
        note('trophy', !!(t3 && t3.ok));
        close();
        const t4 = await open({ mode: 'dressing' });
        note('dressing', !!(t4 && t4.ok));
        close();
        const t5 = await open({ mode: 'bench' });
        note('bench', !!(t5 && t5.ok));
        close();
        // ── 自由观赛（spectate）：坐替补席 → 起立 → 朝球场走被挡 → 比分只认脚本进球
        try {
          const t5s = await open({ mode: 'spectate' });
          note('spectateOpen', !!(t5s && t5s.ok), t5s && (t5s.reason || 'ok'));
          if (t5s && t5s.ok) {
            await new Promise((res) => setTimeout(res, 700));
            const sp0 = state.scene && state.scene.spectate ? state.scene.spectate() : null;
            note('spectateSit', !!(sp0 && sp0.mode && sp0.seated && sp0.eye < 1.35 && sp0.kind === 'dugout'),
              sp0 ? ('seated=' + sp0.seated + ' eye=' + sp0.eye + ' kind=' + sp0.kind + ' y=' + sp0.groundY + ' sitters=' + sp0.sitters) : 'missing');
            const up = state.scene.spectateSit(false);
            await waitFrames(16);          // 眼高缓动 0.35 s：至少 16 帧，慢机器上也够
            const sp1 = state.scene.spectate();
            note('spectateStand', !!(up && up.ok && !sp1.seated && sp1.eye > 1.5), 'eye=' + sp1.eye + ' y=' + sp1.groundY);
            const blocked = state.scene.spectateWalk(-30, sp1.z);
            note('spectateBlockPitch', !!(blocked && Math.abs(blocked.x) >= 34.3 && blocked.hit === 'pitch'), blocked);
            const lap = state.scene.spectateWalk(-34.6, sp1.z + 2);
            note('spectateWalk', !!(lap && lap.ok), lap);
            note('spectateClock', !!(sp1.minute > 0), sp1.minute + "' " + sp1.score.home + '-' + sp1.score.away);
            note('spectateNoShot', sp1.canShoot === false, 'canShoot=' + sp1.canShoot);
            const aiS = state.scene.ai();
            note('spectateAi', !!(aiS && aiS.players === 22), aiS ? (aiS.players + ' 人 / ' + aiS.phase) : 'missing');
            // 比分必须只认脚本：先记一个，再把球塞进门（未在脚本窗口内 → 判进球无效，比分不变）
            const g0 = state.scene.spectate().score;
            state.scene.spectateForceGoal('home');
            const g1 = state.scene.spectate().score;
            note('spectateScore', g1.home === g0.home + 1, g0.home + '-' + g0.away + ' → ' + g1.home + '-' + g1.away);
            state.scene.debugScoreGoal();
            await new Promise((res) => setTimeout(res, 800));
            const g2 = state.scene.spectate().score;
            note('spectateDisallow', g2.home === g1.home && g2.away === g1.away,
              '塞进门后 ' + g2.home + '-' + g2.away + '（判定为进球无效）');
          }
          close();
        } catch (e) { note('spectateOpen', false, String(e && e.message)); try { close(); } catch (e2) {} }
        const t6 = await open({ mode: 'presser' });
        note('presser', !!(t6 && t6.ok));
        close();
        const t7 = await open({ mode: 'farewell' });
        note('farewell', !!(t7 && t7.ok));
        close();
        const t8 = await open({ mode: 'replay' });
        note('replay', !!(t8 && t8.ok));
        close();
        try { const sc = (window.FW && FW.scoutingReport) ? FW.scoutingReport(FW.state.player.clubId) : null; note('scouting', !!(sc && sc.intel), sc ? sc.intel.slice(0, 12) : 'missing'); } catch (e) { note('scouting', false); }
        try { const t9 = await open({ mode: 'training' }); note('training', !!(t9 && t9.ok)); close(); } catch (e) { note('training', false); }
        try {
          const tg = (window.FW && FW.trainingGroundResult) ? FW.trainingGroundResult({ hits: 6, shots: 10, distance: 420 }) : null;
          note('trainingLoop', !!(tg && tg.ok && tg.gains && Object.keys(tg.gains).length), tg ? Object.keys(tg.gains || {}).join('/') : 'missing');
        try {
          const p0 = window.FW.state.player;
          const club0 = window.FW.state.clubs[p0.clubId];
          const lg0 = window.FW.state.leagues.find((l) => l.id === club0.leagueId);
          const opps = (lg0.clubIds || []).filter((id) => id !== club0.id);
          let k = 0;
          const mkM = (clubId, gf, ga) => ({
            id: 'SELFTEST-' + (k++), date: window.FW.state.date, season: window.FW.state.season,
            leagueId: lg0.id, homeClubId: clubId,
            awayClubId: opps.find((x) => x !== clubId) || club0.id,
            score: { home: gf, away: ga }, events: [], stats: null,
          });
          for (let i = 0; i < 3; i++) window.FW.state.matches.push(mkM(opps[0], 3, 1));
          for (let i = 0; i < 3; i++) window.FW.state.matches.push(mkM(opps[1], 1, 3));
          const rA = FW.scoutingReport(opps[0]);
          const rB = FW.scoutingReport(opps[1]);
          note('scoutBranches', rA.tip === 'defensive' && rB.tip === 'offensive', rA.tip + '/' + rB.tip);
        } catch (e) { note('scoutBranches', false); }
        } catch (e) { note('trainingLoop', false); }
      } catch (e) { note('tour', false); }
      // ── 比赛模式：从通道走出边线后才开表（验证 MatchState 推进与 22 人 AI 在场）
      try {
        close();
        const tm = await open({ mode: 'match' });
        note('matchOpen', !!(tm && tm.ok), tm && (tm.reason || 'ok'));
        await new Promise((res) => setTimeout(res, 600));
        try { if (state.scene.enterPitch) state.scene.enterPitch(); } catch (e) {}
        await new Promise((res) => setTimeout(res, 1600));
        const mst = state.scene && state.scene.matchState ? state.scene.matchState() : null;
        note('matchClock', !!(mst && (mst.phase === 'inPlay' || mst.minute > 0)), mst ? (mst.phase + ' @' + mst.minute.toFixed(1)) : 'missing');
        const aiM = state.scene && state.scene.ai ? state.scene.ai() : null;
        note('matchAi', !!(aiM && aiM.players === 22 && aiM.intents >= 20), aiM ? (aiM.players + '/' + aiM.intents) : 'missing');
        // ── [players-subsystem] 场上 22 人：全部带外观、脸型组合互不相同、材质带宽、LOD 生效
        let lookOk = false, lookVal = 'missing';
        try {
          const ap = state.scene.appearance ? state.scene.appearance() : null;
          lookOk = !!(ap && ap.count === 22 && ap.withAppearance === 22 && ap.maxMaterials <= 3);
          lookVal = ap ? ('with=' + ap.withAppearance + '/' + ap.count + ' mats=' + ap.maxMaterials + ' hair=' + (ap.hairStyles || []).length + ' h=' + JSON.stringify((ap.heights || []).slice(0, 4))) : 'missing';
        } catch (e) { lookVal = String(e && e.message); }
        note('matchLook', lookOk, lookVal);
        let lookU = false, lookUVal = 'missing';
        try {
          const ap = state.scene.appearance();
          lookU = ap.uniqueFaces >= 16;
          lookUVal = ap.uniqueFaces + '/' + ap.withAppearance + ' 种脸型组合';
        } catch (e) { lookUVal = String(e && e.message); }
        note('matchLookUnique', lookU, lookUVal);
        let lodOk = false, lodVal = 'missing';
        try {
          const full = state.scene.renderOnce();
          state.scene.setAllDetail('low');
          const low = state.scene.renderOnce();
          state.scene.setAllDetail('full');
          lodOk = full.calls > low.calls && low.calls > 0;
          lodVal = 'full ' + full.calls + ' → low ' + low.calls + ' (tris ' + full.triangles + ' → ' + low.triangles + ')';
        } catch (e) { lodVal = String(e && e.message); }
        note('matchLOD', lodOk, lodVal);
        // 进球链路：把球放进球门 → 下一帧 judgeExit('goal') → ms.goal → 比分 +1
        let goalOk = false, goalVal = 'missing';
        try {
          const before = state.scene.ai().score;
          state.scene.debugScoreGoal();
          await new Promise((res) => setTimeout(res, 700));
          const after = state.scene.ai().score;
          goalOk = after.home === before.home + 1;
          goalVal = before.home + '-' + before.away + ' → ' + after.home + '-' + after.away;
        } catch (e) { goalVal = String(e && e.message); }
        note('matchGoal', goalOk, goalVal);
        // 门将扑救：正对球门的一脚射门应被挡出（比分不变、save 计数 +1）
        let saveOk = false, saveVal = 'missing';
        try {
          const sc0 = state.scene.ai().score;
          const a0 = state.scene.actions().save || 0;
          state.scene.debugShotAtGoal();
          await new Promise((res) => setTimeout(res, 900));
          const a1 = state.scene.actions().save || 0;
          const sc1 = state.scene.ai().score;
          const dv = state.scene.actions().saveDive || 0;
          saveOk = a1 > a0 && sc1.home === sc0.home && sc1.away === sc0.away && dv > 0;
          saveVal = 'save ' + a0 + '→' + a1 + ' / dive ' + dv + ' / score ' + sc0.home + '-' + sc0.away + '→' + sc1.home + '-' + sc1.away;
        } catch (e) { saveVal = String(e && e.message); }
        note('matchSave', saveOk, saveVal);
        // 门将抱球 → 手抛球
        let throwOk = false, throwVal = 'missing';
        try {
          let t = 0;
          for (let i = 0; i < 14 && t === 0; i++) {
            await new Promise((res) => setTimeout(res, 250));
            t = state.scene.actions().keeperThrow || 0;
          }
          const h = state.scene.actions().gkHold || 0;
          throwOk = t > 0 && h > 0;
          throwVal = 'hold ' + h + ' / throw ' + t;
        } catch (e) { throwVal = String(e && e.message); }
        note('matchKeeperThrow', throwOk, throwVal);
        // 第一脚接球（第四阶段）：NPC 接管球权时要有接球姿态与质量评分（此前只有玩家有）
        let recOk = false, recVal = 'missing';
        try {
          const r0 = state.scene.debugNpcReceive();
          let n = r0.before || 0, pose = null;
          for (let i = 0; i < 24 && n === (r0.before || 0); i++) {
            await new Promise((res) => setTimeout(res, 150));
            n = state.scene.actions().npcReceive || 0;
            if (n > (r0.before || 0)) pose = state.scene.debugPoseOf(r0.id);
          }
          const q = state.scene.actions().npcReceiveQ || 0;
          recOk = n === (r0.before || 0) + 1 && q > 0.5 && !!(pose && pose.receive);
          recVal = r0.id + ' / npcReceive ' + (r0.before || 0) + '→' + n + ' / q ' + q + ' / pose ' + JSON.stringify(pose);
        } catch (e) { recVal = 'ERR ' + String(e && e.message); }
        note('matchReceive', recOk, recVal);
        // ── 抢断（本次新增）：无球时贴身抢断 → 计数 +1；成功则球权归玩家
        let tackleOk = false, tackleVal = 'missing';
        try {
          const t0 = state.scene.debugPlayerTackleNow();
          await new Promise((res) => setTimeout(res, 220));
          const st2 = state.scene.actions();
          const r = t0 && t0.result ? t0.result : null;
          const won = !!(r && (r.ok === true || r.reason));   // 抢断成功与否是概率，断言只要求"这次尝试真的执行了"
          tackleOk = !!(t0 && t0.ok && t0.before != null && st2.steal === t0.before + 1 && won);
          tackleVal = 'steal ' + (t0 && t0.before) + '→' + st2.steal + ' / ' + JSON.stringify(r) + ' / owner=' + (state.scene.playerOnBall() ? 'me' : 'other');
        } catch (e) { tackleVal = 'ERR ' + String(e && e.message); }
        note('matchPlayerTackle', tackleOk, tackleVal);

        // ── 玩家自己拿球（本次新增）：球滚到脚边 → ballTick 应把球权登记到玩家名下，
        //    出脚后 → 球权清空、最后触球改成玩家。
        //    旧实现两件都做不到：接管循环跳过 isUser（玩家整场都拿不到 ownerId，手机端射门键
        //    因此长期显示成滑铲键）；tryKick 从不写 ms.touch（球出边线时界外球/角球会判给上一位
        //    触球的 AI，方向可能正好反过来）。
        let ownOk = false, ownVal = 'missing';
        try {
          const d = state.scene.debugDropBallAtFeet();
          await new Promise((res) => setTimeout(res, 420));            // 留几帧给 ballTick 接管
          const owner = state.scene.ai().owner;
          const onBall = state.scene.playerOnBall();
          const poss = state.scene.matchState().possession;
          const kick = state.scene.debugPlayerKick(0.5);
          ownOk = !!(d && d.ok && owner && onBall
            && poss && poss.playerId === owner
            && kick && kick.ok === true
            && kick.owner === null
            && kick.lastTouch && kick.lastTouch.playerId === owner && kick.lastTouch.kind === 'userKick');
          ownVal = 'owner=' + owner + ' onBall=' + onBall + ' poss=' + (poss && poss.playerId)
            + ' kick=' + JSON.stringify(kick);
        } catch (e) { ownVal = 'ERR ' + String(e && e.message); }
        note('matchUserOwnBall', ownOk, ownVal);

        // ── 长传 / 传中（本次新增）：玩家踢出去的球必须真的离地。
        //    旧实现里 kickBall 只会拿到 back/inside/outside 三种触球面，垂直初速固定 +0.6 m/s，
        //    球最高点约 1.8 cm —— 挑传、传中、过顶、解围在玩家这边物理上就不可能。
        let loftOk = false, loftVal = 'missing';
        try {
          state.scene.debugDropBallAtFeet();
          await new Promise((res) => setTimeout(res, 420));
          const lp = state.scene.debugPlayerLongPass({ x: 0, z: 0 });   // 朝中圈方向约 30 m 的高球
          let apex = 0, flew = 0, from = null;
          for (let i = 0; i < 24; i++) {
            await new Promise((res) => setTimeout(res, 90));
            const b = state.scene.ballInfo();
            if (!from) from = { x: b.x, z: b.z };
            if (b.y > apex) apex = b.y;
            flew = Math.hypot(b.x - from.x, b.z - from.z);
          }
          loftOk = !!(lp && lp.ok && lp.lofted && lp.vy > 4 && apex > 2.5 && flew > 6);
          loftVal = 'kind=' + (lp && lp.kind) + ' 计划 apex=' + (lp && lp.apex) + ' m / vy=' + (lp && lp.vy)
            + ' → 实测最高 ' + apex.toFixed(2) + ' m · 水平 ' + flew.toFixed(1) + ' m';
        } catch (e) { loftVal = 'ERR ' + String(e && e.message); }
        note('matchUserLongPass', loftOk, loftVal);

        // ── 起跳 + 头球（本次新增）：玩家必须有垂直位移，并且能真的把球顶出去。
        //    旧实现两样都没有：headerTick 的候选循环第一行就跳过 isUser（玩家永远顶不到球），
        //    玩家也没有任何离地通道（ctrl.pos.y 从不参与运动/相机），所以"玩家头球"在系统里不存在。
        let headOk = false, headVal = 'missing';
        try {
          state.scene.debugDropBallAtFeet();          // 先把贴身对手挪开，保证争顶只发生在玩家身上
          await new Promise((res) => setTimeout(res, 320));
          const h0 = state.scene.actions().userHeader || 0;
          const ab = state.scene.debugAerialBall({ y: 2.0, dist: 0.9, speed: 6 });
          const jp = state.scene.debugPlayerJump();
          let peak = 0, seen = null;
          for (let i = 0; i < 16; i++) {
            await new Promise((res) => setTimeout(res, 60));
            const pa = state.scene.playerAir();
            if (pa.air > peak) peak = pa.air;
            // 一旦顶到就立刻记下"那一刻"的最后触球 —— 之后球会被门将扑出/被对手接走，
            // 等循环结束再读会把扑救记成"玩家的头球"（见过一次假失败）
            if (!seen && (state.scene.actions().userHeader || 0) > h0) {
              seen = state.scene.matchState().lastTouch;
            }
          }
          const h1 = state.scene.actions().userHeader || 0;
          headOk = !!(ab && ab.ok && jp && jp.ok && peak > 0.35 && h1 === h0 + 1
            && seen && typeof seen.kind === 'string' && seen.kind.indexOf('userHeader') === 0);
          headVal = '起跳峰值 ' + peak.toFixed(2) + ' m · userHeader ' + h0 + '→' + h1
            + ' · 顶到那一刻=' + (seen && seen.playerId) + '/' + (seen && seen.kind);
        } catch (e) { headVal = 'ERR ' + String(e && e.message); }
        note('matchUserHeader', headOk, headVal);

        // ── 滑铲（本次新增）：1.0–2.6m 内可下脚；铲空 → 自己倒地，倒地期间按住 W 也不能移动
        let slideOk = false, slideVal = 'missing';
        try {
          const s0 = state.scene.debugPlayerSlideNow();
          await new Promise((res) => setTimeout(res, 120));
          const st3 = state.scene.actions();
          const down0 = state.scene.playerDown();
          const p0 = state.scene.playerPos();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
          await new Promise((res) => setTimeout(res, 320));
          window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
          const p1 = state.scene.playerPos();
          const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
          slideOk = !!(s0 && s0.ok && s0.before != null && st3.slide === s0.before + 1 && down0.down === true && moved < 0.12);
          slideVal = 'slide ' + (s0 && s0.before) + '→' + st3.slide + ' / down ' + down0.down + '(' + down0.remain + 's) / moved ' + moved.toFixed(3) + 'm / ' + JSON.stringify(s0 && s0.result);
        } catch (e) { slideVal = 'ERR ' + String(e && e.message); }
        note('matchPlayerSlide', slideOk, slideVal);
        // 不在这里 kickoff：后续步骤各自会摆好球和站位，主动重置反而会打乱它们的场景

        // 门柱：撞柱后球改变方向、且不计分（读物理层命中瞬间的飞行记录，不是之后的带球速度）
        let postOk = false, postVal = 'missing';
        try {
          const p0 = state.scene.debugPostShot();
          let fh = p0.frameHit || 0, log = null;
          for (let i = 0; i < 30 && !log; i++) {
            await new Promise((res) => setTimeout(res, 150));
            fh = state.scene.actions().frameHit || 0;
            log = state.scene.debugFrameLog ? state.scene.debugFrameLog() : null;
          }
          const sc = state.scene.ai().score;
          const scored = sc.home === p0.score.home && sc.away === p0.score.away;
          postOk = !!log && log.kind === 'post' && Math.abs(log.vzBefore) > 4
            && Math.abs(log.vzAfter) < Math.abs(log.vzBefore) && log.zAfter > p0.goalZ && scored;
          postVal = 'frameHit ' + (p0.frameHit || 0) + '→' + fh + ' / hit ' + JSON.stringify(log) + ' / score ' + sc.home + '-' + sc.away;
          // 把球收回中圈：撞柱后球停在对方门前，会让后面的越位判定失去前置条件（球比接球者更靠门）
          state.scene.kickoff();
        } catch (e) { postVal = 'ERR ' + String(e && e.message); }
        note('matchPost', postOk, postVal);
        // 战术风格：切换 + 持久化（第八阶段）
        let tactOk = false, tactVal = 'missing';
        try {
          const s1 = state.scene.setTactics('press');
          const t1 = state.scene.tactics();
          const s2 = state.scene.setTactics('low');
          const t2 = state.scene.tactics();
          let persisted = null;
          try { persisted = localStorage.getItem('fw3d.style'); } catch (e) {}
          tactOk = s1 === 'press' && t1.style === 'press' && s2 === 'low' && t2.style === 'low' && persisted === 'low';
          tactVal = s1 + '→' + s2 + ' / stored=' + persisted;
          state.scene.setTactics('balanced');
        } catch (e) { tactVal = String(e && e.message); }
        note('matchTactics', tactOk, tactVal);
        // 越位判定（用真实球员位置构造，不伪造）
        let offOk = false, offVal = 'missing';
        try {
          const o = state.scene.debugOffsideNow();
          offOk = !!(o && o.ok && o.offside === true);
          offVal = o ? ('line ' + o.line + ' / z ' + o.testZ + ' / offside ' + o.offside) : 'missing';
        } catch (e) { offVal = String(e && e.message); }
        note('matchOffside', offOk, offVal);
        // 战术 UI：主界面下拉已移除，改为 3D 比赛内的 HUD 胶囊（#fw3d-tactics-hud）
        // 断言：①胶囊存在 ②文案里带当前风格 ③点击能真的换档（cycle 后 style 必须变化）
        try {
          const hud = document.getElementById('fw3d-tactics-hud');
          const t0 = state.scene.tactics ? state.scene.tactics().style : null;
          const before = hud ? hud.textContent : '';
          if (hud) hud.onclick && hud.onclick({});
          const t1 = state.scene.tactics ? state.scene.tactics().style : null;
          const after = hud ? hud.textContent : '';
          note('tacticsUI', !!(hud && t0 && t1 && t1 !== t0 && after !== before), hud ? ('hud "' + before.trim() + '" → "' + after.trim() + '" / ' + t0 + '→' + t1) : 'missing');
        } catch (e) { note('tacticsUI', false); }
        // 头顶姓名牌：①场上除玩家外都挂了牌 ②存在白/红两套队色 ③N 键三档循环
        try {
          const sc = state.scene;
          const st0 = sc.nameTagState ? sc.nameTagState() : null;
          const d0 = sc.nameTagDetail ? sc.nameTagDetail() : [];
          const colors = {};
          for (const x of d0) colors[x.tag.color] = (colors[x.tag.color] || 0) + 1;
          let modes = '';
          if (sc.cycleNameTags) {
            modes = [sc.cycleNameTags(), sc.cycleNameTags(), sc.cycleNameTags()].join(',');
          }
          const teamCount = d0.filter(function (x) { return x.tag.color === '#f4f7fa'; }).length;
          const foeCount = d0.filter(function (x) { return x.tag.color === '#e88079'; }).length;
          // 断言口径修正：注释写的是"除玩家外都挂了牌"，就该看 total（已建牌数）。
          // tagged 是"当前可见数"，开球时远端球员按距离规则隐藏（旧口径实测 13/21），
          // 用它判定会把正常表现误判成失败。可见性与缩放由 tools/probe_nameplates.js 单独覆盖。
          note('nameTags', !!(st0 && st0.total >= 18 && teamCount > 0 && foeCount > 0 && modes === 'team,off,all'),
            (st0 ? st0.total : 0) + ' 块（可见 ' + (st0 ? st0.tagged : 0) + '） · 白 ' + teamCount + '/红 ' + foeCount + ' · ' + modes);
        } catch (e) { note('nameTags', false, String(e && e.message)); }
        // 犯规 → 任意球 → 人墙（走真实路径）
        let foulOk = false, foulVal = 'missing';
        try {
          const f0 = state.scene.actions().foul || 0;
          const r = state.scene.debugFoulNow();
          await new Promise((res) => setTimeout(res, 350));
          const f1 = state.scene.actions().foul || 0;
          const ph = state.scene.matchState().phase;
          foulOk = f1 === f0 + 1 && ph === 'setPiece' && !!(r && r.wall && r.wall.length === 2);
          foulVal = 'foul ' + f0 + '→' + f1 + ' / phase ' + ph + ' / wall ' + (r && r.wall ? r.wall.length : '-');
        } catch (e) { foulVal = String(e && e.message); }
        note('matchFoul', foulOk, foulVal);
        // 红黄牌（第六阶段）：黄 → 两黄变红 → 罚下（场上人数 -1、模型隐藏、比分不变）
        let cardOk = false, cardVal = 'missing';
        try {
          const sc0 = state.scene.ai().score;
          const n0 = state.scene.ai().active || 22;
          const c1 = state.scene.debugCardNow('yellow', 'away');
          const c2 = state.scene.debugCardNow('yellow', 'away');
          const sc1 = state.scene.ai().score;
          cardOk = !!c1 && !!c2 && c1.ok && c1.book.y === 1 && c1.book.off === false
            && c2.book.y === 2 && c2.book.off === true && c2.sentOff.length === 1
            && c1.active === n0 && c2.active === n0 - 1
            && c2.visible === false
            // 罚下后整队重排成 10 人 4-4-1：客队守 +z → 5 人（门将+4 后卫）在 z>25，只有 1 个前锋在 z<0
            && Array.isArray(c2.formation) && c2.formation.length === 10
            && c2.formation.filter((p) => p[1] > 25).length === 5
            && c2.formation.filter((p) => p[1] < 0).length === 1
            && sc1.home === sc0.home && sc1.away === sc0.away;
          cardVal = (c1 && c1.id) + ' / 黄 ' + (c1 && c1.book.y) + '→' + (c2 && c2.book.y)
            + ' / 罚下 ' + (c2 && c2.book.off) + ' / 场上 ' + (c1 && c1.active) + '→' + (c2 && c2.active)
            + ' / 模型可见 ' + (c2 && c2.visible)
            + ' / 阵型 ' + (c2 && c2.formation ? c2.formation.length + '人(后场' + c2.formation.filter((p) => p[1] > 25).length + ',前场' + c2.formation.filter((p) => p[1] < 0).length + ')' : 'missing');
        } catch (e) { cardVal = 'ERR ' + String(e && e.message); }
        note('matchCard', cardOk, cardVal);
        // 手球（第六阶段最后一块规则）：球打在手臂上 → 对方任意球；判定含概率，最多重试 6 次
        let handOk = false, handVal = 'missing';
        try {
          let hb = 0, hid = null, tries = 0;
          for (let i = 0; i < 6 && hb === 0; i++) {
            const r = state.scene.debugHandNow('home');
            if (!r || !r.ok) break;
            hid = r.id;
            const before = r.before || 0;
            for (let k = 0; k < 8 && hb === before; k++) {
              await new Promise((res) => setTimeout(res, 120));
              hb = state.scene.actions().handball || 0;
            }
            tries = i + 1;
          }
          const ph = state.scene.matchState().phase;
          const last = state.scene.actions().lastHandball || null;
          handOk = hb > 0 && ph === 'setPiece' && !!last;
          handVal = (hid || '-') + ' / handball ' + hb + ' / phase ' + ph + ' / 重试 ' + tries + ' / ' + JSON.stringify(last);
        } catch (e) { handVal = 'ERR ' + String(e && e.message); }
        note('matchHand', handOk, handVal);
        // 点球（第六阶段收尾）：禁区内犯规 → 罚球点 → 2.4 s 后真实罚出 → 进/扑由物理决定
        let pkOk = false, pkVal = 'missing';
        try {
          const sc0 = state.scene.ai().score;
          const sv0 = state.scene.actions().save || 0;
          const r = state.scene.debugPenaltyNow('home');            // 主队在自家禁区犯规 → 客队罚点球
          let pk = 0, last = null;
          for (let i = 0; i < 90 && !pk; i++) {                     // 2.4 s 比赛时间 ≈ 5 s 真实时间
            await new Promise((res) => setTimeout(res, 150));
            pk = state.scene.actions().penalty || 0;
          }
          // 等结果：进球 或 扑救（都由真实链路产生）
          let outcome = 'none';
          for (let i = 0; i < 40 && outcome === 'none'; i++) {
            await new Promise((res) => setTimeout(res, 150));
            const sc = state.scene.ai().score;
            if (sc.home !== sc0.home || sc.away !== sc0.away) outcome = 'goal';
            else if ((state.scene.actions().save || 0) > sv0) outcome = 'save';
          }
          last = state.scene.actions().lastPenalty || null;
          const sc1 = state.scene.ai().score;
          // 没有进球也没有扑救：如果球高过横梁，那是"打飞了"（点球本来就允许打飞），算合法结果
          if (outcome === 'none' && last && last.aimY > 2.44) outcome = 'miss';
          pkOk = !!r && r.ok && r.box === true && pk >= 1 && !!last
            && (outcome === 'goal' || outcome === 'save' || outcome === 'miss')
            && last.aimSide >= -1 && last.aimSide <= 1 && last.keeperSide >= -1 && last.keeperSide <= 1;
          pkVal = (last ? last.taker + ' / 打' + last.aimSide + ' 门将猜' + last.keeperSide + ' 猜对 ' + last.guessRight + ' / 高 ' + last.aimY : '-')
            + ' / 结果 ' + outcome + ' / 比分 ' + sc0.home + '-' + sc0.away + '→' + sc1.home + '-' + sc1.away;
        } catch (e) { pkVal = 'ERR ' + String(e && e.message); }
        note('matchPenalty', pkOk, pkVal);
        // 点球大战（只限杯赛/淘汰赛）：每一脚都是真实罚球，轮次/先后/终止条件走 ai/shootout.js
        // **规定：联赛/友谊赛没有点球大战** —— 先验证默认（联赛）被拒绝，再验证杯赛能踢
        let soOk = false, soVal = 'missing';
        try {
          const comp = state.scene.competition();
          const leagueTry = await state.scene.debugShootout({ kind: 'league' });
          // 杯赛只有"总分平"才点球，所以这里显式传 1-1（真实接入时传两回合总分）
          const so = await state.scene.debugShootout({ kind: 'cup', first: 'home', scoreA: 1, scoreB: 1 });
          const leagueRefused = !!leagueTry && leagueTry.refused === true && /联赛/.test(leagueTry.reason || '');
          soOk = !!comp && comp.kind === 'league' && comp.allowsShootout === false
            && leagueRefused
            && !!so && so.done === true && (so.winner === 'home' || so.winner === 'away')
            && so.winnerGoals > so.loserGoals && so.kicksTotal >= 6
            && Array.isArray(so.log) && so.log.length === so.kicksTotal
            && so.kind === 'cup' && so.needsShootout === true;
          soVal = '默认赛事 ' + (comp && comp.kind) + '(可点球 ' + (comp && comp.allowsShootout) + ')'
            + ' / 联赛请求 ' + (leagueTry && leagueTry.reason)
            + ' / 杯赛 胜 ' + (so && so.winner) + ' ' + (so && so.goals ? so.goals.home + '-' + so.goals.away : '-')
            + ' / 轮 ' + (so && so.rounds) + ' / ' + (so && so.reason) + ' / 脚数 ' + (so && so.kicksTotal);
        } catch (e) { soVal = 'ERR ' + String(e && e.message); }
        note('matchShootout', soOk, soVal);
        // 停赛跨场累积（第六阶段）：牌面写进 FW.state.fw3dDiscipline（随存档），累计 3 黄 → 停赛
        let spOk = false, spVal = 'missing';
        try {
          const d0 = state.scene.discipline();
          const r = state.scene.debugSuspensionNow('away');
          const d1 = state.scene.discipline();
          spOk = !!r && r.ok === true && !!r.after && r.after.ban >= 1
            && r.after.yellow === 0                                  // 累计到 3 张后清零
            && d1.persisted === true && Array.isArray(d1.suspended) && d1.suspended.indexOf(r.id) >= 0
            && d1.counts.banned >= 1;
          spVal = (r && r.name) + ' / id ' + (r && r.id)
            + ' / 停赛 ' + (r && r.before ? r.before.ban : '-') + '→' + (r && r.after ? r.after.ban : '-')
            + ' / 累计黄 ' + (r && r.after ? r.after.yellow : '-')
            + ' / 档案球员 ' + (d1 && d1.counts ? d1.counts.players : '-')
            + ' / 停赛人数 ' + (d1 && d1.counts ? d1.counts.banned : '-')
            + ' / 已入存档 ' + (d1 && d1.persisted);
        } catch (e) { spVal = 'ERR ' + String(e && e.message); }
        note('matchSuspension', spOk, spVal);
        // 铲球（P0 动画）：走真实 doSlideTackle —— 滑铲动作在播、铲完倒地一段时间、球被打出去或犯规
        let slOk = false, slVal = 'missing';
        try {
          const r = state.scene.debugSlideNow('away');           // 客队后卫对主队持球者滑铲
          let pose = r && r.pose ? r.pose : null;
          // 下一帧再读一次姿态（debugSlideNow 内部已经播了滑铲）
          await new Promise((res) => setTimeout(res, 120));
          const again = state.scene.actions().lastSlide || null;
          slOk = !!r && r.ok === true && (r.slide | 0) >= 1
            && !!pose && (pose.oneshot === 'slide' || again)
            && (!r.win || !r.foul)          // 同一脚不可能既铲到球又犯规
            && (r.downUntil || 0) > 0;
          slVal = (r && r.tackler) + ' 铲 ' + (r && r.carrier)
            + ' / 动作 ' + (pose && pose.oneshot) + ' t=' + (pose && pose.oneshotT)
            + ' / 铲到球 ' + (r && r.win) + ' / 犯规 ' + (r && r.foul)
            + ' / 倒地至 ' + (r && r.downUntil) + ' / 计数 ' + (r && r.slide);
        } catch (e) { slVal = 'ERR ' + String(e && e.message); }
        note('matchSlide', slOk, slVal);
        // 裁判（P0 建模）：场上有主裁、会跟随球、会亮牌（牌真的出现在右手）
        let rfOk = false, rfVal = 'missing';
        try {
          const before = state.scene.refereeInfo();
          const carded = state.scene.debugRefCard('red');
          await new Promise((res) => setTimeout(res, 120));
          const after = state.scene.refereeInfo();
          const pose = after && after.pose ? after.pose : null;
          rfOk = !!before && before.present === true && Math.abs(before.x) <= 34 && Math.abs(before.z) <= 52.5
            && !!carded && carded.ok === true
            && !!pose && (pose.oneshot === 'card' || pose.card === 'red')
            && after.card === 'red';
          rfVal = '裁判 (' + (before && before.x) + ',' + (before && before.z) + ')'
            + ' / 动作 ' + (pose && pose.oneshot) + ' / 手里的牌 ' + (after && after.card)
            + ' / 距球跟随 ' + (before && before.speed);
          state.scene.debugRefCard('yellow');
        } catch (e) { rfVal = 'ERR ' + String(e && e.message); }
        note('matchReferee', rfOk, rfVal);
        // 界外球（P1 动画）：球出边线 → 判界外球 → 最近的队友走到边线 → 掷球进场（有掷球动作）
        let thOk = false, thVal = 'missing';
        try {
          const award = state.scene.debugThrowInNow();
          const thrown = state.scene.debugThrowNow();
          await new Promise((res) => setTimeout(res, 150));
          const lastTI = state.scene.actions().lastThrowIn || null;
          const sp = lastTI ? lastTI.speed : 0;              // 出手瞬间的速度（之后会被场地阻尼吃掉）
          const pose = thrown && thrown.pose ? thrown.pose : null;
          thOk = !!award && award.ok === true && award.type === 'throwIn' && !!award.takerId
            && !!thrown && thrown.ok === true && (thrown.throwIn | 0) >= 1
            && sp > 6 && thrown.ball.y > 0.5
            && !!pose && (pose.oneshot === 'throwIn' || pose.oneshot === 'receive' || pose.oneshot === null);
          thVal = '掷球者 ' + (award && award.takerId) + ' → ' + (thrown && thrown.to)
            + ' / 距离 ' + (thrown && thrown.dist) + ' m / 出手 ' + sp + ' m/s / 球高 ' + (thrown && thrown.ball && thrown.ball.y)
            + ' / 动作 ' + (pose && pose.oneshot);
        } catch (e) { thVal = 'ERR ' + String(e && e.message); }
        note('matchThrowIn', thOk, thVal);
        // 点球助跑（P1 动画）：主罚者退到球后 2.2 m → 助跑 0.5 s → 门将压低重心
        let ruOk = false, ruVal = 'missing';
        try {
          const ru = state.scene.debugRunUpNow('home');
          const back = ru && ru.takerZ != null && ru.spotZ != null ? Math.abs(ru.takerZ - ru.spotZ) : 0;
          ruOk = !!ru && ru.ok === true && (ru.runUp | 0) >= 1 && back > 1.2
            && !!ru.pose && ru.pose.oneshot === 'runUp'
            && !!ru.gkPose && ru.gkPose.oneshot === 'crouch';
          ruVal = '主罚者 ' + (ru && ru.taker) + ' / 球后 ' + back.toFixed(1) + ' m'
            + ' / 动作 ' + (ru && ru.pose && ru.pose.oneshot)
            + ' / 门将 ' + (ru && ru.gkPose && ru.gkPose.oneshot) + ' / 计数 ' + (ru && ru.runUp);
        } catch (e) { ruVal = 'ERR ' + String(e && e.message); }
        note('matchRunUp', ruOk, ruVal);
        // 边裁（P2）：两名边裁在两条边线上，越位/界外球时举旗
        let lmOk = false, lmVal = 'missing';
        try {
          const before = state.scene.linesmenInfo();
          const flagged = state.scene.debugLinesmanFlag('offside', 4);
          await new Promise((res) => setTimeout(res, 120));
          const after = state.scene.linesmenInfo();
          const pose = flagged && flagged.info ? flagged.info.pose : null;
          const onLine = Array.isArray(before) && before.length === 2
            && before.every((l) => Math.abs(l.x) > 34)                                  // 站在边线外（halfW = 34）
            && before.every((l) => l.hasFlag === true && l.flagVisible === true);        // 手里必须有旗
          lmOk = onLine && !!flagged && flagged.ok === true
            && !!pose && pose.oneshot === 'flag'
            && Array.isArray(after) && after.some((l) => l.flagged === 'offside');
          lmVal = '边裁 ' + (before.length) + ' 名 / x ' + (before[0] && before[0].x) + ',' + (before[1] && before[1].x)
            + '（边线 34，站外侧）/ 有旗 ' + (before[0] && before[0].hasFlag) + ' 可见 ' + (before[0] && before[0].flagVisible)
            + ' / 旗语 ' + (flagged && flagged.kind) + ' / 动作 ' + (pose && pose.oneshot);
        } catch (e) { lmVal = 'ERR ' + String(e && e.message); }
        note('matchLinesman', lmOk, lmVal);
        // 进球庆祝镜头（P2，用户要求"切第三视角 + 实况感"）：远景 → 近景 → 拉回
        let ceOk = false, ceVal = 'missing';
        try {
          // 自检时间预算：把时钟拨回 20 分钟，避免庆祝镜头（3.8 s）把比赛拖到 90 分钟自动关场景
          state.scene.debugSetMinute(20);
          const ce = state.scene.debugCelebration('home');
          // 等远景段（phase < 0.75）
          let wide = null;
          for (let i = 0; i < 20; i++) {
            await new Promise((res) => setTimeout(res, 120));
            wide = state.scene.cameraInfo();
            if (wide && wide.fov === 58) break;
          }
          // 等近景段（phase 0.75–2.6）
          let close = null;
          for (let i = 0; i < 40; i++) {
            await new Promise((res) => setTimeout(res, 150));
            close = state.scene.cameraInfo();
            if (close && close.fov === 40) break;
          }
          const eye = wide ? wide.playerEye : { x: 0, z: 0 };
          const dWide = wide ? Math.hypot(wide.x - eye.x, wide.z - eye.z) : 0;
          const dClose = close ? Math.hypot(close.x - eye.x, close.z - eye.z) : 0;
          ceOk = !!ce && ce.ok === true && !!ce.scorerId && !!wide && !!close
            && wide.celebrating === true && wide.fov === 58 && wide.y > 7
            && close.celebrating === true && close.fov === 40 && close.y < 3 && dClose < dWide;
          ceVal = '进球者 ' + (ce && ce.scorerId)
            + ' / 远景 fov ' + (wide && wide.fov) + ' h ' + (wide && wide.y) + ' 距玩家 ' + (wide && wide.y ? dWide.toFixed(1) : '-')
            + ' → 近景 fov ' + (close && close.fov) + ' h ' + (close && close.y) + ' 距玩家 ' + (close && close.fov ? dClose.toFixed(1) : '-');
          // 收尾：等庆祝结束（最多 8 s），确保镜头还给第一人称，不影响后面的输入自检
          for (let i = 0; i < 55; i++) {
            const c = state.scene.cameraInfo();
            if (!c || !c.celebrating) break;
            await new Promise((res) => setTimeout(res, 150));
          }
        } catch (e) { ceVal = 'ERR ' + String(e && e.message); }
        note('matchCelebration', ceOk, ceVal);
        // 换人（P3）：体力/时间到阈值 → 同位置替补登场；场上仍是 11 人，被换下的模型消失
        let subOk = false, subVal = 'missing';
        try {
          state.scene.debugSetMinute(62);          // 换人窗口（>55 分钟）
          const b0 = state.scene.benchInfo();
          // 前置：把一名主队球员体力压到 18（模拟末段疲劳），让 pickSub 的"体力偏低"条件成立
          const drained = state.scene.debugDrain('home', 18);
          const r = state.scene.debugSubNow('home');
          const b1 = state.scene.benchInfo();
          subOk = !!r && r.ok === true && (r.subs | 0) >= 1
            && r.activeBefore === r.activeAfter          // 换人不改变场上人数（被换下的不计入、替补计入）
            && !!r.onName && r.onVisible === true && b0.home.bench.length > 0
            && b1.agents > b0.agents && b1.home.subs === b0.home.subs + 1;
          subVal = '疲劳 ' + (drained && drained.name) + '(' + (drained && drained.stamina) + ')'
            + ' / 换下 ' + (r && r.off) + ' → 换上 ' + (r && r.onName)
            + ' / 场上 ' + (r && r.activeBefore) + '→' + (r && r.activeAfter)
            + ' / 名额 ' + (b0.home.subs) + '→' + (b1.home.subs)
            + ' / 名单 ' + (b0.home.bench.length) + ' 人 / 原因 ' + (r && r.reason);
        } catch (e) { subVal = 'ERR ' + String(e && e.message); }
        note('matchSub', subOk, subVal);
        // 玩家运动模型 A/B（第二阶段）：默认仍走旧模型，这里给出可比数字，便于决定是否切换
        let pmOk = false, pmVal = 'missing';
        try {
          const ab = state.scene.playerMotorAB();
          pmOk = !!ab && ab.enabled === false && ab.legacy.top > 4 && ab.motor.top > 4
            && ab.legacy.t80 <= ab.motor.t80 && ab.legacy.stop < 4 && ab.motor.stop < 4
            // 电机 + 属性补偿（ARCADE_TUNING）必须比裸电机更快、起步更快，否则切换没有意义
            && !!ab.tuned && ab.tuned.top > ab.motor.top && ab.tuned.t80 < ab.motor.t80;
          pmVal = 'enabled ' + ab.enabled + ' / legacy ' + JSON.stringify(ab.legacy) + ' / motor ' + JSON.stringify(ab.motor) + ' / tuned ' + JSON.stringify(ab.tuned);
        } catch (e) { pmVal = 'ERR ' + String(e && e.message); }
        note('playerMotor', pmOk, pmVal);
        close();
      } catch (e) { note('matchOpen', false); }

      // ── 输入层（本专项）：电脑端「鼠标 → 视角」与手机端「触摸 → 视角 / 摇杆 → 位移」
      //    断言的是真实链路：合成浏览器 PointerEvent 打进画布 → 场景 update 消费增量 → ctrl.yaw/pos 变化。
      //    电脑端额外用 __FW3D_NO_POINTER_LOCK 强制走拖拽分支：无头环境指针锁定会吞掉合成的 pointermove。
      try {
        close();
        window.__FW3D_NO_POINTER_LOCK = true;
        const rd = await open({});
        await waitFrames(8);
        const cvs = document.querySelector('#fw3d-root canvas');
        const mk = (type, opt) => new PointerEvent(type, Object.assign({
          bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: 1, pointerId: 1,
        }, opt || {}));
        const v0 = state.scene.inputView();
        cvs.dispatchEvent(mk('pointerdown', { clientX: 640, clientY: 400 }));
        // 拖拽 200 px：0.0024 rad/px × 200 ≈ 0.48 rad，远大于阈值
        document.dispatchEvent(mk('pointermove', { clientX: 740, clientY: 400 }));
        document.dispatchEvent(mk('pointermove', { clientX: 840, clientY: 400 }));
        await waitFrames(3);
        const v1 = state.scene.inputView();
        window.dispatchEvent(mk('pointerup', { buttons: 0 }));
        const dInfo = state.scene.inputDebug();
        // 上下视角：拖拽 120 px 应让 pitch 变化；再狠推一次应被 ±0.9 夹住
        cvs.dispatchEvent(mk('pointerdown', { clientX: 640, clientY: 400 }));
        document.dispatchEvent(mk('pointermove', { clientX: 640, clientY: 280 }));
        await waitFrames(3);
        const v2 = state.scene.inputView();
        document.dispatchEvent(mk('pointermove', { clientX: 640, clientY: -2000 }));
        await waitFrames(3);
        const v3 = state.scene.inputView();
        window.dispatchEvent(mk('pointerup', { buttons: 0 }));
        const desOk = !!(rd && rd.ok) && dInfo.mobile === false
          && Math.abs(v1.yaw - v0.yaw) > 0.25          // 鼠标横向真正带动了视角
          && Math.abs(v2.pitch - v1.pitch) > 0.10      // 纵向也能抬头/低头
          // 俯仰被夹在 ±0.9 之间（不会翻过头）。注意方向：鼠标上移 = 抬头 = pitch 正，
          // 所以这里只断言「绝对值贴住上限」，不写死正负。
          && Math.abs(v3.pitch) >= 0.89 && Math.abs(v3.pitch) <= 0.91;
        note('inputDesktop', desOk,
          'mobile ' + dInfo.mobile + ' / yaw ' + v0.yaw + '→' + v1.yaw + ' / pitch ' + v1.pitch + '→' + v2.pitch + '→' + v3.pitch);

        // 手机端：强制触摸判据重开一次球场，验证「触摸 UI 建立 + 拖动看四周 + 摇杆推进」
        close();
        window.__FW3D_FORCE_MOBILE = true;
        const rm = await open({});
        await waitFrames(8);
        const cvs2 = document.querySelector('#fw3d-root canvas');
        const mkm = (type, opt) => new PointerEvent(type, Object.assign({
          bubbles: true, cancelable: true, pointerType: 'touch', button: 0, buttons: 1, pointerId: 7,
        }, opt || {}));
        const dm = state.scene.inputDebug();
        const vm0 = state.scene.inputView();
        // ① 右半屏滑动（x=900 > 45% 宽）→ 视角
        cvs2.dispatchEvent(mkm('pointerdown', { clientX: 900, clientY: 400 }));
        cvs2.dispatchEvent(mkm('pointermove', { clientX: 1000, clientY: 400, pointerId: 7 }));
        await waitFrames(3);
        const vm1 = state.scene.inputView();
        cvs2.dispatchEvent(mkm('pointerup', { pointerId: 7, buttons: 0 }));
        // ② 左摇杆前推（x=70 < 45% 宽）→ 位移
        cvs2.dispatchEvent(mkm('pointerdown', { clientX: 70, clientY: 600, pointerId: 8 }));
        cvs2.dispatchEvent(mkm('pointermove', { clientX: 70, clientY: 520, pointerId: 8 }));
        await waitFrames(14);          // 14 帧 × dt(≤0.05) ≈ 0.7 s 模拟时间，慢机器上也推得动
        const vm2 = state.scene.inputView();
        const dStick = state.scene.inputDebug();
        cvs2.dispatchEvent(mkm('pointerup', { pointerId: 8, buttons: 0 }));
        const walked = Math.hypot(vm2.x - vm1.x, vm2.z - vm1.z);
        // 触屏键位布局（本次改动）：长传键必须在，护球键必须不在（它被长传取代了）；
        // 传球键的文案只能是「短传 / 抢断」两种之一。
        const longBtn = document.querySelector('#fw3d-b-long');
        const shieldBtn = document.querySelector('#fw3d-b-shield');
        const passBtn = document.querySelector('#fw3d-b-pass');
        const passLabel = passBtn ? passBtn.textContent : null;
        const layoutOk = !!longBtn && !shieldBtn
          && (passLabel === '短传' || passLabel === '抢断');
        const mobOk = !!(rm && rm.ok) && dm.mobile === true && dm.hasUI === true
          && Math.abs(vm1.yaw - vm0.yaw) > 0.20      // 滑动带动了视角
          && walked > 0.15                          // 摇杆把人推动了
          && dStick.stick.active === true
          && layoutOk;
        note('inputMobile', mobOk,
          'mobile ' + dm.mobile + ' ui ' + dm.hasUI + ' / yaw ' + vm0.yaw + '→' + vm1.yaw
          + ' / walk ' + walked.toFixed(2) + ' m / stick ' + JSON.stringify(dStick.stick)
          + ' / 长传键 ' + !!longBtn + ' 护球键 ' + !!shieldBtn + ' 传球键文案 ' + passLabel);

        // ── 命中容错（本次改动）：按在"视觉圆之外 5 px"也必须算按到这颗键。
        //    旧实现的指针目标就是那颗小圆本身，差几像素就漏给画布 ——
        //    表现是"按了射门却是视角在转"，这是触屏最容易被抱怨的不精准。
        let slopOk = false, slopVal = 'missing';
        try {
          const shootEl = document.querySelector('#fw3d-b-shoot');
          const disc = document.querySelector('[data-hit-for="fw3d-b-shoot"]');
          const sr = shootEl.getBoundingClientRect();
          const cx = sr.left + sr.width / 2, cy = sr.top + sr.height / 2;
          // 朝「冲刺」那一侧偏出 5 px：离射门圆心 37 px，仍比冲刺更近，必须判给射门
          disc.dispatchEvent(mkm('pointerdown', { clientX: cx + sr.width / 2 + 5, clientY: cy, pointerId: 21 }));
          await new Promise((res) => setTimeout(res, 80));
          const pressedOutside = shootEl.dataset.pressed === '1';
          disc.dispatchEvent(mkm('pointerup', { clientX: cx + sr.width / 2 + 5, clientY: cy, pointerId: 21, buttons: 0 }));
          await new Promise((res) => setTimeout(res, 60));
          slopOk = pressedOutside && shootEl.dataset.pressed !== '1';
          slopVal = '外扩 5px 按下=' + pressedOutside + ' / 抬起后=' + (shootEl.dataset.pressed || '未按住')
            + ' / 视觉直径 ' + Math.round(sr.width) + 'px 命中圆 ' + (disc ? Math.round(disc.getBoundingClientRect().width) : 0) + 'px';
        } catch (e) { slopVal = 'ERR ' + String(e && e.message); }
        note('inputHitSlop', slopOk, slopVal);
        window.__FW3D_FORCE_MOBILE = null;
        window.__FW3D_NO_POINTER_LOCK = false;
        close();
      } catch (e) {
        note('inputDesktop', false, String(e && e.message));
        note('inputMobile', false, String(e && e.message));
        try { window.__FW3D_FORCE_MOBILE = null; window.__FW3D_NO_POINTER_LOCK = false; } catch (e2) {}
      }

      close();
      note('closed', !state.active);
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    out.pass = out.steps.every((x) => x.ok);
    console.log('[FW3D selftest]', JSON.stringify(out));
    window.__FW3D_SELFTEST = out;
    return out;
  }

  window.FW3D = {
    version: VERSION,
    available: state.available,
    isEnabled: state.isEnabled,
    setEnabled: state.setEnabled,
    open, close, toggle,
    setDifficulty: (k) => (window.FW && FW.setDifficulty ? FW.setDifficulty(k) : false),
    lookDown: (v) => (state.scene && state.scene.lookDown ? state.scene.lookDown(v) : null),
    actions: () => (state.scene && state.scene.actions ? state.scene.actions() : null),
    quality: () => (state.scene && state.scene.quality ? state.scene.quality() : null),
    controlMode: () => (state.scene && state.scene.controlMode ? state.scene.controlMode() : null),
    setControlMode: (m) => (state.scene && state.scene.setControlMode ? state.scene.setControlMode(m) : null),
    keyMomentActive: () => (state.scene && state.scene.keyMomentActive ? state.scene.keyMomentActive() : false),
    appearance: () => loadAppearance(),
    setAppearance: (a) => saveAppearance(Object.assign({}, loadAppearance(), a || {})),
    // [players-subsystem] 任意球员的确定性外观查询（2D 界面/调试/外部系统用）
    // 参数可以是 id 字符串，也可以是球员记录（推荐：传记录才能用上 position/age 先验）。
    // 同一个记录永远返回同一套外观；真实球员会叠加 real-likeness 覆盖。
    appearanceOf: async (player, kit) => {
      try {
        const A = await import('./players/appearance.js');
        const R = await import('./players/real-likeness.js');
        const rec = (player && typeof player === 'object') ? Object.assign({}, player) : { id: String(player) };
        if (rec.id == null) return null;
        rec.id = String(rec.id);
        return A.appearanceFor(rec, { overrides: R.likenessOf(rec), kit: kit || null });
      } catch (e) { return null; }
    },
    restartMatch: () => { close(); try { return window.FW && FW.restartLastMatch ? FW.restartLastMatch() : null; } catch (e) { return null; } },
    celebrate: () => (state.scene && state.scene.celebrate ? state.scene.celebrate() : null),
    teleportToBall: () => (state.scene && state.scene.teleportToBall ? state.scene.teleportToBall() : null),
    scene: () => state.scene,
    selftest: runSelfTest,
    setScore: (t) => { window.__FW3D_SCORE = t; },
    setTimeline: (tl) => { window.__FW3D_TIMELINE = tl; if (tl && tl.score) window.__FW3D_SCORE = tl.score.home + ' - ' + tl.score.away; },
    autoTimeline: () => { try { const tl = window.FW && FW.matchTimeline ? FW.matchTimeline() : null; if (tl) FW3D.setTimeline(tl); return tl; } catch (e) { return null; } },
    canRun: () => detect() && location.protocol !== 'file:',
    status: () => ({ supported: state.supported, enabled: state.enabled, active: state.active, fps: (window.__FW3D_FPS || 0), error: state.error ? String(state.error.message || state.error) : null }),
  };
})();
