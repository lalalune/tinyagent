"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "./api";
import type { DeployAgentInput, ResourceSize } from "./types";

export const qk = {
  me: ["me"] as const,
  packs: ["packs"] as const,
  agents: ["agents"] as const,
  status: (name: string) => ["agent-status", name] as const,
  attestation: (name: string) => ["attestation", name] as const,
  billingConfig: ["billing-config"] as const,
  billingBalance: (addr?: string) => ["billing-balance", addr] as const,
  quote: (r: ResourceSize, hours: number) =>
    ["quote", r.vcpu, r.memMiB, r.diskGiB, hours] as const,
};

export function usePacks() {
  return useQuery({
    queryKey: qk.packs,
    queryFn: ({ signal }) => api.packs(signal),
    staleTime: 60_000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: qk.agents,
    queryFn: ({ signal }) => api.agents(signal),
  });
}

export function useAgentStatus(name: string, enabled = true) {
  return useQuery({
    queryKey: qk.status(name),
    queryFn: ({ signal }) => api.status(name, signal),
    enabled,
    refetchInterval: (q) => {
      const s = q.state.data?.status?.toLowerCase() ?? "";
      // Poll faster while provisioning/transitioning.
      return s.includes("provision") || s.includes("pending") ? 4000 : false;
    },
  });
}

export function useDeployAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeployAgentInput) => api.deploy(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agents });
    },
  });
}

export function useBackupAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.backup(name),
    onSuccess: (_data, name) => {
      qc.invalidateQueries({ queryKey: qk.status(name) });
      qc.invalidateQueries({ queryKey: qk.agents });
    },
  });
}

export function useRecoverAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.recover(name),
    onSuccess: (_data, name) => {
      qc.invalidateQueries({ queryKey: qk.status(name) });
      qc.invalidateQueries({ queryKey: qk.agents });
    },
  });
}

export function useDownAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.down(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agents });
    },
  });
}

export function useBillingConfig() {
  return useQuery({
    queryKey: qk.billingConfig,
    queryFn: ({ signal }) => api.billingConfig(signal),
    staleTime: 5 * 60_000,
  });
}

export function useBillingBalance(address?: string) {
  return useQuery({
    queryKey: qk.billingBalance(address),
    queryFn: ({ signal }) => api.billingBalance(address!, signal),
    enabled: !!address,
    refetchInterval: 15_000,
  });
}

export function useQuote(r: ResourceSize, hours: number, enabled = true) {
  return useQuery({
    queryKey: qk.quote(r, hours),
    queryFn: ({ signal }) => api.quote(r, hours, signal),
    enabled,
    placeholderData: (prev) => prev,
  });
}
