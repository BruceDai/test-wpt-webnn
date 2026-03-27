const os = require("os");
const path = require("path");
const csv = require("csv-parser");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const nodemailer = require("nodemailer");
const si = require("systeminformation");
const { getConfig, getTimestamp, getTestsuiteName } = require("./utils.js");

const config = getConfig();

async function getTestEnvironmentInfo(currentVersion) {
  const environmentInfo = {};
  environmentInfo["hostname"] = os.hostname();
  environmentInfo["platform"] = os.platform();
  environmentInfo["testUrl"] = "https://wpt.live/webnn/conformance_tests/";
  environmentInfo[config.targetBrowser] = currentVersion;
  config.targetBackendOrEP.forEach((backendOrEP) => {
    const commandKey = `testCommand (${backendOrEP})`;
    environmentInfo[commandKey] =
      `"${config.browserPath[config.targetBrowser]}" ${config.browserLaunchArgs[backendOrEP].join(" ")}`;
  });

  // CPU
  const cpuData = await si.cpu();
  environmentInfo["cpuName"] = `${cpuData.manufacturer} ${cpuData.brand}`;

  // GPU
  try {
    if (environmentInfo.platform === "win32") {
      const info = execSync(
        `powershell -Command "Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,DriverVersion,Status,PNPDeviceID | ConvertTo-Json"`,
      )
        .toString()
        .trim();
      const gpuInfo = JSON.parse(info);
      if (gpuInfo.length > 1) {
        for (let i = 0; i < gpuInfo.length; i++) {
          let match;
          environmentInfo["gpuName"] = gpuInfo[i]["Name"];
          if (environmentInfo["gpuName"].match("Microsoft")) {
            continue;
          }
          environmentInfo["gpuDriverVersion"] = gpuInfo[i]["DriverVersion"];

          match = gpuInfo[i]["PNPDeviceID"].match(".*DEV_(.{4})");
          environmentInfo["gpuDeviceId"] = match[1].toUpperCase();

          match = gpuInfo[i]["PNPDeviceID"].match(".*VEN_(.{4})");
          environmentInfo["gpuVendorId"] = match[1].toUpperCase();

          match = gpuInfo[i]["Status"];
          if (match) {
            if (match == "OK") {
              break;
            }
          }
        }
      } else {
        let match;
        environmentInfo["gpuName"] = gpuInfo["Name"];
        environmentInfo["gpuDriverVersion"] = gpuInfo["DriverVersion"];

        match = gpuInfo["PNPDeviceID"].match(".*DEV_(.{4})");
        environmentInfo["gpuDeviceId"] = match[1].toUpperCase();

        match = gpuInfo["PNPDeviceID"].match(".*VEN_(.{4})");
        environmentInfo["gpuVendorId"] = match[1].toUpperCase();
      }
    } else if (environmentInfo.platform === "darwin") {
      // macOS command
      const info = execSync("system_profiler SPDisplaysDataType")
        .toString()
        .trim();

      const nameMatch = info.match(/Chipset Model:\s+(.*)/);
      const vendorMatch = info.match(/Vendor:\s+(.*)/);
      const driverMatch = info.match(/Metal Support:\s+(.*)/);

      environmentInfo["gpuName"] = nameMatch ? nameMatch[1].trim() : "";
      environmentInfo["gpuVendor"] = vendorMatch ? vendorMatch[1].trim() : "";
      environmentInfo["gpuDriverVersion"] = driverMatch
        ? driverMatch[1].trim()
        : "";
    } else if (environmentInfo.platform === "linux") {
      const info = execSync(`lshw -C display`).toString().trim();
      const productMatch = info.match(/product:\s+(.+)/i);
      const vendorMatch = info.match(/vendor:\s+(.+)/i);
      const driverMatch = info.match(/configuration:\s+driver=(\w+)\s/i);

      environmentInfo["gpuName"] = productMatch ? productMatch[1].trim() : "";
      environmentInfo["gpuVendor"] = vendorMatch ? vendorMatch[1].trim() : "";
      environmentInfo["gpuDriverVersion"] = driverMatch
        ? driverMatch[1].trim()
        : "";
    }
  } catch (error) {
    console.error(
      `>>> Error occurred while getting GPU info\n. Error Details: ${error}`,
    );
  }

  // NPU
  try {
    if (environmentInfo.platform === "win32") {
      const info = execSync(
        `powershell -Command "Get-WmiObject Win32_PnPSignedDriver | Where-Object {$_.DeviceName -like \\"*AI Boost*\\"} | Select-Object  DeviceName,DeviceID,DriverVersion | ConvertTo-Json"`,
      )
        .toString()
        .trim();
      const npuInfo = JSON.parse(info);
      environmentInfo["npuName"] = npuInfo["DeviceName"];
      const match = npuInfo["DeviceID"].match(".*DEV_(.{4})");
      environmentInfo["npuDeviceId"] = match
        ? match[1].toUpperCase()
        : "Unknown";
      environmentInfo["npuDriverVersion"] = npuInfo["DriverVersion"];
    }
  } catch (error) {
    console.error(
      `>>> Error occurred while getting NPU info\n. Error Details: ${error}`,
    );
  }

  return environmentInfo;
}

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const testResults = new Map();
    let totalNumber = 0;
    let passNumber = 0;
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        const key = `${row["Test Suite"]}||${row["Test Case"]}`;
        testResults.set(key, {
          status: row["Status"],
          message: row["Message"],
        });
        ++totalNumber;
        if (row["Status"] == "Pass") {
          ++passNumber;
        }
      })
      .on("end", () => resolve([testResults, totalNumber, passNumber]))
      .on("error", (error) => reject(error));
  });
}

function diffResults(oldResults, newResults, backend) {
  // Get unique keys from both files
  const allKeys = new Set([...oldResults.keys(), ...newResults.keys()]);

  let newPassTests = [];
  let regressionTests = [];

  allKeys.forEach((key) => {
    const [testSuite, testCase] = key.split("||");
    const oldData = oldResults.get(key) || { status: "", message: "" };
    const newData = newResults.get(key) || { status: "", message: "" };

    if (oldData.status === "Pass" && newData.status === "Fail") {
      regressionTests.push({
        backend,
        suiteName: testSuite,
        testName: testCase,
        message: newData.message,
      });
    }

    if (oldData.status === "Fail" && newData.status === "Pass") {
      newPassTests.push({ backend, suiteName: testSuite, testName: testCase });
    }
  });

  return [newPassTests, regressionTests];
}

async function getSummaryResult(currentVersion, lastVersion, csvFileArray) {
  return Promise.all(
    csvFileArray.map(async (csvFile) => {
      const passRates = [];
      let newPassTests = [];
      let regressionTests = [];
      const fileName = path.basename(csvFile, ".csv");
      const backend = fileName.slice("conformance_tests_result-".length);
      const currentResults = await readCsv(csvFile);
      passRates.push({
        backend,
        totalNumber: currentResults[1],
        passNumber: currentResults[2],
      });
      if (lastVersion) {
        const lastResultFile = csvFile.replace(currentVersion, lastVersion);
        const lastResults = await readCsv(lastResultFile);
        const [currentNewPassTests, currentRegressionTests] = diffResults(
          lastResults[0],
          currentResults[0],
          backend,
        );
        newPassTests = newPassTests.concat(currentNewPassTests);
        regressionTests = regressionTests.concat(currentRegressionTests);
      }

      return { passRates, newPassTests, regressionTests };
    }),
  );
}

function transformNotRunTests(test) {
  const result = [];
  for (const [key, urls] of Object.entries(test)) {
    const device = key
      .split(" ")
      [key.split(" ").length - 1].toLowerCase()
      .replace("webgpu", "gpu");
    urls.forEach((url) => {
      const testLink = url.replace(".js", ".html") + `?${device}`;
      result.push({
        backend: key,
        suiteName: getTestsuiteName(url),
        link: testLink,
      });
    });
  }

  return result;
}

async function formatResultsAsHTMLTable(
  currentVersion,
  lastVersion,
  csvFileArray,
  crashTests,
  notRunTests,
) {
  const resultObj = {
    html: {
      environmentInfoTable: "",
      passRateTable: "",
      newPassTestsTable: "",
      regressionTestsTable: "",
      crashTestsTable: "",
      notRunTestsTable: "",
    },
  };

  const environmentInfo = await getTestEnvironmentInfo(currentVersion);
  const formattedEnvironmentInfo = [];
  for (let category of Object.keys(environmentInfo)) {
    formattedEnvironmentInfo.push({
      category,
      detail: environmentInfo[category],
    });
  }

  const thStyle = `border: 1px solid black; padding: 0 4px 0 4px; background-color:rgb(4,116,196); text-align: center; vertical-align: middle; color:white`;
  const thFixedStyle = `${thStyle}; min-width: 50px; width: 50px; max-width: 50px`;
  const tdStyle = `border: 1px solid black;`;

  function th(label, fixed = false) {
    return `<th style="${fixed ? thFixedStyle : thStyle}">${label}</th>`;
  }

  function td(value) {
    return `<td style="${tdStyle}">${value}</td>`;
  }

  function buildTable(width, headers, rows) {
    if (rows.length === 0) return null;
    const headerRow = headers
      .map(([label, fixed]) => th(label, fixed))
      .join("");
    return `
    <table style="border-collapse: collapse; width: ${width}; table-layout: fixed;">
      <thead><tr>${headerRow}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  const environmentInfoRows = formattedEnvironmentInfo
    .map(({ category, detail }) => `<tr>${td(category)}${td(detail)}</tr>`)
    .join("");

  let summary = {
    passRates: [],
    newPassTests: [],
    regressionTests: [],
  };

  const rawSummary = await getSummaryResult(
    currentVersion,
    lastVersion,
    csvFileArray,
  );

  for (let deviceResult of rawSummary) {
    summary.passRates = summary.passRates.concat(deviceResult.passRates);
    summary.newPassTests = summary.newPassTests.concat(
      deviceResult.newPassTests,
    );
    summary.regressionTests = summary.regressionTests.concat(
      deviceResult.regressionTests,
    );
  }

  const passRateRows = summary.passRates
    .map(
      (passRate) =>
        `<tr>${td(passRate.backend)}${td(`${((passRate.passNumber / passRate.totalNumber) * 100).toFixed(2)}% (${passRate.passNumber} / ${passRate.totalNumber})`)}</tr>`,
    )
    .join("");
  const newPassTestsRows = summary.newPassTests
    .map(
      (test) =>
        `<tr>${td(test.backend)}${td(test.suiteName)}${td(test.testName)}</tr>`,
    )
    .join("");
  const regressionTestsRows = summary.regressionTests
    .map(
      (test) =>
        `<tr>${td(test.backend)}${td(test.suiteName)}${td(test.testName)}${td(test.message)}</tr>`,
    )
    .join("");

  const crashTestsRows = transformNotRunTests(crashTests)
    .map(
      (test) =>
        `<tr>${td(test.backend)}${td(test.suiteName)}${td(test.link)}</tr>`,
    )
    .join("");

  const notRunTestsRows = transformNotRunTests(notRunTests)
    .map(
      (test) =>
        `<tr>${td(test.backend)}${td(test.suiteName)}${td(test.link)}</tr>`,
    )
    .join("");

  resultObj.html.environmentInfoTable = buildTable(
    "100%",
    [
      ["Category", false],
      ["Details", false],
    ],
    environmentInfoRows,
  );

  resultObj.html.passRateTable = buildTable(
    "40%",
    [
      ["Backend", true],
      ["Pass Rate", false],
    ],
    passRateRows,
  );

  resultObj.html.newPassTestsTable = buildTable(
    "80%",
    [
      ["Backend", true],
      ["Test Suite", false],
      ["Test Case", false],
    ],
    newPassTestsRows,
  );

  resultObj.html.regressionTestsTable = buildTable(
    "100%",
    [
      ["Backend", true],
      ["Test Suite", false],
      ["Test Case", false],
      ["Message", false],
    ],
    regressionTestsRows,
  );

  resultObj.html.crashTestsTable = buildTable(
    "100%",
    [
      ["Backend", true],
      ["Test Suite", true],
      ["Test URL", false],
    ],
    crashTestsRows,
  );

  resultObj.html.notRunTestsTable = buildTable(
    "100%",
    [
      ["Backend", true],
      ["Test Suite", true],
      ["Test URL", false],
    ],
    notRunTestsRows,
  );

  return resultObj;
}

async function sendMail(
  currentVersion,
  lastVersion,
  csvFileArray = [],
  crashTests = {},
  notRunTests = {},
) {
  console.log(">>> Sending email...");
  const subject = `${getTimestamp()} - Nightly WPT WebNN Conformance Test Report by ${os.hostname()}`;
  let transporter = nodemailer.createTransport(
    config.emailService.serverConfig,
  );

  try {
    let mailOptions = {
      from: config.emailService.from,
      to: config.emailService.to,
      subject: subject,
      attachments: [],
    };

    let htmlContent = "";
    if (currentVersion === lastVersion) {
      htmlContent = `
        <p>None new released build, skip this Nightly WPT Conformance Test.</p>
      `;
      console.log(
        ">>> None new released build, skip this Nightly WPT Conformance Test.",
      );
    } else {
      if (csvFileArray.length === 0) {
        console.log(`>>> None saved CSV result file.`);
        return false;
      }

      csvFileArray.forEach((csvFile) => {
        mailOptions.attachments.push({
          filename: path.basename(csvFile),
          path: csvFile,
        });
      });

      const htmlResult = await formatResultsAsHTMLTable(
        currentVersion,
        lastVersion,
        csvFileArray,
        crashTests,
        notRunTests,
      );
      const environmentInfoTable = htmlResult.html.environmentInfoTable;
      const passRateTable = htmlResult.html.passRateTable;

      if (lastVersion) {
        htmlContent = `
          <p>Nightly WPT Conformance Test completed ${config.testPurpose}. Please review below details comparing with last test of ${lastVersion}:</p>
        `;
      } else {
        htmlContent = `
          <p>Nightly WPT Conformance Test completed ${config.testPurpose}. Please review below details:</p>
        `;
      }

      htmlContent += `<p><strong>Test Environment Info</strong></p>
        ${environmentInfoTable}`;

      htmlContent += `<p><strong>Pass Rate</strong></p>
        ${passRateTable}`;

      const newPassTestsTable = htmlResult.html.newPassTestsTable;
      const regressionTestsTable = htmlResult.html.regressionTestsTable;
      const crashTestsTable = htmlResult.html.crashTestsTable;
      const notRunTestsTable = htmlResult.html.notRunTestsTable;

      if (newPassTestsTable) {
        htmlContent += `<p style="color:green;"><strong>New Pass Test Case</strong></p>
          ${newPassTestsTable}`;
      }

      if (regressionTestsTable) {
        htmlContent += `<p style="color:red;"><strong>Regression Test Case</strong></p>
          ${regressionTestsTable}`;
      }

      if (crashTestsTable) {
        htmlContent += `<p style="color:red;"><strong>Crash Test</strong></p>
          ${crashTestsTable}`;
      }

      if (notRunTestsTable) {
        htmlContent += `<p style="color:red;"><strong>Not Run Test Case</strong></p>
          ${notRunTestsTable}`;
      }

      if (
        lastVersion !== null &&
        newPassTestsTable === null &&
        regressionTestsTable === null &&
        notRunTestsTable === null
      ) {
        htmlContent +=
          "<p>None new Pass & Regression Test Case of this test.</p>";
      }
    }

    htmlContent += "<p>Thanks,<br>WebNN Team</p>";
    mailOptions.html = htmlContent;

    await transporter.verify();
    await transporter.sendMail(mailOptions);

    return true;
  } catch (e) {
    console.log(`>>> Send mail error: ${e.message}`);
    return false;
  } finally {
    transporter.close();
  }
}

module.exports = { sendMail };
