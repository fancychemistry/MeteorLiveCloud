import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "../shared/paths.js";

export class AstroLiveDb {
  readonly db: DatabaseSync;

  private constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  static async open(dataDir: string): Promise<AstroLiveDb> {
    await ensureDir(dataDir);
    const dbPath = path.join(dataDir, "meteor-astro-live.sqlite");
    const store = new AstroLiveDb(dbPath);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calibration (
        id INTEGER PRIMARY KEY,
        camera_code TEXT NOT NULL,
        stream TEXT NOT NULL,
        platepar_path TEXT NOT NULL,
        original_path TEXT,
        sha256 TEXT NOT NULL,
        station_code TEXT,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_tool TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_active
      ON calibration(camera_code, stream, active)
      WHERE active = 1;

      CREATE TABLE IF NOT EXISTS cloud_profile (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'default',
        active INTEGER NOT NULL DEFAULT 1,
        profile_version INTEGER NOT NULL DEFAULT 0,
        config_version INTEGER NOT NULL DEFAULT 0,
        api_base TEXT NOT NULL,
        api_prefix TEXT NOT NULL,
        device_api_path TEXT NOT NULL,
        station_uid TEXT NOT NULL,
        station_code TEXT,
        camera_uid TEXT NOT NULL,
        camera_code TEXT,
        device_key_id TEXT NOT NULL UNIQUE,
        device_secret_ref TEXT NOT NULL,
        upload_policy_json TEXT,
        status TEXT,
        issued_at TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_status_at TEXT,
        last_status_message TEXT,
        daily_quota_gb REAL,
        remaining_quota_bytes INTEGER
      );

      CREATE TABLE IF NOT EXISTS cloud_camera_binding (
        camera_code TEXT PRIMARY KEY,
        profile_id INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        station_uid TEXT,
        station_code TEXT,
        camera_uid TEXT,
        camera_code_remote TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message TEXT,
        FOREIGN KEY(profile_id) REFERENCES cloud_profile(id)
      );

      CREATE TABLE IF NOT EXISTS event_package (
        id INTEGER PRIMARY KEY,
        local_event_id TEXT NOT NULL UNIQUE,
        schema_version TEXT NOT NULL,
        camera_code TEXT NOT NULL,
        event_time_utc TEXT NOT NULL,
        source_event_json TEXT NOT NULL,
        calibration_id INTEGER,
        calibration_sha256 TEXT,
        manual_points_path TEXT,
        manual_points_sha256 TEXT,
        ecsv_path TEXT,
        media_path TEXT,
        preview_path TEXT,
        output_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS upload_queue (
        id INTEGER PRIMARY KEY,
        local_event_id TEXT NOT NULL UNIQUE,
        camera_code TEXT NOT NULL,
        event_time_utc TEXT NOT NULL,
        package_dir TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        ecsv_path TEXT NOT NULL,
        media_path TEXT,
        preview_path TEXT,
        manifest_sha256 TEXT NOT NULL,
        ecsv_sha256 TEXT NOT NULL,
        media_sha256 TEXT NOT NULL DEFAULT '-',
        preview_sha256 TEXT NOT NULL DEFAULT '-',
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        last_attempt_at TEXT,
        uploaded_at TEXT,
        completed_at TEXT,
        remote_upload_uid TEXT,
        remote_job_uid TEXT,
        remote_job_status TEXT,
        error_code TEXT,
        error_message TEXT,
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  get<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }
}
