const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;
const J2000_JD = 2451545.0;
const JD_UNIX_EPOCH = 2440587.5;
const SECONDS_PER_DAY = 86400;

type DistortionType =
  | "none"
  | "radial3"
  | "radial5"
  | "poly3+radial"
  | "poly3+radial3"
  | "poly3+radial5"
  | "radial3-all"
  | "radial4-all"
  | "radial5-all"
  | "radial3-odd"
  | "radial5-odd"
  | "radial7-odd"
  | "radial9-odd";

interface PointingModel {
  ra0: number;
  dec0: number;
  roll: number;
  scaleX: number;
  scaleY: number;
  refTime: number;
}

interface ProjectionContext {
  lat: number;
  lon: number;
  jd: number;
  refraction: boolean;
}

interface DistortionModel {
  type: DistortionType;
  forwardParams: number[];
  reverseParams: number[];
  imageWidth: number;
  imageHeight: number;
  forceDistortionCentre: boolean;
  equalAspect: boolean;
  asymmetryCorr: boolean;
}

export interface SkyfitPlatepar {
  width: number;
  height: number;
  lat: number;
  lon: number;
  elev: number;
  jd: number;
  fovH: number;
  fovV: number;
  raDeg: number;
  decDeg: number;
  posAngleRef: number;
  rotationFromHoriz: number;
  fScale: number;
  distortionType: string;
  xPolyFwd: number[];
  yPolyFwd: number[];
  xPolyRev: number[];
  yPolyRev: number[];
  refraction: boolean;
  equalAspect: boolean;
  forceDistortionCentre: boolean;
  asymmetryCorr: boolean;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

export function julianDayFromDate(date: Date): number {
  return date.getTime() / 1000 / SECONDS_PER_DAY + JD_UNIX_EPOCH;
}

export function raDecToXY(raDeg: number, decDeg: number, jd: number, platepar: SkyfitPlatepar): ProjectedPoint | null {
  const refX = platepar.width * 0.5;
  const refY = platepar.height * 0.5;
  const pointing = buildSkyFitPointing(platepar);
  const ctx = buildProjectionContext(platepar, jd);
  const pixel = skyToPixelCorrected(pointing, ctx, raDeg * DEG2RAD, decDeg * DEG2RAD, refX, refY);
  if (!pixel) {
    return null;
  }

  const distortion = buildSkyFitDistortion(platepar);
  if (distortion.type !== "none" && distortion.reverseParams.length > 0) {
    const distorted = applyDistortion(distortion, pixel.x - refX, pixel.y - refY);
    pixel.x = refX + distorted.x;
    pixel.y = refY + distorted.y;
  }

  if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) {
    return null;
  }
  return pixel;
}

export function xyToRaDec(x: number, y: number, jd: number, platepar: SkyfitPlatepar): { raDeg: number; decDeg: number } | null {
  const refX = platepar.width * 0.5;
  const refY = platepar.height * 0.5;
  let xCorr = x - refX;
  let yCorr = y - refY;

  const distortion = buildSkyFitDistortion(platepar);
  if (distortion.type !== "none" && distortion.forwardParams.length > 0) {
    const corrected = removeDistortion(distortion, xCorr, yCorr);
    xCorr = corrected.x;
    yCorr = corrected.y;
  }

  const pointing = buildSkyFitPointing(platepar);
  const ctx = buildProjectionContext(platepar, jd);
  const sky = pixelToSkyCorrected(pointing, ctx, refX + xCorr, refY + yCorr, refX, refY);
  if (!sky || !Number.isFinite(sky.ra) || !Number.isFinite(sky.dec)) {
    return null;
  }
  return {
    raDeg: normalizeDegrees(sky.ra * RAD2DEG),
    decDeg: sky.dec * RAD2DEG,
  };
}

export function plateparScaleArcsecPerPixel(platepar: SkyfitPlatepar): number {
  if (platepar.fScale > 1e-9) {
    return 3600 / platepar.fScale;
  }
  if (platepar.width > 0 && platepar.fovH > 0) {
    return (platepar.fovH * 3600) / Math.max(1, platepar.width);
  }
  return 30;
}

function buildSkyFitPointing(platepar: SkyfitPlatepar): PointingModel {
  const scale = plateparScaleArcsecPerPixel(platepar);
  return {
    ra0: platepar.raDeg * DEG2RAD,
    dec0: platepar.decDeg * DEG2RAD,
    roll: platepar.posAngleRef * DEG2RAD,
    scaleX: scale,
    scaleY: scale,
    refTime: platepar.jd > 0 ? jdToUnixTime(platepar.jd) : 0,
  };
}

function buildProjectionContext(platepar: SkyfitPlatepar, jd: number): ProjectionContext {
  return {
    lat: platepar.lat * DEG2RAD,
    lon: platepar.lon * DEG2RAD,
    jd,
    refraction: platepar.refraction,
  };
}

function skyToPixel(model: PointingModel, ra: number, dec: number, refX: number, refY: number): ProjectedPoint | null {
  if (!hasFinitePointing(model) || !finite(ra, dec, refX, refY)) {
    return null;
  }

  const cosDec = Math.cos(dec);
  const sinDec = Math.sin(dec);
  const cosDec0 = Math.cos(model.dec0);
  const sinDec0 = Math.sin(model.dec0);
  const dra = ra - model.ra0;
  const cosRadius = clamp(sinDec0 * sinDec + cosDec0 * cosDec * Math.cos(dra), -1, 1);
  if (cosRadius < -0.9) {
    return null;
  }

  const radius = Math.acos(cosRadius);
  if (radius < 1e-12) {
    return { x: refX, y: refY };
  }

  const sinRadius = Math.sin(radius);
  const sinAng = (cosDec * Math.sin(dra)) / sinRadius;
  const cosAng = (sinDec - sinDec0 * cosRadius) / (cosDec0 * sinRadius);
  const theta = -Math.atan2(sinAng, cosAng) + model.roll - Math.PI / 2;
  const avgScale = (model.scaleX + model.scaleY) * 0.5;
  if (!Number.isFinite(avgScale) || Math.abs(avgScale) < 1e-12) {
    return null;
  }

  const radiusPx = ((radius * RAD2DEG) * 3600) / avgScale;
  const x = refX + radiusPx * Math.cos(theta);
  const y = refY + radiusPx * Math.sin(theta);
  return finite(x, y) ? { x, y } : null;
}

function pixelToSky(model: PointingModel, px: number, py: number, refX: number, refY: number): { ra: number; dec: number } {
  const dx = px - refX;
  const dy = py - refY;
  const avgScale = (model.scaleX + model.scaleY) * 0.5;
  const radiusPx = Math.hypot(dx, dy);
  const radiusRad = ((radiusPx * avgScale) / 3600) * DEG2RAD;

  if (radiusPx < 1e-12) {
    return { ra: model.ra0, dec: model.dec0 };
  }

  const theta = Math.atan2(dy, dx);
  const skyTheta = -(theta - model.roll + Math.PI / 2);
  const cosDec0 = Math.cos(model.dec0);
  const sinDec0 = Math.sin(model.dec0);
  const cosR = Math.cos(radiusRad);
  const sinR = Math.sin(radiusRad);
  const cosAng = Math.cos(skyTheta);
  const sinAng = Math.sin(skyTheta);

  const dec = Math.asin(clamp(sinDec0 * cosR + cosDec0 * sinR * cosAng, -1, 1));
  const ra = normalizeRadians(model.ra0 + Math.atan2(sinR * sinAng, cosDec0 * cosR - sinDec0 * sinR * cosAng));
  return { ra, dec };
}

function skyToPixelCorrected(
  model: PointingModel,
  ctx: ProjectionContext,
  ra: number,
  dec: number,
  refX: number,
  refY: number,
): ProjectedPoint | null {
  if (ctx.jd <= 0) {
    return skyToPixel(model, ra, dec, refX, refY);
  }
  if (!finite(ctx.jd, ctx.lat, ctx.lon, ra, dec)) {
    return null;
  }

  const corrected = { ...model };
  const correctedPointing = correctedPointingFor(model, ctx);
  corrected.ra0 = correctedPointing.ra0;
  corrected.dec0 = correctedPointing.dec0;
  corrected.roll = correctedPointing.roll;
  if (!hasFinitePointing(corrected)) {
    return null;
  }

  let projectedRa = ra;
  let projectedDec = dec;
  if (ctx.refraction) {
    const refracted = applyRefractionRaDec(ctx.jd, ctx.lat, ctx.lon, projectedRa, projectedDec);
    projectedRa = refracted.ra;
    projectedDec = refracted.dec;
    if (!finite(projectedRa, projectedDec)) {
      return null;
    }
  }
  return skyToPixel(corrected, projectedRa, projectedDec, refX, refY);
}

function pixelToSkyCorrected(
  model: PointingModel,
  ctx: ProjectionContext,
  px: number,
  py: number,
  refX: number,
  refY: number,
): { ra: number; dec: number } | null {
  if (ctx.jd <= 0) {
    return pixelToSky(model, px, py, refX, refY);
  }
  const correctedPointing = correctedPointingFor(model, ctx);
  const corrected = { ...model, ...correctedPointing };
  const sky = pixelToSky(corrected, px, py, refX, refY);
  return ctx.refraction ? removeRefractionRaDec(ctx.jd, ctx.lat, ctx.lon, sky.ra, sky.dec) : sky;
}

function correctedPointingFor(model: PointingModel, ctx: ProjectionContext): { ra0: number; dec0: number; roll: number } {
  let ra0 = model.ra0;
  let dec0 = model.dec0;
  let roll = model.roll;
  if (ctx.jd <= 0 || model.refTime <= 0 || !hasFinitePointing(model) || !finite(ctx.jd, ctx.lat, ctx.lon, model.refTime)) {
    return { ra0, dec0, roll };
  }

  const h0 = gmst(unixTimeToJD(model.refTime));
  ra0 = normalizeRadians(ra0 + gmst(ctx.jd) - h0);
  if (ctx.refraction) {
    const refracted = applyRefractionRaDec(ctx.jd, ctx.lat, ctx.lon, ra0, dec0);
    ra0 = refracted.ra;
    dec0 = refracted.dec;
  }
  const precessed = precessRaDecAndRotation(ctx.jd, J2000_JD, ra0, dec0, roll);
  return { ra0: precessed.ra, dec0: precessed.dec, roll: precessed.rot };
}

function buildSkyFitDistortion(platepar: SkyfitPlatepar): DistortionModel {
  const type = parseDistortionType(platepar.distortionType);
  const distortion: DistortionModel = {
    type,
    forwardParams: [],
    reverseParams: [],
    imageWidth: Math.max(1, platepar.width),
    imageHeight: Math.max(1, platepar.height),
    forceDistortionCentre: platepar.forceDistortionCentre,
    equalAspect: platepar.equalAspect,
    asymmetryCorr: platepar.asymmetryCorr,
  };

  if (type === "none") {
    return distortion;
  }

  if (isPoly3RadialFamily(type)) {
    const axisCount = poly3RadialAxisParamCount(type);
    if (
      axisCount <= 0 ||
      platepar.xPolyFwd.length < axisCount ||
      platepar.yPolyFwd.length < axisCount ||
      platepar.xPolyRev.length < axisCount ||
      platepar.yPolyRev.length < axisCount
    ) {
      return distortion;
    }
    distortion.forwardParams = [
      ...platepar.xPolyFwd.slice(0, axisCount),
      ...platepar.yPolyFwd.slice(0, axisCount),
    ];
    distortion.reverseParams = [
      ...platepar.xPolyRev.slice(0, axisCount),
      ...platepar.yPolyRev.slice(0, axisCount),
    ];
    return distortion;
  }

  if (!isRmsRadialFamily(type)) {
    return distortion;
  }

  const halfWidth = Math.max(1, platepar.width * 0.5);
  const halfHeight = Math.max(1, platepar.height * 0.5);
  const decodeRadial = (source: number[]): number[] => {
    const out: number[] = [];
    let index = 0;
    const take = (scale: number) => (index < source.length ? source[index++] * scale : 0);
    if (!distortion.forceDistortionCentre) {
      out.push(take(halfWidth), take(halfHeight));
    }
    if (!distortion.equalAspect) {
      out.push(take(1));
    }
    if (distortion.asymmetryCorr) {
      out.push(take(1), take(1));
    }
    for (let i = 0; i < rmsRadialCoeffCount(type); i += 1) {
      out.push(take(1));
    }
    return out;
  };

  distortion.forwardParams = decodeRadial(platepar.xPolyFwd.length ? platepar.xPolyFwd : platepar.xPolyRev);
  distortion.reverseParams = decodeRadial(platepar.xPolyRev.length ? platepar.xPolyRev : platepar.xPolyFwd);
  return distortion;
}

function applyDistortion(model: DistortionModel, x: number, y: number): ProjectedPoint {
  if (model.type === "none" || model.reverseParams.length === 0) {
    return { x, y };
  }
  if (model.type === "radial3" || model.type === "radial5") {
    return applyLegacyRadialForward(model, x, y);
  }
  if (isPoly3RadialFamily(model.type)) {
    return applyRmsPolyForward(model, x, y);
  }
  if (isRmsRadialFamily(model.type)) {
    return applyRmsRadialForward(model, x, y);
  }
  return { x, y };
}

function removeDistortion(model: DistortionModel, x: number, y: number): ProjectedPoint {
  if (model.type === "none" || model.forwardParams.length === 0) {
    return { x, y };
  }
  if (isPoly3RadialFamily(model.type)) {
    return applyRmsPolyReverse(model, x, y);
  }
  if (isRmsRadialFamily(model.type)) {
    return applyRmsRadialReverse(model, x, y);
  }

  let xi = x;
  let yi = y;
  for (let iter = 0; iter < 10; iter += 1) {
    const distorted = applyDistortion(model, xi, yi);
    xi += x - distorted.x;
    yi += y - distorted.y;
  }
  return { x: xi, y: yi };
}

function applyLegacyRadialForward(model: DistortionModel, x: number, y: number): ProjectedPoint {
  const params = model.reverseParams;
  const r2 = x * x + y * y;
  if (model.type === "radial3" && params.length >= 1) {
    const scale = 1 + params[0] * r2;
    return { x: x * scale, y: y * scale };
  }
  if (model.type === "radial5" && params.length >= 2) {
    const scale = 1 + params[0] * r2 + params[1] * r2 * r2;
    return { x: x * scale, y: y * scale };
  }
  return { x, y };
}

function applyRmsPolyForward(model: DistortionModel, x: number, y: number): ProjectedPoint {
  const axisCount = poly3RadialAxisParamCount(model.type);
  const params = model.reverseParams;
  if (axisCount <= 0 || params.length < axisCount * 2) {
    return { x, y };
  }
  const px = params.slice(0, axisCount);
  const py = params.slice(axisCount, axisCount * 2);
  const x0 = px[0];
  const y0 = py[0];
  const r = Math.hypot(x - x0, y - y0);
  let dx =
    x0 +
    px[1] * x +
    px[2] * y +
    px[3] * x * x +
    px[4] * x * y +
    px[5] * y * y +
    px[6] * x * x * x +
    px[7] * x * x * y +
    px[8] * x * y * y +
    px[9] * y * y * y +
    px[10] * x * r +
    px[11] * y * r;
  let dy =
    y0 +
    py[1] * x +
    py[2] * y +
    py[3] * x * x +
    py[4] * x * y +
    py[5] * y * y +
    py[6] * x * x * x +
    py[7] * x * x * y +
    py[8] * x * y * y +
    py[9] * y * y * y +
    py[10] * y * r +
    py[11] * x * r;
  if (axisCount >= 13) {
    const r3 = r * r * r;
    dx += px[12] * x * r3;
    dy += py[12] * y * r3;
  }
  if (axisCount >= 14) {
    const r5 = r ** 5;
    dx += px[13] * x * r5;
    dy += py[13] * y * r5;
  }
  return { x: x - dx, y: y - dy };
}

function applyRmsPolyReverse(model: DistortionModel, x: number, y: number): ProjectedPoint {
  const axisCount = poly3RadialAxisParamCount(model.type);
  const params = model.forwardParams;
  if (axisCount <= 0 || params.length < axisCount * 2) {
    return { x, y };
  }
  const px = params.slice(0, axisCount);
  const py = params.slice(axisCount, axisCount * 2);
  const x0 = px[0];
  const y0 = py[0];
  const r = Math.hypot(x - x0, y - y0);
  let dx =
    x0 +
    px[1] * x +
    px[2] * y +
    px[3] * x * x +
    px[4] * x * y +
    px[5] * y * y +
    px[6] * x * x * x +
    px[7] * x * x * y +
    px[8] * x * y * y +
    px[9] * y * y * y +
    px[10] * x * r +
    px[11] * y * r;
  let dy =
    y0 +
    py[1] * x +
    py[2] * y +
    py[3] * x * x +
    py[4] * x * y +
    py[5] * y * y +
    py[6] * x * x * x +
    py[7] * x * x * y +
    py[8] * x * y * y +
    py[9] * y * y * y +
    py[10] * y * r +
    py[11] * x * r;
  if (axisCount >= 13) {
    const r3 = r * r * r;
    dx += px[12] * x * r3;
    dy += py[12] * y * r3;
  }
  if (axisCount >= 14) {
    const r5 = r ** 5;
    dx += px[13] * x * r5;
    dy += py[13] * y * r5;
  }
  return { x: x + dx, y: y + dy };
}

function unpackRmsRadialParams(model: DistortionModel, source: number[]) {
  let index = 0;
  const out = { x0: 0, y0: 0, xy: 0, a1: 0, a2: 0, k: [0, 0, 0, 0] };
  if (!model.forceDistortionCentre) {
    if (source.length < 2) return null;
    out.x0 = source[index++];
    out.y0 = source[index++];
  }
  if (!model.equalAspect) {
    if (source.length <= index) return null;
    out.xy = source[index++];
  }
  if (model.asymmetryCorr) {
    if (source.length < index + 2) return null;
    out.a1 = source[index++];
    out.a2 = normalizeRadians(source[index++] * TWO_PI);
  }
  const coeffCount = rmsRadialCoeffCount(model.type);
  if (coeffCount <= 0 || source.length < index + coeffCount) return null;
  for (let i = 0; i < coeffCount; i += 1) {
    out.k[i] = source[index + i];
  }
  return out;
}

function evaluateRmsRadialSeries(type: DistortionType, params: { k: number[] }, r: number): number {
  switch (type) {
    case "radial3-all":
      return r + params.k[0] * r * r + params.k[1] * r * r * r;
    case "radial4-all":
      return r + params.k[0] * r * r + params.k[1] * r * r * r + params.k[2] * r ** 4;
    case "radial5-all":
      return r + params.k[0] * r * r + params.k[1] * r * r * r + params.k[2] * r ** 4 + params.k[3] * r ** 5;
    case "radial3-odd":
      return r + params.k[0] * r * r * r;
    case "radial5-odd":
      return r + params.k[0] * r * r * r + params.k[1] * r ** 5;
    case "radial7-odd":
      return r + params.k[0] * r * r * r + params.k[1] * r ** 5 + params.k[2] * r ** 7;
    case "radial9-odd":
      return r + params.k[0] * r * r * r + params.k[1] * r ** 5 + params.k[2] * r ** 7 + params.k[3] * r ** 9;
    default:
      return r;
  }
}

function applyRmsRadialForward(model: DistortionModel, x: number, y: number): ProjectedPoint {
  const params = unpackRmsRadialParams(model, model.reverseParams);
  if (!params) return { x, y };
  const aspectDen = Math.abs(1 + params.xy) < 1e-6 ? (1 + params.xy < 0 ? -1e-6 : 1e-6) : 1 + params.xy;
  let r = Math.hypot(x, y);
  if (model.asymmetryCorr) {
    r += params.a1 * y * Math.cos(params.a2) - params.a1 * x * Math.sin(params.a2);
  }
  r /= safeHalfWidth(model);
  const rCorr = evaluateRmsRadialSeries(model.type, params, r);
  const rScale = Math.abs(r) < 1e-12 ? 0 : rCorr / r - 1;
  const dx = x * rScale - params.x0;
  const dy = (y * rScale) / aspectDen - params.y0 + y * (1 - 1 / aspectDen);
  return { x: x - dx, y: y - dy };
}

function applyRmsRadialReverse(model: DistortionModel, x: number, y: number): ProjectedPoint {
  const params = unpackRmsRadialParams(model, model.forwardParams);
  if (!params) return { x, y };
  const aspectScale = Math.abs(1 + params.xy) < 1e-6 ? (1 + params.xy < 0 ? -1e-6 : 1e-6) : 1 + params.xy;
  let r = Math.hypot(x - params.x0, aspectScale * (y - params.y0));
  if (model.asymmetryCorr) {
    r += params.a1 * aspectScale * (y - params.y0) * Math.cos(params.a2) - params.a1 * (x - params.x0) * Math.sin(params.a2);
  }
  r /= safeHalfWidth(model);
  const rCorr = evaluateRmsRadialSeries(model.type, params, r);
  const rScale = Math.abs(r) < 1e-12 ? 0 : rCorr / r - 1;
  const dx = (x - params.x0) * rScale - params.x0;
  const dy = (y - params.y0) * rScale * aspectScale - params.y0 * aspectScale + y * params.xy;
  return { x: x + dx, y: y + dy };
}

function parseDistortionType(value: string): DistortionType {
  const normalized = value.trim() as DistortionType;
  switch (normalized) {
    case "radial3":
    case "radial5":
    case "poly3+radial":
    case "poly3+radial3":
    case "poly3+radial5":
    case "radial3-all":
    case "radial4-all":
    case "radial5-all":
    case "radial3-odd":
    case "radial5-odd":
    case "radial7-odd":
    case "radial9-odd":
      return normalized;
    default:
      return "none";
  }
}

function poly3RadialAxisParamCount(type: DistortionType): number {
  if (type === "poly3+radial") return 12;
  if (type === "poly3+radial3") return 13;
  if (type === "poly3+radial5") return 14;
  return 0;
}

function rmsRadialCoeffCount(type: DistortionType): number {
  switch (type) {
    case "radial3-all":
      return 2;
    case "radial4-all":
      return 3;
    case "radial5-all":
      return 4;
    case "radial3-odd":
      return 1;
    case "radial5-odd":
      return 2;
    case "radial7-odd":
      return 3;
    case "radial9-odd":
      return 4;
    default:
      return 0;
  }
}

function isPoly3RadialFamily(type: DistortionType): boolean {
  return type === "poly3+radial" || type === "poly3+radial3" || type === "poly3+radial5";
}

function isRmsRadialFamily(type: DistortionType): boolean {
  return (
    type === "radial3-all" ||
    type === "radial4-all" ||
    type === "radial5-all" ||
    type === "radial3-odd" ||
    type === "radial5-odd" ||
    type === "radial7-odd" ||
    type === "radial9-odd"
  );
}

function precessRaDec(jdFrom: number, jdTo: number, ra: number, dec: number): { ra: number; dec: number } {
  const T = (jdFrom - J2000_JD) / 36525;
  const t = (jdTo - jdFrom) / 36525;
  if (Math.abs(t) < 1e-12) return { ra, dec };

  const zetaA = (2306.2181 + 1.39656 * T - 0.000139 * T * T) * t + (0.30188 - 0.000344 * T) * t * t + 0.017998 * t ** 3;
  const zA = (2306.2181 + 1.39656 * T - 0.000139 * T * T) * t + (1.09468 + 0.000066 * T) * t * t + 0.018203 * t ** 3;
  const thetaA = (2004.3109 - 0.8533 * T - 0.000217 * T * T) * t - (0.42665 + 0.000217 * T) * t * t - 0.041833 * t ** 3;
  const zeta = (zetaA / 3600) * DEG2RAD;
  const z = (zA / 3600) * DEG2RAD;
  const theta = (thetaA / 3600) * DEG2RAD;

  const cosD = Math.cos(dec);
  const sinD = Math.sin(dec);
  const cosRZ = Math.cos(ra + zeta);
  const sinRZ = Math.sin(ra + zeta);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const A = cosD * sinRZ;
  const B = cosT * cosD * cosRZ - sinT * sinD;
  const C = sinT * cosD * cosRZ + cosT * sinD;
  return { ra: normalizeRadians(Math.atan2(A, B) + z), dec: Math.asin(clamp(C, -1, 1)) };
}

function precessRaDecAndRotation(jdFrom: number, jdTo: number, ra: number, dec: number, rot: number): { ra: number; dec: number; rot: number } {
  if (jdFrom === jdTo) {
    return { ra, dec, rot };
  }

  const T = (jdFrom - J2000_JD) / 36525;
  const t = (jdTo - jdFrom) / 36525;
  const zeta = (((2306.2181 + 1.39656 * T - 0.000139 * T * T) * t + (0.30188 - 0.000344 * T) * t * t + 0.017998 * t ** 3) / 3600) * DEG2RAD;
  const z = (((2306.2181 + 1.39656 * T - 0.000139 * T * T) * t + (1.09468 + 0.000066 * T) * t * t + 0.018203 * t ** 3) / 3600) * DEG2RAD;
  const theta = (((2004.3109 - 0.8533 * T - 0.000217 * T * T) * t - (0.42665 + 0.000217 * T) * t * t - 0.041833 * t ** 3) / 3600) * DEG2RAD;
  const matrix = precessionMatrix(zeta, theta, z);
  const initialVector = raDecToCartesian(ra, dec);
  const transformedVector = matMul(matrix, initialVector);
  const normalVector = cross(initialVector, transformedVector);
  const transformedNormal = matMul(matrix, normalVector);
  const initialUnit = normalizeVec(initialVector);
  const transformedUnit = normalizeVec(transformedVector);
  const normalUnit = normalizeVec(normalVector);
  const transformedNormalUnit = normalizeVec(transformedNormal);
  const precessed = cartesianToRaDec(transformedUnit);
  const parallel = [-Math.sin(ra), Math.cos(ra), 0] as Vec3;
  const parallelPrecessed = [-Math.sin(precessed.ra), Math.cos(precessed.ra), 0] as Vec3;
  const projParallel = normalizeVec(subtractVec(parallel, scaleVec(initialUnit, dot(parallel, initialUnit))));
  const projParallelPrecessed = normalizeVec(subtractVec(parallelPrecessed, scaleVec(transformedUnit, dot(parallelPrecessed, transformedUnit))));

  if (
    normVec(normalUnit) < 1e-12 ||
    normVec(transformedNormalUnit) < 1e-12 ||
    normVec(projParallel) < 1e-12 ||
    normVec(projParallelPrecessed) < 1e-12
  ) {
    return { ...precessed, rot };
  }

  const angle1 = Math.atan2(dot(cross(normalUnit, projParallel), initialUnit), dot(normalUnit, projParallel));
  const angle2 = Math.atan2(dot(cross(transformedNormalUnit, projParallelPrecessed), transformedUnit), dot(transformedNormalUnit, projParallelPrecessed));
  return { ...precessed, rot: normalizeSignedRadians(rot + (angle2 - angle1)) };
}

function applyRefractionRaDec(jd: number, lat: number, lon: number, ra: number, dec: number): { ra: number; dec: number } {
  let sky = precessRaDec(J2000_JD, jd, ra, dec);
  const lmst = gmst(jd) + lon;
  const altAz = raDecToAltAz(sky.ra, sky.dec, lat, normalizeRadians(lmst));
  const apparentAlt = altAz.alt + refractionTrueToApparent(altAz.alt);
  sky = altAzToRaDec(apparentAlt, altAz.az, lat, normalizeRadians(lmst));
  return precessRaDec(jd, J2000_JD, sky.ra, sky.dec);
}

function removeRefractionRaDec(jd: number, lat: number, lon: number, ra: number, dec: number): { ra: number; dec: number } {
  const app = { ra, dec };
  let current = { ra, dec };
  for (let i = 0; i < 5; i += 1) {
    const trial = applyRefractionRaDec(jd, lat, lon, current.ra, current.dec);
    current = { ra: current.ra + app.ra - trial.ra, dec: current.dec + app.dec - trial.dec };
  }
  return current;
}

function raDecToAltAz(ra: number, dec: number, lat: number, lmstValue: number): { alt: number; az: number } {
  const ha = normalizeRadians(lmstValue - ra);
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  let cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
  cosAz = clamp(cosAz, -1, 1);
  let az = Math.acos(cosAz);
  if (Math.sin(ha) > 0) az = TWO_PI - az;
  return { alt, az };
}

function altAzToRaDec(alt: number, az: number, lat: number, lmstValue: number): { ra: number; dec: number } {
  const sinDec = Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(clamp(sinDec, -1, 1));
  let cosHa = (Math.sin(alt) - Math.sin(dec) * Math.sin(lat)) / (Math.cos(dec) * Math.cos(lat));
  cosHa = clamp(cosHa, -1, 1);
  let ha = Math.acos(cosHa);
  if (Math.sin(az) > 0) ha = TWO_PI - ha;
  return { ra: normalizeRadians(lmstValue - ha), dec };
}

function refractionTrueToApparent(trueElevRad: number): number {
  const elevDeg = Math.max(trueElevRad * RAD2DEG, -0.5);
  const r = 1.02 / Math.tan((elevDeg + 10.3 / (elevDeg + 5.11)) * DEG2RAD);
  return (r / 60) * DEG2RAD;
}

function gmst(jd: number): number {
  const T = (jd - J2000_JD) / 36525;
  return normalizeRadians((280.46061837 + 360.98564736629 * (jd - J2000_JD) + 0.000387933 * T * T - (T * T * T) / 38710000) * DEG2RAD);
}

function unixTimeToJD(unixTime: number): number {
  return unixTime / SECONDS_PER_DAY + JD_UNIX_EPOCH;
}

function jdToUnixTime(jd: number): number {
  return (jd - JD_UNIX_EPOCH) * SECONDS_PER_DAY;
}

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

function precessionMatrix(zeta: number, theta: number, z: number): Mat3 {
  const czeta = Math.cos(zeta);
  const szeta = Math.sin(zeta);
  const ctheta = Math.cos(theta);
  const stheta = Math.sin(theta);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  return [
    [czeta * ctheta * cz - szeta * sz, -szeta * ctheta * cz - czeta * sz, -stheta * cz],
    [czeta * ctheta * sz + szeta * cz, -szeta * ctheta * sz + czeta * cz, -stheta * sz],
    [czeta * stheta, -szeta * stheta, ctheta],
  ];
}

function raDecToCartesian(ra: number, dec: number): Vec3 {
  const cosDec = Math.cos(dec);
  return [cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec)];
}

function cartesianToRaDec(v: Vec3): { ra: number; dec: number } {
  const unit = normalizeVec(v);
  return { ra: normalizeRadians(Math.atan2(unit[1], unit[0])), dec: Math.asin(clamp(unit[2], -1, 1)) };
}

function matMul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normVec(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

function normalizeVec(v: Vec3): Vec3 {
  const n = normVec(v);
  return n < 1e-12 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
}

function scaleVec(v: Vec3, scale: number): Vec3 {
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

function subtractVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function hasFinitePointing(model: PointingModel): boolean {
  return finite(model.ra0, model.dec0, model.roll, model.scaleX, model.scaleY);
}

function safeHalfWidth(model: DistortionModel): number {
  return model.imageWidth > 1 ? model.imageWidth * 0.5 : 640;
}

function finite(...values: number[]): boolean {
  return values.every(Number.isFinite);
}

function normalizeRadians(rad: number): number {
  const wrapped = rad % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

function normalizeSignedRadians(rad: number): number {
  let wrapped = (rad + Math.PI) % TWO_PI;
  if (wrapped < 0) wrapped += TWO_PI;
  return wrapped - Math.PI;
}

function normalizeDegrees(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
