import { readJsonFile, asRecord } from "../shared/json.js";
import { assertUser } from "../shared/errors.js";

export interface ManualPoint {
  frame: number;
  x: number;
  y: number;
}

export interface ManualPointsFile {
  schema: "manual_meteor_points_v1";
  fps: number;
  points: ManualPoint[];
}

export async function readManualPoints(filePath: string): Promise<ManualPointsFile> {
  const root = asRecord(await readJsonFile(filePath), "manual points");
  assertUser(root.schema === "manual_meteor_points_v1", "manual points schema must be manual_meteor_points_v1");
  assertUser(typeof root.fps === "number" && root.fps > 0, "manual points fps must be greater than zero");
  assertUser(Array.isArray(root.points), "manual points file must contain points array");
  const points = root.points.map((entry, index) => {
    const record = asRecord(entry, `manual point ${index}`);
    const frame = Number(record.frame);
    const x = Number(record.x);
    const y = Number(record.y);
    assertUser(Number.isFinite(frame) && frame >= 0, `manual point ${index} frame is invalid`);
    assertUser(Number.isFinite(x), `manual point ${index} x is invalid`);
    assertUser(Number.isFinite(y), `manual point ${index} y is invalid`);
    return { frame, x, y };
  });
  points.sort((a, b) => a.frame - b.frame);
  assertUser(points.length >= 1, "manual points file contains no points");
  return { schema: "manual_meteor_points_v1", fps: root.fps, points };
}
