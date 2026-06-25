import { useEffect, useState } from "react";
import { prNum } from "../../src/shared/protocol";
import type {
  SidebarState,
  ToWebview,
  ChangedFile
} from "../../src/shared/protocol";
import { send, vscode } from "./vscodeApi";

const EMPTY: SidebarState = {
  hasWorkspace: true,
  prs: [],
  activePrId: null,
  selected: null,
  reviewing: false,
  status: null
};

function getFlag(key: string, fallback: boolean): boolean {
  const v = vscode.getState<Record<string, unknown>>()?.[key];
  return typeof v === "boolean" ? v : fallback;
}
function setFlag(key: string, value: boolean) {
  vscode.setState({ ...(vscode.getState<Record<string, unknown>>() ?? {}), [key]: value });
}

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
      <button
        className="btn neutral refresh"
        onClick={() => send({ type: "refresh" })}
        title="Re-scan .offshoot for PRs and refresh the view"
      >
        <span className="ico">⟳</span> Refresh
      </button>

      <hr />
      <NewPR />

      <hr />
      <OpenPRs state={state} />

      {state.selected && (
        <>
          <hr />
          <SelectedPanel state={state} />
        </>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return <span className={`chevron ${open ? "open" : ""}`}>▸</span>;
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
    <section className="section">
      <div className="section-title">New Pull Request</div>
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
      <button className="btn add" onClick={open}>
        Open Pull Request
      </button>
    </section>
  );
}

function OpenPRs({ state }: { state: SidebarState }) {
  const [expanded, setExpanded] = useState<boolean>(getFlag("prsOpen", true));
  const [query, setQuery] = useState("");

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    setFlag("prsOpen", next);
  };

  const selectedId = state.selected?.meta.id ?? state.activePrId;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? state.prs.filter(
        (pr) =>
          pr.id.toLowerCase().includes(q) ||
          prNum(pr.id).toLowerCase().includes(q) ||
          pr.title.toLowerCase().includes(q)
      )
    : state.prs;

  return (
    <section className="section">
      <button className="collapse-head" onClick={toggle}>
        <Chevron open={expanded} />
        <span className="section-title">Open PRs</span>
        <span className="count">{state.prs.length}</span>
      </button>

      {expanded && (
        <>
          {state.prs.length > 0 && (
            <input
              className="input search"
              placeholder="Search PRs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {state.prs.length === 0 ? (
            <div className="muted">
              No open PRs. Open one, then edit files to track changes.
            </div>
          ) : filtered.length === 0 ? (
            <div className="muted">No PRs match “{query}”.</div>
          ) : (
            <ul className="pr-list">
              {filtered.map((pr) => (
                <li
                  key={pr.id}
                  className={`pr-row ${pr.id === selectedId ? "active" : ""}`}
                  title={pr.title}
                  onClick={() => send({ type: "selectPR", id: pr.id })}
                >
                  <span className="pr-id">{prNum(pr.id)}</span>
                  <span className="pr-title">{pr.title}</span>
                  <button
                    className="icon-btn edit-pr"
                    title="Edit title & notes"
                    onClick={(e) => {
                      e.stopPropagation();
                      send({ type: "editPR", id: pr.id });
                    }}
                  >
                    ✎
                  </button>
                  <span className="pr-count" title={`${pr.changeCount} changed file(s)`}>
                    {pr.changeCount}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SelectedPanel({ state }: { state: SidebarState }) {
  const view = state.selected!;
  const id = view.meta.id;
  const [open, setOpen] = useState<boolean>(getFlag("changesOpen", true));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setFlag("changesOpen", next);
  };

  return (
    <section className="section selected">
      <button className="collapse-head" onClick={toggle}>
        <Chevron open={open} />
        <span className="section-title pr-name" title={view.meta.title}>
          {view.meta.title}
        </span>
        <span className="count">{view.changedFiles.length}</span>
      </button>

      {open && (
        <>
          {view.meta.notes && <div className="notes">{view.meta.notes}</div>}
          <div className="files">
            {view.changedFiles.length === 0 && (
              <div className="muted">No changes captured yet.</div>
            )}
            {view.changedFiles.map((f) => (
              <FileRow key={f.file} id={id} f={f} />
            ))}
          </div>
        </>
      )}

      <div className="actions">
        <button
          className={`btn review ${state.reviewing ? "active" : ""}`}
          onClick={() =>
            send(state.reviewing ? { type: "stopReview" } : { type: "review", id })
          }
        >
          Review
        </button>
        <button
          className="btn primary"
          title="Select lines in an open file, then click to commit only those lines"
          onClick={() => send({ type: "commitSelection", id })}
        >
          Commit Selected
        </button>
        <button className="btn danger full" onClick={() => send({ type: "revert", id })}>
          Revert
        </button>
        <button className="btn add full" onClick={() => send({ type: "commit", id })}>
          Commit
        </button>
      </div>
    </section>
  );
}

function FileRow({ id, f }: { id: string; f: ChangedFile }) {
  const tag = f.kind === "added" ? "A" : f.kind === "deleted" ? "D" : "M";
  return (
    <div className="file-row">
      <span
        className="file-main"
        onClick={() => send({ type: "openFileDiff", id, file: f.file })}
        title="Open baseline ↔ disk diff"
      >
        <span className={`tag ${f.kind}`}>{tag}</span>
        <span className="file-name" title={f.file}>
          {f.file}
        </span>
      </span>
      <button
        className="icon-btn revert-file"
        title="Revert this file to baseline"
        onClick={() => send({ type: "revertFile", id, file: f.file })}
      >
        ↩
      </button>
      <span className="counts">
        {f.added > 0 && <span className="add">+{f.added}</span>}
        {f.removed > 0 && <span className="del">−{f.removed}</span>}
      </span>
    </div>
  );
}
