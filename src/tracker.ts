import '@whiskeysockets/baileys';
import { WASocket, proto, jidNormalizedUser } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { AdaptiveThresholdManager, DeviceState } from './adaptive-threshold.js';
import { DatabaseManager, MeasurementRecord } from './db.js';

// Suppress Baileys debug output (Closing session spam)
const logger = pino({
    level: process.argv.includes('--debug') ? 'debug' : 'silent'
});

/**
 * Probe method types
 * - 'delete': Silent delete probe (sends delete request for non-existent message) - DEFAULT
 * - 'reaction': Reaction probe (sends reaction to non-existent message)
 */
export type ProbeMethod = 'delete' | 'reaction';

/**
 * Logger utility for debug and normal mode
 */
class TrackerLogger {
    private isDebugMode: boolean;

    constructor(debugMode: boolean = false) {
        this.isDebugMode = debugMode;
    }

    setDebugMode(enabled: boolean) {
        this.isDebugMode = enabled;
    }

    debug(...args: any[]) {
        if (this.isDebugMode) {
            console.log(...args);
        }
    }

    info(...args: any[]) {
        console.log(...args);
    }

    formatDeviceState(jid: string, rtt: number, stats: any, state: string) {
        const stateColor = state === 'Online' ? '🟢' : state === 'Standby' ? '🟡' : state === 'OFFLINE' ? '🔴' : '⚪';
        const timestamp = new Date().toLocaleTimeString('de-DE');

        // Box width is 64 characters, inner content is 62 characters (excluding ║ on both sides)
        const boxWidth = 62;

        const header = `${stateColor} Device Status Update - ${timestamp}`;
        const jidLine = `JID:        ${jid}`;
        const statusLine = `Status:     ${state}`;
        const rttLine = `RTT:        ${rtt}ms`;
        const onlineLine = `Online Avg: ${stats.onlineAvg.toFixed(0)}ms`;
        const standbyLine = `Standby Avg:${stats.standbyAvg.toFixed(0)}ms`;
        const thresholdLine = `Threshold:  ${stats.threshold.toFixed(0)}ms`;
        const confLine = `Confidence: ${(stats.confidence * 100).toFixed(0)}%`;

        console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
        console.log(`║ ${header.padEnd(boxWidth)} ║`);
        console.log(`╠════════════════════════════════════════════════════════════════╣`);
        console.log(`║ ${jidLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${statusLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${rttLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${onlineLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${standbyLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${thresholdLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${confLine.padEnd(boxWidth)} ║`);
        console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
    }
}

const trackerLogger = new TrackerLogger();

/**
 * Metrics tracked per device for activity monitoring
 */
interface DeviceMetrics {
    lastRtt: number;           // Most recent RTT measurement
    lastUpdate: number;        // Timestamp of last update
    state: DeviceState | 'OFFLINE'; // Current device state
    thresholdManager: AdaptiveThresholdManager; // Per-device adaptive model
}

/**
 * WhatsAppTracker - Monitors messaging app user activity using RTT-based analysis
 */
export class WhatsAppTracker {
    private sock: WASocket;
    private targetJid: string;
    private trackedJids: Set<string> = new Set(); // Multi-device support
    private isTracking: boolean = false;
    private deviceMetrics: Map<string, DeviceMetrics> = new Map();
    private probeStartTimes: Map<string, number> = new Map();
    private probeTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private lastPresence: string | null = null;
    private probeMethod: ProbeMethod = 'delete'; // Default to delete method
    private db = DatabaseManager.getInstance();
    private dbBuffer: MeasurementRecord[] = [];
    public onUpdate?: (data: any) => void;

    constructor(sock: WASocket, targetJid: string, debugMode: boolean = false) {
        this.sock = sock;
        this.targetJid = targetJid;
        this.trackedJids.add(targetJid);
        trackerLogger.setDebugMode(debugMode);
    }

    public setProbeMethod(method: ProbeMethod) {
        this.probeMethod = method;
        trackerLogger.info(`\n🔄 Probe method changed to: ${method === 'delete' ? 'Silent Delete' : 'Reaction'}\n`);
    }

    public getProbeMethod(): ProbeMethod {
        return this.probeMethod;
    }

    /**
     * Start tracking the target user's activity
     */
    public async startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;
        trackerLogger.info(`\n✅ Tracking started for ${this.targetJid}`);
        trackerLogger.info(`Probe method: ${this.probeMethod === 'delete' ? 'Silent Delete (covert)' : 'Reaction'}\n`);

        // Listen for message updates (receipts)
        this.sock.ev.on('messages.update', (updates) => {
            for (const update of updates) {
                if (update.key.remoteJid && this.trackedJids.has(update.key.remoteJid) && update.key.fromMe) {
                    this.analyzeUpdate(update);
                }
            }
        });

        // Listen for raw receipts to catch 'inactive' type which are ignored by Baileys
        this.sock.ws.on('CB:receipt', (node: any) => {
            this.handleRawReceipt(node);
        });

        // Listen for presence updates
        this.sock.ev.on('presence.update', (update) => {
            trackerLogger.debug('[PRESENCE] Raw update received:', JSON.stringify(update, null, 2));

            if (update.presences) {
                for (const [jid, presenceData] of Object.entries(update.presences)) {
                    if (presenceData && presenceData.lastKnownPresence) {
                        this.trackedJids.add(jid);
                        trackerLogger.debug(`[MULTI-DEVICE] Added JID to tracking: ${jid}`);

                        this.lastPresence = presenceData.lastKnownPresence;
                        trackerLogger.debug(`[PRESENCE] Stored presence from ${jid}: ${this.lastPresence}`);
                        break;
                    }
                }
            }
        });

        // Subscribe to presence updates
        try {
            await this.sock.presenceSubscribe(this.targetJid);
            trackerLogger.debug(`[PRESENCE] Successfully subscribed to presence for ${this.targetJid}`);
        } catch (err) {
            trackerLogger.debug('[PRESENCE] Error subscribing to presence:', err);
        }

        // Send initial state update
        if (this.onUpdate) {
            this.onUpdate({
                devices: [],
                deviceCount: this.trackedJids.size,
                presence: this.lastPresence,
                median: 0,
                threshold: 0
            });
        }

        this.probeLoop();
    }

    private async probeLoop() {
        while (this.isTracking) {
            try {
                await this.sendProbe();
            } catch (err) {
                logger.error(err, 'Error sending probe');
            }
            const delay = Math.floor(Math.random() * 100) + 2000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    private async sendProbe() {
        if (this.probeMethod === 'delete') {
            await this.sendDeleteProbe();
        } else {
            await this.sendReactionProbe();
        }
    }

    private async sendDeleteProbe() {
        try {
            const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
            const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
            const randomMsgId = randomPrefix + randomSuffix;

            const randomDeleteMessage = {
                delete: {
                    remoteJid: this.targetJid,
                    fromMe: true,
                    id: randomMsgId,
                }
            };

            trackerLogger.debug(`[PROBE-DELETE] Sending silent delete probe for fake message ${randomMsgId}`);
            const startTime = Date.now();

            const result = await this.sock.sendMessage(this.targetJid, randomDeleteMessage);

            if (result?.key?.id) {
                trackerLogger.debug(`[PROBE-DELETE] Delete probe sent successfully, message ID: ${result.key.id}`);
                this.probeStartTimes.set(result.key.id, startTime);

                const timeoutId = setTimeout(() => {
                    if (this.probeStartTimes.has(result.key.id!)) {
                        const elapsedTime = Date.now() - startTime;
                        trackerLogger.debug(`[PROBE-DELETE TIMEOUT] No CLIENT ACK for ${result.key.id} after ${elapsedTime}ms - Device is OFFLINE`);
                        this.probeStartTimes.delete(result.key.id!);
                        this.probeTimeouts.delete(result.key.id!);

                        if (result.key.remoteJid) {
                            this.markDeviceOffline(result.key.remoteJid, elapsedTime);
                        }
                    }
                }, 10000);

                this.probeTimeouts.set(result.key.id, timeoutId);
            }
        } catch (err) {
            logger.error(err, '[PROBE-DELETE ERROR] Failed to send delete probe message');
        }
    }

    private async sendReactionProbe() {
        try {
            const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
            const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
            const randomMsgId = randomPrefix + randomSuffix;
            const reactions = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👻', '🔥', '✨', ''];
            const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];

            const reactionMessage = {
                react: {
                    text: randomReaction,
                    key: {
                        remoteJid: this.targetJid,
                        fromMe: false,
                        id: randomMsgId
                    }
                }
            };

            trackerLogger.debug(`[PROBE-REACTION] Sending probe with reaction "${randomReaction}" to non-existent message ${randomMsgId}`);
            const result = await this.sock.sendMessage(this.targetJid, reactionMessage);
            const startTime = Date.now();

            if (result?.key?.id) {
                trackerLogger.debug(`[PROBE-REACTION] Probe sent successfully, message ID: ${result.key.id}`);
                this.probeStartTimes.set(result.key.id, startTime);

                const timeoutId = setTimeout(() => {
                    if (this.probeStartTimes.has(result.key.id!)) {
                        const elapsedTime = Date.now() - startTime;
                        trackerLogger.debug(`[PROBE-REACTION TIMEOUT] No CLIENT ACK for ${result.key.id} after ${elapsedTime}ms - Device is OFFLINE`);
                        this.probeStartTimes.delete(result.key.id!);
                        this.probeTimeouts.delete(result.key.id!);

                        if (result.key.remoteJid) {
                            this.markDeviceOffline(result.key.remoteJid, elapsedTime);
                        }
                    }
                }, 10000);

                this.probeTimeouts.set(result.key.id, timeoutId);
            }
        } catch (err) {
            logger.error(err, '[PROBE-REACTION ERROR] Failed to send probe message');
        }
    }

    /**
     * Store record in buffer and flush if full
     */
    private recordMeasurement(jid: string, rtt: number, state: string) {
        this.dbBuffer.push({
            jid,
            timestamp: Date.now(),
            rtt,
            state
        });

        // Flush every 5 samples to minimize DB writes
        if (this.dbBuffer.length >= 5) {
            this.flushDbBuffer();
        }
    }

    private flushDbBuffer() {
        if (this.dbBuffer.length === 0) return;
        try {
            this.db.insertBatch(this.dbBuffer);
            this.dbBuffer = [];
        } catch (err) {
            logger.error(err, 'Failed to flush DB buffer');
        }
    }

    private handleRawReceipt(node: any) {
        try {
            const { attrs } = node;
            if (attrs.type === 'inactive') {
                trackerLogger.debug(`[RAW RECEIPT] Received inactive receipt: ${JSON.stringify(attrs)}`);
                const msgId = attrs.id;
                const fromJid = attrs.from;
                if (!fromJid) return;

                const baseNumber = fromJid.split('@')[0].split(':')[0];
                const isTracked = this.trackedJids.has(fromJid) ||
                    this.trackedJids.has(`${baseNumber}@s.whatsapp.net`);

                if (isTracked) {
                    this.processAck(msgId, fromJid, 'inactive');
                }
            }
        } catch (err) {
            trackerLogger.debug(`[RAW RECEIPT] Error handling receipt: ${err}`);
        }
    }

    private processAck(msgId: string, fromJid: string, type: string) {
        trackerLogger.debug(`[ACK PROCESS] ID: ${msgId}, JID: ${fromJid}, Type: ${type}`);
        if (!msgId || !fromJid) return;
        const startTime = this.probeStartTimes.get(msgId);
        if (startTime) {
            const rtt = Date.now() - startTime;
            trackerLogger.debug(`[TRACKING] ✅ ${type.toUpperCase()} received for ${msgId} from ${fromJid}, RTT: ${rtt}ms`);
            const timeoutId = this.probeTimeouts.get(msgId);
            if (timeoutId) {
                clearTimeout(timeoutId);
                this.probeTimeouts.delete(msgId);
            }
            this.probeStartTimes.delete(msgId);
            this.addMeasurementForDevice(fromJid, rtt);
        }
    }

    private analyzeUpdate(update: { key: proto.IMessageKey, update: Partial<proto.IWebMessageInfo> }) {
        const status = update.update.status;
        const msgId = update.key.id;
        const fromJid = update.key.remoteJid;
        if (!msgId || !fromJid) return;
        trackerLogger.debug(`[TRACKING] Message Update - ID: ${msgId}, JID: ${fromJid}, Status: ${status} (${this.getStatusName(status)})`);
        if (status === 3) { // CLIENT ACK
            this.processAck(msgId, fromJid, 'client_ack');
        }
    }

    private getStatusName(status: number | null | undefined): string {
        switch (status) {
            case 0: return 'ERROR';
            case 1: return 'PENDING';
            case 2: return 'SERVER_ACK';
            case 3: return 'DELIVERY_ACK';
            case 4: return 'READ';
            case 5: return 'PLAYED';
            default: return 'UNKNOWN';
        }
    }

    private markDeviceOffline(jid: string, timeout: number) {
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, {
                lastRtt: timeout,
                lastUpdate: Date.now(),
                state: 'OFFLINE',
                thresholdManager: new AdaptiveThresholdManager()
            });
        }

        const metrics = this.deviceMetrics.get(jid)!;
        metrics.state = 'OFFLINE';
        metrics.lastRtt = timeout;
        metrics.lastUpdate = Date.now();

        // Record OFFLINE in DB
        this.recordMeasurement(jid, timeout, 'OFFLINE');

        trackerLogger.info(`\n🔴 Device ${jid} marked as OFFLINE (no CLIENT ACK after ${timeout}ms)\n`);
        this.sendUpdate();
    }

    private addMeasurementForDevice(jid: string, rtt: number) {
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, {
                lastRtt: rtt,
                lastUpdate: Date.now(),
                state: 'Calibrating',
                thresholdManager: new AdaptiveThresholdManager()
            });
        }

        const metrics = this.deviceMetrics.get(jid)!;
        if (rtt <= 10000) {
            metrics.lastRtt = rtt;
            metrics.lastUpdate = Date.now();
            metrics.thresholdManager.addMeasurement(rtt);
            metrics.state = metrics.thresholdManager.determineState(rtt);

            // Record in DB
            this.recordMeasurement(jid, rtt, metrics.state);

            const stats = metrics.thresholdManager.getDebugStats();
            trackerLogger.formatDeviceState(jid, rtt, stats, metrics.state);
        }

        this.sendUpdate();
    }

    private sendUpdate() {
        const devices = Array.from(this.deviceMetrics.entries()).map(([jid, metrics]) => {
            const stats = metrics.thresholdManager.getDebugStats();
            return {
                jid,
                state: metrics.state,
                rtt: metrics.lastRtt,
                onlineAvg: stats.onlineAvg,
                standbyAvg: stats.standbyAvg,
                threshold: stats.threshold,
                confidence: stats.confidence,
                samples: stats.samples
            };
        });

        const data = {
            devices,
            deviceCount: this.trackedJids.size,
            presence: this.lastPresence,
            median: 0,
            threshold: 0
        };

        if (this.onUpdate) {
            this.onUpdate(data);
        }
    }

    public async getProfilePicture() {
        try {
            return await this.sock.profilePictureUrl(this.targetJid, 'image');
        } catch (err) {
            return null;
        }
    }

    public stopTracking() {
        this.isTracking = false;
        // Flush remaining data
        this.flushDbBuffer();

        for (const timeoutId of this.probeTimeouts.values()) {
            clearTimeout(timeoutId);
        }
        this.probeTimeouts.clear();
        this.probeStartTimes.clear();
        logger.info('Stopping tracking');
    }
}
