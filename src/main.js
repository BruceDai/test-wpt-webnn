const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const process = require("process");
const puppeteer = require("puppeteer-core");
const sleep = require("sleep");
const { execSync, spawnSync } = require("child_process");
const { stringify } = require("csv-stringify");
const { getConfig, getTimestamp } = require("./utils.js");
const { sendMail } = require("./report.js");

const msTimeout = 300000; // 5 minutes
const currentPath = process.cwd();
const resultColumns = {
  testsuite: "Test Suite",
  testcase: "Test Case",
  status: "Status",
  message: "Message",
};
let currentBrowser = null;
let lastVersion = null;
let currentVersion = null;
let config;

function getBrowserVersion() {
  const queryString =
    config.targetBrowser === "Chrome Canary"
      ? `reg query "HKEY_CURRENT_USER\\Software\\Google\\Chrome SxS\\BLBeacon" /v version`
      : `reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Edge SxS\\BLBeacon" /v version`;
  const info = execSync(queryString).toString();
  const match = info.match(/version\s+REG_SZ\s+([^\r\n]+)/i);
  return match[1];
}

async function getConformanceTestLinks() {
  const browser = await setBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(msTimeout);

  await page.goto("https://wpt.live/webnn/conformance_tests", {
    waitUntil: "domcontentloaded",
  });
  await page.$("ul");

  const links = await page.$$eval("li.file > a", (aElements) => {
    return aElements.map((a) => a.href);
  });

  await page.close();
  await browser.close();

  return links.filter((link) => !link.endsWith("headers"));
}

function getTestsuiteName(link) {
  const startIndex = "https://wpt.live/webnn/conformance_tests/".length;
  const tailLength = ".https.any.js".length; // 13
  const rawName = link.slice(startIndex, link.length - tailLength);
  const partArray = rawName.split("_");
  return (
    partArray[0] +
    partArray
      .slice(1)
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join("")
  );
}

function killBrowser() {
  const binaryName =
    config.targetBrowser === "Chrome Canary" ? "chrome.exe" : "msedge.exe";
  spawnSync("cmd", ["/c", `taskkill /F /IM ${binaryName} /T`]);
}

function getLaunchArgs(backendOrEP) {
  let launchArgs;

  if (backendOrEP === undefined) {
    launchArgs = [];
  } else {
    launchArgs = JSON.parse(
      JSON.stringify(config.browserLaunchArgs[backendOrEP]),
    );
  }

  return launchArgs;
}

async function setBrowser(backendOrEP) {
  killBrowser();

  const userDataDir = path.join(
    os.tmpdir(),
    backendOrEP ?? getTimestamp("YYYYMMDDHHmmss"),
  );

  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  fs.mkdirpSync(userDataDir);

  const browser = await puppeteer.launch({
    args: getLaunchArgs(backendOrEP),
    executablePath: config.browserPath[config.targetBrowser],
    headless: false,
    ignoreHTTPSErrors: true,
    acceptInsecureCerts: true,
    protocolTimeout: msTimeout,
    userDataDir: userDataDir,
  });

  sleep.sleep(3);

  return browser;
}

async function getTestResult(link, backendOrEP, timeoutTestLinks, lastRerun) {
  let page;

  if (currentBrowser) {
    await currentBrowser.close();
  }

  currentBrowser = await setBrowser(backendOrEP);

  page = await currentBrowser.newPage();
  page.setDefaultTimeout(msTimeout);

  const testsuiteName = getTestsuiteName(link);
  const deviceType = backendOrEP
    .split(" ")
    [backendOrEP.split(" ").length - 1].toLowerCase()
    .replace("webgpu", "gpu");
  const testLink = link.slice(0, link.length - 3) + `.html?${deviceType}`;
  console.log(`>>> Test link: ${testLink}`);

  let results = [];

  try {
    await page.goto(testLink, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#results > tbody > tr");

    results = await page.$$eval(
      "#results > tbody > tr",
      (trElements, testsuiteName, lastRerun) => {
        const results = [];
        for (const tr of trElements) {
          const tdElements = tr.getElementsByTagName("td");
          const testcaseName = tdElements[1].innerHTML;
          const result = tdElements[0].innerHTML;
          if (!lastRerun && (result === "Timeout" || result === "Not Run")) {
            throw new Error(`Timeout to run ${testcaseName}`);
          }
          results.push([
            testsuiteName,
            testcaseName,
            result,
            result === "Fail"
              ? tdElements[2].innerHTML.slice(
                  0,
                  tdElements[2].innerHTML.indexOf("<pre>"),
                )
              : "",
          ]);
        }
        return results;
      },
      testsuiteName,
      lastRerun,
    );

    console.log(results);
    await page.close();
  } catch (e) {
    if (e instanceof puppeteer.TimeoutError) {
      console.log(`>>> Timeout to run ${testLink}`);
    } else {
      console.log(`>>> Failed to run ${testLink}, ${e.message}`);
    }

    timeoutTestLinks.push(link);
  }

  return results;
}

async function runByDevice(testLinks, backendOrEP, lastRerun = false) {
  let totalResults = [];
  let timeoutTestLinks = [];

  for (const link of testLinks) {
    const results = await getTestResult(
      link,
      backendOrEP,
      timeoutTestLinks,
      lastRerun,
    );
    totalResults = totalResults.concat(results);
  }

  return [totalResults, timeoutTestLinks];
}

async function run() {
  try {
    let mailStatus;
    config = getConfig();
    currentVersion = getBrowserVersion();
    console.log(`>>> Current browser version: ${currentVersion}`);

    const lastTestedVersionFile = path.join(currentPath, "LastTestedVersion");

    if (fs.existsSync(lastTestedVersionFile)) {
      lastVersion = fs.readFileSync(lastTestedVersionFile).toString();
      console.log(`>>> Last tested browser version: ${lastVersion}`);
    }

    const resultFolder = path.join(currentPath, "result", currentVersion);
    fs.mkdirpSync(resultFolder);

    const testLinks = await getConformanceTestLinks();

    if (testLinks === null || testLinks.length === 0) {
      return;
    }

    let csvResultFileArray = [];
    let notRunTests = {};

    for (const backendOrEP of config.targetBackendOrEP) {
      console.log(`>>> Test by ${backendOrEP}`);

      let [resultByDevice, timeoutTestLinks] = await runByDevice(
        testLinks,
        backendOrEP,
      );

      if (timeoutTestLinks.length > 0) {
        // First run timeout tests
        const [rerunResult, rerunTimeoutTestLinks] = await runByDevice(
          timeoutTestLinks,
          backendOrEP,
        );
        resultByDevice = resultByDevice.concat(rerunResult);
        if (rerunTimeoutTestLinks.length > 0) {
          // Second run timeout tests
          const [rerunResult2nd, rerunTimeoutTestLinks2nd] = await runByDevice(
            rerunTimeoutTestLinks,
            backendOrEP,
          );
          resultByDevice = resultByDevice.concat(rerunResult2nd);
          if (rerunTimeoutTestLinks2nd.length > 0) {
            // Third run timeout tests
            const [rerunResult3rd, rerunTimeoutTestLinks3rd] =
              await runByDevice(rerunTimeoutTestLinks2nd, backendOrEP, true);
            resultByDevice = resultByDevice.concat(rerunResult3rd);
            if (rerunTimeoutTestLinks3rd.length > 0) {
              console.log(
                `>>> Please check these timeout tests for testing ${backendOrEP}: ${rerunTimeoutTestLinks3rd}`,
              );
              notRunTests[backendOrEP] = rerunTimeoutTestLinks3rd;
            }
          }
        }
      }

      stringify(
        resultByDevice,
        { header: true, columns: resultColumns },
        (_, output) => {
          const csvFile = path.join(
            resultFolder,
            `conformance_tests_result-${backendOrEP}.csv`,
          );
          csvResultFileArray.push(csvFile);
          fs.writeFile(csvFile, output, () => {
            console.log(
              `>>> Save WebNN WPT conformance tests results into ${csvFile}`,
            );
          });
        },
      );
    }

    await currentBrowser.close();

    // save current version into LastTestedVersion file
    fs.writeFileSync(lastTestedVersionFile, currentVersion);

    mailStatus = await sendMail(
      currentVersion,
      lastVersion,
      csvResultFileArray,
      notRunTests,
    );
    if (mailStatus) {
      console.log(">>> Successfully send email.");
    }
  } catch (e) {
    console.error(`>>> Failed to run test: ${e.message}.`);
  }

  killBrowser();
}

run();
