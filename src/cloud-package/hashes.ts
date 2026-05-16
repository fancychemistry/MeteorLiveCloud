import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function sha256FileHex(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function sha256TextHex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function fileSizeBytes(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}
