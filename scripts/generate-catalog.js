import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectRoot, process.argv[2] || 'generated');
const wranglerEntryPoint = resolve(projectRoot, 'node_modules/wrangler/bin/wrangler.js');
const persistPath = process.env.WRANGLER_D1_PERSIST_TO;

const catalogQuery = `
    WITH catalog AS (
        SELECT
            'asset:' || a.r2_key AS id,
            a.id AS databaseId,
            s.name AS skinName,
            s.description AS description,
            s.release_date AS skinReleaseDate,
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
            COALESCE(a.thumb_key, '') AS thumbUrl,
            COALESCE(a.preview_key, '') AS previewUrl,
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
            s.release_date AS skinReleaseDate,
            'external' AS type,
            el.url AS url,
            COALESCE(el.title, el.url) AS title,
            COALESCE(el.category, 'Uncategorized') AS category,
            COALESCE(el.game, 'Generic') AS game,
            el.asset_release_year AS releaseYear,
            COALESCE((
                SELECT json_group_array(t.name)
                FROM external_link_tags elt
                JOIN tags t ON t.id = elt.tag_id
                WHERE elt.external_link_id = el.id
            ), '[]') AS tags,
            el.platform AS platform,
            '' AS thumbUrl,
            '' AS previewUrl,
            'external_link' AS source,
            CASE
                WHEN LOWER(TRIM(s.name)) LIKE '% ezreal' THEN TRIM(SUBSTR(TRIM(s.name), 1, LENGTH(TRIM(s.name)) - 7))
                ELSE TRIM(s.name)
            END AS skinline
        FROM external_links el
        JOIN skins s ON s.id = el.skin_id
    )
    SELECT * FROM catalog
    ORDER BY CAST(SUBSTR(skinReleaseDate, 1, 4) AS INTEGER) DESC, skinReleaseDate DESC, skinName ASC, title ASC
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
    wranglerEntryPoint,
    'd1', 'execute', 'ezreal', '--local', '--json',
    ...(persistPath ? ['--persist-to', persistPath] : []),
    '--command', catalogQuery
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
    skinReleaseDate: String(row.skinReleaseDate ?? 'Unknown'),
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

// Remove superseded versions so the output folder only keeps the catalog the manifest points to.
const staleFiles = readdirSync(outputDirectory).filter(name => /^catalog\.[0-9a-f]{64}\.json$/.test(name) && name !== catalogFileName);
const removedFiles = staleFiles.filter(name => {
    try {
        rmSync(resolve(outputDirectory, name));
        return true;
    } catch (err) {
        // A running dev server may hold the file open; it will be removed on the next run.
        console.warn(`Could not remove ${name}: ${err.code || err.message}`);
        return false;
    }
});
console.log(`Wrote ${items.length} catalog entries to ${outputDirectory}`);
if (removedFiles.length > 0) {
    console.log(`Removed ${removedFiles.length} outdated catalog file(s).`);
}