// UI 层：纯 DOM，不依赖 three.js。所有面板都在 #dd-root 里，游戏画布在下面一层。
// 与游戏的耦合只有两种：初始化时传入的回调（onXxx）+ 每帧 update(state) 传的只读快照。
// 这样 UI 可以单独在浏览器里冒烟测试（不需要 WebGL）。

import { WEATHERS } from '../world/weather.js';
import { TREE_REGIONS } from '../world/trees.js';
import { describeEffects } from '../items/consumables.js';
import { describeTreat } from '../items/medical.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KIND_LABEL = {
  weapon: '武器', ammo: '弹药', food: '食物', drink: '饮水', medical: '医疗',
  tool: '工具', material: '材料', clothing: '衣物', misc: '杂项',
};

const ITEM_GLYPH = {
  gun: '▮', rifle: '▬', shotgun: '▭', bat: '／', ammo: '▤', can: '◎', bar: '▭',
  apple: '●', water: '▽', soda: '▽', bandage: '✚', medkit: '✚', pills: '○',
  flashlight: '◐', crowbar: '⌐', scrap: '▲', wood: '▥', cloth: '≋', battery: '▮',
  jersey: '👕', jacket: '🧥', radio: '▣', photo: '▢',
  pizza: '◔', sushi: '◎', icecream: '△',
};

export class GameUI {
  constructor(handlers = {}) {
    this.h = handlers;
    this.root = null;
    this.els = {};
    this.toastTimer = null;
    this.inventoryOpen = false;
    this.paused = false;
    this._hitT = 0;
    this._damageT = 0;
    this._lastPrompt = null;
    this._built = false;
  }

  mount(container) {
    if (this._built) return this.root;
    const root = document.createElement('div');
    root.id = 'dd-root';
    root.innerHTML = `
      <div class="dd-layer" id="dd-hud">
        <div class="dd-vignette" id="dd-vignette"></div>
        <div class="dd-quest" id="dd-quest" style="display:none"></div>
        <div class="dd-topright" id="dd-topright"></div>
        <div class="dd-crosshair" id="dd-crosshair"></div>
        <div class="dd-prompt" id="dd-prompt"></div>
        <div class="dd-toasts" id="dd-toasts"></div>
        <div class="dd-vitals">
          <div class="dd-bar-row"><span>HP</span><span class="dd-bar dd-hp"><i id="dd-hp-bar"></i></span><b id="dd-hp-val">100</b></div>
          <div class="dd-bar-row"><span>饥饿</span><span class="dd-bar dd-hunger"><i id="dd-hunger-bar"></i></span><b id="dd-hunger-val">100</b></div>
          <div class="dd-bar-row"><span>口渴</span><span class="dd-bar dd-thirst"><i id="dd-thirst-bar"></i></span><b id="dd-thirst-val">100</b></div>
          <div class="dd-bar-row"><span>体力</span><span class="dd-bar dd-stamina"><i id="dd-stamina-bar"></i></span><b id="dd-stamina-val">100</b></div>
        </div>
        <div class="dd-buffs" id="dd-buffs"></div>
        <div class="dd-weapon dd-panel">
          <div class="dd-wname" id="dd-wname">徒手</div>
          <div class="dd-ammo"><span id="dd-ammo">—</span> <small id="dd-reserve"></small></div>
          <div class="dd-reload" id="dd-reload" style="display:none">换弹中…</div>
        </div>
        <div class="dd-quick" id="dd-quick"></div>
      </div>
      <div class="dd-layer" id="dd-screens"></div>
    `;
    (container || document.body).appendChild(root);
    this.root = root;
    this.els.hud = root.querySelector('#dd-hud');
    this.els.screens = root.querySelector('#dd-screens');
    this.els.vignette = root.querySelector('#dd-vignette');
    this.els.quest = root.querySelector('#dd-quest');
    this.els.topright = root.querySelector('#dd-topright');
    this.els.crosshair = root.querySelector('#dd-crosshair');
    this.els.prompt = root.querySelector('#dd-prompt');
    this.els.toasts = root.querySelector('#dd-toasts');
    this.els.hp = root.querySelector('#dd-hp-bar');
    this.els.hpVal = root.querySelector('#dd-hp-val');
    this.els.hunger = root.querySelector('#dd-hunger-bar');
    this.els.hungerVal = root.querySelector('#dd-hunger-val');
    this.els.thirst = root.querySelector('#dd-thirst-bar');
    this.els.thirstVal = root.querySelector('#dd-thirst-val');
    this.els.stamina = root.querySelector('#dd-stamina-bar');
    this.els.staminaVal = root.querySelector('#dd-stamina-val');
    this.els.buffs = root.querySelector('#dd-buffs');
    this.els.wname = root.querySelector('#dd-wname');
    this.els.ammo = root.querySelector('#dd-ammo');
    this.els.reserve = root.querySelector('#dd-reserve');
    this.els.reload = root.querySelector('#dd-reload');
    this.els.quick = root.querySelector('#dd-quick');
    this._built = true;
    this.hideHud();
    return root;
  }

  // ── 基础显隐 ─────────────────────────────────────────
  showHud() { if (this.els.hud) this.els.hud.style.display = ''; }
  hideHud() { if (this.els.hud) this.els.hud.style.display = 'none'; }

  clearScreens() { if (this.els.screens) this.els.screens.innerHTML = ''; }

  hideAll() {
    this.clearScreens();
    this.hideHud();
  }

  setLoading(text, visible = true) {
    this.clearScreens();
    if (!visible) return;
    const el = document.createElement('div');
    el.className = 'dd-loading';
    el.innerHTML = `<div class="dd-spin"></div><div class="dd-ltext">${esc(text || '加载中')}</div>`;
    this.els.screens.appendChild(el);
  }

  // ── 主菜单 ───────────────────────────────────────────
  showMainMenu(opts = {}) {
    const hasSave = !!opts.hasSave;
    const summary = opts.summary || null;
    // 回主菜单时顺手把背包状态清掉，否则残留的 inventoryOpen 会让下一局永远处于"暂停"
    this.inventoryOpen = false;
    this.clearScreens();
    this.hideHud();
    const el = document.createElement('div');
    el.className = 'dd-screen';
    el.innerHTML = `
      <div class="dd-menu-box dd-panel">
        <h1 class="dd-logo">DEAD<span>WORLD</span></h1>
        <div class="dd-sub">低多边形开放世界 · 僵尸生存 · 数据来自足球世界</div>
        <div class="dd-menu-list">
          <button class="dd-btn dd-primary" data-act="new">开始游戏<small>生成新的城镇（同种子地图固定）</small></button>
          <button class="dd-btn" data-act="continue" ${hasSave ? '' : 'disabled'}>继续游戏<small>${hasSave ? '读取本地存档' : '暂无存档'}</small></button>
          <button class="dd-btn" data-act="settings">设置</button>
          <button class="dd-btn" data-act="db">足球数据库<small>${summary ? `${summary.clubs} 俱乐部 / ${summary.original && summary.original.players ? summary.original.players.toLocaleString() : summary.players} 球员 / ${summary.leagues} 联赛` : '查看数据来源'}</small></button>
          <button class="dd-btn" data-act="help">操作说明</button>
        </div>
        <div class="dd-hint" style="margin-top:18px">
          <span class="dd-kbd">W</span><span class="dd-kbd">A</span><span class="dd-kbd">S</span><span class="dd-kbd">D</span> 移动 ·
          <span class="dd-kbd">Shift</span> 冲刺 · <span class="dd-kbd">C</span> 蹲下 · <span class="dd-kbd">Space</span> 跳跃 ·
          <span class="dd-kbd">V</span> 第一/第三人称 · <span class="dd-kbd">E</span> 交互 · <span class="dd-kbd">Tab</span> 背包 ·
          <span class="dd-kbd">M</span> 地图 · <span class="dd-kbd">R</span> 换弹 · <span class="dd-kbd">Q</span> 近战 · <span class="dd-kbd">Esc</span> 暂停
        </div>
      </div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (this.h.click) this.h.click();
      if (act === 'new' && this.h.onNewGame) this.h.onNewGame();
      else if (act === 'continue' && this.h.onContinue) this.h.onContinue();
      else if (act === 'settings' && this.h.onSettings) this.h.onSettings();
      else if (act === 'db' && this.h.onDatabase) this.h.onDatabase();
      else if (act === 'help' && this.h.onHelp) this.h.onHelp();
    });
  }

  showHelp(onBack) {
    this.clearScreens();
    const el = document.createElement('div');
    el.className = 'dd-screen dd-modal';
    el.innerHTML = `
      <div class="dd-db dd-panel">
        <div class="dd-inv-head"><div class="dd-title">操作说明</div>
          <button class="dd-btn" data-act="back">返回</button></div>
        <div class="dd-grid2">
          <div>
            <div class="dd-section">移动与视角</div>
            <div class="dd-hint">
              <span class="dd-kbd">W</span><span class="dd-kbd">A</span><span class="dd-kbd">S</span><span class="dd-kbd">D</span> 移动（方向键同效）<br>
              <span class="dd-kbd">Shift</span> 冲刺（消耗体力）<br>
              <span class="dd-kbd">C</span> 蹲伏（更慢，但僵尸更难发现你）<br>
              <span class="dd-kbd">Space</span> 跳跃 · 高处落地会受伤<br>
              <span class="dd-kbd">V</span> 第一人称 / 第三人称切换<br>
              <span class="dd-kbd">L</span> 手电筒 · <span class="dd-kbd">Esc</span> 暂停（锁定指针时按 Esc 也会暂停）<br>
              鼠标拖动 = 视角（点击画面锁定指针，锁定后左键才开火）
            </div>
            <div class="dd-section">地图</div>
            <div class="dd-hint">
              右下角是<b>小地图</b>：始终朝上的是你的朝向，红点是感染者（亮红 = 已被惊动正在追你），
              圈外的小三角表示更远处还有感染者<br>
              <span class="dd-kbd">M</span> 或点小地图 = <b>大地图</b>（地形 / 道路 / 建筑 / 车辆 / 地点，游戏会暂停）<br>
              大地图里：拖动平移 · 滚轮缩放 · <span class="dd-kbd">W</span><span class="dd-kbd">A</span><span class="dd-kbd">S</span><span class="dd-kbd">D</span> 平移 ·
              双击回到玩家 · <span class="dd-kbd">M</span> / <span class="dd-kbd">Esc</span> 关闭
            </div>
            <div class="dd-section">战斗</div>
            <div class="dd-hint">
              鼠标左键 开火 · 右键 瞄准（降低散布）<br>
              <span class="dd-kbd">R</span> 换弹 · <span class="dd-kbd">Q</span> 近战挥击<br>
              <span class="dd-kbd">1</span>–<span class="dd-kbd">6</span> 切换武器 · 滚轮也可切换<br>
              爆头有额外伤害；子弹会被墙挡住；连发会让准星扩散变大<br>
              步枪/狙击可穿透目标；命中会致流血与硬直；枪声会招来感染者
            </div>
          </div>
          <div>
            <div class="dd-section">交互与生存</div>
            <div class="dd-hint">
              <span class="dd-kbd">E</span> 搜刮 / 开关门 / 上下车 / 对话<br>
              <span class="dd-kbd">F</span> 用车：车外 <b>加油 / 维修</b>，车内 <b>喇叭</b>（会把一片僵尸引过来）<br>
              <span class="dd-kbd">Tab</span> 背包（点击物品即可使用/装备）<br>
              <span class="dd-kbd">G</span> 丢弃当前手持物品<br>
              饥饿与口渴会持续下降，归零就掉血<br>
              <span class="dd-kbd">F5</span> 快速存档 · <span class="dd-kbd">F9</span> 读档<br>
              倒地后按 <span class="dd-kbd">R</span> 立刻在营地重生
            </div>
            <div class="dd-section">开车</div>
            <div class="dd-hint">
              <span class="dd-kbd">W</span><span class="dd-kbd">S</span> 油门 / 倒车 · <span class="dd-kbd">A</span><span class="dd-kbd">D</span> 转向 · <span class="dd-kbd">Space</span> 刹车<br>
              <span class="dd-kbd">L</span> <b>车灯</b>（夜里看路，也更显眼）<br>
              油量见 HUD；没油就熄火。一桶汽油 +45%，2 块废金属修一次耐久<br>
              车越快越吵，引擎声会把僵尸拉过来；高速撞人有伤害，但车也会掉耐久<br>
              车尾的<b>后备箱</b>可以按 <span class="dd-kbd">E</span> 翻一次
            </div>
            <div class="dd-section">提示</div>
            <div class="dd-hint">
              · 枪声会引来附近的僵尸（听觉感知）<br>
              · 蹲伏接近可以降低被发现距离<br>
              · 友好幸存者会提供任务，敌对掠夺者会主动开火<br>
              · 汽车可以驾驶，耐久随碰撞下降、油量会烧完
            </div>
          </div>
        </div>
      </div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.closest('button[data-act="back"]') && onBack) onBack(); });
  }

  // ── 暂停 ─────────────────────────────────────────────
  showPause() {
    this.paused = true;
    this.clearScreens();
    const el = document.createElement('div');
    el.className = 'dd-screen dd-modal';
    el.innerHTML = `
      <div class="dd-menu-box dd-panel" style="max-width:420px">
        <div class="dd-title">已暂停</div>
        <div class="dd-menu-list" style="margin-top:16px;max-width:none">
          <button class="dd-btn dd-primary" data-act="resume">继续游戏</button>
          <button class="dd-btn" data-act="save">保存游戏</button>
          <button class="dd-btn" data-act="load">读取存档</button>
          <button class="dd-btn" data-act="settings">设置</button>
          <button class="dd-btn dd-danger" data-act="menu">返回主菜单</button>
        </div>
      </div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (this.h.click) this.h.click();
      const a = btn.getAttribute('data-act');
      if (a === 'resume' && this.h.onResume) this.h.onResume();
      else if (a === 'save' && this.h.onSave) this.h.onSave();
      else if (a === 'load' && this.h.onLoad) this.h.onLoad();
      else if (a === 'settings' && this.h.onSettings) this.h.onSettings();
      else if (a === 'menu' && this.h.onMenu) this.h.onMenu();
    });
  }

  hidePause() { this.paused = false; this.clearScreens(); }

  // ── 设置 ─────────────────────────────────────────────
  showSettings(cfg, onBack, onApply) {
    this.clearScreens();
    const R = cfg.render || {}, A = cfg.audio || {}, Pl = cfg.player || {}, C = cfg.camera || {}, AI = cfg.ai || {}, W = cfg.world || {};
    const seasonNow = ['spring', 'summer', 'autumn', 'winter'].includes(W.season) ? W.season : 'summer';
    const weatherNow = W.weatherMode || 'auto';
    const weatherOpts = Object.values(WEATHERS)
      .map((w) => `<option value="${w.id}" ${weatherNow === w.id ? 'selected' : ''}>${w.icon} ${w.label}</option>`)
      .join('');
    const seasonNames = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
    const scalePct = (v) => Math.round((Number(v) || 1) * 100);
    const el = document.createElement('div');
    el.className = 'dd-screen dd-modal';
    el.innerHTML = `
      <div class="dd-db dd-panel" style="width:min(760px,94vw)">
        <div class="dd-inv-head"><div class="dd-title">设置</div><button class="dd-btn" data-act="back">返回</button></div>
        <div class="dd-settings">
          <div class="dd-field"><label>画质</label>
            <select id="s-quality">
              <option value="low" ${R.quality === 'low' ? 'selected' : ''}>低（省电，无阴影）</option>
              <option value="medium" ${R.quality === 'medium' ? 'selected' : ''}>中（默认）</option>
              <option value="high" ${R.quality === 'high' ? 'selected' : ''}>高（阴影 + 远视距）</option>
            </select>
          </div>
          <div class="dd-field"><label>天气</label>
            <select id="s-weather">
              <option value="auto" ${weatherNow === 'auto' ? 'selected' : ''}>自动（按季节随机推进）</option>
              ${weatherOpts}
            </select>
          </div>
          <div class="dd-field"><label>季节</label>
            <select id="s-season">
              ${Object.keys(seasonNames).map((k) => `<option value="${k}" ${seasonNow === k ? 'selected' : ''}>${seasonNames[k]}</option>`).join('')}
            </select>
          </div>
          <div class="dd-field"><label>植被区域</label>
            <select id="s-region">
              ${Object.entries(TREE_REGIONS).map(([k, r]) => `<option value="${k}" ${(W.region || 'temperate') === k ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </div>
          <div class="dd-field"><label>天气持续时长 <span class="dd-val" id="v-wscale">${scalePct(W.weatherScale)}%</span></label>
            <input type="range" id="s-wscale" min="20" max="400" step="10" value="${Math.min(400, Math.max(20, scalePct(W.weatherScale)))}">
          </div>
          <div class="dd-field"><label>僵尸上限 <span class="dd-val" id="v-zombies">${AI.maxZombies}</span></label>
            <input type="range" id="s-zombies" min="0" max="80" step="2" value="${AI.maxZombies}">
          </div>
          <div class="dd-field"><label>主音量 <span class="dd-val" id="v-master">${Math.round(A.master * 100)}%</span></label>
            <input type="range" id="s-master" min="0" max="100" value="${Math.round(A.master * 100)}">
          </div>
          <div class="dd-field"><label>音效 <span class="dd-val" id="v-sfx">${Math.round(A.sfx * 100)}%</span></label>
            <input type="range" id="s-sfx" min="0" max="100" value="${Math.round(A.sfx * 100)}">
          </div>
          <div class="dd-field"><label>环境音 <span class="dd-val" id="v-ambient">${Math.round(A.ambient * 100)}%</span></label>
            <input type="range" id="s-ambient" min="0" max="100" value="${Math.round(A.ambient * 100)}">
          </div>
          <div class="dd-field"><label>声音开关</label>
            <select id="s-audio"><option value="1" ${A.enabled ? 'selected' : ''}>开启</option><option value="0" ${!A.enabled ? 'selected' : ''}>关闭</option></select>
          </div>
          <div class="dd-field"><label>鼠标灵敏度 <span class="dd-val" id="v-sens">${(C.sensitivity * 1000).toFixed(1)}</span></label>
            <input type="range" id="s-sens" min="1" max="10" step="1" value="${Math.round(C.sensitivity * 1000)}">
          </div>
          <div class="dd-field"><label>视野 FOV <span class="dd-val" id="v-fov">${C.fov}</span></label>
            <input type="range" id="s-fov" min="60" max="100" step="1" value="${C.fov}">
          </div>
        </div>
        <div class="dd-actions">
          <button class="dd-btn dd-primary" data-act="apply">应用</button>
          <button class="dd-btn" data-act="back">返回</button>
          <span class="dd-hint" style="align-self:center">提示：修改画质会重建阴影与视距；换季会重载树木几何。</span>
        </div>
      </div>`;
    this.els.screens.appendChild(el);

    const bind = (id, out) => {
      const input = el.querySelector(id);
      if (!input) return;
      input.addEventListener('input', () => {
        out(input);
      });
    };
    const quality = el.querySelector('#s-quality');
    const zombies = el.querySelector('#s-zombies');
    const master = el.querySelector('#s-master');
    const sfx = el.querySelector('#s-sfx');
    const ambient = el.querySelector('#s-ambient');
    const audioSel = el.querySelector('#s-audio');
    const sens = el.querySelector('#s-sens');
    const fov = el.querySelector('#s-fov');
    const weatherSel = el.querySelector('#s-weather');
    const seasonSel = el.querySelector('#s-season');
    const regionSel = el.querySelector('#s-region');
    const wscale = el.querySelector('#s-wscale');
    zombies.addEventListener('input', () => { el.querySelector('#v-zombies').textContent = zombies.value; });
    master.addEventListener('input', () => { el.querySelector('#v-master').textContent = `${master.value}%`; });
    sfx.addEventListener('input', () => { el.querySelector('#v-sfx').textContent = `${sfx.value}%`; });
    ambient.addEventListener('input', () => { el.querySelector('#v-ambient').textContent = `${ambient.value}%`; });
    sens.addEventListener('input', () => { el.querySelector('#v-sens').textContent = Number(sens.value).toFixed(1); });
    fov.addEventListener('input', () => { el.querySelector('#v-fov').textContent = fov.value; });
    wscale.addEventListener('input', () => { el.querySelector('#v-wscale').textContent = `${wscale.value}%`; });
    bind('#s-master', () => {});

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (this.h.click) this.h.click();
      const a = btn.getAttribute('data-act');
      if (a === 'back' && onBack) { onBack(); return; }
      if (a === 'apply' && onApply) {
        onApply({
          quality: quality.value,
          maxZombies: Number(zombies.value),
          master: Number(master.value) / 100,
          sfx: Number(sfx.value) / 100,
          ambient: Number(ambient.value) / 100,
          audioEnabled: audioSel.value === '1',
          sensitivity: Number(sens.value) / 1000,
          fov: Number(fov.value),
          weatherMode: weatherSel.value,
          season: seasonSel.value,
          weatherScale: Number(wscale.value) / 100,
          region: regionSel.value,
        });
      }
    });
  }

  // ── 足球数据库 ────────────────────────────────────────
  showDatabase(summary) {
    this.clearScreens();
    const s = summary || {};
    const factions = s.factions || [];
    const rows = factions.map((f) => `
      <tr>
        <td><span class="dd-swatch" style="background:${esc(f.color)}"></span>${esc(f.name)}</td>
        <td>${esc(f.club)}</td>
        <td>${esc(f.country)}</td>
        <td>${f.role === 'friendly' ? '幸存者' : '掠夺者'}</td>
        <td>${f.squad}</td>
      </tr>`).join('');
    const el = document.createElement('div');
    el.className = 'dd-screen dd-modal';
    el.innerHTML = `
      <div class="dd-db dd-panel">
        <div class="dd-inv-head"><div class="dd-title">足球数据库 · 世界背景来源</div>
          <button class="dd-btn" data-act="back">返回</button></div>
        <div class="dd-hint">
          数据来源：<b>${esc(s.source || '未知')}</b> ·
          原始库 <b>${s.original && s.original.clubs ? s.original.clubs : s.clubs}</b> 俱乐部 /
          <b>${s.original && s.original.players ? s.original.players : s.players}</b> 球员 /
          <b>${s.original && s.original.leagues ? s.original.leagues : s.leagues}</b> 联赛 ·
          本局载入 <b>${s.players}</b> 名球员身份 ·
          外观生成器：<b>${s.appearance ? '已接入原项目 appearance.js' : '未接入（使用兜底外观）'}</b>
        </div>
        <div class="dd-section">阵营（由俱乐部数据映射）</div>
        <table>
          <thead><tr><th>阵营</th><th>来源俱乐部</th><th>国家</th><th>立场</th><th>阵容人数</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="dd-dim">数据未载入</td></tr>'}</tbody>
        </table>
        <div class="dd-hint" style="margin-top:14px">
          说明：球员 ID 与俱乐部 ID 完全沿用原数据，因此同一个球员在不同存档里永远是同一张脸、同一件球衣。
          游戏专属属性（生命、阵营、背包、掉落）保存在游戏侧存档中，<b>不写回原始足球数据库</b>。
        </div>
      </div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.closest('button[data-act="back"]') && this.h.onClosePanel) this.h.onClosePanel(); });
  }

  // ── HUD 更新 ─────────────────────────────────────────
  update(dt, st) {
    if (!this._built || !st) return;
    const pct = (v, m) => `${Math.max(0, Math.min(100, (v / Math.max(1, m)) * 100))}%`;
    if (this.els.hp) {
      this.els.hp.style.width = pct(st.health, st.maxHealth);
      this.els.hpVal.textContent = Math.ceil(st.health);
      this.els.hunger.style.width = pct(st.hunger, st.maxHunger || 100);
      this.els.hungerVal.textContent = Math.ceil(st.hunger);
      this.els.thirst.style.width = pct(st.thirst, st.maxThirst || 100);
      this.els.thirstVal.textContent = Math.ceil(st.thirst);
      this.els.stamina.style.width = pct(st.stamina, st.maxStamina || 100);
      this.els.staminaVal.textContent = Math.ceil(st.stamina);
    }

    // 状态条：食物 buff（饱腹/糖分冲刺/中毒…，带倒计时）+ 医疗伤情（流血/感染/骨折/疼痛）+ 治疗进度
    if (this.els.buffs) {
      const list = (st.buffs || []).filter((b) => b && b.left > 0);
      const cond = (st.conditions || []).filter((c) => c && c.severity > 0.01);
      const treat = st.treating && st.treating.progress < 1 ? st.treating : null;
      const sig = list.map((b) => `${b.id}:${Math.ceil(b.left)}`).join('|')
        + '#' + cond.map((c) => `${c.id}:${Math.round(c.severity * 100)}`).join(',')
        + '#' + (treat ? `${treat.name}:${Math.round(treat.progress * 100)}` : '');
      if (sig !== this._buffSig) {
        this._buffSig = sig;
        const chips = list.map((b) => {
          const s = Math.max(0, Math.ceil(b.left));
          const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
          return `<span class="dd-buff${b.bad ? ' dd-buff-bad' : ''}" title="${esc(b.note || '')}">${esc(b.name)} <b>${t}</b></span>`;
        });
        const woundChips = cond.map((c) => {
          const pct = Math.round(c.severity * 100);
          return `<span class="dd-buff dd-buff-bad" title="${esc(c.note || '')}">${esc(c.icon || '✚')} ${esc(c.name)} ${pct}%</span>`;
        });
        const treatChip = treat
          ? `<span class="dd-buff" title="治疗中：跑动/腾空/受伤都会打断">✚ ${esc(treat.name)} ${Math.round(treat.progress * 100)}%</span>`
          : '';
        this.els.buffs.innerHTML = [...chips, ...woundChips, treatChip].join('');
      }
    }

    if (this.els.wname) {
      this.els.wname.textContent = st.weaponName || '徒手';
      this.els.ammo.textContent = st.ammo == null ? '—' : String(st.ammo);
      this.els.reserve.textContent = st.reserve == null ? '' : `／ ${st.reserve}`;
      this.els.reload.style.display = st.reloading ? '' : 'none';
    }

    if (this.els.crosshair) {
      // 连发散热也会让准星变宽（枪械功效：压枪/点射的反馈）
      const hot = Number(st.heat) > 0.3;
      this.els.crosshair.classList.toggle('dd-spread', !!st.aiming || !!st.moving || hot);
      if (this._hitT > 0) { this._hitT -= dt; this.els.crosshair.classList.add('dd-hit'); }
      else this.els.crosshair.classList.remove('dd-hit');
    }

    // 快捷栏
    if (this.els.quick && st.quickSlots) {
      const sig = st.quickSlots.map((s) => (s ? `${s.itemId}:${s.count}` : '-')).join('|') + `#${st.activeQuick}`;
      if (sig !== this._quickSig) {
        this._quickSig = sig;
        this.els.quick.innerHTML = st.quickSlots.map((s, i) => {
          if (!s) return `<div class="dd-slot"><span class="dd-idx">${i + 1}</span></div>`;
          const def = s.def || {};
          return `<div class="dd-slot ${i === st.activeQuick ? 'dd-active' : ''}" title="${esc(def.name || '')}">
            <span class="dd-idx">${i + 1}</span>
            <span>${esc(def.name || '物品')}</span>
            ${s.count > 1 ? `<span class="dd-cnt">${s.count}</span>` : ''}
          </div>`;
        }).join('');
      }
    }

    // 交互提示
    const promptText = st.prompt || '';
    if (promptText !== this._lastPrompt) {
      this._lastPrompt = promptText;
      this.els.prompt.textContent = promptText;
      this.els.prompt.classList.toggle('dd-on', !!promptText);
    }

    // 任务
    if (this.els.quest) {
      if (st.quest) {
        this.els.quest.style.display = '';
        this.els.quest.innerHTML = `<div class="dd-qname">${esc(st.quest.name)}</div>`
          + `<div class="dd-qobj ${st.quest.done ? 'dd-done' : ''}">${esc(st.quest.objective)}</div>`;
      } else {
        this.els.quest.style.display = 'none';
      }
    }

    // 右上角状态
    if (this.els.topright && st.chips) {
      const sig = st.chips.join('|');
      if (sig !== this._chipSig) {
        this._chipSig = sig;
        this.els.topright.innerHTML = st.chips.map((c) => `<div class="dd-chip">${c}</div>`).join('');
      }
    }

    // 受伤红晕
    if (this.els.vignette) {
      if (this._damageT > 0) { this._damageT -= dt; this.els.vignette.classList.add('dd-on'); }
      else this.els.vignette.classList.toggle('dd-on', st.health / Math.max(1, st.maxHealth) < 0.3);
    }
  }

  hitMarker() { this._hitT = 0.14; }
  flashDamage() { this._damageT = 0.3; }

  setPrompt(text) {
    if (!this.els.prompt) return;
    if (text === this._lastPrompt) return;
    this._lastPrompt = text;
    this.els.prompt.textContent = text || '';
    this.els.prompt.classList.toggle('dd-on', !!text);
  }

  toast(msg, kind = '') {
    if (!this.els.toasts) return;
    const el = document.createElement('div');
    el.className = `dd-toast ${kind ? `dd-${kind}` : ''}`;
    el.textContent = msg;
    this.els.toasts.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (e) {} }, 2600);
    while (this.els.toasts.children.length > 5) this.els.toasts.firstChild.remove();
  }

  // ── 背包 ─────────────────────────────────────────────
  openInventory(player) {
    this.inventoryOpen = true;
    const inv = player.inventory;
    const slots = inv.slots.map((s, i) => this._itemCard(s, i, 'bag')).join('');
    const quick = inv.quick.map((s, i) => this._itemCard(s, i, 'quick')).join('');
    const el = document.createElement('div');
    el.className = 'dd-inv';
    el.id = 'dd-inv-screen';
    el.innerHTML = `
      <div class="dd-inv-box dd-panel">
        <div class="dd-inv-head">
          <div>
            <div class="dd-title">背包</div>
            <div class="dd-hint">负重 ${inv.weight.toFixed(1)} / ${inv.maxWeight} kg ${inv.isOverweight ? '<b style="color:#c05a4a">超重</b>' : ''}</div>
          </div>
          <button class="dd-btn" data-act="close">关闭 (Tab)</button>
        </div>
        <div class="dd-section">快捷栏</div>
        <div class="dd-inv-grid">${quick || '<div class="dd-dim">空</div>'}</div>
        <div class="dd-section">物品</div>
        <div class="dd-inv-grid">${slots || '<div class="dd-dim">空</div>'}</div>
        <div class="dd-hint" style="margin-top:14px">
          点击物品：食物/饮水/药品 → 使用；武器 → 装备；弹药会显示数量。
          按 <span class="dd-kbd">G</span> 丢弃当前手持武器。
        </div>
      </div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => {
      if (this.h.click) this.h.click();
      if (e.target.closest('button[data-act="close"]')) { this.closeInventory(); return; }
      const card = e.target.closest('[data-slot-index]');
      if (!card) return;
      const idx = Number(card.getAttribute('data-slot-index'));
      const list = card.getAttribute('data-slot-list');
      if (this.h.onUseItem) this.h.onUseItem(list, idx);
      this.refreshInventory(player);
    });
  }

  _itemCard(slotRec, index, list) {
    if (!slotRec) return `<div class="dd-item dd-empty" data-slot-index="${index}" data-slot-list="${list}"></div>`;
    const def = slotRec.def || {};
    const glyph = ITEM_GLYPH[def.icon] || '▫';
    // 食物/饮水的功效说明（饱食/水分/体力 + buff 时长 + 中毒风险），鼠标悬停或直接看得见
    const eff = def.kind === 'medical' ? describeTreat(def) : describeEffects(def);
    const effLine = eff.text ? `<div class="dd-ieff" title="${esc(eff.text)}">${esc(eff.text)}</div>` : '';
    const riskLine = eff.risk ? `<div class="dd-irisk">${esc(eff.risk)}</div>`
      : (eff.note ? `<div class="dd-irisk">${esc(eff.note)}</div>` : '');
    return `<div class="dd-item" data-slot-index="${index}" data-slot-list="${list}" title="${esc(def.desc || '')}">
      <div class="dd-iname">${glyph} ${esc(def.name || slotRec.itemId)}</div>
      <div class="dd-ikind">${esc(KIND_LABEL[def.kind] || def.kind || '')}</div>
      ${effLine}${riskLine}
      ${slotRec.count > 1 ? `<div class="dd-inum">${slotRec.count}</div>` : ''}
    </div>`;
  }

  refreshInventory(player) {
    const box = document.getElementById('dd-inv-screen');
    if (!box || !player) return;
    const inv = player.inventory;
    const grid = box.querySelectorAll('.dd-inv-grid');
    if (grid[0]) grid[0].innerHTML = inv.quick.map((s, i) => this._itemCard(s, i, 'quick')).join('');
    if (grid[1]) grid[1].innerHTML = inv.slots.map((s, i) => this._itemCard(s, i, 'bag')).join('');
    const hint = box.querySelector('.dd-hint');
    if (hint) hint.innerHTML = hint.innerHTML.replace(/负重 [\d.]+ \/ [\d.]+ kg/, `负重 ${inv.weight.toFixed(1)} / ${inv.maxWeight} kg`);
  }

  closeInventory() {
    const wasOpen = this.inventoryOpen;
    this.inventoryOpen = false;
    const el = document.getElementById('dd-inv-screen');
    if (el) el.remove();
    // 关背包之后游戏要重新拿到指针锁定，否则视角动不了、还得再点一下画面
    if (wasOpen && this.h.onInventoryClose) this.h.onInventoryClose();
  }

  // ── 搜刮 ─────────────────────────────────────────────
  openLoot(title, items, onTake, onClose) {
    this.clearScreens();
    const rows = items.map((it, i) => `<div class="dd-loot-row" data-take="${i}">
        <span>${esc(it.name)}</span><span class="dd-dim">×${it.count}</span></div>`).join('');
    const el = document.createElement('div');
    el.className = 'dd-loot dd-panel';
    el.innerHTML = `
      <div class="dd-inv-head"><div class="dd-title">${esc(title)}</div>
        <button class="dd-btn" data-act="close">关闭</button></div>
      <div class="dd-loot-list">${rows || '<div class="dd-dim">空的……</div>'}</div>
      <div class="dd-hint">点击物品即可拿走。</div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => {
      if (this.h.click) this.h.click();
      if (e.target.closest('button[data-act="close"]')) { if (onClose) onClose(); return; }
      const row = e.target.closest('[data-take]');
      if (!row) return;
      const idx = Number(row.getAttribute('data-take'));
      if (onTake) onTake(idx);
    });
  }

  closeLoot() { this.clearScreens(); }

  /**
   * 后备箱双栏面板：左 = 后备箱（点击取出），右 = 背包（点击放入）。
   * @param {object} view {
   *   title, trunk: {items:[{name,count,weight}], weight, maxWeight},
   *   bag: {items:[{name,count,weight}], weight, maxWeight},
   *   onTake(i), onStore(i), onClose()
   * }
   */
  openTrunk(view) {
    this.clearScreens();
    const kg = (n) => `${n.toFixed(1)}kg`;
    const row = (it, i, attr) => `<div class="dd-loot-row" data-${attr}="${i}">
        <span>${esc(it.name)}${it.count > 1 ? ` <span class="dd-dim">×${it.count}</span>` : ''}</span>
        <span class="dd-dim">${kg((it.weight || 0) * it.count)}</span></div>`;
    const trunkRows = view.trunk.items.length
      ? view.trunk.items.map((it, i) => row(it, i, 'take')).join('')
      : '<div class="dd-trunk-empty">空的</div>';
    const bagRows = view.bag.items.length
      ? view.bag.items.map((it, i) => row(it, i, 'store')).join('')
      : '<div class="dd-trunk-empty">背包是空的</div>';
    const el = document.createElement('div');
    el.className = 'dd-loot dd-panel dd-trunk';
    el.innerHTML = `
      <div class="dd-inv-head"><div class="dd-title">${esc(view.title)}</div>
        <button class="dd-btn" data-act="close">关闭</button></div>
      <div class="dd-trunk-cols">
        <div class="dd-trunk-col">
          <div class="dd-trunk-col-head"><span>后备箱 · 点击取出</span><span>${kg(view.trunk.weight)} / ${kg(view.trunk.maxWeight)}</span></div>
          <div class="dd-loot-list">${trunkRows}</div>
        </div>
        <div class="dd-trunk-col">
          <div class="dd-trunk-col-head"><span>背包 · 点击放入</span><span>${kg(view.bag.weight)} / ${kg(view.bag.maxWeight)}</span></div>
          <div class="dd-loot-list">${bagRows}</div>
        </div>
      </div>
      <div class="dd-hint">后备箱按重量上限装东西（车型不同容量不同）；放不进去时会提示原因。</div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => {
      if (this.h.click) this.h.click();
      if (e.target.closest('button[data-act="close"]')) { if (view.onClose) view.onClose(); return; }
      const take = e.target.closest('[data-take]');
      if (take) { if (view.onTake) view.onTake(Number(take.getAttribute('data-take'))); return; }
      const store = e.target.closest('[data-store]');
      if (store) { if (view.onStore) view.onStore(Number(store.getAttribute('data-store'))); }
    });
  }

  // ── 对话 ─────────────────────────────────────────────
  showDialogue(name, text, options, onChoose) {
    this.clearScreens();
    const el = document.createElement('div');
    el.className = 'dd-dialog dd-panel';
    const opts = (options || []).map((o, i) => `<button class="dd-dopt" data-opt="${i}">${esc(o.label)}</button>`).join('');
    el.innerHTML = `<div class="dd-dname">${esc(name)}</div><div class="dd-dtext">${esc(text)}</div>
      <div class="dd-dopts">${opts || '<button class="dd-dopt" data-opt="-1">离开</button>'}</div>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-opt]');
      if (!btn) return;
      if (this.h.click) this.h.click();
      const i = Number(btn.getAttribute('data-opt'));
      if (onChoose) onChoose(i);
    });
  }

  closeDialogue() { this.clearScreens(); }

  // ── 死亡 ─────────────────────────────────────────────
  showDeath(onRespawn, seconds) {
    this.clearScreens();
    const el = document.createElement('div');
    el.className = 'dd-dead';
    el.innerHTML = `<h2>你倒下了</h2><p>${seconds ? `${seconds} 秒后可以在营地重生（按 R 立即重生）` : '按 R 在营地重生'}</p>
      <button class="dd-btn dd-primary" data-act="respawn">立即重生</button>`;
    this.els.screens.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('button[data-act="respawn"]') && onRespawn) onRespawn();
    });
  }

  setDeathCountdown(seconds) {
    const p = this.root && this.root.querySelector('.dd-dead p');
    if (p) p.textContent = `${Math.max(0, Math.ceil(seconds))} 秒后可以在营地重生（按 R 立即重生）`;
  }
}

export default { GameUI };
