const { runCli } = require("../dist/cli.js");

process.exitCode = runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
