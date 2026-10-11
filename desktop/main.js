const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const os = require('os');

// Global safety against unhandled process crashes
process.on('uncaughtException', (err) => {
  console.warn('[Unweave Desktop] Handled uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[Unweave Desktop] Handled unhandled rejection:', reason);
});

let mainWindow = null;
let backendProcess = null;
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const BACKEND_PORT = 8010;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

// ──────────────────────────────────────────────
// Persistent Install Log File
// ──────────────────────────────────────────────
const LOG_FILE_PATH = path.join(app.getPath('userData'), 'unweave-install.log');
let logStream = null;

function initLogFile() {
  try {
    logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a', encoding: 'utf8' });
    const separator = '\n' + '='.repeat(72) + '\n';
    logStream.write(separator);
    logStream.write(`[Session Start] ${new Date().toISOString()}\n`);
    logStream.write(`[System] OS: ${os.type()} ${os.release()} (${os.arch()})\n`);
    logStream.write(`[System] Platform: ${process.platform}\n`);
    logStream.write(`[System] Node.js: ${process.version}\n`);
    logStream.write(`[System] Electron: ${process.versions.electron}\n`);
    logStream.write(`[System] App Packaged: ${app.isPackaged}\n`);
    logStream.write(`[System] User Data: ${app.getPath('userData')}\n`);
    logStream.write(separator);
  } catch (err) {
    console.warn('[Unweave Desktop] Could not create log file:', err.message);
  }
}

function writeLog(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  if (logStream) {
    try {
      logStream.write(line);
    } catch {
      // Silently continue if log write fails
    }
  }
  console.log(message);
}

function closeLogFile() {
  if (logStream) {
    try {
      logStream.write(`[Session End] ${new Date().toISOString()}\n`);
      logStream.end();
    } catch {
      // Silently continue
    }
    logStream = null;
  }
}

// ──────────────────────────────────────────────
// Backend Health Checker
// ──────────────────────────────────────────────
function checkBackendHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_URL}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ──────────────────────────────────────────────
// Runtime & Environment Paths
// ──────────────────────────────────────────────
const RUNTIME_DIR = path.join(app.getPath('userData'), 'runtime');
const VENV_DIR = path.join(RUNTIME_DIR, 'venv');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');
// Path to the portable embeddable Python executable (Windows-only fallback)
const EMBED_DIR = path.join(RUNTIME_DIR, 'python-embed');
const EMBED_PYTHON = path.join(EMBED_DIR, 'python.exe');

let engineState = {
  status: 'checking', // 'ready' | 'needs-setup' | 'installing' | 'error'
  progress: 0,
  step: 'Checking AI Engine...',
  detail: '',
  logs: []
};

function broadcastEngineStatus(updates = {}) {
  Object.assign(engineState, updates);
  // Write every status update to the persistent log file
  if (updates.step) writeLog(`[Status] ${updates.step}`);
  if (updates.detail) writeLog(`[Detail] ${updates.detail}`);
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('engine:status-update', engineState);
  }
}

// Returns the version tuple [major, minor] from a python executable, or null if it can't be determined.
function getPythonVersion(cmd, extraArgs = []) {
  try {
    const res = require('child_process').spawnSync(
      cmd,
      [...extraArgs, '-c', 'import sys; print(sys.version_info.major, sys.version_info.minor)'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    if (res.status === 0 && res.stdout) {
      const parts = res.stdout.trim().split(' ');
      if (parts.length === 2) {
        return [parseInt(parts[0], 10), parseInt(parts[1], 10)];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// Returns true if [major, minor] is within the compatible range for our AI packages (3.9 – 3.12).
function isPythonCompatible(ver) {
  if (!ver) return false;
  const [major, minor] = ver;
  return major === 3 && minor >= 9 && minor <= 12;
}

function findSystemPython() {
  const isWin = process.platform === 'win32';

  // ── Windows: try explicit per-version py launcher flags first ──
  if (isWin) {
    // Preferred versions in order: 3.11 > 3.10 > 3.12 > 3.9
    for (const minorVer of ['3.11', '3.10', '3.12', '3.9']) {
      try {
        const res = require('child_process').spawnSync(
          'py', [`-${minorVer}`, '--version'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        );
        if (res.status === 0) {
          const ver = getPythonVersion('py', [`-${minorVer}`]);
          if (isPythonCompatible(ver)) {
            writeLog(`[Setup] Found compatible Python ${ver[0]}.${ver[1]} via py -${minorVer}`);
            return `py -${minorVer}`;
          }
        }
      } catch { /* continue */ }
    }

    // ── Full-path scan for standard Python installer locations ──
    const localApp = process.env.LOCALAPPDATA || '';
    const progFiles = process.env.ProgramFiles || '';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || '';
    const winCandidates = [
      // User installs (LOCALAPPDATA)
      path.join(localApp, 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(localApp, 'Programs', 'Python', 'Python310', 'python.exe'),
      path.join(localApp, 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(localApp, 'Programs', 'Python', 'Python39', 'python.exe'),
      // System installs (Program Files)
      path.join(progFiles, 'Python311', 'python.exe'),
      path.join(progFiles, 'Python310', 'python.exe'),
      path.join(progFiles, 'Python312', 'python.exe'),
      path.join(progFiles, 'Python39', 'python.exe'),
      path.join(progFilesX86, 'Python311', 'python.exe'),
      path.join(progFilesX86, 'Python310', 'python.exe'),
      // PATH-based names as last resort
      'python311',
      'python310',
      'python312',
      'python',
      'python3',
    ];
    for (const cmd of winCandidates) {
      try {
        const ver = getPythonVersion(cmd);
        if (isPythonCompatible(ver)) {
          writeLog(`[Setup] Found compatible Python ${ver[0]}.${ver[1]} at: ${cmd}`);
          return cmd;
        }
      } catch { /* continue */ }
    }

    return null; // No compatible Python found on Windows
  }

  // ── macOS / Linux ──
  const unixCandidates = [
    'python3.11',
    'python3.10',
    'python3.12',
    'python3.9',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10',
    '/opt/homebrew/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10',
    '/usr/local/bin/python3.12',
    '/usr/bin/python3.11',
    '/usr/bin/python3.10',
    '/usr/bin/python3',
    'python3',
    'python',
  ];
  for (const cmd of unixCandidates) {
    try {
      const ver = getPythonVersion(cmd);
      if (isPythonCompatible(ver)) {
        writeLog(`[Setup] Found compatible Python ${ver[0]}.${ver[1]} at: ${cmd}`);
        return cmd;
      }
    } catch { /* continue */ }
  }

  return null; // No compatible Python found
}

// Downloads and sets up a portable Python 3.11 embeddable runtime for Windows.
// This is used as a zero-dependency fallback when no compatible Python is on the system.
async function downloadPortablePython() {
  const PYTHON_VERSION = '3.11.9';
  const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
  const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
  const EMBED_DIR = path.join(RUNTIME_DIR, 'python-embed');
  const EMBED_PYTHON = path.join(EMBED_DIR, 'python.exe');

  if (fs.existsSync(EMBED_PYTHON)) {
    writeLog('[Setup] Portable Python already exists, skipping download.');
    return EMBED_PYTHON;
  }

  writeLog(`[Setup] No compatible system Python found. Downloading portable Python ${PYTHON_VERSION}...`);
  broadcastEngineStatus({
    progress: 8,
    step: 'Downloading Python runtime...',
    detail: `No compatible Python found on your system. Auto-downloading Python ${PYTHON_VERSION} (~8 MB)...`,
    logs: [...engineState.logs, `[Setup] Downloading portable Python ${PYTHON_VERSION} from python.org...`]
  });

  if (!fs.existsSync(EMBED_DIR)) fs.mkdirSync(EMBED_DIR, { recursive: true });

  const zipPath = path.join(RUNTIME_DIR, 'python-embed.zip');

  // Download zip
  await new Promise((resolve, reject) => {
    const https = require('https');
    const file = fs.createWriteStream(zipPath);
    const req = https.get(PYTHON_EMBED_URL, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download Python: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('Python download timed out. Check your internet connection.'));
    });
  });

  writeLog('[Setup] Python download complete. Extracting...');
  broadcastEngineStatus({
    progress: 10,
    step: 'Extracting Python runtime...',
    detail: 'Unpacking portable Python...',
    logs: [...engineState.logs, '[Setup] Extracting portable Python...']
  });

  // Extract using PowerShell on Windows (no external unzip dependency needed)
  await runCommand('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${EMBED_DIR}' -Force`
  ]);

  fs.unlinkSync(zipPath);

  // The embeddable package has pip disabled and import paths locked down.
  // We must patch the ._pth file to enable site-packages, then bootstrap pip.
  const pthFiles = fs.readdirSync(EMBED_DIR).filter(f => f.endsWith('._pth'));
  if (pthFiles.length > 0) {
    const pthPath = path.join(EMBED_DIR, pthFiles[0]);
    let pthContent = fs.readFileSync(pthPath, 'utf8');
    // Uncomment the 'import site' line so pip and installed packages are importable
    pthContent = pthContent.replace('#import site', 'import site');
    fs.writeFileSync(pthPath, pthContent, 'utf8');
    writeLog('[Setup] Patched ._pth file to enable site-packages.');
  }

  // Bootstrap pip into the embeddable python
  writeLog('[Setup] Bootstrapping pip into portable Python...');
  broadcastEngineStatus({
    progress: 12,
    step: 'Setting up package manager...',
    detail: 'Installing pip into the portable Python runtime...',
    logs: [...engineState.logs, '[Setup] Bootstrapping pip...']
  });

  const getPipPath = path.join(EMBED_DIR, 'get-pip.py');
  await new Promise((resolve, reject) => {
    const https = require('https');
    const file = fs.createWriteStream(getPipPath);
    const req = https.get(GET_PIP_URL, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download get-pip.py: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('pip download timed out.'));
    });
  });

  await runCommand(EMBED_PYTHON, [getPipPath, '--no-warn-script-location']);
  fs.unlinkSync(getPipPath);

  writeLog(`[Setup] Portable Python ${PYTHON_VERSION} is ready at: ${EMBED_PYTHON}`);
  return EMBED_PYTHON;
}

function runCommand(cmd, args, onData, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let actualCmd = cmd;
    let actualArgs = args;
    if (cmd === 'py -3') {
      actualCmd = 'py';
      actualArgs = ['-3', ...args];
    }
    const cmdStr = `${actualCmd} ${actualArgs.join(' ')}`;
    writeLog(`[Runtime Manager] Running: ${cmdStr}`);
    const proc = spawn(actualCmd, actualArgs, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let timedOut = false;
    let lastDataTime = Date.now();
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      const msg = `[TIMEOUT] Command timed out after ${Math.round(timeoutMs / 1000)}s: ${cmdStr}`;
      writeLog(msg);
      engineState.logs.push(msg);
      broadcastEngineStatus();
      try { proc.kill(); } catch {}
      reject(new Error(msg));
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      lastDataTime = Date.now();
      const text = data.toString();
      writeLog(`[stdout] ${text.trim()}`);
      if (onData) onData(text);
      engineState.logs.push(text.trim());
      if (engineState.logs.length > 200) engineState.logs.shift();
      broadcastEngineStatus();
    });

    proc.stderr.on('data', (data) => {
      lastDataTime = Date.now();
      const text = data.toString();
      writeLog(`[stderr] ${text.trim()}`);
      if (onData) onData(text);
      engineState.logs.push(text.trim());
      if (engineState.logs.length > 200) engineState.logs.shift();
      broadcastEngineStatus();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutTimer);
      if (timedOut) return;
      if (code === 0) {
        writeLog(`[Success] Command completed: ${cmdStr}`);
        resolve();
      } else {
        const errMsg = `Command ${cmd} exited with code ${code}`;
        writeLog(`[Error] ${errMsg}`);
        reject(new Error(errMsg));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutTimer);
      if (timedOut) return;
      writeLog(`[Error] Spawn error for ${cmd}: ${err.message}`);
      reject(err);
    });
  });
}

async function verifyVenvHealth(pythonOverride = null) {
  // Allow caller to supply the exact python to test (e.g. embed python).
  // On packaged builds fall back to the managed venv; in dev also accept the project-local venv.
  const devVenvPy = path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python');
  let pyToTest = pythonOverride;
  if (!pyToTest) {
    pyToTest = (isDev && fs.existsSync(devVenvPy)) ? devVenvPy : VENV_PYTHON;
  }

  if (!fs.existsSync(pyToTest)) {
    console.log('[Verifier] Python binary not found at:', pyToTest);
    return false;
  }

  // Only verify the packages we directly control. Demucs internals are tested
  // indirectly via torch + torchaudio which it depends on.
  // PyTorch cold-import on a fresh machine can take 15-30s — timeout is generous.
  const CHECK_TIMEOUT_MS = 30000;
  const verifyScript = [
    'import sys',
    'import torch',
    'import fastapi',
    'import uvicorn',
    'print("OK")',
  ].join('; ');

  return new Promise((resolve) => {
    const proc = spawn(pyToTest, ['-c', verifyScript], {
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      const ok = code === 0 && out.includes('OK');
      if (!ok) {
        console.warn('[Verifier] Health check failed. exit:', code, '| stderr:', stderr.slice(0, 400));
      }
      resolve(ok);
    });
    proc.on('error', (err) => {
      console.warn('[Verifier] Spawn error:', err.message);
      resolve(false);
    });
    const killer = setTimeout(() => {
      console.warn('[Verifier] Health check timed out after', CHECK_TIMEOUT_MS, 'ms — killing proc');
      try { proc.kill(); } catch {}
      resolve(false);
    }, CHECK_TIMEOUT_MS);
    proc.on('close', () => clearTimeout(killer));
  });
}

// ──────────────────────────────────────────────
// Automated AI Runtime Provisioner
// ──────────────────────────────────────────────
async function installRuntime() {
  if (engineState.status === 'installing') return;

  writeLog('[Setup] ====== Starting AI Engine initialization ======');
  broadcastEngineStatus({
    status: 'installing',
    progress: 5,
    step: 'Initializing AI Engine...',
    detail: 'Setting up dedicated environment...',
    logs: ['[Setup] Starting AI Engine initialization...']
  });

  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });

    // Resolve a compatible Python interpreter (3.9–3.12).
    // If none is found on the system, auto-download a portable Python 3.11 embeddable.
    let systemPython = findSystemPython();
    // Track whether we are using the portable embeddable Python.
    // The embeddable ZIP does NOT ship venv or ensurepip, so we must skip
    // venv creation and use the embed dir as the install target directly.
    let usingEmbedPython = false;

    if (!systemPython) {
      if (process.platform !== 'win32') {
        // On macOS/Linux: cannot auto-download — surface a clear message
        throw new Error(
          'No compatible Python (3.9–3.12) found on your system.\n' +
          'Please install Python 3.11 from https://www.python.org/downloads/ and relaunch Unweave.'
        );
      }
      // On Windows: silently download a portable Python 3.11 embeddable
      await downloadPortablePython();
      systemPython = EMBED_PYTHON;
      usingEmbedPython = true;
    }

    // Also treat it as embed mode if a previous install left the embed python
    // but no venv (e.g. the user clicked "Rebuild Runtime" after a partial run).
    if (!usingEmbedPython && systemPython === EMBED_PYTHON) {
      usingEmbedPython = true;
    }

    broadcastEngineStatus({
      progress: 15,
      step: usingEmbedPython ? 'Configuring portable Python runtime...' : 'Creating Python virtual environment...',
      detail: `Setting up isolated environment (${systemPython})...`,
      logs: [...engineState.logs, usingEmbedPython
        ? '[Setup] Using portable Python embed (skipping venv — not supported by embeddable Python)'
        : `[Setup] Creating virtual environment at ${VENV_DIR}...`]
    });

    // 1. Create Virtualenv if missing (only when NOT using embeddable Python)
    if (!usingEmbedPython && !fs.existsSync(VENV_PYTHON)) {
      try {
        await runCommand(systemPython, ['-m', 'venv', VENV_DIR]);
      } catch (venvErr) {
        console.warn('[Setup] Standard venv creation failed, trying with ensurepip fallback...', venvErr);
        await runCommand(systemPython, ['-m', 'venv', '--without-pip', VENV_DIR]);
        try {
          await runCommand(systemPython, ['-m', 'ensurepip', '--upgrade']);
        } catch {
          // Continue — pip may already be present
        }
      }
    }

    // Determine the active Python to use for all subsequent pip/verify steps.
    // When using the embeddable Python we install packages directly into the embed
    // dir (pip was bootstrapped into it by downloadPortablePython), so there is no
    // venv. All steps below use `activePython` rather than the module-level VENV_PYTHON.
    const activePython = usingEmbedPython ? EMBED_PYTHON : VENV_PYTHON;
    writeLog(`[Setup] Active Python for install steps: ${activePython}`);

    // 2. Upgrade pip
    broadcastEngineStatus({
      progress: 25,
      step: 'Updating package installer (pip)...',
      detail: 'Configuring package manager...',
      logs: [...engineState.logs, '[Setup] Upgrading pip...']
    });
    try {
      await runCommand(activePython, [
        '-m', 'pip', 'install', '--upgrade', 'pip',
        '--no-warn-script-location', '--quiet'
      ]);
    } catch {
      // Continue — a slightly older pip is fine
    }

    // 3. Pre-install PyTorch with the official index URL so the correct platform
    //    wheel is selected (MPS for Apple Silicon, CUDA for NVIDIA, CPU otherwise).
    //    This MUST happen before requirements.txt because requirements.txt does
    //    not specify an index URL and pip may resolve the wrong wheel.
    broadcastEngineStatus({
      progress: 40,
      step: 'Installing PyTorch AI Engine...',
      detail: 'Downloading PyTorch with hardware acceleration support (~1-2 minutes)...',
      logs: [...engineState.logs, '[Setup] Installing PyTorch & torchaudio...']
    });

    const torchIndexUrl = 'https://download.pytorch.org/whl/cpu';
    const TORCH_TIMEOUT = 900000; // 15 minutes for PyTorch download (500MB-1GB)
    try {
      await runCommand(activePython, [
        '-m', 'pip', 'install',
        'torch', 'torchaudio',
        '--extra-index-url', torchIndexUrl,
        '--prefer-binary',
        '--only-binary', 'torch,torchaudio',
        '--no-warn-script-location'
      ], null, TORCH_TIMEOUT);
    } catch (torchErr) {
      writeLog('[Setup] PyTorch install with index URL failed: ' + torchErr.message);
      // Fallback: try without index URL (may still work on many systems)
      await runCommand(activePython, [
        '-m', 'pip', 'install',
        'torch', 'torchaudio',
        '--prefer-binary',
        '--only-binary', 'torch,torchaudio',
        '--no-warn-script-location'
      ], null, TORCH_TIMEOUT);
    }

    // 4. Install remaining requirements
    const backendDir = isDev
      ? path.join(__dirname, '..', 'backend')
      : path.join(process.resourcesPath, 'backend');

    const reqFile = path.join(backendDir, 'requirements.txt');

    broadcastEngineStatus({
      progress: 60,
      step: 'Installing Demucs & Backend Dependencies...',
      detail: 'Installing AI model library and API server packages...',
      logs: [...engineState.logs, '[Setup] Installing backend packages...']
    });

    if (fs.existsSync(reqFile)) {
      try {
        await runCommand(activePython, [
          '-m', 'pip', 'install', '-r', reqFile,
          '--prefer-binary',
          '--only-binary', 'lameenc,soxr',
          '--no-warn-script-location'
        ]);
      } catch (reqErr) {
        console.warn('[Setup] requirements.txt install failed, trying minimal fallback...', reqErr.message);
        broadcastEngineStatus({
          progress: 65,
          step: 'Retrying with minimal package set...',
          detail: 'Some optional packages failed — installing core dependencies only...',
          logs: [...engineState.logs, '[Setup] Retrying minimal install...']
        });
        // Minimal fallback — guaranteed to work on all platforms with binary wheels
        await runCommand(activePython, [
          '-m', 'pip', 'install',
          'fastapi', 'uvicorn[standard]', 'python-multipart', 'aiofiles',
          'numpy<2', 'scipy', 'demucs', 'imageio-ffmpeg',
          '--prefer-binary',
          '--only-binary', 'lameenc,soxr',
          '--no-warn-script-location'
        ]);
      }
    } else {
      await runCommand(activePython, [
        '-m', 'pip', 'install',
        'fastapi', 'uvicorn[standard]', 'python-multipart', 'aiofiles',
        'numpy<2', 'scipy', 'demucs', 'imageio-ffmpeg',
        '--prefer-binary',
        '--only-binary', 'lameenc,soxr',
        '--no-warn-script-location'
      ]);
    }

    // 5. Verify installation — give extra time for PyTorch first-launch JIT caching
    broadcastEngineStatus({
      progress: 85,
      step: 'Verifying AI Engine health & hardware acceleration...',
      detail: 'Checking Apple Silicon Metal (MPS) / CUDA / CPU acceleration (may take ~30s)...',
      logs: [...engineState.logs, '[Setup] Running health verification...']
    });

    const isHealthy = await verifyVenvHealth(activePython);
    if (!isHealthy) {
      throw new Error(
        'AI Engine verification failed. Please check your Python version (3.9–3.12 required) ' +
        'and internet connection, then click "Rebuild Runtime" to try again.'
      );
    }

    // 6. Start Backend
    broadcastEngineStatus({
      progress: 95,
      step: 'Starting local backend server...',
      detail: 'Launching API daemon on port 8010...',
      logs: [...engineState.logs, '[Setup] Starting backend daemon...']
    });

    await startBackendSupervisor();

    writeLog('[SUCCESS] AI Engine setup completed successfully!');
    broadcastEngineStatus({
      status: 'ready',
      progress: 100,
      step: 'AI Engine Ready!',
      detail: 'Unweave Studio is ready to separate stems.',
      logs: [...engineState.logs, '[SUCCESS] Setup completed successfully!']
    });
  } catch (err) {
    writeLog(`[FATAL ERROR] Installation failed: ${err.message}`);
    broadcastEngineStatus({
      status: 'error',
      progress: 0,
      step: 'Setup encountered an issue',
      detail: err.message || 'Failed to install AI Engine dependencies.',
      logs: [...engineState.logs, `[Error] ${err.message}`]
    });
  }
}

// ──────────────────────────────────────────────
// Backend Process Supervisor
// ──────────────────────────────────────────────
async function startBackendSupervisor() {
  const isRunning = await checkBackendHealth();
  if (isRunning) {
    console.log('[Unweave Desktop] Backend is already running on port', BACKEND_PORT);
    broadcastEngineStatus({ status: 'ready', progress: 100, step: 'AI Engine Ready' });
    return;
  }

  const backendDir = isDev
    ? path.join(__dirname, '..', 'backend')
    : path.join(process.resourcesPath, 'backend');

  const devVenvPy = path.join(backendDir, '.venv', 'bin', 'python');
  const devWorkspacePy = path.join(process.env.HOME || '', 'Workspace', 'Projects', 'Unweave', 'backend', '.venv', 'bin', 'python');

  let launchCmd = null;

  if (isDev && fs.existsSync(devVenvPy)) {
    launchCmd = devVenvPy;
  } else if (isDev && fs.existsSync(devWorkspacePy)) {
    launchCmd = devWorkspacePy;
  } else if (fs.existsSync(VENV_PYTHON)) {
    launchCmd = VENV_PYTHON;
  } else if (process.platform === 'win32' && fs.existsSync(EMBED_PYTHON)) {
    // Fallback: use portable embeddable Python directly (no venv needed — pip
    // packages were installed into its site-packages by installRuntime).
    writeLog('[Supervisor] No venv found — using portable embed Python to launch backend.');
    launchCmd = EMBED_PYTHON;
  }

  if (!launchCmd) {
    console.log('[Unweave Desktop] No verified virtual environment found. Requesting setup...');
    broadcastEngineStatus({
      status: 'needs-setup',
      progress: 0,
      step: 'First-Launch Setup Required',
      detail: 'Click "Initialize AI Engine" to set up Python and Demucs.'
    });
    // Auto-trigger setup on first launch
    setTimeout(() => {
      installRuntime().catch(() => {});
    }, 1200);
    return;
  }

  console.log(`[Unweave Desktop] Starting AI Backend process: ${launchCmd} in ${backendDir}...`);

  try {
    backendProcess = spawn(launchCmd, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)], {
      cwd: backendDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    backendProcess.on('error', (err) => {
      console.warn('[Unweave Desktop] Backend spawn error:', err.message);
      backendProcess = null;
      broadcastEngineStatus({ status: 'error', detail: err.message });
    });

    backendProcess.stdout.on('data', (data) => {
      console.log(`[Backend stdout] ${data.toString().trim()}`);
    });

    backendProcess.stderr.on('data', (data) => {
      console.log(`[Backend stderr] ${data.toString().trim()}`);
    });

    backendProcess.on('exit', (code, signal) => {
      console.log(`[Unweave Desktop] Backend process exited with code ${code} signal ${signal}`);
      backendProcess = null;
    });

    // Wait up to 25 seconds for backend to be fully online
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ok = await checkBackendHealth();
      if (ok) {
        console.log('[Unweave Desktop] AI Backend is online and ready.');
        broadcastEngineStatus({ status: 'ready', progress: 100, step: 'AI Engine Ready' });
        break;
      }
    }
  } catch (err) {
    console.warn('[Unweave Desktop] Could not start local Python backend:', err.message);
    broadcastEngineStatus({ status: 'error', detail: err.message });
  }
}

function stopBackendProcess() {
  if (backendProcess) {
    writeLog('[Shutdown] Terminating backend daemon...');
    try {
      if (process.platform === 'win32') {
        // Windows: SIGTERM is not supported; use taskkill to forcefully end the process tree
        try {
          execSync(`taskkill /F /T /PID ${backendProcess.pid}`, { windowsHide: true });
        } catch {
          // taskkill may fail if process already exited
        }
        backendProcess = null;
      } else {
        backendProcess.kill('SIGTERM');
        setTimeout(() => {
          if (backendProcess) {
            backendProcess.kill('SIGKILL');
            backendProcess = null;
          }
        }, 2000);
      }
    } catch {
      // Ignored on exit
    }
  }
}

// ──────────────────────────────────────────────
// Dispatch Menu Action to Frontend
// ──────────────────────────────────────────────
function sendMenuAction(action, payload) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('menu-action', action, payload);
  }
}

// ──────────────────────────────────────────────
// Mac-Class Native Menu Bar
// ──────────────────────────────────────────────
function buildMacMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        {
          label: `About ${app.name}`,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Unweave',
              message: 'Unweave Studio',
              detail: 'AI Audio Stem Separation & Studio DAW Suite\nVersion 1.0.0\nPowered by Hybrid Transformer Demucs & Web Audio Engine.\nCopyright © 2025-2026 Unweave.',
              buttons: ['OK']
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('navigate', 'export')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Studio Project',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-project')
        },
        {
          label: 'Save Project As...',
          accelerator: 'Shift+CmdOrCtrl+S',
          click: () => sendMenuAction('save-project-as')
        },
        {
          label: 'Open Project Manager...',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendMenuAction('open-project-manager')
        },
        { type: 'separator' },
        {
          label: 'Import Audio Files...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('import-audio')
        },
        { type: 'separator' },
        {
          label: 'Export Master Mixdown...',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendMenuAction('export-mixdown')
        },
        {
          label: 'Export All Stems (ZIP)...',
          accelerator: 'Shift+CmdOrCtrl+E',
          click: () => sendMenuAction('export-all-stems')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendMenuAction('undo')
        },
        {
          label: 'Redo',
          accelerator: 'Shift+CmdOrCtrl+Z',
          click: () => sendMenuAction('redo')
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Transport',
      submenu: [
        {
          label: 'Play / Pause',
          accelerator: 'Space',
          click: () => sendMenuAction('toggle-play')
        },
        {
          label: 'Stop & Rewind to Start',
          accelerator: '0',
          click: () => sendMenuAction('stop-rewind')
        },
        { type: 'separator' },
        {
          label: 'Skip Forward 5 Seconds',
          accelerator: 'Right',
          click: () => sendMenuAction('seek-forward')
        },
        {
          label: 'Skip Backward 5 Seconds',
          accelerator: 'Left',
          click: () => sendMenuAction('seek-backward')
        }
      ]
    },
    {
      label: 'Track',
      submenu: [
        {
          label: 'Add Audio Track',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendMenuAction('add-track')
        },
        {
          label: 'Split Clip at Playhead',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendMenuAction('split-clip')
        },
        {
          label: 'Merge Selected Layers...',
          accelerator: 'CmdOrCtrl+M',
          click: () => sendMenuAction('open-merge-dialog')
        },
        { type: 'separator' },
        {
          label: 'Toggle Magnet Snap Grid',
          accelerator: 'CmdOrCtrl+G',
          click: () => sendMenuAction('toggle-snap')
        },
        {
          label: 'Reset All Tracks to Defaults',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => sendMenuAction('reset-tracks')
        }
      ]
    },
    {
      label: 'Mixer',
      submenu: [
        {
          label: 'Reset Master Volume (0.0 dB)',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => sendMenuAction('reset-master-volume')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Separate Workspace',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendMenuAction('navigate', 'separate')
        },
        {
          label: 'Timeline Editor',
          accelerator: 'CmdOrCtrl+2',
          click: () => sendMenuAction('navigate', 'editor')
        },
        {
          label: 'Live Mixer Console',
          accelerator: 'CmdOrCtrl+3',
          click: () => sendMenuAction('navigate', 'mixer')
        },
        {
          label: '8D Spatial Mixer',
          accelerator: 'CmdOrCtrl+4',
          click: () => sendMenuAction('navigate', 'spatial')
        },
        {
          label: 'Export Hub',
          accelerator: 'CmdOrCtrl+5',
          click: () => sendMenuAction('navigate', 'export')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Setup / Repair AI Engine...',
          click: () => {
            sendMenuAction('open-engine-setup');
            installRuntime().catch(() => {});
          }
        },
        {
          label: 'Open Unweave Data Folder',
          click: async () => {
            await shell.openPath(app.getPath('userData'));
          }
        },
        { type: 'separator' },
        {
          label: 'Unweave Documentation',
          click: async () => {
            await shell.openExternal('https://github.com/Shlok-gupta08/unweave#readme');
          }
        },
        {
          label: 'GitHub Repository',
          click: async () => {
            await shell.openExternal('https://github.com/Shlok-gupta08/unweave');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ──────────────────────────────────────────────
// Create MainWindow
// ──────────────────────────────────────────────
async function createMainWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  const windowOptions = {
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: 'Unweave Studio',
    backgroundColor: '#09090b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  };

  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 14 };
  } else if (isWin) {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.titleBarOverlay = {
      color: '#000000',
      symbolColor: '#e4e4e7',
      height: 42
    };
  }

  mainWindow = new BrowserWindow(windowOptions);

  buildMacMenu();

  // Load URL or static production build
  if (isDev) {
    // Try to load Vite dev server
    const viteUrl = 'http://localhost:5180';
    const fallbackViteUrl = 'http://localhost:5173';

    mainWindow.loadURL(viteUrl).catch(() => {
      mainWindow.loadURL(fallbackViteUrl).catch(() => {
        mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
      });
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'frontend', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ──────────────────────────────────────────────
// Dedicated Project & Auto-Save File System
// ──────────────────────────────────────────────
const PROJECTS_DIR = path.join(app.getPath('userData'), 'projects');
const AUTOSAVE_DIR = path.join(PROJECTS_DIR, 'autosave');
const AUTOSAVE_AUDIO_DIR = path.join(AUTOSAVE_DIR, 'audio');

function ensureProjectDirs() {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    if (!fs.existsSync(AUTOSAVE_DIR)) fs.mkdirSync(AUTOSAVE_DIR, { recursive: true });
    if (!fs.existsSync(AUTOSAVE_AUDIO_DIR)) fs.mkdirSync(AUTOSAVE_AUDIO_DIR, { recursive: true });
  } catch (err) {
    console.warn('[Unweave Desktop] Failed to create project directories:', err.message);
  }
}

// Register IPC handlers for project storage
ipcMain.handle('project:get-autosave-info', async () => {
  ensureProjectDirs();
  const metaPath = path.join(AUTOSAVE_DIR, 'project_meta.json');
  const projectPath = path.join(AUTOSAVE_DIR, 'project.json');

  if (!fs.existsSync(projectPath)) {
    return { exists: false };
  }

  try {
    let meta = {};
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } else {
      const stats = fs.statSync(projectPath);
      meta = { lastSaved: stats.mtimeMs };
    }
    return { exists: true, meta };
  } catch (err) {
    console.warn('[Unweave Desktop] Error reading autosave info:', err.message);
    return { exists: false };
  }
});

ipcMain.handle('project:save-autosave-state', async (_event, payload) => {
  ensureProjectDirs();
  try {
    const projectPath = path.join(AUTOSAVE_DIR, 'project.json');
    const metaPath = path.join(AUTOSAVE_DIR, 'project_meta.json');

    const projectData = JSON.stringify(payload.data || payload, null, 2);
    fs.writeFileSync(projectPath, projectData, 'utf8');

    const meta = {
      songName: payload.meta?.songName || 'Untitled Session',
      stemCount: payload.meta?.stemCount || 0,
      trackCount: payload.meta?.trackCount || 0,
      lastSaved: Date.now(),
      songId: payload.meta?.songId || null,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

    return { success: true };
  } catch (err) {
    console.error('[Unweave Desktop] Error saving autosave state:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('project:load-autosave-state', async () => {
  ensureProjectDirs();
  const projectPath = path.join(AUTOSAVE_DIR, 'project.json');
  if (!fs.existsSync(projectPath)) return null;

  try {
    const raw = fs.readFileSync(projectPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Unweave Desktop] Error loading autosave state:', err);
    return null;
  }
});

ipcMain.handle('project:save-audio-file', async (_event, { filename, base64Data }) => {
  ensureProjectDirs();
  try {
    const filePath = path.join(AUTOSAVE_AUDIO_DIR, filename);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return { success: true, filePath };
  } catch (err) {
    console.error('[Unweave Desktop] Error saving audio file:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('project:load-audio-file', async (_event, { filename }) => {
  ensureProjectDirs();
  try {
    const filePath = path.join(AUTOSAVE_AUDIO_DIR, filename);
    if (!fs.existsSync(filePath)) return null;

    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  } catch (err) {
    console.error('[Unweave Desktop] Error loading audio file:', err);
    return null;
  }
});

ipcMain.handle('project:clear-autosave', async () => {
  ensureProjectDirs();
  try {
    const files = fs.readdirSync(AUTOSAVE_DIR);
    for (const f of files) {
      const fullPath = path.join(AUTOSAVE_DIR, f);
      if (f === 'audio') {
        const audioFiles = fs.readdirSync(fullPath);
        for (const af of audioFiles) {
          fs.unlinkSync(path.join(fullPath, af));
        }
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    return { success: true };
  } catch (err) {
    console.error('[Unweave Desktop] Error clearing autosave:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('project:open-projects-folder', async () => {
  ensureProjectDirs();
  await shell.openPath(PROJECTS_DIR);
  return { success: true, path: PROJECTS_DIR };
});

ipcMain.handle('project:get-projects-path', async () => {
  ensureProjectDirs();
  return PROJECTS_DIR;
});

// Engine Runtime Setup IPC APIs
ipcMain.handle('engine:get-status', async () => {
  return engineState;
});

ipcMain.handle('engine:start-install', async () => {
  installRuntime().catch(() => {});
  return { success: true };
});

ipcMain.handle('engine:repair', async () => {
  try {
    fs.rmSync(VENV_DIR, { recursive: true, force: true });
  } catch (err) {
    writeLog('[Repair] Could not clean venv: ' + err.message);
  }
  installRuntime().catch(() => {});
  return { success: true };
});

// Log file IPC APIs
ipcMain.handle('logs:open-file', async () => {
  try {
    if (fs.existsSync(LOG_FILE_PATH)) {
      await shell.openPath(LOG_FILE_PATH);
      return { success: true, path: LOG_FILE_PATH };
    } else {
      return { success: false, error: 'Log file not found yet. Logs will appear after the first setup attempt.' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('logs:get-path', async () => {
  return LOG_FILE_PATH;
});

// ──────────────────────────────────────────────
// App Lifecycle
// ──────────────────────────────────────────────
app.whenReady().then(async () => {
  initLogFile();
  ensureProjectDirs();
  writeLog('[Lifecycle] App ready — starting backend supervisor...');
  await startBackendSupervisor();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  writeLog('[Lifecycle] App quitting — stopping backend process...');
  stopBackendProcess();
  closeLogFile();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
