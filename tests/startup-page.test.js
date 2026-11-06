'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('startup page contains only a loading state, not a captured account or balance', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const start = html.indexOf('<div id="root">');
    const end = html.indexOf('<!-- LiveChat script -->', start);
    assert(start >= 0 && end > start);
    const startup = html.slice(start, end);
    assert.match(startup, /Loading Dylan Trades/);
    assert.doesNotMatch(startup, /95\.85|account-switcher|bot-dashboard/i);
    assert.doesNotMatch(html, /95\.85/);
    assert.match(html, /id="modal_root"/);
    assert.match(html, /id="popup_root"/);
    assert.match(html, /\/static\/js\/index\.39f61533\.js/);
    const bundle = fs.readFileSync('scripts/index.39f61533.js', 'utf8');
    assert.match(bundle, /createRoot\(document\.getElementById\("root"\)\)/);
});
