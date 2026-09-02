const CATALOG_PREFIX = 'catalog/';
const CATALOG_MANIFEST_KEY = `${CATALOG_PREFIX}catalog-manifest.json`;
const CATALOG_ASSET_ORIGIN = 'https://assets.timfernix.dev';

const catalogQuery = `
    WITH catalog AS (
        SELECT
            'asset:' || a.r2_key AS id,
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

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function regenerateCatalog(env) {
    if (!env.CATALOG) {
        throw new Error('Missing CATALOG R2 binding.');
    }

    const catalogResult = await env.DB.prepare(catalogQuery).all();
    const items = (catalogResult.results || []).map(row => ({
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
            games: sortedDistinct(items.map(item => item.game).filter(game => game !== 'Generic'))
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

export default {
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(regenerateCatalog(env));
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

/* Legacy gallery API retired in favor of the static catalog. */
/*
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const CACHE_TTL_SECONDS = 120; // reuse identical GET responses to avoid re-scanning D1
const CATALOG_PREFIX = 'catalog/';
const CATALOG_MANIFEST_KEY = `${CATALOG_PREFIX}catalog-manifest.json`;
const CATALOG_ASSET_ORIGIN = 'https://assets.timfernix.dev';

const catalogQuery = `
    WITH catalog AS (
        SELECT
            'asset:' || a.r2_key AS id,
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

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function regenerateCatalog(env) {
    if (!env.CATALOG) {
        throw new Error('Missing CATALOG R2 binding.');
    }

    const catalogResult = await env.DB.prepare(catalogQuery).all();
    const items = (catalogResult.results || []).map(row => ({
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
            games: sortedDistinct(items.map(item => item.game).filter(game => game !== 'Generic'))
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
    const catalog = { version: contentHash, ...content };
    const manifest = {
        version: contentHash,
        catalogUrl: `${CATALOG_ASSET_ORIGIN}/${catalogKey}`,
        generatedAt: new Date().toISOString()
    };

    await env.CATALOG.put(catalogKey, JSON.stringify(catalog), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' }
    });
    await env.CATALOG.put(CATALOG_MANIFEST_KEY, JSON.stringify(manifest), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache, must-revalidate' }
    });

    return { updated: true, version: contentHash, itemCount: items.length, rowsRead: catalogResult.meta?.rows_read };
}

export default {
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(regenerateCatalog(env));
    },

    async fetch(request, env, ctx) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Content-Type": "application/json"
        };

        if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

        const url = new URL(request.url);
        const cache = caches.default;

        if (url.pathname === '/api/skins' || url.pathname === '/api/filters' || url.pathname === '/api/asset') {
            return new Response('Not found', { status: 404 });
        }

        if (url.pathname === '/admin/catalog/regenerate') {
            const expectedAuthorization = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : null;
            if (request.method !== 'POST' || !expectedAuthorization || request.headers.get('Authorization') !== expectedAuthorization) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
            }

            try {
                const result = await regenerateCatalog(env);
                return new Response(JSON.stringify(result), { headers: corsHeaders });
            } catch (err) {
                console.error('Catalog generation failed:', err);
                return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
            }
        }

        // Cache-Control does not apply on cache miss, so read/write the edge cache explicitly.
        const cachedResponse = request.method === "GET" ? await cache.match(request) : null;
        if (cachedResponse) {
            return cachedResponse;
        }

        const respondCached = (body, status = 200) => {
            const response = new Response(JSON.stringify(body), {
                status,
                headers: { ...corsHeaders, "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` }
            });
            if (status === 200 && request.method === "GET") {
                ctx.waitUntil(cache.put(request, response.clone()));
            }
            return response;
        };

        const safeParseJSON = (data) => {
            if (!data) return [];
            if (typeof data === 'object') return Array.isArray(data) ? data : [data];
            if (typeof data !== 'string') return [];
            if (data === "null" || data.trim() === "") return [];
            try {
                return JSON.parse(data);
            } catch (e) {
                console.error("Konnte Datenbank-Eintrag nicht parsen:", data);
                return [];
            }
        };

        // Whitelisted ORDER BY clauses only — never build ORDER BY from raw user input.
        const buildOrderByClause = (sort) => {
            switch (sort) {
                case 'oldest':
                    return 'ORDER BY CAST(releaseYear AS INTEGER) ASC, skinName ASC, title ASC';
                case 'name-asc':
                    return 'ORDER BY title ASC';
                case 'skinline-asc':
                    return 'ORDER BY skinline ASC, title ASC';
                case 'none':
                    return '';
                case 'newest':
                default:
                    return 'ORDER BY CAST(releaseYear AS INTEGER) DESC, skinName ASC, title ASC';
            }
        };

        // ── /api/skins
        // Always paginated: server-side filtering keeps row reads bounded regardless of archive size.
        if (url.pathname === "/api/skins") {
            const limitParam = url.searchParams.get('limit');
            const offsetParam = url.searchParams.get('offset');
            const limit = Math.min(Math.max(parseInt(limitParam, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
            const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

            const searchTerm = (url.searchParams.get('q') || '').trim();
            const skinlineFilters = url.searchParams.getAll('skinline').map(v => v.trim()).filter(Boolean);
            const categoryFilters = url.searchParams.getAll('category').map(v => v.trim()).filter(Boolean);
            const gameFilters = url.searchParams.getAll('game').map(v => v.trim()).filter(Boolean);
            const sort = url.searchParams.get('sort') || 'newest';

            const orderByClause = buildOrderByClause(sort);

            // Skinline = skin name with a trailing " Ezreal" stripped (mirrors the frontend's deriveSkinlineFromName).
            const skinlineExpr = `
                CASE
                    WHEN LOWER(TRIM(s.name)) LIKE '% ezreal' THEN TRIM(SUBSTR(TRIM(s.name), 1, LENGTH(TRIM(s.name)) - 7))
                    ELSE TRIM(s.name)
                END
            `;

            const flatCte = `
                WITH flat AS (
                    SELECT
                        s.name        AS skinName,
                        s.description AS description,
                        s.release_year AS skinReleaseYear,
                        a.type        AS type,
                        a.r2_key      AS url,
                        COALESCE(a.title, a.r2_key) AS title,
                        a.category    AS category,
                        a.game        AS game,
                        a.asset_release_year AS releaseYear,
                        a.id           AS assetId,
                        NULL           AS platform,
                        'asset'        AS source,
                        ${skinlineExpr} AS skinline
                    FROM assets a
                    JOIN skins s ON s.id = a.skin_id

                    UNION ALL

                    SELECT
                        s.name        AS skinName,
                        s.description AS description,
                        s.release_year AS skinReleaseYear,
                        'external'    AS type,
                        el.url        AS url,
                        COALESCE(el.title, el.url) AS title,
                        el.category   AS category,
                        el.game       AS game,
                        el.asset_release_year AS releaseYear,
                        NULL          AS assetId,
                        el.platform   AS platform,
                        'external_link' AS source,
                        ${skinlineExpr} AS skinline
                    FROM external_links el
                    JOIN skins s ON s.id = el.skin_id
                )
            `;

            const whereClauses = [];
            const whereParams = [];

            if (skinlineFilters.length > 0) {
                whereClauses.push(`skinline IN (${skinlineFilters.map(() => '?').join(',')})`);
                whereParams.push(...skinlineFilters);
            }

            if (categoryFilters.length > 0) {
                whereClauses.push(`category IN (${categoryFilters.map(() => '?').join(',')})`);
                whereParams.push(...categoryFilters);
            }

            if (gameFilters.length > 0) {
                whereClauses.push(`game IN (${gameFilters.map(() => '?').join(',')})`);
                whereParams.push(...gameFilters);
            }

            if (searchTerm) {
                const likeParam = `%${searchTerm}%`;
                whereClauses.push(`(
                    title LIKE ? OR
                    skinName LIKE ? OR
                    skinline LIKE ? OR
                    description LIKE ? OR
                    category LIKE ? OR
                    game LIKE ? OR
                    CAST(releaseYear AS TEXT) LIKE ? OR
                    (source = 'asset' AND EXISTS (
                        SELECT 1 FROM asset_tags atg
                        JOIN tags tg ON tg.id = atg.tag_id
                        WHERE atg.asset_id = flat.assetId AND tg.name LIKE ?
                    ))
                )`);
                whereParams.push(likeParam, likeParam, likeParam, likeParam, likeParam, likeParam, likeParam, likeParam);
            }

            const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

            try {
                const pageQuery = `
                    ${flatCte}
                    SELECT * FROM flat
                    ${whereSql}
                    ${orderByClause}
                    LIMIT ? OFFSET ?
                `;

                const pageResult = await env.DB.prepare(pageQuery).bind(...whereParams, limit, offset).all();
                const { results } = pageResult;

                // Total only needs to be known once — recomputing it on every subsequent page would
                // re-scan the whole (filtered) table again for no benefit, since the client caches it.
                let total = null;
                if (offset === 0) {
                    if (whereClauses.length === 0) {
                        const countResult = await env.DB.prepare(`
                            SELECT
                                (SELECT COUNT(*) FROM assets) + (SELECT COUNT(*) FROM external_links) AS total
                        `).all();
                        const countRow = countResult.results?.[0];
                        total = countRow?.total ?? 0;
                    } else {
                        const countQuery = `${flatCte} SELECT COUNT(*) AS total FROM flat ${whereSql}`;
                        const countResult = await env.DB.prepare(countQuery).bind(...whereParams).all();
                        const countRow = countResult.results?.[0];
                        total = countRow?.total ?? 0;
                    }
                }

                // Only look up tags for the assets that ended up on this page, not the whole table.
                const pageAssetIds = [...new Set(results.map(row => row.assetId).filter(id => id !== null && id !== undefined))];
                const tagsByAssetId = {};

                if (pageAssetIds.length > 0) {
                    const placeholders = pageAssetIds.map(() => '?').join(',');
                    const tagResult = await env.DB.prepare(`
                        SELECT at2.asset_id AS assetId, json_group_array(t.name) AS tags
                        FROM asset_tags at2
                        JOIN tags t ON t.id = at2.tag_id
                        WHERE at2.asset_id IN (${placeholders})
                        GROUP BY at2.asset_id
                    `).bind(...pageAssetIds).all();
                    const { results: tagRows } = tagResult;

                    tagRows.forEach(row => {
                        tagsByAssetId[row.assetId] = row.tags;
                    });
                }

                const items = results.map(row => ({
                    skinName:       row.skinName,
                    description:    row.description,
                    skinReleaseYear: String(row.skinReleaseYear ?? 'Unknown'),
                    type:           row.type,
                    url:            row.url,
                    title:          row.title,
                    category:       row.category    || 'Uncategorized',
                    game:           row.game        || 'Generic',
                    releaseYear:    String(row.releaseYear ?? 'Unknown'),
                    tags:           safeParseJSON(tagsByAssetId[row.assetId] || '[]').filter(Boolean),
                    platform:       row.platform    || '',
                    source:         row.source      || 'asset',
                    skinline:       row.skinline
                }));

                const nextOffset = offset + items.length;
                // Without a fresh total (pages after the first) fall back to the standard
                // "got a full page, so there's probably more" heuristic; the next request self-corrects.
                const hasMore = total !== null ? nextOffset < total : items.length >= limit;

                return respondCached({ items, hasMore, nextOffset, total });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
            }
        }

        // ── /api/asset ──────────────────────────────────────────────────────
        // Direkt-Lookup eines einzelnen Assets für Deep-Links (?asset=...)
        // Erwartet: ?id=source:url  (z. B. asset:skins/base/icon.png)
        if (url.pathname === "/api/asset") {
            const rawId = url.searchParams.get('id');
            if (!rawId) {
                return new Response(JSON.stringify({ error: "Missing id parameter" }), { status: 400, headers: corsHeaders });
            }

            const colonIdx = rawId.indexOf(':');
            if (colonIdx === -1) {
                return new Response(JSON.stringify({ error: "Invalid id format" }), { status: 400, headers: corsHeaders });
            }

            const source = rawId.slice(0, colonIdx);
            const assetUrl = rawId.slice(colonIdx + 1);

            if (!source || !assetUrl) {
                return new Response(JSON.stringify({ error: "Invalid id format" }), { status: 400, headers: corsHeaders });
            }

            try {
                let row = null;

                if (source === 'asset') {
                    const result = await env.DB.prepare(`
                        SELECT
                            s.name        AS skinName,
                            s.description AS description,
                            s.release_year AS skinReleaseYear,
                            a.type        AS type,
                            a.r2_key      AS url,
                            COALESCE(a.title, a.r2_key) AS title,
                            a.category    AS category,
                            a.game        AS game,
                            a.asset_release_year AS releaseYear,
                            (
                                SELECT json_group_array(t.name)
                                FROM tags t
                                JOIN asset_tags at2 ON t.id = at2.tag_id
                                WHERE at2.asset_id = a.id
                            ) AS tags,
                            NULL          AS platform,
                            'asset'       AS source
                        FROM assets a
                        JOIN skins s ON s.id = a.skin_id
                        WHERE a.r2_key = ?
                        LIMIT 1
                    `).bind(assetUrl).first();
                    row = result;
                } else if (source === 'external_link') {
                    const result = await env.DB.prepare(`
                        SELECT
                            s.name        AS skinName,
                            s.description AS description,
                            s.release_year AS skinReleaseYear,
                            'external'    AS type,
                            el.url        AS url,
                            COALESCE(el.title, el.url) AS title,
                            el.category   AS category,
                            el.game       AS game,
                            el.asset_release_year AS releaseYear,
                            '[]'          AS tags,
                            el.platform   AS platform,
                            'external_link' AS source
                        FROM external_links el
                        JOIN skins s ON s.id = el.skin_id
                        WHERE el.url = ?
                        LIMIT 1
                    `).bind(assetUrl).first();
                    row = result;
                }

                if (!row) {
                    return new Response(JSON.stringify({ error: "Asset not found" }), { status: 404, headers: corsHeaders });
                }

                const item = {
                    skinName:        row.skinName,
                    description:     row.description,
                    skinReleaseYear: String(row.skinReleaseYear ?? 'Unknown'),
                    type:            row.type,
                    url:             row.url,
                    title:           row.title,
                    category:        row.category    || 'Uncategorized',
                    game:            row.game        || 'Generic',
                    releaseYear:     String(row.releaseYear ?? 'Unknown'),
                    tags:            safeParseJSON(row.tags).filter(Boolean),
                    platform:        row.platform    || '',
                    source:          row.source      || 'asset'
                };

                return respondCached(item);
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
            }
        }

        // ── /api/filters
    
        if (url.pathname === "/api/filters") {
            try {
                // Fetch all distinct skin names and extract skinlines
                const skinsData = await env.DB.prepare(`
                    SELECT DISTINCT s.name
                    FROM skins s
                    WHERE s.name IS NOT NULL AND TRIM(s.name) != ''
                    ORDER BY s.name ASC
                `).all();

                // Extract skinlines by removing " Ezreal" from the end (case-insensitive)
                const skinlines = (skinsData.results || [])
                    .map(row => {
                        if (!row || !row.name) return null;
                        // Remove " Ezreal" suffix (case-insensitive)
                        const name = row.name.trim();
                        const skinline = name.replace(/\s+ezreal\s*$/i, '').trim();
                        return skinline || name;
                    })
                    .filter((value, index, self) => value && self.indexOf(value) === index)
                    .sort();

                const categoriesData = await env.DB.prepare(`
                    SELECT DISTINCT a.category
                    FROM assets a
                    WHERE a.category IS NOT NULL AND TRIM(a.category) != ''
                    
                    UNION
                    
                    SELECT DISTINCT el.category
                    FROM external_links el
                    WHERE el.category IS NOT NULL AND TRIM(el.category) != ''
                    
                    ORDER BY category ASC
                `).all();

                const gamesData = await env.DB.prepare(`
                    SELECT DISTINCT a.game
                    FROM assets a
                    WHERE a.game IS NOT NULL AND TRIM(a.game) != '' AND a.game != 'Generic'
                    
                    UNION
                    
                    SELECT DISTINCT el.game
                    FROM external_links el
                    WHERE el.game IS NOT NULL AND TRIM(el.game) != '' AND el.game != 'Generic'
                    
                    ORDER BY game ASC
                `).all();

                const categories = (categoriesData.results || [])
                    .map(row => row.category || 'Uncategorized')
                    .filter((value, index, self) => value && self.indexOf(value) === index)
                    .sort();

                const games = (gamesData.results || [])
                    .map(row => row.game || 'Generic')
                    .filter((value, index, self) => value && self.indexOf(value) === index)
                    .sort();

                console.log('Filter options:', { skinlines: skinlines.length, categories: categories.length, games: games.length });
                return respondCached({ skinlines, categories, games });
            } catch (err) {
                console.error('Filter endpoint error:', err);
                return new Response(JSON.stringify({ error: err.message, skinlines: [], categories: [], games: [] }), { status: 500, headers: corsHeaders });
            }
        }

        return new Response("Not found", { status: 404 });
    }
};
*/