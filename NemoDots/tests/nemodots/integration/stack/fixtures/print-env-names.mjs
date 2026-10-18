// Stub checkout child for the I3 test: prints the NAMES (never values) of
// its environment as one JSON line, then exits.
/* global console, process */
console.log(`ENV_NAMES ${JSON.stringify(Object.keys(process.env).sort())}`);
