"use client";

import { useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { CopyButton } from "@/components/ui/CopyButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AttestationModal } from "./AttestationModal";
import { TunnelHintModal } from "./TunnelHintModal";
import {
  useAgentStatus,
  useBackupAgent,
  useDownAgent,
  useRecoverAgent,
} from "@/lib/hooks";
import { useToast } from "@/components/ui/Toast";
import { formatBytes, shortHash, timeAgo } from "@/lib/utils";
import type { DeployedAgent } from "@/lib/types";

export function AgentCard({ agent }: { agent: DeployedAgent }) {
  const { data: status, isLoading: statusLoading } = useAgentStatus(agent.name);
  const backup = useBackupAgent();
  const recover = useRecoverAgent();
  const down = useDownAgent();
  const toast = useToast();

  const [showAttestation, setShowAttestation] = useState(false);
  const [showTunnel, setShowTunnel] = useState(false);
  const [confirmDown, setConfirmDown] = useState(false);
  const [confirmRecover, setConfirmRecover] = useState(false);

  const isTee = agent.provider === "dstack-cvm";
  const isLightning = agent.provider === "lightning";
  const resourceNoun = isLightning ? "sandbox" : "agent";
  const busy = backup.isPending || recover.isPending || down.isPending;

  const onBackup = async () => {
    const id = toast.push({
      kind: "loading",
      title: `Backing up ${agent.name}…`,
      message: isLightning
        ? "Snapshotting sandbox state into TinyCloud"
        : "Snapshotting state into TinyCloud",
    });
    try {
      const r = await backup.mutateAsync(agent.name);
      toast.update(id, {
        kind: "success",
        title: `Backup complete · ${agent.name}`,
        message: `${r.chunks} chunks · ${formatBytes(r.totalBytes)} · ${r.integrity.slice(0, 16)}…`,
      });
    } catch (e) {
      toast.update(id, {
        kind: "error",
        title: "Backup failed",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  };

  const onRecover = async () => {
    setConfirmRecover(false);
    const id = toast.push({
      kind: "loading",
      title: `Recovering ${agent.name}…`,
      message: isLightning
        ? "Restoring sandbox state from the latest snapshot"
        : "Restoring sealed memory from the latest snapshot",
    });
    try {
      await recover.mutateAsync(agent.name);
      toast.update(id, {
        kind: "success",
        title: `Recovered ${agent.name}`,
        message: isLightning
          ? "Sandbox restored from backup."
          : "Agent restored from backup.",
      });
    } catch (e) {
      toast.update(id, {
        kind: "error",
        title: "Recover failed",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  };

  const onDown = async () => {
    setConfirmDown(false);
    const id = toast.push({
      kind: "loading",
      title: `Tearing down ${agent.name}…`,
    });
    try {
      await down.mutateAsync(agent.name);
      toast.update(id, {
        kind: "success",
        title: `${agent.name} is down`,
        message: isLightning
          ? "Sandbox compute released. Snapshots remain in TinyCloud."
          : "Compute released. Sealed memory remains in TinyCloud.",
      });
    } catch (e) {
      toast.update(id, {
        kind: "error",
        title: "Teardown failed",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  };

  return (
    <div className="card p-5 transition hover:border-slate-300">
      {/* header row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-mono text-base font-semibold text-slate-900">
              {agent.name}
            </h3>
            {statusLoading ? (
              <span className="skeleton h-5 w-16 rounded-full" />
            ) : (
              <StatusBadge status={status?.status ?? "unknown"} />
            )}
            {isTee ? (
              <Badge tone="tee" dot>
                TDX
              </Badge>
            ) : isLightning ? (
              <Badge tone="tee" dot>
                Lightning
              </Badge>
            ) : (
              <Badge tone="neutral">local</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
            <span>
              {isLightning ? "runtime" : "pack"}{" "}
              <span className="font-medium text-slate-600">{agent.pack}</span>
            </span>
            <span className="text-slate-300">·</span>
            <span>{agent.provider}</span>
            <span className="text-slate-300">·</span>
            <span>{agent.modelMode}</span>
            <span className="text-slate-300">·</span>
            <span>created {timeAgo(agent.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* details grid */}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs sm:grid-cols-4">
        <Detail label="Sandbox" value={agent.sandboxId} mono copy />
        <Detail
          label={isLightning ? "Sandbox DID" : "Agent DID"}
          value={shortHash(agent.agentDid, 14, 6)}
          title={agent.agentDid}
          mono
          copyValue={agent.agentDid}
        />
        <Detail
          label="Last backup"
          value={status?.lastBackupAt ? timeAgo(status.lastBackupAt) : "never"}
          sub={
            status?.snapshotBytes
              ? formatBytes(status.snapshotBytes)
              : undefined
          }
        />
        <Detail
          label="Endpoint"
          value={
            status?.endpoint
              ? "available"
              : agent.gatewayPort
                ? `port ${agent.gatewayPort}`
                : "not exposed"
          }
        />
      </dl>

      {/* actions */}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <button
          className="btn-ghost btn-sm"
          onClick={onBackup}
          disabled={busy}
          title="Snapshot state into TinyCloud"
        >
          {backup.isPending ? <MiniSpinner /> : <BackupIcon />}
          Backup
        </button>
        <button
          className="btn-ghost btn-sm"
          onClick={() => setConfirmRecover(true)}
          disabled={busy}
          title="Restore from the latest snapshot"
        >
          {recover.isPending ? <MiniSpinner /> : <RecoverIcon />}
          Recover
        </button>
        <button
          className="btn-ghost btn-sm"
          onClick={() => setShowTunnel(true)}
          disabled={busy}
          title={`How to reach the ${resourceNoun} gateway`}
        >
          <TunnelIcon />
          Tunnel
        </button>
        <button
          className="btn-ghost btn-sm"
          onClick={() => setShowAttestation(true)}
          disabled={busy}
          title="View the TDX attestation"
        >
          <ShieldIcon />
          Attestation
        </button>
        <button
          className="btn-danger btn-sm ml-auto"
          onClick={() => setConfirmDown(true)}
          disabled={busy}
          title="Tear down compute (memory is retained)"
        >
          {down.isPending ? <MiniSpinner /> : <DownIcon />}
          Down
        </button>
      </div>

      {/* modals */}
      <AttestationModal
        agent={agent}
        open={showAttestation}
        onClose={() => setShowAttestation(false)}
      />
      <TunnelHintModal
        agent={agent}
        endpoint={status?.endpoint}
        open={showTunnel}
        onClose={() => setShowTunnel(false)}
      />
      <ConfirmDialog
        open={confirmDown}
        onClose={() => setConfirmDown(false)}
        onConfirm={onDown}
        tone="danger"
        title={`Tear down ${agent.name}?`}
        confirmLabel="Tear down"
        body={
          isLightning
            ? "This releases the open sandbox. TinyCloud snapshots remain available for recovery onto fresh compute."
            : "This releases the compute sandbox. Your agent's sealed memory stays in TinyCloud — you can recover it onto fresh compute anytime."
        }
      />
      <ConfirmDialog
        open={confirmRecover}
        onClose={() => setConfirmRecover(false)}
        onConfirm={onRecover}
        title={`Recover ${agent.name}?`}
        confirmLabel="Recover"
        body={
          isLightning
            ? "Restore this sandbox from its most recent TinyCloud snapshot. Any unsaved state since the last backup will be lost."
            : "Restore this agent's state from its most recent TinyCloud snapshot. Any unsaved in-memory state since the last backup will be lost."
        }
      />
    </div>
  );
}

function Detail({
  label,
  value,
  sub,
  mono,
  copy,
  copyValue,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  copy?: boolean;
  copyValue?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400">
        {label}
        {(copy || copyValue) && (
          <CopyButton value={copyValue ?? value} label="" />
        )}
      </dt>
      <dd
        className={`truncate text-slate-700 ${mono ? "font-mono" : ""}`}
        title={title ?? value}
      >
        {value}
        {sub && <span className="ml-1 text-slate-400">({sub})</span>}
      </dd>
    </div>
  );
}

function MiniSpinner() {
  return (
    <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
function BackupIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}
function RecoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
function TunnelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20a8 8 0 0 1 16 0M9 20v-5a3 3 0 0 1 6 0v5" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
function DownIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64M12 2v10" />
    </svg>
  );
}
