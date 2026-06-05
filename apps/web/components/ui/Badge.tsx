import { cx } from "@/lib/utils";

type Tone = "running" | "pending" | "stopped" | "error" | "neutral" | "tee";

const TONE_CLASSES: Record<Tone, string> = {
  running: "bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-500/30",
  pending: "bg-amber-400/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  stopped: "bg-slate-500/15 text-slate-600 ring-1 ring-inset ring-slate-500/30",
  error: "bg-red-50 text-red-600 ring-1 ring-inset ring-red-500/30",
  neutral: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-300",
  tee: "bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-500/30",
};

const DOT_CLASSES: Record<Tone, string> = {
  running: "bg-blue-500",
  pending: "bg-amber-300 animate-pulse",
  stopped: "bg-slate-400",
  error: "bg-red-400",
  neutral: "bg-slate-500",
  tee: "bg-blue-500",
};

export function toneForStatus(status: string): Tone {
  const s = status.toLowerCase();
  if (s.includes("run")) return "running";
  if (s.includes("provision") || s.includes("pending") || s.includes("start"))
    return "pending";
  if (s.includes("error") || s.includes("fail")) return "error";
  if (s.includes("stop") || s.includes("down") || s.includes("destroy"))
    return "stopped";
  return "neutral";
}

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={cx("badge", TONE_CLASSES[tone], className)}>
      {dot && (
        <span className={cx("h-1.5 w-1.5 rounded-full", DOT_CLASSES[tone])} />
      )}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = toneForStatus(status);
  return (
    <Badge tone={tone} dot>
      {status}
    </Badge>
  );
}
