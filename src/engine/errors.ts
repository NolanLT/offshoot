// Section 7 — the error list. A single error class with a numeric code and a
// list of resolution buttons to offer. The guard / command layer turns these
// into vscode dialogs (Section 6).

import { prNum } from "../shared/protocol";

export type ResolutionId =
  | "cancel"
  | "retry"
  | "refreshList"
  | "keepDisk"
  | "forceBaseline"
  | "recapture"
  | "openExisting"
  | "useDifferentId"
  | "openNew"
  | "selectExisting"
  | "removeFromList"
  | "revealFolder"
  | "discard"
  | "save"
  | "discardBuffers"
  | "skipFile"
  | "recreate"
  | "chooseSelection"
  | "commitOverlap" // dynamic per-PR commit (carries data)
  | "commitAllOverlap";

export interface Resolution {
  id: ResolutionId;
  label: string;
  /** true if choosing this button loses data — caller adds a confirm step. */
  destructive?: boolean;
  /** arbitrary payload, e.g. a target PR id for commitOverlap. */
  data?: unknown;
}

export class OffshootError extends Error {
  code: number;
  resolutions: Resolution[];
  constructor(code: number, message: string, resolutions: Resolution[]) {
    super(message);
    this.name = "OffshootError";
    this.code = code;
    this.resolutions = resolutions;
  }
}

const CANCEL: Resolution = { id: "cancel", label: "Cancel" };

// Factory helpers for the fixed-shape errors. Variable ones (#4, #11, #12) are
// built at the call site because their buttons depend on runtime data.
export const Errors = {
  misc: (msg = "Something went wrong.") =>
    new OffshootError(1, msg, [{ id: "retry", label: "Retry" }, CANCEL]),

  prNotFound: (id: string) =>
    new OffshootError(2, `PR ${prNum(id)} not found.`, [
      { id: "refreshList", label: "Refresh PR list" },
      CANCEL
    ]),

  lineOutOfRange: (file: string) =>
    new OffshootError(
      3,
      `Stored deltas no longer line up with ${file} (line out of range).`,
      [
        { id: "recapture", label: "Re-capture (loses record)", destructive: true },
        { id: "discard", label: "Discard PR", destructive: true },
        { id: "revealFolder", label: "Reveal folder" },
        CANCEL
      ]
    ),

  contentMismatch: (file: string) =>
    new OffshootError(
      4,
      `A line in ${file} no longer matches what the delta expected (changed outside this PR).`,
      [
        { id: "keepDisk", label: "Keep disk version" },
        { id: "forceBaseline", label: "Force baseline", destructive: true },
        { id: "recapture", label: "Re-capture this PR", destructive: true },
        CANCEL
      ]
    ),

  idExists: (id: string) =>
    new OffshootError(5, `PR ${prNum(id)} already exists.`, [
      { id: "openExisting", label: `Open existing PR ${prNum(id)}`, data: id },
      { id: "useDifferentId", label: "Use a different id" },
      CANCEL
    ]),

  noActivePR: () =>
    new OffshootError(6, "No active PR.", [
      { id: "openNew", label: "Open a new PR" },
      { id: "selectExisting", label: "Select an existing PR" },
      CANCEL
    ]),

  folderMissing: (id: string) =>
    new OffshootError(7, `PR ${prNum(id)} folder is missing or closed.`, [
      { id: "removeFromList", label: "Remove from list", data: id },
      CANCEL
    ]),

  metaUnreadable: (id: string) =>
    new OffshootError(8, `meta.json for PR ${prNum(id)} is unreadable.`, [
      { id: "revealFolder", label: "Reveal folder", data: id },
      { id: "discard", label: "Discard PR", destructive: true, data: id },
      CANCEL
    ]),

  deltasUnreadable: (id: string) =>
    new OffshootError(9, `deltas.json for PR ${prNum(id)} is unreadable.`, [
      { id: "recapture", label: "Re-capture (loses record)", destructive: true, data: id },
      { id: "discard", label: "Discard PR", destructive: true, data: id },
      { id: "revealFolder", label: "Reveal folder", data: id },
      CANCEL
    ]),

  unsavedChanges: (files: string[]) =>
    new OffshootError(
      10,
      `Affected files have unsaved changes: ${files.join(", ")}.`,
      [
        { id: "save", label: "Save & continue" },
        { id: "discardBuffers", label: "Discard & continue", destructive: true },
        CANCEL
      ]
    ),

  fileMissing: (file: string, canRecreate: boolean) =>
    new OffshootError(
      11,
      `File no longer exists: ${file}.`,
      [
        { id: "skipFile", label: "Skip this file", data: file },
        ...(canRecreate
          ? [{ id: "recreate", label: "Recreate from baseline", data: file } as Resolution]
          : []),
        CANCEL
      ]
    ),

  // #12 — committing a PR that overlaps others on a file. Resolve by committing
  // one side (which removes the conflict).
  overlap: (file: string, prX: string, overlappingIds: string[]) => {
    const buttons: Resolution[] = [
      { id: "commitOverlap", label: `Commit PR ${prNum(prX)} only`, data: prX },
      ...overlappingIds.map(
        (oid): Resolution => ({
          id: "commitOverlap",
          label: `Commit PR ${prNum(oid)}`,
          data: oid
        })
      )
    ];
    if (overlappingIds.length > 0) {
      buttons.push({
        id: "commitAllOverlap",
        label: "Commit all overlapping",
        data: [prX, ...overlappingIds]
      });
    }
    buttons.push(CANCEL);
    return new OffshootError(
      12,
      `PR ${prNum(prX)} and ${overlappingIds.length} other open PR(s) modify ${file}. How do you want to proceed?`,
      buttons
    );
  },

  // #15 — reverting a PR that overlaps others on a file. Offer to revert anyway
  // (overwrite to baseline despite the overlap), or commit one side first.
  overlapRevert: (file: string, prX: string, overlappingIds: string[]) => {
    const buttons: Resolution[] = [
      {
        id: "forceBaseline",
        label: `Revert PR ${prNum(prX)} anyway`,
        destructive: true,
        data: prX
      },
      ...overlappingIds.map(
        (oid): Resolution => ({
          id: "commitOverlap",
          label: `Commit PR ${prNum(oid)} first`,
          data: oid
        })
      )
    ];
    if (overlappingIds.length > 0) {
      buttons.push({
        id: "commitAllOverlap",
        label: "Commit all overlapping first",
        data: [prX, ...overlappingIds]
      });
    }
    buttons.push(CANCEL);
    return new OffshootError(
      15,
      `Reverting PR ${prNum(prX)} would overwrite ${file}, which ${overlappingIds.length} other open PR(s) also modify. How do you want to proceed?`,
      buttons
    );
  },

  noDiffInSelection: () =>
    new OffshootError(13, "No diff in the selected region.", [
      { id: "chooseSelection", label: "Choose another selection" },
      CANCEL
    ])
};
