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
            
            if (typeof data === 'object') {
                return Array.isArray(data) ? data : [data];
            }
            
            if (typeof data !== 'string') return [];
            
            if (data === "null" || data.trim() === "") return [];
            
            try {
                return JSON.parse(data);
            } catch (e) {
                console.error("Konnte Datenbank-Eintrag nicht parsen:", data);
                return []; 
            }
        };

        if (url.pathname === "/api/skins") {
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
                        ) as media
                    FROM skins s
                `).all();

                const formatted = results.map(row => ({
                    skinName: row.name,
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

        return new Response("Not found", { status: 404 });
    }
};