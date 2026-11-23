/**
 * The documents keep their shape: numbered without gaps, each building only on those before it, every link
 * resolving, the module and test tables of 007 naming every source file, and backend sources being 100% pure TypeScript.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function documents(): [number, string, string][] {
  const docsDir = path.join(ROOT, "docs");
  const found: [number, string, string][] = [];
  for (const name of fs.readdirSync(docsDir)) {
    if (!name.endsWith(".md")) continue;
    const prefix = name.slice(0, 3);
    if (!/^\d{3}$/.test(prefix)) continue;
    found.push([Number.parseInt(prefix, 10), name, read(path.join(docsDir, name))]);
  }
  found.sort((a, b) => a[0] - b[0]);
  return found;
}

function links(text: string): string[] {
  const out: string[] = [];
  const parts = text.split("](");
  for (let i = 1; i < parts.length; i++) {
    const target = parts[i]!.split(")")[0];
    if (target !== undefined) out.push(target);
  }
  return out;
}

function collectFiles(relDir: string, extensions: readonly string[], found: Set<string>): void {
  const start = path.join(ROOT, relDir);
  if (!fs.existsSync(start)) return;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const ext = path.extname(entry.name).slice(1);
        if (extensions.includes(ext)) {
          found.add(path.relative(ROOT, full).replaceAll("\\", "/"));
        }
      }
    }
  };
  walk(start);
}

describe("docs", () => {
  test("numbers_the_documents_without_gaps_and_titles_each_by_its_number", () => {
    const docs = documents();
    expect(docs.length).toBeGreaterThanOrEqual(11);
    for (let i = 0; i < docs.length; i++) {
      const [num, name, text] = docs[i]!;
      expect(num).toBe(i);
      const title = text.split("\n")[0] ?? "";
      expect(title.startsWith(`# ${String(num).padStart(3, "0")} `), `${name} starts with ${JSON.stringify(title)}`).toBe(true);
      expect(text.endsWith("\n") && !text.endsWith("\n\n"), `${name} ends with single newline`).toBe(true);
    }
  });

  test("builds_each_document_only_on_those_before_it", () => {
    for (const [num, name, text] of documents()) {
      for (const link of links(text)) {
        const target = link.split("#")[0] ?? "";
        if (!target.endsWith(".md") || target.includes("/")) continue;
        const prefix = target.slice(0, 3);
        if (!/^\d{3}$/.test(prefix)) continue;
        const other = Number.parseInt(prefix, 10);
        expect(other < num, `${name} links forward to ${target}`).toBe(true);
      }
    }
  });

  test("resolves_every_link_to_a_file", () => {
    const texts: [string, string][] = documents().map(([, name, text]) => [path.join(ROOT, "docs", name), text]);
    for (const name of ["README.md", "SETUP.md"]) {
      texts.push([path.join(ROOT, name), read(path.join(ROOT, name))]);
    }
    for (const [filePath, text] of texts) {
      for (const link of links(text)) {
        const target = link.split("#")[0] ?? "";
        if (!target || target.includes("://") || target.startsWith("mailto:")) continue;
        const resolved = path.resolve(path.dirname(filePath), target);
        expect(fs.existsSync(resolved), `${filePath} links to ${target}, which does not exist`).toBe(true);
      }
    }
  });

  test("names_every_source_file_in_the_architecture_tables", () => {
    const architecture = documents().find(([num]) => num === 7)![2];
    const sources = new Set<string>();
    collectFiles("backend/src", ["ts"], sources);
    collectFiles("backend/tests", ["ts"], sources);
    collectFiles("backend/benchmarks", ["ts"], sources);
    collectFiles("app/lib", ["dart"], sources);
    collectFiles("app/test", ["dart"], sources);
    collectFiles("packaging/e2e", ["mjs", "sh"], sources);
    expect(sources.size).toBeGreaterThan(80);

    const named = new Set<string>();
    for (const line of architecture.split("\n")) {
      if (!line.startsWith("| `")) continue;
      const filesCol = line.split("|")[1] ?? "";
      let folder = "";
      const parts = filesCol.split("`");
      for (let i = 1; i < parts.length; i += 2) {
        const cell = parts[i]!;
        if (cell.includes(" ")) break;
        const slash = cell.lastIndexOf("/");
        if (slash >= 0) {
          folder = cell.slice(0, slash);
          named.add(cell);
        } else {
          named.add(`${folder}/${cell}`);
        }
      }
    }

    const missing = [...sources].filter((file) => !file.endsWith("/common.ts") && !named.has(file)).sort();
    expect(missing).toEqual([]);
    const gone = [...named].filter((file) => !fs.existsSync(path.join(ROOT, file))).sort();
    expect(gone).toEqual([]);
  });

  test("backend_contains_only_pure_typescript_sources", () => {
    const nonTs = new Set<string>();
    collectFiles("backend/src", ["rs", "py", "js", "mjs", "sh", "c", "cpp"], nonTs);
    collectFiles("backend/tests", ["rs", "py", "js", "mjs", "sh", "c", "cpp"], nonTs);
    expect([...nonTs]).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, "backend/crates"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "backend/Cargo.toml"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "shim"))).toBe(false);
  });
});
