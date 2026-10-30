import * as THREE from "three";

/** Small, deterministic PRNG so procedural scenery is stable between reloads. */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(random, min, max) {
  return min + (max - min) * random();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Create a CanvasTexture from a drawing callback. Color textures use sRGB.
 */
export function makeCanvasTexture(width, height, draw, options = {}) {
  const {
    colorSpace = "srgb",
    repeat = null,
    anisotropy = 8,
    minFilter = THREE.LinearMipmapLinearFilter,
    magFilter = THREE.LinearFilter,
    wrap = THREE.ClampToEdgeWrapping,
  } = options;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  draw(ctx, width, height, canvas);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = anisotropy;
  texture.minFilter = minFilter;
  texture.magFilter = magFilter;
  texture.wrapS = wrap;
  texture.wrapT = wrap;
  if (repeat) {
    texture.repeat.set(repeat[0], repeat[1]);
  }
  texture.needsUpdate = true;
  return texture;
}

export function addBox(group, options) {
  const {
    size = [1, 1, 1],
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    material,
    castShadow = false,
    receiveShadow = false,
    name,
  } = options;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  if (name) mesh.name = name;
  group.add(mesh);
  return mesh;
}

export function addPlane(group, options) {
  const {
    size = [1, 1],
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    material,
    receiveShadow = false,
    name,
  } = options;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.receiveShadow = receiveShadow;
  if (name) mesh.name = name;
  group.add(mesh);
  return mesh;
}

export function addCylinder(group, options) {
  const {
    radiusTop = 0.5,
    radiusBottom = 0.5,
    height = 1,
    radialSegments = 12,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    material,
    castShadow = false,
    receiveShadow = false,
    openEnded = false,
  } = options;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments, 1, openEnded),
    material,
  );
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  group.add(mesh);
  return mesh;
}

export function addCollider(colliders, minX, maxX, minZ, maxZ, extra = {}) {
  const collider = {
    minX,
    maxX,
    minZ,
    maxZ,
    active: true,
    ...extra,
  };
  colliders.push(collider);
  return collider;
}

export function colliderFromMesh(mesh, padding = 0, extra = {}) {
  mesh.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(mesh);
  return {
    minX: box.min.x - padding,
    maxX: box.max.x + padding,
    minZ: box.min.z - padding,
    maxZ: box.max.z + padding,
    active: true,
    ...extra,
  };
}

export function addPointLight(group, color, intensity, distance, position, decay = 2) {
  const light = new THREE.PointLight(color, intensity, distance, decay);
  light.position.set(position[0], position[1], position[2]);
  group.add(light);
  return light;
}

export function addSpotLight(group, options) {
  const {
    color = 0xffd2a0,
    intensity = 100,
    distance = 20,
    angle = Math.PI / 6,
    penumbra = 0.45,
    decay = 2,
    position = [0, 4, 0],
    target = [0, 0, 0],
    castShadow = false,
    mapSize = 1024,
  } = options;
  const light = new THREE.SpotLight(color, intensity, distance, angle, penumbra, decay);
  light.position.set(position[0], position[1], position[2]);
  light.target.position.set(target[0], target[1], target[2]);
  light.castShadow = castShadow;
  if (castShadow) {
    light.shadow.mapSize.set(mapSize, mapSize);
    light.shadow.bias = -0.0005;
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = distance;
  }
  group.add(light);
  group.add(light.target);
  return light;
}

export function createTextTexture(text, options = {}) {
  const {
    width = 1024,
    height = 256,
    background = "rgba(0,0,0,0)",
    color = "#f1eada",
    accent = null,
    fontSize = 90,
    fontFamily = '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontWeight = 700,
    align = "center",
    letterSpacing = "0.04em",
    subtext = null,
    subFontSize = 28,
    padding = 36,
  } = options;

  return makeCanvasTexture(width, height, (ctx) => {
    if (background !== "transparent") {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    if (accent) {
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, width, 8);
    }
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    const x = align === "center" ? width / 2 : padding;
    const y = subtext ? height * 0.44 : height * 0.5;
    if ("letterSpacing" in ctx) ctx.letterSpacing = letterSpacing;
    ctx.fillText(text, x, y);
    if (subtext) {
      ctx.font = `400 ${subFontSize}px ${fontFamily}`;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.52;
      ctx.fillText(subtext, x, height * 0.77);
      ctx.globalAlpha = 1;
    }
  });
}

export function createPanelTexture({
  width = 1024,
  height = 512,
  base = "#a63724",
  highlight = "#d7622d",
  dark = "#581a14",
  stripes = true,
} = {}) {
  return makeCanvasTexture(width, height, (ctx, w, h) => {
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, dark);
    gradient.addColorStop(0.38, base);
    gradient.addColorStop(0.72, highlight);
    gradient.addColorStop(1, base);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    if (stripes) {
      const random = mulberry32(74);
      ctx.save();
      ctx.globalAlpha = 0.11;
      for (let i = 0; i < 26; i += 1) {
        ctx.fillStyle = i % 3 === 0 ? "#ffb36a" : "#2b0c08";
        ctx.beginPath();
        ctx.moveTo(0, range(random, 0, h));
        ctx.lineTo(w, range(random, 0, h));
        ctx.lineTo(w, range(random, 0, h));
        ctx.lineTo(0, range(random, 0, h));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, h - 80, w, 80);
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "#f7d0a6";
    ctx.lineWidth = 2;
    for (let x = 0; x < w; x += 128) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, { repeat: [2, 1], wrap: THREE.RepeatWrapping });
}

export function createConcreteTexture(tone = "#6a625c") {
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = tone;
    ctx.fillRect(0, 0, w, h);
    const random = mulberry32(91021);
    for (let i = 0; i < 7000; i += 1) {
      const alpha = range(random, 0.015, 0.09);
      ctx.fillStyle = random() > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
      const size = range(random, 0.5, 2.6);
      ctx.fillRect(range(random, 0, w), range(random, 0, h), size, size);
    }
    ctx.strokeStyle = "rgba(20,16,12,0.22)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 16; i += 1) {
      ctx.beginPath();
      let x = range(random, 0, w);
      let y = range(random, 0, h);
      ctx.moveTo(x, y);
      for (let j = 0; j < 6; j += 1) {
        x += range(random, -28, 28);
        y += range(random, 8, 34);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const vignette = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.7);
    vignette.addColorStop(0, "rgba(255,255,255,0.04)");
    vignette.addColorStop(1, "rgba(0,0,0,0.22)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }, { repeat: [2, 2], wrap: THREE.RepeatWrapping });
}

export function createWoodTexture() {
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#4c2d1c";
    ctx.fillRect(0, 0, w, h);
    const random = mulberry32(117);
    for (let i = 0; i < 110; i += 1) {
      ctx.strokeStyle = `rgba(${random() > 0.5 ? "22,10,4" : "120,75,40"},${range(random, 0.08, 0.25)})`;
      ctx.lineWidth = range(random, 1, 3);
      ctx.beginPath();
      const y = range(random, 0, h);
      ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += 32) {
        ctx.lineTo(x, y + Math.sin(x * 0.025 + i) * range(random, 1, 5));
      }
      ctx.stroke();
    }
  }, { repeat: [2, 2], wrap: THREE.RepeatWrapping });
}

export function createNetGeometry(width, height, depth, step = 0.34) {
  const points = [];
  const backHeight = height * 0.58;

  // Back plane at z = -depth.
  for (let x = 0; x <= width; x += step) {
    points.push(-width / 2 + x, 0, -depth, -width / 2 + x, backHeight, -depth);
  }
  for (let y = 0; y <= backHeight; y += step) {
    points.push(-width / 2, y, -depth, width / 2, y, -depth);
  }
  // Slanted roof panel from the crossbar to the back.
  for (let x = 0; x <= width; x += step) {
    points.push(-width / 2 + x, height, 0, -width / 2 + x, backHeight, -depth);
  }
  for (let z = 0; z <= depth; z += step) {
    const t = z / depth;
    const y = THREE.MathUtils.lerp(height, backHeight, t);
    points.push(-width / 2, y, -z, width / 2, y, -z);
  }
  // Side panels.
  for (let z = 0; z <= depth; z += step) {
    const t = z / depth;
    points.push(-width / 2, 0, -z, -width / 2, THREE.MathUtils.lerp(height, backHeight, t), -z);
    points.push(width / 2, 0, -z, width / 2, THREE.MathUtils.lerp(height, backHeight, t), -z);
  }
  for (let y = 0; y <= backHeight; y += step) {
    points.push(-width / 2, y, 0, -width / 2, y, -depth);
    points.push(width / 2, y, 0, width / 2, y, -depth);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

export function makeGlowSprite(color = 0xffbb77, size = 2.4, opacity = 0.55) {
  const texture = makeCanvasTexture(128, 128, (ctx, w, h) => {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(0.18, "rgba(255,255,255,0.5)");
    gradient.addColorStop(0.5, "rgba(255,170,90,0.16)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  });
  const material = new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size, size, 1);
  return sprite;
}

export function createNoiseTexture(size = 256) {
  return makeCanvasTexture(size, size, (ctx, w, h) => {
    const image = ctx.createImageData(w, h);
    const random = mulberry32(8821);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = Math.floor(random() * 255);
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, {
    colorSpace: "none",
    wrap: THREE.RepeatWrapping,
    repeat: [4, 3],
    minFilter: THREE.LinearFilter,
  });
}

export function setObjectShadows(root, cast = true, receive = true) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = cast;
      child.receiveShadow = receive;
    }
  });
}

export function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        Object.values(material).forEach((value) => {
          if (value && value.isTexture) value.dispose();
        });
        material.dispose();
      });
    }
  });
}
