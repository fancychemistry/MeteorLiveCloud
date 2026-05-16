import { CloudCameraBinding, CloudProfile, ResolvedEventPackage } from "../shared/types.js";

export function buildManifest(input: {
  event: ResolvedEventPackage;
  profile: CloudProfile;
  binding: CloudCameraBinding;
  fileInfo: {
    ecsvSha256: string;
    ecsvBytes: number;
    mediaSha256: string;
    mediaBytes: number;
    previewSha256: string;
    previewBytes: number;
  };
  softwareVersion: string;
  reductionMode: "existing_ecsv" | "external_adapter" | "pure_js_ecsv";
}): Record<string, unknown> {
  const stationUid = input.binding.stationUid || input.profile.stationUid;
  const stationCode = input.binding.stationCode || input.profile.stationCode || input.event.stationCode;
  const cameraUid = input.binding.cameraUid || input.profile.cameraUid;
  const cameraCode = input.binding.remoteCameraCode || input.profile.cameraCode || input.event.cameraCode;
  return {
    event_time_utc: input.event.eventTimeUtc,
    station_uid: stationUid,
    station_code: stationCode,
    camera_uid: cameraUid,
    camera_code: cameraCode,
    local_event_id: input.event.localEventId,
    software_name: "MeteorAstroLive",
    software_version: input.softwareVersion,
    files: {
      ecsv: {
        sha256: input.fileInfo.ecsvSha256,
        size_bytes: input.fileInfo.ecsvBytes,
      },
      media: {
        sha256: input.fileInfo.mediaSha256,
        size_bytes: input.fileInfo.mediaBytes,
      },
      preview: {
        sha256: input.fileInfo.previewSha256,
        size_bytes: input.fileInfo.previewBytes,
      },
    },
    vendor: {
      source: "MeteorAstroLive",
      event_package_schema: input.event.schemaVersion,
      calibration_sha256: input.event.calibration?.sha256 ?? "",
      calibration_camera_code: input.event.calibration?.cameraCode ?? "",
      reduction_mode: input.reductionMode,
    },
  };
}
