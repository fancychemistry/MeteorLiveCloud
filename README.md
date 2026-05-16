# MeteorAstroLive 施工文档

状态：draft
最后核对：2026-05-16

这是独立 JS / TypeScript 天测量与 MeteorLive 上报项目的施工入口。它不接 MeteorStation 主工程，不复用主数据库，当前已落地 MVP 骨架：

```text
事件包校验
CAL / platepar 导入归档与 active 绑定
cloud_profile.json 导入与本地相机绑定
MeteorLive manifest/package 生成
HMAC 签名与 Device API 客户端
SQLite 上传队列
worker 单轮上传/轮询
CLI
```

## 快速开始

```powershell
npm install
npm run build
npm test
```

Web UI + local API:

```powershell
npm run build:node
npm run api
npm run dev
```

Open `http://127.0.0.1:5173/`. The Vue UI proxies `/api/*` to the local Node API on `http://127.0.0.1:5174/`.

Manual UI upload flow:

```text
1. Profile page: import cloud_profile JSON and bind the local camera code.
2. Event page: select ECSV, video, and optional preview, or type local paths.
3. Click Package Queue to create manifest/package files and enqueue the event.
4. Queue page: click Upload to run one worker pass and submit the queued event to MeteorLive.
```

CLI 入口：

```powershell
node .\dist\src\cli\index.js help
```

常用流程：

```powershell
node .\dist\src\cli\index.js profile import --file cloud_profile.json --bind-camera CAM01 --enable

node .\dist\src\cli\index.js cal import --camera CAM01 --stream main --file camera.cal --activate

node .\dist\src\cli\index.js package --event event-package.json

node .\dist\src\cli\index.js worker run
```

## 文档

1. `standalone-js-astrometry-cloud-overview.md`
   - 给开发者快速理解整体运行逻辑。
   - 先读这个。

2. `standalone-js-astrometry-cloud-plan.md`
   - 详细施工规格。
   - 包含 CAL / platepar、事件包、MeteorLive profile、JS API、HMAC 签名、上传队列和 worker 规则。

## 当前边界

本项目施工阶段只关注：

```text
手动 CAL / platepar
已有 ECSV 或手动轨迹点
事件打包
MeteorLive Cloud 上传
本地上传队列
```

当前不做：

```text
实时检测
自动标定
DaytimeAstrometryService 重写
NVR 接入
MeteorStation 主数据库直接复用
```

## 施工状态

当前已经实现最小可用链路的代码骨架，但还没有接真实 MeteorLive 账号做端到端上传验证。`node:sqlite` 目前是 Node.js 实验特性，运行时会出现 ExperimentalWarning；后续如需生产稳定性，可以替换为专用 SQLite 依赖或封装。
