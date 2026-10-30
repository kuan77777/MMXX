// 动画状态机：负责"状态 → 片段"的映射、淡入淡出、一次性动作的回位、以及按距离冻结。
// 关键约束：任何状态切换都走 crossFadeTo，不允许硬切（硬切是肉眼可见的跳帧）。
import { STATE_CLIPS, ONE_SHOT } from './clips.js';

const FADE = { base: 0.18, action: 0.10, death: 0.25, idle: 0.22 };

export class Animator {
  /**
   * @param {object} THREE
   * @param {THREE.Object3D} root 骨骼所在的根节点（mixer 的查询根）
   * @param {Record<string, THREE.AnimationClip>} clips
   */
  constructor(THREE, root, clips, opts = {}) {
    this.THREE = THREE;
    this.clips = clips || {};
    this.stateSpeed = opts.stateSpeed || null;   // 例：{sprint:1.35} 让"跑步"动作也能当冲刺播
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = new Map();
    for (const [name, clip] of Object.entries(this.clips)) {
      const action = this.mixer.clipAction(clip);
      const oneShot = ONE_SHOT.has(name) || name === 'death';
      action.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
      action.clampWhenFinished = oneShot;
      this.actions.set(name, action);
    }
    this.base = 'idle';
    this.oneShot = null;
    this.current = null;
    this.dead = false;
    this.frozen = false;
    this._pendingBase = null;
    this._onFinished = (e) => {
      const name = this._nameOfAction(e.action);
      if (!name) return;
      if (name === 'death') {
        this.dead = true;
        return;
      }
      if (this.oneShot === name) {
        this.oneShot = null;
        const back = this._pendingBase || this.base;
        this._pendingBase = null;
        this._crossTo(back, FADE.action);
      }
    };
    this.mixer.addEventListener('finished', this._onFinished);
    this.lastBaseRequest = null;
    this._apply(this.base, 0);
  }

  _nameOfAction(action) {
    for (const [name, a] of this.actions) if (a === action) return name;
    return null;
  }

  _apply(name, fade) {
    const next = this.actions.get(name) || this.actions.get(STATE_CLIPS[name] || '');
    if (!next) return false;
    if (this.current === next && !this.oneShot) return true;
    this._crossTo(name, fade);
    return true;
  }

  _crossTo(name, fade) {
    const next = this.actions.get(name);
    if (!next) return;
    const prev = this.current;
    if (prev === next && !this.oneShot) return;
    next.reset();
    next.setEffectiveTimeScale((this.stateSpeed && this.stateSpeed[name]) || 1);
    next.setEffectiveWeight(1);
    next.enabled = true;
    if (fade > 0) next.fadeIn(fade); else next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) {
      if (fade > 0) prev.fadeOut(fade); else prev.stop();
    }
    this.current = next;
  }

  /** 设置基础状态（移动/瞄准/蹲伏/下落…）。一次性动作播放期间只记录，不回显。 */
  setBase(name, fade = FADE.base) {
    const resolved = STATE_CLIPS[name] ? name : 'idle';
    if (this.base === resolved && !this.oneShot) return;
    this.base = resolved;
    if (this.oneShot) { this._pendingBase = resolved; return; }
    if (this.dead) return;
    this._crossTo(resolved, fade);
  }

  /** 播放一次性动作（射击/换弹/近战/受击/交互/跳跃）。 */
  trigger(name, opts = {}) {
    if (this.dead) return false;
    const clip = this.actions.get(name);
    if (!clip) return false;
    const fade = Number.isFinite(opts.fade) ? opts.fade : FADE.action;
    // 已有一个一次性动作在播：除跳跃/受击外直接忽略，避免动作互相打断得乱跳
    if (this.oneShot && this.oneShot !== name) {
      if (name !== 'hit') return false;
    }
    this.oneShot = name;
    const prev = this.current;
    clip.reset();
    // 起点偏移：资源包的动画常常带一段"准备动作"，从中间起播能让判定时机对上动作
    if (Number.isFinite(opts.time) && opts.time > 0) {
      const dur = clip.getClip() ? clip.getClip().duration : 0;
      clip.time = Math.max(0, Math.min(opts.time, Math.max(0, dur - 0.001)));
    }
    clip.setEffectiveTimeScale(Number.isFinite(opts.timeScale) ? opts.timeScale : 1);
    clip.setEffectiveWeight(1);
    clip.enabled = true;
    clip.fadeIn(fade);
    clip.play();
    if (prev && prev !== clip) prev.fadeOut(fade);
    this.current = clip;
    return true;
  }

  /** 死亡：一次性播放并停在最后一人帧（clampWhenFinished）。 */
  die() {
    if (this.dead) return;
    this.oneShot = 'death';
    const clip = this.actions.get('death');
    if (!clip) { this.dead = true; return; }
    const prev = this.current;
    clip.reset();
    clip.setEffectiveWeight(1);
    clip.fadeIn(FADE.death);
    clip.play();
    if (prev && prev !== clip) prev.fadeOut(FADE.death);
    this.current = clip;
  }

  /** 复活/重新使用对象池时彻底复位。 */
  revive() {
    this.dead = false;
    this.oneShot = null;
    this._pendingBase = null;
    this.mixer.stopAllAction();
    this.current = null;
    this.base = 'idle';
    this._crossTo('idle', 0);
  }

  /** 远距离 NPC：冻结蒙皮计算（mixer 不再推进），显式停止以避免残留权重。 */
  setFrozen(frozen) {
    if (this.frozen === frozen) return;
    this.frozen = !!frozen;
    this.mixer.timeScale = this.frozen ? 0 : 1;
  }

  update(dt) {
    if (this.frozen) return;
    // dt 上限：切标签页回来时 dt 可能是几秒，会把一次性动作直接跳完
    this.mixer.update(Math.min(0.1, Math.max(0, dt)));
  }

  get state() { return this.oneShot || this.base; }

  dispose() {
    try { this.mixer.removeEventListener('finished', this._onFinished); } catch (e) {}
    this.mixer.stopAllAction();
    try { this.mixer.uncacheRoot(this.mixer.getRoot()); } catch (e) {}
    this.actions.clear();
  }
}

export default { Animator };
