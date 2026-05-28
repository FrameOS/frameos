Assets
======================

- Files in compiled/ folder will get compiled into the FrameOS binary.
- Files in copied/ will get copied to the frame on deploy.


Updating timezone data
======================

FrameOS embeds timezone data from `tz/tzdata.json` at compile time via
`frameos/src/lib/tz.nim`. The generated source of truth lives in the sibling
`../tz` checkout, which builds data from https://github.com/eggert/tz.

From the FrameOS repo root:

1. Update the timezone generator checkout:

   cd ../tz
   git fetch origin
   git merge --ff-only origin/main
   git status --short --branch

   cd tools/tz
   git fetch origin
   git merge --ff-only origin/main

2. Rebuild and run the generator:

   cd ..
   nim c generate.nim
   ./generate

   The generator may print `Failed to parse Jan 1 ... -2147481748` for ancient
   sentinel rows from `zdump`; this is expected if the command exits
   successfully and writes `tools/tzdata.json`.

3. Publish the generated files into `../tz/dist`:

   cd ..
   cp tools/tzdata.json dist/tzdata.json
   cp tools/tzdata/dstchanges.csv dist/dstchanges.csv
   cp tools/tzdata/timezones.csv dist/timezones.csv
   gzip -9 -f -k dist/tzdata.json
   gzip -9 -f -k dist/dstchanges.csv
   gzip -9 -f -k dist/timezones.csv
   date -u +"%Y-%m-%dT%H:%M:%SZ" > dist/updated.txt

4. Copy the embedded runtime asset back into FrameOS:

   cd ../frameos
   cp ../tz/dist/tzdata.json frameos/assets/compiled/tz/tzdata.json

5. Sanity-check the result:

   cmp -s ../tz/dist/tzdata.json frameos/assets/compiled/tz/tzdata.json
   gzip -t ../tz/dist/tzdata.json.gz
   gzip -t ../tz/dist/timezones.csv.gz
   gzip -t ../tz/dist/dstchanges.csv.gz
   jq '{timezones:(.timezones|length), dstChanges:(.dstChanges|length)}' frameos/assets/compiled/tz/tzdata.json
   nim c -r frameos/src/frameos/utils/tests/test_period.nim
