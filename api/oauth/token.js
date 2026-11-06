'use strict';

// OAuth authorization codes are exchanged server-side with Deriv. Never log the
// request body or the response: both may contain credentials.
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const MAX_BODY_BYTES = 16 * 1024;

function reply(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    if (req.body !== undefined) {
        if (typeof req.body === 'object' && req.body !== null) {
            if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) throw new Error('body too large');
            return req.body;
        }
        if (typeof req.body === 'string' && Buffer.byteLength(req.body) <= MAX_BODY_BYTES) return JSON.parse(req.body);
        throw new Error('invalid body');
    }
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('body too large');
    }
    return JSON.parse(body);
}

module.exports = async function tokenExchange(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return reply(res, 405, { error: 'method_not_allowed' });
    }
    let body;
    try { body = await readBody(req); }
    catch { return reply(res, 400, { error: 'invalid_request', error_description: 'Invalid request body.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return reply(res, 400, { error: 'invalid_request', error_description: 'Invalid request body.' });
    const { grant_type, client_id, code, code_verifier, redirect_uri } = body;
    let redirect;
    try { redirect = new URL(redirect_uri); } catch {}
    if (grant_type !== 'authorization_code' ||
        typeof client_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(client_id) ||
        typeof code !== 'string' || !code || code.length > 4096 ||
        typeof code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier) ||
        !redirect || redirect.pathname !== '/callback' || redirect.search || redirect.hash || redirect.username || redirect.password ||
        !(redirect.protocol === 'https:' || (redirect.protocol === 'http:' && redirect.hostname === 'localhost'))) {
        return reply(res, 400, { error: 'invalid_request', error_description: 'Invalid OAuth exchange parameters.' });
    }
    const params = new URLSearchParams({ grant_type, client_id, code, code_verifier, redirect_uri });
    try {
        const upstream = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: params.toString(),
            signal: AbortSignal.timeout(12000),
            redirect: 'error',
        });
        const data = await upstream.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
        return reply(res, upstream.status, data);
    } catch {
        return reply(res, 502, { error: 'token_exchange_failed', error_description: 'Could not reach the Deriv authentication service. Please try signing in again.' });
    }
};
