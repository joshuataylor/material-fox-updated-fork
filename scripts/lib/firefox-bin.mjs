// Cross-platform Firefox binary resolution for the dev/test tooling.
//
// A single literal path cannot be correct on every OS, e.g:
// 1. macOS via Firefox.app/Contents/MacOS/firefox
// 2. Linux via firefox/firefox
// 3. Windows via firefox.exe
//
// You can override via environment variable FF_<CHANNEL>:
//
//   1. $FF_<CHANNEL> (e.g. FF_NIGHTLY), if set and the path exists.
//   2. Otherwise search the channel install dir tmp/firefox/<channel> for the executable.
//
// To download firefox, use `mise run download-firefox`.
//
// Usage:
// node scripts/lib/firefox-bin.mjs --channel nightly

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");

// Nova (browser.nova.enabled) default per channel, mirroring each channel's own
// default: on for nightly (158+), off for beta/stable (156/155). Shared so the
// launcher and the headless harnesses agree.
export const NOVA_DEFAULT = { nightly: true, beta: false, stable: false };

export const CHANNELS = ["nightly", "beta", "stable"];

// The install dir for a channel: tmp/firefox/<channel> (gitignored).
export function channelDir(channel, { dest } = {}) {
    const root = dest ?? join(REPO, "tmp", "firefox");
    return join(root, channel);
}

// Depth-bounded search for the launchable executable under `dir`, ranked by how
// well a candidate matches this OS (mac bundle > plain firefox > anything named
// firefox*). Returns an absolute path or null.
function searchDir(dir, depth = 6) {
    if (depth < 0 || !existsSync(dir)) return null;
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    const subdirs = [];
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            // macOS: the target is <bundle>.app/Contents/MacOS/firefox.
            if (isMac && e.name.endsWith(".app")) {
                const bin = join(full, "Contents", "MacOS", "firefox");
                if (existsSync(bin)) return bin;
            }
            subdirs.push(full);
            continue;
        }
        if (isWin && e.name.toLowerCase() === "firefox.exe") return full;
        // Linux/mac plain binary: a regular file named exactly "firefox".
        if (!isWin && e.name === "firefox") {
            try {
                if (statSync(full).isFile()) return full;
            } catch {
                /* ignore */
            }
        }
    }
    for (const sub of subdirs) {
        const found = searchDir(sub, depth - 1);
        if (found) return found;
    }
    return null;
}

// Resolve the binary for a channel, returns null if not installed.
export function findBinary(channel, opts = {}) {
    const override = process.env[`FF_${channel.toUpperCase()}`];
    if (override && existsSync(override)) return override;
    return searchDir(channelDir(channel, opts));
}

// Like findBinary but throws a directive error when nothing is found.
export function resolveBinary(channel, opts = {}) {
    const bin = findBinary(channel, opts);
    if (!bin) {
        throw new Error(
            `No Firefox binary for channel "${channel}". Set $FF_${channel.toUpperCase()} ` +
                `or run: mise run download-firefox --channel ${channel}`,
        );
    }
    return bin;
}

// print the resolved path (stdout only), for `-b "$(...)"` shell capture.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf("--channel");
    const channel = i >= 0 ? argv[i + 1] : "nightly";
    if (!CHANNELS.includes(channel)) {
        console.error(
            `invalid channel: ${channel} (expected ${CHANNELS.join("|")})`,
        );
        process.exit(2);
    }
    try {
        process.stdout.write(resolveBinary(channel) + "\n");
    } catch (err) {
        console.error(String(err.message ?? err));
        process.exit(1);
    }
}
