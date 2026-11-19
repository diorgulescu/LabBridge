import { useCallback, useMemo, useRef, useState } from "react";
import {
  filterAndSortEntries,
  type SortDirection,
  type SortField,
} from "./formatters";
import type { DirListing, FsEntry } from "../../types/labbridge";

export interface FilePaneState {
  listing: DirListing | null;
  setListing: React.Dispatch<React.SetStateAction<DirListing | null>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  filter: string;
  setFilter: React.Dispatch<React.SetStateAction<string>>;
  sortField: SortField;
  sortDir: SortDirection;
  selectedPath: string | null;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  jumpOpen: boolean;
  setJumpOpen: React.Dispatch<React.SetStateAction<boolean>>;
  jumpInput: string;
  setJumpInput: React.Dispatch<React.SetStateAction<string>>;
  newFolderOpen: boolean;
  setNewFolderOpen: React.Dispatch<React.SetStateAction<boolean>>;
  newFolderName: string;
  setNewFolderName: React.Dispatch<React.SetStateAction<string>>;
  sortedEntries: FsEntry[];
  selectedEntry: FsEntry | null;
  pathRef: React.MutableRefObject<string | undefined>;
  toggleSort: (field: SortField) => void;
}

/**
 * Shared state hook for a single file-explorer pane (local or remote).
 * Encapsulates listing, loading, filter, sort, selection, quick-jump,
 * and new-folder state so the pane components stay focused on rendering.
 */
export function useFilePaneState(
  listing: DirListing | null,
  setListing: React.Dispatch<React.SetStateAction<DirListing | null>>,
): FilePaneState {
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpInput, setJumpInput] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const pathRef = useRef<string | undefined>(undefined);
  pathRef.current = listing?.path;

  const sortedEntries = useMemo(
    () => filterAndSortEntries(listing?.entries ?? [], filter, sortField, sortDir),
    [listing, filter, sortField, sortDir],
  );

  const selectedEntry = useMemo(
    () => listing?.entries.find((e) => e.path === selectedPath) ?? null,
    [listing, selectedPath],
  );

  const toggleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("asc");
      }
    },
    [sortField],
  );

  return {
    listing,
    setListing,
    loading,
    setLoading,
    filter,
    setFilter,
    sortField,
    sortDir,
    selectedPath,
    setSelectedPath,
    jumpOpen,
    setJumpOpen,
    jumpInput,
    setJumpInput,
    newFolderOpen,
    setNewFolderOpen,
    newFolderName,
    setNewFolderName,
    sortedEntries,
    selectedEntry,
    pathRef,
    toggleSort,
  };
}
