import { ChangeEvent, MouseEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { decompress } from "fzstd";

type Kind = "movesets" | "dependencies" | "skills" | "presets" | "meshes" | "audio" | "textures";
type SkillObject = Record<string, unknown>;
type AssetData = { id: string; image?: string };
type Item = {
  id: string;
  kind: Kind;
  name: string;
  data: SkillObject | SkillObject[] | AssetData;
  createdAt: string;
  updatedAt: string;
};
type Library = { version: 1; items: Item[] };
type SelectionRef = {
  key: string;
  level: "kind" | "item" | "skill" | "section";
  kind: Kind;
  itemId?: string;
  skillIndex?: number;
  path?: (string | number)[];
};
type MenuState = { x: number; y: number; ref: SelectionRef } | null;

const KINDS: { id: Kind; label: string }[] = [
  { id: "movesets", label: "Movesets" },
  { id: "dependencies", label: "Dependencies" },
  { id: "skills", label: "Skills" },
  { id: "presets", label: "Presets" },
  { id: "meshes", label: "Mesh Library" },
  { id: "audio", label: "Audio Library" },
  { id: "textures", label: "Texture Library" },
];
const KIND_IDS = new Set<Kind>(KINDS.map((entry) => entry.id));

const emptyLibrary: Library = { version: 1, items: [] };
const clone = <T,>(value: T): T => structuredClone(value);
const uid = () => crypto.randomUUID();
const isSkill = (value: unknown): value is SkillObject =>
  !!value && typeof value === "object" && !Array.isArray(value) && ("DATA" in value || "K_NAME" in value || "NAME" in value);
const isAssetKind = (kind: Kind) => kind === "meshes" || kind === "audio" || kind === "textures";
const displaySkillName = (skill: SkillObject, index: number) => String(skill.NAME || skill.K_NAME || `Skill ${index + 1}`);
const cleanFilename = (name: string) => name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "export";

function parseSkillData(skill: SkillObject): Record<string, unknown> | null {
  try {
    const parsed = typeof skill.DATA === "string" ? JSON.parse(skill.DATA) as unknown : skill.DATA;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return clone(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
  return null;
}

function sectionRows(skill: SkillObject) {
  const rows: { label: string; path: (string | number)[] }[] = [];
  Object.keys(skill).filter((key) => key !== "DATA").forEach((key) => rows.push({ label: key, path: [key] }));
  const data = parseSkillData(skill);
  if (!data) {
    if ("DATA" in skill) rows.push({ label: "DATA (invalid JSON string)", path: ["DATA"] });
    return rows;
  }
  for (const key of Object.keys(data)) {
    if (key === "Branch" && data.Branch && typeof data.Branch === "object" && !Array.isArray(data.Branch)) {
      for (const branch of Object.keys(data.Branch as object)) rows.push({ label: `Branch: ${branch}`, path: ["DATA", "Branch", branch] });
    } else {
      rows.push({ label: `DATA.${key}`, path: ["DATA", key] });
    }
  }
  return rows;
}

function getAtPath(skill: SkillObject, path: (string | number)[]) {
  if (path[0] !== "DATA") return path.reduce<unknown>((value, key) => (value as Record<string | number, unknown>)?.[key], skill);
  if (path.length === 1) return skill.DATA;
  const data = parseSkillData(skill);
  return path.slice(1).reduce<unknown>((value, key) => (value as Record<string | number, unknown>)?.[key], data);
}

function setAtPath(skill: SkillObject, path: (string | number)[], value: unknown) {
  const next = clone(skill);
  if (path[0] !== "DATA") {
    if (path.length === 1) next[String(path[0])] = value;
    return next;
  }
  if (path.length === 1) {
    next.DATA = typeof value === "string" ? value : JSON.stringify(value);
    return next;
  }
  const data = parseSkillData(next) ?? {};
  let cursor: Record<string | number, unknown> = data;
  path.slice(1, -1).forEach((key) => {
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key] as Record<string | number, unknown>;
  });
  cursor[path[path.length - 1]] = value;
  next.DATA = JSON.stringify(data);
  return next;
}

function deleteAtPath(skill: SkillObject, path: (string | number)[]) {
  const next = clone(skill);
  if (path[0] !== "DATA") {
    delete next[String(path[0])];
    return next;
  }
  if (path.length === 1) {
    delete next.DATA;
    return next;
  }
  const data = parseSkillData(next) ?? {};
  let cursor: Record<string | number, unknown> = data;
  path.slice(1, -1).forEach((key) => { cursor = cursor[key] as Record<string | number, unknown>; });
  delete cursor[path[path.length - 1]];
  next.DATA = JSON.stringify(data);
  return next;
}

function walk(value: unknown, visit: (object: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) visit(value as Record<string, unknown>);
  Object.values(value).forEach((child) => walk(child, visit));
}

function tagKeys(skill: SkillObject, checkedOnly = false) {
  const keys = new Set<string>();
  walk(parseSkillData(skill) ?? skill, (node) => {
    if (node.K_NAME === "TAG" && (!checkedOnly || node.CHECK === true)) keys.add(`${String(node.TAG)}\u0000${String(node.VALUE)}`);
  });
  return keys;
}

function replaceField(value: unknown, field: string, oldValue: string, newValue: string, insideField = false): unknown {
  if (Array.isArray(value)) return value.map((part) => replaceField(part, field, oldValue, newValue, insideField));
  if (!value || typeof value !== "object") return insideField && String(value) === oldValue ? newValue : value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, part] of Object.entries(value)) {
    result[key] = replaceField(part, field, oldValue, newValue, insideField || key.toUpperCase().includes(field));
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const unpadded = value.replace(/^data:[^,]+,/, "").replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const normalized = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function decodeImport(input: string | ArrayBuffer) {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    const trimmed = input.trim();
    try { return JSON.parse(trimmed) as unknown; } catch { /* Try encoded input. */ }
    try { bytes = base64ToBytes(trimmed); } catch { throw new Error("Input is neither valid JSON nor valid base64."); }
  } else {
    bytes = new Uint8Array(input);
    const text = new TextDecoder().decode(bytes).trim();
    try { return JSON.parse(text) as unknown; } catch { /* Try encoded or compressed input. */ }
    const rawIsZstd = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
    if (!rawIsZstd) {
      try { bytes = base64ToBytes(text); } catch { throw new Error("The selected file is neither JSON, base64 JSON, nor Zstandard data."); }
    }
  }
  const isZstd = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
  if (isZstd) {
    try {
      bytes = decompress(bytes);
    } catch {
      throw new Error("The Zstandard data could not be decompressed. Check that the file is a complete .zst payload.");
    }
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error("Decoded data is not valid JSON."); }
}

function isAssetData(value: unknown): value is AssetData {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as AssetData).id === "string" &&
    ((value as AssetData).image === undefined || typeof (value as AssetData).image === "string");
}

function normalizeSkill(skill: SkillObject) {
  const next = clone(skill);
  if ("DATA" in next && typeof next.DATA !== "string") {
    const serialized = JSON.stringify(next.DATA);
    if (serialized !== undefined) next.DATA = serialized;
  }
  return next;
}

function validateLibrary(value: unknown): value is Library {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Library>;
  if (candidate.version !== 1 || !Array.isArray(candidate.items)) return false;
  const ids = new Set<string>();
  return candidate.items.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Item;
    if (typeof entry.id !== "string" || ids.has(entry.id) || !KIND_IDS.has(entry.kind) || typeof entry.name !== "string" ||
      typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") return false;
    ids.add(entry.id);
    if (isAssetKind(entry.kind)) return isAssetData(entry.data);
    return Array.isArray(entry.data) ? entry.data.every(isSkill) : isSkill(entry.data);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("json-skill-library", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadLibrary() {
  const db = await openDatabase();
  return new Promise<Library>((resolve, reject) => {
    const request = db.transaction("state", "readonly").objectStore("state").get("library");
    request.onsuccess = () => resolve((request.result as Library | undefined) ?? emptyLibrary);
    request.onerror = () => reject(request.error);
  });
}

async function saveLibrary(library: Library) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    tx.objectStore("state").put(library, "library");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function download(name: string, content: string, type = "text/plain") {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export default function App() {
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [ready, setReady] = useState(false);
  const [kind, setKind] = useState<Kind>("movesets");
  const [itemId, setItemId] = useState<string>();
  const [skillIndex, setSkillIndex] = useState<number>();
  const [path, setPath] = useState<(string | number)[]>();
  const [selected, setSelected] = useState<SelectionRef[]>([]);
  const [anchor, setAnchor] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<MenuState>(null);
  const [dialog, setDialog] = useState<"import" | "new" | "replace" | "section" | "help" | null>(null);
  const [notice, setNotice] = useState("Loading local library...");
  const [editor, setEditor] = useState("");
  const [editorError, setEditorError] = useState("");
  const [importText, setImportText] = useState("");
  const [importDecoded, setImportDecoded] = useState<unknown>();
  const [importName, setImportName] = useState("");
  const [importKind, setImportKind] = useState<Kind>("movesets");
  const [importTarget, setImportTarget] = useState("new");
  const [splitImport, setSplitImport] = useState(true);
  const [newName, setNewName] = useState("");
  const [newAssetId, setNewAssetId] = useState("");
  const [newAssetImage, setNewAssetImage] = useState<string>();
  const [sectionName, setSectionName] = useState("");
  const [sectionValue, setSectionValue] = useState("{}");
  const [replacement, setReplacement] = useState({ field: "MESH", oldValue: "", newValue: "" });
  const clipboard = useRef<{ mode: "copy" | "cut"; refs: SelectionRef[]; library: Library } | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadLibrary().then((value) => {
      setLibrary(value);
      setReady(true);
      setNotice(`Local library ready: ${value.items.length} item${value.items.length === 1 ? "" : "s"}.`);
    }).catch((error) => {
      setReady(true);
      setNotice(`Could not open local memory: ${String(error)}`);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => saveLibrary(library).then(() => setNotice("Saved locally.")).catch((error) => setNotice(`Save failed: ${String(error)}`)), 250);
    return () => window.clearTimeout(timer);
  }, [library, ready]);

  const items = useMemo(() => library.items.filter((item) => item.kind === kind), [library, kind]);
  const item = library.items.find((candidate) => candidate.id === itemId);
  const skills: SkillObject[] = item && !isAssetKind(item.kind) ? (Array.isArray(item.data) ? item.data : isSkill(item.data) ? [item.data] : []) : [];
  const activeSkill = skillIndex !== undefined ? skills[skillIndex] : item && isSkill(item.data) ? item.data : undefined;
  const sections = activeSkill ? sectionRows(activeSkill) : [];
  const activeRef: SelectionRef | undefined = path && item && skillIndex !== undefined
    ? { key: `section:${item.id}:${skillIndex}:${path.join("/")}`, level: "section", kind, itemId: item.id, skillIndex, path }
    : skillIndex !== undefined && item
      ? { key: `skill:${item.id}:${skillIndex}`, level: "skill", kind, itemId: item.id, skillIndex }
      : item
        ? { key: `item:${item.id}`, level: "item", kind, itemId: item.id }
        : undefined;

  useEffect(() => {
    let value: unknown = activeSkill;
    if (activeSkill && path) value = getAtPath(activeSkill, path);
    else if (item && isAssetKind(item.kind)) value = item.data;
    setEditor(value === undefined ? "" : JSON.stringify(value, null, 2));
    setEditorError("");
  }, [itemId, skillIndex, path, library]);

  function mutateItem(id: string, mutate: (item: Item) => Item) {
    setLibrary((current) => ({ ...current, items: current.items.map((entry) => entry.id === id ? { ...mutate(clone(entry)), updatedAt: new Date().toISOString() } : entry) }));
  }

  function setActiveSkill(next: SkillObject) {
    if (!item) return;
    mutateItem(item.id, (entry) => {
      if (Array.isArray(entry.data)) entry.data[skillIndex ?? 0] = next;
      else entry.data = next;
      return entry;
    });
  }

  function allVisibleRefs(level: SelectionRef["level"]) {
    if (level === "kind") return KINDS.map((entry) => ({ key: `kind:${entry.id}`, level, kind: entry.id } as SelectionRef));
    if (level === "item") return items.map((entry) => ({ key: `item:${entry.id}`, level, kind, itemId: entry.id } as SelectionRef));
    if (level === "skill" && item) return skills.map((_, index) => ({ key: `skill:${item.id}:${index}`, level, kind, itemId: item.id, skillIndex: index } as SelectionRef));
    if (level === "section" && item && skillIndex !== undefined) return sections.map((section) => ({ key: `section:${item.id}:${skillIndex}:${section.path.join("/")}`, level, kind, itemId: item.id, skillIndex, path: section.path } as SelectionRef));
    return [];
  }

  function selectRef(ref: SelectionRef, event?: MouseEvent | PointerEvent, fromDrag = false) {
    const visible = allVisibleRefs(ref.level);
    const additive = !!event && (event.metaKey || event.ctrlKey);
    const range = !!event && event.shiftKey && anchor;
    if (range) {
      const start = visible.findIndex((entry) => entry.key === anchor);
      const end = visible.findIndex((entry) => entry.key === ref.key);
      if (start >= 0 && end >= 0) {
        const block = visible.slice(Math.min(start, end), Math.max(start, end) + 1);
        setSelected(additive ? (current) => [...current.filter((old) => !block.some((entry) => entry.key === old.key)), ...block] : block);
      } else {
        setSelected([ref]);
        setAnchor(ref.key);
      }
    } else if (additive) {
      setSelected((current) => current.some((entry) => entry.key === ref.key) ? current.filter((entry) => entry.key !== ref.key) : [...current, ref]);
      setAnchor(ref.key);
    } else if (fromDrag) {
      setSelected((current) => current.some((entry) => entry.key === ref.key) ? current : [...current, ref]);
    } else {
      setSelected([ref]);
      setAnchor(ref.key);
    }
    if (ref.level === "kind") { setKind(ref.kind); setItemId(undefined); setSkillIndex(undefined); setPath(undefined); }
    if (ref.level === "item") {
      const target = library.items.find((entry) => entry.id === ref.itemId);
      setKind(ref.kind); setItemId(ref.itemId); setSkillIndex(target && !isAssetKind(target.kind) && !Array.isArray(target.data) ? 0 : undefined); setPath(undefined);
    }
    if (ref.level === "skill") { setItemId(ref.itemId); setSkillIndex(ref.skillIndex); setPath(undefined); }
    if (ref.level === "section") { setItemId(ref.itemId); setSkillIndex(ref.skillIndex); setPath(ref.path); }
  }

  function rowPointerDown(ref: SelectionRef, event: PointerEvent) {
    if (event.button !== 0) return;
    setDragging(true);
    selectRef(ref, event);
  }

  function context(ref: SelectionRef, event: MouseEvent) {
    event.preventDefault();
    if (!selected.some((entry) => entry.key === ref.key)) selectRef(ref, event);
    setMenu({ x: event.clientX, y: event.clientY, ref });
  }

  async function decodeCurrentImport(source?: string | ArrayBuffer) {
    try {
      const decoded = await decodeImport(source ?? importText);
      const values = Array.isArray(decoded) ? decoded : [decoded];
      if (values.length === 0) throw new Error("The imported moveset contains no skills.");
      if (!values.every(isSkill)) throw new Error("Imported JSON must be a skill object or an array of skill objects.");
      const normalized = values.map(normalizeSkill);
      setImportDecoded(Array.isArray(decoded) ? normalized : normalized[0]);
      setNotice(`Import decoded: ${values.length} skill${values.length === 1 ? "" : "s"}. Choose its destination.`);
      setImportName(values.length === 1 ? displaySkillName(values[0], 0) : "Imported Moveset");
    } catch (error) {
      setImportDecoded(undefined);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function commitImport() {
    const incoming = (Array.isArray(importDecoded) ? importDecoded : [importDecoded]).filter(isSkill).map(clone);
    if (!incoming.length) return setNotice("Decode the import before adding it.");
    const now = new Date().toISOString();
    if (importKind === "movesets" && importTarget !== "new") {
      mutateItem(importTarget, (entry) => ({ ...entry, data: [...(Array.isArray(entry.data) ? entry.data : isSkill(entry.data) ? [entry.data] : []), ...incoming] }));
    } else if (importKind === "movesets" || !splitImport) {
      setLibrary((current) => ({ ...current, items: [...current.items, { id: uid(), kind: importKind, name: importName || "Imported item", data: importKind === "movesets" ? incoming : incoming.length === 1 ? incoming[0] : incoming, createdAt: now, updatedAt: now }] }));
    } else {
      setLibrary((current) => ({ ...current, items: [...current.items, ...incoming.map((skill, index) => ({ id: uid(), kind: importKind, name: incoming.length === 1 && importName ? importName : displaySkillName(skill, index), data: skill, createdAt: now, updatedAt: now }))] }));
    }
    setDialog(null); setImportDecoded(undefined); setImportText(""); setImportName("");
    setNotice("Import added to the local library.");
  }

  function addNew() {
    if (!newName.trim()) return;
    const now = new Date().toISOString();
    const data: Item["data"] = isAssetKind(kind) ? { id: newAssetId.trim(), ...(newAssetImage ? { image: newAssetImage } : {}) } : kind === "movesets" ? [] : { NAME: newName.trim(), K_NAME: "SKILL", DATA: JSON.stringify({ Line: [], Prop: {}, Req: [], Branch: {} }) };
    const next: Item = { id: uid(), kind, name: newName.trim(), data, createdAt: now, updatedAt: now };
    setLibrary((current) => ({ ...current, items: [...current.items, next] }));
    setDialog(null); setNewName(""); setNewAssetId(""); setNewAssetImage(undefined); setItemId(next.id); setSkillIndex(undefined); setPath(undefined); setSelected([]);
  }

  function saveEditor() {
    try {
      const value = JSON.parse(editor) as unknown;
      if (!item) return;
      if (isAssetKind(item.kind)) {
        if (!isAssetData(value)) throw new Error("An asset record must be an object with a string ID and optional string image.");
        mutateItem(item.id, (entry) => ({ ...entry, data: value }));
      }
      else if (activeSkill && path) setActiveSkill(setAtPath(activeSkill, path, value));
      else if (activeSkill && isSkill(value)) setActiveSkill(normalizeSkill(value));
      else throw new Error("The complete skill editor must contain a skill object.");
      setEditorError(""); setNotice("Section saved without changing surrounding data.");
    } catch (error) { setEditorError(error instanceof Error ? error.message : String(error)); }
  }

  function renameItem() {
    if (!item) return;
    const name = window.prompt("Library name", item.name)?.trim();
    if (name) mutateItem(item.id, (entry) => ({ ...entry, name }));
  }

  function duplicateRefs(refs = selected) {
    const now = new Date().toISOString();
    const additions: Item[] = [];
    const skillCopies = new Map<string, SkillObject[]>();
    refs.forEach((ref) => {
      const source = library.items.find((entry) => entry.id === ref.itemId);
      if (!source) return;
      if (ref.level === "item") additions.push({ ...clone(source), id: uid(), name: `${source.name} copy`, createdAt: now, updatedAt: now });
      if (ref.level === "skill" && ref.skillIndex !== undefined) {
        const sourceSkills = Array.isArray(source.data) ? source.data : isSkill(source.data) ? [source.data] : [];
        const copy = clone(sourceSkills[ref.skillIndex]);
        const list = skillCopies.get(source.id) ?? [];
        list.push(copy); skillCopies.set(source.id, list);
      }
    });
    setLibrary((current) => ({ ...current, items: [...current.items.map((entry) => skillCopies.has(entry.id) ? { ...entry, data: [...(Array.isArray(entry.data) ? entry.data : isSkill(entry.data) ? [entry.data] : []), ...skillCopies.get(entry.id)!], updatedAt: now } : entry), ...additions] }));
  }

  function deleteRefs(refs = selected) {
    const kinds = new Set(refs.filter((ref) => ref.level === "kind").map((ref) => ref.kind));
    const itemIds = new Set(refs.filter((ref) => ref.level === "item").map((ref) => ref.itemId));
    const skillsByItem = new Map<string, Set<number>>();
    refs.filter((ref) => ref.level === "skill" && ref.itemId && ref.skillIndex !== undefined).forEach((ref) => {
      const set = skillsByItem.get(ref.itemId!) ?? new Set<number>(); set.add(ref.skillIndex!); skillsByItem.set(ref.itemId!, set);
    });
    refs.filter((ref) => ref.level === "section" && ref.itemId && ref.skillIndex !== undefined && ref.path).forEach((ref) => {
      mutateItem(ref.itemId!, (entry) => {
        if (Array.isArray(entry.data)) entry.data[ref.skillIndex!] = deleteAtPath(entry.data[ref.skillIndex!], ref.path!);
        else if (isSkill(entry.data)) entry.data = deleteAtPath(entry.data, ref.path!);
        return entry;
      });
    });
    setLibrary((current) => ({ ...current, items: current.items.filter((entry) => !kinds.has(entry.kind) && !itemIds.has(entry.id)).map((entry) => {
      const indexes = skillsByItem.get(entry.id);
      if (!indexes) return entry;
      const list = Array.isArray(entry.data) ? entry.data : isSkill(entry.data) ? [entry.data] : [];
      return { ...entry, data: list.filter((_, index) => !indexes.has(index)), updatedAt: new Date().toISOString() };
    }) }));
    setSelected([]); setItemId(undefined); setSkillIndex(undefined); setPath(undefined);
  }

  function pasteRefs(target = activeRef) {
    if (!clipboard.current || !target) return;
    const sourceRefs = clipboard.current.refs;
    const sourceLibrary = clipboard.current.library;
    if (clipboard.current.mode === "cut") {
      const alreadyAtTarget = (target.level === "kind" && sourceRefs.every((ref) =>
        (ref.level === "kind" && ref.kind === target.kind) ||
        (ref.level === "item" && sourceLibrary.items.find((entry) => entry.id === ref.itemId)?.kind === target.kind))) ||
        (target.itemId !== undefined && sourceRefs.some((ref) => ref.level === "item" && ref.itemId === target.itemId)) ||
        (target.itemId !== undefined && sourceRefs.some((ref) => ref.level === "kind" && ref.kind === library.items.find((entry) => entry.id === target.itemId)?.kind)) ||
        (target.level === "section" && sourceRefs.some((ref) => ref.key === target.key));
      if (alreadyAtTarget) {
        clipboard.current = undefined;
        setNotice("The cut selection is already at that destination.");
        return;
      }
    }
    const copiedItems = sourceRefs.flatMap((ref) => ref.level === "kind" ? sourceLibrary.items.filter((entry) => entry.kind === ref.kind) : ref.level === "item" ? sourceLibrary.items.filter((entry) => entry.id === ref.itemId) : []);
    if (target.level === "kind") {
      const copiedSkills = sourceRefs.flatMap((ref) => {
        if (ref.level !== "skill" || !ref.itemId || ref.skillIndex === undefined) return [];
        const source = sourceLibrary.items.find((entry) => entry.id === ref.itemId);
        const list = source ? (Array.isArray(source.data) ? source.data : isSkill(source.data) ? [source.data] : []) : [];
        return list[ref.skillIndex] ? [clone(list[ref.skillIndex])] : [];
      });
      const compatibleItems = copiedItems.filter((entry) => isAssetKind(target.kind) ? isAssetData(entry.data) : !isAssetKind(entry.kind));
      const hasUnsupported = compatibleItems.length !== copiedItems.length || sourceRefs.some((ref) => ref.level === "section") || (isAssetKind(target.kind) && copiedSkills.length > 0);
      if (hasUnsupported && clipboard.current.mode === "cut") {
        setNotice("That cut selection cannot be moved into this kind without changing its data format.");
        return;
      }
      if (!compatibleItems.length && !copiedSkills.length) {
        setNotice("The copied selection is not compatible with this kind.");
        return;
      }
      const now = new Date().toISOString();
      const itemAdditions = compatibleItems.map((entry) => ({
        ...clone(entry), id: uid(), kind: target.kind,
        name: clipboard.current?.mode === "cut" ? entry.name : `${entry.name} copy`,
        data: target.kind === "movesets" && !Array.isArray(entry.data) ? [clone(entry.data as SkillObject)] : clone(entry.data),
        createdAt: now, updatedAt: now,
      }));
      const skillAdditions = isAssetKind(target.kind) ? [] : copiedSkills.map((skill, index) => ({
        id: uid(), kind: target.kind, name: displaySkillName(skill, index),
        data: target.kind === "movesets" ? [skill] : skill, createdAt: now, updatedAt: now,
      }));
      setLibrary((current) => ({ ...current, items: [...current.items, ...itemAdditions, ...skillAdditions] }));
    } else if (target.level === "section" && target.itemId && target.skillIndex !== undefined && target.path) {
      const sourceRef = sourceRefs.find((ref) => ref.level === "section" && ref.itemId && ref.skillIndex !== undefined && ref.path);
      const source = sourceRef && sourceLibrary.items.find((entry) => entry.id === sourceRef.itemId);
      const sourceSkills = source ? (Array.isArray(source.data) ? source.data : isSkill(source.data) ? [source.data] : []) : [];
      if (sourceRef?.path && sourceSkills[sourceRef.skillIndex!]) {
        const targetItem = library.items.find((entry) => entry.id === target.itemId);
        const targetSkills = targetItem ? (Array.isArray(targetItem.data) ? targetItem.data : isSkill(targetItem.data) ? [targetItem.data] : []) : [];
        const targetSkill = targetSkills[target.skillIndex];
        if (targetSkill) {
          const replaced = setAtPath(targetSkill, target.path, clone(getAtPath(sourceSkills[sourceRef.skillIndex!], sourceRef.path)));
          mutateItem(target.itemId, (entry) => {
            if (Array.isArray(entry.data)) entry.data[target.skillIndex!] = replaced;
            else entry.data = replaced;
            return entry;
          });
        }
      }
    } else if (target.itemId) {
      const targetItem = library.items.find((entry) => entry.id === target.itemId);
      if (!targetItem) return;
      if (isAssetKind(targetItem.kind)) {
        const sourceAsset = copiedItems.find((entry) => isAssetKind(entry.kind) && isAssetData(entry.data));
        if (!sourceAsset) {
          setNotice("Only another asset record can be pasted onto an asset.");
          return;
        }
        mutateItem(target.itemId, (entry) => ({ ...entry, data: clone(sourceAsset.data) }));
        if (clipboard.current.mode === "cut") { deleteRefs(sourceRefs); clipboard.current = undefined; }
        setNotice("Asset data pasted.");
        return;
      }
      const copiedSkills: SkillObject[] = [];
      sourceRefs.forEach((ref) => {
        const source = sourceLibrary.items.find((entry) => entry.id === ref.itemId);
        if (!source) return;
        const list = Array.isArray(source.data) ? source.data : isSkill(source.data) ? [source.data] : [];
        if (ref.level === "skill" && ref.skillIndex !== undefined) copiedSkills.push(clone(list[ref.skillIndex]));
        if (ref.level === "item" && !isAssetKind(source.kind)) copiedSkills.push(...clone(list));
      });
      if (copiedSkills.length) mutateItem(target.itemId, (entry) => ({ ...entry, data: [...(Array.isArray(entry.data) ? entry.data : isSkill(entry.data) ? [entry.data] : []), ...copiedSkills] }));
    }
    if (clipboard.current.mode === "cut") { deleteRefs(sourceRefs); clipboard.current = undefined; }
    setNotice("Pasted.");
  }

  function exportBase64(ref: SelectionRef, withDependencies = true) {
    const source = library.items.find((entry) => entry.id === ref.itemId);
    if (!source) return;
    let data: unknown = source.data;
    let name = source.name;
    if ((ref.level === "skill" && ref.skillIndex !== undefined) || (ref.level === "item" && (source.kind === "skills" || source.kind === "presets"))) {
      const list = Array.isArray(source.data) ? source.data : isSkill(source.data) ? [source.data] : [];
      const index = ref.skillIndex ?? 0;
      const skill = list[index];
      if (!skill) return;
      data = [skill]; name = displaySkillName(skill, index);
      if (withDependencies && source.kind !== "dependencies") {
        const used = tagKeys(skill);
        const dependencies = library.items.filter((entry) => entry.kind === "dependencies").flatMap((entry) => Array.isArray(entry.data) ? entry.data : isSkill(entry.data) ? [entry.data] : []).filter((dependency) => [...tagKeys(dependency, true)].some((key) => used.has(key)));
        data = [skill, ...dependencies];
      }
    }
    if (ref.level === "section" && ref.skillIndex !== undefined && ref.path) {
      const list = Array.isArray(source.data) ? source.data : isSkill(source.data) ? [source.data] : [];
      data = getAtPath(list[ref.skillIndex], ref.path); name = `${name}-${ref.path.join("-")}`;
    }
    const raw = JSON.stringify(data);
    const base64 = bytesToBase64(new TextEncoder().encode(raw));
    download(`${cleanFilename(name)}.base64.txt`, base64);
    navigator.clipboard?.writeText(base64).catch(() => undefined);
    setNotice("Base64 export downloaded and copied to the clipboard when permitted.");
  }

  function applyReplacement() {
    if (!activeSkill || !replacement.oldValue) return;
    const data = parseSkillData(activeSkill);
    if (!data) return setNotice("This skill's DATA is not valid JSON.");
    const next = { ...activeSkill, DATA: JSON.stringify(replaceField(data, replacement.field, replacement.oldValue, replacement.newValue)) };
    setActiveSkill(next); setDialog(null); setNotice(`${replacement.field} references replaced in the selected skill.`);
  }

  function addSection() {
    if (!activeSkill || !sectionName.trim()) return;
    try {
      const value = JSON.parse(sectionValue) as unknown;
      const name = sectionName.trim();
      if (["__proto__", "prototype", "constructor"].includes(name)) throw new Error("That section name is reserved. Choose another name.");
      setActiveSkill(setAtPath(activeSkill, ["DATA", name], value));
      setPath(["DATA", name]); setDialog(null); setSectionName(""); setSectionValue("{}");
      setNotice(`Added DATA.${name}; all existing skill data was preserved.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  function backup() {
    download(`json-skill-library-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(library, null, 2), "application/json");
  }

  async function restore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const value = JSON.parse(await file.text()) as Library;
      if (!validateLibrary(value)) throw new Error("Not a valid or complete JSON Skill Library backup.");
      setLibrary(clone(value)); setItemId(undefined); setSkillIndex(undefined); setPath(undefined); setSelected([]);
      setNotice(`Restored ${value.items.length} library items.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    event.target.value = "";
  }

  useEffect(() => {
    const up = () => setDragging(false);
    const close = () => setMenu(null);
    const keys = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input, textarea, select")) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "c") { event.preventDefault(); clipboard.current = { mode: "copy", refs: clone(selected), library: clone(library) }; setNotice("Copied selection."); }
      if (command && event.key.toLowerCase() === "x") { event.preventDefault(); clipboard.current = { mode: "cut", refs: clone(selected), library: clone(library) }; setNotice("Cut selection; choose a destination and paste."); }
      if (command && event.key.toLowerCase() === "v") { event.preventDefault(); pasteRefs(); }
      if (command && event.key.toLowerCase() === "a") { event.preventDefault(); const level = activeRef?.level ?? "item"; setSelected(allVisibleRefs(level)); }
      if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); deleteRefs(); }
      if (event.key === "Escape") { setSelected([]); setMenu(null); }
    };
    window.addEventListener("pointerup", up); window.addEventListener("click", close); window.addEventListener("keydown", keys);
    return () => { window.removeEventListener("pointerup", up); window.removeEventListener("click", close); window.removeEventListener("keydown", keys); };
  });

  const Row = ({ refValue, children, detail }: { refValue: SelectionRef; children: React.ReactNode; detail?: string }) => (
    <button
      className={`tree-row ${selected.some((entry) => entry.key === refValue.key) ? "selected" : ""}`}
      onPointerDown={(event) => rowPointerDown(refValue, event)}
      onPointerEnter={(event) => dragging && selectRef(refValue, event, true)}
      onContextMenu={(event) => context(refValue, event)}
      type="button"
    >
      <span>{children}</span>{detail && <small>{detail}</small>}
    </button>
  );

  return (
    <main onPointerDown={(event) => {
      const target = event.target as HTMLElement;
      if (!target.closest("button, input, textarea, select, .tree-row, .context-menu")) setSelected([]);
    }}>
      <header>
        <strong>JSON Skill Library</strong>
        <div className="toolbar">
          <button onClick={() => setDialog("import")}>Import</button>
          <button onClick={() => { setNewName(""); setNewAssetId(""); setNewAssetImage(undefined); setDialog("new"); }}>New</button>
          <button onClick={backup}>Backup Library</button>
          <button onClick={() => restoreInput.current?.click()}>Restore Library</button>
          <button onClick={() => setDialog("help")}>Help</button>
          <input ref={restoreInput} hidden type="file" accept="application/json,.json" onChange={restore} />
        </div>
      </header>

      <div className="tree" onPointerDown={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>
        <section className="column">
          <h2>Kind</h2>
          {KINDS.map((entry) => <Row key={entry.id} refValue={{ key: `kind:${entry.id}`, level: "kind", kind: entry.id }}>{entry.label}</Row>)}
        </section>
        <section className="column">
          <h2>{KINDS.find((entry) => entry.id === kind)?.label}</h2>
          {items.length === 0 && <p className="empty">No items. Use Import or New.</p>}
          {items.map((entry) => <Row key={entry.id} refValue={{ key: `item:${entry.id}`, level: "item", kind, itemId: entry.id }} detail={isAssetKind(entry.kind) ? String((entry.data as AssetData).id || "No ID") : Array.isArray(entry.data) ? `${entry.data.length} skills` : "1 skill"}>{entry.name}</Row>)}
        </section>
        {item && !isAssetKind(item.kind) && (item.kind === "movesets" || Array.isArray(item.data)) && <section className="column">
          <h2>Skills</h2>
          {skills.length === 0 && <p className="empty">This item has no skills.</p>}
          {skills.map((skill, index) => <Row key={index} refValue={{ key: `skill:${item.id}:${index}`, level: "skill", kind, itemId: item.id, skillIndex: index }} detail={String(skill.K_NAME || "Unknown")}>{displaySkillName(skill, index)}</Row>)}
        </section>}
        {activeSkill && <section className="column">
          <h2>Skill Data</h2>
          {sections.map((section) => <Row key={section.path.join("/")} refValue={{ key: `section:${item!.id}:${skillIndex ?? 0}:${section.path.join("/")}`, level: "section", kind, itemId: item!.id, skillIndex: skillIndex ?? 0, path: section.path }}>{section.label}</Row>)}
        </section>}
        {item && <section className="inspector">
          <div className="inspector-heading">
            <div><h2>{path ? path.join(" > ") : item.name}</h2><small>{path ? "Isolated section editor" : isAssetKind(item.kind) ? "Asset record" : activeSkill ? "Complete skill editor" : "Select a skill"}</small></div>
            <div>
              <button onClick={renameItem}>Rename Library Item</button>
              {activeSkill && <button onClick={() => setDialog("section")}>Add DATA Section</button>}
              {activeSkill && <button onClick={() => { setReplacement({ field: "MESH", oldValue: "", newValue: "" }); setDialog("replace"); }}>Replace Mesh/Texture</button>}
            </div>
          </div>
          {(activeSkill || isAssetKind(item.kind)) ? <>
            <textarea className="editor" spellCheck={false} value={editor} onChange={(event) => setEditor(event.target.value)} />
            {editorError && <p className="error">{editorError}</p>}
            <div className="editor-actions"><button onClick={saveEditor}>Save JSON</button>{activeRef && <button onClick={() => exportBase64(activeRef, true)}>Export Base64</button>}{activeRef?.level === "skill" && <button onClick={() => exportBase64(activeRef, false)}>Export Without Dependencies</button>}</div>
          </> : <p className="empty">Select a skill to inspect or edit its JSON.</p>}
        </section>}
      </div>

      <footer><span>{notice}</span><span>{selected.length} selected</span></footer>

      {menu && <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
        <button onClick={() => { selectRef(menu.ref); setMenu(null); }}>Open</button>
        <button onClick={() => { clipboard.current = { mode: "cut", refs: clone(selected), library: clone(library) }; setMenu(null); }}>Cut</button>
        <button onClick={() => { clipboard.current = { mode: "copy", refs: clone(selected), library: clone(library) }; setMenu(null); }}>Copy</button>
        <button onClick={() => { pasteRefs(menu.ref); setMenu(null); }}>Paste</button>
        {(menu.ref.level === "item" || menu.ref.level === "skill") && <button onClick={() => { duplicateRefs(); setMenu(null); }}>Duplicate</button>}
        {(menu.ref.level === "item" || menu.ref.level === "skill" || menu.ref.level === "section") && <button onClick={() => { exportBase64(menu.ref, true); setMenu(null); }}>Export</button>}
        {(menu.ref.level === "skill" || (menu.ref.level === "item" && (menu.ref.kind === "skills" || menu.ref.kind === "presets"))) && <button onClick={() => { exportBase64(menu.ref, false); setMenu(null); }}>Export Without Dependencies</button>}
        {(menu.ref.level === "skill" || menu.ref.level === "section") && <button onClick={() => { setReplacement({ field: "MESH", oldValue: "", newValue: "" }); setDialog("replace"); setMenu(null); }}>Change Mesh/Texture</button>}
        <button className="danger" onClick={() => { deleteRefs(); setMenu(null); }}>Delete</button>
      </div>}

      {dialog === "import" && <div className="modal-backdrop"><div className="modal wide">
        <h2>Import JSON</h2>
        <p>Paste raw JSON or base64 JSON, or choose a JSON/base64/Zstandard file.</p>
        <textarea value={importText} onChange={(event) => { setImportText(event.target.value); setImportDecoded(undefined); }} placeholder="Paste complete moveset or individual skill here" />
        <input ref={fileInput} hidden type="file" accept=".json,.txt,.base64,.zst,.zstd,application/json,application/octet-stream" onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; if (file) await decodeCurrentImport(await file.arrayBuffer()); input.value = ""; }} />
        <div className="line"><button onClick={() => fileInput.current?.click()}>Choose File</button><button onClick={() => decodeCurrentImport()}>Decode Pasted Data</button></div>
        <label>Destination<select value={importKind} onChange={(event) => { setImportKind(event.target.value as Kind); setImportTarget("new"); }}><option value="movesets">Moveset</option><option value="dependencies">Dependency Library</option><option value="skills">Skill Library</option><option value="presets">Preset Library</option></select></label>
        {importKind === "movesets" && <label>Moveset<select value={importTarget} onChange={(event) => setImportTarget(event.target.value)}><option value="new">Create new moveset</option>{library.items.filter((entry) => entry.kind === "movesets").map((entry) => <option key={entry.id} value={entry.id}>Add to {entry.name}</option>)}</select></label>}
        {(importTarget === "new" || importKind !== "movesets") && <label>Library name<input value={importName} onChange={(event) => setImportName(event.target.value)} /></label>}
        {importKind !== "movesets" && <label className="check"><input type="checkbox" checked={splitImport} onChange={(event) => setSplitImport(event.target.checked)} /> Split arrays into individually named entries</label>}
        <div className="modal-actions"><button onClick={() => setDialog(null)}>Cancel</button><button disabled={!importDecoded} onClick={commitImport}>Add to Library</button></div>
      </div></div>}

      {dialog === "new" && <div className="modal-backdrop"><div className="modal">
        <h2>New {KINDS.find((entry) => entry.id === kind)?.label}</h2>
        <label>Name<input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
        {isAssetKind(kind) && <><label>ID<input value={newAssetId} onChange={(event) => setNewAssetId(event.target.value)} /></label><label>Optional image<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setNewAssetImage(String(reader.result)); reader.readAsDataURL(file); }} /></label></>}
        <div className="modal-actions"><button onClick={() => setDialog(null)}>Cancel</button><button onClick={addNew}>Create</button></div>
      </div></div>}

      {dialog === "replace" && <div className="modal-backdrop"><div className="modal">
        <h2>Change Mesh or Texture</h2>
        <label>Field type<select value={replacement.field} onChange={(event) => setReplacement({ ...replacement, field: event.target.value })}><option value="MESH">Mesh</option><option value="TEXTURE">Texture</option></select></label>
        <label>Current exact ID<input value={replacement.oldValue} onChange={(event) => setReplacement({ ...replacement, oldValue: event.target.value })} /></label>
        <label>New ID<input list="asset-ids" value={replacement.newValue} onChange={(event) => setReplacement({ ...replacement, newValue: event.target.value })} /></label>
        <datalist id="asset-ids">{library.items.filter((entry) => replacement.field === "MESH" ? entry.kind === "meshes" : entry.kind === "textures").map((entry) => <option key={entry.id} value={String((entry.data as AssetData).id)}>{entry.name}</option>)}</datalist>
        <div className="modal-actions"><button onClick={() => setDialog(null)}>Cancel</button><button onClick={applyReplacement}>Replace in Skill</button></div>
      </div></div>}

      {dialog === "section" && <div className="modal-backdrop"><div className="modal">
        <h2>Add DATA Section</h2>
        <p>A new top-level field will be added inside the selected skill's stringified DATA object.</p>
        <label>Section name<input autoFocus value={sectionName} onChange={(event) => setSectionName(event.target.value)} placeholder="Example: Custom Data" /></label>
        <label>Initial JSON value<textarea value={sectionValue} onChange={(event) => setSectionValue(event.target.value)} /></label>
        <div className="modal-actions"><button onClick={() => setDialog(null)}>Cancel</button><button onClick={addSection}>Add Section</button></div>
      </div></div>}

      {dialog === "help" && <div className="modal-backdrop"><div className="modal wide">
        <h2>How this library works</h2>
        <p>Everything is stored in this browser using IndexedDB. GitHub stores the website code, not your private library. Use Backup Library regularly and Restore Library to move it to another browser or device.</p>
        <p>Navigate left to right: kind, library item, skill when applicable, then isolated skill-data sections. Saving an isolated section rebuilds the DATA JSON string and preserves all other fields.</p>
        <p>Selection: click selects; Shift-click selects a range; Command/Ctrl-click adds or removes one; drag across rows adds them. Right-click for actions. Command/Ctrl+C, V, X and Backspace/Delete are supported.</p>
        <p>Dependency export matches a selected skill's TAG nodes against checked TAG nodes in the Dependency library using both TAG and VALUE. Export Without Dependencies always returns only the selected skill.</p>
        <div className="modal-actions"><button onClick={() => setDialog(null)}>Close</button></div>
      </div></div>}
    </main>
  );
}
