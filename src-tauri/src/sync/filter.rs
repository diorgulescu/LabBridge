use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;

use crate::error::{AppError, AppResult};

pub const TEMP_FILE_PREFIX: &str = ".labbridge.tmp.";

/// Checks whether `.git/index.lock` or `.git/HEAD.lock` currently exists in `local_root`.
pub fn has_active_git_lock(local_root: &Path) -> bool {
    let git_dir = local_root.join(".git");
    if !git_dir.is_dir() {
        return false;
    }
    git_dir.join("index.lock").exists() || git_dir.join("HEAD.lock").exists()
}

/// Returns `true` if the path touches `.git/` internals.
pub fn is_inside_git_dir(local_root: &Path, candidate: &Path) -> bool {
    let Ok(rel) = candidate.strip_prefix(local_root) else {
        return false;
    };
    rel.components().any(|c| match c {
        Component::Normal(s) => s.eq_ignore_ascii_case(".git"),
        _ => false,
    })
}

/// Converts a local path inside `local_root` into a strict relative POSIX `/` string.
pub fn to_relative_posix(local_root: &Path, abs_path: &Path) -> Option<String> {
    let rel = abs_path.strip_prefix(local_root).ok()?;
    let mut parts = Vec::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(os) => {
                let s = os.to_string_lossy();
                if s.is_empty() {
                    return None;
                }
                parts.push(s.into_owned());
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Evaluates hard-exclusions (`.git/`, `.labbridge.tmp.*`, configured `excluded_dirs`)
/// alongside `.gitignore` and `.labignore` rules.
pub struct ProjectFilter {
    local_root: PathBuf,
    excluded_dirs: HashSet<String>,
    matcher: Gitignore,
}

impl ProjectFilter {
    pub fn build(local_root: &Path, excluded_dirs: &[String]) -> AppResult<Self> {
        let mut excluded_set = HashSet::new();
        excluded_set.insert(".git".to_string());
        for dir in excluded_dirs {
            let clean = dir.trim().trim_matches(|c| c == '/' || c == '\\');
            if !clean.is_empty() {
                excluded_set.insert(clean.to_string());
            }
        }

        let mut builder = GitignoreBuilder::new(local_root);

        let root_gitignore = local_root.join(".gitignore");
        if root_gitignore.is_file() {
            let _ = builder.add(root_gitignore);
        }

        let git_exclude = local_root.join(".git").join("info").join("exclude");
        if git_exclude.is_file() {
            let _ = builder.add(git_exclude);
        }

        let root_labignore = local_root.join(".labignore");
        if root_labignore.is_file() {
            let _ = builder.add(root_labignore);
        }

        let matcher = builder
            .build()
            .map_err(|e| AppError::Sync(format!("Invalid ignore file syntax: {}", e)))?;

        Ok(Self {
            local_root: local_root.to_path_buf(),
            excluded_dirs: excluded_set,
            matcher,
        })
    }

    pub fn is_excluded_rel_posix(&self, rel_posix: &str, is_dir: bool) -> bool {
        if rel_posix.is_empty() {
            return true;
        }

        let segments: Vec<&str> = rel_posix.split('/').collect();
        for (idx, seg) in segments.iter().enumerate() {
            if *seg == ".git" || seg.starts_with(TEMP_FILE_PREFIX) {
                return true;
            }
            let seg_is_dir = is_dir || idx + 1 < segments.len();
            if seg_is_dir && self.excluded_dirs.contains(*seg) {
                return true;
            }
        }

        if let Some(last) = segments.last() {
            if last.starts_with(TEMP_FILE_PREFIX) {
                return true;
            }
        }

        let rel_path = Path::new(rel_posix);
        if self
            .matcher
            .matched_path_or_any_parents(rel_path, is_dir)
            .is_ignore()
        {
            return true;
        }

        // Also check nested .gitignore / .labignore if file lives in a subdirectory
        if segments.len() > 1 {
            let mut dir_cursor = self.local_root.clone();
            for seg in &segments[..segments.len() - 1] {
                dir_cursor.push(seg);
                let nested_gi = dir_cursor.join(".gitignore");
                let nested_li = dir_cursor.join(".labignore");
                if nested_gi.is_file() || nested_li.is_file() {
                    let mut nested_builder = GitignoreBuilder::new(&dir_cursor);
                    if nested_gi.is_file() {
                        let _ = nested_builder.add(nested_gi);
                    }
                    if nested_li.is_file() {
                        let _ = nested_builder.add(nested_li);
                    }
                    if let Ok(nested_matcher) = nested_builder.build() {
                        let full = self.local_root.join(rel_path);
                        if let Ok(sub_rel) = full.strip_prefix(&dir_cursor) {
                            if nested_matcher
                                .matched_path_or_any_parents(sub_rel, is_dir)
                                .is_ignore()
                            {
                                return true;
                            }
                        }
                    }
                }
            }
        }

        false
    }

    pub fn is_excluded_abs(&self, abs_path: &Path, is_dir: bool) -> bool {
        let Some(rel_posix) = to_relative_posix(&self.local_root, abs_path) else {
            return true;
        };
        self.is_excluded_rel_posix(&rel_posix, is_dir)
    }
}

/// Walks `local_root` respecting `.gitignore`, `.labignore`, `.git/` hard-exclusion,
/// `.labbridge.tmp.*` exclusion, and configured `excluded_dirs`.
/// Returns `(abs_path, rel_posix_path)` pairs for all regular syncable files.
pub fn walk_syncable_files(
    local_root: &Path,
    excluded_dirs: &[String],
) -> AppResult<Vec<(PathBuf, String)>> {
    let mut excluded_set = HashSet::new();
    excluded_set.insert(".git".to_string());
    for dir in excluded_dirs {
        let clean = dir.trim().trim_matches(|c| c == '/' || c == '\\');
        if !clean.is_empty() {
            excluded_set.insert(clean.to_string());
        }
    }

    let root_owned = local_root.to_path_buf();
    let mut walk_builder = WalkBuilder::new(local_root);
    walk_builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .add_custom_ignore_filename(".labignore");

    walk_builder.filter_entry(move |entry| {
        if entry.path() == root_owned {
            return true;
        }
        let name = entry.file_name().to_string_lossy();
        if name == ".git" || name.starts_with(TEMP_FILE_PREFIX) {
            return false;
        }
        let is_dir = entry.file_type().map_or(false, |ft| ft.is_dir());
        if is_dir && excluded_set.contains(name.as_ref()) {
            return false;
        }
        true
    });

    let mut out = Vec::new();
    for res in walk_builder.build() {
        let Ok(entry) = res else {
            continue;
        };
        let Some(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_file() {
            continue;
        }
        let abs = entry.into_path();
        if let Some(rel_posix) = to_relative_posix(local_root, &abs) {
            if !rel_posix.split('/').any(|s| s.starts_with(TEMP_FILE_PREFIX)) {
                out.push((abs, rel_posix));
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn evaluates_gitignore_labignore_temp_and_build_exclusions() {
        let root = std::env::temp_dir().join(format!("labbridge_filter_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();

        fs::write(root.join(".gitignore"), "*.o\nsecret.env\n").unwrap();
        fs::write(root.join(".labignore"), "local_notes.md\n").unwrap();
        fs::write(root.join(".git").join("index.lock"), b"").unwrap();
        fs::write(root.join("build").join("app.bin"), b"bin").unwrap();
        fs::write(root.join("src").join("main.c"), b"int main(){}").unwrap();
        fs::write(root.join("src").join("main.o"), b"obj").unwrap();
        fs::write(root.join("src").join(".labbridge.tmp.main.c"), b"tmp").unwrap();
        fs::write(root.join("local_notes.md"), b"notes").unwrap();

        assert!(has_active_git_lock(&root));

        let excluded = vec!["build".into(), "out".into(), "target".into(), ".vscode".into()];
        let filter = ProjectFilter::build(&root, &excluded).unwrap();

        assert!(!filter.is_excluded_rel_posix("src/main.c", false));
        assert!(filter.is_excluded_rel_posix("src/main.o", false));
        assert!(filter.is_excluded_rel_posix("src/.labbridge.tmp.main.c", false));
        assert!(filter.is_excluded_rel_posix("local_notes.md", false));
        assert!(filter.is_excluded_rel_posix("build/app.bin", false));
        assert!(filter.is_excluded_rel_posix(".git/HEAD", false));

        let walked = walk_syncable_files(&root, &excluded).unwrap();
        let rels: Vec<String> = walked.into_iter().map(|(_, r)| r).collect();
        assert!(rels.contains(&"src/main.c".to_string()));
        assert!(!rels.iter().any(|r| r.contains(".labbridge.tmp.")));
        assert!(!rels.iter().any(|r| r.starts_with("build/")));
        assert!(!rels.contains(&"local_notes.md".to_string()));
        assert!(!rels.contains(&"src/main.o".to_string()));

        let _ = fs::remove_dir_all(&root);
    }
}
