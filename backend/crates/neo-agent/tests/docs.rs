//! The documents keep their shape: numbered without gaps, each building only on those before it, every link
//! resolving, the module and test tables of 007 naming every source file, and nothing left of what was removed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("the repository root")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The numbered documents as (number, file name, text), in order.
fn documents() -> Vec<(usize, String, String)> {
    let mut found: Vec<(usize, String, String)> = std::fs::read_dir(root().join("docs"))
        .expect("the docs folder")
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let number = name.get(..3)?.parse().ok()?;
            name.ends_with(".md").then(|| (number, name, read(&entry.path())))
        })
        .collect();
    found.sort();
    found
}

/// The targets of the Markdown links in a text.
fn links(text: &str) -> Vec<String> {
    text.split("](").skip(1).filter_map(|rest| rest.split(')').next()).map(str::to_string).collect()
}

/// Every file under `dir` with one of the extensions, relative to the repository root.
fn files(dir: &str, extensions: &[&str], found: &mut BTreeSet<String>) {
    fn walk(root: &Path, dir: &Path, extensions: &[&str], found: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, extensions, found);
            } else if path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extensions.contains(&extension)) {
                found.insert(path.strip_prefix(root).expect("under the root").to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let root = root();
    walk(&root, &root.join(dir), extensions, found);
}

#[test]
fn numbers_the_documents_without_gaps_and_titles_each_by_its_number() {
    let documents = documents();
    assert!(documents.len() >= 11, "{} documents", documents.len());
    for (index, (number, name, text)) in documents.iter().enumerate() {
        assert_eq!(*number, index, "{name} is out of sequence");
        let title = text.lines().next().unwrap_or("");
        assert!(title.starts_with(&format!("# {number:03} ")), "{name} starts with {title:?}");
        assert!(text.ends_with('\n') && !text.ends_with("\n\n"), "{name} ends with exactly one newline");
    }
}

#[test]
fn builds_each_document_only_on_those_before_it() {
    for (number, name, text) in documents() {
        for link in links(&text) {
            let target = link.split('#').next().unwrap_or("");
            let Some(other) = target.get(..3).and_then(|digits| digits.parse::<usize>().ok()).filter(|_| target.ends_with(".md") && !target.contains('/'))
            else {
                continue;
            };
            assert!(other < number, "{name} links forward to {target}");
        }
    }
}

#[test]
fn resolves_every_link_to_a_file() {
    let root = root();
    let mut texts: Vec<(PathBuf, String)> = documents().into_iter().map(|(_, name, text)| (root.join("docs").join(name), text)).collect();
    for name in ["README.md", "SETUP.md"] {
        texts.push((root.join(name), read(&root.join(name))));
    }
    for (path, text) in texts {
        for link in links(&text) {
            let target = link.split('#').next().unwrap_or("");
            if target.is_empty() || target.contains("://") || target.starts_with("mailto:") {
                continue;
            }
            let resolved = path.parent().expect("a folder").join(target);
            assert!(resolved.exists(), "{} links to {target}, which does not exist", path.display());
        }
    }
}

#[test]
fn names_every_source_file_in_the_architecture_tables() {
    let architecture = documents().into_iter().find(|(number, _, _)| *number == 7).expect("007").2;
    let mut sources = BTreeSet::new();
    files("backend/crates", &["rs"], &mut sources);
    files("app/lib", &["dart"], &mut sources);
    files("app/test", &["dart"], &mut sources);
    files("shim", &["ts"], &mut sources);
    files("packaging/e2e", &["mjs", "sh"], &mut sources);
    assert!(sources.len() > 80, "{} source files found", sources.len());
    // A table row names its first file whole and the others of the same folder by name.
    let mut named = BTreeSet::new();
    for line in architecture.lines().filter(|line| line.starts_with("| `")) {
        let mut folder = String::new();
        for cell in line.split('`').skip(1).step_by(2).take_while(|cell| !cell.contains(' ')) {
            if let Some((dir, _)) = cell.rsplit_once('/') {
                folder = dir.to_string();
                named.insert(cell.to_string());
            } else {
                named.insert(format!("{folder}/{cell}"));
            }
        }
    }
    let missing: Vec<&String> = sources.iter().filter(|file| !file.contains("/common/") && !named.contains(*file)).collect();
    assert!(missing.is_empty(), "007 does not name: {missing:#?}");
    let gone: Vec<&String> = named.iter().filter(|file| !root().join(file).exists()).collect();
    assert!(gone.is_empty(), "007 names files that do not exist: {gone:#?}");
}

#[test]
fn says_nothing_of_what_was_removed() {
    let root = root();
    let mut texts: Vec<(String, String)> = documents().into_iter().map(|(_, name, text)| (name, text)).collect();
    texts.push(("SETUP.md".into(), read(&root.join("SETUP.md"))));
    for (name, text) in &texts {
        for removed in ["bun run", "config.json", "stateDir", "pull request", "gh api", "omp-superagent"] {
            assert!(!text.contains(removed), "{name} still mentions {removed}");
        }
        // The earlier releases are named only where a person is told that their state cannot be opened.
        for line in text.lines().filter(|line| line.contains("GitHub") || line.contains("TypeScript")) {
            assert!(line.contains("TypeScript release") || line.contains("github.com/") || line.contains(".github/"), "{name}: {line}");
        }
    }
    // The read-me says once what an upgrade loses.
    let readme = read(&root.join("README.md"));
    assert_eq!(readme.matches("GitHub").count(), 1, "the read-me names the removed integration once, under upgrading");
}
