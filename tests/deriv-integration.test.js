'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const tokenExchange = require('../api/oauth/token');
const bundle = fs.readFileSync('scripts/index.39f61533.js', 'utf8');

function storage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
function loadModule(id, next, deps, globals = {}) {
    const start = bundle.indexOf(`    ${id}: function (e, t, n) {`);
    const end = bundle.indexOf(`    ${next}: function (e, t, n) {`, start);
    assert(start >= 0 && end > start, `module ${id} exists`);
    const body = bundle.slice(start, end).replace(/^\s*\d+: /, '').replace(/,\s*$/, '');
    const context = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout, Date, Map, Promise, ...globals });
    const factory = vm.runInContext(`(${body})`, context);
    const exports = {};
    const requireModule = id => { assert(id in deps, `missing dependency ${id}`); return deps[id]; };
    requireModule.d = (obj, definitions) => { for (const [key, getter] of Object.entries(definitions)) Object.defineProperty(obj, key, { enumerable: true, get: getter }); };
    factory({}, exports, requireModule);
    return exports;
}

const validBody = { grant_type: 'authorization_code', client_id: '34J0u7zObmeCX5lnl8zm7', code: 'one-use-code', code_verifier: 'A'.repeat(64), redirect_uri: 'https://dylantrades.site/callback' };
async function withServer(fn) {
    const server = http.createServer(tokenExchange);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await fn(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
}
test('token endpoint validates input, forwards once to Deriv, and does not cache secrets', async () => {
    const realFetch = global.fetch;
    const calls = [];
    await withServer(async url => {
        global.fetch = async (target, options) => {
            calls.push({ target, options });
            return { status: 200, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
        };
        try {
            const invalid = await realFetch(url, { method: 'POST', body: JSON.stringify({ ...validBody, code_verifier: 'short' }) });
            assert.equal(invalid.status, 400);
            assert.equal(calls.length, 0);
            const res = await realFetch(url, { method: 'POST', body: JSON.stringify(validBody) });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.equal((await res.json()).access_token, 'test-access-token');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].target, 'https://auth.deriv.com/oauth2/token');
            assert.equal(new URLSearchParams(calls[0].options.body).get('code_verifier'), validBody.code_verifier);
            assert.equal((await realFetch(url)).status, 405);
        } finally { global.fetch = realFetch; }
    });
});
test('token exchange reports upstream failures without leaking credentials', async () => {
    const realFetch = global.fetch;
    await withServer(async url => {
        global.fetch = async () => { throw Error('sensitive upstream detail'); };
        try {
            const res = await realFetch(url, { method: 'POST', body: JSON.stringify(validBody) });
            assert.equal(res.status, 502);
            assert.doesNotMatch(await res.text(), /sensitive|one-use-code/);
        } finally { global.fetch = realFetch; }
    });
});

test('accounts API uses production, bearer authentication, and a fresh OTP for the selected account', async () => {
    const localStorage = storage(), sessionStorage = storage(), calls = [];
    const demo = { account_id: 'DOT123', account_type: 'demo', balance: 1200, currency: 'USD', status: 'active' };
    const real = { account_id: 'CR123', account_type: 'real', balance: 30, currency: 'USD', status: 'active' };
    const deps = {
        27412: { _: (obj, key, value) => { obj[key] = value; } },
        5625: { Cy: () => [] },
        5568: { _Z: () => '' },
        39143: { x: async fn => fn(), K: () => false },
        7877: { k: async (url, options) => {
            calls.push({ url, options });
            return { ok: true, json: async () => url.endsWith('/otp') ? { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=one-use' } } : { data: [demo, real] } };
        } },
    };
    const { DerivWSAccountsService: service } = loadModule(30645, 7877, deps, { window: { location: { hostname: 'localhost' } }, localStorage, sessionStorage });
    const accounts = await service.fetchAccountsList('test-token');
    assert.equal(accounts.length, 2);
    assert.equal(calls[0].url, 'https://api.derivws.com/trading/v1/options/accounts');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    localStorage.setItem('active_loginid', 'DOT123');
    const socket = await service.getAuthenticatedWebSocketURL('test-token', 'DOT123');
    assert.equal(socket, 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=one-use');
    assert.equal(calls[1].url, 'https://api.derivws.com/trading/v1/options/accounts/DOT123/otp');
    assert.equal(calls[1].options.method, 'POST');
    service.updateStoredAccountBalance('DOT123', 1234.5, 'USD');
    assert.equal(service.getStoredAccounts()[0].balance, '1234.5');
    assert.equal(JSON.parse(localStorage.getItem('clientAccounts')).DOT123.balance, 1234.5);
});

test('OAuth exchange uses backend once and initializes the selected demo session', async () => {
    const localStorage = storage(), sessionStorage = storage(), calls = [];
    let active;
    const accountService = {
        fetchAccountsList: async () => [
            { account_id: 'CR123', account_type: 'real', currency: 'USD', status: 'active', balance: 10 },
            { account_id: 'DOT123', account_type: 'demo', currency: 'USD', status: 'active', balance: 1000 },
        ],
        getAuthenticatedWebSocketURL: () => { throw Error('must not pre-consume OTP'); },
    };
    const deps = {
        66175: { jf2: { CLIENT_ID: validBody.client_id }, SmL: () => validBody.redirect_uri, Q0H: () => '/api/oauth/token' },
        5625: { Cy: () => [] },
        5568: { _Z: () => '', ii: data => { active = data.activeLoginId; localStorage.setItem('active_loginid', active); }, W7: () => {} },
        30645: { DerivWSAccountsService: accountService },
        7877: { k: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) }; } },
        39143: { x: async fn => fn(), K: () => false },
        88199: { api_base: { init: async () => {} } },
    };
    const oauth = loadModule(58454, 39143, deps, { localStorage, sessionStorage });
    oauth.storeCodeVerifier(validBody.code_verifier);
    const result = await oauth.OAuthTokenExchangeService.exchangeCodeForToken(validBody.code);
    assert.equal(result.access_token, 'test-token');
    assert.equal(active, 'DOT123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/oauth/token');
    assert.equal(JSON.parse(calls[0].options.body).code_verifier, validBody.code_verifier);
    assert.equal(sessionStorage.getItem('pkce_code_verifier'), null);
    assert.equal(oauth.OAuthTokenExchangeService.getAccessToken(), 'test-token');
});

test('OAuth uses state validation and does not bypass the server token endpoint', () => {
    assert.match(bundle, /CSRF token validation failed/);
    assert.match(bundle, /!u \|\| u !== i/);
    assert.match(bundle, /return \(t = await D\(e\), X\(t\)\)/);
    assert.match(bundle, /p = \(\) => \[\]/);
});

test('login URL uses the registered client, callback, PKCE and state', async () => {
    const sessionStorage = storage();
    const pkce = {
        generateCodeVerifier: () => 'B'.repeat(64),
        generateCodeChallenge: async () => 'test-challenge',
        generateCsrfToken: () => 'test-state',
        storeCodeVerifier: value => sessionStorage.setItem('pkce_code_verifier', value),
        storeCsrfToken: value => sessionStorage.setItem('oauth_state', value),
    };
    const location = { hostname: 'dylantrades.site', origin: 'https://dylantrades.site', protocol: 'https:', host: 'dylantrades.site', search: '' };
    const oauth = loadModule(18470, 6967, { 12838: {}, 30645: {}, 58454: pkce }, { window: { location }, localStorage: storage(), sessionStorage });
    const url = new URL(await oauth.R7());
    assert.equal(url.origin + url.pathname, 'https://auth.deriv.com/oauth2/auth');
    assert.equal(url.searchParams.get('client_id'), validBody.client_id);
    assert.equal(url.searchParams.get('redirect_uri'), validBody.redirect_uri);
    assert.equal(url.searchParams.get('scope'), 'trade');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), 'test-challenge');
    assert.equal(url.searchParams.get('state'), sessionStorage.getItem('oauth_state'));
    assert.equal(sessionStorage.getItem('pkce_code_verifier'), 'B'.repeat(64));
});

test('a missing selected account is rejected instead of trading a different one', async () => {
    const localStorage = storage(), sessionStorage = storage();
    const deps = {
        27412: { _: (obj, key, value) => { obj[key] = value; } },
        5625: { Cy: () => [] },
        5568: { _Z: () => '' },
        39143: { x: async fn => fn(), K: () => false },
        7877: { k: async () => ({ ok: true, json: async () => ({ data: [{ account_id: 'DOT123', account_type: 'demo', status: 'active' }] }) }) },
    };
    const { DerivWSAccountsService: service } = loadModule(30645, 7877, deps, { window: { location: { hostname: 'dylantrades.site' } }, localStorage, sessionStorage });
    await assert.rejects(service.getAuthenticatedWebSocketURL('token', 'CR-missing'), /selected Deriv account is unavailable/);
});

test('refuses an OTP URL that would send credentials to a different host', async () => {
    const localStorage = storage(), sessionStorage = storage();
    const deps = {
        27412: { _: (obj, key, value) => { obj[key] = value; } },
        5625: { Cy: () => [] },
        5568: { _Z: () => '' },
        39143: { x: async fn => fn(), K: () => false },
        7877: { k: async url => ({ ok: true, json: async () => url.endsWith('/otp') ? { data: { url: 'wss://example.com/trading/v1/options/ws/demo?otp=secret' } } : { data: [{ account_id: 'DOT123', account_type: 'demo', status: 'active' }] } }) },
    };
    const { DerivWSAccountsService: service } = loadModule(30645, 7877, deps, { window: { location: { hostname: 'dylantrades.site' } }, localStorage, sessionStorage });
    await assert.rejects(service.getAuthenticatedWebSocketURL('token', 'DOT123'), /Invalid authenticated WebSocket URL/);
});

test('a Deriv accounts 503 is actionable and sign-in can resume without reusing the OAuth code', async () => {
    const localStorage = storage(), sessionStorage = storage();
    let accountCalls = 0, tokenCalls = 0, active;
    const fastTimer = fn => setTimeout(fn, 0);
    const retry = loadModule(39143, 24903, {}, { setTimeout: fastTimer, Error });
    const deps = {
        27412: { _: (obj, key, value) => { obj[key] = value; } },
        5625: { Cy: () => [] },
        5568: { _Z: () => '' },
        39143: retry,
        7877: { k: async () => {
            accountCalls++;
            if (accountCalls <= 2) return { ok: false, status: 503, statusText: '', text: async () => '{"errors":[{"code":"CircuitBreakerOpen"}]}' };
            return { ok: true, json: async () => ({ data: [{ account_id: 'DOT123', account_type: 'demo', status: 'active', currency: 'USD' }] }) };
        } },
    };
    const { DerivWSAccountsService: service } = loadModule(30645, 7877, deps, { window: { location: { hostname: 'dylantrades.site' } }, localStorage, sessionStorage, setTimeout: fastTimer, Error });
    const oauthDeps = {
        66175: { jf2: { CLIENT_ID: validBody.client_id }, SmL: () => validBody.redirect_uri, Q0H: () => '/api/oauth/token' },
        5625: { Cy: () => [] },
        5568: { _Z: () => '', ii: data => { active = data.activeLoginId; }, W7: () => sessionStorage.removeItem('auth_info') },
        30645: { DerivWSAccountsService: service },
        7877: { k: async () => { tokenCalls++; return { ok: true, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) }; } },
        39143: retry,
        88199: { api_base: { init: async () => {} } },
    };
    const oauth = loadModule(58454, 39143, oauthDeps, { localStorage, sessionStorage, Error });
    oauth.storeCodeVerifier(validBody.code_verifier);
    const failure = await oauth.OAuthTokenExchangeService.exchangeCodeForToken(validBody.code);
    assert.match(failure.error_description, /temporarily unavailable \(503\).*Retry sign in/);
    assert.equal(accountCalls, 2);
    assert.equal(tokenCalls, 1);
    assert.equal(oauth.OAuthTokenExchangeService.getAccessToken(), 'test-token');
    assert.equal(active, undefined);
    await new Promise(resolve => setTimeout(resolve, 5));
    const resumed = await oauth.OAuthTokenExchangeService.resumeAuthenticatedSession();
    assert.equal(resumed.access_token, 'test-token');
    assert.equal(tokenCalls, 1);
    assert.equal(accountCalls, 3);
    assert.equal(active, 'DOT123');
});

test('account retries distinguish temporary server errors from non-retryable HTTP failures', async () => {
    const retry = loadModule(39143, 24903, {}, { setTimeout: fn => setTimeout(fn, 0), Error });
    for (const [status, expectedAttempts] of [[400, 1], [401, 1], [429, 2], [503, 2]]) {
        let attempts = 0;
        await assert.rejects(retry.x(async () => {
            attempts++;
            throw Object.assign(new Error(`[DerivWS] Failed to fetch accounts: ${status}`), { status });
        }, { retries: 1, shouldRetry: retry.K }));
        assert.equal(attempts, expectedAttempts, `status ${status}`);
    }
});
