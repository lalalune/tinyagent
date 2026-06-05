import { cx } from "@/lib/utils";

/** TinyAgent mark — a sealed cube (sovereignty) with an orbiting node. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cx("h-7 w-7", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ta-grad" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <path
        d="M16 3 27 9v14L16 29 5 23V9l11-6Z"
        stroke="url(#ta-grad)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M16 3v26M5 9l11 6 11-6M16 15v14"
        stroke="url(#ta-grad)"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <circle cx="16" cy="15" r="2.6" fill="url(#ta-grad)" />
    </svg>
  );
}

export function Logo({
  className,
  withWordmark = true,
}: {
  className?: string;
  withWordmark?: boolean;
}) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      {withWordmark && (
        <span className="text-base font-semibold tracking-tight text-slate-900">
          Tiny<span className="text-blue-600">Agent</span>
        </span>
      )}
    </span>
  );
}
