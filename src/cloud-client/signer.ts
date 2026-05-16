import { createHmac, randomUUID } from "node:crypto";
import { CloudHashes, CloudProfile } from "../shared/types.js";

export interface CanonicalInput {
  method: "GET" | "POST";
  urlPath: string;
  timestamp: string;
  nonce: string;
  manifestSha: string;
  ecsvSha: string;
  mediaSha: string;
  previewSha: string;
}

export interface SignedRequestHeaders {
  authorization: string;
  timestamp: string;
  nonce: string;
  headers: Record<string, string>;
}

export function buildCanonical(input: CanonicalInput): string {
  return [
    input.method,
    input.urlPath,
    input.timestamp,
    input.nonce,
    input.manifestSha,
    input.ecsvSha,
    input.mediaSha,
    input.previewSha,
  ].join("\n");
}

export function hmacSha256Base64(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("base64");
}

export function signDeviceRequest(input: {
  profile: CloudProfile;
  deviceSecret: string;
  method: "GET" | "POST";
  urlPath: string;
  hashes?: Partial<CloudHashes>;
  timestamp?: string;
  nonce?: string;
}): SignedRequestHeaders {
  const manifestSha = input.hashes?.manifestSha256 ?? "-";
  const ecsvSha = input.hashes?.ecsvSha256 ?? "-";
  const mediaSha = input.hashes?.mediaSha256 ?? "-";
  const previewSha = input.hashes?.previewSha256 ?? "-";
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = input.nonce ?? randomUUID();
  const canonical = buildCanonical({
    method: input.method,
    urlPath: input.urlPath,
    timestamp,
    nonce,
    manifestSha,
    ecsvSha,
    mediaSha,
    previewSha,
  });
  const signature = hmacSha256Base64(input.deviceSecret, canonical);
  const authorization = `MeteorCloud ${input.profile.deviceKeyId}:${signature}`;
  return {
    authorization,
    timestamp,
    nonce,
    headers: {
      Authorization: authorization,
      "X-Device-Key-Id": input.profile.deviceKeyId,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Manifest-SHA256": manifestSha,
      "X-Ecsv-SHA256": ecsvSha,
      "X-Media-SHA256": mediaSha,
      "X-Preview-SHA256": previewSha,
    },
  };
}
