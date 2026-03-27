const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const process = require("process");
const puppeteer = require("puppeteer-core");
const sleep = require("sleep");
const { execSync, spawnSync } = require("child_process");
const { stringify } = require("csv-stringify");
const { getConfig, getTimestamp, getTestsuiteName } = require("./utils.js");
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

function killBrowser() {
  const binaryName =
    config.targetBrowser === "Chrome Canary" ? "chrome.exe" : "msedge.exe";
  spawnSync("cmd", ["/c", `taskkill /F /IM ${binaryName} /T`]);
}

function getLaunchArgs(backendOrEP) {
  if (backendOrEP === undefined) {
    return [];
  }
  return JSON.parse(JSON.stringify(config.browserLaunchArgs[backendOrEP]));
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

    const gpuPage = await currentBrowser.newPage();
    await gpuPage.goto("chrome://gpu", { waitUntil: "networkidle0" });
    await gpuPage.waitForFunction(() => {
      const infoView = document.querySelector("info-view").shadowRoot;
      return (
        infoView.querySelector(
          "#content > div:last-child > h3 > span:nth-child(2)",
        ).innerText === "Log Messages"
      );
    });
    const gpuLogMessages = await gpuPage.evaluate(() => {
      const infoView = document.querySelector("info-view").shadowRoot;
      return Array.from(
        infoView.querySelectorAll("#content > div:last-child > ul > li"),
      ).map((el) => el.innerText);
    });
    const webnnErrorMessagesStartIndex = gpuLogMessages.findIndex((message) =>
      message.includes("[WebNN]"),
    );
    const webnnErrorMessages =
      webnnErrorMessagesStartIndex != -1
        ? gpuLogMessages.slice(webnnErrorMessagesStartIndex)
        : [];
    const crashMessages = webnnErrorMessages.filter((message) =>
      message.includes("GpuProcessHost: The GPU process crashed!"),
    );

    if (crashMessages.length > 0) {
      results.push([
        testsuiteName,
        testsuiteName,
        "Crash",
        webnnErrorMessages.join("\n"),
      ]);
    } else {
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
    }

    sleep.sleep(3);
    await gpuPage.close();
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
  let crashTestLinks = [];

  for (const link of testLinks) {
    const results = await getTestResult(
      link,
      backendOrEP,
      timeoutTestLinks,
      lastRerun,
    );
    if (results && results[0] && results[0][2] === "Crash") {
      crashTestLinks.push(link);
    }
    totalResults = totalResults.concat(results);
  }

  return [totalResults, timeoutTestLinks, crashTestLinks];
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
    let crashTests = {};
    let notRunTests = {};

    for (const backendOrEP of config.targetBackendOrEP) {
      console.log(`>>> Test by ${backendOrEP}`);

      const maxRetries = 3;
      let [resultByDevice, timeoutTestLinks, crashTestLinks] =
        await runByDevice(testLinks, backendOrEP);

      if (crashTestLinks.length > 0) {
        crashTests[backendOrEP] = (crashTests[backendOrEP] || []).concat(
          crashTestLinks,
        );
      }

      for (
        let retry = 0;
        retry < maxRetries && timeoutTestLinks.length > 0;
        retry++
      ) {
        const lastRerun = retry === maxRetries - 1;
        console.log(
          `>>> Retry ${retry + 1}/${maxRetries} for timeout tests (${backendOrEP})`,
        );
        const [rerunResult, rerunTimeoutTestLinks, rerunCrashTestLinks] =
          await runByDevice(timeoutTestLinks, backendOrEP, lastRerun);
        if (rerunCrashTestLinks.length > 0) {
          crashTests[backendOrEP] = (crashTests[backendOrEP] || []).concat(
            rerunCrashTestLinks,
          );
        }
        resultByDevice = resultByDevice.concat(rerunResult);
        timeoutTestLinks = rerunTimeoutTestLinks;
      }

      if (timeoutTestLinks.length > 0) {
        console.log(
          `>>> Please check these timeout tests for testing ${backendOrEP}: ${timeoutTestLinks}`,
        );
        notRunTests[backendOrEP] = timeoutTestLinks;
      }

      const csvFile = path.join(
        resultFolder,
        `conformance_tests_result-${backendOrEP}.csv`,
      );
      csvResultFileArray.push(csvFile);
      const csvOutput = await new Promise((resolve, reject) => {
        stringify(
          resultByDevice,
          { header: true, columns: resultColumns },
          (err, output) => (err ? reject(err) : resolve(output)),
        );
      });
      fs.writeFileSync(csvFile, csvOutput);
      console.log(
        `>>> Save WebNN WPT conformance tests results into ${csvFile}`,
      );
    }

    await currentBrowser.close();

    // save current version into LastTestedVersion file
    fs.writeFileSync(lastTestedVersionFile, currentVersion);

    mailStatus = await sendMail(
      currentVersion,
      lastVersion,
      csvResultFileArray,
      crashTests,
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
