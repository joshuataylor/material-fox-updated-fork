#!/usr/bin/env node
// Captures Firefox's browser UI with Marionette and save PNGs.
// That's all I wanted. What follows is a weekend worth of digging into Selenium, GeckoDriver and Firefox's chrome context
// to get it working reliably across channels and colour schemes.
//
// Supports full-window and element screenshots across release channels (nightly/beta/stable) and colour schemes (light/dark).
//
// Also hides the automation indicator (striped URL bar and robot icon) before capture.
//
// Relevant documentation to help with understanding this mess:
//
// Firefox options, profiles and preferences: https://www.selenium.dev/documentation/webdriver/browsers/firefox/
// Browser navigation: https://www.selenium.dev/documentation/webdriver/interactions/navigation/
// Window and element screenshots: https://www.selenium.dev/documentation/webdriver/interactions/windows/#takescreenshot
// GeckoDriver system access: https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html#allow-system-access
//
// Usage:
//   mise run screenshots # defaults from the config
//   mise run screenshots -- --channels nightly,beta --schemes light
//   mise run screenshots -- --only urlbar-not-secure
//   mise run screenshots -- --no-headless # visible window (debugging)
//
// Configure in scripts/screenshot.config.mjs, or use --config <path>.
// Use `variants: [{ id, prefs }]` for captures with different prefs. Variant prefs override the screenshot's prefs.
// Screenshots share a browser, with UI state reset between captures.
// Set `isolate: true` on a screenshot or the config to use a fresh profile for each capture that changes persistent state, such as bookmarks or history.
//
// PNGs output to `outDir` (default tmp/screenshots), named
// <feature>__<enabled|disabled>__<channel_major>__<light|dark>__<os>.png.
// For example: findbar_top_right__nightly_158__light__windows_11.png.

import { Builder, By, Key } from "selenium-webdriver";
import * as firefox from "selenium-webdriver/firefox.js";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { findBinary, NOVA_DEFAULT } from "./lib/firefox-bin.mjs";
import { makeThemedProfile } from "./lib/profile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const BINARIES = {
    nightly: findBinary("nightly"),
    beta: findBinary("beta"),
    stable: findBinary("stable"),
};

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const key = token.slice(2);
        if (key.startsWith("no-")) {
            args[key.slice(3)] = false;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
            args[key] = argv[++i];
        } else {
            args[key] = true;
        }
    }
    return args;
}

const list = (value) =>
    String(value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lowercase a filename segment and replace runs of punctuation or whitespace with "_".
const seg = (s) =>
    String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

// Combine the screenshot name, variant and aspect (crop label or "window").
// Omit the aspect if it repeats the name or variant: findbar + default + findbar becomes findbar_default.
function featureName(screenshotName, variant, aspect) {
    const parts = [seg(screenshotName)];
    if (variant) parts.push(seg(variant));
    const a = seg(aspect);
    if (a && !parts.includes(a)) parts.push(a);
    return parts.filter(Boolean).join("_");
}

// Include the toggle state, channel version, scheme and OS so captures can share
// one directory: <feature>__<enabled|disabled>__<version>__<scheme>__<os>.png.
function flatFile({
    outDir,
    screenshotName,
    variant,
    aspect,
    state,
    version,
    scheme,
    osTag,
}) {
    const feature = featureName(screenshotName, variant, aspect);
    return join(
        outDir,
        `${feature}__${state}__${version}__${scheme}__${osTag}.png`,
    );
}

// Read "<channel>_<major>" (e.g. "beta_156") from the running browser.
// Fall back to the channel name if the capabilities request fails.
async function readVersion(driver, channel) {
    try {
        const caps = await driver.getCapabilities();
        const v = String(
            caps.get("browserVersion") || caps.get("version") || "",
        );
        const major = (v.match(/\d+/) || ["0"])[0];
        return `${channel}_${major}`;
    } catch {
        return channel;
    }
}

// Detect the OS label for filenames, e.g. windows_11 or ubuntu_26_04.
// The caller checks --os and $SCREENSHOT_OS first.
function detectOs() {
    const p = process.platform;
    if (p === "darwin") {
        let v = "";
        try {
            v = execFileSync("sw_vers", ["-productVersion"], {
                encoding: "utf8",
            }).trim();
        } catch {
            /* ignore */
        }
        const major = (v.match(/\d+/) || [""])[0];
        return major ? `macos_${major}` : "macos";
    }
    if (p === "win32") {
        // os.release() -> "10.0.<build>"; Windows 11 is build >= 22000.
        const build = Number(os.release().split(".")[2] || 0);
        return build >= 22000 ? "windows_11" : "windows_10";
    }
    // Linux: ID + VERSION_ID from /etc/os-release, e.g. ubuntu_26_04.
    try {
        const txt = readFileSync("/etc/os-release", "utf8");
        const get = (k) =>
            (txt.match(new RegExp(`^${k}="?([^"\\n]+)`, "m")) || [])[1] || "";
        const id = get("ID");
        const ver = get("VERSION_ID");
        if (id && ver) return seg(`${id}_${ver}`);
    } catch {
        /* ignore */
    }
    return "linux";
}

// Convert a CSS selector to a crop label suitable for filenames.
const labelFor = (selector) =>
    selector
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "crop";

// Build one screenshot from --adhoc CLI flags.
// Capture the full window if no selector is supplied.
function buildAdhocScreenshot(args) {
    const selectors = args.selector ? list(args.selector) : [];
    let prefs;
    if (args.prefs) {
        try {
            prefs = JSON.parse(args.prefs);
        } catch (err) {
            throw new Error(`--prefs is not valid JSON: ${err.message}`);
        }
    }
    return {
        name: args.name || "adhoc",
        url: args.url || "about:blank",
        prefs,
        setup: args.setup || undefined,
        window: args.window === true || selectors.length === 0,
        crops: selectors.map((selector) => ({
            label: labelFor(selector),
            selector,
        })),
    };
}

async function loadConfig(configArg) {
    const path = configArg
        ? resolve(process.cwd(), configArg)
        : join(HERE, "screenshot.config.mjs");
    const mod = await import(pathToFileURL(path).href);
    return mod.default;
}

// Firefox options, profiles and preferences:
// https://www.selenium.dev/documentation/webdriver/browsers/firefox/
function buildOptions({ binary, profileDir, headless, nova, scheme, dpr }) {
    const options = new firefox.Options();
    options.addArguments("-no-remote", "-new-instance");
    if (headless) options.addArguments("-headless");
    options.setBinary(binary);
    options.setProfile(profileDir);

    // Use 2x resolution by default; override with --dpr.
    if (dpr && dpr !== 1) {
        options.setPreference("layout.css.devPixelsPerPx", String(dpr));
    }

    // Allow browser UI automation and access to Services.*.
    options.setPreference("marionette.allow-system-access", true);
    options.setPreference("remote.allow-system-access", true);
    options.setPreference("devtools.chrome.enabled", true);
    options.setPreference(
        "toolkit.legacyUserProfileCustomizations.stylesheets",
        true,
    );
    options.setPreference("browser.nova.enabled", nova);
    options.setPreference(
        "browser.newtabpage.activity-stream.nova.enabled",
        nova,
    );
    // Disable onboarding and data submission prompts in fresh profiles.
    options.setPreference("browser.aboutwelcome.enabled", false);
    options.setPreference("datareporting.policy.dataSubmissionEnabled", false);
    options.setPreference("browser.startup.homepage_override.mstone", "ignore");
    // Skip the Firefox 158+ pre-onboarding Terms-of-Use splash.
    options.setPreference("browser.preonboarding.enabled", false);
    options.setPreference("termsofuse.bypassNotification", true);
    // Set the system and page colour schemes.
    options.setPreference("ui.systemUsesDarkTheme", scheme === "dark" ? 1 : 0);
    options.setPreference(
        "layout.css.prefers-color-scheme.content-override",
        scheme === "dark" ? 0 : 1,
    );
    return options;
}

async function newDriver(options) {
    // GeckoDriver requires system access to automate Firefox's browser UI.
    // https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html#allow-system-access
    const service = new firefox.ServiceBuilder().addArguments(
        "--allow-system-access",
    );
    const driver = await new Builder()
        .forBrowser("firefox")
        .setFirefoxOptions(options)
        .setFirefoxService(service)
        .build();
    await driver.setContext("chrome");
    return driver;
}

// Navigate the selected tab and wait for loading and UI updates.
// Use openTrustedLinkIn because gBrowser.loadURI can race the Marionette response and drop the connection.
// Standard WebDriver page navigation is documented here; this function runs in Firefox's chrome context:
// https://www.selenium.dev/documentation/webdriver/interactions/navigation/
async function navigate(driver, url, settleMs) {
    await driver.executeScript((u) => {
        // eslint-disable-next-line no-undef
        openTrustedLinkIn(u, "current");
        return true;
    }, url);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const done = await driver.executeScript(() => {
            // eslint-disable-next-line no-undef
            const b = gBrowser.selectedBrowser;
            const uri = b?.currentURI?.spec || "";
            const loading = b?.webProgress?.isLoadingDocument;
            return uri !== "about:blank" && loading === false;
        });
        if (done) break;
        await sleep(150);
    }
    await sleep(settleMs);
}

async function setPrefs(driver, prefs) {
    if (!prefs) return;
    await driver.executeScript((entries) => {
        for (const [name, value] of entries) {
            if (typeof value === "boolean")
                Services.prefs.setBoolPref(name, value); // eslint-disable-line no-undef
            else if (typeof value === "number")
                Services.prefs.setIntPref(name, value); // eslint-disable-line no-undef
            else Services.prefs.setStringPref(name, String(value)); // eslint-disable-line no-undef
        }
        return true;
    }, Object.entries(prefs));
}

async function clearPrefs(driver, prefs) {
    if (!prefs) return;
    await driver.executeScript((names) => {
        for (const name of names) {
            try {
                Services.prefs.clearUserPref(name); // eslint-disable-line no-undef
            } catch {}
        }
        return true;
    }, Object.keys(prefs));
}

// Hide the striped toolbar and robot icon added by Marionette.
async function stripAutomationIndicator(driver) {
    await driver.executeScript(() => {
        document.documentElement.removeAttribute("remotecontrol");
        return true;
    });
}

function writePng(base64, outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(base64, "base64"));
}

// Grab the whole OS display via the platform's screen-capture tool. Needed for
// content-anchored popups (#PopupAutoComplete) that render as separate native
// windows and are therefore invisible to geckodriver's window/element
// screenshots -- a full-display grab is the only capture that includes them.
// macOS: screencapture; Windows: PowerShell (System.Drawing); Linux: an X11
// grabber (import/scrot/xwd -- present when the shot runs under Xvfb).
// Returns true on success; false (with a warning) if no tool is available.
function osFullScreenShot(outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    const run = (cmd, args) => {
        execFileSync(cmd, args, { stdio: "ignore" });
    };
    try {
        if (process.platform === "darwin") {
            run("screencapture", ["-x", outPath]);
            return true;
        }
        if (process.platform === "win32") {
            const ps = [
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
                "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
                "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
                "$g=[System.Drawing.Graphics]::FromImage($bmp);",
                "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
                `$bmp.Save('${outPath.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
            ].join(" ");
            run("powershell", ["-NoProfile", "-Command", ps]);
            return true;
        }
        // Linux: needs an X display (Xvfb sets $DISPLAY); skip cleanly on the
        // headless pass where there is none.
        if (!process.env.DISPLAY) return false;
        // Try common X11 grabbers in order.
        for (const [cmd, args] of [
            ["import", ["-window", "root", outPath]],
            ["scrot", ["-o", outPath]],
            ["gnome-screenshot", ["-f", outPath]],
        ]) {
            try {
                run(cmd, args);
                return true;
            } catch {
                /* try the next tool */
            }
        }
        console.warn(
            "  ! full-screen capture: no X11 grabber found (install imagemagick or scrot)",
        );
        return false;
    } catch (err) {
        console.warn(`  ! full-screen capture failed: ${err.message}`);
        return false;
    }
}

// Run setup in chrome context, then wait for UI updates before capture.
// For example, setup can open the findbar with document.getElementById("cmd_find").doCommand().
async function runSetup(driver, setup, settleMs) {
    if (!setup) return;
    await driver.executeScript(setup);
    await sleep(settleMs);
}

// Used when a web-content element needs to open a content-anchored chrome popup (e.g. the #PopupAutoComplete satchel/datalist dropdown).
async function runContentTrigger(driver, trigger, settleMs) {
    if (!trigger) return;
    await driver.setContext("content");
    try {
        const el = await driver.findElement(By.css(trigger.selector));
        // Centre the field so a downward-opening popup has room (else it opens
        // off-screen and the crop grabs the page behind it).
        await driver.executeScript(
            "arguments[0].scrollIntoView({ block: 'center' });",
            el,
        );
        await el.click();
        if (trigger.type) await el.sendKeys(trigger.type);
        if (trigger.key) await el.sendKeys(Key[trigger.key]);
    } finally {
        await driver.setContext("chrome");
    }
    if (trigger.showPopup) {
        // The focused content input carries over the context switch; open its autocomplete popup from chrome (nsIFormFillController.showPopup).
        await driver.executeScript(() => {
            Cc["@mozilla.org/satchel/form-fill-controller;1"] // eslint-disable-line no-undef
                .getService(Ci.nsIFormFillController) // eslint-disable-line no-undef
                .showPopup();
            return true;
        });
    }
    await sleep(settleMs);
}

// Select the built-in theme matching the requested colour scheme.
// An active light or dark theme overrides ui.systemUsesDarkTheme for browser UI.
// This caused light captures to render dark on Firefox 156 beta...
async function enforceColorScheme(driver, scheme) {
    const themeId =
        scheme === "dark"
            ? "firefox-compact-dark@mozilla.org"
            : "firefox-compact-light@mozilla.org";
    await driver.executeAsyncScript((id, done) => {
        const { AddonManager } = ChromeUtils.importESModule(
            "resource://gre/modules/AddonManager.sys.mjs",
        );
        AddonManager.getAddonByID(id)
            .then((addon) => (addon ? addon.enable() : null))
            .then(
                () => done(true),
                () => done(false),
            );
    }, themeId);
    await sleep(300);
}

// Reset UI state between captures: close findbars, panels and menus, leave split view, and keep one tab.
// Attempt each step even if an earlier one fails.
async function resetState(driver) {
    await driver.executeScript(() => {
        /* global gBrowser, gURLBar, document */
        const tryEach = (fns) =>
            fns.forEach((f) => {
                try {
                    f();
                } catch {}
            });
        tryEach([
            () =>
                document
                    .querySelectorAll("findbar")
                    .forEach((fb) => fb.close()),
            () => gBrowser.selectedTab.splitview?.unsplitTabs("reset"),
            () => gURLBar?.view?.close(),
            () => SidebarController?.hide(),
            () =>
                [
                    "editBookmarkPanel",
                    "appMenu-popup",
                    "tabContextMenu",
                    "contentAreaContextMenu",
                    "downloadsPanel",
                    "trustpanel-popup",
                    "protections-popup",
                ].forEach((id) => document.getElementById(id)?.hidePopup()),
            () => {
                for (let i = gBrowser.tabs.length - 1; i > 0; i--)
                    gBrowser.removeTab(gBrowser.tabs[i]);
                gBrowser.selectedTab = gBrowser.tabs[0];
            },
        ]);
        return true;
    });
}

// nameFor(aspect) supplies the output path for "window" or a crop label.
// Return the written files as { aspect, file }.
// WebDriver window and element screenshot APIs:
// https://www.selenium.dev/documentation/webdriver/interactions/windows/#takescreenshot
async function captureScreenshot(driver, screenshot, nameFor, settleMs) {
    const written = [];
    await resetState(driver);
    await setPrefs(driver, screenshot.prefs);
    await navigate(driver, screenshot.url, settleMs);
    await runSetup(driver, screenshot.setup, settleMs);
    await runContentTrigger(driver, screenshot.contentTrigger, settleMs);
    await stripAutomationIndicator(driver);

    // Native-window popups are invisible to WebDriver screenshots; capture the
    // whole display from the OS instead. This is the only aspect for such a shot.
    if (screenshot.fullScreen) {
        const out = nameFor("fullscreen");
        if (osFullScreenShot(out)) {
            written.push({ aspect: "fullscreen", file: out });
        }
        await clearPrefs(driver, screenshot.prefs);
        return written;
    }

    if (screenshot.window !== false) {
        const png = await driver.takeScreenshot();
        const out = nameFor("window");
        writePng(png, out);
        written.push({ aspect: "window", file: out });
    }

    for (const crop of screenshot.crops || []) {
        try {
            const el = await driver.findElement(By.css(crop.selector));
            const png = await el.takeScreenshot();
            const out = nameFor(crop.label);
            writePng(png, out);
            written.push({ aspect: crop.label, file: out });
        } catch (err) {
            console.warn(
                `  ! crop "${crop.label}" (${crop.selector}) failed: ${err.message}`,
            );
        }
    }

    await clearPrefs(driver, screenshot.prefs);
    return written;
}

// Expand each variant into a capture, with its prefs overriding the screenshot's.
// The variant ID becomes part of the filename. Without variants, capture once.
// `state` records whether this capture has the feature toggle on: "enabled" when
// the variant applies a pref, "disabled" for the baseline (empty prefs) or a
// variant-less screenshot. A variant may set `state` explicitly to override.
function expandScreenshot(screenshot) {
    if (!screenshot.variants?.length)
        return [{ screenshot, variant: null, state: "disabled" }];
    return screenshot.variants.map((v) => ({
        screenshot: {
            ...screenshot,
            prefs: { ...(screenshot.prefs || {}), ...(v.prefs || {}) },
        },
        variant: v.id,
        state:
            v.state ??
            (Object.keys(v.prefs || {}).length ? "enabled" : "disabled"),
    }));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = await loadConfig(args.config);

    const adhoc = args.adhoc === true;
    // Accept --scheme as an alias for --schemes.
    const schemesArg = args.schemes ?? args.scheme;
    const dpr = args.dpr ? Number(args.dpr) : (config.dpr ?? 2);
    // Ad-hoc captures default to nightly and light unless overridden.
    const channels = args.channels
        ? list(args.channels)
        : adhoc
          ? ["nightly"]
          : config.channels;
    const schemes = schemesArg
        ? list(schemesArg)
        : adhoc
          ? ["light"]
          : config.schemes;
    const only = args.only ? new Set(list(args.only)) : null;
    const headfulOnly = args["headful-only"] === true;
    const headless = headfulOnly ? false : args.headless !== false;
    const outDir = resolve(process.cwd(), args.out || config.outDir);
    const osTag = args.os || process.env.SCREENSHOT_OS || detectOs();
    const settleMs = config.settleMs ?? 600;
    // Cache the browser version per channel for filenames.
    const versionByChannel = {};
    let screenshots = adhoc ? [buildAdhocScreenshot(args)] : config.screenshots;
    if (only) screenshots = screenshots.filter((s) => only.has(s.name));
    if (headfulOnly) screenshots = screenshots.filter((s) => s.headful);

    if (!screenshots.length) {
        console.error("No screenshots selected.");
        process.exit(1);
    }

    const manifest = [];
    for (const channel of channels) {
        const binary = BINARIES[channel];
        if (!binary || !existsSync(binary)) {
            console.warn(
                `Skipping channel "${channel}": no binary (run: mise run download-firefox --channel ${channel}, or set $FF_${channel.toUpperCase()}).`,
            );
            continue;
        }
        const nova = args.nova ? args.nova === "on" : NOVA_DEFAULT[channel];
        // Create a temporary themed profile for this channel under tmp/profiles/.
        const profileDir = makeThemedProfile({
            prefs: { "userChrome.theme-material": true },
            label: "screenshot",
        });

        try {
            for (const scheme of schemes) {
                console.log(
                    `\n[${channel}/${scheme}] (nova=${nova}, headless=${headless})...`,
                );
                // Selenium copies the profile for each launch. Apply the requested theme after startup.
                const launch = async () => {
                    const options = buildOptions({
                        binary,
                        profileDir,
                        headless,
                        nova,
                        scheme,
                        dpr,
                    });
                    options.windowSize(config.window);
                    const d = await newDriver(options);
                    await enforceColorScheme(d, scheme);
                    return d;
                };

                // Reuse one browser unless the screenshot requires isolation.
                // Isolated captures get a fresh profile so bookmarks and history do not carry over.
                let shared = null;
                try {
                    for (const screenshot of screenshots) {
                        for (const {
                            screenshot: s,
                            variant,
                            state,
                        } of expandScreenshot(screenshot)) {
                            const isolate =
                                s.isolate ?? config.isolate ?? false;
                            const label = variant
                                ? `${screenshot.name}/${variant}`
                                : screenshot.name;
                            process.stdout.write(
                                `  - ${label}${isolate ? " [isolated]" : ""} ... `,
                            );
                            let driver;
                            if (isolate) driver = await launch();
                            else driver = shared ?? (shared = await launch());
                            if (!versionByChannel[channel])
                                versionByChannel[channel] = await readVersion(
                                    driver,
                                    channel,
                                );
                            const version = versionByChannel[channel];
                            const nameFor = (aspect) =>
                                flatFile({
                                    outDir,
                                    screenshotName: screenshot.name,
                                    variant,
                                    aspect,
                                    state,
                                    version,
                                    scheme,
                                    osTag,
                                });
                            try {
                                const written = await captureScreenshot(
                                    driver,
                                    s,
                                    nameFor,
                                    settleMs,
                                );
                                console.log(`${written.length} file(s)`);
                                for (const w of written)
                                    manifest.push({
                                        feature: featureName(
                                            screenshot.name,
                                            variant,
                                            w.aspect,
                                        ),
                                        state,
                                        channel,
                                        version,
                                        scheme,
                                        os: osTag,
                                        aspect: w.aspect,
                                        file: w.file,
                                    });
                            } catch (err) {
                                console.log(`error: ${err.message}`);
                            } finally {
                                if (isolate)
                                    await driver.quit().catch(() => {});
                            }
                        }
                    }
                } finally {
                    if (shared) await shared.quit().catch(() => {});
                }
            }
        } finally {
            rmSync(profileDir, { recursive: true, force: true });
        }
    }

    const manifestPath = join(outDir, "manifest.json");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
        `\nDone. ${manifest.length} screenshot(s). Manifest: ${manifestPath}`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
