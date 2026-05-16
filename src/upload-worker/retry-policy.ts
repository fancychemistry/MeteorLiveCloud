import { addSecondsIso, nowIso } from "../shared/time.js";

export function nextRetryIso(attempts: number, now = nowIso()): string {
  if (attempts <= 1) {
    return addSecondsIso(now, 5 * 60);
  }
  if (attempts === 2) {
    return addSecondsIso(now, 15 * 60);
  }
  if (attempts === 3) {
    return addSecondsIso(now, 60 * 60);
  }
  return addSecondsIso(now, 6 * 60 * 60);
}
