// Placeholder for server.js content
// Express.js API + UI server
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const { startBot, stopBot, getBotStatus, resetBot } = require('./bot'); // Assuming bot.js exports these

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOG_FILE = path.join(__dirname, 'logs/output.log'); // For sending logs to client

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

// --- WebSocket Setup ---
wss.on('connection', (ws) => {
    console.log('Client connected via WebSocket');
    ws.on('close', () => {
        console.log('Client disconnected');
    });
    // Send initial status or welcome message if needed
    // ws.send(JSON.stringify({ type: 'status', data: getBotStatus() }));
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// --- Configuration Management ---
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const rawData = fs.readFileSync(CONFIG_FILE);
            return JSON.parse(rawData);
        } catch (error) {
            console.error("Error reading or parsing config.json:", error);
            return {}; // Return empty object on error
        }
    }
    return {}; // Default empty config
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        broadcast({ type: 'config_saved', message: 'Configuration saved successfully.' });
    } catch (error) {
        console.error("Error writing config.json:", error);
        broadcast({ type: 'error', message: 'Failed to save configuration.' });
    }
}

app.get('/api/config', (req, res) => {
    res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
    saveConfig(req.body);
    res.json({ message: 'Configuration saved.' });
});

// --- Bot Control API Endpoints ---
app.post('/api/start', async (req, res) => {
    try {
        const config = loadConfig();
        if (!config.targetUrl) { // Basic validation
            return res.status(400).json({ message: 'Configuration is incomplete. Please set it up first.' });
        }
        await startBot(config, (update) => { // Pass broadcast function or specific handlers
            broadcast(update);
        });
        res.json({ message: 'Bot started.' });
    } catch (error) {
        console.error('Error starting bot:', error);
        broadcast({ type: 'error', message: `Error starting bot: ${error.message}` });
        res.status(500).json({ message: `Error starting bot: ${error.message}` });
    }
});

app.post('/api/stop', (req, res) => {
    try {
        stopBot();
        broadcast({ type: 'status', data: { message: "Bot stop requested.", status: "stopping" } });
        res.json({ message: 'Bot stop requested.' });
    } catch (error) {
        broadcast({ type: 'error', message: `Error stopping bot: ${error.message}` });
        res.status(500).json({ message: `Error stopping bot: ${error.message}` });
    }
});

app.post('/api/reset', (req, res) => {
    try {
        resetBot(); // Assuming resetBot clears logs or state
        // Clear the log file content if reset implies that
        if (fs.existsSync(LOG_FILE)) {
            fs.writeFileSync(LOG_FILE, '');
        }
        broadcast({ type: 'log_reset', message: 'Logs and bot state reset.' });
        broadcast({ type: 'status', data: { message: "Bot reset.", status: "idle" } });
        res.json({ message: 'Bot reset.' });
    } catch (error) {
        broadcast({ type: 'error', message: `Error resetting bot: ${error.message}` });
        res.status(500).json({ message: `Error resetting bot: ${error.message}` });
    }
});

// --- Log Streaming (Initial load and updates via WebSocket) ---
app.get('/api/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) {
        res.sendFile(LOG_FILE);
    } else {
        res.type('text/plain').send('Log file not found.');
    }
});

// Watch for log file changes and broadcast them (simple implementation)
// A more robust solution might use a library like 'chokidar'
let fsWait = false;
if (fs.existsSync(path.dirname(LOG_FILE))) { // Ensure logs directory exists
    fs.watch(LOG_FILE, (eventType, filename) => {
        if (filename && eventType === 'change') {
            if (fsWait) return;
            fsWait = setTimeout(() => {
                fsWait = false;
            }, 100); // Debounce

            fs.readFile(LOG_FILE, 'utf8', (err, data) => {
                if (err) {
                    console.error('Failed to read log file for broadcasting:', err);
                    return;
                }
                broadcast({ type: 'log_update', data: data });
            });
        }
    });
} else {
    console.warn(`Log directory ${path.dirname(LOG_FILE)} does not exist. Log watching disabled.`);
}


// --- Server Initialization ---
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Web interface available at http://localhost:${PORT}`);
    // Ensure config.json and logs/output.log exist
    if (!fs.existsSync(CONFIG_FILE)) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2));
        console.log(`${CONFIG_FILE} created.`);
    }
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
        console.log(`Log directory ${logDir} created.`);
    }
    if (!fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, '');
        console.log(`${LOG_FILE} created.`);
    }
});

// Export broadcast for bot.js and emailWatcher.js to send updates
module.exports = { broadcast };
