#!/usr/bin/env node
// pi replacement that dies immediately: exercises the monitor's error path.
process.stderr.write("fatal: model provider unreachable\n");
process.exit(1);
