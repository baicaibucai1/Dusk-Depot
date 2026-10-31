# 第三方许可证

这个项目自己写的代码是项目本身的（见仓库根目录）。下面是**运行时真正打包进来**的
第三方库里，许可证要求保留声明的那几个。开发依赖（TypeScript / Vite / Biome 等）
不随产物分发，不在此列。

## epub.js 0.3.93

用途：书架的 EPUB 解析与分页排版（`src/core/shelf/epub.ts`、`src/ui/shelf/EpubReader.tsx`）。
许可证：**BSD-2-Clause**（Copyright © 2013 FuturePress）。

```
Copyright (c) 2013, FuturePress

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

原始许可证文本：`node_modules/epubjs/license`。

## JSZip（epub.js 的依赖，随它一起打包）

用途：解 EPUB 的 ZIP 容器（我们不直接调用它）。
许可证：**MIT 或 GPL-3.0-or-later**（双许可，本项目按 MIT 使用）。

```
Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## tauri-plugin-opener

用途：「在资源管理器中查看」（Rust 侧，调用系统默认程序 / 定位文件）。
许可证：MIT OR Apache-2.0，与 Tauri 本体一致。随桌面安装包分发时，其许可证文本由
Cargo 依赖树自带（`src-tauri/Cargo.lock` 可查），通常放在安装包的第三方声明里。

---

## 没有加进来的东西（说明一下）

- **不引入 readium / Adobe SDK**：它们要么体积巨大，要么带 DRM 组件，与"不绕过 DRM"的
  立场冲突。
- **PDF 仍然用 pdfjs-dist**（Apache-2.0），跟书架无关，走原来的预览器。
