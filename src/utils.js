const dayjs = require("dayjs");
const fs = require("fs-extra");

function getTimestamp(template = "MM/DD") {
  return dayjs(Date.now()).format(template);
}

/**
 * Parses a JSON file with comments.
 * @param {string} filePath - Path to the JSON file.
 * @returns {object} - Parsed JSON object.
 */
function parseConfigWithComments(filePath) {
  // Read the file content as a string
  const fileContent = fs.readFileSync(filePath, "utf8");

  // Remove single-line comments (//) and multi-line comments (/* */)
  const cleanedContent = fileContent
    .replace(/\/\/.*$/gm, "") // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // Remove multi-line comments

  // Parse the cleaned JSON string
  return JSON.parse(cleanedContent);
}

/**
 * Replaces placeholders in browserLaunchArgs with corresponding config values.
 * @param {object} config - The configuration object.
 */
function replacePlaceholders(config) {
  const browserLaunchArgs = config.browserLaunchArgs;

  // Iterate over each key in browserLaunchArgs
  for (const key in browserLaunchArgs) {
    if (browserLaunchArgs.hasOwnProperty(key)) {
      // Iterate over each argument in the array
      browserLaunchArgs[key] = browserLaunchArgs[key].map((arg) => {
        // Check if the argument contains "ToReplaceBy"
        if (arg.includes("ToReplaceBy")) {
          // Extract the placeholder key
          const placeholder = arg.match(/ToReplaceBy\w+/)[0];
          const configKey =
            placeholder.slice(11, 12).toLowerCase() + placeholder.slice(12);

          // Replace the placeholder with the corresponding config value
          if (config[configKey]) {
            return arg.replace(placeholder, `${config[configKey]}`);
          }
        }
        return arg; // Return the argument unchanged if no placeholder is found
      });
    }
  }
}

function getConfig() {
  let config = parseConfigWithComments("config.json");
  replacePlaceholders(config);
  return config;
}

module.exports = { getConfig, getTimestamp };
