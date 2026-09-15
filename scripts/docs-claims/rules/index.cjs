const appCount = require('./app-count.cjs');
const appNames = require('./app-names.cjs');
const codeFences = require('./code-fences.cjs');
const placeholders = require('./placeholders.cjs');
const promisedSoon = require('./promised-soon.cjs');
const versionReferences = require('./version-references.cjs');

const RULES = [codeFences, appCount, appNames, versionReferences, promisedSoon, placeholders];

module.exports = { RULES };
