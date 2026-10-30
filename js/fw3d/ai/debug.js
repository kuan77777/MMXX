// FW3D AI · 调试可视化（设计 02 §8 行为原因日志、03 §8 调试工具）
// 内容：左上俯视雷达（22 人 + 球 + 目标点 + 行为标签）、左下行为明细（行为/评分/切换原因/候选分）。
// 设计语言：细线描边、低透明度色、不使用大色块。
const C = {
  home: 'rgba(90,209,160,',
  away: 'rgba(255,143,143,',
  text: '#dfe6f2',
  dim: 'rgba(223,230,242,.55)',
  line: 'rgba(255,255,255,.18)',
};

export function createDebugHud(host, cfg) {
  const wrap = document.createElement('div');
  wrap.id = 'fw3d-ai-debug';
  wrap.style.cssText = 'position:absolute;right:14px;top:52px;z-index:5;display:none;pointer-events:none;'
    + 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:' + C.text;
  const canvas = document.createElement('canvas');
  const W = 172, H = 266;
  canvas.width = W * 2; canvas.height = H * 2;
  canvas.style.cssText = 'width:' + W + 'px;height:' + H + 'px;border:1px solid ' + C.line
    + ';border-radius:8px;background:rgba(6,10,16,.66);backdrop-filter:blur(2px)';
  wrap.appendChild(canvas);

  const panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;left:14px;bottom:96px;z-index:5;display:none;pointer-events:none;'
    + 'max-width:360px;padding:9px 12px;border:1px solid ' + C.line + ';border-radius:8px;'
    + 'background:rgba(6,10,16,.7);backdrop-filter:blur(2px);'
    + 'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:' + C.text;
  host.appendChild(wrap);
  host.appendChild(panel);

  const ctx = canvas.getContext('2d');
  let visible = !!(cfg && cfg.debug && cfg.debug.enabled);
  let lastDraw = 0;
  let lastDebug = null;

  function setVisible(v) {
    visible = !!v;
    wrap.style.display = visible ? 'block' : 'none';
    panel.style.display = visible ? 'block' : 'none';
  }
  function toggle() { setVisible(!visible); return visible; }
  setVisible(visible);

  // 世界坐标 → 雷达坐标
  function mapper(snap) {
    const pad = 8;
    const w = W - pad * 2, h = H - pad * 2;
    const hw = snap.pitch.halfW, hl = snap.pitch.halfL;
    return (x, z) => ({ x: pad + (x + hw) / (hw * 2) * w, y: pad + (z + hl) / (hl * 2) * h });
  }

  function drawPitch(snap) {
    const m = mapper(snap);
    const s = canvas.width / W;      // 2x 缩放
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const a = m(-snap.pitch.halfW, -snap.pitch.halfL), b = m(snap.pitch.halfW, snap.pitch.halfL);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    // 中线 + 中圈
    ctx.beginPath(); ctx.moveTo(a.x, (a.y + b.y) / 2); ctx.lineTo(b.x, (a.y + b.y) / 2); ctx.stroke();
    ctx.beginPath();
    ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, (b.x - a.x) * 0.135, 0, Math.PI * 2);
    ctx.stroke();
    // 禁区（16.5 m 深、40.32 m 宽）
    for (const side of [-1, 1]) {
      const z0 = side * snap.pitch.halfL;
      const z1 = side * (snap.pitch.halfL - 16.5);
      const p0 = m(-20.16, z0), p1 = m(20.16, z1);
      ctx.strokeRect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
      const q0 = m(-9.16, z0), q1 = m(9.16, side * (snap.pitch.halfL - 5.5));
      ctx.strokeRect(Math.min(q0.x, q1.x), Math.min(q0.y, q1.y), Math.abs(q1.x - q0.x), Math.abs(q1.y - q0.y));
    }
  }

  function dot(m, p, color, r) {
    const q = m(p.x, p.z);
    ctx.beginPath(); ctx.arc(q.x, q.y, r || 2.4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return q;
  }

  function draw(snap, dbg) {
    if (!visible || !snap || !dbg) return;
    const now = performance.now();
    const fps = (cfg && cfg.debug && cfg.debug.hudFps) || 10;
    if (now - lastDraw < 1000 / fps) return;
    lastDraw = now;
    lastDebug = dbg;
    drawPitch(snap);
    const m = mapper(snap);

    // 目标点与连线
    for (const row of dbg.players) {
      const p = snap.byId[row.id];
      if (!p || !row.target) continue;
      const from = m(p.x, p.z);
      const to = m(row.target.x, row.target.z);
      const isHome = p.team === 'home';
      ctx.strokeStyle = (isHome ? C.home : C.away) + '0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.strokeStyle = (isHome ? C.home : C.away) + '0.5)';
      ctx.beginPath();
      ctx.moveTo(to.x - 2.5, to.y); ctx.lineTo(to.x + 2.5, to.y);
      ctx.moveTo(to.x, to.y - 2.5); ctx.lineTo(to.x, to.y + 2.5);
      ctx.stroke();
    }

    // 球员点
    for (const p of snap.players) {
      const color = (p.team === 'home' ? C.home : C.away) + (p.isGk ? '0.45)' : '0.92)');
      const q = dot(m, p, color, p.isUser ? 3.2 : 2.4);
      if (p.isUser) {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(q.x, q.y, 4.6, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // 球
    const bq = dot(m, { x: snap.ball.x, z: snap.ball.z }, '#ffffff', 2.6);
    if (snap.ball.speed > 0.5) {
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.beginPath(); ctx.moveTo(bq.x, bq.y);
      ctx.lineTo(bq.x + snap.ball.vx * 1.2, bq.y + snap.ball.vz * 1.2);
      ctx.stroke();
    }

    // 行为标签（只标最活跃的几个，避免糊成一片）
    const labels = (cfg && cfg.debug && cfg.debug.labels) || 6;
    const marked = dbg.players
      .filter((r) => r.behavior !== 'RecoverShape')
      .sort((a1, b1) => b1.score - a1.score)
      .slice(0, labels);
    ctx.font = '9px ui-monospace,monospace';
    ctx.fillStyle = C.text;
    for (const r of marked) {
      const p = snap.byId[r.id];
      if (!p) continue;
      const q = m(p.x, p.z);
      ctx.fillStyle = p.team === 'home' ? 'rgba(90,209,160,.95)' : 'rgba(255,143,143,.95)';
      ctx.fillText(r.behaviorLabel + ' ' + r.score.toFixed(2), q.x + 5, q.y - 3);
    }
    // 视角队朝向提示（雷达上边永远是主队自己的球门 = -z）
    ctx.fillStyle = C.dim;
    ctx.font = '9px ui-monospace,monospace';
    ctx.fillText('雷达 · 上 = 我方球门', 8, H - 4);
  }

  function renderPanel(dbg) {
    if (!visible || !dbg) return;
    const carrier = dbg.carrier && dbg.players.find((r) => r.id === dbg.carrier);
    const rows = dbg.players
      .filter((r) => r.team === 'home')
      .sort((a, b) => {
        const w = (r) => (r.behavior === 'RecoverShape' ? 1 : 0);
        return w(a) - w(b) || b.score - a.score;
      })
      .slice(0, 6);
    const phase = dbg.home.phase === 'attack' ? '进攻' : '防守';
    let html = '<div style="letter-spacing:.18em;font-size:9px;color:' + C.dim + '">NPC 决策 · ' + phase
      + ' · 球 ' + dbg.ball.x.toFixed(0) + ',' + dbg.ball.z.toFixed(0) + ' @' + dbg.ball.speed.toFixed(1) + ' m/s</div>';
    if (carrier) {
      html += '<div style="margin:3px 0 5px;color:rgba(90,209,160,.95)">持球 ' + (carrier.name || carrier.id) + ' · ' + carrier.behaviorLabel
        + ' · ' + carrier.reason + '</div>';
    }
    for (const r of rows) {
      const sc = (r.scores || []).slice(0, 3).map((s) => s.id + ' ' + s.score).join('  ');
      html += '<div style="margin-top:3px">'
        + '<span style="color:' + C.dim + '">' + (r.number != null ? r.number : '·') + '</span> '
        + '<span style="color:#eaf1fb">' + (r.name || r.id) + '</span> '
        + '<span style="color:rgba(90,209,160,.9)">' + r.behaviorLabel + ' ' + r.score.toFixed(2) + '</span> '
        + '<span style="color:' + C.dim + '">/ ' + r.roleLabel + ' / 体力' + r.stamina + '</span>'
        + '<div style="color:' + C.dim + ';font-size:10px">　' + (r.why || []).join(' · ') + '</div>'
        + (sc ? '<div style="color:rgba(223,230,242,.38);font-size:10px">　候选 ' + sc + '</div>' : '')
        + '</div>';
    }
    if (dbg.log && dbg.log.length) {
      const l = dbg.log[dbg.log.length - 1];
      html += '<div style="margin-top:6px;padding-top:5px;border-top:1px solid ' + C.line + ';color:' + C.dim + '">'
        + '切换 ' + (l.name || l.id) + '：' + (l.from || '—') + ' → ' + l.to + '（' + l.score + '）</div>';
    }
    panel.innerHTML = html;
  }

  return {
    setVisible, toggle, visible: () => visible,
    update(snap, dbg) { if (!visible) return; draw(snap, dbg); renderPanel(dbg); },
    last: () => lastDebug,
    dispose() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    },
  };
}
