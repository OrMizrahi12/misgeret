"""Generate deterministic Windows icon assets from Misgeret's existing brand mark."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "desktop" / "assets"
SIZE = 1024


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)

    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Matches client/public/favicon.svg: one strong accent tile and the Hebrew
    # initial of "מסגרת". A generous transparent gutter keeps Windows' smaller
    # taskbar renditions from visually clipping the rounded corners.
    gutter = 32
    draw.rounded_rectangle(
        (gutter, gutter, SIZE - gutter, SIZE - gutter),
        radius=220,
        fill="#7d86ff",
    )

    font_path = Path("C:/Windows/Fonts/arialbd.ttf")
    if not font_path.exists():
        raise FileNotFoundError(f"Required Windows font not found: {font_path}")
    font = ImageFont.truetype(str(font_path), 590)

    glyph = "מ"
    bbox = draw.textbbox((0, 0), glyph, font=font)
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    x = (SIZE - width) / 2 - bbox[0]
    y = (SIZE - height) / 2 - bbox[1] + 40
    draw.text((x, y), glyph, font=font, fill="#15151d")

    png_path = ASSETS / "icon.png"
    ico_path = ASSETS / "icon.ico"
    image.save(png_path, optimize=True)
    image.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print(png_path)
    print(ico_path)


if __name__ == "__main__":
    main()
