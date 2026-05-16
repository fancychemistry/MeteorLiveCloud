import { spawn } from "node:child_process";
import path from "node:path";
import { ensureDir } from "../shared/paths.js";

export async function runExternalReduction(input: {
  executable: string;
  videoPath: string;
  calPath: string;
  pointsPath: string;
  outputEcsvPath: string;
  eventTimeUtc: string;
  fps?: number;
}): Promise<void> {
  await ensureDir(path.dirname(input.outputEcsvPath));
  const args = [
    "--video",
    input.videoPath,
    "--cal",
    input.calPath,
    "--points",
    input.pointsPath,
    "--out",
    input.outputEcsvPath,
    "--event-time-utc",
    input.eventTimeUtc,
  ];
  if (input.fps) {
    args.push("--fps", String(input.fps));
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.executable, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`external reduction failed with exit code ${code}`));
      }
    });
  });
}
