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
 * Convert CIE Lab color to hex string (#rrggbb).
 *
 * Pipeline: Lab → XYZ (D65 illuminant) → linear sRGB → gamma-corrected sRGB → hex
 *
 * Lab color space separates luminance (L) from chrominance (a, b),
 * making it perceptually uniform — small numeric differences correspond
 * to small perceived color differences. That's why cinechroma uses it
 * for analysis, but we need hex for CSS.
 */
function labToHex([L, a, b]) {
  // Step 1: Lab → XYZ
  // The forward transform uses the CIE standard formulas with D65 white point.
  // fy is derived from luminance L, then fx and fz from chrominance channels.
  let fy = (L + 16) / 116;
  let fx = a / 500 + fy;
  let fz = fy - b / 200;

  // Inverse of the cube-root compression used in Lab encoding.
  // Below the threshold (δ = 6/29 ≈ 0.20689), a linear segment is used instead.
  const delta = 6 / 29;
  const delta3 = delta * delta * delta; // ≈ 0.008856

  let xr = fx * fx * fx > delta3 ? fx * fx * fx : (fx - 16 / 116) / 7.787;
  let yr = fy * fy * fy > delta3 ? fy * fy * fy : (fy - 16 / 116) / 7.787;
  let zr = fz * fz * fz > delta3 ? fz * fz * fz : (fz - 16 / 116) / 7.787;

  // D65 standard illuminant (daylight, 6504K color temperature)
  let X = xr * 0.95047;
  let Y = yr * 1.0;
  let Z = zr * 1.08883;

  // Step 2: XYZ → linear sRGB
  // This matrix is the official sRGB specification (IEC 61966-2-1).
  // Each row converts XYZ tristimulus values to one RGB channel.
  let rLin = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let gLin = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let bLin = 0.0556434 * X + 0.2040259 * Y + 1.0572252 * Z;

  // Step 3: linear → gamma-corrected sRGB
  // The sRGB transfer function: gamma ≈ 2.4 with a linear toe near black.
  const gamma = (c) => {
    if (c <= 0.0031308) return 12.92 * c;
    return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };

  // Clamp to [0, 255] and convert to 2-digit hex
  const toHex = (c) => {
    const val = Math.round(Math.min(1, Math.max(0, gamma(c))) * 255);
    return val.toString(16).padStart(2, '0');
  };

  return `#${toHex(rLin)}${toHex(gLin)}${toHex(bLin)}`;
}

/* ── Folder name parser ────────────────────────────────────────────────── */

/**
 * Extract a clean movie title and year from torrent-style folder names.
 *
 * Handles formats like:
 *   "Blade Runner (1982) [BluRay] [1080p] [YTS.AM]"  → { title: "Blade Runner", year: 1982 }
 *   "Dune.2021.1080p.WEBRip.x264-RARBG"              → { title: "Dune", year: 2021 }
 *   "Barry.Lyndon.1975.CRITERION.1080p..."            → { title: "Barry Lyndon", year: 1975 }
 *   "12 Angry Men (1957) + Extras (1080p...)"         → { title: "12 Angry Men", year: 1957 }
 */
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
