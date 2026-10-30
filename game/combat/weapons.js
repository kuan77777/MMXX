// 武器系统：**数据与模型分离**。
// · WEAPONS 是纯数据表（伤害/射速/弹匣/换弹/后坐/散布/重量/弹药类型 + 功效参数），可被 NPC 复用；
// · buildWeaponMesh() 只负责外观（程序化低多边形占位，接口与 Quaternius Ultimate Guns 的
//   GLB 资源一致：换成真模型只需替换这一个函数里的几何来源）；
// · 开火判定在 combat.js + combat/ballistics.js，用 ColliderWorld 的射线做遮挡，绝不"隔着墙命中"。
//
// 弹药与背包解耦：武器只关心 ammoId，实际弹药数量由 inventory 提供（约定 i_<ammoId>）。
//
// ── 「功效」参数（见 docs/枪械功效设计.md，结算在 combat/ballistics.js）──
//   falloffNear / falloffMin  距离衰减：射程这么多比例内全额，之后线性衰减到 falloffMin
//   penetration               可额外穿透几个目标（每层伤害 × pierceDamageMul）
//   bleed {chance,dps,dur}    致伤：命中概率触发流血（持续掉血，由施加者计时）
//   stagger                   停止力：命中硬直秒数（打断僵尸扑咬/让目标动作变慢）
//   noise                     枪声"响度"（越响招来的僵尸越多越远）
//   heatPerShot / heatMax / heatSpread  连发散热：射得越连续扩散越大

export const WEAPON_TYPES = ['pistol', 'rifle', 'shotgun', 'smg', 'sniper', 'melee'];

/**
 * 武器表。id 是稳定 ID（存档只存 id）。
 * modelHint 对应 Quaternius Ultimate Guns 资源包里的模型名（资源未下载时用程序化占位）。
 */
export const WEAPONS = {
  w_pistol_9mm: {
    id: 'w_pistol_9mm', name: '手枪', type: 'pistol',
    damage: 26, rpm: 300, range: 60, magSize: 12, reloadTime: 1.55,
    recoil: 0.95, spread: 0.014, pellets: 1, ammoId: 'ammo_9mm',
    weight: 1.1, modelHint: 'Pistol', slot: 1,
    soundFire: 'gunshot', soundReload: 'reload',
    // 功效：稳妥的自卫武器。射程短、几乎打不穿、能致少量流血，枪声不算太吵。
    falloffNear: 0.55, falloffMin: 0.5, penetration: 0,
    bleed: { chance: 0.15, dps: 2, dur: 4 }, stagger: 0.18, noise: 3.2,
    heatPerShot: 0.12, heatMax: 1, heatSpread: 1.5,
  },
  w_rifle_556: {
    id: 'w_rifle_556', name: '步枪', type: 'rifle',
    damage: 32, rpm: 620, range: 140, magSize: 30, reloadTime: 2.15,
    recoil: 0.62, spread: 0.0085, pellets: 1, ammoId: 'ammo_556',
    weight: 3.6, modelHint: 'Rifle', slot: 2,
    soundFire: 'gunshot_rifle', soundReload: 'reload',
    // 功效：中距离主力。能穿透 1 个目标（排队来的僵尸一枪两个），伤害衰减平缓。
    falloffNear: 0.55, falloffMin: 0.62, penetration: 1,
    bleed: { chance: 0.35, dps: 3, dur: 5 }, stagger: 0.28, noise: 4.5,
    heatPerShot: 0.1, heatMax: 1, heatSpread: 1.2,
  },
  w_shotgun_12g: {
    id: 'w_shotgun_12g', name: '霰弹枪', type: 'shotgun',
    damage: 12, rpm: 75, range: 32, magSize: 6, reloadTime: 2.7,
    recoil: 2.4, spread: 0.055, pellets: 9, ammoId: 'ammo_12g',
    weight: 4.2, modelHint: 'Shotgun', slot: 3,
    soundFire: 'gunshot_shotgun', soundReload: 'reload',
    // 功效：贴脸处决。9 弹丸、衰减极快、零穿透、流血率最高、硬直最强、枪声最响（最招僵尸）。
    falloffNear: 0.35, falloffMin: 0.22, penetration: 0,
    bleed: { chance: 0.5, dps: 4, dur: 4 }, stagger: 0.5, noise: 5.5,
    heatPerShot: 0.5, heatMax: 1, heatSpread: 2.2,
  },
  w_smg_9mm: {
    id: 'w_smg_9mm', name: '冲锋枪', type: 'smg',
    damage: 18, rpm: 900, range: 55, magSize: 32, reloadTime: 1.9,
    recoil: 0.5, spread: 0.02, pellets: 1, ammoId: 'ammo_9mm',
    weight: 2.6, modelHint: 'SubmachineGun', slot: 5,
    soundFire: 'gunshot', soundReload: 'reload',
    // 功效：近距离压制/清群。射速极高、单发伤害低、几乎无衰减（近距离）、扩散升温最快。
    falloffNear: 0.5, falloffMin: 0.45, penetration: 0,
    bleed: { chance: 0.12, dps: 2, dur: 3 }, stagger: 0.12, noise: 4.2,
    heatPerShot: 0.08, heatMax: 1, heatSpread: 1.1,
  },
  w_sniper_762: {
    id: 'w_sniper_762', name: '狙击步枪', type: 'sniper',
    damage: 105, rpm: 55, range: 220, magSize: 5, reloadTime: 3.1,
    recoil: 3.2, spread: 0.0015, pellets: 1, ammoId: 'ammo_762',
    weight: 5.2, modelHint: 'SniperRifle', slot: 6,
    soundFire: 'gunshot_rifle', soundReload: 'reload',
    // 功效：远程点名。射程最远、几乎不衰减、穿透 2 层、流血与硬直都最强，但射速最慢、枪声最远。
    falloffNear: 0.8, falloffMin: 0.85, penetration: 2,
    bleed: { chance: 0.85, dps: 6, dur: 6 }, stagger: 0.8, noise: 6.5,
    heatPerShot: 0.6, heatMax: 1, heatSpread: 2.6,
  },
  w_melee_bat: {
    id: 'w_melee_bat', name: '球棒', type: 'melee',
    damage: 42, rpm: 95, range: 2.1, magSize: 0, reloadTime: 0,
    recoil: 0, spread: 0, pellets: 1, ammoId: null,
    weight: 1.4, modelHint: null, slot: 4,
    soundFire: 'melee_swing', soundReload: null,
    bleed: { chance: 0.15, dps: 2, dur: 3 }, stagger: 0.45, noise: 1.0,
  },
  // 近战：消防斧（外观 = Survival Pack 的 Axe_Small，不是枪械，所以允许取用）。
  // 比球棒更慢但更疼，装甲/木门也能砸开；保留球棒定义只因旧存档里可能还带着它。
  w_melee_axe: {
    id: 'w_melee_axe', name: '消防斧', type: 'melee',
    damage: 58, rpm: 72, range: 2.2, magSize: 0, reloadTime: 0,
    recoil: 0, spread: 0, pellets: 1, ammoId: null,
    weight: 2.2, modelHint: 'Axe_Small', slot: 4,
    soundFire: 'melee_swing', soundReload: null,
    bleed: { chance: 0.4, dps: 3, dur: 4 }, stagger: 0.7, noise: 1.2,
  },
};

export function weaponById(id) { return WEAPONS[id] || null; }

/** 射击间隔（秒）。 */
export function fireInterval(w) { return w && w.rpm > 0 ? 60 / w.rpm : 1; }

/**
 * 运行时武器实例：只保存可变状态（弹匣内子弹、下次可开火时间、换弹进度）。
 */
export class WeaponState {
  constructor(def) {
    this.def = def;
    this.ammo = def.magSize || 0;
    this.nextFireAt = 0;
    this.reloadingUntil = 0;
    this.reloadStartedAt = 0;
  }

  get id() { return this.def.id; }
  get isEmpty() { return this.def.type !== 'melee' && this.ammo <= 0; }
  get isReloading() { return this.reloadingUntil > 0; }

  canFire(now) { return !this.isReloading && now >= this.nextFireAt && !this.isEmpty; }

  /** 消耗一发，返回 true 表示真的打出去了。 */
  consume(now) {
    if (!this.canFire(now)) return false;
    if (this.def.type !== 'melee') this.ammo -= 1;
    this.nextFireAt = now + fireInterval(this.def);
    return true;
  }

  startReload(now, reserveAmmo) {
    const d = this.def;
    if (!d.magSize || d.type === 'melee') return false;
    if (this.isReloading) return false;
    if (this.ammo >= d.magSize) return false;
    if (reserveAmmo <= 0) return false;
    this.reloadStartedAt = now;
    this.reloadingUntil = now + d.reloadTime;
    return true;
  }

  /** 换弹完成时调用：从备弹里补满，返回实际消耗的备弹数。 */
  finishReload() {
    const d = this.def;
    const need = Math.max(0, d.magSize - this.ammo);
    this.reloadingUntil = 0;
    return need;
  }

  serialize() {
    return { id: this.def.id, ammo: this.ammo };
  }
}

/** 程序化低多边形枪械（占位外观）。真实资源到位后替换本函数即可。 */
export function buildWeaponMesh(THREE, weaponId) {
  const def = WEAPONS[weaponId];
  const g = new THREE.Group();
  g.name = `weapon:${weaponId}`;
  const dark = new THREE.MeshLambertMaterial({ color: 0x24262b, flatShading: true });
  const mid = new THREE.MeshLambertMaterial({ color: 0x3a3d44, flatShading: true });
  const wood = new THREE.MeshLambertMaterial({ color: 0x6a4a30, flatShading: true });

  const add = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  if (!def) return g;
  if (def.type === 'pistol') {
    add(0.075, 0.10, 0.26, 0, 0.03, 0.06, mid);   // 套筒
    add(0.065, 0.16, 0.09, 0, -0.075, -0.02, dark); // 握把
    add(0.04, 0.04, 0.10, 0, 0.06, 0.20, dark);   // 枪口
  } else if (def.type === 'rifle') {
    add(0.085, 0.11, 0.52, 0, 0.02, 0.10, mid);   // 机匣
    add(0.045, 0.045, 0.34, 0, 0.035, 0.48, dark); // 枪管
    add(0.07, 0.15, 0.10, 0, -0.08, -0.02, dark);  // 握把
    add(0.06, 0.19, 0.11, 0, -0.10, 0.18, dark);   // 弹匣
    add(0.075, 0.12, 0.24, 0, 0.02, -0.26, wood);  // 枪托
    add(0.03, 0.05, 0.06, 0, 0.09, 0.28, dark);    // 瞄具
  } else if (def.type === 'shotgun') {
    add(0.09, 0.10, 0.62, 0, 0.02, 0.12, mid);    // 机匣
    add(0.055, 0.055, 0.46, 0, 0.055, 0.56, dark); // 双管
    add(0.08, 0.10, 0.22, 0, -0.06, 0.36, wood);   // 护木
    add(0.07, 0.15, 0.10, 0, -0.08, -0.04, dark);  // 握把
    add(0.08, 0.12, 0.26, 0, 0.01, -0.28, wood);   // 枪托
  } else if (def.type === 'melee') {
    const bat = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 0.85, 6), wood);
    bat.rotation.x = Math.PI / 2.2;
    bat.position.set(0, 0.02, 0.22);
    bat.castShadow = true;
    g.add(bat);
    add(0.05, 0.05, 0.14, 0, -0.02, -0.14, dark);
  }
  // 枪口点：命中/枪火特效从这里发出
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0.04, def.type === 'pistol' ? 0.27 : (def.type === 'shotgun' ? 0.8 : 0.66));
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

export default { WEAPONS, WEAPON_TYPES, WeaponState, buildWeaponMesh, weaponById, fireInterval };
