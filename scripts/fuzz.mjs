// npm run fuzz: every property in tests/fuzz.test.ts, 100 000 times (or FUZZ_RUNS).
// Long mode: a parse over 200 ms fails. FUZZ_SEED replays a failure.
import { spawnSync } from "node:child_process";

const env = { ...process.env, FUZZ_RUNS: process.env.FUZZ_RUNS ?? "100000" };
const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/fuzz.test.ts"], { stdio: "inherit", env });
process.exit(r.status ?? 1);
