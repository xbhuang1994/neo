//! Independent deliverable artifact collector and filename sanitizer.
//!
//! Scans a ticket workspace with bounded BFS, filters out engineering noise and boilerplate,
//! prioritizes sent files and deliverable extensions over source code (never truncating
//! non-ASCII filenames by ASCII code-point order), and sanitizes every path segment against
//! control characters, BiDi overrides, and structural prompt-confusion characters.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { clip } from "./text.ts";

/** Maximum directory depth traversed below the workspace root (root files are depth 0). */
export const ARTIFACT_MAX_DEPTH = 3;
/** Maximum directory entries visited during a bounded BFS scan. */
export const ARTIFACT_MAX_ENTRIES = 300;
/** Maximum Unicode code points allowed for a sanitized artifact path/name. */
export const ARTIFACT_MAX_NAME_CHARS = 64;

const ASCII_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI_AND_ZERO_WIDTH_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF\u061C]/g;
const STRUCTURAL_CONFUSION_RE = /["'`<>|*?\\]/g;
const WHITESPACE_RUN_RE = /\p{White_Space}+/gu;
const EDGE_WHITESPACE_RE = /^\p{White_Space}+|\p{White_Space}+$/gu;
const NON_ASCII_RE = /[^\u0000-\u007F]/;
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;

/** Engineering noise directories skipped immediately during BFS. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".next",
  "dist",
  "build",
  "coverage",
  ".git",
  "vendor",
]);

/** Generic engineering scaffolding filenames ignored (matched case-insensitively on basename). */
const BOILERPLATE_FILES: ReadonlySet<string> = new Set([
  "readme",
  "readme.md",
  "readme.txt",
  "agents.md",
  "claude.md",
  "gemini.md",
  "license",
  "license.md",
  "license.txt",
  "changelog",
  "changelog.md",
  "contributing.md",
  "code_of_conduct.md",
  "security.md",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  "jsconfig.json",
  "makefile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "poetry.lock",
  "uv.lock",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".prettierrc",
  ".eslintrc",
  ".eslintrc.json",
]);

/** Extensions prioritized as user-facing deliverables ahead of ordinary source files. */
const DELIVERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".html",
  ".htm",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".zip",
  ".md",
  ".txt",
]);

function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        count += 1;
        continue;
      }
    }
    i += 1;
    count += 1;
  }
  return count;
}

function cleanSegment(segment: string): string {
  return segment
    .replace(ASCII_CONTROL_RE, "")
    .replace(BIDI_AND_ZERO_WIDTH_RE, "")
    .replace(STRUCTURAL_CONFUSION_RE, "")
    .replace(WHITESPACE_RUN_RE, " ")
    .replace(EDGE_WHITESPACE_RE, "");
}

function clipPreservingExtension(name: string, maxChars: number): string {
  if (countCodePoints(name) <= maxChars) {
    return name;
  }
  const lastDot = name.lastIndexOf(".");
  const lastSlash = name.lastIndexOf("/");
  if (lastDot > lastSlash + 1) {
    const ext = name.slice(lastDot);
    const extLen = countCodePoints(ext);
    if (extLen > 1 && extLen <= 10 && extLen < maxChars) {
      const stem = name.slice(0, lastDot);
      return `${clip(stem, maxChars - extLen)}${ext}`;
    }
  }
  return clip(name, maxChars);
}

/**
 * Sanitize a file name or relative path for safe indexing and prompt/card rendering:
 * - Absolute paths are reduced to their basename so internal host paths never leak.
 * - Relative paths have each segment cleaned, dropping `.` and `..` traversal components.
 * - Strips ASCII control chars, Unicode BiDi/zero-width chars, quotes, backticks, angle brackets.
 * - Collapses whitespace and bounds length to 64 Unicode code points.
 */
export function sanitizeArtifactName(raw: string): string {
  if (raw.length === 0) {
    return "";
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const isAbsolute =
    trimmed.startsWith("/") || trimmed.startsWith("\\") || WINDOWS_ABS_RE.test(trimmed);

  let segments: string[];
  if (isAbsolute) {
    const parts = trimmed.split(/[\\/]+/).filter((part) => part.length > 0);
    const base = parts.length > 0 ? parts[parts.length - 1] : "";
    segments = [base];
  } else {
    segments = trimmed.split(/[\\/]+/);
  }

  const cleaned: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const part = cleanSegment(segments[i]);
    if (part.length === 0 || part === "." || part === "..") {
      continue;
    }
    cleaned.push(part);
  }
  if (cleaned.length === 0) {
    return "";
  }
  return clipPreservingExtension(cleaned.join("/"), ARTIFACT_MAX_NAME_CHARS);
}

function normalizeSentFile(directory: string, rawFile: string): string {
  const trimmed = rawFile.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (directory.length > 0) {
    const looksAbs =
      trimmed.startsWith("/") || trimmed.startsWith("\\") || WINDOWS_ABS_RE.test(trimmed);
    if (looksAbs) {
      const rel = path.relative(directory, trimmed);
      if (
        rel.length > 0 &&
        rel !== "." &&
        rel !== ".." &&
        !rel.startsWith(`..${path.sep}`) &&
        !rel.startsWith("../") &&
        !path.isAbsolute(rel)
      ) {
        return sanitizeArtifactName(rel.split(path.sep).join("/"));
      }
    }
  }
  return sanitizeArtifactName(trimmed);
}

function isBoilerplateFilename(name: string): boolean {
  return BOILERPLATE_FILES.has(name.toLowerCase());
}

function isDeliverableExtension(relPath: string): boolean {
  const ext = path.posix.extname(relPath).toLowerCase();
  return DELIVERABLE_EXTENSIONS.has(ext);
}

interface ScannedFile {
  sanitized: string;
  deliverable: boolean;
  nonAscii: boolean;
  mtimeMs: number;
}

/**
 * Collect up to `maxItems` sanitized deliverable paths from `directory` using bounded BFS
 * (`maxDepth = 3`, `maxEntriesVisited = 300`).
 *
 * Priority order:
 * 1. Files explicitly listed in `sentFiles` (highest priority, deduplicated, preserving order).
 * 2. Deliverable extensions (`.pdf`, `.docx`, `.xlsx`, `.pptx`, `.html`, `.htm`, `.csv`, images,
 *    `.zip`, non-boilerplate `.md`/`.txt`) ahead of ordinary source files.
 * 3. Within the same tier: non-ASCII names (e.g. Chinese deliverables) first, then `mtimeMs DESC`.
 *
 * If `directory` does not exist or cannot be read, safely returns sanitized deduplicated `sentFiles`.
 */
export function collectArtifacts(
  directory: string,
  sentFiles?: readonly string[],
  maxItems = 15,
): string[] {
  if (maxItems <= 0) {
    return [];
  }

  const orderedSent: string[] = [];
  const seen = new Set<string>();
  const sentBasenames = new Set<string>();

  if (sentFiles !== undefined) {
    for (let i = 0; i < sentFiles.length; i++) {
      const cleaned = normalizeSentFile(directory, sentFiles[i]);
      if (cleaned.length === 0 || seen.has(cleaned)) {
        continue;
      }
      seen.add(cleaned);
      orderedSent.push(cleaned);
      if (!cleaned.includes("/")) {
        sentBasenames.add(cleaned);
      }
    }
  }

  if (orderedSent.length >= maxItems) {
    return orderedSent.slice(0, maxItems);
  }

  if (directory.length === 0) {
    return orderedSent;
  }

  let rootIsDir = false;
  try {
    rootIsDir = statSync(directory).isDirectory();
  } catch {
    return orderedSent;
  }
  if (!rootIsDir) {
    return orderedSent;
  }

  const scanned: ScannedFile[] = [];
  const queue: Array<{ absDir: string; relPrefix: string; depth: number }> = [
    { absDir: directory, relPrefix: "", depth: 0 },
  ];
  let visited = 0;

  while (queue.length > 0 && visited < ARTIFACT_MAX_ENTRIES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(current.absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (let i = 0; i < entries.length && visited < ARTIFACT_MAX_ENTRIES; i++) {
      const entry = entries[i];
      visited += 1;
      const name = entry.name;
      if (name.length === 0 || name.startsWith(".")) {
        continue;
      }

      // Never traverse symlinked directories to avoid cycles or escaping the workspace.
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) {
          continue;
        }
        if (current.depth < ARTIFACT_MAX_DEPTH) {
          const nextRel = current.relPrefix.length > 0 ? `${current.relPrefix}/${name}` : name;
          queue.push({
            absDir: path.join(current.absDir, name),
            relPrefix: nextRel,
            depth: current.depth + 1,
          });
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (isBoilerplateFilename(name)) {
        continue;
      }

      const rawRel = current.relPrefix.length > 0 ? `${current.relPrefix}/${name}` : name;
      const sanitized = sanitizeArtifactName(rawRel);
      if (sanitized.length === 0 || seen.has(sanitized)) {
        continue;
      }
      // If a bare filename was already explicitly listed in sentFiles and appears at top level
      // or under a subdir with the exact same sanitized basename, keep the priority-1 sent entry.
      const sanitizedBase = path.posix.basename(sanitized);
      if (sentBasenames.has(sanitizedBase)) {
        continue;
      }

      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path.join(current.absDir, name)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }

      seen.add(sanitized);
      scanned.push({
        sanitized,
        deliverable: isDeliverableExtension(sanitized),
        nonAscii: NON_ASCII_RE.test(sanitized),
        mtimeMs,
      });
    }
  }

  scanned.sort((a, b) => {
    if (a.deliverable !== b.deliverable) {
      return a.deliverable ? -1 : 1;
    }
    if (a.nonAscii !== b.nonAscii) {
      return a.nonAscii ? -1 : 1;
    }
    if (a.mtimeMs !== b.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    if (a.sanitized < b.sanitized) return -1;
    if (a.sanitized > b.sanitized) return 1;
    return 0;
  });

  const remaining = maxItems - orderedSent.length;
  for (let i = 0; i < Math.min(remaining, scanned.length); i++) {
    orderedSent.push(scanned[i].sanitized);
  }
  return orderedSent;
}
