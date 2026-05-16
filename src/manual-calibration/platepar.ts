import path from "node:path";
import { copyFile } from "node:fs/promises";
import { readJsonFile, asRecord, numberArrayField, numberField, stringField } from "../shared/json.js";
import { assertUser } from "../shared/errors.js";
import { CalibrationBinding, CalibrationStream, PlateparSummary } from "../shared/types.js";
import { compactIsoForPath, nowIso } from "../shared/time.js";
import { ensureDir } from "../shared/paths.js";
import { sha256FileHex } from "../cloud-package/hashes.js";
import { AstroLiveDb } from "../upload-store/db.js";
import { writeJsonFile } from "../shared/json.js";

const SKYFIT_SNAPSHOT_KIND = "meteorstation_skyfit_calibration_bundle";

export async function loadPlateparSummary(filePath: string): Promise<PlateparSummary> {
  const raw = asRecord(await readJsonFile(filePath), "platepar file");
  const platepar =
    raw.kind === SKYFIT_SNAPSHOT_KIND ? asRecord(raw.platepar, "SkyFit snapshot platepar") : raw;

  const summary: PlateparSummary = {
    version: numberField(platepar, "version", 2),
    stationCode: stringField(platepar, "station_code"),
    lat: numberField(platepar, "lat"),
    lon: numberField(platepar, "lon"),
    elev: numberField(platepar, "elev"),
    jd: numberField(platepar, "JD", 2451545.0),
    width: numberField(platepar, "X_res", 0),
    height: numberField(platepar, "Y_res", 0),
    fovH: numberField(platepar, "fov_h"),
    fovV: numberField(platepar, "fov_v"),
    raDeg: numberField(platepar, "RA_d"),
    decDeg: numberField(platepar, "dec_d"),
    posAngleRef: numberField(platepar, "pos_angle_ref"),
    rotationFromHoriz: numberField(platepar, "rotation_from_horiz"),
    fScale: numberField(platepar, "F_scale"),
    distortionType: stringField(platepar, "distortion_type"),
    xPolyFwd: numberArrayField(platepar, "x_poly_fwd"),
    yPolyFwd: numberArrayField(platepar, "y_poly_fwd"),
    xPolyRev: numberArrayField(platepar, "x_poly_rev"),
    yPolyRev: numberArrayField(platepar, "y_poly_rev"),
  };
  validatePlateparSummary(summary);
  return summary;
}

export function validatePlateparSummary(summary: PlateparSummary): void {
  assertUser(summary.width > 0 && summary.height > 0, "platepar X_res/Y_res must be greater than zero");
  assertUser(summary.lat >= -90 && summary.lat <= 90, "platepar lat must be within [-90, 90]");
  assertUser(summary.lon >= -180 && summary.lon <= 180, "platepar lon must be within [-180, 180]");
  assertUser(summary.fScale > 0, "platepar F_scale must be greater than zero");
  assertUser(summary.distortionType.length > 0, "platepar distortion_type is required");
}

export async function importCalibration(input: {
  db: AstroLiveDb;
  dataDir: string;
  cameraCode: string;
  stream: CalibrationStream;
  filePath: string;
  activate?: boolean;
  sourceTool?: string;
  notes?: string;
}): Promise<CalibrationBinding> {
  const summary = await loadPlateparSummary(input.filePath);
  const sha = await sha256FileHex(input.filePath);
  const stamp = compactIsoForPath();
  const archiveDir = path.join(input.dataDir, "calibrations", input.cameraCode, `${stamp}_${input.stream}`);
  await ensureDir(archiveDir);
  const plateparPath = path.join(archiveDir, "platepar.json");
  await copyFile(input.filePath, plateparPath);
  await writeJsonFile(path.join(archiveDir, "source-info.json"), {
    camera_code: input.cameraCode,
    stream: input.stream,
    active: Boolean(input.activate),
    platepar_path: plateparPath,
    original_path: input.filePath,
    sha256: sha,
    source: "manual",
    source_tool: input.sourceTool ?? "manual",
    width: summary.width,
    height: summary.height,
    station_code: summary.stationCode,
    created_at: nowIso(),
    notes: input.notes ?? "",
  });

  if (input.activate) {
    input.db.run(
      "UPDATE calibration SET active = 0, updated_at = ? WHERE camera_code = ? AND stream = ?",
      nowIso(),
      input.cameraCode,
      input.stream,
    );
  }
  const now = nowIso();
  input.db.run(
    `INSERT INTO calibration (
      camera_code, stream, platepar_path, original_path, sha256, station_code,
      width, height, source, source_tool, active, summary_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.cameraCode,
    input.stream,
    plateparPath,
    input.filePath,
    sha,
    summary.stationCode,
    summary.width,
    summary.height,
    "manual",
    input.sourceTool ?? "manual",
    input.activate ? 1 : 0,
    JSON.stringify(summary),
    now,
    now,
  );
  const id = Number(input.db.db.prepare("SELECT last_insert_rowid() AS id").get()?.id ?? 0);
  const saved = getCalibrationById(input.db, id);
  assertUser(saved, "failed to read imported calibration");
  return saved;
}

export function activateCalibration(db: AstroLiveDb, id: number): CalibrationBinding {
  const calibration = getCalibrationById(db, id);
  assertUser(calibration, `calibration ${id} not found`);
  db.run(
    "UPDATE calibration SET active = 0, updated_at = ? WHERE camera_code = ? AND stream = ?",
    nowIso(),
    calibration.cameraCode,
    calibration.stream,
  );
  db.run("UPDATE calibration SET active = 1, updated_at = ? WHERE id = ?", nowIso(), id);
  const updated = getCalibrationById(db, id);
  assertUser(updated, `calibration ${id} not found after activation`);
  return updated;
}

export function getActiveCalibration(
  db: AstroLiveDb,
  cameraCode: string,
  stream: CalibrationStream,
): CalibrationBinding | undefined {
  const row = db.get<Record<string, unknown>>(
    "SELECT * FROM calibration WHERE camera_code = ? AND stream = ? AND active = 1 LIMIT 1",
    cameraCode,
    stream,
  );
  return row ? rowToCalibration(row) : undefined;
}

export function getCalibrationById(db: AstroLiveDb, id: number): CalibrationBinding | undefined {
  const row = db.get<Record<string, unknown>>("SELECT * FROM calibration WHERE id = ? LIMIT 1", id);
  return row ? rowToCalibration(row) : undefined;
}

function rowToCalibration(row: Record<string, unknown>): CalibrationBinding {
  return {
    id: Number(row.id),
    cameraCode: String(row.camera_code),
    stream: String(row.stream) as CalibrationStream,
    plateparPath: String(row.platepar_path),
    originalPath: row.original_path ? String(row.original_path) : undefined,
    sha256: String(row.sha256),
    active: Number(row.active) !== 0,
    summary: JSON.parse(String(row.summary_json)) as PlateparSummary,
  };
}
