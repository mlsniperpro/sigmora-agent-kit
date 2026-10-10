import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KIT_ROOT } from '../lib/config.js';

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: KIT_ROOT,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
const report = JSON.parse(stdout);
if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0].files)) {
  throw new Error('npm pack returned an unexpected report.');
}
const names = new Set(report[0].files.map((file) => file.path));
const required = [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.zcode-plugin/plugin.json',
  '.mcp.json',
  'bin/sigmora.js',
  'lib/cli.js',
  'lib/config.js',
  'lib/upload.js',
  'skills/sigmora-media/SKILL.md',
  'skills/sigmora-media/references/workflow-contract.md',
  'templates/opencode/opencode.json',
  'templates/codex/config.toml',
  'templates/deepseek/cordis.patch.yml',
  'skills/sigmora/SKILL.md',
  'skills/sigmora/scripts/sigmora.mjs',
  'LICENSE',
  'assets/icon.png',
  'assets/logo.png',
  'README.md',
  'package.json',
];
const missing = required.filter((path) => !names.has(path));
const forbidden = [...names].filter((path) => path.startsWith('test/') || path.endsWith('.bak') || /(?:^|\/)\.env(?:\.|$)/.test(path));
if (missing.length || forbidden.length) {
  if (missing.length) process.stderr.write(`Missing package files: ${missing.join(', ')}\n`);
  if (forbidden.length) process.stderr.write(`Forbidden package files: ${forbidden.join(', ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Package contains ${names.size} files (${report[0].size} bytes packed, ${report[0].unpackedSize} bytes unpacked).\n`);
}
