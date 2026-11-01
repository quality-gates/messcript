#!/usr/bin/env bash
set -euo pipefail

mkdir -p .explore
work=$(mktemp -d "$PWD/.explore/replay.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/project/src" "$work/project/test" "$work/project/dist" "$work/policies"

run() {
  local name=$1 expected=$2
  shift 2
  local status=0
  node dist/cli.js "$@" > "$work/$name.out" 2> "$work/$name.err" || status=$?
  if [[ $status != "$expected" ]]; then
    printf '%s: expected exit %s, got %s\n' "$name" "$expected" "$status" >&2
    return 1
  fi
  printf '%s: exit %s\n' "$name" "$status"
}

printf 'const excessively_long_variable_name_for_fixture_abc = 1;\n' > "$work/project/src/main.ts"
printf 'function broken( {\n' > "$work/project/src/broken.ts"
printf 'const excessively_long_test_variable_name_for_fixture = 1;\n' > "$work/project/test/example.test.ts"
printf 'const excessively_long_generated_variable_name_for_fixture = 1;\n' > "$work/project/dist/generated.ts"
run scan 1 "$work/project" json typescript --only LongVariable
jq -e '([.findings[].path | split("/")[-1]] == ["main.ts", "example.test.ts"]) and (.errors | length == 1) and (.errors[0].message | startswith("Could not parse /"))' "$work/scan.out" >/dev/null
run ignored-tests 1 "$work/project" json typescript --only LongVariable --ignore-tests
jq -e '([.findings[].path | split("/")[-1]] == ["main.ts"]) and (.errors | length == 1)' "$work/ignored-tests.out" >/dev/null
run ignored-errors 2 "$work/project" json typescript --only LongVariable --ignore-tests --ignore-errors-on-exit
jq -e '(.findings | length == 1) and (.errors | length == 1)' "$work/ignored-errors.out" >/dev/null
printf 'const okay = 1;\n' > "$work/project/src/broken.ts"
run corrected 2 "$work/project" json typescript --only LongVariable --ignore-tests
jq -e '(.findings | length == 1) and (.errors | length == 0)' "$work/corrected.out" >/dev/null
printf 'const clean = 1;\n' > "$work/clean.ts"
run clean 0 "$work/clean.ts" json typescript --only LongVariable
jq -e '(.findings | length == 0) and (.errors | length == 0)' "$work/clean.out" >/dev/null

printf '%s\n' 'const deliberately_long_variable_name_for_a_fixture = 1;' '// messcript-disable-next-line LongVariable' 'const another_deliberately_long_variable_name_for_fixture = 2;' > "$work/next-line.ts"
run next-line 2 "$work/next-line.ts" json typescript --only LongVariable
jq -e '[.findings[] | [.line, .suppressed]] == [[1, false]]' "$work/next-line.out" >/dev/null
run next-line-strict 2 "$work/next-line.ts" json typescript --only LongVariable --strict
jq -e '[.findings[] | [.line, .suppressed]] == [[1, false], [3, true]]' "$work/next-line-strict.out" >/dev/null

printf '%s\n' '// messcript-disable LongVariable' 'const first_really_long_variable_name_for_testing = 1;' '// messcript-disable LongVariable' 'const second_really_long_variable_name_for_testing = 2;' '// messcript-enable LongVariable' 'const third_really_long_variable_name_for_testing = 3;' '// messcript-enable LongVariable' 'const fourth_really_long_variable_name_for_testing = 4;' > "$work/region.ts"
run region 2 "$work/region.ts" json typescript --only LongVariable
jq -e '[.findings[] | [.line, .suppressed]] == [[8, false]]' "$work/region.out" >/dev/null
run strict 2 "$work/region.ts" json typescript --only LongVariable --strict
jq -e '[.findings[] | [.line, .suppressed]] == [[2, true], [4, true], [6, true], [8, false]]' "$work/strict.out" >/dev/null

printf '%s\n' '<ruleset name="team"><rule ref="LongVariable"><priority>2</priority><properties><property name="maximum" value="10" /></properties></rule></ruleset>' > "$work/policies/team.xml"
printf '%s\n' '<ruleset name="nested"><rule ref="team.xml"><exclude name="LongVariable" /></rule></ruleset>' > "$work/policies/nested.xml"
printf 'const ordinaryName = 1;\n' > "$work/custom.ts"
run custom 2 "$work/custom.ts" json "$work/policies/team.xml"
jq -e '[.findings[] | [.ruleName, .priority, .line]] == [["LongVariable", 2, 1]]' "$work/custom.out" >/dev/null
run nested 0 "$work/custom.ts" json "$work/policies/nested.xml"
jq -e '(.findings | length == 0) and (.errors | length == 0)' "$work/nested.out" >/dev/null
printf 'old report contents\n' > "$work/report.sarif"
run report 2 "$work/custom.ts" sarif "$work/policies/team.xml" --reportfile "$work/report.sarif"
test ! -s "$work/report.out"
jq -e '.version == "2.1.0" and [.runs[0].results[] | [.ruleId, .properties.priority]] == [["LongVariable", 2]] and .runs[0].invocations[0].executionSuccessful == true' "$work/report.sarif" >/dev/null
run replace-report 0 "$work/clean.ts" sarif "$work/policies/team.xml" --reportfile "$work/report.sarif"
jq -e '(.runs[0].results | length == 0) and .runs[0].invocations[0].executionSuccessful == true' "$work/report.sarif" >/dev/null
printf 'All observable checks passed.\n'
