#!/usr/bin/env node
/**
 * Builds the ZIP that is uploaded to OpenAI for the Sigmora ChatGPT app:
 * `dist/sigmora-chatgpt.zip`.
 *
 * Zero dependencies and no `zlib.crc32` (it needs Node 20.15 / 22.2, and the
 * kit declares `engines >=20`): the archive is a plain stored ZIP with an
 * in-script CRC-32 table and a fixed timestamp, so the same tree always gives
 * the same bytes.
 *
 * What goes in is an explicit allowlist (plugin.json, mcp.json, assets/**, the
 * seven playbooks and the sigmora-media skill). The `sigmora` REST skill is
 * never packaged: it drives Sigma turns, and the ChatGPT door is host-brain
 * with no inference of its own. There is no `.app.json` in this format.
 *
 * Usage: node scripts/package-chatgpt.mjs [--out <dir>]
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ZIP_NAME = 'sigmora-chatgpt.zip';

/** Files at the plugin root. */
const ROOT_FILES = ['plugin.json', 'mcp.json'];
/** Directories packaged whole. */
const DIRECTORIES = ['assets'];
/** Skill directories: the playbooks (PLAYBOOK_IDS in apps/web) plus the media skill. */
export const CHATGPT_SKILLS = [
  'short-form-script',
  'hook-adaptation',
  'platform-copy',
  'caption-style',
  'repurpose-long-video',
  'review-first-edit',
  'weekly-content-plan',
  'sigmora-media',
];
/** Never packaged, whatever the allowlist says later. */
const EXCLUDED_SKILLS = new Set(['sigmora']);

function walk(relativeDir) {
  const absolute = path.join(ROOT, relativeDir);
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) return walk(child);
      if (entry.isFile() && entry.name !== '.DS_Store') return [child];
      return [];
    });
}

/** The archive paths, sorted, relative to the plugin root. */
export function chatgptPackageFiles() {
  for (const skill of CHATGPT_SKILLS) {
    if (EXCLUDED_SKILLS.has(skill)) throw new Error(`skills/${skill} must not ship in the ChatGPT package`);
  }
  const files = [
    ...ROOT_FILES,
    ...DIRECTORIES.flatMap((dir) => walk(dir)),
    ...CHATGPT_SKILLS.flatMap((skill) => {
      if (!existsSync(path.join(ROOT, 'skills', skill, 'SKILL.md'))) throw new Error(`skills/${skill}/SKILL.md is missing`);
      return walk(`skills/${skill}`);
    }),
  ];
  for (const file of files) {
    if (path.basename(file).endsWith('.app.json')) throw new Error(`${file}: the ChatGPT package has no .app.json`);
  }
  return [...new Set(files)].sort();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00, the DOS epoch: a fixed stamp keeps the archive reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A stored (uncompressed) ZIP of `entries` ({ name, data }). */
export function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
}

/** Writes the ZIP into `outDir` and returns its path and file list. */
export function packageChatgpt(outDir = path.join(ROOT, 'dist')) {
  const manifest = readJson('plugin.json');
  const pkg = readJson('package.json');
  if (manifest.version !== pkg.version) {
    throw new Error(`plugin.json version ${manifest.version} must equal package.json version ${pkg.version}`);
  }
  const files = chatgptPackageFiles();
  const zip = storedZip(files.map((name) => ({ name, data: readFileSync(path.join(ROOT, name)) })));
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, ZIP_NAME);
  writeFileSync(out, zip);
  return { out, files, version: manifest.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  const outDir = flag >= 0 && process.argv[flag + 1] ? path.resolve(process.argv[flag + 1]) : undefined;
  try {
    const { out, files, version } = packageChatgpt(outDir);
    const size = statSync(out).size;
    process.stdout.write(`Wrote ${out} (sigmora ${version}, ${files.length} files, ${size} bytes)\n`);
  } catch (error) {
    process.stderr.write(`package-chatgpt: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
