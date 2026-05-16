# MeteorAstroLive

状态：draft  
最后核对：2026-05-16

MeteorAstroLive 是一套独立的 JS / TypeScript 天测量与 MeteorLive 上报参考实现。它的主要读者是 Meteor Master AI 的开发者：如果你需要把“精准 CAL 天测量结果”和 “MeteorLive Cloud 上报”接入自己的程序，这个项目可以作为模块拆分、事件合同、文件打包、HMAC 签名和上传队列的施工样板。

它不是实时检测器，也不是主程序的替代品。它关注的是检测之后的可靠交接：

```text
已有 ECSV / 视频 + CAL + 手动轨迹点
  -> 事件合同校验
  -> ECSV 准入检查
  -> manifest / package 生成
  -> SQLite 上传队列
  -> MeteorLive Device API
```

## 适合谁看

- Meteor Master AI 开发者：需要复用 CAL / platepar 管理、ECSV 事件包、MeteorLive 上报协议。
- MeteorLive 接入开发者：需要知道本地程序如何导入 `cloud_profile.json`、绑定机位、签名上传。
- 天测量工具开发者：需要把外部减流星程序输出的 ECSV 稳定送入云端。
- 后续 Electron / Web UI 开发者：需要理解当前 Vue UI、local API、CLI 和 worker 的边界。

## 当前能做什么

当前项目已经落地 MVP 骨架，包含这些能力：

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 事件合同校验 | `src/event-contract/*` | 校验 `event-package.json`，统一事件 ID、UTC 时间、相机代码、ECSV / 视频 / 预览路径 |
| CAL / platepar 管理 | `src/manual-calibration/*` | 导入 CAL / platepar，归档 SHA256，并绑定为某个本地相机的 active CAL |
| 手动轨迹输入 | `src/manual-reduction/*` | 校验 `manual-points.json`，并提供外部减流星程序调用封装 |
| MeteorLive profile | `src/cloud-profile/*` | 导入 `cloud_profile.json`，保存非敏感字段，保护 device secret |
| 上报包生成 | `src/cloud-package/*` | 复制 ECSV / 视频 / 预览图，计算 hash，生成 `manifest.json` 和本地 `package.json` |
| HMAC Device API | `src/cloud-client/*` | 生成 canonical string、签名头，并调用 MeteorLive Device API |
| 上传队列 | `src/upload-store/*` | 使用 SQLite 保存上传状态、远端 UID、错误和重试信息 |
| worker | `src/upload-worker/*` | 单轮上传和远端 job 轮询 |
| CLI | `src/cli/index.ts` | 提供 profile 导入、CAL 导入、package、worker run 等命令 |
| Web UI / local API | `src/ui/*`, `src/server/*` | Vue UI + 本地 Node API，用于手动导入、打包、查看队列和触发 worker |

当前打包链路以已有 ECSV 为第一优先级。纯 JS 天测量转换还不是主路径；如果没有 ECSV，推荐由外部 `astro-reduce.exe` / Meteor Master AI / 减流星工具先生成 ECSV，再交给本项目打包上传。

## 当前不做什么

- 不做实时采集。
- 不做自动检测。
- 不重写上游天测量核心。
- 不直接接管主程序数据库。
- 不要求嵌入 Dear ImGui / WebView2。
- 不把 CAL 文件里的历史 `JD` 当作事件时间。

这些边界是故意保守的。MeteorAstroLive 的价值在于把上报前后的合同和工程流程拆清楚，而不是把检测、标定、减流星、上报全部绑死在一个程序里。

## 推荐集成方式

Meteor Master AI 可以把本项目当成四层参考：

```text
1. 天测量层
   视频 / 图像 / 手动点 / CAL -> event.ecsv

2. 事件合同层
   event-package.json -> 解析路径、时间、相机、站点、CAL 选择

3. 上报包层
   event.ecsv + media + preview -> manifest.json + package.json + hashes

4. 云端同步层
   upload_queue -> HMAC signed multipart -> job polling
```

建议把“生成 ECSV”和“上传 ECSV”分开。上游工具负责准确的 CAL 天测量，本项目负责把结果变成稳定、可追溯、可重试的 MeteorLive 上传任务。

## 上报准入门槛

MeteorAstroLive 建议在打包上传前设置一层事件准入门槛。它不是替代检测器，而是避免把明显不可靠的候选事件提交到 MeteorLive。

推荐默认门槛：

```text
min_move_px_1080p = 30
min_frame_span = 6
brightness_threshold = maxpixel - avepixel > 3.5 * stdpixel + 12
```

### 移动长度门槛

以 1080p 为基准，事件最小移动距离为 30 像素。其他分辨率按画面高度等比例缩放：

```text
min_move_px = 30 * frame_height / 1080
```

示例：

```text
1920x1080 -> 30 px
3840x2160 -> 60 px
1280x720  -> 20 px
```

计算方式建议优先使用 ECSV 的 `x_image / y_image`：

```text
pixel_move = distance(first_valid_xy, last_valid_xy)
```

如果要更严格，可以使用逐点轨迹长度：

```text
pixel_path_length = sum(distance(point[i], point[i + 1]))
```

准入门槛建议使用首尾位移，统计展示可以同时输出首尾位移和逐点轨迹长度。

### 帧跨度门槛

事件至少跨过 6 帧：

```text
frame_span = max(frame_index) - min(frame_index) + 1
frame_span >= 6
```

如果 ECSV 没有 `frame_index`，可以退化为有效测量点数量：

```text
valid_measurement_count >= 6
```

但推荐上游 ECSV 始终写入 `frame_index`，这样可以区分“连续跨帧”和“稀疏点数足够”。

### 亮度门槛

```text
maxpixel - avepixel > 3.5 * stdpixel + 12
```

参数含义：

- `maxpixel`：候选流星像素或条纹区域的峰值图像亮度。
- `avepixel`：同位置背景平均亮度。
- `stdpixel`：同位置背景标准差。
- `3.5`：背景标准差倍数。
- `12`：绝对灰度偏移。

当 `stdpixel = 4` 时，阈值就是：

```text
maxpixel - avepixel > 26
```

也就是比背景平均亮度高出 26 个灰度级以上。

## ECSV 推荐字段

MeteorLive 上传必须有 ECSV。建议至少包含：

```text
datetime
frame_index
ra
dec
azimuth
altitude
x_image
y_image
integrated_pixel_value
background_pixel_value
saturated_pixels
mag_data
err_minus_mag
err_plus_mag
snr
quality_flags
```

其中：

- `datetime` 是每个测量点的 UTC 时间。
- `x_image / y_image` 用于复核轨迹、计算移动距离和长度。
- `mag_data` 是天测量后的星等数据，不等同于检测阈值。
- `integrated_pixel_value / background_pixel_value / snr` 用于工程质量判断。
- `quality_flags` 用于记录条纹测量、rolling shutter 修正、seed locked measurement 等处理标记。

ECSV meta 建议至少包含：

```text
station_id
camera_id
obs_latitude
obs_longitude
obs_elevation
photometric_band
image_file
isodate_start_obs
mag_label
```

## 事件包

事件包是本项目的核心输入合同。示例：

```json
{
  "schema": "meteor_astro_event_v1",
  "local_event_id": "CAM01_20260516_203001",
  "event_time_utc": "2026-05-16T12:30:01Z",
  "station_code": "CN0001",
  "camera_code": "CAM01",
  "video_path": "event.mp4",
  "platepar_path": "camera.cal",
  "ecsv_path": "event.ecsv",
  "preview_path": "preview.png",
  "manual_points_path": "manual-points.json",
  "output_dir": "output/CAM01_20260516_203001"
}
```

规则：

- `event_time_utc` 必须是 UTC，推荐 ISO 8601 且以 `Z` 结尾。
- `local_event_id` 必须稳定且在本地唯一。
- 有 `ecsv_path` 时，当前打包逻辑直接使用已有 ECSV。
- 没有 `ecsv_path` 时，需要 `video_path + CAL + manual_points_path`，并由外部 adapter 生成 ECSV。
- `output_dir` 是 package、manifest 和本地追溯文件的输出目录。

## CAL / platepar

CAL 的职责是说明画面如何映射到天空坐标。它是精准天测量能力的基础，不是普通备注字段。

本项目导入 CAL 后会：

1. 解析 platepar 或 SkyFit calibration bundle。
2. 校验分辨率、经纬度、FOV、畸变、光度字段等基础信息。
3. 复制到本项目数据目录形成归档。
4. 计算 SHA256。
5. 绑定到 `camera_code + stream`，并可设置为 active。

事件使用 CAL 的顺序：

```text
1. event-package.json 显式 platepar_path
2. event-package.json 显式 calibration_id
3. 当前 camera_code + stream 的 active CAL
4. 都没有时，只能上传已有 ECSV，不能从手动点生成 ECSV
```

注意：CAL 文件中的 `JD` 不是事件时间。ECSV 输出时必须使用 `event_time_utc` 和逐帧 frame / fps 推导测量点时间。

## MeteorLive 上报

MeteorLive Cloud 网站入口：[https://meteorlive.net/cloud](https://meteorlive.net/cloud)。

上传使用 MeteorLive Device API：

```text
POST /cloud/device-api/mscloud/uploads
GET  /cloud/device-api/mscloud/jobs/{jobUid}
GET  /cloud/device-api/mscloud/profile/status
GET  /cloud/device-api/mscloud/profile/latest
```

multipart part 名固定为：

```text
manifest  application/json  必填
ecsv      text/plain         必填
media     application/octet-stream 可选
preview   image/png          可选
```

大小限制：

```text
manifest <= 1 MB
ECSV     <= 50 MB
media    <= 500 MB
preview  <= 5 MB
```

`manifest.json` 记录事件身份、站点 / 相机 UID、软件版本和文件 hash。科学测量值以 ECSV 为准，不建议把 `mag_data`、轨迹长度或完整逐点结果塞进 manifest。

## HMAC 签名

所有 Device API 请求都使用设备级密钥签名，不使用网页登录 token。

canonical string 固定为 8 行：

```text
HTTP_METHOD
URL_PATH
X-Timestamp
X-Nonce
X-Manifest-SHA256
X-Ecsv-SHA256
X-Media-SHA256
X-Preview-SHA256
```

签名：

```text
signature = Base64(HMAC-SHA256(device_secret, canonical_string))
```

公网路径示例：

```text
https://meteorlive.net/cloud/device-api/mscloud/uploads
URL_PATH = /cloud/device-api/mscloud/uploads
```

开发直连 Java 服务时，签名路径要变成实际外部请求路径：

```text
http://127.0.0.1:48080/device-api/mscloud/uploads
URL_PATH = /device-api/mscloud/uploads
```

## 快速开始

安装依赖、构建和测试：

```powershell
npm install
npm run build
npm test
```

启动本地 API 和 Web UI：

```powershell
npm run build:node
npm run api
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

Vue UI 会把 `/api/*` 代理到本地 Node API：

```text
http://127.0.0.1:5174/
```

## 常用 CLI

查看帮助：

```powershell
node .\dist\src\cli\index.js help
```

导入 MeteorLive profile 并绑定本地相机：

```powershell
node .\dist\src\cli\index.js profile import --file cloud_profile.json --bind-camera CAM01 --enable
```

导入 CAL 并设为 active：

```powershell
node .\dist\src\cli\index.js cal import --camera CAM01 --stream main --file camera.cal --activate
```

打包事件：

```powershell
node .\dist\src\cli\index.js package --event event-package.json
```

运行一次上传 worker：

```powershell
node .\dist\src\cli\index.js worker run
```

## Web UI 手动流程

```text
1. Profile 页面：导入 cloud_profile.json，并绑定本地 camera code。
2. Event 页面：选择 ECSV、视频和可选 preview，或输入本地路径。
3. 点击 Package Queue：生成 manifest/package 文件并入队。
4. Queue 页面：点击 Upload，运行一轮 worker 并提交到 MeteorLive。
```

## 目录导览

```text
src/event-contract/      事件包 schema 与路径解析
src/manual-calibration/  CAL / platepar 导入、归档、active 绑定
src/manual-reduction/    手动点校验和外部减流星 adapter
src/ffmpeg-tools/        视频/预览图辅助工具
src/cloud-profile/       cloud_profile 导入和 secret 保存
src/cloud-package/       manifest/package/hash 生成
src/cloud-client/        Device API URL、HMAC 签名和上传
src/upload-store/        SQLite 上传队列
src/upload-worker/       上传和 job 轮询 worker
src/server/              本地 API
src/ui/                  Vue UI
src/cli/                 CLI
```

## 进一步文档

1. `standalone-js-astrometry-cloud-overview.md`
   - 流程型说明，适合先读。
2. `standalone-js-astrometry-cloud-plan.md`
   - 详细施工规格，包含 CAL / platepar、事件包、MeteorLive profile、JS API、HMAC 签名、上传队列和 worker 规则。

## 当前施工状态

当前代码已经实现最小可用链路，并已用真实 MeteorLive 账号完成端到端上传验收。已跑通的主链路包括 profile 导入、事件打包、HMAC Device API 上传、上传队列状态记录和远端 job 轮询。`node:sqlite` 目前是 Node.js 实验特性，运行时可能出现 `ExperimentalWarning`；如果进入生产环境，建议替换为专用 SQLite 依赖或在数据库层增加兼容封装。
