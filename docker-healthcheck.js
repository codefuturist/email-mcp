#!/usr/bin/env node
// Health check for Docker containers running email-mcp in HTTP mode.
// Exits 0 if healthy, 1 otherwise.

const port = process.argv[2] || 8080;

fetch(`http://localhost:${port}/health`)
  .then((res) => (res.ok ? process.exit(0) : process.exit(1)))
  .catch(() => process.exit(1));
