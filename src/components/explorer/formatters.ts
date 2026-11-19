import type { FsEntry } from "../../types/labbridge";

export type SortField = "name" | "size" | "mtime";
export type SortDirection = "asc" | "desc";

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${Math.round(val)} B` : `${val.toFixed(1)} ${units[idx]}`;
}

export function formatThroughputMBps(speedBps: number): string {
  if (!Number.isFinite(speedBps) || speedBps <= 0) return "0.00 MB/s";
  const mbps = speedBps / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

export function formatMtime(epochSecs: number | null): string {
  if (!epochSecs) return "—";
  const dt = new Date(epochSecs * 1000);
  if (Number.isNaN(dt.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(
    dt.getDate(),
  )} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function splitBreadcrumbs(
  path: string,
  isRemote: boolean,
): BreadcrumbSegment[] {
  if (!path) return [];

  if (isRemote) {
    const clean = path.replace(/\\/g, "/");
    const segments = clean.split("/").filter(Boolean);
    const out: BreadcrumbSegment[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const seg of segments) {
      acc += `/${seg}`;
      out.push({ label: seg, path: acc });
    }
    return out;
  }

  // Local path: handle Windows drive root (`C:\...`) or POSIX root (`/...`)
  const winDriveMatch = path.match(/^([A-Za-z]:)(?:[\\/](.*))?$/);
  if (winDriveMatch) {
    const drive = winDriveMatch[1];
    const rest = winDriveMatch[2] ?? "";
    const out: BreadcrumbSegment[] = [{ label: `${drive}\\`, path: `${drive}\\` }];
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    let acc = drive;
    for (const part of parts) {
      acc += `\\${part}`;
      out.push({ label: part, path: acc });
    }
    return out;
  }

  const parts = path.split("/").filter(Boolean);
  const out: BreadcrumbSegment[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

export function filterAndSortEntries(
  entries: FsEntry[],
  filterQuery: string,
  sortField: SortField,
  sortDir: SortDirection,
): FsEntry[] {
  const q = filterQuery.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => e.name.toLowerCase().includes(q))
    : entries;

  const mult = sortDir === "asc" ? 1 : -1;

  return [...filtered].sort((a, b) => {
    // Keep directories grouped above files
    if (a.is_dir_like !== b.is_dir_like) {
      return a.is_dir_like ? -1 : 1;
    }

    switch (sortField) {
      case "size": {
        if (a.size !== b.size) {
          return (a.size - b.size) * mult;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      }
      case "mtime": {
        const ma = a.mtime ?? 0;
        const mb = b.mtime ?? 0;
        if (ma !== mb) {
          return (ma - mb) * mult;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      }
      case "name":
      default:
        return (
          a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          }) * mult
        );
    }
  });
}
