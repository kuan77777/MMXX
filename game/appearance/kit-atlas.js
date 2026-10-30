// 球衣图集生成器：把「球衣包」里的官方商品照片，按球衣包自带的 UV 分区模板贴成一张可用图集。
//
// 依据：球衣包 `06_游戏贴图/UV_Maps/README_UV说明.txt` 明确写了
//   · 官方 UV 不存在，任何"中超球衣 UV"都是第三方二次绘制；
//   · 包内提供 1 张自建分区参考模板（FRONT / BACK / SLEEVE / COLLAR / HEM / SIDE SEAM / FABRIC TILE）；
//   · 用法就是"把 01_球队球衣 里的正面/背面/细节照片按区块贴到自己的球衣模型上"。
// 所以这里不是伪造官方 UV，而是按那份分区模板的**排布约定**自建一张图集，
// 芯片内容来自包内 `06_游戏贴图/PNG/*_Home_Front_Texture_*.png`（官方商品正面图，已裁掉队名条）。
//
// 诚实说明（同步写进 ASSET_CATALOG.md）：
//   · 包里只有"正面"纹理，没有背面纹理 → 背面面板用正面水平镜像 + 印号码/姓名，
//     这是**替代方案**，不是真实背面版型；
//   · 侧面/袖子/领口/下摆没有独立素材 → 取正面照片采样出的主色填充，而不是编造图案。

/** 图集分区（UV 空间，v 向上）。排布遵循球衣包模板的相对位置，具体像素由本模块定义。 */
import { cslKitForClub, getCrest, getBrand } from './csl-kits.js';

export const ATLAS_SLOTS = {
  front: { u0: 0.02, u1: 0.47, v0: 0.50, v1: 0.98 },
  back: { u0: 0.51, u1: 0.96, v0: 0.50, v1: 0.98 },
  collar: { u0: 0.02, u1: 0.45, v0: 0.40, v1: 0.48 },
  hem: { u0: 0.51, u1: 0.96, v0: 0.40, v1: 0.48 },
  sleeveR: { u0: 0.02, u1: 0.20, v0: 0.22, v1: 0.38 },
  sleeveL: { u0: 0.23, u1: 0.41, v0: 0.22, v1: 0.38 },
  sideR: { u0: 0.02, u1: 0.20, v0: 0.02, v1: 0.18 },
  sideL: { u0: 0.23, u1: 0.41, v0: 0.02, v1: 0.18 },
  fabric: { u0: 0.51, u1: 0.96, v0: 0.02, v1: 0.18 },
};

const slotPx = (slot, w, h) => ({
  x: Math.round(slot.u0 * w),
  y: Math.round((1 - slot.v1) * h),
  w: Math.round((slot.u1 - slot.u0) * w),
  h: Math.round((slot.v1 - slot.v0) * h),
});

function hexOf(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function contrastText(bgHex) {
  return luminance(bgHex) > 0.45 ? '#101010' : '#ffffff';
}

/** 把颜色变暗/变亮（用于领口、下摆的层次）。 */
export function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))));
  return hexOf(f(r), f(g), f(b));
}

/**
 * 从正面图里采样主色（裁掉边缘背景影响：只取中间 40% 宽的竖条）。
 * @returns {string} #rrggbb
 */
export function samplePrimaryColor(image, canvasFactory) {
  const size = 24;
  const c = canvasFactory(size, size);
  const ctx = c.getContext('2d');
  if (!ctx) return '#3d6b52';
  const sw = image.width, sh = image.height;
  // 取样区域：胸腹之间那块"纯布料"（避开队徽、赞助商、领口、下摆和背景渐变）
  ctx.drawImage(image, sw * 0.42, sh * 0.52, sw * 0.16, sh * 0.24, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 32) continue;
    // 跳过接近纯白/纯黑的像素（商标、阴影），避免主色被拉偏
    const lum = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    if (lum > 0.94 || lum < 0.06) continue;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
  }
  if (!n) return '#3d6b52';
  return hexOf(r / n, g / n, b / n);
}

/**
 * 生成一张球衣图集。
 * @param {object} p
 * @param {HTMLImageElement} p.front 官方正面图
 * @param {object} p.kit makeKit() 的结果（号码/姓名/图案）
 * @param {number} p.size 图集边长（默认 1024）
 * @param {Function} p.canvasFactory (w,h)=>canvas
 * @returns {{canvas, primary, secondary, hasBack}}
 */
export function buildKitAtlas({ front, kit, size = 1024, canvasFactory, crest = null, brand = null }) {
  const mk = canvasFactory || ((w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  });
  const canvas = mk(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { canvas, primary: '#3d6b52', secondary: '#ffffff', hasBack: false };

  // 底色：先铺一层主色，避免任何缝隙露出透明
  const primary = front ? samplePrimaryColor(front, mk) : (kit && kit.primary) || '#3d6b52';
  const secondary = (kit && kit.secondary) || shade(primary, 0.55);
  ctx.fillStyle = primary;
  ctx.fillRect(0, 0, size, size);

  // 正面：裁掉四周背景与底部队名条，只取球衣主体
  const cropFront = (target, rect, mirror) => {
    ctx.save();
    if (mirror) {
      ctx.translate(rect.x + rect.w, rect.y);
      ctx.scale(-1, 1);
      ctx.beginPath();
      ctx.rect(0, 0, rect.w, rect.h);
      ctx.clip();
      // 正面图有效区域：水平 18%~82%，垂直 4%~86%（下方是队名文字，切掉）
      ctx.drawImage(front, front.width * 0.18, front.height * 0.04,
        front.width * 0.64, front.height * 0.82, 0, 0, rect.w, rect.h);
    } else {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.drawImage(front, front.width * 0.18, front.height * 0.04,
        front.width * 0.64, front.height * 0.82, rect.x, rect.y, rect.w, rect.h);
    }
    ctx.restore();
  };

  const fRect = slotPx(ATLAS_SLOTS.front, size, size);
  const bRect = slotPx(ATLAS_SLOTS.back, size, size);
  let hasBack = false;
  if (front) {
    cropFront('front', fRect, false);
    // 背面：水平镜像正面（包内没有背面纹理，这是替代方案）
    cropFront('back', bRect, true);
    hasBack = true;
  }

  // 纯色方案（用户最终选定）：整件球衣只用**主场主色**，不做次色色带、不做图案。
  // 底图已经把整张图集铺成主色，这里只需要在纯色模式下跳过所有分区填色；
  // 背号仍然绘制（那是球员信息，不是装饰）。
  const solid = !front;
  const fillSlot = (slot, color) => {
    if (solid) return;   // 纯色模式：所有分区都保持主色
    const r = slotPx(slot, size, size);
    ctx.fillStyle = color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  };
  fillSlot(ATLAS_SLOTS.sleeveL, secondary);
  fillSlot(ATLAS_SLOTS.sleeveR, secondary);
  fillSlot(ATLAS_SLOTS.sideL, shade(primary, -0.14));
  fillSlot(ATLAS_SLOTS.sideR, shade(primary, -0.14));
  fillSlot(ATLAS_SLOTS.collar, shade(secondary, -0.12));
  fillSlot(ATLAS_SLOTS.hem, secondary);
  fillSlot(ATLAS_SLOTS.fabric, primary);

  // 正面胸前：左胸队徽、右胸品牌商标（低多边形尺度下只做小图标，不抢主体色）
  // 队徽 / 商标默认按 kit.clubId 从 csl-kits 的图片缓存里取，调用方不用传参。
  {
    const kitTeam = kit && kit.clubId ? cslKitForClub(kit.clubId) : null;
    const crestImg = crest || (kitTeam ? getCrest(kitTeam.slug) : null);
    const brandImg = brand || getBrand();
    if (crestImg || brandImg) {
      const f = slotPx(ATLAS_SLOTS.front, size, size);
      const drawMark = (img, cxFrac, cyFrac, sizeFrac) => {
        if (!img) return;
        const w = Math.round(f.w * sizeFrac);
        const h = Math.round(w * (img.height / Math.max(1, img.width)));   // 保持原始宽高比
        const x = Math.round(f.x + f.w * cxFrac - w / 2);
        const y = Math.round(f.y + f.h * cyFrac - h / 2);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, x, y, w, h);
        ctx.restore();
      };
      drawMark(crestImg, 0.30, 0.18, 0.14);
      drawMark(brandImg, 0.70, 0.19, 0.11);

      // 胸前广告：队徽/商标下方居中一行文字（用文字代替 logo，避免再引入一堆版权图）。
      // 字号按可用宽度自动收敛，长名字不会顶到袖子。
      const sponsor = kitTeam && kitTeam.sponsor ? String(kitTeam.sponsor) : '';
      if (sponsor) {
        const maxW = f.w * 0.62;
        let fs = Math.max(8, Math.round(f.h * 0.115));
        const setFont = () => { ctx.font = `700 ${fs}px Arial, "Noto Sans SC", sans-serif`; };
        setFont();
        while (ctx.measureText(sponsor).width > maxW && fs > 8) { fs -= 2; setFont(); }
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, fs * 0.14);
        ctx.strokeStyle = shade(primary, -0.55);
        ctx.fillStyle = contrastText(primary);
        const sx = f.x + f.w * 0.5;
        const sy = f.y + f.h * 0.42;
        ctx.strokeText(sponsor, sx, sy);
        ctx.fillText(sponsor, sx, sy);
        ctx.restore();
      }
    }
  }

  // 背号：只印号码、不印姓名（避免文字和号码挤在一起）。
  // 排版：号码放在背面上半部中央，四周留边；字号按"数字个数"和可用框宽取小，
  // 两位数也不会横向挤扁；再描一圈深色边，任何底色上都看得清。
  const number = kit && Number.isFinite(kit.number) && kit.number > 0 ? String(kit.number) : '';
  if (number) {
    const boxW = bRect.w * 0.66;              // 号码可用宽度（左右各留 17%）
    const boxH = bRect.h * 0.48;              // 号码可用高度：保持大号，不缩小
    const cx = bRect.x + bRect.w / 2;
    const cy = bRect.y + bRect.h * 0.40;      // 略偏上，避开下摆
    const byWidth = (boxW / Math.max(1, number.length)) * 1.55;
    const numSize = Math.max(8, Math.floor(Math.min(boxH, byWidth)));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${numSize}px Arial, "Noto Sans SC", sans-serif`;
    ctx.lineWidth = Math.max(2, numSize * 0.09);
    ctx.strokeStyle = shade(primary, -0.55);
    ctx.fillStyle = contrastText(primary);
    ctx.strokeText(number, cx, cy);
    ctx.fillText(number, cx, cy);
    // 背号上方印姓名：与号码同一套字体（700 / Arial / Noto Sans SC），
    // 位置按号码顶边推算并留出间隙，整体不越过面板上沿，长名字自动缩字号。
    const rawName = (kit && kit.name) ? String(kit.name).slice(0, 14) : '';
    // 纯 ASCII 名字按球衣惯例转大写；中文原样保留
    const pname = /^[\x20-\x7E]+$/.test(rawName) ? rawName.toUpperCase() : rawName;
    if (pname) {
      const nmaxW = bRect.w * 0.56;
      let nfs = Math.max(7, Math.round(numSize * 0.26));
      const setN = () => { ctx.font = `700 ${nfs}px Arial, "Noto Sans SC", sans-serif`; };
      setN();
      while (ctx.measureText(pname).width > nmaxW && nfs > 7) { nfs -= 1; setN(); }
      // 号码顶边 ≈ cy - numSize*0.62；姓名基线下移 nfs*0.5，再留 numSize*0.20 间隙
      const gap = Math.max(2, numSize * 0.20);
      let ny = cy - numSize * 0.62 - gap - nfs * 0.5;
      const topLimit = bRect.y + bRect.h * 0.06 + nfs * 0.5;
      if (ny < topLimit) ny = topLimit;
      ctx.lineWidth = Math.max(1, nfs * 0.16);
      ctx.strokeText(pname, cx, ny);
      ctx.fillText(pname, cx, ny);
    }
    ctx.restore();
  }

  // 分区边框（调试用，默认不画；需要时把 debug 传进来）
  return { canvas, primary, secondary, hasBack };
}

export default { ATLAS_SLOTS, buildKitAtlas, samplePrimaryColor, contrastText, shade };
