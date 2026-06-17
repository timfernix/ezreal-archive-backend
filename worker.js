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
                        s.id, s.codename, s.name, s.description, s.release_year,
                        (SELECT json_group_array(json_object('type', type, 'r2_key', r2_key)) FROM assets WHERE skin_id = s.id) as media,
                        (SELECT json_group_array(t.name) FROM tags t JOIN skin_tags st ON t.id = st.tag_id WHERE st.skin_id = s.id) as tags,
                        (SELECT json_group_array(json_object('platform', platform, 'url', url)) FROM external_links WHERE skin_id = s.id) as externalLinks
                    FROM skins s
                `).all();

                const formatted = results.map(row => ({
                    ...row,
                    media: JSON.parse(row.media || '[]'),
                    tags: JSON.parse(row.tags || '[]'),
                    externalLinks: JSON.parse(row.externalLinks || '[]')
                }));

                return new Response(JSON.stringify(formatted), { headers: corsHeaders });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
            }
        }

        return new Response("Not found", { status: 404 });
    }
}; 
