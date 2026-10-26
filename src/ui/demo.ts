/*
 * 出厂示例：直接读仓库根目录的 `示例库/`。
 *
 * 为什么要读真文件而不是另外写一份字符串：**内容只有一份**。
 * 改 `示例库/` 里的 md，一键示例跟着变 —— 不会出现"演示和文档说的不一样"。
 *
 * 只能读文本：图片这类二进制不走这里（内存宿主支持 base64 种子，但现在不需要）。
 */
import type { FileMap } from '../core/model/library'
import assetNote from '../../示例库/素材/说明.md?raw'
import start from '../../示例库/开始这里.md?raw'
import syntax from '../../示例库/语法示例.md?raw'
import weekly from '../../示例库/项目/周计划.md?raw'

export const CURRENT = '开始这里.md'

export const SEED: FileMap = {
  '开始这里.md': start,
  '语法示例.md': syntax,
  '项目/周计划.md': weekly,
  '素材/说明.md': assetNote,
}
