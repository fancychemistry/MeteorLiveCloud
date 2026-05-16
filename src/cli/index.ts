#!/usr/bin/env node
import path from "node:path";
import { AstroLiveDb } from "../upload-store/db.js";
import { defaultDataDir, ensureDir } from "../shared/paths.js";
import { UserError } from "../shared/errors.js";
import { importCalibration, activateCalibration, getActiveCalibration } from "../manual-calibration/platepar.js";
import { importCloudProfile, bindCloudCamera, getBinding, getProfile } from "../cloud-profile/profile.js";
import { FileSecretStore } from "../cloud-profile/secret-store.js";
import { queryProfileStatus } from "../cloud-client/device-api.js";
import { resolveEventPackage } from "../event-contract/validate.js";
import { buildUploadPackage } from "../cloud-package/package-builder.js";
import { enqueuePackage, insertQueueFromUploadPackage } from "../upload-store/queue.js";
import { runWorkerOnce } from "../upload-worker/worker.js";
import { CalibrationStream } from "../shared/types.js";

const SOFTWARE_VERSION = "0.1.0";

type Options = Record<string, string | boolean>;

function parseOptions(args: string[]): Options {
  const out: Options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function required(options: Options, key: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new UserError(`--${key} is required`);
  }
  return value;
}

function optionalString(options: Options, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function flag(options: Options, key: string): boolean {
  return options[key] === true || options[key] === "true";
}

async function withDb<T>(options: Options, fn: (ctx: {
  db: AstroLiveDb;
  dataDir: string;
  secretStore: FileSecretStore;
}) => T | Promise<T>): Promise<T> {
  const dataDir = path.resolve(optionalString(options, "data-dir") ?? defaultDataDir());
  await ensureDir(dataDir);
  const db = await AstroLiveDb.open(dataDir);
  try {
    return await fn({ db, dataDir, secretStore: new FileSecretStore(dataDir) });
  } finally {
    db.close();
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(argv: string[]): Promise<void> {
  const domain = argv[0];
  const actionCandidate = argv[1];
  const action = actionCandidate && !actionCandidate.startsWith("--") ? actionCandidate : undefined;
  const rest = action ? argv.slice(2) : argv.slice(1);
  const options = parseOptions(rest);
  if (!domain || domain === "help" || domain === "--help") {
    printHelp();
    return;
  }

  if (domain === "profile" && action === "import") {
    const result = await withDb(options, ({ db, secretStore }) =>
      importCloudProfile({
        db,
        secretStore,
        filePath: path.resolve(required(options, "file")),
        bindCameraCode: optionalString(options, "bind-camera"),
        enableBinding: flag(options, "enable"),
      }),
    );
    printJson({ ok: true, profile: result });
    return;
  }

  if (domain === "profile" && action === "bind") {
    await withDb(options, async ({ db }) => {
      const cameraCode = required(options, "camera");
      const profileId = Number(required(options, "profile-id"));
      const profile = getProfile(db, profileId);
      if (!profile) {
        throw new UserError(`profile ${profileId} not found`);
      }
      bindCloudCamera(db, {
        cameraCode,
        profileId,
        enabled: flag(options, "enable"),
        stationUid: profile.stationUid,
        stationCode: profile.stationCode,
        cameraUid: profile.cameraUid,
        remoteCameraCode: profile.cameraCode,
      });
      printJson({ ok: true, binding: getBinding(db, cameraCode) });
    });
    return;
  }

  if (domain === "profile" && action === "status") {
    await withDb(options, async ({ db, secretStore }) => {
      const cameraCode = required(options, "camera");
      const binding = getBinding(db, cameraCode);
      if (!binding?.enabled) {
        throw new UserError(`camera ${cameraCode} has no enabled cloud binding`);
      }
      const profile = getProfile(db, binding.profileId);
      if (!profile) {
        throw new UserError(`profile ${binding.profileId} not found`);
      }
      const secret = await secretStore.getSecret(profile.deviceSecretRef);
      printJson(await queryProfileStatus({ profile, deviceSecret: secret }));
    });
    return;
  }

  if (domain === "cal" && action === "import") {
    const result = await withDb(options, ({ db, dataDir }) =>
      importCalibration({
        db,
        dataDir,
        cameraCode: required(options, "camera"),
        stream: (optionalString(options, "stream") ?? "main") as CalibrationStream,
        filePath: path.resolve(required(options, "file")),
        activate: flag(options, "activate"),
        sourceTool: optionalString(options, "source-tool"),
        notes: optionalString(options, "notes"),
      }),
    );
    printJson({ ok: true, calibration: result });
    return;
  }

  if (domain === "cal" && action === "bind") {
    const result = await withDb(options, ({ db }) => activateCalibration(db, Number(required(options, "cal-id"))));
    printJson({ ok: true, calibration: result });
    return;
  }

  if (domain === "cal" && action === "inspect") {
    await withDb(options, async ({ db }) => {
      const calibration = getActiveCalibration(
        db,
        required(options, "camera"),
        (optionalString(options, "stream") ?? "main") as CalibrationStream,
      );
      if (!calibration) {
        throw new UserError("active calibration not found");
      }
      printJson({ ok: true, calibration });
    });
    return;
  }

  if (domain === "package" && action === undefined) {
    await withDb(options, async ({ db }) => {
      const event = await resolveEventPackage({ db, filePath: path.resolve(required(options, "event")) });
      const binding = getBinding(db, event.cameraCode);
      if (!binding?.enabled) {
        throw new UserError(`camera ${event.cameraCode} has no enabled cloud binding`);
      }
      const profile = getProfile(db, binding.profileId);
      if (!profile) {
        throw new UserError(`profile ${binding.profileId} not found`);
      }
      const pkg = await buildUploadPackage({ event, profile, binding, softwareVersion: SOFTWARE_VERSION });
      const row = insertQueueFromUploadPackage({
        db,
        pkg,
        cameraCode: event.cameraCode,
        eventTimeUtc: event.eventTimeUtc,
        packageDir: path.dirname(pkg.manifestPath),
      });
      printJson({ ok: true, package: pkg, queue: row });
    });
    return;
  }

  if (domain === "enqueue" && action === undefined) {
    const result = await withDb(options, ({ db }) =>
      enqueuePackage({ db, packageDir: path.resolve(required(options, "package")), replace: flag(options, "replace") }),
    );
    printJson({ ok: true, queue: result });
    return;
  }

  if (domain === "worker" && action === "run") {
    const result = await withDb(options, ({ db, secretStore }) =>
      runWorkerOnce({ db, secretStore, limit: Number(optionalString(options, "limit") ?? 5) }),
    );
    printJson({ ok: true, ...result });
    return;
  }

  throw new UserError(`Unknown command: ${[domain, action].filter(Boolean).join(" ")}`);
}

function printHelp(): void {
  console.log(`MeteorAstroLive CLI

Commands:
  profile import --file cloud_profile.json [--bind-camera CAM01 --enable]
  profile bind --camera CAM01 --profile-id 1 [--enable]
  profile status --camera CAM01
  cal import --camera CAM01 --stream main --file camera.cal [--activate]
  cal inspect --camera CAM01 [--stream main]
  cal bind --cal-id 1
  package --event event-package.json
  enqueue --package output/.../package [--replace]
  worker run [--limit 5]

Common:
  --data-dir data
`);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ ok: false, error: message });
  process.exitCode = error instanceof UserError ? 2 : 1;
});
