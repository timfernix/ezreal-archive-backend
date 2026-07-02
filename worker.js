const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export default {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Content-Type": "application/json"
        };

        if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

        const url = new URL(request.url);

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

        // ── /api/skins 
        if (url.pathname === "/api/skins") {
            const limitParam = url.searchParams.get('limit');
            const offsetParam = url.searchParams.get('offset');
            const usePagination = limitParam !== null;

            if (usePagination) {
                // Flat paginated response: { items, hasMore, nextOffset, total }
                const limit = Math.min(Math.max(parseInt(limitParam, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
                const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

                try {
                    const { results } = await env.DB.prepare(`
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
                                (
                                    SELECT json_group_array(t.name)
                                    FROM tags t
                                    JOIN asset_tags at2 ON t.id = at2.tag_id
                                    WHERE at2.asset_id = a.id
                                ) AS tags,
                                NULL           AS platform,
                                'asset'        AS source
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
                                '[]'          AS tags,
                                el.platform   AS platform,
                                'external_link' AS source
                            FROM external_links el
                            JOIN skins s ON s.id = el.skin_id
                        )
                        SELECT
                            *,
                            (SELECT COUNT(*) FROM flat) AS total
                        FROM flat
                        ORDER BY
                            CAST(releaseYear AS INTEGER) DESC,
                            skinName ASC,
                            title ASC
                        LIMIT ? OFFSET ?
                    `).bind(limit, offset).all();

                    const total = results.length > 0 ? results[0].total : 0;

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
                        tags:           safeParseJSON(row.tags).filter(Boolean),
                        platform:       row.platform    || '',
                        source:         row.source      || 'asset'
                    }));

                    const nextOffset = offset + items.length;
                    const hasMore = nextOffset < total;

                    return new Response(JSON.stringify({ items, hasMore, nextOffset, total }), { headers: corsHeaders });
                } catch (err) {
                    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
                }
            }

            // Legacy (no pagination params)
            try {
                const { results } = await env.DB.prepare(`
                    SELECT
                        s.codename,
                        s.name,
                        s.description,
                        s.release_year,
                        (
                            SELECT json_group_array(json_object(
                                'type', m.type,
                                'url', m.url,
                                'title', m.title,
                                'category', m.category,
                                'game', m.game,
                                'assetReleaseYear', m.assetReleaseYear,
                                'tags', m.tags,
                                'platform', m.platform,
                                'source', m.source
                            ))
                            FROM (
                                SELECT
                                    a.type AS type,
                                    a.r2_key AS url,
                                    COALESCE(a.title, a.r2_key) AS title,
                                    a.category AS category,
                                    a.game AS game,
                                    a.asset_release_year AS assetReleaseYear,
                                    (
                                        SELECT json_group_array(t.name)
                                        FROM tags t
                                        JOIN asset_tags at ON t.id = at.tag_id
                                        WHERE at.asset_id = a.id
                                    ) AS tags,
                                    NULL AS platform,
                                    'asset' AS source
                                FROM assets a
                                WHERE a.skin_id = s.id

                                UNION ALL

                                SELECT
                                    'external' AS type,
                                    el.url AS url,
                                    COALESCE(el.title, el.url) AS title,
                                    el.category AS category,
                                    el.game AS game,
                                    el.asset_release_year AS assetReleaseYear,
                                    '[]' AS tags,
                                    el.platform AS platform,
                                    'external_link' AS source
                                FROM external_links el
                                WHERE el.skin_id = s.id
                            ) m
                        ) AS media
                    FROM skins s
                `).all();

                const formatted = results.map(row => ({
                    skinName:    row.name,
                    skinCodename: row.codename,
                    description: row.description,
                    releaseYear: row.release_year,
                    media: safeParseJSON(row.media).map(m => ({
                        ...m,
                        tags: safeParseJSON(m.tags).filter(Boolean)
                    }))
                })).filter(skin => skin.media && skin.media.length > 0);

                return new Response(JSON.stringify(formatted), { headers: corsHeaders });
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

                return new Response(JSON.stringify(item), { headers: corsHeaders });
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
                return new Response(JSON.stringify({ skinlines, categories, games }), { headers: corsHeaders });
            } catch (err) {
                console.error('Filter endpoint error:', err);
                return new Response(JSON.stringify({ error: err.message, skinlines: [], categories: [], games: [] }), { status: 500, headers: corsHeaders });
            }
        }

        return new Response("Not found", { status: 404 });
    }
};