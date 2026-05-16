import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { AstroLiveDb } from "../upload-store/db.js";
import { defaultDataDir, ensureDir } from "../shared/paths.js";
import { writeJsonFile } from "../shared/json.js";
import { UserError } from "../shared/errors.js";
import { EventPackageInput, UploadQueueRow } from "../shared/types.js";
import { FileSecretStore } from "../cloud-profile/secret-store.js";
import { bindCloudCamera, getBinding, getProfile, importCloudProfile } from "../cloud-profile/profile.js";
import { queryProfileStatus } from "../cloud-client/device-api.js";
import { resolveEventPackage } from "../event-contract/validate.js";
import { buildUploadPackage } from "../cloud-package/package-builder.js";
import { insertQueueFromUploadPackage, rowToUpload } from "../upload-store/queue.js";
import { runWorkerOnce } from "../upload-worker/worker.js";

const SOFTWARE_VERSION = "0.1.0";
const PORT = Number(process.env.METEOR_ASTRO_LIVE_API_PORT ?? 5174);
const DATA_DIR = path.resolve(process.env.METEOR_ASTRO_LIVE_DATA_DIR ?? defaultDataDir());

type JsonRecord = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "http://127.0.0.1:5173",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error instanceof UserError ? 400 : 500;
  sendJson(res, status, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "")));
  });
}

async function readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
  const text = await readBody(req);
  return text ? (JSON.parse(text) as JsonRecord) : {};
}

async function readFormData(req: IncomingMessage): Promise<FormData> {
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  const init = {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req,
    duplex: "half",
  } as unknown as RequestInit & { duplex: "half" };
  const request = new Request(`http://${host}${req.url ?? "/"}`, init);
  return request.formData();
}

function stringValue(body: JsonRecord, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(body: JsonRecord, key: string, fallback = false): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "event";
}

function localPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(value);
}

function queueDto(row: UploadQueueRow): JsonRecord {
  return {
    id: row.id,
    localEventId: row.localEventId,
    cameraCode: row.cameraCode,
    eventTimeUtc: row.eventTimeUtc,
    status: row.status,
    attempts: row.attempts,
    updatedAt: row.completedAt ?? row.uploadedAt ?? row.lastAttemptAt ?? row.nextRetryAt ?? "",
    remoteUploadUid: row.remoteUploadUid ?? "",
    remoteJobUid: row.remoteJobUid ?? "",
    remoteJobStatus: row.remoteJobStatus ?? "",
    errorCode: row.errorCode ?? "",
    errorMessage: row.errorMessage ?? "",
    packageDir: row.packageDir,
  };
}

function listQueue(db: AstroLiveDb): JsonRecord[] {
  return db
    .all<Record<string, unknown>>("SELECT * FROM upload_queue ORDER BY updated_at DESC, id DESC LIMIT 100")
    .map(rowToUpload)
    .map(queueDto);
}

async function withDb<T>(fn: (ctx: { db: AstroLiveDb; secretStore: FileSecretStore }) => Promise<T>): Promise<T> {
  await ensureDir(DATA_DIR);
  const db = await AstroLiveDb.open(DATA_DIR);
  try {
    return await fn({ db, secretStore: new FileSecretStore(DATA_DIR) });
  } finally {
    db.close();
  }
}

async function saveFileField(form: FormData, key: string, dir: string): Promise<string> {
  const value = form.get(key);
  if (!value || typeof value === "string" || typeof (value as File).arrayBuffer !== "function") {
    return "";
  }
  const file = value as File;
  if (file.size <= 0) {
    return "";
  }
  const target = path.join(dir, path.basename(file.name));
  await writeFile(target, Buffer.from(await file.arrayBuffer()));
  return target;
}

async function packageEvent(input: {
  db: AstroLiveDb;
  event: EventPackageInput;
  eventFilePath: string;
}): Promise<{ package: unknown; queue: JsonRecord[] }> {
  await writeJsonFile(input.eventFilePath, input.event);
  const event = await resolveEventPackage({ db: input.db, filePath: input.eventFilePath });
  const binding = getBinding(input.db, event.cameraCode);
  if (!binding?.enabled) {
    throw new UserError(`camera ${event.cameraCode} has no enabled cloud binding`);
  }
  const profile = getProfile(input.db, binding.profileId);
  if (!profile) {
    throw new UserError(`profile ${binding.profileId} not found`);
  }
  const pkg = await buildUploadPackage({ event, profile, binding, softwareVersion: SOFTWARE_VERSION });
  insertQueueFromUploadPackage({
    db: input.db,
    pkg,
    cameraCode: event.cameraCode,
    eventTimeUtc: event.eventTimeUtc,
    packageDir: path.dirname(pkg.manifestPath),
  });
  return { package: pkg, queue: listQueue(input.db) };
}

async function handleProfileImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const filePath = stringValue(body, "filePath");
  const bindCameraCode = stringValue(body, "bindCameraCode");
  const enableBinding = boolValue(body, "enableBinding", true);
  if (!filePath) {
    throw new UserError("profile filePath is required");
  }
  const result = await withDb(async ({ db, secretStore }) => {
    const profile = await importCloudProfile({
      db,
      secretStore,
      filePath: localPath(filePath),
      bindCameraCode: bindCameraCode || undefined,
      enableBinding,
    });
    if (!bindCameraCode && profile.cameraCode) {
      bindCloudCamera(db, {
        cameraCode: profile.cameraCode,
        profileId: profile.id,
        enabled: enableBinding,
        stationUid: profile.stationUid,
        stationCode: profile.stationCode,
        cameraUid: profile.cameraUid,
        remoteCameraCode: profile.cameraCode,
      });
    }
    return { profile, queue: listQueue(db) };
  });
  sendJson(res, 200, { ok: true, ...result });
}

async function handleProfileStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const cameraCode = stringValue(body, "cameraCode");
  if (!cameraCode) {
    throw new UserError("cameraCode is required");
  }
  const result = await withDb(async ({ db, secretStore }) => {
    const binding = getBinding(db, cameraCode);
    if (!binding?.enabled) {
      throw new UserError(`camera ${cameraCode} has no enabled cloud binding`);
    }
    const profile = getProfile(db, binding.profileId);
    if (!profile) {
      throw new UserError(`profile ${binding.profileId} not found`);
    }
    const secret = await secretStore.getSecret(profile.deviceSecretRef);
    return queryProfileStatus({ profile, deviceSecret: secret });
  });
  sendJson(res, 200, { ok: true, result });
}

async function handlePackagePaths(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const localEventId = stringValue(body, "localEventId");
  const eventTimeUtc = stringValue(body, "eventTimeUtc");
  const cameraCode = stringValue(body, "cameraCode");
  const ecsvPath = stringValue(body, "ecsvPath");
  if (!localEventId || !eventTimeUtc || !cameraCode || !ecsvPath) {
    throw new UserError("localEventId, eventTimeUtc, cameraCode and ecsvPath are required");
  }
  const eventDir = path.join(DATA_DIR, "events", safeSegment(localEventId));
  await ensureDir(eventDir);
  const outputDir = stringValue(body, "outputDir") || path.join(eventDir, "output");
  const event: EventPackageInput = {
    schema: "meteor_astro_event_v1",
    local_event_id: localEventId,
    event_time_utc: eventTimeUtc,
    station_code: stringValue(body, "stationCode") || undefined,
    camera_code: cameraCode,
    ecsv_path: localPath(ecsvPath),
    video_path: stringValue(body, "videoPath") ? localPath(stringValue(body, "videoPath")) : undefined,
    preview_path: stringValue(body, "previewPath") ? localPath(stringValue(body, "previewPath")) : undefined,
    output_dir: localPath(outputDir),
  };
  const result = await withDb(({ db }) => packageEvent({ db, event, eventFilePath: path.join(eventDir, "event-package.json") }));
  sendJson(res, 200, { ok: true, ...result });
}

async function handlePackageFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readFormData(req);
  const localEventId = String(form.get("localEventId") ?? "").trim();
  const eventTimeUtc = String(form.get("eventTimeUtc") ?? "").trim();
  const cameraCode = String(form.get("cameraCode") ?? "").trim();
  const stationCode = String(form.get("stationCode") ?? "").trim();
  if (!localEventId || !eventTimeUtc || !cameraCode) {
    throw new UserError("localEventId, eventTimeUtc and cameraCode are required");
  }
  const eventDir = path.join(DATA_DIR, "events", safeSegment(localEventId));
  const sourceDir = path.join(eventDir, "source");
  await ensureDir(sourceDir);
  const ecsvPath = await saveFileField(form, "ecsv", sourceDir);
  const videoPath = await saveFileField(form, "video", sourceDir);
  const previewPath = await saveFileField(form, "preview", sourceDir);
  if (!ecsvPath) {
    throw new UserError("ECSV file is required");
  }
  const event: EventPackageInput = {
    schema: "meteor_astro_event_v1",
    local_event_id: localEventId,
    event_time_utc: eventTimeUtc,
    station_code: stationCode || undefined,
    camera_code: cameraCode,
    ecsv_path: ecsvPath,
    video_path: videoPath || undefined,
    preview_path: previewPath || undefined,
    output_dir: path.join(eventDir, "output"),
  };
  const result = await withDb(({ db }) => packageEvent({ db, event, eventFilePath: path.join(eventDir, "event-package.json") }));
  sendJson(res, 200, { ok: true, ...result });
}

async function handleWorkerRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const limit = Number(body.limit ?? 1);
  const result = await withDb(async ({ db, secretStore }) => {
    const worker = await runWorkerOnce({ db, secretStore, limit: Number.isFinite(limit) ? limit : 1 });
    return { worker, queue: listQueue(db) };
  });
  sendJson(res, 200, { ok: true, ...result });
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, dataDir: DATA_DIR });
    } else if (req.method === "GET" && url.pathname === "/api/queue") {
      const queue = await withDb(({ db }) => Promise.resolve(listQueue(db)));
      sendJson(res, 200, { ok: true, queue });
    } else if (req.method === "POST" && url.pathname === "/api/profile/import") {
      await handleProfileImport(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/profile/status") {
      await handleProfileStatus(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/event/package-paths") {
      await handlePackagePaths(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/event/package-files") {
      await handlePackageFiles(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/worker/run") {
      await handleWorkerRun(req, res);
    } else {
      sendJson(res, 404, { ok: false, error: "not found" });
    }
  })().catch((error) => sendError(res, error));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MeteorAstroLive API listening on http://127.0.0.1:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
