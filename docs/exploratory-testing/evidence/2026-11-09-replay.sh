#!/usr/bin/env bash
set -euo pipefail

mkdir -p .explore
work=$(mktemp -d "$PWD/.explore/replay.XXXXXX")
trap 'rm -rf "$work"; rmdir .explore 2>/dev/null || true' EXIT

run() {
  local name=$1 expected=$2 status=0
  shift 2
  node dist/cli.js "$@" > "$work/$name.out" 2> "$work/$name.err" || status=$?
  printf '%s: exit %s\n' "$name" "$status"
  if [[ $status != "$expected" ]]; then
    printf 'expected exit %s\n' "$expected" >&2
    return 1
  fi
}

mkdir -p "$work/project/src" "$work/project/test" "$work/project/dist"
printf 'const excessively_long_variable_name_for_this_fixture = 1;\n' > "$work/project/src/main.TS"
printf 'const excessively_long_variable_name_for_this_test_case = 1;\n' > "$work/project/test/example.test.ts"
printf 'const excessively_long_variable_name_for_generated_code = 1;\n' > "$work/project/dist/generated.ts"
run discovery 2 "$work/project,$work/project/src/main.TS" json typescript --only LongVariable
jq -e '[.findings[].path | split("/")[-1]] == ["main.TS", "example.test.ts"] and (.errors | length == 0)' "$work/discovery.out" >/dev/null
run discovery-filtered 2 "$work/project" json typescript --only LongVariable --ignore-tests
jq -e '[.findings[].path | split("/")[-1]] == ["main.TS"]' "$work/discovery-filtered.out" >/dev/null
run suffix-filtered 0 "$work/project" json typescript --only LongVariable --suffixes .js
jq -e '(.findings | length == 0) and (.errors | length == 0)' "$work/suffix-filtered.out" >/dev/null

mkdir -p "$work/report"
printf '%s\n' '// messcript-disable-next-line LongVariable' 'const excessively_long_variable_name_for_report_fixture = 1;' 'const another_excessively_long_variable_name_for_report = 2;' > "$work/report/space #&.ts"
run json 2 "$work/report" json typescript --only LongVariable --strict
jq -e '[.findings[] | [.line, .suppressed]] == [[2, true], [3, false]]' "$work/json.out" >/dev/null
run sarif 2 "$work/report" sarif typescript --only LongVariable --strict --reportfile "$work/report.sarif"
test ! -s "$work/sarif.out"
jq -e '[.runs[0].results[] | [.locations[0].physicalLocation.artifactLocation.uri, .properties.suppressed, (.suppressions // [])]] | length == 2 and all(.[0] | contains("space%20%23%26.ts")) and .[0][1:] == [true, [{"kind":"inSource"}]] and .[1][1:] == [false, []]' "$work/report.sarif" >/dev/null
run gitlab 2 "$work/report" gitlab typescript --only LongVariable --strict
jq -e 'length == 2 and .[0].suppressed == true and .[1].suppressed == false and all(.location.path | endswith("space #&.ts"))' "$work/gitlab.out" >/dev/null
run xml 2 "$work/report" xml typescript --only LongVariable --strict
python3 - "$work/xml.out" <<'PY'
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
findings = root.findall('./findings/finding')
assert len(findings) == 2
assert [f.attrib['suppressed'] for f in findings] == ['true', 'false']
assert all(f.attrib['path'].endswith('space #&.ts') for f in findings)
PY
run unsuppressed 2 "$work/report" json typescript --only LongVariable
jq -e '[.findings[] | [.line, .suppressed]] == [[3, false]]' "$work/unsuppressed.out" >/dev/null

mkdir -p "$work/policy"
printf '%s\n' '<ruleset name="a"><rule ref="b.xml" /></ruleset>' > "$work/policy/a.xml"
printf '%s\n' '<ruleset name="b"><rule ref="a.xml" /></ruleset>' > "$work/policy/b.xml"
run cycle 1 "$work/report" json "$work/policy/a.xml"
grep -qi 'circular\|cycle' "$work/cycle.err"
printf '%s\n' '<ruleset name="b"><rule ref="LongVariable" /></ruleset>' > "$work/policy/b.xml"
run corrected-policy 2 "$work/report" json "$work/policy/a.xml" --reportfile "$work/corrected.json"
jq -e '[.findings[] | [.line, .suppressed]] == [[3, false]] and (.errors | length == 0)' "$work/corrected.json" >/dev/null
printf 'All observable checks passed.\n'
