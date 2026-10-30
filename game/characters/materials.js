// 角色材质缓存：每个 kit（俱乐部+号码+图案）只生成一次贴图与材质，多个 NPC 共享。
// 作用有二：① 减少 draw call 状态切换；② 避免 60 个 NPC 各自 new 一遍 256² canvas 贴图。
import { makeKit, createKitTexture } from '../appearance/kit.js';

export class KitMaterialCache {
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.max = opts.max || 64;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  static keyOf(kit) {
    return `${kit.clubId || '-'}|${kit.number}|${kit.pattern}|${kit.shirt}|${kit.shorts}`;
  }

  get(kit) {
    const key = KitMaterialCache.keyOf(kit);
    const found = this.map.get(key);
    if (found) {
      this.hits += 1;
      // LRU：命中后移到末尾
      this.map.delete(key);
      this.map.set(key, found);
      return found;
    }
    this.misses += 1;
    const texture = createKitTexture(kit, this.THREE);
    const material = new this.THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      map: texture || null,
    });
    material.name = `kit:${key}`;
    const entry = { material, texture, key };
    this.map.set(key, entry);
    this._evict();
    return entry;
  }

  _evict() {
    while (this.map.size > this.max) {
      const firstKey = this.map.keys().next().value;
      const entry = this.map.get(firstKey);
      this.map.delete(firstKey);
      // 只释放 GPU 资源；共享材质可能仍被场景引用，这里用 dispose 是安全的，
      // 因为被淘汰意味着下一帧会重新生成一份。
      try { if (entry.texture) entry.texture.dispose(); } catch (e) {}
      try { if (entry.material) entry.material.dispose(); } catch (e) {}
    }
  }

  dispose() {
    for (const entry of this.map.values()) {
      try { if (entry.texture) entry.texture.dispose(); } catch (e) {}
      try { if (entry.material) entry.material.dispose(); } catch (e) {}
    }
    this.map.clear();
  }
}

/** 没有球员/俱乐部数据时的兜底外观（避免崩溃，也避免全都长一样）。 */
export function fallbackAppearance(seedId) {
  return {
    playerId: String(seedId || 'anon'),
    height: 172 + (Number(seedId) % 9 || 0),
    skin_tone: 0xc9a27b,
    hair_color: 0x20180f,
    hair_style: 'short',
    body: { shoulderWidth: 1, chestDepth: 1, waist: 1, hipWidth: 1, thigh: 1, calf: 1, armLength: 1, legProportion: 1, neck: 1, muscle: 1 },
  };
}

export { makeKit };
export default { KitMaterialCache, fallbackAppearance, makeKit };
