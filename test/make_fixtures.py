"""生成 dsh-image-import 解码器的测试样本。

用 Pillow 把同一张确定性图案写成各种容器格式，并把 Pillow 自己解出来的 RGBA
写成 `.rgba` 期望值：测试因此对标的是一个成熟解码器，而不是我们自己的假设。

用法：python test/make_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, TiffImagePlugin

WIDTH = 37
HEIGHT = 23
ROOT = Path(__file__).resolve().parent / "fixtures"


def pattern_rgba() -> Image.Image:
    """构造一张确定性的 RGBA 图案：四角纯色 + 渐变 + 半透明斜带。"""
    image = Image.new("RGBA", (WIDTH, HEIGHT))
    pixels = image.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            r = (x * 7 + y * 3) % 256
            g = (x * 3 + y * 11) % 256
            b = (x * 13 + y * 5) % 256
            a = 255
            if x < 8 and y < 6:
                r, g, b, a = 255, 0, 0, 255
            elif x >= WIDTH - 8 and y < 6:
                r, g, b, a = 0, 255, 0, 255
            elif (x + y) % 9 == 0:
                r, g, b, a = 20, 40, 60, 96
            pixels[x, y] = (r, g, b, a)
    return image


def write_case(name: str, payload: bytes | None, expected: Image.Image, source_path: Path | None) -> None:
    """写出样本与期望 RGBA，`.json` 记录尺寸与期望的容器格式。"""
    if payload is not None:
        (ROOT / name).write_bytes(payload)
    rgba = expected.convert("RGBA")
    (ROOT / f"{name}.rgba").write_bytes(rgba.tobytes())
    (ROOT / f"{name}.json").write_text(
        json.dumps({"width": rgba.width, "height": rgba.height, "format": Path(name).suffix.lstrip(".")}),
        encoding="utf-8",
    )
    print(f"  {name:<30} {rgba.width}x{rgba.height}")


def emit(name: str, image: Image.Image, **save) -> None:
    """用 Pillow 写样本，并回读 Pillow 的 RGBA 作为期望值。"""
    path = ROOT / name
    image.save(path, **save)
    with Image.open(path) as reopened:
        expected = reopened.convert("RGBA")
    write_case(name, None, expected, path)


def emit_manual(name: str, payload: bytes, expected: Image.Image) -> None:
    """手写样本（Pillow 不能写 ASCII 变体），期望值另行给定。"""
    write_case(name, payload, expected, None)


def ascii_ppm(image: Image.Image) -> bytes:
    rgb = image.convert("RGB")
    pixels = rgb.load()
    rows = ["P3", f"{rgb.width} {rgb.height}", "255"]
    for y in range(rgb.height):
        rows.append(" ".join(f"{pixels[x, y][0]} {pixels[x, y][1]} {pixels[x, y][2]}" for x in range(rgb.width)))
    return ("\n".join(rows) + "\n").encode("ascii")


def ascii_pgm(image: Image.Image) -> bytes:
    gray = image.convert("L")
    pixels = gray.load()
    rows = ["P2", f"{gray.width} {gray.height}", "255"]
    for y in range(gray.height):
        rows.append(" ".join(str(pixels[x, y]) for x in range(gray.width)))
    return ("\n".join(rows) + "\n").encode("ascii")


def ascii_pbm(image: Image.Image) -> bytes:
    bilevel = image.convert("1")
    pixels = bilevel.load()
    rows = ["P1", f"{bilevel.width} {bilevel.height}"]
    for y in range(bilevel.height):
        rows.append(" ".join("1" if pixels[x, y] == 0 else "0" for x in range(bilevel.width)))
    return ("\n".join(rows) + "\n").encode("ascii")


def attempt(label: str, action) -> None:
    """单个样本失败时只跳过它——不同 Pillow 版本的编码器能力不同。"""
    try:
        action()
    except Exception as error:  # noqa: BLE001 - 记录即可，缺样本不算失败
        print(f"  skip {label}: {error}")


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    base = pattern_rgba()
    rgb = base.convert("RGB")
    gray = base.convert("L")
    bilevel = base.convert("1")
    palette = base.convert("RGB").convert("P", palette=Image.Palette.ADAPTIVE, colors=64)
    gray16 = base.convert("L").convert("I;16")

    print("TIFF")
    for label, image, compression in [
        ("rgb/raw", rgb, "raw"),
        ("rgb/lzw", rgb, "tiff_lzw"),
        ("rgb/packbits", rgb, "packbits"),
        ("rgb/deflate", rgb, "tiff_deflate"),
        ("gray/raw", gray, "raw"),
        ("gray/lzw", gray, "tiff_lzw"),
        ("bilevel/raw", bilevel, "raw"),
        ("bilevel/lzw", bilevel, "tiff_lzw"),
        ("bilevel/packbits", bilevel, "packbits"),
        ("palette/raw", palette, "raw"),
        ("palette/lzw", palette, "tiff_lzw"),
        ("rgba/raw", base, "raw"),
        ("rgba/lzw", base, "tiff_lzw"),
        ("gray16/raw", gray16, "raw"),
    ]:
        name = f"tiff-{label.replace('/', '-')}.tif"
        attempt(name, lambda n=name, i=image, c=compression: emit(n, i, compression=c))

    predictor = TiffImagePlugin.ImageFileDirectory_v2()
    predictor[317] = 2
    for label, image, compression in [("rgb", rgb, "tiff_lzw"), ("rgb", rgb, "tiff_deflate")]:
        name = f"tiff-{label}-predictor2-{compression.split('_')[-1]}.tif"
        attempt(
            name,
            lambda n=name, i=image, c=compression: emit(n, i, compression=c, tiffinfo=predictor),
        )

    print("TGA")
    for name, image, save in [
        ("truecolor24.tga", rgb, {}),
        ("truecolor32.tga", base, {}),
        ("truecolor24-rle.tga", rgb, {"compression": "tga_rle"}),
        ("truecolor32-rle.tga", base, {"compression": "tga_rle"}),
        ("gray8.tga", gray, {}),
    ]:
        attempt(name, lambda n=name, i=image, s=save: emit(n, i, **s))

    print("PCX")
    for name, save in [("palette256.pcx", {}), ("palette256-rle.pcx", {"compression": "pcx_rle"})]:
        attempt(name, lambda n=name, s=save: emit(n, palette, **s))

    print("Netpbm")
    for name, image in [("binary-rgb.ppm", rgb), ("binary-gray.pgm", gray), ("binary-bitmap.pbm", bilevel)]:
        attempt(name, lambda n=name, i=image: emit(n, i))
    emit_manual("ascii-rgb.ppm", ascii_ppm(base), rgb)
    emit_manual("ascii-gray.pgm", ascii_pgm(base), gray)
    emit_manual("ascii-bitmap.pbm", ascii_pbm(base), bilevel)

    print("对照格式（浏览器自己解，仅作回归）")
    attempt("truecolor24.bmp", lambda: emit("truecolor24.bmp", rgb))
    attempt("rgba.png", lambda: emit("rgba.png", base))

    print(f"\n样本写入 {ROOT}")


if __name__ == "__main__":
    main()
