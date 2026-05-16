import path from "node:path";
import { copyFile, readFile } from "node:fs/promises";
import { assertUser } from "../shared/errors.js";
import { ensureDir } from "../shared/paths.js";
import { writeJsonFile } from "../shared/json.js";
import { CloudCameraBinding, CloudProfile, ResolvedEventPackage, UploadPackage } from "../shared/types.js";
import { fileSizeBytes, sha256FileHex, sha256TextHex } from "./hashes.js";
import { buildManifest } from "./manifest.js";

const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_ECSV_BYTES = 50 * 1024 * 1024;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export async function buildUploadPackage(input: {
  event: ResolvedEventPackage;
  profile: CloudProfile;
  binding: CloudCameraBinding;
  softwareVersion: string;
}): Promise<UploadPackage> {
  assertUser(input.binding.enabled, `camera ${input.event.cameraCode} is not enabled for cloud upload`);
  assertUser(input.event.ecsvPath, "event package must have ecsv_path for MVP packaging");
  const packageDir = path.join(input.event.outputDir, "package");
  await ensureDir(packageDir);

  const ecsvBytes = await fileSizeBytes(input.event.ecsvPath);
  assertUser(ecsvBytes > 0 && ecsvBytes <= MAX_ECSV_BYTES, "ECSV size is invalid or exceeds MeteorLive limit");
  const ecsvPath = path.join(packageDir, path.basename(input.event.ecsvPath));
  await copyFile(input.event.ecsvPath, ecsvPath);
  const ecsvSha256 = await sha256FileHex(ecsvPath);

  let mediaPath: string | undefined;
  let mediaBytes = 0;
  let mediaSha256 = "-";
  if (input.event.videoPath) {
    const size = await fileSizeBytes(input.event.videoPath);
    if (size > 0 && size <= MAX_MEDIA_BYTES) {
      mediaPath = path.join(packageDir, path.basename(input.event.videoPath));
      await copyFile(input.event.videoPath, mediaPath);
      mediaBytes = size;
      mediaSha256 = await sha256FileHex(mediaPath);
    }
  }

  let previewPath: string | undefined;
  let previewBytes = 0;
  let previewSha256 = "-";
  if (input.event.previewPath) {
    const size = await fileSizeBytes(input.event.previewPath);
    if (size > 0 && size <= MAX_PREVIEW_BYTES) {
      previewPath = path.join(packageDir, path.basename(input.event.previewPath));
      await copyFile(input.event.previewPath, previewPath);
      previewBytes = size;
      previewSha256 = await sha256FileHex(previewPath);
    }
  }

  const manifest = buildManifest({
    event: input.event,
    profile: input.profile,
    binding: input.binding,
    fileInfo: { ecsvSha256, ecsvBytes, mediaSha256, mediaBytes, previewSha256, previewBytes },
    softwareVersion: input.softwareVersion,
    reductionMode: "existing_ecsv",
  });
  const manifestJson = JSON.stringify(manifest);
  assertUser(Buffer.byteLength(manifestJson, "utf8") <= MAX_MANIFEST_BYTES, "manifest exceeds MeteorLive limit");
  const manifestPath = path.join(packageDir, "manifest.json");
  await writeJsonFile(manifestPath, manifest);
  const finalManifestJson = await readFile(manifestPath, "utf8");
  const manifestSha256 = sha256TextHex(finalManifestJson);

  const pkg: UploadPackage = {
    localEventId: input.event.localEventId,
    manifestJson: finalManifestJson,
    manifestPath,
    ecsvPath,
    mediaPath,
    previewPath,
    hashes: { manifestSha256, ecsvSha256, mediaSha256, previewSha256 },
    sizes: {
      manifestBytes: Buffer.byteLength(finalManifestJson, "utf8"),
      ecsvBytes,
      mediaBytes,
      previewBytes,
    },
  };
  await writeJsonFile(path.join(packageDir, "package.json"), {
    local_event_id: input.event.localEventId,
    event_time_utc: input.event.eventTimeUtc,
    camera_code: input.event.cameraCode,
    profile_id: input.profile.id,
    cloud_camera_uid: input.binding.cameraUid || input.profile.cameraUid,
    manifest_path: manifestPath,
    ecsv_path: ecsvPath,
    media_path: mediaPath ?? "",
    preview_path: previewPath ?? "",
    hashes: pkg.hashes,
    sizes: pkg.sizes,
  });
  return pkg;
}
