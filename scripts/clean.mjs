#!/usr/bin/env node
// Cross-platform `mise run clean`: removes tmp/firefox etc.
// Firefox profiles.ini is never touched. Idempotent: a missing target is a no-op.
// Pure Node so it runs under cmd / PowerShell without a POSIX shell (the old
// `rm -rf` loop did not).

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// Both are gitignored throwaway dirs inside the repo: the downloaded builds and
// the reusable launcher profiles. The shared Firefox profiles.ini is untouched.
for (const d of ["tmp/firefox", "tmp/profiles"]) {
    const p = join(REPO, d);
    if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
        console.log(`removed ${d}`);
    }
}
console.log("clean: done");
