import { runFfmpeg } from "./ffmpeg.js";

export async function trimMedia(input: {
  videoPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  ffmpegPath?: string;
}): Promise<void> {
  await runFfmpeg(
    [
      "-hide_banner",
      "-ss",
      input.startSeconds.toFixed(3),
      "-i",
      input.videoPath,
      "-t",
      input.durationSeconds.toFixed(3),
      "-c",
      "copy",
      "-y",
      input.outputPath,
    ],
    input.ffmpegPath,
  );
}
