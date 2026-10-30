// 角色实体：把"骨骼模型 + 动画状态机 + 命中盒 + 挂点 + 生命值"打包成 AI/玩家/战斗系统都认的一个东西。
// 视觉模型可以替换（程序化骨骼 / 之后的 GLB 资源包），但对外接口保持不变：
//   char.group / char.animator / char.health / char.raycast(ray) / char.takeDamage(n, part)
import { buildHumanoid } from './rig.js';
import { buildClips } from './clips.js';
import { Animator } from './animator.js';
import { makeKit } from '../appearance/kit.js';
import { applyKitTexture } from '../appearance/shirt-uv.js';

const _v = { x: 0, y: 0, z: 0 };

// 全进程共享一份片段（所有角色共用同一批 AnimationClip，mixer 各自独立）
const clipCache = new WeakMap();
function clipsFor(THREE) {
  let c = clipCache.get(THREE);
  if (!c) { c = buildClips(THREE); clipCache.set(THREE, c); }
  return c;
}

export function sharedClips(THREE) { return clipsFor(THREE); }

export class Character {
  /**
   * @param {object} THREE
   * @param {object} ctx { materials: KitMaterialCache, quality: object }
   * @param {object} def { id, kind, appearance, kit, health, name, factionId, zombie }
   */
  constructor(THREE, ctx, def = {}) {
    this.THREE = THREE;
    this.def = def;
    this.id = def.id != null ? String(def.id) : `char-${Math.random().toString(36).slice(2, 8)}`;
    this.kind = def.kind || 'npc';
    this.name = def.name || '幸存者';
    this.factionId = def.factionId || null;
    this.zombie = def.kind === 'zombie' || !!def.zombie;

    this.maxHealth = Number.isFinite(def.health) ? def.health : 100;
    this.health = this.maxHealth;
    this.alive = true;
    this.deathAt = 0;

    this.appearance = def.appearance || null;
    this.kit = def.kit || makeKit({ playerId: this.id, clubId: def.factionId });

    const entry = ctx.materials ? ctx.materials.get(this.kit) : null;

    // 视觉来源有两种：
    //   ① 传入了已加载的 FBX 模型（def.model）→ 用真实资产 + 它自带的动画；
    //   ② 没传 → 程序化骨骼角色（兜底，保证任何情况下都有可见、可动的人）。
    const model = def.model || null;
    if (model && model.group) {
      this.modelKind = 'fbx';
      this.model = model;
      this.group = model.group;
      this.visualRoot = model.inner || model.group;
      this.height = model.height || 1.75;
      this.rig = {
        group: model.group,
        mesh: model.mesh,
        bones: model.bones,
        boneList: model.skinnedMeshes ? [] : [],
        skeleton: model.skeleton,
        eyeHeight: model.eyeHeight,
        kit: this.kit,
        skinnedMeshes: model.skinnedMeshes || [],
        // 挂在骨骼上的附件（男性体型模板的程序化发型/胡子）：第一人称要一起隐藏，
        // 否则"自己"的头发出现在镜头里（它们不是 SkinnedMesh，上面的列表盖不住）。
        attachments: model.attachments || [],
        dispose() {},
      };
      this.animator = new Animator(THREE, this.group, model.clips, { stateSpeed: model.stateSpeed });

      // B′ 球衣：给模型自带的球衣三角面生成 UV 并换上俱乐部图集（这批 FBX 没有任何 UV，必须自己算）。
      if (def.kitAtlas && def.kitAtlas.canvas) {
        try {
          const r = applyKitTexture(THREE, model, def.kitAtlas.canvas);
          this.kitApplied = !!r.ok;
          this.kitReason = r.ok ? null : r.reason;
          if (!r.ok) console.warn('[kit] 球衣替换失败：', r.reason);
        } catch (e) {
          this.kitApplied = false;
          this.kitReason = String(e && e.message ? e.message : e);
        }
      }
    } else {
      this.modelKind = 'procedural';
      this.rig = buildHumanoid(THREE, {
        appearance: this.appearance || {},
        kit: this.kit,
        zombie: this.zombie,
        material: entry ? entry.material : undefined,
      });
      this.group = this.rig.group;
      this.visualRoot = this.rig.mesh;
      this.height = 1.75 * (this.group.scale.x || 1);
      this.animator = new Animator(THREE, this.group, clipsFor(THREE));
    }

    // 命中盒（世界坐标，每帧按需刷新）
    this._headSphere = new THREE.Sphere(new THREE.Vector3(), 0.16);
    this._torsoBox = new THREE.Box3();
    this._legsBox = new THREE.Box3();
    this._tmpVec = new THREE.Vector3();

    // 武器挂点：挂在右手骨骼上，枪口朝 hand 的 -Y（手臂抬起时自然朝前）
    this.weaponMount = new THREE.Object3D();
    this.weaponMount.name = 'weaponMount';
    this.weaponMount.position.set(0, -0.075, 0.01);
    this.weaponMount.rotation.set(Math.PI / 2, 0, 0);
    const hand = this.rig.bones.handR;
    if (hand) hand.add(this.weaponMount);

    // 状态机对外字段
    this.moving = false;
    this.speed = 0;
    this.crouching = false;
    this.aiming = false;
    this.yaw = 0;

    this._refreshHitboxes();
  }

  get position() { return this.group.position; }
  get eyeHeight() { return this.rig.eyeHeight; }

  setPosition(x, y, z) {
    this.group.position.set(x, y, z);
    this._refreshHitboxes();
  }

  setYaw(yaw) {
    this.yaw = yaw;
    this.group.rotation.y = yaw;
  }

  /** 第一人称时隐藏自身模型（只隐藏视觉，不影响命中盒）。 */
  setVisible(v) {
    const on = !!v;
    if (this.visualRoot) this.visualRoot.visible = on;
    // 多蒙皮网格的模型要逐个关，否则 rig.mesh.visible 仍是 true
    const list = (this.rig && this.rig.skinnedMeshes) || [];
    for (const m of list) m.visible = on;
    if (this.rig && this.rig.mesh) this.rig.mesh.visible = on;
    const att = (this.rig && this.rig.attachments) || [];
    for (const m of att) m.visible = on;
  }

  attachWeapon(obj, offset = null) {
    if (!obj) return null;
    this.weaponMount.clear();
    if (offset) {
      obj.position.set(offset.x || 0, offset.y || 0, offset.z || 0);
      obj.rotation.set(offset.rx || 0, offset.ry || 0, offset.rz || 0);
    }
    this.weaponMount.add(obj);
    this.weapon = obj;
    return obj;
  }

  _refreshHitboxes() {
    const THREE = this.THREE;
    const p = this.group.position;
    const headBone = this.rig.bones.head;
    if (headBone) {
      headBone.getWorldPosition(this._tmpVec);
      this._headSphere.center.copy(this._tmpVec);
      this._headSphere.center.y += 0.06;
      this._headSphere.radius = 0.17 * (this.group.scale.x || 1);
    } else {
      this._headSphere.center.set(p.x, p.y + 1.6, p.z);
    }
    const s = this.group.scale.x || 1;
    // 用模型实测身高（FBX 资产的缩放烘焙在内层，wrapper.scale 恒为 1，不能拿它当尺度）
    const h = this.height || 1.75 * s;
    // 躯干与腿用两个轴对齐盒近似：低多边形角色 + 快节奏射击，够用且极快
    this._torsoBox.min.set(p.x - 0.26 * s, p.y + h * 0.55, p.z - 0.26 * s);
    this._torsoBox.max.set(p.x + 0.26 * s, p.y + h * 0.92, p.z + 0.26 * s);
    this._legsBox.min.set(p.x - 0.22 * s, p.y + 0.02, p.z - 0.22 * s);
    this._legsBox.max.set(p.x + 0.22 * s, p.y + h * 0.55, p.z + 0.22 * s);
  }

  /**
   * 射线命中测试。
   * @param {THREE.Ray} ray
   * @returns {{distance:number, part:'head'|'torso'|'legs', point:THREE.Vector3}|null}
   */
  raycast(ray) {
    if (!this.alive) {
      // 尸体仍可被射线阻挡（子弹打在尸体上不算命中目标，但会停下）
      return null;
    }
    this._refreshHitboxes();
    const THREE = this.THREE;
    let best = null;
    const hp = new THREE.Vector3();
    if (ray.intersectSphere(this._headSphere, hp)) {
      const d = ray.origin.distanceTo(hp);
      if (d > 0.01) best = { distance: d, part: 'head', point: hp };
    }
    const boxHit = new THREE.Vector3();
    if (ray.intersectBox(this._torsoBox, boxHit)) {
      const d = ray.origin.distanceTo(boxHit);
      if (d > 0.01 && (!best || d < best.distance)) best = { distance: d, part: 'torso', point: boxHit };
    }
    if (ray.intersectBox(this._legsBox, boxHit)) {
      const d = ray.origin.distanceTo(boxHit);
      if (d > 0.01 && (!best || d < best.distance)) best = { distance: d, part: 'legs', point: boxHit };
    }
    return best;
  }

  takeDamage(amount, part = 'torso', now = 0) {
    if (!this.alive) return { died: false, applied: 0 };
    const n = Math.max(0, Number(amount) || 0);
    if (!n) return { died: false, applied: 0 };
    this.health -= n;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deathAt = now;
      this.animator.die();
      return { died: true, applied: n };
    }
    // 受击硬直（僵尸用 Stagger 状态消费这个信号）
    this.lastHitAt = now;
    this.lastHitPart = part;
    if (part !== 'legs') this.animator.trigger('hit', { fade: 0.06 });
    return { died: false, applied: n };
  }

  setBaseState(name, fade) { this.animator.setBase(name, fade); }
  triggerAction(name, opts) { return this.animator.trigger(name, opts); }

  /** 由 NPC/玩家逻辑每帧调用。distance 用于冻结远处角色的骨骼计算。 */
  update(dt, distance = 0, animDistance = 45) {
    const frozen = distance > animDistance;
    this.animator.setFrozen(frozen);
    if (!frozen) this.animator.update(dt);
  }

  dispose() {
    try { this.animator.dispose(); } catch (e) {}
    try { this.rig.dispose(); } catch (e) {}
    try { this.group.removeFromParent(); } catch (e) {}
    if (this.weapon && this.weapon.parent) { try { this.weapon.removeFromParent(); } catch (e) {} }
  }
}

export default { Character, sharedClips };
