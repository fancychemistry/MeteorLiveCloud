import path from "node:path";
import { access } from "node:fs/promises";
import { readJsonFile, asRecord, stringField } from "../shared/json.js";
import { assertUser } from "../shared/errors.js";
import { resolveMaybeRelative } from "../shared/paths.js";
import { isIsoUtc } from "../shared/time.js";
import { EventPackageInput, ResolvedEventPackage } from "../shared/types.js";
import { AstroLiveDb } from "../upload-store/db.js";
import { getActiveCalibration, getCalibrationById } from "../manual-calibration/platepar.js";

async function pathExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readEventPackage(filePath: string): Promise<EventPackageInput> {
  const record = asRecord(await readJsonFile(filePath), "event package");
  assertUser(record.schema === "meteor_astro_event_v1", "event package schema must be meteor_astro_event_v1");
  const localEventId = stringField(record, "local_event_id");
  const eventTimeUtc = stringField(record, "event_time_utc");
  const cameraCode = stringField(record, "camera_code");
  const outputDir = stringField(record, "output_dir");
  assertUser(localEventId, "event package local_event_id is required");
  assertUser(eventTimeUtc && isIsoUtc(eventTimeUtc), "event package event_time_utc must be an ISO UTC timestamp ending in Z");
  assertUser(cameraCode, "event package camera_code is required");
  assertUser(outputDir, "event package output_dir is required");
  return record as unknown as EventPackageInput;
}

export async function resolveEventPackage(input: {
  db?: AstroLiveDb;
  filePath: string;
}): Promise<ResolvedEventPackage> {
  const event = await readEventPackage(input.filePath);
  const baseDir = path.dirname(input.filePath);
  const stream = event.stream ?? "main";
  const explicitCalPath = resolveMaybeRelative(baseDir, event.platepar_path);
  const calibration = input.db
    ? event.calibration_id
      ? getCalibrationById(input.db, event.calibration_id)
      : explicitCalPath
        ? undefined
        : getActiveCalibration(input.db, event.camera_code, stream)
    : undefined;

  const ecsvPath = resolveMaybeRelative(baseDir, event.ecsv_path);
  const videoPath = resolveMaybeRelative(baseDir, event.video_path);
  const previewPath = resolveMaybeRelative(baseDir, event.preview_path);
  const manualPointsPath = resolveMaybeRelative(baseDir, event.manual_points_path);
  assertUser(
    ecsvPath || (videoPath && (explicitCalPath || calibration) && manualPointsPath),
    "event package needs either ecsv_path or video + CAL + manual_points_path",
  );
  if (ecsvPath) {
    assertUser(await pathExists(ecsvPath), `ECSV does not exist: ${ecsvPath}`);
  }
  if (videoPath) {
    assertUser(await pathExists(videoPath), `video does not exist: ${videoPath}`);
  }
  if (previewPath) {
    assertUser(await pathExists(previewPath), `preview does not exist: ${previewPath}`);
  }
  if (manualPointsPath) {
    assertUser(await pathExists(manualPointsPath), `manual points file does not exist: ${manualPointsPath}`);
  }

  return {
    schemaVersion: event.schema,
    localEventId: event.local_event_id,
    eventTimeUtc: event.event_time_utc,
    stationCode: event.station_code ?? calibration?.summary.stationCode ?? "",
    cameraCode: event.camera_code,
    videoPath,
    ecsvPath,
    previewPath,
    manualPointsPath,
    outputDir: resolveMaybeRelative(baseDir, event.output_dir) ?? event.output_dir,
    stream,
    calibration,
  };
}
