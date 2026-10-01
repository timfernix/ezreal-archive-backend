import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerEntryPoint = resolve(projectRoot, 'node_modules/wrangler/bin/wrangler.js');
const configPath = resolve(projectRoot, 'wrangler.toml');
const outputArgument = process.argv[2] || 'generated/d1-remote.sql';
const outputPath = isAbsolute(outputArgument) ? outputArgument : resolve(projectRoot, outputArgument);
const pageSize = 250;

function executeRemote(query) {
    const output = execFileSync(process.execPath, [
        wranglerEntryPoint,
        'd1', 'execute', 'ezreal',
        '--remote',
        '--config', configPath,
        '--json',
        '--command', query
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit']
    });
    const response = JSON.parse(output);

    if (!response[0]?.success) {
        throw new Error(`Remote D1 query failed: ${query}`);
    }

    return response[0].results || [];
}

function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}

function toSqlLiteral(value) {
    if (value === null) {
        return 'NULL';
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }

    if (typeof value === 'string') {
        return `'${value.replaceAll("'", "''")}'`;
    }

    throw new Error(`Unsupported D1 value type: ${typeof value}`);
}

const schema = executeRemote(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name
`);
const tables = schema.filter(entry => entry.type === 'table');
const statements = schema
    .filter(entry => entry.type === 'table' || entry.type === 'view')
    .map(entry => `${entry.sql};`);
const rowsByTable = new Map();
const dependencies = new Map();

for (const table of tables) {
    const quotedTable = quoteIdentifier(table.name);
    const countRows = executeRemote(`SELECT COUNT(*) AS count FROM ${quotedTable}`);
    const foreignKeys = executeRemote(`PRAGMA foreign_key_list(${quotedTable})`);
    const expectedCount = Number(countRows[0]?.count);
    const rows = [];

    for (let offset = 0; offset < expectedCount; offset += pageSize) {
        rows.push(...executeRemote(
            `SELECT * FROM ${quotedTable} ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`
        ));
    }

    if (rows.length !== expectedCount) {
        throw new Error(`Snapshot incomplete for ${table.name}: expected ${expectedCount}, received ${rows.length}.`);
    }

    rowsByTable.set(table.name, rows);
    dependencies.set(table.name, foreignKeys.map(key => key.table).filter(name => rowsByTable.has(name) || tables.some(item => item.name === name)));
}

const insertOrder = [];
const visited = new Set();
const visiting = new Set();

function visitTable(tableName) {
    if (visited.has(tableName) || visiting.has(tableName)) {
        return;
    }

    visiting.add(tableName);
    for (const dependency of dependencies.get(tableName) || []) {
        visitTable(dependency);
    }
    visiting.delete(tableName);
    visited.add(tableName);
    insertOrder.push(tableName);
}

tables.forEach(table => visitTable(table.name));

for (const tableName of insertOrder) {
    const table = tables.find(item => item.name === tableName);
    const rows = rowsByTable.get(table.name);

    for (const row of rows) {
        const columns = Object.keys(row);
        const columnList = columns.map(quoteIdentifier).join(', ');
        const values = columns.map(column => toSqlLiteral(row[column])).join(', ');
        statements.push(`INSERT INTO ${quoteIdentifier(table.name)} (${columnList}) VALUES (${values});`);
    }
}

for (const entry of schema.filter(item => item.type === 'index' || item.type === 'trigger')) {
    statements.push(`${entry.sql};`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${statements.join('\n')}\n`);
const totalRows = [...rowsByTable.values()].reduce((total, rows) => total + rows.length, 0);
console.log(`Pulled ${tables.length} tables and ${totalRows} rows from remote D1 into ${outputPath}`);