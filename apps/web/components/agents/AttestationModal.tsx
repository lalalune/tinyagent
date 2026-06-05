"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { qk } from "@/lib/hooks";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { CopyButton } from "@/components/ui/CopyButton";
import type { DeployedAgent } from "@/lib/types";

export function AttestationModal({
  agent,
  open,
  onClose,
}: {
  agent: DeployedAgent;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: qk.attestation(agent.name),
    queryFn: ({ signal }) => api.attestation(agent.name, signal),
    enabled: open,
  });

  const isTee = data?.mode === "dstack";
  const isLightning = agent.provider === "lightning";
  const resourceNoun = isLightning ? "sandbox" : "agent";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2.5">
          Attestation · <span className="font-mono text-base">{agent.name}</span>
          {data &&
            (isTee ? (
              <Badge tone="tee" dot>
                Intel TDX
              </Badge>
            ) : (
              <Badge tone="neutral">not a TEE</Badge>
            ))}
        </span>
      }
      description="Cryptographic proof of what code is running and where. Verify the quote against the expected compose hash."
      footer={
        <button onClick={onClose} className="btn-ghost">
          Close
        </button>
      }
    >
      {isLoading && <AttestationSkeleton />}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          Could not load attestation: {(error as Error).message}
        </p>
      )}

      {data && !isTee && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-600">
            {data.message ??
              `This ${resourceNoun} does not run inside a Trusted Execution Environment, so no hardware attestation is available.`}
          </p>
          <p className="mt-3 text-xs text-slate-400">
            Deploy with the <span className="font-mono">dstack-cvm</span>{" "}
            provider to get a verifiable Intel-TDX quote.
          </p>
        </div>
      )}

      {data && isTee && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="App ID" value={data.appId} mono />
            <Field label="Instance ID" value={data.instanceId} mono />
            <Field label="Timestamp" value={data.timestamp} />
            <Field label="Mode" value="dstack (Intel TDX)" />
          </div>

          <QuoteBlock label="Compose hash (expected measurement)" value={data.composeHash} />
          <QuoteBlock label="TDX quote" value={data.quote} mono />
          {data.eventLog && (
            <QuoteBlock label="Event log" value={data.eventLog} mono />
          )}

          {data.message && (
            <p className="rounded-lg border border-blue-600/25 bg-blue-600/5 px-3 py-2 text-xs text-blue-700">
              {data.message}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p
        className={`mt-0.5 truncate text-sm text-slate-700 ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value || "—"}
      </p>
    </div>
  );
}

function QuoteBlock({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-slate-400">
          {label}
        </p>
        <CopyButton value={value} />
      </div>
      <pre
        className={`max-h-40 overflow-auto rounded-lg border border-slate-200 bg-paper p-3 text-xs text-slate-600 ${mono ? "font-mono" : ""}`}
      >
        <code className="break-all">{value}</code>
      </pre>
    </div>
  );
}

function AttestationSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-12 w-full" />
        ))}
      </div>
      <div className="skeleton h-24 w-full" />
      <div className="skeleton h-32 w-full" />
    </div>
  );
}
