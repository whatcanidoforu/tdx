"""
生成股票名称图片 —— 多列布局，手机上一屏能看全。

用法（推荐，避免 PowerShell 管道编码问题）：
    python stock_names_image.py <输入json> <输出png>

输入 JSON 格式：
    {"title": "标题", "names": ["名称1", "名称2", ...]}
"""

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 中文字体候选（按优先级）
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 粗体
    r"C:\Windows\Fonts\msyh.ttc",     # 微软雅黑
    r"C:\Windows\Fonts\simhei.ttf",   # 黑体
    r"C:\Windows\Fonts\simsun.ttc",   # 宋体
]

# 配色
BG_COLOR = (255, 255, 255)
TITLE_COLOR = (33, 33, 33)
NAME_COLOR = (25, 25, 25)
STRIPE_COLOR = (246, 248, 251)
ACCENT_COLOR = (68, 114, 196)
FOOTER_COLOR = (140, 140, 140)

# 布局参数
PADDING = 44
TITLE_SIZE = 40
NAME_SIZE = 40
ROW_GAP = 16
COL_GAP = 40
FOOTER_SIZE = 26

# 目标：图片高度控制在合理范围，宽度不超过上限
MAX_WIDTH = 1080
MAX_HEIGHT = 1600


def load_font(size):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def text_size(text, font):
    if not text:
        return 0, 0
    bbox = font.getbbox(text)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def choose_columns(count):
    """按数量选列数，让版面接近竖向矩形（手机上好看）。"""
    if count <= 6:
        return 1
    if count <= 15:
        return 2
    if count <= 30:
        return 3
    if count <= 48:
        return 4
    if count <= 80:
        return 5
    return 6


def generate(output_path, title, names):
    title_font = load_font(TITLE_SIZE)
    name_font = load_font(NAME_SIZE)
    footer_font = load_font(FOOTER_SIZE)

    count = len(names)
    columns = choose_columns(count)
    rows = max(1, math.ceil(count / columns)) if count else 1

    # 列宽取最长名称
    name_w = 0
    name_h = 0
    for name in names:
        w, h = text_size(name, name_font)
        name_w = max(name_w, w)
        name_h = max(name_h, h)
    if name_h == 0:
        name_h = NAME_SIZE
    # 预留编号宽度
    index_w, _ = text_size(f"{count}.", name_font)
    cell_w = index_w + 10 + name_w

    title_w, title_h = text_size(title, title_font)
    footer_text = f"HJ10 底背离 · 共 {count} 只"
    footer_w, footer_h = text_size(footer_text, footer_font)

    content_w = max(
        columns * cell_w + (columns - 1) * COL_GAP,
        title_w,
        footer_w,
    )
    width = content_w + PADDING * 2

    row_h = name_h + ROW_GAP
    height = PADDING * 2 + title_h + 16 + 3 + 24 + rows * row_h + 20 + footer_h

    # 缩放：超过上限时按比例缩小字号（简单处理：直接缩小整图）
    img = Image.new("RGB", (width, height), BG_COLOR)
    draw = ImageDraw.Draw(img)

    y = PADDING
    draw.text((PADDING, y), title, font=title_font, fill=TITLE_COLOR)
    y += title_h + 16

    # 标题下强调线
    draw.line([(PADDING, y), (width - PADDING, y)], fill=ACCENT_COLOR, width=3)
    y += 3 + 24

    # 多列布局：先按行再按列填充（横向优先，读起来更顺）
    for i, name in enumerate(names):
        col = i % columns
        row = i // columns
        x = PADDING + col * (cell_w + COL_GAP)
        cy = y + row * row_h

        # 斑马纹
        if row % 2 == 1:
            draw.rectangle(
                [x - 8, cy - 5, x + cell_w + 8, cy + name_h + 5],
                fill=STRIPE_COLOR,
            )

        # 序号（灰色小字）
        index_text = f"{i + 1}."
        draw.text((x, cy), index_text, font=name_font, fill=(170, 170, 170))
        # 名称
        draw.text((x + index_w + 10, cy), name, font=name_font, fill=NAME_COLOR)

    y += rows * row_h + 20
    draw.text((PADDING, y), footer_text, font=footer_font, fill=FOOTER_COLOR)

    # 超过高度上限时等比缩小，避免手机上要滑很久
    if height > MAX_HEIGHT or width > MAX_WIDTH:
        ratio = min(MAX_WIDTH / width, MAX_HEIGHT / height, 1.0)
        new_size = (int(width * ratio), int(height * ratio))
        img = img.resize(new_size, Image.LANCZOS)
        width, height = new_size

    img.save(output_path, "PNG", optimize=True)
    return width, height


def main():
    if len(sys.argv) < 3:
        print("usage: python stock_names_image.py <input.json> <output.png>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, encoding="utf-8") as f:
        data = json.load(f)

    width, height = generate(
        output_path,
        data.get("title", "Stock Names"),
        data.get("names", []),
    )
    print(f"OK {output_path} {width}x{height} {len(data.get('names', []))} names")


if __name__ == "__main__":
    main()
