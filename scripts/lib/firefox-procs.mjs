// Find and stop Firefox processes running from the repo's downloaded builds
// (tmp/firefox/<channel>), never an installed Firefox elsewhere.
//
// Windows will not delete an executable that is running, so a leftover test
// browser makes `mise run clean` fail with EPERM on tmp/firefox. Windows also
// relaunches a browser that was open at shutdown (`-os-autostart`), so one can
// come back on its own after a VM reboot.
//
// Matching is by executable path: content/GPU child processes run the same
// binary, so they are caught too.

import { spawnSync } from "node:child_process";
import { join, sep } from "node:path";
import { REPO } from "./firefox-bin.mjs";

export const BUILDS_DIR = join(REPO, "tmp", "firefox");

// [{ pid, exe }] for every process whose executable lives under tmp/firefox.
export function findRepoFirefox() {
    const root = BUILDS_DIR + sep;
    if (process.platform === "win32") {
        // Win32_Process.ExecutablePath is the full path; StartsWith avoids
        // -like treating [ ] in the path as wildcards.
        const ps = [
            `$r = '${root.replace(/'/g, "''")}';`,
            "Get-CimInstance Win32_Process |",
            "Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($r, [StringComparison]::OrdinalIgnoreCase) } |",
            'ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)" }',
        ].join(" ");
        const r = spawnSync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command", ps],
            { encoding: "utf8" },
        );
        if (r.status !== 0)
            throw new Error(`process lookup failed: ${r.stderr || r.error}`);
        return r.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => {
                const [pid, exe] = l.split("\t");
                return { pid: Number(pid), exe };
            });
    }
    // POSIX: argv[0] is the absolute binary path, as every launcher here
    // spawns Firefox by its full tmp/firefox path.
    const r = spawnSync("ps", ["-A", "-o", "pid=", "-o", "args="], {
        encoding: "utf8",
    });
    if (r.status !== 0)
        throw new Error(`process lookup failed: ${r.stderr || r.error}`);
    return r.stdout
        .split("\n")
        .map((l) => l.match(/^\s*(\d+)\s+(.*)$/))
        .filter((m) => m && m[2].startsWith(root) && +m[1] !== process.pid)
        .map((m) => ({ pid: Number(m[1]), exe: m[2].split(" ")[0] }));
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Stop the given processes and wait for them to exit (Windows releases the
// file locks only once they are gone). POSIX gets SIGTERM first and SIGKILL
// after the grace period; on Windows process.kill already terminates.
export async function stopProcesses(procs, { graceMs = 5000 } = {}) {
    const signal = (pid, sig) => {
        try {
            process.kill(pid, sig);
        } catch {
            /* already exited */
        }
    };
    for (const { pid } of procs) signal(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    let left = procs.filter((p) => alive(p.pid));
    while (left.length && Date.now() < deadline) {
        await sleep(200);
        left = left.filter((p) => alive(p.pid));
    }
    for (const { pid } of left) signal(pid, "SIGKILL");
    await sleep(left.length ? 500 : 0);
    return procs.filter((p) => alive(p.pid));
}
