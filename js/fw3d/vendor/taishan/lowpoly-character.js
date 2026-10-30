import * as THREE from "three";
import { addBox, createTextTexture, makeCanvasTexture } from "./utils.js";

/**
 * A deliberately blocky, low-poly character used by every human in the
 * stadium. Keeping the proportions and flat materials identical makes the
 * real players (Wang Gang, Cryzan) feel like they belong to the same haunted
 * arcade cabinet as the crowd figures.
 */
export function createLowPolyPerson({
  jersey = 0x2f5e42,
  shorts = 0xefeee4,
  skin = 0x9e7358,
  hair = 0x101112,
  accent = 0xd7c08d,
  number = null,
  name = "",
  numberColor = "#f6ecd6",
  nameColor = "#f4ead4",
  scale = 1,
} = {}) {
  const group = new THREE.Group();
  const jerseyMaterial = new THREE.MeshStandardMaterial({
    color: jersey,
    roughness: 0.82,
    metalness: 0.02,
  });
  const shortsMaterial = new THREE.MeshStandardMaterial({
    color: shorts,
    roughness: 0.88,
  });
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: skin,
    roughness: 0.84,
  });
  const hairMaterial = new THREE.MeshStandardMaterial({
    color: hair,
    roughness: 0.98,
  });
  const bootMaterial = new THREE.MeshStandardMaterial({
    color: 0x141210,
    roughness: 0.92,
  });

  const leftLeg = new THREE.Group();
  leftLeg.position.set(-0.16, 0.8, 0);
  group.add(leftLeg);
  const leftLegMesh = addBox(leftLeg, {
    size: [0.22, 0.3, 0.24],
    position: [0, -0.15, 0],
    material: shortsMaterial,
  });
  addBox(leftLeg, {
    size: [0.19, 0.52, 0.2],
    position: [0, -0.56, 0],
    material: skinMaterial,
  });
  addBox(leftLeg, {
    size: [0.22, 0.22, 0.21],
    position: [0, -0.72, 0.01],
    material: bootMaterial,
  });
  addBox(leftLeg, {
    size: [0.24, 0.13, 0.34],
    position: [0, -0.8, 0.04],
    material: bootMaterial,
  });

  const rightLeg = new THREE.Group();
  rightLeg.position.set(0.16, 0.8, 0);
  group.add(rightLeg);
  const rightLegMesh = addBox(rightLeg, {
    size: [0.22, 0.3, 0.24],
    position: [0, -0.15, 0],
    material: shortsMaterial,
  });
  addBox(rightLeg, {
    size: [0.19, 0.52, 0.2],
    position: [0, -0.56, 0],
    material: skinMaterial,
  });
  addBox(rightLeg, {
    size: [0.22, 0.22, 0.21],
    position: [0, -0.72, 0.01],
    material: bootMaterial,
  });
  addBox(rightLeg, {
    size: [0.24, 0.13, 0.34],
    position: [0, -0.8, 0.04],
    material: bootMaterial,
  });

  const torso = addBox(group, {
    size: [0.7, 0.82, 0.38],
    position: [0, 1.22, 0],
    material: jerseyMaterial,
  });
  addBox(group, {
    size: [0.64, 0.22, 0.4],
    position: [0, 0.83, 0],
    material: shortsMaterial,
  });

  const leftArm = new THREE.Group();
  leftArm.position.set(-0.45, 1.55, 0);
  group.add(leftArm);
  addBox(leftArm, {
    size: [0.18, 0.62, 0.2],
    position: [0, -0.3, 0],
    material: jerseyMaterial,
  });
  addBox(leftArm, {
    size: [0.17, 0.16, 0.2],
    position: [0, -0.64, 0.02],
    material: skinMaterial,
  });

  const rightArm = new THREE.Group();
  rightArm.position.set(0.45, 1.55, 0);
  group.add(rightArm);
  addBox(rightArm, {
    size: [0.18, 0.62, 0.2],
    position: [0, -0.3, 0],
    material: jerseyMaterial,
  });
  addBox(rightArm, {
    size: [0.17, 0.16, 0.2],
    position: [0, -0.64, 0.02],
    material: skinMaterial,
  });

  const head = new THREE.Group();
  head.position.set(0, 1.86, 0);
  group.add(head);
  addBox(head, {
    size: [0.32, 0.34, 0.3],
    position: [0, 0, 0],
    material: skinMaterial,
  });
  addBox(head, {
    size: [0.36, 0.1, 0.34],
    position: [0, 0.22, 0],
    material: hairMaterial,
  });
  addBox(head, {
    size: [0.08, 0.08, 0.015],
    position: [-0.08, 0.02, 0.155],
    material: new THREE.MeshBasicMaterial({ color: 0x17100c }),
  });
  addBox(head, {
    size: [0.08, 0.08, 0.015],
    position: [0.08, 0.02, 0.155],
    material: new THREE.MeshBasicMaterial({ color: 0x17100c }),
  });
  addBox(head, {
    size: [0.12, 0.018, 0.015],
    position: [0, -0.09, 0.155],
    material: new THREE.MeshBasicMaterial({ color: 0x3e2218 }),
  });

  // A simple number placard on both sides of the torso. It is intentionally
  // low-resolution, like the rest of the NPCs.
  if (number !== null) {
    const numberTexture = createTextTexture(String(number), {
      width: 256,
      height: 256,
      background: "#00000000",
      color: numberColor,
      accent,
      fontSize: 118,
      subtext: "",
      subFontSize: 1,
      transparent: true,
    });
    addBox(group, {
      size: [0.26, 0.26, 0.012],
      position: [0, 1.28, 0.2],
      material: new THREE.MeshBasicMaterial({ map: numberTexture, transparent: true, toneMapped: false }),
    });
    addBox(group, {
      size: [0.26, 0.26, 0.012],
      position: [0, 1.28, -0.2],
      rotation: [0, Math.PI, 0],
      material: new THREE.MeshBasicMaterial({ map: numberTexture, transparent: true, toneMapped: false }),
    });
  }

  if (name) {
    const nameTexture = makeCanvasTexture(512, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = nameColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = '700 58px "Microsoft YaHei", "PingFang SC", sans-serif';
      ctx.fillText(name, w / 2, h / 2);
    });
    addBox(group, {
      size: [0.5, 0.14, 0.012],
      position: [0, 1.46, -0.201],
      rotation: [0, Math.PI, 0],
      material: new THREE.MeshBasicMaterial({
        map: nameTexture,
        transparent: true,
        toneMapped: false,
      }),
    });
  }

  group.scale.setScalar(scale);
  group.userData.rig = {
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
    head,
    torso,
    leftLegMesh,
    rightLegMesh,
  };
  return group;
}


export function animateLowPolyPerson(group, elapsed, { amount = 1, phase = 0 } = {}) {
  if (!group?.userData?.rig) return;
  const rig = group.userData.rig;
  const t = elapsed + phase;
  const breath = Math.sin(t * 1.55) * 0.012 * amount;
  if (rig.torso) rig.torso.scale.y = 1 + breath;
  if (rig.leftArm) rig.leftArm.rotation.x = -0.035 + Math.sin(t * 1.2) * 0.035 * amount;
  if (rig.rightArm) rig.rightArm.rotation.x = 0.035 - Math.sin(t * 1.2 + 0.7) * 0.035 * amount;
  if (rig.head) rig.head.rotation.x = Math.sin(t * 0.83) * 0.018 * amount;
  group.rotation.z = Math.sin(t * 0.57) * 0.008 * amount;
}
