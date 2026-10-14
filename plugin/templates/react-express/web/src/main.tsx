import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, type Config } from "./App";
import "./index.css";

const root = createRoot(document.getElementById("root")!);
const queryClient = new QueryClient();

// The Clerk key is loaded at runtime so the same build runs in every environment.
fetch("/config.json", { cache: "no-store" })
  .then((res) => {
    if (!res.ok) throw new Error(`GET /config.json: ${res.status}`);
    return res.json() as Promise<Config>;
  })
  .then((config) => {
    root.render(
      <StrictMode>
        <ClerkProvider publishableKey={config.clerkPublishableKey}>
          <QueryClientProvider client={queryClient}>
            <App config={config} />
          </QueryClientProvider>
        </ClerkProvider>
      </StrictMode>,
    );
  })
  .catch((err) => {
    root.render(<p className="p-8 text-danger">Failed to load config: {String(err)}</p>);
  });
