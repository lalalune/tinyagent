/** Small presentation helpers shared across components. Keep this module pure
 * (no React imports) so it can be used from Server Components too. */

/** Join class names, dropping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Shorten an 0x address to 0x1234…abcd. */
export function shortAddress(addr?: string, lead = 6, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= lead + tail + 1) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

/** Shorten any long opaque id/hash for display. */
export function shortHash(s?: string, lead = 10, tail = 8): string {
  if (!s) return "";
  if (s.length <= lead + tail + 1) return s;
  return `${s.slice(0, lead)}…${s.slice(-tail)}`;
}

/** Human-friendly relative time, e.g. "5h ago", "just now". */
export function timeAgo(iso?: string): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Format a byte count as KB/MB/GB. */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** GiB helper from MiB. */
export function miBToGiB(memMiB: number): number {
  return Math.round((memMiB / 1024) * 100) / 100;
}
