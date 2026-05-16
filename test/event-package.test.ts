import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveEventPackage } from "../src/event-contract/validate.js";

test("resolveEventPackage accepts existing ECSV-only event", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mal-event-"));
  const ecsv = path.join(dir, "event.ecsv");
  await writeFile(ecsv, "# test\n", "utf8");
  const eventPath = path.join(dir, "event-package.json");
  await writeFile(
    eventPath,
    JSON.stringify(
      {
        schema: "meteor_astro_event_v1",
        local_event_id: "CAM01_20260516_203001",
        event_time_utc: "2026-05-16T12:30:01Z",
        station_code: "CN0001",
        camera_code: "CAM01",
        ecsv_path: "event.ecsv",
        output_dir: "out",
      },
      null,
      2,
    ),
    "utf8",
  );
  const resolved = await resolveEventPackage({ filePath: eventPath });
  assert.equal(resolved.localEventId, "CAM01_20260516_203001");
  assert.equal(resolved.ecsvPath, ecsv);
  assert.equal(resolved.outputDir, path.join(dir, "out"));
});
