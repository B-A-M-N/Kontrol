// Direct `npm publish` from the checkout must be impossible. Publication
// only happens through the qualified staged path:
//
//   KONTROL_QUALIFIED_CANDIDATE=releases/<buildId> KONTROL_RELEASE_BUILD_ID=<buildId> \
//     npm run release:publish
//
// which runs the full release-verify gate (combined qualified receipt, exact
// buildId, exact source SHA, release-local validation, clean checkout) before
// `npm publish` executes inside the staged tree. The staging script strips
// lifecycle hooks from the staged manifest, so this refusal never fires there
// — it exists solely to stop a checkout-local `npm publish`.
console.error(
  "[publish] REFUSED: direct `npm publish` from the checkout is not allowed.\n"
  + "\n"
  + "Publication is fail-closed on qualification. To publish a release:\n"
  + "\n"
  + "  1. land a clean commit, then run the code gate:      npm run gate:beta:code\n"
  + "  2. deploy the EXACT immutable buildId and soak it:   npm run soak:beta  (12h)\n"
  + "  3. join the evidence into the final receipt:         npm run gate:beta:final\n"
  + "  4. verify the exact qualified candidate:             npm run release:verify\n"
  + "  5. stage + publish the qualified artifact:\n"
  + "\n"
  + "       KONTROL_QUALIFIED_CANDIDATE=releases/<buildId> \\\n"
  + "       KONTROL_RELEASE_BUILD_ID=<buildId> \\\n"
  + "       npm run release:publish\n"
  + "\n"
  + "Never rebuild between soak and publish — the soak qualifies an exact artifact.",
);
process.exit(1);
