const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let pythonProcess = null;

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "LoopMaster SA3",
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Load the launcher UI first
    mainWindow.loadFile('launcher.html');
};

app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => {
    app.quit();
});

// Clean up Python process when Electron quits
app.on('will-quit', () => {
    if (pythonProcess) {
        console.log("Killing Python backend...");
        if (process.platform === 'win32') {
            spawn("taskkill", ["/pid", pythonProcess.pid, '/f', '/t']);
        } else {
            pythonProcess.kill('SIGINT');
        }
    }
});

// IPC listener from launcher to start backend
ipcMain.on('start-backend', (event, modelId) => {
    // modelId maps to [1-4] from launcher.html
    let modelName = 'medium';
    let extraArgs = ['--no-half'];

    if (modelId === '2') { modelName = 'small-music'; extraArgs = []; }
    if (modelId === '3') { modelName = 'small-sfx'; extraArgs = []; }
    if (modelId === '4') { modelName = 'medium-bf16'; extraArgs = []; }

    console.log(`Starting backend with model: ${modelName}`);

    // Show loading screen while we wait for Python
    mainWindow.loadFile('loading.html');

    const pythonExecutable = path.join(__dirname, '..', 'stable-audio-3', '.venv', 'Scripts', 'python.exe');
    const scriptPath = path.join(__dirname, '..', 'loopmaster', 'loopmaster-app', 'app_server.py');

    const args = ['-u', scriptPath, '--model', modelName, ...extraArgs];

    pythonProcess = spawn(pythonExecutable, args, {
        cwd: path.join(__dirname, '..') // Run from j:\projects\sa3
    });

    // Start polling the HTTP server to know when it's ready
    pollServerReady();

    pythonProcess.stdout.on('data', (data) => {
        const out = data.toString();
        console.log(`[Python]: ${out}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Python Error]: ${data.toString()}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`Python process exited with code ${code}`);
    });
});

function pollServerReady() {
    const checkInterval = setInterval(() => {
        http.get('http://127.0.0.1:7861/', (res) => {
            if (res.statusCode === 200) {
                clearInterval(checkInterval);
                console.log("Server is fully ready. Loading UI...");
                mainWindow.loadURL('http://127.0.0.1:7861/');
            }
        }).on('error', (err) => {
            // Still booting up...
        });
    }, 1000);
}
