#!/usr/bin/env node
// Ignores argv and stdin, never exits on its own: for testing stop() escalation.
process.stdin.resume();
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
