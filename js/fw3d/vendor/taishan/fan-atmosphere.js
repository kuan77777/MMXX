// Generated crowd atmosphere. No reference photograph is shipped.
// (three-panel home end north-stand match-day collage).
import * as THREE from "three";
import { addBox, addCylinder, makeCanvasTexture } from "./utils.js";
import { DEVICE } from "./device.js";

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const METAL = new THREE.MeshStandardMaterial({
  color: 0x444b4d,
  roughness: 0.55,
  metalness: 0.5,
});
const ROPE = new THREE.MeshStandardMaterial({
  color: 0x8a7d63,
  roughness: 0.9,
  metalness: 0,
});
const EDGE = new THREE.MeshStandardMaterial({
  color: 0x17130f,
  roughness: 0.92,
  metalness: 0,
});

const textureCache = new Map();
const FLAG_POLE = new THREE.MeshStandardMaterial({ color: 0xaeb4ae, roughness: 0.46, metalness: 0.55 });
const FLAG_MATERIALS = [0xe85c22, 0xf1e5cc, 0xb72b20].map((color) => new THREE.MeshStandardMaterial({
  color,
  roughness: 0.86,
  metalness: 0,
  side: THREE.DoubleSide,
}));

function drawFabric(ctx, w, h, base) {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, base);
  gradient.addColorStop(0.48, base);
  gradient.addColorStop(1, "#000000");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  // Woven cloth and long horizontal folds.
  for (let y = 0; y < h; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? "rgba(255,255,255,0.028)" : "rgba(0,0,0,0.045)";
    ctx.fillRect(0, y, w, 1);
  }
  for (let x = 0; x < w; x += 5) {
    ctx.fillStyle = "rgba(0,0,0,0.018)";
    ctx.fillRect(x, 0, 1, h);
  }
  for (let i = 0; i < 7; i += 1) {
    const x = (w / 7) * i + 30;
    const fold = ctx.createLinearGradient(x - 40, 0, x + 70, 0);
    fold.addColorStop(0, "rgba(0,0,0,0)");
    fold.addColorStop(0.48, "rgba(0,0,0,0.2)");
    fold.addColorStop(0.58, "rgba(255,255,255,0.05)");
    fold.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = fold;
    ctx.fillRect(x - 40, 0, 120, h);
  }
  const vignette = ctx.createLinearGradient(0, 0, 0, h);
  vignette.addColorStop(0, "rgba(0,0,0,0.35)");
  vignette.addColorStop(0.12, "rgba(0,0,0,0)");
  vignette.addColorStop(0.86, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.32)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

function drawGrommets(ctx, w, h) {
  for (const [x, y] of [[16, 16], [w - 16, 16], [16, h - 16], [w - 16, h - 16]]) {
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#6d6253";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = "#16120e";
    ctx.fill();
  }
}

function createBannerTexture({
  text,
  subtext = "",
  background = "#0c0d0f",
  foreground = "#f3ecdc",
  accent = "#d84622",
  aspect = 6,
  layout = "center",
  stripe = false,
  border = true,
}) {
  const key = [text, subtext, background, foreground, accent, aspect, layout, stripe, border].join("|");
  if (textureCache.has(key)) return textureCache.get(key);
  const width = 1024;
  const height = Math.max(160, Math.round(width / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  drawFabric(ctx, width, height, background);

  if (stripe) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.9;
    for (let x = -height; x < width + height; x += height * 1.4) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(-0.42);
      ctx.fillRect(0, -height * 0.2, height * 0.34, height * 1.4);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  if (border) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(5, height * 0.018);
    ctx.strokeRect(18, 18, width - 36, height - 36);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 2;
    ctx.strokeRect(30, 30, width - 60, height - 60);
  }

  // Two small accent blocks, echoing the taped/stitched edges in the photo.
  ctx.fillStyle = accent;
  ctx.fillRect(30, height - 30 - Math.max(6, height * 0.025), Math.min(220, width * 0.16), Math.max(6, height * 0.025));
  ctx.fillRect(width - 250, 30, Math.min(220, width * 0.16), Math.max(6, height * 0.025));

  ctx.textBaseline = "middle";
  ctx.textAlign = layout === "left" ? "left" : "center";
  const maxTextWidth = width * (layout === "left" ? 0.68 : 0.86);
  let fontSize = Math.floor(height * (subtext ? 0.5 : 0.58));
  ctx.font = `900 ${fontSize}px ${FONT}`;
  while (ctx.measureText(text).width > maxTextWidth && fontSize > 36) {
    fontSize -= 4;
    ctx.font = `900 ${fontSize}px ${FONT}`;
  }
  const baseY = subtext ? height * 0.44 : height * 0.52;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillText(text, width / 2 + 4, baseY + 5);
  ctx.fillStyle = foreground;
  ctx.fillText(text, width / 2, baseY);

  if (subtext) {
    let subSize = Math.floor(height * 0.13);
    ctx.font = `700 ${subSize}px ${FONT}`;
    while (ctx.measureText(subtext).width > maxTextWidth && subSize > 22) {
      subSize -= 2;
      ctx.font = `700 ${subSize}px ${FONT}`;
    }
    ctx.fillStyle = accent;
    ctx.fillText(subtext, width / 2, height * 0.79);
  }
  drawGrommets(ctx, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  textureCache.set(key, texture);
  return texture;
}

function bannerMaterial(texture) {
  return new THREE.MeshStandardMaterial({
    map: texture,
    emissive: 0x2b0c05,
    emissiveMap: texture,
    emissiveIntensity: 0.16,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
  });
}

function addRail(group, { axis, x, z, length, y, rotationY = 0, posts = true }) {
  const railGroup = new THREE.Group();
  railGroup.position.set(x, 0, z);
  railGroup.rotation.y = rotationY;
  group.add(railGroup);
  const horizontal = axis === "x"
    ? [length, 0.09, 0.09]
    : [0.09, 0.09, length];
  addBox(railGroup, {
    size: horizontal,
    position: [0, y, 0],
    material: METAL,
  });
  addBox(railGroup, {
    size: axis === "x" ? [length, 0.055, 0.055] : [0.055, 0.055, length],
    position: [0, y - 1.55, 0],
    material: METAL,
  });
  if (posts) {
    const steps = Math.max(2, Math.round(length / 24));
    for (let i = 0; i <= steps; i += 1) {
      const offset = -length / 2 + (length / steps) * i;
      addBox(railGroup, {
        size: [0.075, y, 0.075],
        position: axis === "x" ? [offset, y / 2, 0] : [0, y / 2, offset],
        material: METAL,
      });
    }
  }
  return railGroup;
}

function addBanner(group, {
  text,
  subtext = "",
  background,
  foreground,
  accent,
  width,
  height,
  x,
  y,
  z,
  rotationY = 0,
  layout = "center",
  stripe = false,
  railY,
  simple = true,
}) {
  const texture = createBannerTexture({
    text,
    subtext,
    background,
    foreground,
    accent,
    aspect: width / height,
    layout,
    stripe,
  });
  const clothMaterial = bannerMaterial(texture);
  const cloth = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, 0.035),
    clothMaterial,
  );
  cloth.position.set(0, 0, 0);
  cloth.castShadow = false;
  cloth.receiveShadow = true;

  const banner = new THREE.Group();
  banner.position.set(x, y, z);
  banner.rotation.y = rotationY;
  banner.add(cloth);

  // A stitched sleeve gives the cloth a physical edge. Small repeated rail
  // banners use a simplified sleeve only; this keeps the stadium draw-call
  // budget lower without making the large pieces look flat.
  addBox(banner, {
    size: [width + 0.1, 0.075, 0.075],
    position: [0, height / 2 + 0.01, 0.04],
    material: EDGE,
  });
  if (!simple) {
    addBox(banner, {
      size: [width - 0.12, 0.045, 0.055],
      position: [0, -height / 2 - 0.005, 0.035],
      material: EDGE,
    });
    const ropeTop = (railY ?? y + height / 2 + 0.22) - y;
    for (const side of [-1, 1]) {
      addBox(banner, {
        size: [0.025, Math.max(0.08, ropeTop - height / 2), 0.025],
        position: [side * width * 0.4, height / 2 + Math.max(0.04, ropeTop - height / 2) / 2, 0.055],
        rotation: [0, 0, side * 0.06],
        material: ROPE,
      });
    }
  }
  group.add(banner);
  return banner;
}

function addSmallBanners(group, config) {
  const {
    axis,
    fixed,
    from,
    to,
    step,
    y,
    railY,
    rotationY,
    texts,
    colors,
  } = config;
  let index = 0;
  for (let p = from; p <= to + 0.001; p += step) {
    const palette = colors[index % colors.length];
    const text = texts[index % texts.length];
    addBanner(group, {
      text,
      subtext: "",
      background: palette.background,
      foreground: palette.foreground,
      accent: palette.accent,
      width: config.width,
      height: config.height,
      x: axis === "x" ? p : fixed,
      y,
      z: axis === "x" ? fixed : p,
      rotationY,
      railY,
      stripe: index % 3 === 0,
      simple: true,
    });
    index += 1;
  }
}

function wavyFlagGeometry(width = 1.05, height = 0.62) {
  const geometry = new THREE.PlaneGeometry(width, height, 8, 3);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    position.setZ(i, Math.sin(x * 7 + y * 2) * 0.06 + Math.cos(x * 4) * 0.025);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function addFlags(group, config) {
  const {
    axis,
    fixed,
    from,
    to,
    step,
    rotationY,
    baseY,
    poleHeight,
    flagWidth,
    flagHeight,
  } = config;
  const placements = [];
  for (let p = from; p <= to + 0.001; p += step) {
    placements.push({
      x: axis === "x" ? p : fixed,
      z: axis === "x" ? fixed : p,
      colorIndex: placements.length % 3,
    });
  }
  const poleGeometry = new THREE.CylinderGeometry(0.022, 0.028, 1, 6);
  const poleMesh = new THREE.InstancedMesh(poleGeometry, FLAG_POLE, placements.length);
  const flagGeometry = wavyFlagGeometry(flagWidth, flagHeight);
  const buckets = [[], [], []];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const scale = new THREE.Vector3(1, 1, 1);
  const position = new THREE.Vector3();
  const offset = new THREE.Vector3();

  placements.forEach((placement, index) => {
    quaternion.setFromAxisAngle(yAxis, rotationY);
    position.set(placement.x, baseY + poleHeight / 2, placement.z);
    matrix.compose(position, new THREE.Quaternion(), new THREE.Vector3(1, poleHeight, 1));
    poleMesh.setMatrixAt(index, matrix);

    offset.set(flagWidth * 0.48, 0, 0).applyAxisAngle(yAxis, rotationY);
    position.set(
      placement.x + offset.x,
      baseY + poleHeight - flagHeight * 0.48,
      placement.z + offset.z,
    );
    const flagQuat = new THREE.Quaternion().setFromAxisAngle(yAxis, rotationY - 0.08);
    matrix.compose(position, flagQuat, scale);
    buckets[placement.colorIndex].push(matrix.clone());
  });
  poleMesh.instanceMatrix.needsUpdate = true;
  poleMesh.frustumCulled = false;
  group.add(poleMesh);

  buckets.forEach((matrices, bucketIndex) => {
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(flagGeometry, FLAG_MATERIALS[bucketIndex], matrices.length);
    matrices.forEach((entry, index) => mesh.setMatrixAt(index, entry));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    group.add(mesh);
  });
}

function addLargeCornerFlags(group) {
  const texture = createBannerTexture({
    text: "北看台",
    subtext: "ULTRAS",
    background: "#0a0b0d",
    foreground: "#f5eddb",
    accent: "#d74422",
    aspect: 1.7,
  });
  for (const [x, z, rotationY] of [[-48, -63.86, 0], [48, -63.86, 0]]) {
    const pole = new THREE.Group();
    pole.position.set(x, 0, z);
    pole.rotation.y = rotationY;
    group.add(pole);
    addCylinder(pole, {
      radiusTop: 0.03,
      radiusBottom: 0.04,
      height: 5.5,
      radialSegments: 8,
      position: [0, 2.75, 0],
      material: METAL,
    });
    const flag = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 1.45, 0.025),
      [EDGE, EDGE, EDGE, EDGE, bannerMaterial(texture), bannerMaterial(texture)],
    );
    flag.position.set(1.28, 4.65, 0);
    flag.rotation.y = -0.18;
    pole.add(flag);
  }
}


function addUpperBanners(group) {
  // Banners on the front of the upper tiers. Their positions avoid the older
  // anniversary/legacy banners already present in the stadium.
  addRail(group, { axis: "x", x: 0, z: -78.28, length: 100, y: 8.72, posts: false });
  addRail(group, { axis: "x", x: 0, z: 78.28, length: 100, y: 8.72, posts: false });
  addRail(group, { axis: "z", x: 78.28, z: 0, length: 74, y: 8.72, posts: false });
  addRail(group, { axis: "z", x: -78.28, z: 0, length: 74, y: 8.72, posts: false });

  addBanner(group, {
    text: "北看台青年",
    subtext: "NORTH STAND ULTRAS",
    background: "#0a0b0d",
    foreground: "#f6efdf",
    accent: "#db4a23",
    width: 26,
    height: 2.9,
    x: -32,
    y: 7.2,
    z: -78.18,
    railY: 8.72,
  });
  addBanner(group, {
    text: "T山精神铸荣光",
    subtext: "SHANDONG HOME",
    background: "#a72a1c",
    foreground: "#fff0d2",
    accent: "#f1b23a",
    width: 26,
    height: 2.9,
    x: 32,
    y: 7.2,
    z: -78.18,
    railY: 8.72,
  });
  addBanner(group, {
    text: "荣耀与传承",
    subtext: "SINCE 1993 · HOME",
    background: "#e7dfcf",
    foreground: "#171411",
    accent: "#b52a1e",
    width: 38,
    height: 2.4,
    x: 0,
    y: 6.95,
    z: 78.18,
    rotationY: Math.PI,
    railY: 8.72,
  });
  addBanner(group, {
    text: "山东T山",
    subtext: "HOME · WE ARE ONE",
    background: "#b42b1e",
    foreground: "#fff2dd",
    accent: "#f0b23b",
    width: 22,
    height: 2.5,
    x: 78.18,
    y: 7.0,
    z: -24,
    rotationY: -Math.PI / 2,
    railY: 8.72,
  });
  addBanner(group, {
    text: "战斗",
    subtext: "FIGHTING TOGETHER",
    background: "#0b0c0e",
    foreground: "#f5eddc",
    accent: "#db4a23",
    width: 22,
    height: 2.5,
    x: 78.18,
    y: 7.0,
    z: 24,
    rotationY: -Math.PI / 2,
    railY: 8.72,
  });
  addBanner(group, {
    text: "T山队",
    subtext: "MOUNTAIN TAI",
    background: "#0b0c0e",
    foreground: "#f5eddc",
    accent: "#db4a23",
    width: 22,
    height: 2.5,
    x: -78.18,
    y: 7.0,
    z: -24,
    rotationY: Math.PI / 2,
    railY: 8.72,
  });
  addBanner(group, {
    text: "战斗",
    subtext: "FIGHTING TOGETHER",
    background: "#a72a1c",
    foreground: "#fff0d2",
    accent: "#e8a83a",
    width: 22,
    height: 2.5,
    x: -78.18,
    y: 7.0,
    z: 24,
    rotationY: Math.PI / 2,
    railY: 8.72,
  });
}

function addSeatBackMosaic(group) {
  const entries = [];
  const palette = [new THREE.Color(0x7d2f14), new THREE.Color(0x0b0b0c), new THREE.Color(0x625b50)];
  const addSeatBack = (x, y, z, rotationY, block) => {
    const index = ((block % 10) + 10) % 10;
    const color = index < 8 ? palette[0] : index < 9 ? palette[1] : palette[2];
    entries.push({ x, y, z, rotationY, color });
  };

  // Lower tiers only. These are additive seat-back tifo cards, not a crowd
  // simulation, and keep the existing seat geometry untouched.
  for (const side of [-1, 1]) {
    for (let row = 0; row < 9; row += 1) {
      const topY = 0.9 + row * 0.59;
      const seatY = topY + 0.06;
      const zCenter = side * (64 + row * 1.38 + 0.69);
      for (let x = -51.5; x <= 51.5; x += 0.63) {
        if (Math.abs(((x + 52) / 0.63) % 26) < 1.1) continue;
        if (side === 1 && Math.abs(x) < 2.8) continue;
        const z = zCenter + side * 0.18 - side * 0.12;
        addSeatBack(x, seatY + 0.3, z, side === 1 ? Math.PI : 0, Math.floor((x + 52) / 6.3) + row * 2);
      }
    }
  }
  for (const side of [-1, 1]) {
    for (let row = 0; row < 9; row += 1) {
      const topY = 0.9 + row * 0.59;
      const seatY = topY + 0.06;
      const xCenter = side * (46 + row * 1.38 + 0.69);
      for (let z = -38.5; z <= 38.5; z += 0.63) {
        if (Math.abs(((z + 39) / 0.63) % 24) < 1.1) continue;
        const x = xCenter + side * 0.18 - side * 0.12;
        addSeatBack(x, seatY + 0.3, z, side === 1 ? Math.PI / 2 : -Math.PI / 2, Math.floor((z + 39) / 6.3) + row * 2);
      }
    }
  }

  // Upper tiers: same additive tifo treatment so the whole bowl, not just
  // the lower rail, carries the orange home-end colour.
  for (const side of [-1, 1]) {
    for (let row = 0; row < 10; row += 1) {
      const topY = 6.15 + row * 0.68;
      const seatY = topY + 0.06;
      const zCenter = side * (78.57 + row * 1.52 + 0.76);
      for (let x = -49.5; x <= 49.5; x += 0.63) {
        if (Math.abs(((x + 50) / 0.63) % 28) < 1.1) continue;
        const z = zCenter + side * 0.18 - side * 0.12;
        addSeatBack(x, seatY + 0.3, z, side === 1 ? Math.PI : 0, Math.floor((x + 50) / 6.6) + row * 2);
      }
    }
  }
  for (const side of [-1, 1]) {
    for (let row = 0; row < 10; row += 1) {
      const topY = 6.15 + row * 0.68;
      const seatY = topY + 0.06;
      const xCenter = side * (78.57 + row * 1.52 + 0.76);
      for (let z = -36.5; z <= 36.5; z += 0.63) {
        if (Math.abs(((z + 37) / 0.63) % 26) < 1.1) continue;
        const x = xCenter + side * 0.18 - side * 0.12;
        addSeatBack(x, seatY + 0.3, z, side === 1 ? Math.PI / 2 : -Math.PI / 2, Math.floor((z + 37) / 6.6) + row * 2);
      }
    }
  }

  const geometry = new THREE.PlaneGeometry(0.52, 0.58);
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, entries.length);
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const position = new THREE.Vector3();
  entries.forEach((entry, index) => {
    position.set(entry.x, entry.y, entry.z);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), entry.rotationY);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, entry.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
}


function addSeatTopMosaic(group) {
  const entries = [];
  const palette = [new THREE.Color(0x7d2f14), new THREE.Color(0x0b0b0c), new THREE.Color(0x625b50)];
  const addSeatTop = (x, y, z, rotationY, block) => {
    const index = ((block % 10) + 10) % 10;
    entries.push({
      x, y, z, rotationY,
      color: index < 9 ? palette[0] : palette[1],
    });
  };
  for (const side of [-1, 1]) {
    for (let row = 0; row < 10; row += 1) {
      const topY = 6.15 + row * 0.68;
      const seatY = topY + 0.06;
      const zCenter = side * (78.57 + row * 1.52 + 0.76);
      for (let x = -49.5; x <= 49.5; x += 0.63) {
        if (Math.abs(((x + 50) / 0.63) % 28) < 1.1) continue;
        addSeatTop(x, seatY + 0.12, zCenter, side === 1 ? Math.PI : 0, Math.floor((x + 50) / 6.6) + row * 2);
      }
    }
  }
  for (const side of [-1, 1]) {
    for (let row = 0; row < 10; row += 1) {
      const topY = 6.15 + row * 0.68;
      const seatY = topY + 0.06;
      const xCenter = side * (78.57 + row * 1.52 + 0.76);
      for (let z = -36.5; z <= 36.5; z += 0.63) {
        if (Math.abs(((z + 37) / 0.63) % 26) < 1.1) continue;
        addSeatTop(xCenter, seatY + 0.12, z, side === 1 ? Math.PI / 2 : -Math.PI / 2, Math.floor((z + 37) / 6.6) + row * 2);
      }
    }
  }
  const geometry = new THREE.PlaneGeometry(0.52, 0.46);
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, entries.length);
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const quaternion = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const scale = new THREE.Vector3(1, 1, 1);
  const position = new THREE.Vector3();
  entries.forEach((entry, index) => {
    position.set(entry.x, entry.y, entry.z);
    quaternion.setFromAxisAngle(yAxis, entry.rotationY).multiply(qx);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, entry.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
}

export function buildFanAtmosphere(group) {
  // Front railings: existing advertisements sit near y=0.6; the fan banners
  // hang above them so both remain readable.
  addRail(group, { axis: "x", x: 0, z: -63.84, length: 104, y: 4.6 });
  addRail(group, { axis: "x", x: 0, z: 63.84, length: 104, y: 4.6 });
  addRail(group, { axis: "z", x: 46.42, z: 0, length: 78, y: 4.6 });
  addRail(group, { axis: "z", x: -46.42, z: 0, length: 78, y: 4.6 });

  // Upper banner cable, so the small rail banners are visibly tied too.
  addRail(group, { axis: "x", x: 0, z: -63.84, length: 104, y: 5.3, posts: false });
  addRail(group, { axis: "x", x: 0, z: 63.84, length: 104, y: 5.3, posts: false });
  addRail(group, { axis: "z", x: 46.42, z: 0, length: 78, y: 5.3, posts: false });
  addRail(group, { axis: "z", x: -46.42, z: 0, length: 78, y: 5.3, posts: false });

  // North stand: the main home end in the supplied photograph.
  addBanner(group, {
    text: "勇士",
    subtext: "BRAVE · ULTRAS",
    background: "#0b0c0e",
    foreground: "#f4edde",
    accent: "#c83220",
    width: 13,
    height: 3.2,
    x: -40,
    y: 2.6,
    z: -63.78,
    railY: 4.6,
  });
  addBanner(group, {
    text: "成就永恒的篇章",
    subtext: "GLORY · 1993—2025",
    background: "#e7dfcf",
    foreground: "#161412",
    accent: "#b52a1e",
    width: 15,
    height: 3.2,
    x: -24,
    y: 2.6,
    z: -63.78,
    railY: 4.6,
  });
  addBanner(group, {
    text: "北看台青年",
    subtext: "NORTH STAND ULTRAS · WE ARE ONE",
    background: "#0a0b0d",
    foreground: "#f6efdf",
    accent: "#dd4b23",
    width: 24,
    height: 3.8,
    x: -2,
    y: 2.7,
    z: -63.78,
    railY: 4.6,
  });
  addBanner(group, {
    text: "T山精神铸荣光",
    subtext: "MOUNTAIN TAI · SHANDONG",
    background: "#a72a1c",
    foreground: "#fff0d2",
    accent: "#f1b23a",
    width: 16,
    height: 3.2,
    x: 19,
    y: 2.6,
    z: -63.78,
    railY: 4.6,
  });
  addBanner(group, {
    text: "天下齐鲁一脉传",
    subtext: "ONE QILU · ONE HEART",
    background: "#0b0c0e",
    foreground: "#f4edde",
    accent: "#d34a24",
    width: 16,
    height: 3.2,
    x: 37,
    y: 2.6,
    z: -63.78,
    railY: 4.6,
  });

  // East and west lower rails, using the same visual language but different
  // text so the whole ground feels decorated rather than one end.
  addBanner(group, {
    text: "我们是T山",
    subtext: "WE ARE MOUNTAIN TAI",
    background: "#b42b1e",
    foreground: "#fff2dd",
    accent: "#f0b23b",
    width: 18,
    height: 2.9,
    x: 46.34,
    y: 2.45,
    z: 2,
    rotationY: -Math.PI / 2,
    railY: 4.6,
  });
  addBanner(group, {
    text: "山东T山",
    subtext: "HOME · JINAN",
    background: "#0b0c0e",
    foreground: "#f5eddc",
    accent: "#db4a23",
    width: 19,
    height: 3.0,
    x: -46.34,
    y: 2.45,
    z: -4,
    rotationY: Math.PI / 2,
    railY: 4.6,
  });
  addBanner(group, {
    text: "荣耀与传承",
    subtext: "30 YEARS · 1993—2023",
    background: "#e8dfcd",
    foreground: "#171411",
    accent: "#b52b1e",
    width: 20,
    height: 2.9,
    x: 2,
    y: 2.45,
    z: 63.78,
    rotationY: Math.PI,
    railY: 4.6,
  });
  addBanner(group, {
    text: "同袍",
    subtext: "TOGETHER · HOME",
    background: "#a72a1c",
    foreground: "#fff0d2",
    accent: "#e8a83a",
    width: 11,
    height: 2.8,
    x: 27,
    y: 2.5,
    z: 63.78,
    rotationY: Math.PI,
    railY: 4.6,
  });

  addBanner(group, {
    text: "山东T山",
    subtext: "HOME · JINAN",
    background: "#0b0c0e",
    foreground: "#f5eddc",
    accent: "#db4a23",
    width: 16,
    height: 2.8,
    x: 46.34,
    y: 2.5,
    z: -23,
    rotationY: -Math.PI / 2,
    railY: 4.6,
  });
  addBanner(group, {
    text: "战斗",
    subtext: "FIGHTING TOGETHER",
    background: "#a72a1c",
    foreground: "#fff0d2",
    accent: "#e8a83a",
    width: 16,
    height: 2.8,
    x: 46.34,
    y: 2.5,
    z: 26,
    rotationY: -Math.PI / 2,
    railY: 4.6,
  });
  addBanner(group, {
    text: "T山队",
    subtext: "MOUNTAIN TAI",
    background: "#a72a1c",
    foreground: "#fff0d2",
    accent: "#e8a83a",
    width: 16,
    height: 2.8,
    x: -46.34,
    y: 2.5,
    z: -24,
    rotationY: Math.PI / 2,
    railY: 4.6,
  });
  addBanner(group, {
    text: "忠橙",
    subtext: "LOYAL ORANGE",
    background: "#0b0c0e",
    foreground: "#f5eddc",
    accent: "#db4a23",
    width: 16,
    height: 2.8,
    x: -46.34,
    y: 2.5,
    z: 25,
    rotationY: Math.PI / 2,
    railY: 4.6,
  });
  addBanner(group, {
    text: "山东T山",
    subtext: "HOME · WE ARE ONE",
    background: "#0b0c0e",
    foreground: "#f5eddc",
    accent: "#db4a23",
    width: 18,
    height: 2.9,
    x: -24,
    y: 2.45,
    z: 63.78,
    rotationY: Math.PI,
    railY: 4.6,
  });
  addBanner(group, {
    text: "战斗",
    subtext: "FIGHTING TOGETHER",
    background: "#a72a1c",
    foreground: "#fff0d2",
    accent: "#e8a83a",
    width: 16,
    height: 2.9,
    x: 22,
    y: 2.45,
    z: 63.78,
    rotationY: Math.PI,
    railY: 4.6,
  });

  const smallPalette = [
    { background: "#d9551e", foreground: "#fff3dc", accent: "#8f2318" },
    { background: "#0b0c0e", foreground: "#f4edde", accent: "#d94b22" },
    { background: "#e9dfcc", foreground: "#161310", accent: "#b42b1e" },
  ];
  const northSmall = ["山东T山", "HOME", "北看台", "战斗", "T山队", "忠橙", "WE ARE ONE", "1993"];
  if (DEVICE.quality !== "low") addSmallBanners(group, {
    axis: "x",
    fixed: -63.8,
    from: -45,
    to: 45,
    step: 8.2,
    y: 4.96,
    railY: 5.3,
    rotationY: 0,
    texts: northSmall,
    colors: smallPalette,
    width: 7.4,
    height: 0.56,
  });
  if (DEVICE.quality !== "low") addSmallBanners(group, {
    axis: "x",
    fixed: 63.8,
    from: -43,
    to: 43,
    step: 9.5,
    y: 4.96,
    railY: 5.3,
    rotationY: Math.PI,
    texts: ["山东T山", "战斗", "HOME", "T山队"],
    colors: smallPalette,
    width: 8.4,
    height: 0.56,
  });
  if (DEVICE.quality !== "low") addSmallBanners(group, {
    axis: "z",
    fixed: 46.36,
    from: -31,
    to: 31,
    step: 12.4,
    y: 4.96,
    railY: 5.3,
    rotationY: -Math.PI / 2,
    texts: ["山东T山", "北看台", "HOME", "战斗"],
    colors: smallPalette,
    width: 9.4,
    height: 0.56,
  });
  if (DEVICE.quality !== "low") addSmallBanners(group, {
    axis: "z",
    fixed: -46.36,
    from: -31,
    to: 31,
    step: 12.4,
    y: 4.96,
    railY: 5.3,
    rotationY: Math.PI / 2,
    texts: ["T山队", "忠橙", "山东T山", "WE ARE ONE"],
    colors: smallPalette,
    width: 9.4,
    height: 0.56,
  });

  addFlags(group, {
    axis: "x",
    fixed: -63.78,
    from: -44,
    to: 44,
    step: 8.8,
    rotationY: 0,
    baseY: 5.32,
    poleHeight: 1.35,
    flagWidth: 1.05,
    flagHeight: 0.62,
  });
  addFlags(group, {
    axis: "x",
    fixed: 63.78,
    from: -40,
    to: 40,
    step: 10,
    rotationY: Math.PI,
    baseY: 5.32,
    poleHeight: 1.35,
    flagWidth: 1.05,
    flagHeight: 0.62,
  });
  addFlags(group, {
    axis: "z",
    fixed: 46.32,
    from: -28,
    to: 28,
    step: 14,
    rotationY: -Math.PI / 2,
    baseY: 5.32,
    poleHeight: 1.35,
    flagWidth: 1.05,
    flagHeight: 0.62,
  });
  addFlags(group, {
    axis: "z",
    fixed: -46.32,
    from: -28,
    to: 28,
    step: 14,
    rotationY: Math.PI / 2,
    baseY: 5.32,
    poleHeight: 1.35,
    flagWidth: 1.05,
    flagHeight: 0.62,
  });

  addLargeCornerFlags(group);
  if (DEVICE.quality !== "low") {
    addUpperBanners(group);
  }
  addSeatBackMosaic(group);
  if (DEVICE.quality !== "low") {
    addSeatTopMosaic(group);
  }
}
