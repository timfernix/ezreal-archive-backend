import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectRoot, process.argv[2] || 'generated');
const wranglerEntryPoint = resolve(projectRoot, 'node_modules/wrangler/bin/wrangler.js');

const catalogQuery = `
    WITH catalog AS (
        SELECT
            'asset:' || a.r2_key AS id,
            a.id AS databaseId,
            s.name AS skinName,
            s.description AS description,
            s.release_year AS skinReleaseYear,
            a.type AS type,
            a.r2_key AS url,
            COALESCE(a.title, a.r2_key) AS title,
            COALESCE(a.category, 'Uncategorized') AS category,
            COALESCE(a.game, 'Generic') AS game,
            a.asset_release_year AS releaseYear,
            COALESCE((
                SELECT json_group_array(t.name)
                FROM asset_tags at
                JOIN tags t ON t.id = at.tag_id
                WHERE at.asset_id = a.id
            ), '[]') AS tags,
            '' AS platform,
            'asset' AS source,
            CASE
                WHEN LOWER(TRIM(s.name)) LIKE '% ezreal' THEN TRIM(SUBSTR(TRIM(s.name), 1, LENGTH(TRIM(s.name)) - 7))
                ELSE TRIM(s.name)
            END AS skinline
        FROM assets a
        JOIN skins s ON s.id = a.skin_id

        UNION ALL

        SELECT
            'external_link:' || el.url AS id,
            el.id AS databaseId,
            s.name AS skinName,
            s.description AS description,
            s.release_year AS skinReleaseYear,
            'external' AS type,
            el.url AS url,
            COALESCE(el.title, el.url) AS title,
            COALESCE(el.category, 'Uncategorized') AS category,
            COALESCE(el.game, 'Generic') AS game,
            el.asset_release_year AS releaseYear,
            '[]' AS tags,
            el.platform AS platform,
            'external_link' AS source,
            CASE
                WHEN LOWER(TRIM(s.name)) LIKE '% ezreal' THEN TRIM(SUBSTR(TRIM(s.name), 1, LENGTH(TRIM(s.name)) - 7))
                ELSE TRIM(s.name)
            END AS skinline
        FROM external_links el
        JOIN skins s ON s.id = el.skin_id
    )
    SELECT * FROM catalog
    ORDER BY CAST(releaseYear AS INTEGER) DESC, skinName ASC, title ASC
`;

function parseTags(tags) {
    try {
        return JSON.parse(tags).filter(Boolean);
    } catch {
        return [];
    }
}

function sortedDistinct(values) {
    return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

const rawOutput = execFileSync(process.execPath, [
    wranglerEntryPoint, 'd1', 'execute', 'ezreal', '--local', '--json', '--command', catalogQuery
], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 10 * 1024 * 1024
});

const execution = JSON.parse(rawOutput);
const rows = execution[0]?.results;

if (!Array.isArray(rows)) {
    throw new Error('Wrangler returned no D1 query results.');
}

const items = rows.map(row => ({
    ...row,
    skinReleaseYear: String(row.skinReleaseYear ?? 'Unknown'),
    releaseYear: String(row.releaseYear ?? 'Unknown'),
    tags: parseTags(row.tags)
}));

const content = {
    items,
    filters: {
        skinlines: sortedDistinct(items.map(item => item.skinline)),
        categories: sortedDistinct(items.map(item => item.category)),
        games: sortedDistinct(items.map(item => item.game).filter(game => game !== 'Generic')),
        tags: sortedDistinct(items.flatMap(item => item.tags))
    }
};
const version = createHash('sha256').update(JSON.stringify(content)).digest('hex');
const catalogFileName = `catalog.${version}.json`;
const catalog = { version, ...content };
const manifest = { version, catalogUrl: catalogFileName, generatedAt: new Date().toISOString() };

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(resolve(outputDirectory, catalogFileName), `${JSON.stringify(catalog)}\n`);
writeFileSync(resolve(outputDirectory, 'catalog-manifest.json'), `${JSON.stringify(manifest)}\n`);
console.log(`Wrote ${items.length} catalog entries to ${outputDirectory}`);