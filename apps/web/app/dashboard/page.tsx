"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { AgentCard } from "@/components/agents/AgentCard";
import { DeployModal } from "@/components/agents/DeployModal";
import { useAgents } from "@/lib/hooks";

export default function DashboardPage() {
  return (
    <AppShell>
      <DashboardBody />
    </AppShell>
  );
}

function DashboardBody() {
  const { data: agents, isLoading, isError, error, refetch, isFetching } =
    useAgents();
  const [deployOpen, setDeployOpen] = useState(false);
  const [view, setView] = useState<"agents" | "lightning">("agents");

  const names = (agents ?? []).map((a) => a.name);
  const visibleResources = (agents ?? []).filter((agent) =>
    view === "lightning"
      ? agent.provider === "lightning"
      : agent.provider !== "lightning",
  );
  const resourceNoun = view === "lightning" ? "sandbox" : "agent";

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {view === "lightning" ? "Lightning sandboxes" : "Your agents"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {agents
              ? `${visibleResources.length} ${resourceNoun}${visibleResources.length === 1 ? "" : resourceNoun === "sandbox" ? "es" : "s"} · wallet-owned lifecycle`
              : "Loading…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
            <button
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                view === "agents"
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:text-slate-900"
              }`}
              onClick={() => setView("agents")}
            >
              TinyAgent
            </button>
            <button
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                view === "lightning"
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:text-slate-900"
              }`}
              onClick={() => setView("lightning")}
            >
              Lightning
            </button>
          </div>
          <button
            className="btn-ghost btn-sm"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh"
          >
            <RefreshIcon spinning={isFetching} />
            Refresh
          </button>
          <button className="btn-primary" onClick={() => setDeployOpen(true)}>
            <PlusIcon />
            {view === "lightning" ? "Open sandbox" : "Deploy agent"}
          </button>
        </div>
      </div>

      <div className="mt-8">
        {isLoading && <AgentListSkeleton />}

        {isError && (
          <div className="card flex flex-col items-center gap-3 p-10 text-center">
            <p className="text-sm text-red-600">
              Could not load agents: {(error as Error)?.message}
            </p>
            <button className="btn-ghost btn-sm" onClick={() => refetch()}>
              Try again
            </button>
          </div>
        )}

        {!isLoading && !isError && agents && visibleResources.length === 0 && (
          <EmptyState
            mode={view}
            onDeploy={() => setDeployOpen(true)}
          />
        )}

        {!isLoading && agents && visibleResources.length > 0 && (
          <div className="grid gap-4">
            {visibleResources.map((a) => (
              <AgentCard key={a.name} agent={a} />
            ))}
          </div>
        )}
      </div>

      <DeployModal
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        existingNames={names}
        mode={view === "lightning" ? "lightning" : "agent"}
      />
    </div>
  );
}

function EmptyState({
  mode,
  onDeploy,
}: {
  mode: "agents" | "lightning";
  onDeploy: () => void;
}) {
  const isLightning = mode === "lightning";
  return (
    <div className="card flex flex-col items-center gap-4 p-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-200 bg-blue-50">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M12 3 21 8v8l-9 5-9-5V8l9-5Z" />
          <path d="M12 12 21 8M12 12v9M12 12 3 8" />
        </svg>
      </div>
      <div>
        <h3 className="text-lg font-semibold text-slate-900">
          {isLightning ? "No sandboxes yet" : "No agents yet"}
        </h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
          {isLightning
            ? "Open a Lightning sandbox when you want raw, disposable compute with the same wallet-owned controls."
            : "Deploy your first sovereign agent. Its memory is sealed to your wallet from the first boot — the compute is just a disposable shell."}
        </p>
      </div>
      <button className="btn-primary" onClick={onDeploy}>
        <PlusIcon />
        {isLightning ? "Open your first sandbox" : "Deploy your first agent"}
      </button>
    </div>
  );
}

function AgentListSkeleton() {
  return (
    <div className="grid gap-4">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="card p-5">
          <div className="flex items-center gap-2">
            <div className="skeleton h-5 w-28" />
            <div className="skeleton h-5 w-16 rounded-full" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((__, j) => (
              <div key={j} className="skeleton h-9" />
            ))}
          </div>
          <div className="mt-5 flex gap-2 border-t border-slate-200 pt-4">
            {Array.from({ length: 4 }).map((__, j) => (
              <div key={j} className="skeleton h-7 w-20 rounded-xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? "animate-spin" : ""} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
