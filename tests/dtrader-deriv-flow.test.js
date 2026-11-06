'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createTradeController } = require('../scripts/dtrader');

function storage() {
    const map = new Map();
    return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), key: i => [...map.keys()][i], get length() { return map.size; } };
}

// Load the actual compatibility middleware/socket factory shipped in the bundle.
function loadConnectionFactory(deps, globals) {
    const src = fs.readFileSync('scripts/index.39f61533.js', 'utf8');
    const start = src.indexOf('    76052: function (e, t, n) {');
    const end = src.indexOf('    49243: function (e, t, n) {', start);
    assert(start >= 0 && end > start);
    const fn = src.slice(start, end).replace(/^\s*\d+: /, '').replace(/,\s*$/, '');
    const context = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout, Date, Map, Promise, ...globals });
    const factory = vm.runInContext(`(${fn})`, context);
    const exports = {};
    function requireModule(id) { assert(id in deps, `unexpected module ${id}`); return deps[id]; }
    requireModule.d = (obj, definitions) => { for (const [key, getter] of Object.entries(definitions)) Object.defineProperty(obj, key, { get: getter }); };
    requireModule.n = mod => () => mod;
    factory({}, exports, requireModule);
    return exports;
}

test('first-party ticket completes a demo quote and purchase through the actual new-API middleware', async () => {
    const localStorage = storage(), sessionStorage = storage(), requests = [];
    localStorage.setItem('active_loginid', 'DOT123');
    localStorage.setItem('clientAccounts', JSON.stringify({ DOT123: { currency: 'USD', account_type: 'demo', is_virtual: true } }));
    sessionStorage.setItem('auth_info', JSON.stringify({ access_token: 'mock-token', expires_at: Date.now() + 60000 }));
    class FakeSocket {
        static CONNECTING = 0; static OPEN = 1;
        constructor(url) { this.url = url; this.readyState = 1; }
        addEventListener() {}
        close() { this.readyState = 3; }
    }
    class FakeDerivAPI {
        constructor({ connection, middleware }) { this.connection = connection; this.middleware = middleware; }
        onMessage() { return { subscribe: () => ({ unsubscribe() {} }) }; }
        send(request) {
            const wire = this.middleware.requestDataTransformer(request);
            requests.push(wire);
            let response;
            if (wire.proposal) {
                assert.equal(wire.underlying_symbol, 'R_100');
                assert.equal(wire.symbol, undefined);
                response = { msg_type: 'proposal', proposal: { id: 'demo-quote', ask_price: '1.00', payout: '1.92' } };
            } else if (wire.buy) response = { msg_type: 'buy', buy: { contract_id: 123, buy_price: '1.00' } };
            else throw Error('Unexpected request');
            return this.middleware.sendIsCalled({ response_promise: Promise.resolve(response), args: [request] });
        }
    }
    const deps = {
        66175: {},
        58454: { OAuthTokenExchangeService: { getAuthInfo: () => JSON.parse(sessionStorage.getItem('auth_info')), isAuthenticated: () => true } },
        30645: { DerivWSAccountsService: { getAuthenticatedWebSocketURL: async (_token, account) => {
            assert.equal(account, 'DOT123');
            return 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=mock';
        }, getStoredAccounts: () => [{ account_id: 'DOT123', currency: 'USD', account_type: 'demo' }], isDemoAccount: () => true } },
        66000: FakeDerivAPI,
        48059: { Jb: () => 'EN' },
        27412: { _: (object, key, value) => { object[key] = value; } },
    };
    const perf = { mark() {}, getEntriesByName: () => [], measure: () => ({}) };
    const socketFactory = loadConnectionFactory(deps, { localStorage, sessionStorage, WebSocket: FakeSocket, performance: perf });
    const api = await socketFactory.wL(undefined, 'DOT123');
    const controller = createTradeController({ api, account_id: 'DOT123', is_authorized: true }, localStorage, () => Date.now(), sessionStorage);
    const quote = await controller.getQuote({ symbol: 'R_100', contractType: 'CALL', amount: '1', duration: '5' });
    assert.equal(quote.price, 1);
    const bought = await controller.buy(quote);
    assert.equal(bought.contract_id, 123);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].buy, 'demo-quote');
    assert.equal(requests[1].price, 1);
    assert.equal(requests[1].loginid, undefined);
    assert.equal(controller.hasPending('DOT123'), false);
});
