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

function loadBotTradeHelpers(localStorage) {
    const src = fs.readFileSync('scripts/index.39f61533.js', 'utf8');
    const start = src.indexOf('    39338: function (e, t, n) {'), end = src.indexOf('    55967: function (e, t, n) {', start);
    assert(start >= 0 && end > start);
    const source = src.slice(start, end).replace(/^\s*\d+: /, '').replace(/,\s*$/, '');
    const context = vm.createContext({ localStorage, WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }, console, Promise, Date, Math, setTimeout, clearTimeout });
    const factory = vm.runInContext(`(${source})`, context), exports = {};
    const config = { vh_variables: { is_enabled: false, is_martingale_active: false }, other_symbol: { isActive: false }, copy_trading: { is_active: false }, demo_copy_trading: { is_active: false }, pred_setter: { allow_pred_setter: false }, touch_notouch_vars: {} };
    const deps = { 66175: { Qr$: value => value == null }, 48059: { NC: text => text }, 65464: {}, 21796: {}, 47962: { GL: config }, 76052: { LP: () => ({ account_id: 'DOT123' }), Ke: () => 'DOT123', k9: () => false, aZ: () => false } };
    function requireModule(id) { assert(id in deps, `unexpected module ${id}`); return deps[id]; }
    requireModule.d = (obj, definitions) => { for (const [key, getter] of Object.entries(definitions)) Object.defineProperty(obj, key, { get: getter }); };
    factory({}, exports, requireModule);
    return exports;
}

function loadBotProposalObserver(api) {
    const source = fs.readFileSync('scripts/index.39f61533.js', 'utf8');
    function method(start, next) {
        const i = source.indexOf(start), j = source.indexOf(next, i);
        assert(i > 0 && j > i, `bot method ${start} not found`);
        return source.slice(i, j);
    }
    const methods = method('selectProposal(e) {', 'selectProposalVH(e) {') +
        method('observeProposals() {', 'observeProposalsVH() {') +
        method('checkProposalReady() {', 'checkProposalReadyVH() {');
    const base = { api, pushSubscription() {} };
    return vm.runInNewContext(`(class { ${methods} })`, { d: { DO: base }, X: () => ({ type: 'PROPOSALS_READY' }), y: { NC: text => text } });
}

test('real bot digit requests and proposal readiness work with new-API echo_req and string barrier', async () => {
    const localStorage = storage(), sessionStorage = storage(), requests = [], listeners = [];
    localStorage.setItem('active_loginid', 'DOT123');
    sessionStorage.setItem('auth_info', JSON.stringify({ access_token: 'mock-token' }));
    class FakeSocket { static CONNECTING = 0; static OPEN = 1; constructor() { this.readyState = 1; } addEventListener() {} close() {} }
    class FakeDerivAPI {
        constructor({ connection, middleware }) { this.connection = connection; this.middleware = middleware; }
        onMessage() { return { subscribe: callback => { listeners.push(callback); return { unsubscribe() {} }; } }; }
        send(request) {
            const wire = this.middleware.requestDataTransformer(request);
            requests.push(wire);
            let response;
            if (wire.proposal) {
                assert.equal(wire.underlying_symbol, 'R_100');
                assert.equal(wire.barrier, '5');
                assert.equal(wire.selected_tick, undefined);
                response = { msg_type: 'proposal', echo_req: wire, proposal: { id: `quote-${wire.contract_type}`, ask_price: '1', payout: '1.9' } };
                listeners.forEach(callback => callback({ data: response }));
            } else {
                assert.equal(wire.parameters?.underlying_symbol, 'R_100');
                assert.equal(wire.parameters?.barrier, '5');
                assert.equal(wire.parameters?.selected_tick, undefined);
                response = { msg_type: 'buy', buy: { contract_id: 999, buy_price: '1' } };
            }
            return this.middleware.sendIsCalled({ response_promise: Promise.resolve(response), args: [request] });
        }
    }
    const deps = {
        66175: {}, 58454: { OAuthTokenExchangeService: { getAuthInfo: () => ({ access_token: 'mock-token' }), isAuthenticated: () => true } },
        30645: { DerivWSAccountsService: { getAuthenticatedWebSocketURL: async () => 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=mock', getStoredAccounts: () => [], isDemoAccount: () => true } },
        66000: FakeDerivAPI, 48059: { Jb: () => 'EN' }, 27412: { _: (obj, key, value) => { obj[key] = value; } },
    };
    const factory = loadConnectionFactory(deps, { localStorage, sessionStorage, WebSocket: FakeSocket, performance: { mark() {}, getEntriesByName: () => [], measure: () => ({}) } });
    const api = await factory.wL(undefined, 'DOT123');
    const helpers = loadBotTradeHelpers(localStorage);
    const options = { contractTypes: ['DIGITOVER', 'DIGITUNDER'], symbol: 'R_100', amount: 1, basis: 'stake', currency: 'USD', duration: 1, duration_unit: 't', prediction: 5 };
    const Observer = loadBotProposalObserver(api), bot = new Observer();
    bot.proposal_templates = helpers.pH(options, 'reference-123');
    bot.data = { proposals: [] }; bot.startPromise = Promise.resolve();
    const events = []; bot.store = { dispatch: event => events.push(event) };
    bot.getPurchaseReference = () => 'reference-123';
    bot.observeProposals();
    await Promise.all(bot.proposal_templates.map(req => api.send(req)));
    await Promise.resolve();
    assert.equal(events[0].type, 'PROPOSALS_READY');
    assert.equal(bot.selectProposal('DIGITOVER').id, 'quote-DIGITOVER');
    const request = helpers.nD('DIGITOVER', { ...options });
    const bought = await api.send(request);
    assert.equal(bought.buy.contract_id, 999);
    assert.equal(requests.length, 3);
    const tickRequest = helpers.nD('TICKHIGH', { ...options, prediction: 3 });
    const normalizedTick = api.middleware.requestDataTransformer(tickRequest);
    assert.equal(normalizedTick.parameters.selected_tick, 3);
    assert.equal(normalizedTick.parameters.barrier, undefined);
    // Legacy WebSockets keep the original legacy payload untouched.
    localStorage.setItem('authToken', 'legacy-token');
    const legacy = helpers.nD('DIGITOVER', { ...options });
    assert.strictEqual(api.middleware.requestDataTransformer(legacy), legacy);
    assert.equal(legacy.parameters.symbol, 'R_100');
});

test('bot proposal rejection reports a useful error and does not wait forever for an unavailable contract', async () => {
    const source = fs.readFileSync('scripts/index.39f61533.js', 'utf8');
    const start = source.indexOf('requestProposals() {'), end = source.indexOf('requestProposalsVH() {', start);
    assert(start > 0 && end > start);
    let rejectWith = { error: { code: 'ContractBuyValidationError', message: 'Not available' } };
    const calls = [], events = [];
    const api = { send: async req => { calls.push(req); throw rejectWith; } };
    const Bot = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, { Promise, T: { l6: fn => Promise.resolve().then(fn) }, d: { DO: { api } } });
    const bot = new Bot(); bot.proposal_templates = [{ passthrough: { contract_type: 'DIGITOVER', purchase_reference: 'ref' } }];
    bot.data = { proposals: [] }; bot.checkProposalReady = () => events.push('ready'); bot.$scope = { observer: { emit: (...args) => events.push(args) } };
    bot.requestProposals();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(bot.data.proposals[0].contract_type, 'DIGITOVER');
    assert.equal(bot.data.proposals[0].error.error.code, 'ContractBuyValidationError');
    assert.equal(events[0], 'ready');
    rejectWith = new Error('Connection unavailable');
    bot.requestProposals();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events[1][0], 'Error');
    assert.equal(events[1][1].message, 'Connection unavailable');
});
