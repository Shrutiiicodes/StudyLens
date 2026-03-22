import neo4j, { Driver, Session } from 'neo4j-driver';

let driver: Driver | null = null;

/**
 * Get or create the Neo4j driver singleton.
 */
export function getNeo4jDriver(): Driver {
    if (!driver) {
        const uri = process.env.NEO4J_URI!;
        const username = process.env.NEO4J_USER || process.env.NEO4J_USERNAME!;
        const password = process.env.NEO4J_PASSWORD!;

        driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    }
    return driver;
}

/**
 * Get a new Neo4j session.
 */
export function getNeo4jSession(): Session {
    return getNeo4jDriver().session();
}

/**
 * Run a Cypher query and return the results.
 */
export async function runCypher<T = Record<string, unknown>>(
    query: string,
    params: Record<string, unknown> = {}
): Promise<T[]> {
    const session = getNeo4jSession();
    try {
        const result = await session.run(query, params);
        return result.records.map((record) => {
            const obj: Record<string, unknown> = {};
            record.keys.forEach((key) => {
                obj[key as string] = record.get(key);
            });
            return obj as T;
        });
    } finally {
        await session.close();
    }
}

/**
 * Close the Neo4j driver (for cleanup).
 */
export async function closeNeo4j(): Promise<void> {
    if (driver) {
        await driver.close();
        driver = null;
    }
}
