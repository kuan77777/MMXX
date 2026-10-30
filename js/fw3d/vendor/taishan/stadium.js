import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import {
  addBox,
  addCylinder,
  addPlane,
  addCollider,
  addPointLight,
  createNetGeometry,
  createTextTexture,
  makeCanvasTexture,
  makeGlowSprite,
  mulberry32,
  range,
} from "./utils.js";
import { buildFanAtmosphere } from "./fan-atmosphere.js";
import { createLowPolyPerson, animateLowPolyPerson } from "./lowpoly-character.js";
import { createDynamicScoreboard } from "./scoreboard.js";
import {
  createAdTexture,
  createExitSign,
  createGatePanelTexture,
  createPitchTexture,
  createStadiumBanner,
  createTrackTexture,
} from "./materials.js";

const NORTH_GOAL_Z = -52.5;
const SOUTH_GOAL_Z = 52.5;

function createSkyTexture() {
  return makeCanvasTexture(2048, 1024, (ctx, w, h) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#020309");
    gradient.addColorStop(0.36, "#050a16");
    gradient.addColorStop(0.62, "#0f1a2a");
    gradient.addColorStop(0.78, "#1b2636");
    gradient.addColorStop(0.84, "#3a2b27");
    gradient.addColorStop(0.9, "#110d0b");
    gradient.addColorStop(1, "#040303");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    // Faint city glow on the horizon.
    const glow = ctx.createRadialGradient(w * 0.56, h * 0.79, 10, w * 0.56, h * 0.79, w * 0.42);
    glow.addColorStop(0, "rgba(126,80,45,0.18)");
    glow.addColorStop(0.4, "rgba(58,49,52,0.1)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // A few distant city pin-lights.
    const random = mulberry32(702);
    for (let i = 0; i < 130; i += 1) {
      const x = random() * w;
      const y = h * 0.79 + random() * h * 0.05;
      ctx.fillStyle = random() > 0.8 ? "rgba(224,165,100,0.35)" : "rgba(194,202,210,0.2)";
      ctx.fillRect(x, y, range(random, 1, 4), 1);
    }
  }, { anisotropy: 4 });
}

function createGateDoorTexture() {
  return makeCanvasTexture(1024, 768, (ctx, w, h) => {
    ctx.fillStyle = "#24211f";
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 62) {
      ctx.fillStyle = x % 124 === 0 ? "#2c2926" : "#171615";
      ctx.fillRect(x, 0, 44, h);
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fillRect(x + 4, 0, 3, h);
    }
    ctx.fillStyle = "#8f2f1f";
    ctx.fillRect(0, 100, w, 28);
    ctx.fillRect(0, h - 128, w, 28);
    ctx.fillStyle = "rgba(221,203,172,0.55)";
    ctx.font = '600 32px "Microsoft YaHei", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("PLAYERS & OFFICIALS ONLY", w / 2, 76);
    ctx.fillText("山 东 泰 山 · 济 南 奥 体 中 心", w / 2, h - 58);
    ctx.strokeStyle = "rgba(205,192,168,0.22)";
    ctx.lineWidth = 5;
    ctx.strokeRect(22, 22, w - 44, h - 44);
  }, { anisotropy: 8 });
}

function makeSeatGeometry(number) {
  if (number === 0) {
    return new THREE.BoxGeometry(0.5, 0.1, 0.44);
  }
  return new THREE.BoxGeometry(0.5, 0.44, 0.075);
}

function getSeatColor(random) {
  const value = random();
  if (value < 0.62) return new THREE.Color(0x1d355b);
  if (value < 0.82) return new THREE.Color(0x294a76);
  if (value < 0.92) return new THREE.Color(0xa84a28);
  if (value < 0.965) return new THREE.Color(0xc9c5b8);
  return new THREE.Color(0x6d1e16);
}

function createGoal(group, z, facing, netMaterial) {
  const goal = new THREE.Group();
  goal.position.set(0, 0, z);
  if (facing > 0) goal.rotation.y = Math.PI;
  group.add(goal);

  const postMaterial = new THREE.MeshStandardMaterial({
    color: 0xd6d8d2,
    roughness: 0.45,
    metalness: 0.25,
  });
  const width = 7.32;
  const height = 2.44;
  const depth = 2.1;
  const postRadius = 0.09;

  addCylinder(goal, {
    radiusTop: postRadius,
    radiusBottom: postRadius,
    height,
    radialSegments: 12,
    position: [-width / 2, height / 2, 0],
    material: postMaterial,
    castShadow: true,
  });
  addCylinder(goal, {
    radiusTop: postRadius,
    radiusBottom: postRadius,
    height,
    radialSegments: 12,
    position: [width / 2, height / 2, 0],
    material: postMaterial,
    castShadow: true,
  });
  addCylinder(goal, {
    radiusTop: postRadius,
    radiusBottom: postRadius,
    height: width,
    radialSegments: 12,
    position: [0, height, 0],
    rotation: [0, 0, Math.PI / 2],
    material: postMaterial,
    castShadow: true,
  });
  // Rear supports.
  addCylinder(goal, {
    radiusTop: 0.055,
    radiusBottom: 0.055,
    height: height * 0.68,
    radialSegments: 8,
    position: [-width / 2, height * 0.68, -depth],
    rotation: [0.28, 0, 0],
    material: postMaterial,
  });
  addCylinder(goal, {
    radiusTop: 0.055,
    radiusBottom: 0.055,
    height: height * 0.68,
    radialSegments: 8,
    position: [width / 2, height * 0.68, -depth],
    rotation: [0.28, 0, 0],
    material: postMaterial,
  });

  const net = new THREE.LineSegments(createNetGeometry(width, height, depth, 0.35), netMaterial);
  goal.add(net);

  return goal;
}

function buildStandRowsAndSeats(group, materials) {
  const random = mulberry32(33818);
  const seatMatricesBase = [];
  const seatMatricesBack = [];
  const seatColorsBase = [];
  const seatColorsBack = [];
  const tempPosition = new THREE.Vector3();
  const tempQuaternion = new THREE.Quaternion();
  const tempScale = new THREE.Vector3(1, 1, 1);
  const tempMatrix = new THREE.Matrix4();

  const pushSeat = (x, y, z, rotationY, color, backOffsetX = 0, backOffsetZ = 0) => {
    tempPosition.set(x, y, z);
    tempQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
    tempMatrix.compose(tempPosition, tempQuaternion, tempScale);
    seatMatricesBase.push(tempMatrix.clone());
    const colorBase = color.clone().multiplyScalar(0.92);
    seatColorsBase.push(colorBase);

    tempPosition.set(x + backOffsetX, y + 0.29, z + backOffsetZ);
    tempMatrix.compose(tempPosition, tempQuaternion, tempScale);
    seatMatricesBack.push(tempMatrix.clone());
    seatColorsBack.push(color.clone().multiplyScalar(0.72));
  };

  const concrete = materials.standConcrete;

  const buildNorthSouth = (side) => {
    const lowerRows = 9;
    const upperRows = 10;
    const rowDepth = 1.38;
    const rowRise = 0.59;
    const lowerStart = 64;
    const upperStart = lowerStart + lowerRows * rowDepth + 2.15;
    const standLength = 104;
    const exposedTunnelGap = side === 1 ? 4.8 : 0;

    for (let row = 0; row < lowerRows; row += 1) {
      const topY = 0.9 + row * rowRise;
      const zCenter = side * (lowerStart + row * rowDepth + rowDepth / 2);
      if (exposedTunnelGap) {
        const halfWidth = (standLength - exposedTunnelGap) / 2;
        addBox(group, {
          size: [halfWidth, topY, rowDepth],
          position: [-(exposedTunnelGap / 2 + halfWidth / 2), topY / 2, zCenter],
          material: concrete,
          receiveShadow: true,
          castShadow: true,
        });
        addBox(group, {
          size: [halfWidth, topY, rowDepth],
          position: [exposedTunnelGap / 2 + halfWidth / 2, topY / 2, zCenter],
          material: concrete,
          receiveShadow: true,
          castShadow: true,
        });
      } else {
        addBox(group, {
          size: [standLength, topY, rowDepth],
          position: [0, topY / 2, zCenter],
          material: concrete,
          receiveShadow: true,
          castShadow: true,
        });
      }

      const seatY = topY + 0.06;
      for (let x = -standLength / 2 + 0.5; x <= standLength / 2 - 0.5; x += 0.63) {
        if (exposedTunnelGap && Math.abs(x) < 2.6) continue;
        if (Math.abs(((x + 52) / 0.63) % 26) < 1.1) continue;
        if (random() < 0.018) continue;
        const color = getSeatColor(random);
        pushSeat(x, seatY, zCenter, side === 1 ? Math.PI : 0, color, 0, side * 0.18);
      }
    }

    for (let row = 0; row < upperRows; row += 1) {
      const topY = 6.15 + row * 0.68;
      const zCenter = side * (upperStart + row * 1.52 + 0.76);
      addBox(group, {
        size: [100, topY, 1.52],
        position: [0, topY / 2, zCenter],
        material: concrete,
        receiveShadow: true,
        castShadow: true,
      });
      const seatY = topY + 0.06;
      for (let x = -50 + 0.5; x <= 50 - 0.5; x += 0.63) {
        if (Math.abs(((x + 50) / 0.63) % 28) < 1.1) continue;
        if (random() < 0.022) continue;
        const color = getSeatColor(random);
        pushSeat(x, seatY, zCenter, side === 1 ? Math.PI : 0, color, 0, side * 0.18);
      }
    }
  };

  const buildEastWest = (side) => {
    const lowerRows = 9;
    const upperRows = 10;
    const rowDepth = 1.38;
    const rowRise = 0.59;
    const lowerStart = 46;
    const upperStart = lowerStart + lowerRows * rowDepth + 2.15;
    const standLength = 78;

    for (let row = 0; row < lowerRows; row += 1) {
      const topY = 0.9 + row * rowRise;
      const xCenter = side * (lowerStart + row * rowDepth + rowDepth / 2);
      addBox(group, {
        size: [rowDepth, topY, standLength],
        position: [xCenter, topY / 2, 0],
        material: concrete,
        receiveShadow: true,
        castShadow: true,
      });
      const seatY = topY + 0.06;
      for (let z = -standLength / 2 + 0.5; z <= standLength / 2 - 0.5; z += 0.63) {
        if (Math.abs(((z + 39) / 0.63) % 24) < 1.1) continue;
        if (random() < 0.018) continue;
        const color = getSeatColor(random);
        pushSeat(xCenter, seatY, z, side === 1 ? Math.PI / 2 : -Math.PI / 2, color, side * 0.18, 0);
      }
    }

    for (let row = 0; row < upperRows; row += 1) {
      const topY = 6.15 + row * 0.68;
      const xCenter = side * (upperStart + row * 1.52 + 0.76);
      addBox(group, {
        size: [1.52, topY, 74],
        position: [xCenter, topY / 2, 0],
        material: concrete,
        receiveShadow: true,
        castShadow: true,
      });
      const seatY = topY + 0.06;
      for (let z = -37 + 0.5; z <= 37 - 0.5; z += 0.63) {
        if (Math.abs(((z + 37) / 0.63) % 26) < 1.1) continue;
        if (random() < 0.022) continue;
        const color = getSeatColor(random);
        pushSeat(xCenter, seatY, z, side === 1 ? Math.PI / 2 : -Math.PI / 2, color, side * 0.18, 0);
      }
    }
  };

  buildNorthSouth(-1);
  buildNorthSouth(1);
  buildEastWest(-1);
  buildEastWest(1);

  const seatBaseGeometry = makeSeatGeometry(0);
  const seatBackGeometry = makeSeatGeometry(1);
  const baseMesh = new THREE.InstancedMesh(seatBaseGeometry, materials.seat, seatMatricesBase.length);
  const backMesh = new THREE.InstancedMesh(seatBackGeometry, materials.seat, seatMatricesBack.length);
  baseMesh.castShadow = false;
  baseMesh.receiveShadow = true;
  backMesh.castShadow = false;
  backMesh.receiveShadow = true;

  seatMatricesBase.forEach((matrix, index) => {
    baseMesh.setMatrixAt(index, matrix);
    baseMesh.setColorAt(index, seatColorsBase[index]);
  });
  seatMatricesBack.forEach((matrix, index) => {
    backMesh.setMatrixAt(index, matrix);
    backMesh.setColorAt(index, seatColorsBack[index]);
  });
  baseMesh.instanceMatrix.needsUpdate = true;
  backMesh.instanceMatrix.needsUpdate = true;
  if (baseMesh.instanceColor) baseMesh.instanceColor.needsUpdate = true;
  if (backMesh.instanceColor) backMesh.instanceColor.needsUpdate = true;
  group.add(baseMesh, backMesh);

  return { baseMesh, backMesh };
}

function buildRoofAndFacade(group, materials) {
  const roofMaterial = materials.roof;
  const beamMaterial = materials.beam;

  const addRoof = (position, size, rotation) => {
    addBox(group, {
      size,
      position,
      rotation,
      material: roofMaterial,
      castShadow: true,
      receiveShadow: true,
    });
  };

  addRoof([0, 25.4, -88], [145, 0.7, 40], [0.105, 0, 0]);
  addRoof([0, 25.4, 88], [145, 0.7, 40], [-0.105, 0, 0]);
  addRoof([-88, 25.4, 0], [40, 0.7, 128], [0, 0, -0.105]);
  addRoof([88, 25.4, 0], [40, 0.7, 128], [0, 0, 0.105]);

  // Segmented stadium floodlight banks. Long emissive strips read as floating
  // lines against a black sky, so use discrete fixtures instead.
  const stripMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a4148,
    roughness: 0.72,
    metalness: 0.4,
  });
  const fixturePositions = [];
  for (const x of [-47, -28, -9, 9, 28, 47]) {
    fixturePositions.push([x, 23.42, -63.4, 9.5, 0.22, 0.5]);
    fixturePositions.push([x, 23.42, 63.4, 9.5, 0.22, 0.5]);
  }
  fixturePositions.forEach(([x, y, z, sx, sy, sz]) => {
    addBox(group, {
      size: [sx, sy, sz],
      position: [x, y, z],
      material: stripMaterial,
    });
  });

  // Dark structural beams under the roof.
  const trussPoints = [];
  for (let i = -4; i <= 4; i += 1) {
    const x = i * 12;
    trussPoints.push(x, 23.2, -64, x, 25.1, -92);
    trussPoints.push(x, 23.2, 64, x, 25.1, 92);
  }
  for (let i = -3; i <= 3; i += 1) {
    const z = i * 12;
    trussPoints.push(-46, 23.2, z, -84, 25.1, z);
    trussPoints.push(46, 23.2, z, 84, 25.1, z);
  }
  const trussGeometry = new THREE.BufferGeometry();
  trussGeometry.setAttribute("position", new THREE.Float32BufferAttribute(trussPoints, 3));
  const trusses = new THREE.LineSegments(
    trussGeometry,
    new THREE.LineBasicMaterial({ color: 0x3b3f43, transparent: true, opacity: 0.6 }),
  );
  group.add(trusses);

  // Inner upper facade. Without this the roof reads as floating neon lines.
  const upperFacade = new THREE.MeshStandardMaterial({
    color: 0x45403a,
    roughness: 0.92,
    metalness: 0.08,
  });
  const accentLight = new THREE.MeshBasicMaterial({ color: 0x8f3b24, toneMapped: false });
  addBox(group, { size: [178, 13.5, 1.4], position: [0, 18.4, -93.8], material: upperFacade });
  addBox(group, { size: [178, 13.5, 1.4], position: [0, 18.4, 93.8], material: upperFacade });
  addBox(group, { size: [1.4, 13.5, 172], position: [-88, 18.4, 0], material: upperFacade });
  addBox(group, { size: [1.4, 13.5, 172], position: [88, 18.4, 0], material: upperFacade });

  // Thin club-coloured uplights give the upper bowl a silhouette.
  addBox(group, { size: [112, 0.14, 0.1], position: [0, 19.9, -93.05], material: accentLight });
  addBox(group, { size: [112, 0.14, 0.1], position: [0, 19.9, 93.05], material: accentLight });
  addBox(group, { size: [0.1, 0.14, 96], position: [-87.25, 19.9, 0], material: accentLight });
  addBox(group, { size: [0.1, 0.14, 96], position: [87.25, 19.9, 0], material: accentLight });

  // Structural columns from the upper deck to the roof.
  for (let i = -6; i <= 6; i += 1) {
    const x = i * 12.5;
    addCylinder(group, {
      radiusTop: 0.16,
      radiusBottom: 0.24,
      height: 13.2,
      radialSegments: 8,
      position: [x, 19.1, -93.1],
      material: beamMaterial,
    });
    addCylinder(group, {
      radiusTop: 0.16,
      radiusBottom: 0.24,
      height: 13.2,
      radialSegments: 8,
      position: [x, 19.1, 93.1],
      material: beamMaterial,
    });
  }
  for (let i = -4; i <= 4; i += 1) {
    const z = i * 12.5;
    addCylinder(group, {
      radiusTop: 0.16,
      radiusBottom: 0.24,
      height: 13.2,
      radialSegments: 8,
      position: [-87.2, 19.1, z],
      material: beamMaterial,
    });
    addCylinder(group, {
      radiusTop: 0.16,
      radiusBottom: 0.24,
      height: 13.2,
      radialSegments: 8,
      position: [87.2, 19.1, z],
      material: beamMaterial,
    });
  }

  // Outer concrete wall ring, mostly swallowed by fog.
  const wallMaterial = materials.outerWall;
  addBox(group, { size: [190, 17, 1.5], position: [0, 10, -110], material: wallMaterial });
  addBox(group, { size: [190, 17, 1.5], position: [0, 10, 110], material: wallMaterial });
  addBox(group, { size: [1.5, 17, 218], position: [-95, 10, 0], material: wallMaterial });
  addBox(group, { size: [1.5, 17, 218], position: [95, 10, 0], material: wallMaterial });

  // Floodlight towers.
  const mastMaterial = new THREE.MeshStandardMaterial({
    color: 0x33383c,
    roughness: 0.65,
    metalness: 0.55,
  });
  const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xf2f5ff, toneMapped: false });
  const towerLocations = [
    [-72, -92],
    [72, -92],
    [-72, 92],
    [72, 92],
  ];
  towerLocations.forEach(([x, z]) => {
    addCylinder(group, {
      radiusTop: 0.35,
      radiusBottom: 0.65,
      height: 31,
      radialSegments: 10,
      position: [x, 15.5, z],
      material: mastMaterial,
      castShadow: true,
    });
    addBox(group, {
      size: [9, 3.2, 0.5],
      position: [x, 31.5, z],
      material: mastMaterial,
    });
    for (let i = -3; i <= 3; i += 1) {
      addBox(group, {
        size: [0.9, 0.65, 0.12],
        position: [x + i * 1.15, 31.5, z + (z < 0 ? -0.3 : 0.3)],
        material: lampMaterial,
      });
    }
    const glow = makeGlowSprite(0xc7dcff, 10, 0.22);
    glow.position.set(x, 31.5, z);
    group.add(glow);
  });
}

export function buildStadium({ textures, renderer }) {
  const group = new THREE.Group();
  const colliders = [];
  const interactables = [];
  const maxAnisotropy = renderer?.capabilities.getMaxAnisotropy?.() ?? 8;

  const area = {
    group,
    colliders,
    interactables,
    spawn: { position: new THREE.Vector3(0, 0, 26), yaw: 0, pitch: 0 },
    fog: new THREE.FogExp2(0x070a11, 0.0052),
    background: new THREE.Color(0x04060a),
    exposure: 0.78,
    bloom: 0.22,
    update: () => {},
  };

  // -----------------------------------------------------------------------
  // Sky, haze and the pitch
  // -----------------------------------------------------------------------
  const skyTexture = createSkyTexture();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(290, 48, 28),
    new THREE.MeshBasicMaterial({
      map: skyTexture,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
  sky.rotation.y = Math.PI * 0.1;
  group.add(sky);

  const starPositions = [];
  const random = mulberry32(5109);
  for (let i = 0; i < 950; i += 1) {
    const azimuth = random() * Math.PI * 2;
    const elevation = range(random, 0.12, 1.25);
    const radius = 270;
    starPositions.push(
      Math.cos(azimuth) * Math.cos(elevation) * radius,
      Math.sin(elevation) * radius,
      Math.sin(azimuth) * Math.cos(elevation) * radius,
    );
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
      color: 0xb9c7d6,
      size: 0.55,
      transparent: true,
      opacity: 0.38,
      sizeAttenuation: true,
      fog: false,
      depthWrite: false,
    }),
  );
  group.add(stars);

  const trackTexture = createTrackTexture(renderer);
  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(140, 112),
    new THREE.MeshStandardMaterial({
      map: trackTexture,
      roughness: 0.9,
      metalness: 0.02,
    }),
  );
  track.rotation.x = -Math.PI / 2;
  track.position.y = -0.02;
  track.receiveShadow = true;
  group.add(track);

  const pitchTexture = createPitchTexture(renderer);
  pitchTexture.anisotropy = maxAnisotropy;
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(68, 105),
    new THREE.MeshStandardMaterial({
      map: pitchTexture,
      roughness: 0.91,
      metalness: 0,
    }),
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.y = 0.01;
  pitch.receiveShadow = true;
  group.add(pitch);

  // Thin white touchline curb around the pitch, for legibility from afar.
  const pitchEdgeMaterial = new THREE.MeshStandardMaterial({
    color: 0xdad7c8,
    roughness: 0.75,
  });
  addBox(group, {
    size: [68.4, 0.06, 0.16],
    position: [0, 0.035, -52.55],
    material: pitchEdgeMaterial,
  });
  addBox(group, {
    size: [68.4, 0.06, 0.16],
    position: [0, 0.035, 52.55],
    material: pitchEdgeMaterial,
  });

  // -----------------------------------------------------------------------
  // Materials
  // -----------------------------------------------------------------------
  // The stand texture is intentionally its own small, grungy concrete map.
  const standConcreteTexture = makeCanvasTexture(512, 512, (ctx, w, h) => {
    const rng = mulberry32(1337);
    ctx.fillStyle = "#55514b";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 4500; i += 1) {
      const a = range(rng, 0.01, 0.09);
      ctx.fillStyle = rng() > 0.5 ? `rgba(235,230,220,${a})` : `rgba(0,0,0,${a})`;
      ctx.fillRect(rng() * w, rng() * h, range(rng, 0.5, 2.2), range(rng, 0.5, 2.2));
    }
    ctx.strokeStyle = "rgba(15,12,10,0.25)";
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 9; i += 1) {
      ctx.beginPath();
      let x = rng() * w;
      let y = rng() * h;
      ctx.moveTo(x, y);
      for (let j = 0; j < 5; j += 1) {
        x += range(rng, -48, 48);
        y += range(rng, 5, 32);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, { repeat: [6, 3], wrap: THREE.RepeatWrapping, anisotropy: maxAnisotropy });

  const materials = {
    standConcrete: new THREE.MeshStandardMaterial({
      map: standConcreteTexture,
      color: 0x887f75,
      roughness: 0.94,
      metalness: 0.02,
    }),
    seat: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.02,
    }),
    roof: new THREE.MeshStandardMaterial({
      color: 0x353a40,
      roughness: 0.76,
      metalness: 0.42,
    }),
    beam: new THREE.MeshStandardMaterial({
      color: 0x393d41,
      roughness: 0.63,
      metalness: 0.6,
    }),
    outerWall: new THREE.MeshStandardMaterial({
      color: 0x242526,
      roughness: 0.9,
      metalness: 0.12,
    }),
  };

  buildStandRowsAndSeats(group, materials);
  buildRoofAndFacade(group, materials);

  // -----------------------------------------------------------------------
  // Perimeter advertising boards and banners
  // -----------------------------------------------------------------------
  const adTextures = [
    // Original stand lettering cropped from the supplied photograph; the
    // remaining boards stay procedural to avoid a wall of identical photos.
    textures.bannerLegacy,
    createAdTexture("山东T山", "HOME · JINAN OLYMPIC SPORTS CENTER", 1),
    createAdTexture("共同战斗", "FIGHTING TOGETHER · 北看台青年", 2),
  ];
  const adMaterials = adTextures.map((texture) => new THREE.MeshStandardMaterial({
    map: texture,
    emissive: 0x2a1209,
    emissiveMap: texture,
    emissiveIntensity: 0.22,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  }));

  const addAdBoard = (x, z, rotationY, index) => {
    addBox(group, {
      size: [6.8, 1.0, 0.12],
      position: [x, 0.63, z],
      rotation: [0, rotationY, 0],
      material: adMaterials[index % adMaterials.length],
    });
  };

  for (let i = -6; i <= 6; i += 1) {
    if (i === 0) {
      // South centre is the tunnel mouth.
      continue;
    }
    addAdBoard(i * 7.6, 63.7, 0, i + 6);
    addAdBoard(i * 7.6, -63.7, Math.PI, i + 7);
  }
  for (let i = -4; i <= 4; i += 1) {
    addAdBoard(45.7, i * 8.4, -Math.PI / 2, i + 4);
    addAdBoard(-45.7, i * 8.4, Math.PI / 2, i + 5);
  }

  // Large banners draped on the stands. The south banner uses the original
  // 30th-anniversary strip from the supplied stand photograph; the other
  // banners remain acrylic/fan-made so the photograph does not repeat.
  const bannerNorth = createStadiumBanner("荣耀与传承", "1993 — 2023 · HOME · 山东T山足球俱乐部");
  const bannerEast = createStadiumBanner("我们是T山", "WE ARE MOUNTAIN TAI");
  const bannerMaterial = (texture) => new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    roughness: 0.86,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  addPlane(group, {
    size: [28, 3.5],
    position: [0, 8.3, -76.2],
    rotation: [0, 0, 0],
    material: bannerMaterial(bannerNorth),
  });
  addBox(group, {
    size: [30.4, 1.93, 0.12],
    position: [0, 9.6, 76.19],
    material: new THREE.MeshStandardMaterial({
      color: 0x1b1410,
      roughness: 0.8,
      metalness: 0.08,
    }),
  });
  addPlane(group, {
    size: [30, 1.714],
    position: [0, 9.6, 76.11],
    rotation: [0, Math.PI, 0],
    material: new THREE.MeshStandardMaterial({
      map: textures.bannerAnniversary,
      emissive: 0x1c0905,
      emissiveMap: textures.bannerAnniversary,
      emissiveIntensity: 0.36,
      roughness: 0.78,
      metalness: 0.02,
    }),
  });
  addPlane(group, {
    size: [23, 3.0],
    position: [-79, 8.0, 0],
    rotation: [0, Math.PI / 2, 0],
    material: bannerMaterial(bannerEast),
  });
  addPlane(group, {
    size: [23, 3.0],
    position: [79, 8.0, 0],
    rotation: [0, -Math.PI / 2, 0],
    material: bannerMaterial(bannerNorth),
  });

  // Supplied match-day reference: dense orange/black/white rail banners,
  // layered small banners and flags on all four lower stands.
  buildFanAtmosphere(group);

  // -----------------------------------------------------------------------
  // Goals
  // -----------------------------------------------------------------------
  const netMaterial = new THREE.LineBasicMaterial({
    color: 0xc6cdd1,
    transparent: true,
    opacity: 0.3,
  });
  createGoal(group, NORTH_GOAL_Z, -1, netMaterial);
  createGoal(group, SOUTH_GOAL_Z, 1, netMaterial);

  // Corner flags.
  const flagPoleMaterial = new THREE.MeshStandardMaterial({
    color: 0xd7d5c8,
    roughness: 0.6,
    metalness: 0.1,
  });
  const flagMaterials = [
    new THREE.MeshStandardMaterial({ color: 0xb63a22, roughness: 0.8, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0xe0c99c, roughness: 0.8, side: THREE.DoubleSide }),
  ];
  [
    [-33.9, -52.4],
    [33.9, -52.4],
    [-33.9, 52.4],
    [33.9, 52.4],
  ].forEach(([x, z], index) => {
    addCylinder(group, {
      radiusTop: 0.025,
      radiusBottom: 0.025,
      height: 1.55,
      radialSegments: 6,
      position: [x, 0.78, z],
      material: flagPoleMaterial,
    });
    addBox(group, {
      size: [0.46, 0.3, 0.015],
      position: [x + 0.22, 1.4, z],
      rotation: [0, index * 0.35, 0.1],
      material: flagMaterials[index % 2],
    });
  });

  const goalRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xda3f24,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const goalMarker = new THREE.Mesh(new THREE.PlaneGeometry(7.1, 2.3), goalRingMaterial);
  goalMarker.position.set(0, 1.2, NORTH_GOAL_Z - 0.02);
  goalMarker.visible = false;
  group.add(goalMarker);

  const goalLight = new THREE.PointLight(0xff4b29, 0, 15, 2);
  goalLight.position.set(0, 2.2, NORTH_GOAL_Z + 1.5);
  group.add(goalLight);

  const escapePortalMaterial = new THREE.MeshBasicMaterial({
    color: 0xc3d7d9,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const escapePortal = new THREE.Mesh(new THREE.PlaneGeometry(6.9, 2.3), escapePortalMaterial);
  escapePortal.position.set(0, 1.18, NORTH_GOAL_Z - 1.25);
  escapePortal.visible = false;
  group.add(escapePortal);
  const escapeGlow = makeGlowSprite(0xc8dedb, 9.5, 0);
  escapeGlow.position.set(0, 1.4, NORTH_GOAL_Z - 0.7);
  group.add(escapeGlow);
  const escapeLight = new THREE.PointLight(0xbfd7d5, 0, 18, 1.8);
  escapeLight.position.set(0, 1.6, NORTH_GOAL_Z + 0.4);
  group.add(escapeLight);

  // -----------------------------------------------------------------------
  // South tunnel: a real recess under the lower stand
  // -----------------------------------------------------------------------
  const portal = new THREE.Group();
  group.add(portal);

  const portalConcrete = new THREE.MeshStandardMaterial({
    color: 0x34302b,
    roughness: 0.95,
  });
  const portalOrange = new THREE.MeshStandardMaterial({
    color: 0x8c2d1c,
    roughness: 0.58,
    metalness: 0.12,
  });

  // Floor and walls continuing into the stand.
  const tunnelFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(4.8, 14),
    new THREE.MeshStandardMaterial({ color: 0x2a211c, roughness: 0.63, metalness: 0.12 }),
  );
  tunnelFloor.rotation.x = -Math.PI / 2;
  tunnelFloor.position.set(0, 0.02, 70.6);
  tunnelFloor.receiveShadow = true;
  portal.add(tunnelFloor);

  addBox(portal, { size: [0.2, 3.4, 14], position: [-2.5, 1.7, 70.6], material: portalOrange });
  addBox(portal, { size: [0.2, 3.4, 14], position: [2.5, 1.7, 70.6], material: portalOrange });
  addBox(portal, { size: [5.2, 0.22, 14], position: [0, 3.5, 70.6], material: portalConcrete });
  addBox(portal, { size: [5.2, 3.4, 0.22], position: [0, 1.7, 77.6], material: portalConcrete });

  const portalFrame = new THREE.MeshStandardMaterial({
    color: 0x5b1c12,
    roughness: 0.5,
    metalness: 0.2,
  });
  addBox(portal, { size: [0.45, 3.8, 0.45], position: [-2.55, 1.9, 64.15], material: portalFrame });
  addBox(portal, { size: [0.45, 3.8, 0.45], position: [2.55, 1.9, 64.15], material: portalFrame });
  addBox(portal, { size: [5.55, 0.45, 0.45], position: [0, 3.82, 64.15], material: portalFrame });
  const frameGlowMaterial = new THREE.MeshBasicMaterial({ color: 0xc66032, toneMapped: false });
  addBox(portal, {
    size: [0.08, 3.45, 0.08],
    position: [-2.32, 1.77, 63.88],
    material: frameGlowMaterial,
  });
  addBox(portal, {
    size: [0.08, 3.45, 0.08],
    position: [2.32, 1.77, 63.88],
    material: frameGlowMaterial,
  });
  addBox(portal, {
    size: [4.7, 0.08, 0.08],
    position: [0, 3.48, 63.88],
    material: frameGlowMaterial,
  });
  const portalSpill = new THREE.PointLight(0xff7a3c, 26, 21, 1.8);
  portalSpill.position.set(0, 3.7, 62.8);
  group.add(portalSpill);
  const portalGlowSprite = makeGlowSprite(0xff8346, 7.2, 0.32);
  portalGlowSprite.position.set(0, 3.15, 62.6);
  group.add(portalGlowSprite);

  const tunnelSignTexture = createTextTexture("球员通道", {
    width: 1024,
    height: 256,
    background: "#160704",
    color: "#f1e6d0",
    accent: "#d45d2d",
    fontSize: 96,
    subtext: "PLAYERS TUNNEL · 仅限球员与工作人员",
    subFontSize: 24,
  });
  const tunnelSign = addPlane(portal, {
    size: [3.7, 0.92],
    position: [0, 4.4, 63.98],
    rotation: [0, Math.PI, 0],
    material: new THREE.MeshBasicMaterial({ map: tunnelSignTexture, toneMapped: false }),
  });

  // Gate itself.
  const gateTexture = createGateDoorTexture();
  const gateMaterial = new THREE.MeshStandardMaterial({
    map: gateTexture,
    roughness: 0.58,
    metalness: 0.36,
    emissive: 0x130603,
    emissiveIntensity: 0.3,
  });
  const gate = new THREE.Group();
  gate.position.set(0, 0, 64.5);
  portal.add(gate);
  addBox(gate, {
    size: [4.55, 3.15, 0.16],
    position: [0, 1.58, 0],
    material: gateMaterial,
  });
  const gateCollider = addCollider(colliders, -2.3, 2.3, 64.3, 64.75, {
    name: "tunnelGate",
    maxY: 3.3,
  });

  // Interior orange strip lights.
  const tunnelLightMaterial = new THREE.MeshBasicMaterial({ color: 0xffb16f, toneMapped: false });
  addBox(portal, {
    size: [3.0, 0.06, 0.2],
    position: [0, 3.38, 68.2],
    material: tunnelLightMaterial,
  });
  addBox(portal, {
    size: [3.0, 0.06, 0.2],
    position: [0, 3.38, 74.0],
    material: tunnelLightMaterial,
  });
  const portalLight = addPointLight(portal, 0xff8d4a, 10, 8, [0, 3.1, 69.5]);
  const portalLight2 = addPointLight(portal, 0xff8d4a, 6, 6, [0, 3.1, 75.0]);

  // Maintenance panel and note.
  const panelTexture = createGatePanelTexture();
  const panel = addPlane(portal, {
    size: [0.86, 0.86],
    position: [3.12, 1.35, 63.75],
    rotation: [0, Math.PI - 0.15, 0],
    material: new THREE.MeshStandardMaterial({
      map: panelTexture,
      roughness: 0.5,
      metalness: 0.3,
      emissive: 0x1a0a06,
      emissiveMap: panelTexture,
      emissiveIntensity: 0.4,
    }),
  });

  const greenIndicatorMaterial = new THREE.MeshBasicMaterial({
    color: 0x5d2618,
    toneMapped: false,
  });
  const greenIndicator = new THREE.Mesh(
    new THREE.CircleGeometry(0.09, 18),
    greenIndicatorMaterial,
  );
  greenIndicator.position.set(3.47, 1.64, 63.75);
  greenIndicator.rotation.y = Math.PI - 0.15;
  portal.add(greenIndicator);

  // Original HOME sign crop from the supplied stand photograph, mounted on
  // the concourse wall beside the players' tunnel.
  addBox(portal, {
    size: [2.52, 0.94, 0.08],
    position: [-3.92, 2.35, 63.82],
    material: new THREE.MeshStandardMaterial({
      color: 0x1b1511,
      roughness: 0.72,
      metalness: 0.16,
    }),
  });
  addPlane(portal, {
    size: [2.4, 0.823],
    position: [-3.92, 2.35, 63.76],
    rotation: [0, Math.PI, 0],
    material: new THREE.MeshStandardMaterial({
      map: textures.bannerHome,
      emissive: 0x24120a,
      emissiveMap: textures.bannerHome,
      emissiveIntensity: 0.45,
      roughness: 0.55,
      metalness: 0.04,
    }),
  });

  const noteGroup = new THREE.Group();
  noteGroup.position.set(-4.15, 0, 62.55);
  group.add(noteGroup);
  addBox(noteGroup, {
    size: [1.7, 0.06, 0.75],
    position: [0, 0.76, 0],
    rotation: [-0.3, 0, 0],
    material: new THREE.MeshStandardMaterial({ color: 0x9b8d74, roughness: 0.85 }),
  });
  addBox(noteGroup, {
    size: [0.06, 0.78, 0.06],
    position: [-0.65, 0.38, 0.18],
    material: new THREE.MeshStandardMaterial({ color: 0x37312b, roughness: 0.8 }),
  });
  addBox(noteGroup, {
    size: [0.06, 0.78, 0.06],
    position: [0.65, 0.38, 0.18],
    material: new THREE.MeshStandardMaterial({ color: 0x37312b, roughness: 0.8 }),
  });
  const notePaper = addPlane(noteGroup, {
    size: [0.9, 0.55],
    position: [0, 0.78, 0.02],
    rotation: [-Math.PI / 2 + 0.3, 0, 0.12],
    material: new THREE.MeshBasicMaterial({
      color: 0xe4dac4,
      side: THREE.DoubleSide,
    }),
  });

  // Narrative scarf on a bench.
  const benchGroup = new THREE.Group();
  benchGroup.position.set(-8.5, 0, 44);
  group.add(benchGroup);
  const benchMaterial = new THREE.MeshStandardMaterial({ color: 0x31251c, roughness: 0.78 });
  addBox(benchGroup, { size: [2.4, 0.12, 0.52], position: [0, 0.56, 0], material: benchMaterial });
  addBox(benchGroup, { size: [0.12, 0.55, 0.48], position: [-1, 0.28, 0], material: benchMaterial });
  addBox(benchGroup, { size: [0.12, 0.55, 0.48], position: [1, 0.28, 0], material: benchMaterial });
  const scarfMaterial = new THREE.MeshStandardMaterial({
    color: 0x31533b,
    roughness: 0.8,
    emissive: 0x0b190f,
    emissiveIntensity: 0.2,
  });
  addBox(benchGroup, {
    size: [0.95, 0.035, 0.26],
    position: [0.1, 0.64, 0.03],
    rotation: [0, 0.2, 0],
    material: scarfMaterial,
  });
  addBox(benchGroup, {
    size: [0.16, 0.035, 0.5],
    position: [0.53, 0.64, 0.2],
    rotation: [0, 0.2, 0],
    material: scarfMaterial,
  });

  // Dynamic 3D LED scoreboard. The housing and mounting are separate from
  // the programmatically drawn screen texture.
  const scoreboard = createDynamicScoreboard({ textures, parent: group });

  // -----------------------------------------------------------------------
  // Specter (extremely restrained; only used in the final return)
  // -----------------------------------------------------------------------
  const specter = new THREE.Group();
  specter.position.set(1.15, 0, -54.3);
  specter.visible = false;
  group.add(specter);
  const specterMaterial = new THREE.MeshBasicMaterial({
    color: 0x050607,
    transparent: true,
    opacity: 0.74,
    depthWrite: false,
    fog: true,
  });
  addBox(specter, { size: [0.46, 0.82, 0.25], position: [0, 1.22, 0], material: specterMaterial });
  addBox(specter, { size: [0.15, 0.72, 0.16], position: [-0.14, 0.45, 0], material: specterMaterial });
  addBox(specter, { size: [0.15, 0.72, 0.16], position: [0.14, 0.45, 0], material: specterMaterial });
  const specterHead = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), specterMaterial);
  specterHead.position.set(0, 1.76, 0);
  specter.add(specterHead);

  // -----------------------------------------------------------------------
  // Lighting
  // -----------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0x60799b, 0x24130c, 0.92);
  group.add(hemi);
  const stadiumFill = new THREE.AmbientLight(0x3a302a, 0.22);
  group.add(stadiumFill);

  // Broad, shadowless washes make the empty seating decks legible without
  // flattening the pitch with more spotlighting.
  RectAreaLightUniformsLib.init();
  const standWashes = [];
  [
    { position: [0, 11, -39], target: [0, 10, -76], width: 78, height: 10 },
    { position: [0, 11, 39], target: [0, 10, 76], width: 78, height: 10 },
    { position: [-37, 11, 0], target: [-76, 10, 0], width: 72, height: 10 },
    { position: [37, 11, 0], target: [76, 10, 0], width: 72, height: 10 },
  ].forEach(({ position, target, width, height }) => {
    const wash = new THREE.RectAreaLight(0x9fb6d3, 3.2, width, height);
    wash.position.set(...position);
    wash.lookAt(new THREE.Vector3(...target));
    group.add(wash);
    standWashes.push(wash);
  });

  const moon = new THREE.DirectionalLight(0x9bb8dd, 1.05);
  moon.position.set(45, 74, 38);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.near = 1;
  moon.shadow.camera.far = 220;
  moon.shadow.camera.left = -100;
  moon.shadow.camera.right = 100;
  moon.shadow.camera.top = 100;
  moon.shadow.camera.bottom = -100;
  moon.shadow.bias = -0.00045;
  group.add(moon);

  const floodA = new THREE.SpotLight(0xdce9ff, 430, 180, 0.65, 0.72, 1.25);
  floodA.position.set(-53, 42, -42);
  floodA.target.position.set(0, 0, 4);
  group.add(floodA, floodA.target);

  const floodB = new THREE.SpotLight(0xdce9ff, 380, 180, 0.68, 0.72, 1.25);
  floodB.position.set(52, 43, 46);
  floodB.target.position.set(0, 0, -5);
  group.add(floodB, floodB.target);

  const ambientWarm = new THREE.PointLight(0xff5b2d, 3.4, 45, 2);
  ambientWarm.position.set(0, 6, -58.5);
  group.add(ambientWarm);

  // Emergency lights: red, very low, visible in blackout.
  const emergencyLights = [];
  [
    [-25, 2.4, 60],
    [25, 2.4, 60],
    [-25, 2.4, -60],
    [25, 2.4, -60],
  ].forEach(([x, y, z]) => {
    const light = new THREE.PointLight(0x9e1d11, 0.9, 16, 2);
    light.position.set(x, y, z);
    group.add(light);
    emergencyLights.push(light);
  });

  // Dust motes in the floodlights.
  const dustCount = 900;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    dustPositions[i * 3] = range(random, -55, 55);
    dustPositions[i * 3 + 1] = range(random, 0.3, 24);
    dustPositions[i * 3 + 2] = range(random, -65, 65);
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      color: 0xd9c6a7,
      size: 0.06,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  );
  group.add(dust);

  // -----------------------------------------------------------------------
  // LEAGUE fourth-official stoppage board (final-act interaction)
  // -----------------------------------------------------------------------
  const stoppageBoard = new THREE.Group();
  stoppageBoard.position.set(16, 0, 44);
  stoppageBoard.rotation.y = -0.16;
  stoppageBoard.visible = false;
  group.add(stoppageBoard);

  const stoppageFrameMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d1712,
    roughness: 0.46,
    metalness: 0.52,
  });
  addBox(stoppageBoard, {
    size: [1.18, 0.08, 0.44],
    position: [0, 1.56, 0],
    material: stoppageFrameMaterial,
  });
  addBox(stoppageBoard, {
    size: [0.08, 1.5, 0.08],
    position: [-0.46, 0.78, 0],
    material: stoppageFrameMaterial,
  });
  addBox(stoppageBoard, {
    size: [0.08, 1.5, 0.08],
    position: [0.46, 0.78, 0],
    material: stoppageFrameMaterial,
  });
  addBox(stoppageBoard, {
    size: [1.25, 0.72, 0.06],
    position: [0, 1.65, -0.02],
    material: new THREE.MeshStandardMaterial({ color: 0x0b0907, roughness: 0.5 }),
  });

  let stoppageValue = 1;
  let stoppageActive = false;
  let stoppageTextureUserDraw = null;
  const stoppageTexture = makeCanvasTexture(512, 320, (ctx, w, h) => {
    const draw = (value, solved = false) => {
      ctx.fillStyle = "#080605";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = solved ? "#82d99b" : "#a53b26";
      ctx.lineWidth = 8;
      ctx.strokeRect(12, 12, w - 24, h - 24);
      ctx.fillStyle = solved ? "#82d99b" : "#e06a43";
      ctx.font = '700 172px "Arial Black", "Microsoft YaHei", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`+${value}`, w / 2, h * 0.48);
      ctx.fillStyle = "rgba(235,225,205,0.7)";
      ctx.font = '400 28px "Microsoft YaHei", sans-serif';
      ctx.fillText(solved ? "补时确认 · 90+6" : "第四官员 · 补时牌", w / 2, h * 0.83);
    };
    draw(1, false);
    stoppageTextureUserDraw = draw;
  });
  const stoppageScreen = addPlane(stoppageBoard, {
    size: [1.12, 0.62],
    position: [0, 1.65, 0.015],
    material: new THREE.MeshBasicMaterial({ map: stoppageTexture, toneMapped: false }),
  });
  const stoppageLight = new THREE.PointLight(0xd34a2b, 0, 7, 2);
  stoppageLight.position.set(0, 2.3, 0.2);
  stoppageBoard.add(stoppageLight);
  const redCardGroup = new THREE.Group();
  redCardGroup.position.set(0.36, 1.35, 0.07);
  redCardGroup.visible = false;
  stoppageBoard.add(redCardGroup);
  const redCardMaterial = new THREE.MeshBasicMaterial({ color: 0xb3261c, toneMapped: false, side: THREE.DoubleSide });
  addBox(redCardGroup, {
    size: [0.2, 0.3, 0.012],
    position: [0, 0, 0],
    material: redCardMaterial,
  });
  addBox(redCardGroup, {
    size: [0.16, 0.025, 0.018],
    position: [0, 0.2, 0.015],
    material: new THREE.MeshBasicMaterial({ color: 0x2a0a08, toneMapped: false }),
  });
  let redCardActive = false;
  const showRedCard = () => {
    redCardActive = true;
    redCardGroup.visible = true;
    stoppageLight.color.setHex(0xe04b38);
  };
  const hideRedCard = () => {
    redCardActive = false;
    redCardGroup.visible = false;
  };

  const setStoppageActive = (active) => {
    stoppageActive = Boolean(active);
    stoppageBoard.visible = stoppageActive;
    stoppageLight.intensity = stoppageActive ? 4.5 : 0;
    if (stoppageTextureUserDraw) stoppageTextureUserDraw(stoppageValue, false);
    stoppageTexture.needsUpdate = true;
  };
  const setStoppageValue = (value, solved = false) => {
    stoppageValue = Math.max(1, Math.min(9, value));
    if (stoppageTextureUserDraw) stoppageTextureUserDraw(stoppageValue, solved);
    stoppageTexture.needsUpdate = true;
    stoppageLight.color.setHex(solved ? 0x69c88a : 0xd34a2b);
  };

  // -----------------------------------------------------------------------
  // LEAGUE "12th man" memorial seat on the north stand
  // -----------------------------------------------------------------------
  const twelfthManGroup = new THREE.Group();
  twelfthManGroup.position.set(-14, 0, -63.62);
  group.add(twelfthManGroup);
  addBox(twelfthManGroup, {
    size: [1.7, 0.86, 0.08],
    position: [0, 1.45, 0],
    material: new THREE.MeshStandardMaterial({
      color: 0x15100c,
      roughness: 0.68,
      metalness: 0.24,
    }),
  });
  const twelfthManTexture = createTextTexture("第12人", {
    width: 1024,
    height: 512,
    background: "#0a0c09",
    color: "#e5d9c1",
    accent: "#32765a",
    fontSize: 104,
    subtext: "NORTH STAND · 12 · 6排0号",
    subFontSize: 28,
  });
  addPlane(twelfthManGroup, {
    size: [1.54, 0.72],
    position: [0, 1.45, 0.05],
    material: new THREE.MeshBasicMaterial({ map: twelfthManTexture, toneMapped: false }),
  });
  addBox(twelfthManGroup, {
    size: [1.3, 0.08, 0.34],
    position: [0, 0.92, 0.18],
    material: new THREE.MeshStandardMaterial({ color: 0x24352b, roughness: 0.92 }),
  });
  addBox(twelfthManGroup, {
    size: [0.24, 0.5, 0.06],
    position: [-0.48, 0.72, 0.2],
    material: new THREE.MeshStandardMaterial({
      color: 0x3d7c5d,
      emissive: 0x0e2418,
      emissiveIntensity: 0.5,
      roughness: 0.86,
    }),
  });
  const twelfthManLight = new THREE.PointLight(0x4e9f72, 2.2, 5.2, 2);
  twelfthManLight.position.set(0, 1.7, 0.8);
  twelfthManGroup.add(twelfthManLight);

  // -----------------------------------------------------------------------
  // Seat 6 row 0, the empty away seat from Wang Gang's family ticket
  // -----------------------------------------------------------------------
  const seatSixZero = new THREE.Group();
  seatSixZero.position.set(-6, 0, 63.35);
  seatSixZero.rotation.y = Math.PI;
  group.add(seatSixZero);
  const seatZeroMaterial = new THREE.MeshStandardMaterial({
    color: 0x214b35,
    roughness: 0.68,
    metalness: 0.16,
    emissive: 0x0a1d13,
    emissiveIntensity: 0.24,
  });
  addBox(seatSixZero, {
    size: [0.56, 0.08, 0.5],
    position: [0, 0.46, 0],
    material: seatZeroMaterial,
  });
  addBox(seatSixZero, {
    size: [0.56, 0.58, 0.06],
    position: [0, 0.76, -0.24],
    material: seatZeroMaterial,
  });
  addBox(seatSixZero, {
    size: [0.06, 0.45, 0.06],
    position: [-0.23, 0.23, 0.16],
    material: benchMaterial,
  });
  addBox(seatSixZero, {
    size: [0.06, 0.45, 0.06],
    position: [0.23, 0.23, 0.16],
    material: benchMaterial,
  });
  const seatZeroTicketTexture = createTextTexture("6排0号", {
    width: 1024,
    height: 512,
    background: "#e6ddc7",
    color: "#1a2a20",
    accent: "#3e7c58",
    fontSize: 84,
    subtext: "客队看台 · 未离场",
    subFontSize: 26,
  });
  const seatZeroTicket = addPlane(seatSixZero, {
    size: [0.34, 0.2],
    position: [0, 0.51, 0.04],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: seatZeroTicketTexture, toneMapped: false }),
  });
  const seatZeroLight = new THREE.PointLight(0x4a9a68, 2.4, 5.5, 2);
  seatZeroLight.position.set(0, 1.45, 0.55);
  seatSixZero.add(seatZeroLight);
  addPlane(seatSixZero, {
    size: [0.62, 0.16],
    position: [0, 0.34, 0.26],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ color: 0x9b3d28, toneMapped: false }),
  });

  // -----------------------------------------------------------------------
  // North-stand capo megaphone, beside the 12th-man memorial
  // -----------------------------------------------------------------------
  const capoMegaphone = new THREE.Group();
  capoMegaphone.position.set(-12.2, 0, -63.35);
  group.add(capoMegaphone);
  addBox(capoMegaphone, {
    size: [0.45, 0.06, 0.45],
    position: [0, 0.03, 0],
    material: benchMaterial,
  });
  addBox(capoMegaphone, {
    size: [0.05, 1.0, 0.05],
    position: [0, 0.52, 0],
    material: benchMaterial,
  });
  addCylinder(capoMegaphone, {
    radiusTop: 0.08,
    radiusBottom: 0.28,
    height: 0.56,
    radialSegments: 18,
    position: [0, 1.05, 0],
    rotation: [0, 0, Math.PI / 2],
    material: new THREE.MeshStandardMaterial({
      color: 0xcfc7ae,
      roughness: 0.72,
      metalness: 0.18,
    }),
  });
  addBox(capoMegaphone, {
    size: [0.12, 0.12, 0.12],
    position: [-0.32, 1.05, 0],
    material: new THREE.MeshStandardMaterial({ color: 0x29241d, roughness: 0.88 }),
  });
  const capoLight = new THREE.PointLight(0xd6b68b, 1.4, 3.5, 2);
  capoLight.position.set(0, 1.5, 0.3);
  capoMegaphone.add(capoLight);

  // -----------------------------------------------------------------------
  // "Refund Brother" away-fan ghost, a LEAGUE terrace meme made physical
  // -----------------------------------------------------------------------
  const refundFan = new THREE.Group();
  refundFan.position.set(-10, 0, 61.7);
  refundFan.rotation.y = Math.PI;
  refundFan.visible = false;
  group.add(refundFan);
  const jacketMaterial = new THREE.MeshStandardMaterial({
    color: 0x245c3d,
    roughness: 0.86,
    metalness: 0.02,
  });
  const trouserMaterial = new THREE.MeshStandardMaterial({ color: 0x151717, roughness: 0.9 });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0x9b7458, roughness: 0.82 });
  addBox(refundFan, { size: [0.22, 0.78, 0.24], position: [-0.14, 0.39, 0], material: trouserMaterial });
  addBox(refundFan, { size: [0.22, 0.78, 0.24], position: [0.14, 0.39, 0], material: trouserMaterial });
  addBox(refundFan, { size: [0.64, 0.76, 0.36], position: [0, 1.12, 0], material: jacketMaterial });
  addBox(refundFan, { size: [0.18, 0.58, 0.2], position: [-0.4, 1.12, 0], material: jacketMaterial });
  addBox(refundFan, { size: [0.18, 0.58, 0.2], position: [0.4, 1.12, 0], material: jacketMaterial });
  addBox(refundFan, { size: [0.3, 0.32, 0.28], position: [0, 1.75, 0], material: skinMaterial });
  addBox(refundFan, { size: [0.34, 0.1, 0.32], position: [0, 1.96, 0], material: new THREE.MeshStandardMaterial({ color: 0x0d0e0d, roughness: 0.9 }) });
  addBox(refundFan, { size: [0.08, 0.08, 0.02], position: [-0.07, 1.78, 0.145], material: new THREE.MeshBasicMaterial({ color: 0x17110d }) });
  addBox(refundFan, { size: [0.08, 0.08, 0.02], position: [0.07, 1.78, 0.145], material: new THREE.MeshBasicMaterial({ color: 0x17110d }) });
  addBox(refundFan, { size: [0.45, 0.3, 0.45], position: [0, 0.14, 0], material: new THREE.MeshStandardMaterial({ color: 0x2b1c13, roughness: 0.92 }) });
  addCylinder(refundFan, {
    radiusTop: 0.11,
    radiusBottom: 0.26,
    height: 0.42,
    radialSegments: 16,
    position: [0.58, 1.3, 0.1],
    rotation: [Math.PI / 2, 0, -0.18],
    material: new THREE.MeshStandardMaterial({ color: 0xd2c6ad, roughness: 0.7, metalness: 0.12 }),
  });
  const refundSignTexture = createTextTexture("退钱球迷", {
    width: 1024,
    height: 256,
    background: "#0a0d0a",
    color: "#e6dcc4",
    accent: "#5c9a6c",
    fontSize: 78,
    subtext: "AWAY END · 客队看台",
    subFontSize: 23,
  });
  addPlane(refundFan, {
    size: [1.15, 0.3],
    position: [0, 0.2, 0.5],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: refundSignTexture, toneMapped: false }),
  });
  const refundLight = new THREE.PointLight(0x69a77a, 1.2, 4.0, 2);
  refundLight.position.set(0, 2.2, 0.4);
  refundFan.add(refundLight);

  // -----------------------------------------------------------------------
  // Ghost goalkeeper "大L" at the north goal, a home end memory
  // -----------------------------------------------------------------------
  const goalkeeper = new THREE.Group();
  goalkeeper.position.set(0, 0, NORTH_GOAL_Z + 1.2);
  goalkeeper.visible = false;
  group.add(goalkeeper);
  const keeperOrange = new THREE.MeshStandardMaterial({
    color: 0xd76426,
    roughness: 0.7,
    metalness: 0.02,
    emissive: 0x3b1307,
    emissiveIntensity: 0.18,
  });
  const keeperBlack = new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.86 });
  const keeperSkin = new THREE.MeshStandardMaterial({ color: 0xb58a6b, roughness: 0.8 });
  addBox(goalkeeper, { size: [0.24, 0.82, 0.26], position: [-0.16, 0.41, 0], material: keeperBlack });
  addBox(goalkeeper, { size: [0.24, 0.82, 0.26], position: [0.16, 0.41, 0], material: keeperBlack });
  addBox(goalkeeper, { size: [0.72, 0.82, 0.4], position: [0, 1.22, 0], material: keeperOrange });
  addBox(goalkeeper, { size: [0.2, 0.65, 0.22], position: [-0.46, 1.18, 0.02], material: keeperOrange });
  addBox(goalkeeper, { size: [0.2, 0.65, 0.22], position: [0.46, 1.18, 0.02], material: keeperOrange });
  addBox(goalkeeper, { size: [0.28, 0.14, 0.16], position: [-0.52, 0.82, 0.06], material: new THREE.MeshStandardMaterial({ color: 0xd9d5c7, roughness: 0.65 }) });
  addBox(goalkeeper, { size: [0.28, 0.14, 0.16], position: [0.52, 0.82, 0.06], material: new THREE.MeshStandardMaterial({ color: 0xd9d5c7, roughness: 0.65 }) });
  addBox(goalkeeper, { size: [0.34, 0.36, 0.32], position: [0, 1.84, 0], material: keeperSkin });
  addBox(goalkeeper, { size: [0.38, 0.1, 0.36], position: [0, 2.04, 0], material: keeperBlack });
  addBox(goalkeeper, { size: [0.08, 0.08, 0.02], position: [-0.08, 1.88, 0.165], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  addBox(goalkeeper, { size: [0.08, 0.08, 0.02], position: [0.08, 1.88, 0.165], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  const keeperNameTexture = createTextTexture("大L", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e4d7bd",
    accent: "#d2642a",
    fontSize: 78,
    subtext: "GOALKEEPER · 14",
    subFontSize: 22,
  });
  addPlane(goalkeeper, {
    size: [0.9, 0.24],
    position: [0, 0.15, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: keeperNameTexture, toneMapped: false }),
  });
  const keeperLight = new THREE.PointLight(0xe67835, 0, 5.5, 2);
  keeperLight.position.set(0, 2.3, 0.6);
  goalkeeper.add(keeperLight);
  let goalkeeperActive = false;
  const setGoalkeeperActive = (active) => {
    goalkeeperActive = Boolean(active);
    goalkeeper.visible = goalkeeperActive;
    keeperLight.intensity = goalkeeperActive ? 2.4 : 0;
  };

  // -----------------------------------------------------------------------
  // "Gao the Airplane" paper plane, a LEAGUE shooting meme made physical
  // -----------------------------------------------------------------------
  const paperPlane = new THREE.Group();
  paperPlane.position.set(0, 0.22, 24);
  group.add(paperPlane);
  const planeGeometry = new THREE.BufferGeometry();
  planeGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0.36, -0.5, 0, -0.24, 0, 0, -0.1,
    0, 0, 0.36, 0.5, 0, -0.24, 0, 0, -0.1,
    0, 0.24, 0.08, 0, 0.02, -0.12, 0, 0.02, -0.38,
  ], 3));
  planeGeometry.computeVertexNormals();
  const paperPlaneMesh = new THREE.Mesh(
    planeGeometry,
    new THREE.MeshBasicMaterial({ color: 0xe8e0cd, side: THREE.DoubleSide, toneMapped: false }),
  );
  paperPlaneMesh.rotation.x = -0.08;
  paperPlane.add(paperPlaneMesh);
  const planeSignTexture = createTextTexture("郜飞机", {
    width: 1024,
    height: 256,
    background: "#e7dfca",
    color: "#17251b",
    accent: "#4a8b61",
    fontSize: 78,
    subtext: "这脚打高了 · 纸飞机",
    subFontSize: 24,
  });
  const planeSign = addPlane(paperPlane, {
    size: [0.8, 0.2],
    position: [0, 0.02, 0.12],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: planeSignTexture, toneMapped: false }),
  });
  let paperPlaneFlying = false;
  let paperPlaneTime = 0;
  const launchPaperPlane = () => {
    if (paperPlaneFlying) return false;
    paperPlaneFlying = true;
    paperPlaneTime = 0;
    paperPlane.visible = true;
    paperPlane.position.set(0, 0.35, 24);
    paperPlane.rotation.set(0, 0, 0);
    return true;
  };

  // -----------------------------------------------------------------------
  // Referee figure, the card-happy LEAGUE official at the fourth-official board
  // -----------------------------------------------------------------------
  const referee = new THREE.Group();
  referee.position.set(14.2, 0, 43.0);
  referee.rotation.y = 0.28;
  referee.visible = false;
  group.add(referee);
  const refBlack = new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.76 });
  const refSkin = new THREE.MeshStandardMaterial({ color: 0xa97f63, roughness: 0.82 });
  addBox(referee, { size: [0.22, 0.78, 0.24], position: [-0.14, 0.39, 0], material: refBlack });
  addBox(referee, { size: [0.22, 0.78, 0.24], position: [0.14, 0.39, 0], material: refBlack });
  addBox(referee, { size: [0.68, 0.78, 0.36], position: [0, 1.13, 0], material: refBlack });
  addBox(referee, { size: [0.18, 0.64, 0.2], position: [-0.43, 1.1, 0], material: refBlack });
  addBox(referee, { size: [0.18, 0.64, 0.2], position: [0.43, 1.1, 0], material: refBlack });
  addBox(referee, { size: [0.3, 0.32, 0.28], position: [0, 1.78, 0], material: refSkin });
  addBox(referee, { size: [0.34, 0.12, 0.3], position: [0, 1.98, 0], material: refBlack });
  addBox(referee, { size: [0.08, 0.08, 0.02], position: [-0.07, 1.81, 0.145], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  addBox(referee, { size: [0.08, 0.08, 0.02], position: [0.07, 1.81, 0.145], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  addBox(referee, { size: [0.26, 0.14, 0.03], position: [0.52, 1.5, 0.18], material: new THREE.MeshBasicMaterial({ color: 0xc6291b, toneMapped: false }) });
  addBox(referee, { size: [0.2, 0.26, 0.02], position: [0.34, 1.56, 0.18], material: new THREE.MeshBasicMaterial({ color: 0xd7b43b, toneMapped: false }) });
  addCylinder(referee, {
    radiusTop: 0.018,
    radiusBottom: 0.024,
    height: 0.32,
    radialSegments: 8,
    position: [-0.52, 1.58, 0.1],
    rotation: [0, 0, 0.18],
    material: new THREE.MeshStandardMaterial({ color: 0xc9c5b7, roughness: 0.3, metalness: 0.6 }),
  });
  const refNameTexture = createTextTexture("主裁判", {
    width: 1024,
    height: 256,
    background: "#0b0b0b",
    color: "#e4d7bd",
    accent: "#c23825",
    fontSize: 76,
    subtext: "REFEREE · 马N今天带了几张牌？",
    subFontSize: 21,
  });
  addPlane(referee, {
    size: [1.15, 0.3],
    position: [0, 0.16, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: refNameTexture, toneMapped: false }),
  });
  const refLight = new THREE.PointLight(0xc4452d, 0, 4.5, 2);
  refLight.position.set(0, 2.3, 0.4);
  referee.add(refLight);
  let refereeActive = false;
  const setRefereeActive = (active) => {
    refereeActive = Boolean(active);
    referee.visible = refereeActive;
    refLight.intensity = refereeActive ? 2.0 : 0;
  };

  // -----------------------------------------------------------------------
  // "Fellaini time" ghost in the north stand
  // -----------------------------------------------------------------------
  const fellaini = new THREE.Group();
  fellaini.position.set(11.5, 0, -60.6);
  fellaini.visible = false;
  group.add(fellaini);
  const fellainiOrange = new THREE.MeshStandardMaterial({
    color: 0xd75c25,
    roughness: 0.72,
    metalness: 0.02,
    emissive: 0x2e0e04,
    emissiveIntensity: 0.16,
  });
  const fellainiBlack = new THREE.MeshStandardMaterial({ color: 0x111213, roughness: 0.88 });
  const fellainiSkin = new THREE.MeshStandardMaterial({ color: 0x8e6148, roughness: 0.82 });
  addBox(fellaini, { size: [0.28, 1.02, 0.3], position: [-0.17, 0.51, 0], material: fellainiBlack });
  addBox(fellaini, { size: [0.28, 1.02, 0.3], position: [0.17, 0.51, 0], material: fellainiBlack });
  addBox(fellaini, { size: [0.82, 0.92, 0.44], position: [0, 1.42, 0], material: fellainiOrange });
  addBox(fellaini, { size: [0.22, 0.7, 0.24], position: [-0.52, 1.38, 0.02], material: fellainiOrange });
  addBox(fellaini, { size: [0.22, 0.7, 0.24], position: [0.52, 1.38, 0.02], material: fellainiOrange });
  addBox(fellaini, { size: [0.36, 0.38, 0.34], position: [0, 2.05, 0], material: fellainiSkin });
  const afroMaterial = new THREE.MeshStandardMaterial({ color: 0x14100d, roughness: 0.98 });
  const afro = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), afroMaterial);
  afro.scale.set(1.15, 0.82, 1.05);
  afro.position.set(0, 2.33, 0);
  fellaini.add(afro);
  addBox(fellaini, { size: [0.09, 0.08, 0.02], position: [-0.09, 2.08, 0.175], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  addBox(fellaini, { size: [0.09, 0.08, 0.02], position: [0.09, 2.08, 0.175], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  const fellainiSignTexture = createTextTexture("费莱N", {
    width: 1024,
    height: 256,
    background: "#0b0c0b",
    color: "#e6d8bd",
    accent: "#d5642b",
    fontSize: 78,
    subtext: "25 · 费莱N时间 · 90+6",
    subFontSize: 23,
  });
  addPlane(fellaini, {
    size: [1.1, 0.28],
    position: [0, 0.17, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: fellainiSignTexture, toneMapped: false }),
  });
  const fellainiLight = new THREE.PointLight(0xe07835, 1.8, 4.8, 2);
  fellainiLight.position.set(0, 2.7, 0.4);
  fellaini.add(fellainiLight);

  // -----------------------------------------------------------------------
  // "Fu Huan does not track back" ghost defender
  // -----------------------------------------------------------------------
  const fuhuan = createLowPolyPerson({
    jersey: 0xe9e7dc,
    shorts: 0x141414,
    skin: 0x9c7258,
    hair: 0x101112,
    accent: 0xc23a2b,
    number: 23,
    name: "傅H",
    numberColor: "#1a2a20",
    nameColor: "#1a2a20",
  });
  fuhuan.position.set(-30, 0, 40);
  fuhuan.visible = false;
  group.add(fuhuan);
  const fuhuanSignTexture = createTextTexture("傅H", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#b33a2a",
    fontSize: 76,
    subtext: "23 · 不回追 · 客队半场",
    subFontSize: 22,
  });
  addPlane(fuhuan, {
    size: [0.95, 0.24],
    position: [0, 0.18, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: fuhuanSignTexture, toneMapped: false }),
  });
  const fuhuanLight = new THREE.PointLight(0xcfd8c7, 1.0, 3.8, 2);
  fuhuanLight.position.set(0, 2.2, 0.4);
  fuhuan.add(fuhuanLight);

  // -----------------------------------------------------------------------
  // "Nuclear Wu 7" ghost striker with a one-on-one ball
  // -----------------------------------------------------------------------
  const wuLei = createLowPolyPerson({
    jersey: 0xb72b24,
    shorts: 0xe8e5da,
    skin: 0x9b7258,
    hair: 0x101112,
    accent: 0xe8c56b,
    number: 7,
    name: "武L",
    numberColor: "#f6ecd6",
    nameColor: "#f6ecd6",
  });
  wuLei.position.set(-22, 0, 18);
  wuLei.rotation.y = -0.35;
  wuLei.visible = false;
  group.add(wuLei);
  const wuLeiSignTexture = createTextTexture("武L", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#b72b24",
    fontSize: 76,
    subtext: "7 · 核武7 · 单刀",
    subFontSize: 22,
  });
  addPlane(wuLei, {
    size: [0.95, 0.24],
    position: [0, 0.18, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: wuLeiSignTexture, toneMapped: false }),
  });
  const wuLeiLight = new THREE.PointLight(0xd45a3a, 1.2, 4.2, 2);
  wuLeiLight.position.set(0, 2.2, 0.4);
  wuLei.add(wuLeiLight);
  const wuLeiBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xe7e2d5, roughness: 0.78 }),
  );
  wuLeiBall.position.set(0.45, 0.12, 0.35);
  wuLei.add(wuLeiBall);

  // -----------------------------------------------------------------------
  // Coach Li Xiaopeng and the last substitution: seat 6 row 0
  // -----------------------------------------------------------------------
  const coach = new THREE.Group();
  coach.position.set(18, 0, 30);
  coach.rotation.y = -0.55;
  coach.visible = true;
  group.add(coach);
  const coachSuit = new THREE.MeshStandardMaterial({ color: 0x1d2023, roughness: 0.76, metalness: 0.06 });
  const coachShirt = new THREE.MeshStandardMaterial({ color: 0xbdb8aa, roughness: 0.86 });
  const coachTie = new THREE.MeshStandardMaterial({ color: 0xc45a24, roughness: 0.7 });
  const coachSkin = new THREE.MeshStandardMaterial({ color: 0xa77f63, roughness: 0.82 });
  addBox(coach, { size: [0.22, 0.82, 0.24], position: [-0.15, 0.41, 0], material: new THREE.MeshStandardMaterial({ color: 0x121314, roughness: 0.9 }) });
  addBox(coach, { size: [0.22, 0.82, 0.24], position: [0.15, 0.41, 0], material: new THREE.MeshStandardMaterial({ color: 0x121314, roughness: 0.9 }) });
  addBox(coach, { size: [0.68, 0.82, 0.38], position: [0, 1.2, 0], material: coachSuit });
  addBox(coach, { size: [0.2, 0.22, 0.04], position: [0, 1.56, 0.2], material: coachShirt });
  addBox(coach, { size: [0.07, 0.34, 0.03], position: [0, 1.34, 0.23], material: coachTie });
  addBox(coach, { size: [0.18, 0.62, 0.2], position: [-0.43, 1.18, 0], material: coachSuit });
  addBox(coach, { size: [0.18, 0.62, 0.2], position: [0.43, 1.18, 0], material: coachSuit });
  addBox(coach, { size: [0.3, 0.32, 0.28], position: [0, 1.84, 0], material: coachSkin });
  addBox(coach, { size: [0.34, 0.1, 0.3], position: [0, 2.04, 0], material: new THREE.MeshStandardMaterial({ color: 0x3a2e24, roughness: 0.95 }) });
  addBox(coach, { size: [0.34, 0.08, 0.34], position: [0, 2.1, 0], material: new THREE.MeshStandardMaterial({ color: 0x1a1b1b, roughness: 0.9 }) });
  addBox(coach, { size: [0.07, 0.07, 0.02], position: [-0.07, 1.87, 0.145], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  addBox(coach, { size: [0.07, 0.07, 0.02], position: [0.07, 1.87, 0.145], material: new THREE.MeshBasicMaterial({ color: 0x1b120d }) });
  // Dugout / bench: a small scene around the coach, not just a standing figure.
  const dugout = new THREE.Group();
  dugout.position.set(18, 0, 33);
  group.add(dugout);
  const benchMaterialLocal = new THREE.MeshStandardMaterial({ color: 0x2c2822, roughness: 0.72, metalness: 0.2 });
  addBox(dugout, { size: [4.8, 0.12, 0.62], position: [0, 0.52, 0], material: benchMaterialLocal });
  addBox(dugout, { size: [4.8, 0.55, 0.1], position: [0, 0.82, -0.28], material: benchMaterialLocal });
  [-2.2, -1.1, 0, 1.1, 2.2].forEach((x) => {
    addBox(dugout, { size: [0.08, 0.5, 0.5], position: [x, 0.26, 0], material: benchMaterialLocal });
  });
  addBox(dugout, { size: [5.2, 0.08, 1.5], position: [0, 2.45, -0.15], material: new THREE.MeshStandardMaterial({ color: 0x141719, roughness: 0.8, metalness: 0.3 }) });
  [-2.45, 2.45].forEach((x) => {
    addBox(dugout, { size: [0.07, 2.4, 0.07], position: [x, 1.22, 0.55], material: benchMaterialLocal });
  });
  const dugoutSignTexture = createTextTexture("山东T山 · 替补席", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#c45a24",
    fontSize: 58,
    subtext: "DUGOUT · 6排0号",
    subFontSize: 22,
  });
  addPlane(dugout, {
    size: [3.2, 0.8],
    position: [0, 2.0, -0.75],
    material: new THREE.MeshBasicMaterial({ map: dugoutSignTexture, toneMapped: false }),
  });
  addBox(dugout, { size: [0.5, 0.35, 0.35], position: [2.1, 0.2, 0.25], material: new THREE.MeshStandardMaterial({ color: 0xb7c2b0, roughness: 0.5, metalness: 0.3 }) });

  const coachBoardTexture = createTextTexture("换人", {
    width: 512,
    height: 384,
    background: "#ece9df",
    color: "#15231a",
    accent: "#c45a24",
    fontSize: 86,
    subtext: "6 排 0 号",
    subFontSize: 32,
  });
  addPlane(coach, {
    size: [0.46, 0.34],
    position: [0.48, 1.35, 0.24],
    rotation: [0, 0, -0.08],
    material: new THREE.MeshBasicMaterial({ map: coachBoardTexture, toneMapped: false }),
  });
  const coachSignTexture = createTextTexture("李X鹏", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#c45a24",
    fontSize: 76,
    subtext: "主教练 · 还有一个换人名额",
    subFontSize: 22,
  });
  addPlane(coach, {
    size: [1.1, 0.28],
    position: [0, 0.18, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: coachSignTexture, toneMapped: false }),
  });
  const coachLight = new THREE.PointLight(0xd58b56, 1.4, 4.4, 2);
  coachLight.position.set(0, 2.3, 0.4);
  coach.add(coachLight);

  // The coach is gone. Only the substitution board remains.
  addBox(group, {
    size: [0.06, 1.15, 0.06],
    position: [18, 0.58, 30],
    material: new THREE.MeshStandardMaterial({ color: 0x1a1b1b, roughness: 0.8, metalness: 0.3 }),
  });
  addPlane(group, {
    size: [0.72, 0.5],
    position: [18, 1.22, 30],
    rotation: [0, 0, -0.08],
    material: new THREE.MeshBasicMaterial({ map: coachBoardTexture, toneMapped: false }),
  });

  // The captain is gone. Only the armband is left on the centre circle.
  const armbandTrace = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.045, 8, 18),
    new THREE.MeshBasicMaterial({ color: 0xe8c56b, toneMapped: false }),
  );
  armbandTrace.rotation.x = Math.PI / 2;
  armbandTrace.position.set(4.2, 0.36, 14);
  group.add(armbandTrace);
  const armbandTraceSign = createTextTexture("队长袖标", {
    width: 512,
    height: 128,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#e8c56b",
    fontSize: 44,
    subtext: "6排0号",
    subFontSize: 18,
  });
  addPlane(group, {
    size: [0.9, 0.22],
    position: [4.2, 0.04, 14.7],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: armbandTraceSign, toneMapped: false }),
  });

  // -----------------------------------------------------------------------
  // Captain Zheng Zhi and the cursed armband
  // -----------------------------------------------------------------------
  const captain = createLowPolyPerson({
    jersey: 0xb72b24,
    shorts: 0xe8e5da,
    skin: 0x9b7258,
    hair: 0x101112,
    accent: 0xe8c56b,
    number: 10,
    name: "郑Z",
  });
  captain.position.set(4.2, 0, 14);
  captain.rotation.y = -0.25;
  captain.visible = true;
  group.add(captain);
  const armbandMaterial = new THREE.MeshBasicMaterial({ color: 0xe8c56b, toneMapped: false });
  addBox(captain, {
    size: [0.24, 0.08, 0.22],
    position: [-0.42, 1.0, 0],
    material: armbandMaterial,
  });
  addBox(captain.userData.rig.leftArm, {
    size: [0.22, 0.09, 0.18],
    position: [0, -0.08, 0.02],
    material: armbandMaterial,
  });
  const captainSignTexture = createTextTexture("郑Z", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#c23a2b",
    fontSize: 76,
    subtext: "10 · 队长 · 袖标",
    subFontSize: 22,
  });
  addPlane(captain, {
    size: [0.95, 0.24],
    position: [0, 0.18, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: captainSignTexture, toneMapped: false }),
  });
  const captainLight = new THREE.PointLight(0xd9c27a, 1.3, 4.2, 2);
  captainLight.position.set(0, 2.3, 0.4);
  captain.add(captainLight);

  // -----------------------------------------------------------------------
  // Home-end pressure: six orange flares, a 1993 tifo, and the away cage
  // -----------------------------------------------------------------------
  const homePressure = new THREE.Group();
  homePressure.visible = false;
  group.add(homePressure);
  const homeFlareLights = [];
  const homeFlareMeshes = [];
  const homeFlareX = [-12, -7.2, -2.4, 2.4, 7.2, 12];
  homeFlareX.forEach((x) => {
    const flare = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.62, 8),
      new THREE.MeshBasicMaterial({ color: 0xff6a24, toneMapped: false }),
    );
    flare.position.set(x, 2.1, -62.8);
    flare.scale.setScalar(0.8);
    homePressure.add(flare);
    homeFlareMeshes.push(flare);
    const light = new THREE.PointLight(0xff6a24, 0.0, 7, 2);
    light.position.set(x, 2.5, -62.2);
    homePressure.add(light);
    homeFlareLights.push(light);
  });
  const homeFlareGlows = homeFlareX.map((x) => {
    const glow = makeGlowSprite(0xff6a24, 5.5, 0.55);
    glow.position.set(x, 7.0, -58);
    homePressure.add(glow);
    return glow;
  });
  const homeWash = new THREE.PointLight(0xff5a22, 0, 72, 2);
  homeWash.position.set(0, 8, 14);
  group.add(homeWash);
  const homeNearGlows = homeFlareX.map((x) => {
    const glow = makeGlowSprite(0xff6a24, 4.2, 0.42);
    glow.position.set(x * 1.25, 6.2, -30);
    homePressure.add(glow);
    return glow;
  });

  const homeTifoTexture = createTextTexture("1993", {
    width: 1024,
    height: 384,
    background: "#0b0c0c",
    color: "#f0dfb9",
    accent: "#d65a24",
    fontSize: 150,
    subtext: "荣耀与传承 · 6:0 · 北看台",
    subFontSize: 34,
  });
  addPlane(group, {
    size: [5.2, 1.9],
    position: [0, 5.2, -63.55],
    rotation: [0, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: homeTifoTexture, toneMapped: false }),
  });
  const awaySignTexture = createTextTexture("客队球迷区", {
    width: 1024,
    height: 384,
    background: "#07100b",
    color: "#cfe0c4",
    accent: "#4f8f63",
    fontSize: 84,
    subtext: "AWAY END · 请从南门有序离场",
    subFontSize: 28,
  });
  addPlane(group, {
    size: [3.6, 1.35],
    position: [-8.5, 3.1, 63.55],
    rotation: [0, Math.PI, 0],
    material: new THREE.MeshBasicMaterial({ map: awaySignTexture, toneMapped: false }),
  });
  const awayFenceMaterial = new THREE.MeshStandardMaterial({ color: 0x335b42, roughness: 0.8, metalness: 0.25 });
  for (let i = 0; i < 12; i += 1) {
    addBox(group, {
      size: [0.07, 1.25, 0.07],
      position: [-15 + i * 2.0, 0.62, 62.7],
      material: awayFenceMaterial,
    });
  }
  addBox(group, {
    size: [22.2, 0.07, 0.07],
    position: [-4.0, 1.23, 62.7],
    material: awayFenceMaterial,
  });
  let homePressureActive = false;
  let homeGoalIndex = 0;
  const HOME_GOAL_Z = [45, 24, 2, -18, -36, -47];
  const setHomePressure = (active) => {
    homePressureActive = Boolean(active);
    homePressure.visible = homePressureActive;
    if (homePressureActive) homeGoalIndex = 0;
    homeWash.intensity = homePressureActive ? 9.0 : 0;
    if (!homePressureActive) {
      homeFlareLights.forEach((light) => { light.intensity = 0; });
      homeFlareMeshes.forEach((flare) => { flare.scale.setScalar(0.8); });
      homeFlareGlows.forEach((glow) => { glow.material.opacity = 0.55; });
      homeNearGlows.forEach((glow) => { glow.material.opacity = 0.42; });
    }
  };
  const pulseHomeFlare = (index) => {
    const light = homeFlareLights[index];
    const flare = homeFlareMeshes[index];
    if (light) light.intensity = 4.5;
    if (flare) flare.scale.setScalar(1.45);
    const glow = homeFlareGlows[index];
    if (glow) glow.material.opacity = 1.0;
    const nearGlow = homeNearGlows[index];
    if (nearGlow) nearGlow.material.opacity = 1.0;
  };

  // North stand underpass around Fellaini.
  const northUnderpass = new THREE.Group();
  northUnderpass.position.set(11.5, 0, -60.6);
  group.add(northUnderpass);
  const underpassWall = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.92 });
  addBox(northUnderpass, { size: [0.2, 3.0, 5.0], position: [-2.3, 1.5, 0], material: underpassWall });
  addBox(northUnderpass, { size: [0.2, 3.0, 5.0], position: [2.3, 1.5, 0], material: underpassWall });
  addBox(northUnderpass, { size: [4.8, 0.2, 5.0], position: [0, 3.0, 0], material: underpassWall });
  const underpassSignTexture = createTextTexture("北看台通道", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#d75c25",
    fontSize: 62,
    subtext: "NORTH STAND · 费莱N时间",
    subFontSize: 22,
  });
  addPlane(northUnderpass, {
    size: [1.8, 0.45],
    position: [-2.18, 2.35, 2.4],
    rotation: [0, Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({ map: underpassSignTexture, toneMapped: false }),
  });
  const underpassLight = new THREE.PointLight(0xd75c25, 2.0, 5.5, 2);
  underpassLight.position.set(0, 2.2, 1.5);
  northUnderpass.add(underpassLight);

  // -----------------------------------------------------------------------
  // Collision walls
  // -----------------------------------------------------------------------
  addCollider(colliders, -52, 52, -64.35, -63.8, { name: "northStand", maxY: 1.6 });
  addCollider(colliders, 46.4, 46.9, -42, 42, { name: "eastStand", maxY: 1.6 });
  addCollider(colliders, -46.9, -46.4, -42, 42, { name: "westStand", maxY: 1.6 });
  // South stand except the tunnel mouth.
  addCollider(colliders, -52, -2.55, 63.8, 64.35, { name: "southStandL", maxY: 1.6 });
  addCollider(colliders, 2.55, 52, 63.8, 64.35, { name: "southStandR", maxY: 1.6 });
  // Tunnel side walls and end wall.
  addCollider(colliders, -2.65, -2.38, 64, 77.8, { name: "tunnelWallL", maxY: 3.5 });
  addCollider(colliders, 2.38, 2.65, 64, 77.8, { name: "tunnelWallR", maxY: 3.5 });
  addCollider(colliders, -2.6, 2.6, 77.4, 77.8, { name: "tunnelEnd", maxY: 3.5 });

  // -----------------------------------------------------------------------
  // Interaction items
  // -----------------------------------------------------------------------
  // These are wired by Game after construction.
  area.interactables.push(
    {
      object: panel,
      getLabel: () => (gateOpen ? "进入球员通道" : "查看通道门禁"),
      range: 3.0,
      onInteract: () => area.onPanelInteract?.(),
    },
    {
      object: gate,
      getLabel: () => (gateOpen ? "进入球员通道" : "检查通道门"),
      range: 3.0,
      onInteract: () => area.onPanelInteract?.(),
    },
    {
      object: notePaper,
      label: "阅读维护记录",
      range: 3.0,
      onInteract: () => area.onNoteInteract?.(),
    },
    {
      object: benchGroup,
      label: "看那条绿色围巾",
      range: 3.5,
      onInteract: () => area.onScarfInteract?.(),
    },
    {
      object: stoppageBoard,
      getLabel: () => `调整补时牌（+${stoppageValue}）`,
      range: 3.2,
      enabled: () => stoppageActive,
      onInteract: () => area.onStoppageInteract?.(),
    },
    {
      object: redCardGroup,
      label: "查看红牌",
      range: 3.0,
      enabled: () => redCardActive,
      onInteract: () => area.onRedCardInteract?.(),
    },
    {
      object: twelfthManGroup,
      label: "查看第12人的座位",
      range: 3.2,
      onInteract: () => area.onTwelfthManInteract?.(),
    },
    {
      object: capoMegaphone,
      label: "拿起领喊喇叭",
      range: 3.0,
      onInteract: () => area.onMegaphoneInteract?.(),
    },
    {
      object: seatSixZero,
      label: "查看6排0号",
      range: 3.2,
      onInteract: () => area.onSeatSixZeroInteract?.(),
    },
    {
      object: goalkeeper,
      label: "和门将说话",
      range: 3.2,
      enabled: () => goalkeeperActive,
      onInteract: () => area.onGoalkeeperInteract?.(),
    },
    {
      object: referee,
      label: "和主裁判说话",
      range: 3.2,
      enabled: () => refereeActive,
      onInteract: () => area.onRefereeInteract?.(),
    },
    {
      object: paperPlane,
      label: "捡起纸飞机",
      range: 3.0,
      onInteract: () => area.onPaperPlaneInteract?.(),
    },
    {
      object: coach,
      label: "和主教练说话",
      range: 3.2,
      onInteract: () => area.onCoachInteract?.(),
    },
    {
      object: captain,
      label: "和郑Z说话",
      range: 3.2,
      onInteract: () => area.onCaptainInteract?.(),
    },
  );

  // -----------------------------------------------------------------------
  // Area behavior
  // -----------------------------------------------------------------------
  let mood = "search";
  let gateOpen = false;
  let gateProgress = 0;
  let flickerTimer = 8;
  let flickerUntil = 0;
  let elapsedLocal = 0;
  let specterTimer = 0;
  let finalGlow = 0;
  let escapeMode = false;

  const setGate = (open) => {
    gateOpen = open;
    gateCollider.active = !open;
    greenIndicatorMaterial.color.set(open ? 0x5dd58b : 0x5d2618);
    scoreboard.light.color.set(open ? 0xd34527 : 0x8d2419);
  };

  const setMood = (nextMood) => {
    mood = nextMood;
    if (nextMood === "final") {
      hemi.intensity = 0.56;
      moon.intensity = 0.42;
      floodA.intensity = 310;
      floodB.intensity = 270;
      ambientWarm.intensity = 4.5;
      scoreboard.setMood("final");
      standWashes.forEach((light) => { light.intensity = 1.1; });
      emergencyLights.forEach((light) => { light.intensity = 0.35; });
    } else if (nextMood === "blackout") {
      hemi.intensity = 0.12;
      moon.intensity = 0.03;
      floodA.intensity = 0;
      floodB.intensity = 0;
      ambientWarm.intensity = 1.6;
      scoreboard.setMood("blackout");
      standWashes.forEach((light) => { light.intensity = 0.18; });
      emergencyLights.forEach((light) => { light.intensity = 1.5; });
    } else {
      hemi.intensity = 0.92;
      moon.intensity = 1.05;
      floodA.intensity = 430;
      floodB.intensity = 380;
      ambientWarm.intensity = 3.4;
      scoreboard.setMood("normal");
      standWashes.forEach((light) => { light.intensity = 3.2; });
      emergencyLights.forEach((light) => { light.intensity = 0.9; });
    }
  };

  const glitchScoreboard = (duration = 1.6) => {
    flickerUntil = Math.max(flickerUntil, elapsedLocal + duration);
    flickerTimer = 4 + Math.random() * 6;
    scoreboard.glitch(duration);
  };

  const showSpecter = () => {
    specter.visible = true;
    specterTimer = 0;
  };

  let refundPassiveSeen = false;
  let fuhuanPassiveSeen = false;
  let fellainiPassiveSeen = false;
  const scareTargets = [
    { group: fuhuan, name: "傅H" },
    { group: fellaini, name: "费莱N" },
    { group: refundFan, name: "退钱球迷" },
    { group: coach, name: "李X鹏" },
    { group: captain, name: "郑Z" },
    { group: goalkeeper, name: "大L" },
    { group: referee, name: "主裁判" },
  ];
  const scareDone = new Set();

  area.update = (dt, elapsed) => {
    elapsedLocal = elapsed;
    const step = Math.min(dt, 0.05);
    animateLowPolyPerson(refundFan, elapsed, { amount: refundFan.visible ? 1 : 0, phase: 0.3 });
    animateLowPolyPerson(fuhuan, elapsed, { amount: fuhuan.visible ? 1 : 0, phase: 1.1 });
    animateLowPolyPerson(fellaini, elapsed, { amount: fellaini.visible ? 1 : 0, phase: 2.2 });
    animateLowPolyPerson(coach, elapsed, { amount: 0.8, phase: 0.8 });
    animateLowPolyPerson(captain, elapsed, { amount: 0.8, phase: 1.7 });
    goalkeeper.rotation.z = Math.sin(elapsed * 0.9) * 0.006;
    referee.rotation.z = Math.sin(elapsed * 0.74 + 1.4) * 0.006;
    if (area.player) {
      const px = area.player.position.x;
      const pz = area.player.position.z;
      const faceHead = (group, baseY = 1.86, rate = 0.08) => {
        const head = group.userData.rig?.head;
        if (!head) return;
        const dx = px - group.position.x;
        const dz = pz - group.position.z;
        const target = Math.atan2(dx, dz);
        head.rotation.y += (target - head.rotation.y) * rate;
        head.position.y = baseY;
      };
      if (fellaini.visible) {
        faceHead(fellaini, 1.86, 0.12);
        const neck = Math.max(0, Math.sin(elapsed * 1.35));
        if (fellaini.userData.rig?.head) fellaini.userData.rig.head.position.y += neck * 0.16;
      }
      if (fuhuan.visible) {
        faceHead(fuhuan, 1.86, 0.1);
        const arm = fuhuan.userData.rig?.rightArm;
        if (arm) arm.rotation.x += (-1.15 - arm.rotation.x) * 0.035;
      }
      if (coach.visible) {
        faceHead(coach, 1.86, 0.08);
        const arm = coach.userData.rig?.leftArm;
        if (arm) arm.rotation.x += (-0.95 - arm.rotation.x) * 0.03;
      }
      if (captain.visible) {
        faceHead(captain, 1.86, 0.08);
        const arm = captain.userData.rig?.leftArm;
        if (arm) arm.rotation.x += (-1.05 - arm.rotation.x) * 0.035;
      }
      if (refundFan.visible) {
        faceHead(refundFan, 1.86, 0.1);
        refundFan.position.y = Math.sin(elapsed * 1.4) * 0.015;
      }
    }
    if (area.player) {
      const px = area.player.position.x;
      const pz = area.player.position.z;
      if (!refundPassiveSeen && Math.hypot(px + 10, pz - 61.7) < 8) {
        refundPassiveSeen = true;
        refundFan.visible = true;
        area.onRefundPassive?.();
        window.setTimeout(() => { refundFan.visible = false; }, 4800);
      }
      if (!fuhuanPassiveSeen && Math.hypot(px + 30, pz - 40) < 10) {
        fuhuanPassiveSeen = true;
        fuhuan.visible = true;
        area.onFuhuanPassive?.();
        window.setTimeout(() => { fuhuan.visible = false; }, 5200);
      }
      if (!fellainiPassiveSeen && Math.hypot(px - 11.5, pz + 60.6) < 12) {
        fellainiPassiveSeen = true;
        fellaini.visible = true;
        area.onFellainiPassive?.();
        window.setTimeout(() => { fellaini.visible = false; }, 6200);
      }
    }

    if (area.player) {
      for (const target of scareTargets) {
        if (!target.group.visible || scareDone.has(target.name)) continue;
        const dx = area.player.position.x - target.group.position.x;
        const dz = area.player.position.z - target.group.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 5.2) {
          scareDone.add(target.name);
          const head = target.group.userData?.rig?.head;
          if (head) {
            head.rotation.y = Math.atan2(dx, dz);
            head.rotation.x = -0.14;
          }
          if (distance > 0.8) {
            target.group.position.x += (dx / distance) * 0.28;
            target.group.position.z += (dz / distance) * 0.28;
          }
          target.group.userData.scareUntil = elapsed + 0.75;
          area.onCharacterScare?.(target.name);
          glitchScoreboard(0.7);
        }
      }
    }

    if (homePressureActive && homeGoalIndex < HOME_GOAL_Z.length && area.player) {
      if (area.player.position.z < HOME_GOAL_Z[homeGoalIndex]) {
        const index = homeGoalIndex;
        homeGoalIndex += 1;
        pulseHomeFlare(index);
        area.onHomeGoal?.(index);
      }
    }

    // Gate slide.
    gateProgress += ((gateOpen ? 1 : 0) - gateProgress) * Math.min(1, step * 3.6);
    gate.position.y = gateProgress * 3.35;

    // The dynamic screen drives its own clock and glitch frames. The area
    // still owns the occasional ambient LED flicker.
    if (mood !== "blackout") {
      flickerTimer -= step;
      if (flickerTimer <= 0) {
        scoreboard.glitch(0.25 + Math.random() * 0.55);
        flickerTimer = 4 + Math.random() * 6;
      }
    }
    scoreboard.update(dt, elapsed);

    // Goal marker pulse for the final objective.
    if (mood === "final" || escapeMode) {
      finalGlow = Math.min(1, finalGlow + step * 0.8);
      goalMarker.visible = true;
      goalMarker.material.opacity = 0.1 + Math.sin(elapsed * 2.2) * 0.05 + finalGlow * 0.08;
      goalMarker.material.color.setHex(escapeMode ? 0xc8d3d6 : 0xda3f24);
      goalLight.intensity = (escapeMode ? 7 : 4) + Math.sin(elapsed * 2.2) * 1.5;
    } else {
      goalMarker.visible = false;
      goalLight.intensity = 0;
    }
    if (escapeMode) {
      escapePortal.visible = true;
      escapePortalMaterial.opacity = 0.2 + Math.sin(elapsed * 1.6) * 0.05;
      escapeGlow.material.opacity = 0.2 + Math.sin(elapsed * 1.3) * 0.04;
      escapeLight.intensity = 22 + Math.sin(elapsed * 1.7) * 4;
    }

    if (paperPlaneFlying) {
      paperPlaneTime += step;
      const p = paperPlaneTime;
      paperPlane.position.x = Math.sin(p * 1.8) * 3.2;
      paperPlane.position.y = 0.7 + Math.abs(Math.sin(p * 2.2)) * 1.9;
      paperPlane.position.z = 24 - p * 8.5;
      paperPlane.rotation.z = Math.sin(p * 2.8) * 0.5;
      paperPlane.rotation.y = Math.sin(p * 1.2) * 0.4;
      if (p > 5.2) {
        paperPlaneFlying = false;
        paperPlane.visible = false;
      }
    } else if (paperPlane.visible) {
      paperPlane.position.y = 0.22 + Math.sin(elapsed * 1.7) * 0.025;
    }

    // Very slow dust drift.
    dust.rotation.y = elapsed * 0.002;

    // Specter appears at distance, gone when approached.
    if (specter.visible) {
      specterTimer += step;
      const distance = area.player?.position.distanceTo(specter.position) ?? 999;
      if (distance < 17 || specterTimer > 11) {
        specter.visible = false;
      }
    }

    // Portal lights lower slightly once open, to draw the eye inward.
    if (gateOpen) {
      portalLight.intensity = 8 + Math.sin(elapsed * 2.1) * 1.2;
      portalLight2.intensity = 5 + Math.sin(elapsed * 1.7 + 1) * 0.8;
    }
    tunnelSign.material.color.setRGB(
      1,
      gateOpen ? 0.74 : 0.5,
      gateOpen ? 0.48 : 0.34,
    );
  };

  area.setMood = setMood;
  area.glitchScoreboard = glitchScoreboard;
  area.setGateOpen = setGate;
  area.openGate = () => setGate(true);
  area.isGateOpen = () => gateOpen;
  area.showSpecter = showSpecter;
  area.hideSpecter = () => { specter.visible = false; };
  area.setEscapeMode = () => {
    escapeMode = true;
    goalMarker.visible = true;
    goalMarker.material.color.setHex(0xc8d3d6);
    goalLight.color.setHex(0xaec4cc);
    escapePortal.visible = true;
  };
  area.setScoreboard = (data) => scoreboard.setData(data);
  area.getScoreboard = () => ({ ...scoreboard.data, clock: scoreboard.getClock() });
  area.setScoreboardPower = (on) => scoreboard.setPower(on);
  area.setPortalEscape = () => {
    tunnelSign.material.map = createExitSign("南出口", "SOUTH EXIT", "#f2b06d");
    tunnelSign.material.needsUpdate = true;
    greenIndicatorMaterial.color.set(0x8ef0b1);
  };
  area.setHomePressure = setHomePressure;
  area.pulseHomeFlare = pulseHomeFlare;
  area.setPlayer = (player) => { area.player = player; };
  area.setStoppageActive = setStoppageActive;
  area.setStoppageValue = setStoppageValue;
  area.getStoppageValue = () => stoppageValue;
  area.isStoppageActive = () => stoppageActive;
  area.showRedCard = showRedCard;
  area.hideRedCard = hideRedCard;
  area.hideRefundFan = () => { refundFan.visible = false; };
  area.setGoalkeeperActive = setGoalkeeperActive;
  area.setRefereeActive = setRefereeActive;
  area.launchPaperPlane = launchPaperPlane;
  area._debug = { homePressure, homeWash,
    materials,
    scoreboard: scoreboard,
    gate,
    portal,
    goalMarker,
    specter,
  };

  return area;
}
