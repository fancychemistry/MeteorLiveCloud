import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ensureDir } from "../shared/paths.js";

export interface SecretStore {
  putSecret(label: string, secret: string): Promise<string>;
  getSecret(ref: string): Promise<string>;
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly dataDir: string) {}

  async putSecret(label: string, secret: string): Promise<string> {
    const secretsDir = path.join(this.dataDir, "secrets");
    await ensureDir(secretsDir);
    const id = createHash("sha256").update(label).digest("hex").slice(0, 24);
    const ref = `file-secret:${id}`;
    const payload = {
      label,
      value_base64: Buffer.from(secret, "utf8").toString("base64"),
      created_at: new Date().toISOString(),
    };
    await writeFile(path.join(secretsDir, `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return ref;
  }

  async getSecret(ref: string): Promise<string> {
    if (!ref.startsWith("file-secret:")) {
      throw new Error(`Unsupported secret reference: ${ref}`);
    }
    const id = ref.slice("file-secret:".length);
    const text = await readFile(path.join(this.dataDir, "secrets", `${id}.json`), "utf8");
    const payload = JSON.parse(text) as { value_base64?: string };
    if (!payload.value_base64) {
      throw new Error(`Secret ${ref} is missing value`);
    }
    return Buffer.from(payload.value_base64, "base64").toString("utf8");
  }
}
