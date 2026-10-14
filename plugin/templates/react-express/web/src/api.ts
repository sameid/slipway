import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// The only way components talk to the API: wrap each endpoint in a TanStack
// Query hook below (useQuery to read, useMutation + invalidateQueries to
// write). Paths are relative (/api/...), so the same build works on staging
// and prod behind CloudFront.
export function useApi() {
  return useCallback(async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    const res = await fetch(`/api${path}`, { ...init, headers });
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }, []);
}

export type Health = { ok: boolean; release: string; migrations: number };
export type Note = { id: number; body: string; createdAt: string };

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: ["health"], queryFn: () => api<Health>("/health") });
}

export function useNotes() {
  const api = useApi();
  return useQuery({ queryKey: ["notes"], queryFn: () => api<{ notes: Note[] }>("/notes").then((r) => r.notes) });
}

export function useAddNote() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<{ note: Note }>("/notes", { method: "POST", body: JSON.stringify({ body }) }).then((r) => r.note),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
  });
}
