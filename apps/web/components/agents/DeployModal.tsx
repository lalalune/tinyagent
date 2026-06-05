"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { useDeployAgent, usePacks } from "@/lib/hooks";
import { useToast } from "@/components/ui/Toast";
import { cx } from "@/lib/utils";
import type { PackRecord, ProviderKind } from "@/lib/types";

const PROVIDERS: {
  id: ProviderKind;
  name: string;
  blurb: string;
  tee: boolean;
}[] = [
  {
    id: "dstack-cvm",
    name: "dstack CVM",
    blurb: "Intel-TDX confidential VM. Hardware-attested, memory sealed in-enclave.",
    tee: true,
  },
  {
    id: "local-docker",
    name: "Local Docker",
    blurb: "Runs on a local Docker host. Fast to iterate; not a TEE.",
    tee: false,
  },
];

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
type DeployMode = "agent" | "lightning";

export function DeployModal({
  open,
  onClose,
  existingNames,
  mode = "agent",
}: {
  open: boolean;
  onClose: () => void;
  existingNames: string[];
  mode?: DeployMode;
}) {
  const { data: packs, isLoading: packsLoading } = usePacks();
  const deploy = useDeployAgent();
  const toast = useToast();

  const isLightning = mode === "lightning";
  const deployablePacks = useMemo(() => {
    if (!packs) return undefined;
    if (!isLightning) return packs.filter((p) => p.type === "agent");
    const basePacks = packs.filter((p) => p.type === "base");
    return basePacks.length > 0 ? basePacks : packs;
  }, [isLightning, packs]);

  const [name, setName] = useState("");
  const [packName, setPackName] = useState<string>("");
  const [provider, setProvider] = useState<ProviderKind>("dstack-cvm");
  const [modelMode, setModelMode] = useState<string>("");

  const selectedPack: PackRecord | undefined = useMemo(
    () => packs?.find((p) => p.name === packName),
    [packs, packName],
  );

  // Default the pack selection once packs load.
  useEffect(() => {
    if (!deployablePacks || deployablePacks.length === 0) return;
    if (!packName || !deployablePacks.some((p) => p.name === packName)) {
      setPackName(deployablePacks[0].name);
    }
  }, [deployablePacks, packName]);

  // Lightning always targets the open sandbox provider.
  useEffect(() => {
    if (isLightning) setProvider("lightning");
    else if (provider === "lightning") setProvider("dstack-cvm");
  }, [isLightning, provider]);

  // Keep model mode valid for the chosen pack.
  useEffect(() => {
    const modes = selectedPack?.modelModes ?? [];
    if (modes.length === 0) {
      setModelMode("api-key");
    } else if (!modes.includes(modelMode)) {
      setModelMode(modes[0]);
    }
  }, [selectedPack, modelMode]);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setName("");
      deploy.reset();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameTaken = existingNames.includes(name.trim());
  const nameValid = NAME_RE.test(name.trim());
  const nameError =
    name.length === 0
      ? null
      : nameTaken
        ? `A ${isLightning ? "sandbox" : "agent"} with this name already exists.`
        : !nameValid
          ? "Lowercase letters, digits, and dashes; must start with a letter."
          : null;

  const canSubmit =
    !!packName && !!provider && !!modelMode && nameValid && !nameTaken && !deploy.isPending;

  const modelModes = selectedPack?.modelModes?.length
    ? selectedPack.modelModes
    : ["api-key"];

  const onSubmit = async () => {
    if (!canSubmit) return;
    const toastId = toast.push({
      kind: "loading",
      title: `Deploying ${name.trim()}…`,
      message: isLightning
        ? `Lightning sandbox on ${provider}`
        : `${packName} on ${provider}`,
    });
    try {
      const agent = await deploy.mutateAsync({
        name: name.trim(),
        pack: packName,
        provider,
        modelMode,
      });
      toast.update(toastId, {
        kind: "success",
        title: isLightning
          ? `Opened ${agent.name}`
          : `Deployed ${agent.name}`,
        message: `Sandbox ${agent.sandboxId} is provisioning.`,
      });
      onClose();
    } catch (e) {
      toast.update(toastId, {
        kind: "error",
        title: "Deploy failed",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={isLightning ? "Open a Lightning sandbox" : "Deploy an agent"}
      description={
        isLightning
          ? "Start an open sandbox with the same wallet-owned lifecycle controls as TinyAgent, without choosing an agent pack."
          : "Spin up a new sovereign agent. Memory is sealed to your wallet from the first boot."
      }
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={deploy.isPending}>
            Cancel
          </button>
          <button className="btn-primary" onClick={onSubmit} disabled={!canSubmit}>
            {deploy.isPending
              ? "Deploying…"
              : isLightning
                ? "Open sandbox"
                : "Deploy agent"}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Pack/runtime */}
        <div>
          <label className="label">{isLightning ? "Runtime" : "Pack"}</label>
          {packsLoading ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="skeleton h-16" />
              <div className="skeleton h-16" />
            </div>
          ) : (
            <div className="grid max-h-56 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {deployablePacks?.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setPackName(p.name)}
                  className={cx(
                    "rounded-xl border p-3 text-left transition",
                    packName === p.name
                      ? "border-blue-500 bg-blue-50"
                      : "border-slate-300 bg-white hover:border-slate-400",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-slate-900">
                      {p.name}
                    </span>
                    <span className="flex gap-1">
                      {p.brain && <Badge tone="tee">brain</Badge>}
                      <Badge tone="neutral">{p.type}</Badge>
                    </span>
                  </div>
                  {p.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                      {p.description}
                    </p>
                  )}
                  <PackNeeds pack={p} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Name */}
        <div>
          <label className="label" htmlFor="agent-name">
            {isLightning ? "Sandbox name" : "Agent name"}
          </label>
          <input
            id="agent-name"
            className="input font-mono"
            placeholder={isLightning ? "e.g. workspace" : "e.g. scribe"}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) onSubmit();
            }}
          />
          {nameError && (
            <p className="mt-1 text-xs text-red-600">{nameError}</p>
          )}
        </div>

        {/* Provider */}
        {!isLightning && <div>
          <label className="label">Provider</label>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProvider(p.id)}
                className={cx(
                  "rounded-xl border p-3 text-left transition",
                  provider === p.id
                    ? "border-blue-500 bg-blue-50"
                    : "border-slate-300 bg-white hover:border-slate-400",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-900">
                    {p.name}
                  </span>
                  {p.tee ? (
                    <Badge tone="tee" dot>
                      TEE
                    </Badge>
                  ) : (
                    <Badge tone="neutral">no TEE</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-500">{p.blurb}</p>
              </button>
            ))}
          </div>
        </div>}
        {isLightning && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
            Lightning provider selected. Custom images and templates can plug
            into this runtime slot without changing the lifecycle UI.
          </div>
        )}

        {/* Model mode */}
        <div>
          <label className="label" htmlFor="model-mode">
            Model mode
          </label>
          <select
            id="model-mode"
            className="input"
            value={modelMode}
            onChange={(e) => setModelMode(e.target.value)}
          >
            {modelModes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {selectedPack?.defaultModel && (
            <p className="mt-1 text-xs text-slate-400">
              Default model:{" "}
              <span className="font-mono text-slate-500">
                {selectedPack.defaultModel}
              </span>
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PackNeeds({ pack }: { pack: PackRecord }) {
  const chips: string[] = [];
  if (pack.needs.gpu) chips.push("gpu");
  if (pack.needs.docker) chips.push("docker");
  if (pack.needs.postgres) chips.push("postgres");
  if (pack.needs.interactiveLogin) chips.push("interactive login");
  if (pack.dataVolumeGiB > 0) chips.push(`${pack.dataVolumeGiB} GiB state`);
  else chips.push("stateless");
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c}
          className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500"
        >
          {c}
        </span>
      ))}
    </div>
  );
}
