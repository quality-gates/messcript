const {
  measureIgnorePatternProbe,
  nativeIgnorePatternProbeArgument,
} = require("../dist/rules/ignore-pattern.js");

if (process.argv[2] === nativeIgnorePatternProbeArgument) {
  try {
    process.stdout.write(String(measureIgnorePatternProbe(process.argv[3] ?? "")));
    process.exitCode = 0;
  } catch {
    process.exitCode = 2;
  }
  return;
}

process.env.MESSCRIPT_NATIVE_EXECUTABLE = process.execPath;

const { runCli } = require("../dist/cli.js");

process.exitCode = runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
