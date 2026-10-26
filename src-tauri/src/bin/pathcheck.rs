/*
 * 仓库文件系统层的验收脚本：`cargo run --bin pathcheck`
 *
 * 为什么不写在 `#[cfg(test)]` 里：带 Tauri 链接出来的测试二进制在这台机器的
 * mingw-gnu 目标上起不来（STATUS_ENTRYPOINT_NOT_FOUND）。而这里测的是纯文件系统逻辑，
 * 不该被 GUI 栈拖着。这个 bin 不 import tauri，链得又小又快。
 *
 * 任何一条不符预期就 exit 1 —— 不做"只打印不判定"的假绿。
 */
#[path = "../fs_ops.rs"]
mod fs_ops;

use std::path::Path;

fn check(name: &str, ok: bool, detail: &str) {
  if ok {
    println!("  ✓ {name}");
  } else {
    println!("  ✗ {name}  {detail}");
    std::process::exit(1);
  }
}

fn main() {
  println!("pathcheck —— 仓库文件系统层");

  println!("\n路径越界");
  let root = Path::new("C:/repo");
  check("正常相对路径放行", fs_ops::join(root, "notes/雨天.md").is_ok(), "");
  check("`..` 拒绝", fs_ops::join(root, "../外面.md").is_err(), "");
  check("多级 `..` 拒绝", fs_ops::join(root, "a/../../外面.md").is_err(), "");
  check("前导斜杠拒绝", fs_ops::join(root, "/etc/passwd").is_err(), "");
  check("盘符拒绝", fs_ops::join(root, "C:/Windows/x.md").is_err(), "");
  check("反斜杠拒绝", fs_ops::join(root, "a\\b.md").is_err(), "");

  println!("\n真目录往返");
  let dir = std::env::temp_dir().join(format!("dusk-pathcheck-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  let root = dir.to_string_lossy().to_string();

  fs_ops::write_bytes(&root, "notes/雨天.md", "你好".as_bytes().to_vec()).unwrap();
  let back = fs_ops::read_bytes(&root, "notes/雨天.md").unwrap();
  check("写进去能读回来", String::from_utf8(back).unwrap() == "你好", "");

  let entries = fs_ops::list(&root).unwrap();
  let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
  check("父目录出现在列表里", paths.contains(&"notes"), &format!("{paths:?}"));
  check("文件出现在列表里", paths.contains(&"notes/雨天.md"), &format!("{paths:?}"));

  let file = entries.iter().find(|e| e.path == "notes/雨天.md").unwrap();
  check("type 是 file", file.kind == "file", "");
  check("size 是 6", file.size == 6, &file.size.to_string());

  fs_ops::mkdir(&root, "空的").unwrap();
  let entries = fs_ops::list(&root).unwrap();
  check(
    "空目录也列得出来",
    entries.iter().any(|e| e.path == "空的" && e.kind == "dir"),
    "",
  );

  fs_ops::remove(&root, "notes/雨天.md").unwrap();
  check("删掉就读不到了", fs_ops::read_bytes(&root, "notes/雨天.md").is_err(), "");

  let _ = std::fs::remove_dir_all(&dir);
  println!("\n全部通过");
}
