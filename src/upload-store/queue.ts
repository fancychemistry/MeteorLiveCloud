import path from "node:path";
import { readJsonFile } from "../shared/json.js";
import { nowIso } from "../shared/time.js";
import { UploadPackage, UploadQueueRow, UploadStatus } from "../shared/types.js";
import { assertUser } from "../shared/errors.js";
import { AstroLiveDb } from "./db.js";

export async function readPackageFile(packageDir: string): Promise<{
  local_event_id: string;
  event_time_utc: string;
  camera_code: string;
  manifest_path: string;
  ecsv_path: string;
  media_path?: string;
  preview_path?: string;
  hashes: {
    manifestSha256: string;
    ecsvSha256: string;
    mediaSha256: string;
    previewSha256: string;
  };
}> {
  return readJsonFile(path.join(packageDir, "package.json"));
}

export async function enqueuePackage(input: {
  db: AstroLiveDb;
  packageDir: string;
  replace?: boolean;
}): Promise<UploadQueueRow> {
  const pkg = await readPackageFile(input.packageDir);
  assertUser(pkg.local_event_id, "package.json missing local_event_id");
  assertUser(pkg.manifest_path && pkg.ecsv_path, "package.json missing manifest_path or ecsv_path");
  const existing = getUploadByLocalEventId(input.db, pkg.local_event_id);
  if (existing && !input.replace) {
    return existing;
  }
  if (existing && input.replace) {
    input.db.run("DELETE FROM upload_queue WHERE local_event_id = ?", pkg.local_event_id);
  }
  const now = nowIso();
  input.db.run(
    `INSERT INTO upload_queue (
      local_event_id, camera_code, event_time_utc, package_dir, manifest_path,
      ecsv_path, media_path, preview_path, manifest_sha256, ecsv_sha256,
      media_sha256, preview_sha256, status, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pkg.local_event_id,
    pkg.camera_code,
    pkg.event_time_utc,
    input.packageDir,
    pkg.manifest_path,
    pkg.ecsv_path,
    pkg.media_path ?? "",
    pkg.preview_path ?? "",
    pkg.hashes.manifestSha256,
    pkg.hashes.ecsvSha256,
    pkg.hashes.mediaSha256,
    pkg.hashes.previewSha256,
    "queued",
    0,
    now,
    now,
  );
  const row = getUploadByLocalEventId(input.db, pkg.local_event_id);
  assertUser(row, "failed to read enqueued package");
  return row;
}

export function insertQueueFromUploadPackage(input: {
  db: AstroLiveDb;
  pkg: UploadPackage;
  cameraCode: string;
  eventTimeUtc: string;
  packageDir: string;
}): UploadQueueRow {
  const now = nowIso();
  input.db.run(
    `INSERT INTO upload_queue (
      local_event_id, camera_code, event_time_utc, package_dir, manifest_path,
      ecsv_path, media_path, preview_path, manifest_sha256, ecsv_sha256,
      media_sha256, preview_sha256, status, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_event_id) DO UPDATE SET
      package_dir=excluded.package_dir,
      manifest_path=excluded.manifest_path,
      ecsv_path=excluded.ecsv_path,
      media_path=excluded.media_path,
      preview_path=excluded.preview_path,
      manifest_sha256=excluded.manifest_sha256,
      ecsv_sha256=excluded.ecsv_sha256,
      media_sha256=excluded.media_sha256,
      preview_sha256=excluded.preview_sha256,
      status='queued',
      updated_at=excluded.updated_at`,
    input.pkg.localEventId,
    input.cameraCode,
    input.eventTimeUtc,
    input.packageDir,
    input.pkg.manifestPath,
    input.pkg.ecsvPath,
    input.pkg.mediaPath ?? "",
    input.pkg.previewPath ?? "",
    input.pkg.hashes.manifestSha256,
    input.pkg.hashes.ecsvSha256,
    input.pkg.hashes.mediaSha256,
    input.pkg.hashes.previewSha256,
    "queued",
    0,
    now,
    now,
  );
  const row = getUploadByLocalEventId(input.db, input.pkg.localEventId);
  assertUser(row, "failed to read upload queue row");
  return row;
}

export function getRunnableUploads(db: AstroLiveDb, now = nowIso(), limit = 10): UploadQueueRow[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM upload_queue
       WHERE status IN ('queued', 'failed_retriable')
         AND (next_retry_at IS NULL OR next_retry_at = '' OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      now,
      limit,
    )
    .map(rowToUpload);
}

export function getPollingUploads(db: AstroLiveDb, now = nowIso(), limit = 10): UploadQueueRow[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM upload_queue
       WHERE status = 'job_running'
         AND (next_retry_at IS NULL OR next_retry_at = '' OR next_retry_at <= ?)
       ORDER BY updated_at ASC
       LIMIT ?`,
      now,
      limit,
    )
    .map(rowToUpload);
}

export function getUploadByLocalEventId(db: AstroLiveDb, localEventId: string): UploadQueueRow | undefined {
  const row = db.get<Record<string, unknown>>("SELECT * FROM upload_queue WHERE local_event_id = ? LIMIT 1", localEventId);
  return row ? rowToUpload(row) : undefined;
}

export function updateUploadStatus(
  db: AstroLiveDb,
  id: number,
  status: UploadStatus,
  fields: Partial<UploadQueueRow> = {},
): void {
  const now = nowIso();
  db.run(
    `UPDATE upload_queue SET
      status = ?,
      attempts = ?,
      next_retry_at = ?,
      last_attempt_at = ?,
      uploaded_at = ?,
      completed_at = ?,
      remote_upload_uid = ?,
      remote_job_uid = ?,
      remote_job_status = ?,
      error_code = ?,
      error_message = ?,
      response_json = ?,
      updated_at = ?
    WHERE id = ?`,
    status,
    fields.attempts ?? undefined,
    fields.nextRetryAt ?? "",
    fields.lastAttemptAt ?? "",
    fields.uploadedAt ?? "",
    fields.completedAt ?? "",
    fields.remoteUploadUid ?? "",
    fields.remoteJobUid ?? "",
    fields.remoteJobStatus ?? "",
    fields.errorCode ?? "",
    fields.errorMessage ?? "",
    fields.responseJson ?? "",
    now,
    id,
  );
}

export function rowToUpload(row: Record<string, unknown>): UploadQueueRow {
  return {
    id: Number(row.id),
    localEventId: String(row.local_event_id),
    cameraCode: String(row.camera_code),
    eventTimeUtc: String(row.event_time_utc),
    packageDir: String(row.package_dir),
    manifestPath: String(row.manifest_path),
    ecsvPath: String(row.ecsv_path),
    mediaPath: row.media_path ? String(row.media_path) : undefined,
    previewPath: row.preview_path ? String(row.preview_path) : undefined,
    hashes: {
      manifestSha256: String(row.manifest_sha256),
      ecsvSha256: String(row.ecsv_sha256),
      mediaSha256: String(row.media_sha256 ?? "-"),
      previewSha256: String(row.preview_sha256 ?? "-"),
    },
    status: String(row.status) as UploadStatus,
    attempts: Number(row.attempts ?? 0),
    nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : undefined,
    lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : undefined,
    uploadedAt: row.uploaded_at ? String(row.uploaded_at) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    remoteUploadUid: row.remote_upload_uid ? String(row.remote_upload_uid) : undefined,
    remoteJobUid: row.remote_job_uid ? String(row.remote_job_uid) : undefined,
    remoteJobStatus: row.remote_job_status ? String(row.remote_job_status) : undefined,
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    responseJson: row.response_json ? String(row.response_json) : undefined,
  };
}
