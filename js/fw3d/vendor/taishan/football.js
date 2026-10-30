import * as THREE from "three";
import { makeCanvasTexture } from "./utils.js";

function createBallTexture() {
  return makeCanvasTexture(1024, 512, (ctx, w, h) => {
    ctx.fillStyle = "#ded9ce";
    ctx.fillRect(0, 0, w, h);
    const random = (() => {
      let seed = 1467;
      return () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
    })();

    ctx.fillStyle = "rgba(140,132,120,0.13)";
    for (let i = 0; i < 1600; i += 1) {
      ctx.fillRect(random() * w, random() * h, 1 + random() * 2, 1 + random() * 2);
    }

    const drawPentagon = (cx, cy, radius, rotation = 0) => {
      ctx.beginPath();
      for (let i = 0; i < 5; i += 1) {
        const angle = rotation + (i / 5) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    };

    ctx.fillStyle = "#151719";
    const spots = [
      [80, 95, 45],
      [260, 360, 50],
      [450, 100, 46],
      [645, 330, 52],
      [840, 100, 48],
      [980, 380, 46],
      [120, 430, 42],
      [520, 250, 36],
      [730, 430, 35],
      [360, 70, 35],
    ];
    spots.forEach(([x, y, r], index) => drawPentagon(x, y, r, index * 0.3));

    ctx.strokeStyle = "rgba(24,24,25,0.55)";
    ctx.lineWidth = 3;
    for (let i = 0; i < 14; i += 1) {
      const x = random() * w;
      const y = random() * h;
      ctx.beginPath();
      ctx.arc(x, y, 60 + random() * 70, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, { wrap: THREE.RepeatWrapping });
}

function createShadowTexture() {
  return makeCanvasTexture(128, 128, (ctx, w, h) => {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, "rgba(0,0,0,0.62)");
    gradient.addColorStop(0.5, "rgba(0,0,0,0.25)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  });
}

export class Football {
  constructor({ camera, player, sound, sceneManager }) {
    this.camera = camera;
    this.player = player;
    this.sound = sound;
    this.sceneManager = sceneManager;
    this.radius = 0.22;
    this.active = true;
    this.scored = false;
    this.velocity = new THREE.Vector3();
    this.colliders = [];
    this.onGoal = null;
    this.onBounce = null;
    this.outTimer = 0;
    this.goalCooldown = 0;
    this.restingTime = 0;

    this.group = new THREE.Group();
    this.group.name = "football";

    const geometry = new THREE.SphereGeometry(this.radius, 32, 24);
    const material = new THREE.MeshStandardMaterial({
      map: createBallTexture(),
      roughness: 0.67,
      metalness: 0.02,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);

    const shadowMaterial = new THREE.MeshBasicMaterial({
      map: createShadowTexture(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.group.add(this.shadow);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xd48b4f,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.575, 40), ringMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);

    // Dedicated, generous raycast target so the ball is easy to interact with.
    this.hitbox = new THREE.Mesh(
      new THREE.SphereGeometry(0.72, 12, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.group.add(this.hitbox);

    this.position = new THREE.Vector3(0, this.radius, 5);
    this.group.position.set(this.position.x, 0, this.position.z);
    this.mesh.position.set(0, this.position.y, 0);
    this._syncGroup();
  }

  get positionVector() {
    return this.mesh.position;
  }

  setColliders(colliders) {
    this.colliders = colliders ?? [];
  }

  reset(position = new THREE.Vector3(0, this.radius, 5), silent = false) {
    this.group.position.set(position.x, 0, position.z);
    this.mesh.position.set(0, position.y, 0);
    this.velocity.set(0, 0, 0);
    this.mesh.quaternion.identity();
    this.scored = false;
    this.goalCooldown = 0.8;
    this.outTimer = 0;
    this.restingTime = 0;
    this.active = true;
    this.group.visible = true;
    this._syncGroup();
    if (!silent) {
      this.onReset?.();
    }
  }

  setActive(active) {
    this.active = active;
    this.group.visible = active;
    if (!active) this.velocity.set(0, 0, 0);
  }

  canKick() {
    if (!this.active) return false;
    const distance = this.player.position.distanceTo(this._getWorldPosition());
    return distance < 2.9;
  }

  kick(strength = 1) {
    if (!this.canKick()) return false;
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const flatDirection = direction.clone();
    flatDirection.y = 0;
    if (flatDirection.lengthSq() < 0.01) flatDirection.set(0, 0, -1);
    flatDirection.normalize();

    // Very gentle aim assist towards the north goal once the player is aiming
    // within roughly sixteen degrees of its centre.
    const goal = new THREE.Vector3(0, 0, -52.4);
    const toGoal = goal.clone().sub(this._getWorldPosition());
    const distanceToGoal = toGoal.length();
    if (distanceToGoal > 1) {
      toGoal.y = 0;
      toGoal.normalize();
      const dot = flatDirection.dot(toGoal);
      if (dot > 0.965) {
        flatDirection.lerp(toGoal, 0.28).normalize();
      }
    }

    const upward = THREE.MathUtils.clamp(direction.y * 0.35 + 0.16, 0.08, 0.4);
    const speed = 28.5 * strength;
    this.velocity.set(
      flatDirection.x * speed,
      upward * speed,
      flatDirection.z * speed,
    );
    this.mesh.position.y = Math.max(this.mesh.position.y, this.radius + 0.01);
    this.scored = false;
    this.goalCooldown = 0.6;
    this.restingTime = 0;
    this.sound.kick(strength);
    return true;
  }

  _syncGroup() {
    // The group sits on the ground below the ball; children are positioned
    // relative to it for cheap, stable raycasting.
    const y = this.mesh.position.y;
    this.hitbox.position.set(0, y, 0);
    this.shadow.position.set(0, 0.012, 0);
    this.ring.position.set(0, 0.016, 0);
    const fade = THREE.MathUtils.clamp(1 - (y - this.radius) / 3.2, 0.12, 1);
    this.shadow.material.opacity = 0.58 * fade;
    this.shadow.scale.setScalar(0.85 + (y - this.radius) * 0.22);
  }

  _getWorldPosition() {
    return new THREE.Vector3(
      this.group.position.x,
      this.mesh.position.y,
      this.group.position.z,
    );
  }

  _stepPhysics(dt) {
    const pos = this._getWorldPosition();
    const previousZ = pos.z;
    const previousX = pos.x;

    this.velocity.y -= 9.81 * dt;
    const next = pos.clone().addScaledVector(this.velocity, dt);

    // Ground.
    if (next.y <= this.radius) {
      next.y = this.radius;
      if (this.velocity.y < -0.8) {
        const impact = Math.min(0.14, Math.abs(this.velocity.y) * 0.02);
        this.sound.ballBounce(impact);
        this.velocity.y *= -0.48;
        this.velocity.x *= 0.93;
        this.velocity.z *= 0.93;
        this.onBounce?.(impact);
      } else {
        this.velocity.y = 0;
      }
    }

    // AABB barriers. The ball bounces off the advertisement boards and the
    // open gate structure.
    const radius = this.radius;
    for (const collider of this.colliders) {
      if (!collider || collider.active === false) continue;
      if (next.y > (collider.maxY ?? 2.8) + radius) continue;
      const minX = collider.minX - radius;
      const maxX = collider.maxX + radius;
      const minZ = collider.minZ - radius;
      const maxZ = collider.maxZ + radius;
      if (next.x <= minX || next.x >= maxX || next.z <= minZ || next.z >= maxZ) continue;

      const pushLeft = next.x - minX;
      const pushRight = maxX - next.x;
      const pushFront = next.z - minZ;
      const pushBack = maxZ - next.z;
      const smallest = Math.min(pushLeft, pushRight, pushFront, pushBack);
      if (smallest === pushLeft) {
        next.x = minX;
        this.velocity.x = -Math.abs(this.velocity.x) * 0.55;
      } else if (smallest === pushRight) {
        next.x = maxX;
        this.velocity.x = Math.abs(this.velocity.x) * 0.55;
      } else if (smallest === pushFront) {
        next.z = minZ;
        this.velocity.z = -Math.abs(this.velocity.z) * 0.55;
      } else {
        next.z = maxZ;
        this.velocity.z = Math.abs(this.velocity.z) * 0.55;
      }
      if (Math.abs(this.velocity.x) + Math.abs(this.velocity.z) > 1.2) {
        this.sound.ballBounce(0.05);
      }
    }

    // Goal-line crossing. Crossbar at 2.44m, posts at +/-3.66m. The scored
    // flag is the real duplicate guard; a short cooldown could otherwise make
    // a fast shot miss the sensor on low frame-rate machines.
    if (!this.scored) {
      const crossedNorth = previousZ > -52.55 && next.z <= -52.55;
      const crossedSouth = previousZ < 52.55 && next.z >= 52.55;
      if (crossedNorth && Math.abs(next.x) < 3.66 && next.y < 2.44) {
        this.scored = true;
        this.goalCooldown = 2.0;
        this.velocity.z *= 0.25;
        this.velocity.x *= 0.4;
        this.onGoal?.("north");
      } else if (crossedSouth && Math.abs(next.x) < 3.66 && next.y < 2.44) {
        this.scored = true;
        this.goalCooldown = 2.0;
        this.velocity.z *= 0.25;
        this.velocity.x *= 0.4;
        this.onGoal?.("south");
      }
    }

    this.group.position.set(next.x, 0, next.z);
    this.mesh.position.set(0, next.y, 0);

    // Drag: air is forgiving, turf consumes speed.
    const onGround = next.y <= this.radius + 0.03;
    const drag = onGround ? 0.17 : 0.035;
    const factor = Math.exp(-drag * dt);
    this.velocity.x *= factor;
    this.velocity.z *= factor;

    if (Math.abs(this.velocity.y) < 0.001 && onGround) this.velocity.y = 0;

    // Rolling rotation.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed > 0.03) {
      const axis = new THREE.Vector3(this.velocity.z, 0, -this.velocity.x).normalize();
      this.mesh.rotateOnWorldAxis(axis, (speed * dt) / this.radius);
    }

    if (onGround && speed < 0.16) {
      this.restingTime += dt;
      this.velocity.x *= 0.75;
      this.velocity.z *= 0.75;
    } else {
      this.restingTime = 0;
    }

    return { previousZ, nextZ: next.z, previousX, nextX: next.x };
  }

  update(dt, elapsed) {
    this.goalCooldown = Math.max(0, this.goalCooldown - dt);
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    if (this.active) {
      const steps = Math.min(12, Math.max(1, Math.ceil((speed * dt) / 0.32)));
      for (let i = 0; i < steps; i += 1) {
        this._stepPhysics(dt / steps);
      }
      this._syncGroup();

      const worldPos = this._getWorldPosition();
      const outOfBounds =
        worldPos.z < -68 ||
        worldPos.z > 68 ||
        Math.abs(worldPos.x) > 52 ||
        worldPos.y < -2;
      if (outOfBounds) {
        this.outTimer += dt;
        if (this.outTimer > 4.5) {
          const resetPos = new THREE.Vector3(0, this.radius, 4);
          this.reset(resetPos);
        }
      } else {
        this.outTimer = 0;
      }

      // Show a subtle "you can kick this" ring only when close.
      const distance = this.player.position.distanceTo(this._getWorldPosition());
      const ringTarget = distance < 3.0 && this.active ? 0.18 + Math.sin(elapsed * 2.8) * 0.05 : 0;
      this.ring.material.opacity += (ringTarget - this.ring.material.opacity) * Math.min(1, dt * 6);
      this.ring.scale.setScalar(1 + Math.sin(elapsed * 2.2) * 0.05);
    }

    this.sound.setBallSpeed(speed);
  }
}
