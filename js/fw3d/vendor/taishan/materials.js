import * as THREE from "three";
import { makeCanvasTexture, mulberry32, range } from "./utils.js";

const PITCH_WIDTH = 68;
const PITCH_LENGTH = 105;

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function createPitchTexture(renderer) {
  const width = 2048;
  const height = 1320;
  const texture = makeCanvasTexture(width, height, (ctx, w, h) => {
    const random = mulberry32(1409);
    const px = (x) => ((x + PITCH_WIDTH / 2) / PITCH_WIDTH) * w;
    const py = (z) => ((z + PITCH_LENGTH / 2) / PITCH_LENGTH) * h;
    const sx = w / PITCH_WIDTH;
    const sy = h / PITCH_LENGTH;

    // Base grass + mowing stripes.
    ctx.fillStyle = "#1b3d22";
    ctx.fillRect(0, 0, w, h);
    const stripes = 18;
    for (let i = 0; i < stripes; i += 1) {
      const left = (i / stripes) * w;
      const right = ((i + 1) / stripes) * w;
      const even = i % 2 === 0;
      const gradient = ctx.createLinearGradient(left, 0, right, 0);
      gradient.addColorStop(0, even ? "#1d4024" : "#18361e");
      gradient.addColorStop(0.5, even ? "#214829" : "#1b3b21");
      gradient.addColorStop(1, even ? "#1c3e23" : "#17341d");
      ctx.fillStyle = gradient;
      ctx.fillRect(left, 0, right - left + 1, h);
    }

    // Subtle grass speckle, worn patches and mowing marks.
    for (let i = 0; i < 38000; i += 1) {
      const x = random() * w;
      const y = random() * h;
      const alpha = range(random, 0.01, 0.075);
      ctx.fillStyle = random() > 0.55
        ? `rgba(120,160,105,${alpha})`
        : `rgba(8,25,12,${alpha})`;
      ctx.fillRect(x, y, range(random, 0.6, 2.6), range(random, 0.7, 3.4));
    }

    for (let i = 0; i < 34; i += 1) {
      const x = range(random, 0.04, 0.96) * w;
      const y = range(random, 0.04, 0.96) * h;
      const radius = range(random, 14, 70);
      const gradient = ctx.createRadialGradient(x, y, 1, x, y, radius);
      gradient.addColorStop(0, "rgba(124,106,70,0.075)");
      gradient.addColorStop(1, "rgba(56,46,28,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    ctx.strokeStyle = "rgba(236,238,227,0.82)";
    ctx.lineWidth = 0.12 * sx;
    ctx.lineCap = "square";

    // Touchlines and goal lines.
    ctx.strokeRect(px(-34), py(-52.5), px(34) - px(-34), py(52.5) - py(-52.5));
    // Halfway line.
    ctx.beginPath();
    ctx.moveTo(px(-34), py(0));
    ctx.lineTo(px(34), py(0));
    ctx.stroke();
    // Centre circle and spot.
    const centreRadius = 9.15 * sx;
    ctx.beginPath();
    ctx.arc(px(0), py(0), centreRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(236,238,227,0.85)";
    ctx.beginPath();
    ctx.arc(px(0), py(0), 0.18 * sx, 0, Math.PI * 2);
    ctx.fill();

    const drawPenaltyBoxes = (side) => {
      const goalLine = side * 52.5;
      const penaltyDepth = side * 16.5;
      const goalAreaDepth = side * 5.5;
      const penaltyWidth = 40.32;
      const goalAreaWidth = 18.32;
      ctx.strokeRect(
        px(-penaltyWidth / 2),
        py(Math.min(goalLine, goalLine - penaltyDepth)),
        px(penaltyWidth / 2) - px(-penaltyWidth / 2),
        Math.abs(py(goalLine) - py(goalLine - penaltyDepth)),
      );
      ctx.strokeRect(
        px(-goalAreaWidth / 2),
        py(Math.min(goalLine, goalLine - goalAreaDepth)),
        px(goalAreaWidth / 2) - px(-goalAreaWidth / 2),
        Math.abs(py(goalLine) - py(goalLine - goalAreaDepth)),
      );
      const spotZ = goalLine - side * 11;
      ctx.beginPath();
      ctx.arc(px(0), py(spotZ), 0.16 * sx, 0, Math.PI * 2);
      ctx.fill();

      const arcRadius = 9.15 * sx;
      ctx.beginPath();
      if (side < 0) {
        ctx.arc(px(0), py(spotZ), arcRadius, 0.28, Math.PI - 0.28);
      } else {
        ctx.arc(px(0), py(spotZ), arcRadius, Math.PI + 0.28, Math.PI * 2 - 0.28);
      }
      ctx.stroke();
    };
    drawPenaltyBoxes(-1);
    drawPenaltyBoxes(1);

    // Corner arcs.
    const cornerRadius = 1.0 * sx;
    [
      [-34, -52.5, 0, Math.PI / 2],
      [34, -52.5, Math.PI / 2, Math.PI],
      [34, 52.5, Math.PI, (Math.PI * 3) / 2],
      [-34, 52.5, (Math.PI * 3) / 2, Math.PI * 2],
    ].forEach(([x, z, start, end]) => {
      ctx.beginPath();
      ctx.arc(px(x), py(z), cornerRadius, start, end);
      ctx.stroke();
    });

    // Scuff marks around the goals and centre.
    ctx.globalAlpha = 0.14;
    for (let i = 0; i < 80; i += 1) {
      const x = px(range(random, -20, 20));
      const y = py(range(random, -52, 52));
      ctx.fillStyle = random() > 0.5 ? "#d8d2bd" : "#0b1d0c";
      ctx.beginPath();
      ctx.ellipse(x, y, range(random, 1, 5), range(random, 0.8, 2.4), random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, {
    anisotropy: renderer?.capabilities.getMaxAnisotropy?.() ?? 8,
  });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

export function createTrackTexture(renderer) {
  const width = 2048;
  const height = 1600;
  return makeCanvasTexture(width, height, (ctx, w, h) => {
    const random = mulberry32(412);
    ctx.fillStyle = "#181716";
    ctx.fillRect(0, 0, w, h);

    // Apron around track.
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#2b2723");
    gradient.addColorStop(0.5, "#171513");
    gradient.addColorStop(1, "#24211e");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    const mapX = (x) => ((x + 70) / 140) * w;
    const mapZ = (z) => ((z + 56) / 112) * h;

    const outerX = 45.5;
    const outerZ = 63.4;
    const innerX = 34.45;
    const innerZ = 53.2;
    const outerR = 19;
    const innerR = 14.5;

    roundedRectPath(
      ctx,
      mapX(-outerX),
      mapZ(-outerZ),
      mapX(outerX) - mapX(-outerX),
      mapZ(outerZ) - mapZ(-outerZ),
      outerR * (w / 140),
    );
    ctx.fillStyle = "#6f3225";
    ctx.fill();

    // Red running track, using a darker fill so it reads at night.
    roundedRectPath(
      ctx,
      mapX(-outerX + 1.0),
      mapZ(-outerZ + 1.0),
      mapX(outerX - 1.0) - mapX(-outerX + 1.0),
      mapZ(outerZ - 1.0) - mapZ(-outerZ + 1.0),
      (outerR - 1) * (w / 140),
    );
    ctx.fillStyle = "#843b2a";
    ctx.fill();

    // Track noise / rubber flecks.
    for (let i = 0; i < 9000; i += 1) {
      const x = random() * w;
      const y = random() * h;
      const insideOuter =
        x > mapX(-outerX) && x < mapX(outerX) && y > mapZ(-outerZ) && y < mapZ(outerZ);
      const insideInner =
        x > mapX(-innerX) && x < mapX(innerX) && y > mapZ(-innerZ) && y < mapZ(innerZ);
      if (!insideOuter || insideInner) continue;
      ctx.fillStyle = random() > 0.5
        ? `rgba(222,135,102,${range(random, 0.02, 0.1)})`
        : `rgba(18,8,5,${range(random, 0.02, 0.12)})`;
      ctx.fillRect(x, y, range(random, 0.6, 2), range(random, 0.6, 2));
    }

    // Lane lines.
    const lanes = 8;
    ctx.strokeStyle = "rgba(230,226,213,0.26)";
    ctx.lineWidth = 1.7;
    for (let i = 1; i < lanes; i += 1) {
      const t = i / lanes;
      const x = THREE.MathUtils.lerp(outerX - 1.0, innerX, t);
      const z = THREE.MathUtils.lerp(outerZ - 1.0, innerZ, t);
      const radius = THREE.MathUtils.lerp(outerR - 1.0, innerR, t);
      roundedRectPath(
        ctx,
        mapX(-x),
        mapZ(-z),
        mapX(x) - mapX(-x),
        mapZ(z) - mapZ(-z),
        radius * (w / 140),
      );
      ctx.stroke();
    }

    // Inner infield dark green; pitch plane sits above this.
    roundedRectPath(
      ctx,
      mapX(-innerX),
      mapZ(-innerZ),
      mapX(innerX) - mapX(-innerX),
      mapZ(innerZ) - mapZ(-innerZ),
      innerR * (w / 140),
    );
    ctx.fillStyle = "#142a18";
    ctx.fill();

    // Apron markings and scuffs.
    ctx.strokeStyle = "rgba(230,226,213,0.16)";
    ctx.lineWidth = 3;
    roundedRectPath(
      ctx,
      mapX(-outerX + 2.8),
      mapZ(-outerZ + 2.8),
      mapX(outerX - 2.8) - mapX(-outerX + 2.8),
      mapZ(outerZ - 2.8) - mapZ(-outerZ + 2.8),
      (outerR - 2.8) * (w / 140),
    );
    ctx.stroke();

    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 26; i += 1) {
      ctx.fillStyle = random() > 0.4 ? "#b6aa95" : "#090807";
      ctx.beginPath();
      ctx.ellipse(
        random() * w,
        random() * h,
        range(random, 5, 28),
        range(random, 3, 12),
        random() * Math.PI,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, {
    anisotropy: renderer?.capabilities.getMaxAnisotropy?.() ?? 8,
  });
}

export function createAdTexture(title, subtitle, variant = 0) {
  const backgrounds = [
    ["#751b14", "#ea6a2d", "#f6ead2"],
    ["#111111", "#bd3b23", "#f3e6d0"],
    ["#21120d", "#d0622f", "#dec79d"],
  ];
  const [bg, accent, text] = backgrounds[variant % backgrounds.length];
  return makeCanvasTexture(1024, 160, (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = accent;
    ctx.fillRect(0, h - 12, w, 12);
    ctx.fillRect(0, 0, 14, h);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = text;
    for (let x = -h; x < w; x += 54) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 24, 0);
      ctx.lineTo(x + h + 24, h);
      ctx.lineTo(x + h, h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = text;
    ctx.font = '700 55px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(title, 42, h * 0.48);
    ctx.font = '400 22px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = accent;
    ctx.fillText(subtitle, 44, h * 0.78);
    ctx.textAlign = "right";
    ctx.font = "400 20px monospace";
    ctx.fillStyle = "rgba(240,232,213,0.45)";
    ctx.fillText("JINAN OLYMPIC SPORTS CENTER", w - 36, h * 0.47);
  }, { anisotropy: 8 });
}

export function createStadiumBanner(text, subtext = "") {
  return makeCanvasTexture(2048, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(104,22,13,0.9)";
    ctx.fillRect(0, 18, w, h - 36);
    ctx.strokeStyle = "rgba(238,162,96,0.4)";
    ctx.lineWidth = 3;
    ctx.strokeRect(10, 28, w - 20, h - 56);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f1e7d1";
    ctx.font = '700 108px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(text, w / 2, h * 0.45);
    if (subtext) {
      ctx.fillStyle = "rgba(232,196,145,0.72)";
      ctx.font = '400 30px "Microsoft YaHei", sans-serif';
      ctx.letterSpacing = "0.22em";
      ctx.fillText(subtext, w / 2, h * 0.78);
    }
  }, { anisotropy: 8 });
}

export function createExitSign(text = "出口", subtext = "EXIT", color = "#52d38b") {
  return makeCanvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = "#07110b";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = '700 100px "Microsoft YaHei", sans-serif';
    ctx.fillText(text, w / 2, h * 0.43);
    ctx.font = '400 33px monospace';
    ctx.letterSpacing = "0.22em";
    ctx.fillText(subtext, w / 2, h * 0.75);
  }, { anisotropy: 8 });
}

export function createGatePanelTexture() {
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#181512";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(228,216,194,0.15)";
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, w - 36, h - 36);
    ctx.fillStyle = "#b9ad96";
    ctx.font = '600 33px "Microsoft YaHei", sans-serif';
    ctx.textAlign = "left";
    ctx.fillText("南出口门禁", 46, 86);
    ctx.font = '400 18px monospace';
    ctx.fillStyle = "rgba(220,208,187,0.45)";
    ctx.fillText("SOUTH EXIT ACCESS", 46, 118);
    ctx.fillStyle = "#0b0907";
    ctx.fillRect(46, 156, 420, 116);
    ctx.fillStyle = "#982e1e";
    ctx.font = '700 30px monospace';
    ctx.fillText("SENSOR OFFLINE", 68, 205);
    ctx.fillStyle = "rgba(228,216,194,0.4)";
    ctx.font = '400 19px "Microsoft YaHei", sans-serif';
    ctx.fillText("维护记录：北看台球门", 68, 244);
    ctx.fillStyle = "#e5dac5";
    ctx.font = '500 20px "Microsoft YaHei", sans-serif';
    ctx.fillText("请使用比赛用球重新激活", 46, 330);
    ctx.fillStyle = "rgba(228,216,194,0.32)";
    ctx.font = '400 16px "Microsoft YaHei", sans-serif';
    ctx.fillText("MATCH BALL REQUIRED", 46, 364);
    ctx.fillStyle = "#7d2b1c";
    ctx.beginPath();
    ctx.arc(440, 82, 18, 0, Math.PI * 2);
    ctx.fill();
  }, { anisotropy: 8 });
}
