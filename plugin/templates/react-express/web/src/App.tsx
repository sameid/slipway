import { useState } from "react";
import { Alert, Button, Card, Form, Input, Label, Spinner, TextField } from "@heroui/react";
import { useAddNote, useHealth, useNotes } from "./api";

export type Config = { env: string; release: string };

export function App({ config }: { config: Config }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col p-6">
      <header className="mb-8">
        <h1 className="text-xl font-semibold">__APP_NAME__</h1>
      </header>

      <main className="flex-1">
        <Home />
      </main>

      <Footer config={config} />
    </div>
  );
}

// The app's first screen: the template's sample notes. Replace it with the real thing.
function Home() {
  return (
    <Card>
      <Card.Header>
        <Card.Title>Notes</Card.Title>
        <Card.Description>Anyone with this app's link can read and add notes.</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <AddNote />
        <NoteList />
      </Card.Content>
    </Card>
  );
}

function AddNote() {
  const [body, setBody] = useState("");
  const addNote = useAddNote();
  return (
    <Form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) addNote.mutate(body, { onSuccess: () => setBody("") });
      }}
    >
      <TextField className="flex-1" value={body} onChange={setBody} maxLength={500}>
        <Label>New note</Label>
        <Input />
      </TextField>
      <Button type="submit" variant="primary" isPending={addNote.isPending}>
        Add
      </Button>
    </Form>
  );
}

function NoteList() {
  const notes = useNotes();
  if (notes.isPending) return <Spinner aria-label="Loading" />;
  if (notes.isError) {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Couldn't load notes</Alert.Title>
          <Alert.Description>{notes.error.message}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (!notes.data.length) return <p className="text-sm text-muted">No notes yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {notes.data.map((note) => (
        <li key={note.id} className="text-sm">
          {note.body}
        </li>
      ))}
    </ul>
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
