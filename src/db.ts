import Database from 'better-sqlite3';
import path from 'path';

export interface MeasurementRecord {
    jid: string;
    timestamp: number;
    rtt: number;
    state: string;
}

export class DatabaseManager {
    private db: Database.Database;
    private static instance: DatabaseManager;

    private constructor() {
        // Store db in the project root or data folder
        const dbPath = path.join(process.cwd(), 'tracker.db');
        this.db = new Database(dbPath);
        this.init();
    }

    public static getInstance(): DatabaseManager {
        if (!DatabaseManager.instance) {
            DatabaseManager.instance = new DatabaseManager();
        }
        return DatabaseManager.instance;
    }

    private init() {
        // WAL mode for better concurrency
        this.db.pragma('journal_mode = WAL');

        // Create measurements table
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                jid TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                rtt INTEGER NOT NULL,
                state TEXT NOT NULL
            )
        `).run();

        // Create index on JID and Timestamp for fast history queries
        this.db.prepare(`
            CREATE INDEX IF NOT EXISTS idx_measurements_jid_ts 
            ON measurements(jid, timestamp)
        `).run();
    }

    public insertMeasurement(data: MeasurementRecord) {
        const stmt = this.db.prepare(`
            INSERT INTO measurements (jid, timestamp, rtt, state)
            VALUES (@jid, @timestamp, @rtt, @state)
        `);
        stmt.run(data);
    }

    public insertBatch(data: MeasurementRecord[]) {
        const insert = this.db.prepare(`
            INSERT INTO measurements (jid, timestamp, rtt, state)
            VALUES (@jid, @timestamp, @rtt, @state)
        `);

        const insertMany = this.db.transaction((measurements: MeasurementRecord[]) => {
            for (const m of measurements) insert.run(m);
        });

        insertMany(data);
    }

    /**
     * Get hourly activity (Online %) for the last 7 days
     * Returns: { timestamp: number, online_count: number, total_count: number }
     * Aggregated by hour
     */
    public getHistory(jid: string, days = 7) {
        const since = Date.now() - (days * 24 * 60 * 60 * 1000);

        // Group by hour
        const stmt = this.db.prepare(`
            SELECT 
                (timestamp / 3600000) * 3600000 as hourStr,
                COUNT(*) as total_samples,
                SUM(CASE WHEN state = 'Online' THEN 1 ELSE 0 END) as online_samples
            FROM measurements
            WHERE jid = ? AND timestamp > ?
            GROUP BY hourStr
            ORDER BY hourStr ASC
        `);

        return stmt.all(jid, since);
    }
}
