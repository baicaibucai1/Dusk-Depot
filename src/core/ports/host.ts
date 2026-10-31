/*
 * Host —— 存储那一侧。桌面 / 浏览器 / 暂存三种实现，对上层的形状完全一样。
 *
 * ## 四条硬规矩
 *
 *   ① 路径是**仓库内的相对路径**，正斜杠分隔。绝对路径不许进这个接口 ——
 *      那是宿主自己的事（Rust 侧 / 目录句柄），上层拿到的永远是相对名。
 *      于是"AI 助手能不能写到仓库外面"这类问题在这里天然不存在，不用再兜正则。
 *
 *   ② **read 一律返回字节**，没有"读文本"这个方法。
 *      旧项目是 read 返 string + readBytes 返字节，然后靠"按后缀分派"避免把 PNG 当文本读 ——
 *      那是一整类静默损坏（解不出的字节变 U+FFFD，而且不可逆）。
 *      只有字节，"文字还是附件"的分派就只剩 decode 一处，做错了会立刻炸。
 *
 *   ③ **目录是真的目录**。不需要在空目录里放标识文件 —— 那是给 git 用的补丁，
 *      现在没有同步，mkdir / rmdir 就够了。
 *
 *   ④ 出错必须说人话（"这个文件夹写不进去，换一个吧"）。
 *      仓库选错了后面每一步都会失败，用户得知道该改什么。
 */

export type HostKind = 'tauri' | 'fsa' | 'memory'

/** 仓库里的一个条目。`mtime` 用来跳过没变的文件，别拿它当"内容没变"的定论 */
export type Entry = {
  path: string
  kind: 'file' | 'dir'
  /** 目录为 0 */
  size: number
  /** 毫秒时间戳 */
  mtime: number
}

/**
 * 这个宿主能做什么。
 *
 * ⚠️ 这是**一张数据**，不是散在代码里的 `isTauri()`。
 * 界面按它决定自己能说什么话 —— 于是"不可能渲染出一句能力不支持的话"是结构，
 * 不是文案纪律。
 */
export type HostCapabilities = {
  /** 能真的挑一个目录。Safari / Firefox 拿不到目录句柄，这里就是 false */
  pickDir: boolean
  /** 能监听目录变化。浏览器没有任何 watch API，只能靠聚焦时抽查 */
  watch: boolean
  /** 内容真的落在磁盘上。memory 是 false —— 界面必须把"暂存"两个字说在明处 */
  durable: boolean
  /** 能进系统凭据库 */
  keychain: boolean
  /**
   * 能在系统文件管理器里定位一个文件。
   * 只有拿到真实绝对路径的宿主（桌面端）才为 true；浏览器 FSA 和 memory 都拿不到。
   */
  reveal: boolean
}

export type Host = {
  readonly kind: HostKind
  /** 显示用的短名字 */
  readonly label: string
  /** 给人看的完整位置。桌面端是绝对路径，浏览器只有一个名字，暂存是空串 */
  readonly where: string
  readonly capabilities: HostCapabilities

  /** 列全部条目。**目录也在里面** —— 空目录要能显示出来，所以不能只列文件 */
  list(): Promise<Entry[]>
  read(path: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>

  /**
   * 换名 / 搬家。**可选** —— 浏览器那条路只能"读出来、写新的、删旧的"。
   *
   * ⚠️ 上层不依赖它：改名在"按差异落盘"的那一层天然就是"写一个新的 + 删掉旧的"，
   * 结果完全等价。留着这条是因为真文件系统上有原子换名，比复制可靠得多；
   * 将来搬整棵目录时会用得上。
   */
  move?(from: string, to: string): Promise<void>

  /**
   * 在系统文件管理器里定位这个文件。
   *
   * ⚠️ 只对**这个宿主根目录内**的相对路径负责：桌面端会自己做 join + 越界检查，
   *    浏览器端没有真实路径，`capabilities.reveal` 是 false，这个方法不存在。
   */
  reveal?(path: string): Promise<void>
}
