import * as THREE from "three";
import { addBox, addPlane, makeGlowSprite } from "./utils.js";

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const MONO = '"Arial Narrow", "Bahnschrift Condensed", "Impact", monospace';
const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 576;
const DRAW_WIDTH = 1280;
const DRAW_HEIGHT = 720;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function shieldPath(ctx, x, y, width, height) {
  ctx.beginPath();
  ctx.moveTo(x + width * 0.5, y);
  ctx.lineTo(x + width * 0.9, y + height * 0.12);
  ctx.lineTo(x + width * 0.86, y + height * 0.66);
  ctx.quadraticCurveTo(x + width * 0.7, y + height * 0.9, x + width * 0.5, y + height);
  ctx.quadraticCurveTo(x + width * 0.3, y + height * 0.9, x + width * 0.14, y + height * 0.66);
  ctx.lineTo(x + width * 0.1, y + height * 0.12);
  ctx.closePath();
}

function circlePath(ctx, x, y, width, height) {
  ctx.beginPath();
  ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.closePath();
}

function drawCrest(ctx, source, crop, target, shape, accent, pal) {
  const P = Object.assign({
    crest0: '#d8d1ba', crest1: '#f3ead1', crest2: '#a51f15', crestText: '#8e2118',
  }, pal || {});
  const [tx, ty, tw, th] = target;
  ctx.save();
  if (shape === "shield") shieldPath(ctx, tx, ty, tw, th);
  else circlePath(ctx, tx, ty, tw, th);
  ctx.clip();
  if (source && source.width && source.height) {
    const sx = source.width * crop[0];
    const sy = source.height * crop[1];
    const sw = source.width * crop[2];
    const sh = source.height * crop[3];
    ctx.drawImage(source, sx, sy, sw, sh, tx, ty, tw, th);
  } else {
    const gradient = ctx.createLinearGradient(tx, ty, tx, ty + th);
    gradient.addColorStop(0, P.crest0);
    gradient.addColorStop(0.55, P.crest1);
    gradient.addColorStop(1, P.crest2);
    ctx.fillStyle = gradient;
    ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = P.crestText;
    ctx.font = `900 ${Math.floor(tw * 0.26)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(shape === "shield" ? "HOME" : "AWAY", tx + tw / 2, ty + th * 0.5);
  }
  ctx.restore();

  ctx.save();
  if (shape === "shield") shieldPath(ctx, tx, ty, tw, th);
  else circlePath(ctx, tx, ty, tw, th);
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(4, tw * 0.018);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawLedGrid(ctx, width, height) {
  ctx.save();
  ctx.globalAlpha = 0.055;
  ctx.fillStyle = "#050505";
  for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);
  for (let x = 0; x < width; x += 4) ctx.fillRect(x, 0, 1, height);
  ctx.globalAlpha = 0.025;
  ctx.fillStyle = "#ffffff";
  for (let y = 2; y < height; y += 8) ctx.fillRect(0, y, width, 1);
  ctx.restore();

  const vignette = ctx.createLinearGradient(0, 0, 0, height);
  vignette.addColorStop(0, "rgba(0,0,0,0.22)");
  vignette.addColorStop(0.18, "rgba(0,0,0,0)");
  vignette.addColorStop(0.82, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

export function createDynamicScoreboard({ textures, parent, palette, brand }) {
  // ── 配色与文案外部化（《足球世界》改造）
  // 原来这里的红/蓝配色与"华润饮料中超 / 济南奥体"等真实赛事、场地文案全部写死，
  // 结果不管哪支球队主场，记分牌都是同一块橙红底；而且把真实赞助商与场地名带进了游戏。
  // 现在由调用方（stadium-kinds.js）传入队色派生的 palette 与 brand，默认值只保留中性文案。
  const P = Object.assign({
    base0: '#16120f', base1: '#050506',
    body0: '#d93a20', body1: '#b92a1b', body2: '#7f1b13',
    stripe: '#f06a3e',
    head0: '#244b80', head1: '#0c2145',
    headStroke: 'rgba(147,190,246,0.65)',
    headText: '#e9f2ff', headSub: 'rgba(224,238,255,0.72)', headSide: 'rgba(224,238,255,0.75)',
    name: '#fff0d8', nameSub: 'rgba(255,235,205,0.68)',
    score: '#fff8e8', scoreStroke: 'rgba(20,10,8,0.86)', scoreGlow: 'rgba(255,71,35,0.55)',
    period: '#ffd58b', status: 'rgba(255,236,201,0.78)',
    foot0: '#1b3b72', foot1: '#07162f',
    crest0: '#d8d1ba', crest1: '#f3ead1', crest2: '#a51f15', crestText: '#8e2118',
    accentRing: '#d8b369',
    // 队徽：不再用图片/文字占位，改成"主色填充 + 辅色描边"的纯色圆形徽记。
    // 这是低模风格里最干净的做法，也不存在复制真实俱乐部徽章的授权问题。
    homeFill0: '#d8d1ba', homeFill1: '#a51f15', homeRing: '#d8b369',
    awayFill0: '#e9eef5', awayFill1: '#7a8494', awayRing: '#d8b369',
    shell: 0x0e1114, edge: 0x262a2d, inner: 0x060708, support: 0x202428,
  }, palette || {});
  const B = Object.assign({
    league: 'FOOTBALL WORLD', leagueEn: 'FOOTBALL WORLD LEAGUE',
    leagueTag: 'MATCHDAY', venue: '', side: '',
  }, brand || {});
  const group = new THREE.Group();
  group.position.set(0, 14.1, -66.8);
  group.scale.setScalar(1.34);
  parent.add(group);

  const shellMaterial = new THREE.MeshStandardMaterial({
    color: P.shell,
    roughness: 0.5,
    metalness: 0.72,
  });
  const edgeMaterial = new THREE.MeshStandardMaterial({
    color: P.edge,
    roughness: 0.34,
    metalness: 0.82,
  });
  const innerMaterial = new THREE.MeshStandardMaterial({
    color: P.inner,
    roughness: 0.8,
    metalness: 0.25,
  });
  const supportMaterial = new THREE.MeshStandardMaterial({
    color: P.support,
    roughness: 0.56,
    metalness: 0.66,
  });

  // Thick structural shell, recessed screen and a separately readable bezel.
  addBox(group, {
    size: [23.2, 13.5, 1.5],
    position: [0, 0, -1.0],
    material: shellMaterial,
    castShadow: true,
  });
  addBox(group, {
    size: [22.5, 12.8, 0.16],
    position: [0, 0, -1.78],
    material: innerMaterial,
  });
  addBox(group, {
    size: [21.2, 11.9, 0.28],
    position: [0, 0, -0.08],
    material: innerMaterial,
  });
  addBox(group, {
    size: [23.7, 0.38, 1.8],
    position: [0, 6.82, -0.92],
    material: edgeMaterial,
    castShadow: true,
  });
  addBox(group, {
    size: [23.7, 0.38, 1.8],
    position: [0, -6.82, -0.92],
    material: edgeMaterial,
    castShadow: true,
  });
  addBox(group, {
    size: [0.42, 13.0, 1.72],
    position: [-11.48, 0, -0.92],
    material: edgeMaterial,
  });
  addBox(group, {
    size: [0.42, 13.0, 1.72],
    position: [11.48, 0, -0.92],
    material: edgeMaterial,
  });

  const bezelThickness = 0.58;
  addBox(group, {
    size: [20.8 + bezelThickness * 2, bezelThickness, 0.62],
    position: [0, 6.15, -0.13],
    material: edgeMaterial,
    castShadow: true,
  });
  addBox(group, {
    size: [20.8 + bezelThickness * 2, bezelThickness, 0.62],
    position: [0, -6.15, -0.13],
    material: edgeMaterial,
    castShadow: true,
  });
  addBox(group, {
    size: [bezelThickness, 12.3, 0.62],
    position: [-10.69, 0, -0.13],
    material: edgeMaterial,
  });
  addBox(group, {
    size: [bezelThickness, 12.3, 0.62],
    position: [10.69, 0, -0.13],
    material: edgeMaterial,
  });

  // Small corner brackets reinforce the heavy mounting frame silhouette.
  for (const x of [-10.9, 10.9]) {
    for (const y of [-5.95, 5.95]) {
      addBox(group, {
        size: [0.9, 0.9, 0.75],
        position: [x, y, 0.04],
        rotation: [0, 0, Math.PI / 4],
        material: supportMaterial,
      });
    }
  }

  // Ventilation slats, cable tray and rear service panels.
  for (let i = 0; i < 8; i += 1) {
    addBox(group, {
      size: [1.15, 0.055, 0.04],
      position: [-8.7 + i * 2.5, 6.38, 0.12],
      material: innerMaterial,
    });
    addBox(group, {
      size: [1.15, 0.055, 0.04],
      position: [-8.7 + i * 2.5, -6.38, 0.12],
      material: innerMaterial,
    });
  }
  addBox(group, {
    size: [18.5, 0.16, 0.12],
    position: [0, -6.15, -1.72],
    material: supportMaterial,
  });
  addBox(group, {
    size: [0.42, 0.16, 3.1],
    position: [7.8, -6.15, -2.8],
    material: supportMaterial,
  });

  // Steel support columns, cross-bracing and top truss.
  for (const x of [-8.2, 8.2]) {
    addBox(group, {
      size: [0.62, 11.8, 0.62],
      position: [x, -7.4, -1.22],
      material: supportMaterial,
      castShadow: true,
    });
    addBox(group, {
      size: [0.28, 8.4, 0.28],
      position: [x * 0.82, -6.9, -1.42],
      rotation: [0, 0, x > 0 ? -0.22 : 0.22],
      material: supportMaterial,
    });
  }
  addBox(group, {
    size: [19.2, 0.34, 0.45],
    position: [0, -13.0, -1.3],
    material: supportMaterial,
  });
  addBox(group, {
    size: [21.2, 0.24, 0.4],
    position: [0, 6.92, -1.55],
    material: supportMaterial,
  });
  for (const x of [-8.2, 0, 8.2]) {
    addBox(group, {
      size: [0.28, 0.28, 3.7],
      position: [x, 6.92, -3.05],
      material: supportMaterial,
    });
  }

  // Dynamic screen canvas. 1280x720 is enough at the stadium's viewing
  // distance and keeps per-second texture uploads inexpensive.
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(CANVAS_WIDTH / DRAW_WIDTH, 0, 0, CANVAS_HEIGHT / DRAW_HEIGHT, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const screenMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    color: 0xd2d0c8,
    toneMapped: true,
    side: THREE.FrontSide,
  });
  const screen = addPlane(group, {
    size: [20.8, 11.7],
    position: [0, 0, 0.24],
    material: screenMaterial,
  });
  screen.name = "dynamic-scoreboard-screen";

  const screenBacking = addBox(group, {
    size: [20.9, 11.8, 0.18],
    position: [0, 0, 0.12],
    material: innerMaterial,
  });
  screenBacking.renderOrder = 1;

  const glassMaterial = new THREE.MeshBasicMaterial({
    color: 0x78908c,
    transparent: true,
    opacity: 0.035,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  addPlane(group, {
    size: [20.75, 11.65],
    position: [0, 0, 0.27],
    material: glassMaterial,
  });

  // Panel seams are shader-free dark strips over the LED surface.
  for (const x of [-5.2, 0, 5.2]) {
    addBox(group, {
      size: [0.018, 11.58, 0.012],
      position: [x, 0, 0.265],
      material: new THREE.MeshBasicMaterial({ color: 0x070706, transparent: true, opacity: 0.3 }),
    });
  }
  for (const y of [-2.8, 2.8]) {
    addBox(group, {
      size: [20.65, 0.018, 0.012],
      position: [0, y, 0.265],
      material: new THREE.MeshBasicMaterial({ color: 0x070706, transparent: true, opacity: 0.3 }),
    });
  }

  const light = new THREE.PointLight(0xd34527, 28, 30, 2);
  light.position.set(0, 14.6, -63.8);
  parent.add(light);
  const glowSprite = makeGlowSprite(0xc23b23, 24, 0.07);
  glowSprite.position.set(0, 0, 1.2);
  group.add(glowSprite);

  const sourceImage = textures?.scoreboard?.image ?? null;
  const state = {
    homeName: "山东T山",
    homeEnglish: "SHANDONG HOME",
    awayName: "北京G安",
    awayEnglish: "BEIJING AWAY",
    homeScore: 6,
    awayScore: 0,
    period: "下半场",
    status: "比赛结束",
    competition: "2025华润饮料中国足球超级联赛",
    competitionEnglish: "CHINESE FOOTBALL SUPER LEAGUE",
    venue: "济南奥体中心",
    clockSeconds: 90 * 60,
    clockRunning: true,
  };

  let mood = "normal";
  let powered = true;
  let dirty = true;
  let lastClock = "";
  let lastDrawAt = 0;
  let lastGlitchFrame = 0;
  let glitchUntil = 0;
  let wasGlitching = false;
  let flashUntil = 0;

  function currentClock() {
    return formatClock(state.clockSeconds);
  }

  // 圆形队徽：主色径向填充 + 辅色描边（高级简约，无图片、无真实徽章）
  function drawBadge(target, fill0, fill1, ring) {
    const [tx, ty, tw, th] = target;
    const cx = tx + tw / 2, cy = ty + th / 2;
    const r = Math.min(tw, th) / 2;
    ctx.save();
    // 外圈留白：让徽记和深色牌面之间有呼吸感
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    g.addColorStop(0, fill0);
    g.addColorStop(1, fill1);
    ctx.fillStyle = g;
    ctx.fill();
    // 描边用辅色，宽度按半径比例，远景也能看出轮廓
    ctx.lineWidth = Math.max(8, r * 0.10);
    ctx.strokeStyle = ring;
    ctx.stroke();
    // 外圈一道深色细线，把徽记从深色牌面上"抠"出来（否则边缘会和背景糊在一起）
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(4, r * 0.05), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(3, r * 0.02);
    ctx.stroke();
    // 内侧细高光，避免大面积纯色显得平板
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.82, Math.PI * 1.08, Math.PI * 1.92);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(3, r * 0.03);
    ctx.stroke();
    ctx.restore();
  }

  // ── 牌面绘制：与场边广告板同一套画风（纯队色底 + 白色粗体字 + 辅色细边）
  // 旧版是"LED 大屏模拟"：暗底渐变 + 斜纹 + 像素网格 + 扫描线 + 比分外发光 + 双层徽章容器。
  // 它和场边广告板（纯色底 + 白字，见 stadium-kinds.js 的 adBoards）完全是两种视觉语言，
  // 用户反馈"还是好丑，画风要和广告牌一样"。新版只保留平涂该有的东西：
  //   纯色底 / 上下辅色细边 / 圆形纯色队徽 / 中文队名 / 超大比分 / 一行时间。
  function drawTextFrame(glitch = false) {
    const w = DRAW_WIDTH;
    const h = DRAW_HEIGHT;
    ctx.clearRect(0, 0, w, h);

    // 底色 = 主队主色（与广告板同色同风格，不做渐变）
    ctx.fillStyle = P.body1;
    ctx.fillRect(0, 0, w, h);

    // 上下各一条辅色细边：把牌面框住，同时把次色带出来
    ctx.fillStyle = P.homeRing;
    ctx.fillRect(0, 0, w, 10);
    ctx.fillRect(0, h - 10, w, 10);

    // 顶部左：赛事名；顶部右：比赛时间
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(state.competition || B.league, 46, 54);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(glitch ? '--:--' : currentClock(), w - 46, 54);

    // 圆形队徽：左＝主队（主色/辅色描边），右＝客队（辅色/主色描边）
    drawBadge([78, 150, 208, 208], P.homeFill0, P.homeFill1, P.homeRing);
    drawBadge([w - 286, 150, 208, 208], P.awayFill0, P.awayFill1, P.awayRing);

    // 中文队名：徽记正下方
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 50px ${FONT}`;
    ctx.fillText(String(state.homeName || '').slice(0, 8), 182, 418);
    ctx.fillText(String(state.awayName || '').slice(0, 8), w - 182, 418);

    // 比分：整块牌面的主角，纯白、无描边、无发光（平涂语言里发光是"脏"的）
    const scoreText = glitch ? `${state.homeScore}:?` : `${state.homeScore}:${state.awayScore}`;
    ctx.textBaseline = 'middle';
    ctx.font = `900 300px ${MONO}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(scoreText, w / 2, 322);

    // 底行：阶段 + 状态（有球场名就带上）
    ctx.font = `700 32px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(state.period, w / 2, 512);
    ctx.font = `600 24px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    const venueText = state.venue || B.venue || '';
    ctx.fillText(venueText ? `${state.status} · ${venueText}` : state.status, w / 2, 558);

    // 进球/事件的一次性白闪（保留原有反馈，但不引入新的装饰层）
    if (performance.now() < flashUntil) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(0, 0, w, h);
    }
  }

  function upload() {
    texture.needsUpdate = true;
    lastDrawAt = performance.now();
    lastClock = currentClock();
    dirty = false;
  }

  function draw(glitch = false) {
    drawTextFrame(glitch);
    upload();
  }

  function setData(partial = {}) {
    const previousScore = `${state.homeScore}:${state.awayScore}`;
    for (const key of [
      "homeName", "homeEnglish", "awayName", "awayEnglish",
      "homeScore", "awayScore", "period", "status",
      "competition", "competitionEnglish", "venue", "clockSeconds",
      "clockRunning",
    ]) {
      if (partial[key] !== undefined) state[key] = partial[key];
    }
    if (`${state.homeScore}:${state.awayScore}` !== previousScore) {
      flashUntil = performance.now() + 1000;
    }
    dirty = true;
    draw(performance.now() < glitchUntil);
  }

  function setPower(on = true) {
    powered = Boolean(on);
    screen.visible = powered;
    glowSprite.visible = powered;
    light.visible = powered;
    if (powered) draw(false);
  }

  function setMood(nextMood) {
    mood = nextMood;
    const config = mood === "final"
      ? { color: 0xebe4d6, light: 44, glow: 0.085 }
      : mood === "blackout"
        ? { color: 0x5b5851, light: 10, glow: 0.028 }
        : { color: 0xd2d0c8, light: 28, glow: 0.06 };
    screenMaterial.color.setHex(config.color);
    light.intensity = config.light;
    glowSprite.material.opacity = config.glow;
  }

  function update(dt, elapsed, skipDraw) {
    if (!powered) return;
    if (state.clockRunning) state.clockSeconds += Math.min(dt, 0.25);
    const clock = currentClock();
    const now = performance.now();
    if (now < glitchUntil) {
      wasGlitching = true;
      if (now - lastGlitchFrame > 82) {
        lastGlitchFrame = now;
        if (!skipDraw) draw(true);
      }
    } else {
      // Force a clean redraw on the frame the glitch ends; otherwise the last
      // corrupted canvas frame can remain on the LED texture.
      if (wasGlitching) {
        wasGlitching = false;
        dirty = true;
      }
      // skipDraw：屏幕不在相机视锥里时不重绘 1024×576 画布（每秒一次的固定开销），
      // 时钟仍然照常推进，回到视野里下一秒就会补齐。纯渲染优化，不影响任何数据。
      if ((clock !== lastClock || dirty) && !skipDraw) {
        draw(false);
      }
    }
    // A restrained breathing glow; the screen itself stays within the night
    // lighting rather than becoming a white plastic lightbox.
    const base = mood === "final" ? 40 : mood === "blackout" ? 8 : 24;
    const glitching = now < glitchUntil;
    light.intensity = glitching
      ? base * (0.35 + Math.random() * 0.65)
      : base + Math.sin(elapsed * 1.4) * 1.2;
    glowSprite.material.opacity = glitching ? 0.04 + Math.random() * 0.045 : 0.06;
  }

  function glitch(duration = 1.6) {
    glitchUntil = Math.max(glitchUntil, performance.now() + duration * 1000);
    lastGlitchFrame = 0;
    dirty = true;
  }

  draw();
  setMood("normal");

  return {
    group,
    screen,
    screenMaterial,
    texture,
    light,
    glowSprite,
    setData,
    setMood,
    setPower,
    update,
    glitch,
    data: state,
    getClock: currentClock,
    getLastDrawAt: () => lastDrawAt,
  };
}
