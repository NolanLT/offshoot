import { useEffect, useState, type ReactNode } from "react";
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
    // Always send — an empty title is handled by the extension (Error #14),
    // which prompts for one rather than silently doing nothing.
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
          {view.changedFiles.length === 0 ? (
            <div className="muted">No changes captured yet.</div>
          ) : (
            <ChangesTree id={id} files={view.changedFiles} />
          )}
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

interface TreeNode {
  name: string;
  path: string;
  file?: ChangedFile;
  children: Map<string, TreeNode>;
}

function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.file.split("/");
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: acc, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.file = f;
      node = child;
    });
  }
  return root;
}

/** folders first, then files; alphabetical within each. */
function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aFolder = a.children.size > 0;
    const bFolder = b.children.size > 0;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function ChangesTree({ id, files }: { id: string; files: ChangedFile[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const root = buildTree(files);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (node: TreeNode, depth: number): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const child of sortedChildren(node)) {
      const isFolder = child.children.size > 0;
      const pad = depth * 12 + 6;
      if (isFolder) {
        const isCollapsed = collapsed.has(child.path);
        rows.push(
          <div
            key={child.path}
            className="folder-row"
            style={{ paddingLeft: pad }}
            onClick={() => toggle(child.path)}
            title={child.path}
          >
            <Chevron open={!isCollapsed} />
            <span className="folder-name">{child.name}</span>
          </div>
        );
        if (!isCollapsed) rows.push(...render(child, depth + 1));
      } else if (child.file) {
        rows.push(<FileLeaf key={child.path} id={id} f={child.file} pad={pad} />);
      }
    }
    return rows;
  };

  return <div className="files">{render(root, 0)}</div>;
}

function FileLeaf({ id, f, pad }: { id: string; f: ChangedFile; pad: number }) {
  const name = f.file.split("/").pop() ?? f.file;
  return (
    <div className="file-row">
      <span
        className={`file-main kind-${f.kind}`}
        style={{ paddingLeft: pad }}
        onClick={() => send({ type: "openFileDiff", id, file: f.file })}
        title={f.file}
      >
        <span className="file-name">{name}</span>
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
