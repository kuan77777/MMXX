// 相机：第一人称 / 第三人称共用同一个 yaw/pitch 状态，切换时用位置插值过渡，不硬切。
// 第三人称做"碰撞回缩"：眼睛到目标点之间被墙挡住就把距离收回来，否则会穿墙看穿整个建筑。

const DEG = Math.PI / 180;

export class CameraRig {
  constructor(THREE, cfg) {
    this.THREE = THREE;
    this.cfg = cfg || {};
    this.mode = 'third';          // 'first' | 'third'
    this.yaw = 0;
    this.pitch = -0.08;
    this.distance = 0;            // 当前实际距离（用于插值）
    this.targetDistance = 0;
    this.switchT = 1;             // 0=第一人称 1=第三人称
    this.shake = 0;
    this._shakeT = 0;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.recoil = { x: 0, y: 0, t: 0 };
  }

  toggle() {
    this.mode = this.mode === 'first' ? 'third' : 'first';
    return this.mode;
  }

  setMode(mode) { this.mode = mode === 'first' ? 'first' : 'third'; }

  addLook(dx, dy, sensitivity) {
    const s = sensitivity || 0.0022;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    const lim = 1.15;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;
    // yaw 归一化，避免长时间游玩后数值爆炸
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  addRecoil(amount) {
    this.recoil.y += amount * 0.55;
    this.recoil.x += (Math.random() - 0.5) * amount * 0.35;
    this.recoil.t = 0.16;
  }

  addShake(amount) {
    this.shake = Math.min(0.5, this.shake + amount);
    this._shakeT = 0;
  }

  /** 视线方向（含第一人称）。 */
  getForward(out) {
    const cp = Math.cos(this.pitch);
    out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    return out;
  }

  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {{x,y,z}} eye 眼睛位置（玩家）
   * @param {object} collision ColliderWorld，可为 null
   * @param {number} dt
   */
  update(camera, eye, collision, dt) {
    const THREE = this.THREE;
    const cfg = this.cfg;
    // 模式插值
    const target = this.mode === 'third' ? 1 : 0;
    const lerpSpeed = cfg.switchLerpSpeed || 9;
    this.switchT += (target - this.switchT) * Math.min(1, dt * lerpSpeed);
    if (Math.abs(this.switchT - target) < 0.001) this.switchT = target;

    // 后坐力回弹
    if (this.recoil.t > 0) {
      this.recoil.t = Math.max(0, this.recoil.t - dt);
      const k = this.recoil.t / 0.16;
      this.recoil.y *= (0.86 + 0.14 * k);
      this.recoil.x *= (0.86 + 0.14 * k);
    } else { this.recoil.x = 0; this.recoil.y = 0; }

    // 抖动
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 1.6);
      this._shakeT += dt;
    }

    const yaw = this.yaw + this.recoil.x * DEG * 2;
    const pitch = this.pitch + this.recoil.y * DEG * 2;

    const forward = this._v.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));

    // 第一人称位置（眼睛）
    const firstX = eye.x;
    const firstY = eye.y;
    const firstZ = eye.z;

    // 第三人称：从眼睛沿视线反方向后退
    // distanceScale 让"开车时"把相机拉远（3.2m 会卡在 4.6m 长的 SUV 车壳里，只剩车顶一片白）
    const maxDist = (cfg.thirdDistance || 3.2) * (this.distanceScale || 1);
    const back = this._v2.set(-forward.x, -forward.y, -forward.z);
    let dist = maxDist;
    if (collision) {
      const hit = collision.raycast(eye.x, eye.y, eye.z, back.x, back.y, back.z, maxDist + 0.4);
      if (hit) dist = Math.max(0.7, hit.distance - (cfg.tpCollisionPadding || 0.35));
    }
    // 肩部偏移：这里用的是玩家**左侧**（角色因此在画面偏右）。
    // 注意别照抄成"右方"——右手边是前方向×上方向 = (-cos, +sin)，
    // 与下面这两个分量符号相反。横移方向的正确算法见 player.js。
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const shoulder = (cfg.shoulderOffset || 0.55);
    const thirdX = eye.x + back.x * dist + rightX * shoulder;
    const thirdY = eye.y + back.y * dist + (cfg.thirdHeight || 0) - 0.1;
    const thirdZ = eye.z + back.z * dist + rightZ * shoulder;

    // 按 switchT 在两种位置之间插值
    const t = this.switchT;
    const px = firstX + (thirdX - firstX) * t;
    const py = firstY + (thirdY - firstY) * t;
    const pz = firstZ + (thirdZ - firstZ) * t;

    let shakeX = 0, shakeY = 0;
    if (this.shake > 0) {
      shakeX = Math.sin(this._shakeT * 47) * this.shake * 0.12;
      shakeY = Math.cos(this._shakeT * 39) * this.shake * 0.12;
    }

    camera.position.set(px + shakeX, py + shakeY, pz);
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw + Math.PI;   // 相机默认看向 -Z，角色的 +Z 是前方
    camera.rotation.x = pitch;
    camera.fov = (cfg.fov || 72) * (this.mode === 'first' ? 1 : 0.94);
    camera.updateProjectionMatrix();
  }

  /** 第一人称时用于隐藏自身模型/显示视图模型。 */
  get isFirstPerson() { return this.mode === 'first'; }
}

export default { CameraRig };
