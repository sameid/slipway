import { useCallback } from "react";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

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
// write). Paths are relative (/api/...), so the same build works locally and
// behind CloudFront. The Clerk session token goes in the Authorization header.
export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (init.body) headers.set("Content-Type", "application/json");
      const res = await fetch(`/api${path}`, { ...init, headers });
      if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    },
    [getToken],
  );
}

export type Health = { ok: boolean; release: string; migrations: number };
export type User = { id: number; clerkId: string; email: string | null; name: string | null; createdAt: string };

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: ["health"], queryFn: () => api<Health>("/health") });
}

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: ["me"], queryFn: () => api<{ user: User }>("/me"), retry: false });
}
