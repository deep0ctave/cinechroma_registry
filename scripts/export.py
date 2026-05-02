"""
export.py — Export cinechroma_v3 data to a single JSON file for the registry.

Reads the cinechroma_v3 SQLite DB, palette JSONs, and OKLAB histograms.
Computes cosine similarity between all films.
Writes scripts/cinechroma-export.json for build-data.mjs to consume.

Usage:
    python scripts/export.py <cinechroma_output_dir>
    e.g.
    python scripts/export.py "C:/Users/avinash/Documents/cinechroma_v3/cinechroma_output"
"""

from __future__ import annotations
import json
import re
import sqlite3
import sys
from pathlib import Path

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity


# ── Helpers ──────────────────────────────────────────────────────────────────

def parse_title_year(raw_title: str, video_path: str) -> tuple[str, int | None]:
    """
    Try to get a clean title + year from the DB title or the video path's
    parent directory name.  Handles both "(Year)" and dot-separated formats.
    """
    # Prefer the parent folder name from the video path — usually cleaner
    candidates = []
    if video_path:
        try:
            parent = Path(video_path).parent.name
            if parent:
                candidates.append(parent)
        except Exception:
            pass
    if raw_title:
        candidates.append(raw_title)

    for candidate in candidates:
        # "Title (Year)" or "Title (Year) [extra]"
        m = re.match(r'^(.+?)\s*\((\d{4})\)', candidate)
        if m:
            return m.group(1).strip(), int(m.group(2))

        # Dot-separated: "Title.Year.1080p..."
        parts = re.split(r'[.\s]+', candidate)
        year_idx = -1
        for i, p in enumerate(parts):
            if re.fullmatch(r'1[89]\d\d|20[012]\d', p):
                year_idx = i
                break
        if year_idx > 0:
            title = ' '.join(parts[:year_idx])
            return title, int(parts[year_idx])

    # Fallback
    year_m = re.search(r'(1[89]\d\d|20[012]\d)', raw_title or '')
    year = int(year_m.group(1)) if year_m else None
    title = re.sub(r'[\(\[].+$', '', raw_title or '').strip() or raw_title
    return title, year


def slugify(title: str, year: int | None) -> str:
    base = title.lower()
    base = re.sub(r'[^a-z0-9\s-]', '', base)
    base = re.sub(r'\s+', '-', base)
    base = re.sub(r'-+', '-', base).strip('-')
    return f'{base}-{year}' if year else base


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/export.py <cinechroma_output_dir>")
        sys.exit(1)

    output_root = Path(sys.argv[1])
    script_dir = Path(__file__).parent

    db_path = output_root / "db" / "films.sqlite"
    if not db_path.exists():
        print(f"ERROR: DB not found at {db_path}")
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM films WHERE status = 'done' ORDER BY id"
    ).fetchall()
    conn.close()

    if not rows:
        print("No done films found in DB.")
        sys.exit(1)

    films = []
    histograms = []

    for row in rows:
        film_id = row['id']
        slug_id = f"film_{film_id:04d}"

        # Clean title + year
        title, year = parse_title_year(row['title'] or '', row['path'] or '')

        # Palette JSON
        palette_path = Path(row['palette_path']) if row['palette_path'] else \
            output_root / "palettes" / f"{slug_id}.json"
        if not palette_path.exists():
            print(f"  SKIP {slug_id} — palette not found at {palette_path}")
            continue
        palette_data = json.loads(palette_path.read_text())

        # Histogram npz
        hist_path = Path(row['histogram_path']) if row['histogram_path'] else \
            output_root / "histograms" / f"{slug_id}.npz"
        if not hist_path.exists():
            print(f"  SKIP {slug_id} — histogram not found at {hist_path}")
            continue
        hist_npz = np.load(str(hist_path))
        hist_vec = hist_npz['hist'].astype(np.float32)  # (2000,)
        hue_hist = hist_npz['hue_hist'].astype(np.float32)  # (36,)

        # Barcode PNG
        barcode_path = output_root / "barcodes" / f"{slug_id}.png"

        # Build colors list (hex + weight, sorted by weight desc)
        colors = [
            {"hex": c["hex"], "weight": round(c["weight"], 4)}
            for c in palette_data["colors"]
        ]

        film_entry = {
            "id": film_id,
            "title": title,
            "year": year,
            "slug": slugify(title, year),
            "frameCount": row['frame_count'] or 0,
            "barcode_path": str(barcode_path),
            "colors": colors,
            "similar_ids": [],  # filled after similarity computation
        }

        films.append(film_entry)
        histograms.append(hist_vec)
        print(f"  ✓  {title} ({year})  →  {film_entry['slug']}")

    if not films:
        print("No films exported.")
        sys.exit(1)

    # ── Cosine similarity ────────────────────────────────────────────────────
    print(f"\nComputing similarity matrix for {len(films)} films...")
    H = np.vstack(histograms)  # (N, 2000)
    sim = cosine_similarity(H)  # (N, N)

    for i, film in enumerate(films):
        row_sim = sim[i].copy()
        row_sim[i] = -1.0  # exclude self
        top = np.argsort(-row_sim)[:5]
        film['similar_ids'] = [films[j]['id'] for j in top]

    # ── Write export JSON ────────────────────────────────────────────────────
    out_path = script_dir / "cinechroma-export.json"
    out_path.write_text(json.dumps(films, indent=2))
    print(f"\nExported {len(films)} films → {out_path}")


if __name__ == "__main__":
    main()
