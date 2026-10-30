// FOOTBALL WORLD · 音效引擎
// 纯 WebAudio 合成，不加载任何音频文件：短促、克制、有层次，符合界面气质。
// 用法：FWSound.play('tap') / FWSound.toggle() / FWSound.enabled
(function () {
  const KEY = 'fw_sound_enabled';
  let ctx = null;
  let master = null;
  let enabled = true;
  try {
    const v = localStorage.getItem(KEY);
    if (v === '0') enabled = false;
  } catch (e) { /* 隐私模式忽略 */ }

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.16;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;
      master.connect(lp);
      lp.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  function resume() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    return c;
  }

  // 单个音：type/频率/时长/音量/滑音
  function tone(c, opt) {
    const t0 = c.currentTime + (opt.delay || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.freq, t0);
    if (opt.to) osc.frequency.exponentialRampToValueAtTime(Math.max(30, opt.to), t0 + (opt.dur || 0.15));
    const peak = (opt.gain == null ? 0.5 : opt.gain);
    const atk = opt.attack == null ? 0.008 : opt.attack;
    const dur = opt.dur || 0.15;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + atk + dur + 0.03);
  }

  // 噪声（哨声/鼓掌质感）
  function noise(c, opt) {
    const dur = opt.dur || 0.2;
    const t0 = c.currentTime + (opt.delay || 0);
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, opt.power || 2.2);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = opt.freq || 1800;
    bp.Q.value = opt.q || 1.2;
    const g = c.createGain();
    g.gain.value = opt.gain == null ? 0.25 : opt.gain;
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0);
  }

  const PRESETS = {
    // 极轻的按钮反馈
    tap(c) { tone(c, { type: 'sine', freq: 880, to: 760, dur: 0.05, gain: 0.16, attack: 0.004 }); },
    // 切换页签 / 选择
    select(c) {
      tone(c, { type: 'sine', freq: 660, dur: 0.05, gain: 0.12, attack: 0.004 });
      tone(c, { type: 'sine', freq: 990, dur: 0.07, gain: 0.08, delay: 0.035 });
    },
    // 确认：存档、接受报价
    confirm(c) {
      tone(c, { type: 'sine', freq: 523.25, dur: 0.10, gain: 0.18, attack: 0.006 });
      tone(c, { type: 'sine', freq: 783.99, dur: 0.16, gain: 0.14, delay: 0.07, attack: 0.006 });
    },
    // 推进时间
    tick(c) { tone(c, { type: 'triangle', freq: 420, to: 320, dur: 0.06, gain: 0.10, attack: 0.004 }); },
    // 训练
    train(c) {
      tone(c, { type: 'triangle', freq: 300, to: 520, dur: 0.12, gain: 0.14, attack: 0.006 });
      tone(c, { type: 'sine', freq: 780, dur: 0.08, gain: 0.07, delay: 0.09 });
    },
    // 进球
    goal(c) {
      tone(c, { type: 'triangle', freq: 523.25, to: 659.25, dur: 0.16, gain: 0.22, attack: 0.01 });
      tone(c, { type: 'triangle', freq: 783.99, to: 1046.5, dur: 0.22, gain: 0.18, delay: 0.14, attack: 0.01 });
      noise(c, { freq: 2600, q: 0.9, dur: 0.34, gain: 0.08, delay: 0.02, power: 2.6 });
    },
    // 成就解锁
    unlock(c) {
      [1046.5, 1318.5, 1568.0, 2093.0].forEach((f, i) => {
        tone(c, { type: 'sine', freq: f, dur: 0.16, gain: 0.13 - i * 0.02, delay: i * 0.075, attack: 0.006 });
      });
    },
    // 赛季结算 / 报告
    season(c) {
      [392.0, 523.25, 659.25].forEach((f, i) => {
        tone(c, { type: 'sine', freq: f, dur: 0.5, gain: 0.10 - i * 0.02, delay: i * 0.05, attack: 0.03 });
      });
      tone(c, { type: 'triangle', freq: 261.63, dur: 0.7, gain: 0.08, attack: 0.05 });
    },
    // 受伤 / 负面
    hurt(c) {
      tone(c, { type: 'sawtooth', freq: 220, to: 110, dur: 0.22, gain: 0.12, attack: 0.01 });
      noise(c, { freq: 700, q: 0.8, dur: 0.16, gain: 0.06, power: 2.4 });
    },
    // 开赛哨
    whistle(c) {
      noise(c, { freq: 2100, q: 2.4, dur: 0.14, gain: 0.10, power: 3.2 });
      noise(c, { freq: 2400, q: 2.6, dur: 0.12, gain: 0.08, delay: 0.16, power: 3.4 });
    },
    // 页面进入
    enter(c) { tone(c, { type: 'sine', freq: 440, to: 523.25, dur: 0.12, gain: 0.07, attack: 0.02 }); }
  };

  function play(name) {
    if (!enabled) return;
    const c = resume();
    if (!c) return;
    const fn = PRESETS[name] || PRESETS.tap;
    try { fn(c); } catch (e) { /* 音效失败不影响游戏 */ }
  }

  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (e) {}
    if (enabled) play('confirm');
    return enabled;
  }
  function toggle() { return setEnabled(!enabled); }

  window.FWSound = { play, toggle, setEnabled, get enabled() { return enabled; }, unlock: resume };
})();
