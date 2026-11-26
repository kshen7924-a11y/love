# CPTI 恋爱人格测验 · 微信小程序基础工程骨架

## 一、目录结构
- `miniprogram/pages/index`：品牌首页（单人入口、双人入口、上次单人报告快捷回看、理论参考文献说明）
- `miniprogram/pages/quiz`：12–16 题自适应答题页（5 档量表、高对比吐槽气泡、上一题回退、跳过）
- `miniprogram/pages/room`：双人独立盲答房间（6 位房间码、`open-type="share"` 原生微信好友卡片邀请、实时监听揭晓）
- `miniprogram/pages/report`：海报级结果报告页（称号-代码-插画-总结首屏、四维滑轨、八维曲线、六维需求、优势短板、适配伴侣、改进计划）
- `miniprogram/utils/cpti_data.js`：16 题双视角题库、32 个核心称号、开放型称号及单人适配伴侣库
- `miniprogram/utils/cpti_engine.js`：确定性规则判定引擎（加权净分同源计算、自适应追问、六维需求与双人温差）
- `miniprogram/utils/assets.js`：美术素材挂载表（后续把 39 张 PNG 放入 `miniprogram/assets/` 即可自动显示）
- `miniprogram/utils/room_service.js`：双人房间同步服务（已填入 `cloudEnvId` 时走微信云开发实时同步，未配置时自动降级本地模拟联机）
- `cloudfunctions/cptiSync`：双人交卷原子更新云函数

## 二、导入微信开发者工具步骤
1. 解压压缩包后，打开 **微信开发者工具** -> 点击「导入项目」-> 选择 `cpti-miniprogram` 目录。
2. 填入你的小程序 `AppID`（无 `AppID` 可先点「测试号」体验全部界面与单人/本地双人流程）。
3. **接入美术素材**：将做好的透明底 PNG 按《美术资产需求表及规范》命名后放入 `miniprogram/assets/` 目录即可自动加载（未放图时自动显示内置虚线占位卡）。
4. **开通跨设备双人同步**：
   - 在微信开发者工具顶部点击「云开发」开通云环境，复制你的云环境 ID（如 `cpti-prod-xxxx`）。
   - 在云开发控制台创建数据库集合 `cpti_rooms`（权限设为「所有用户可读，仅创建者及管理员可写」或配合 `cptiSync` 云函数）。
   - 右键 `cloudfunctions/cptiSync` -> 选择「上传并部署：云端安装依赖」。
   - 打开 `miniprogram/app.js`，将 `cloudEnvId` 填入你的云环境 ID 即可实现跨手机真实微信联机盲答。
