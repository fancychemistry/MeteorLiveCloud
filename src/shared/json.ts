import { readFile, writeFile } from "node:fs/promises";
import { JsonObject } from "./types.js";

export async function readJsonFile<T = JsonObject>(filePath: string): Promise<T> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function asRecord(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

export function stringField(record: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

export function numberField(record: JsonObject, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function boolField(record: JsonObject, key: string, fallback = false): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

export function numberArrayField(record: JsonObject, key: string): number[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
}
