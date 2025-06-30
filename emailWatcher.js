// Placeholder for emailWatcher.js content
// IMAP listener (checks every 60s)
const Imap = require('imap-simple'); // Using imap-simple as requested
const { simpleParser } = require('mailparser'); // To parse email content

let isWatching = false;
let emailCheckInterval = 60 * 1000; // 60 seconds
let lastCheckTime = new Date(0); // Initialize to a very old date
let imapConnection = null;
let currentEmailConfigForConnection = null; // Renamed to avoid confusion with parameter name
let emailWatcherLogCallback = null; // Callback for logging updates

function logEmailWatcher(message) {
    const logMessage = `EmailWatcher: ${message}`;
    console.log(logMessage);
    if (emailWatcherLogCallback) {
        emailWatcherLogCallback(logMessage);
    }
}

async function connectToImap(emailLoginConfig) { // Parameter renamed for clarity
    if (!emailLoginConfig || !emailLoginConfig.email || !emailLoginConfig.password || !emailLoginConfig.imapHost || !emailLoginConfig.imapPort) {
        logEmailWatcher('Error: Email login configuration is incomplete (email, password, host, port).');
        throw new Error('Email login configuration is incomplete.');
    }

    currentEmailConfigForConnection = emailLoginConfig; // Store current config for reconnects if needed

    const imapParams = { // Renamed to avoid conflict
        imap: {
            user: emailLoginConfig.email,
            password: emailLoginConfig.password,
            host: emailLoginConfig.imapHost,
            port: emailLoginConfig.imapPort,
            tls: emailLoginConfig.imapTls !== undefined ? emailLoginConfig.imapTls : true,
            authTimeout: 10000,
            tlsOptions: {
                rejectUnauthorized: false // Should be true in production with valid certs
            }
        }
    };

    try {
        logEmailWatcher(`Connecting to IMAP server ${emailLoginConfig.imapHost}:${emailLoginConfig.imapPort}...`);
        imapConnection = await Imap.connect(imapParams);
        logEmailWatcher('Successfully connected to IMAP server.');
        await imapConnection.openBox('INBOX');
        logEmailWatcher('INBOX opened.');
        // Reset lastCheckTime here, so each watch period starts fresh for its duration
        lastCheckTime = new Date(Date.now() - 10 * 60 * 1000); // Look back 10 mins initially for safety margin with UNSEEN
        // More precisely, lastCheckTime will be set to 'now' before first search in a watch session.
        return imapConnection;
    } catch (err) {
        logEmailWatcher(`IMAP connection error: ${err.message}`);
        imapConnection = null;
        throw err;
    }
}

async function disconnectImap() {
    if (imapConnection && imapConnection.state !== 'disconnected') {
        try {
            logEmailWatcher('Disconnecting from IMAP server...');
            await imapConnection.end();
            logEmailWatcher('Successfully disconnected from IMAP server.');
        } catch (err) {
            logEmailWatcher(`Error disconnecting from IMAP: ${err.message}`);
        } finally {
            imapConnection = null;
        }
    }
}

// Updated function to include new filters
async function searchAndProcessEmails(fullEmailConfig) {
    if (!imapConnection || imapConnection.state === 'disconnected') {
        logEmailWatcher('IMAP not connected. Attempting to reconnect...');
        try {
            // Use currentEmailConfigForConnection which holds only login details for reconnect
            await connectToImap(currentEmailConfigForConnection);
        } catch (reconnectError) {
            logEmailWatcher(`Failed to reconnect: ${reconnectError.message}`);
            return null;
        }
    }

    try {
        // Search for UNSEEN emails. 'SINCE' can be tricky with UNSEEN across different servers.
        // Relying primarily on UNSEEN and processing them.
        // For the "last 10 minutes" requirement, it's more of a fallback for a persistent global watcher.
        // In watchEmailForResponse, lastCheckTime is effectively the start of the watch window.
        const searchCriteria = [
            'UNSEEN',
            // ['SINCE', lastCheckTime.toISOString().split('T')[0]] // Using UNSEEN is usually sufficient.
            // If we want to ensure we look back a bit for items that might have been missed by UNSEEN on some servers:
             ['SINCE', new Date(Date.now() - 10 * 60 * 1000).toISOString().split('T')[0]] // Max 10 minutes back as a fallback
        ];
        const fetchOptions = {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
            markSeen: true
        };

        logEmailWatcher(`Searching for new emails (UNSEEN, or since last ~10 min)...`);
        const messages = await imapConnection.search(searchCriteria, fetchOptions);
        // lastCheckTime = new Date(); // Update after search, or rely on UNSEEN

        if (!messages || messages.length === 0) {
            logEmailWatcher('No new messages found matching basic criteria.');
            return null;
        }

        logEmailWatcher(`Found ${messages.length} new message(s) to filter.`);

        for (const item of messages.reverse()) { // Process newest first if multiple found
            const headerPart = item.parts.find(part => part.which === 'HEADER.FIELDS (FROM TO SUBJECT DATE)');
            const textPart = item.parts.find(part => part.which === 'TEXT');
            
            if (!textPart || !headerPart) {
                logEmailWatcher('Skipping email with missing text or header part.');
                continue;
            }

            const mailRawBody = textPart.body;
            const mailHeaders = headerPart.body;
            const emailSubject = mailHeaders.subject && mailHeaders.subject[0] ? mailHeaders.subject[0] : '';
            const emailDate = mailHeaders.date && mailHeaders.date[0] ? new Date(mailHeaders.date[0]) : new Date();

            // Filter by date if necessary (e.g. ensure it's within the last 10 mins for this specific call)
            // This is mostly for the "last 10 minutes" if UNSEEN isn't perfectly reliable.
            if (Date.now() - emailDate.getTime() > 15 * 60 * 1000) { // Give a bit of slack (15min)
                logEmailWatcher(`Skipping older email by date: "${emailSubject}" from ${emailDate.toISOString()}`);
                continue;
            }


            logEmailWatcher(`Processing email from: ${mailHeaders.from ? mailHeaders.from[0] : 'N/A'}, subject: "${emailSubject}"`);

            // 1. Subject Filter
            if (fullEmailConfig.subjectFilter && fullEmailConfig.subjectFilter.trim() !== '') {
                if (!emailSubject.toLowerCase().includes(fullEmailConfig.subjectFilter.toLowerCase())) {
                    logEmailWatcher(`Email subject "${emailSubject}" does not match subjectFilter: "${fullEmailConfig.subjectFilter}". Skipping.`);
                    continue;
                }
                logEmailWatcher(`Email subject matches subjectFilter: "${fullEmailConfig.subjectFilter}".`);
            }

            // Parse email body (UTF-8 is default for mailparser)
            const parsedMail = await simpleParser(mailRawBody);
            // Prioritize text body, fallback to HTML if text is empty or not available.
            const emailContent = parsedMail.text || (parsedMail.html ? parsedMail.html : ''); 

            if (!emailContent) {
                logEmailWatcher(`Email subject "${emailSubject}" has no text or HTML body content. Skipping.`);
                continue;
            }

            // 2. Body Keyword Filter
            if (fullEmailConfig.bodyKeywordFilter && fullEmailConfig.bodyKeywordFilter.trim() !== '') {
                if (!emailContent.toLowerCase().includes(fullEmailConfig.bodyKeywordFilter.toLowerCase())) {
                    logEmailWatcher(`Email body does not contain bodyKeywordFilter: "${fullEmailConfig.bodyKeywordFilter}". Skipping email with subject "${emailSubject}".`);
                    continue;
                }
                logEmailWatcher(`Email body contains bodyKeywordFilter: "${fullEmailConfig.bodyKeywordFilter}".`);
            }

            // 3. Extraction Pattern (RegEx)
            if (fullEmailConfig.extractionRegex && fullEmailConfig.extractionRegex.trim() !== '') {
                try {
                    const regex = new RegExp(fullEmailConfig.extractionRegex);
                    const match = emailContent.match(regex);

                    if (match && match[0]) {
                        logEmailWatcher(`Extraction regex match found in email (subject: "${emailSubject}"): ${match[0]}`);
                        return match[1] || match[0]; // Return first capture group or full match
                    } else {
                        logEmailWatcher(`WARN: Extraction regex did not match for email with subject: "${emailSubject}". Regex: ${fullEmailConfig.extractionRegex}`);
                    }
                } catch (e) {
                    logEmailWatcher(`ERROR: Invalid extraction regex "${fullEmailConfig.extractionRegex}": ${e.message}`);
                    // Don't attempt further regex matching if the pattern is invalid for this email.
                    // Could choose to return null or throw, for now, just logs and continues (effectively skipping).
                }
            } else {
                // If no extraction regex, but filters passed, what to do?
                // Current requirement implies regex is for extraction. If no regex, no extraction.
                logEmailWatcher('No extraction regex provided. Filters passed, but nothing to extract.');
            }
        }
        logEmailWatcher('No email matched all specified filters and extraction pattern.');
        return null; // No email matched all criteria or extracted data
    } catch (err) {
        logEmailWatcher(`Error searching or processing emails: ${err.message}`);
        if (err.message.toLowerCase().includes('session ended') || err.message.toLowerCase().includes('socket')) {
            logEmailWatcher('IMAP session likely ended. Will attempt reconnect on next cycle.');
            await disconnectImap();
        }
        return null;
    }
}

/**
 * Watches for an email response for a specific duration.
 * This is intended to be called by bot.js after an action.
 * @param {object} emailConfig - Contains full email configuration including login, filters, and regex.
 * @param {function} [logCallback] - Optional callback for logging detailed watcher activity.
 * @returns {Promise<string|null>} - The extracted data or null if not found/timeout.
 */
async function watchEmailForResponse(emailConfig, logCb) { // emailConfig now holds all settings
    logEmailWatcher('Starting to watch for specific email response...');
    if (logCb) emailWatcherLogCallback = logCb;

    // Pass only login details to connectToImap
    const loginConfig = { 
        email: emailConfig.email, 
        password: emailConfig.password, 
        imapHost: emailConfig.imapHost, 
        imapPort: emailConfig.imapPort, 
        imapTls: emailConfig.imapTls 
    };

    try {
        await connectToImap(loginConfig); 
    } catch (connectErr) {
        logEmailWatcher(`Failed to connect to IMAP for watching: ${connectErr.message}`);
        if (emailWatcherLogCallback) emailWatcherLogCallback = null;
        return null;
    }

    const startTime = Date.now();
    const watchDuration = 60 * 1000; // Max 60 seconds
    const checkInterval = 7 * 1000; // Check every 7 seconds (slightly less frequent)

    let extractedData = null;

    // Set lastCheckTime to roughly the start of the watch window for the SINCE criteria.
    // This is mainly a fallback if UNSEEN isn't perfect.
    lastCheckTime = new Date(startTime - 2 * 60 * 1000); // 2 minutes before watch started, as a safety for SINCE

    while (Date.now() - startTime < watchDuration) {
        logEmailWatcher(`Checking for email... Time elapsed: ${((Date.now() - startTime)/1000).toFixed(0)}s of ${watchDuration/1000}s`);
        // Pass the full emailConfig (including filters and regex) to searchAndProcessEmails
        extractedData = await searchAndProcessEmails(emailConfig); 
        if (extractedData) {
            logEmailWatcher('Relevant email found and data extracted.');
            break;
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    await disconnectImap();
    if (emailWatcherLogCallback) emailWatcherLogCallback = null;

    if (extractedData) {
        logEmailWatcher(`Returning extracted data: ${extractedData}`);
    } else {
        logEmailWatcher('No relevant email found matching all criteria within the watch duration.');
    }
    return extractedData;
}


// --- Persistent Email Monitoring (Optional - not primary for this bot's flow) ---
// This section would need similar updates if used.
let persistentIntervalId = null;

async function checkMailTask(fullEmailConfig, onDataCallback) { // Takes full config
    if (!imapConnection || imapConnection.state === 'disconnected') {
        try {
            // Pass only login part of config
            const loginConfig = { email: fullEmailConfig.email, password: fullEmailConfig.password, imapHost: fullEmailConfig.imapHost, imapPort: fullEmailConfig.imapPort, imapTls: fullEmailConfig.imapTls };
            await connectToImap(loginConfig);
        } catch (err) {
            logEmailWatcher(`Persistent check: Failed to connect - ${err.message}. Will retry.`);
            return;
        }
    }
    const data = await searchAndProcessEmails(fullEmailConfig); // Pass full config
    if (data && onDataCallback) {
        onDataCallback(data);
    }
}

function startPersistentEmailWatcher(fullEmailConfig, onDataCallback) { // Takes full config
    if (isWatching) {
        logEmailWatcher('Persistent email watcher is already running.');
        return;
    }
    if (!fullEmailConfig || !fullEmailConfig.email || !fullEmailConfig.extractionRegex) { // Basic check
        logEmailWatcher('Cannot start persistent watcher: Email login config or extraction regex missing.');
        return;
    }

    currentEmailConfigForConnection = { // Store only login details for reconnects
        email: fullEmailConfig.email, 
        password: fullEmailConfig.password, 
        imapHost: fullEmailConfig.imapHost, 
        imapPort: fullEmailConfig.imapPort, 
        imapTls: fullEmailConfig.imapTls 
    };


    logEmailWatcher('Starting persistent email watcher...');
    isWatching = true;
    checkMailTask(fullEmailConfig, onDataCallback); // Initial check with full config
    persistentIntervalId = setInterval(() => checkMailTask(fullEmailConfig, onDataCallback), emailCheckInterval);
}
// stopPersistentEmailWatcher remains largely the same, just ensures disconnect.

module.exports = {
    watchEmailForResponse,
    // startPersistentEmailWatcher, 
    // stopPersistentEmailWatcher 
};
