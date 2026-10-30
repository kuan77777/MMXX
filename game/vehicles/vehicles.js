// 车辆：街机化的基础驾驶模型（不是汽车模拟器）+ **使用系统**（油/引擎/震伤/车灯）。
// 需求里明确提到"车辆资源没有车轮骨骼或动画时，不要假设轮胎动画已经存在" ——
// 所以这里只对**程序化车模**做车轮旋转（mesh.userData.wheels），
// 如果换成了没有轮子节点的 GLB，代码会因为找不到 wheels 而跳过，不会报错。
//
// 物理极简：速度标量 + 朝向角，转向只与速度相关，碰撞用碰撞世界的圆柱近似。
// 使用系统的细则（数值全在 config.vehicles）见 docs/VEHICLES.md：
//   · 油箱：`car.fuel` 0~100（%）。怠速也烧油，油尽自动熄火 → 只能滑行；
//   · 引擎噪音：按速度每隔 engineNoiseInterval 秒向 AI 广播一次（1=脚步，4=枪声）；
//   · 撞击：ramTargets() 是**纯函数**（可单测），game 只负责把伤害交给 director.damageNpc；
//   · 车灯：只是状态位，真正的 SpotLight 由 game 挂在车上（14 台车不各配一盏灯）。

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, f) => (Number.isFinite(v) ? v : f);

/** 每秒烧掉多少油（%）。速度越快越费油；怠速也在烧。 */
export function fuelBurnPerSecond(speed, cfg = {}) {
  const idle = num(cfg.fuelBurnIdle, 0.1);
  const perSpeed = num(cfg.fuelBurnPerSpeed, 0.022);
  return Math.max(0, idle + Math.abs(speed) * perSpeed);
}

/**
 * 引擎噪音强度（1 = 普通脚步，4 = 枪声）。静止怠速也在响，所以停车不等于隐身。
 * 这也正是"车快但吵"的取舍：开得越快，把僵尸拉得越远。
 */
export function engineLoudness(speed, cfg = {}) {
  const idle = num(cfg.engineNoiseIdle, 0.9);
  const drive = num(cfg.engineNoiseDrive, 1.9);
  const vmax = Math.max(1, num(cfg.maxSpeed, 19));
  return idle + (drive - idle) * clamp(Math.abs(speed) / vmax, 0, 1);
}

/** 撞击伤害：速度低于 ramMinSpeed 时不造成伤害（只是把人顶开）。 */
export function ramDamage(impactSpeed, cfg = {}) {
  const min = num(cfg.ramMinSpeed, 4.5);
  if (impactSpeed < min) return 0;
  return Math.round((impactSpeed - min) * num(cfg.ramDamagePerSpeed, 9));
}

/**
 * 车头前方哪些 NPC 被撞到（纯函数，便于单测）。
 * 只算**前方一条扁盒子**：车头两侧 ±(半宽+0.35)、朝前 0.4~车长×0.75 的范围。
 * @param {{x:number,z:number,rotY:number,speed:number,halfWidth?:number,length?:number}} car
 * @param {Array<{x:number,z:number,alive?:boolean,radius?:number}>} npcs
 * @returns {Array<{npc:object, distance:number}>}
 */
export function ramTargets(car, npcs, opts = {}) {
  const speed = Math.abs(num(car.speed, 0));
  if (speed < num(opts.ramMinSpeed, 4.5)) return [];
  const length = num(car.length, 4.4);
  const halfW = num(car.halfWidth, 1.0) + 0.35;
  const fx = Math.sin(car.rotY);
  const fz = Math.cos(car.rotY);
  // 车头在世界里的位置（车模原点是车中心）
  const noseX = car.x + fx * length * 0.5;
  const noseZ = car.z + fz * length * 0.5;
  // 撞击区：从车头往外再伸出 0.4m，往回覆盖到车中心
  const reach = length * 0.55 + 0.4;
  const out = [];
  for (const n of npcs || []) {
    if (!n || n.alive === false) continue;
    const dx = n.x - noseX;
    const dz = n.z - noseZ;
    // 以车头为原点、车头方向为 +前 的局部坐标
    const forward = dx * fx + dz * fz;
    const lateral = Math.abs(dx * -fz + dz * fx);
    if (forward > 0.4 || forward < -reach) continue;
    if (lateral > halfW + num(n.radius, 0.35)) continue;
    out.push({ npc: n, distance: Math.abs(forward) });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

export class VehicleController {
  constructor(cfg = {}) {
    this.cfg = cfg.vehicles || cfg;
    this.car = null;
    this.driver = null;
    this.throttle = 0;
    this.steer = 0;
    this._engineSoundT = 0;
    this._noiseT = 0;
  }

  get driving() { return !!this.car; }

  /** 车辆是否还有油（能发动）。读档里的旧车没有 fuel 字段时按满油处理。 */
  static fuelOf(car) {
    if (!car) return 0;
    return Number.isFinite(car.fuel) ? car.fuel : 100;
  }

  enter(car, player) {
    if (!car || !car.drivable) return false;
    if (this.car) return false;
    if (VehicleController.fuelOf(car) <= 0) return false; // 没油 = 打不着火
    this.car = car;
    this.driver = player;
    car.driving = true;
    car.engineOn = true;
    this._engineSoundT = 0;
    this._noiseT = 0;
    if (player && player.character) player.character.setVisible(false);
    return true;
  }

  exit(player) {
    if (!this.car) return null;
    const car = this.car;
    car.speed = 0;
    car.driving = false;
    car.engineOn = false;
    this.car = null;
    this.driver = null;
    this.throttle = 0;
    this.steer = 0;
    if (player) {
      // 从车的左侧下车，并确保不卡进建筑
      const side = car.mesh.rotation.y + Math.PI / 2;
      const x = car.mesh.position.x + Math.cos(side) * 2.2;
      const z = car.mesh.position.z - Math.sin(side) * 2.2;
      player.setPosition(x, 0, z);
      if (player.character) player.character.setVisible(true);
    }
    return car;
  }

  /** 手动熄火（省油 / 藏车）。熄火也能滑行，但踩油门没用。 */
  setEngine(on) {
    if (!this.car) return false;
    this.car.engineOn = !!on && VehicleController.fuelOf(this.car) > 0;
    return this.car.engineOn;
  }

  toggleLights() {
    if (!this.car) return false;
    this.car.lights = !this.car.lights;
    return this.car.lights;
  }

  /**
   * @param {number} dt
   * @param {object} input Input 实例
   * @param {object} collision ColliderWorld
   * @param {object} hooks { onCrash(dmg, car), onEngine(speed, car), onNoise(x,z,loudness,car), onStall() }
   */
  update(dt, input, collision, hooks = {}) {
    const car = this.car;
    if (!car) return;
    const C = this.cfg;
    // 每台车自己的手感系数（world/cars.js 里按车型给：跑车更快、SUV 更稳）。
    // 没有 perf 的车（程序化回退车模 / 旧存档）就是 1.0，行为与以前完全一致。
    const perf = car.perf || null;
    // 天气抓地力（雪地/积水）：game 通过 hooks.grip 传进来，缺省 1 = 完全干燥。
    // 它同时影响三件事——极速、加速、刹车距离——只改一个会让手感很怪：
    // 雪地里"开不快"和"刹不住"必须一起发生，玩家才会觉得是路滑而不是马力小。
    const grip = Number.isFinite(hooks.grip) ? clamp(hooks.grip, 0.4, 1.2) : 1;
    const maxSpeed = (C.maxSpeed || 19) * (perf ? (perf.speed || 1) : 1) * grip;
    const accel = (C.acceleration || 11) * (perf ? (perf.accel || 1) : 1) * grip;
    // 抓地越低刹车越软（grip=0.78 → 刹车力只有干燥时的 ~0.67），雪地刹车距离接近翻倍
    const brake = (C.brakeForce || 18) * (1 - (1 - grip) * 1.5);
    const drag = C.drag || 0.72;

    const fwd = input && input.isDown('forward');
    const back = input && input.isDown('back');
    const left = input && input.isDown('left');
    const right = input && input.isDown('right');
    const brakeKey = input && input.isDown('jump');

    // ── 油量：没油就熄火（引擎声音/hook 也要断）
    if (!Number.isFinite(car.fuel)) car.fuel = 100;
    if (car.engineOn !== false && car.fuel > 0) {
      car.fuel = Math.max(0, car.fuel - fuelBurnPerSecond(car.speed, C) * dt);
      if (car.fuel <= 0) {
        car.engineOn = false;
        if (hooks.onStall) hooks.onStall(car);
      }
    }
    const engineOn = car.engineOn !== false && car.fuel > 0;

    // 油门 / 刹车 / 倒车（熄火时只有刹车和滑行）
    if (engineOn && fwd) car.speed += accel * dt;
    else if (engineOn && back) car.speed -= accel * dt;
    if (brakeKey) car.speed *= Math.max(0, 1 - (brake / maxSpeed) * dt * 2.2);

    // 阻力（熄火滑行时阻力更大一点，别让空油箱变成永动机）
    car.speed *= Math.max(0, 1 - drag * dt * (engineOn ? 0.35 : 0.9));
    car.speed = clamp(car.speed, -(C.reverseSpeed || 7), maxSpeed);
    if (Math.abs(car.speed) < 0.05) car.speed = 0;

    // 转向：速度越快越难转，倒车时反向；小车/跑车转向更灵；雪地还会更钝
    const speedFactor = Math.min(1, Math.abs(car.speed) / 6);
    const steerRate = (C.steerRate || 1.7) * speedFactor * (car.speed < 0 ? -1 : 1)
      * (perf ? (perf.steer || 1) : 1) * (0.7 + 0.3 * grip);
    if (left) car.mesh.rotation.y += steerRate * dt;
    if (right) car.mesh.rotation.y -= steerRate * dt;

    // 位移
    const heading = car.mesh.rotation.y;
    const dx = Math.sin(heading) * car.speed * dt;
    const dz = Math.cos(heading) * car.speed * dt;
    if ((dx || dz) && collision) {
      const res = collision.move(car.mesh.position.x, car.mesh.position.z, 1.15, dx, dz, 0, 1.6);
      car.mesh.position.x = res.x;
      car.mesh.position.z = res.z;
      if (res.hitX || res.hitZ) {
        const impact = Math.abs(car.speed);
        car.speed *= -0.18;
        if (impact > (C.crashDamageSpeed || 7)) {
          const dmg = (impact - (C.crashDamageSpeed || 7)) * 7;
          car.durability = Math.max(0, car.durability - dmg);
          if (hooks.onCrash) hooks.onCrash(dmg, car);
        }
      }
    } else {
      car.mesh.position.x += dx;
      car.mesh.position.z += dz;
    }

    // 车轮旋转（只有程序化车模才有 wheels）
    const wheels = car.mesh.userData && car.mesh.userData.wheels;
    if (wheels && wheels.length) {
      const spin = (car.speed / 0.34) * dt;
      for (const w of wheels) w.rotation.x -= spin;
    }

    // ── 引擎声：脉冲播放（音频层没有循环 API，见 docs/VEHICLES.md）
    if (engineOn) {
      this._engineSoundT -= dt;
      if (this._engineSoundT <= 0) {
        this._engineSoundT = C.enginePulseInterval || 0.46;
        if (hooks.onEngine) hooks.onEngine(car.speed, car, maxSpeed);
      }
    }

    // ── 引擎噪音：定期向 AI 广播（停车也响，所以"停着躲僵尸"不是万能的）
    if (engineOn) {
      this._noiseT -= dt;
      if (this._noiseT <= 0) {
        this._noiseT = C.engineNoiseInterval || 1.1;
        if (hooks.onNoise) {
          hooks.onNoise(car.mesh.position.x, car.mesh.position.z, engineLoudness(car.speed, { ...C, maxSpeed }), car);
        }
      }
    }

    // 耐久归零 → 无法驾驶（只保留"还能当掩体"）
    if (car.durability <= 0 && car.drivable) {
      car.drivable = false;
      car.engineOn = false;
      if (hooks.onDestroyed) hooks.onDestroyed(car);
    }
    this.car = car;
  }

  /** HUD 用的速度表。 */
  speedKmh() {
    return this.car ? Math.abs(this.car.speed) * 3.6 : 0;
  }

  serialize() {
    const c = this.car;
    if (!c) return null;
    return {
      id: c.id, x: c.mesh.position.x, z: c.mesh.position.z, rotY: c.mesh.rotation.y,
      durability: c.durability, fuel: c.fuel, lights: !!c.lights,
    };
  }
}

export default { VehicleController, fuelBurnPerSecond, engineLoudness, ramDamage, ramTargets };
