import { useEffect, useState } from "react";
import type {
  SidebarState,
  ToWebview,
  ChangedFile
} from "../../src/shared/protocol";
import { send } from "./vscodeApi";

const EMPTY: SidebarState = {
  hasWorkspace: true,
  prs: [],
  activePrId: null,
  selected: null,
  reviewing: false,
  status: null
};

export function App() {
  const [state, setState] = useState<SidebarState>(EMPTY);

  useEffect(() => {
    const onMsg = (e: MessageEvent<ToWebview>) => {
      if (e.data?.type === "state") setState(e.data.state);
    };
    window.addEventListener("message", onMsg);
    send({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <div className="app">
      <Header reviewing={state.reviewing} />
      {state.status && (
        <div className={`status ${state.status.kind}`}>{state.status.text}</div>
      )}
      <NewPR />
      <PRList state={state} />
      <SelectedPanel state={state} />
    </div>
  );
}

function Header({ reviewing }: { reviewing: boolean }) {
  return (
    <div className="header">
      <span className="brand">Offshoot</span>
      {reviewing && <span className="badge">Reviewing</span>}
      <button className="ghost" onClick={() => send({ type: "refresh" })} title="Refresh">
        ⟳
      </button>
    </div>
  );
}

function NewPR() {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [id, setId] = useState("");

  const open = () => {
    if (!title.trim() && !id.trim()) return;
    send({ type: "openPR", id: id.trim() || undefined, title, notes });
    setTitle("");
    setNotes("");
    setId("");
  };

  return (
    <section className="card">
      <div className="card-title">New PR</div>
      <input
        className="input"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="input"
        placeholder="Notes (optional)"
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <input
        className="input"
        placeholder="Custom id (optional)"
        value={id}
        onChange={(e) => setId(e.target.value)}
      />
      <button className="primary" onClick={open}>
        Open PR
      </button>
    </section>
  );
}

function PRList({ state }: { state: SidebarState }) {
  if (state.prs.length === 0) {
    return (
      <section className="card">
        <div className="card-title">Open PRs</div>
        <div className="muted">No open PRs. Edit files after opening one to track changes.</div>
      </section>
    );
  }
  const selectedId = state.selected?.meta.id ?? state.activePrId;
  return (
    <section className="card">
      <div className="card-title">Open PRs</div>
      <ul className="pr-list">
        {state.prs.map((pr) => (
          <li
            key={pr.id}
            className={`pr-row ${pr.id === selectedId ? "active" : ""}`}
            onClick={() => send({ type: "selectPR", id: pr.id })}
          >
            <span className="pr-id">#{pr.id}</span>
            <span className="pr-title">{pr.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SelectedPanel({ state }: { state: SidebarState }) {
  const view = state.selected;
  if (!view) return null;
  const id = view.meta.id;

  return (
    <section className="card selected">
      <div className="card-title">
        PR #{id} — {view.meta.title}
      </div>
      {view.meta.notes && <div className="notes">{view.meta.notes}</div>}

      <div className="files">
        {view.changedFiles.length === 0 && (
          <div className="muted">No changes captured yet.</div>
        )}
        {view.changedFiles.map((f) => (
          <FileRow key={f.file} id={id} f={f} />
        ))}
      </div>

      <div className="actions">
        {state.reviewing ? (
          <button className="ghost" onClick={() => send({ type: "stopReview" })}>
            Stop review
          </button>
        ) : (
          <button className="ghost" onClick={() => send({ type: "review", id })}>
            Review
          </button>
        )}
        <button className="ghost" onClick={() => send({ type: "commitSelection", id })}>
          Commit selection
        </button>
        <button className="danger" onClick={() => send({ type: "revert", id })}>
          Revert
        </button>
        <button className="primary" onClick={() => send({ type: "commit", id })}>
          Commit
        </button>
      </div>
      <div className="hint">
        Commit deletes the baseline — it can’t be undone. Revert restores it.
      </div>
    </section>
  );
}

function FileRow({ id, f }: { id: string; f: ChangedFile }) {
  const tag =
    f.kind === "added" ? "A" : f.kind === "deleted" ? "D" : "M";
  return (
    <div
      className="file-row"
      onClick={() => send({ type: "openFileDiff", id, file: f.file })}
      title="Open baseline ↔ disk diff"
    >
      <span className={`tag ${f.kind}`}>{tag}</span>
      <span className="file-name">{f.file}</span>
      <span className="counts">
        {f.added > 0 && <span className="add">+{f.added}</span>}
        {f.removed > 0 && <span className="del">−{f.removed}</span>}
      </span>
    </div>
  );
}
