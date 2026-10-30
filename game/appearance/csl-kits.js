// 中超 2026 球衣 → 游戏俱乐部映射。
// 依据：球衣包 `00_总览与球队名单/Teams.csv`，以及本仓库足球库里**本来就存在**的中超/中甲俱乐部
// （C231~C248，L19 中超 / L20 中甲）——所以不需要另造球队数据，直接用现有 clubId。
//
// ⚠️ 许可：球衣图与队徽来自 Nike 中国官网商品图、球衫堂、kotologo，
//    属于**俱乐部/品牌版权素材**，不是 CC0。仅适合本地个人研究；商业发行必须取得授权。
//    详见 ASSET_CATALOG.md 第 6 节。

/**
 * @typedef {{slug,teamZh,teamEn,clubId,color,colorName,front}} CslKit
 */

/**
 * 次色：整体走"主色 + 一个干净的搭配色"，不追求复刻真实客场/第三球衣。
 * 少数球队的主色名字本身就带两种颜色（橙+深蓝、蓝黑），或真实球衣有标志性副色（蓉城金、浙江黄），
 * 这几支用显式覆盖；其余按明度自动配：亮色配深藏青，深色配米白。
 */
const SECONDARY_OVERRIDE = {
  chengdu_rongcheng: '#e8c15a',   // 红 + 金
  zhejiang: '#f0d040',            // 绿 + 黄
  qingdao_hainiu: '#14306b',      // 橙 + 深蓝（队名即"橙+深蓝"）
  wuhan_three_towns: '#14161a',   // 蓝 + 黑（队名即"蓝黑"）
  yunnan_yukun: '#14306b',        // 橙红 + 藏青
  tianjin_jinmen_tiger: '#f0efe8',// 紫 + 米白
};

/**
 * 胸前广告（赞助商名称）。
 * 来源：直播吧《中超各队胸前广告盘点》(2023-04-17)
 *   https://news.zhibo8.com/zuqiu/2023-04-17/643d5940eaa10.htm
 * 用户允许用非本赛季数据。只有能对上的 10 支填了名字；其余 6 支（云南玉昆/青岛西海岸/
 * 大连英博/深圳新鹏城/辽宁铁人/重庆铜梁龙）是近年新军或易名球队，该盘点里没有对应项，
 * 因此留空（球衣不印广告），不猜。空字符串 = 该赛季无胸前广告。
 */
const SPONSOR = {
  shanghai_port: '荣威',
  shanghai_shenhua: '交通银行',
  beijing_guoan: '京东',
  chengdu_rongcheng: '成都建工',
  zhejiang: '松下电器',
  henan: '郑发集团',
  wuhan_three_towns: '融创桃花源',
  shandong_taishan: '',        // 该赛季无胸前广告
  tianjin_jinmen_tiger: '',
  qingdao_hainiu: '',
  // 以下 3 支查不到胸前广告记录，用"球队命名企业/股东名"代替（中超常见做法），
  // 标注来源为推断，不是已核实的胸前广告合同。
  yunnan_yukun: '玉昆钢铁',
  qingdao_west_coast: '中创恒泰',
  dalian_yingbo: '英博集团',
  // 深圳新鹏城 / 辽宁铁人 / 重庆铜梁龙：查不到赞助商记录，队名也不是企业名，
  // 按用户要求用"球队自身名称"当胸前字（当 wordmark 用，不冒充赞助商）。
  shenzhen_peng_city: '新鹏城',
  liaoning_tieren: '辽宁铁人',
  chongqing_tonglianglong: '铜梁龙',
};

function lumOf(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 16 支球队（顺序同 Teams.csv）。color=主色，secondary=次色（自动配或显式覆盖）。 */
export const CSL_KITS = [
  { slug: 'shanghai_port', teamZh: '上海海港', teamEn: 'Shanghai Port', clubId: 'C231', color: '#c8102e', colorName: '红色' },
  { slug: 'shanghai_shenhua', teamZh: '上海申花', teamEn: 'Shanghai Shenhua', clubId: 'C232', color: '#1a4f9c', colorName: '蓝色' },
  { slug: 'beijing_guoan', teamZh: '北京国安', teamEn: 'Beijing Guoan', clubId: 'C234', color: '#0f8a4a', colorName: '绿色' },
  { slug: 'chengdu_rongcheng', teamZh: '成都蓉城', teamEn: 'Chengdu Rongcheng', clubId: 'C233', color: '#c8102e', colorName: '红色' },
  { slug: 'shandong_taishan', teamZh: '山东泰山', teamEn: 'Shandong Taishan', clubId: 'C235', color: '#e8641a', colorName: '橙色' },
  { slug: 'zhejiang', teamZh: '浙江队', teamEn: 'Zhejiang', clubId: 'C237', color: '#0f8a4a', colorName: '绿色' },
  { slug: 'tianjin_jinmen_tiger', teamZh: '天津津门虎', teamEn: 'Tianjin Jinmen Tiger', clubId: 'C236', color: '#6a3d9a', colorName: '紫色' },
  { slug: 'yunnan_yukun', teamZh: '云南玉昆', teamEn: 'Yunnan Yukun', clubId: 'C242', color: '#e8531a', colorName: '橙红' },
  { slug: 'qingdao_west_coast', teamZh: '青岛西海岸', teamEn: 'Qingdao West Coast', clubId: 'C238', color: '#f0c419', colorName: '黄色' },
  { slug: 'henan', teamZh: '河南队', teamEn: 'Henan', clubId: 'C240', color: '#c8102e', colorName: '红色' },
  { slug: 'dalian_yingbo', teamZh: '大连英博', teamEn: 'Dalian Yingbo', clubId: 'C243', color: '#2fa8de', colorName: '天蓝色' },
  { slug: 'shenzhen_peng_city', teamZh: '深圳新鹏城', teamEn: 'Shenzhen Peng City', clubId: 'C241', color: '#2fa8de', colorName: '天蓝色' },
  { slug: 'qingdao_hainiu', teamZh: '青岛海牛', teamEn: 'Qingdao Hainiu', clubId: 'C244', color: '#e8641a', colorName: '橙+深蓝' },
  { slug: 'wuhan_three_towns', teamZh: '武汉三镇', teamEn: 'Wuhan Three Towns', clubId: 'C239', color: '#14306b', colorName: '蓝黑' },
  { slug: 'liaoning_tieren', teamZh: '辽宁铁人', teamEn: 'Liaoning Tieren', clubId: 'C247', color: '#c8102e', colorName: '红色' },
  { slug: 'chongqing_tonglianglong', teamZh: '重庆铜梁龙', teamEn: 'Chongqing Tonglianglong', clubId: 'C248', color: '#c8102e', colorName: '红色' },
].map((t) => ({
  ...t,
  secondary: SECONDARY_OVERRIDE[t.slug] || (lumOf(t.color) > 0.6 ? '#1b2a3a' : '#f0efe8'),
  sponsor: SPONSOR[t.slug] || '',             // 胸前广告文字（空 = 不印）
  crest: `assets/kits/${t.slug}_crest.png`,    // 透明底队徽（球衣包 04_队徽与赞助商）
  front: `assets/kits/${t.slug}_front.png`,   // 原始正面照片（当前方案未使用）
}));

/** 球衣品牌商标（球衣包 05 里的 Nike 合作商标）。 */
export const KIT_BRAND = { slug: 'nike', path: 'assets/kits/brand_nike.png', name: 'Nike' };

export const CSL_BY_CLUB = new Map(CSL_KITS.map((t) => [t.clubId, t]));
export const CSL_BY_SLUG = new Map(CSL_KITS.map((t) => [t.slug, t]));

/** 按俱乐部 id 找球衣；找不到返回 null（调用方回退到程序化配色）。 */
export function cslKitForClub(clubId) {
  return CSL_BY_CLUB.get(String(clubId)) || null;
}

export const CSL_LICENSE_NOTE = '球衣图/队徽来源：Nike 中国官网商品图、球衫堂 kitstown、kotologo 位图；'
  + '属俱乐部与品牌版权素材，非 CC0，商业使用需授权。';

// ── 队徽 / 商标的图片缓存 ────────────────────────────────────────────────
// 放在这里（而不是 game.js）有两个原因：
//   1) 图集生成是同步的，需要图片已经就绪 → 用模块顶层 await 预载完再放行；
//   2) game.js 有别的改动在并发进行，尽量不去动它。
// Node 环境没有 Image，自动跳过（单测里这些图不参与逻辑）。
export const crestImages = new Map();
let brandImage = null;

export function getCrest(slug) { return crestImages.get(slug) || null; }
export function getBrand() { return brandImage; }

if (typeof Image !== 'undefined') {
  const load = (src) => new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
  // 注意：这里**不能**用顶层 await —— 一旦某张图既不 load 也不 error，整个模块图会挂住，

  // 表现就是页面卡在 loading、按钮列表空白（踩过一次）。改成后台加载，图集用到时若有就用。
  Promise.all([
    ...CSL_KITS.map(async (t) => {
      const img = await load(t.crest);
      if (img) crestImages.set(t.slug, img);
    }),
    (async () => { brandImage = await load(KIT_BRAND.path); })(),
  ]);
}

export default { CSL_KITS, cslKitForClub, CSL_BY_CLUB, CSL_BY_SLUG, CSL_LICENSE_NOTE };
