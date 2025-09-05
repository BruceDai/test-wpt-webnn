This test infrastructure is to run WPT WebNN Conformance tests by
Chrome Canary on Windows11 platform, and send test report mail.

### Dependency
- Node.js

Download and install the latest [Node.js LTS release](https://nodejs.org/en/download).

- Chrome Canary

Download and install the latest [Chrome
Canary](https://www.google.com/chrome/canary/).

- Windows ML Runtime & Windows ML Runtime Intel OpenVINO
  Execution Provider to run WebNN on Windows ML
  backend (CPU, GPU and NPU)

Install [Windows App SDK](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads)

Install [Windows ML Runtime Intel OpenVINO Execution Provider](https://apps.microsoft.com/detail/9ph4ckr43xlp) from Microsoft Store


### Precondition for testing with own built ONNXRuntime and OpenVino EP dlls
Prepare for target ONNXRuntime libraries and ONNXRuntime OpenVino EP
libraries, then follow below two steps.

Step 1: Make a directory named "ONNXRuntime" under %ProgramFiles%, then
copy below ONNXRuntime libraries into it.
```
onnxruntime.dll
onnxruntime_providers_shared.dll
```

Step 2: Make a directory named "ONNXRuntime-OVEP" under %ProgramFiles%, then
copy below 
dependent OpenVino EP libraries into it.
```
onnxruntime_providers_openvino_plugin.dll
openvino.dll
openvino_intel_cpu_plugin.dll (for CPU inference)
openvino_intel_gpu_plugin.dll (for GPU inference)
openvino_intel_npu_plugin.dll (for NPU inference)
openvino_onnx_frontend.dll (for converting ONNX model to OpenVINO IR)
tbb12.dll (dependency of openvino.dll)
```

### Installing
```batch
> git clone https://github.com/BruceDai/test-wpt-webnn
> cd test-wpt-webnn
> npm install
```

### Configure settings in config.json
Please modify settings in config.json.

### Running Test
```batch
npm test
```