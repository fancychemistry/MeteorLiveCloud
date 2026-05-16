import { runFfmpeg } from "./ffmpeg.js";

export async function makePreview(input: {
  videoPath: string;
  outputPath: string;
  timeSeconds?: number;
  ffmpegPath?: string;
}): Promise<void> {
  await runFfmpeg(
    [
      "-hide_banner",
      "-ss",
      String(input.timeSeconds ?? 0),
      "-i",
      input.videoPath,
      "-frames:v",
      "1",
      "-y",
      input.outputPath,
    ],
    input.ffmpegPath,
  );
}
