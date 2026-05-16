export function nowIso(): string {
  return new Date().toISOString();
}

export function compactIsoForPath(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function isIsoUtc(value: string): boolean {
  if (!value.endsWith("Z")) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function addSecondsIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
