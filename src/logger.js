import fs from 'fs';
import path from 'path';
import os from 'os';

class TranscodeLogger {
    constructor(logFilePath = null, maxLogs = 100) {
        // Use NODE_NAME env var for unique log files, fallback to hostname
        const nodeName = process.env.NODE_NAME || os.hostname().split('.')[0];
        this.nodeName = nodeName;
        this.logFilePath = logFilePath || `logs/transcode-${nodeName}.log`;
        this.maxLogs = maxLogs;
        this.logs = [];
        this.loadLogs();
        console.log(`📝 Logger initialized for node: ${nodeName}`);
    }

    loadLogs() {
        try {
            // Ensure log directory exists
            const logDir = path.dirname(this.logFilePath);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            if (fs.existsSync(this.logFilePath)) {
                const data = fs.readFileSync(this.logFilePath, 'utf8');
                this.logs = data.trim().split('\n')
                    .filter(line => line.trim())
                    .map(line => JSON.parse(line))
                    .slice(-this.maxLogs); // Keep only the last maxLogs entries
            }
        } catch (error) {
            console.warn('⚠️ Could not load existing logs:', error.message);
            this.logs = [];
        }
    }

    saveLogs() {
        try {
            // Keep only the last maxLogs entries
            this.logs = this.logs.slice(-this.maxLogs);

            const logData = this.logs.map(log => JSON.stringify(log)).join('\n') + '\n';
            fs.writeFileSync(this.logFilePath, logData);
        } catch (error) {
            console.error('❌ Could not save logs:', error.message);
        }
    }

    addLog(logEntry) {
        const enrichedLog = {
            ...logEntry,
            timestamp: new Date().toISOString(),
            id: logEntry.id || 'unknown',
            node: this.nodeName
        };

        this.logs.push(enrichedLog);
        this.saveLogs();

        // Also log to console with rich formatting
        this.consoleLog(enrichedLog);
    }

    consoleLog(log) {
        const emoji = this.getStatusEmoji(log.status);
        const duration = log.duration ? `${log.duration}ms` : 'N/A';

        console.log(`${emoji} [${log.timestamp}] [${log.node || 'unknown'}] ${log.status.toUpperCase()}`);
        console.log(`   🆔 ID: ${log.id}`);
        console.log(`   👤 User: ${log.user || 'anonymous'}${log.userHP ? ` (HP: ${log.userHP})` : ''}`);
        console.log(`   📁 File: ${log.filename || 'unknown'} (${log.fileSize || 0} bytes)`);
        console.log(`   📍 IP: ${log.clientIP || 'unknown'}`);
        console.log(`   🖥️  Device: ${log.deviceInfo || 'unknown'}`);
        console.log(`   🌐 Platform: ${log.platform || 'unknown'}`);
        console.log(`   ⏱️  Duration: ${duration}`);

        if (log.correlationId) {
            console.log(`   � Correlation: ${log.correlationId}`);
        }

        if (log.viewport) {
            console.log(`   📐 Viewport: ${log.viewport}`);
        }

        if (log.connectionType) {
            console.log(`   📶 Connection: ${log.connectionType}`);
        }

        if (log.cid) {
            console.log(`   📦 CID: ${log.cid}`);
        }

        if (log.error) {
            console.log(`   ❌ Error: ${log.error}`);
        }

        if (log.gatewayUrl) {
            console.log(`   🌐 URL: ${log.gatewayUrl}`);
        }

        console.log(''); // Empty line for readability
    }

    getStatusEmoji(status) {
        const emojis = {
            'started': '🚀',
            'processing': '⚙️',
            'uploading': '☁️',
            'completed': '✅',
            'failed': '❌',
            'error': '💥'
        };
        return emojis[status] || '📝';
    }

    logTranscodeStart({ id, user, filename, fileSize, clientIP, userAgent, origin, platform, deviceInfo, browserInfo, userHP, correlationId, viewport, connectionType }) {
        this.addLog({
            id,
            status: 'started',
            user: user || 'anonymous',
            filename,
            fileSize,
            clientIP,
            userAgent: userAgent?.substring(0, 100),
            origin,
            platform: platform || 'unknown',
            deviceInfo: deviceInfo || 'unknown',
            browserInfo: browserInfo || '',
            userHP: userHP || 0,
            correlationId: correlationId || null,
            viewport: viewport || null,
            connectionType: connectionType || null,
            startTime: Date.now()
        });
    }

    logTranscodeComplete({ id, user, filename, cid, gatewayUrl, duration, clientIP }) {
        // Find the original start log to preserve device context
        const startLog = this.logs.find(log => log.id === id && log.status === 'started');

        this.addLog({
            id,
            status: 'completed',
            user: user || 'anonymous',
            filename,
            cid,
            gatewayUrl,
            duration,
            clientIP,
            success: true,
            // Preserve device info from start log
            platform: startLog?.platform || null,
            deviceInfo: startLog?.deviceInfo || null,
            browserInfo: startLog?.browserInfo || null,
            userHP: startLog?.userHP || null,
            correlationId: startLog?.correlationId || null,
            viewport: startLog?.viewport || null,
            connectionType: startLog?.connectionType || null
        });
    }

    logTranscodeError({ id, user, filename, error, duration, clientIP }) {
        // Find the original start log to preserve device context
        const startLog = this.logs.find(log => log.id === id && log.status === 'started');

        this.addLog({
            id,
            status: 'failed',
            user: user || 'anonymous',
            filename,
            error: error?.message || error || 'Unknown error',
            duration,
            clientIP,
            success: false,
            // Preserve device info from start log
            platform: startLog?.platform || null,
            deviceInfo: startLog?.deviceInfo || null,
            browserInfo: startLog?.browserInfo || null,
            userHP: startLog?.userHP || null,
            correlationId: startLog?.correlationId || null,
            viewport: startLog?.viewport || null,
            connectionType: startLog?.connectionType || null
        });
    }

    logFFmpegProgress({ id, progress, timeElapsed }) {
        // Don't save progress logs to file (too noisy), just console log
        console.log(`⏳ [FFMPEG-PROGRESS] ID: ${id} | Progress: ${progress} | Elapsed: ${timeElapsed}`);
    }

    getRecentLogs(limit = 10) {
        return this.logs.slice(-limit).reverse(); // Most recent first
    }

    getLogsForDashboard(limit = 5) {
        return this.logs.slice(-limit).reverse().map(log => ({
            id: log.id,
            timestamp: log.timestamp,
            user: log.user,
            filename: log.filename,
            status: log.status,
            duration: log.duration,
            error: log.error,
            cid: log.cid,
            fileSize: log.fileSize,
            clientIP: log.clientIP,
            platform: log.platform,
            deviceInfo: log.deviceInfo,
            userHP: log.userHP,
            correlationId: log.correlationId,
            viewport: log.viewport,
            connectionType: log.connectionType
        }));
    }

    getStats() {
        const total = this.logs.length;
        const successful = this.logs.filter(log => log.success === true).length;
        const failed = this.logs.filter(log => log.success === false).length;
        const inProgress = this.logs.filter(log => log.status === 'started' || log.status === 'processing').length;

        const avgDuration = this.logs
            .filter(log => log.duration && log.success === true)
            .reduce((sum, log, _, arr) => sum + log.duration / arr.length, 0);

        return {
            total,
            successful,
            failed,
            inProgress,
            avgDuration: Math.round(avgDuration),
            successRate: total > 0 ? Math.round((successful / total) * 100) : 0
        };
    }
}

export default TranscodeLogger;
