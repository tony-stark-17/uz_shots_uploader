const fs = require('fs');
const path = require('path');
const https = require('https');

const RESOURCE = GetCurrentResourceName();

const SOURCE_RESOURCE = GetConvar('uz_shots_source_resource', 'uz_AutoShot');
const SOURCE_SUBDIR   = GetConvar('uz_shots_source_subdir', 'shots');
const REMOTE_PREFIX   = GetConvar('uz_shots_remote_prefix', 'uz_autoshot');
const API_HOST        = GetConvar('fivemanage_api_host', 'api.fivemanage.com');
const REQUEST_DELAY   = parseInt(GetConvar('uz_shots_delay_ms', '150'), 10) || 0;
const MAX_RETRIES     = parseInt(GetConvar('uz_shots_max_retries', '3'), 10) || 1;
const ALLOWED_EXT     = /\.(png|webp|jpe?g|mp4|mp3|wav|ogg)$/i;

const RES_PATH = GetResourcePath(RESOURCE);
const OUTPUT_DIR = path.join(RES_PATH, 'output');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'uploaded.json');
const FAILED_PATH = path.join(OUTPUT_DIR, 'failed.json');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function resolveSourceDir() {
    const base = GetResourcePath(SOURCE_RESOURCE);
    if (!base) throw new Error(`could not resolve resource path for "${SOURCE_RESOURCE}" — is it started or installed?`);
    return path.join(base, SOURCE_SUBDIR);
}

function walk(dir, rel = '') {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return out; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...walk(full, r));
        } else if (ALLOWED_EXT.test(entry.name)) {
            out.push({ full, rel: r, size: entry.isFile() ? fs.statSync(full).size : 0 });
        }
    }
    return out;
}

function uploadOnce(apiKey, absPath, remotePath, filename) {
    return new Promise((resolve, reject) => {
        let buf;
        try { buf = fs.readFileSync(absPath); }
        catch (e) { return reject(new Error(`read failed: ${e.message}`)); }

        const body = JSON.stringify({
            base64: buf.toString('base64'),
            filename,
            path: remotePath || undefined,
        });

        const req = https.request({
            method: 'POST',
            hostname: API_HOST,
            path: '/api/v3/file/base64',
            headers: {
                'Authorization': apiKey,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent': `uz_shots_uploader/1.0 (FXServer; ${RESOURCE})`,
            },
            timeout: 60000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error(`bad json (status ${res.statusCode}): ${data.slice(0, 200)}`)); }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function uploadWithRetry(apiKey, absPath, remotePath, filename) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try { return await uploadOnce(apiKey, absPath, remotePath, filename); }
        catch (e) {
            lastErr = e;
            if (attempt < MAX_RETRIES) await sleep(500 * attempt);
        }
    }
    throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let isRunning = false;

async function runUpload(triggeredBy) {
    if (isRunning) {
        console.log('^3[uz_shots_uploader]^0 already running, ignoring request');
        return;
    }
    const apiKey = GetConvar('fivemanage_api_key', '');
    if (!apiKey) {
        console.log('^1[uz_shots_uploader]^0 set the convar `fivemanage_api_key` in server.cfg first');
        return;
    }

    let sourceDir;
    try { sourceDir = resolveSourceDir(); }
    catch (e) { console.log(`^1[uz_shots_uploader]^0 ${e.message}`); return; }

    if (!fs.existsSync(sourceDir)) {
        console.log(`^1[uz_shots_uploader]^0 shots folder not found: ${sourceDir}`);
        return;
    }

    isRunning = true;
    const startedAt = Date.now();
    const manifest = loadJson(MANIFEST_PATH, {});
    const failed   = loadJson(FAILED_PATH, {});

    const files = walk(sourceDir);
    const total = files.length;
    let done = 0, skipped = 0, errored = 0;

    console.log(`^2[uz_shots_uploader]^0 (${triggeredBy}) starting — ${total} candidate file(s) under ${sourceDir}`);

    try {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (manifest[f.rel] && manifest[f.rel].url) { skipped++; continue; }

            const relDir = path.posix.dirname(f.rel.split(path.sep).join('/'));
            const remoteDir = relDir === '.' ? REMOTE_PREFIX : (REMOTE_PREFIX ? `${REMOTE_PREFIX}/${relDir}` : relDir);
            const filename = path.basename(f.rel);

            try {
                const res = await uploadWithRetry(apiKey, f.full, remoteDir, filename);
                manifest[f.rel] = {
                    url: res?.data?.url,
                    originalUrl: res?.data?.originalUrl,
                    id: res?.data?.id,
                    remotePath: remoteDir,
                    size: f.size,
                    uploadedAt: new Date().toISOString(),
                };
                if (failed[f.rel]) delete failed[f.rel];
                done++;
                if (done % 10 === 0 || done === 1) saveJson(MANIFEST_PATH, manifest);
                console.log(`^2[uz_shots_uploader]^0 (${i + 1}/${total}) ${f.rel} -> ${res?.data?.url}`);
            } catch (e) {
                errored++;
                failed[f.rel] = { error: e.message, attemptedAt: new Date().toISOString(), remotePath: remoteDir };
                console.log(`^1[uz_shots_uploader]^0 (${i + 1}/${total}) ${f.rel} FAILED: ${e.message}`);
            }

            if (REQUEST_DELAY > 0) await sleep(REQUEST_DELAY);
        }
    } finally {
        saveJson(MANIFEST_PATH, manifest);
        saveJson(FAILED_PATH, failed);
        isRunning = false;
    }

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`^2[uz_shots_uploader]^0 done in ${secs}s — uploaded=${done} skipped=${skipped} failed=${errored}`);
    console.log(`^2[uz_shots_uploader]^0 manifest: ${MANIFEST_PATH}`);
}

RegisterCommand('uploadshots', (source) => {
    const src = typeof source === 'number' ? source : parseInt(source, 10);
    if (src !== 0) {
        if (!IsPlayerAceAllowed(String(src), 'command.uploadshots')) {
            console.log(`^3[uz_shots_uploader]^0 player ${src} denied (missing command.uploadshots ace)`);
            return;
        }
    }
    runUpload(src === 0 ? 'console' : `player:${src}`).catch((e) => {
        console.log(`^1[uz_shots_uploader]^0 fatal: ${e.stack || e.message}`);
    });
}, true);

RegisterCommand('uploadshots_status', (source) => {
    const src = typeof source === 'number' ? source : parseInt(source, 10);
    if (src !== 0 && !IsPlayerAceAllowed(String(src), 'command.uploadshots')) return;
    const manifest = loadJson(MANIFEST_PATH, {});
    const failed   = loadJson(FAILED_PATH, {});
    console.log(`^2[uz_shots_uploader]^0 manifest=${Object.keys(manifest).length} failed=${Object.keys(failed).length} running=${isRunning}`);
}, true);

RegisterCommand('uploadshots_reset', (source) => {
    const src = typeof source === 'number' ? source : parseInt(source, 10);
    if (src !== 0 && !IsPlayerAceAllowed(String(src), 'command.uploadshots')) return;
    if (isRunning) {
        console.log('^3[uz_shots_uploader]^0 cannot reset while upload is running');
        return;
    }
    saveJson(MANIFEST_PATH, {});
    saveJson(FAILED_PATH, {});
    console.log('^2[uz_shots_uploader]^0 manifest cleared');
}, true);

console.log(`^2[uz_shots_uploader]^0 ready. run \`uploadshots\` in the server console to start.`);
