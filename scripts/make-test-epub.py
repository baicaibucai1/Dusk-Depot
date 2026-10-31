#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成测试用 EPUB（不依赖任何第三方库）。

用法： python scripts/make-test-epub.py [输出目录]

产出：
  三体.epub          正常书：EPUB 3，中文书名/作者，两章，一张 PNG 封面
  银河.epub          第二本正常书（不同内容哈希，测切书不串进度）
  基地.epub          第三本正常书（测"仓库 EPUB 加进书架"）
  损坏.epub          不是 ZIP 的假货（测"打不开"）
  加密.epub          带 META-INF/encryption.xml 的假 DRM（测"不支持 DRM"）

为什么要自己造：书架的验收要真 EPUB，而仓库里不该塞版权书。
"""
import os
import struct
import sys
import zipfile
import zlib


def png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """最小的合法 PNG（纯色），不依赖 Pillow。"""
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def chapter(title: str, body: str) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>{title}</title></head>
<body>
  <h1>{title}</h1>
  {body}
</body>
</html>
"""


def build(
    path: str,
    drm: bool = False,
    title: str = "三体",
    author: str = "刘慈欣",
    uid: str = "6f6b2f0e-test-book",
    accent: tuple[int, int, int] = (14, 155, 102),
) -> None:
    cover = png(60, 80, accent)
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:{uid}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:publisher>测试出版社</dc:publisher>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-10-31T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
"""
    nav = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="ch1.xhtml">第一章 地球往事</a>
        <ol><li><a href="ch1.xhtml#sec">第一节 红岸</a></li></ol>
      </li>
      <li><a href="ch2.xhtml">第二章 黑暗森林</a></li>
    </ol>
  </nav>
</body>
</html>
"""
    ch1 = chapter(
        "第一章 地球往事",
        '<p id="sec">这是第一章的正文。书架验收用它确认 EPUB 能正常渲染、翻页和记录进度。</p>'
        "<p>第二段用来测试换行与段落间距。</p>"
        + "".join(f"<p>补充段落 {i}：宇宙很大，生活更大。</p>" for i in range(1, 6)),
    )
    ch2 = chapter(
        "第二章 黑暗森林",
        "<p>这是第二章。用来确认目录跳转与进度百分比。</p>"
        + "".join(f"<p>段落 {i}：给岁月以文明，而不是给文明以岁月。</p>" for i in range(1, 6)),
    )
    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""
    with zipfile.ZipFile(path, "w") as z:
        # 规范要求 mimetype 是第一条且不压缩
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/ch1.xhtml", ch1, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/ch2.xhtml", ch2, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/cover.png", cover, compress_type=zipfile.ZIP_DEFLATED)
        if drm:
            z.writestr(
                "META-INF/encryption.xml",
                '<?xml version="1.0" encoding="utf-8"?>'
                '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                '<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">'
                '<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>'
                "<CipherData><CipherReference URI=\"OEBPS/ch1.xhtml\"/></CipherData>"
                "</EncryptedData></encryption>",
                compress_type=zipfile.ZIP_DEFLATED,
            )


def build_drm(path: str) -> None:
    # 结构完整、只是资源被 AES 加密的"真 DRM"书：能被解包，但读不了正文
    build(path, drm=True)


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("TEMP", "."), "dd-shelf-epub")
    os.makedirs(out, exist_ok=True)
    build(os.path.join(out, "三体.epub"))
    build(
        os.path.join(out, "银河.epub"),
        title="银河系搭车客指南",
        author="道格拉斯·亚当斯",
        uid="9a1c0f3e-second-book",
        accent=(36, 92, 160),
    )
    build(
        os.path.join(out, "基地.epub"),
        title="基地",
        author="艾萨克·阿西莫夫",
        uid="3d7e2b1a-third-book",
        accent=(120, 70, 160),
    )
    build_drm(os.path.join(out, "加密.epub"))
    with open(os.path.join(out, "损坏.epub"), "wb") as f:
        f.write(b"this is not a zip file, just text pretending to be an epub" * 3)
    print(out)
    for name in os.listdir(out):
        print(" ", name, os.path.getsize(os.path.join(out, name)))


if __name__ == "__main__":
    main()
