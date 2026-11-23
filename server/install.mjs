// One-click setup for Claude Desktop: add ecosys to claude_desktop_config.json as a local (stdio)
// MCP server that runs mcp/stdio-bridge.mjs with this computer's Node. A timestamped .bak copy is
// written first (the installer keeps its own 5 newest and never touches other files) and every
// other key in the file is kept exactly: whatever its name (also "prototype" or "constructor"),
// numbers as written, and a config that is a link stays one. No shell commands are run.
import { existsSync, readFileSync, copyFileSync, readdirSync, statSync, lstatSync, realpathSync, openSync, ftruncateSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { atomicWrite, isPlainObject, pruneDir, removeFile, stamp, STAMP_RE_SOURCE } from './util.mjs';

export const SERVER_KEY = 'ecosys';
/** How many of its own backups the installer keeps next to each config file. */
export const KEEP_BACKUPS = 5;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Exactly the names of the backups this installer writes (`<config>.<stamp()>.bak`): never a user's own files. */
export const ownBackupPattern = (configPath) => new RegExp(`^${escapeRe(basename(configPath))}\\.${STAMP_RE_SOURCE}\\.bak$`);

/** File-system errors that mean "read-only, in use by another program, or not writable for this user". */
const LOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EROFS']);

/** Candidate config files for this OS, most likely first. */
export function claudeDesktopConfigPaths({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const file = 'claude_desktop_config.json';
  if (platform === 'win32') {
    const out = [];
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    out.push(join(appData, 'Claude', file));
    // Microsoft Store (MSIX) builds may read a virtualized copy instead; update it too when present.
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    try {
      for (const pkg of readdirSync(join(local, 'Packages'))) {
        if (!/^Claude_/i.test(pkg)) continue;
        const p = join(local, 'Packages', pkg, 'LocalCache', 'Roaming', 'Claude', file);
        if (existsSync(p)) out.push(p);
      }
    } catch {}
    return out;
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Claude', file)];
  return [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', file)];
}

export class InstallError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A file-system error while handling `path`, as an InstallError the user can act on. */
function fsProblem(err, path, doing) {
  if (err instanceof InstallError || typeof err?.code !== 'string') return err;
  if (LOCKED_CODES.has(err.code)) {
    return new InstallError(
      `Claude Desktop's settings file could not be ${doing}: it is read-only, in use by another program, or not writable for this user (${path}). Make sure the file is not read-only, quit Claude Desktop, then try again.`,
      409,
    );
  }
  return new InstallError(`Claude Desktop's settings file could not be ${doing} (${err.code}): ${path}.`, 500);
}

/**
 * Claude Desktop's settings as written. A plain JSON.parse (never one that drops keys): its objects
 * get every key as their own property, "__proto__" included, so spreading them pollutes nothing and
 * only mcpServers.ecosys is ever assigned. A number JSON can't hold exactly (a 20-digit id) is kept
 * as its own text where Node can (JSON.rawJSON), so writing the file back doesn't round it.
 */
export function parseConfig(text) {
  if (typeof JSON.rawJSON !== 'function') return JSON.parse(text);
  return JSON.parse(text, (_k, v, ctx) => (typeof v === 'number' && typeof ctx?.source === 'string' && JSON.stringify(v) !== ctx.source ? JSON.rawJSON(ctx.source) : v));
}

/** `config` without mcpServers.ecosys (and without an mcpServers that only held it), as JSON. */
function withoutEcosys(config, hadServers) {
  const out = { ...config };
  if (isPlainObject(out.mcpServers)) {
    const { [SERVER_KEY]: _ecosys, ...rest } = out.mcpServers;
    if (hadServers) out.mcpServers = rest;
    else delete out.mcpServers;
  }
  return JSON.stringify(out);
}

/** Write over `path` in place, so every hard link to it sees the change (the .bak is the safety net). */
function writeInPlace(path, text) {
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The mcpServers entry for ecosys. */
export function bridgeEntry({ nodePath, bridgePath, clientId, dataDir = null }) {
  const args = [bridgePath, '--client', clientId];
  if (dataDir) args.push('--data', dataDir);
  return { command: nodePath, args };
}

/**
 * Merge the ecosys entry into one config file. Returns {path, backup|null, created}.
 * A file it cannot read or replace (read-only, in use) is an InstallError and is left exactly as it
 * was, with no backup or temp file left behind. Old backups are pruned only after a successful
 * write, and only the installer's own (see ownBackupPattern).
 */
export function mergeConfig(path, entry) {
  const dir = dirname(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new InstallError(`Claude Desktop does not seem to be installed for this user (no folder at ${dir}). Install it from claude.ai/download, open it once, then try again.`, 404);
  }
  let config = {};
  let backup = null;
  let text = '';
  const created = !existsSync(path);
  if (!created) {
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw fsProblem(err, path, 'read');
    }
    const body = text.replace(/^﻿/, '');
    if (body.trim()) {
      try {
        config = parseConfig(body);
      } catch {
        throw new InstallError(`Claude Desktop's settings file is not valid JSON, so it was left untouched: ${path}. Fix or remove it, then try again.`, 422);
      }
      if (!isPlainObject(config)) throw new InstallError(`Claude Desktop's settings file has an unexpected shape, so it was left untouched: ${path}.`, 422);
      if (config.mcpServers !== undefined && !isPlainObject(config.mcpServers)) {
        throw new InstallError(`"mcpServers" in Claude Desktop's settings file is not an object, so the file was left untouched: ${path}. Fix it, then try again.`, 422);
      }
    }
  }
  const hadServers = isPlainObject(config.mcpServers);
  const next = { ...config, mcpServers: { ...(hadServers ? config.mcpServers : {}), [SERVER_KEY]: entry } };
  const out = JSON.stringify(next, null, 2) + '\n';
  // Only mcpServers.ecosys may differ from what the file said; anything else would be the installer
  // changing the user's settings, so the file is left as it is.
  let same = false;
  try {
    same = withoutEcosys(parseConfig(out), hadServers) === withoutEcosys(config, hadServers);
  } catch {}
  if (!same) throw new InstallError(`Claude Desktop's settings file holds something the installer can't write back exactly, so it was left untouched: ${path}. Add ecosys by hand (Connect AI shows the entry), or remove the odd part, then try again.`, 422);
  if (!created) {
    backup = `${path}.${stamp()}.bak`;
    try {
      copyFileSync(path, backup);
    } catch (err) {
      removeFile(backup);
      throw fsProblem(err, path, 'backed up');
    }
  }
  // A config that is a link stays one: a symbolic link keeps pointing at its file, which is replaced
  // (atomically, next to it); a file with more than one hard link is written in place.
  let target = path;
  let link = null;
  try {
    if (!created && lstatSync(path).isSymbolicLink()) {
      target = realpathSync(path);
      link = 'symbolic';
    }
    if (!created && statSync(target).nlink > 1) link = 'hard';
  } catch {}
  try {
    if (link === 'hard') {
      try {
        writeInPlace(target, out);
      } catch (err) {
        try {
          writeInPlace(target, text); // put back what it said
        } catch {}
        throw err;
      }
    } else atomicWrite(target, out);
  } catch (err) {
    if (backup) removeFile(backup); // nothing changed, so the copy just made is not needed
    throw fsProblem(err, path, 'changed');
  }
  if (backup) pruneDir(dir, ownBackupPattern(path), KEEP_BACKUPS);
  return { path, backup, created, ...(link ? { link } : {}) };
}

/**
 * Install into every Claude Desktop config found for this OS (the primary path must exist as a folder).
 * Returns {ok:true, path, paths, backups}.
 */
export function installClaudeDesktop({ nodePath, bridgePath, clientId, dataDir = null, paths = claudeDesktopConfigPaths() }) {
  if (!paths.length) throw new InstallError('Could not work out where Claude Desktop keeps its settings on this system.', 500);
  const entry = bridgeEntry({ nodePath, bridgePath, clientId, dataDir });
  const results = [];
  for (const [i, p] of paths.entries()) {
    try {
      results.push(mergeConfig(p, entry));
    } catch (err) {
      if (i === 0) throw err;
    }
  }
  return { ok: true, path: results[0].path, paths: results.map((r) => r.path), backups: results.map((r) => r.backup).filter(Boolean), entry };
}
