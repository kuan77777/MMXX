// FW3D AI · 集中配置
// 约定：长度 m、速度 m/s、加速度 m/s²、时间 s、角度 rad。
// 所有数值都可被 createConfig() 覆盖（调参入口），上线前不要散落到各模块里。

export const AI_DEFAULTS = {
  version: 2,

  // ── 决策频率（设计 01 §性能建议：高层 4–10 次/秒）
  rates: {
    thinkHz: 6,          // 每秒高层决策次数（每人错峰），1–12
    thinkJitter: 0.45,   // 错峰抖动比例 0–1
    rolesHz: 3,          // 团队角色分配频率 1–6
    urgentThinkMs: 70,   // 紧急事件（球权变化）后强制重估的最短间隔 ms
    snapshotHz: 20,      // 快照重建上限频率（复用同一帧结果）
  },

  // ── 行为切换滞回（设计 02 §8）
  switch: {
    threshold: 0.18,      // 普通切换需超过当前评分多少 0.02–0.4
    urgentThreshold: 0.06,// 紧急中断阈值 0–0.2
    minCommitment: 0.75,  // 普通行为最短保持 s 0.1–2
    urgentCommitment: 0.3,
    cooldown: 0.5,        // 切换后冷却 s，避免连跳
  },

  // ── 目标点与移动意图
  target: {
    smooth: 0.22,     // 目标点每帧向新目标插值比例 0.05–1（越小越平滑）
    deadzone: 0.7,    // 到达判定半径 m
    arriveFade: 2.2,  // 距目标多少米内开始减速
    strafeBias: 0.35, // 侧向移动时朝向的滞后系数
  },

  // ── 球员运动（设计 03 §4）
  motor: {
    walk: 1.9,             // m/s
    jog: 4.6,
    sprint: 7.9,
    accelMul: 3.2,         // 加速度 = speed 属性归一 * accelMul * sprintBase
    brakeMul: 5.4,         // 制动倍率（>1 表示刹车比加速快）
    turnRate: 7.4,         // rad/s 转向速度 3–14
    separation: 0.9,       // 球员间分离力强度 m/s per m
    separationRadius: 1.15,// 分离力作用半径 m
    staminaDrain: 8.5,     // 冲刺每秒消耗 3–15
    staminaRecover: 6.0,   // 非冲刺每秒恢复 2–10
    tiredBelow: 28,        // 低于此体力强制降速的阈值
    tiredSpeedMul: 0.78,   // 疲劳时速度倍率
  },

  // ── 球权与带球（设计 03 §2/§3）
  ball: {
    controlRadius: 1.75,   // m 接管球权半径
    controlMaxSpeed: 9.5,  // m/s 球速超过此值不能直接接管（需第一触球）
    touchDelay: 0.6,       // s 接管后到可出脚的延迟（第一脚处理）
    kickCooldown: 0.35,    // s 出脚后的收势，期间不再决策
    windup: 0.16,          // s 出脚起手（触球窗口开始）
    followThrough: 0.22,   // s 收势
    dribbleAhead: 0.80,    // m 带球时球在身前的距离
    dribbleSpeed: 1.05,    // 带球时球速 = 球员速度 * 该系数 + base
    dribbleBase: 1.2,
    protectUserRadius: 2.35, // m 玩家脚下此半径内 AI 不抢球（避免和玩家抢同一脚）
    looseBallRadius: 1.6,  // 无主球判定
    maxDribbleSec: 2.6,    // s 单人带球超过此时长后出球意愿上升（避免"抱着球不传"）
    shotBlockRadius: 1.2,  // 已不再使用，保留给后续封堵判定
    tackleRadius: 1.9,     // m 上抢/抢断的触发半径（AI 的 tackleTick 与玩家抢断共用；
                           //   之前这个键根本不存在 → A.ball.tackleRadius=undefined → 抢断/滑铲从未触发过）
  },

  // ── 传球求解（kick.js）
  pass: {
    minPower: 7.0,     // m/s
    maxPower: 27.0,
    idealMin: 7,       // m 理想传球距离
    idealMax: 23,
    leadFactor: 0.28,  // 提前量系数（按接球者速度）
    arriveSpeed: 4.5,  // m/s 期望到达球速（决定初速）
    riskWeight: 1.05,  // 线路风险惩罚权重
  },

  // ── 射门
  shot: {
    maxDist: 33,        // m 超过此距离不做射门候选
    minPower: 15,
    maxPower: 31,
    angleWidth: 0.62,   // 射门角度分（球门半宽 / 距离）的归一上限
  },

  // ── 团队角色
  roles: {
    stability: 0.2,     // 保留原角色的加成（归一评分）
    holdRoleSec: 0.9,   // 角色最短保持
    supportMax: 2,      // 接应人数
    anchors: 2,         // 后场保护人数
    presserMaxDist: 26, // 超过此距离不选为第一压迫者
  },

  // ── 阵型与战术（第八阶段）
  team: {
    formation: '4-3-3',
    style: 'balanced',   // balanced / possession / counter / press / low
    pressMul: 1,         // 压迫积极性倍率（由风格预设覆盖）
    attackWidth: 0.82,   // 进攻时阵型横向展开比例 0–1
    defendWidth: 0.55,   // 防守时收紧比例
    attackDepth: 0.34,   // 阵型整体前压比例
    defendDepth: -0.10,  // 防守时整体回收比例
    ballPull: 0.42,      // 阵型跟随球横移的比例
    riskAppetite: 0.5,   // 0 保守 1 冒险（比分/时间会修正）
  },

  // ── 难度（由 FW.difficultyProfile() 注入；1 = 标准）
  difficulty: {
    errorScale: 1,     // 执行误差倍率 0.5–1.6
    thinkMul: 1,       // 决策间隔倍率（越大越慢）
    pressMul: 1,       // 压迫积极性倍率
  },

  // ── 调试
  debug: {
    enabled: false,  // HUD 默认关闭（按 B 切换）
    radar: true,
    labels: 7,       // 雷达上显示标签的球员数
    logLimit: 40,    // 切换原因保留条数
  },
};

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = clone(v[k]);
    return o;
  }
  return v;
}

export function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (v !== undefined) {
      base[k] = Array.isArray(v) ? v.slice() : v;
    }
  }
  return base;
}

export function createConfig(overrides) {
  return deepMerge(clone(AI_DEFAULTS), overrides);
}

// ── 战术风格预设（第八阶段）：只改"阵型宽度/深度/压迫/冒险"四个维度，不改球员能力
export const STYLE_PRESETS = {
  balanced: { label: '均衡', attackWidth: 0.82, defendWidth: 0.55, attackDepth: 0.34, defendDepth: -0.10, ballPull: 0.42, riskAppetite: 0.50, pressMul: 1.00 },
  possession: { label: '控球', attackWidth: 0.88, defendWidth: 0.62, attackDepth: 0.30, defendDepth: -0.04, ballPull: 0.50, riskAppetite: 0.42, pressMul: 0.85 },
  counter: { label: '反击', attackWidth: 0.70, defendWidth: 0.46, attackDepth: 0.24, defendDepth: -0.18, ballPull: 0.34, riskAppetite: 0.62, pressMul: 0.90 },
  press: { label: '高压', attackWidth: 0.84, defendWidth: 0.52, attackDepth: 0.46, defendDepth: 0.06, ballPull: 0.44, riskAppetite: 0.58, pressMul: 1.30 },
  low: { label: '低位', attackWidth: 0.74, defendWidth: 0.42, attackDepth: 0.20, defendDepth: -0.26, ballPull: 0.30, riskAppetite: 0.36, pressMul: 0.70 },
};

/** 应用战术风格；未知名回退 balanced，返回 cfg 便于链式调用 */
export function applyStyle(cfg, name) {
  const key = STYLE_PRESETS[name] ? name : 'balanced';
  const p = STYLE_PRESETS[key];
  cfg.team.style = key;
  cfg.team.attackWidth = p.attackWidth;
  cfg.team.defendWidth = p.defendWidth;
  cfg.team.attackDepth = p.attackDepth;
  cfg.team.defendDepth = p.defendDepth;
  cfg.team.ballPull = p.ballPull;
  cfg.team.riskAppetite = p.riskAppetite;
  cfg.team.pressMul = p.pressMul;
  return cfg;
}

// 从引擎难度档位换算（3D → 引擎契约：FW.difficultyProfile() 返回 {label, window, assist}）// window：0.30 休闲 / 0.18 标准 / 0.10 硬核 —— 换算成 0（硬核）…1（休闲）的档位系数。
// AI 一侧只调"执行误差、思考间隔、压迫积极性"，不动球速与射门精度本身（设计 02 §1）。
export function applyDifficulty(cfg, profile) {
  if (!profile) return cfg;
  const w = typeof profile.window === 'number' ? profile.window : 0.18;
  const level = Math.min(1, Math.max(0, (w - 0.10) / 0.20));   // 1 = 休闲，0 = 硬核
  const d = cfg.difficulty;
  d.errorScale = 0.78 + 0.5 * level;    // 硬核 0.78，休闲 1.28
  d.thinkMul = 0.85 + 0.5 * level;      // 硬核反应更快
  d.pressMul = 1.22 - 0.42 * level;     // 硬核压迫更积极
  d.label = profile.label || '';
  return cfg;
}
