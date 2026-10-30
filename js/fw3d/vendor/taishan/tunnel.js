import * as THREE from "three";
import {
  addBox,
  addCylinder,
  addPlane,
  addCollider,
  addPointLight,
  createTextTexture,
  createPanelTexture,
  makeCanvasTexture,
  range,
  mulberry32,
} from "./utils.js";
import { createLowPolyPerson, animateLowPolyPerson } from "./lowpoly-character.js";

function createFloorTexture() {
  return makeCanvasTexture(1024, 512, (ctx, w, h) => {
    const rng = mulberry32(611);
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, "#2a1b16");
    gradient.addColorStop(0.35, "#3f261d");
    gradient.addColorStop(0.5, "#4b2c20");
    gradient.addColorStop(0.65, "#3b241b");
    gradient.addColorStop(1, "#241713");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < 9000; i += 1) {
      ctx.fillStyle = rng() > 0.5
        ? `rgba(220,190,150,${range(rng, 0.01, 0.05)})`
        : `rgba(0,0,0,${range(rng, 0.01, 0.07)})`;
      ctx.fillRect(rng() * w, rng() * h, range(rng, 0.5, 2.5), range(rng, 0.5, 2.5));
    }
    ctx.strokeStyle = "rgba(10,6,4,0.22)";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 18; i += 1) {
      ctx.beginPath();
      let x = rng() * w;
      let y = rng() * h;
      ctx.moveTo(x, y);
      for (let j = 0; j < 5; j += 1) {
        x += range(rng, -40, 40);
        y += range(rng, 4, 26);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    const glow = ctx.createRadialGradient(w / 2, h * 0.5, 30, w / 2, h * 0.5, w * 0.55);
    glow.addColorStop(0, "rgba(211,146,91,0.11)");
    glow.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  }, { repeat: [1, 5], wrap: THREE.RepeatWrapping });
}

function createCeilingTexture() {
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#121110";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(123,113,99,0.17)";
    ctx.lineWidth = 3;
    for (let x = 0; x < w; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 48) {
      for (let y = 0; y < h; y += 48) {
        ctx.strokeRect(x + 2, y + 2, 44, 44);
      }
    }
  }, { repeat: [2, 14], wrap: THREE.RepeatWrapping });
}

function createLoopDisplay(count) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const draw = (value) => {
    ctx.fillStyle = "#080706";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(205,188,162,0.18)";
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    ctx.fillStyle = "rgba(205,188,162,0.5)";
    ctx.font = '400 25px "Microsoft YaHei", sans-serif';
    ctx.textAlign = "left";
    ctx.fillText("通道回路 / SPATIAL LOOP", 34, 58);
    ctx.fillStyle = "#dc6d3b";
    ctx.font = "700 88px monospace";
    ctx.textAlign = "right";
    ctx.fillText(String(value).padStart(2, "0"), canvas.width - 38, 154);
    ctx.fillStyle = "rgba(205,188,162,0.3)";
    ctx.font = '400 18px monospace';
    ctx.textAlign = "left";
    ctx.fillText("DO NOT TURN BACK", 34, 210);
  };
  draw(count);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return { canvas, ctx, texture, draw };
}

export function buildTunnel({ textures, renderer }) {
  const group = new THREE.Group();
  const colliders = [];
  const interactables = [];
  const maxAnisotropy = renderer?.capabilities.getMaxAnisotropy?.() ?? 8;

  const area = {
    group,
    colliders,
    interactables,
    spawn: { position: new THREE.Vector3(0, 0, 14.4), yaw: 0, pitch: 0 },
    fog: new THREE.FogExp2(0x120c09, 0.038),
    background: new THREE.Color(0x080604),
    exposure: 1.02,
    bloom: 0.38,
    update: () => {},
  };

  const wallTexture = createPanelTexture({
    base: "#8f2b1b",
    highlight: "#c85b2a",
    dark: "#3f100c",
    width: 1024,
    height: 512,
  });
  wallTexture.anisotropy = maxAnisotropy;
  const wallMaterial = new THREE.MeshStandardMaterial({
    map: wallTexture,
    roughness: 0.6,
    metalness: 0.04,
    color: 0xffffff,
  });
  const upperWallMaterial = new THREE.MeshStandardMaterial({
    map: wallTexture,
    roughness: 0.66,
    metalness: 0.04,
    color: 0xa58c7e,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d1a17,
    roughness: 0.58,
    metalness: 0.28,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: createFloorTexture(),
    roughness: 0.38,
    metalness: 0.12,
  });
  const ceilingMaterial = new THREE.MeshStandardMaterial({
    map: createCeilingTexture(),
    roughness: 0.8,
    metalness: 0.25,
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x15110f,
    roughness: 0.85,
  });
  const orangeMaterial = new THREE.MeshStandardMaterial({
    color: 0x9d321e,
    roughness: 0.48,
    metalness: 0.14,
  });

  // -----------------------------------------------------------------------
  // Corridor shell
  // -----------------------------------------------------------------------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 44.4), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.01, -4);
  floor.receiveShadow = true;
  group.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 44.4), ceilingMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 3.82, -4);
  group.add(ceiling);

  addBox(group, {
    size: [0.26, 3.8, 44.4],
    position: [-3.08, 1.9, -4],
    material: wallMaterial,
    receiveShadow: true,
  });
  addBox(group, {
    size: [0.26, 1.0, 44.4],
    position: [-3.07, 0.5, -4],
    material: trimMaterial,
  });
  addBox(group, {
    size: [0.26, 0.18, 44.4],
    position: [-3.05, 3.05, -4],
    material: trimMaterial,
  });

  // Right wall is split around the honours room doorway.
  addBox(group, {
    size: [0.26, 3.8, 16.2],
    position: [3.08, 1.9, 10.1],
    material: wallMaterial,
    receiveShadow: true,
  });
  addBox(group, {
    size: [0.26, 3.8, 17.8],
    position: [3.08, 1.9, -17.1],
    material: wallMaterial,
    receiveShadow: true,
  });
  addBox(group, {
    size: [0.26, 1.05, 2.4],
    position: [3.08, 3.275, -7.0],
    material: upperWallMaterial,
  });
  addBox(group, {
    size: [0.26, 1.0, 44.4],
    position: [3.07, 0.5, -4],
    material: trimMaterial,
  });
  addBox(group, {
    size: [0.26, 0.18, 44.4],
    position: [3.05, 3.05, -4],
    material: trimMaterial,
  });

  // Start wall and closed return door.
  addBox(group, {
    size: [6.2, 3.8, 0.3],
    position: [0, 1.9, 18.25],
    material: wallMaterial,
  });
  const returnDoor = addBox(group, {
    size: [2.2, 3.0, 0.12],
    position: [0, 1.5, 18.06],
    material: darkMaterial,
  });
  addPlane(group, {
    size: [2.0, 0.5],
    position: [0, 3.15, 18.04],
    rotation: [0, Math.PI, 0],
    material: new THREE.MeshBasicMaterial({
      map: createTextTexture("返回球场", {
        width: 512,
        height: 128,
        background: "#090705",
        color: "#b9a88d",
        fontSize: 42,
        subtext: "BACK TO PITCH",
        subFontSize: 16,
      }),
      toneMapped: false,
    }),
  });

  // Floor trim strips.
  addBox(group, {
    size: [0.06, 0.015, 44],
    position: [-2.55, 0.025, -4],
    material: new THREE.MeshBasicMaterial({ color: 0x6d2b1c }),
  });
  addBox(group, {
    size: [0.06, 0.015, 44],
    position: [2.55, 0.025, -4],
    material: new THREE.MeshBasicMaterial({ color: 0x6d2b1c }),
  });

  // Ceiling beams and pipes.
  for (let z = 16; z >= -24; z -= 3.4) {
    addBox(group, {
      size: [6.2, 0.14, 0.16],
      position: [0, 3.66, z],
      material: trimMaterial,
    });
  }
  addCylinder(group, {
    radiusTop: 0.065,
    radiusBottom: 0.065,
    height: 42,
    radialSegments: 8,
    position: [-2.45, 3.56, -3.5],
    rotation: [Math.PI / 2, 0, 0],
    material: trimMaterial,
  });
  addCylinder(group, {
    radiusTop: 0.095,
    radiusBottom: 0.095,
    height: 42,
    radialSegments: 8,
    position: [2.3, 3.57, -3.5],
    rotation: [Math.PI / 2, 0, 0],
    material: trimMaterial,
  });

  // -----------------------------------------------------------------------
  // Overhead lights
  // -----------------------------------------------------------------------
  const panelMaterialWarm = new THREE.MeshBasicMaterial({ color: 0xffc48a, toneMapped: false });
  const panelMaterialRed = new THREE.MeshBasicMaterial({ color: 0xc23a23, toneMapped: false });
  const lightFixtures = [];
  const fixtureZ = [13.5, 6.5, -0.5, -7.5, -14.5, -21.5];
  fixtureZ.forEach((z, index) => {
    addBox(group, {
      size: [2.2, 0.1, 0.4],
      position: [0, 3.72, z],
      material: index === 3 ? panelMaterialRed : panelMaterialWarm,
    });
    addBox(group, {
      size: [2.36, 0.16, 0.56],
      position: [0, 3.82, z],
      material: trimMaterial,
    });
    lightFixtures.push({ z, index });
  });

  const pointLights = [
    addPointLight(group, 0xffa260, 23, 12, [0, 3.25, 11.5], 2),
    addPointLight(group, 0xff9c5b, 19, 11, [0, 3.25, -3.0], 2),
    addPointLight(group, 0xff8d52, 16, 10, [0, 3.25, -17.5], 2),
  ];
  const flickerLight = pointLights[1];

  const ambient = new THREE.HemisphereLight(0x7f5843, 0x160907, 0.78);
  group.add(ambient);
  const fill = new THREE.PointLight(0xc77546, 8, 27, 2);
  fill.position.set(0, 2.8, 2);
  group.add(fill);
  const endFill = new THREE.PointLight(0xff9254, 9, 15, 1.8);
  endFill.position.set(0, 2.8, -22.5);
  group.add(endFill);

  // -----------------------------------------------------------------------
  // Visual dressing
  // -----------------------------------------------------------------------
  const tunnelPosterGroup = new THREE.Group();
  tunnelPosterGroup.position.set(-2.88, 2.1, 7.8);
  tunnelPosterGroup.rotation.y = Math.PI / 2;
  group.add(tunnelPosterGroup);

  const posterFrameMaterial = new THREE.MeshStandardMaterial({
    color: 0x1e1713,
    roughness: 0.5,
    metalness: 0.45,
  });
  addBox(tunnelPosterGroup, {
    size: [4.3, 2.5, 0.12],
    position: [0, 0, -0.06],
    material: posterFrameMaterial,
  });
  const tunnelPoster = addPlane(tunnelPosterGroup, {
    size: [4.06, 2.28],
    position: [0, 0, 0.02],
    material: new THREE.MeshStandardMaterial({
      map: textures.tunnel,
      roughness: 0.5,
      metalness: 0.05,
      emissive: 0x2a0e06,
      emissiveMap: textures.tunnel,
      emissiveIntensity: 0.38,
    }),
  });
  addBox(tunnelPosterGroup, {
    size: [4.5, 0.06, 0.22],
    position: [0, 1.29, 0.04],
    material: posterFrameMaterial,
  });

  const posterSmallGroup = new THREE.Group();
  posterSmallGroup.position.set(-2.88, 2.05, 14.5);
  posterSmallGroup.rotation.y = Math.PI / 2;
  group.add(posterSmallGroup);
  addBox(posterSmallGroup, {
    size: [2.06, 1.4, 0.1],
    position: [0, 0, -0.06],
    material: posterFrameMaterial,
  });
  addPlane(posterSmallGroup, {
    // 1179 x 760 source -> 1.551 aspect.
    size: [1.86, 1.2],
    position: [0, 0, 0.01],
    material: new THREE.MeshStandardMaterial({
      map: textures.stadiumInterior,
      roughness: 0.6,
      emissive: 0x1d1710,
      emissiveMap: textures.stadiumInterior,
      emissiveIntensity: 0.28,
    }),
  });

  const anniversaryBannerTexture = makeCanvasTexture(1536, 384, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(99,22,12,0.96)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(232,150,92,0.38)";
    ctx.lineWidth = 5;
    ctx.strokeRect(12, 12, w - 24, h - 24);
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f0e3ca";
    ctx.font = '700 118px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText("1993 — 2023", 74, h * 0.43);
    ctx.font = '400 39px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = "rgba(238,194,145,0.7)";
    ctx.fillText("30TH ANNIVERSARY · 荣耀与传承", 78, h * 0.76);
    ctx.textAlign = "right";
    ctx.font = "700 130px serif";
    ctx.fillStyle = "rgba(245,226,193,0.26)";
    ctx.fillText("30", w - 60, h * 0.48);
  }, { anisotropy: maxAnisotropy });
  addPlane(group, {
    size: [6.2, 1.55],
    position: [2.89, 2.55, 3.5],
    rotation: [0, -Math.PI / 2, 0],
    material: new THREE.MeshStandardMaterial({
      map: anniversaryBannerTexture,
      transparent: true,
      roughness: 0.7,
      emissive: 0x240b05,
      emissiveMap: anniversaryBannerTexture,
      emissiveIntensity: 0.4,
    }),
  });

  // Left-side fake doors.
  const fakeDoors = [];
  const makeFakeDoor = (z, label, sub) => {
    const doorGroup = new THREE.Group();
    doorGroup.position.set(-3.0, 0, z);
    group.add(doorGroup);
    addBox(doorGroup, {
      size: [0.14, 2.8, 2.35],
      position: [0.08, 1.4, 0],
      material: darkMaterial,
    });
    addBox(doorGroup, {
      size: [0.18, 2.9, 0.14],
      position: [0.06, 1.45, -1.25],
      material: trimMaterial,
    });
    addBox(doorGroup, {
      size: [0.18, 2.9, 0.14],
      position: [0.06, 1.45, 1.25],
      material: trimMaterial,
    });
    const signTexture = createTextTexture(label, {
      width: 512,
      height: 128,
      background: "#0c0907",
      color: "#d9cbb1",
      accent: "#a43b24",
      fontSize: 38,
      subtext: sub,
      subFontSize: 14,
    });
    addPlane(doorGroup, {
      size: [1.0, 0.25],
      position: [0.19, 3.02, 0],
      rotation: [0, Math.PI / 2, 0],
      material: new THREE.MeshBasicMaterial({ map: signTexture, toneMapped: false }),
    });
    fakeDoors.push(doorGroup);
    return doorGroup;
  };
  const equipmentDoor = makeFakeDoor(2.2, "器材室", "EQUIPMENT");
  const dressingDoor = makeFakeDoor(-14.2, "更衣室", "DRESSING ROOM");

  // Club marks and small direction signs.
  const clubMarkTexture = makeCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(231,210,178,0.4)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(w / 2, 64);
    ctx.lineTo(w - 90, 124);
    ctx.lineTo(w - 120, 338);
    ctx.quadraticCurveTo(w / 2, 452, 120, 338);
    ctx.lineTo(90, 124);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "rgba(237,218,188,0.65)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 110px Georgia, serif";
    ctx.fillText("HOME", w / 2, h * 0.52);
    ctx.font = '400 28px "Microsoft YaHei", sans-serif';
    ctx.fillText("山东T山", w / 2, h * 0.67);
  });
  addPlane(group, {
    size: [1.6, 1.6],
    position: [-2.9, 2.1, -2.5],
    rotation: [0, Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({
      map: clubMarkTexture,
      transparent: true,
      toneMapped: false,
      color: 0xcbb18e,
    }),
  });

  const directionSignTexture = createTextTexture("南出口 →", {
    width: 1024,
    height: 200,
    background: "#0b0a08",
    color: "#d8ccb8",
    fontSize: 64,
    subtext: "SOUTH EXIT · 直行 35m",
    subFontSize: 23,
  });
  addPlane(group, {
    size: [2.6, 0.5],
    position: [2.9, 2.45, 11.4],
    rotation: [0, -Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({ map: directionSignTexture, toneMapped: false }),
  });

  // Loop display.
  const loopDisplay = createLoopDisplay(0);
  const displayMesh = addPlane(group, {
    size: [1.12, 0.56],
    position: [2.88, 1.65, 12.8],
    rotation: [0, -Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({
      map: loopDisplay.texture,
      toneMapped: false,
    }),
  });

  // Chair anomaly, first appears after one circuit.
  const chair = new THREE.Group();
  chair.position.set(0, 0, -12.3);
  chair.rotation.y = 0.3;
  chair.visible = false;
  group.add(chair);
  const chairMaterial = new THREE.MeshStandardMaterial({ color: 0x241b15, roughness: 0.6, metalness: 0.3 });
  addBox(chair, { size: [0.58, 0.07, 0.54], position: [0, 0.46, 0], material: chairMaterial });
  addBox(chair, { size: [0.58, 0.7, 0.07], position: [0, 0.82, -0.25], material: chairMaterial });
  addBox(chair, { size: [0.06, 0.45, 0.06], position: [-0.24, 0.22, -0.22], material: chairMaterial });
  addBox(chair, { size: [0.06, 0.45, 0.06], position: [0.24, 0.22, -0.22], material: chairMaterial });
  addBox(chair, { size: [0.06, 0.45, 0.06], position: [-0.24, 0.22, 0.22], material: chairMaterial });
  addBox(chair, { size: [0.06, 0.45, 0.06], position: [0.24, 0.22, 0.22], material: chairMaterial });

  // Dust.
  const dustCount = 260;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    dustPositions[i * 3] = range(Math.random, -2.5, 2.5);
    dustPositions[i * 3 + 1] = range(Math.random, 0.2, 3.5);
    dustPositions[i * 3 + 2] = range(Math.random, -25, 17);
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      color: 0xe1c7a3,
      size: 0.028,
      transparent: true,
      opacity: 0.23,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(dust);

  // -----------------------------------------------------------------------
  // Honours room doorway
  // -----------------------------------------------------------------------
  const galleryDoorGroup = new THREE.Group();
  galleryDoorGroup.position.set(3.06, 1.43, -7.0);
  group.add(galleryDoorGroup);
  const galleryDoor = addBox(galleryDoorGroup, {
    size: [0.12, 2.85, 2.35],
    position: [0, 0, 0],
    material: new THREE.MeshStandardMaterial({
      color: 0x7f2a1a,
      roughness: 0.52,
      metalness: 0.34,
    }),
  });
  addBox(galleryDoorGroup, {
    size: [0.16, 0.12, 0.28],
    position: [-0.08, 0.1, 0.82],
    material: trimMaterial,
  });
  const galleryDoorCollider = addCollider(colliders, 2.88, 3.23, -8.3, -5.7, {
    name: "galleryDoor",
    maxY: 3.0,
  });

  addBox(group, {
    size: [0.22, 3.1, 0.22],
    position: [3.1, 1.55, -8.35],
    material: trimMaterial,
  });
  addBox(group, {
    size: [0.22, 3.1, 0.22],
    position: [3.1, 1.55, -5.65],
    material: trimMaterial,
  });
  addBox(group, {
    size: [0.22, 0.22, 2.92],
    position: [3.1, 3.05, -7.0],
    material: trimMaterial,
  });

  const gallerySignTexture = createTextTexture("荣誉室", {
    width: 1024,
    height: 256,
    background: "#1a0804",
    color: "#f2e4ca",
    accent: "#d2602d",
    fontSize: 82,
    subtext: "HONOURS ROOM · 山东T山冠军展厅",
    subFontSize: 23,
  });
  const gallerySign = addPlane(group, {
    size: [2.65, 0.66],
    position: [2.87, 3.35, -7.0],
    rotation: [0, -Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({ map: gallerySignTexture, toneMapped: false }),
  });

  // Alcove beyond the door.
  addBox(group, {
    size: [1.5, 3.3, 2.4],
    position: [3.9, 1.65, -7.0],
    material: darkMaterial,
  });
  const alcoveGlow = addPlane(group, {
    size: [2.2, 2.7],
    position: [4.58, 1.45, -7.0],
    rotation: [0, -Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({
      color: 0x9e351e,
      transparent: true,
      opacity: 0,
      toneMapped: false,
    }),
  });
  const alcoveLight = new THREE.PointLight(0xff7a3b, 0, 9, 1.8);
  alcoveLight.position.set(3.65, 2.15, -7.0);
  group.add(alcoveLight);
  const alcoveSpill = new THREE.PointLight(0xff9a5a, 0, 8, 2);
  alcoveSpill.position.set(2.8, 1.2, -7.0);
  group.add(alcoveSpill);
  addCollider(colliders, 4.28, 4.55, -8.4, -5.6, { name: "alcoveBack", maxY: 3.2 });
  addCollider(colliders, 3.2, 4.5, -8.45, -8.15, { name: "alcoveSideA", maxY: 3.2 });
  addCollider(colliders, 3.2, 4.5, -5.85, -5.55, { name: "alcoveSideB", maxY: 3.2 });

  // -----------------------------------------------------------------------
  // End assembly (moves subtly on each loop)
  // -----------------------------------------------------------------------
  const endAssembly = new THREE.Group();
  endAssembly.position.set(0, 0, -26);
  group.add(endAssembly);

  const endWallMaterial = new THREE.MeshStandardMaterial({
    map: wallTexture,
    roughness: 0.62,
    color: 0xb19282,
  });
  addBox(endAssembly, {
    size: [1.0, 3.8, 0.28],
    position: [-2.6, 1.9, 0],
    material: endWallMaterial,
  });
  addBox(endAssembly, {
    size: [1.0, 3.8, 0.28],
    position: [2.6, 1.9, 0],
    material: endWallMaterial,
  });
  addBox(endAssembly, {
    size: [4.2, 0.8, 0.28],
    position: [0, 3.4, 0],
    material: endWallMaterial,
  });

  const endDoorPivotL = new THREE.Group();
  endDoorPivotL.position.set(-2.1, 0, -0.08);
  endAssembly.add(endDoorPivotL);
  const endDoorPivotR = new THREE.Group();
  endDoorPivotR.position.set(2.1, 0, -0.08);
  endAssembly.add(endDoorPivotR);

  const endDoorMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a261c,
    roughness: 0.54,
    metalness: 0.38,
    emissive: 0x110503,
    emissiveIntensity: 0.3,
  });
  addBox(endDoorPivotL, {
    size: [2.08, 3.0, 0.14],
    position: [1.04, 1.5, 0],
    material: endDoorMaterial,
  });
  addBox(endDoorPivotR, {
    size: [2.08, 3.0, 0.14],
    position: [-1.04, 1.5, 0],
    material: endDoorMaterial,
  });
  addBox(endDoorPivotL, {
    size: [0.32, 0.08, 0.08],
    position: [1.82, 1.42, 0.1],
    material: trimMaterial,
  });
  addBox(endDoorPivotR, {
    size: [0.32, 0.08, 0.08],
    position: [-1.82, 1.42, 0.1],
    material: trimMaterial,
  });

  const exitSignTexture = createTextTexture("出口", {
    width: 1024,
    height: 256,
    background: "#05110a",
    color: "#64e397",
    accent: "#3ac276",
    fontSize: 92,
    subtext: "EXIT · 球员通道",
    subFontSize: 24,
  });
  const exitSign = addPlane(endAssembly, {
    size: [3.05, 0.76],
    position: [0, 3.48, 0.16],
    material: new THREE.MeshBasicMaterial({ map: exitSignTexture, toneMapped: false }),
  });
  const exitSignLight = new THREE.PointLight(0x51d88c, 2.4, 7, 2);
  exitSignLight.position.set(0, 3.1, 1.0);
  endAssembly.add(exitSignLight);
  const endDoorGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0x9e3e26,
    toneMapped: false,
  });
  addBox(endAssembly, {
    size: [0.06, 2.65, 0.06],
    position: [-2.1, 1.4, 0.15],
    material: endDoorGlowMaterial,
  });
  addBox(endAssembly, {
    size: [0.06, 2.65, 0.06],
    position: [2.1, 1.4, 0.15],
    material: endDoorGlowMaterial,
  });
  const endDoorLight = new THREE.PointLight(0xff9a5d, 7, 9, 1.8);
  endDoorLight.position.set(0, 3.0, 1.4);
  endAssembly.add(endDoorLight);

  // Small vestibule beyond the door.
  addBox(group, {
    size: [4.4, 0.1, 3.2],
    position: [0, 0.02, -27.8],
    material: floorMaterial,
  });
  addBox(group, {
    size: [4.4, 3.8, 0.22],
    position: [0, 1.9, -29.5],
    material: darkMaterial,
  });
  addBox(group, {
    size: [0.2, 3.8, 3.2],
    position: [-2.2, 1.9, -27.8],
    material: darkMaterial,
  });
  addBox(group, {
    size: [0.2, 3.8, 3.2],
    position: [2.2, 1.9, -27.8],
    material: darkMaterial,
  });

  const endDoorCollider = addCollider(colliders, -2.15, 2.15, -26.2, -25.82, {
    name: "corridorEndDoor",
    maxY: 3.2,
  });
  const endSideLCollider = addCollider(colliders, -3.1, -2.05, -26.2, -25.82, {
    name: "corridorEndL",
    maxY: 3.2,
  });
  const endSideRCollider = addCollider(colliders, 2.05, 3.1, -26.2, -25.82, {
    name: "corridorEndR",
    maxY: 3.2,
  });
  addCollider(colliders, -3.1, 3.1, 17.95, 18.35, { name: "corridorStart", maxY: 3.2 });
  addCollider(colliders, -3.3, -2.9, -26, 18, { name: "corridorWallL", maxY: 3.8 });
  addCollider(colliders, 2.9, 3.3, -5.8, 18, { name: "corridorWallR1", maxY: 3.8 });
  addCollider(colliders, 2.9, 3.3, -26, -8.2, { name: "corridorWallR2", maxY: 3.8 });

  // -----------------------------------------------------------------------
  // State and animations
  // -----------------------------------------------------------------------
  let loopCount = 0;
  let galleryOpen = false;
  let galleryDoorProgress = 0;
  let endOpen = false;
  let endDoorProgress = 0;
  let mood = "loop";
  let elapsedLocal = 0;

  const updateEndColliders = () => {
    const z = endAssembly.position.z;
    for (const collider of [endDoorCollider, endSideLCollider, endSideRCollider]) {
      collider.minZ = z - 0.22;
      collider.maxZ = z + 0.18;
    }
    endDoorCollider.active = !endOpen;
  };

  const setLoop = (count) => {
    loopCount = count;
    const offset = Math.min(count, 4) * 1.35;
    endAssembly.position.z = -26 + offset;
    updateEndColliders();
    loopDisplay.draw(count);
    loopDisplay.texture.needsUpdate = true;

    if (count >= 1) {
      chair.visible = true;
      wallMaterial.color.setHex(0xd4b5a8);
      upperWallMaterial.color.setHex(0x9a7b6f);
      panelMaterialWarm.color.setHex(0xffae6d);
      flickerLight.intensity = 5 + Math.random() * 6;
      equipmentDoor.position.z = 1.4;
      tunnelPosterGroup.position.z = 8.9;
      posterSmallGroup.position.z = 14.1;
    }
    if (count >= 2) {
      wallMaterial.color.setHex(0xb98579);
      upperWallMaterial.color.setHex(0x70534a);
      panelMaterialWarm.color.setHex(0xd27a48);
      panelMaterialRed.color.setHex(0x881f13);
      pointLights[0].intensity = 13;
      pointLights[2].intensity = 8.5;
      endFill.intensity = 5.5;
      dressingDoor.position.z = -16.0;
      anniversaryBannerTexture.offset.x = 0.12;
    }
    if (count >= 3) {
      wallMaterial.color.setHex(0x91594f);
      upperWallMaterial.color.setHex(0x553a33);
      panelMaterialWarm.color.setHex(0xc34c2c);
      flickerLight.intensity = 3;
      ambient.intensity = 0.38;
      fill.intensity = 2.4;
      exitSign.material.color.setHex(0xd18b61);
    }
    if (count >= 4) {
      wallMaterial.color.setHex(0x6a3b34);
      panelMaterialWarm.color.setHex(0x892e1d);
      pointLights[0].intensity = 8;
      pointLights[2].intensity = 4.5;
      exitSign.material.color.setHex(0xa85d3f);
    }
  };

  const unlockGallery = () => {
    galleryOpen = true;
    gallerySign.material.color.setHex(0xffc79e);
    alcoveLight.intensity = 9;
  };

  const openEnd = () => {
    endOpen = true;
    endDoorCollider.active = false;
    exitSign.material.color.setHex(0x83ffb3);
    exitSignLight.intensity = 5;
  };

  const setMood = (nextMood) => {
    mood = nextMood;
    if (nextMood === "broken") {
      wallMaterial.color.setHex(0x6e3a32);
      upperWallMaterial.color.setHex(0x4d312d);
      pointLights.forEach((light, index) => {
        light.intensity = [10, 8, 6][index] ?? 5;
      });
      ambient.intensity = 0.58;
      fill.intensity = 5.5;
      endFill.intensity = 12;
      panelMaterialWarm.color.setHex(0xb04428);
      alcoveGlow.material.opacity = 0;
      alcoveLight.intensity = 0;
      chair.visible = false;
      galleryOpen = false;
      galleryDoorCollider.active = true;
    }
  };

  // -----------------------------------------------------------------------
  // Passive encounter: Wu Lei is waiting in the tunnel, not in the stadium
  // -----------------------------------------------------------------------
  const tunnelWuLei = createLowPolyPerson({
    jersey: 0xb72b24,
    shorts: 0xe8e5da,
    skin: 0x9b7258,
    hair: 0x101112,
    accent: 0xe8c56b,
    number: 7,
    name: "武L",
  });
  tunnelWuLei.position.set(2.15, 0, -1.5);
  tunnelWuLei.rotation.y = 0;
  tunnelWuLei.visible = false;
  group.add(tunnelWuLei);
  const tunnelWuLeiSign = createTextTexture("武L", {
    width: 1024,
    height: 256,
    background: "#0b0c0c",
    color: "#e5d9c1",
    accent: "#b72b24",
    fontSize: 76,
    subtext: "7 · 通道尽头 · 单刀",
    subFontSize: 22,
  });
  addPlane(tunnelWuLei, {
    size: [0.95, 0.24],
    position: [0, 0.18, 0.62],
    rotation: [-Math.PI / 2, 0, 0],
    material: new THREE.MeshBasicMaterial({ map: tunnelWuLeiSign, toneMapped: false }),
  });
  const tunnelWuLeiBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xe7e2d5, roughness: 0.78 }),
  );
  tunnelWuLeiBall.position.set(0.45, 0.12, 0.35);
  tunnelWuLei.add(tunnelWuLeiBall);
  const tunnelWuLeiLight = new THREE.PointLight(0xd45a3a, 1.4, 4.2, 2);
  tunnelWuLeiLight.position.set(0, 2.2, 0.4);
  tunnelWuLei.add(tunnelWuLeiLight);
  let tunnelWuLeiSeen = false;

  area.update = (dt, elapsed) => {
    const step = Math.min(dt, 0.05);
    animateLowPolyPerson(tunnelWuLei, elapsed, { amount: tunnelWuLei.visible ? 0.9 : 0, phase: 0.9 });
    if (tunnelWuLei.visible) {
      tunnelWuLeiBall.position.y = 0.12 + Math.abs(Math.sin(elapsed * 2.1)) * 0.22;
      tunnelWuLeiBall.rotation.x = elapsed * 1.7;
      const head = tunnelWuLei.userData.rig?.head;
      if (head && area.player) {
        const target = Math.atan2(area.player.position.x - tunnelWuLei.position.x, area.player.position.z - tunnelWuLei.position.z);
        head.rotation.y += (target - head.rotation.y) * 0.06;
      }
    }
    elapsedLocal = elapsed;

    galleryDoorProgress += ((galleryOpen ? 1 : 0) - galleryDoorProgress) * Math.min(1, step * 3.2);
    galleryDoorGroup.position.z = -7.0 + galleryDoorProgress * 2.65;
    galleryDoorCollider.active = galleryDoorProgress < 0.55;
    alcoveGlow.material.opacity = galleryDoorProgress * 0.5;
    alcoveLight.intensity = galleryDoorProgress * 24;
    alcoveSpill.intensity = galleryDoorProgress * 16;

    endDoorProgress += ((endOpen ? 1 : 0) - endDoorProgress) * Math.min(1, step * 2.2);
    endDoorPivotL.rotation.y = endDoorProgress * 1.35;
    endDoorPivotR.rotation.y = -endDoorProgress * 1.35;

    // Flickering fluorescent fixture.
    const basePanel = loopCount >= 3 ? 0xc34c2c : 0xffc48a;
    if (Math.sin(elapsed * 0.7 + 1.4) > 0.94 || (loopCount >= 1 && Math.random() < step * 0.8)) {
      flickerLight.intensity = Math.random() * 2;
      panelMaterialWarm.color.setHex(0x6e4a33);
    } else {
      flickerLight.intensity = mood === "broken" ? 7 : 18;
      panelMaterialWarm.color.setHex(basePanel);
    }
    fill.intensity = (mood === "broken" ? 5.5 : 8) + Math.sin(elapsed * 1.1) * 0.2;

    // Subtle sign glow.
    exitSignLight.intensity = (endOpen ? 4.2 : 1.6) + Math.sin(elapsed * 2.0) * 0.22;
    if (!tunnelWuLeiSeen && area.player && area.player.position.z < 4.2) {
      tunnelWuLeiSeen = true;
      tunnelWuLei.visible = true;
      area.onWuLeiAppear?.();
    }

    dust.rotation.y = Math.sin(elapsed * 0.09) * 0.05;
    for (let i = 0; i < dustCount; i += 1) {
      dustGeometry.attributes.position.array[i * 3 + 1] += step * 0.02;
      if (dustGeometry.attributes.position.array[i * 3 + 1] > 3.7) {
        dustGeometry.attributes.position.array[i * 3 + 1] = 0.15;
      }
    }
    dustGeometry.attributes.position.needsUpdate = true;

    // The chair is just slightly wrong.
    if (chair.visible) {
      chair.rotation.y = 0.3 + Math.sin(elapsed * 0.17) * 0.025;
    }
  };

  interactables.push({
    object: tunnelWuLei,
    getLabel: () => "和武L说话",
    range: 3.0,
    enabled: () => tunnelWuLei.visible,
    onInteract: () => area.onWuLeiInteract?.(),
  });

  area.setLoop = setLoop;
  area.unlockGallery = unlockGallery;
  area.openEnd = openEnd;
  area.setMood = setMood;
  area.isGalleryOpen = () => galleryOpen;
  area.isEndOpen = () => endOpen;
  area.setPlayer = (player) => { area.player = player; };
  area.getEndZ = () => endAssembly.position.z;
  area.setEndLabel = (text) => {
    exitSign.material.map = createTextTexture(text, {
      width: 1024,
      height: 256,
      background: "#05110a",
      color: "#64e397",
      accent: "#3ac276",
      fontSize: 88,
      subtext: "EXIT · 球员通道",
      subFontSize: 22,
    });
    exitSign.material.needsUpdate = true;
  };

  // -----------------------------------------------------------------------
  // Staff elevator branch. It is a wall-mounted call door; pressing E moves
  // the player into the separate elevator lobby without cutting a hole in the
  // existing looping tunnel.
  // -----------------------------------------------------------------------
  const elevatorDoorGroup = new THREE.Group();
  elevatorDoorGroup.position.set(2.88, 0, 4.8);
  group.add(elevatorDoorGroup);
  addBox(elevatorDoorGroup, {
    size: [0.1, 2.55, 1.65],
    position: [0, 1.28, 0],
    material: new THREE.MeshStandardMaterial({ color: 0x1d1b18, roughness: 0.34, metalness: 0.55 }),
  });
  addBox(elevatorDoorGroup, {
    size: [0.12, 2.7, 0.12],
    position: [-0.01, 1.35, -0.9],
    material: trimMaterial,
  });
  addBox(elevatorDoorGroup, {
    size: [0.12, 2.7, 0.12],
    position: [-0.01, 1.35, 0.9],
    material: trimMaterial,
  });
  addBox(elevatorDoorGroup, {
    size: [0.03, 2.38, 0.025],
    position: [-0.06, 1.28, 0],
    material: new THREE.MeshStandardMaterial({ color: 0x5f5142, roughness: 0.5, metalness: 0.3 }),
  });
  const elevatorSignTexture = createTextTexture("员工电梯", {
    width: 1024,
    height: 256,
    background: "#07110b",
    color: "#cfe8c9",
    accent: "#4e9f68",
    fontSize: 72,
    subtext: "STAFF LIFT · 01",
    subFontSize: 22,
  });
  addPlane(elevatorDoorGroup, {
    size: [1.45, 0.36],
    position: [-0.075, 2.88, 0],
    rotation: [0, -Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({ map: elevatorSignTexture, toneMapped: false }),
  });
  addBox(elevatorDoorGroup, {
    size: [0.08, 0.32, 0.22],
    position: [-0.09, 1.16, 1.02],
    material: trimMaterial,
  });
  addCylinder(elevatorDoorGroup, {
    radiusTop: 0.035,
    radiusBottom: 0.035,
    height: 0.025,
    position: [-0.15, 1.16, 1.02],
    rotation: [0, 0, Math.PI / 2],
    material: new THREE.MeshStandardMaterial({ color: 0xc8b18b, roughness: 0.3, metalness: 0.24, emissive: 0x49321e, emissiveIntensity: 0.5 }),
  });
  addPointLight(group, 0x6bcf91, 1.6, 3.4, [2.52, 2.75, 4.8]);

  // -----------------------------------------------------------------------
  // LEAGUE VAR review monitor
  // -----------------------------------------------------------------------
  const varMonitor = new THREE.Group();
  varMonitor.position.set(2.78, 0, -18.3);
  group.add(varMonitor);
  addBox(varMonitor, {
    size: [0.14, 1.12, 1.8],
    position: [0, 1.65, 0],
    material: new THREE.MeshStandardMaterial({ color: 0x11100d, roughness: 0.42, metalness: 0.5 }),
  });
  const varScreenTexture = createTextTexture("VAR", {
    width: 1024,
    height: 512,
    background: "#080705",
    color: "#f0e8d4",
    accent: "#c4402a",
    fontSize: 150,
    subtext: "顶级联赛 · 视频助理裁判 / 90+6",
    subFontSize: 34,
  });
  addPlane(varMonitor, {
    size: [1.46, 0.78],
    position: [-0.09, 1.65, 0],
    rotation: [0, -Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({ map: varScreenTexture, toneMapped: false, side: THREE.DoubleSide }),
  });
  const varLight = new THREE.PointLight(0xc33a25, 2.5, 5.5, 2);
  varLight.position.set(-0.35, 2.35, 0);
  varMonitor.add(varLight);

  // -----------------------------------------------------------------------
  // Cryzan's match-worn shirt outside the home dressing room
  // -----------------------------------------------------------------------
  const cryzanJerseyTexture = makeCanvasTexture(512, 768, (ctx, w, h) => {
    ctx.fillStyle = "#d95a20";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    for (let y = 0; y < h; y += 6) ctx.fillRect(0, y, w, 2);
    ctx.strokeStyle = "#f0dfb8";
    ctx.lineWidth = 8;
    ctx.strokeRect(20, 20, w - 40, h - 40);
    ctx.fillStyle = "#f4ead4";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 210px Georgia, serif";
    ctx.fillText("9", w / 2, h * 0.4);
    ctx.font = '700 66px "Microsoft YaHei", sans-serif';
    ctx.fillText("克雷S", w / 2, h * 0.62);
    ctx.font = '400 27px "Microsoft YaHei", sans-serif';
    ctx.fillText("SHANDONG HOME · HOME", w / 2, h * 0.78);
    ctx.fillStyle = "rgba(40,20,10,0.55)";
    ctx.beginPath();
    ctx.ellipse(w * 0.68, h * 0.72, 42, 18, 0.2, 0, Math.PI * 2);
    ctx.fill();
  });
  const cryzanJersey = addPlane(group, {
    size: [0.62, 0.92],
    position: [-2.86, 1.55, -12.7],
    rotation: [0, Math.PI / 2, 0],
    material: new THREE.MeshBasicMaterial({
      map: cryzanJerseyTexture,
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  });
  addBox(group, {
    size: [0.05, 0.02, 0.58],
    position: [-2.86, 2.04, -12.7],
    material: trimMaterial,
  });
  addPointLight(group, 0xf07a35, 0.25, 2.0, [-2.5, 2.0, -12.7]);


  // -----------------------------------------------------------------------
  // Interaction wiring
  // -----------------------------------------------------------------------
  interactables.push(
    {
      object: endDoorPivotL,
      getLabel: () => (endOpen ? "穿过出口" : "推开出口门"),
      range: 3.0,
      onInteract: () => area.onEndDoorInteract?.(),
    },
    {
      object: endDoorPivotR,
      getLabel: () => (endOpen ? "穿过出口" : "推开出口门"),
      range: 3.0,
      onInteract: () => area.onEndDoorInteract?.(),
    },
    {
      object: galleryDoor,
      getLabel: () => (galleryOpen ? "进入荣誉展厅" : "查看荣誉室的门"),
      range: 3.0,
      onInteract: () => area.onGalleryDoorInteract?.(),
    },
    {
      object: gallerySign,
      getLabel: () => (galleryOpen ? "进入荣誉展厅" : "查看荣誉室的标牌"),
      range: 3.2,
      onInteract: () => area.onGalleryDoorInteract?.(),
    },
    {
      object: tunnelPoster,
      label: "端详通道照片",
      range: 3.0,
      onInteract: () => area.onPosterInteract?.(),
    },
    {
      object: equipmentDoor,
      label: "查看器材室",
      range: 3.0,
      onInteract: () => area.onFakeDoorInteract?.("器材室"),
    },
    {
      object: dressingDoor,
      label: "查看更衣室",
      range: 3.0,
      onInteract: () => area.onFakeDoorInteract?.("更衣室"),
    },
    {
      object: displayMesh,
      label: "查看回路计数器",
      range: 3.0,
      onInteract: () => area.onLoopDisplayInteract?.(),
    },
    {
      object: returnDoor,
      label: "试着推门",
      range: 3.0,
      onInteract: () => area.onReturnDoorInteract?.(),
    },
    {
      object: elevatorDoorGroup,
      label: "进入员工电梯",
      range: 3.0,
      onInteract: () => area.onElevatorInteract?.(),
    },
    {
      object: varMonitor,
      label: "查看VAR回放",
      range: 3.2,
      onInteract: () => area.onVarInteract?.(),
    },
    {
      object: cryzanJersey,
      label: "查看9号球衣",
      range: 3.0,
      onInteract: () => area.onJerseyInteract?.(),
    },
  );

  area._debug = {
    endAssembly,
    galleryDoorGroup,
    endDoorPivotL,
    endDoorPivotR,
    pointLights,
  };

  return area;
}
