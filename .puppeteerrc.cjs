const { join } = require("path");

/**
 * Keep the downloaded Chromium inside the project so Render bundles it into the
 * deploy (the default ~/.cache/puppeteer is outside the repo and not persisted,
 * forcing a re-download — or a missing binary — on every deploy).
 */
module.exports = {
	cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
