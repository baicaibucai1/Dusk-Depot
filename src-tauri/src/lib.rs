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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
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
      repo_default_dir
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
