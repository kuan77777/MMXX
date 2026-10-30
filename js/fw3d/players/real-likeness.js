// FW3D · 真实球员外观资料（likeness overrides）
//
// ⚠️ 重要：本文件里的「外观」字段全部是 estimate（估计），不是实测数据。
//   原因：本项目没有取得任何球员肖像授权，也没有可离线核验的官方人体测量表。
//   本会话尝试访问 en.wikipedia.org / wikidata.org 均失败（见 PLAYER_MODEL_WORK_LOG.md），
//   因此连"公开身高"也无法逐条在线核验 —— 所以一律降级为 estimate，绝不写成 source。
//   当有可核验来源时，把该字段的 provenance 改成 'source' 并把 sourceRefs 填成真实可访问的链接即可。
//
// 数据结构（每名球员只写「想覆盖」的字段，其余继续走程序生成）：
//   {
//     label: '界面显示名',
//     source: 'real:curated',
//     verifyStatus: 'unverified' | 'search-snippet',
//     provenance: { height:'estimate', hair_style:'estimate', ... },
//     sourceRefs: { height:'https://…' },
//     height, weight, skin_tone(hex 或 SKIN_TONES.key), hair_style, hair_color, facial_hair,
//     head_shape: {...}, face: {...}, body: {...}, accessories: {...},
//     notes: ['…']
//   }
//
// 挑选原则：只挑「公众形象稳定、特征广泛可查」的球员做原型，避免把主观印象当成事实。

export const REAL_LIKENESS = {
  'REAL-erling-haaland': {
    label: '哈兰德',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', hair_color: 'estimate', skin_tone: 'estimate' },
    sourceRefs: { height: 'https://en.wikipedia.org/wiki/Erling_Haaland' },
    height: 195,
    hair_style: 'ponytail',
    hair_color: 0xb89355,
    skin_tone: 0xe8c0a2,
    facial_hair: 'none',
    // 长脸、宽下颌是常被提到的辨识特征（估计）
    head_shape: { length: 1.06, jaw: 0.98, cheek: 1.04 },
    notes: ['身高/发型按公开赛事影像的普遍印象填写，属估计；未能在线核验。'],
  },
  'REAL-thibaut-courtois': {
    label: '库尔图瓦',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    sourceRefs: { height: 'https://en.wikipedia.org/wiki/Thibaut_Courtois' },
    height: 199,
    hair_style: 'short',
    hair_color: 0x2b1d14,
    skin_tone: 0xe8c0a2,
    facial_hair: 'stubble',
    head_shape: { length: 1.04, width: 0.97, jaw: 0.9 },
    body: { shoulderWidth: 1.02, chestDepth: 0.98 },
    notes: ['门将体型偏高偏瘦长（估计）。'],
  },
  'REAL-virgil-van-dijk': {
    label: '范戴克',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    height: 193,
    hair_style: 'buzz',
    hair_color: 0x14100e,
    skin_tone: 0x7a4f37,
    facial_hair: 'stubble',
    head_shape: { jaw: 0.96, brow: 1.1 },
    body: { shoulderWidth: 1.06, build: 0.62, bodyType: 'powerful' },
    notes: ['中卫体型、短发（估计）。'],
  },
  'REAL-harry-kane': {
    label: '凯恩',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    hair_style: 'short',
    hair_color: 0x3f2a1c,
    skin_tone: 0xe8c0a2,
    facial_hair: 'stubble',
    head_shape: { length: 1.03, jaw: 0.95 },
    notes: ['中锋体型（估计）。'],
  },
  'REAL-kylian-mbappe': {
    label: '姆巴佩',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    height: 178,
    hair_style: 'buzz',
    hair_color: 0x14100e,
    skin_tone: 0x6f4a33,
    facial_hair: 'stubble',
    body: { build: 0.38, bodyType: 'athletic', thigh: 1.02 },
    notes: ['速度型边锋体型（估计）。'],
  },
  'REAL-vinicius-junior': {
    label: '维尼修斯',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    height: 176,
    hair_style: 'curly',
    hair_color: 0x1d1712,
    skin_tone: 0x6f4a33,
    facial_hair: 'none',
    head_shape: { width: 0.98, jaw: 0.88 },
    body: { build: 0.34, bodyType: 'lean' },
    notes: ['边锋体型、短卷发（估计）。'],
  },
  'REAL-mohamed-salah': {
    label: '萨拉赫',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    height: 175,
    hair_style: 'curly',
    hair_color: 0x14100e,
    skin_tone: 0x8d5f43,
    facial_hair: 'beard',
    head_shape: { cheek: 1.06, jaw: 0.94 },
    notes: ['卷发 + 络腮胡（估计）。'],
  },
  'REAL-luka-modric': {
    label: '莫德里奇',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', hair_color: 'estimate' },
    height: 172,
    hair_style: 'side',
    hair_color: 0x8a6a3f,
    facial_hair: 'none',
    head_shape: { width: 0.96, length: 1.03, jaw: 0.86, cheekbone: 0.7 },
    body: { build: 0.3, bodyType: 'lean', legProportion: 0.98 },
    notes: ['瘦小体型、偏长发（估计）。'],
  },
  'REAL-kevin-de-bruyne-napoli': {
    label: '德布劳内',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', hair_color: 'estimate' },
    height: 181,
    hair_style: 'side',
    hair_color: 0x8a6a3f,
    facial_hair: 'stubble',
    head_shape: { length: 1.04, forehead: 1.05, jaw: 0.92 },
    notes: ['中场体型、侧分金发（估计）。'],
  },
  'REAL-jude-bellingham': {
    label: '贝林厄姆',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    hair_style: 'crop',
    hair_color: 0x1d1712,
    skin_tone: 0x7a4f37,
    facial_hair: 'goatee',
    body: { build: 0.55, bodyType: 'powerful' },
    notes: ['强壮中场体型（估计）。'],
  },
  'REAL-lamine-yamal': {
    label: '亚马尔',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate', skin_tone: 'estimate' },
    height: 180,
    hair_style: 'curly',
    hair_color: 0x14100e,
    skin_tone: 0x9a6b4c,
    facial_hair: 'none',
    body: { build: 0.3, bodyType: 'lean', legProportion: 1.02 },
    notes: ['年轻边锋，偏瘦长（估计）。'],
  },
  'REAL-robert-lewandowski': {
    label: '莱万多夫斯基',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate' },
    height: 185,
    hair_style: 'short',
    hair_color: 0x3f2a1c,
    facial_hair: 'stubble',
    head_shape: { length: 1.03, brow: 1.15, jaw: 0.96 },
    body: { build: 0.6, bodyType: 'powerful' },
    notes: ['中锋体型（估计）。'],
  },
  'REAL-rodri': {
    label: '罗德里',
    source: 'real:curated',
    verifyStatus: 'unverified',
    provenance: { height: 'estimate', hair_style: 'estimate' },
    height: 191,
    hair_style: 'crop',
    hair_color: 0x2b1d14,
    facial_hair: 'beard',
    head_shape: { length: 1.04, jaw: 0.93 },
    body: { build: 0.55, bodyType: 'athletic' },
    notes: ['后腰，偏高（估计）。'],
  },
};

// 参考页面（每条记录都应有来源链接，便于以后逐条核验 / 升级为 source）。
// 注意：本会话 en.wikipedia.org 与 wikidata.org 的网络请求全部失败，这些链接**没有被本项目在线核验**，
// 因此对应字段一律保持 estimate。任何一条被人工核验后可把 provenance 改成 'source'。
const WIKI_PAGE = {
  'REAL-erling-haaland': 'Erling_Haaland',
  'REAL-thibaut-courtois': 'Thibaut_Courtois',
  'REAL-virgil-van-dijk': 'Virgil_van_Dijk',
  'REAL-harry-kane': 'Harry_Kane',
  'REAL-kylian-mbappe': 'Kylian_Mbappé',
  'REAL-vinicius-junior': 'Vinícius_Júnior',
  'REAL-mohamed-salah': 'Mohamed_Salah',
  'REAL-luka-modric': 'Luka_Modrić',
  'REAL-kevin-de-bruyne-napoli': 'Kevin_De_Bruyne',
  'REAL-jude-bellingham': 'Jude_Bellingham',
  'REAL-lamine-yamal': 'Lamine_Yamal',
  'REAL-robert-lewandowski': 'Robert_Lewandowski',
  'REAL-rodri': 'Rodri_(footballer,_born_1996)',
};

// 真实球员在游戏里的实体 id 是 P326 这种数字 id，真正的资料库 id 在 pl.realPlayerId 上
// （实测：P326/哈兰德 → realPlayerId 'REAL-erling-haaland'）。所以查询必须同时接受：
//   · 字符串（REAL-xxx 或游戏内 id）
//   · 球员记录对象（优先用 realPlayerId，其次 id）
// 传对象或裸 id 都能查到，避免"看起来接了、其实永远没命中"。
export function likenessKeyOf(playerOrId) {
  if (playerOrId && typeof playerOrId === 'object') {
    return String(playerOrId.realPlayerId || playerOrId.id || '');
  }
  return String(playerOrId || '');
}

export function likenessOf(playerOrId) {
  const key = likenessKeyOf(playerOrId);
  const id = REAL_LIKENESS[key] ? key : (REAL_LIKENESS['REAL-' + key] ? 'REAL-' + key : '');
  if (!id) return null;
  const ov = REAL_LIKENESS[id];
  if (!ov.sourceRefs || Object.keys(ov.sourceRefs).length === 0) {
    const page = WIKI_PAGE[id];
    if (page) return Object.assign({}, ov, { sourceRefs: { page: 'https://en.wikipedia.org/wiki/' + page } });
  }
  return ov;
}

export const LIKENESS_COUNT = Object.keys(REAL_LIKENESS).length;
