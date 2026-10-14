import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";

const config = { env: "staging", release: "dev" };

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App config={config} />
    </QueryClientProvider>,
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let notes = [{ id: 1, body: "First note", createdAt: "" }];
let notesDown = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === "/api/notes" && init?.method === "POST") {
    const note = { id: 2, body: JSON.parse(String(init.body)).body, createdAt: "" };
    notes = [note, ...notes];
    return json({ note }, 201);
  }
  if (String(input) === "/api/notes") {
    return notesDown ? new Response("database unavailable", { status: 503 }) : json({ notes });
  }
  return json({ ok: true, release: "a1b2c3d", migrations: 1 });
});

beforeEach(() => {
  notes = [{ id: 1, body: "First note", createdAt: "" }];
  notesDown = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

describe("App", () => {
  it("lists notes and the running releases", async () => {
    renderApp();

    expect(await screen.findByText("First note")).toBeInTheDocument();
    expect(await screen.findByText("staging · web dev · api a1b2c3d")).toBeInTheDocument();
  });

  it("adds a note and shows it", async () => {
    renderApp();
    await screen.findByText("First note");

    fireEvent.change(screen.getByLabelText("New note"), { target: { value: "Second note" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Second note")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ body: "Second note" });
    await waitFor(() => expect(screen.getByLabelText("New note")).toHaveValue(""));
  });

  it("shows an alert when notes can't load", async () => {
    notesDown = true;
    renderApp();

    expect(await screen.findByText("Couldn't load notes")).toBeInTheDocument();
    expect(screen.getByText("503 database unavailable")).toBeInTheDocument();
  });
});
