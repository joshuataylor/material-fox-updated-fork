#!/usr/bin/env node
// Cross-platform `mise run clean`: removes tmp/firefox etc.
// Firefox profiles.ini is never touched. Idempotent: a missing target is a no-op.
// Pure Node so it runs under cmd / PowerShell without a POSIX shell (the old
// `rm -rf` loop did not).

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./lib/firefox-bin.mjs";
import { findRepoFirefox } from "./lib/firefox-procs.mjs";

// Both are gitignored throwaway dirs inside the repo: the downloaded builds and
// the reusable launcher profiles. The shared Firefox profiles.ini is untouched.
for (const d of ["tmp/firefox", "tmp/profiles"]) {
    const p = join(REPO, d);
    if (!existsSync(p)) continue;
    try {
        // Retries ride out short-lived Windows locks (antivirus, a browser
        // that has only just exited).
        rmSync(p, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
        });
    } catch (err) {
        if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
        // Windows cannot delete a running executable or a profile in use.
        const running = findRepoFirefox();
        console.error(`clean: cannot remove ${d} (${err.code}).`);
        if (running.length)
            console.error(
                `  Firefox is still running from tmp/firefox (pids ${running.map((r) => r.pid).join(" ")}).\n` +
                    "  Stop it with `mise run kill-firefox`, then re-run clean.",
            );
        process.exit(1);
    }
    console.log(`removed ${d}`);
}
console.log("clean: done");
