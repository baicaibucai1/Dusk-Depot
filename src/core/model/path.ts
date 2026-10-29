/*
 * 仓库内路径。纯函数、零依赖、零 DOM —— 跑在 Node 里，所以能直接单测。
 *
 * 这里是全应用**唯一**允许摆弄路径的地方。别的地方拿到 Path 就只当不透明字符串用，
 * 不要再自己 split 一遍 —— 反斜杠、前导斜杠、`..` 越界这几个坑只该在这里踩一次。
 */

/** 仓库内的相对路径，正斜杠分隔，**不含**前导斜杠。空串表示仓库根 */
export type Path = string

/**
 * 把用户或系统给的路径收拾成仓库内路径。
 *
 * 三件事：反斜杠归一、`.`/空段丢掉、`..` 就地回退一级。
 * 越出仓库根的 `..` 与绝对路径一律**抛错**，不做"悄悄夹紧" ——
 * 夹紧会让一个写错的路径变成写到别的地方，那比报错危险得多。
 */
export function normalizePath(input: string): Path {
  const raw = input.replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`绝对路径不许进这一层：${input}`)
  }

  const out: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) throw new Error(`路径越出仓库：${input}`)
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

export function segments(path: Path): string[] {
  return path === '' ? [] : path.split('/')
}

/** 上一级目录。根目录的上一级还是根目录（空串） */
export function parentOf(path: Path): Path {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** 最后一段，带后缀 */
export function nameOf(path: Path): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 后缀，带点；没有就是空串。
 * ⚠️ `.gitignore` 这种**整名就是后缀**的不能算有后缀 —— 所以 `dot > 0`，不是 `>= 0`。
 */
export function extOf(path: Path): string {
  const name = nameOf(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/**
 * 界面上显示的名字：`.md` 不带后缀（前面另有 markdown 标记），其余照原样。
 * 只影响显示 —— 路径、链接、落盘一律用真名。
 */
export function labelOf(path: Path): string {
  return extOf(path).toLowerCase() === '.md' ? stemOf(path) : nameOf(path)
}

/** 去掉后缀的名字。和 extOf 用同一套判定，两个必须一致 */
export function stemOf(path: Path): string {
  const name = nameOf(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function joinPath(...parts: string[]): Path {
  return normalizePath(parts.filter((p) => p !== '').join('/'))
}

/** 任意一段以点开头就算隐藏。左边那棵文件树据此不列 .git / .dusk 之类 */
export function isHidden(path: Path): boolean {
  return segments(path).some((seg) => seg.startsWith('.'))
}

/** 同名判定：同一目录下同名即冲突（大小写不敏感 —— Windows 上本来就分不开） */
export function samePath(a: Path, b: Path): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
