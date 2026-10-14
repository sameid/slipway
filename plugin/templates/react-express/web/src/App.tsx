import { Show, SignIn, UserButton } from "@clerk/react";
import { Alert, Card, Spinner } from "@heroui/react";
import { useHealth, useMe } from "./api";

export type Config = { clerkPublishableKey: string; env: string; release: string };

export function App({ config }: { config: Config }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col p-6">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold">__APP_NAME__</h1>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>

      <main className="flex-1">
        <Show when="signed-out">
          <div className="flex justify-center">
            <SignIn routing="hash" />
          </div>
        </Show>
        <Show when="signed-in">
          <Home />
        </Show>
      </main>

      <Footer config={config} />
    </div>
  );
}

// The app's first screen. Replace it with the real thing.
function Home() {
  const me = useMe();
  if (me.isPending) return <Spinner aria-label="Loading" />;
  if (me.isError) {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Couldn't load your profile</Alert.Title>
          <Alert.Description>{me.error.message}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  const { user } = me.data;
  return (
    <Card>
      <Card.Header>
        <Card.Title>Welcome{user.name ? `, ${user.name}` : ""}</Card.Title>
        <Card.Description>
          Signed in as {user.email ?? user.clerkId} (local user #{user.id}).
        </Card.Description>
      </Card.Header>
    </Card>
  );
}

function Footer({ config }: { config: Config }) {
  const health = useHealth();
  return (
    <footer className="mt-8 text-xs text-muted">
      {config.env} · web {config.release} · api {health.data?.release ?? "…"}
    </footer>
  );
}
