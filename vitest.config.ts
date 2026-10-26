import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /*
     * ⚠️ 这条是结构，不是配置：src/core 必须零 DOM、零 React。
     * 它一旦碰了 window / localStorage / document，测试当场红。
     * 所以"core 不许碰浏览器"这件事不靠 lint 规则自律，靠运行时环境。
     */
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
