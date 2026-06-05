"use client";

import { Modal } from "@/components/ui/Modal";
import { CopyButton } from "@/components/ui/CopyButton";
import type { DeployedAgent } from "@/lib/types";

export function TunnelHintModal({
  agent,
  endpoint,
  open,
  onClose,
}: {
  agent: DeployedAgent;
  endpoint?: string;
  open: boolean;
  onClose: () => void;
}) {
  const isLightning = agent.provider === "lightning";
  const resourceNoun = isLightning ? "Sandbox" : "Agent";
  const port = agent.gatewayPort ?? 3001;
  const localPort = port;
  const tunnelCmd = `tinyagent tunnel ${agent.name} --remote ${port} --local ${localPort}`;
  const curlCmd = `curl http://localhost:${localPort}/health`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2.5">
          Reach <span className="font-mono text-base">{agent.name}</span>
        </span>
      }
      description={`${resourceNoun}s listen on a loopback port inside the sandbox. Forward it to your machine to talk to the gateway.`}
      footer={
        <button onClick={onClose} className="btn-ghost">
          Done
        </button>
      }
    >
      <div className="space-y-4">
        {endpoint ? (
          <div className="rounded-xl border border-blue-600/25 bg-blue-600/5 p-3">
            <p className="text-[11px] uppercase tracking-wide text-blue-600/80">
              Public endpoint (provider gateway)
            </p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <a
                href={endpoint}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-sm text-blue-700 underline-offset-2 hover:underline"
              >
                {endpoint}
              </a>
              <CopyButton value={endpoint} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            This {resourceNoun.toLowerCase()} has no public endpoint. Open a local tunnel to reach its
            gateway on port{" "}
            <span className="font-mono text-slate-700">{port}</span>.
          </p>
        )}

        <CommandBlock label="Open a tunnel (CLI)" cmd={tunnelCmd} />
        <CommandBlock label="Then hit it locally" cmd={curlCmd} />

        <p className="text-xs text-slate-400">
          Tip: the gateway is bound to loopback inside the enclave — it is never
          exposed to the public internet unless you forward it.
        </p>
      </div>
    </Modal>
  );
}

function CommandBlock({ label, cmd }: { label: string; cmd: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-slate-400">
          {label}
        </p>
        <CopyButton value={cmd} />
      </div>
      <pre className="overflow-auto rounded-lg border border-slate-200 bg-paper p-3 text-xs">
        <code className="font-mono text-blue-700">$ {cmd}</code>
      </pre>
    </div>
  );
}
