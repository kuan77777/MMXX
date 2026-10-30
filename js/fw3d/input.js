// FW3D · 统一输入层（电脑端 / 手机端）
//
// 为什么要这一层：
//   旧实现（arena.js 内联）只有「按住左键拖拽」一条路 —— 用户按 PC 习惯直接移动鼠标时毫无反应，
//   于是表现为「电脑端无法通过鼠标转动视角」；手机端则完全没有触摸输入，只能看不能走。
//
// 现在的约定：
//   电脑端 —— 点击画面进入指针锁定（Pointer Lock），锁定后移动鼠标即可转头、无需按住任何键；
//             指针锁定不可用 / 被浏览器拒绝 / 用户按 Esc 释放时，自动退回「按住左键拖拽」，不黑屏、不失效。
//   手机端 —— 左下虚拟摇杆移动、右半屏滑动看向四周、右下动作键（射门/传球/冲刺/护球/检视）。
//             多点触控：一根手指走路、另一根转头可以同时进行。
//
// 设计约束（遵循项目总控，勿破坏）：
//   · 本模块只产出「输入意图」，不直接改相机、不碰物理与 AI —— 场景每帧自己取用。
//   · 零依赖、不引外部资源；关掉 3D 后对 2D 没有任何影响。
//   · 回滚：arena.js 删掉 createInput(...) 与 update() 里的取用，即可回到旧的纯拖拽实现。

const DEFAULTS = {
  sensDesktop: 0.0024,     // 弧度 / 像素（指针锁定与拖拽共用）
  sensTouch: 0.0046,       // 手机滑动灵敏度（手指行程更短，给大一点）
  dragThreshold: 2,        // 小于该位移不算转头，避免「点击/锁定」时画面抖一下
  lockSkipFrames: 1,       // 刚锁定时浏览器偶尔给一个巨大位移，丢弃第一帧
  joystickRadius: 58,      // 摇杆最大行程（px）
  joystickDead: 0.16,      // 死区（占半径比例），避免走路时手抖
  stickLookAssist: 0,      // 预留：摇杆推到边缘时轻微带动视角（默认关）
};

// 是否为触摸设备：供 boot.js（入口形态）与 arena.js（画质/提示）共用同一判据。
export function isTouchDevice() {
  try {
    if (window.__FW3D_FORCE_MOBILE != null) return !!window.__FW3D_FORCE_MOBILE;
    const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
    const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    const small = (window.innerWidth || 1200) < 760;
    // 有触摸 + (粗指针 或 窄屏) 才算手机；带触摸屏的笔记本仍按电脑处理（指针锁定更好用）
    return !!(touch && (coarse || small));
  } catch (e) { return false; }
}

function safeGet(storageKey, fallback) {
  try {
    const v = localStorage.getItem(storageKey);
    const n = Number(v);
    return v != null && isFinite(n) && n > 0 ? n : fallback;
  } catch (e) { return fallback; }
}

export function createInput(opts) {
  const o = opts || {};
  const el = o.el || null;                 // 渲染画布（接收指针锁定与触摸）
  const host = o.host || (el && el.parentNode) || document.body;
  const onKey = typeof o.onKey === 'function' ? o.onKey : function () {};   // 动作键 → 复用键盘逻辑
  // 场景回调：玩家当前是否持球（决定「射门↔滑铲」「传球↔抢断」两个双语义键）
  const onBallFn = typeof o.playerOnBall === 'function' ? o.playerOnBall : function () { return false; };
  const mobile = o.mobile != null ? !!o.mobile : isTouchDevice();
  const D = Object.assign({}, DEFAULTS, o.tuning || {});

  // 灵敏度可持久化（设置里以后要加滑杆只需写这个 key）
  const sensMul = safeGet('fw3d.sensitivity', 1);

  const state = {
    mobile: mobile,
    locked: false,
    dragging: false,
    portrait: false,               // 手机/平板竖屏时为 true（会弹横屏遮罩并暂停输入）
    spectate: false,               // 自由观赛：只影响提示文案与「起身/坐下」键的显隐
    look: { dx: 0, dy: 0 },        // 待消费的视角增量（弧度）
    move: { x: 0, y: 0 },          // 摇杆向量，x=右、y=前，范围 [-1,1]
    sprint: false,
    lookTouches: 0,
    errors: [],
  };

  let disposed = false;
  const listeners = [];            // [target, type, fn, options]，dispose 时统一摘除
  function on(target, type, fn, options) {
    if (!target) return;
    target.addEventListener(type, fn, options);
    listeners.push([target, type, fn, options]);
  }
  function noteError(where, e) {
    // 输入失效不应该让游戏崩：记下来给自检/控制台看
    state.errors.push(where + ': ' + ((e && e.message) || e));
    if (state.errors.length > 12) state.errors.shift();
  }

  // ─────────────────────────────────────────────────────────────
  // 视角：桌面与手机共用的唯一出口
  // ─────────────────────────────────────────────────────────────
  function addLook(dx, dy) {
    state.look.dx += dx;
    state.look.dy += dy;
  }

  // 场景每帧调用一次；返回并清空累计增量（弧度）
  function takeLook() {
    const r = { dx: state.look.dx, dy: state.look.dy };
    state.look.dx = 0; state.look.dy = 0;
    return r;
  }

  // ─────────────────────────────────────────────────────────────
  // 电脑端：指针锁定（主）+ 按住左键拖拽（兜底）
  // ─────────────────────────────────────────────────────────────
  let lastX = 0, lastY = 0, dragMoved = false, skipUntil = 0;

  function requestLock() {
    if (!el || state.locked || !el.requestPointerLock) return false;
    // 自检缝隙：无头环境里指针锁定成功后会吞掉合成的 pointermove（movementX 恒为 0），
    // 让「拖拽兜底」路径无法被确定性验证。设此标志即强制走拖拽分支；真实浏览器不受影响。
    if (window.__FW3D_NO_POINTER_LOCK) return false;
    try {
      // 新版 Chrome 支持 unadjustedMovement（关掉系统鼠标加速，手感更稳）
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(function () {
          // 不支持 unadjustedMovement → 退回普通锁定；再失败就安静地走拖拽
          try {
            const p2 = el.requestPointerLock();
            if (p2 && typeof p2.catch === 'function') p2.catch(function (e) { noteError('lock2', e); });
          } catch (e) { noteError('lock2', e); }
        });
      }
      return true;
    } catch (e) {
      noteError('lock', e);
      return false;
    }
  }

  function onPointerDownDesktop(e) {
    if (e.pointerType === 'touch') return;          // 触摸走手机分支
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    lastX = e.clientX; lastY = e.clientY; dragMoved = false;
    if (!state.locked) {
      // 第一次点击：先尝试锁定。锁定失败也没关系 —— 下面的拖拽逻辑照旧生效。
      requestLock();
      state.dragging = true;
      try { if (el.setPointerCapture && e.pointerId != null) el.setPointerCapture(e.pointerId); } catch (err) {}
    }
  }

  function onPointerMoveDesktop(e) {
    if (e.pointerType === 'touch') return;
    if (state.locked) {
      // 锁定态：movementX/Y 是浏览器给的相对位移，鼠标可以无限移动
      if (skipUntil > 0) { skipUntil--; return; }
      const mx = e.movementX != null ? e.movementX : 0;
      const my = e.movementY != null ? e.movementY : 0;
      if (mx || my) addLook(mx * D.sensDesktop * sensMul, my * D.sensDesktop * sensMul);
      return;
    }
    if (!state.dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (!dragMoved) {
      if (Math.abs(dx) + Math.abs(dy) < D.dragThreshold) return;
      dragMoved = true;
    }
    addLook(dx * D.sensDesktop * sensMul, dy * D.sensDesktop * sensMul);
    lastX = e.clientX; lastY = e.clientY;
    updateHint();
  }

  function endDrag() {
    state.dragging = false;
    dragMoved = false;
  }

  function syncLockState() {
    const locked = !!document.pointerLockElement && document.pointerLockElement === el;
    if (locked && !state.locked) skipUntil = D.lockSkipFrames;
    state.locked = locked;
    updateHint();
  }

  // ─────────────────────────────────────────────────────────────
  // 手机端：虚拟摇杆 + 右半屏滑动 + 动作键
  // ─────────────────────────────────────────────────────────────
  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0, active: false };
  const lookPtr = { id: null, x: 0, y: 0 };

  function isMoveZone(e) {
    // 左 45% 屏幕起手 = 走路；其余 = 转视角（右下动作键是独立 DOM，会 stopPropagation）
    return e.clientX < (window.innerWidth || 1200) * 0.45;
  }

  function onTouchDown(e) {
    if (!state.mobile || disposed) return;
    try { e.preventDefault(); } catch (err) {}
    if (stick.id == null && isMoveZone(e)) {
      stick.id = e.pointerId; stick.active = true;
      stick.ox = e.clientX; stick.oy = e.clientY;
      stick.x = 0; stick.y = 0;
      // 指针捕获：手指拖到画布外（或划过某个按钮）时 pointermove 仍然回到画布。
      // 没有这一步的话，视角/摇杆会在手指经过 DOM 元素的那几帧"静默失灵"——这正是
      // 「滑到一半视角不动了」这类不精准的来源。
      try { if (el.setPointerCapture) el.setPointerCapture(e.pointerId); } catch (err) {}
      placeStickBase(stick.ox, stick.oy);
      moveKnob(0, 0);
      return;
    }
    if (lookPtr.id == null) {
      lookPtr.id = e.pointerId; lookPtr.x = e.clientX; lookPtr.y = e.clientY;
      state.lookTouches = 1;
      try { if (el.setPointerCapture) el.setPointerCapture(e.pointerId); } catch (err) {}
    }
  }

  function onTouchMove(e) {
    if (!state.mobile) return;
    if (e.pointerId === stick.id) {
      try { e.preventDefault(); } catch (err) {}
      let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
      const len = Math.hypot(dx, dy);
      const R = D.joystickRadius;
      if (len > R) { dx = dx / len * R; dy = dy / len * R; }
      moveKnob(dx, dy);
      let nx = dx / R, ny = dy / R;
      // 死区归零，避免抖；出死区后重新归一化到 0..1，手感连续
      if (Math.hypot(nx, ny) < D.joystickDead) { nx = 0; ny = 0; }
      stick.x = nx; stick.y = ny;
      state.move.x = nx;
      state.move.y = -ny;          // 屏幕向下为正 → 前进取反
      state.sprint = Math.hypot(nx, ny) > 0.90;   // 推到边缘即冲刺（手机没有 Shift）；0.90 而不是 0.86，少一点误触发
      return;
    }
    if (e.pointerId === lookPtr.id) {
      try { e.preventDefault(); } catch (err) {}
      addLook((e.clientX - lookPtr.x) * D.sensTouch * sensMul, (e.clientY - lookPtr.y) * D.sensTouch * sensMul);
      lookPtr.x = e.clientX; lookPtr.y = e.clientY;
    }
  }

  function onTouchUp(e) {
    if (e.pointerId === stick.id) {
      stick.id = null; stick.active = false;
      stick.x = 0; stick.y = 0;
      state.move.x = 0; state.move.y = 0;
      state.sprint = false;
      hideStick();
      return;
    }
    if (e.pointerId === lookPtr.id) {
      lookPtr.id = null;
      state.lookTouches = 0;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 手机端 UI：摇杆 + 动作键（全部注入到 host，pointer-events 只在按键上开）
  // ─────────────────────────────────────────────────────────────
  let ui = null;
  let sitBtnEl = null;          // 「起身/坐下」键的视觉元素（仅自由观赛显示）
  let jumpBtnEl = null;         // 「起跳」键的视觉元素（仅比赛显示，与「起身」互斥占同一个位置）
  let sitRec = null, jumpRec = null;   // 上面两颗键的记录（显隐要同时切视觉圆与命中圆）
  let hintEl = null;
  let rotateEl = null;          // 竖屏遮罩（手机/平板横屏要求）
  let uiScale = 1;              // 触屏布局缩放（由 buildTouchUI 按屏幕短边算出，供归位等函数复用）

  function buildTouchUI() {
    if (!state.mobile || ui || !host) return;
    ui = document.createElement('div');
    ui.id = 'fw3d-touch';
    // 整层不吃事件（pointer-events:none），只有具体按键/摇杆图形吃事件
    ui.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4;'
      + 'font:600 12px/1 system-ui,-apple-system,sans-serif;user-select:none;-webkit-user-select:none;'
      + '-webkit-tap-highlight-color:transparent';

    // ── 触屏缩放：平板上的按钮必须更大，否则"按不准"。
    //    基准取可视区短边（旋转不变：手机横竖都是 ~390，平板 ~768），手机上≈1.0、平板上≈1.45。
    const vmin = Math.min(window.innerWidth || 1200, window.innerHeight || 700);
    const SCALE = Math.max(0.9, Math.min(1.45, vmin / 400));
    uiScale = SCALE;
    const px = (n) => Math.max(1, Math.round(n * SCALE));
    // 摇杆半径也跟着放大（只改半径；死区/冲刺阈值都是比例值，手感等比放大）
    D.joystickRadius = px(D.joystickRadius);
    const B = 'env(safe-area-inset-bottom,0px)';
    const R = (n) => 'right:' + px(n) + 'px;';
    const U = (n) => 'bottom:calc(' + px(n) + 'px + ' + B + ');';

    // 摇杆底座与把手（空闲时在左下角做「可摇」的可视提示）
    const base = document.createElement('div');
    base.id = 'fw3d-stick';
    base.style.cssText = 'position:absolute;width:' + (D.joystickRadius * 2) + 'px;height:' + (D.joystickRadius * 2) + 'px;'
      + 'border-radius:50%;border:1px solid rgba(255,255,255,.14);'
      + 'background:radial-gradient(circle at 50% 45%,rgba(26,33,43,.55),rgba(10,14,20,.42));'
      + 'box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 8px 20px rgba(0,0,0,.22);'
      + '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);'
      + 'left:' + px(26) + 'px;bottom:calc(' + px(30) + 'px + env(safe-area-inset-bottom,0px));pointer-events:none;'
      + 'opacity:.62;transition:opacity .12s,left .12s,bottom .12s,width .12s,height .12s';
    const knob = document.createElement('div');
    knob.id = 'fw3d-stick-knob';
    const knobPx = px(40);
    knob.style.cssText = 'position:absolute;left:50%;top:50%;width:' + knobPx + 'px;height:' + knobPx + 'px;'
      + 'margin:' + (-knobPx / 2) + 'px 0 0 ' + (-knobPx / 2) + 'px;'
      + 'border-radius:50%;border:1px solid rgba(255,255,255,.34);'
      // 别做太亮：白色高光把手会被误看成场上的足球，这里压成中性灰玻璃
      + 'background:radial-gradient(circle at 38% 32%,rgba(255,255,255,.72),rgba(190,204,220,.44) 55%,rgba(140,156,176,.30) 100%);'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.30),inset 0 1px 2px rgba(255,255,255,.36)';
    base.appendChild(knob);
    ui.appendChild(base);

    // ── 动作键视觉语言：中性深色磨砂玻璃 + 发丝描边（不用 saturate，否则会把草地绿吸进按钮里）
    //    每个键一种高饱和彩色描边会被读成"功能说明书"；现在统一单色，
    //    只有主键（右下·冲刺）描边更亮一档，字号/字距一致，整体更安静。
    const GLASS = {
      primary: 'background:linear-gradient(180deg,rgba(24,31,42,.80),rgba(13,18,25,.64));'
        + 'border:1px solid rgba(255,255,255,.44);'
        + 'box-shadow:0 12px 28px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.20)',
      normal: 'background:linear-gradient(180deg,rgba(21,27,36,.64),rgba(12,17,23,.48));'
        + 'border:1px solid rgba(255,255,255,.20);'
        + 'box-shadow:0 8px 20px rgba(0,0,0,.30),inset 0 1px 0 rgba(255,255,255,.12)',
      ghost: 'background:rgba(14,19,26,.42);border:1px solid rgba(255,255,255,.14);'
        + 'box-shadow:0 6px 16px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.08)',
    };
    // 按下不做"闪白"（廉价感），改成整体压暗一档 + 描边提亮 + 轻微缩小
    const PRESSED = { primary: 'rgba(54,66,82,.92)', normal: 'rgba(46,57,72,.90)', ghost: 'rgba(38,47,60,.86)' };
    // 命中容错：手指的落点按"视觉圆 ×1.5"来判（直径多出半个键宽，约 12–28 px）。
    // 这样"差一点没按到"仍然算按到；两个键都够得着时取离得最近的那一颗。
    const HIT_MUL = 1.5;

    const BTNS = [];   // 全部动作键（顺序 = 布局顺序；命中判定要用同一份数字）
    let setBtnVisible = null;

    // 动作键：btn(id, 文案, 直径, 距右, 距下, 视觉级别, 按下, 抬起)
    // 返回值是"视觉圆"（自检按 id 查的就是它）；命中层是另一颗更大的透明圆，盖在它上面。
    const btn = (id, label, size, right, bottom, variant, onDown, onUp) => {
      const v = variant || 'normal';
      const sizePx = px(size), rightPx = px(right), bottomPx = px(bottom);
      const b = document.createElement('div');
      b.id = id;
      b.textContent = label;
      b.dataset.variant = v;
      b.style.cssText = 'position:absolute;display:flex;align-items:center;justify-content:center;'
        + 'border-radius:50%;pointer-events:none;touch-action:none;'
        + 'width:' + sizePx + 'px;height:' + sizePx + 'px;' + R(right) + U(bottom)
        + 'color:rgba(255,255,255,.94);font-weight:' + (v === 'primary' ? '600' : '500') + ';'
        + 'font-size:' + Math.max(11, Math.round(sizePx * 0.19)) + 'px;letter-spacing:.10em;'
        // 字距会在末尾多出空隙，往右补同样距离才能视觉居中
        + 'text-indent:.10em;'
        + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);'
        + 'transition:transform .12s ease,background .12s ease,box-shadow .12s ease,border-color .12s ease;'
        + GLASS[v];
      ui.appendChild(b);

      // 透明命中圆：直径 = 视觉圆 × HIT_MUL，圆心对齐视觉圆。
      // 触屏真正的指针目标，视觉圆不再吃事件（pointer-events:none）——
      // 判定只在这一处，避免"看起来按到了但事件落在别处"。
      const hitSize = Math.round(sizePx * HIT_MUL);
      const hit = document.createElement('div');
      hit.dataset.hitFor = id;
      hit.style.cssText = 'position:absolute;border-radius:50%;background:transparent;'
        + 'pointer-events:auto;touch-action:none;'
        + 'width:' + hitSize + 'px;height:' + hitSize + 'px;'
        + R(rightPx + sizePx / 2 - hitSize / 2) + U(bottomPx + sizePx / 2 - hitSize / 2);
      ui.appendChild(hit);

      const rec = { id, el: b, hit, size: sizePx, right: rightPx, bottom: bottomPx, variant: v, down: onDown, up: onUp, visible: true };
      BTNS.push(rec);

      const press = () => {
        if (b.dataset.pressed === '1') return;
        b.dataset.pressed = '1';
        b.style.transform = 'scale(.95)';
        b.style.background = PRESSED[v];
        b.style.borderColor = 'rgba(255,255,255,.5)';
        try { if (navigator.vibrate) navigator.vibrate(6); } catch (e) {}   // 手感确认（支持的设备才有）
        onDown && onDown();
      };
      const release = () => {
        if (b.dataset.pressed !== '1') return;
        delete b.dataset.pressed;
        b.style.transform = '';
        b.style.background = '';
        b.style.borderColor = '';
        onUp && onUp();
      };

      // 命中判定：以所有可见键的视觉圆心算距离，取最近的一颗。
      // 这样即使两颗键的命中圆重叠，也只会落到"更近的那颗"，不会走漏。
      const nearest = (ev) => {
        const box = ui.getBoundingClientRect();
        const x = ev.clientX - box.left, y = ev.clientY - box.top;
        let best = null, bestD = Infinity;
        for (const r of BTNS) {
          if (!r.visible) continue;
          const cx = box.width - (r.right + r.size / 2);
          const cy = box.height - (r.bottom + r.size / 2);
          const d = Math.hypot(x - cx, y - cy);
          if (d <= r.size * (HIT_MUL / 2) && d < bestD) { bestD = d; best = r; }
        }
        return best;
      };
      // 捕获指针：手指按住后轻微滑出圆外不再取消动作（旧实现 pointerleave 就抬手，
      // 于是"按住射门蓄力"经常被几像素的滑动打断，力度忽高忽低）。
      hit.addEventListener('pointerdown', (ev) => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        const t = nearest(ev) || rec;
        if (!t.visible) return;
        try { hit.setPointerCapture(ev.pointerId); } catch (e) {}
        t.el.dataset.heldBy = String(ev.pointerId);
        t.press ? t.press() : press();
      });
      hit.addEventListener('pointerup', (ev) => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        // 只抬起这颗指针按住的那颗键（多指同时按住两个键时不能互相打断）
        for (const r of BTNS) {
          if (r.el.dataset.heldBy === String(ev.pointerId)) {
            delete r.el.dataset.heldBy;
            r.release ? r.release() : release();
          }
        }
        try { hit.releasePointerCapture(ev.pointerId); } catch (e) {}
      });
      hit.addEventListener('pointercancel', (ev) => {
        for (const r of BTNS) {
          if (r.el.dataset.heldBy === String(ev.pointerId)) {
            delete r.el.dataset.heldBy;
            r.release ? r.release() : release();
          }
        }
      });
      rec.press = press;
      rec.release = release;
      return b;
    };

    // ── 布局：右手拇指为圆心，排成两列（贴角一列 + 内收一列），主键落在右下最好按的位置。
    //    之所以不再散着摆：五个同色圆一旦不等距就看不出主次，两列对齐后视线有规律、也更好按。
    // ── 贴角列（右）
    // 主键 · 右下：冲刺（按住加速；摇杆推到底也会自动冲刺）
    btn('fw3d-b-sprint', '冲刺', 78, 24, 26, 'primary',
      () => { state.sprint = true; pressKey('shift'); },
      () => { state.sprint = false; releaseKey('shift'); });
    // 传球/抢断（同一颗键）：有球=F 短传（会给最有价值的队友），无球=抢断（E，贴身才生效）
    // 文案：有球时叫「短传」，无球时叫「抢断」—— 两个动作的语义差别很大，用同一个词会误导。
    btn('fw3d-b-pass', '短传', 56, 34, 118, 'normal',
      () => { if (onBallFn()) pressKey('f'); else pressWindowKey('e'); },
      () => { releaseKey('f'); });
    // 检视 = V（第三人称环绕，看自己的动作）
    btn('fw3d-b-orbit', '视角', 44, 40, 188, 'ghost',
      () => pressWindowKey('v'), () => {});
    // ── 内收列（左）
    // 射门/滑铲（同一颗键）：有球=按住蓄力射门（出脚方式可能是头球，见 arena 的 tryKick），无球=滑铲
    let shootHeld = false;
    btn('fw3d-b-shoot', '射门', 64, 118, 40, 'normal',
      () => {
        if (onBallFn()) { shootHeld = true; pressKey(' '); }
        else { shootHeld = false; pressWindowKey('x'); }
      },
      () => { if (shootHeld) { shootHeld = false; releaseKey(' '); } });
    // 长传/传中 = G（一定离地；边路进攻三区自动改判为传中）
    // 触屏上这颗键**取代了护球键**：护球（Q）在触屏上很少用，而长传是"真实踢一场"绕不过去的动作。
    btn('fw3d-b-long', '长传', 50, 112, 116, 'normal',
      () => pressKey('g'), () => releaseKey('g'));
    // 起跳 = J（空中球靠它够到 2.25 m 以上的头球点；顶到球就是头球）
    // 与「起身」共用一个位置，由 spectate() 按模式互斥显示。
    jumpBtnEl = btn('fw3d-b-jump', '起跳', 50, 40, 246, 'ghost',
      () => pressKey('j'), () => releaseKey('j'));
    // 起身/坐下 = C（只有自由观赛模式会显示；其它模式这键没有意义，默认隐藏）
    sitBtnEl = btn('fw3d-b-sit', '起身', 50, 40, 246, 'ghost',
      () => pressWindowKey('c'), () => {});
    // 显隐：视觉圆与命中圆必须一起切，否则会出现"看不见却能按到"的幽灵热区
    setBtnVisible = (rec, on) => {
      if (!rec) return;
      if (!on && rec.el.dataset.pressed === '1') { delete rec.el.dataset.pressed; rec.release && rec.release(); }
      rec.visible = !!on;
      rec.el.style.display = on ? 'flex' : 'none';
      rec.hit.style.display = on ? 'block' : 'none';
    };
    jumpRec = BTNS.find((r) => r.id === 'fw3d-b-jump') || null;
    sitRec = BTNS.find((r) => r.id === 'fw3d-b-sit') || null;
    setBtnVisible(sitRec, false);

    // 手机端提示条（与桌面 fw3d-tip 区分，放在画面上方，避免被摇杆挡住）
    hintEl = document.createElement('div');
    hintEl.id = 'fw3d-touch-hint';
    hintEl.style.cssText = 'position:absolute;left:50%;top:calc(56px + env(safe-area-inset-top,0px));transform:translateX(-50%);'
      + 'max-width:86vw;text-align:center;padding:7px 14px;border-radius:10px;'
      + 'background:rgba(10,14,20,.62);border:1px solid rgba(255,255,255,.10);color:rgba(232,238,248,.88);'
      + '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);'
      + 'font:500 11.5px/1.5 system-ui,sans-serif;letter-spacing:.02em;opacity:.92;transition:opacity .2s';
    hintEl.dataset.base = '左摇杆移动 · 右半屏滑动看四周 · 按住冲刺加速 · 射门蓄力 · 短传/长传';
    hintEl.textContent = hintEl.dataset.base;
    ui.appendChild(hintEl);

    host.appendChild(ui);
    // 触摸层一旦建立，就让画布不吃浏览器默认手势（滚动/双击缩放）
    try { el.style.touchAction = 'none'; } catch (e) {}
  }

  function placeStickBase(x, y) {
    if (!ui) return;
    const b = ui.querySelector('#fw3d-stick');
    if (!b) return;
    const R = D.joystickRadius;
    b.style.left = (x - R) + 'px';
    b.style.top = (y - R) + 'px';
    b.style.bottom = 'auto';
    b.style.width = (R * 2) + 'px';
    b.style.height = (R * 2) + 'px';
    b.style.opacity = '1';
  }
  function moveKnob(dx, dy) {
    if (!ui) return;
    const k = ui.querySelector('#fw3d-stick-knob');
    if (k) k.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }
  function hideStick() {
    if (!ui) return;
    const b = ui.querySelector('#fw3d-stick');
    if (!b) return;
    // 归位坐标也要跟着缩放，否则平板上大摇杆会贴到屏幕边角外面
    b.style.left = Math.round(26 * uiScale) + 'px';
    b.style.top = 'auto';
    b.style.bottom = 'calc(' + Math.round(30 * uiScale) + 'px + env(safe-area-inset-bottom,0px))';
    b.style.opacity = '.5';
    moveKnob(0, 0);
  }

  // 动作键 → 复用场景的键盘处理（不改任何玩法逻辑）
  function fakeEvent(key) {
    return { key: key, repeat: false, preventDefault: function () {}, stopPropagation: function () {}, synthetic: 'fw3d-touch' };
  }
  function pressKey(key) { try { onKey(fakeEvent(key), true); } catch (e) { noteError('press:' + key, e); } }
  function releaseKey(key) { try { onKey(fakeEvent(key), false); } catch (e) { noteError('release:' + key, e); } }
  // 少数快捷键注册在 window 上（如 V 检视），不在场景的 onKey 里 —— 这类要发真实按键事件。
  function pressWindowKey(key) {
    try { window.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true })); }
    catch (e) { noteError('winkey:' + key, e); }
  }

  // ─────────────────────────────────────────────────────────────
  // 双语义键文案：只在「有球/无球」切换时改 DOM（每帧调用也不会抖动）
  let ballUiState = null;
  function syncBallUi(force) {
    const now = force == null ? !!onBallFn() : !!force;
    if (now === ballUiState) return now;
    ballUiState = now;
    if (!ui) return now;
    const sh = ui.querySelector('#fw3d-b-shoot');
    const ps = ui.querySelector('#fw3d-b-pass');
    if (sh) sh.textContent = now ? '射门' : '滑铲';
    if (ps) ps.textContent = now ? '短传' : '抢断';
    if (hintEl) {
      hintEl.textContent = now
        ? '有球：射门（按住蓄力）· 短传 · 长传 · 冲刺'
        : '无球：滑铲 · 抢断 · 冲刺 · 起跳';
    }
    return now;
  }

  // 提示文案（桌面/手机不同）
  // ─────────────────────────────────────────────────────────────
  function hintText() {
    if (state.mobile) {
      if (state.spectate) return '左摇杆走动 · 右半屏滑动看四周 · 右下「起身/坐下」切换';
      return '左摇杆移动 · 右半屏滑动看四周 · 按住冲刺加速 · 射门蓄力 · 短传/长传 · 起跳';
    }
    if (state.spectate) {
      return state.locked
        ? '鼠标已锁定：移动鼠标转头 · WASD 走动 · C 坐/站 · Esc 释放鼠标'
        : '点击画面锁定鼠标（移动即可转头）· 也可按住左键拖拽 · C 坐/站 · Esc 退出';
    }
    return state.locked
      ? '鼠标已锁定：移动鼠标转头 · Esc 释放鼠标 · Shift 冲刺 · 空格蓄力射门 · F 短传 · G 长传 · J 起跳 · X 滑铲 · E 抢断 · Q 护球'
      : '点击画面锁定鼠标（移动即可转头）· 也可按住左键拖拽 · Esc 退出';
  }
  function updateHint() {
    if (state.mobile) {
      // 手机端只用自带的 #fw3d-touch-hint：底部那条 #fw3d-tip 会被动作键压住（截图验收确认过），
      // 队伍/球场信息已经在顶栏 stat 里，这里不再重复拼进去。
      if (hintEl) hintEl.textContent = hintText();
      return;
    }
    const tip = document.getElementById('fw3d-tip');
    if (tip && !tip.dataset.tipHidden) {
      const extra = tip.dataset.extra ? (' · ' + tip.dataset.extra) : '';
      tip.textContent = hintText() + extra;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 事件绑定
  // ─────────────────────────────────────────────────────────────
  if (el) {
    on(el, 'pointerdown', state.mobile ? onTouchDown : onPointerDownDesktop);
    on(el, 'contextmenu', function (e) { e.preventDefault(); });
    // 触摸在 el 上处理；桌面在 document 上收 movementX（锁定后事件也可能落在 document）
    if (state.mobile) {
      on(el, 'pointermove', onTouchMove, { passive: false });
      on(window, 'pointerup', onTouchUp);
      on(window, 'pointercancel', onTouchUp);
    } else {
      on(document, 'pointermove', onPointerMoveDesktop);
      on(window, 'pointerup', endDrag);
      on(window, 'pointercancel', endDrag);
      on(document, 'pointerlockchange', syncLockState);
      on(document, 'pointerlockerror', function () { noteError('pointerlockerror', { message: '浏览器拒绝指针锁定，已回退拖拽' }); state.locked = false; updateHint(); });
    }
  }

  // 切标签页/失焦：清掉所有按键状态，避免「一直往前跑」
  on(window, 'blur', function () {
    state.move.x = 0; state.move.y = 0; state.sprint = false;
    state.dragging = false;
    stick.id = null; stick.active = false; lookPtr.id = null;
    if (ui) { hideStick(); }
    try { onKey(fakeEvent('w'), false); onKey(fakeEvent('a'), false); onKey(fakeEvent('s'), false); onKey(fakeEvent('d'), false); onKey(fakeEvent('shift'), false); } catch (e) {}
  });

  buildTouchUI();
  if (!state.mobile) {
    // 桌面：在画布上给一个明确的「点击锁定」可点性
    try { el.style.cursor = 'crosshair'; } catch (e) {}
  }
  // 手机/平板：窗口尺寸变化、旋转、可视区域变化都要重新判断横竖屏
  on(window, 'resize', syncOrientation);
  on(window, 'orientationchange', syncOrientation);
  if (window.visualViewport && window.visualViewport.addEventListener) {
    on(window.visualViewport, 'resize', syncOrientation);
  }
  syncOrientation();
  updateHint();

  // ─────────────────────────────────────────────────────────────
  // 横屏要求（手机 / 平板）：3D 按横屏设计
  //   ① 能锁就锁：全屏 + screen.orientation.lock('landscape')（Android Chrome 支持）
  //   ② 锁不了（iOS Safari 不支持 lock）就退化成「竖屏遮罩」，提示把设备横过来，
  //      并停掉移动/视角，避免竖屏下摇杆和动作键挤在一起、画面被裁。
  // ─────────────────────────────────────────────────────────────
  function isPortrait() {
    try {
      const w = window.innerWidth || 0, h = window.innerHeight || 0;
      return h > w * 1.06;
    } catch (e) { return false; }
  }

  function buildRotateOverlay() {
    if (!host) return null;
    const d = document.createElement('div');
    d.id = 'fw3d-rotate';
    d.style.cssText = 'position:absolute;inset:0;z-index:9;display:none;flex-direction:column;'
      + 'align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px;'
      + 'background:linear-gradient(160deg,#0b1018,#060a0f);color:#e8eef8;'
      + 'font:600 15px/1.5 system-ui,-apple-system,sans-serif';
    d.innerHTML = '<div style="width:84px;height:56px;border-radius:10px;border:2px solid rgba(255,255,255,.55);'
      + 'position:relative;animation:fw3d-rot 1.6s ease-in-out infinite">'
      + '<span style="position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#8fd0ff"></span>'
      + '</div>'
      + '<div style="font-size:19px">请横屏游玩</div>'
      + '<div style="font-size:12.5px;opacity:.72;max-width:280px;line-height:1.6">'
      + '把手机/平板横过来：横屏下左手是摇杆、右手是动作键，视野也更宽</div>'
      + '<div style="font-size:11.5px;opacity:.5" id="fw3d-rotate-hint">若画面没有自动转过来，请关闭系统的「竖屏锁定」</div>';
    // 旋转动画（不引外部资源）
    try {
      const st = document.createElement('style');
      st.textContent = '@keyframes fw3d-rot{0%,100%{transform:rotate(0)}50%{transform:rotate(-90deg)}}';
      document.head.appendChild(st);
    } catch (e) {}
    host.appendChild(d);
    return d;
  }

  function syncOrientation() {
    if (!state.mobile) return;
    const portrait = isPortrait();
    state.portrait = portrait;
    if (portrait) {
      if (!rotateEl) rotateEl = buildRotateOverlay();
      if (rotateEl) rotateEl.style.display = 'flex';
      // 竖屏不接受移动/视角，避免「能动但画面是歪的」
      state.move.x = 0; state.move.y = 0; state.sprint = false;
      stick.id = null; stick.active = false;
      lookPtr.id = null;
      if (ui) hideStick();
    } else if (rotateEl) {
      rotateEl.style.display = 'none';
    }
    if (hintEl) hintEl.style.opacity = portrait ? '0' : '.92';
  }

  // 进入 3D 时尽力申请横屏：必须在用户手势里调用
  function requestLandscape() {
    const out = { fullscreen: false, locked: false };
    try {
      const rootEl = document.getElementById('fw3d-root');
      if (rootEl && rootEl.requestFullscreen) {
        const p = rootEl.requestFullscreen({ navigationUI: 'hide' });
        if (p && p.then) p.then(lockLandscape).catch(function () { /* 用户拒绝/不支持 → 用竖屏遮罩兜底 */ });
        else { out.fullscreen = true; lockLandscape(); }
      }
    } catch (e) { noteError('fullscreen', e); }
    function lockLandscape() {
      try {
        const so = window.screen && window.screen.orientation;
        if (so && so.lock) {
          const lp = so.lock('landscape');
          if (lp && lp.then) lp.then(function () { out.locked = true; }).catch(function () {});
        }
      } catch (e) { noteError('orientlock', e); }
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // 对外接口
  // ─────────────────────────────────────────────────────────────
  return {
    isMobile: () => state.mobile,
    isLocked: () => state.locked,
    // 横屏要求：手机/平板里 true 表示当前是竖屏（已弹遮罩、输入已暂停）
    isPortrait: () => !!state.portrait,
    requestLandscape,
    takeLook,
    move: () => ({ x: state.move.x, y: state.move.y }),
    sprinting: () => state.sprint,
    hintText,
    refreshHint: updateHint,
    setExtraHint(text) {
      const tip = document.getElementById('fw3d-tip');
      if (tip) tip.dataset.extra = text || '';
      updateHint();
    },
    // 自检/调试：不经过真实指针即可读到内部状态
    debug: () => ({
      mobile: state.mobile,
      locked: state.locked,
      portrait: !!state.portrait,
      hasRotateOverlay: !!rotateEl,
      dragging: state.dragging,
      lookTouches: state.lookTouches,
      move: { x: +state.move.x.toFixed(2), y: +state.move.y.toFixed(2) },
      sprint: state.sprint,
      stick: { active: stick.active, x: +stick.x.toFixed(2), y: +stick.y.toFixed(2) },
      hasUI: !!ui,
      errors: state.errors.slice(),
      sensMul: sensMul,
    }),
    // 自检专用：直接注入视角增量（验证「增量 → 相机」这条链路，不依赖浏览器指针锁定）
    testLook(dx, dy) { addLook(Number(dx) || 0, Number(dy) || 0); return { dx: state.look.dx, dy: state.look.dy }; },
    // 场景每帧调用：有球/无球变化时切换两个动作键的文案与行为提示
    ballState(v) { return syncBallUi(v); },
    // 自由观赛：显示/隐藏「起身/坐下」键，并切换提示文案（不改任何玩法逻辑）
    // 「起跳」与「起身」同一个视觉位置（观赛时你不在场上，起跳没有意义），按模式互斥显示。
    // 显隐必须走 setBtnVisible：视觉圆和命中圆要一起切，否则会留下"看不见却能按到"的热区。
    spectate(on) {
      state.spectate = !!on;
      if (setBtnVisible) {
        setBtnVisible(sitRec, !!on);
        setBtnVisible(jumpRec, !on);
      }
      updateHint();
      return state.spectate;
    },
    /** 按钮文案跟着坐/站翻转（arena 在 sitDown/standUp 里调） */
    sitLabel(seated) { if (sitBtnEl) sitBtnEl.textContent = seated ? '起身' : '坐下'; },
    // 自检专用：模拟摇杆（验证「摇杆 → 位移」这条链路）
    testStick(x, y) {
      state.move.x = Number(x) || 0; state.move.y = Number(y) || 0;
      state.sprint = Math.hypot(state.move.x, state.move.y) > 0.90;
      return { x: state.move.x, y: state.move.y, sprint: state.sprint };
    },
    // 释放指针锁定（退出 3D / 关闭场景时调用，避免残留在别的界面）
    unlock() {
      try { if (document.pointerLockElement === el && document.exitPointerLock) document.exitPointerLock(); } catch (e) {}
    },
    dispose() {
      disposed = true;
      this.unlock();
      for (const [t, type, fn, options] of listeners) {
        try { t.removeEventListener(type, fn, options); } catch (e) {}
      }
      listeners.length = 0;
      if (ui && ui.parentNode) ui.parentNode.removeChild(ui);
      ui = null; hintEl = null;
    },
  };
}
