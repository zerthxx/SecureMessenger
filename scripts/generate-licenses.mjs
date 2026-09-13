#!/usr/bin/env node
/**
 * Generates src/data/licenses.json — the data behind Settings → Legal &
 * licenses — from the packages this app actually ships:
 *
 *   - JavaScript: every runtime dependency in package.json, with the
 *     version, SPDX license and repository from its installed package.json
 *     and the text of any LICENSE/COPYING file it publishes.
 *   - Native: the direct Rust dependencies of the mls-core encryption
 *     module (modules/mls-core/rust), resolved with `cargo metadata`, with
 *     each crate's declared license and license files.
 *
 * Nothing here is written by hand, so the screen can never list a license
 * or dependency the project doesn't use. Identical license texts are stored
 * once. Re-run after changing dependencies:  npm run licenses
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_FILE = /^(licen[sc]e|copying)([-._][a-z0-9-]+)?(\.(md|markdown|txt))?$/i;

const licenseTexts = {};

function addLicenseText(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const id = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  licenseTexts[id] = normalized;
  return id;
}

function licenseFilesIn(dir) {
  try {
    return readdirSync(dir).filter((file) => LICENSE_FILE.test(file)).sort();
  } catch {
    return [];
  }
}

function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@github\.com/, 'https://github.com')
    .replace(/\.git$/, '');
}

function javascriptPackages() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  return Object.keys(manifest.dependencies ?? {})
    .sort()
    .map((name) => {
      const dir = path.join(root, 'node_modules', name);
      const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const license =
        typeof meta.license === 'string'
          ? meta.license
          : Array.isArray(meta.licenses)
            ? meta.licenses.map((entry) => entry.type).join(' OR ')
            : null;
      return {
        name,
        version: meta.version,
        license: license ?? 'Not declared',
        repository: repositoryUrl(meta.repository),
        licenseTextIds: licenseFilesIn(dir).map((file) => addLicenseText(readFileSync(path.join(dir, file), 'utf8'))),
      };
    });
}

function nativePackages() {
  const manifestPath = path.join(root, 'modules', 'mls-core', 'rust', 'Cargo.toml');
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--offline', '--manifest-path', manifestPath], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const rootNode = metadata.resolve.nodes.find((node) => node.id === metadata.resolve.root);
  if (!rootNode) throw new Error('cargo metadata did not resolve the mls-core package');

  return rootNode.deps
    .filter((dep) => dep.dep_kinds.some((kind) => kind.kind === null)) // normal (shipped) dependencies only
    .map((dep) => packagesById.get(dep.pkg))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pkg) => {
      const dir = path.dirname(pkg.manifest_path);
      const files = pkg.license_file ? [pkg.license_file] : licenseFilesIn(dir);
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? 'Not declared',
        repository: repositoryUrl(pkg.repository),
        licenseTextIds: files.map((file) => addLicenseText(readFileSync(path.join(dir, file), 'utf8'))),
      };
    });
}

const javascript = javascriptPackages();
const native = nativePackages();
const output = {
  generatedBy: 'scripts/generate-licenses.mjs — do not edit by hand',
  javascript,
  native,
  licenseTexts,
};

mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
writeFileSync(path.join(root, 'src', 'data', 'licenses.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `licenses.json: ${javascript.length} JavaScript packages, ${native.length} native crates, ${Object.keys(licenseTexts).length} distinct license texts`,
);
