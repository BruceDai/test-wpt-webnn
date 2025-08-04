const os = require("os");
const path = require("path");
const csv = require("csv-parser");
const dayjs = require("dayjs");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const nodemailer = require("nodemailer");
const si = require("systeminformation");

const emailService = {
  serverConfig: {
    host: "ecsmtp.pdx.intel.com",
    port: 25,
    secure: false,
    auth: false,
  },
  from: "username@intel.com",
  to: ["username@intel.com"],
};

function getTimestamp(minute = false) {
  const timestamp = Date.now();
  let formattedTimestamp;
  if (minute === true) {
    formattedTimestamp = dayjs(timestamp).format("YYYYMMDDHHmm");
  } else {
    formattedTimestamp = dayjs(timestamp).format("MM/DD");
  }
  return formattedTimestamp;
}

async function getTestEnvironmentInfo(currentVersion) {
  const environmentInfo = {};
  environmentInfo["hostname"] = os.hostname();
  environmentInfo["platform"] = os.platform();
  environmentInfo["testUrl"] = "https://wpt.live/webnn/conformance_tests/";
  environmentInfo["chromeCanary"] = currentVersion;
  environmentInfo["testCommand"] =
    `chrome.exe --enable-features=WebMachineLearningNeuralNetwork,WebNNOnnxRuntime`;
  
  // This test command is for testing own built ORT and OV EP dlls
  // const ortDllsFolder = path.join(process.env.ProgramFiles, "ONNXRuntime");
  // const ortOVEPDllsFolder = path.join(
  //   process.env.ProgramFiles,
  //   "ONNXRuntime-OVEP",
  // );
  // environmentInfo["testCommand"] =
  //   `chrome.exe --enable-features=WebMachineLearningNeuralNetwork,WebNNOnnxRuntime --webnn-ort-library-path-for-testing=${ortDllsFolder} --webnn-ort-ep-library-path-for-testing=${ortOVEPDllsFolder} --allow-third-party-modules`;


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
        `powershell -Command "Get-CimInstance -ClassName Win32_PnPEntity | Where-Object { $_.Name -like '*AI Boost*' } | Select-Object Name,Manufacturer,DeviceID | ConvertTo-Json"`,
      )
        .toString()
        .trim();
      const npuInfo = JSON.parse(info);
      environmentInfo["npuName"] = npuInfo["Name"];
      const match = npuInfo["DeviceID"].match(".*DEV_(.{4})");
      environmentInfo["npuDeviceId"] = match
        ? match[1].toUpperCase()
        : "Unknown";
      // manually set version since it can't get with script
      environmentInfo["npuDriverVersion"] = "32.0.100.3159";
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
      const backend =
        "OV " +
        fileName.slice("conformance_tests_result-".length).toUpperCase();
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

function getTestsuiteName(link) {
  const startIndex = "https://wpt.live/webnn/conformance_tests/".length; // 41
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

function transformNotRunTests(test) {
  const result = {};
  for (const [key, urls] of Object.entries(test)) {
    const device = key.split("-")[0];
    urls.forEach((url) => {
      const htmlUrl = url.replace(".js", ".html") + `?${device}`;
      if (!result[url]) {
        result[url] = [];
      }
      if (!result[url].includes(htmlUrl)) {
        result[url].push(htmlUrl);
      }
    });
  }
  // Convert the object into the array format
  return Object.entries(result).map(([key, value]) => ({
    suiteName: getTestsuiteName(key),
    links: value,
  }));
}

async function formatResultsAsHTMLTable(
  currentVersion,
  lastVersion,
  csvFileArray,
  notRunTests,
) {
  const resultObj = {
    html: {
      environmentInfoTable: "",
      passRateTable: "",
      newPassTestsTable: "",
      regressionTestsTable: "",
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

  const environmentInfoRows = formattedEnvironmentInfo
    .map(
      ({ category, detail }) =>
        `<tr><td style="border: 1px solid black;">${category}</td><td style="border: 1px solid black;">${detail}</td></tr>`,
    )
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
        `<tr><td style="border: 1px solid black;">${passRate.backend}</td><td style="border: 1px solid black;">${((passRate.passNumber / passRate.totalNumber) * 100).toFixed(2)}% (${passRate.passNumber} / ${passRate.totalNumber})</td></tr>`,
    )
    .join("");
  const newPassTestsRows = summary.newPassTests
    .map(
      (test) =>
        `<tr><td style="border: 1px solid black;">${test.backend}</td><td style="border: 1px solid black;">${test.suiteName}</td><td style="border: 1px solid black;">${test.testName}</td></tr>`,
    )
    .join("");
  const regressionTestsRows = summary.regressionTests
    .map(
      (test) =>
        `<tr><td style="border: 1px solid black;">${test.backend}</td><td style="border: 1px solid black;">${test.suiteName}</td><td style="border: 1px solid black;">${test.testName}</td><td style="border: 1px solid black;">${test.message}</td></tr>`,
    )
    .join("");

  const transformedNotRunTests = transformNotRunTests(notRunTests);
  let notRunTestsArray = [];
  transformedNotRunTests.forEach((test) => {
    test.links.forEach((link) =>
      notRunTestsArray.push(
        `<tr><td style="border: 1px solid black;">${test.suiteName}</td><td style="border: 1px solid black;">${link}</td></tr>`,
      ),
    );
  });

  const notRunTestsRows = notRunTestsArray.join("");

  resultObj.html.environmentInfoTable = `
    <table style="border-collapse: collapse; width: 100%; table-layout: fixed;">
      <thead>
        <tr>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196);
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Category
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Details
          </th>
        </tr>
      </thead>
      <tbody>
        ${environmentInfoRows}
      </tbody>
    </table>
  `;

  resultObj.html.passRateTable = `
    <table style="border-collapse: collapse; width: 40%; table-layout: fixed;">
      <thead>
        <tr>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196);
            text-align: center; 
            vertical-align: middle; 
            color:white;
            min-width: 50px;
            width: 50px;
            max-width: 50px
          ">
            Backend
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Pass Rate
          </th>
        </tr>
      </thead>
      <tbody>
        ${passRateRows}
      </tbody>
    </table>
  `;

  resultObj.html.newPassTestsTable =
    summary.newPassTests.length > 0
      ? `
    <table style="border-collapse: collapse; width: 80%; table-layout: fixed;">
      <thead>
        <tr>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196);
            text-align: center; 
            vertical-align: middle; 
            color:white;
            min-width: 50px;
            width: 50px;
            max-width: 50px
          ">
            Backend
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Test Suite
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Test Case
          </th>
        </tr>
      </thead>
      <tbody>
        ${newPassTestsRows}
      </tbody>
    </table>
  `
      : null;

  resultObj.html.regressionTestsTable =
    summary.regressionTests.length > 0
      ? `
    <table style="border-collapse: collapse; width: 100%; table-layout: fixed;">
      <thead>
        <tr>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196);
            text-align: center; 
            vertical-align: middle; 
            color:white;
            min-width: 50px;
            width: 50px;
            max-width: 50px
          ">
            Backend
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Test Suite
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Test Case
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Message
          </th>
        </tr>
      </thead>
      <tbody>
        ${regressionTestsRows}
      </tbody>
    </table>
  `
      : null;

  resultObj.html.notRunTestsTable =
    notRunTestsArray.length > 0
      ? `
    <table style="border-collapse: collapse; width: 100%; table-layout: fixed;">
      <thead>
        <tr>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196);
            text-align: center; 
            vertical-align: middle; 
            color:white;
            min-width: 50px;
            width: 50px;
            max-width: 50px
          ">
            Test Suite
          </th>
          <th style="
            border: 1px solid black; 
            padding: 0 4px 0 4px;
            background-color:rgb(4,116,196); 
            text-align: center; 
            vertical-align: middle; 
            color:white
          ">
            Test URL
          </th>
        </tr>
      </thead>
      <tbody>
        ${notRunTestsRows}
      </tbody>
    </table>
  `
      : null;

  return resultObj;
}

async function sendMail(
  currentVersion,
  lastVersion,
  csvFileArray = [],
  notRunTests = {},
) {
  console.log(">>> Sending email...");
  const subject = `${getTimestamp()} - Nightly WPT WebNN Conformance Test Report by ${os.hostname()}`;
  let transporter = nodemailer.createTransport(emailService.serverConfig);

  try {
    let mailOptions = {
      from: emailService.from,
      to: emailService.to,
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

      csvFileArray.map((csvFile) => {
        mailOptions.attachments.push({
          filename: path.basename(csvFile),
          path: csvFile,
        });
      });

      const htmlResult = await formatResultsAsHTMLTable(
        currentVersion,
        lastVersion,
        csvFileArray,
        notRunTests,
      );
      const environmentInfoTable = htmlResult.html.environmentInfoTable;
      const passRateTable = htmlResult.html.passRateTable;
      htmlContent = `
        <p>Nightly WPT Conformance Test completed. Please review the details below:</p>
      `;

      htmlContent += `<p><strong>Test Environment Info</strong></p>
        ${environmentInfoTable}`;

      htmlContent += `<p><strong>Pass Rate</strong></p>
        ${passRateTable}`;

      const newPassTestsTable = htmlResult.html.newPassTestsTable;
      const regressionTestsTable = htmlResult.html.regressionTestsTable;
      const notRunTestsTable = htmlResult.html.notRunTestsTable;

      if (newPassTestsTable) {
        htmlContent += `<p style="color:green;"><strong>New Pass Test Case</strong></p>
          ${newPassTestsTable}`;
      }

      if (regressionTestsTable) {
        htmlContent += `<p style="color:red;"><strong>Regression Test Case</strong></p>
          ${regressionTestsTable}`;
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
