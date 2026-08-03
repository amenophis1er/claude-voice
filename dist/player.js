#!/usr/bin/env node
import { readFileSync, unlinkSync } from "node:fs";
import { logDebug, runJob } from "./speak.js";
/**
 * Detached worker. Invoked as `node player.ts <payload.json>` by speak.ts.
 * It owns its own process group so a UserPromptSubmit interrupt can kill the
 * whole thing (synthesis + playback) mid-flight. Runs to completion, then exits.
 */
const payloadFile = process.argv[2];
if (!payloadFile)
    process.exit(0);
let job;
try {
    job = JSON.parse(readFileSync(payloadFile, "utf8"));
}
catch (err) {
    logDebug(`player: bad payload: ${err.message}`);
    process.exit(0);
}
try {
    unlinkSync(payloadFile); // consume it
}
catch {
    /* ignore */
}
runJob(job)
    .catch((err) => logDebug(`player: job failed: ${err.message}`))
    .finally(() => process.exit(0));
