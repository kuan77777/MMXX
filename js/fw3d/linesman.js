// FW3D · 边裁（低模，2 名，沿两条边线）
// 复用球员低模身体（荧光黄/橙配色的助理裁判衫）+ 旗子（挂在右手腕上）：
//   - 跟随：沿边线站，z 跟着"越位线/球"走（简化：球所在半场的 z），x 固定在边线内侧 1.2 m
//   - 举旗：越位 / 界外球方向指示 —— flag('offside' | 'throwIn' | 'corner')
import { createPlayerModel } from './character.js';

export const LINESMAN_KIT = {
  jersey: 0xd9f24a,   // 荧光黄
  shorts: 0x14161c,
  socks: 0x14161c,
  accent: 0x2b2f36,
  skin: 0xc79a72,
};

/**
 * @param {object} THREE
 * @param {{side?: 1|-1, cache?:Map, detail?:'full'|'mid'|'low'}} opts side=1 站 +x 边线
 */
export function createLinesman(THREE, opts = {}) {
  const side = opts.side === -1 ? -1 : 1;
  const model = createPlayerModel(THREE, {
    jersey: LINESMAN_KIT.jersey,
    shorts: LINESMAN_KIT.shorts,
    socks: LINESMAN_KIT.socks,
    accent: LINESMAN_KIT.accent,
    skin: LINESMAN_KIT.skin,
    boot: 0x0b0c0e,
    number: null,
    name: '',
    detail: opts.detail || 'mid',
    cache: opts.cache || null,
    cards: false,
    flag: true,          // 建旗子（挂在右手，一直拿在手里；举旗时抬手）
  });
  const object = new THREE.Group();
  object.add(model.object);
  object.position.set(side * 35.4, 0, 0);

  const st = { x: side * 35.4, z: 0, facing: -side * Math.PI / 2, speed: 0, flagged: null, flagUntil: 0 };

  return {
    object,
    model,
    side,
    get x() { return st.x; },
    get z() { return st.z; },
    /** 举旗：kind='offside' 高举过头 / 'throwIn' 斜上举 / 'corner' 指向角旗 */
    flag(kind) {
      const k = kind === 'throwIn' || kind === 'corner' ? kind : 'offside';
      model.flagPose(k);
      st.flagged = k;
      st.flagUntil = 1.1;      // 由 update 的 dt 递减
      return k;
    },
    /**
     * 跟随更新：站在**边线外**沿边线跟球（越位线简化为球 z），身体朝向场内
     * @param {number} dt
     * @param {{z:number}} ball
     * @param {number} t
     * @param {{halfW?:number, halfL?:number}} pitch
     */
    update(dt, ball, t, pitch) {
      const halfW = (pitch && pitch.halfW) || 34;
      const halfL = (pitch && pitch.halfL) || 52.5;
      // 边裁站在边线**外**侧 1.4 m（线是场地边界，人不能站进去）
      const lineX = side * (halfW + 1.4);
      const targetZ = Math.max(-halfL + 3, Math.min(halfL - 3, (ball && ball.z) || 0));
      const dz = targetZ - st.z;
      const dx = lineX - st.x;
      const d = Math.hypot(dx, dz);
      let sp = 0;
      if (d > 0.4) {
        sp = Math.min(7.2, d * 2.0);
        st.x += (dx / d) * sp * dt;
        st.z += (dz / d) * sp * dt;
      }
      // 身体始终朝场内（模型正面是 -z，转到 -side*90° 就是看向球场）
      st.facing = -side * Math.PI / 2;
      if (st.flagUntil > 0) st.flagUntil = Math.max(0, st.flagUntil - dt);
      if (st.flagUntil === 0 && st.flagged) st.flagged = null;
      st.speed = sp;
      object.position.set(st.x, 0, st.z);
      object.rotation.y = st.facing;
      model.update(dt, sp, t);
    },
    info() {
      return {
        side, x: +st.x.toFixed(2), z: +st.z.toFixed(2), speed: +st.speed.toFixed(2),
        flagged: st.flagged, pose: model.poseState(),
        // 边裁手里必须有旗（自检断言用）
        hasFlag: !!(model.hasFlag && model.hasFlag()),
        flagVisible: !!(model.flagVisible && model.flagVisible()),
      };
    },
  };
}
