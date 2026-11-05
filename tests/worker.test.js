import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { regenerateCatalog, scheduleCatalogRegeneration } from '../worker.js';

function makeEnv(rows = []) {
    const objects = new Map();
    return {
        objects,
        DB: {
            prepare() {
                return { all: async () => ({ results: rows, meta: { rows_read: rows.length } }) };
            }
        },
        CATALOG: {
            async get(key) {
                const value = objects.get(key);
                return value ? { json: async () => JSON.parse(value) } : null;
            },
            async put(key, value) {
                objects.set(key, value);
            }
        }
    };
}

test('regenerates and publishes a normalized catalog', async () => {
    const env = makeEnv([{
        id: 'asset:a',
        skinName: 'Skin',
        skinReleaseDate: null,
        releaseYear: null,
        skinline: 'Skin',
        category: 'Promoart',
        game: 'Game',
        tags: '["B","A"]'
    }]);

    const result = await regenerateCatalog(env);
    assert.equal(result.updated, true);
    assert.equal(result.itemCount, 1);
    const manifest = JSON.parse(env.objects.get('catalog/catalog-manifest.json'));
    const catalogKey = new URL(manifest.catalogUrl).pathname.slice(1);
    const catalog = JSON.parse(env.objects.get(catalogKey));
    assert.equal(catalog.items[0].skinReleaseDate, 'Unknown');
    assert.deepEqual(catalog.items[0].tags, ['B', 'A']);
    assert.deepEqual(catalog.filters.tags, ['A', 'B']);
    assert.match(catalogKey, /^catalog\/catalog\.[a-f0-9]{64}\.json$/);

    const putsBefore = env.objects.size;
    const secondResult = await regenerateCatalog(env);
    assert.equal(secondResult.updated, false);
    assert.equal(env.objects.size, putsBefore);
});

test('admin catalog regeneration requires the bearer token', async () => {
    const response = await worker.fetch(new Request('https://api.example/api/admin/catalog/regenerate', {
        method: 'POST'
    }), { ADMIN_TOKEN: 'test-token' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('admin catalog regeneration runs for a valid bearer token', async () => {
    const env = makeEnv();
    const response = await worker.fetch(new Request('https://api.example/api/admin/catalog/regenerate', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' }
    }), { ...env, ADMIN_TOKEN: 'test-token' });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).updated, true);
    assert.ok(env.objects.has('catalog/catalog-manifest.json'));
});

test('scheduled regeneration logs rejected runs and settles waitUntil', async () => {
    let scheduled;
    const logged = [];
    scheduleCatalogRegeneration(
        { waitUntil(promise) { scheduled = promise; } },
        {},
        async () => { throw new Error('D1 unavailable'); },
        { error: (...args) => logged.push(args) }
    );

    await scheduled;
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], 'Scheduled catalog regeneration failed');
    assert.equal(logged[0][1].message, 'D1 unavailable');
});

test('scheduled handler uses waitUntil for regeneration', async () => {
    let scheduled;
    const env = makeEnv();
    worker.scheduled({}, env, { waitUntil(promise) { scheduled = promise; } });
    await scheduled;
    assert.ok(env.objects.has('catalog/catalog-manifest.json'));
});
