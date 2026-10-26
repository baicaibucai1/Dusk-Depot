/*
 * 仓库的文件系统操作。
 *
 * 这一层**不依赖 Tauri** —— 命令层（lib.rs）只负责把参数递进来、把错误递出去。
 * 分离的理由很实际：带着 Tauri 链接出来的测试二进制在 Windows GNU 目标上跑不起来
 * （STATUS_ENTRYPOINT_NOT_FOUND），而这里的逻辑又恰恰是最该被测的部分 —— 路径越界。
 * 所以它单独成一个模块，由 `src/bin/pathcheck.rs` 直接测。
 */

#[derive(serde::Serialize)]
pub struct Entry {
  pub path: String,
  pub kind: String,
  pub size: u64,
  pub mtime: u64,
}

/// 把仓库内相对路径拼成绝对路径。
///
/// **绝对路径、盘符、反斜杠、`..` 一律拒** —— 前端拿不到、也造不出仓库外的路径。
pub fn join(root: &std::path::Path, rel: &str) -> Result<std::path::PathBuf, String> {
  if rel.is_empty() {
    return Ok(root.to_path_buf());
  }
  if rel.starts_with('/') || rel.contains(':') || rel.contains('\\') {
    return Err(format!("不接受绝对路径或反斜杠：{rel}"));
  }

  let mut out = root.to_path_buf();
  for seg in rel.split('/') {
    if seg.is_empty() || seg == "." {
      continue;
    }
    if seg == ".." {
      return Err(format!("路径越出仓库：{rel}"));
    }
    out.push(seg);
  }
  Ok(out)
}

/// 依赖 / 构建 / 系统目录：笔记库里没有意义，走进去就是几千个文件
const SKIP_DIRS: &[&str] = &[
  "node_modules", ".git", ".svn", "target", "dist", "build", ".next", ".nuxt",
  ".cache", ".venv", "__pycache__", "$RECYCLE.BIN", "System Volume Information",
];

/// 一个仓库的条目上限。到顶就明说，别让人对着"正在读取…"干等
const MAX_ENTRIES: usize = 20000;

fn walk(dir: &std::path::Path, prefix: &str, out: &mut Vec<Entry>) -> Result<(), String> {
  let rd = std::fs::read_dir(dir).map_err(|e| format!("读不了目录 {}：{e}", dir.display()))?;

  for item in rd {
    let item = item.map_err(|e| e.to_string())?;
    let name = item.file_name().to_string_lossy().to_string();
    let path = if prefix.is_empty() {
      name.clone()
    } else {
      format!("{prefix}/{name}")
    };

    let meta = item.metadata().map_err(|e| e.to_string())?;
    let mtime = meta
      .modified()
      .ok()
      .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0);

    if meta.is_dir() {
      if SKIP_DIRS.contains(&name.as_str()) {
        continue;
      }
      out.push(Entry {
        path: path.clone(),
        kind: "dir".into(),
        size: 0,
        mtime,
      });
      if out.len() > MAX_ENTRIES {
        return Err(too_big());
      }
      walk(&item.path(), &path, out)?;
    } else {
      out.push(Entry {
        path,
        kind: "file".into(),
        size: meta.len(),
        mtime,
      });
      if out.len() > MAX_ENTRIES {
        return Err(too_big());
      }
    }
  }

  Ok(())
}

fn too_big() -> String {
  format!("这个文件夹太大了（超过 {MAX_ENTRIES} 项）。请选一个笔记文件夹，不要选整个磁盘或项目根目录。")
}

pub fn list(root: &str) -> Result<Vec<Entry>, String> {
  let mut out = Vec::new();
  walk(std::path::Path::new(root), "", &mut out)?;
  Ok(out)
}

pub fn read_bytes(root: &str, path: &str) -> Result<Vec<u8>, String> {
  let full = join(std::path::Path::new(root), path)?;
  std::fs::read(&full).map_err(|e| format!("读不了 {path}：{e}"))
}

pub fn write_bytes(root: &str, path: &str, data: Vec<u8>) -> Result<(), String> {
  let full = join(std::path::Path::new(root), path)?;
  if let Some(parent) = full.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("建不了目录：{e}"))?;
  }
  std::fs::write(&full, data).map_err(|e| format!("写不了 {path}：{e}"))
}

pub fn remove(root: &str, path: &str) -> Result<(), String> {
  let full = join(std::path::Path::new(root), path)?;
  if full.is_dir() {
    std::fs::remove_dir_all(&full).map_err(|e| format!("删不了 {path}：{e}"))
  } else {
    std::fs::remove_file(&full).map_err(|e| format!("删不了 {path}：{e}"))
  }
}

pub fn mkdir(root: &str, path: &str) -> Result<(), String> {
  let full = join(std::path::Path::new(root), path)?;
  std::fs::create_dir_all(&full).map_err(|e| format!("建不了 {path}：{e}"))
}

pub fn rmdir(root: &str, path: &str) -> Result<(), String> {
  let full = join(std::path::Path::new(root), path)?;
  std::fs::remove_dir_all(&full).map_err(|e| format!("删不了 {path}：{e}"))
}
