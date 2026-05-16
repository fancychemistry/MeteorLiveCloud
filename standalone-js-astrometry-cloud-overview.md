# 独立天测量与 MeteorLive 上报流程简明说明

状态：draft
最后核对：2026-05-16
详细规格：`standalone-js-astrometry-cloud-plan.md`

这份文档只讲运行逻辑，帮助开发者快速理解这套独立 JS / TypeScript 程序应该怎么跑。更细的表结构、TypeScript 类型和 API 签名规则看详细规格。

## 1. 一句话

这套程序不负责实时检测，也不负责自动标定。它负责把“已有视频、手动 CAL、手动轨迹或已有 ECSV”整理成标准事件包，然后异步上传到 MeteorLive Cloud。

```text
视频 + CAL + 手动轨迹 / 已有 ECSV
  -> 事件包
  -> ECSV / manifest / 预览图
  -> 本地上传队列
  -> MeteorLive Cloud
```

## 2. 输入

最小输入有两种。

第一种最简单：

```text
已有 event.ecsv
已有或可选 event.mp4
已有或可选 preview.png
cloud_profile.json
```

第二种用于手动减流星：

```text
event.mp4
camera.cal / platepar.json
manual-points.json
cloud_profile.json
```

其中 `manual-points.json` 只记录人工点出来的流星像素轨迹，例如帧号、x、y。

## 3. CAL 的作用

CAL 只做一件事：说明这个相机画面如何对应天空坐标。

它来自手动标定，例如 SkyFit 保存的 platepar。程序导入 CAL 后会做三件事：

1. 复制一份到自己的 `data/calibrations/` 目录。
2. 计算 SHA256，保证以后能追溯当时用的是哪一版 CAL。
3. 绑定到某个本地相机，例如 `CAM01 main`。

同一个相机可以有多个历史 CAL，但同一时间只应该有一个 active CAL。

事件处理时的 CAL 选择顺序：

1. 事件包里显式指定的 CAL。
2. 事件包里指定的 `calibration_id`。
3. 当前相机 active CAL。
4. 都没有时，只能上传已有 ECSV，不能从手动点生成 ECSV。

注意：CAL 文件里的 `JD` 不是事件时间。真正的事件时间必须来自 `event_time_utc`。

## 4. 事件包

事件包是这套程序的核心输入合同。它把一个流星事件需要的文件和元数据放在一起。

示例：

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

`local_event_id` 在本地必须唯一。后续上传去重和队列恢复都靠它。

## 5. ECSV 生成逻辑

MeteorLive 上传必须有 ECSV。程序按下面顺序处理：

1. 如果事件包已经有 `ecsv_path`，直接校验并使用。
2. 如果没有 ECSV，但有视频、CAL、手动点，则调用外部转换器生成 ECSV。
3. 如果既没有 ECSV，也没有可生成 ECSV 的输入，则事件不能上传。

第一版不建议用纯 JS 重写完整天测量算法。更稳的方式是 JS 调一个独立转换程序：

```text
video + cal + manual-points.json
  -> astro-reduce.exe
  -> event.ecsv
```

JS 负责检查输入、调用程序、记录结果和继续上传。

## 6. 打包逻辑

上传前会生成一个 package 目录：

```text
package/
  manifest.json
  event.ecsv
  event.mp4
  preview.png
  package.json
```

`manifest.json` 上传给 MeteorLive。  
`package.json` 只给本地程序自己用，记录 hash、文件大小、使用的 CAL、错误和构建过程。

打包时会计算：

```text
manifest_sha256
ecsv_sha256
media_sha256
preview_sha256
```

其中 ECSV 必须存在。视频和预览图是可选的，超限或不存在时可以跳过。

## 7. Cloud Profile

`cloud_profile.json` 是 MeteorLive 给本地程序的设备凭证。

里面最重要的是：

```text
api_base
api_prefix
device_api_path
station_uid
camera_uid
device_key_id
device_secret
```

导入后：

1. 非敏感字段写入 SQLite。
2. `device_secret` 写入系统 secret store。
3. 数据库只保存 `device_secret_ref`。
4. 日志不能打印 `device_secret` 或完整 `Authorization`。

上传长期使用的是 `device_key_id + device_secret`，不是用户账号密码，也不是网页登录 token。

## 8. 本地相机如何绑定云端相机

绑定不是靠相机名字自动猜，而是靠 `cloud_profile.json`。

云端给每个 camera 签发一份独立 profile，里面包含：

```text
station_uid
camera_uid
camera_code
device_key_id
device_secret
```

本地导入 profile 后，用户把它绑定到本地相机：

```text
本地 CAM01
  -> cloud profile
  -> 云端 station_uid / camera_uid
```

上传时分两步使用这份绑定：

1. `manifest.json` 写入 `station_uid / camera_uid / camera_code`，说明这个事件属于哪个云端相机。
2. HTTP 请求用 `device_key_id + device_secret` 做 HMAC 签名，证明本地确实有这个云端相机的上传权限。

所以真正的关系是：

```text
本地相机
  -> profile_id
  -> 云端 camera_uid
  -> 设备密钥
```

如果没有启用这条绑定，即使本地有 ECSV，也不应该自动上传。

## 9. 上传逻辑

上传只走 MeteorLive Device API：

```text
POST /cloud/device-api/mscloud/uploads
GET  /cloud/device-api/mscloud/jobs/{jobUid}
GET  /cloud/device-api/mscloud/profile/status
GET  /cloud/device-api/mscloud/profile/latest
```

上传请求是 multipart：

```text
manifest  必填
ecsv      必填
media     可选
preview   可选
```

每个请求都要 HMAC 签名。签名内容包含：

```text
HTTP 方法
URL path
时间戳
nonce
manifest hash
ECSV hash
media hash
preview hash
```

上传成功后，云端会返回：

```text
uploadUid
jobUid
status
```

本地保存这些值，然后进入 job 轮询。

## 10. 队列状态

所有上传都先入队，worker 异步处理。

常见状态：

```text
queued
uploading
job_running
succeeded
duplicate
failed_retriable
failed_terminal
```

状态含义：

```text
queued             等待上传
uploading          正在 POST /uploads
job_running        云端已接收，等待云端处理
succeeded          云端处理成功
duplicate          云端认为重复，不再重试
failed_retriable   网络、限流、5xx，可重试
failed_terminal    签名、凭证、文件、manifest 等硬错误
```

worker 每轮做两件事：

1. 找到可以上传的任务，上传 package。
2. 找到 `job_running` 的任务，查询云端 job 状态。

## 11. 错误处理

建议默认规则：

```text
429 / 5xx / 网络错误 -> failed_retriable
409                  -> duplicate
400 / 401 / 413      -> failed_terminal
响应结构错误           -> failed_terminal
```

`failed_retriable` 会按退避时间重试。  
`failed_terminal` 需要人工检查，不自动重试。

## 12. 开发者先做什么

建议按这个顺序开发：

1. 事件包读取和校验。
2. CAL 导入、归档和 active 绑定。
3. profile 导入和 secret 保存。
4. ECSV + manifest 打包。
5. HMAC 签名单元测试。
6. multipart 上传。
7. SQLite 上传队列。
8. worker 轮询 job。
9. 最后再接 UI。

最小可用版本只需要支持：

```text
已有 ECSV
已有 cloud_profile.json
生成 manifest
上传并轮询 job
```

手动点转 ECSV、视频裁剪、预览图、Electron UI 都可以放到后面。
