// 输入层：键盘/鼠标 → 游戏动作。指针锁定 + 边缘触发（pressed）与持续态（held）分开，
// 这样"按住 Shift 冲刺"和"按一下 V 切视角"不会互相干扰。
// 触屏：只做最小支持（虚拟摇杆由 UI 层可选用），不作为第一版验收项。
//
// 键位设计上的硬约束（都是踩过的坑）：
//   1. 不能用 Ctrl / Alt / Meta 当游戏键。浏览器快捷键（Ctrl+W 关标签页、Ctrl+1..4 切标签页、
//      Ctrl+R 刷新、Ctrl+S 保存网页）里有一部分根本无法被 preventDefault 拦下来，
//      而玩家蹲着往前走（Ctrl+W）恰好就会触发它。蹲伏因此只用 C。
//   2. Esc 不能依赖 keydown：指针锁定时 Chrome 会把 Esc 吞掉（只退出指针锁定，不派发按键）。
//      所以"Esc 暂停"是用 pointerlockchange 的"锁定丢失 → 自动暂停"来实现的（见 consumeLockLost）。
//   3. 窗口失焦必须清掉 held，否则按着 W 切出去再回来，人会一直往前跑。

export const KEYMAP = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  // 只留 C：ControlLeft 会和浏览器快捷键打架（见文件头第 1 条）
  crouch: ['KeyC'],
  reload: ['KeyR'],
  // 死亡界面的 R 立刻重生（UI 上的文案与这里对应）
  respawn: ['KeyR'],
  interact: ['KeyE'],
  // F 是备用交互键：E 是主交互键（搜刮/开门/对话/上下车），F 留给以后的长按操作，
  // 这样两个键不会因为抢同一类动作而互相干扰。
  use: ['KeyF'],
  inventory: ['Tab', 'KeyI'],
  // M：小地图 / 大地图（大地图打开时 WASD 改成平移、滚轮改成缩放，见 game.js）
  map: ['KeyM'],
  pause: ['Escape'],
  toggleView: ['KeyV'],
  flashlight: ['KeyL'],
  quicksave: ['F5'],
  quickload: ['F9'],
  weapon1: ['Digit1', 'Numpad1'],
  weapon2: ['Digit2', 'Numpad2'],
  weapon3: ['Digit3', 'Numpad3'],
  weapon4: ['Digit4', 'Numpad4'],
  weapon5: ['Digit5', 'Numpad5'],
  weapon6: ['Digit6', 'Numpad6'],
  melee: ['KeyQ'],
  drop: ['KeyG'],
};

// 这些键有浏览器默认行为（切焦点 / 滚动 / 刷新页面），按下时必须 preventDefault。
const PREVENT_DEFAULT = new Set([
  'Tab', 'Space', 'F5', 'F9',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** 焦点在输入控件里时不要抢键，也不要拦默认行为（设置面板以后加文本框时不会踩坑）。 */
function isTypingTarget(el) {
  if (!el) return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export class Input {
  constructor(target = (typeof window !== 'undefined' ? window : null)) {
    this.target = target;
    this.doc = null;
    this._win = null;
    this.held = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    // 指针锁定是否可用：只有真正支持时才要求"先锁定再开火"，
    // 避免在不支持/被拒绝的环境里把射击彻底锁死。
    this.lockSupported = false;
    this.enabled = true;
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this._lockLost = false;
    this._onKeyDown = null;
    this._onKeyUp = null;
    this._onMouseDown = null;
    this._onMouseUp = null;
    this._onMouseMove = null;
    this._onWheel = null;
    this._onLockChange = null;
    this._onContext = null;
    this._onBlur = null;
    this._onVisibility = null;
    this.attach();
  }

  /** 目标可以是 window（带 .document），也可以直接是 document（Node 单测里用假实现）。 */
  _resolveDoc() {
    const t = this.target;
    if (t && t.document && typeof t.document.addEventListener === 'function') return t.document;
    if (t && typeof t.addEventListener === 'function' && typeof t.createElement === 'function') return t;
    if (typeof document !== 'undefined' && document) return document;
    return null;
  }

  attach() {
    const doc = this._resolveDoc();
    if (!doc) return;
    this.doc = doc;
    // blur 只能挂在 window 上；target 是 document 时回退到全局 window
    const win = this.target && this.target.document === doc && typeof this.target.addEventListener === 'function'
      ? this.target
      : (typeof window !== 'undefined' && window.document === doc ? window : null);
    this._win = win;
    const lower = (e) => e.code || e.key;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (isTypingTarget(e.target)) return;
      const code = lower(e);
      // Tab 会切走焦点、空格/方向键会让面板滚动、F5/F9 会刷新页面，全部拦掉
      if (PREVENT_DEFAULT.has(code) && typeof e.preventDefault === 'function') e.preventDefault();
      if (e.repeat) return;
      this.held.add(code);
      this.pressed.add(code);
    };
    this._onKeyUp = (e) => {
      const code = lower(e);
      this.held.delete(code);
      this.released.add(code);
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      // 没锁定指针时的按下只用于"请求锁定"（画面 click 会做），不能顺手开一枪。
      if (this.lockSupported && !this.locked) return;
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
    };
    this._onMouseUp = (e) => { this.mouseButtons.delete(e.button); };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    this._onWheel = (e) => { this.wheel += Math.sign(e.deltaY); };
    this._onContext = (e) => { if (this.locked) e.preventDefault(); };
    this._onLockChange = () => {
      const wasLocked = this.locked;
      this.locked = doc.pointerLockElement != null;
      if (!this.locked) {
        this.mouseButtons.clear();
        this.mousePressed.clear();
        // 只把"曾经锁定 → 现在丢了"算作意外丢失：开局/背包/搜刮/对话的主动解锁不算。
        if (wasLocked) this._lockLost = true;
      }
    };
    // 失焦/切到后台：清空所有按住状态，避免"手离开键盘了人还在跑 / 还在开火"
    this._onBlur = () => this.releaseAll();
    this._onVisibility = () => {
      if (doc.visibilityState === 'hidden' || doc.hidden === true) this.releaseAll();
    };

    doc.addEventListener('keydown', this._onKeyDown);
    doc.addEventListener('keyup', this._onKeyUp);
    doc.addEventListener('mousedown', this._onMouseDown);
    doc.addEventListener('mouseup', this._onMouseUp);
    doc.addEventListener('mousemove', this._onMouseMove);
    doc.addEventListener('wheel', this._onWheel, { passive: true });
    doc.addEventListener('contextmenu', this._onContext);
    doc.addEventListener('pointerlockchange', this._onLockChange);
    doc.addEventListener('visibilitychange', this._onVisibility);
    if (win) win.addEventListener('blur', this._onBlur);
  }

  /** 玩家点击"开始游戏"后调用；浏览器要求用户手势才能锁定指针、启动音频。 */
  requestLock(element) {
    if (!element || typeof element.requestPointerLock !== 'function') return false;
    try {
      const p = element.requestPointerLock();
      // 真正调得动才算支持：这样"不支持指针锁定"的环境仍然能开火（见 _onMouseDown）
      this.lockSupported = true;
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return true;
    } catch (e) { return false; }
  }

  releaseLock() {
    const doc = this.doc || (typeof document !== 'undefined' ? document : null);
    if (doc && doc.exitPointerLock) {
      try { doc.exitPointerLock(); } catch (e) {}
    }
    this.locked = false;
  }

  /**
   * 指针锁定是否被浏览器/玩家意外收回（指针锁定时按 Esc、切窗口、全屏退出）。
   * 消费式：调用一次就把标记清掉。game.js 用它做"锁定一丢就暂停"。
   */
  consumeLockLost() {
    const lost = this._lockLost;
    this._lockLost = false;
    return lost;
  }

  /** 清空所有按住状态（失焦、切后台、暂停时调用都安全）。 */
  releaseAll() {
    this.held.clear();
    this.pressed.clear();
    this.released.clear();
    this.mouseButtons.clear();
    this.mousePressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  isDown(action) {
    const keys = KEYMAP[action];
    if (!keys) return false;
    for (const k of keys) if (this.held.has(k)) return true;
    return false;
  }

  wasPressed(action) {
    const keys = KEYMAP[action];
    if (!keys) return false;
    for (const k of keys) if (this.pressed.has(k)) return true;
    return false;
  }

  mouseDown(btn = 0) { return this.mouseButtons.has(btn); }
  mouseWasPressed(btn = 0) { return this.mousePressed.has(btn); }

  /** 取走本帧的鼠标位移（消费式，避免重复应用）。 */
  takeMouseDelta() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  /** 取走本帧的滚轮（消费式）：正数 = 向下滚，负数 = 向上滚。 */
  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** 每帧末调用：清空边缘触发集合。 */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
  }

  dispose() {
    const doc = this.doc;
    if (!doc) return;
    doc.removeEventListener('keydown', this._onKeyDown);
    doc.removeEventListener('keyup', this._onKeyUp);
    doc.removeEventListener('mousedown', this._onMouseDown);
    doc.removeEventListener('mouseup', this._onMouseUp);
    doc.removeEventListener('mousemove', this._onMouseMove);
    doc.removeEventListener('wheel', this._onWheel);
    doc.removeEventListener('contextmenu', this._onContext);
    doc.removeEventListener('pointerlockchange', this._onLockChange);
    doc.removeEventListener('visibilitychange', this._onVisibility);
    if (this._win) this._win.removeEventListener('blur', this._onBlur);
    this._win = null;
    this.doc = null;
  }
}

export default { Input, KEYMAP };
