"""Spike: pdfplumber against the same PDFs used for the xberg comparison.

Measures the two things that actually matter for Nodus:
  1. speed (pdfminer.six is pure Python — expected to be the weak point)
  2. what geometry and table structure it recovers that the current
     pdfjs-based engine does not.
"""
import json
import sys
import time

import pdfplumber

target = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "text"

t0 = time.time()
parts = []
words_with_geometry = 0
tables_found = 0
ruling_lines = 0
rects = 0

with pdfplumber.open(target) as pdf:
    page_count = len(pdf.pages)
    for i, page in enumerate(pdf.pages, start=1):
        # layout=True mimics visual layout; the default is reading-stream order.
        text = page.extract_text(layout=(mode == "layout")) or ""
        if text.strip():
            parts.append(f"[[p. {i}]]\n{text}")

        # Char/word-level geometry — the thing xberg does not expose at all.
        words_with_geometry += len(page.extract_words())

        # Ruling-line awareness: pdfplumber sees vector graphics as table borders.
        ruling_lines += len(page.lines)
        rects += len(page.rects)

        found = page.extract_tables()
        tables_found += len(found)

elapsed = (time.time() - t0) * 1000
out = "\n\n".join(parts)

print(json.dumps({
    "mode": mode,
    "pages": page_count,
    "ms": round(elapsed),
    "chars": len(out),
    "words": len(out.split()),
    "lines": len([l for l in out.split("\n") if l.strip()]),
    "paragraphs": len([p for p in out.split("\n\n") if p.strip()]),
    "wordsWithGeometry": words_with_geometry,
    "rulingLines": ruling_lines,
    "rects": rects,
    "tables": tables_found,
}, indent=2))

with open(f"out-pdfplumber-{mode}.txt", "w") as fh:
    fh.write(out)
