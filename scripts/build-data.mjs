/**
 * build-data.mjs — Pre-build script for cinechroma registry site.
 *
 * Runs BEFORE `astro build`. For every movie folder in movie_list/:
 *   1. Parses the messy torrent-style folder name → clean title + year
 *   2. Reads analysis.json → extracts movie-level palettes (Lab color space)
 *   3. Converts Lab → hex colors for CSS rendering
 *   4. Copies strip.png and palette.png into public/movies/<slug>/
 *   5. Writes a combined src/data/movies.json with all movie metadata
 *
 * The Astro pages then import movies.json at build time to generate
 * the static site — no runtime data fetching needed.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';

/* ── Paths ─────────────────────────────────────────────────────────────── */
const ROOT = resolve(import.meta.dirname, '..');
const MOVIE_LIST = join(ROOT, 'movie_list');
const DATA_OUT = join(ROOT, 'src', 'data');
const PUBLIC_MOVIES = join(ROOT, 'public', 'movies');

/* ── Lab → Hex conversion ─────────────────────────────────────────────── */

/**
 * Convert CIE Lab color to hex string (#rrggbb) using skimage.color.lab2rgb math.
 */
function labToHex([L, a, b]) {
  // 1. Lab to XYZ
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;

  // skimage uses delta = 6/29
  const delta = 6 / 29;
  const xyz = [x, y, z].map((v) => {
    return (v > delta)
      ? v * v * v
      : 3 * delta * delta * (v - 4 / 29);
  });

  // Reference white D65
  let X = xyz[0] * 0.95047;
  let Y = xyz[1] * 1.0;
  let Z = xyz[2] * 1.08883;

  // 2. XYZ to linear RGB (skimage order)
  let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let b_ = X * 0.0557 + Y * -0.2040 + Z * 1.0570;

  // 3. Linear RGB to sRGB
  function gammaCorrect(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }
  r = gammaCorrect(r);
  g = gammaCorrect(g);
  b_ = gammaCorrect(b_);

  // 4. Clamp and convert to hex
  function toHex(v) {
    return Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b_)}`;
}

  // --- Folder name parser and slugify (move out of labToHex) ---
  function parseMovieFolder(folderName) {
    let title, year;

    // Strategy 1: Look for "(YYYY)" pattern — most common format
    const parenMatch = folderName.match(/^(.+?)\s*\((\d{4})\)/);
    if (parenMatch) {
      title = parenMatch[1].trim();
      year = parseInt(parenMatch[2], 10);
    } else {
      // Strategy 2: Dot-separated format (e.g. "Dune.2021.1080p.WEBRip")
      // Split by dots or spaces, find the first 4-digit number that looks like a year.
      // Everything BEFORE the year is the title; everything after is codec/resolution junk.
      const parts = folderName.split(/[.\s]+/);
      let yearIdx = -1;
      for (let i = 0; i < parts.length; i++) {
        const num = parseInt(parts[i], 10);
        if (num >= 1900 && num <= 2030 && parts[i].length === 4) {
          yearIdx = i;
          year = num;
          break;
        }
      }
      if (yearIdx > 0) {
        // Everything before the year is the title (dots/spaces → spaces)
        title = parts.slice(0, yearIdx).join(' ');
      } else {
        // Fallback: use the whole name, try to extract year anywhere
        const anyYear = folderName.match(/(\d{4})/);
        year = anyYear ? parseInt(anyYear[1], 10) : null;
        title = folderName.replace(/[\[\(].*$/g, '').trim();
      }
    }

    // Clean up title edge cases
    title = title.replace(/\s+/g, ' ').trim();

    return { title, year };
  }



/**
 * Generate a URL-safe slug from movie title and year.
 * "Blade Runner" + 1982 → "blade-runner-1982"
 */
function slugify(title, year) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // strip special chars
    .replace(/\s+/g, '-')          // spaces → hyphens
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-|-$/g, '');        // trim leading/trailing hyphens
  return year ? `${base}-${year}` : base;
}

/* ── Main build ────────────────────────────────────────────────────────── */

console.log('\n🎬 cinechroma — building movie data...\n');

// Ensure output directories exist
mkdirSync(DATA_OUT, { recursive: true });
mkdirSync(PUBLIC_MOVIES, { recursive: true });

// Read all movie directories
const folders = readdirSync(MOVIE_LIST).filter((name) => {
  const fullPath = join(MOVIE_LIST, name);
  return statSync(fullPath).isDirectory();
});

const movies = [];

for (const folder of folders) {
  const folderPath = join(MOVIE_LIST, folder);
  const analysisPath = join(folderPath, 'analysis.json');
  const stripPath = join(folderPath, 'strip.png');
  const palettePath = join(folderPath, 'palette.png');

  // Skip folders without analysis data
  if (!existsSync(analysisPath)) {
    console.log(`  ⏭  Skipping "${folder}" — no analysis.json`);
    continue;
  }

  // Parse folder name → title + year
  const { title, year } = parseMovieFolder(folder);
  const slug = slugify(title, year);

  // Read analysis data
  const analysis = JSON.parse(readFileSync(analysisPath, 'utf-8'));
  const frameCount = analysis.frames ? analysis.frames.length : 0;

  // Convert Lab palettes → hex colors
  const palettes = {};
  if (analysis.palettes) {
    for (const [band, colors] of Object.entries(analysis.palettes)) {
      palettes[band] = colors.map(labToHex);
    }
  }

  // Copy images to public/movies/<slug>/
  const publicDir = join(PUBLIC_MOVIES, slug);
  mkdirSync(publicDir, { recursive: true });

  if (existsSync(stripPath)) {
    copyFileSync(stripPath, join(publicDir, 'strip.png'));
  }
  if (existsSync(palettePath)) {
    copyFileSync(palettePath, join(publicDir, 'palette.png'));
  }

  const movie = {
    title,
    year,
    slug,
    frameCount,
    palettes,
  };

  movies.push(movie);
  console.log(`  ✓  ${title} (${year}) — ${frameCount} frames → /movies/${slug}/`);
}

// Sort by year (newest first), then alphabetically within same year
movies.sort((a, b) => {
  if (b.year !== a.year) return b.year - a.year;
  return a.title.localeCompare(b.title);
});

// Write combined data file
const outPath = join(DATA_OUT, 'movies.json');
writeFileSync(outPath, JSON.stringify(movies, null, 2));

console.log(`\n✅ Built data for ${movies.length} movies → src/data/movies.json\n`);
