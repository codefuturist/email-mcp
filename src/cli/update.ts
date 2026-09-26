/**
 * `email-mcp update` — self-update the compiled binary from GitHub Releases.
 *
 * Checks the latest release, and when it is newer downloads the matching
 * platform archive, verifies its sha256 against the release's checksums file
 * (plus a provenance attestation when the `gh` CLI is available), then
 * atomically swaps the running executable. Installs owned by a package
 * manager (npm, mise) or a dev checkout are pointed at their own upgrade
 * path instead of being overwritten.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { confirm, intro, log, note, outro, spinner as p_spinner } from '@clack/prompts';
import { xdg } from '../config/xdg.js';
import { PKG_VERSION } from '../version.js';
import { assertNotCancel, CancelledError } from './guard.js';
import { selfCommand } from './server-commands.js';

const execFileAsync = promisify(execFile);

const REPO = 'codefuturist/email-mcp';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const USAGE = `
Usage: email-mcp update [options]

Update the email-mcp binary to the latest GitHub release.

Options:
  --check   Only check for a newer version; exit code 1 means one is available
  --yes     Update without asking for confirmation (for scripts)

Only self-updates a compiled binary install. npm, mise, and dev-checkout
installs are pointed at their own upgrade command instead.
`.trim();

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Minimal semver ordering: numeric major.minor.patch, and any prerelease
 * ranks below its release (1.0.0-rc.1 < 1.0.0). Prerelease-vs-prerelease
 * falls back to string order — fine for "is the release newer than me".
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', ...pre] = v.replace(/^v/, '').split('-');
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre.join('-') };
  };
  const va = parse(a);
  const vb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (va.nums[i] ?? 0) - (vb.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  return va.pre < vb.pre ? -1 : va.pre > vb.pre ? 1 : 0;
}

/**
 * GoReleaser asset name for this platform. Contract (verified against the
 * live release): email-mcp_<ver>_<os>_<arch>[_musl].tar.gz, zip on windows,
 * Go-style arch names (x64 → amd64). windows-arm64 has no native build and
 * runs the amd64 one under emulation.
 */
export function pickAssetName(
  version: string,
  platform: string,
  arch: string,
  musl: boolean,
): string {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  if (!os) throw new Error(`No prebuilt binaries are published for platform "${platform}"`);
  let goArch = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (os === 'windows' && goArch === 'arm64') goArch = 'amd64';
  if (!goArch) throw new Error(`No prebuilt binaries are published for architecture "${arch}"`);
  const suffix = os === 'linux' && musl ? '_musl' : '';
  const ext = os === 'windows' ? 'zip' : 'tar.gz';
  return `email-mcp_${version}_${os}_${goArch}${suffix}.${ext}`;
}

/** Parse sha256sum-format lines (`<64 hex>  <filename>`) into name → hash. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(\S+)\s*$/i);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export type InstallKind =
  | { kind: 'binary'; target: string }
  | { kind: 'mise'; target: string }
  | { kind: 'npm' }
  | { kind: 'dev' };

/**
 * What kind of install is running, and (for binaries) what file to replace.
 * Reuses selfCommand()'s tri-state detection; the realpath catches binaries
 * that are symlinks into a mise install tree, which mise must keep owning.
 */
export function classifyInstall(
  execPath: string,
  entry: string | undefined,
  realExecPath: string,
): InstallKind {
  const command = selfCommand(execPath, entry);
  if (command === undefined) return { kind: 'dev' };
  if (command.length === 2) return { kind: 'npm' };
  const misePath = `${path.sep}mise${path.sep}installs${path.sep}`;
  if (realExecPath.includes(misePath) || execPath.includes(misePath)) {
    return { kind: 'mise', target: execPath };
  }
  return { kind: 'binary', target: execPath };
}

// ---------------------------------------------------------------------------
// Release lookup
// ---------------------------------------------------------------------------

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  assets: ReleaseAsset[];
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `email-mcp/${PKG_VERSION}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestRelease(): Promise<Release> {
  const res = await fetchWithTimeout(RELEASES_LATEST_URL, CHECK_TIMEOUT_MS);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const when = Number.isFinite(reset) ? ` (resets ${new Date(reset).toLocaleTimeString()})` : '';
    throw new Error(`GitHub API rate limit exceeded${when} — try again later`);
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${RELEASES_LATEST_URL}`);
  return (await res.json()) as Release;
}

/** Alpine has no glibc; elsewhere ldd identifies itself as musl when it is. */
async function isMuslLinux(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    await fs.access('/etc/alpine-release');
    return true;
  } catch {
    /* not alpine — fall through to ldd */
  }
  try {
    const { stdout, stderr } = await execFileAsync('ldd', ['--version']).catch(
      (err: Error & { stdout?: string; stderr?: string }) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      }),
    );
    return /musl/i.test(`${stdout}${stderr}`);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Download, verify, swap
// ---------------------------------------------------------------------------

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

async function downloadTo(
  url: string,
  dest: string,
  totalBytes: number,
  onProgress: (message: string) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': `email-mcp/${PKG_VERSION}` },
    });
    if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`);
    let received = 0;
    const counter = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        received += chunk.length;
        onProgress(`Downloading… ${mb(received)} / ${mb(totalBytes)} MB`);
        yield chunk;
      }
    };
    await pipeline(
      counter(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)),
      createWriteStream(dest),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(file);
  try {
    await pipeline(handle.createReadStream(), hash);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Provenance check on top of the checksum: attestations are only reachable
 * through the gh CLI, so absence of gh downgrades to a notice — but a
 * present gh that FAILS verification is a hard stop.
 */
async function verifyAttestation(archive: string): Promise<'verified' | 'skipped'> {
  try {
    await execFileAsync('gh', ['attestation', 'verify', archive, '--repo', REPO]);
    return 'verified';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'skipped';
    throw new Error(
      `Provenance attestation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Atomic-as-possible swap. The staged copy lives next to the target so the
 * final rename never crosses filesystems. POSIX renames straight over the
 * running executable (the old inode stays alive for the running process);
 * Windows cannot, so the running exe is moved aside first and restored on
 * failure. A stale `.old` from a previous update is cleaned up best-effort.
 */
async function swapBinary(extracted: string, target: string): Promise<void> {
  const staged = path.join(path.dirname(target), `.${path.basename(target)}.new-${process.pid}`);
  await fs.copyFile(extracted, staged);
  try {
    await fs.chmod(staged, 0o755);
    if (process.platform === 'win32') {
      const old = `${target}.old`;
      await fs.rm(old, { force: true });
      await fs.rename(target, old);
      try {
        await fs.rename(staged, target);
      } catch (err) {
        await fs.rename(old, target); // roll back so the install stays usable
        throw err;
      }
    } else {
      await fs.rename(staged, target);
    }
  } catch (err) {
    await fs.rm(staged, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface UpdateOptions {
  check: boolean;
  yes: boolean;
  help: boolean;
}

export function parseUpdateArgs(args: string[]): UpdateOptions {
  const opts: UpdateOptions = { check: false, yes: false, help: false };
  for (const arg of args) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.log(`${USAGE}\n`);
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function upgradeHint(install: InstallKind): string {
  switch (install.kind) {
    case 'npm':
      return 'This copy is managed by a package manager — update it with:\n  npm install -g @codefuturist/email-mcp@latest';
    case 'mise':
      return 'This binary is managed by mise — update it with:\n  mise upgrade email-mcp';
    case 'dev':
      return 'This is a development checkout — update it with:\n  git pull';
    default:
      return '';
  }
}

export default async function runUpdateCommand(args: string[]): Promise<void> {
  const opts = parseUpdateArgs(args);
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  try {
    intro('email-mcp update');

    const spinner = p_spinner();
    spinner.start('Checking for updates…');
    let release: Release;
    try {
      release = await fetchLatestRelease();
    } catch (err) {
      spinner.stop('Check failed ❌');
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const latest = release.tag_name.replace(/^v/, '');
    if (compareVersions(PKG_VERSION, latest) >= 0) {
      spinner.stop(`Already up to date (v${PKG_VERSION}) ✅`);
      outro('Nothing to do.');
      return;
    }
    spinner.stop(`Update available: v${PKG_VERSION} → v${latest}`);

    if (opts.check) {
      log.info(`Run \`email-mcp update\` to install v${latest}.`);
      process.exitCode = 1; // documented: 1 = an update is available
      return;
    }

    const realExecPath = await fs.realpath(process.execPath).catch(() => process.execPath);
    const install = classifyInstall(process.execPath, process.argv[1], realExecPath);
    if (install.kind !== 'binary') {
      log.warn(upgradeHint(install));
      process.exitCode = 1;
      return;
    }

    const notes = (release.body ?? '').trim().split('\n').slice(0, 12).join('\n');
    if (notes) note(notes, release.name ?? `v${latest}`);
    log.message(release.html_url);

    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        log.error('Non-interactive terminal — pass --yes to update without confirmation.');
        process.exitCode = 1;
        return;
      }
      const proceed = await confirm({ message: `Update to v${latest}?`, initialValue: true });
      assertNotCancel(proceed);
      if (!proceed) {
        outro('Cancelled.');
        return;
      }
    }

    const assetName = pickAssetName(latest, process.platform, process.arch, await isMuslLinux());
    const asset = release.assets.find((a) => a.name === assetName);
    const checksumAsset = release.assets.find((a) => a.name.endsWith('_checksums.txt'));
    if (!asset || !checksumAsset) {
      log.error(
        `❌ Release v${latest} has no asset "${assetName}" for this platform.\n` +
          `   Download manually: ${release.html_url}`,
      );
      process.exitCode = 1;
      return;
    }

    const staging = path.join(xdg.cache, 'update');
    await fs.mkdir(staging, { recursive: true });
    const archive = path.join(staging, asset.name);

    try {
      const dl = p_spinner();
      dl.start(`Downloading ${asset.name} (${mb(asset.size)} MB)…`);
      await downloadTo(asset.browser_download_url, archive, asset.size, (m) => dl.message(m));
      dl.stop(`Downloaded ${asset.name} ✅`);

      const verify = p_spinner();
      verify.start('Verifying…');
      const sums = await fetchWithTimeout(checksumAsset.browser_download_url, CHECK_TIMEOUT_MS);
      if (!sums.ok) throw new Error(`Could not fetch checksums (HTTP ${sums.status})`);
      const expected = parseChecksums(await sums.text()).get(asset.name);
      if (!expected) throw new Error(`No checksum published for ${asset.name}`);
      const actual = await sha256File(archive);
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
      }
      const attestation = await verifyAttestation(archive);
      verify.stop(
        attestation === 'verified'
          ? 'Checksum + provenance attestation verified ✅'
          : 'Checksum verified ✅ (attestation skipped — gh CLI not installed)',
      );

      const binaryName = process.platform === 'win32' ? 'email-mcp.exe' : 'email-mcp';
      // bsdtar (macOS, Windows 10+) and GNU tar both auto-detect tar.gz and
      // zip with plain -xf; extract only the binary member.
      await execFileAsync('tar', ['-xf', archive, '-C', staging, binaryName]);

      const swap = p_spinner();
      swap.start(`Installing to ${install.target}…`);
      try {
        await swapBinary(path.join(staging, binaryName), install.target);
      } catch (err) {
        swap.stop('Install failed ❌');
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          log.error(
            `No permission to replace ${install.target}.\n   Re-run with: sudo email-mcp update`,
          );
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      swap.stop(`Installed v${latest} → ${install.target} ✅`);
      outro(`✅ Updated v${PKG_VERSION} → v${latest} — restart any running server to pick it up.`);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  } catch (err) {
    if (err instanceof CancelledError) return;
    throw err;
  }
}
