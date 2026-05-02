/**
 * build-data.mjs — Pre-build script for cinechroma registry site (v3).
 *
 * Reads scripts/cinechroma-export.json (produced by scripts/export.py),
 * resizes barcode PNGs to a normalised 1200×200 strip, copies them into
 * public/movies/<slug>/, and writes src/data/movies.json.
 *
 * Run BEFORE astro build:
 *   python scripts/export.py <cinechroma_output_dir>
 *   node scripts/build-data.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import sharp from 'sharp';

/* ── Paths ─────────────────────────────────────────────────────────────── */
const ROOT = resolve(import.meta.dirname, '..');
const EXPORT_JSON = join(ROOT, 'scripts', 'cinechroma-export.json');
const DATA_OUT = join(ROOT, 'src', 'data');
const PUBLIC_MOVIES = join(ROOT, 'public', 'movies');

/** Normalised strip width — every barcode is stretched/compressed to this. */
const STRIP_W = 1200;
const STRIP_H = 200;

/* ── Main build ────────────────────────────────────────────────────────── */

console.log('\ncinechronoma — building movie data (v3)...\n');

if (!existsSync(EXPORT_JSON)) {
  console.error(`ERROR: ${EXPORT_JSON} not found.`);
  console.error('Run:  python scripts/export.py <cinechroma_output_dir>  first.');
  process.exit(1);
}

const exportData = JSON.parse(readFileSync(EXPORT_JSON, 'utf-8'));

// Build id → slug map for resolving similar_ids later
const idToSlug = {};
for (const film of exportData) {
  idToSlug[film.id] = film.slug;
}

// Ensure output directories exist
mkdirSync(DATA_OUT, { recursive: true });
mkdirSync(PUBLIC_MOVIES, { recursive: true });

const movies = [];

for (const film of exportData) {
  const { title, year, slug, frameCount, barcode_path, colors, similar_ids } = film;

  // ── Resize + copy barcode strip ────────────────────────────────────────
  const publicDir = join(PUBLIC_MOVIES, slug);
  mkdirSync(publicDir, { recursive: true });

  const destStrip = join(publicDir, 'strip.png');
  if (existsSync(barcode_path)) {
    try {
      await sharp(barcode_path)
        .resize(STRIP_W, STRIP_H, { fit: 'fill' })
        .toFile(destStrip);
    } catch (err) {
      console.warn(`  WARN: could not resize barcode for ${slug}: ${err.message}`);
    }
  } else {
    console.warn(`  WARN: barcode not found at ${barcode_path}`);
  }

  // ── Resolve similar ids → slugs ─────────────────────────────────────────
  const similar = (similar_ids || [])
    .map((id) => idToSlug[id])
    .filter(Boolean)
    .slice(0, 3);

  const movie = {
    title,
    year,
    slug,
    frameCount,
    colors,   // [{hex, weight}, ...] × 16, sorted by weight desc
    similar,  // [slug, slug, slug]
  };

  movies.push(movie);
  console.log(`  ✓  ${title} (${year}) — ${frameCount} frames → /movies/${slug}/`);
}

// Sort by year (newest first), then alphabetically
movies.sort((a, b) => {
  if ((b.year ?? 0) !== (a.year ?? 0)) return (b.year ?? 0) - (a.year ?? 0);
  return a.title.localeCompare(b.title);
});

// Write combined data file
const outPath = join(DATA_OUT, 'movies.json');
writeFileSync(outPath, JSON.stringify(movies, null, 2));

console.log(`\nBuilt data for ${movies.length} films → src/data/movies.json\n`);
