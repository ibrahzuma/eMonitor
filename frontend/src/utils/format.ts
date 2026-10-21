/** Formatting helpers. API timestamps are UTC ISO strings; we render them in the user's time zone. */

/** Best-effort registrable domain (mirrors the backend): www.qalaam.co.tz → qalaam.co.tz. */
const SLD = new Set(["co", "com", "net", "org", "ac", "go", "gov", "edu", "or", "ne", "mil", "sch", "nic", "info", "biz",
  "ltd", "plc", "me", "web", "gen", "firm", "nom", "int", "mobi", "tv", "sc", "us"]);
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  if (labels[labels.length - 1].length === 2 && SLD.has(labels[labels.length - 2])) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return "";
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

let activeTimeZone: string = browserTimeZone();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function setDisplayTimeZone(tz: string | null | undefined): void {
  activeTimeZone = tz && isValidTimeZone(tz) ? tz : browserTimeZone();
}

export function getDisplayTimeZone(): string {
  return activeTimeZone;
}

export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const zones = intl.supportedValuesOf?.("timeZone") ?? [];
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

export function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(typeof v === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(v: string | number | Date | null | undefined, opts: { seconds?: boolean } = {}): string {
  const d = toDate(v);
  if (!d) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: activeTimeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: opts.seconds ? "2-digit" : undefined,
    hour12: false,
  }).format(d);
}

export function formatDate(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  return new Intl.DateTimeFormat(undefined, { timeZone: activeTimeZone, year: "numeric", month: "short", day: "2-digit" })
    .format(d);
}

export function formatTime(v: string | number | Date | null | undefined, seconds = false): string {
  const d = toDate(v);
  if (!d) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: activeTimeZone, hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hour12: false,
  }).format(d);
}

/** Axis tick formatter: time for short ranges, date+time for longer ranges. */
export function formatTick(v: string | number, rangeSeconds: number): string {
  const d = toDate(v);
  if (!d) return "";
  if (rangeSeconds <= 86400) return formatTime(d);
  if (rangeSeconds <= 7 * 86400) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: activeTimeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { timeZone: activeTimeZone, month: "short", day: "2-digit" }).format(d);
}

const RTF = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

export function formatRelative(v: string | number | Date | null | undefined, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d || !RTF) return "—";
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff <= 0 ? "just now" : "in a few seconds";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60], ["hour", 3600], ["day", 86400], ["week", 604800], ["month", 2629800], ["year", 31557600],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let div = 60;
  for (const [u, s] of units) {
    if (abs >= s) {
      unit = u;
      div = s;
    }
  }
  return RTF.format(Math.round(diff / div), unit);
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatNumber(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatPercent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function formatMs(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v >= 10000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.round(v)} ms`;
}

export function formatBytes(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = Math.abs(v);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${v < 0 ? "-" : ""}${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatBits(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let n = Math.abs(v);
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Convert a UTC ISO string to the value of an <input type="datetime-local"> in the given time zone. */
export function isoToLocalInput(iso: string | null | undefined, tz: string = activeTimeZone): string {
  const d = toDate(iso);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Offset (minutes) of a time zone at a given instant. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - date.getTime()) / 60000;
}

/** Interpret a datetime-local value as wall-clock time in `tz` and return a UTC ISO string. */
export function localInputToIso(value: string, tz: string = activeTimeZone): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let ts = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(ts), tz);
  if (off2 !== off1) ts = guess - off2 * 60000;
  return new Date(ts).toISOString();
}

export function rangeToSeconds(range: string): number {
  const m = /^(\d+)([mhd])$/.exec(range);
  if (!m) return 86400;
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n * 86400;
}

/** Parse "a, b ,c" into a trimmed, de-duplicated list. */
export function splitList(s: string): string[] {
  return Array.from(new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)));
}
