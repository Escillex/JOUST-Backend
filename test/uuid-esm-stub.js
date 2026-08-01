// uuid v13 ships ESM only, which this jest config (ts-jest, CommonJS, no allowJs)
// cannot load. Any test that reaches ImagesService transitively imports it, so it
// is mapped to this CommonJS stub in test/jest-e2e.json. Nothing under test here
// depends on the values being real UUIDs - the tests that touch this module only
// read route metadata.
let counter = 0;

module.exports = {
  v4: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
};
