import test from "node:test";
import assert from "node:assert/strict";
import { buildCanonical, hmacSha256Base64, signDeviceRequest } from "../src/cloud-client/signer.js";
import { buildDeviceApiPath, buildDeviceApiUrl } from "../src/cloud-client/device-api.js";
import { CloudProfile } from "../src/shared/types.js";

const profile: CloudProfile = {
  id: 1,
  name: "CAM01",
  active: true,
  profileVersion: 2,
  configVersion: 1,
  apiBase: "https://meteorlive.net",
  apiPrefix: "/cloud",
  deviceApiPath: "/device-api/mscloud",
  stationUid: "st_xxx",
  stationCode: "CN0001",
  cameraUid: "cam_xxx",
  cameraCode: "CAM01",
  deviceKeyId: "dk_xxx",
  deviceSecretRef: "test",
};

test("buildDeviceApiUrl and buildDeviceApiPath keep URL path separate", () => {
  assert.equal(buildDeviceApiPath(profile, "/uploads"), "/cloud/device-api/mscloud/uploads");
  assert.equal(
    buildDeviceApiUrl(profile, "/uploads"),
    "https://meteorlive.net/cloud/device-api/mscloud/uploads",
  );
});

test("HMAC sample matches MeteorLive fixed vector", () => {
  const canonical = buildCanonical({
    method: "POST",
    urlPath: "/cloud/device-api/mscloud/uploads",
    timestamp: "1712160000",
    nonce: "550e8400-e29b-41d4-a716-446655440000",
    manifestSha: "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0011223344556677",
    ecsvSha: "e5f6a7b8c9d00112233445566778899aabbccddeeff00112233445566778899",
    mediaSha: "c9d0e1f2a3b4c5d6e7f80112233445566778899aabbccddeeff001122334455",
    previewSha: "-",
  });
  assert.equal(
    hmacSha256Base64("test_device_secret_20260403", canonical),
    "y5CyG1Il8XPajhABZOVqeA4hkr93Cs166Nu+qM5hors=",
  );
});

test("signDeviceRequest fills required headers", () => {
  const signed = signDeviceRequest({
    profile,
    deviceSecret: "test_device_secret_20260403",
    method: "GET",
    urlPath: "/cloud/device-api/mscloud/profile/status",
    timestamp: "1712160000",
    nonce: "550e8400-e29b-41d4-a716-446655440000",
  });
  assert.equal(signed.headers["X-Device-Key-Id"], "dk_xxx");
  assert.equal(signed.headers["X-Manifest-SHA256"], "-");
  assert.match(signed.headers.Authorization, /^MeteorCloud dk_xxx:/);
});
