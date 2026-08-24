from pathlib import Path

from PIL import Image


root = Path(__file__).resolve().parent.parent
source = root / "desktop" / "assets" / "icon.png"
target = root / "desktop" / "assets" / "icon.icns"

with Image.open(source) as image:
    rgba = image.convert("RGBA")
    rgba.save(target, format="ICNS")
    rgba.resize((32, 32), Image.Resampling.LANCZOS).save(
        root / "desktop" / "static" / "tray.png",
        format="PNG",
    )

print(f"Generated {target}")
