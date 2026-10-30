// 浏览器本地存档（IndexedDB + gzip），支持多个存档位。
// 不用 localStorage：整个世界序列化后 10–35MB，超过 localStorage 配额。
(function () {
  const DB_NAME = 'football-world';
  const STORE = 'saves';
  const DEFAULT_KEY = 'slot';
  const SLOTS = ['slot', 'slot-2', 'slot-3'];
  let lastSaveAt = 0;
  let saving = false;

  function slotKey(slot) {
    const n = Number(slot);
    if (!n || n < 1 || n > 3) return DEFAULT_KEY;
    return n === 1 ? 'slot' : 'slot-' + n;
  }

  // ── gzip 压缩（Chrome/Edge 80+ 支持 CompressionStream；不支持时退回明文） ──
  async function zip(str) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(new TextEncoder().encode(str));
      writer.close();
      return await new Response(cs.readable).arrayBuffer();
    } catch (e) {
      console.warn('[FOOTBALL WORLD] 压缩失败，改用明文存档', e);
      return null;
    }
  }

  async function unzip(buf) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(buf));
    writer.close();
    return await new Response(ds.readable).text();
  }

  function open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('浏览器不支持 IndexedDB，无法存档'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('打开存档数据库失败'));
    });
  }

  function put(value, key) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key || DEFAULT_KEY);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  function get(key) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const q = tx.objectStore(STORE).get(key || DEFAULT_KEY);
      q.onsuccess = () => { db.close(); resolve(q.result || null); };
      q.onerror = () => { db.close(); reject(q.error); };
    }));
  }

  function remove(key) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  function clear() {
    return Promise.all(SLOTS.map((k) => remove(k))).then(() => true).catch(() => false);
  }

  // 读取所有存档位的元信息（不加载完整数据）
  async function list() {
    const out = [];
    for (let i = 1; i <= 3; i++) {
      const key = slotKey(i);
      try {
        const rec = await get(key);
        out.push({ slot: i, exists: !!rec, meta: rec ? rec.meta || {} : null, bytes: rec ? (rec.gz ? (rec.data && rec.data.byteLength) : String(rec.json || '').length) : 0 });
      } catch (e) {
        out.push({ slot: i, exists: false, meta: null, bytes: 0 });
      }
    }
    return out;
  }

  window.FWStore = {
    available: () => !!window.indexedDB,
    lastSaveAt: () => lastSaveAt,
    clear,
    list,
    slots: 3,
    _zip: zip,
    _unzip: unzip,
    /** 保存到指定存档位：{ gz:true, data:ArrayBuffer, meta } 或 { gz:false, json, meta } */
    async save(json, slot) {
      const started = Date.now();
      const key = slotKey(slot);
      const packed = await zip(json);
      const st = (window.FW && window.FW.state) || {};
      const meta = {
        at: started,
        date: st.date || '',
        season: st.season || '',
        player: (st.player && st.player.name) || null,
        club: (st.player && st.player.clubId && window.FW && window.FW.clubName) ? window.FW.clubName(st.player.clubId) : null,
        bytes: json.length,
      };
      if (packed) {
        await put({ gz: true, data: packed, meta }, key);
        return { ok: true, ms: Date.now() - started, bytes: json.length, stored: packed.byteLength };
      }
      await put({ gz: false, json, meta }, key);
      return { ok: true, ms: Date.now() - started, bytes: json.length, stored: json.length };
    },
    async load(slot) {
      const rec = await get(slotKey(slot));
      if (!rec) return null;
      const json = rec.gz ? await unzip(rec.data) : rec.json;
      return { json, meta: rec.meta || {} };
    },
  };

  // 静默自动存档：默认 45 秒内不重复写盘，避免每次推进都压缩整份世界
  window.autoSave = async function (force, slot) {
    if (!window.FW || !window.FW.saveState) return false;
    // 手动存档若撞上正在进行的自动存档，稍等重试，避免"点了没反应"
    if (saving) {
      for (let i = 0; i < 10 && saving; i++) await new Promise((r) => setTimeout(r, 200));
      if (saving) return false;
    }
    const now = Date.now();
    if (!force && now - lastSaveAt < 45000) return false;
    saving = true;
    try {
      const json = window.FW.saveState();
      await window.FWStore.save(json, slot || 1);
      lastSaveAt = now;
      return true;
    } catch (e) {
      console.warn('[FOOTBALL WORLD] 自动存档失败：', e);
      return false;
    } finally {
      saving = false;
    }
  };

  window.scheduleAutoSave = function () { setTimeout(() => window.autoSave(true), 400); };
})();
