'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradeController, connectedAccount, QUOTE_LIFETIME_MS } = require('../scripts/dtrader');
function setup() {
    let id = 'DOT123', time = 1000;
    const accounts = { DOT123: { currency: 'USD', account_type: 'demo', is_virtual: true }, CR123: { currency: 'USD', account_type: 'real', is_virtual: false } };
    const stored = new Map();
    const storage = { getItem: key => key === 'active_loginid' ? id : key === 'clientAccounts' ? JSON.stringify(accounts) : stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
    const calls = [];
    const api = { connection: { readyState: 1 }, send: async request => {
        calls.push(request);
        if (request.proposal) return { proposal: { id: 'quote-1', ask_price: '1.00', payout: '1.90', longcode: 'A Rise contract' } };
        if (request.buy) return { buy: { contract_id: 42, buy_price: 1 } };
    } };
    const base = { api, account_id: id, is_authorized: true };
    return { storage, base, api, calls, controller: createTradeController(base, storage, () => time), setAccount: value => { id = value; }, setTime: value => { time = value; } };
}
const inputs = { symbol: 'R_100', contractType: 'CALL', amount: '1', duration: '5' };

test('reviewed quote is sent to Deriv only once when purchased', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    assert.equal(connectedAccount(s.base, s.storage).demo, true);
    assert.deepEqual(s.calls[0], { proposal: 1, amount: 1, basis: 'stake', contract_type: 'CALL', currency: 'USD', duration: 5, duration_unit: 't', symbol: 'R_100' });
    assert.equal(s.calls.length, 1);
    const bought = await s.controller.buy(q);
    assert.equal(bought.contract_id, 42);
    assert.deepEqual(s.calls[1], { buy: 'quote-1', price: 1 });
    await assert.rejects(s.controller.buy(q), /Get a new quote/);
    assert.equal(s.calls.length, 2);
});
test('rejects invalid inputs and disconnected accounts without sending an order', async () => {
    const s = setup();
    for (const input of [{ ...inputs, amount: 0 }, { ...inputs, duration: 11 }, { ...inputs, contractType: 'OTHER' }, { ...inputs, symbol: '' }])
        await assert.rejects(s.controller.getQuote(input), /positive stake/);
    s.base.is_authorized = false;
    await assert.rejects(s.controller.getQuote(inputs), /not connected/);
    assert.equal(s.calls.length, 0);
});
test('invalidated or expired quotes cannot purchase', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    s.controller.invalidate();
    await assert.rejects(s.controller.buy(q), /Get a new quote/);
    const q2 = await s.controller.getQuote(inputs);
    s.setTime(1000 + QUOTE_LIFETIME_MS);
    await assert.rejects(s.controller.buy(q2), /expired/);
    assert.equal(s.calls.filter(call => call.buy).length, 0);
});
test('account or socket changes invalidate the purchase before it is sent', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    s.setAccount('CR123'); s.base.account_id = 'CR123';
    await assert.rejects(s.controller.buy(q), /account or connection changed/i);
    assert.equal(s.calls.filter(call => call.buy).length, 0);
});
test('a delayed quote is rejected after an account switch', async () => {
    const s = setup();
    let resolve;
    s.api.send = () => new Promise(r => { resolve = r; });
    const pending = s.controller.getQuote(inputs);
    s.setAccount('CR123'); s.base.account_id = 'CR123';
    resolve({ proposal: { id: 'late', ask_price: 1, payout: 2 } });
    await assert.rejects(pending, /account or connection changed/i);
});
test('missing prices and rejected proposals cannot become purchases', async () => {
    const s = setup();
    s.api.send = async () => ({ proposal: { id: 'q', ask_price: 1 } });
    await assert.rejects(s.controller.getQuote(inputs), /complete quote/);
    s.api.send = async () => ({ error: { message: 'Market is closed' } });
    await assert.rejects(s.controller.getQuote(inputs), /Market is closed/);
});
test('a purchase with unknown outcome is not retried', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    s.api.send = async () => { throw Error('connection lost'); };
    await assert.rejects(s.controller.buy(q), /status is uncertain.*portfolio/i);
    await assert.rejects(s.controller.buy(q), /Get a new quote/);
});
test('concurrent purchase attempts cannot send duplicate orders', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    let resolve, count = 0;
    s.api.send = () => { count++; return new Promise(r => { resolve = r; }); };
    const first = s.controller.buy(q);
    await assert.rejects(s.controller.buy(q), /already being processed/);
    resolve({ buy: { contract_id: 42 } });
    await first;
    assert.equal(count, 1);
});

test('ambiguous account data is never labelled as demo', () => {
    const s = setup();
    const storage = { getItem: key => key === 'active_loginid' ? 'DOT123' : JSON.stringify({ DOT123: { currency: 'USD', account_type: 'real', is_virtual: true } }) };
    assert.equal(connectedAccount(s.base, storage).demo, false);
});

test('uncertain purchases block new trades across controller instances until acknowledged', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    s.api.send = async () => { throw Error('connection lost'); };
    await assert.rejects(s.controller.buy(q), /status is uncertain/);
    assert.equal(s.controller.hasPending('DOT123'), true);
    const afterReload = createTradeController(s.base, s.storage);
    await assert.rejects(afterReload.getQuote(inputs), /check your Deriv portfolio/i);
    afterReload.acknowledgePending();
    assert.equal(afterReload.hasPending('DOT123'), false);
});

test('definitive Deriv rejection clears pending state without sending another purchase', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    s.api.send = async () => ({ error: { code: 'InsufficientBalance', message: 'Insufficient balance' } });
    await assert.rejects(s.controller.buy(q), /Insufficient balance/);
    assert.equal(s.controller.hasPending('DOT123'), false);
});

test('timed out purchases stay blocked even if Deriv responds later', async () => {
    const s = setup();
    const controller = createTradeController(s.base, s.storage, () => 1000, null, 10);
    const q = await controller.getQuote(inputs);
    let resolve;
    s.api.send = () => new Promise(r => { resolve = r; });
    await assert.rejects(controller.buy(q), /status is uncertain/);
    resolve({ buy: { contract_id: 42 } });
    await Promise.resolve();
    assert.equal(controller.hasPending('DOT123'), true);
    await assert.rejects(controller.getQuote(inputs), /check your Deriv portfolio/i);
});

test('refuses to trade if purchase safety state cannot be saved', async () => {
    const s = setup(), q = await s.controller.getQuote(inputs);
    s.storage.setItem = () => { throw Error('storage disabled'); };
    await assert.rejects(s.controller.buy(q), /No order was sent/);
    assert.equal(s.calls.filter(call => call.buy).length, 0);
});

test('expired OAuth session prevents new quotes or purchases', async () => {
    const s = setup();
    const session = { getItem: () => JSON.stringify({ access_token: 'test-token', expires_at: 2000 }) };
    const controller = createTradeController(s.base, s.storage, () => 1000, session);
    const q = await controller.getQuote(inputs);
    const expired = createTradeController(s.base, s.storage, () => 2000, session);
    await assert.rejects(expired.getQuote(inputs), /not connected/);
    assert.equal(connectedAccount(s.base, s.storage, session, () => 2000), null);
    assert.equal(q.account.id, 'DOT123');
});

test('DTrader is a first-party component without external token handoff', () => {
    const source = require('node:fs').readFileSync('scripts/dtrader.js', 'utf8');
    assert.doesNotMatch(source, /deriv-dtrader\.vercel\.app|postMessage|iframe/);
    const Component = require('../scripts/dtrader').createComponent({ createElement() {} }, { api_base: {} });
    assert.equal(Component.name, 'LocalDTrader');
});

test('digit contracts send a validated prediction to Deriv', async () => {
    const s = setup();
    await s.controller.getQuote({ ...inputs, contractType: 'DIGITOVER', prediction: '5' });
    assert.equal(s.calls[0].barrier, '5');
    assert.equal(s.calls[0].contract_type, 'DIGITOVER');
    await s.controller.getQuote({ ...inputs, contractType: 'DIGITEVEN' });
    assert.equal(s.calls[1].barrier, undefined);
    await assert.rejects(s.controller.getQuote({ ...inputs, contractType: 'DIGITMATCH', prediction: '10' }), /prediction digit/i);
    assert.equal(s.calls.length, 2);
});

test('DTrader has its own labelled tab and preserves saved tab visibility and custom names', () => {
    const source = require('node:fs').readFileSync('scripts/async/698.5f7f5ff5.js', 'utf8');
    assert.match(source, /\["manualTrader","DTrader"\]/);
    assert.match(source, /id:"id-9"[^}]*}[^}]*children:\(0,n\.jsx\)\(rN,\{\}\)/);
    const matcher = source.match(/return t\.map\((e=>\{let t=\{\.\.\.e,\.\.\.a\.get\(e\.key\)\};return[^}]+\})\)\.sort/);
    assert(matcher, 'tab preference migration not found');
    const saved = new Map([['manualTrader', { name: 'Manual Trader', hidden: true }], ['other', { name: 'Custom', hidden: false }]]);
    const migrate = require('node:vm').runInNewContext(`(a => ${matcher[1]})`, {})(saved);
    assert.equal(migrate({ key: 'manualTrader', name: 'DTrader', hidden: false }).name, 'DTrader');
    assert.equal(migrate({ key: 'manualTrader', name: 'DTrader', hidden: false }).hidden, true);
    saved.set('manualTrader', { name: 'My Trading Tab', hidden: false });
    assert.equal(migrate({ key: 'manualTrader', name: 'DTrader', hidden: false }).name, 'My Trading Tab');
});

test('native DTrader trade-type navigation changes selection without sending a trade', () => {
    const oldLocal = global.localStorage, oldSession = global.sessionStorage;
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    global.localStorage = storage; global.sessionStorage = storage;
    try {
        const hooks = []; let cursor = 0, calls = 0;
        const React = {
            Fragment: Symbol('Fragment'),
            createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
            useState: value => { const i = cursor++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
            useRef: value => { const i = cursor++; return hooks[i] || (hooks[i] = { current: value }); },
            useEffect: () => {},
            useCallback: fn => fn,
        };
        const base = { api: { send: () => { calls++; } } };
        const Component = require('../scripts/dtrader').createComponent(React, { api_base: base });
        const render = () => { cursor = 0; return Component(); };
        const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.children || [])] : [];
        let nodes = flatten(render());
        const chips = nodes.filter(n => n.props?.className?.includes('dt-type-chip'));
        assert.deepEqual(chips.map(n => n.children[0]), ['Rise / Fall', 'Even / Odd', 'Matches / Differs', 'Over / Under']);
        assert.equal(chips[0].props['aria-pressed'], true);
        chips[2].props.onClick();
        nodes = flatten(render());
        assert.equal(nodes.find(n => n.children?.[0] === 'Matches / Differs' && n.props?.className?.includes('dt-type-chip')).props['aria-pressed'], true);
        assert.equal(calls, 0);
    } finally { global.localStorage = oldLocal; global.sessionStorage = oldSession; }
});
