/**
 * CPTI 美术素材配置表（支持本地 /assets/ PNG、云存储 fileID / HTTPS URL 映射）
 *
 * 使用方式：
 * 1. 默认读取 miniprogram/assets/ 下的 JPG（角色插画）与 PNG（首页透明图），命名规则见《美术资产需求表及规范》。
 * 2. 若后续把图片上传至微信云存储或 CDN，可在 CUSTOM_ASSET_MAP 中填入映射覆盖，无需改页面逻辑。
 */
const ASSET_BASE = '/assets';

const VALID_CORE_CODES = [
  'RBFK', 'RBHK', 'RBFD', 'RBHD',
  'RPFK', 'RPHK', 'RPFD', 'RPHD',
  'MBFK', 'MBHK', 'MBFD', 'MBHD',
  'MPFK', 'MPHK', 'MPFD', 'MPHD'
];

// 可选：云存储 fileID 或 CDN URL 覆盖表（键名为不含后缀的文件名，如 'solo_RBFK' 或 'home_hero'）
const CUSTOM_ASSET_MAP = {
  // 'solo_RBFK': 'cloud://xxxx.cpti-xxxx/assets/solo_RBFK.png',
  // 'home_hero': 'https://your-cdn.example.com/cpti/home_hero.png'
};

const PNG_ASSETS = ['home_hero', 'entry_solo', 'entry_pair', 'share_card'];

function resolveAssetPath(keyName) {
  if (CUSTOM_ASSET_MAP[keyName]) {
    return CUSTOM_ASSET_MAP[keyName];
  }
  const ext = PNG_ASSETS.indexOf(keyName) !== -1 ? '.png' : '.jpg';
  return `${ASSET_BASE}/${keyName}${ext}`;
}

function getCharacterImage(mode, code) {
  const cleanCode = (code || '').trim().toUpperCase();
  const prefix = mode === 'pair' ? 'pair' : 'solo';

  if (VALID_CORE_CODES.includes(cleanCode)) {
    return resolveAssetPath(`${prefix}_${cleanCode}`);
  }

  // 开放过渡型通用兜底图
  if (cleanCode === 'XXXX') {
    return resolveAssetPath('open_flexible');
  }
  if (cleanCode.includes('X')) {
    return resolveAssetPath(mode === 'pair' ? 'open_pair_split' : 'open_solo_split');
  }
  return resolveAssetPath('open_blank');
}

const HOME_ASSETS = {
  hero: resolveAssetPath('home_hero'),
  entrySolo: resolveAssetPath('entry_solo'),
  entryPair: resolveAssetPath('entry_pair')
};

const SHARE_IMAGE = resolveAssetPath('share_card');

module.exports = {
  ASSET_BASE,
  VALID_CORE_CODES,
  CUSTOM_ASSET_MAP,
  resolveAssetPath,
  getCharacterImage,
  HOME_ASSETS,
  SHARE_IMAGE
};
