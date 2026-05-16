export type JsonObject = Record<string, unknown>;

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
  originalPath?: string;
  sha256: string;
  active: boolean;
  summary: PlateparSummary;
}

export interface EventPackageInput {
  schema: "meteor_astro_event_v1";
  local_event_id: string;
  event_time_utc: string;
  station_code?: string;
  camera_code: string;
  video_path?: string;
  platepar_path?: string;
  calibration_id?: number;
  ecsv_path?: string;
  preview_path?: string;
  manual_points_path?: string;
  output_dir: string;
  stream?: CalibrationStream;
}

export interface ResolvedEventPackage {
  schemaVersion: string;
  localEventId: string;
  eventTimeUtc: string;
  stationCode: string;
  cameraCode: string;
  videoPath?: string;
  ecsvPath?: string;
  previewPath?: string;
  manualPointsPath?: string;
  outputDir: string;
  stream: CalibrationStream;
  calibration?: CalibrationBinding;
}

export interface CloudProfile {
  id: number;
  name: string;
  active: boolean;
  profileVersion: number;
  configVersion: number;
  apiBase: string;
  apiPrefix: string;
  deviceApiPath: string;
  stationUid: string;
  stationCode: string;
  cameraUid: string;
  cameraCode: string;
  deviceKeyId: string;
  deviceSecretRef: string;
  uploadPolicyJson?: string;
  status?: string;
  issuedAt?: string;
}

export interface CloudCameraBinding {
  cameraCode: string;
  profileId: number;
  enabled: boolean;
  stationUid: string;
  stationCode: string;
  cameraUid: string;
  remoteCameraCode: string;
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

export type UploadStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "job_running"
  | "succeeded"
  | "duplicate"
  | "failed_retriable"
  | "failed_terminal";

export interface UploadQueueRow {
  id: number;
  localEventId: string;
  cameraCode: string;
  eventTimeUtc: string;
  packageDir: string;
  manifestPath: string;
  ecsvPath: string;
  mediaPath?: string;
  previewPath?: string;
  hashes: CloudHashes;
  status: UploadStatus;
  attempts: number;
  nextRetryAt?: string;
  lastAttemptAt?: string;
  uploadedAt?: string;
  completedAt?: string;
  remoteUploadUid?: string;
  remoteJobUid?: string;
  remoteJobStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  responseJson?: string;
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
