# 图标库选型（2026-10-29）

- **状态**：已接入 Lucide（主基础库），自有 16 格图标保留
- **范围**：文件树图标、文件夹图标、按扩展名分文件图标
- **约束**：离线优先（不许运行时拉 CDN）、描边风格与现有 16 格一致、协议可商用、按需摇树

## 候选与数据（2026-10-29 查 GitHub API）

| 库 | 星 | 协议 | 图标数 | 风格 | React 摇树 | 判定 |
|---|---:|---|---:|---|---|---|
| **Lucide** | 25.4k | ISC | 1,600+ | 24 格描边 2，圆角端点 | ✅ `lucide-react` | **选它** |
| Tabler Icons | 22.5k | MIT | 6,200+ | 24 格描边 2 | ✅ `@tabler/icons-react` | 备选（更全，但细节不齐） |
| Phosphor | 0.4k\* | MIT | 1,500 基础 / 9,000+ 变体 | 6 种字重 | ✅ | 设计系统才需要 |
| Remix Icon | 8.4k | Apache-2.0 | 3,200+ | 描边 + 填充 | 一般（字体为主） | 不选 |
| Heroicons | 23.9k | MIT | 316 | 描边/实心/16 格 | ✅ | 太少，会缺图标 |
| vscode-icons | 5.2k | MIT | 1,000+ | **彩色 32 格** | ❌（主题资源） | 不选（配色冲突） |
| material-icon-theme | 3.0k | MIT | 1,000+ | **彩色** | ❌ | 不选（同上） |

\* Phosphor 主仓已迁到 `phosphor-icons/core`，星数不代表实际使用量。

## 为什么是 Lucide

1. **风格对得上**：24 格、2 描边、圆角端点 —— 和项目手画的 16 格图标是同一套语言。
   实际使用时统一 `size={16} strokeWidth={1.5}`，视觉上无缝。
2. **协议最松**：ISC（比 MIT 更短），只需要保留版权声明。
3. **摇树干净**：只 import 用到的图标，实测包体 **337.12 → 336.85 kB（gzip 不变 107.13）**，
   等于没付出代价（因为只用了约 10 个）。
4. **文件类图标齐**：file-text / file-code / file-image / file-json / file-spreadsheet /
   file-archive / file / file-question，外加 folder / folder-open，刚好覆盖文件树。

## 为什么不用彩色文件图标（vscode-icons / material-icon-theme）

它们是 VS Code 主题资源，为 32px 彩色槽位设计。这个应用的配色是"绿 + 墨 + 纸"，绿色只做强调，
塞一排橙黄蓝的彩色图标会直接破坏整套语言。**图标靠形状区分，颜色只表达状态**（选中=绿）。

## 接入方式

```
core/model/fileKind.ts   纯语义：按扩展名判定 md / text / code / sheet / image / archive / unknown
ui/fileIcon.tsx          语义 → 图标：文件夹 folder/folder-open，md 用自有 M↓，其余走 Lucide
```

- **md 例外**：用项目自己的 `IconMarkdown`（M↓），这是主格式，要一眼认出来
- **文件名不带 `.md`**：`labelOf()` 只影响显示，路径/链接/落盘仍是真名
- **自定义文件夹图标**：改 `FOLDER_OVERRIDES`（路径 → 组件）即可。
  将来做"每个文件夹自选图标"，这张表从 `.dusk/icons.json` 读（投影层，可删）

## 还没做的

- **树里目前只列 `.md`**（`readRepo` 的 `isNote` 过滤）——所以 `text/code/image/archive`
  的图标暂时看不到。要让它们出现，得先做"非 md 文件只读查看"（方案书 R3）：
  树列出全部文件 → 文本类只读打开 → 二进制「用系统程序打开」
- 自定义文件夹图标的设置界面
- 替换剩下的手写图标（FormatBar 那排仍是手画的，风格一致，不急着换）

## 协议声明

Lucide — ISC License，https://github.com/lucide-icons/lucide
本项目的 `assets/` 与源码中不再复制的图标，均通过 `lucide-react` 依赖引入。

---

## 第二层：给用户用的符号（2026-10-29 定）

这个应用里有**两层**图标，别混：

| | 第一层：界面图标 | 第二层：用户符号 |
|---|---|---|
| 谁用 | 程序的按钮、状态、文件类型 | 用户自己，插进正文 / 当文件夹图标 |
| 用什么 | Lucide（SVG，ISC） | **彩色 emoji 字符**（系统字体） |
| 存什么 | 不存在任何地方，是代码 | 存字符本身（`.md` 里 / `.zzq` 的 `icon` 字段） |
| 能换吗 | 换库要改 `fileIcon.tsx` | 用户随时换，选一个就是 |

### 第二层为什么必须是字符，不能是 SVG

因为「插进正文」的本质是**可移植**：那一行 `.md` 得在 VS Code、GitHub、手机上打开还成立。
所以能存下的只有字符。图片/SVG 一进去，纯文本编辑器里就是一堆路径，反而更脏。

顺带一个推论：**描边风格的 emoji（OpenMoji 之类）只在本程序里成立**。
它只是换画法，文件里仍是 `🚀` 这个码位，别人打开看到的还是彩色 emoji。
想"到哪都是描边样"只能存 `:rocket:` 短码，但那样纯文本里就是短码 —— 更脏。所以不采用。

### 代价（写清楚，免得以后当 bug 报）

- 同一个 emoji 在 Windows / macOS / 安卓上画得不一样 —— 字体的事，我们不打包字体
- 包体 +12.7 kB（gzip +5.9），全是符号目录的数据（12 类 / 180 个）
- 不做后缀级文件图标、不收品牌 logo（理由见上一节）

### 代码在哪

- `src/core/model/symbols.ts` —— 符号目录（纯数据 + `searchSymbols` / `withRecent`，可单测）
- `src/ui/SymbolPanel.tsx` —— 面板组件，正文插入与文件夹图标共用
- `src/core/model/vault.ts` —— `FileMeta.icon` + `iconsOf` / `setIcon`（存 `.zzq`，不是新文件）
