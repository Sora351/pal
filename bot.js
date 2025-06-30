// Placeholder for bot.js content
// Puppeteer automation logic
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { watchEmailForResponse } = require('./emailWatcher');

let globalBrowserInstance = null; // Renamed to avoid conflict with local browser in startBot
// Removed page global as it will be context-specific

let isRunning = false;
let currentConfig = null;
let sendUpdateToServer; 
let currentLineIndexGlobal = 0; // Renamed for clarity
let totalLinesGlobal = 0;       // Renamed for clarity
let stopRequested = false;

const INPUT_FILE_PATH_DEFAULT = path.join(__dirname, 'input.txt');
const OUTPUT_LOG_PATH_DEFAULT = path.join(__dirname, 'logs/output.log');

// Helper function for random delays
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function logMessage(message, type = 'info', lineNum = null) {
    const timestamp = new Date().toISOString();
    const linePrefix = lineNum ? `Line ${lineNum}: ` : '';
    const logEntry = `${timestamp} [${type.toUpperCase()}] ${linePrefix}${message}\n`;
    // console.log(logEntry.trim()); // Already logged by server or direct console.log in functions

    if (sendUpdateToServer) {
        sendUpdateToServer({ type: 'log', data: logEntry });
    }

    const outputLogPath = currentConfig?.outputLogPath || OUTPUT_LOG_PATH_DEFAULT;
    try {
        // Append to file only if it's not a simple status update for the UI
        if (type !== 'status_detail_internal') { // Avoid logging internal UI cues to file
             await fs.appendFile(outputLogPath, logEntry);
        }
    } catch (err) {
        console.error(`Failed to write to output log ${outputLogPath}:`, err);
        if (sendUpdateToServer) {
            // Also send this critical error to UI log
            const errorLogEntry = `${timestamp} [ERROR] Failed to write to output log ${outputLogPath}: ${err.message}\n`;
            sendUpdateToServer({ type: 'log', data: errorLogEntry });
        }
    }
}


async function initializeGlobalBrowser() {
    if (globalBrowserInstance) return;
    try {
        logMessage('Initializing global browser instance...');
        const launchOptions = {
            headless: true, // Consider "new" for newer Puppeteer versions if issues arise
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                // Common arguments to try and reduce fingerprinting, though effectiveness varies
                '--window-size=1366,768', // Set a common window size
                '--disable-blink-features=AutomationControlled', // Attempt to hide automation
                '--disable-infobars',
                // '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36' // Example, can be overridden per page
            ]
        };
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        globalBrowserInstance = await puppeteer.launch(launchOptions);
        logMessage('Global browser instance initialized.');
    } catch (error) {
        logMessage(`Error initializing global browser: ${error.message}`, 'error');
        throw error;
    }
}

async function closeGlobalBrowser() {
    if (globalBrowserInstance) {
        try {
            await globalBrowserInstance.close();
            logMessage('Global browser instance closed.');
        } catch (error) {
            logMessage(`Error closing global browser: ${error.message}`, 'error');
        }
        globalBrowserInstance = null;
    }
}

// Enhanced click function
async function humanLikeClick(page, selector, currentLineNum) {
    logMessage(`Attempting to click element: ${selector}`, 'debug', currentLineNum);
    const element = await page.waitForSelector(selector, { visible: true, timeout: 30000 });
    if (!element) {
        logMessage(`Element ${selector} not found for clicking.`, 'warn', currentLineNum);
        return;
    }
    // Scroll into view if needed (Puppeteer often does this, but explicit can be good)
    await element.evaluate(el => el.scrollIntoViewIfNeeded());
    await page.waitForTimeout(getRandomDelay(100, 300)); // Small pause after scroll
    
    await element.hover();
    logMessage(`Hovered over element: ${selector}`, 'debug', currentLineNum);
    await page.waitForTimeout(getRandomDelay(200, 500)); // Pause after hover
    
    await element.click(); // Puppeteer's click tries to be human-like
    logMessage(`Clicked element: ${selector}`, 'success', currentLineNum);
}

// Enhanced type function
async function humanLikeType(page, selector, text, currentLineNum) {
    logMessage(`Attempting to type "${text}" into element: ${selector}`, 'debug', currentLineNum);
    const element = await page.waitForSelector(selector, { visible: true, timeout: 30000 });
     if (!element) {
        logMessage(`Element ${selector} not found for typing.`, 'warn', currentLineNum);
        return;
    }
    await element.evaluate(el => el.scrollIntoViewIfNeeded());
    await page.waitForTimeout(getRandomDelay(100, 300));
    await element.click(); // Focus the element first
    await page.waitForTimeout(getRandomDelay(100, 300)); // Pause after focus

    for (const char of text) {
        await page.keyboard.type(char, { delay: getRandomDelay(80, 200) });
    }
    logMessage(`Finished typing "${text}" into element: ${selector}`, 'success', currentLineNum);
}


async function processLine(line, lineNum) {
    if (!isRunning || stopRequested) {
        logMessage('Processing stopped or stop requested.', 'info', lineNum);
        return;
    }

    const parts = line.split(':');
    if (parts.length < 2) {
        logMessage(`Skipping invalid line: ${line}`, 'warn', lineNum);
        return;
    }
    const [text1, text2] = parts.map(p => p.trim());

    logMessage(`Processing line ${lineNum}: text1=${text1}, text2=${text2}`, 'info');

    let browserContext = null;
    let page = null;

    try {
        if (!globalBrowserInstance) {
            logMessage('Global browser not initialized. Attempting to initialize.', 'warn', lineNum);
            await initializeGlobalBrowser();
            if (!globalBrowserInstance) throw new Error("Failed to initialize global browser.");
        }

        browserContext = await globalBrowserInstance.createIncognitoBrowserContext();
        page = await browserContext.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        // More robust user agent list could be used and picked randomly
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36');
        logMessage('Incognito browser context and page created.', 'debug', lineNum);
        
        await page.goto(currentConfig.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        logMessage(`Navigated to ${currentConfig.targetUrl}`, 'info', lineNum);
        await page.waitForTimeout(getRandomDelay(500, 2000));

        // Click Button 1
        if (currentConfig.button1Selector) {
            await humanLikeClick(page, currentConfig.button1Selector, lineNum);
            await page.waitForTimeout(getRandomDelay(500, 2000));
        }

        // Click Button 2
        if (currentConfig.button2Selector) {
            await humanLikeClick(page, currentConfig.button2Selector, lineNum);
            await page.waitForTimeout(getRandomDelay(500, 2000));
        }

        // Input text1
        if (currentConfig.inputField1Selector && text1) {
            await humanLikeType(page, currentConfig.inputField1Selector, text1, lineNum);
            await page.waitForTimeout(getRandomDelay(500, 2000));
        }

        // Input text2
        if (currentConfig.inputField2Selector && text2) {
            await humanLikeType(page, currentConfig.inputField2Selector, text2, lineNum);
            await page.waitForTimeout(getRandomDelay(500, 2000));
        }

        // Click Submit Button
        if (currentConfig.submitButtonSelector) {
            await humanLikeClick(page, currentConfig.submitButtonSelector, lineNum);
            await page.waitForTimeout(getRandomDelay(500, 2000)); // Wait after submit
        }

        logMessage('Waiting for email response (30-60 seconds)...', 'info', lineNum);
        if (sendUpdateToServer) {
            sendUpdateToServer({ type: 'status_detail', data: 'Waiting for email...' });
        }

        // The watchEmailForResponse function now takes the full emailConfig object,
        // which includes subjectFilter, bodyKeywordFilter, and extractionRegex.
        // The second argument (previously filterRegex) is removed.
        const emailResult = await watchEmailForResponse(
            currentConfig.emailConfig, 
            (emailUpdate) => { 
                if (sendUpdateToServer) sendUpdateToServer({ type: 'log', data: `EMAIL_WATCHER: ${emailUpdate}\n`});
            }
        );

        const resultLogEntry = `Input: ${line} | EmailData: ${emailResult || 'NOT_FOUND'}`;
        if (emailResult) {
            logMessage(`Email response received and extracted: ${emailResult}`, 'success', lineNum);
            // logMessage(resultLogEntry, 'info', lineNum); // Log to file via logMessage
        } else {
            logMessage('No relevant email response received within timeout.', 'warn', lineNum);
            // logMessage(resultLogEntry, 'warn', lineNum); // Log to file via logMessage
        }
        // Explicitly log the final result to the file through logMessage for consistency
        await logMessage(resultLogEntry, emailResult ? 'info' : 'warn', lineNum);


    } catch (error) {
        logMessage(`Error processing line "${line}": ${error.message}`, 'error', lineNum);
        // await fs.appendFile(currentConfig.outputLogPath || OUTPUT_LOG_PATH_DEFAULT, `Input: ${line} | Error: ${error.message}\n`);
        // Log error to file via logMessage
        await logMessage(`Input: ${line} | Error: ${error.message}`, 'error', lineNum);

        if (page && !page.isClosed()) {
            try {
                const screenshotPath = path.join(__dirname, 'logs', `error_screenshot_line_${lineNum}_${Date.now()}.png`);
                await page.screenshot({ path: screenshotPath });
                logMessage(`Screenshot taken: ${screenshotPath}`, 'debug', lineNum);
            } catch (ssError) {
                logMessage(`Failed to take screenshot: ${ssError.message}`, 'error', lineNum);
            }
        }
    } finally {
        if (page) {
            try {
                await page.close();
                logMessage('Page closed.', 'debug', lineNum);
            } catch (e) {
                logMessage(`Error closing page: ${e.message}`, 'warn', lineNum);
            }
        }
        if (browserContext) {
            try {
                await browserContext.close();
                logMessage('Incognito browser context closed.', 'debug', lineNum);
            } catch (e) {
                logMessage(`Error closing browser context: ${e.message}`, 'warn', lineNum);
            }
        }
    }
}

async function startBot(config, updateCallback) {
    if (isRunning) {
        logMessage('Bot is already running.', 'warn');
        if (updateCallback) updateCallback({ type: 'status', data: { message: 'Bot is already running.', status: 'running' }});
        return;
    }

    logMessage('Starting bot...');
    isRunning = true;
    stopRequested = false;
    currentConfig = config;
    sendUpdateToServer = updateCallback; 

    currentLineIndexGlobal = 0;
    totalLinesGlobal = 0;

    const inputFilePath = config.inputFilePath || INPUT_FILE_PATH_DEFAULT;
    const outputLogPath = config.outputLogPath || OUTPUT_LOG_PATH_DEFAULT;

    try {
        await fs.mkdir(path.dirname(outputLogPath), { recursive: true });
    } catch (dirError) {
        logMessage(`Error creating log directory ${path.dirname(outputLogPath)}: ${dirError.message}`, 'error');
        isRunning = false;
        if (sendUpdateToServer) sendUpdateToServer({ type: 'status', data: { message: `Error creating log directory: ${dirError.message}`, status: 'error' }});
        return;
    }

    if (sendUpdateToServer) {
        sendUpdateToServer({ type: 'status', data: { message: 'Bot starting...', status: 'running', currentLine: 0, totalLines: 0 } });
    }

    try {
        await initializeGlobalBrowser(); // Initialize the single global browser instance

        const fileContent = await fs.readFile(inputFilePath, 'utf8');
        const lines = fileContent.split('\n').filter(line => line.trim() !== '');
        totalLinesGlobal = lines.length;

        if (sendUpdateToServer) {
            sendUpdateToServer({ type: 'progress_init', data: { totalLines: totalLinesGlobal } });
        }
        logMessage(`Loaded ${totalLinesGlobal} lines from ${inputFilePath}`);

        for (let i = 0; i < lines.length; i++) {
            if (stopRequested) {
                logMessage('Bot stop was requested. Terminating processing.');
                break;
            }
            currentLineIndexGlobal = i + 1;
            if (sendUpdateToServer) {
                sendUpdateToServer({ type: 'progress_update', data: { currentLine: currentLineIndexGlobal, totalLines: totalLinesGlobal, lineContent: lines[i] } });
            }
            await processLine(lines[i], currentLineIndexGlobal);
            await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 3000))); // Delay between processing lines
        }

        logMessage('All lines processed.');
    } catch (error) {
        logMessage(`Bot error: ${error.message}`, 'error');
        if (sendUpdateToServer) sendUpdateToServer({ type: 'error', message: `Bot error: ${error.message}` });
    } finally {
        await closeGlobalBrowser(); // Close the single global browser instance
        isRunning = false;
        stopRequested = false;
        logMessage('Bot finished.');
        if (sendUpdateToServer) {
            sendUpdateToServer({ type: 'status', data: { message: 'Bot finished processing.', status: 'idle' } });
        }
    }
}

function stopBot() {
    if (!isRunning) {
        logMessage('Bot is not running.', 'warn');
        if (sendUpdateToServer) sendUpdateToServer({ type: 'status', data: { message: 'Bot is not running.', status: 'idle' } });
        return;
    }
    logMessage('Stop request received. Bot will stop after the current line processing completes.');
    stopRequested = true; 
    if (sendUpdateToServer) sendUpdateToServer({ type: 'status', data: { message: 'Bot stopping after current line...', status: 'stopping' } });
}

function getBotStatus() {
    return {
        isRunning,
        currentLine: currentLineIndexGlobal,
        totalLines: totalLinesGlobal,
        currentConfig: currentConfig ? "Configured" : "Not Configured"
    };
}

async function resetBot() {
    logMessage('Resetting bot...');
    if (isRunning) {
        stopBot(); 
        await new Promise(resolve => setTimeout(resolve, 2000)); 
    }
    await closeGlobalBrowser(); // Ensure global browser is closed
    isRunning = false;
    stopRequested = false;
    currentConfig = null; // Clear current config
    currentLineIndexGlobal = 0;
    totalLinesGlobal = 0;

    const outputLogPathDefault = path.join(__dirname, 'logs/output.log');
    const actualOutputLogPath = (currentConfig && currentConfig.outputLogPath) ? currentConfig.outputLogPath : outputLogPathDefault;
    try {
        await fs.writeFile(actualOutputLogPath, ''); 
        logMessage(`Output log file ${actualOutputLogPath} cleared.`);
    } catch (err) {
        logMessage(`Error clearing output log file ${actualOutputLogPath}: ${err.message}`, 'warn');
    }

    logMessage('Bot reset to initial state.');
    if (sendUpdateToServer) {
        sendUpdateToServer({ type: 'status', data: { message: 'Bot reset.', status: 'idle', currentLine: 0, totalLines: 0 } });
        sendUpdateToServer({ type: 'log_reset', message: 'Logs and bot state reset.' });
    }
}


module.exports = {
    startBot,
    stopBot,
    getBotStatus,
    resetBot,
    // logMessage // Potentially export if other modules need to log through this centralized function
};
