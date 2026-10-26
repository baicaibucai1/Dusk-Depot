import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // host: true —— 手机连同一个 WiFi 就能打开，端口不变
  server: {
    host: true,
    port: 5183,
    watch: {
      /*
       * ⚠️ 编辑器的写文件是"临时目录 + 原子改名"，那个临时目录会开在源码目录里
       * （`.DocPane.tsx.<pid>.<uuid>.tmpdir/`）。Vite 去 watch 它就会撞上 EBUSY，
       * 而这是**未捕获的 'error' 事件** —— 整个 dev server 直接退出，不是警告。
       *
       * ⚠️ 更要命的一条：Vite 对项目目录里**任何**文件的变化都会整页重载。
       * 所以如果用户的仓库文件夹在项目里，每敲一下字、450ms 后自动保存写一个 .md，
       * 页面就刷一次 —— 表现成"一换行就刷新"。笔记和工具产物都不该被监听。
       */
      ignored: [
        '**/*.tmpdir/**',
        '**/*.tmp',
        '**/*.md',
        '**/*.markdown',
        '**/*.txt',
        '**/.zzq',
        '**/scripts/**',
        '**/assets/**',
        '**/src-tauri/**',
        '**/dist/**',
      ],
    },
  },
  preview: { host: true, port: 5184 },
  build: {
    outDir: 'dist',
    /*
     * 编辑器那块 511KB 是 CodeMirror 本体，它待在自己的懒加载 chunk 里，
     * 不在首屏路径上 —— 所以把阈值放到 600，让"首屏变大"这件事重新变得刺眼。
     */
    chunkSizeWarningLimit: 600,
  },
})
