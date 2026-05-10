import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

let _sql: Sql | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;

function getDatabaseUrl(): string {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error('DATABASE_URL is required.');
    }
    return url;
}

export function getSql(): Sql {
    if (!_sql) {
        _sql = postgres(getDatabaseUrl(), { prepare: false });
    }
    return _sql;
}

export function getDb(): PostgresJsDatabase<typeof schema> {
    if (!_db) {
        _db = drizzle(getSql(), { schema });
    }
    return _db;
}

export async function closeDb(): Promise<void> {
    if (_sql) {
        await _sql.end({ timeout: 5 });
        _sql = null;
        _db = null;
    }
}

export type Db = PostgresJsDatabase<typeof schema>;
