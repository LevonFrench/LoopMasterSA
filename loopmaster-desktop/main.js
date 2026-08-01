const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let pythonProcess = null;
let readinessCheck = null;
let startupTimeout = null;
let backendAttempt = 0;
let appIsQuitting = false;
let stopMessage = null;

const STARTUP_TIMEOUT_MS = 120000;
const BACKEND_STATE = Object.freeze({
    STOPPED: 'stopped',
    STARTING: 'starting',
    READY: 'ready',
    FAILED: 'failed',
    STOPPING: 'stopping'
});
let backendState = BACKEND_STATE.STOPPED;

const SA3_MODELS = new Set([
    'medium',
    'medium-bf16',
    'small-music',
    'small-sfx'
]);

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'LoopMaster SA3',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'launcher.html'));
};

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
    appIsQuitting = true;
    stopReadinessCheck();
    if (pythonProcess) {
        backendState = BACKEND_STATE.STOPPING;
        terminateChild(pythonProcess);
    }
});

function stopReadinessCheck() {
    if (readinessCheck) {
        clearInterval(readinessCheck);
        readinessCheck = null;
    }
    if (startupTimeout) {
        clearTimeout(startupTimeout);
        startupTimeout = null;
    }
}

function isCurrentAttempt(attempt, child = pythonProcess) {
    return attempt === backendAttempt && child === pythonProcess;
}

function showLauncherError(message) {
    if (appIsQuitting || !mainWindow || mainWindow.isDestroyed()) return;

    mainWindow.loadFile(path.join(__dirname, 'launcher.html'))
        .then(() => {
            if (!appIsQuitting && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('backend-error', message);
            }
        })
        .catch((error) => console.error(`Could not return to the launcher: ${error.message}`));
}

function terminateChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    try {
        if (process.platform === 'win32' && child.pid) {
            // /t also removes subprocesses that Python may have created.
            const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
            taskkill.on('error', (error) => {
                console.error(`Could not run taskkill for Python backend: ${error.message}`);
            });
        } else {
            child.kill('SIGINT');
        }
    } catch (error) {
        console.error(`Could not stop Python backend: ${error.message}`);
    }
}

function completeStop(attempt, child) {
    if (!isCurrentAttempt(attempt, child)) return;

    pythonProcess = null;
    stopReadinessCheck();
    const message = stopMessage;
    stopMessage = null;
    backendState = message ? BACKEND_STATE.FAILED : BACKEND_STATE.STOPPED;

    if (message) showLauncherError(message);
}

function stopBackend(attempt, message) {
    if (attempt !== backendAttempt) return;

    stopReadinessCheck();
    stopMessage = message;
    backendState = BACKEND_STATE.STOPPING;

    if (!pythonProcess) {
        completeStop(attempt, null);
        return;
    }
    terminateChild(pythonProcess);
}

function failBackend(attempt, message) {
    if (attempt !== backendAttempt || appIsQuitting) return;

    if (pythonProcess) {
        stopBackend(attempt, message);
        return;
    }

    stopReadinessCheck();
    backendState = BACKEND_STATE.FAILED;
    showLauncherError(message);
}

function startBackend(modelName) {
    if (backendState !== BACKEND_STATE.STOPPED && backendState !== BACKEND_STATE.FAILED) {
        console.log(`Ignoring duplicate backend start while state is ${backendState}.`);
        return;
    }
    if (!SA3_MODELS.has(modelName)) {
        showLauncherError(`Unsupported Stable Audio 3 model: ${modelName}`);
        return;
    }

    const attempt = ++backendAttempt;
    backendState = BACKEND_STATE.STARTING;
    stopMessage = null;
    const extraArgs = modelName === 'medium' ? ['--no-half'] : [];
    const pythonExecutable = path.join(__dirname, '..', 'stable-audio-3', '.venv', 'Scripts', 'python.exe');
    const scriptPath = path.join(__dirname, '..', 'loopmaster', 'loopmaster-app', 'app_server.py');
    const args = ['-u', scriptPath, '--model', modelName, ...extraArgs];

    console.log(`Starting Stable Audio 3 with model: ${modelName}`);
    mainWindow.loadFile(path.join(__dirname, 'loading.html'));

    let child;
    try {
        child = spawn(pythonExecutable, args, { cwd: path.join(__dirname, '..') });
    } catch (error) {
        failBackend(attempt, `Could not start Stable Audio 3: ${error.message}`);
        return;
    }
    pythonProcess = child;

    child.stdout.on('data', (data) => console.log(`[Python]: ${data}`));
    child.stderr.on('data', (data) => console.error(`[Python Error]: ${data}`));
    child.on('error', (error) => {
        if (!isCurrentAttempt(attempt, child)) return;
        console.error(`Python process failed to start: ${error.message}`);
        failBackend(attempt, `Could not start Stable Audio 3: ${error.message}`);
    });
    child.on('close', (code, signal) => {
        if (!isCurrentAttempt(attempt, child)) return;

        console.log(`Python process exited with code ${code}${signal ? ` (${signal})` : ''}`);
        if (backendState === BACKEND_STATE.STOPPING) {
            completeStop(attempt, child);
        } else if (backendState === BACKEND_STATE.STARTING) {
            pythonProcess = null;
            stopReadinessCheck();
            backendState = BACKEND_STATE.FAILED;
            showLauncherError(`Stable Audio 3 stopped before it was ready (exit code ${code}). Check the model and startup log, then try again.`);
        } else if (backendState === BACKEND_STATE.READY) {
            pythonProcess = null;
            backendState = BACKEND_STATE.FAILED;
            showLauncherError(`Stable Audio 3 stopped unexpectedly (exit code ${code}). Return to the launcher to retry.`);
        }
    });

    pollServerReady(attempt, child);
}

function pollServerReady(attempt, child) {
    stopReadinessCheck();
    readinessCheck = setInterval(() => {
        if (!isCurrentAttempt(attempt, child) || backendState !== BACKEND_STATE.STARTING) return;

        http.get('http://127.0.0.1:7861/', (res) => {
            if (res.statusCode === 200 && isCurrentAttempt(attempt, child) && backendState === BACKEND_STATE.STARTING) {
                stopReadinessCheck();
                backendState = BACKEND_STATE.READY;
                console.log('Server is fully ready. Loading UI...');
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('http://127.0.0.1:7861/');
            }
            res.resume();
        }).on('error', () => {
            // The backend is still booting.
        });
    }, 1000);
    startupTimeout = setTimeout(() => {
        if (!isCurrentAttempt(attempt, child) || backendState !== BACKEND_STATE.STARTING) return;
        stopBackend(attempt, 'Stable Audio 3 did not become ready within two minutes. The backend was stopped; check the model and port 7861, then retry.');
    }, STARTUP_TIMEOUT_MS);
}

ipcMain.on('start-backend', (_event, modelName) => startBackend(modelName));

ipcMain.on('stop-backend', () => {
    if (backendState === BACKEND_STATE.STARTING) {
        stopBackend(backendAttempt, 'Stable Audio 3 startup was stopped. You can choose a model and retry.');
    }
});
