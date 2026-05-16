# 独立 JS 天测量与 MeteorLive 上报模块规划

状态：draft
最后核对：2026-05-16
真相来源：`docs/modules/astrometry.md`、`docs/meteorlive/*`、`src/cloud/*`、`src/astrometry/*`、`src/VideoCalibrator.cpp`、`src/DataBase.h`
验证方式：源码入口与现有文档核对；本文件是规划，不代表当前已实现

## 1. 目标

把“手动天测量对齐、事件打包、MeteorLive Cloud 上报”做成一个独立 JS / TypeScript 模块集合。这个集合可以先作为独立 CLI / worker 使用，后续再接 Electron 桌面 UI。

核心目标是：

1. 用 JS 管理事件、文件、任务队列和云端上报。
2. 接受手动标定结果、已有 CAL / platepar、已有或手动整理的轨迹点。
3. 生成或接收 ECSV、manifest、预览图和上传包。
4. 使用 MeteorLive Cloud device profile 做 HMAC 签名上传。
5. 不依赖 MeteorStation 主 GUI、主数据库和 `DaytimeReductionScheduler`。

设计原则：

1. JS / TypeScript 负责产品逻辑、文件编排、任务队列、上报协议和 UI。
2. CAL / platepar 是手动标定结果的唯一权威输入；本阶段只导入、绑定、校验和使用它。
3. ECSV 是 MeteorLive 上报的必需科学数据文件；已有 ECSV 优先，手动轨迹转 ECSV 是第二步能力。
4. MeteorLive 上传必须异步入队，不能阻塞手动处理或 UI。
5. 所有可复核文件都保留原件和 hash，避免上传失败后无法追溯。

## 2. 本阶段不做

当前阶段明确不做这些内容：

1. 不重写 `DaytimeAstrometryService` 那套核心处理。
2. 不做自动标定、blind solve、自动星点识别闭环。
3. 不做实时采集、实时检测、NVR 接入。
4. 不直接复用 MeteorStation 主程序的 `DataBase.h`。
5. 不把 MeteorStation 的 Dear ImGui 页面复制成新项目 UI。
6. 不把 WebView2 当成核心依赖；网页登录或 profile 分发以后再接。

这意味着第一版的输入要更保守：用户或外部工具先完成手动标定和轨迹整理，本模块负责把这些结果稳定地组织、校验、打包和上报。

## 3. 推荐技术栈

建议使用 TypeScript，而不是裸 JavaScript。

基础运行时：

- Node.js：文件系统、任务进程、crypto、HTTP、SQLite。
- TypeScript：保证事件包、profile、上传状态等结构稳定。
- FFmpeg：视频裁剪、预览图、叠加合成、封面输出。
- SQLite：本地 profile、任务和上传队列。

可选外壳：

- Electron + Vue / React：只做后续桌面 UI，不影响核心模块。

云端相关可以全部用 JS 完成：

- `crypto.createHash("sha256")`
- `crypto.createHmac("sha256", secret)`
- `fetch` / `FormData` / multipart 上传
- SQLite 队列
- job 轮询和失败重试

## 4. 总体流程

```text
视频 / 已有 ECSV / 手动轨迹点 / CAL
  -> event-contract 校验
  -> manual-reduction 或 ECSV 导入
  -> preview / media 处理
  -> manifest 生成
  -> upload-queue 入队
  -> cloud-client HMAC 上传
  -> job-poller 轮询结果
```

第一版优先支持两条路径：

1. `已有 ECSV + 视频/预览图 -> MeteorLive 上报`
2. `视频 + CAL + 手动轨迹点 JSON -> 生成 ECSV -> MeteorLive 上报`

第二条路径只做手动轨迹点转换，不做自动识别和自动标定。

## 5. 模块拆分

### 5.1 `event-contract`

职责：

- 定义独立事件包 schema。
- 校验视频、CAL、ECSV、预览图路径。
- 统一本地事件 ID、相机代码、站点代码、UTC 时间。

建议事件包：

```json
{
  "schema": "meteor_astro_event_v1",
  "local_event_id": "CAM01_20260515_203001",
  "event_time_utc": "2026-05-15T12:30:01Z",
  "station_code": "CN0001",
  "camera_code": "CAM01",
  "video_path": "event.mp4",
  "platepar_path": "camera.cal",
  "ecsv_path": "event.ecsv",
  "preview_path": "preview.png",
  "manual_points_path": "manual-points.json",
  "output_dir": "output/CAM01_20260515_203001"
}
```

规则：

- `event_time_utc` 必须是 UTC。
- `local_event_id` 在本机上传队列中必须唯一。
- `ecsv_path` 可以为空；为空时才尝试用手动点生成 ECSV。
- `platepar_path` 在第一版只作为手动对齐和元数据输入，不承担自动标定。

### 5.2 `manual-calibration`

职责：

- 管理手动标定结果。
- 导入 `.cal` / platepar 文件。
- 保存相机到 CAL 的绑定关系。
- 记录手动对齐状态。

它不负责自动求解，只负责“这个相机当前使用哪个标定结果”。

#### 5.2.1 CAL / platepar 的定位

这里的 CAL 指 MeteorStation 当前 `Platepar` JSON 结构，或 SkyFit 保存的 snapshot 中的 `platepar` 对象。现有 `src/astrometry/Platepar.cpp` 支持两种输入：

1. 直接的 platepar JSON。
2. `kind = "meteorstation_skyfit_calibration_bundle"` 的 SkyFit snapshot，读取其中的 `platepar` 对象。

第一版独立 JS 项目只要求能读出并校验这些字段，不要求立即实现完整坐标转换：

```text
version
station_code
lat / lon / elev
JD / Ho / UT_corr
X_res / Y_res
fov_h / fov_v
RA_d / dec_d / pos_angle_ref / rotation_from_horiz
az_centre / alt_centre
F_scale
distortion_type
x_poly_fwd / y_poly_fwd / x_poly_rev / y_poly_rev
refraction / equal_aspect / force_distortion_centre / asymmetry_corr
mag_0 / mag_lev / gamma / vignetting_coeff / extinction_scale
```

`platepar_path` 不是普通备注字段，它决定：

1. 这个事件使用哪个相机标定。
2. 手动轨迹点能否转换成 ECSV 天球坐标。
3. ECSV meta 中的站点、图像分辨率、光度和畸变信息是否可信。
4. 预览叠加时能否显示投影参考线或后续复核标记。

#### 5.2.2 CAL 归档规则

导入 CAL 时不要只保存外部路径。推荐复制一份到本项目数据目录，形成不可变归档：

```text
data/
  calibrations/
    CAM01/
      20260515T120000Z_main/
        platepar.json
        source-info.json
```

`source-info.json` 建议保存：

```json
{
  "camera_code": "CAM01",
  "stream": "main",
  "active": true,
  "platepar_path": "data/calibrations/CAM01/20260515T120000Z_main/platepar.json",
  "original_path": "F:/cal/CAM01_main.cal",
  "sha256": "hex",
  "source": "manual",
  "source_tool": "SkyFit",
  "width": 1920,
  "height": 1080,
  "station_code": "CN0001",
  "created_at": "2026-05-15T12:00:00Z",
  "notes": "manual SkyFit alignment"
}
```

归档规则：

1. 同一个 `camera_code + stream` 可以有多个历史 CAL。
2. 只有一个 active CAL；新导入不会自动覆盖 active，除非用户明确 `--activate`。
3. 事件包生成时把当时使用的 CAL hash 写入事件包，后续相机 active CAL 改变也不影响旧事件复核。
4. CAL 原始文件不可修改；如需修正，导入为新版本。

#### 5.2.3 CAL 绑定逻辑

绑定表最小字段：

```sql
CREATE TABLE calibration (
  id INTEGER PRIMARY KEY,
  camera_code TEXT NOT NULL,
  stream TEXT NOT NULL,
  platepar_path TEXT NOT NULL,
  original_path TEXT,
  sha256 TEXT NOT NULL,
  station_code TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_calibration_active
ON calibration(camera_code, stream, active)
WHERE active = 1;
```

解析事件时的 CAL 选择顺序：

1. `event-package.json` 显式 `platepar_path`。
2. `event-package.json` 显式 `calibration_id`。
3. 当前 `camera_code + stream` 的 active CAL。
4. 没有可用 CAL 时，事件只能做“已有 ECSV 上报”，不能做手动点转 ECSV。

#### 5.2.4 CAL 校验规则

导入时至少检查：

1. 文件能解析为 JSON。
2. 如果是 SkyFit snapshot，必须包含 `platepar` 对象。
3. `X_res > 0` 且 `Y_res > 0`。
4. `lat` 在 `[-90, 90]`，`lon` 在 `[-180, 180]`。
5. `F_scale > 0`。
6. `distortion_type` 不为空。
7. 多项式数组存在时必须是数字数组。
8. `station_code`、`camera_code` 为空时允许导入，但必须提示用户补充绑定信息。

事件处理时再检查：

1. 视频分辨率与 CAL 的 `X_res / Y_res` 一致；不一致时默认阻止手动转 ECSV。
2. 如果允许缩放映射，必须记录 `cal_resolution`、`video_resolution` 和缩放方式。
3. `event_time_utc` 与 CAL 的 `JD` 不必完全一致，但 ECSV 输出时要使用事件时间，不要把历史 CAL 的 `JD` 当事件时间。

#### 5.2.5 TypeScript 接口草案

```ts
export type CalibrationStream = "main" | "sub" | "unknown";

export interface PlateparSummary {
  version: number;
  stationCode: string;
  lat: number;
  lon: number;
  elev: number;
  jd: number;
  width: number;
  height: number;
  fovH: number;
  fovV: number;
  raDeg: number;
  decDeg: number;
  posAngleRef: number;
  rotationFromHoriz: number;
  fScale: number;
  distortionType: string;
  xPolyFwd: number[];
  yPolyFwd: number[];
  xPolyRev: number[];
  yPolyRev: number[];
}

export interface CalibrationBinding {
  id: number;
  cameraCode: string;
  stream: CalibrationStream;
  plateparPath: string;
  sha256: string;
  active: boolean;
  summary: PlateparSummary;
}
```

### 5.3 `manual-reduction`

职责：

- 接收手动轨迹点。
- 按帧号 / 时间戳排序。
- 校验点是否落在视频分辨率范围内。
- 在有转换能力时输出 ECSV。

建议手动点格式：

```json
{
  "schema": "manual_meteor_points_v1",
  "fps": 25,
  "points": [
    { "frame": 120, "x": 553.2, "y": 401.8 },
    { "frame": 121, "x": 560.5, "y": 397.1 }
  ]
}
```

第一版可以有两种实现策略：

1. 只整理手动点和事件包，不直接输出天球坐标；要求用户提供已有 ECSV。
2. 复用现有 `VideoCalibrator` / 独立转换 CLI，把 `manual_points.json + cal` 转成 ECSV。

如果要纯 JS 输出 ECSV，需要把 platepar 坐标转换和 ECSV writer 的最小子集移植过来。这个工作可以单独做，不和云端上报耦合。

#### 5.3.1 手动减流星的三种模式

第一版建议同时定义三种模式，但只强制实现前两种：

```text
existing_ecsv
  用户已经有 event.ecsv；本模块只校验和上报。

external_adapter
  用户提供 video + CAL + manual-points.json；
  JS 调用外部 astro-reduce.exe / VideoCalibrator 风格工具生成 ECSV。

pure_js_ecsv
  JS 自己实现 platepar 坐标转换和 ECSV 输出；
  这个模式要等数值对拍通过后再启用。
```

`external_adapter` 的输入输出合同：

```text
输入：
  --video event.mp4
  --cal platepar.json
  --points manual-points.json
  --out event.ecsv
  --fps 25
  --event-time-utc 2026-05-15T12:30:01Z

输出：
  event.ecsv
  reduction-summary.json
```

`reduction-summary.json` 至少保存：

```json
{
  "ok": true,
  "mode": "external_adapter",
  "ecsv_path": "event.ecsv",
  "points_used": 12,
  "calibration_sha256": "hex",
  "event_time_utc": "2026-05-15T12:30:01Z",
  "warnings": []
}
```

手动点处理规则：

1. 按 `frame` 升序排序。
2. 同一帧多个点时默认保留最后一个，并记录 warning。
3. `x / y` 超出视频尺寸时拒绝，除非命令显式 `--allow-out-of-frame-points`。
4. 如果手动点少于 2 个，只能做单点检查，不能作为完整流星轨迹。
5. ECSV 的事件时间以 `event_time_utc + frame / fps` 计算，不使用 CAL 文件里的历史 `JD` 作为事件时间。

### 5.4 `ffmpeg-tools`

职责：

- 截取事件视频。
- 生成预览图。
- 合成叠加视频。
- 统一 FFmpeg 调用和错误处理。

实现原则：

- 用 `child_process.spawn` 传参数数组。
- 不拼 shell 字符串。
- 所有路径都走参数，不进入 filter 字符串时不需要额外转义。

示例能力：

```text
make-preview --video event.mp4 --time 1.2 --out preview.png
trim-media --video source.mp4 --start 10.0 --duration 3.0 --out event.mp4
blend-lighten --base current.mp4 --meteor meteor.mp4 --out merged.mp4
```

### 5.5 `cloud-profile`

职责：

- 导入 `cloud_profile.json`。
- 校验必填字段。
- 保存 profile 非敏感字段。
- 安全保存 `device_secret`。

必填字段：

```text
api_base
api_prefix
device_api_path
station_uid
station_code
camera_uid
camera_code
device_key_id
device_secret
```

Windows 版建议用 DPAPI 或系统凭据管理器保存 secret。不要把明文 secret 写日志，也不要把完整 `Authorization` 头写日志。

#### 5.5.1 profile 导入逻辑

`cloud_profile.json` 可能来自网页分发、本地向导或手动文件。导入时要兼容 snake_case 和 camelCase，例如 `device_key_id` / `deviceKeyId`。

导入步骤：

1. 读取 JSON。
2. 如果外层有 `profile` 字段，先取 `profile`。
3. 规范化 URL 字段：
   - `api_base` 默认 `https://meteorlive.net`
   - `api_prefix` 默认 `/cloud`
   - `device_api_path` 默认 `/device-api/mscloud`
4. 校验 `station_uid`、`camera_uid`、`device_key_id`、`device_secret`。
5. 把 `device_secret` 写入 secret store，数据库只保存 `device_secret_ref`。
6. 保存 profile。
7. 可选调用 `/profile/status` 验证凭证有效。

profile 表建议按设备凭证保存，而不是按本地相机保存。一个本地相机绑定到哪个 profile，由 `cloud_camera_binding` 决定。

```sql
CREATE TABLE cloud_profile (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'default',
  active INTEGER NOT NULL DEFAULT 1,
  profile_version INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 0,
  api_base TEXT NOT NULL,
  api_prefix TEXT NOT NULL,
  device_api_path TEXT NOT NULL,
  station_uid TEXT NOT NULL,
  station_code TEXT,
  camera_uid TEXT NOT NULL,
  camera_code TEXT,
  device_key_id TEXT NOT NULL UNIQUE,
  device_secret_ref TEXT NOT NULL,
  upload_policy_json TEXT,
  status TEXT,
  issued_at TEXT,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_status_at TEXT,
  last_status_message TEXT,
  daily_quota_gb REAL,
  remaining_quota_bytes INTEGER
);

CREATE TABLE cloud_camera_binding (
  camera_code TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  station_uid TEXT,
  station_code TEXT,
  camera_uid TEXT,
  camera_code_remote TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message TEXT
);
```

绑定时优先使用 binding 里的 `station_uid / camera_uid`；为空时回退 profile 里的值。这样以后一个 profile 最新配置刷新后，不会误改用户手动绑定。

### 5.6 `cloud-package`

职责：

- 生成 MeteorLive manifest。
- 计算 ECSV、media、preview、manifest 的 SHA256。
- 检查文件大小限制。
- 固化上传包目录。

标准输出：

```text
package/
  manifest.json
  event.ecsv
  event.mp4
  preview.png
  package.json
```

`package.json` 是本地内部文件，保存路径、hash、大小、profile/binding 选择结果和构建日志；它不上传到 MeteorLive。

manifest 最小字段：

```json
{
  "event_time_utc": "2026-05-15T12:30:01Z",
  "station_uid": "st_xxx",
  "station_code": "CN0001",
  "camera_uid": "cam_xxx",
  "camera_code": "CAM01",
  "local_event_id": "CAM01_20260515_203001",
  "software_name": "MeteorAstroLive",
  "software_version": "0.1.0",
  "files": {
    "ecsv": {
      "sha256": "hex",
      "size_bytes": 1234
    },
    "media": {
      "sha256": "hex-or--",
      "size_bytes": 0
    },
    "preview": {
      "sha256": "hex-or--",
      "size_bytes": 0
    }
  }
}
```

#### 5.6.1 打包输入

打包模块输入建议是完整的 `ResolvedEventPackage`：

```ts
export interface ResolvedEventPackage {
  localEventId: string;
  eventTimeUtc: string;
  stationCode: string;
  cameraCode: string;
  ecsvPath: string;
  mediaPath?: string;
  previewPath?: string;
  calibration?: CalibrationBinding;
  cloudBinding: {
    profileId: number;
    stationUid: string;
    stationCode: string;
    cameraUid: string;
    cameraCode: string;
  };
}
```

打包规则：

1. `ecsvPath` 必须存在，大小必须大于 0。
2. `mediaPath` 可选；不存在或超限时不阻塞 ECSV 上传。
3. `previewPath` 可选；不存在或超限时不阻塞 ECSV 上传。
4. 复制文件到 package 目录后再计算 SHA256。
5. `manifest_sha256` 必须对最终 `manifest.json` 字节计算，不能在 hash 后重新格式化 JSON。

大小限制按现有 MeteorLive 文档执行：

```text
manifest <= 1 MB
ECSV     <= 50 MB
media    <= 500 MB
preview  <= 5 MB
```

如果媒体或预览图超限：

1. 默认丢弃该可选文件，并在 `package.json` 记录原因。
2. 不要自动压缩后悄悄上传，除非命令显式启用 `--transcode-media` 或 `--resize-preview`。

#### 5.6.2 manifest vendor 扩展

manifest 的 `vendor` 字段可以保存本地追溯信息。第一版建议包含：

```json
{
  "vendor": {
    "source": "MeteorAstroLive",
    "event_package_schema": "meteor_astro_event_v1",
    "calibration_sha256": "hex-or-empty",
    "calibration_camera_code": "CAM01",
    "manual_points_sha256": "hex-or-empty",
    "reduction_mode": "existing_ecsv"
  }
}
```

`vendor` 不能包含 `device_secret`、用户 token 或本地绝对隐私路径。

### 5.7 `cloud-client`

职责：

- 构造 MeteorLive Device API URL。
- 生成 HMAC 签名头。
- 上传 multipart 包。
- 查询远端 job。
- 查询 profile 状态和最新配置。

签名 canonical string 保持 8 行：

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

接口：

```text
POST /cloud/device-api/mscloud/uploads
GET  /cloud/device-api/mscloud/jobs/{jobUid}
GET  /cloud/device-api/mscloud/profile/status
GET  /cloud/device-api/mscloud/profile/latest
```

#### 5.7.1 签名头

上传和查询 job 都走同一套 HMAC 签名。上传时使用真实 hash；非上传接口四个 hash 头都写 `-`。

上传请求头：

```text
Authorization: MeteorCloud {device_key_id}:{base64_hmac_sha256_signature}
X-Device-Key-Id: {device_key_id}
X-Timestamp: {unix_epoch_seconds}
X-Nonce: {uuid_v4}
X-Manifest-SHA256: {manifest_sha256_hex}
X-Ecsv-SHA256: {ecsv_sha256_hex}
X-Media-SHA256: {media_sha256_hex_or_-}
X-Preview-SHA256: {preview_sha256_hex_or_-}
```

JS 实现草案：

```ts
export function buildCanonical(input: {
  method: "GET" | "POST";
  urlPath: string;
  timestamp: string;
  nonce: string;
  manifestSha: string;
  ecsvSha: string;
  mediaSha: string;
  previewSha: string;
}): string {
  return [
    input.method,
    input.urlPath,
    input.timestamp,
    input.nonce,
    input.manifestSha,
    input.ecsvSha,
    input.mediaSha,
    input.previewSha,
  ].join("\n");
}
```

公网路径必须签外部路径：

```text
https://meteorlive.net/cloud/device-api/mscloud/uploads
URL_PATH = /cloud/device-api/mscloud/uploads
```

如果开发环境直连 Java 服务：

```text
http://127.0.0.1:48080/device-api/mscloud/uploads
URL_PATH = /device-api/mscloud/uploads
```

#### 5.7.2 multipart 上传

multipart part 名必须固定：

```text
manifest  application/json  必填，JSON 文本
ecsv      text/plain         必填，ECSV 文件
media     application/octet-stream 可选
preview   image/png          可选
```

上传响应必须包含：

```json
{
  "code": 0,
  "data": {
    "uploadUid": "up_xxx",
    "jobUid": "job_xxx",
    "status": "queued"
  },
  "msg": ""
}
```

处理规则：

1. HTTP 成功且 `code == 0` 才算上传接受。
2. 缺少 `uploadUid` 或 `jobUid` 时进入 `failed_terminal`。
3. 接受后本地状态进入 `job_running`，`next_retry_at` 建议设为 20 秒后。
4. 原始响应写入 `response_json` 便于排查。

#### 5.7.3 job 轮询

轮询接口：

```text
GET /cloud/device-api/mscloud/jobs/{jobUid}
```

请求签名时：

```text
method = GET
manifestSha = -
ecsvSha = -
mediaSha = -
previewSha = -
```

远端 `jobStatus` 映射：

```text
succeeded -> succeeded
failed    -> failed_terminal
dead      -> failed_terminal
queued    -> job_running
running   -> job_running
```

轮询间隔：

1. 上传刚接受后 20 秒。
2. `queued / running` 时 30 到 60 秒。
3. `succeeded / failed / dead` 后停止。

#### 5.7.4 HTTP 错误分类

```text
429、5xx、网络错误 -> failed_retriable
409                -> duplicate
400、401、413      -> failed_terminal
响应 JSON 结构错误    -> failed_terminal
```

`failed_retriable` 要设置 `next_retry_at`。达到最大重试次数后转 `failed_terminal`。

#### 5.7.5 JS 调用 MeteorLive API 实现规范

这一节是给 JS / TypeScript 客户端直接照着实现的边界。所有函数都应该是纯输入输出或显式 I/O，不依赖 Electron UI 状态。

##### 类型定义

```ts
export interface CloudProfile {
  id: number;
  apiBase: string;
  apiPrefix: string;
  deviceApiPath: string;
  stationUid: string;
  stationCode: string;
  cameraUid: string;
  cameraCode: string;
  deviceKeyId: string;
  deviceSecretRef: string;
  configVersion?: number;
  status?: string;
}

export interface CloudHashes {
  manifestSha256: string;
  ecsvSha256: string;
  mediaSha256: string;
  previewSha256: string;
}

export interface UploadPackage {
  localEventId: string;
  manifestJson: string;
  manifestPath: string;
  ecsvPath: string;
  mediaPath?: string;
  previewPath?: string;
  hashes: CloudHashes;
  sizes: {
    manifestBytes: number;
    ecsvBytes: number;
    mediaBytes: number;
    previewBytes: number;
  };
}

export interface SignedRequestHeaders {
  authorization: string;
  timestamp: string;
  nonce: string;
  headers: Record<string, string>;
}

export interface CloudApiResult<T> {
  ok: boolean;
  httpStatus: number;
  data?: T;
  code?: number;
  msg?: string;
  rawBody: string;
  error?: string;
}
```

##### URL 和路径

必须分清完整 URL 和签名路径。

```ts
export function normalizeProfile(profile: CloudProfile): CloudProfile {
  return {
    ...profile,
    apiBase: profile.apiBase || "https://meteorlive.net",
    apiPrefix: profile.apiPrefix || "/cloud",
    deviceApiPath: profile.deviceApiPath || "/device-api/mscloud",
  };
}

export function buildDeviceApiPath(profile: CloudProfile, suffix: string): string {
  const normalized = normalizeProfile(profile);
  const prefix = normalized.apiPrefix.replace(/\/+$/, "");
  const devicePath = normalized.deviceApiPath.replace(/^\/?/, "/").replace(/\/+$/, "");
  const cleanSuffix = suffix.replace(/^\/?/, "/");
  return `${prefix}${devicePath}${cleanSuffix}`;
}

export function buildDeviceApiUrl(profile: CloudProfile, suffix: string): string {
  const normalized = normalizeProfile(profile);
  const base = normalized.apiBase.replace(/\/+$/, "");
  return `${base}${buildDeviceApiPath(normalized, suffix)}`;
}
```

例子：

```text
buildDeviceApiUrl(profile, "/uploads")
=> https://meteorlive.net/cloud/device-api/mscloud/uploads

buildDeviceApiPath(profile, "/uploads")
=> /cloud/device-api/mscloud/uploads
```

HMAC canonical string 里的第二行必须使用 `buildDeviceApiPath()`，不能使用完整 URL。

##### 签名函数

```ts
import { createHmac, randomUUID } from "node:crypto";

export function hmacSha256Base64(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("base64");
}

export function signDeviceRequest(input: {
  profile: CloudProfile;
  deviceSecret: string;
  method: "GET" | "POST";
  urlPath: string;
  hashes?: Partial<CloudHashes>;
  timestamp?: string;
  nonce?: string;
}): SignedRequestHeaders {
  const manifestSha = input.hashes?.manifestSha256 ?? "-";
  const ecsvSha = input.hashes?.ecsvSha256 ?? "-";
  const mediaSha = input.hashes?.mediaSha256 ?? "-";
  const previewSha = input.hashes?.previewSha256 ?? "-";
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = input.nonce ?? randomUUID();
  const canonical = buildCanonical({
    method: input.method,
    urlPath: input.urlPath,
    timestamp,
    nonce,
    manifestSha,
    ecsvSha,
    mediaSha,
    previewSha,
  });
  const signature = hmacSha256Base64(input.deviceSecret, canonical);
  const authorization = `MeteorCloud ${input.profile.deviceKeyId}:${signature}`;
  return {
    authorization,
    timestamp,
    nonce,
    headers: {
      Authorization: authorization,
      "X-Device-Key-Id": input.profile.deviceKeyId,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Manifest-SHA256": manifestSha,
      "X-Ecsv-SHA256": ecsvSha,
      "X-Media-SHA256": mediaSha,
      "X-Preview-SHA256": previewSha,
    },
  };
}
```

签名固定样例必须作为单元测试：

```text
device_secret:
  test_device_secret_20260403

canonical_string:
  POST
  /cloud/device-api/mscloud/uploads
  1712160000
  550e8400-e29b-41d4-a716-446655440000
  a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0011223344556677
  e5f6a7b8c9d00112233445566778899aabbccddeeff00112233445566778899
  c9d0e1f2a3b4c5d6e7f80112233445566778899aabbccddeeff001122334455
  -

expected_signature:
  y5CyG1Il8XPajhABZOVqeA4hkr93Cs166Nu+qM5hors=
```

##### 响应解析

MeteorLive API 响应外层格式固定：

```json
{
  "code": 0,
  "data": {},
  "msg": ""
}
```

JS 客户端解析规则：

```ts
export async function parseCloudResponse<T>(response: Response): Promise<CloudApiResult<T>> {
  const rawBody = await response.text();
  let body: { code?: number; data?: T; msg?: string };
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return {
      ok: false,
      httpStatus: response.status,
      rawBody,
      error: "invalid JSON response",
    };
  }
  const ok = response.ok && body.code === 0;
  return {
    ok,
    httpStatus: response.status,
    code: body.code,
    data: body.data,
    msg: body.msg,
    rawBody,
    error: ok ? undefined : body.msg || `HTTP ${response.status}`,
  };
}
```

##### 上传函数

Node.js 版本建议使用 Node 20+ 的内置 `fetch`、`FormData`、`Blob`、`File`，或统一封装 `undici`。不要手写 multipart boundary，除非内置 FormData 不能满足文件流需求。

```ts
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export async function uploadEventPackage(input: {
  profile: CloudProfile;
  deviceSecret: string;
  pkg: UploadPackage;
}): Promise<CloudApiResult<{ uploadUid: string; jobUid: string; status: string }>> {
  const url = buildDeviceApiUrl(input.profile, "/uploads");
  const path = buildDeviceApiPath(input.profile, "/uploads");
  const signed = signDeviceRequest({
    profile: input.profile,
    deviceSecret: input.deviceSecret,
    method: "POST",
    urlPath: path,
    hashes: input.pkg.hashes,
  });

  const form = new FormData();
  form.append("manifest", new Blob([input.pkg.manifestJson], { type: "application/json" }), "manifest.json");
  form.append("ecsv", new Blob([await readFile(input.pkg.ecsvPath)], { type: "text/plain" }), basename(input.pkg.ecsvPath));
  if (input.pkg.mediaPath) {
    form.append("media", new Blob([await readFile(input.pkg.mediaPath)], { type: "application/octet-stream" }), basename(input.pkg.mediaPath));
  }
  if (input.pkg.previewPath) {
    form.append("preview", new Blob([await readFile(input.pkg.previewPath)], { type: "image/png" }), basename(input.pkg.previewPath));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: signed.headers,
    body: form,
  });
  return parseCloudResponse(response);
}
```

上传前必须检查：

1. `pkg.manifestJson` 与 `pkg.hashes.manifestSha256` 对应。
2. `ecsvPath` 存在，且 SHA256 与 `pkg.hashes.ecsvSha256` 对应。
3. 可选 `mediaPath / previewPath` 存在时，hash 必须对应。
4. 不要手动设置 `Content-Type: multipart/form-data`；让 `fetch/FormData` 自动带 boundary。

##### 查询 job

```ts
export async function pollRemoteJob(input: {
  profile: CloudProfile;
  deviceSecret: string;
  jobUid: string;
}): Promise<CloudApiResult<{
  uploadUid: string;
  jobUid: string;
  jobStatus: "queued" | "running" | "succeeded" | "failed" | "dead";
  pipelineEventId?: string | null;
  accepted?: boolean | null;
  reason?: string | null;
}>> {
  const suffix = `/jobs/${encodeURIComponent(input.jobUid)}`;
  const url = buildDeviceApiUrl(input.profile, suffix);
  const path = buildDeviceApiPath(input.profile, suffix);
  const signed = signDeviceRequest({
    profile: input.profile,
    deviceSecret: input.deviceSecret,
    method: "GET",
    urlPath: path,
  });
  const response = await fetch(url, {
    method: "GET",
    headers: signed.headers,
  });
  return parseCloudResponse(response);
}
```

##### 查询和刷新 profile

```ts
export async function queryProfileStatus(input: {
  profile: CloudProfile;
  deviceSecret: string;
}): Promise<CloudApiResult<{
  deviceKeyId: string;
  status: string;
  dailyQuotaGb: number;
  remainingQuotaBytes: number;
  latestConfigVersion: number;
}>> {
  const url = buildDeviceApiUrl(input.profile, "/profile/status");
  const path = buildDeviceApiPath(input.profile, "/profile/status");
  const signed = signDeviceRequest({
    profile: input.profile,
    deviceSecret: input.deviceSecret,
    method: "GET",
    urlPath: path,
  });
  return parseCloudResponse(await fetch(url, { method: "GET", headers: signed.headers }));
}

export async function refreshProfileLatest(input: {
  profile: CloudProfile;
  deviceSecret: string;
}): Promise<CloudApiResult<Partial<CloudProfile>>> {
  const url = buildDeviceApiUrl(input.profile, "/profile/latest");
  const path = buildDeviceApiPath(input.profile, "/profile/latest");
  const signed = signDeviceRequest({
    profile: input.profile,
    deviceSecret: input.deviceSecret,
    method: "GET",
    urlPath: path,
  });
  return parseCloudResponse(await fetch(url, { method: "GET", headers: signed.headers }));
}
```

`/profile/latest` 不会返回 `device_secret`。刷新时只能更新非敏感配置，不能覆盖本地 secret 引用。

##### 错误到队列状态映射

```ts
export function classifyCloudFailure(httpStatus: number, code?: number, error?: string):
  "failed_retriable" | "failed_terminal" | "duplicate" {
  if (httpStatus === 409) return "duplicate";
  if (httpStatus === 429 || httpStatus >= 500 || httpStatus === 0) {
    return "failed_retriable";
  }
  return "failed_terminal";
}
```

额外规则：

1. `401` 通常是凭证不存在、吊销、签名错误、时间偏差或 nonce 重复，默认终止并提示用户检查 profile / 系统时间。
2. `413` 表示文件超限，默认终止；媒体或预览图应在打包阶段就丢弃或压缩。
3. `409` 是重复上传，进入 `duplicate`，不要继续重试。
4. 网络异常没有 HTTP 状态时记为 `httpStatus = 0`，按可重试处理。

##### 日志规则

日志允许记录：

```text
api_base
device_key_id
camera_code
local_event_id
uploadUid
jobUid
HTTP status
error code / msg
```

日志禁止记录：

```text
device_secret
完整 Authorization
用户密码
accessToken / refreshToken
本地敏感绝对路径
```

### 5.8 `upload-store`

职责：

- 本地 SQLite 队列。
- 支持断点续传和重启后继续。
- 记录远端 `uploadUid`、`jobUid`、错误码和重试时间。

建议表：

```sql
CREATE TABLE event_package (
  id INTEGER PRIMARY KEY,
  local_event_id TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  camera_code TEXT NOT NULL,
  event_time_utc TEXT NOT NULL,
  source_event_json TEXT NOT NULL,
  calibration_id INTEGER,
  calibration_sha256 TEXT,
  manual_points_path TEXT,
  manual_points_sha256 TEXT,
  ecsv_path TEXT,
  media_path TEXT,
  preview_path TEXT,
  output_dir TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE upload_queue (
  id INTEGER PRIMARY KEY,
  local_event_id TEXT NOT NULL UNIQUE,
  camera_code TEXT NOT NULL,
  event_time_utc TEXT NOT NULL,
  package_dir TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  ecsv_path TEXT NOT NULL,
  media_path TEXT,
  preview_path TEXT,
  manifest_sha256 TEXT NOT NULL,
  ecsv_sha256 TEXT NOT NULL,
  media_sha256 TEXT NOT NULL DEFAULT '-',
  preview_sha256 TEXT NOT NULL DEFAULT '-',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_attempt_at TEXT,
  uploaded_at TEXT,
  completed_at TEXT,
  remote_upload_uid TEXT,
  remote_job_uid TEXT,
  remote_job_status TEXT,
  error_code TEXT,
  error_message TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`cloud_profile` 和 `cloud_camera_binding` 表按 5.5.1 定义；`calibration` 表按 5.2.3 定义。这里不重复定义，避免 profile、CAL 绑定和上传队列混在同一张表里。

上传状态：

```text
discovered
packed
queued
uploading
uploaded
job_running
succeeded
duplicate
failed_retriable
failed_terminal
```

#### 5.8.1 入队规则

入队必须幂等：

1. `local_event_id` 已存在时不重复创建。
2. package hash 不变时返回 existing。
3. package hash 改变时要求用户显式 `--replace`，避免同一事件反复上传不同文件。
4. `succeeded / duplicate` 状态默认不可重新上传；要人工 reset。

#### 5.8.2 重试字段

每次 worker 取任务时更新：

```text
attempts += 1
last_attempt_at = now
status = uploading 或 job_running
```

失败后：

```text
failed_retriable:
  next_retry_at = now + retryDelay(attempts)

failed_terminal:
  completed_at = now
  next_retry_at = null
```

建议默认退避：

```text
第 1 次：5 分钟
第 2 次：15 分钟
第 3 次：1 小时
之后：6 小时
```

### 5.9 `upload-worker`

职责：

- 扫描队列。
- 上传 `queued / failed_retriable` 任务。
- 轮询 `uploaded / job_running` 任务。
- 处理限流、网络失败、重复上传和终止错误。

默认策略：

- 单并发上传。
- `429`、`5xx`、网络错误进入可重试。
- `401`、摘要不匹配、manifest 错误进入终止失败。
- `409` 重复上传进入 `duplicate`，不反复上传。

worker 单轮逻辑：

```text
1. 读取设置和当前时间。
2. 如果不在上传时间窗，退出本轮。
3. 查找 queued / failed_retriable 且 next_retry_at <= now 的任务。
4. 对每个任务加载 profile 和 camera binding。
5. 重新检查 package 文件是否存在，hash 是否与入队时一致。
6. POST /uploads。
7. 成功则写 remote_upload_uid / remote_job_uid，状态转 job_running。
8. 再查找 job_running 任务。
9. GET /jobs/{jobUid}。
10. 根据远端状态写 succeeded / failed_terminal / job_running。
```

worker 不应该做：

1. 不自动重做手动标定。
2. 不自动修改 ECSV。
3. 不自动替换 CAL。
4. 不把用户 token 写入队列。

## 6. 推荐目录结构

```text
MeteorAstroLive/
  package.json
  tsconfig.json
  src/
    cli/
      index.ts
    event-contract/
      schema.ts
      validate.ts
    manual-calibration/
      platepar-store.ts
      camera-binding.ts
    manual-reduction/
      points.ts
      ecsv-adapter.ts
    ffmpeg-tools/
      ffmpeg.ts
      preview.ts
      media.ts
    cloud-profile/
      profile.ts
      secret-store.ts
    cloud-package/
      manifest.ts
      hashes.ts
      package-builder.ts
    cloud-client/
      signer.ts
      device-api.ts
    upload-store/
      db.ts
      migrations.ts
      queue.ts
    upload-worker/
      worker.ts
      retry-policy.ts
  engines/
    ffmpeg.exe
    astro-reduce.exe
```

`astro-reduce.exe` 是可选引擎。第一版如果只上传已有 ECSV，可以没有它。

## 7. CLI 草案

```powershell
meteor-astro-live profile import --file cloud_profile.json
meteor-astro-live profile status --camera CAM01

meteor-astro-live cal import `
  --camera CAM01 `
  --stream main `
  --file cal\CAM01_main.cal `
  --activate

meteor-astro-live cal inspect --camera CAM01 --stream main

meteor-astro-live cal bind `
  --camera CAM01 `
  --stream main `
  --cal-id 12

meteor-astro-live package `
  --event event-package.json

meteor-astro-live enqueue `
  --package output\CAM01_20260515_203001

meteor-astro-live worker run
```

`cal import` 负责归档 CAL 文件，`cal bind` 只负责把已有 CAL 设为相机 active 绑定。这样可以避免“导入文件”和“切换生产使用标定”混在一起。

如果启用手动轨迹点到 ECSV：

```powershell
meteor-astro-live reduce-manual `
  --video event.mp4 `
  --cal cal\CAM01_main.cal `
  --points manual-points.json `
  --out output\CAM01_20260515_203001
```

## 8. 与现有 MeteorStation 的关系

现有 MeteorStation 可以只做一个很薄的导出桥：

```text
MeteorStation 事件
  -> 导出 event-package.json
  -> 独立 JS 模块处理打包和上传
```

不要让独立 JS 项目直接读取 MeteorStation 的主数据库表。这样可以避免被 `DataBase.h` 的历史表结构、GUI 状态和调度器耦合。

已有代码可参考但不直接照搬：

- `src/cloud/MeteorLiveCloud.cpp`：HMAC、manifest、上传、profile。
- `src/cloud/MeteorLiveCloudWorker.cpp`：上传状态机。
- `docs/meteorlive/*`：MeteorLive Device API 合同。
- `src/VideoCalibrator.cpp`：视频 + CAL + 手动轨迹 / 检测输出 ECSV 的已有 CLI 思路。
- `src/astrometry/ECSVWriter.*`：ECSV 字段和输出格式参考。

## 9. MVP 验收标准

第一版完成后至少满足：

1. 能导入并保存 `cloud_profile.json`。
2. 能保存相机到 CAL 的手动绑定关系。
3. 能读取 `event-package.json` 并校验文件存在。
4. 能接受已有 ECSV 并生成 MeteorLive manifest。
5. 能计算 SHA256 并通过固定 HMAC 签名样例。
6. 能把事件包写入 SQLite 上传队列。
7. 能上传到 `/cloud/device-api/mscloud/uploads`。
8. 能保存 `uploadUid / jobUid`。
9. 能轮询远端 job 状态。
10. 上传失败不会破坏本地事件包和手动标定数据。

第二版再增加：

1. 手动轨迹点生成 ECSV。
2. FFmpeg 预览图和短视频裁剪。
3. Electron UI。
4. 与 MeteorStation 的事件导出桥。

## 10. 风险与边界

1. 纯 JS 做完整天测量算法风险高，本阶段只做手动输入和文件流程。
2. 如果要纯 JS 输出 RA / Dec、Alt / Az，需要单独移植 platepar 坐标转换并做数值对拍。
3. MeteorLive Cloud profile 的 `device_secret` 必须安全保存，不能明文落库。
4. FFmpeg filter 字符串要谨慎处理路径和特殊字符。
5. 上传队列要支持重启恢复，不能只放内存。
6. 手动标定和手动轨迹输入必须保留原始文件，方便复核。

## 11. 建议执行顺序

1. 新建 TypeScript 项目和 `event-contract`。
2. 实现 `cloud-profile`、`cloud-client/signer`，先通过 HMAC 固定样例。
3. 实现 `cloud-package`，支持已有 ECSV 打包。
4. 实现 `upload-store` 和 `upload-worker`。
5. 加入 FFmpeg 预览图生成。
6. 加入手动 CAL 绑定和手动点文件。
7. 最后决定是否接 `astro-reduce.exe` 或移植最小坐标转换。
