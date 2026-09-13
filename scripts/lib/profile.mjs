// Temporary Firefox profiles are created under tmp/profiles/ , used for headless testing etc.

import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPO } from "./firefox-bin.mjs";

// Point <profile>/chrome at chrome/ (using a junction on Windows, which needs no admin, a dir symlink on linux/macOS).
// Windows: https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions
export function linkChrome(profileDir) {
    const link = join(profileDir, "chrome");
    const target = join(REPO, "chrome");
    try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
        else return; // a real directory -- leave whatever is there alone
    } catch {
        /* not present yet */
    }
    symlinkSync(
        target,
        link,
        process.platform === "win32" ? "junction" : "dir",
    );
}

// tad cursed
export function renderUserJs(prefs) {
    const line = ([k, v]) =>
        `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`;
    return Object.entries(prefs).map(line).join("\n") + "\n";
}

// Create a temporary profile dir under tmp/profiles/<label>-XXXX. `themed`, then link the compiled chrome/ in.
export function makeThemedProfile({
    prefs = {},
    themed = true,
    label = "profile",
} = {}) {
    const root = join(REPO, "tmp", "profiles");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, `${label}-`));
    if (themed) linkChrome(dir);
    const base = {
        "toolkit.legacyUserProfileCustomizations.stylesheets": true,
        "svg.context-properties.content.enabled": true,
        "layout.css.color-mix.enabled": true,
        "browser.aboutwelcome.enabled": false,
        "datareporting.policy.dataSubmissionEnabled": false,
        "browser.startup.homepage_override.mstone": "ignore",
    };
    writeFileSync(join(dir, "user.js"), renderUserJs({ ...base, ...prefs }));
    return dir;
}
