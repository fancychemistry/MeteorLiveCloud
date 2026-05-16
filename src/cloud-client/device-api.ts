import { readFile } from "node:fs/promises";
import path from "node:path";
import { CloudApiResult, CloudProfile, UploadPackage } from "../shared/types.js";
import { signDeviceRequest } from "./signer.js";

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

export async function uploadEventPackage(input: {
  profile: CloudProfile;
  deviceSecret: string;
  pkg: UploadPackage;
}): Promise<CloudApiResult<{ uploadUid: string; jobUid: string; status: string }>> {
  const url = buildDeviceApiUrl(input.profile, "/uploads");
  const urlPath = buildDeviceApiPath(input.profile, "/uploads");
  const signed = signDeviceRequest({
    profile: input.profile,
    deviceSecret: input.deviceSecret,
    method: "POST",
    urlPath,
    hashes: input.pkg.hashes,
  });
  const form = new FormData();
  form.append("manifest", new Blob([input.pkg.manifestJson], { type: "application/json" }), "manifest.json");
  form.append(
    "ecsv",
    new Blob([await readFile(input.pkg.ecsvPath)], { type: "text/plain" }),
    path.basename(input.pkg.ecsvPath),
  );
  if (input.pkg.mediaPath) {
    form.append(
      "media",
      new Blob([await readFile(input.pkg.mediaPath)], { type: "application/octet-stream" }),
      path.basename(input.pkg.mediaPath),
    );
  }
  if (input.pkg.previewPath) {
    form.append(
      "preview",
      new Blob([await readFile(input.pkg.previewPath)], { type: "image/png" }),
      path.basename(input.pkg.previewPath),
    );
  }
  return parseCloudResponse(
    await fetch(url, {
      method: "POST",
      headers: signed.headers,
      body: form,
    }),
  );
}

export async function pollRemoteJob(input: {
  profile: CloudProfile;
  deviceSecret: string;
  jobUid: string;
}): Promise<
  CloudApiResult<{
    uploadUid: string;
    jobUid: string;
    jobStatus: "queued" | "running" | "succeeded" | "failed" | "dead";
    pipelineEventId?: string | null;
    accepted?: boolean | null;
    reason?: string | null;
  }>
> {
  const suffix = `/jobs/${encodeURIComponent(input.jobUid)}`;
  const url = buildDeviceApiUrl(input.profile, suffix);
  const urlPath = buildDeviceApiPath(input.profile, suffix);
  const signed = signDeviceRequest({
    profile: input.profile,
    deviceSecret: input.deviceSecret,
    method: "GET",
    urlPath,
  });
  return parseCloudResponse(await fetch(url, { method: "GET", headers: signed.headers }));
}

export async function queryProfileStatus(input: {
  profile: CloudProfile;
  deviceSecret: string;
}): Promise<
  CloudApiResult<{
    deviceKeyId: string;
    status: string;
    dailyQuotaGb: number;
    remainingQuotaBytes: number;
    latestConfigVersion: number;
  }>
> {
  const url = buildDeviceApiUrl(input.profile, "/profile/status");
  const urlPath = buildDeviceApiPath(input.profile, "/profile/status");
  const signed = signDeviceRequest({
    profile: input.profile,
    deviceSecret: input.deviceSecret,
    method: "GET",
    urlPath,
  });
  return parseCloudResponse(await fetch(url, { method: "GET", headers: signed.headers }));
}

export function classifyCloudFailure(httpStatus: number): "failed_retriable" | "failed_terminal" | "duplicate" {
  if (httpStatus === 409) {
    return "duplicate";
  }
  if (httpStatus === 429 || httpStatus >= 500 || httpStatus === 0) {
    return "failed_retriable";
  }
  return "failed_terminal";
}
