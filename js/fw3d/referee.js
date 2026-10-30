// FW3D · 场上主裁判（低模）
// 复用球员的低模身体（同一套 rig），只换裁判配色 + 加红黄牌道具；
// 站位/跟随由 arena 用 ai/features.js 的 refAnchor 算目标点，这里只负责移动与朝向。
import { createPlayerModel } from './character.js';

export const REF_KIT = {
  jersey: 0x14161c,   // 黑衫
  shorts: 0x0f1114,
  socks: 0x14161c,
  accent: 0x2e3238,
  skin: 0xc79a72,
};

/**
 * @param {object} THREE
 * @param {{cache?:Map, detail?:'full'|'mid'|'low'}} opts cache 与球员共用（材质/几何共享）
 */
export function createReferee(THREE, opts = {}) {
  const model = createPlayerModel(THREE, {
    jersey: REF_KIT.jersey,
    shorts: REF_KIT.shorts,
    socks: REF_KIT.socks,
    accent: REF_KIT.accent,
    skin: REF_KIT.skin,
    boot: 0x0b0c0e,
    number: null,
    name: '',
    detail: opts.detail || 'mid',   // 裁判离镜头通常较远，用 mid 省 draw call
    cache: opts.cache || null,
    cards: true,                    // 建红黄牌道具（挂在右手腕）
  });
  const object = new THREE.Group();
  object.add(model.object);
  object.position.set(0, 0, 12);

  const state = { x: 0, z: 12, facing: 0, speed: 0, moving: false };

  return {
    object,
    model,
    get x() { return state.x; },
    get z() { return state.z; },
    /** 亮牌：'yellow' | 'red'（同时播举牌动作 1.25 s） */
    card(kind) { model.cardPose(kind); return kind; },
    whistle() { model.whistlePose(); },
    /** 指方向：dir = 1 指向 +x 侧 / -1 指向 -x 侧（任意球、点球示意） */
    point(dir) { model.pointPose(dir); },
    appeal() { model.appealPose(); },
    hideCard() { model.showCard(null); },
    /**
     * 跟随更新：朝 target 走（最高 6.4 m/s），朝向 = 移动方向
     * @param {number} dt
     * @param {{x:number,z:number}} target
     * @param {number} t 累计时间（传给模型动画）
     */
    update(dt, target, t) {
      const dx = (target.x || 0) - state.x;
      const dz = (target.z || 0) - state.z;
      const d = Math.hypot(dx, dz);
      let sp = 0;
      if (d > 0.35) {
        sp = Math.min(6.4, d * 1.8);
        state.x += (dx / d) * sp * dt;
        state.z += (dz / d) * sp * dt;
        state.facing = Math.atan2(dx, dz);
      }
      state.speed = sp;
      state.moving = sp > 0.4;
      object.position.set(state.x, 0, state.z);
      object.rotation.y = state.facing;
      model.update(dt, sp, t);
    },
    info() {
      return {
        x: +state.x.toFixed(2), z: +state.z.toFixed(2),
        facing: +state.facing.toFixed(2), speed: +state.speed.toFixed(2),
        pose: model.poseState(), card: model.cardKind(),
      };
    },
  };
}
