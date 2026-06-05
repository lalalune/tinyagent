import { cx } from "@/lib/utils";

/**
 * The tinycloud.xyz "window" motif: a card with a macOS title bar (red/yellow/
 * green traffic-light dots) and an optional monospace title. Used to frame
 * technical content so the console reads like a developer tool.
 */
export function WindowChrome({
  title,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={cx("card overflow-hidden", className)}>
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50/80 px-4 py-2.5">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-win-red" />
          <span className="h-3 w-3 rounded-full bg-win-yellow" />
          <span className="h-3 w-3 rounded-full bg-win-green" />
        </span>
        {title && (
          <span className="ml-2 truncate font-mono text-xs text-slate-400">{title}</span>
        )}
      </div>
      <div className={cx("p-5", bodyClassName)}>{children}</div>
    </div>
  );
}
