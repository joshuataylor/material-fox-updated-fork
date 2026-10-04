#!/usr/bin/env node
// `npm install` with npm's stdout sent to stderr, for mise's [deps.npm] provider.
// mise passes a provider's stdout through to its own, and the raw tasks need a
// clean stdout (firefox-download prints the binary path for BIN=$(...),
// firefox-css-theme-mcp speaks JSON-RPC over stdio). A shell redirect
// (`1>&2`) works in sh and cmd but PowerShell rejects it, so the redirect
// happens here instead and the command is shell-agnostic.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Single shell string (not shell:true + args array -> Node DEP0190); the shell
// is what resolves npm to npm.cmd on Windows. stdio fd 2 for the child's
// stdout routes it to our stderr.
const r = spawnSync("npm install", {
    cwd: REPO,
    shell: true,
    stdio: ["inherit", 2, "inherit"],
});
if (r.error) {
    console.error(`npm-install: ${r.error.message}`);
    process.exit(1);
}
process.exit(r.status ?? 1);
