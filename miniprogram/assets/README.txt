本目录素材由 utils/assets.js 自动映射，文件名不含后缀作为 key。

为控制小程序源码包体积，角色插画已压缩为白底 JPG（宽 600px，按原图比例缩放，质量 85）；首页透明图仍保留 PNG。

【单人 16 核心型】solo_XXXX.jpg
【双人 16 核心型】pair_XXXX.jpg
【开放过渡型通用图】open_solo_split.jpg / open_pair_split.jpg / open_flexible.jpg / open_blank.jpg
【首页视觉图】home_hero.png (600×256px) / entry_solo.png (160×160px) / entry_pair.png (160×160px)
【微信分享缩略图】share_card.png (500×400px，5:4，复用首页 banner 样式)

如需替换为透明底 PNG，请同步修改 utils/assets.js 中的 PNG_ASSETS 列表或 CUSTOM_ASSET_MAP，并注意源码包 2MB 上限。
