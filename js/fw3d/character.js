// FW3D · 低模球员（延续《终场之后》的方块人方向，重做肢体与动作）
// 改进点：
//  1. 两段式四肢（大腿/小腿、上臂/前臂），膝肘有独立枢轴
//  2. 跑动周期：对侧摆臂 + 膝盖屈曲 + 躯干前倾 + 头部稳定 + 落脚滚动
//  3. 待机：重心左右移动、呼吸、偶发转头；冲刺：步频加快、摆幅加大、身体更低
//  4. 射门/传球/铲球一次性姿态，带缓入缓出
// [players-subsystem] 参数化外观子系统（纯数据层 + 参数化身体构造）
import { toMeshLook, appearanceFor } from './players/appearance.js';
import { likenessOf } from './players/real-likeness.js';
import { buildParametricBody } from './players/body.js';

export function createPlayerModel(THREE, opts = {}) {
  const {
    jersey = 0x2f5e42, shorts = 0xefeee4, skin = 0xb0805e, hair = 0x14100e,
    number = 9, name = '', scale = 1, boot = 0x14161a, dominantFoot = 'right',
    accent = null, hairStyle = 'short', captain = false, cache = null,
    socks = null, detail = 'full', playerId = null, player = null,
  } = opts;

  // 共享缓存（每场比赛一份）：材质按 颜色+粗糙度 复用、盒体几何按尺寸复用。
  // 22 人 × 约 20 个 Mesh 在分享前是 279 材质 / 680 几何；共享后材质降到十几、几何降到几十。
  // 注意：draw call 不会因此减少（每个 Mesh 仍是一次 draw），要减 draw call 得合并几何或降 LOD。
  const shared = cache instanceof Map ? cache : null;
  const M = (color, rough = 0.85) => {
    const key = 'm|' + color + '|' + rough;
    if (shared) { const hit = shared.get(key); if (hit) return hit; }
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 });
    if (shared) shared.set(key, m);
    return m;
  };
  const boxGeo = (w, h, d) => {
    const key = 'g|' + w + '|' + h + '|' + d;
    if (shared) { const hit = shared.get(key); if (hit) return hit; }
    const gm = new THREE.BoxGeometry(w, h, d);
    if (shared) shared.set(key, gm);
    return gm;
  };
  const planeGeo = (w, h) => {
    const key = 'p|' + w + '|' + h;
    if (shared) { const hit = shared.get(key); if (hit) return hit; }
    const gm = new THREE.PlaneGeometry(w, h);
    if (shared) shared.set(key, gm);
    return gm;
  };

  const g = new THREE.Group();

  // ── [players-subsystem] 外观参数化分支 ────────────────────────────────────
  // opts.look（players/appearance.js 的 toMeshLook 产出）或 opts.appearance 存在时，
  // 走 parameters/buildParametricBody 的路径；否则走下面的原低模构造（一字未改）。
  // 两条路径产出**同构 rig**，所以下面的全部动画代码不区分来源。
  const lookSrc = opts.look
    || (opts.appearance ? toMeshLook(opts.appearance) : null)
    // [players-subsystem] 只给 playerId 也能拿到确定性外观（场景里最小改动即可升级）
    || (opts.player ? toMeshLook(appearanceFor(opts.player, {})) : null)
    || (playerId ? toMeshLook(appearanceFor({ id: String(playerId), position: opts.position || null, age: opts.age || null })) : null);
  let torso, head, armL, armR, legL, legR;
  let HIP_Y = 0.95;
  let PDIMS = { torsoD: 0.24 };
  let parametric = null;      // 参数化身体构造的返回值（含 detailMesh / boxCount / dims）

  // 号码 / 姓名贴图（两条路径共用；z 由躯干厚度决定）
  // 修复（外观子系统阶段发现）：旧实现给 256px 画布贴图保留了 mipmap，
  // 远处缩小时透明区与白色字形被平均成灰白色块 → 号码看起来像贴了一块号码布（白球衣上还会出现"深色数字"）。
  // 低模风格不需要 mipmap，关掉并改用线性过滤。
  const canvasTex = (draw, w = 256, h = 256) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  function addPlates(torsoGroup, dims) {
    const zf = (dims && dims.torsoD ? dims.torsoD : 0.24) * 0.5 + 0.002;
    // 号码/姓名颜色按球衣亮度自动反色：浅色球衣用深色字，否则白色数字会糊在白球衣上看不见
    const jc = new THREE.Color(jersey);
    const lum = 0.299 * jc.r + 0.587 * jc.g + 0.114 * jc.b;
    const ink = lum > 0.55 ? '#14171c' : '#ffffff';
    if (number != null) {
      const tex = canvasTex((ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = ink; ctx.font = '700 150px system-ui,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(number), w / 2, h / 2);
      });
      const numFront = new THREE.Mesh(planeGeo(0.22, 0.22), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
      numFront.position.set(0, 0.3, zf); torsoGroup.add(numFront);
      const numBack = numFront.clone();
      numBack.position.set(0, 0.32, -zf); numBack.rotation.y = Math.PI; torsoGroup.add(numBack);
    }
    if (name) {
      const tex = canvasTex((ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = ink; ctx.font = '700 56px "Microsoft YaHei",system-ui,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(name, w / 2, h / 2);
      }, 512, 128);
      const plate = new THREE.Mesh(planeGeo(0.42, 0.105), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
      plate.position.set(0, 0.52, -(zf + 0.001)); plate.rotation.y = Math.PI; torsoGroup.add(plate);
    }
  }

  // ── 头顶姓名牌（团战认人用）─────────────────────────────────────────────
  // 视觉语言与项目其它 UI 一致：**不画框、不做渐变、不加发光**，只保留
  //   ① 一行中等字重的名字（队伍色）
  //   ② 一条 2px 的队伍色细线（下方留白）—— 对应记分牌"一条辅助线"的规则
  //   ③ 一层极轻的暗色投影，只用来保证在天空/草地/看台三种背景上都能读
  // 与球衣背面的姓名贴图（addPlates）不同：这是世界坐标里的头顶牌，随距离缩放。
  const NAME_TAG_W = 512, NAME_TAG_H = 128, NAME_TAG_TEXT_Y = 58, NAME_TAG_RULE_Y = 92;
  const NAME_TAG_SS = 2;   // 超采样倍数：画布 1024×256，绘制仍用 512×128 的逻辑坐标
  // 姓名牌字体栈：**按可用性自动降级**，不打包任何字体文件（避免把商业字体塞进仓库）。
  //   ① 方正金陵 / 文悦新青年体 —— 商业字体，只有本机装了才会命中（装了即生效，无需改代码）
  //   ② 思源宋体 Noto Serif SC / Source Han Serif SC —— OFL，笔画更讲究，观感更像"印刷品"
  //   ③ 思源黑体 Noto Sans SC → 微软雅黑 → 系统默认
  // 字体预设：canvas 只能吃 font-family 列表，所以每个预设就是一套优先级
  const NAME_TAG_FONT_PRESETS = {
    // 自动：装了金陵/新青年就用，否则思源宋体（本项目默认）
    auto: '"FZJinLing","方正金陵","Jinling","WenYue XinQingNianTi","文悦新青年体","XinQingNianTi","Noto Serif SC","Source Han Serif SC","思源宋体","Noto Sans SC","Microsoft YaHei","PingFang SC",system-ui,sans-serif',
    serif: '"Noto Serif SC","Source Han Serif SC","思源宋体","Songti SC","SimSun",serif',
    sans: '"Noto Sans SC","Source Han Sans SC","Microsoft YaHei","PingFang SC",system-ui,sans-serif',
    kai: '"STKaiti","KaiTi","楷体","华文楷体","Noto Serif SC",serif',
    jinling: '"FZJinLing","方正金陵","Jinling","Noto Serif SC",serif',
    xqn: '"WenYue XinQingNianTi","文悦新青年体","XinQingNianTi","Noto Sans SC","Microsoft YaHei",sans-serif',
  };
  let nameTagFontKey = 'auto';
  try {
    const saved = (typeof localStorage !== 'undefined') && localStorage.getItem('fw3d.nameTagFont');
    if (saved && NAME_TAG_FONT_PRESETS[saved]) nameTagFontKey = saved;
  } catch (e) {}
  const nameTagFontFamilies = () => NAME_TAG_FONT_PRESETS[nameTagFontKey] || NAME_TAG_FONT_PRESETS.auto;
  function setNameTagFont(key) {
    const k = NAME_TAG_FONT_PRESETS[key] ? key : 'auto';
    nameTagFontKey = k;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('fw3d.nameTagFont', k); } catch (e) {}
    return k;
  }
  function nameTagFont() { return nameTagFontKey; }
  function buildNameTag(text, colorStr) {
    const col = colorStr || '#f4f7fa';
    const label = String(text || '');
    const fontOf = (px) => '500 ' + px + 'px ' + nameTagFontFamilies();
    // ① 先量文字：画布宽度**跟着名字走**（不再固定 512 宽、字只占中间一小段）。
    //    这一步决定了屏幕上字形的大小 —— 固定画布时 30 m 外名字只有几像素，根本读不出来。
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = fontOf(46);
    let textW = probe.measureText(label).width;
    const PAD_X = 10;                       // 左右各留 10 个逻辑像素
    const cw = Math.max(96, Math.min(NAME_TAG_W, Math.ceil(textW + PAD_X * 2)));
    const c = document.createElement('canvas');
    c.width = cw * NAME_TAG_SS; c.height = NAME_TAG_H * NAME_TAG_SS;
    const ctx = c.getContext('2d');
    ctx.scale(NAME_TAG_SS, NAME_TAG_SS);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = fontOf(46);
    try { ctx.letterSpacing = '2px'; } catch (e) {}
    textW = ctx.measureText(label).width;
    // ② 细描边 + 队伍色填充：广播字幕的做法 —— 不画底框也能在天空/草地/看台上读清
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(5,9,14,0.6)';
    ctx.strokeText(label, cw / 2, NAME_TAG_TEXT_Y);
    ctx.shadowColor = 'rgba(4,7,11,0.32)';
    ctx.shadowBlur = 9;
    ctx.fillStyle = col;
    ctx.fillText(label, cw / 2, NAME_TAG_TEXT_Y);
    ctx.shadowBlur = 0;
    // ③ 一条细线（宽度 = 文字宽度，两端各收 6px），不做满宽下划线
    const tw = Math.max(24, Math.min(textW - 12, cw - PAD_X * 2 - 8));
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = col;
    ctx.fillRect((cw - tw) / 2, NAME_TAG_RULE_Y, tw, 2);
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    // 姓名牌会被大幅缩小（远处），必须开 mipmap + 三线性，否则文字会抖成一团马赛克
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8;
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, alphaTest: 0.02 });
    const sp = new THREE.Sprite(mat);
    const aspect = NAME_TAG_H / cw;          // 高 / 宽：宽名字更扁，短名字更方
    sp.userData.tagAspect = aspect;
    sp.userData.textWidth = textW;
    sp.userData.canvasWidth = cw;
    sp.scale.set(1.25, 1.25 * aspect, 1);
    sp.position.set(0, 2.06, 0);      // 头顶（模型总高约 1.85 m）
    sp.renderOrder = 30;
    sp.name = 'nameTag';
    return sp;
  }
  let nameTag = null, nameTagKey = '';

    if (lookSrc) {
    const built = buildParametricBody(THREE, lookSrc, { jersey, shorts, accent, boot, socks, captain });
    parametric = built;
    torso = built.torso; head = built.head;
    armL = built.armL; armR = built.armR; legL = built.legL; legR = built.legR;
    HIP_Y = built.hipY; PDIMS = built.dims;
    g.add(torso);
    addPlates(torso, PDIMS);
  } else {
  const jerseyMat = M(jersey, 0.8), shortsMat = M(shorts, 0.88);
  const skinMat = M(skin, 0.86), hairMat = M(hair, 0.96), sockMat = M(0x14161a, 0.9);
  const bootMat = M(boot, 0.72);
  const accentMat = M(accent == null ? shorts : accent, 0.82);

  const box = (parent, w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(boxGeo(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  const SHOULDER_Y = 1.45;
  torso = new THREE.Group();
  torso.position.y = HIP_Y;
  g.add(torso);
  box(torso, 0.44, 0.52, 0.24, 0, 0.26, 0, jerseyMat);      // 躯干
  box(torso, 0.045, 0.5, 0.245, -0.215, 0.26, 0, accentMat);   // 左侧条
  box(torso, 0.045, 0.5, 0.245, 0.215, 0.26, 0, accentMat);    // 右侧条
  box(torso, 0.42, 0.10, 0.24, 0, 0.02, 0, shortsMat);      // 腰带
  box(torso, 0.20, 0.09, 0.18, 0, 0.535, 0, skinMat);        // 脖子

  head = new THREE.Group();
  head.position.y = 0.575;
  torso.add(head);
  box(head, 0.26, 0.28, 0.24, 0, 0.12, 0, skinMat);
  if (hairStyle !== 'none') box(head, 0.27, 0.09, 0.25, 0, 0.28, 0, hairMat);   // 短发
  if (hairStyle === 'long') {
    box(head, 0.29, 0.2, 0.06, 0, 0.19, -0.13, hairMat);                        // 长发
    box(head, 0.05, 0.16, 0.24, -0.14, 0.2, 0, hairMat);
    box(head, 0.05, 0.16, 0.24, 0.14, 0.2, 0, hairMat);
  }
  if (hairStyle === 'bun') box(head, 0.1, 0.1, 0.1, 0, 0.33, -0.12, hairMat);   // 丸子头
  box(head, 0.05, 0.04, 0.02, -0.06, 0.14, 0.125, M(0x1a1512, 1));
  box(head, 0.05, 0.04, 0.02, 0.06, 0.14, 0.125, M(0x1a1512, 1));

  addPlates(torso, { torsoD: 0.24 });

  // ── 手臂：肩 → 上臂 → 肘 → 前臂
  const makeArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.27, 0.46, 0);
    torso.add(shoulder);
    box(shoulder, 0.11, 0.28, 0.12, 0, -0.14, 0, jerseyMat);      // 上臂（短袖）
    box(shoulder, 0.10, 0.10, 0.11, 0, -0.30, 0, skinMat);        // 肘
    const forearm = new THREE.Group();
    forearm.position.y = -0.32;
    shoulder.add(forearm);
    box(forearm, 0.09, 0.26, 0.10, 0, -0.13, 0, skinMat);
    box(forearm, 0.10, 0.10, 0.11, 0, -0.28, 0.01, skinMat);      // 手
    return { shoulder, forearm };
  };
  armL = makeArm(-1); armR = makeArm(1);

  // ── 腿：髋 → 大腿 → 膝 → 小腿 → 脚
  const makeLeg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.12, -0.01, 0);
    torso.add(hip);
    box(hip, 0.155, 0.30, 0.17, 0, -0.16, 0, shortsMat);          // 大腿
    const shin = new THREE.Group();
    shin.position.y = -0.44;
    hip.add(shin);
    box(shin, 0.135, 0.40, 0.15, 0, -0.20, 0, skinMat);           // 小腿
    box(shin, 0.14, 0.16, 0.155, 0, -0.40, 0, sockMat);           // 袜
    box(shin, 0.145, 0.035, 0.16, 0, -0.335, 0, accentMat);       // 袜口条纹
    const foot = new THREE.Group();
    foot.position.y = -0.48;
    shin.add(foot);
    box(foot, 0.145, 0.09, 0.30, 0, 0.02, 0.07, bootMat);         // 鞋
    return { hip, shin, foot };
  };
  legL = makeLeg(-1); legR = makeLeg(1);
  }   // ← else：原低模构造结束

  // ── 裁判道具：红黄牌（挂在右手腕上，默认隐藏；只有 opts.cards 的模型才建，避免给 22 人加 draw call）
  let cardYellow = null, cardRed = null;
  if (opts.cards) {
    const cg = boxGeo(0.085, 0.115, 0.012);
    cardYellow = new THREE.Mesh(cg, M(0xd8b53c, 0.5));
    cardRed = new THREE.Mesh(cg, M(0xc32a1c, 0.5));
    for (const c of [cardYellow, cardRed]) {
      c.position.set(0, -0.36, 0.075);
      c.visible = false;
      armR.forearm.add(c);
    }
  }
  // 边裁旗（opts.flag）：一根长杆 + 一面旗，**一直拿在右手**（不是只在举旗时才出现）。
  // 旗杆沿手臂方向（局部 -y）伸出，手垂下时旗子挂在手边；举旗动作一抬手，旗子就跟着举起来。
  let flagGroup = null;
  if (opts.flag) {
    flagGroup = new THREE.Group();
    const pole = new THREE.Mesh(boxGeo(0.028, 0.62, 0.028), M(0xd8dde4, 0.55));
    pole.position.set(0, -0.31, 0);
    // 旗面：双面片 + 相对手臂转 35°，保证任何机位都不是"侧着一条线"
    const clothMat = new THREE.MeshStandardMaterial({ color: 0xf2d447, roughness: 0.5, side: THREE.DoubleSide });
    const cloth = new THREE.Mesh(planeGeo(0.4, 0.26), clothMat);
    cloth.position.set(0.2, -0.46, 0);
    cloth.rotation.y = 0.6;
    flagGroup.add(pole); flagGroup.add(cloth);
    flagGroup.position.set(0, -0.3, 0.04);
    flagGroup.visible = true;          // 边裁手里一直有旗
    armR.forearm.add(flagGroup);
  }
  // 亮牌：kind='yellow'|'red'，传 null 收起
  function showCard(kind) {
    if (cardYellow) cardYellow.visible = kind === 'yellow';
    if (cardRed) cardRed.visible = kind === 'red';
    st.cardKind = kind || null;
    return kind || null;
  }
  // 旗语：offside 高举过头 / throwIn 斜上举 / corner 指向角旗（都由 flagPose 一次性动作驱动）
  function flagPose(kind) { if (flagGroup) flagGroup.visible = true; play('flag', 1.0, { kind: kind || 'offside' }); }
  function hasFlag() { return !!flagGroup; }
  function flagVisible() { return !!(flagGroup && flagGroup.visible); }

  // ── 静态合并：同一关节组内、同材质的方块合并为一个 Mesh（减少 draw call）
  // 22 人 × 约 20 个 Mesh 是渲染瓶颈（≈440 call）；眼睛 2→1、球衣侧条 2→1、前臂+手 2→1（左右各一）
  // 每名球员少 4 个 draw call。几何只是把局部位移烘进顶点，关节组（rig）不变，动作完全不受影响。
  function mergeBoxMeshes(list) {
    let vCount = 0, iCount = 0;
    for (const m of list) {
      const gm = m.geometry;
      vCount += gm.attributes.position.count;
      iCount += gm.index ? gm.index.count : gm.attributes.position.count;
    }
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let vo = 0, io = 0;
    for (const m of list) {
      const gm = m.geometry, p = gm.attributes.position, n = gm.attributes.normal, u = gm.attributes.uv;
      const ox = m.position.x, oy = m.position.y, oz = m.position.z;
      for (let i = 0; i < p.count; i++) {
        const k = vo + i;
        pos[k * 3] = p.getX(i) + ox; pos[k * 3 + 1] = p.getY(i) + oy; pos[k * 3 + 2] = p.getZ(i) + oz;
        if (n) { nor[k * 3] = n.getX(i); nor[k * 3 + 1] = n.getY(i); nor[k * 3 + 2] = n.getZ(i); }
        if (u) { uv[k * 2] = u.getX(i); uv[k * 2 + 1] = u.getY(i); }
      }
      const gi = gm.index;
      const nn = gi ? gi.count : p.count;
      for (let i = 0; i < nn; i++) idx[io + i] = (gi ? gi.getX(i) : i) + vo;
      vo += p.count; io += nn;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = new THREE.Mesh(out, list[0].material);
    mesh.castShadow = true;
    return mesh;
  }
  function mergeSameMaterial(group) {
    const byMat = new Map();
    for (const child of group.children.slice()) {
      if (!child.isMesh || !child.geometry || !child.material || Array.isArray(child.material)) continue;
      if (child.geometry.type !== 'BoxGeometry') continue;
      const key = child.material.uuid;
      if (!byMat.has(key)) byMat.set(key, []);
      byMat.get(key).push(child);
    }
    for (const list of byMat.values()) {
      if (list.length < 2) continue;
      const merged = mergeBoxMeshes(list);
      for (const m of list) group.remove(m);
      group.add(merged);
    }
  }
  const groupsToMerge = [];
  g.traverse((o) => { if (o.isGroup) groupsToMerge.push(o); });
  for (const gr of groupsToMerge) mergeSameMaterial(gr);

  g.scale.setScalar(scale * ((lookSrc && lookSrc.heightScale) || 1));

  // ── 动画状态
  const st = { phase: 0, lean: 0, kickT: -1, slideT: -1, moveKind: 'forward', moveSide: 1,
    // 通用一次性动作（名字 / 已播时间 / 总时长 / 参数）：新动作都走这里，不再往 poseAction 里堆 if
    oneshot: null, cardKind: null, sit: false,
    // 跳跃（与头球分开计时）：跳跃负责"屈膝—蹬地—空中收腿—落地"，头球负责颈部那一下。
    // 两者要能同时存在 —— 先起跳，再在半空中甩头，所以不能都塞进 oneshot（那个是互斥的）。
    jump: null };

  // 坐姿（替补席 / 看台）：髋、膝各约 90°，躯干降到大腿高度，双手搭在膝上；头会慢慢左右看人。
  // 只在原地（speed ≤ 0.4）生效，一旦走动就自动回到待机/跑动姿态，不需要外部复位。
  function poseSit(t) {
    torso.position.y = HIP_Y - 0.30;
    torso.rotation.set(-0.06, 0, Math.sin(t * 0.5) * 0.012);
    head.rotation.set(0, Math.sin(t * 0.42) * 0.42, Math.sin(t * 0.31) * 0.03);
    legL.hip.rotation.set(-1.48, 0.10, 0);
    legR.hip.rotation.set(-1.48, -0.10, 0);
    legL.shin.rotation.set(1.46, 0, 0);
    legR.shin.rotation.set(1.46, 0, 0);
    legL.foot.rotation.set(0.02, 0, 0);
    legR.foot.rotation.set(0.02, 0, 0);
    armL.shoulder.rotation.set(0.55, 0, 0.16);
    armR.shoulder.rotation.set(0.55, 0, -0.16);
    armL.forearm.rotation.set(-0.75, 0, 0);
    armR.forearm.rotation.set(-0.75, 0, 0);
  }

  function poseIdle(t) {
    // 侧移/后退会改腿的外展角，回到待机要归位
    legL.hip.rotation.z = 0; legR.hip.rotation.z = 0;
    const cycle = Math.floor(t / 6) % 3;   // 每 6 秒换一种待机小动作
    if (cycle === 1) {
      // 张望
      head.rotation.y = Math.sin(t * 0.6) * 0.55;
      armL.shoulder.rotation.x = 0.08; armR.shoulder.rotation.x = 0.08;
      legL.hip.rotation.x = 0; legR.hip.rotation.x = 0;
      torso.rotation.z = Math.sin(t * 0.4) * 0.02;
      return;
    }
    if (cycle === 2) {
      // 伸展
      const k = (t % 6) / 1.2;
      const lift = Math.sin(Math.min(1, k) * Math.PI) * 1.6;
      armL.shoulder.rotation.x = -lift; armR.shoulder.rotation.x = -lift;
      armL.forearm.rotation.x = -0.2; armR.forearm.rotation.x = -0.2;
      head.rotation.x = -0.25 * Math.sin(Math.min(1, k) * Math.PI);
      return;
    }
    const sway = Math.sin(t * 0.9) * 0.03;
    torso.position.y = HIP_Y + Math.sin(t * 1.6) * 0.006;
    torso.rotation.z = sway * 0.4;
    head.rotation.y = Math.sin(t * 0.33) * 0.22;
    armL.shoulder.rotation.x = 0.05 + Math.sin(t * 1.3) * 0.04;
    armR.shoulder.rotation.x = 0.05 - Math.sin(t * 1.3 + 0.4) * 0.04;
    armL.shoulder.rotation.z = 0.12; armR.shoulder.rotation.z = -0.12;
    armL.forearm.rotation.x = -0.18; armR.forearm.rotation.x = -0.18;
    legL.hip.rotation.x = 0.02; legR.hip.rotation.x = -0.02;
    legL.shin.rotation.x = 0.04; legR.shin.rotation.x = 0.04;
  }

  // 步幅（每步米数）随速度略增：走路 1.0 → 冲刺约 2.0
  function strideOf(speed) {
    return 1.0 + Math.max(0, Math.min(8.5, speed)) * 0.12;
  }
  // 跑步/慢跑循环
  // 修复：旧实现用固定 0.016 s 推相位（st.phase += freq * 0.016），与真实 dt 脱钩，
  // 低帧率下腿的循环速度只有正确值的 1/4–1/10 → 人已经滑出去、腿还没迈完（滑步根因）。
  // 现在相位由"位移 / 一个循环的步幅"决定：一次循环覆盖 2 步，脚落地时相对地面基本不动。
  function poseRun(t, speed, dt) {
    legL.hip.rotation.z = 0; legR.hip.rotation.z = 0;   // 侧移留下的外展角归零
    const dtt = (isFinite(dt) && dt > 0) ? Math.min(dt, 0.1) : 0.016;
    const sp = Math.max(0, Math.min(1, speed / 8.5));
    const stride = strideOf(speed);
    const cycleDist = stride * 2;
    const cadence = Math.max(0.35, speed / cycleDist);   // 每秒循环数
    st.phase += cadence * dtt;
    if (st.phase > 4096) st.phase -= 4096;
    const p = st.phase * Math.PI * 2;
    const amp = 0.42 + sp * 0.62;              // 摆幅
    // 对侧摆动：左腿与右臂同相
    legL.hip.rotation.x = Math.sin(p) * amp;
    legR.hip.rotation.x = Math.sin(p + Math.PI) * amp;
    // 膝盖：抬腿时屈曲更多
    legL.shin.rotation.x = Math.max(0, -Math.sin(p - 0.7)) * (0.55 + sp * 0.75);
    legR.shin.rotation.x = Math.max(0, -Math.sin(p + Math.PI - 0.7)) * (0.55 + sp * 0.75);
    // 落脚滚动
    legL.foot.rotation.x = Math.sin(p + 1.2) * 0.25 * (0.4 + sp);
    legR.foot.rotation.x = Math.sin(p + Math.PI + 1.2) * 0.25 * (0.4 + sp);
    // 手臂反向摆动，肘部自然弯曲
    armL.shoulder.rotation.x = Math.sin(p + Math.PI) * (0.35 + sp * 0.5);
    armR.shoulder.rotation.x = Math.sin(p) * (0.35 + sp * 0.5);
    armL.shoulder.rotation.z = 0.16; armR.shoulder.rotation.z = -0.16;
    armL.forearm.rotation.x = -0.42 - sp * 0.35;
    armR.forearm.rotation.x = -0.42 - sp * 0.35;
    // 躯干前倾 + 轻微上下起伏 + 肩膀反向扭转
    st.lean += ((sp * 0.22) - st.lean) * 0.12;
    torso.rotation.x = st.lean;
    torso.rotation.y = Math.sin(p) * 0.12 * sp;
    torso.position.y = HIP_Y + Math.abs(Math.sin(p)) * 0.035 * sp;
    head.rotation.x = -st.lean * 0.7;
    head.rotation.y = -torso.rotation.y * 0.6;
  }

  // 侧移（左右滑步）：腿沿身体两侧开合，躯干朝移动侧轻压，双臂外展保持平衡。
  // 与跑动的区别是"髋外展 + 小步幅 + 不摆臂前后"，避免侧着走还像在跑步。
  function poseStrafe(speed, dt, side) {
    const dtt = (isFinite(dt) && dt > 0) ? Math.min(dt, 0.1) : 0.016;
    const sp = Math.max(0, Math.min(1, speed / 6));
    const stride = 0.55 + speed * 0.06;
    const cadence = Math.max(0.5, speed / (stride * 2));
    st.phase += cadence * dtt;
    if (st.phase > 4096) st.phase -= 4096;
    const p = st.phase * Math.PI * 2;
    const sgn = side >= 0 ? 1 : -1;
    const amp = 0.22 + sp * 0.5;
    legL.hip.rotation.z = (-0.16 + Math.sin(p) * amp * 0.5) * sgn;
    legR.hip.rotation.z = (0.16 - Math.sin(p + Math.PI) * amp * 0.5) * sgn;
    legL.hip.rotation.x = Math.sin(p) * 0.10;
    legR.hip.rotation.x = Math.sin(p + Math.PI) * 0.10;
    legL.shin.rotation.x = Math.max(0, Math.sin(p)) * 0.25;
    legR.shin.rotation.x = Math.max(0, Math.sin(p + Math.PI)) * 0.25;
    legL.foot.rotation.x = 0; legR.foot.rotation.x = 0;
    armL.shoulder.rotation.z = 0.34 + Math.sin(p) * 0.10;
    armR.shoulder.rotation.z = -0.34 + Math.sin(p) * 0.10;
    armL.shoulder.rotation.x = 0.10; armR.shoulder.rotation.x = 0.10;
    armL.forearm.rotation.x = -0.5; armR.forearm.rotation.x = -0.5;
    st.lean += ((sp * 0.06) - st.lean) * 0.15;
    torso.rotation.x = st.lean;
    torso.rotation.z = -sgn * (0.09 + sp * 0.05) + Math.sin(p) * 0.02;
    torso.rotation.y = 0;
    torso.position.y = HIP_Y - 0.03 + Math.abs(Math.sin(p)) * 0.02 * sp;
    head.rotation.x = -0.04; head.rotation.y = 0;
  }

  // 后退（背身跑）：腿部反向摆动、躯干略后仰、重心更低，手臂收敛在体侧。
  function poseBackpedal(speed, dt) {
    const dtt = (isFinite(dt) && dt > 0) ? Math.min(dt, 0.1) : 0.016;
    const sp = Math.max(0, Math.min(1, speed / 6));
    const stride = 0.8 + speed * 0.08;
    const cadence = Math.max(0.4, speed / (stride * 2));
    st.phase += cadence * dtt;
    if (st.phase > 4096) st.phase -= 4096;
    const p = st.phase * Math.PI * 2;
    const amp = 0.28 + sp * 0.42;
    legL.hip.rotation.z = 0; legR.hip.rotation.z = 0;
    legL.hip.rotation.x = -Math.sin(p) * amp;
    legR.hip.rotation.x = -Math.sin(p + Math.PI) * amp;
    legL.shin.rotation.x = Math.max(0, Math.sin(p - 0.5)) * (0.4 + sp * 0.5);
    legR.shin.rotation.x = Math.max(0, Math.sin(p + Math.PI - 0.5)) * (0.4 + sp * 0.5);
    legL.foot.rotation.x = -Math.sin(p) * 0.14;
    legR.foot.rotation.x = -Math.sin(p + Math.PI) * 0.14;
    armL.shoulder.rotation.x = -Math.sin(p + Math.PI) * (0.28 + sp * 0.3);
    armR.shoulder.rotation.x = -Math.sin(p) * (0.28 + sp * 0.3);
    armL.shoulder.rotation.z = 0.2; armR.shoulder.rotation.z = -0.2;
    armL.forearm.rotation.x = -0.6; armR.forearm.rotation.x = -0.6;
    st.lean += ((-0.06 - sp * 0.04) - st.lean) * 0.15;
    torso.rotation.x = st.lean;
    torso.rotation.z = 0;
    torso.rotation.y = Math.sin(p) * 0.05 * sp;
    torso.position.y = HIP_Y - 0.05 + Math.abs(Math.sin(p)) * 0.02 * sp;
    head.rotation.x = -st.lean * 0.5; head.rotation.y = 0;
  }

  // 由外部（arena 每帧按 速度×朝向 判定）设置步态种类
  function setMoveKind(kind, side) { st.moveKind = kind || 'forward'; st.moveSide = side >= 0 ? 1 : -1; }

  function kick(power = 1) { st.kickT = 0; st.kickPower = power; st.kickLeg = dominantFoot === 'left' ? legL : legR; }
  // 庆祝动作：slid=滑跪, arms=抱臂, sky=指天
  function celebratePose(type, dur) { st.celeb = { type: type || 'arms', t: 0, dur: dur > 0 ? dur : undefined }; }

  // 比赛细节动作：接球 / 护球 / 转身 / 失衡
  function receivePose(quality) { st.receive = { t: 0, q: Math.max(0, Math.min(1, quality == null ? 0.7 : quality)) }; }
  function shieldPose() { st.shield = true; }
  function turnPose(dir) { st.turn = { t: 0, dir: dir >= 0 ? 1 : -1 }; }
  function stumblePose() { st.stumble = { t: 0 }; }
  // 门将侧扑：dir = -1 左 / 1 右；high = 是否高球（决定躯干下沉与手臂角度）
  function divePose(dir, high) { st.dive = { t: 0, dir: dir >= 0 ? 1 : -1, high: !!high }; }
  // 头球：起跳 + 颈部前甩（0.45 s 一次性）
  function headerPose() { st.header = { t: 0 }; }
  // 起跳争顶（0.62 s）：屈膝蓄力 → 蹬地展体 → 空中收腿 → 落地缓冲。
  // 垂直位移由场景负责（arena 的 ctrl.air），这里只管关节。
  function jumpPose() { st.jump = { t: 0 }; }

  // ── 通用一次性动作：play('slide', 0.9) / play('card', 1.25, {kind:'red'})
  // 现有镜头/动作都可继续用各自的便捷函数（它们最终都落到这里或 poseDetail 上）
  const ONESHOT_DUR = {
    slide: 0.9, down: 1.15, getUp: 0.6, poke: 0.3, lunge: 0.45, intercept: 0.4,
    card: 1.25, whistle: 0.55, point: 0.8, appeal: 0.85,
    throwIn: 0.8, runUp: 0.5, crouch: 2.2, cut: 0.35, trapChest: 0.45, trapThigh: 0.4,
    flag: 1.0, punch: 0.5, headerClear: 0.5,
  };
  function play(name, dur, opts) {
    if (!name || !ONESHOT_DUR[name]) return null;
    st.oneshot = { name, t: 0, dur: dur || ONESHOT_DUR[name], opts: opts || {} };
    return name;
  }
  function slide() { play('slide', 0.9); }
  // 倒地 / 起身（铲球失败、被撞倒）：先倒 1.15 s，Arena 再调 getUp 接回站立
  function downPose(side) { play('down', 1.15, { side: side >= 0 ? 1 : -1 }); }
  function getUpPose(side) { play('getUp', 0.6, { side: side >= 0 ? 1 : -1 }); }
  // 抢断/拦截：伸脚捅球、大步上抢、侧身拦截
  function pokePose() { play('poke', 0.3); }
  function lungePose() { play('lunge', 0.45); }
  function interceptPose(side) { play('intercept', 0.4, { side: side >= 0 ? 1 : -1 }); }
  // 裁判示意：亮牌（自动展牌 + 举过头顶）、吹哨、指方向、抗议
  function cardPose(kind) { showCard(kind); play('card', 1.25, { kind }); }
  function whistlePose() { play('whistle', 0.55); }
  function pointPose(dir) { play('point', 0.8, { dir: dir >= 0 ? 1 : -1 }); }
  function appealPose() { play('appeal', 0.85); }
  // 界外球掷球（双手过顶 → 前甩）、点球助跑、门将压低重心、急停变向、胸部/大腿停球
  function throwInPose() { play('throwIn', 0.8); }
  function runUpPose() { play('runUp', 0.5); }
  function crouchPose() { play('crouch', 2.2); }
  function cutPose(side) { play('cut', 0.35, { side: side >= 0 ? 1 : -1 }); }
  function trapChestPose() { play('trapChest', 0.45); }
  function trapThighPose() { play('trapThigh', 0.4); }
  // 门将拳击球（单臂向前上方击球）/ 后卫解围甩头
  function punchPose() { play('punch', 0.5); }
  function headerClearPose() { play('headerClear', 0.5); }

  // 庆祝动作：预备 → 主动作（带过冲）→ 收势，三段式缓动 + 二次摆动
  function poseCelebration(dt) {
    if (!st.celeb) return false;
    st.celeb.t += dt;
    const T = st.celeb.t;
    const DUR = st.celeb.dur || 2.2;
    const type = st.celeb.type || 'arms';

    // 三段式权重
    const ANT = 0.22;                 // 预备
    const MAIN = type === 'slid' ? 0.95 : 0.75;
    const p1 = Math.min(1, T / ANT);                              // 预备进度
    const p2 = Math.max(0, Math.min(1, (T - ANT) / MAIN));        // 主动作
    const p3 = Math.max(0, Math.min(1, (T - ANT - MAIN) / Math.max(0.2, DUR - ANT - MAIN))); // 收势
    const easeOut = 1 - Math.pow(1 - p2, 3);
    const overshoot = Math.sin(Math.min(1, p2 * 1.15) * Math.PI) * 0.12 * (1 - p3); // 过冲
    const settle = Math.sin(p3 * Math.PI) * 0.06;                 // 收势回摆
    const sway = Math.sin(T * 3.1) * 0.03 * (1 - p3) * p2;        // 二次摆动

    if (type === 'knee') {
      // 滑跪：先屈膝下沉，再向前滑出（一腿跪地、另一腿前伸、双臂张开）
      const drop = Math.min(1, T / 0.28);
      const slide = Math.max(0, Math.min(1, (T - 0.28) / 1.4));
      const out = 1 - Math.pow(1 - slide, 2);
      torso.position.y = HIP_Y - (0.28 * drop + 0.4 * out);
      torso.rotation.x = -0.22 * out;                       // 上身后仰
      legR.hip.rotation.x = 0.9 * drop - 0.45 * out;
      legL.hip.rotation.x = -1.15 * out;
      legL.shin.rotation.x = 0.25 * out;
      legR.shin.rotation.x = 0.9 * drop;
      armL.shoulder.rotation.z = 1.25 * out;
      armR.shoulder.rotation.z = -1.25 * out;
      armL.shoulder.rotation.x = -0.35 * out;
      armR.shoulder.rotation.x = -0.35 * out;
      head.rotation.x = 0.28 * out;                          // 仰头
      torso.rotation.z = Math.sin(T * 2.4) * 0.04 * out;
    } else if (type === 'slid') {
      const drive = easeOut + overshoot;
      torso.position.y = HIP_Y - 0.58 * drive + 0.06 * p1;
      torso.rotation.x = 0.52 * drive - 0.18 * p1;                // 先下蹲再前倾
      torso.rotation.z = sway * 0.8;
      legR.hip.rotation.x = -1.15 * drive;
      legL.hip.rotation.x = 0.5 * drive;
      legR.shin.rotation.x = 0.35 * drive;
      armL.shoulder.rotation.z = 0.85 * drive + 0.2 * p1;
      armR.shoulder.rotation.z = -0.85 * drive - 0.2 * p1;
      head.rotation.x = -0.2 * drive + 0.1 * p1;
    } else if (type === 'sky') {
      // 预备：手臂先下沉蓄力，再上举过冲
      const lift = easeOut + overshoot;
      armR.shoulder.rotation.x = 0.35 * p1 - 2.75 * lift;
      armR.forearm.rotation.x = -0.15 * lift + 0.2 * p1;
      armL.shoulder.rotation.x = 0.25 * p1 - 0.35 * lift;
      head.rotation.x = 0.12 * p1 - 0.4 * lift;
      torso.rotation.x = -0.08 * lift + 0.1 * p1;
      torso.position.y = HIP_Y + 0.025 * Math.sin(T * 12) * (1 - p3) + settle * 0.4;
      torso.rotation.z = sway;
    } else {
      // 抱臂：手臂先张开再交叉，交叉后轻微回弹
      const cross = easeOut + overshoot;
      armL.shoulder.rotation.z = 1.18 * cross;
      armR.shoulder.rotation.z = -1.18 * cross;
      armL.shoulder.rotation.x = 0.32 * cross + 0.1 * p1;
      armR.shoulder.rotation.x = 0.32 * cross + 0.1 * p1;
      armL.forearm.rotation.x = -0.95 * cross + 0.15 * settle;
      armR.forearm.rotation.x = -0.95 * cross + 0.15 * settle;
      head.rotation.x = -0.14 * cross + 0.06 * p1;
      torso.rotation.y = sway * 1.4;
      torso.position.y = HIP_Y + settle * 0.5;
    }

    if (T >= DUR) {
      st.celeb = null;
      torso.rotation.y = 0;
      head.rotation.x = 0;
      return false;
    }
    return true;
  }

  function poseDetail(dt) {
    if (st.stumble) {
      st.stumble.t += dt;
      const k = Math.min(1, st.stumble.t / 0.85);
      const s1 = Math.sin(k * Math.PI);
      torso.rotation.z = 0.45 * s1;
      torso.rotation.x = 0.3 * s1;
      torso.position.y = HIP_Y - 0.22 * s1;
      armL.shoulder.rotation.z = 0.9 * s1;
      armR.shoulder.rotation.z = -0.9 * s1;
      head.rotation.z = -0.2 * s1;
      if (k >= 1) { st.stumble = null; torso.rotation.z = 0; head.rotation.z = 0; }
      return true;
    }
    if (st.receive) {
      st.receive.t += dt;
      const k = Math.min(1, st.receive.t / 0.5);
      const ease = Math.sin(k * Math.PI);
      // 好球（q 高）压低身体粘脚，差球（q 低）球会弹开，身体后仰
      const crouch = 0.12 + 0.16 * st.receive.q;
      torso.position.y = HIP_Y - crouch * ease;
      torso.rotation.x = 0.18 * ease - 0.12 * (1 - st.receive.q) * ease;
      legR.hip.rotation.x = -0.45 * ease * (0.5 + st.receive.q);
      legR.shin.rotation.x = 0.5 * ease;
      armL.shoulder.rotation.z = 0.55 * ease;
      armR.shoulder.rotation.z = -0.4 * ease;
      if (k >= 1) st.receive = null;
      return true;
    }
    if (st.shield) {
      // 护球：侧身、低重心、一手张开
      torso.rotation.y = 0.55;
      torso.position.y = HIP_Y - 0.1;
      legL.hip.rotation.x = 0.25; legR.hip.rotation.x = -0.2;
      armL.shoulder.rotation.z = 1.0; armR.shoulder.rotation.z = -0.3;
      return true;
    }
    if (st.turn) {
      st.turn.t += dt;
      const k = Math.min(1, st.turn.t / 0.35);
      const s1 = Math.sin(k * Math.PI) * st.turn.dir;
      torso.rotation.y = 0.7 * s1;
      legL.hip.rotation.x = 0.3 * s1; legR.hip.rotation.x = -0.3 * s1;
      if (k >= 1) { st.turn = null; torso.rotation.y = 0; }
      return true;
    }
    return false;
  }

  // ── 通用一次性动作播放器：滑铲 / 倒地 / 起身 / 伸脚 / 上抢 / 拦截 / 亮牌 / 吹哨 / 指方向 / 抗议
  function poseOneshot(dt) {
    const o = st.oneshot;
    if (!o) return false;
    o.t += dt;
    const k = Math.min(1, o.t / o.dur);
    const s = Math.sin(k * Math.PI);                 // 0→1→0 的缓入缓出
    const side = o.opts.side || 1;

    if (o.name === 'slide') {
      // 滑铲：重心猛降、一腿伸直去够球、另一腿收在身下，手臂后撑
      const d = Math.sin(Math.min(1, k * 1.45) * Math.PI);
      torso.position.y = HIP_Y - 0.46 * d;
      torso.rotation.x = 0.62 * d;
      torso.rotation.z = 0.16 * d * side;
      legR.hip.rotation.x = -1.35 * d;
      legR.shin.rotation.x = 0.22 * d;
      legL.hip.rotation.x = 0.62 * d;
      legL.shin.rotation.x = 1.05 * d;
      armL.shoulder.rotation.x = -0.72 * d;
      armR.shoulder.rotation.x = 0.58 * d;
      head.rotation.x = -0.16 * d;
    } else if (o.name === 'down') {
      // 倒地：先跪再侧倒，最后趴住（不自动起身，由 Arena 调 getUp）
      const d = Math.min(1, k * 1.35);
      torso.position.y = HIP_Y - 0.62 * d;
      torso.rotation.x = 0.34 * d;
      torso.rotation.z = 1.12 * d * side;
      legL.hip.rotation.x = -0.9 * d;
      legR.hip.rotation.x = -0.5 * d;
      armL.shoulder.rotation.z = 0.92 * d;
      armR.shoulder.rotation.z = -0.7 * d;
      head.rotation.z = -0.42 * d * side;
    } else if (o.name === 'getUp') {
      // 起身：从趴地反向插值回站立
      const d = 1 - Math.min(1, k * 1.15);
      torso.position.y = HIP_Y - 0.5 * d;
      torso.rotation.z = 0.9 * d * side;
      torso.rotation.x = 0.3 * d;
      legL.hip.rotation.x = -0.8 * d;
      armL.shoulder.rotation.z = 0.7 * d;
    } else if (o.name === 'poke') {
      // 伸脚捅球：支撑腿微屈、出脚腿直插、上身探出去
      legR.hip.rotation.x = -0.85 * s;
      legR.shin.rotation.x = 0.1 * s;
      torso.rotation.x = 0.3 * s;
      torso.position.y = HIP_Y - 0.12 * s;
      armL.shoulder.rotation.x = -0.4 * s;
      armR.shoulder.rotation.x = 0.3 * s;
    } else if (o.name === 'lunge') {
      // 大步上抢：重心前压、跨步、双臂张开保持平衡
      torso.rotation.x = 0.38 * s;
      torso.position.y = HIP_Y - 0.1 * s;
      legL.hip.rotation.x = -0.95 * s;
      legR.hip.rotation.x = 0.7 * s;
      armL.shoulder.rotation.z = 0.75 * s;
      armR.shoulder.rotation.z = -0.75 * s;
      head.rotation.x = -0.12 * s;
    } else if (o.name === 'intercept') {
      // 侧身伸腿拦截传球
      torso.rotation.z = 0.28 * s * side;
      torso.position.y = HIP_Y - 0.1 * s;
      legR.hip.rotation.z = -0.55 * s * side;
      legR.hip.rotation.x = -0.5 * s;
      armR.shoulder.rotation.z = -0.6 * s * side;
      head.rotation.z = 0.18 * s * side;
    } else if (o.name === 'card') {
      // 掏牌：右手摸向胸前口袋（0–0.35 s）→ 举过头顶并保持 → 收牌
      const draw = Math.min(1, o.t / 0.35);
      const raise = o.t < 0.35 ? 0 : Math.min(1, (o.t - 0.35) / 0.28);
      armR.shoulder.rotation.x = -0.55 * draw - 1.95 * raise;
      armR.shoulder.rotation.z = -0.25 * draw;
      armR.forearm.rotation.x = -0.45 * draw - 0.15 * raise;
      head.rotation.x = -0.22 * raise;
      torso.rotation.y = -0.14 * raise;
      if (o.t >= o.dur) showCard(null);
    } else if (o.name === 'whistle') {
      // 吹哨：右手抬到嘴前、头略低
      armR.shoulder.rotation.x = -1.55 * s;
      armR.shoulder.rotation.z = -0.45 * s;
      armR.forearm.rotation.x = -1.45 * s;
      head.rotation.x = 0.12 * s;
    } else if (o.name === 'point') {
      // 指方向：右臂斜下指，身体略转
      const dir = o.opts.dir || 1;
      armR.shoulder.rotation.x = -1.15 * s;
      armR.shoulder.rotation.z = -0.55 * s * dir;
      torso.rotation.y = 0.18 * s * dir;
      head.rotation.y = 0.25 * s * dir;
    } else if (o.name === 'appeal') {
      // 抗议/摊手：双臂摊开、上身前倾
      armL.shoulder.rotation.z = 0.95 * s;
      armR.shoulder.rotation.z = -0.95 * s;
      armL.shoulder.rotation.x = -0.35 * s;
      armR.shoulder.rotation.x = -0.35 * s;
      torso.rotation.x = 0.16 * s;
      head.rotation.x = -0.1 * s;
    } else if (o.name === 'throwIn') {
      // 界外球：双手从脑后（举过头）前甩，同时上身前压、后腿蹬地
      const back = Math.min(1, o.t / 0.3);            // 先把手举到脑后
      const fwd = o.t < 0.3 ? 0 : Math.min(1, (o.t - 0.3) / 0.32);  // 再向前甩
      const lift = back * (1 - fwd * 0.35);
      armL.shoulder.rotation.x = -2.25 * lift + 0.9 * fwd;
      armR.shoulder.rotation.x = -2.25 * lift + 0.9 * fwd;
      armL.shoulder.rotation.z = 0.28 * lift - 0.1 * fwd;
      armR.shoulder.rotation.z = -0.28 * lift + 0.1 * fwd;
      armL.forearm.rotation.x = -0.5 * back + 0.35 * fwd;
      armR.forearm.rotation.x = -0.5 * back + 0.35 * fwd;
      torso.rotation.x = -0.18 * back + 0.42 * fwd;
      legL.hip.rotation.x = -0.22 * back + 0.3 * fwd;
      legR.hip.rotation.x = 0.18 * back - 0.15 * fwd;
      head.rotation.x = 0.12 * back - 0.2 * fwd;
    } else if (o.name === 'runUp') {
      // 点球助跑最后一步：上身前压、支撑腿蹬地、摆腿蓄力
      const k2 = Math.min(1, k * 1.25);
      torso.rotation.x = 0.3 * k2;
      torso.position.y = HIP_Y - 0.06 * k2;
      legR.hip.rotation.x = -0.75 * k2;
      legR.shin.rotation.x = 0.45 * k2;
      legL.hip.rotation.x = 0.35 * k2;
      armL.shoulder.rotation.x = 0.45 * k2;
      armR.shoulder.rotation.x = -0.55 * k2;
      head.rotation.x = 0.08 * k2;
    } else if (o.name === 'crouch') {
      // 门将点球前压低重心：屈膝、双臂张开、左右小幅晃动
      const sway = Math.sin(o.t * 7.5) * 0.12 * Math.min(1, o.t / 0.4);
      torso.position.y = HIP_Y - 0.16;
      torso.rotation.x = 0.18;
      legL.hip.rotation.x = 0.42; legR.hip.rotation.x = 0.42;
      legL.hip.rotation.z = 0.18; legR.hip.rotation.z = -0.18;
      legL.shin.rotation.x = 0.3; legR.shin.rotation.x = 0.3;
      armL.shoulder.rotation.z = 0.85 + sway;
      armR.shoulder.rotation.z = -0.85 + sway;
      armL.shoulder.rotation.x = -0.25; armR.shoulder.rotation.x = -0.25;
    } else if (o.name === 'cut') {
      // 急停变向：重心猛沉、内侧脚支撑、外侧腿摆出去
      torso.position.y = HIP_Y - 0.24 * s;
      torso.rotation.z = 0.16 * s * side;
      torso.rotation.y = 0.3 * s * side;
      legL.hip.rotation.x = -0.5 * s; legR.hip.rotation.x = 0.35 * s;
      legL.hip.rotation.z = 0.2 * s * side;
      armL.shoulder.rotation.z = 0.6 * s; armR.shoulder.rotation.z = -0.6 * s;
      head.rotation.y = -0.2 * s * side;
    } else if (o.name === 'trapChest') {
      // 胸部停球：后仰卸力、双臂张开保持平衡
      torso.position.y = HIP_Y - 0.04 * s;
      torso.rotation.x = -0.24 * s;
      armL.shoulder.rotation.z = 0.7 * s; armR.shoulder.rotation.z = -0.7 * s;
      armL.shoulder.rotation.x = 0.3 * s; armR.shoulder.rotation.x = 0.3 * s;
      legL.hip.rotation.x = 0.12 * s; legR.hip.rotation.x = -0.12 * s;
      head.rotation.x = 0.1 * s;
    } else if (o.name === 'trapThigh') {
      // 大腿停球：抬起膝盖迎球、上身微前压
      legR.hip.rotation.x = -0.85 * s;
      legR.shin.rotation.x = 0.75 * s;
      torso.rotation.x = 0.12 * s;
      torso.position.y = HIP_Y - 0.05 * s;
      armL.shoulder.rotation.z = 0.45 * s; armR.shoulder.rotation.z = -0.35 * s;
    } else if (o.name === 'punch') {
      // 门将拳击球：单臂向前上方击出、身体侧转、另一臂护住
      const k2 = Math.min(1, k * 1.5);
      armR.shoulder.rotation.x = -2.1 * k2;
      armR.shoulder.rotation.z = -0.35 * k2;
      armR.forearm.rotation.x = -0.55 * k2;
      armL.shoulder.rotation.x = -0.5 * k2;
      torso.rotation.x = 0.16 * k2;
      torso.rotation.y = -0.18 * k2;
      torso.position.y = HIP_Y - 0.06 * k2;
      head.rotation.x = -0.2 * k2;
      legL.hip.rotation.x = -0.25 * k2;
      legR.hip.rotation.x = 0.2 * k2;
    } else if (o.name === 'headerClear') {
      // 解围甩头：向后上方顶（不是攻门那种前甩），同时手臂张开保持平衡
      const up = Math.max(0, Math.min(1, (k - 0.15) / 0.5));
      torso.position.y = HIP_Y + 0.2 * up;
      torso.rotation.x = -0.1 * up;
      head.rotation.x = 0.55 * up;               // 颈后仰 → 把球顶向远处
      armL.shoulder.rotation.z = 0.9 * up;
      armR.shoulder.rotation.z = -0.9 * up;
      armL.shoulder.rotation.x = -0.3 * up;
      armR.shoulder.rotation.x = -0.3 * up;
      legL.hip.rotation.x = -0.25 * up;
      legR.hip.rotation.x = 0.15 * up;
    } else if (o.name === 'flag') {
      // 边裁举旗：offside 高举过头并停住 / throwIn 斜上举 / corner 前指角旗
      // 手臂抬起（rotation.z 往外抬，避免 rotation.x 把手臂甩进身体里）
      const kind = o.opts.kind || 'offside';
      const raise = Math.min(1, o.t / 0.22);
      if (kind === 'offside') {
        armR.shoulder.rotation.z = -2.35 * raise;   // 往外侧举到头顶
        armR.shoulder.rotation.x = -0.25 * raise;
        armR.forearm.rotation.x = -0.12 * raise;
        head.rotation.x = -0.16 * raise;
      } else if (kind === 'throwIn') {
        armR.shoulder.rotation.z = -1.55 * raise;   // 斜上举
        armR.shoulder.rotation.x = -0.55 * raise;
        torso.rotation.y = -0.14 * raise;
      } else {
        armR.shoulder.rotation.z = -1.05 * raise;   // 前指角旗
        armR.shoulder.rotation.x = -0.85 * raise;
        torso.rotation.y = 0.2 * raise;
      }
      // 旗子一直拿在手里，动作结束后自然跟着手臂放下来（不再隐藏）
    }

    if (k >= 1) {
      st.oneshot = null;
      resetPose();
      return false;
    }
    return true;
  }

  // 一次性动作结束后的归位（循环姿态会自己覆盖这些）
  function resetPose() {
    torso.position.y = HIP_Y;
    torso.rotation.x = 0; torso.rotation.y = 0; torso.rotation.z = 0;
    head.rotation.x = 0; head.rotation.y = 0; head.rotation.z = 0;
    legL.hip.rotation.x = 0; legR.hip.rotation.x = 0;
    legL.hip.rotation.z = 0; legR.hip.rotation.z = 0;
    legL.shin.rotation.x = 0; legR.shin.rotation.x = 0;
    armL.shoulder.rotation.x = 0; armR.shoulder.rotation.x = 0;
    armL.shoulder.rotation.z = 0; armR.shoulder.rotation.z = 0;
    armL.forearm.rotation.x = 0; armR.forearm.rotation.x = 0;
  }

  function poseAction(dt) {
    if (poseCelebration(dt)) return true;
    // 扑救优先于普通细节动作：0.5 s 一次性侧扑
    if (st.dive) {
      st.dive.t += dt;
      const k = Math.min(1, st.dive.t / 0.5);
      const s = Math.sin(k * Math.PI);
      torso.rotation.z = st.dive.dir * (st.dive.high ? 1.15 : 0.85) * s;
      torso.position.y = HIP_Y - (st.dive.high ? 0.22 : 0.48) * s;
      armL.shoulder.rotation.x = -1.45 * s;
      armR.shoulder.rotation.x = -1.45 * s;
      armL.shoulder.rotation.z = 0.55 * s;
      armR.shoulder.rotation.z = -0.55 * s;
      armL.forearm.rotation.x = -0.15 * s;
      armR.forearm.rotation.x = -0.15 * s;
      legL.hip.rotation.x = 0.42 * s;
      legR.hip.rotation.x = -0.2 * s;
      legL.shin.rotation.x = 0.5 * s;
      legR.shin.rotation.x = 0.3 * s;
      if (k >= 1) {
        st.dive = null;
        torso.rotation.z = 0;
        torso.position.y = HIP_Y;
      }
      return true;
    }
    // 通用一次性动作（滑铲 / 倒地 / 起身 / 抢断 / 拦截 / 裁判示意）：优先级高于细节动作
    if (poseOneshot(dt)) return true;
    if (poseDetail(dt)) return true;
    if (st.header) {
      st.header.t += dt;
      const k = Math.min(1, st.header.t / 0.45);
      const s = Math.sin(k * Math.PI);
      torso.position.y = HIP_Y + 0.22 * s;          // 起跳
      torso.rotation.x = 0.35 * s;                  // 上身前压
      head.rotation.x = -0.45 * s;                  // 颈部前甩
      armL.shoulder.rotation.x = -0.9 * s; armR.shoulder.rotation.x = -0.9 * s;
      armL.shoulder.rotation.z = 0.35 * s; armR.shoulder.rotation.z = -0.35 * s;
      legL.hip.rotation.x = -0.35 * s; legR.hip.rotation.x = 0.2 * s;
      if (k >= 1) { st.header = null; torso.position.y = HIP_Y; torso.rotation.x = 0; head.rotation.x = 0; }
      return true;
    }
    // 跳跃：放在头球之后 —— 半空中顶到球时，颈部那一下（st.header）优先，顶完继续把起跳动作播完。
    if (st.jump) {
      st.jump.t += dt;
      const k = Math.min(1, st.jump.t / 0.62);
      const crouch = Math.min(1, k / 0.18);                                  // 屈膝蓄力
      const air = Math.max(0, Math.min(1, (k - 0.18) / 0.34));               // 蹬地起跳
      const land = Math.max(0, Math.min(1, (k - 0.72) / 0.28));              // 落地缓冲
      const lift = air * (1 - land);
      torso.position.y = HIP_Y - 0.15 * crouch + 0.07 * lift - 0.12 * land;
      torso.rotation.x = 0.16 * crouch - 0.1 * lift + 0.2 * land;
      legL.hip.rotation.x = -0.5 * crouch - 0.28 * lift + 0.45 * land;
      legR.hip.rotation.x = -0.5 * crouch - 0.28 * lift + 0.45 * land;
      legL.shin.rotation.x = 0.75 * crouch + 0.5 * lift + 0.65 * land;
      legR.shin.rotation.x = 0.75 * crouch + 0.5 * lift + 0.65 * land;
      armL.shoulder.rotation.x = -1.35 * lift;
      armR.shoulder.rotation.x = -1.35 * lift;
      armL.shoulder.rotation.z = 0.3 * lift + 0.4 * land;
      armR.shoulder.rotation.z = -0.3 * lift - 0.4 * land;
      head.rotation.x = -0.1 * lift;
      if (k >= 1) { st.jump = null; torso.position.y = HIP_Y; torso.rotation.x = 0; head.rotation.x = 0; }
      return true;
    }
    if (st.kickT >= 0) {
      st.kickT += dt;
      const k = Math.min(1, st.kickT / 0.42);
      const swing = Math.sin(k * Math.PI) * (1.15 * (st.kickPower || 1));
      const kl = st.kickLeg || legR;
      kl.hip.rotation.x = -swing;
      kl.shin.rotation.x = 0.15 + Math.max(0, 0.5 - Math.abs(k - 0.35)) * 0.6;
      armL.shoulder.rotation.x = -0.5 * swing;
      armR.shoulder.rotation.x = 0.3 * swing;
      torso.rotation.x = 0.12 * swing;
      if (k >= 1) st.kickT = -1;
      return true;
    }
    if (st.slideT >= 0) {
      st.slideT += dt;
      const k = Math.min(1, st.slideT / 0.9);
      torso.position.y = HIP_Y - 0.42 * Math.sin(k * Math.PI);
      torso.rotation.x = 0.55 * Math.sin(k * Math.PI);
      legR.hip.rotation.x = -1.0 * Math.sin(k * Math.PI);
      legL.hip.rotation.x = 0.35 * Math.sin(k * Math.PI);
      if (k >= 1) st.slideT = -1;
      return true;
    }
    return false;
  }
  // ── [players-subsystem] LOD / 统计 / 外观查询 ─────────────────────────────
  // 面部细节整块隐藏（远景/比赛镜头不需要眼眉鼻），号码与姓名只在中近景显示。
  let curDetail = (opts.detail === 'mid' || opts.detail === 'low') ? opts.detail : 'full';
  const plateMeshes = [];
  torso.children.forEach((c) => { if (c.isMesh && c.material && c.material.map) plateMeshes.push(c); });
  function applyDetail() {
    if (parametric && parametric.detailMesh) parametric.detailMesh.visible = curDetail === 'full';
    for (const m of plateMeshes) m.visible = curDetail !== 'low';
  }
  function setDetail(level) { curDetail = (level === 'mid' || level === 'low') ? level : 'full'; applyDetail(); return curDetail; }
  function info() {
    let meshes = 0, triangles = 0, vertices = 0;
    const mats = new Set();
    g.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const geo = o.geometry;
      if (geo && geo.attributes && geo.attributes.position) {
        vertices += geo.attributes.position.count;
        triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      }
      if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m));
      else if (o.material) mats.add(o.material);
    });
    return {
      meshes, triangles: Math.round(triangles), vertices, materials: mats.size,
      detail: curDetail, boxes: parametric ? parametric.boxCount : null,
      parametric: !!parametric, look: lookSrc ? lookSrc.summary : null,
      heightScale: lookSrc ? lookSrc.heightScale : 1, hipY: HIP_Y,
    };
  }

  return {
    object: g,
    rig: { torso, head, armL, armR, legL, legR },
    look: lookSrc || null,
    appearance: opts.appearance || null,
    setDetail, detail: () => curDetail, info,
    kick, slide, celebratePose, receivePose, shieldPose: (on) => { st.shield = !!on; }, turnPose, stumblePose, divePose, headerPose, jumpPose,
    // 坐姿开关（替补席 / 看台）；站起时立即回到待机，不会残留蹲坐的关节角
    sitPose: (on) => { st.sit = !!on; return st.sit; },
    isSitting: () => !!st.sit,
    // 新增一次性动作（铲球/倒地/起身/抢断/拦截/裁判示意）
    pose: play, downPose, getUpPose, pokePose, lungePose, interceptPose,
    cardPose, whistlePose, pointPose, appealPose, showCard, cardKind: () => st.cardKind,
    throwInPose, runUpPose, crouchPose, cutPose, trapChestPose, trapThighPose, flagPose, hasFlag, flagVisible,
    punchPose, headerClearPose,
    // 头顶姓名牌：setNameTag('张三', '#ffffff')；传空则隐藏
    setNameTag(text, color) {
      const label = String(text || '').trim();
      const col = color || '#ffffff';
      if (!label) { if (nameTag) nameTag.visible = false; return null; }
      const key = label + '|' + col + '|' + nameTagFontKey;
      if (!nameTag || nameTagKey !== key) {
        if (nameTag) { g.remove(nameTag); try { nameTag.material.map.dispose(); nameTag.material.dispose(); } catch (e) {} }
        nameTag = buildNameTag(label, col);
        nameTagKey = key;
        g.add(nameTag);
      }
      nameTag.visible = true;
      return nameTag;
    },
    showNameTag(on) { if (nameTag) nameTag.visible = !!on; return !!(nameTag && nameTag.visible); },
    // 按距离缩放：让姓名牌在屏幕上保持差不多大小（远处也读得清）
    setNameTagScale(s) {
      if (!nameTag) return null;
      const w = Math.max(0.5, Math.min(4.0, s));
      const aspect = (nameTag.userData && nameTag.userData.tagAspect) || 0.25;
      nameTag.scale.set(w, w * aspect, 1);
      return w;
    },
    hasNameTag: () => !!nameTag,
    nameTagFontKey: () => nameTagFontKey,
    setNameTagFont: (k) => { const r = setNameTagFont(k); if (nameTag && nameTagKey) { const parts = String(nameTagKey).split('|'); nameTagKey = ''; this.setNameTag(parts[0], parts[1]); } return r; },
    // 自检/工具用：姓名牌的文本、颜色、可见性、位置与边框像素
    nameTagInfo() {
      if (!nameTag) return null;
      const key = String(nameTagKey).split('|');
      let border = null;
      try {
        const img = nameTag.material.map.image;
        const d = img.getContext('2d').getImageData(Math.round((img.width / 2)), Math.round((NAME_TAG_RULE_Y + 1) * NAME_TAG_SS), 1, 1).data;
        border = [d[0], d[1], d[2]];
      } catch (e) {}
      return {
        text: key[0] || '', color: key[1] || '#ffffff', visible: !!nameTag.visible,
        y: +nameTag.position.y.toFixed(2), w: +nameTag.scale.x.toFixed(2),
        depthWrite: !!nameTag.material.depthWrite, border: border,
      };
    },
    nameTagText: () => nameTagKey,
    setMoveKind,
    moveKind: () => st.moveKind,
    // 姿态状态（自检用：证明某个一次性动作确实在播）
    poseState: () => ({
      moveKind: st.moveKind, phase: +st.phase.toFixed(3),
      receive: !!st.receive, receiveT: st.receive ? +st.receive.t.toFixed(2) : null,
      kick: st.kickT >= 0, dive: !!st.dive, header: !!st.header, jump: !!st.jump, shield: !!st.shield,
      sit: !!st.sit,
      oneshot: st.oneshot ? st.oneshot.name : null,
      oneshotT: st.oneshot ? +st.oneshot.t.toFixed(2) : null,
      card: st.cardKind || null,
    }),
    // speed: 当前速度 m/s；dt: 秒；t: 累计时间
    update(dt, speed, t) {
      if (poseAction(dt)) return;
      if (speed > 0.4) {
        if (st.moveKind === 'strafe') poseStrafe(speed, dt, st.moveSide);
        else if (st.moveKind === 'back') poseBackpedal(speed, dt);
        else poseRun(t, speed, dt);
      } else if (st.sit) poseSit(t);
      else poseIdle(t);
    },
    // 供外部/自检读取：当前循环相位与相邻两步的等效步幅
    gait: () => ({ phase: st.phase, stride: strideOf(0), cycles: Math.floor(st.phase) }),
  };
}
