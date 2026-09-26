#!/usr/bin/env node
// Fetch a real Firefox build into tmp/firefox and print the launchable binary

import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBinary } from "./lib/firefox-bin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const log = (...a) => console.error(...a);
const die = (m) => {
    console.error(`error: ${m}`);
    process.exit(1);
};

const argv = process.argv.slice(2);
const optOf = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n) => argv.includes(`--${n}`);

const channelOpt = optOf("channel");
const buildOpt = optOf("build");
const dest = optOf("dest") || join(REPO, "tmp", "firefox");
const force = has("force");

const ALLOWED = ["nightly", "beta", "devedition", "stable", "esr"];
const DEFAULT_CHANNELS = ["nightly", "beta", "stable"];
const platform =
    process.platform === "darwin"
        ? "mac"
        : process.platform === "win32"
          ? "windows"
          : "linux";

if (channelOpt && buildOpt) die("--channel and --build are mutually exclusive");
if (channelOpt && !ALLOWED.includes(channelOpt))
    die(`invalid channel: ${channelOpt} (expected ${ALLOWED.join("|")})`);
mkdirSync(dest, { recursive: true });

// Depth-bounded search for a file by exact name under `dir`.
function findFile(dir, name, depth = 6) {
    if (depth < 0 || !existsSync(dir)) return null;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    const subdirs = [];
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) subdirs.push(full);
        else if (e.name === name) return full;
    }
    for (const s of subdirs) {
        const f = findFile(s, name, depth - 1);
        if (f) return f;
    }
    return null;
}

// A key (Version | BuildID) from a channel's installed application.ini, or "".
function iniValue(channel, key) {
    const ini = findFile(join(dest, channel), "application.ini");
    if (!ini) return "";
    for (const line of readFileSync(ini, "utf8").split(/\r?\n/)) {
        const m = line.match(new RegExp(`^${key}=(.*)$`));
        if (m) return m[1].trim();
    }
    return "";
}

const identityPath = (ch) => join(dest, ch, ".identity");
const installedIdentity = (ch) =>
    existsSync(identityPath(ch))
        ? readFileSync(identityPath(ch), "utf8").trim()
        : "";

// Mozilla product-details, fetched at most once.
let productDetails = null;
let productDetailsTried = false;

async function fetchProductDetails() {
    if (productDetailsTried) return productDetails;
    productDetailsTried = true;
    try {
        const r = await fetch(
            "https://product-details.mozilla.org/1.0/firefox_versions.json",
        );
        if (r.ok) productDetails = await r.json();
    } catch {
        /* offline -- caller downloads anyway */
    }
    return productDetails;
}

// The archive filename platform token for the nightly buildID probe.
const nightlyToken = () =>
    platform === "mac"
        ? "mac"
        : platform === "windows"
          ? "win64"
          : "linux-x86_64";

// Latest published identity for a channel.
// "" on any failure (offline / API change).
async function latestIdentity(ch) {
    const pd = await fetchProductDetails();
    if (!pd) return "";
    if (ch === "stable")
        return pd.LATEST_FIREFOX_VERSION
            ? `version:${pd.LATEST_FIREFOX_VERSION}`
            : "";
    if (ch === "beta")
        return pd.LATEST_FIREFOX_DEVEL_VERSION
            ? `version:${pd.LATEST_FIREFOX_DEVEL_VERSION}`
            : "";
    if (ch === "nightly") {
        const ver = pd.FIREFOX_NIGHTLY;
        if (!ver) return "";
        try {
            const r = await fetch(
                `https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/firefox-${ver}.en-US.${nightlyToken()}.txt`,
            );
            if (!r.ok) return "";
            const bid = (await r.text()).split(/\r?\n/)[0].replace(/\D/g, "");
            return bid ? `buildid:${bid}` : "";
        } catch {
            return "";
        }
    }
    return "";
}

// Download the latest build of one channel unless it is already current.
async function downloadOneLatest(channel) {
    if (!ALLOWED.includes(channel))
        die(`invalid channel: ${channel} (expected ${ALLOWED.join("|")})`);

    if (!force) {
        const installed = installedIdentity(channel);
        const latest = await latestIdentity(channel);
        if (installed && installed === latest) {
            const bin = findBinary(channel, { dest });
            if (bin && existsSync(bin)) {
                log(`${channel}: unchanged (${installed.split(":")[1]})`);
                process.stdout.write(bin + "\n");
                return;
            }
        }
        if (!latest)
            log(
                `${channel}: could not resolve latest build (offline?); downloading anyway`,
            );
    }

    // One build per channel under <dest>/<channel>; wipe first so firefox-bin.mjs
    // resolution stays deterministic. The extracted layout is left as
    // @puppeteer/browsers produces it (version-stamped, per-OS); firefox-bin.mjs
    // globs it.
    const outdir = join(dest, channel);
    log(`${channel}: refreshing ${outdir} (removing any previous build) ...`);
    // maxRetries rides out transient Windows locks (AV/indexer) on the extracted
    // binaries; a genuinely held handle (e.g. a lingering crashreporter.exe) still
    // needs that process gone.
    rmSync(outdir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
    });
    mkdirSync(outdir, { recursive: true });

    log(
        `${channel}: installing firefox@${channel} via @puppeteer/browsers ...`,
    );
    // Single shell string (not shell:true + args array -> Node DEP0190); outdir
    // quoted for spaces. stderr inherits so the progress bar shows; stdout is
    // captured for the version token.
    const r = spawnSync(
        `npx -y @puppeteer/browsers install firefox@${channel} --path "${outdir}"`,
        {
            shell: true,
            encoding: "utf8",
            stdio: ["inherit", "pipe", "inherit"],
        },
    );
    if (r.status !== 0)
        die(`@puppeteer/browsers install failed for ${channel}`);
    const line =
        (r.stdout || "")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .pop() || ""; // 'firefox@<channel>_<token> <path>'
    log(line);

    const bin = findBinary(channel, { dest });
    if (!bin || !existsSync(bin))
        die(`could not resolve the installed binary for ${channel}`);

    // Record identity for next run's change check. nightly keys on the accurate
    // application.ini BuildID; beta/stable on puppeteer's version token (carries
    // beta's 'bN' suffix that application.ini drops).
    let id = "";
    if (channel === "nightly") {
        const bid = iniValue(channel, "BuildID");
        if (bid) id = `buildid:${bid}`;
    } else {
        const token = line.split(/\s+/)[0].replace(`firefox@${channel}_`, "");
        if (token) id = `version:${token}`;
    }
    if (id) writeFileSync(identityPath(channel), id);
    log(`${channel}: updated -> ${id.split(":")[1] || "?"}`);
    process.stdout.write(bin + "\n");
}

async function downloadLatest() {
    if (channelOpt) await downloadOneLatest(channelOpt);
    else for (const ch of DEFAULT_CHANNELS) await downloadOneLatest(ch);
}

// Pinned nightly straight from archive.mozilla.org (mozilla-central only).
async function downloadPinned() {
    if (platform === "windows")
        die(
            "--build (pinned nightly) is not supported on Windows (needs a zip/dmg extractor); " +
                "use --channel for the latest, or bisect on a macOS/Linux host.",
        );

    let url, dirName;
    if (/^\d{14}$/.test(buildOpt)) {
        const b = buildOpt;
        dirName = `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}-${b.slice(8, 10)}-${b.slice(10, 12)}-${b.slice(12, 14)}-mozilla-central`;
        url = `https://archive.mozilla.org/pub/firefox/nightly/${b.slice(0, 4)}/${b.slice(4, 6)}/${dirName}/`;
    } else if (/^https?:\/\//i.test(buildOpt)) {
        url = buildOpt.replace("ftp.mozilla.org", "archive.mozilla.org");
        if (!url.endsWith("/")) url += "/";
        dirName = url.replace(/\/$/, "").split("/").pop();
    } else {
        die(
            "--build expects a 14-digit buildID (e.g. 20260908042139) or a build-directory URL",
        );
    }

    const suffix = platform === "linux" ? "linux-x86_64.tar.xz" : "mac.dmg";
    log(`Resolving ${suffix} artefact in ${url} ...`);
    let listing;
    try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        listing = await r.text();
    } catch {
        die(`build directory not found: ${url}`);
    }
    // reeeeeeeeee
    const re = new RegExp(
        `firefox-[0-9][^"/]*\\.en-US\\.${suffix.replace(/\./g, "\\.")}`,
        "g",
    );
    const file = [...new Set(listing.match(re) || [])].sort()[0];
    if (!file) die(`no firefox-*.en-US.${suffix} artefact in ${url}`);

    const outdir = join(dest, dirName);
    // Reuse an already-extracted build unless --force.
    // The binary is named
    // "firefox" on both (linux firefox/firefox, mac <app>/Contents/MacOS/firefox).
    if (!force) {
        const existing = findFile(outdir, "firefox");
        if (existing && existsSync(existing)) {
            log(`Already present: ${existing}`);
            process.stdout.write(existing + "\n");
            return;
        }
    }

    mkdirSync(outdir, { recursive: true });
    const dl = join(outdir, file);
    log(`Downloading ${file} ...`);
    try {
        const r = await fetch(url + file);
        if (!r.ok) throw new Error(String(r.status));
        const buf = Buffer.from(await r.arrayBuffer());
        writeFileSync(dl, buf);
    } catch {
        die(`download failed: ${url}${file}`);
    }

    log("Extracting ...");
    if (platform === "linux") {
        const t = spawnSync("tar", ["-xf", dl, "-C", outdir], {
            stdio: "inherit",
        });
        if (t.status !== 0) die("tar extraction failed");
        const bin = join(outdir, "firefox", "firefox");
        if (!existsSync(bin)) die(`extraction did not yield ${bin}`);
        process.stdout.write(bin + "\n");
    } else {
        // macOS .dmg: attach, copy the .app out, detach.
        const att = spawnSync(
            "hdiutil",
            ["attach", "-nobrowse", "-noverify", dl],
            {
                encoding: "utf8",
            },
        );
        if (att.status !== 0) die(`could not mount ${dl}`);
        const mount = (att.stdout.match(/\/Volumes\/[^\n\r]*/g) || []).pop();
        if (!mount) die(`could not find mount point for ${dl}`);
        try {
            const app = (readdirSync(mount) || []).find((n) =>
                n.endsWith(".app"),
            );
            if (!app) die(`no .app found in mounted ${dl}`);
            spawnSync("cp", ["-R", join(mount, app), outdir + "/"], {
                stdio: "inherit",
            });
            const bin = join(outdir, app, "Contents", "MacOS", "firefox");
            if (!existsSync(bin)) die(`extraction did not yield ${bin}`);
            process.stdout.write(bin + "\n");
        } finally {
            spawnSync("hdiutil", ["detach", "-quiet", mount], {
                stdio: "ignore",
            });
        }
    }
}

if (buildOpt) await downloadPinned();
else await downloadLatest();
