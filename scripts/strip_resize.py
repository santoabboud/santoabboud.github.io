#!/usr/bin/env python3
"""Bake EXIF orientation, strip ALL metadata (incl. GPS), resize, recompress.

Usage: python3 scripts/strip_resize.py IN1 [IN2 ...] --out DIR [--max 1600] [--q 84]
Verifies after writing that no EXIF block survived.
"""
import argparse, os, sys
from PIL import Image, ImageOps

ap = argparse.ArgumentParser()
ap.add_argument('inputs', nargs='+')
ap.add_argument('--out', required=True)
ap.add_argument('--max', type=int, default=1600, help='max edge [px]')
ap.add_argument('--q', type=int, default=84, help='JPEG quality')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
fail = 0
for src in a.inputs:
    im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
    im.thumbnail((a.max, a.max), Image.LANCZOS)
    base = os.path.splitext(os.path.basename(src))[0] + '.jpg'
    dst = os.path.join(a.out, base)
    im.save(dst, 'JPEG', quality=a.q, progressive=True, optimize=True)
    exif = Image.open(dst)._getexif()
    ok = exif is None
    fail += not ok
    print(f"{dst:50s} {im.size}  {os.path.getsize(dst)//1024:4d} KB  exif={'NONE' if ok else 'PRESENT!'}")
sys.exit(1 if fail else 0)
