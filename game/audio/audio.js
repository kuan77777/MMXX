// 程序化 WebAudio 音效引擎（僵尸生存 / 低多边形风格）
// 全部声音实时合成：不加载音频文件、不联网、不依赖任何库。
// 无 AudioContext（无头环境、受限浏览器）时静默降级：available === false，任何调用都不抛错。
//
// 用法：
//   const audio = new AudioSystem({ storage: localStorage });
//   audio.setListener({ x, y, z }, { x: forwardX, z: forwardZ });
//   audio.unlock();                           // 用户手势内调用
//   audio.play('gunshot', { position: { x, y, z } });
//   audio.startAmbient();                     // 循环风声
//   每帧 audio.update(dt);

// ---------- 常量 ----------
const STORAGE_KEY = 'nomeimporta.audio.settings';
const NOISE_SECONDS = 1; // 共享白噪声缓冲长度（只生成一次，所有噪声类音效复用）
const MAX_VOICES = 64; // 同时存活的发声组上限，超出回收最旧的，防止节点泄漏
const REF_DIST = 6; // 距离衰减参考半径：此距离内满音量
const ROLLOFF = 1.2; // 距离衰减斜率
const MAX_DIST = 90; // 超过此距离直接不发声
const MASTER_LP_HZ = 11000; // 母线低通，削掉刺耳的高频毛刺

// 未知音效名只警告一次（模块级，跨实例），避免刷屏
const WARNED = new Set();

// ---------- 数值 / AudioParam 小工具 ----------
function num(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampRange(value, lo, hi, fallback) {
  const n = num(value, fallback);
  return n < lo ? lo : n > hi ? hi : n;
}

function clamp01(value, fallback) {
  return clampRange(value, 0, 1, fallback == null ? 0 : fallback);
}

// 直接写参数值（用于创建时的静态值），任何异常都忽略
function setNow(param, value) {
  try {
    if (param) param.value = value;
  } catch (e) {
    /* 参数不可写时忽略 */
  }
}

function paramSet(param, value, when) {
  try {
    if (param && typeof param.setValueAtTime === 'function') param.setValueAtTime(value, when);
    else setNow(param, value);
  } catch (e) {
    /* 忽略 */
  }
}

// 首选 setTargetAtTime：指数逼近，不会有阶跃爆音；0 目标同样安全
function paramTarget(param, value, when, tau) {
  try {
    if (param && typeof param.setTargetAtTime === 'function') {
      param.setTargetAtTime(value, when, Math.max(0.0001, tau));
    } else {
      setNow(param, value);
    }
  } catch (e) {
    /* 忽略 */
  }
}

function paramExp(param, value, when) {
  // 指数斜坡不允许到 0，这里兜住下限
  const v = Math.max(0.0001, num(value, 0.0001));
  try {
    if (param && typeof param.exponentialRampToValueAtTime === 'function') {
      param.exponentialRampToValueAtTime(v, when);
    } else {
      setNow(param, v);
    }
  } catch (e) {
    /* 忽略 */
  }
}

function paramLinear(param, value, when) {
  try {
    if (param && typeof param.linearRampToValueAtTime === 'function') {
      param.linearRampToValueAtTime(value, when);
    } else {
      setNow(param, value);
    }
  } catch (e) {
    /* 忽略 */
  }
}

// ---------- 音效定义 ----------
// 每个音效收到 (S = AudioSystem, v = 本次发声上下文)：
//   v.ctx    AudioContext
//   v.t     起始时间（略超前于 currentTime）
//   v.env   本次发声的总包络增益，所有声部都汇入它
//   v.nodes 本次创建的全部节点，结束后统一 stop/disconnect
//   v.pitch 由 opts.rate/detune 换算出的音高倍数
//   v.open  静音时为 0，否则为 1（保证静音时调度的增益都是 0）
const SFX = Object.assign(Object.create(null), {
  // 脚步：60~90ms 带通噪声，每次随机音高；低频垫一点点体重感
  footstep(S, v) {
    const dur = 0.06 + Math.random() * 0.03;
    const vary = 0.92 + Math.random() * 0.18; // 每次脚步的随机音高
    S._blast(v, {
      dur,
      type: 'bandpass',
      freq: 850,
      q: 1.3,
      rateMul: vary,
      peak: 0.5,
      atk: 0.002,
      dec: 0.07,
      lp: 3400
    });
    S._blip(v, { type: 'sine', freq: 110, to: 72, dur: 0.08, peak: 0.16, atk: 0.002, dec: 0.07 });
  },

  // 冲刺脚步：更短更亮更重
  footstep_sprint(S, v) {
    S._blast(v, {
      dur: 0.045 + Math.random() * 0.02,
      type: 'bandpass',
      freq: 1450,
      q: 0.9,
      rateMul: 0.92 + Math.random() * 0.2,
      peak: 0.68,
      atk: 0.002,
      dec: 0.05,
      lp: 5200
    });
    S._blip(v, { type: 'sine', freq: 132, to: 66, dur: 0.07, peak: 0.22, atk: 0.002, dec: 0.07 });
  },

  // 雪地脚步：低频"咯吱"来自压实的雪，高频是碎冰粒；整体比普通脚步闷
  footstep_snow(S, v) {
    const vary = 0.9 + Math.random() * 0.2;
    // 咯吱：窄带高频 + 慢速下扫
    S._blast(v, {
      dur: 0.09, type: 'bandpass', freq: 2200, q: 2.2, rateMul: vary,
      peak: 0.34, atk: 0.004, dec: 0.12,
    });
    // 压实雪的低频闷响
    S._blast(v, {
      dur: 0.12, type: 'lowpass', freq: 420, q: 0.8, peak: 0.3, atk: 0.004, dec: 0.13,
    });
    S._blip(v, { type: 'sine', freq: 92, to: 58, dur: 0.09, peak: 0.14, atk: 0.003, dec: 0.09 });
  },

  // 湿地脚步：水花是短促的高频"啪叽" + 一点中频挤压
  footstep_wet(S, v) {
    const vary = 0.9 + Math.random() * 0.25;
    S._blast(v, {
      dur: 0.06, type: 'highpass', freq: 1500, q: 0.7, rateMul: vary,
      peak: 0.4, atk: 0.001, dec: 0.08,
    });
    S._blast(v, {
      dur: 0.1, type: 'bandpass', freq: 620, q: 1.4, peak: 0.35, atk: 0.002, dec: 0.1,
    });
    S._blip(v, { type: 'sine', freq: 120, to: 60, dur: 0.08, peak: 0.18, atk: 0.002, dec: 0.08 });
  },

  // 起跳：布料摩擦 + 上扬气流
  jump(S, v) {
    const src = S._noise(v, 0.16, v.t, 1.05);
    const bp = S._filter(v, 'bandpass', 500, 1.1);
    paramSet(bp.frequency, 500 * v.pitch, v.t);
    paramExp(bp.frequency, 1800 * v.pitch, v.t + 0.14);
    const g = S._env(v, v.t, 0.4, 0.01, 0.15);
    src.connect(bp);
    bp.connect(g);
    S._blip(v, { type: 'sine', freq: 96, to: 62, dur: 0.12, peak: 0.2, atk: 0.003, dec: 0.11 });
  },

  // 落地：低频撞击 + 沙土
  land(S, v) {
    S._blip(v, { type: 'sine', freq: 120, to: 52, dur: 0.18, peak: 0.55, atk: 0.002, dec: 0.16 });
    S._blast(v, { dur: 0.08, type: 'lowpass', freq: 620, q: 0.7, peak: 0.45, atk: 0.002, dec: 0.1 });
    S._blast(v, { dur: 0.05, type: 'bandpass', freq: 1500, q: 1.4, peak: 0.18, dec: 0.05, lp: 4200 });
  },

  // 手枪：爆音 + 快速下坠的"身体"正弦 + 短延迟尾音
  gunshot(S, v) {
    const air = S._blast(v, {
      dur: 0.13,
      type: 'lowpass',
      freq: 2600,
      q: 0.9,
      peak: 0.95,
      atk: 0.0008,
      dec: 0.12
    });
    S._blip(v, { type: 'sine', freq: 152, to: 58, dur: 0.12, peak: 0.55, atk: 0.001, dec: 0.11 });
    S._tail(v, air, { delay: 0.07, feedback: 0.3, amount: 0.3, freq: 2000 });
  },

  // 步枪：更亮更短，尾音更紧
  gunshot_rifle(S, v) {
    const air = S._blast(v, {
      dur: 0.085,
      type: 'lowpass',
      freq: 4200,
      q: 1.1,
      peak: 0.85,
      atk: 0.0006,
      dec: 0.08
    });
    S._blip(v, { type: 'sine', freq: 190, to: 72, dur: 0.08, peak: 0.4, atk: 0.001, dec: 0.075 });
    S._tail(v, air, { delay: 0.05, feedback: 0.24, amount: 0.25, freq: 2600 });
  },

  // 霰弹枪：低频重、持续时间长、尾巴宽
  gunshot_shotgun(S, v) {
    const air = S._blast(v, {
      dur: 0.28,
      type: 'lowpass',
      freq: 1500,
      q: 0.8,
      peak: 1,
      atk: 0.001,
      dec: 0.26
    });
    S._blip(v, { type: 'sine', freq: 105, to: 42, dur: 0.24, peak: 0.62, atk: 0.002, dec: 0.22 });
    S._tail(v, air, { delay: 0.11, feedback: 0.34, amount: 0.4, freq: 1300 });
  },

  // 空仓：金属撞针的干响
  dryfire(S, v) {
    S._blast(v, { dur: 0.012, type: 'bandpass', freq: 2800, q: 2.2, peak: 0.35, atk: 0.0005, dec: 0.025 });
    S._blip(v, { type: 'square', freq: 1100, to: 700, dur: 0.03, peak: 0.12, atk: 0.001, dec: 0.03 });
  },

  // 换弹：退匣卡扣 → 插匣 → 拉栓
  reload(S, v) {
    S._blast(v, { dur: 0.02, type: 'bandpass', freq: 2200, q: 2.6, peak: 0.38, atk: 0.0008, dec: 0.04 });
    S._blast(v, { dur: 0.06, type: 'bandpass', freq: 700, q: 1.2, peak: 0.32, atk: 0.002, dec: 0.06, at: 0.1 });
    S._blip(v, { type: 'triangle', freq: 1500, to: 1100, dur: 0.05, peak: 0.12, at: 0.1, dec: 0.05 });
    S._blast(v, { dur: 0.03, type: 'bandpass', freq: 1600, q: 2, peak: 0.42, at: 0.32, dec: 0.05 });
    S._blip(v, { type: 'square', freq: 900, to: 600, dur: 0.04, peak: 0.1, at: 0.32, dec: 0.04 });
  },

  // 挥砍：带通噪声从低扫到高再落下，像刀刃划空气
  melee_swing(S, v) {
    const src = S._noise(v, 0.22, v.t, 0.9 + Math.random() * 0.2);
    const bp = S._filter(v, 'bandpass', 400, 1.6);
    paramSet(bp.frequency, 400 * v.pitch, v.t);
    paramExp(bp.frequency, 2400 * v.pitch, v.t + 0.09);
    paramExp(bp.frequency, 700 * v.pitch, v.t + 0.22);
    const g = S._env(v, v.t, 0.5, 0.02, 0.22);
    src.connect(bp);
    bp.connect(g);
  },

  // 近战命中：闷响 + 一点脆边
  melee_hit(S, v) {
    S._blast(v, { dur: 0.09, type: 'lowpass', freq: 900, q: 0.9, peak: 0.68, atk: 0.002, dec: 0.1 });
    S._blip(v, { type: 'sine', freq: 170, to: 76, dur: 0.1, peak: 0.4, atk: 0.002, dec: 0.1 });
    S._blast(v, { dur: 0.04, type: 'bandpass', freq: 2600, q: 1.2, peak: 0.15, at: 0.005, dec: 0.05 });
  },

  // 打中血肉：低沉湿润的噗
  hit_flesh(S, v) {
    S._blast(v, { dur: 0.1, type: 'lowpass', freq: 1100, q: 0.8, peak: 0.55, atk: 0.002, dec: 0.12 });
    S._blip(v, { type: 'sine', freq: 96, to: 55, dur: 0.14, peak: 0.42, atk: 0.002, dec: 0.14 });
    S._blast(v, { dur: 0.07, type: 'bandpass', freq: 420, q: 1.8, peak: 0.2, dec: 0.09 });
  },

  // 打中墙面：脆性撞击 + 短促回弹
  hit_wall(S, v) {
    S._blast(v, { dur: 0.05, type: 'bandpass', freq: 3200, q: 1.8, peak: 0.48, atk: 0.0008, dec: 0.06 });
    S._blip(v, { type: 'triangle', freq: 2400, to: 1200, dur: 0.05, peak: 0.14, atk: 0.001, dec: 0.06 });
  },

  // 死亡：下坠锯齿 + 低频轰鸣 + 气声
  death(S, v) {
    S._blip(v, {
      type: 'sawtooth',
      freq: 220,
      to: 48,
      dur: 0.8,
      peak: 0.38,
      atk: 0.01,
      dec: 0.7,
      lp: 1200
    });
    S._blast(v, { dur: 0.35, type: 'lowpass', freq: 700, q: 0.7, peak: 0.28, atk: 0.02, dec: 0.6 });
    S._blip(v, { type: 'sine', freq: 90, to: 34, dur: 0.6, peak: 0.34, atk: 0.005, dec: 0.55 });
  },

  // 僵尸低吼：失谐锯齿 + 慢速 LFO 拉扯音高 + 双共振峰带通
  zombie_growl(S, v) {
    const t = v.t;
    const p = v.pitch;
    const saw = S._osc(v, 'sawtooth', 104 * p, t);
    const saw2 = S._osc(v, 'sawtooth', 107.5 * p, t);
    const lfo = S._osc(v, 'sine', 5.2 + Math.random() * 1.6, t);
    const lg = S._gain(v, 14);
    lfo.connect(lg);
    lg.connect(saw.frequency);
    lg.connect(saw2.frequency);
    // 两级带通当作喉腔共振峰
    const f1 = S._filter(v, 'bandpass', 430 * p, 3.5);
    const f2 = S._filter(v, 'bandpass', 1050 * p, 2.2);
    const g = S._env(v, t, 0.42, 0.09, 0.5);
    saw.connect(f1);
    saw2.connect(f1);
    f1.connect(f2);
    f2.connect(g);
    S._blast(v, { dur: 0.5, type: 'bandpass', freq: 320, q: 0.8, peak: 0.07, atk: 0.1, dec: 0.45 });
  },

  // 僵尸扑咬：短吼 + 挥爪风声
  zombie_attack(S, v) {
    S._blip(v, { type: 'sawtooth', freq: 150, to: 90, dur: 0.24, peak: 0.4, atk: 0.015, dec: 0.22, lp: 900 });
    const src = S._noise(v, 0.16, v.t + 0.04, 1.1);
    const bp = S._filter(v, 'bandpass', 1300, 1.4);
    paramSet(bp.frequency, 1300 * v.pitch, v.t + 0.04);
    paramExp(bp.frequency, 480 * v.pitch, v.t + 0.2);
    const g = S._env(v, v.t + 0.04, 0.3, 0.01, 0.15);
    src.connect(bp);
    bp.connect(g);
    S._blast(v, { dur: 0.12, type: 'bandpass', freq: 700, q: 2.5, peak: 0.16, atk: 0.01, dec: 0.14 });
  },

  // 僵尸倒地：喉音下坠 + 咕噜声
  zombie_death(S, v) {
    S._blip(v, { type: 'sawtooth', freq: 180, to: 40, dur: 0.7, peak: 0.38, atk: 0.01, dec: 0.6, lp: 800 });
    S._blast(v, { dur: 0.5, type: 'bandpass', freq: 350, q: 1.5, peak: 0.18, atk: 0.05, dec: 0.5 });
    S._blip(v, { type: 'sine', freq: 72, to: 34, dur: 0.5, peak: 0.3, atk: 0.01, dec: 0.5 });
  },

  // 拾取：两声上行三角波
  pickup_item(S, v) {
    S._blip(v, { type: 'triangle', freq: 660, to: 880, dur: 0.09, peak: 0.24, atk: 0.002, dec: 0.1 });
    S._blip(v, { type: 'triangle', freq: 990, to: 1320, dur: 0.08, peak: 0.17, at: 0.07, atk: 0.002, dec: 0.1 });
  },

  // 开箱：布料翻动 + 确认音
  loot_open(S, v) {
    S._blast(v, { dur: 0.14, type: 'bandpass', freq: 1900, q: 1.1, peak: 0.26, atk: 0.01, dec: 0.16 });
    S._blast(v, { dur: 0.1, type: 'bandpass', freq: 2600, q: 1.4, peak: 0.18, at: 0.1, dec: 0.12 });
    S._blip(v, { type: 'triangle', freq: 520, to: 700, dur: 0.12, peak: 0.15, at: 0.16, dec: 0.12 });
  },

  // 开门：窄带摩擦噪声缓慢扫频 + 门轴低鸣
  door_open(S, v) {
    const src = S._noise(v, 0.45, v.t, 0.85);
    const bp = S._filter(v, 'bandpass', 750, 7);
    paramSet(bp.frequency, 650, v.t);
    paramLinear(bp.frequency, 1150, v.t + 0.4);
    const g = S._env(v, v.t, 0.2, 0.06, 0.4);
    src.connect(bp);
    bp.connect(g);
    S._blip(v, { type: 'sawtooth', freq: 78, to: 96, dur: 0.45, peak: 0.09, atk: 0.05, dec: 0.4, lp: 400 });
  },

  // 关门：低频闷响 + 门闩咔哒
  door_close(S, v) {
    S._blip(v, { type: 'sine', freq: 95, to: 48, dur: 0.14, peak: 0.55, atk: 0.002, dec: 0.13 });
    S._blast(v, { dur: 0.09, type: 'lowpass', freq: 420, q: 0.8, peak: 0.38, atk: 0.002, dec: 0.1 });
    S._blast(v, { dur: 0.03, type: 'bandpass', freq: 2400, q: 2, peak: 0.28, at: 0.11, dec: 0.04 });
  },

  // UI：短促三角波点击
  ui_click(S, v) {
    S._blip(v, { type: 'triangle', freq: 960, to: 640, dur: 0.05, peak: 0.22, atk: 0.001, dec: 0.055 });
  },

  // UI：更轻的悬停提示
  ui_hover(S, v) {
    S._blip(v, { type: 'sine', freq: 1480, to: 1420, dur: 0.035, peak: 0.1, atk: 0.001, dec: 0.04 });
  },

  // UI：错误双音蜂鸣
  ui_error(S, v) {
    S._blip(v, { type: 'square', freq: 180, to: 150, dur: 0.08, peak: 0.15, atk: 0.002, dec: 0.08, lp: 900 });
    S._blip(v, { type: 'square', freq: 140, to: 120, dur: 0.09, peak: 0.14, at: 0.11, atk: 0.002, dec: 0.09, lp: 800 });
  },

  // 进食：三下咀嚼
  eat(S, v) {
    for (let i = 0; i < 3; i++) {
      S._blast(v, {
        dur: 0.06,
        type: 'bandpass',
        freq: 800 + i * 260,
        q: 1.3,
        peak: 0.3,
        at: i * 0.11,
        atk: 0.003,
        dec: 0.07
      });
    }
    S._blip(v, { type: 'triangle', freq: 180, to: 120, dur: 0.1, peak: 0.07, atk: 0.005, dec: 0.12 });
  },

  // 喝药：三下吞咽气泡 + 液体晃动
  drink(S, v) {
    for (let i = 0; i < 3; i++) {
      S._blip(v, {
        type: 'sine',
        freq: 320 - i * 30,
        to: 180,
        dur: 0.09,
        peak: 0.2,
        at: i * 0.13,
        atk: 0.005,
        dec: 0.1
      });
    }
    S._blast(v, { dur: 0.25, type: 'lowpass', freq: 600, q: 0.7, peak: 0.1, atk: 0.05, dec: 0.3 });
  },

  // 治疗：上行三和弦 + 高频闪光
  heal(S, v) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      S._blip(v, { type: 'sine', freq: notes[i], dur: 0.35, peak: 0.15, at: i * 0.06, atk: 0.01, dec: 0.35 });
    }
    S._blast(v, { dur: 0.3, type: 'highpass', freq: 4000, q: 0.7, peak: 0.05, atk: 0.08, dec: 0.3 });
  },

  // 玩家受伤：闷响 + 闷哼
  player_hurt(S, v) {
    S._blast(v, { dur: 0.12, type: 'lowpass', freq: 800, q: 0.8, peak: 0.55, atk: 0.002, dec: 0.14 });
    S._blip(v, { type: 'sine', freq: 190, to: 70, dur: 0.16, peak: 0.42, atk: 0.002, dec: 0.16 });
    S._blip(v, { type: 'sawtooth', freq: 300, to: 180, dur: 0.12, peak: 0.1, atk: 0.01, dec: 0.12, lp: 900 });
  },

  // 插弹匣：金属卡入的两段咔哒
  reload_insert(S, v) {
    S._blast(v, { dur: 0.025, type: 'bandpass', freq: 2400, q: 3, peak: 0.34, atk: 0.0008, dec: 0.05 });
    S._blip(v, { type: 'triangle', freq: 1250, to: 900, dur: 0.05, peak: 0.11, atk: 0.001, dec: 0.05 });
    S._blast(v, { dur: 0.04, type: 'bandpass', freq: 1200, q: 2, peak: 0.3, at: 0.09, dec: 0.05 });
    S._blip(v, { type: 'square', freq: 700, to: 500, dur: 0.04, peak: 0.09, at: 0.09, dec: 0.04 });
  },

  // 汽车打火：三次起动机拖动，随后引擎点着
  car_start(S, v) {
    for (let i = 0; i < 3; i++) {
      S._blast(v, { dur: 0.1, type: 'lowpass', freq: 320, q: 0.9, peak: 0.38, at: i * 0.16, dec: 0.1 });
      S._blip(v, { type: 'sawtooth', freq: 55, to: 70, dur: 0.1, peak: 0.18, at: i * 0.16, dec: 0.1, lp: 500 });
    }
    S._blip(v, { type: 'sawtooth', freq: 60, to: 130, dur: 0.5, peak: 0.3, at: 0.5, atk: 0.05, dec: 0.5, lp: 700 });
    S._blast(v, { dur: 0.6, type: 'lowpass', freq: 500, q: 0.8, peak: 0.16, at: 0.5, atk: 0.1, dec: 0.6 });
  },

  // 怠速引擎的一小段（氛围式）：两个失谐锯齿 + 滤波 LFO。
  // 需要持续引擎声时由游戏按节奏重复调用，而不是常驻循环，避免节点泄漏。
  car_engine(S, v) {
    const t = v.t;
    const a = S._osc(v, 'sawtooth', 68 * v.pitch, t);
    const b = S._osc(v, 'sawtooth', 71.5 * v.pitch, t);
    const lp = S._filter(v, 'lowpass', 480, 1.2);
    const lfo = S._osc(v, 'sine', 7.5, t);
    const lg = S._gain(v, 180);
    lfo.connect(lg);
    lg.connect(lp.frequency);
    const g = S._env(v, t, 0.26, 0.06, 0.5);
    a.connect(lp);
    b.connect(lp);
    lp.connect(g);
    S._blast(v, { dur: 0.5, type: 'lowpass', freq: 260, q: 0.8, peak: 0.07, atk: 0.06, dec: 0.5 });
  },

  // 撞车：金属挤压 + 低频撞击 + 余振
  car_hit(S, v) {
    const metal = S._blast(v, { dur: 0.12, type: 'bandpass', freq: 1800, q: 1.4, peak: 0.55, atk: 0.001, dec: 0.14 });
    S._blip(v, { type: 'sine', freq: 150, to: 60, dur: 0.16, peak: 0.5, atk: 0.002, dec: 0.16 });
    S._blip(v, { type: 'triangle', freq: 520, to: 380, dur: 0.3, peak: 0.16, atk: 0.003, dec: 0.3 });
    S._tail(v, metal, { delay: 0.045, feedback: 0.2, amount: 0.18, freq: 2200 });
  },

  // 阵风：噪声经低通缓慢扫频，形成渐强渐弱
  wind_gust(S, v) {
    const src = S._noise(v, 0.9, v.t, 0.8 + Math.random() * 0.3);
    const lp = S._filter(v, 'lowpass', 350, 0.6);
    paramSet(lp.frequency, 300, v.t);
    paramLinear(lp.frequency, 1100, v.t + 0.5);
    paramLinear(lp.frequency, 320, v.t + 0.9);
    const g = S._env(v, v.t, 0.32, 0.3, 0.6);
    src.connect(lp);
    lp.connect(g);
  },

  // 雷：远处是一段很长的低频隆隆（先到的是"滚"不是"炸"），近处才加一层脆裂。
  // 远近用 rate 表达：调用方按距离传 0.55~1.4（越远越闷越慢）。
  thunder(S, v) {
    const t = v.t;
    const p = v.pitch;
    // 主轰鸣：低频噪声 + 滤波下扫，2.2 秒才散
    const src = S._noise(v, 2.6, t, 0.5);
    const lp = S._filter(v, 'lowpass', 240 * p, 0.8);
    paramSet(lp.frequency, 260 * p, t);
    paramExp(lp.frequency, 65 * p, t + 2.2);
    const g = S._env(v, t, 0.9, 0.06, 2.4);
    src.connect(lp);
    lp.connect(g);
    // 第二层更低的"余震"，稍微晚一点，制造距离感
    const src2 = S._noise(v, 1.8, t + 0.14, 0.38);
    const lp2 = S._filter(v, 'lowpass', 130 * p, 0.9);
    const g2 = S._env(v, t + 0.14, 0.55, 0.12, 1.8);
    src2.connect(lp2);
    lp2.connect(g2);
    // 近雷：先来一声脆裂
    if (p > 1.05) {
      S._blast(v, { dur: 0.26, type: 'bandpass', freq: 2600 * p, q: 1.0, peak: 0.55, atk: 0.001, dec: 0.4 });
      S._blip(v, { type: 'sine', freq: 130, to: 42, dur: 0.5, peak: 0.5, atk: 0.002, dec: 0.6 });
    }
  },

  // 鸟叫（春/夏天的白天）：两三声短促的颤音，音高每次不同
  birds(S, v) {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i += 1) {
      const at = i * (0.085 + Math.random() * 0.05);
      const base = 2000 + Math.random() * 1100;
      S._blip(v, { type: 'sine', freq: base, to: base * 1.32, dur: 0.055, peak: 0.14, at: at, atk: 0.004, dec: 0.07 });
      S._blip(v, { type: 'sine', freq: base * 1.28, to: base * 0.94, dur: 0.045, peak: 0.09, at: at + 0.05, atk: 0.003, dec: 0.05 });
    }
  },

  // 虫鸣（夏天夜里）：一长串很轻的高频脉冲，靠随机间隔避免机械感
  crickets(S, v) {
    const pulses = 9 + Math.floor(Math.random() * 8);
    for (let i = 0; i < pulses; i += 1) {
      S._blip(v, {
        type: 'sine',
        freq: 4200 + Math.random() * 360,
        dur: 0.018,
        peak: 0.045,
        at: i * 0.052 + Math.random() * 0.012,
        atk: 0.002,
        dec: 0.02,
      });
    }
  },

  // 接任务：三声短促上行
  quest_accept(S, v) {
    const notes = [659.25, 783.99, 987.77];
    for (let i = 0; i < notes.length; i++) {
      S._blip(v, { type: 'triangle', freq: notes[i], dur: 0.18, peak: 0.18, at: i * 0.09, atk: 0.005, dec: 0.2 });
    }
  },

  // 完成任务：四声大调琶音 + 闪光
  quest_complete(S, v) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      S._blip(v, { type: 'triangle', freq: notes[i], dur: 0.4, peak: 0.18, at: i * 0.12, atk: 0.008, dec: 0.45 });
    }
    S._blast(v, { dur: 0.5, type: 'highpass', freq: 5000, q: 0.9, peak: 0.045, at: 0.3, atk: 0.05, dec: 0.5 });
  }
});

// 所有支持的音效名（从音效表派生，保证表内每个都能被调用）
export const SOUND_NAMES = Object.keys(SFX);

// ---------- 主类 ----------
export class AudioSystem {
  constructor(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};

    this._volumes = {
      master: clamp01(o.masterVolume, 0.8),
      sfx: clamp01(o.sfxVolume, 1),
      ambient: clamp01(o.ambientVolume, 0.6),
      enabled: o.enabled !== false
    };

    // 可选的 localStorage 兼容对象；不存在就完全不持久化
    this._storage = null;
    try {
      const st = o.storage;
      if (st && typeof st.getItem === 'function' && typeof st.setItem === 'function') this._storage = st;
    } catch (e) {
      this._storage = null;
    }

    this._ctx = null;
    this._master = null;
    this._sfx = null;
    this._ambient = null;
    this._noiseBuf = null;
    this._noiseRate = 0;
    this._noiseDur = 1;
    this._voices = [];
    this._ambientNodes = null;
    this._ambientWanted = false;
    // 天气驱动的环境声混音（world/weather.js 的 audio 字段直接喂进来）
    this._weatherMix = { rain: 0, wind: 0.4, indoor: false };
    this._available = false;
    this._unlocked = false;
    this._disposed = false;
    this._sfxOpen = 1;

    // 监听者：位置 + 前向（只用于水平面声像）
    this._lx = 0;
    this._ly = 0;
    this._lz = 0;
    this._fx = 0;
    this._fz = -1;
    this._rx = 1;
    this._rz = 0;

    this._time = 0;

    this._loadSettings();
    this._refreshMix();
    this._initAudio();
  }

  get available() {
    return this._available === true;
  }

  get unlocked() {
    return this._unlocked === true;
  }

  get enabled() {
    return this._volumes.enabled === true;
  }

  // ---------- 初始化 / 生命周期 ----------
  _initAudio() {
    if (this._ctx) {
      this._available = true;
      return true;
    }
    let AC = null;
    try {
      const g = typeof globalThis !== 'undefined' ? globalThis : {};
      AC = g.AudioContext || g.webkitAudioContext || null;
    } catch (e) {
      AC = null;
    }
    if (typeof AC !== 'function') {
      this._available = false;
      return false;
    }
    let ctx = null;
    try {
      ctx = new AC();
    } catch (e) {
      ctx = null;
    }
    if (!ctx) {
      this._available = false;
      return false;
    }
    try {
      this._ctx = ctx;
      // 母线：master → 低通 → 输出；sfx / ambient 各自挂一条支路
      const master = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      setNow(lp.frequency, MASTER_LP_HZ);
      setNow(lp.Q, 0.5);
      // 母线压缩器：同时叠很多枪声时压住峰值，避免削波（不支持时直接跳过）
      let comp = null;
      try {
        if (typeof ctx.createDynamicsCompressor === 'function') {
          comp = ctx.createDynamicsCompressor();
          setNow(comp.threshold, -8);
          setNow(comp.knee, 10);
          setNow(comp.ratio, 5);
          setNow(comp.attack, 0.004);
          setNow(comp.release, 0.2);
        }
      } catch (e) {
        comp = null;
      }
      if (comp) {
        master.connect(comp);
        comp.connect(lp);
      } else {
        master.connect(lp);
      }
      lp.connect(ctx.destination);
      const sfx = ctx.createGain();
      const ambient = ctx.createGain();
      sfx.connect(master);
      ambient.connect(master);
      this._master = master;
      this._sfx = sfx;
      this._ambient = ambient;
      this._available = true;
      this._applyVolumes(true); // 初始音量直接落位，避免开局从默认 1.0 缓慢滑落
    } catch (e) {
      // 节点创建失败：整体回落为静音，绝不抛错
      this._ctx = null;
      this._master = null;
      this._sfx = null;
      this._ambient = null;
      this._available = false;
    }
    return this._available;
  }

  // 用户手势解锁：创建（如尚未创建）并恢复 AudioContext，可重复调用
  unlock() {
    if (this._disposed) return this;
    try {
      if (!this._ctx) this._initAudio();
      const ctx = this._ctx;
      if (!ctx) return this;
      this._unlocked = true;
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        if (typeof ctx.resume === 'function') {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      }
      this._applyVolumes();
      // 解锁前请求过环境声的话，这里补启动
      if (this._ambientWanted && !this._ambientNodes && this._volumes.enabled) this.startAmbient();
    } catch (e) {
      /* 解锁失败也只是保持静音 */
    }
    return this;
  }

  // ---------- 音量 ----------
  setEnabled(on) {
    const next = !!on;
    const wasWanted = this._ambientWanted;
    this._volumes.enabled = next;
    if (!next) this._stopAmbientNodes();
    this._applyVolumes();
    if (next && wasWanted) this.startAmbient();
    this._persist();
    return this;
  }

  setMasterVolume(v) {
    this._volumes.master = clamp01(v, this._volumes.master);
    this._applyVolumes();
    this._persist();
    return this;
  }

  setSfxVolume(v) {
    this._volumes.sfx = clamp01(v, this._volumes.sfx);
    this._applyVolumes();
    this._persist();
    return this;
  }

  setAmbientVolume(v) {
    this._volumes.ambient = clamp01(v, this._volumes.ambient);
    this._applyVolumes();
    this._persist();
    return this;
  }

  getVolumes() {
    return {
      master: this._volumes.master,
      sfx: this._volumes.sfx,
      ambient: this._volumes.ambient,
      enabled: this._volumes.enabled
    };
  }

  _applyVolumes(immediate) {
    const v = this._volumes;
    const smooth = immediate ? 0 : 0.02;
    this._setParam(this._master ? this._master.gain : null, v.enabled ? v.master : 0, smooth);
    this._setParam(this._sfx ? this._sfx.gain : null, v.sfx, smooth);
    this._setParam(this._ambient ? this._ambient.gain : null, v.ambient, smooth);
    this._refreshMix();
  }

  // 静音时把本次发声的所有增益直接置 0，既省 CPU，也保证不会漏音
  _refreshMix() {
    const v = this._volumes;
    const base = v.enabled === true && v.master > 0;
    this._sfxOpen = base && v.sfx > 0 ? 1 : 0;
  }

  _setParam(param, value, smooth) {
    if (!param) return;
    const v = num(value, 0);
    if (smooth === 0) {
      setNow(param, v);
      return;
    }
    try {
      if (typeof param.setTargetAtTime === 'function') {
        param.setTargetAtTime(v, this._now(), smooth == null ? 0.02 : smooth);
      }
    } catch (e) {
      /* 忽略 */
    }
    // 同时写 value：兼容没有自动化能力的桩/旧实现，也便于外部读取
    setNow(param, v);
  }

  // ---------- 持久化 ----------
  _loadSettings() {
    const st = this._storage;
    if (!st) return;
    let raw = null;
    try {
      raw = st.getItem(STORAGE_KEY);
    } catch (e) {
      raw = null;
    }
    if (typeof raw !== 'string' || !raw) return;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      // 缺失/非法值会回落到当前（默认）音量
      this._volumes.master = clamp01(data.master, this._volumes.master);
      this._volumes.sfx = clamp01(data.sfx, this._volumes.sfx);
      this._volumes.ambient = clamp01(data.ambient, this._volumes.ambient);
      if (typeof data.enabled === 'boolean') this._volumes.enabled = data.enabled;
    } catch (e) {
      /* 数据损坏就忽略 */
    }
  }

  _persist() {
    const st = this._storage;
    if (!st) return;
    try {
      st.setItem(
        STORAGE_KEY,
        JSON.stringify({
          master: this._volumes.master,
          sfx: this._volumes.sfx,
          ambient: this._volumes.ambient,
          enabled: this._volumes.enabled
        })
      );
    } catch (e) {
      /* 隐私模式 / 配额满：静默 */
    }
  }

  // ---------- 监听者 / 空间化 ----------
  setListener(pos, forward) {
    try {
      if (pos && typeof pos === 'object') {
        this._lx = num(pos.x, this._lx);
        this._ly = num(pos.y, this._ly);
        this._lz = num(pos.z, this._lz);
      }
      if (forward && typeof forward === 'object') {
        let fx = num(forward.x, 0);
        let fz = num(forward.z, -1);
        const len = Math.sqrt(fx * fx + fz * fz);
        if (len > 0.0001) {
          fx /= len;
          fz /= len;
        } else {
          fx = 0;
          fz = -1;
        }
        this._fx = fx;
        this._fz = fz;
        // 右向量 = (-fz, fx)，与 Y 轴向上的左手系约定一致
        this._rx = -fz;
        this._rz = fx;
      }
    } catch (e) {
      /* 参数异常时保持原值 */
    }
    return this;
  }

  // 返回 { gain, pan }；超出最大距离时 gain 为 0
  _spatial(pos) {
    const dx = num(pos.x, 0) - this._lx;
    const dy = num(pos.y, 0) - this._ly;
    const dz = num(pos.z, 0) - this._lz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let gain = 1;
    if (dist > REF_DIST) {
      gain = REF_DIST / (REF_DIST + ROLLOFF * (dist - REF_DIST));
      if (!(dist < MAX_DIST)) gain = 0;
    }
    let pan = 0;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    if (horiz > 0.5) {
      pan = clampRange((dx * this._rx + dz * this._rz) / horiz, -1, 1, 0) * 0.9;
    }
    return { gain, pan };
  }

  // ---------- 发声 ----------
  play(name, opts = {}) {
    try {
      // 名字先校验：即使当前没有音频，也要给出一次警告
      if (typeof name !== 'string' || !(name in SFX)) {
        this._warnUnknown(name);
        return false;
      }
      if (this._disposed || !this._available || !this._ctx) return false;
      if (!this._volumes.enabled) return false;

      const ctx = this._ctx;
      // 未解锁且被自动播放策略挂起时不调度，避免解锁瞬间所有声音一起炸出来
      if (!this._unlocked && ctx.state === 'suspended') return false;

      const o = opts && typeof opts === 'object' ? opts : {};
      let volume = clamp01(o.volume, 1);
      let pan = clampRange(o.pan, -1, 1, 0);
      const rate = clampRange(o.rate, 0.25, 4, 1);
      const detune = clampRange(o.detune, -2400, 2400, 0);

      if (o.position && typeof o.position === 'object') {
        const sp = this._spatial(o.position);
        if (sp.gain <= 0.0001) return false; // 太远，直接不发声
        volume *= sp.gain;
        pan = sp.pan; // 位置优先，覆盖 opts.pan
      }

      const v = this._mkVoice(ctx, this._sfx, volume, pan, rate, detune);
      try {
        SFX[name](this, v);
        this._finish(v);
      } catch (e) {
        this._releaseVoice(v);
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  _warnUnknown(name) {
    let key;
    try {
      key = String(name);
    } catch (e) {
      key = '?';
    }
    if (WARNED.has(key)) return;
    WARNED.add(key);
    try {
      console.warn('[audio] 未知音效名: ' + key);
    } catch (e) {
      /* 控制台不可用就算了 */
    }
  }

  // 创建一次发声的骨架：总包络 + 声像 → 目标总线
  _mkVoice(ctx, dest, volume, pan, rate, detune) {
    const t = this._now() + 0.008; // 略微超前调度，避免踩在 currentTime 上
    const env = ctx.createGain();
    const nodes = [env];
    setNow(env.gain, 0);
    paramSet(env.gain, 0, t);

    let panner = null;
    if (Math.abs(pan) > 0.001 && typeof ctx.createStereoPanner === 'function') {
      try {
        panner = ctx.createStereoPanner();
        setNow(panner.pan, clampRange(pan, -1, 1, 0));
        env.connect(panner);
        panner.connect(dest);
        nodes.push(panner);
      } catch (e) {
        panner = null;
        env.connect(dest);
      }
    } else {
      env.connect(dest);
    }

    return {
      ctx,
      t,
      env,
      nodes,
      peak: Math.max(0, volume) * this._sfxOpen,
      open: this._sfxOpen,
      pitch: rate * Math.pow(2, detune / 1200),
      end: t + 0.2,
      dead: false
    };
  }

  // 结束一次发声：补总包络、统一调度 stop、登记待回收
  _finish(v) {
    const t = v.t;
    let end = num(v.end, t + 0.2);
    if (end < t + 0.02) end = t + 0.02;

    const g = v.env ? v.env.gain : null;
    paramSet(g, 0, t);
    paramTarget(g, Math.max(0, v.peak), t, 0.001); // 极快起音，保留打击感
    // 收尾淡出放在最后一个声部结束之后，避免把余振截断成爆音
    paramTarget(g, 0, Math.max(t + 0.004, end + 0.01), 0.008);

    const stopAt = end + 0.08;
    const nodes = v.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n && typeof n.stop === 'function') {
        try {
          n.stop(stopAt);
        } catch (e) {
          /* 已经停过 / 不支持，忽略 */
        }
      }
    }

    v.until = stopAt + 0.03;
    this._pushVoice(v);
  }

  _pushVoice(v) {
    const list = this._voices;
    while (list.length >= MAX_VOICES) {
      const old = list.shift();
      if (old) this._releaseVoice(old);
    }
    list.push(v);
  }

  // 断开并归还节点；由 update() 在包络结束后统一调用
  _releaseVoice(v) {
    if (!v || v.dead) return;
    v.dead = true;
    const nodes = v.nodes;
    for (let i = 0; i < nodes.length; i++) {
      try {
        nodes[i].disconnect();
      } catch (e) {
        /* 忽略 */
      }
    }
    nodes.length = 0;
  }

  // ---------- 每帧维护 ----------
  // 稳态下不产生任何临时对象：原地压缩活跃列表即可
  update(dt) {
    if (this._disposed || !this._ctx) return;
    const now = this._now();
    this._time = now;
    const list = this._voices;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.until <= now) this._releaseVoice(v);
      else list[w++] = v;
    }
    list.length = w;
  }

  _now() {
    try {
      return this._ctx ? num(this._ctx.currentTime, this._time) : this._time;
    } catch (e) {
      return this._time;
    }
  }

  // ---------- 环境声（风 + 雨，天气驱动） ----------
  // 一条噪声源做风、一条做雨，都过同一个"闷"滤波器再进 ambient 母线：
  //   · 风：低通 + 两个极慢 LFO（明暗/阵风），强度跟随天气的 wind；
  //   · 雨：高通 + 带通（雨不是低频轰鸣，是中高频的沙沙），强度跟随降水；
  //   · 室内：把闷滤波器的截止频率压到 ~700Hz —— 同一套节点，进建筑就自动"隔着墙"。
  // 全部按需创建，天气切换只改增益/截止频率，不重建节点（避免每换一次天气爆一次音）。
  startAmbient() {
    this._ambientWanted = true;
    if (this._disposed || !this._available || !this._ctx || !this._volumes.enabled) return this;
    if (this._ambientNodes) return this; // 已在播放，安全返回
    try {
      this._buildAmbient();
    } catch (e) {
      this._stopAmbientNodes();
    }
    return this;
  }

  stopAmbient() {
    this._ambientWanted = false;
    this._stopAmbientNodes();
    return this;
  }

  /** 天气 → 环境声混音。rain/wind 都是 0..1，可每帧调用（内部做平滑）。 */
  setWeatherMix(o = {}) {
    const m = this._weatherMix;
    if (Number.isFinite(o.rain)) m.rain = clamp01(o.rain, m.rain);
    if (Number.isFinite(o.wind)) m.wind = clamp01(o.wind, m.wind);
    if (o.indoor != null) m.indoor = !!o.indoor;
    this._applyWeatherMix();
    return this;
  }

  setIndoor(indoor) {
    this._weatherMix.indoor = !!indoor;
    this._applyWeatherMix();
    return this;
  }

  get weatherMix() { return { ...this._weatherMix }; }

  _applyWeatherMix() {
    const rec = this._ambientNodes;
    if (!rec) return;
    const m = this._weatherMix;
    const smooth = 0.35;
    // 风：基础底噪 + 阵风幅度都随风力上升
    if (rec.gust && rec.gust.gain) this._slide(rec.gust.gain, 0.05 + m.wind * 0.3, smooth);
    if (rec.gustAmp && rec.gustAmp.gain) this._slide(rec.gustAmp.gain, 0.02 + m.wind * 0.14, smooth);
    // 雨：雨越大越响；室内被闷滤波器削掉高频，但低频"哗"还在
    if (rec.rainGain && rec.rainGain.gain) this._slide(rec.rainGain.gain, m.rain * 0.42, smooth);
    // 室内闷：截止频率 20000（室外，几乎不削）→ 700（室内）
    if (rec.muffle && rec.muffle.frequency) this._slide(rec.muffle.frequency, m.indoor ? 700 : 20000, smooth);
    if (rec.rainHp && rec.rainHp.frequency) this._slide(rec.rainHp.frequency, m.indoor ? 220 : 420, smooth);
  }

  _slide(param, value, seconds) {
    try {
      if (param.setTargetAtTime) param.setTargetAtTime(value, this._now(), seconds);
      else setNow(param, value);
    } catch (e) {
      try { setNow(param, value); } catch (e2) { /* 忽略 */ }
    }
  }

  _buildAmbient() {
    const ctx = this._ctx;
    const rec = { nodes: [] };
    this._ambientNodes = rec;
    const keep = (node) => {
      rec.nodes.push(node);
      return node;
    };

    // 公共"闷"滤波器：室内会把它压到 700Hz，风声/雨声一起变闷
    const muffle = keep(ctx.createBiquadFilter());
    muffle.type = 'lowpass';
    setNow(muffle.frequency, 20000);
    setNow(muffle.Q, 0.4);
    muffle.connect(this._ambient);

    // ── 风
    const src = keep(ctx.createBufferSource());
    src.buffer = this._noiseBuffer(ctx);
    src.loop = true;

    const lp = keep(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    setNow(lp.frequency, 420);
    setNow(lp.Q, 0.6);

    // 极慢的滤波 LFO：风声的明暗起伏
    const lfo1 = keep(ctx.createOscillator());
    lfo1.type = 'sine';
    setNow(lfo1.frequency, 0.06);
    const lg1 = keep(ctx.createGain());
    setNow(lg1.gain, 260);
    lfo1.connect(lg1);
    lg1.connect(lp.frequency);

    // 第二条更慢的 LFO：阵风般的整体音量起伏
    const gust = keep(ctx.createGain());
    setNow(gust.gain, 0.18);
    const lfo2 = keep(ctx.createOscillator());
    lfo2.type = 'sine';
    setNow(lfo2.frequency, 0.11);
    const gustAmp = keep(ctx.createGain());
    setNow(gustAmp.gain, 0.07);
    lfo2.connect(gustAmp);
    gustAmp.connect(gust.gain);

    src.connect(lp);
    lp.connect(gust);
    gust.connect(muffle);

    // ── 雨（与风共用噪声缓冲，但滤波完全不同：中高频沙沙 + 一点低频"哗"）
    const rainSrc = keep(ctx.createBufferSource());
    rainSrc.buffer = this._noiseBuffer(ctx);
    rainSrc.loop = true;

    const rainHp = keep(ctx.createBiquadFilter());
    rainHp.type = 'highpass';
    setNow(rainHp.frequency, 420);
    setNow(rainHp.Q, 0.5);

    const rainBp = keep(ctx.createBiquadFilter());
    rainBp.type = 'bandpass';
    setNow(rainBp.frequency, 2600);
    setNow(rainBp.Q, 0.55);

    const rainGain = keep(ctx.createGain());
    setNow(rainGain.gain, 0);

    rainSrc.connect(rainHp);
    rainHp.connect(rainBp);
    rainBp.connect(rainGain);
    rainGain.connect(muffle);

    src.start(0, Math.random() * 0.5);
    rainSrc.start(0, Math.random() * 0.5);
    lfo1.start(0);
    lfo2.start(0);

    rec.gust = gust;
    rec.gustAmp = gustAmp;
    rec.rainGain = rainGain;
    rec.rainHp = rainHp;
    rec.muffle = muffle;
    // 建好之后立刻把当前天气混音落位（否则要等到下一次 setWeatherMix 才有声）
    this._applyWeatherMix();
  }

  _stopAmbientNodes() {
    const rec = this._ambientNodes;
    this._ambientNodes = null;
    if (!rec) return;
    rec.gust = null;
    rec.gustAmp = null;
    rec.rainGain = null;
    rec.rainHp = null;
    rec.muffle = null;
    const nodes = rec.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      try {
        if (n && typeof n.stop === 'function') n.stop();
      } catch (e) {
        /* 忽略 */
      }
      try {
        n.disconnect();
      } catch (e) {
        /* 忽略 */
      }
    }
    nodes.length = 0;
  }

  // ---------- 噪声缓冲（懒创建，全局复用） ----------
  _noiseBuffer(ctx) {
    const rate = num(ctx.sampleRate, 44100) || 44100;
    if (this._noiseBuf && this._noiseRate === rate) return this._noiseBuf;
    const len = Math.max(1, Math.floor(rate * NOISE_SECONDS));
    const buf = ctx.createBuffer(1, len, rate);
    try {
      const data = buf.getChannelData(0);
      if (data) {
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
    } catch (e) {
      /* 拿不到通道数据就退化为静音缓冲 */
    }
    this._noiseBuf = buf;
    this._noiseRate = rate;
    this._noiseDur = len / rate;
    return buf;
  }

  // ---------- 合成小工具 ----------
  _gain(v, value) {
    const g = v.ctx.createGain();
    setNow(g.gain, Math.max(0, num(value, 0)) * (v.open == null ? this._sfxOpen : v.open));
    v.nodes.push(g);
    return g;
  }

  _filter(v, type, freq, q) {
    const f = v.ctx.createBiquadFilter();
    f.type = type;
    setNow(f.frequency, Math.max(20, num(freq, 1000)));
    setNow(f.Q, q == null ? 1 : q);
    v.nodes.push(f);
    return f;
  }

  _osc(v, type, freq, when) {
    const o = v.ctx.createOscillator();
    o.type = type;
    setNow(o.frequency, Math.max(1, num(freq, 220)));
    v.nodes.push(o);
    try {
      o.start(when == null ? v.t : when);
    } catch (e) {
      /* 忽略 */
    }
    return o;
  }

  _noise(v, dur, when, rateMul) {
    const ctx = v.ctx;
    const buf = this._noiseBuffer(ctx);
    if (!buf) throw new Error('noise buffer unavailable');
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = clampRange(v.pitch * (rateMul == null ? 1 : rateMul), 0.25, 4, 1);
    try {
      if (src.playbackRate) setNow(src.playbackRate, rate);
    } catch (e) {
      /* 忽略 */
    }
    const nd = this._noiseDur > 0 ? this._noiseDur : 1;
    const realDur = Math.min(Math.max(0.005, dur), nd);
    const off = Math.random() * Math.max(0, nd - realDur);
    try {
      src.start(when, off, realDur);
    } catch (e) {
      try {
        src.start(when);
      } catch (e2) {
        /* 忽略 */
      }
    }
    v.nodes.push(src);
    return src;
  }

  // 包络增益：起音 → 衰减到 0（setTargetAtTime，目标 0 也合法）
  // 返回的增益节点已经接到 v.env 上。
  _env(v, when, peak, atk, dec) {
    const g = v.ctx.createGain();
    const p = g.gain;
    const pk = Math.max(0, num(peak, 0)) * (v.open == null ? this._sfxOpen : v.open);
    setNow(p, 0);
    paramSet(p, 0, when);
    paramTarget(p, pk, when, Math.max(0.0005, atk / 3));
    paramTarget(p, 0, when + Math.max(0.002, atk), Math.max(0.002, dec / 3));
    v.nodes.push(g);
    g.connect(v.env);
    v.end = Math.max(v.end, when + atk + dec + 0.03);
    return g;
  }

  // 短噪声爆发：噪声源 → 滤波 → 包络
  // o: { dur, type, freq, q, sweepTo, lp, peak, atk, dec, at, rateMul }
  _blast(v, o) {
    const when = v.t + (o.at || 0);
    const dur = num(o.dur, 0.1);
    const src = this._noise(v, dur, when, o.rateMul || 1);
    let node = src;
    const type = o.type === null ? null : o.type || 'bandpass';
    if (type) {
      const f = this._filter(v, type, num(o.freq, 1200) * v.pitch, o.q == null ? 1 : o.q);
      src.connect(f);
      node = f;
      if (o.sweepTo) {
        paramSet(f.frequency, Math.max(20, num(o.freq, 1200) * v.pitch), when);
        paramExp(f.frequency, Math.max(20, o.sweepTo * v.pitch), when + dur);
      }
      if (o.lp) {
        const l = this._filter(v, 'lowpass', o.lp * v.pitch, 0.7);
        f.connect(l);
        node = l;
      }
    }
    const g = this._env(v, when, o.peak == null ? 0.5 : o.peak, o.atk == null ? 0.002 : o.atk, o.dec == null ? dur : o.dec);
    node.connect(g);
    return node;
  }

  // 短音：振荡器 → 可选低通 → 包络
  _blip(v, o) {
    const when = v.t + (o.at || 0);
    const dur = num(o.dur, 0.1);
    const osc = this._osc(v, o.type || 'sine', num(o.freq, 600) * v.pitch, when);
    if (o.to) paramExp(osc.frequency, Math.max(1, o.to * v.pitch), when + dur);
    const g = this._env(v, when, o.peak == null ? 0.25 : o.peak, o.atk == null ? 0.003 : o.atk, o.dec == null ? dur : o.dec);
    let node = osc;
    if (o.lp) {
      const f = this._filter(v, 'lowpass', o.lp * v.pitch, 0.8);
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    return node;
  }

  // 短反馈延迟尾巴：给枪声加一点空间感（createDelay 不存在时自动跳过）
  _tail(v, from, o) {
    const ctx = v.ctx;
    if (!from || typeof ctx.createDelay !== 'function') return;
    let delay = null;
    try {
      delay = ctx.createDelay(0.5);
    } catch (e) {
      return;
    }
    const opt = o || {};
    const time = num(opt.delay, 0.07);
    setNow(delay.delayTime, Math.max(0.001, time));
    v.nodes.push(delay);

    const fb = this._gain(v, opt.feedback == null ? 0.28 : opt.feedback);
    const lp = this._filter(v, 'lowpass', opt.freq == null ? 1800 : opt.freq, 0.7);
    const wet = this._gain(v, opt.amount == null ? 0.3 : opt.amount);

    from.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay); // 反馈回路，增益 < 1 自然衰减
    lp.connect(wet);
    wet.connect(v.env);

    v.end = Math.max(v.end, v.t + time * 7);
  }

  // ---------- 销毁 ----------
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ambientWanted = false;
    this._stopAmbientNodes();

    const list = this._voices;
    for (let i = 0; i < list.length; i++) this._releaseVoice(list[i]);
    list.length = 0;

    try {
      const ctx = this._ctx;
      if (ctx && typeof ctx.close === 'function') {
        const p = ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (e) {
      /* 关闭失败也继续清理引用 */
    }

    this._ctx = null;
    this._master = null;
    this._sfx = null;
    this._ambient = null;
    this._noiseBuf = null;
    this._available = false;
    this._unlocked = false;
  }
}
