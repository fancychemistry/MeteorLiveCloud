import { readFile } from "node:fs/promises";
import { uploadEventPackage, pollRemoteJob, classifyCloudFailure } from "../cloud-client/device-api.js";
import { getBinding, getProfile } from "../cloud-profile/profile.js";
import { SecretStore } from "../cloud-profile/secret-store.js";
import { nowIso } from "../shared/time.js";
import { assertUser } from "../shared/errors.js";
import { UploadPackage } from "../shared/types.js";
import { AstroLiveDb } from "../upload-store/db.js";
import { getPollingUploads, getRunnableUploads, updateUploadStatus } from "../upload-store/queue.js";
import { nextRetryIso } from "./retry-policy.js";

export async function runWorkerOnce(input: {
  db: AstroLiveDb;
  secretStore: SecretStore;
  limit?: number;
}): Promise<{ uploaded: number; polled: number }> {
  let uploaded = 0;
  for (const row of getRunnableUploads(input.db, nowIso(), input.limit ?? 5)) {
    const attempts = row.attempts + 1;
    updateUploadStatus(input.db, row.id, "uploading", {
      attempts,
      lastAttemptAt: nowIso(),
    });
    try {
      const binding = getBinding(input.db, row.cameraCode);
      assertUser(binding?.enabled, `camera ${row.cameraCode} is not enabled for upload`);
      const profile = getProfile(input.db, binding.profileId);
      assertUser(profile, `cloud profile ${binding.profileId} not found`);
      const secret = await input.secretStore.getSecret(profile.deviceSecretRef);
      const manifestJson = await readFile(row.manifestPath, "utf8");
      const pkg: UploadPackage = {
        localEventId: row.localEventId,
        manifestJson,
        manifestPath: row.manifestPath,
        ecsvPath: row.ecsvPath,
        mediaPath: row.mediaPath,
        previewPath: row.previewPath,
        hashes: row.hashes,
        sizes: {
          manifestBytes: Buffer.byteLength(manifestJson, "utf8"),
          ecsvBytes: 0,
          mediaBytes: 0,
          previewBytes: 0,
        },
      };
      const result = await uploadEventPackage({ profile, deviceSecret: secret, pkg });
      if (!result.ok || !result.data?.uploadUid || !result.data.jobUid) {
        const status = classifyCloudFailure(result.httpStatus);
        updateUploadStatus(input.db, row.id, status, {
          attempts,
          nextRetryAt: status === "failed_retriable" ? nextRetryIso(attempts) : undefined,
          completedAt: status !== "failed_retriable" ? nowIso() : undefined,
          errorCode: String(result.httpStatus),
          errorMessage: result.error ?? result.msg ?? "upload failed",
          responseJson: result.rawBody,
        });
        continue;
      }
      updateUploadStatus(input.db, row.id, "job_running", {
        attempts,
        uploadedAt: nowIso(),
        nextRetryAt: nextRetryIso(0),
        remoteUploadUid: result.data.uploadUid,
        remoteJobUid: result.data.jobUid,
        remoteJobStatus: result.data.status,
        responseJson: result.rawBody,
      });
      uploaded += 1;
    } catch (error) {
      updateUploadStatus(input.db, row.id, "failed_retriable", {
        attempts,
        nextRetryAt: nextRetryIso(attempts),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let polled = 0;
  for (const row of getPollingUploads(input.db, nowIso(), input.limit ?? 5)) {
    try {
      assertUser(row.remoteJobUid, `upload ${row.id} has no remote job uid`);
      const binding = getBinding(input.db, row.cameraCode);
      assertUser(binding?.enabled, `camera ${row.cameraCode} is not enabled for upload`);
      const profile = getProfile(input.db, binding.profileId);
      assertUser(profile, `cloud profile ${binding.profileId} not found`);
      const secret = await input.secretStore.getSecret(profile.deviceSecretRef);
      const result = await pollRemoteJob({ profile, deviceSecret: secret, jobUid: row.remoteJobUid });
      if (!result.ok || !result.data) {
        updateUploadStatus(input.db, row.id, classifyCloudFailure(result.httpStatus), {
          attempts: row.attempts,
          nextRetryAt: nextRetryIso(row.attempts),
          errorCode: String(result.httpStatus),
          errorMessage: result.error ?? result.msg ?? "poll failed",
          responseJson: result.rawBody,
        });
        continue;
      }
      const jobStatus = result.data.jobStatus;
      if (jobStatus === "succeeded") {
        updateUploadStatus(input.db, row.id, "succeeded", {
          attempts: row.attempts,
          completedAt: nowIso(),
          remoteJobStatus: jobStatus,
          responseJson: result.rawBody,
        });
      } else if (jobStatus === "failed" || jobStatus === "dead") {
        updateUploadStatus(input.db, row.id, "failed_terminal", {
          attempts: row.attempts,
          completedAt: nowIso(),
          remoteJobStatus: jobStatus,
          errorMessage: result.data.reason ?? "",
          responseJson: result.rawBody,
        });
      } else {
        updateUploadStatus(input.db, row.id, "job_running", {
          attempts: row.attempts,
          nextRetryAt: nextRetryIso(0),
          remoteJobStatus: jobStatus,
          responseJson: result.rawBody,
        });
      }
      polled += 1;
    } catch (error) {
      updateUploadStatus(input.db, row.id, "failed_retriable", {
        attempts: row.attempts,
        nextRetryAt: nextRetryIso(row.attempts),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { uploaded, polled };
}
