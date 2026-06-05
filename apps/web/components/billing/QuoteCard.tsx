"use client";

import { useMemo, useState } from "react";
import { useQuote } from "@/lib/hooks";
import { formatUsd } from "@/lib/contracts";
import { cx, miBToGiB } from "@/lib/utils";
import type { ResourceSize } from "@/lib/types";

const PRESETS: { id: string; label: string; size: ResourceSize }[] = [
  { id: "nano", label: "Nano", size: { vcpu: 1, memMiB: 1024, diskGiB: 10 } },
  { id: "small", label: "Small", size: { vcpu: 2, memMiB: 4096, diskGiB: 40 } },
  { id: "medium", label: "Medium", size: { vcpu: 4, memMiB: 8192, diskGiB: 80 } },
  { id: "large", label: "Large", size: { vcpu: 8, memMiB: 16384, diskGiB: 160 } },
];

const HOUR_PRESETS = [1, 24, 168, 720];

export function QuoteCard() {
  const [size, setSize] = useState<ResourceSize>(PRESETS[1].size);
  const [hours, setHours] = useState<number>(24);

  const activePreset = useMemo(
    () =>
      PRESETS.find(
        (p) =>
          p.size.vcpu === size.vcpu &&
          p.size.memMiB === size.memMiB &&
          p.size.diskGiB === size.diskGiB,
      )?.id ?? "custom",
    [size],
  );

  const { data: quote, isFetching, isError, error } = useQuote(size, hours);

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Estimate compute
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Pick a CVM size and a duration for a live price.
          </p>
        </div>
      </div>

      {/* Presets */}
      <div className="mt-5">
        <label className="label">Size</label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setSize(p.size)}
              className={cx(
                "rounded-xl border p-2.5 text-left transition",
                activePreset === p.id
                  ? "border-blue-500 bg-blue-50"
                  : "border-slate-300 bg-white hover:border-slate-400",
              )}
            >
              <p className="text-sm font-medium text-slate-900">{p.label}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {p.size.vcpu} vCPU · {miBToGiB(p.size.memMiB)} GiB
              </p>
              <p className="text-[11px] text-slate-400">
                {p.size.diskGiB} GiB disk
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Custom sliders */}
      <div className="mt-5 space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-[11px] uppercase tracking-wide text-slate-400">
          Or fine-tune
        </p>
        <Slider
          label="vCPU"
          value={size.vcpu}
          min={1}
          max={16}
          step={1}
          onChange={(v) => setSize((s) => ({ ...s, vcpu: v }))}
          format={(v) => `${v} vCPU`}
        />
        <Slider
          label="Memory"
          value={size.memMiB}
          min={512}
          max={32768}
          step={512}
          onChange={(v) => setSize((s) => ({ ...s, memMiB: v }))}
          format={(v) => `${miBToGiB(v)} GiB`}
        />
        <Slider
          label="Disk"
          value={size.diskGiB}
          min={5}
          max={500}
          step={5}
          onChange={(v) => setSize((s) => ({ ...s, diskGiB: v }))}
          format={(v) => `${v} GiB`}
        />
      </div>

      {/* Hours */}
      <div className="mt-5">
        <label className="label">Duration</label>
        <div className="flex flex-wrap items-center gap-2">
          {HOUR_PRESETS.map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className={cx(
                "rounded-lg border px-2.5 py-1 text-xs transition",
                hours === h
                  ? "border-blue-400 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700",
              )}
            >
              {labelForHours(h)}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <input
              type="number"
              min={1}
              className="input w-24"
              value={hours}
              onChange={(e) =>
                setHours(Math.max(1, Math.round(Number(e.target.value) || 1)))
              }
            />
            <span className="text-xs text-slate-400">hours</span>
          </div>
        </div>
      </div>

      {/* Quote breakdown */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-paper p-4">
        {isError ? (
          <p className="text-sm text-red-600">
            Could not fetch quote: {(error as Error)?.message}
          </p>
        ) : (
          <div
            className={cx(
              "space-y-2.5 transition-opacity",
              isFetching && !quote ? "opacity-40" : "opacity-100",
            )}
          >
            <Row
              label="Phala cost"
              hint="what the provider charges us"
              value={quote ? formatUsd(quote.phalaCostUsd) : "—"}
            />
            <Row
              label="Markup (+20%)"
              hint="our margin"
              value={quote ? `+ ${formatUsd(quote.marginUsd)}` : "—"}
              valueClass="text-blue-600"
            />
            <div className="border-t border-slate-200 pt-2.5">
              <Row
                label="Your price"
                hint={`for ${labelForHours(hours)}`}
                value={quote ? formatUsd(quote.priceUsd) : "—"}
                big
              />
            </div>
            <p className="pt-1 text-[11px] text-slate-400">
              {quote
                ? `${quote.resources.vcpu} vCPU · ${miBToGiB(
                    quote.resources.memMiB,
                  )} GiB · ${quote.resources.diskGiB} GiB disk × ${quote.hours} h · markup ${quote.markup}×`
                : "Adjust the size or duration."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  valueClass,
  big,
}: {
  label: string;
  hint?: string;
  value: string;
  valueClass?: string;
  big?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-slate-600">
        {label}
        {hint && <span className="ml-1.5 text-xs text-slate-400">{hint}</span>}
      </span>
      <span
        className={cx(
          big ? "text-2xl font-bold text-slate-900" : "text-sm font-medium text-slate-900",
          valueClass,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs text-slate-500">{label}</span>
        <span className="font-mono text-xs text-slate-700">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-100 accent-blue-600"
      />
    </div>
  );
}

function labelForHours(h: number): string {
  if (h === 1) return "1 hour";
  if (h === 24) return "1 day";
  if (h === 168) return "1 week";
  if (h === 720) return "1 month";
  if (h % 720 === 0) return `${h / 720} months`;
  if (h % 168 === 0) return `${h / 168} weeks`;
  if (h % 24 === 0) return `${h / 24} days`;
  return `${h} hours`;
}
