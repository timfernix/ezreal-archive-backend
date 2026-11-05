const CATALOG_PREFIX = 'catalog/';
const CATALOG_MANIFEST_KEY = `${CATALOG_PREFIX}catalog-manifest.json`;
const CATALOG_ASSET_ORIGIN = 'https://assets.timfernix.dev';

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
            COALESCE(a.uploaded_at, '') AS uploadedAt,
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
            '' AS uploadedAt,
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

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function regenerateCatalog(env) {
    if (!env.CATALOG) {
        throw new Error('Missing CATALOG R2 binding.');
    }

    const catalogResult = await env.DB.prepare(catalogQuery).all();
    const items = (catalogResult.results || []).map(row => ({
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
    const contentHash = await sha256(JSON.stringify(content));
    const existingManifestObject = await env.CATALOG.get(CATALOG_MANIFEST_KEY);

    if (existingManifestObject) {
        const existingManifest = await existingManifestObject.json();
        if (existingManifest?.version === contentHash) {
            return { updated: false, version: contentHash, itemCount: items.length, rowsRead: catalogResult.meta?.rows_read };
        }
    }

    const catalogKey = `${CATALOG_PREFIX}catalog.${contentHash}.json`;
    const manifest = {
        version: contentHash,
        catalogUrl: `${CATALOG_ASSET_ORIGIN}/${catalogKey}`,
        generatedAt: new Date().toISOString()
    };

    await env.CATALOG.put(catalogKey, JSON.stringify({ version: contentHash, ...content }), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' }
    });
    await env.CATALOG.put(CATALOG_MANIFEST_KEY, JSON.stringify(manifest), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache, must-revalidate' }
    });

    return { updated: true, version: contentHash, itemCount: items.length, rowsRead: catalogResult.meta?.rows_read };
}

export function scheduleCatalogRegeneration(ctx, env, regenerate = regenerateCatalog, logger = console) {
    ctx.waitUntil(Promise.resolve()
        .then(() => regenerate(env))
        .catch(error => {
            logger.error('Scheduled catalog regeneration failed', {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
        }));
}

export default {
    async scheduled(controller, env, ctx) {
        scheduleCatalogRegeneration(ctx, env);
    },

    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname !== '/api/admin/catalog/regenerate') {
            return new Response('Not found', { status: 404 });
        }

        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        }

        const expectedAuthorization = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : null;
        if (!expectedAuthorization || request.headers.get('Authorization') !== expectedAuthorization) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        try {
            const result = await regenerateCatalog(env);
            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
        } catch (err) {
            console.error('Catalog generation failed:', err);
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
};
