<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  Braces,
  CalendarClock,
  Camera,
  CheckCircle2,
  CloudUpload,
  Database,
  FileJson,
  FileUp,
  FolderOpen,
  Image as ImageIcon,
  KeyRound,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  SquareStack,
  Telescope,
  UploadCloud,
} from "@lucide/vue";
import {
  projectConstellationGroups,
  projectSkyPointToDisplay,
  type ConstellationGroup,
  type ConstellationJson,
} from "./astro/skyfitConstellations";
import { julianDayFromDate, type SkyfitPlatepar } from "./astro/skyfitProjection";

type TabKey = "overview" | "profile" | "calibration" | "event" | "queue" | "logs";
type QueueStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "job_running"
  | "succeeded"
  | "duplicate"
  | "failed_retriable"
  | "failed_terminal";
type CalibrationStream = "main" | "sub";

interface QueueItem {
  id: number;
  eventId: string;
  camera: string;
  status: QueueStatus;
  updated: string;
  remoteJobUid?: string;
  errorMessage?: string;
  packageDir?: string;
}

interface PhotoTime {
  sourceName: string;
  beijingText: string;
  utcIso: string;
  direction: string;
  suffix: string;
}

interface PlateparPreview extends SkyfitPlatepar {
  stationCode: string;
}

interface OverlayLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strong?: boolean;
}

interface SkyCatalogPoint {
  id: string;
  name: string;
  raDeg: number;
  decDeg: number;
  magnitude?: number;
}

interface ProjectedSkyLabel extends SkyCatalogPoint {
  x: number;
  y: number;
}

interface SkyLineSegment {
  id: string;
  constellation: string;
  from: SkyCatalogPoint;
  to: SkyCatalogPoint;
}

interface ProjectedSkyPoint extends SkyCatalogPoint {
  x: number;
  y: number;
  distance: number;
}

interface ProjectedSkyLine {
  id: string;
  constellation: string;
  fromName: string;
  toName: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface SkyProjectionContext {
  width: number;
  height: number;
  centerRa: number;
  centerDec: number;
  fovH: number;
  fovV: number;
  cosDec: number;
  sinRot: number;
  cosRot: number;
}

const activeTab = ref<TabKey>("overview");

const profile = reactive({
  path: "test/cloud_profile.sample.json",
  camera: "1",
  stationUid: "st_xxx",
  cameraUid: "cam_xxx",
  keyId: "dk_xxx",
  enabled: true,
});

const calibration = reactive({
  path: "cal/CAM01_main.cal",
  camera: "CAM01",
  stream: "main" as CalibrationStream,
  active: true,
  width: 1920,
  height: 1080,
  sha: "未导入",
});

const calPreview = reactive({
  photoName: "",
  photoUrl: "",
  photoWidth: 0,
  photoHeight: 0,
  photoError: "",
  photoTime: null as PhotoTime | null,
  calName: "",
  calError: "",
  overlayEnabled: true,
  showConstellationLines: true,
  showConstellations: true,
  showBrightStars: false,
  platepar: null as PlateparPreview | null,
});

let activePhotoUrl = "";

const eventPackage = reactive({
  eventId: "20260513_021029_east_2480_hd_meteor_001",
  eventTime: "2026-05-12T18:10:36.741Z",
  cameraCode: "1",
  stationCode: "CN110001",
  videoPath: "test/1/20260513_021029_east_2480_hd.mp4",
  ecsvPath: "test/1/20260513_021029_east_2480_hd_meteor_001.ecsv",
  previewPath: "test/1/20260513_021029_east_2480_hd_overlay.png",
  outputDir: "",
});

const eventFiles = reactive({
  ecsv: null as File | null,
  video: null as File | null,
  preview: null as File | null,
});

const apiState = reactive({
  busy: false,
  online: false,
  dataDir: "",
  lastError: "",
});

const queue = ref<QueueItem[]>([]);

const logs = ref<string[]>([]);

const constellationGroups = ref<ConstellationGroup[]>([]);
const constellationSourceName = ref("constellation_groups_stellarium_western.json");
const constellationError = ref("");

const statusCounts = computed(() => {
  const seed: Record<QueueStatus, number> = {
    queued: 0,
    uploading: 0,
    uploaded: 0,
    job_running: 0,
    succeeded: 0,
    duplicate: 0,
    failed_retriable: 0,
    failed_terminal: 0,
  };
  for (const item of queue.value) {
    seed[item.status] += 1;
  }
  return seed;
});

const tabs: Array<{ key: TabKey; label: string; icon: unknown }> = [
  { key: "overview", label: "总览", icon: Activity },
  { key: "profile", label: "Profile", icon: KeyRound },
  { key: "calibration", label: "CAL", icon: Telescope },
  { key: "event", label: "事件包", icon: FileJson },
  { key: "queue", label: "队列", icon: UploadCloud },
  { key: "logs", label: "日志", icon: ListChecks },
];

const CONSTELLATION_LABELS: SkyCatalogPoint[] = [
  { id: "and", name: "仙女座", raDeg: 10, decDeg: 37 },
  { id: "ari", name: "白羊座", raDeg: 37, decDeg: 20 },
  { id: "aur", name: "御夫座", raDeg: 90, decDeg: 40 },
  { id: "boo", name: "牧夫座", raDeg: 220, decDeg: 35 },
  { id: "cas", name: "仙后座", raDeg: 15, decDeg: 60 },
  { id: "cep", name: "仙王座", raDeg: 330, decDeg: 70 },
  { id: "cyg", name: "天鹅座", raDeg: 305, decDeg: 43 },
  { id: "dra", name: "天龙座", raDeg: 250, decDeg: 65 },
  { id: "gem", name: "双子座", raDeg: 110, decDeg: 25 },
  { id: "her", name: "武仙座", raDeg: 260, decDeg: 30 },
  { id: "leo", name: "狮子座", raDeg: 155, decDeg: 15 },
  { id: "lyr", name: "天琴座", raDeg: 280, decDeg: 40 },
  { id: "ori", name: "猎户座", raDeg: 85, decDeg: 0 },
  { id: "peg", name: "飞马座", raDeg: 337, decDeg: 20 },
  { id: "per", name: "英仙座", raDeg: 50, decDeg: 45 },
  { id: "sco", name: "天蝎座", raDeg: 247, decDeg: -26 },
  { id: "tau", name: "金牛座", raDeg: 70, decDeg: 18 },
  { id: "uma", name: "大熊座", raDeg: 165, decDeg: 56 },
  { id: "umi", name: "小熊座", raDeg: 225, decDeg: 75 },
  { id: "vir", name: "室女座", raDeg: 200, decDeg: -5 },
];

const BRIGHT_STAR_LABELS: SkyCatalogPoint[] = [
  { id: "sirius", name: "天狼星", raDeg: 101.287, decDeg: -16.716, magnitude: -1.46 },
  { id: "canopus", name: "老人星", raDeg: 95.988, decDeg: -52.696, magnitude: -0.74 },
  { id: "arcturus", name: "大角星", raDeg: 213.915, decDeg: 19.182, magnitude: -0.05 },
  { id: "vega", name: "织女星", raDeg: 279.235, decDeg: 38.784, magnitude: 0.03 },
  { id: "capella", name: "五车二", raDeg: 79.172, decDeg: 45.998, magnitude: 0.08 },
  { id: "rigel", name: "参宿七", raDeg: 78.634, decDeg: -8.202, magnitude: 0.13 },
  { id: "procyon", name: "南河三", raDeg: 114.825, decDeg: 5.225, magnitude: 0.34 },
  { id: "betelgeuse", name: "参宿四", raDeg: 88.793, decDeg: 7.407, magnitude: 0.5 },
  { id: "altair", name: "牛郎星", raDeg: 297.696, decDeg: 8.868, magnitude: 0.77 },
  { id: "aldebaran", name: "毕宿五", raDeg: 68.98, decDeg: 16.509, magnitude: 0.85 },
  { id: "spica", name: "角宿一", raDeg: 201.298, decDeg: -11.161, magnitude: 0.98 },
  { id: "pollux", name: "北河三", raDeg: 116.329, decDeg: 28.026, magnitude: 1.14 },
  { id: "fomalhaut", name: "北落师门", raDeg: 344.413, decDeg: -29.622, magnitude: 1.16 },
  { id: "deneb", name: "天津四", raDeg: 310.358, decDeg: 45.28, magnitude: 1.25 },
  { id: "regulus", name: "轩辕十四", raDeg: 152.093, decDeg: 11.967, magnitude: 1.35 },
  { id: "castor", name: "北河二", raDeg: 113.65, decDeg: 31.888, magnitude: 1.58 },
  { id: "dubhe", name: "天枢", raDeg: 165.932, decDeg: 61.751, magnitude: 1.79 },
  { id: "polaris", name: "北极星", raDeg: 37.954, decDeg: 89.264, magnitude: 1.98 },
  { id: "merak", name: "天璇", raDeg: 165.46, decDeg: 56.382, magnitude: 2.37 },
];

const CONSTELLATION_LINE_SEGMENTS: SkyLineSegment[] = [
  skyLine("ori-1", "猎户座", skyPoint("betelgeuse", "参宿四", 88.793, 7.407), skyPoint("bellatrix", "参宿五", 81.283, 6.35)),
  skyLine("ori-2", "猎户座", skyPoint("bellatrix", "参宿五", 81.283, 6.35), skyPoint("mintaka", "参宿三", 83.001, -0.299)),
  skyLine("ori-3", "猎户座", skyPoint("mintaka", "参宿三", 83.001, -0.299), skyPoint("alnilam", "参宿二", 84.053, -1.202)),
  skyLine("ori-4", "猎户座", skyPoint("alnilam", "参宿二", 84.053, -1.202), skyPoint("alnitak", "参宿一", 85.19, -1.943)),
  skyLine("ori-5", "猎户座", skyPoint("alnitak", "参宿一", 85.19, -1.943), skyPoint("saiph", "参宿六", 86.939, -9.67)),
  skyLine("ori-6", "猎户座", skyPoint("saiph", "参宿六", 86.939, -9.67), skyPoint("rigel", "参宿七", 78.634, -8.202)),
  skyLine("ori-7", "猎户座", skyPoint("rigel", "参宿七", 78.634, -8.202), skyPoint("mintaka", "参宿三", 83.001, -0.299)),
  skyLine("uma-1", "大熊座", skyPoint("dubhe", "天枢", 165.932, 61.751), skyPoint("merak", "天璇", 165.46, 56.382)),
  skyLine("uma-2", "大熊座", skyPoint("merak", "天璇", 165.46, 56.382), skyPoint("phecda", "天玑", 178.458, 53.695)),
  skyLine("uma-3", "大熊座", skyPoint("phecda", "天玑", 178.458, 53.695), skyPoint("megrez", "天权", 183.856, 57.033)),
  skyLine("uma-4", "大熊座", skyPoint("megrez", "天权", 183.856, 57.033), skyPoint("alioth", "玉衡", 193.507, 55.959)),
  skyLine("uma-5", "大熊座", skyPoint("alioth", "玉衡", 193.507, 55.959), skyPoint("mizar", "开阳", 200.981, 54.925)),
  skyLine("uma-6", "大熊座", skyPoint("mizar", "开阳", 200.981, 54.925), skyPoint("alkaid", "摇光", 206.885, 49.313)),
  skyLine("uma-7", "大熊座", skyPoint("megrez", "天权", 183.856, 57.033), skyPoint("dubhe", "天枢", 165.932, 61.751)),
  skyLine("umi-1", "小熊座", skyPoint("polaris", "北极星", 37.954, 89.264), skyPoint("yildun", "勾陈二", 263.054, 86.586)),
  skyLine("umi-2", "小熊座", skyPoint("yildun", "勾陈二", 263.054, 86.586), skyPoint("eps-umi", "勾陈三", 251.492, 82.037)),
  skyLine("umi-3", "小熊座", skyPoint("eps-umi", "勾陈三", 251.492, 82.037), skyPoint("kochab", "帝", 222.676, 74.155)),
  skyLine("umi-4", "小熊座", skyPoint("kochab", "帝", 222.676, 74.155), skyPoint("pherkad", "太子", 230.182, 71.834)),
  skyLine("cas-1", "仙后座", skyPoint("caph", "王良一", 2.295, 59.15), skyPoint("schedar", "王良四", 10.127, 56.537)),
  skyLine("cas-2", "仙后座", skyPoint("schedar", "王良四", 10.127, 56.537), skyPoint("gamma-cas", "策", 14.177, 60.717)),
  skyLine("cas-3", "仙后座", skyPoint("gamma-cas", "策", 14.177, 60.717), skyPoint("ruchbah", "王良三", 21.454, 60.235)),
  skyLine("cas-4", "仙后座", skyPoint("ruchbah", "王良三", 21.454, 60.235), skyPoint("segin", "阁道二", 28.599, 63.67)),
  skyLine("cyg-1", "天鹅座", skyPoint("deneb", "天津四", 310.358, 45.28), skyPoint("sadr", "天津一", 305.557, 40.257)),
  skyLine("cyg-2", "天鹅座", skyPoint("sadr", "天津一", 305.557, 40.257), skyPoint("gienah", "天津九", 292.68, 33.97)),
  skyLine("cyg-3", "天鹅座", skyPoint("sadr", "天津一", 305.557, 40.257), skyPoint("delta-cyg", "天津二", 296.244, 45.131)),
  skyLine("cyg-4", "天鹅座", skyPoint("sadr", "天津一", 305.557, 40.257), skyPoint("albireo", "辇道增七", 292.176, 27.96)),
  skyLine("gem-1", "双子座", skyPoint("castor", "北河二", 113.65, 31.888), skyPoint("wasat", "积薪", 110.031, 21.982)),
  skyLine("gem-2", "双子座", skyPoint("wasat", "积薪", 110.031, 21.982), skyPoint("alhena", "井宿三", 99.427, 16.399)),
  skyLine("gem-3", "双子座", skyPoint("pollux", "北河三", 116.329, 28.026), skyPoint("wasat", "积薪", 110.031, 21.982)),
  skyLine("tau-1", "金牛座", skyPoint("aldebaran", "毕宿五", 68.98, 16.509), skyPoint("elnath", "五车五", 81.573, 28.608)),
  skyLine("tau-2", "金牛座", skyPoint("aldebaran", "毕宿五", 68.98, 16.509), skyPoint("alcyone", "昴宿六", 56.871, 24.105)),
  skyLine("tau-3", "金牛座", skyPoint("aldebaran", "毕宿五", 68.98, 16.509), skyPoint("tianguan", "天关", 84.411, 21.142)),
  skyLine("leo-1", "狮子座", skyPoint("regulus", "轩辕十四", 152.093, 11.967), skyPoint("algieba", "轩辕十二", 154.993, 19.842)),
  skyLine("leo-2", "狮子座", skyPoint("algieba", "轩辕十二", 154.993, 19.842), skyPoint("zosma", "西上相", 168.527, 20.524)),
  skyLine("leo-3", "狮子座", skyPoint("zosma", "西上相", 168.527, 20.524), skyPoint("denebola", "五帝座一", 177.265, 14.572)),
  skyLine("leo-4", "狮子座", skyPoint("algieba", "轩辕十二", 154.993, 19.842), skyPoint("rasalas", "轩辕十", 148.191, 26.006)),
  skyLine("sco-1", "天蝎座", skyPoint("acrab", "房宿四", 241.36, -19.805), skyPoint("dschubba", "房宿三", 240.083, -22.622)),
  skyLine("sco-2", "天蝎座", skyPoint("dschubba", "房宿三", 240.083, -22.622), skyPoint("antares", "心宿二", 247.352, -26.432)),
  skyLine("sco-3", "天蝎座", skyPoint("antares", "心宿二", 247.352, -26.432), skyPoint("shaula", "尾宿八", 263.402, -37.104)),
  skyLine("peg-1", "飞马座", skyPoint("markab", "室宿一", 346.19, 15.205), skyPoint("scheat", "室宿二", 345.944, 28.083)),
  skyLine("peg-2", "飞马座", skyPoint("scheat", "室宿二", 345.944, 28.083), skyPoint("alpheratz", "壁宿二", 2.097, 29.09)),
  skyLine("peg-3", "飞马座", skyPoint("alpheratz", "壁宿二", 2.097, 29.09), skyPoint("algenib", "壁宿一", 3.309, 15.184)),
  skyLine("peg-4", "飞马座", skyPoint("algenib", "壁宿一", 3.309, 15.184), skyPoint("markab", "室宿一", 346.19, 15.205)),
  skyLine("and-1", "仙女座", skyPoint("alpheratz", "壁宿二", 2.097, 29.09), skyPoint("mirach", "奎宿九", 17.433, 35.621)),
  skyLine("and-2", "仙女座", skyPoint("mirach", "奎宿九", 17.433, 35.621), skyPoint("almach", "天大将军一", 30.975, 42.33)),
  skyLine("aur-1", "御夫座", skyPoint("capella", "五车二", 79.172, 45.998), skyPoint("menkalinan", "五车三", 89.882, 44.947)),
  skyLine("aur-2", "御夫座", skyPoint("menkalinan", "五车三", 89.882, 44.947), skyPoint("mahasim", "五车四", 89.93, 37.213)),
  skyLine("aur-3", "御夫座", skyPoint("mahasim", "五车四", 89.93, 37.213), skyPoint("hassaleh", "五车一", 74.248, 33.166)),
  skyLine("aur-4", "御夫座", skyPoint("hassaleh", "五车一", 74.248, 33.166), skyPoint("capella", "五车二", 79.172, 45.998)),
  skyLine("per-1", "英仙座", skyPoint("mirfak", "天船三", 51.081, 49.861), skyPoint("algol", "大陵五", 47.042, 40.956)),
  skyLine("per-2", "英仙座", skyPoint("mirfak", "天船三", 51.081, 49.861), skyPoint("eps-per", "卷舌五", 59.464, 40.01)),
];

const overlaySize = computed(() => {
  const width = calPreview.photoWidth || calPreview.platepar?.width || calibration.width || 1280;
  const height = calPreview.photoHeight || calPreview.platepar?.height || calibration.height || 720;
  return { width, height };
});

const overlayGrid = computed<OverlayLine[]>(() => {
  const { width, height } = overlaySize.value;
  const lines: OverlayLine[] = [];
  for (let i = 1; i < 4; i += 1) {
    const x = (width * i) / 4;
    const y = (height * i) / 4;
    lines.push({ x1: x, y1: 0, x2: x, y2: height });
    lines.push({ x1: 0, y1: y, x2: width, y2: y });
  }
  lines.push({ x1: width / 2, y1: 0, x2: width / 2, y2: height, strong: true });
  lines.push({ x1: 0, y1: height / 2, x2: width, y2: height / 2, strong: true });
  return lines;
});

const compassLines = computed(() => {
  const { width, height } = overlaySize.value;
  const angle = (((calPreview.platepar?.rotationFromHoriz ?? 0) - 90) * Math.PI) / 180;
  const cx = width * 0.82;
  const cy = height * 0.18;
  const len = Math.min(width, height) * 0.1;
  const north = {
    x1: cx,
    y1: cy,
    x2: cx + Math.cos(angle) * len,
    y2: cy + Math.sin(angle) * len,
  };
  const eastAngle = angle + Math.PI / 2;
  const east = {
    x1: cx,
    y1: cy,
    x2: cx + Math.cos(eastAngle) * len * 0.72,
    y2: cy + Math.sin(eastAngle) * len * 0.72,
  };
  return { center: { x: cx, y: cy }, north, east };
});

const calResolutionNote = computed(() => {
  const platepar = calPreview.platepar;
  if (!platepar || !calPreview.photoWidth || !calPreview.photoHeight) {
    return "";
  }
  if (platepar.width === calPreview.photoWidth && platepar.height === calPreview.photoHeight) {
    return "照片分辨率与 CAL 一致";
  }
  return `照片 ${calPreview.photoWidth}x${calPreview.photoHeight} / CAL ${platepar.width}x${platepar.height}，当前叠加层按照片尺寸缩放显示`;
});

const photoJulianDay = computed(() => {
  if (!calPreview.photoTime) {
    return undefined;
  }
  return julianDayFromDate(new Date(calPreview.photoTime.utcIso));
});

const projectedConstellations = computed<ProjectedSkyLabel[]>(() =>
  projectSkyCatalog(CONSTELLATION_LABELS, { maxItems: 10, marginPx: 80 }),
);

const constellationOverlay = computed(() => {
  if (!calPreview.platepar || !photoJulianDay.value || constellationGroups.value.length === 0) {
    return {
      runs: [],
      stats: {
        sourceName: constellationSourceName.value,
        constellationsSelected: 0,
        constellationsDrawn: 0,
        renderedSegments: 0,
      },
    };
  }
  const { width, height } = overlaySize.value;
  return projectConstellationGroups({
    groups: constellationGroups.value,
    platepar: calPreview.platepar,
    jd: photoJulianDay.value,
    displayWidth: width,
    displayHeight: height,
    sourceName: constellationSourceName.value,
  });
});

const projectedConstellationLines = computed(() => constellationOverlay.value.runs);

const projectedBrightStars = computed<ProjectedSkyLabel[]>(() =>
  projectSkyCatalog(BRIGHT_STAR_LABELS, { maxItems: 18, marginPx: 42 }),
);

const skyProjectionNote = computed(() => {
  if (!calPreview.photoTime || !calPreview.platepar) {
    return "星座标识需要照片时间和 CAL";
  }
  if (constellationError.value) {
    return `星座数据加载失败：${constellationError.value}`;
  }
  const count =
    projectedConstellationLines.value.length + projectedConstellations.value.length + projectedBrightStars.value.length;
  if (count === 0) {
    return "当前 MS 星座数据没有落入这个视场";
  }
  return `MS 投影：${constellationOverlay.value.stats.renderedSegments} 条星座线 / ${constellationOverlay.value.stats.constellationsDrawn} 个星座`;
});

function nowClock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function addLog(message: string): void {
  logs.value.unshift(`[${nowClock()}] ${message}`);
  logs.value = logs.value.slice(0, 24);
}

function queueFromApi(rows: Array<Record<string, unknown>> | undefined): QueueItem[] {
  return (rows ?? []).map((row) => ({
    id: Number(row.id),
    eventId: String(row.localEventId ?? ""),
    camera: String(row.cameraCode ?? ""),
    status: String(row.status ?? "queued") as QueueStatus,
    updated: String(row.updatedAt || ""),
    remoteJobUid: typeof row.remoteJobUid === "string" ? row.remoteJobUid : undefined,
    errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : undefined,
    packageDir: typeof row.packageDir === "string" ? row.packageDir : undefined,
  }));
}

function applyProfileFromApi(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const cloud = value as Record<string, unknown>;
  profile.stationUid = String(cloud.stationUid ?? profile.stationUid);
  profile.cameraUid = String(cloud.cameraUid ?? profile.cameraUid);
  profile.keyId = String(cloud.deviceKeyId ?? profile.keyId);
  profile.camera = String(cloud.cameraCode || profile.camera);
  eventPackage.cameraCode = profile.camera;
  eventPackage.stationCode = String(cloud.stationCode ?? eventPackage.stationCode);
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function refreshQueue(): Promise<void> {
  try {
    const payload = await apiJson<{ ok: boolean; queue: Array<Record<string, unknown>> }>("/api/queue");
    queue.value = queueFromApi(payload.queue);
    apiState.lastError = "";
  } catch (error) {
    apiState.lastError = error instanceof Error ? error.message : String(error);
    addLog(`queue refresh failed: ${apiState.lastError}`);
  }
}

async function checkApi(): Promise<void> {
  try {
    const payload = await apiJson<{ ok: boolean; dataDir: string }>("/api/health");
    apiState.online = true;
    apiState.dataDir = payload.dataDir;
    apiState.lastError = "";
    addLog(`api online ${payload.dataDir}`);
    await refreshQueue();
  } catch (error) {
    apiState.online = false;
    apiState.lastError = error instanceof Error ? error.message : String(error);
    addLog(`api offline: ${apiState.lastError}`);
  }
}

async function loadConstellationGroups(): Promise<void> {
  try {
    const response = await fetch("/constellation_groups_stellarium_western.json", { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const root = (await response.json()) as ConstellationJson;
    constellationGroups.value = Array.isArray(root.constellations) ? root.constellations : [];
    constellationError.value = constellationGroups.value.length ? "" : "empty constellation list";
    addLog(`constellation data ${constellationGroups.value.length} groups`);
  } catch (error) {
    constellationGroups.value = [];
    constellationError.value = error instanceof Error ? error.message : String(error);
    addLog(`constellation data failed ${constellationError.value}`);
  }
}

onMounted(() => {
  void loadConstellationGroups();
  void checkApi();
});

async function importProfile(): Promise<void> {
  apiState.busy = true;
  try {
    const payload = await apiJson<{
      ok: boolean;
      profile: Record<string, unknown>;
      queue: Array<Record<string, unknown>>;
    }>("/api/profile/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: profile.path,
        bindCameraCode: profile.camera,
        enableBinding: profile.enabled,
      }),
    });
    applyProfileFromApi(payload.profile);
    queue.value = queueFromApi(payload.queue);
    apiState.lastError = "";
    addLog(`profile imported ${profile.camera} -> ${profile.cameraUid}`);
  } catch (error) {
    apiState.lastError = error instanceof Error ? error.message : String(error);
    addLog(`profile import failed: ${apiState.lastError}`);
  } finally {
    apiState.busy = false;
  }
}

async function bindProfile(): Promise<void> {
  await importProfile();
}

async function checkProfileStatus(): Promise<void> {
  apiState.busy = true;
  try {
    const payload = await apiJson<{ ok: boolean; result: { ok: boolean; data?: Record<string, unknown>; error?: string } }>(
      "/api/profile/status",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraCode: profile.camera }),
      },
    );
    if (!payload.result.ok) {
      throw new Error(payload.result.error || "profile status failed");
    }
    apiState.lastError = "";
    addLog(`profile active quota=${payload.result.data?.remainingQuotaBytes ?? "-"} bytes`);
  } catch (error) {
    apiState.lastError = error instanceof Error ? error.message : String(error);
    addLog(`profile status failed: ${apiState.lastError}`);
  } finally {
    apiState.busy = false;
  }
}

function importCal(): void {
  calibration.active = true;
  calibration.sha = calibration.sha === "未导入" ? "sha256: 8f2c...91a" : calibration.sha;
  addLog(`cal import ${calibration.camera} ${calibration.stream}`);
}

async function onPhotoSelected(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) {
    return;
  }

  calPreview.photoError = "";
  calPreview.photoName = file.name;
  calPreview.photoTime = parseBeijingTimeFromFileName(file.name);

  if (activePhotoUrl) {
    URL.revokeObjectURL(activePhotoUrl);
  }
  activePhotoUrl = URL.createObjectURL(file);
  calPreview.photoUrl = activePhotoUrl;

  if (!calPreview.photoTime) {
    calPreview.photoError = "没有从文件名解析到北京时间，推荐格式：20260316_045758_North_137.jpg";
  }
  addLog(`photo select ${file.name}`);
}

function onPreviewImageLoaded(event: Event): void {
  const image = event.target as HTMLImageElement;
  calPreview.photoWidth = image.naturalWidth;
  calPreview.photoHeight = image.naturalHeight;
  if (!calPreview.platepar) {
    calibration.width = image.naturalWidth;
    calibration.height = image.naturalHeight;
  }
}

async function onCalSelected(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) {
    return;
  }

  calPreview.calError = "";
  calPreview.calName = file.name;
  calibration.path = file.name;

  try {
    const text = await file.text();
    const platepar = parsePlatepar(text);
    calPreview.platepar = platepar;
    calibration.width = platepar.width;
    calibration.height = platepar.height;
    calibration.sha = await sha256FileLabel(file);
    importCal();
  } catch (error) {
    calPreview.platepar = null;
    calPreview.calError = error instanceof Error ? error.message : String(error);
    calibration.sha = "解析失败";
    addLog(`cal parse failed ${file.name}`);
  }
}

function parseBeijingTimeFromFileName(fileName: string): PhotoTime | null {
  const base = fileName.replace(/\.[^.]+$/, "");
  const match = base.match(/(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?:[_-]([^_-]+))?(?:[_-](.+))?/);
  if (!match) {
    return null;
  }

  const [, yyyy, mm, dd, hh, mi, ss, direction = "", suffix = ""] = match;
  const isoWithBeijingOffset = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
  const utc = new Date(isoWithBeijingOffset);
  if (Number.isNaN(utc.getTime())) {
    return null;
  }

  return {
    sourceName: fileName,
    beijingText: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} 北京时间`,
    utcIso: utc.toISOString(),
    direction,
    suffix,
  };
}

function projectSkyCatalog(
  catalog: SkyCatalogPoint[],
  options: { maxItems: number; marginPx: number },
): ProjectedSkyLabel[] {
  const platepar = calPreview.platepar;
  const jd = photoJulianDay.value;
  if (!platepar || !jd) {
    return [];
  }
  const { width, height } = overlaySize.value;

  return catalog
    .map((point) => {
      const projected = projectSkyPointToDisplay({
        raDeg: point.raDeg,
        decDeg: point.decDeg,
        platepar,
        jd,
        displayWidth: width,
        displayHeight: height,
      });
      if (!projected) {
        return null;
      }
      return {
        ...point,
        x: projected.x,
        y: projected.y,
        distance: Math.hypot(projected.x - width / 2, projected.y - height / 2),
      };
    })
    .filter((point): point is ProjectedSkyPoint => Boolean(point))
    .filter((point) => point.x >= options.marginPx && point.y >= options.marginPx && point.x <= width - options.marginPx && point.y <= height - options.marginPx)
    .sort((a, b) => a.distance - b.distance || (a.magnitude ?? 8) - (b.magnitude ?? 8))
    .slice(0, options.maxItems)
    .map(({ distance: _distance, ...point }) => point);
}

function projectConstellationLines(segments: SkyLineSegment[]): ProjectedSkyLine[] {
  const context = buildSkyProjectionContext();
  if (!context) {
    return [];
  }
  const margin = -Math.min(context.width, context.height) * 0.16;

  return segments
    .map((segment) => {
      const from = projectCatalogPoint(segment.from, context);
      const to = projectCatalogPoint(segment.to, context);
      return {
        id: segment.id,
        constellation: segment.constellation,
        fromName: from.name,
        toName: to.name,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        distance: Math.min(from.distance, to.distance),
        visible: isProjectedPointInBounds(from, context, margin) || isProjectedPointInBounds(to, context, margin),
      };
    })
    .filter((line) => line.visible)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 42)
    .map(({ distance: _distance, visible: _visible, ...line }) => line);
}

function buildSkyProjectionContext(): SkyProjectionContext | null {
  const platepar = calPreview.platepar;
  const jd = photoJulianDay.value;
  if (!platepar || !jd) {
    return null;
  }

  const { width, height } = overlaySize.value;
  const fovH = platepar.fovH > 0 ? platepar.fovH : 90;
  const fovV = platepar.fovV > 0 ? platepar.fovV : Math.max(30, (fovH * height) / Math.max(width, 1));
  const baseJd = platepar.jd > 2_000_000 ? platepar.jd : jd;
  const siderealShiftDeg = (jd - baseJd) * 360.98564736629;
  const centerRa = normalizeDegrees(platepar.raDeg + siderealShiftDeg);
  const centerDec = platepar.decDeg;
  const rotation = (((platepar.rotationFromHoriz || platepar.posAngleRef || 0) * Math.PI) / 180) * -1;
  return {
    width,
    height,
    fovH,
    fovV,
    centerRa,
    centerDec,
    cosDec: Math.max(0.18, Math.cos((centerDec * Math.PI) / 180)),
    sinRot: Math.sin(rotation),
    cosRot: Math.cos(rotation),
  };
}

function projectCatalogPoint(point: SkyCatalogPoint, context: SkyProjectionContext): ProjectedSkyPoint {
  const dxDeg = signedAngleDeltaDeg(point.raDeg, context.centerRa) * context.cosDec;
  const dyDeg = point.decDeg - context.centerDec;
  const rotatedX = dxDeg * context.cosRot - dyDeg * context.sinRot;
  const rotatedY = dxDeg * context.sinRot + dyDeg * context.cosRot;
  const x = context.width / 2 + (rotatedX / context.fovH) * context.width;
  const y = context.height / 2 - (rotatedY / context.fovV) * context.height;
  return {
    ...point,
    x,
    y,
    distance: Math.hypot(x - context.width / 2, y - context.height / 2),
  };
}

function isProjectedPointInBounds(point: ProjectedSkyPoint, context: SkyProjectionContext, marginPx: number): boolean {
  return (
    point.x >= marginPx &&
    point.y >= marginPx &&
    point.x <= context.width - marginPx &&
    point.y <= context.height - marginPx
  );
}

function skyPoint(id: string, name: string, raDeg: number, decDeg: number): SkyCatalogPoint {
  return { id, name, raDeg, decDeg };
}

function skyLine(id: string, constellation: string, from: SkyCatalogPoint, to: SkyCatalogPoint): SkyLineSegment {
  return { id, constellation, from, to };
}

function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function signedAngleDeltaDeg(targetDeg: number, centerDeg: number): number {
  const delta = normalizeDegrees(targetDeg - centerDeg);
  return delta > 180 ? delta - 360 : delta;
}

function parsePlatepar(text: string): PlateparPreview {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("当前 UI 先支持 MeteorStation / SkyFit 的 JSON .cal；纯文本 CAL 后面再接解析器");
  }

  const root = asObject(raw, "CAL JSON");
  const platepar =
    root.kind === "meteorstation_skyfit_calibration_bundle" ? asObject(root.platepar, "SkyFit platepar") : root;
  const xPolyFwd = numberArrayValue(platepar, ["x_poly_fwd", "xPolyFwd", "x_poly"], []);
  const yPolyFwd = numberArrayValue(platepar, ["y_poly_fwd", "yPolyFwd", "y_poly"], []);
  const xPolyRev = numberArrayValue(platepar, ["x_poly_rev", "xPolyRev"], xPolyFwd);
  const yPolyRev = numberArrayValue(platepar, ["y_poly_rev", "yPolyRev"], yPolyFwd);

  const preview: PlateparPreview = {
    stationCode: stringValue(platepar, ["station_code", "stationCode"], ""),
    width: numberValue(platepar, ["X_res", "width", "image_width"]),
    height: numberValue(platepar, ["Y_res", "height", "image_height"]),
    lat: numberValue(platepar, ["lat", "latitude"], 0),
    lon: numberValue(platepar, ["lon", "longitude"], 0),
    elev: numberValue(platepar, ["elev", "elevation"], 0),
    jd: numberValue(platepar, ["JD", "jd"], 0),
    fovH: numberValue(platepar, ["fov_h", "fovH"], 0),
    fovV: numberValue(platepar, ["fov_v", "fovV"], 0),
    raDeg: numberValue(platepar, ["RA_d", "raDeg", "ra_d"], 0),
    decDeg: numberValue(platepar, ["dec_d", "decDeg", "DEC_d"], 0),
    posAngleRef: numberValue(platepar, ["pos_angle_ref", "posAngleRef"], 0),
    rotationFromHoriz: numberValue(platepar, ["rotation_from_horiz", "rotationFromHoriz"], 0),
    fScale: numberValue(platepar, ["F_scale", "fScale"], 0),
    distortionType: stringValue(platepar, ["distortion_type", "distortionType"], ""),
    xPolyFwd,
    yPolyFwd,
    xPolyRev,
    yPolyRev,
    refraction: booleanValue(platepar, ["refraction"], true),
    equalAspect: booleanValue(platepar, ["equal_aspect", "equalAspect"], true),
    forceDistortionCentre: booleanValue(platepar, ["force_distortion_centre", "forceDistortionCentre"], false),
    asymmetryCorr: booleanValue(platepar, ["asymmetry_corr", "asymmetryCorr"], false),
  };

  if (preview.width <= 0 || preview.height <= 0) {
    throw new Error("CAL 缺少有效的 X_res / Y_res");
  }
  if (preview.fScale <= 0) {
    throw new Error("CAL 缺少有效的 F_scale");
  }
  return preview;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function numberValue(record: Record<string, unknown>, keys: string[], fallback?: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`CAL 缺少 ${keys.join(" / ")}`);
}

function stringValue(record: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return fallback;
}

function booleanValue(record: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
    }
  }
  return fallback;
}

function numberArrayValue(record: Record<string, unknown>, keys: string[], fallback: number[]): number[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    return value
      .map((entry) => (typeof entry === "number" ? entry : typeof entry === "string" ? Number(entry) : Number.NaN))
      .filter(Number.isFinite);
  }
  return [...fallback];
}

async function sha256FileLabel(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256: ${hex.slice(0, 12)}...${hex.slice(-6)}`;
}

function normalizeUtcIso(value: string): string {
  const clean = value.trim().replace(/^['"]|['"]$/g, "");
  if (!clean) {
    return "";
  }
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(clean) ? clean : `${clean}Z`;
  const date = new Date(withZone);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function inferEventTimeFromEcsv(text: string): string {
  const metaMatch = text.match(/isodate_start_obs:\s*['"]?([^'"\r\n}]+)['"]?/);
  if (metaMatch?.[1]) {
    return normalizeUtcIso(metaMatch[1]);
  }
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("datetime,"));
  const firstData = headerIndex >= 0 ? lines[headerIndex + 1] : "";
  return firstData ? normalizeUtcIso(firstData.split(",")[0] ?? "") : "";
}

async function onEventFileSelected(kind: "ecsv" | "video" | "preview", event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  eventFiles[kind] = file;
  if (!file) {
    return;
  }
  if (kind === "ecsv") {
    eventPackage.ecsvPath = file.name;
    eventPackage.eventId = file.name.replace(/\.[^.]+$/, "");
    const inferred = inferEventTimeFromEcsv(await file.text()) || parseBeijingTimeFromFileName(file.name)?.utcIso || "";
    if (inferred) {
      eventPackage.eventTime = inferred;
    }
  } else if (kind === "video") {
    eventPackage.videoPath = file.name;
    const inferred = parseBeijingTimeFromFileName(file.name)?.utcIso || "";
    if (!eventPackage.eventTime && inferred) {
      eventPackage.eventTime = inferred;
    }
  } else {
    eventPackage.previewPath = file.name;
  }
  addLog(`selected ${kind} ${file.name}`);
}

async function packageEvent(): Promise<void> {
  apiState.busy = true;
  try {
    let payload: { ok: boolean; queue: Array<Record<string, unknown>> };
    if (eventFiles.ecsv) {
      const form = new FormData();
      form.append("localEventId", eventPackage.eventId);
      form.append("eventTimeUtc", eventPackage.eventTime);
      form.append("cameraCode", eventPackage.cameraCode || profile.camera);
      form.append("stationCode", eventPackage.stationCode);
      form.append("ecsv", eventFiles.ecsv);
      if (eventFiles.video) {
        form.append("video", eventFiles.video);
      }
      if (eventFiles.preview) {
        form.append("preview", eventFiles.preview);
      }
      payload = await apiJson("/api/event/package-files", { method: "POST", body: form });
    } else {
      payload = await apiJson("/api/event/package-paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localEventId: eventPackage.eventId,
          eventTimeUtc: eventPackage.eventTime,
          cameraCode: eventPackage.cameraCode || profile.camera,
          stationCode: eventPackage.stationCode,
          ecsvPath: eventPackage.ecsvPath,
          videoPath: eventPackage.videoPath,
          previewPath: eventPackage.previewPath,
          outputDir: eventPackage.outputDir,
        }),
      });
    }
    queue.value = queueFromApi(payload.queue);
    apiState.lastError = "";
    activeTab.value = "queue";
    addLog(`packaged and queued ${eventPackage.eventId}`);
  } catch (error) {
    apiState.lastError = error instanceof Error ? error.message : String(error);
    addLog(`package failed: ${apiState.lastError}`);
  } finally {
    apiState.busy = false;
  }
}

async function runWorker(): Promise<void> {
  const hasRunnable = queue.value.some((entry) => entry.status === "queued" || entry.status === "failed_retriable");
  const message = hasRunnable
    ? "This will upload queued event files to MeteorLive. Continue?"
    : "No queued event is visible. The worker can still poll running jobs. Continue?";
  if (!window.confirm(message)) {
    return;
  }
  apiState.busy = true;
  try {
    const payload = await apiJson<{
      ok: boolean;
      worker: { uploaded: number; polled: number };
      queue: Array<Record<string, unknown>>;
    }>("/api/worker/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });
    queue.value = queueFromApi(payload.queue);
    apiState.lastError = "";
    addLog(`worker uploaded=${payload.worker.uploaded} polled=${payload.worker.polled}`);
  } catch (error) {
    apiState.lastError = error instanceof Error ? error.message : String(error);
    addLog(`worker failed: ${apiState.lastError}`);
    await refreshQueue();
  } finally {
    apiState.busy = false;
  }
}

async function markSelectedDone(): Promise<void> {
  await refreshQueue();
}

async function resetDemo(): Promise<void> {
  logs.value = [];
  await refreshQueue();
  addLog("workspace refreshed");
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">
          <Telescope :size="22" />
        </div>
        <div>
          <h1>MeteorAstroLive</h1>
          <p>Astrometry Upload Desk</p>
        </div>
      </div>

      <nav class="nav-list" aria-label="Workspace">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="nav-item"
          :class="{ active: activeTab === tab.key }"
          type="button"
          @click="activeTab = tab.key"
        >
          <component :is="tab.icon" :size="18" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <div class="sidebar-status">
        <div class="status-dot"></div>
        <span>{{ apiState.online ? "API Online" : "API Offline" }}</span>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div>
          <h2>{{ tabs.find((tab) => tab.key === activeTab)?.label }}</h2>
          <p>{{ profile.camera }} / {{ profile.cameraUid }} / {{ eventPackage.eventId }}</p>
        </div>
        <div class="topbar-actions">
          <button class="icon-button" type="button" title="Run worker" :disabled="apiState.busy || !apiState.online" @click="runWorker">
            <Play :size="18" />
          </button>
          <button class="icon-button" type="button" title="Refresh" :disabled="apiState.busy" @click="checkApi">
            <RefreshCw :size="18" />
          </button>
          <button class="icon-button" type="button" title="Refresh queue" :disabled="apiState.busy" @click="resetDemo">
            <RotateCcw :size="18" />
          </button>
        </div>
      </header>

      <section v-if="activeTab === 'overview'" class="page-grid overview-grid">
        <div class="panel metric">
          <CloudUpload :size="22" />
          <div>
            <span>Queued</span>
            <strong>{{ statusCounts.queued }}</strong>
          </div>
        </div>
        <div class="panel metric">
          <Activity :size="22" />
          <div>
            <span>Running</span>
            <strong>{{ statusCounts.job_running }}</strong>
          </div>
        </div>
        <div class="panel metric">
          <CheckCircle2 :size="22" />
          <div>
            <span>Succeeded</span>
            <strong>{{ statusCounts.succeeded }}</strong>
          </div>
        </div>
        <div class="panel metric">
          <ShieldCheck :size="22" />
          <div>
            <span>Binding</span>
            <strong>{{ profile.enabled ? "Ready" : "Off" }}</strong>
          </div>
        </div>

        <div class="panel wide">
          <div class="panel-title">
            <SquareStack :size="18" />
            <h3>Pipeline</h3>
          </div>
          <div class="flow-row">
            <span>Profile</span>
            <span>CAL</span>
            <span>Event</span>
            <span>Package</span>
            <span>Upload</span>
          </div>
        </div>

        <div class="panel wide">
          <div class="panel-title">
            <Database :size="18" />
            <h3>Latest Queue</h3>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Camera</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in queue.slice(0, 4)" :key="item.id">
                <td>{{ item.eventId }}</td>
                <td>{{ item.camera }}</td>
                <td><span class="pill" :class="item.status">{{ item.status }}</span></td>
                <td>{{ item.updated }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeTab === 'profile'" class="page-grid two-col">
        <div class="panel">
          <div class="panel-title">
            <KeyRound :size="18" />
            <h3>Cloud Profile</h3>
          </div>
          <label>Profile JSON<input v-model="profile.path" /></label>
          <label>Local Camera<input v-model="profile.camera" /></label>
          <label>Device Key<input v-model="profile.keyId" /></label>
          <div class="button-row">
            <button type="button" :disabled="apiState.busy || !apiState.online" @click="importProfile">
              <FolderOpen :size="17" />Import
            </button>
            <button type="button" :disabled="apiState.busy || !apiState.online" @click="checkProfileStatus">
              <ShieldCheck :size="17" />Status
            </button>
          </div>
          <div v-if="apiState.lastError" class="notice danger">
            <AlertTriangle :size="16" />
            <span>{{ apiState.lastError }}</span>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">
            <Camera :size="18" />
            <h3>Cloud Camera</h3>
          </div>
          <label>Station UID<input v-model="profile.stationUid" /></label>
          <label>Camera UID<input v-model="profile.cameraUid" /></label>
          <div class="binding-box">
            <BadgeCheck :size="18" />
            <span>{{ profile.camera }} -> {{ profile.cameraUid }}</span>
          </div>
          <div class="kv"><span>API</span><strong>{{ apiState.online ? "online" : "offline" }}</strong></div>
          <div class="kv"><span>Data Dir</span><strong>{{ apiState.dataDir || "-" }}</strong></div>
        </div>
      </section>

      <section v-if="activeTab === 'calibration'" class="page-grid cal-page">
        <div class="panel cal-inputs">
          <div class="panel-title">
            <Telescope :size="18" />
            <h3>CAL 矫正</h3>
          </div>

          <div class="file-grid">
            <label class="file-input">
              <span><ImageIcon :size="16" />照片</span>
              <input type="file" accept="image/*" @change="onPhotoSelected" />
            </label>
            <label class="file-input">
              <span><FileUp :size="16" />.cal / platepar</span>
              <input type="file" accept=".cal,.json,application/json" @change="onCalSelected" />
            </label>
          </div>

          <label>Camera<input v-model="calibration.camera" /></label>
          <label>Stream<select v-model="calibration.stream"><option value="main">main</option><option value="sub">sub</option></select></label>
          <label>CAL Path<input v-model="calibration.path" /></label>

          <div class="switch-row">
            <label class="check-row">
              <input v-model="calPreview.overlayEnabled" type="checkbox" />
              <span>显示叠加层</span>
            </label>
            <label class="check-row">
              <input v-model="calPreview.showConstellationLines" type="checkbox" />
              <span>星座连线</span>
            </label>
            <label class="check-row">
              <input v-model="calPreview.showConstellations" type="checkbox" />
              <span>星座名</span>
            </label>
            <label class="check-row">
              <input v-model="calPreview.showBrightStars" type="checkbox" />
              <span>亮星名</span>
            </label>
            <button type="button" @click="calibration.active = true; addLog('activate cal')">
              <ShieldCheck :size="17" />Activate
            </button>
          </div>

          <div v-if="calPreview.photoError" class="notice warning">
            <AlertTriangle :size="16" />
            <span>{{ calPreview.photoError }}</span>
          </div>
          <div v-if="calPreview.calError" class="notice danger">
            <AlertTriangle :size="16" />
            <span>{{ calPreview.calError }}</span>
          </div>
        </div>

        <div class="panel cal-summary">
          <div class="panel-title">
            <Braces :size="18" />
            <h3>解析结果</h3>
          </div>
          <div class="kv"><span>照片</span><strong>{{ calPreview.photoName || "未选择" }}</strong></div>
          <div class="kv"><span>照片时间</span><strong>{{ calPreview.photoTime?.beijingText || "未解析" }}</strong></div>
          <div class="kv"><span>UTC</span><strong>{{ calPreview.photoTime?.utcIso || "未解析" }}</strong></div>
          <div class="kv"><span>方向 / 后缀</span><strong>{{ calPreview.photoTime?.direction || "-" }} {{ calPreview.photoTime?.suffix || "" }}</strong></div>
          <div class="kv"><span>CAL</span><strong>{{ calPreview.calName || "未选择" }}</strong></div>
          <div class="kv"><span>Resolution</span><strong>{{ calibration.width }} x {{ calibration.height }}</strong></div>
          <div class="kv"><span>Hash</span><strong>{{ calibration.sha }}</strong></div>
        </div>

        <div class="panel overlay-panel wide">
          <div class="panel-title">
            <CalendarClock :size="18" />
            <h3>照片 + CAL 叠加预览</h3>
            <span class="panel-note">{{ calResolutionNote || "先选择照片和 CAL" }}</span>
          </div>

          <div v-if="calPreview.photoUrl" class="image-overlay-wrap">
            <img :src="calPreview.photoUrl" alt="Calibration preview" @load="onPreviewImageLoaded" />
            <svg
              v-if="calPreview.overlayEnabled"
              class="cal-overlay"
              :viewBox="`0 0 ${overlaySize.width} ${overlaySize.height}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <line
                v-for="(line, index) in overlayGrid"
                :key="`grid-${index}`"
                :x1="line.x1"
                :y1="line.y1"
                :x2="line.x2"
                :y2="line.y2"
                :class="{ strong: line.strong }"
              />
              <g v-if="calPreview.showConstellationLines" class="constellation-lines">
                <polyline
                  v-for="line in projectedConstellationLines"
                  :key="`constellation-line-${line.id}`"
                  class="constellation-line"
                  :points="line.points.map((point) => `${point.x},${point.y}`).join(' ')"
                />
              </g>
              <line class="axis north" v-bind="compassLines.north" />
              <line class="axis east" v-bind="compassLines.east" />
              <circle class="axis-center" :cx="compassLines.center.x" :cy="compassLines.center.y" r="4" />
              <text :x="compassLines.north.x2 + 7" :y="compassLines.north.y2">N</text>
              <text :x="compassLines.east.x2 + 7" :y="compassLines.east.y2">E</text>
              <text x="18" y="30">{{ calPreview.photoTime?.beijingText || "未解析照片时间" }}</text>
              <text x="18" y="56">UTC {{ calPreview.photoTime?.utcIso || "-" }}</text>
              <text x="18" y="82">
                RA {{ calPreview.platepar?.raDeg ?? "-" }} / Dec {{ calPreview.platepar?.decDeg ?? "-" }}
              </text>
              <text x="18" y="108">
                FOV {{ calPreview.platepar?.fovH ?? "-" }} x {{ calPreview.platepar?.fovV ?? "-" }}
              </text>
              <g v-if="calPreview.showConstellations">
                <g
                  v-for="label in projectedConstellations"
                  :key="`constellation-${label.id}`"
                  class="sky-label constellation-label"
                >
                  <rect :x="label.x - 26" :y="label.y - 16" width="52" height="22" rx="5" />
                  <text :x="label.x" :y="label.y">{{ label.name }}</text>
                </g>
              </g>
              <g v-if="calPreview.showBrightStars">
                <g v-for="star in projectedBrightStars" :key="`star-${star.id}`" class="sky-label star-label">
                  <circle :cx="star.x" :cy="star.y" r="3.5" />
                  <text :x="star.x + 8" :y="star.y + 4">{{ star.name }}</text>
                </g>
              </g>
            </svg>
          </div>

          <div v-else class="empty-preview">
            <ImageIcon :size="38" />
            <span>选择一张带时间文件名的照片，例如 20260316_045758_North_137.jpg</span>
          </div>

          <div class="overlay-footnote">
            {{ skyProjectionNote }}。当前叠加层把文件名中的北京时间转换为 UTC，供后续星表投影和 ECSV 时间使用；CAL 文件里的 JD
            只作为标定来源信息，不覆盖照片事件时间。
          </div>
        </div>

        <div class="panel wide">
          <div class="panel-title">
            <Braces :size="18" />
            <h3>Platepar Summary</h3>
          </div>
          <div class="summary-grid">
            <div class="kv"><span>Station</span><strong>{{ calPreview.platepar?.stationCode || "-" }}</strong></div>
            <div class="kv"><span>Lat / Lon</span><strong>{{ calPreview.platepar ? `${calPreview.platepar.lat}, ${calPreview.platepar.lon}` : "-" }}</strong></div>
            <div class="kv"><span>Elev</span><strong>{{ calPreview.platepar?.elev ?? "-" }}</strong></div>
            <div class="kv"><span>F Scale</span><strong>{{ calPreview.platepar?.fScale ?? "-" }}</strong></div>
            <div class="kv"><span>Rotation</span><strong>{{ calPreview.platepar?.rotationFromHoriz ?? "-" }}</strong></div>
            <div class="kv"><span>Distortion</span><strong>{{ calPreview.platepar?.distortionType || "-" }}</strong></div>
            <div class="kv"><span>CAL JD</span><strong>{{ calPreview.platepar?.jd ?? "-" }}</strong></div>
            <div class="kv"><span>Active</span><strong>{{ calibration.active ? "Yes" : "No" }}</strong></div>
          </div>
        </div>
      </section>

      <section v-if="activeTab === 'event'" class="page-grid two-col">
        <div class="panel">
          <div class="panel-title">
            <FileJson :size="18" />
            <h3>Event Package</h3>
          </div>
          <label>Event ID<input v-model="eventPackage.eventId" /></label>
          <label>Event Time<input v-model="eventPackage.eventTime" /></label>
          <label>Camera Code<input v-model="eventPackage.cameraCode" /></label>
          <label>Station Code<input v-model="eventPackage.stationCode" /></label>
          <label>ECSV Path<input v-model="eventPackage.ecsvPath" /></label>
          <label>Output Dir<input v-model="eventPackage.outputDir" /></label>
          <div class="file-grid">
            <label class="file-input">
              <span><FileUp :size="16" />Select ECSV</span>
              <input type="file" accept=".ecsv,text/plain" @change="onEventFileSelected('ecsv', $event)" />
            </label>
            <label class="file-input">
              <span><FileUp :size="16" />Select Video</span>
              <input type="file" accept="video/*,.mp4,.avi,.mov,.mkv" @change="onEventFileSelected('video', $event)" />
            </label>
          </div>
          <div class="button-row">
            <button type="button" :disabled="apiState.busy || !apiState.online" @click="packageEvent">
              <SquareStack :size="17" />Package Queue
            </button>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">
            <FolderOpen :size="18" />
            <h3>Media</h3>
          </div>
          <label>Video<input v-model="eventPackage.videoPath" /></label>
          <label>Preview<input v-model="eventPackage.previewPath" /></label>
          <label class="file-input single-file">
            <span><ImageIcon :size="16" />Select Preview</span>
            <input type="file" accept="image/*" @change="onEventFileSelected('preview', $event)" />
          </label>
          <div class="kv"><span>Upload Camera</span><strong>{{ profile.camera }}</strong></div>
          <div class="kv"><span>Manifest Camera UID</span><strong>{{ profile.cameraUid }}</strong></div>
          <div class="kv"><span>Selected ECSV</span><strong>{{ eventFiles.ecsv?.name || "-" }}</strong></div>
          <div class="kv"><span>Selected Video</span><strong>{{ eventFiles.video?.name || "-" }}</strong></div>
        </div>
      </section>

      <section v-if="activeTab === 'queue'" class="page-grid">
        <div class="panel wide">
          <div class="panel-title">
            <UploadCloud :size="18" />
            <h3>Upload Queue</h3>
            <div class="panel-actions">
              <button type="button" :disabled="apiState.busy || !apiState.online" @click="runWorker">
                <Play :size="17" />Upload
              </button>
              <button type="button" :disabled="apiState.busy || !apiState.online" @click="markSelectedDone">
                <RefreshCw :size="17" />Refresh
              </button>
            </div>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Event</th>
                <th>Camera</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Remote Job</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in queue" :key="item.id">
                <td>{{ item.id }}</td>
                <td>{{ item.eventId }}</td>
                <td>{{ item.camera }}</td>
                <td><span class="pill" :class="item.status">{{ item.status }}</span></td>
                <td>{{ item.updated }}</td>
                <td>{{ item.remoteJobUid || "-" }}</td>
                <td>{{ item.errorMessage || "-" }}</td>
              </tr>
              <tr v-if="queue.length === 0">
                <td colspan="7">No upload queue rows.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeTab === 'logs'" class="page-grid">
        <div class="panel wide log-panel">
          <div class="panel-title">
            <ListChecks :size="18" />
            <h3>Run Log</h3>
          </div>
          <pre>{{ logs.join('\n') }}</pre>
        </div>
      </section>
    </main>
  </div>
</template>
