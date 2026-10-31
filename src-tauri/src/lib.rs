use tauri::Manager;

mod fs_ops;

/*
 * 命令层：只做"参数进来 → 交给 fs_ops → 错误原样出去"。
 *
 * 真正的规矩（相对路径、不许越界）在 fs_ops::join 里，那一层不依赖 Tauri，
 * 所以能被 `cargo run --bin pathcheck` 直接验。
 */

#[tauri::command]
fn repo_list(root: String) -> Result<Vec<fs_ops::Entry>, String> {
  fs_ops::list(&root)
}

#[tauri::command]
fn repo_read_bytes(root: String, path: String) -> Result<Vec<u8>, String> {
  fs_ops::read_bytes(&root, &path)
}

#[tauri::command]
fn repo_write_bytes(root: String, path: String, data: Vec<u8>) -> Result<(), String> {
  fs_ops::write_bytes(&root, &path, data)
}

#[tauri::command]
fn repo_remove(root: String, path: String) -> Result<(), String> {
  fs_ops::remove(&root, &path)
}

#[tauri::command]
fn repo_mkdir(root: String, path: String) -> Result<(), String> {
  fs_ops::mkdir(&root, &path)
}

#[tauri::command]
fn repo_rmdir(root: String, path: String) -> Result<(), String> {
  fs_ops::rmdir(&root, &path)
}

/// 程序自带的仓库目录：应用数据目录下的 `repo`
#[tauri::command]
fn repo_default_dir(app: tauri::AppHandle) -> Result<String, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join("repo");
  std::fs::create_dir_all(&dir).map_err(|e| format!("建不了目录：{e}"))?;
  Ok(dir.to_string_lossy().to_string())
}

/*
 * 书架：设备级目录，**永远不在仓库里**。
 * 默认放在应用数据目录下的 `bookshelf`，跟 `repo` 是兄弟。
 */
#[tauri::command]
fn shelf_default_dir(app: tauri::AppHandle) -> Result<String, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join("bookshelf");
  std::fs::create_dir_all(&dir).map_err(|e| format!("建不了书架目录：{e}"))?;
  Ok(dir.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
struct FileStat {
  name: String,
  size: u64,
  mtime: u64,
}

fn stat_of(p: &std::path::Path) -> Result<FileStat, String> {
  let meta = std::fs::metadata(p).map_err(|e| format!("读不了这个文件：{e}"))?;
  if !meta.is_file() {
    return Err("这不是一个普通文件（文件夹请单独处理）".into());
  }
  let mtime = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  Ok(FileStat {
    name: p
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_default(),
    size: meta.len(),
    mtime,
  })
}

/// 拖进来的文件先问大小 —— 前端据此判断超没超上限，不先读字节
#[tauri::command]
fn fs_stat(src: String) -> Result<FileStat, String> {
  stat_of(std::path::Path::new(&src))
}

/// 书架 / 仓库内单个文件的大小（相对路径，走同一套越界检查）
#[tauri::command]
fn repo_stat(root: String, path: String) -> Result<FileStat, String> {
  let full = fs_ops::join(std::path::Path::new(&root), &path)?;
  stat_of(&full)
}

/**
 * 宿主内换名 / 搬家。
 *
 * 只接受 root 下的相对路径，`..` 一律拒；目标已存在就报错 —— **绝不覆盖**。
 * 同一个根目录内是原子 rename；跨盘时 rename 会失败，这里不做 copy 降级
 * （书架的搬迁有自己的"复制 → 校验 → 落位"流程，不靠这个命令跨盘）。
 */
#[tauri::command]
fn repo_move(root: String, from: String, to: String) -> Result<(), String> {
  let root_path = std::path::Path::new(&root);
  let a = fs_ops::join(root_path, &from)?;
  let b = fs_ops::join(root_path, &to)?;
  if !a.exists() {
    return Err(format!("源文件不在了：{from}"));
  }
  if b.exists() {
    return Err(format!("目标已存在，不覆盖：{to}"));
  }
  if let Some(parent) = b.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("建不了目录：{e}"))?;
  }
  std::fs::rename(&a, &b).map_err(|e| format!("搬不了 {from} → {to}：{e}"))
}

/**
 * 把外部文件**复制**进某个根目录（仓库或书架）。
 *
 * 两条底线：
 *   ① 目标路径由 root + 相对路径算出来，`..` / 绝对路径一律拒（走 fs_ops::join）；
 *   ② **绝不覆盖**已存在的目标 —— 同名冲突由前端改名后再进来。
 */
#[tauri::command]
fn fs_import_file(src: String, root: String, dest: String) -> Result<FileStat, String> {
  let from = std::path::Path::new(&src);
  let stat = stat_of(from)?;

  let root_path = std::path::Path::new(&root);
  let to = fs_ops::join(root_path, &dest)?;
  if to.exists() {
    return Err("目标位置已经有同名文件了".into());
  }
  if let Some(parent) = to.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("建不了目录：{e}"))?;
  }
  std::fs::copy(from, &to).map_err(|e| format!("复制失败：{e}"))?;
  Ok(stat)
}

/// 书架搬家：整棵树复制到新目录（不删旧目录，删不删由用户决定）
#[tauri::command]
fn shelf_copy_tree(from: String, to: String) -> Result<u32, String> {
  let src = std::path::Path::new(&from);
  if !src.is_dir() {
    return Err("旧书架目录不存在".into());
  }
  let dst = std::path::Path::new(&to);
  if dst.exists() && std::fs::read_dir(dst).map(|mut i| i.next().is_some()).unwrap_or(false) {
    return Err("新目录不是空的".into());
  }
  std::fs::create_dir_all(dst).map_err(|e| format!("建不了目录：{e}"))?;

  let mut n = 0u32;
  for item in std::fs::read_dir(src).map_err(|e| e.to_string())? {
    let item = item.map_err(|e| e.to_string())?;
    let meta = item.metadata().map_err(|e| e.to_string())?;
    let target = dst.join(item.file_name());
    if meta.is_file() {
      if !target.exists() {
        std::fs::copy(item.path(), &target).map_err(|e| format!("复制失败：{e}"))?;
        n += 1;
      }
    } else if meta.is_dir() {
      n += copy_dir(&item.path(), &target)?;
    }
  }
  Ok(n)
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> Result<u32, String> {
  std::fs::create_dir_all(to).map_err(|e| format!("建不了目录：{e}"))?;
  let mut n = 0u32;
  for item in std::fs::read_dir(from).map_err(|e| e.to_string())? {
    let item = item.map_err(|e| e.to_string())?;
    let meta = item.metadata().map_err(|e| e.to_string())?;
    let target = to.join(item.file_name());
    if meta.is_file() {
      if !target.exists() {
        std::fs::copy(item.path(), &target).map_err(|e| format!("复制失败：{e}"))?;
        n += 1;
      }
    } else if meta.is_dir() {
      n += copy_dir(&item.path(), &target)?;
    }
  }
  Ok(n)
}

/**
 * 「在资源管理器中查看」。
 *
 * 路径**只**由 root + 相对路径拼出来（跟读写同一套 join），前端拿不到任意路径的入口；
 * 越界、盘符、`..` 都会被 join 挡掉。真正"显示"这一步交给官方 Opener 插件
 * （`reveal_item_in_dir`），这里不拼任何 shell 命令，也不开放任意路径。
 */
#[tauri::command]
fn fs_reveal(app: tauri::AppHandle, root: String, path: String) -> Result<(), String> {
  use tauri_plugin_opener::OpenerExt;

  let abs = fs_ops::join(std::path::Path::new(&root), &path)?;
  if !abs.exists() {
    return Err(format!("这个文件不在了：{}", abs.display()));
  }
  app
    .opener()
    .reveal_item_in_dir(&abs)
    .map_err(|e| format!("打不开文件管理器：{e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      repo_list,
      repo_read_bytes,
      repo_write_bytes,
      repo_remove,
      repo_mkdir,
      repo_rmdir,
      repo_default_dir,
      shelf_default_dir,
      fs_stat,
      repo_stat,
      repo_move,
      fs_import_file,
      shelf_copy_tree,
      fs_reveal
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
