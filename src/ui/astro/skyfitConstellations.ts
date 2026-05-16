import { plateparScaleArcsecPerPixel, raDecToXY, type SkyfitPlatepar, xyToRaDec } from "./skyfitProjection.js";

const MAX_SEGMENT_ANGULAR_DEG = 10.0;
const SAMPLE_STEP_DEG = 0.2;
const PROJECTED_GAP_PX = 220.0;
const MIN_SEGMENT_VISIBLE_POINTS = 3;
const CONSTELLATION_FOV_MARGIN_DEG = 6.0;
const ENDPOINT_GAP_PX = 5.0;

export interface ConstellationJson {
  constellations?: ConstellationGroup[];
}

export interface ConstellationGroup {
  id: string;
  iau?: string;
  chains?: ConstellationChain[];
}

export interface ConstellationChain {
  style?: string;
  points?: Array<[number, number]>;
}

export interface RenderedConstellationRun {
  id: string;
  constellationId: string;
  points: Array<{ x: number; y: number }>;
}

interface VisibleRun {
  points: Array<{ x: number; y: number }>;
  touchesStart: boolean;
  touchesEnd: boolean;
}

export interface ConstellationRenderStats {
  sourceName: string;
  constellationsSelected: number;
  constellationsDrawn: number;
  renderedSegments: number;
}

export interface RenderedConstellationOverlay {
  runs: RenderedConstellationRun[];
  stats: ConstellationRenderStats;
}

export function projectConstellationGroups(input: {
  groups: ConstellationGroup[];
  platepar: SkyfitPlatepar;
  jd: number;
  displayWidth: number;
  displayHeight: number;
  sourceName?: string;
}): RenderedConstellationOverlay {
  const runs: RenderedConstellationRun[] = [];
  const stats: ConstellationRenderStats = {
    sourceName: input.sourceName ?? "constellation_groups_stellarium_western.json",
    constellationsSelected: 0,
    constellationsDrawn: 0,
    renderedSegments: 0,
  };

  if (!Number.isFinite(input.jd) || input.jd <= 0 || input.platepar.width <= 0 || input.platepar.height <= 0) {
    return { runs, stats };
  }

  const center = correctedCenterDeg(input.platepar, input.jd);
  const gateDeg = computePlateparConstellationGateDeg(input.platepar);
  const scaleX = input.displayWidth / Math.max(1, input.platepar.width);
  const scaleY = input.displayHeight / Math.max(1, input.platepar.height);

  for (const group of input.groups) {
    let groupSelected = false;
    let groupDrawn = false;

    for (const chain of group.chains ?? []) {
      const points = normalizeChainPoints(chain.points ?? []);
      for (let i = 0; i + 1 < points.length; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const angularSep = angularSeparationDeg(a[0], a[1], b[0], b[1]);
        if (angularSep > MAX_SEGMENT_ANGULAR_DEG) {
          continue;
        }

        const pathDeg = greatCirclePathDeg(a[0], a[1], b[0], b[1]);
        if (pathDeg.length < 2) {
          continue;
        }

        const mid = pathDeg[Math.floor(pathDeg.length / 2)];
        const minCenterSep = Math.min(
          angularSeparationDeg(center.raDeg, center.decDeg, a[0], a[1]),
          angularSeparationDeg(center.raDeg, center.decDeg, b[0], b[1]),
          angularSeparationDeg(center.raDeg, center.decDeg, mid[0], mid[1]),
        );
        if (minCenterSep > gateDeg) {
          continue;
        }
        groupSelected = true;

        const visibleRuns: VisibleRun[] = [];
        let currentRun: Array<{ x: number; y: number }> = [];
        let currentStartIndex = -1;
        let currentEndIndex = -1;
        let visiblePoints = 0;

        const flushRun = (touchesEnd: boolean) => {
          if (currentRun.length >= 2) {
            visibleRuns.push({
              points: currentRun,
              touchesStart: currentStartIndex === 0,
              touchesEnd,
            });
          }
          currentRun = [];
          currentStartIndex = -1;
          currentEndIndex = -1;
        };

        for (let pointIndex = 0; pointIndex < pathDeg.length; pointIndex += 1) {
          const pointDeg = pathDeg[pointIndex];
          const projected = raDecToXY(pointDeg[0], pointDeg[1], input.jd, input.platepar);
          if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
            if (currentRun.length > 0) flushRun(false);
            continue;
          }
          if (
            projected.x < 0 ||
            projected.x >= input.platepar.width ||
            projected.y < 0 ||
            projected.y >= input.platepar.height
          ) {
            if (currentRun.length > 0) flushRun(false);
            continue;
          }

          const screen = { x: projected.x * scaleX, y: projected.y * scaleY };
          if (screen.x < 0 || screen.x > input.displayWidth || screen.y < 0 || screen.y > input.displayHeight) {
            if (currentRun.length > 0) flushRun(false);
            continue;
          }

          visiblePoints += 1;
          if (currentRun.length > 0) {
            const dx = screen.x - currentRun[currentRun.length - 1].x;
            const dy = screen.y - currentRun[currentRun.length - 1].y;
            if (dx * dx + dy * dy > PROJECTED_GAP_PX * PROJECTED_GAP_PX) {
              flushRun(false);
            }
          }

          if (currentRun.length === 0) {
            currentStartIndex = pointIndex;
          }
          currentRun.push(screen);
          currentEndIndex = pointIndex;
        }

        if (currentRun.length > 0) {
          flushRun(currentEndIndex === pathDeg.length - 1);
        }
        if (visiblePoints < MIN_SEGMENT_VISIBLE_POINTS) {
          continue;
        }

        for (const run of visibleRuns) {
          const trimmed = trimPolyline(run.points, run.touchesStart ? ENDPOINT_GAP_PX : 0, run.touchesEnd ? ENDPOINT_GAP_PX : 0);
          if (trimmed.length < 2) {
            continue;
          }
          runs.push({
            id: `${group.id || group.iau || "constellation"}-${runs.length}`,
            constellationId: group.iau ?? group.id,
            points: trimmed,
          });
          stats.renderedSegments += 1;
          groupDrawn = true;
        }
      }
    }

    if (groupSelected) {
      stats.constellationsSelected += 1;
    }
    if (groupDrawn) {
      stats.constellationsDrawn += 1;
    }
  }

  return { runs, stats };
}

export function projectSkyPointToDisplay(input: {
  raDeg: number;
  decDeg: number;
  platepar: SkyfitPlatepar;
  jd: number;
  displayWidth: number;
  displayHeight: number;
}): { x: number; y: number } | null {
  const point = raDecToXY(input.raDeg, input.decDeg, input.jd, input.platepar);
  if (!point || point.x < 0 || point.y < 0 || point.x >= input.platepar.width || point.y >= input.platepar.height) {
    return null;
  }
  return {
    x: point.x * (input.displayWidth / Math.max(1, input.platepar.width)),
    y: point.y * (input.displayHeight / Math.max(1, input.platepar.height)),
  };
}

function correctedCenterDeg(platepar: SkyfitPlatepar, jd: number): { raDeg: number; decDeg: number } {
  const center = xyToRaDec(platepar.width * 0.5, platepar.height * 0.5, jd, platepar);
  if (center && Number.isFinite(center.raDeg) && Number.isFinite(center.decDeg)) {
    return center;
  }
  return { raDeg: platepar.raDeg, decDeg: platepar.decDeg };
}

function computePlateparConstellationGateDeg(platepar: SkyfitPlatepar): number {
  let gateDeg = 90.0;
  if (platepar.width > 0 && platepar.height > 0) {
    const halfDiagPx = Math.hypot(platepar.width * 0.5, platepar.height * 0.5);
    gateDeg = (halfDiagPx * plateparScaleArcsecPerPixel(platepar)) / 3600 + CONSTELLATION_FOV_MARGIN_DEG;
  } else if (platepar.fovH > 0 || platepar.fovV > 0) {
    gateDeg = Math.max(platepar.fovH, platepar.fovV) * 0.75 + CONSTELLATION_FOV_MARGIN_DEG;
  }
  return clamp(gateDeg, 10, 95);
}

function normalizeChainPoints(points: Array<[number, number]>): Array<[number, number]> {
  return points
    .filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [normalizeDegrees(point[0]), point[1]]);
}

function trimPolyline(points: Array<{ x: number; y: number }>, startGapPx: number, endGapPx: number): Array<{ x: number; y: number }> {
  if (points.length < 2) return [];
  const lengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const length = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (!Number.isFinite(length)) return [];
    lengths.push(length);
    totalLength += length;
  }
  if (!Number.isFinite(totalLength) || totalLength <= 1e-3) return [];

  const startCut = Math.max(0, startGapPx);
  const endCut = Math.max(0, totalLength - endGapPx);
  if (endCut <= startCut) return [];

  const trimmed: Array<{ x: number; y: number }> = [];
  let traversed = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const length = lengths[i];
    if (length <= 1e-6) continue;

    const segStart = traversed;
    const segEnd = traversed + length;
    traversed = segEnd;
    if (segEnd <= startCut || segStart >= endCut) continue;

    const t0 = clamp((startCut - segStart) / length, 0, 1);
    const t1 = clamp((endCut - segStart) / length, 0, 1);
    const a = lerpPoint(points[i], points[i + 1], t0);
    const b = lerpPoint(points[i], points[i + 1], t1);
    if (trimmed.length === 0 || Math.hypot(trimmed[trimmed.length - 1].x - a.x, trimmed[trimmed.length - 1].y - a.y) > 0.01) {
      trimmed.push(a);
    }
    trimmed.push(b);
  }
  return trimmed;
}

function lerpPoint(a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function greatCirclePathDeg(ra1Deg: number, dec1Deg: number, ra2Deg: number, dec2Deg: number): Array<[number, number]> {
  const a = raDecToUnit(ra1Deg, dec1Deg);
  const b = raDecToUnit(ra2Deg, dec2Deg);
  const dotValue = clamp(dot(a, b), -1, 1);
  const omega = Math.acos(dotValue);
  if (omega < 1e-12) {
    return [
      [ra1Deg, dec1Deg],
      [ra2Deg, dec2Deg],
    ];
  }

  const separationDeg = omega * (180 / Math.PI);
  const sampleCount = Math.max(2, Math.ceil(Math.max(separationDeg, 0.1) / SAMPLE_STEP_DEG) + 1);
  const sinOmega = Math.sin(omega);
  const points: Array<[number, number]> = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const t = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
    const s1 = Math.sin((1 - t) * omega) / sinOmega;
    const s2 = Math.sin(t * omega) / sinOmega;
    points.push(unitToRaDecDeg([s1 * a[0] + s2 * b[0], s1 * a[1] + s2 * b[1], s1 * a[2] + s2 * b[2]]));
  }
  return points;
}

function angularSeparationDeg(ra1Deg: number, dec1Deg: number, ra2Deg: number, dec2Deg: number): number {
  const ra1 = (ra1Deg * Math.PI) / 180;
  const dec1 = (dec1Deg * Math.PI) / 180;
  const ra2 = (ra2Deg * Math.PI) / 180;
  const dec2 = (dec2Deg * Math.PI) / 180;
  const cosSep = clamp(Math.sin(dec1) * Math.sin(dec2) + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2), -1, 1);
  return Math.acos(cosSep) * (180 / Math.PI);
}

function raDecToUnit(raDeg: number, decDeg: number): [number, number, number] {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const cosDec = Math.cos(dec);
  return [cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec)];
}

function unitToRaDecDeg(vector: [number, number, number]): [number, number] {
  let [x, y, z] = vector;
  const radius = Math.hypot(x, y, z);
  if (radius <= 0) return [0, 0];
  x /= radius;
  y /= radius;
  z /= radius;
  return [normalizeDegrees(Math.atan2(y, x) * (180 / Math.PI)), Math.asin(clamp(z, -1, 1)) * (180 / Math.PI)];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizeDegrees(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
