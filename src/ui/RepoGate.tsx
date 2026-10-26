type Props = {
  canPick: boolean
  isDesktop: boolean
  busy: boolean
  /** 打开到哪一步了（选文件夹 / 读取中）。null = 没在打开 */
  stage: string | null
  error: string | null
  /** 上次用的仓库。有它就把"打开 xxx"做成主按钮，而不是单独再开一屏 */
  pending: { label: string } | null
  onPick: () => void
  onResume: () => void
  onDefault: () => void
  onMemory: () => void
}

/**
 * 选仓库那道门。
 *
 * 浏览器有个硬限制：目录句柄刷新后还在，但写权限会退回 `prompt`，而**要权限必须有用户手势**。
 * 所以"记住仓库"在网页端最好也只能做到"一进来就是一屏、点一下就开" ——
 * 但那一屏**就是这一屏**，不再为它单独做一个页面。
 */
export function RepoGate({
  canPick,
  isDesktop,
  busy,
  stage,
  error,
  pending,
  onPick,
  onResume,
  onDefault,
  onMemory,
}: Props) {
  return (
    <div className="grid h-dvh place-items-center overflow-y-auto bg-paper px-6 py-10">
      <div className="w-full max-w-[30rem]">
        <div className="mb-7 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10 rounded-[10px]" />
          <div>
            <div className="text-[15px] font-semibold tracking-tight">Dusk Depot</div>
            <div className="text-[12px] text-ink-3">你的文件夹就是笔记库</div>
          </div>
        </div>

        {pending ? (
          <>
            <p className="text-[12px] text-ink-3">上次用的仓库</p>
            <p className="mt-1 truncate text-[19px] font-semibold tracking-tight" title={pending.label}>
              {pending.label}
            </p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
              浏览器要求再确认一次才给这个文件夹的写权限。
            </p>
          </>
        ) : (
          <>
            <h1 className="text-[20px] font-semibold tracking-tight">选一个文件夹当仓库</h1>
            <p className="mt-2.5 text-[13px] leading-relaxed text-ink-2">
              笔记就是那个文件夹里的{' '}
              <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">.md</code> 文件。
              程序只是它的一个视图 —— 你可以随时用别的编辑器改、用网盘备份，或者换一个文件夹。
            </p>
          </>
        )}

        <div className="mt-7 flex flex-col gap-2">
          {pending ? (
            <button
              type="button"
              onClick={onResume}
              disabled={busy}
              className="h-10 rounded-lg bg-ink text-[13px] font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? '正在打开…' : `打开 ${pending.label}`}
            </button>
          ) : null}

          {canPick ? (
            <button
              type="button"
              onClick={onPick}
              disabled={busy}
              className={[
                'h-10 rounded-lg text-[13px] transition-opacity disabled:opacity-50',
                pending
                  ? 'border border-line text-ink-2 hover:bg-surface-2'
                  : 'bg-ink font-medium text-paper hover:opacity-90',
              ].join(' ')}
            >
              {busy ? '正在打开…' : pending ? '换一个文件夹' : '选择文件夹'}
            </button>
          ) : (
            <div className="rounded-lg bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-2">
              这个浏览器拿不到目录句柄 —— Safari / Firefox 不支持 File System Access。
              换 Chrome / Edge 打开，或者用桌面版。
            </div>
          )}

          {isDesktop ? (
            <button
              type="button"
              onClick={onDefault}
              disabled={busy}
              className="h-10 rounded-lg border border-line text-[13px] text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              用程序自带的目录
            </button>
          ) : null}

          {/* 示例库永远给一个入口：不选文件夹也要能立刻上手 */}
          <button
            type="button"
            onClick={onMemory}
            disabled={busy}
            className="h-10 rounded-lg border border-line text-[13px] text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            打开示例库　<span className="text-ink-3">（暂存，不在磁盘上）</span>
          </button>

          {!canPick ? (
            <p className="px-1 text-[11.5px] leading-relaxed text-ink-3">
              示例库可以直接写，但关掉浏览器就没了。要真的存到磁盘，换 Chrome / Edge 选文件夹。
            </p>
          ) : null}
        </div>

        {stage ? (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
            <span className="size-1.5 animate-pulse rounded-full bg-green" />
            {stage}
          </p>
        ) : null}

        <EnvLine />

        {error ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-[#e3b7a8] bg-[#fdf2ed] p-3 text-[12px] leading-relaxed text-[#7a3a24]"
          >
            <p className="font-medium">打不开这个文件夹</p>
            <p className="mt-1 break-words font-mono text-[11.5px] opacity-80">{error}</p>
            <p className="mt-1.5 text-[11.5px] opacity-80">
              换一个文件夹再试；或者先用上面的「打开示例库」，确认界面能用。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 环境自检：不解释原理，只说这台浏览器到底给不给两样东西。
 * 选不了文件夹时，这一行能立刻分清"程序坏了"还是"环境不给"。
 */
function EnvLine() {
  const picker = typeof window !== 'undefined' && 'showDirectoryPicker' in window
  let storage = false
  try {
    localStorage.setItem('dusk.probe', '1')
    localStorage.removeItem('dusk.probe')
    storage = true
  } catch {
    storage = false
  }

  return (
    <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
      环境：{picker ? '支持目录选择' : '不支持目录选择（要 Chrome / Edge）'}
      {storage ? ' · 可记住仓库' : ' · 记不住仓库（存储被禁，不影响本次打开）'}
    </p>
  )
}
