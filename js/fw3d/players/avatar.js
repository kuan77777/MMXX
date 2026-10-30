// FW3D · 球员 2D 头像（SVG）与外观摘要
//
// 为什么需要：任务要求外观要出现在「球队名单 / 球员资料界面」，而不只是 3D 场景里。
// 3D 场景用 players/appearance.js + body.js 建模；2D 界面用同一份 appearance 数据画一个
// **同源的** 平面头像 —— 同一球员在 2D/3D 里的脸是同一张（肤色、脸型、发型、胡须、眼色都一致）。
//
// 纯函数：输入 appearance，输出 SVG 字符串 / 摘要行。不依赖 THREE、不碰 DOM。
// 用法（浏览器）：
//   import { avatarSvg, appearanceRows } from './players/avatar.js';
//   el.innerHTML = avatarSvg(appearanceFor(record), { size: 96, jersey: 0x2f5e42 });

const hex = (n) => '#' + ((n == null ? 0 : n) >>> 0).toString(16).padStart(6, '0');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(v) ? v : d);

function shade(n, k) {
  const r = clamp(Math.round((((n >>> 16) & 255) * k)), 0, 255);
  const g = clamp(Math.round((((n >>> 8) & 255) * k)), 0, 255);
  const b = clamp(Math.round(((n & 255) * k)), 0, 255);
  return (r << 16) | (g << 8) | b;
}

const PROV_LABEL = { source: '实测资料', estimate: '估计', procedural: '程序生成' };

/**
 * 球员头像 SVG。
 * @param {object} a appearance（players/appearance.js 产出）
 * @param {object} opts { size=112, jersey=0x2f5e42, shorts=0xefeee4, bg='#141a22', caption='' }
 */
export function avatarSvg(a, opts = {}) {
  if (!a) return '';
  const size = num(opts.size, 112);
  const jersey = opts.jersey == null ? 0x2f5e42 : opts.jersey;
  const bg = opts.bg || '#141a22';
  const skin = num(a.skin_tone, 0xb0805e);
  const hair = num(a.hair_color, 0x14100e);
  const beardC = num(a.facial_hair_color, hair);
  const eye = num(a.face && a.face.eyeColor, 0x2a1a12);
  const h = a.head_shape || {};
  const f = a.face || {};

  // 视角：120×140，头中心 (60,52)，肩线 y=112
  const cx = 60, cy = 52;
  const HW = 44 * num(h.width, 1);
  const HH = 52 * num(h.length, 1);
  const jawW = HW * num(h.jaw, 0.92) * (1 - num(h.taper, 0.5) * 0.14);
  const skullTop = cy - HH * 0.5;
  const skullBot = cy + HH * 0.14;
  const jawBot = cy + HH * 0.5 * num(h.chin, 1);
  const parts = [];

  // 肩 / 球衣
  parts.push(`<path d="M18 140 L18 118 Q30 104 44 101 L76 101 Q90 104 102 118 L102 140 Z" fill="${hex(jersey)}"/>`);
  parts.push(`<path d="M50 101 L60 110 L70 101 L66 99 L54 99 Z" fill="${hex(shade(jersey, 0.78))}"/>`);
  // 脖子
  parts.push(`<rect x="${cx - 9}" y="${cy + HH * 0.30}" width="18" height="${Math.max(6, 116 - (cy + HH * 0.30))}" fill="${hex(shade(skin, 0.86))}"/>`);

  // 耳朵（在头之前画，避免盖住脸）
  const earW = 5 * num(f.earSize, 1);
  parts.push(`<rect x="${cx - HW / 2 - earW + 1}" y="${cy - HH * 0.08}" width="${earW}" height="${9 * num(f.earSize, 1)}" rx="2" fill="${hex(shade(skin, 0.94))}"/>`);
  parts.push(`<rect x="${cx + HW / 2 - 1}" y="${cy - HH * 0.08}" width="${earW}" height="${9 * num(f.earSize, 1)}" rx="2" fill="${hex(shade(skin, 0.94))}"/>`);

  // 头：颅骨矩形 + 下颌梯形（对应 3D 的三段头）
  parts.push(`<rect x="${cx - HW / 2}" y="${skullTop}" width="${HW}" height="${skullBot - skullTop}" fill="${hex(skin)}"/>`);
  parts.push(`<path d="M${cx - HW / 2} ${skullBot} L${cx - jawW / 2} ${jawBot} L${cx + jawW / 2} ${jawBot} L${cx + HW / 2} ${skullBot} Z" fill="${hex(skin)}"/>`);
  // 颧骨高光/阴影：只用一条浅色线表现轮廓（低模风格不要渐变）
  if (num(h.cheekbone, 0.45) > 0.55) {
    parts.push(`<rect x="${cx - HW / 2}" y="${cy - HH * 0.02}" width="3" height="${HH * 0.22}" fill="${hex(shade(skin, 1.06))}"/>`);
    parts.push(`<rect x="${cx + HW / 2 - 3}" y="${cy - HH * 0.02}" width="3" height="${HH * 0.22}" fill="${hex(shade(skin, 1.06))}"/>`);
  }

  // 眼睛（眼白 + 瞳孔，与 3D 一致）
  const eyeW = 8 * num(f.eyeSize, 1);
  const eyeH = 5 * num(f.eyeSize, 1);
  const eyeY = cy - HH * 0.06;
  const eyeX = HW * 0.225 * num(f.eyeSpacing, 1);
  const tilt = num(f.eyeTilt, 0) * 10;
  for (const s of [-1, 1]) {
    parts.push(`<g transform="rotate(${(s * tilt).toFixed(1)} ${cx + s * eyeX} ${eyeY + eyeH / 2})">`
      + `<rect x="${cx + s * eyeX - eyeW / 2}" y="${eyeY}" width="${eyeW}" height="${eyeH}" fill="#e6e2d8"/>`
      + `<rect x="${cx + s * eyeX - eyeW * 0.19}" y="${eyeY + eyeH * 0.1}" width="${eyeW * 0.38}" height="${eyeH * 0.8}" fill="${hex(eye)}"/>`
      + `</g>`);
    // 眉毛：厚度/角度
    const bw = eyeW * 1.08 * num(f.browThickness, 1);
    const bh = Math.max(1.6, 2.6 * num(f.browThickness, 1));
    parts.push(`<g transform="rotate(${(s * num(f.browAngle, 0) * 16).toFixed(1)} ${cx + s * eyeX} ${eyeY - 3})">`
      + `<rect x="${cx + s * eyeX - bw / 2}" y="${eyeY - 3 - bh}" width="${bw}" height="${bh}" fill="${hex(hair)}"/>`
      + `</g>`);
  }
  // 鼻
  const noseW = Math.max(3, 5 * num(f.noseWidth, 1));
  const noseH = Math.max(5, 10 * num(f.noseLength, 1));
  parts.push(`<rect x="${cx - noseW / 2}" y="${cy + HH * 0.03}" width="${noseW}" height="${noseH}" fill="${hex(shade(skin, 0.9))}"/>`);
  // 嘴
  const mouthW = 12 * num(f.mouthWidth, 1);
  const mouthH = 2 + 1.4 * num(f.mouthFull, 0.45);
  parts.push(`<rect x="${cx - mouthW / 2}" y="${cy + HH * 0.24}" width="${mouthW}" height="${mouthH}" rx="1" fill="#4a2a20"/>`);

  // 胡须（与 3D 的 5 种形态对应）
  const beard = a.facial_hair || 'none';
  const bc = hex(beardC);
  if (beard === 'stubble') {
    parts.push(`<path d="M${cx - HW / 2 + 2} ${cy + HH * 0.10} Q${cx} ${jawBot + 3} ${cx + HW / 2 - 2} ${cy + HH * 0.10} L${cx + HW / 2 - 2} ${cy + HH * 0.16} Q${cx} ${jawBot - 1} ${cx - HW / 2 + 2} ${cy + HH * 0.16} Z" fill="${hex(shade(skin, 0.82))}" opacity="0.85"/>`);
  } else if (beard === 'mustache') {
    parts.push(`<rect x="${cx - mouthW * 0.55}" y="${cy + HH * 0.19}" width="${mouthW * 1.1}" height="2.6" fill="${bc}"/>`);
  } else if (beard === 'goatee') {
    parts.push(`<rect x="${cx - mouthW * 0.55}" y="${cy + HH * 0.19}" width="${mouthW * 1.1}" height="2.6" fill="${bc}"/>`);
    parts.push(`<path d="M${cx - 7} ${jawBot - 9} L${cx + 7} ${jawBot - 9} L${cx + 4} ${jawBot + 2} L${cx - 4} ${jawBot + 2} Z" fill="${bc}"/>`);
  } else if (beard === 'beard' || beard === 'fullbeard') {
    const grow = beard === 'fullbeard' ? 2.5 : 0;
    parts.push(`<path d="M${cx - HW / 2 + 1} ${cy + HH * 0.02} L${cx - jawW / 2 - 1} ${jawBot + grow} L${cx + jawW / 2 + 1} ${jawBot + grow} L${cx + HW / 2 - 1} ${cy + HH * 0.02} L${cx + HW / 2 - 1} ${cy + HH * 0.12} Q${cx} ${jawBot - 2 + grow} ${cx - HW / 2 + 1} ${cy + HH * 0.12} Z" fill="${bc}" opacity="0.96"/>`);
    parts.push(`<rect x="${cx - mouthW * 0.55}" y="${cy + HH * 0.185}" width="${mouthW * 1.1}" height="2.6" fill="${bc}"/>`);
  }

  // 头发（12 种，与 3D 的 HAIR_GEOMETRY 对应）
  const style = a.hair_style || 'short';
  const capY = skullTop - 1;
  const capH = Math.max(3, HH * 0.16);
  const hairFill = hex(hair);
  const fringe = (x, w, hh2) => `<rect x="${cx - HW / 2 + x}" y="${capY + 1}" width="${w}" height="${hh2}" fill="${hairFill}"/>`;
  if (style === 'buzz') parts.push(`<rect x="${cx - HW / 2}" y="${capY}" width="${HW}" height="${capH * 0.45}" rx="2" fill="${hairFill}"/>`);
  else if (style === 'short') parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY}" width="${HW + 2}" height="${capH}" rx="2" fill="${hairFill}"/>`);
  else if (style === 'crop') { parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY}" width="${HW + 2}" height="${capH * 0.85}" rx="2" fill="${hairFill}"/>`); parts.push(fringe(HW * 0.12, HW * 0.68, capH * 0.5)); }
  else if (style === 'side') { parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY}" width="${HW + 2}" height="${capH * 0.9}" rx="2" fill="${hairFill}"/>`); parts.push(fringe(HW * 0.06, HW * 0.55, capH * 0.6)); }
  else if (style === 'curly') {
    parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY}" width="${HW + 2}" height="${capH * 0.8}" rx="3" fill="${hairFill}"/>`);
    for (let i = 0; i < 5; i++) parts.push(`<circle cx="${cx - HW / 2 + 6 + i * (HW - 12) / 4}" cy="${capY + 1}" r="${capH * 0.42}" fill="${hairFill}"/>`);
  } else if (style === 'afro') {
    parts.push(`<ellipse cx="${cx}" cy="${capY + capH * 0.4}" rx="${HW * 0.66}" ry="${capH * 0.95}" fill="${hairFill}"/>`);
  } else if (style === 'long') {
    parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY}" width="${HW + 2}" height="${capH}" rx="2" fill="${hairFill}"/>`);
    parts.push(`<rect x="${cx - HW / 2 - 2}" y="${capY}" width="5" height="${HH * 0.62}" fill="${hairFill}"/>`);
    parts.push(`<rect x="${cx + HW / 2 - 3}" y="${capY}" width="5" height="${HH * 0.62}" fill="${hairFill}"/>`);
  } else if (style === 'bun') {
    parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY}" width="${HW + 2}" height="${capH * 0.85}" rx="2" fill="${hairFill}"/>`);
    parts.push(`<circle cx="${cx}" cy="${capY - 4}" r="5" fill="${hairFill}"/>`);
  } else if (style === 'ponytail') {
    parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY}" width="${HW + 2}" height="${capH * 0.85}" rx="2" fill="${hairFill}"/>`);
    parts.push(`<path d="M${cx + HW / 2 - 2} ${capY + 2} q10 6 8 20 q-1 6 -6 7 q4 -12 -4 -22 Z" fill="${hairFill}"/>`);
  } else if (style === 'receding') {
    parts.push(`<path d="M${cx - HW / 2} ${capY + capH * 0.5} L${cx - HW / 2} ${capY} L${cx - HW * 0.18} ${capY} L${cx - HW * 0.06} ${capY + capH * 0.55} L${cx + HW * 0.06} ${capY + capH * 0.55} L${cx + HW * 0.18} ${capY} L${cx + HW / 2} ${capY} L${cx + HW / 2} ${capY + capH * 0.5} Z" fill="${hairFill}"/>`);
  } else if (style === 'mohawk') {
    parts.push(`<rect x="${cx - HW * 0.16}" y="${capY - capH * 0.4}" width="${HW * 0.32}" height="${capH * 1.5}" rx="2" fill="${hairFill}"/>`);
  } else if (style === 'bald') { /* 光头 */ }
  // 发带
  if (a.accessories && a.accessories.headband != null) {
    parts.push(`<rect x="${cx - HW / 2 - 1}" y="${capY + capH * 0.55}" width="${HW + 2}" height="3" fill="${hex(a.accessories.headband)}"/>`);
  }

  const cap = opts.caption ? `<div style="margin-top:6px;font:600 10.5px/1.3 system-ui,sans-serif;color:#cfd6e4;text-align:center">${escapeHtml(opts.caption)}</div>` : '';
  return `<div class="fw-avatar" style="display:inline-block;text-align:center">`
    + `<svg viewBox="0 0 120 140" width="${size}" height="${Math.round(size * 140 / 120)}" role="img" aria-label="球员头像">`
    + `<rect x="0" y="0" width="120" height="140" rx="10" fill="${bg}"/>`
    + parts.join('')
    + `</svg>${cap}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 外观摘要行（供球员资料界面显示）。带来源等级，避免把"估计"当"事实"。
 * @returns {{rows: {label:string, value:string, prov:string}[], tags: string[]}}
 */
export function appearanceRows(a) {
  if (!a) return { rows: [], tags: [] };
  const prov = a.provenance || {};
  const pv = (k) => PROV_LABEL[prov[k] || 'procedural'] || '程序生成';
  const rows = [
    { label: '身高', value: a.height + ' cm', prov: pv('height') },
    { label: '体重', value: a.weight + ' kg', prov: pv('weight') },
    { label: '体型', value: ({ lean: '纤细', athletic: '匀称', powerful: '力量型', stocky: '厚实' }[a.bodyType] || '匀称') + '（腿长 ' + a.legProportion + '）', prov: pv('body') },
    { label: '脸型', value: a.headLabel || a.headTemplate || '—', prov: pv('head_shape') },
    { label: '发型', value: (a.hair_label || a.hair_style) + ' · ' + (a.hairColorKey || '') , prov: pv('hair_style') },
    { label: '胡须', value: ({ none: '无', stubble: '胡茬', mustache: '上唇胡', goatee: '山羊胡', beard: '短络腮胡', fullbeard: '络腮胡' }[a.facial_hair] || '无'), prov: pv('facial_hair') },
    { label: '肤色', value: a.skinLabel || a.skinKey || '—', prov: pv('skin_tone') },
  ];
  const tags = [];
  if (a.source === 'real:curated') tags.push('真实球员·人工估计');
  else if (a.source === 'real:procedural') tags.push('真实球员·程序生成');
  else if (a.source === 'user') tags.push('自建球员');
  else tags.push('NPC·程序生成');
  return { rows, tags };
}

export default { avatarSvg, appearanceRows };
