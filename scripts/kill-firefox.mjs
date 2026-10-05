#!/usr/bin/env node
// Cross-platform `mise run kill-firefox`: stop every Firefox running from the
// repo's downloaded builds (tmp/firefox), e.g. a leftover `mise run firefox`
// window, an automation-driven browser, or one Windows relaunched at login. An
// installed Firefox (/Applications, Program Files) is never touched.
//
// Usage:
//   node scripts/kill-firefox.mjs            # stop them
//   node scripts/kill-firefox.mjs --dry-run  # list only

import { relative } from "node:path";
import { REPO } from "./lib/firefox-bin.mjs";
import { findRepoFirefox, stopProcesses } from "./lib/firefox-procs.mjs";

const dryRun = process.argv.includes("--dry-run");

const procs = findRepoFirefox();
if (!procs.length) {
    console.log("kill-firefox: no Firefox running from tmp/firefox");
    process.exit(0);
}
for (const { pid, exe } of procs)
    console.log(
        `${dryRun ? "would stop" : "stopping"} ${pid} ${relative(REPO, exe)}`,
    );
if (dryRun) process.exit(0);

const left = await stopProcesses(procs);
if (left.length) {
    console.error(
        `kill-firefox: ${left.length} process(es) still running: ${left.map((p) => p.pid).join(" ")}`,
    );
    process.exit(1);
}
console.log(`kill-firefox: stopped ${procs.length} process(es)`);
