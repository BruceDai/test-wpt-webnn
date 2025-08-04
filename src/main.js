const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const process = require("process");
const puppeteer = require("puppeteer-core");
const sleep = require("sleep");
const { execSync, spawnSync } = require("child_process");
const { stringify } = require("csv-stringify");
const { sendMail } = require("./report.js");

const deviceTypeArray = ["cpu", "gpu", "npu"];
const msTimeout = 300000; // 5 minutes
const currentPath = process.cwd();
let currentBrowser = null;

const headersURLList = [
  "https://wpt.live/webnn/conformance_tests/byob_readtensor.https.any.js.headers",
  "https://wpt.live/webnn/conformance_tests/shared_arraybuffer_constant.https.any.js.headers",
  "https://wpt.live/webnn/conformance_tests/tensor.https.any.js.headers",
];

const resultColumns = {
  testsuite: "Test Suite",
  testcase: "Test Case",
  status: "Status",
  message: "Message",
};

let lastVersion = null;
let currentVersion = null;

function getCanaryVersion() {
  const info = execSync(
    `reg query "HKEY_CURRENT_USER\\Software\\Google\\Chrome SxS\\BLBeacon" /v version`,
  ).toString();
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

  return links.filter((link) => !headersURLList.includes(link));
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

function killChrome() {
  spawnSync("cmd", ["/c", "taskkill /F /IM chrome.exe /T"]);
}

async function setBrowser(deviceType = "cpu") {
  killChrome();

  // Launch Chrome canary
  const chromePath = path.join(
    process.env.LOCALAPPDATA,
    "Google",
    "Chrome SxS",
    "Application",
    "chrome.exe",
  );

  // These two folders are for testing own built ORT and OV EP dlls
  const ortDllsFolder = path.join(process.env.ProgramFiles, "ONNXRuntime");
  const ortOVEPDllsFolder = path.join(
    process.env.ProgramFiles,
    "ONNXRuntime-OVEP",
  );

  const chromeArgs = [
    "--enable-features=WebMachineLearningNeuralNetwork,WebNNOnnxRuntime",

    // These below three switches are for testing own built ORT and OV EP dlls
    `--webnn-ort-library-path-for-testing=${ortDllsFolder}`,
    `--webnn-ort-ep-library-path-for-testing=${ortOVEPDllsFolder}`,
    "--allow-third-party-modules",
  ];

  const userDataDir = path.join(os.tmpdir(), deviceType);
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  fs.mkdirpSync(userDataDir);
  const browser = await puppeteer.launch({
    args: chromeArgs,
    executablePath: chromePath,
    headless: false,
    ignoreHTTPSErrors: true,
    protocolTimeout: msTimeout,
    userDataDir: userDataDir,
  });
  sleep.sleep(3);
  return browser;
}

async function getTestResult(link, deviceType, timeoutTestLinks, lastRerun) {
  let page;

  if (currentBrowser) {
    await currentBrowser.close();
  }

  currentBrowser = await setBrowser(deviceType);

  page = await currentBrowser.newPage();
  page.setDefaultTimeout(msTimeout);

  const testsuiteName = getTestsuiteName(link);
  const testLink =
    link.slice(0, link.length - 3) + `.html?${deviceType.split("-")[0]}`;
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

async function runByDevice(testLinks, deviceType, lastRerun = false) {
  let totalResults = [];
  let timeoutTestLinks = [];

  for (const link of testLinks) {
    const results = await getTestResult(
      link,
      deviceType,
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
    currentVersion = getCanaryVersion();
    console.log(`>>> Current Chrome Canary version: ${currentVersion}`);

    const lastTestedVersionFile = path.join(currentPath, "LastTestedVersion");

    if (fs.existsSync(lastTestedVersionFile)) {
      lastVersion = fs.readFileSync(lastTestedVersionFile).toString();
      console.log(`>>> Last tested Chrome Canary version: ${lastVersion}`);
    }

    const resultFolder = path.join(currentPath, "result", currentVersion);
    fs.mkdirpSync(resultFolder);

    const testLinks = await getConformanceTestLinks();

    if (testLinks === null || testLinks.length === 0) {
      return;
    }

    let csvResultFileArray = [];
    let notRunTests = {};

    for (const deviceType of deviceTypeArray) {
      console.log(`>>> Test by ${deviceType}`);

      let [resultByDevice, timeoutTestLinks] = await runByDevice(
        testLinks,
        deviceType,
      );

      if (timeoutTestLinks.length > 0) {
        // First run timeout tests
        const [rerunResult, rerunTimeoutTestLinks] = await runByDevice(
          timeoutTestLinks,
          deviceType,
        );
        resultByDevice = resultByDevice.concat(rerunResult);
        if (rerunTimeoutTestLinks.length > 0) {
          // Second run timeout tests
          const [rerunResult2nd, rerunTimeoutTestLinks2nd] = await runByDevice(
            rerunTimeoutTestLinks,
            deviceType,
          );
          resultByDevice = resultByDevice.concat(rerunResult2nd);
          if (rerunTimeoutTestLinks2nd.length > 0) {
            // Third run timeout tests
            const [rerunResult3rd, rerunTimeoutTestLinks3rd] =
              await runByDevice(rerunTimeoutTestLinks2nd, deviceType, true);
            resultByDevice = resultByDevice.concat(rerunResult3rd);
            if (rerunTimeoutTestLinks3rd.length > 0) {
              console.log(
                `>>> Please check these timeout tests for testing ${deviceType}: ${rerunTimeoutTestLinks3rd}`,
              );
              notRunTests[deviceType] = rerunTimeoutTestLinks3rd;
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
            `conformance_tests_result-${deviceType}.csv`,
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

  killChrome();
}

run();
