import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";

// Clerk is replaced by a stub whose signed-in state each test sets.
const clerk = vi.hoisted(() => ({ signedIn: false }));

vi.mock("@clerk/react", () => ({
  Show: ({ when, children }: { when: string; children: React.ReactNode }) =>
    (when === "signed-in") === clerk.signedIn ? children : null,
  SignIn: () => <div>Clerk sign-in</div>,
  UserButton: () => <button>User menu</button>,
  useAuth: () => ({ getToken: async () => (clerk.signedIn ? "session-token" : null) }),
}));

const config = { clerkPublishableKey: "pk_test_x", env: "local", release: "dev" };

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App config={config} />
    </QueryClientProvider>,
  );
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const body =
    String(input) === "/api/me"
      ? { user: { id: 7, clerkId: "user_123", email: "jane@example.com", name: "Jane", createdAt: "" } }
      : { ok: true, release: "a1b2c3d", migrations: 1 };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
});

beforeEach(() => {
  fetchMock.mockReset(); // back to the default responses above
  vi.stubGlobal("fetch", fetchMock);
});

describe("App", () => {
  it("shows Clerk's sign-in when signed out", async () => {
    clerk.signedIn = false;
    renderApp();

    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
    expect(screen.queryByText("User menu")).not.toBeInTheDocument();
  });

  it("shows the local user when signed in, sending the session token", async () => {
    clerk.signedIn = true;
    renderApp();

    expect(await screen.findByText(/Signed in as jane@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome, Jane" })).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([input]) => String(input) === "/api/me")!;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
  });

  it("shows an alert when the profile can't load", async () => {
    clerk.signedIn = true;
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/me"
        ? new Response("database unavailable", { status: 503 })
        : new Response(JSON.stringify({ ok: true, release: "a1b2c3d", migrations: 1 })),
    );
    renderApp();

    expect(await screen.findByText("Couldn't load your profile")).toBeInTheDocument();
    expect(screen.getByText("503 database unavailable")).toBeInTheDocument();
  });
});
