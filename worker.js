export default {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "https://timfernix.dev",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Content-Type": "application/json"
        };

        if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

        const url = new URL(request.url);

        if (url.pathname === "/api/skins") {
            try {
                const { results } = await env.DB.prepare(`
                    SELECT 
                        s.codename, s.name,
                        (
                            SELECT json_group_array(json_object(
                                'type', a.type, 
                                'url', a.r2_key, 
                                'category', a.category, 
                                'game', a.game,
                                'tags', (
                                    SELECT json_group_array(t.name) 
                                    FROM tags t 
                                    JOIN asset_tags at ON t.id = at.tag_id 
                                    WHERE at.asset_id = a.id
                                )
                            )) 
                            FROM assets a WHERE a.skin_id = s.id
                        ) as media
                    FROM skins s
                `).all();

                const formatted = results.map(row => ({
                    skinName: row.name,
                    skinCodename: row.codename,
                    media: JSON.parse(row.media || '[]').map(m => ({
                        ...m,
                        tags: JSON.parse(m.tags || '[]')
                    }))
                })).filter(skin => skin.media.length > 0);

                return new Response(JSON.stringify(formatted), { headers: corsHeaders });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
            }
        }

        return new Response("Not found", { status: 404 });
    }
};