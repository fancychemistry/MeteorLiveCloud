import { readJsonFile, asRecord, stringField, numberField } from "../shared/json.js";
import { assertUser } from "../shared/errors.js";
import { CloudCameraBinding, CloudProfile } from "../shared/types.js";
import { nowIso } from "../shared/time.js";
import { AstroLiveDb } from "../upload-store/db.js";
import { SecretStore } from "./secret-store.js";

function profilePayload(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw, "cloud profile");
  if (root.profile && typeof root.profile === "object" && !Array.isArray(root.profile)) {
    return root.profile as Record<string, unknown>;
  }
  return root;
}

function scalarTextField(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

export async function importCloudProfile(input: {
  db: AstroLiveDb;
  secretStore: SecretStore;
  filePath: string;
  bindCameraCode?: string;
  enableBinding?: boolean;
}): Promise<CloudProfile> {
  const payload = profilePayload(await readJsonFile(input.filePath));
  const deviceSecret = stringField(payload, "device_secret", "deviceSecret");
  const deviceKeyId = stringField(payload, "device_key_id", "deviceKeyId");
  const stationUid = stringField(payload, "station_uid", "stationUid");
  const cameraUid = stringField(payload, "camera_uid", "cameraUid");
  assertUser(deviceSecret, "cloud profile must include device_secret");
  assertUser(deviceKeyId, "cloud profile must include device_key_id");
  assertUser(stationUid, "cloud profile must include station_uid");
  assertUser(cameraUid, "cloud profile must include camera_uid");

  const cameraCode = stringField(payload, "camera_code", "cameraCode");
  const stationCode = stringField(payload, "station_code", "stationCode");
  const now = nowIso();
  const secretRef = await input.secretStore.putSecret(deviceKeyId, deviceSecret);

  input.db.run(
    `INSERT INTO cloud_profile (
      name, active, profile_version, config_version, api_base, api_prefix,
      device_api_path, station_uid, station_code, camera_uid, camera_code,
      device_key_id, device_secret_ref, upload_policy_json, status, issued_at,
      imported_at, updated_at, daily_quota_gb, remaining_quota_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_key_id) DO UPDATE SET
      name=excluded.name,
      active=excluded.active,
      profile_version=excluded.profile_version,
      config_version=excluded.config_version,
      api_base=excluded.api_base,
      api_prefix=excluded.api_prefix,
      device_api_path=excluded.device_api_path,
      station_uid=excluded.station_uid,
      station_code=excluded.station_code,
      camera_uid=excluded.camera_uid,
      camera_code=excluded.camera_code,
      device_secret_ref=excluded.device_secret_ref,
      upload_policy_json=excluded.upload_policy_json,
      status=excluded.status,
      issued_at=excluded.issued_at,
      updated_at=excluded.updated_at,
      daily_quota_gb=excluded.daily_quota_gb,
      remaining_quota_bytes=excluded.remaining_quota_bytes`,
    cameraCode || deviceKeyId,
    1,
    numberField(payload, "profile_version", numberField(payload, "profileVersion", 0)),
    numberField(payload, "config_version", numberField(payload, "configVersion", 0)),
    stringField(payload, "api_base", "apiBase") || "https://meteorlive.net",
    stringField(payload, "api_prefix", "apiPrefix") || "/cloud",
    stringField(payload, "device_api_path", "deviceApiPath") || "/device-api/mscloud",
    stationUid,
    stationCode,
    cameraUid,
    cameraCode,
    deviceKeyId,
    secretRef,
    JSON.stringify(payload.upload_policy ?? payload.uploadPolicy ?? {}),
    stringField(payload, "status"),
    scalarTextField(payload, "issued_at", "issuedAt"),
    now,
    now,
    numberField(payload, "daily_quota_gb", numberField(payload, "dailyQuotaGb", 0)),
    numberField(payload, "remaining_quota_bytes", numberField(payload, "remainingQuotaBytes", 0)),
  );

  const profile = getProfileByDeviceKey(input.db, deviceKeyId);
  assertUser(profile, "failed to read saved cloud profile");

  if (input.bindCameraCode) {
    bindCloudCamera(input.db, {
      cameraCode: input.bindCameraCode,
      profileId: profile.id,
      enabled: Boolean(input.enableBinding),
      stationUid: profile.stationUid,
      stationCode: profile.stationCode,
      cameraUid: profile.cameraUid,
      remoteCameraCode: profile.cameraCode,
    });
  }

  return profile;
}

export function bindCloudCamera(db: AstroLiveDb, binding: CloudCameraBinding): void {
  const now = nowIso();
  db.run(
    `INSERT INTO cloud_camera_binding (
      camera_code, profile_id, enabled, station_uid, station_code, camera_uid,
      camera_code_remote, created_at, updated_at, last_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(camera_code) DO UPDATE SET
      profile_id=excluded.profile_id,
      enabled=excluded.enabled,
      station_uid=excluded.station_uid,
      station_code=excluded.station_code,
      camera_uid=excluded.camera_uid,
      camera_code_remote=excluded.camera_code_remote,
      updated_at=excluded.updated_at,
      last_message=excluded.last_message`,
    binding.cameraCode,
    binding.profileId,
    binding.enabled ? 1 : 0,
    binding.stationUid,
    binding.stationCode,
    binding.cameraUid,
    binding.remoteCameraCode,
    now,
    now,
    "binding saved",
  );
}

export function getProfileByDeviceKey(db: AstroLiveDb, deviceKeyId: string): CloudProfile | undefined {
  const row = db.get<Record<string, unknown>>(
    "SELECT * FROM cloud_profile WHERE device_key_id = ? LIMIT 1",
    deviceKeyId,
  );
  return row ? rowToProfile(row) : undefined;
}

export function getProfile(db: AstroLiveDb, profileId: number): CloudProfile | undefined {
  const row = db.get<Record<string, unknown>>("SELECT * FROM cloud_profile WHERE id = ? LIMIT 1", profileId);
  return row ? rowToProfile(row) : undefined;
}

export function getBinding(db: AstroLiveDb, cameraCode: string): CloudCameraBinding | undefined {
  const row = db.get<Record<string, unknown>>(
    "SELECT * FROM cloud_camera_binding WHERE camera_code = ? LIMIT 1",
    cameraCode,
  );
  if (!row) {
    return undefined;
  }
  return {
    cameraCode: String(row.camera_code),
    profileId: Number(row.profile_id),
    enabled: Number(row.enabled) !== 0,
    stationUid: String(row.station_uid ?? ""),
    stationCode: String(row.station_code ?? ""),
    cameraUid: String(row.camera_uid ?? ""),
    remoteCameraCode: String(row.camera_code_remote ?? ""),
  };
}

function rowToProfile(row: Record<string, unknown>): CloudProfile {
  return {
    id: Number(row.id),
    name: String(row.name ?? "default"),
    active: Number(row.active) !== 0,
    profileVersion: Number(row.profile_version ?? 0),
    configVersion: Number(row.config_version ?? 0),
    apiBase: String(row.api_base ?? "https://meteorlive.net"),
    apiPrefix: String(row.api_prefix ?? "/cloud"),
    deviceApiPath: String(row.device_api_path ?? "/device-api/mscloud"),
    stationUid: String(row.station_uid ?? ""),
    stationCode: String(row.station_code ?? ""),
    cameraUid: String(row.camera_uid ?? ""),
    cameraCode: String(row.camera_code ?? ""),
    deviceKeyId: String(row.device_key_id ?? ""),
    deviceSecretRef: String(row.device_secret_ref ?? ""),
    uploadPolicyJson: row.upload_policy_json ? String(row.upload_policy_json) : undefined,
    status: row.status ? String(row.status) : undefined,
    issuedAt: row.issued_at ? String(row.issued_at) : undefined,
  };
}
