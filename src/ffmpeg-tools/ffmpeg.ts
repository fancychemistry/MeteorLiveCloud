import { spawn } from "node:child_process";

export async function runFfmpeg(args: string[], ffmpegPath = "ffmpeg"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with exit code ${code}`));
      }
    });
  });
}
