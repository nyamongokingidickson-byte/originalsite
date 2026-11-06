/* First-party DTrader: uses the application's existing Deriv connection. */
(function (root, factory) {
    const value = factory();
    if (typeof module === 'object' && module.exports) module.exports = value;
    if (root) root.DylanDTrader = value;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const QUOTE_LIFETIME_MS = 15000;
    const REQUEST_TIMEOUT_MS = 20000;
    const pendingKey = id => `dtrader_pending_purchase_v1:${id}`;
    function withTimeout(promise, ms) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Deriv request timed out.')), ms);
            Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
    }
    const message = (error) => error?.error?.message || error?.message || 'Unable to connect to Deriv.';
    const checked = (response) => {
        if (response?.error) {
            const error = new Error(response.error.message || 'Deriv rejected the request.');
            error.derivRejected = true;
            throw error;
        }
        return response;
    };
    const accountDetails = (storage, id) => {
        try { return JSON.parse(storage.getItem('clientAccounts') || '{}')[id] || null; }
        catch { return null; }
    };
    function connectedAccount(apiBase, storage, session, now = () => Date.now()) {
        const id = storage.getItem('active_loginid');
        const api = apiBase.api;
        const account = id && accountDetails(storage, id);
        if (!id || !account || !account.currency || !apiBase.is_authorized || apiBase.account_id !== id || !api || api.connection?.readyState !== 1) return null;
        if (session && !storage.getItem('authToken')) {
            try {
                const auth = JSON.parse(session.getItem('auth_info') || 'null');
                if (!auth?.access_token || !auth.expires_at || now() >= auth.expires_at) return null;
            } catch { return null; }
        }
        const demo = account.account_type !== 'real' && account.is_virtual !== false && account.is_virtual !== 0 && (account.account_type === 'demo' || account.is_virtual === true || account.is_virtual === 1);
        return { id, api, currency: account.currency, demo };
    }
    function createTradeController(apiBase, storage, now = () => Date.now(), session = null, timeoutMs = REQUEST_TIMEOUT_MS) {
        let quote = null, generation = 0, buying = false;
        const requireAccount = () => {
            const account = connectedAccount(apiBase, storage, session, now);
            if (!account) throw new Error('The selected Deriv account is not connected. Wait for it to reconnect.');
            return account;
        };
        const sameAccount = (first) => {
            const current = requireAccount();
            if (current.id !== first.id || current.api !== first.api || current.currency !== first.currency)
                throw new Error('The account or connection changed. Get a new quote.');
        };
        return {
            invalidate() { generation++; quote = null; },
            hasPending(id) { return !!id && !!storage.getItem(pendingKey(id)); },
            acknowledgePending() {
                const account = requireAccount();
                if (buying) throw new Error('A purchase is still being processed.');
                storage.removeItem(pendingKey(account.id));
                if (storage.getItem(pendingKey(account.id))) throw new Error('Could not clear the purchase warning.');
            },
            async getQuote(input) {
                generation++;
                const currentGeneration = generation;
                quote = null;
                const account = requireAccount();
                if (storage.getItem(pendingKey(account.id))) throw new Error('Check your Deriv portfolio and clear the previous purchase warning before trading again.');
                const amount = Number(input.amount), duration = Number(input.duration);
                if (!input.symbol || !['CALL', 'PUT'].includes(input.contractType) || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(duration) || duration < 1 || duration > 10)
                    throw new Error('Choose a market, enter a positive stake and a duration between 1 and 10 ticks.');
                const response = checked(await withTimeout(account.api.send({ proposal: 1, amount, basis: 'stake', contract_type: input.contractType, currency: account.currency, duration, duration_unit: 't', symbol: input.symbol }), timeoutMs));
                sameAccount(account);
                if (generation !== currentGeneration) throw new Error('Trade details changed. Get a new quote.');
                const proposal = response?.proposal;
                const price = Number(proposal?.ask_price), payout = Number(proposal?.payout);
                if (!proposal?.id || proposal.ask_price == null || proposal.payout == null || !Number.isFinite(price) || price <= 0 || !Number.isFinite(payout) || payout <= 0)
                    throw new Error('Deriv did not return a complete quote. Please try again.');
                quote = { id: proposal.id, price, payout, account, symbol: input.symbol, contractType: input.contractType, duration, amount, description: proposal.longcode || '', createdAt: now() };
                return quote;
            },
            async buy(selectedQuote) {
                if (buying) throw new Error('A purchase is already being processed.');
                if (!quote || selectedQuote !== quote) throw new Error('Get a new quote before purchasing.');
                if (now() - quote.createdAt >= QUOTE_LIFETIME_MS) { quote = null; throw new Error('The quote expired. Get a new quote.'); }
                sameAccount(quote.account);
                const selected = quote, key = pendingKey(selected.account.id);
                if (storage.getItem(key)) throw new Error('Check your Deriv portfolio and clear the previous purchase warning before trading again.');
                // Mark before sending: a reload or lost response must not cause an accidental repeat purchase.
                try { storage.setItem(key, JSON.stringify({ createdAt: now() })); }
                catch { throw new Error('Cannot record the purchase safely in this browser. No order was sent.'); }
                quote = null; generation++; buying = true;
                try {
                    const response = checked(await withTimeout(selected.account.api.send({ buy: selected.id, price: selected.price }), timeoutMs));
                    if (!response?.buy?.contract_id) throw new Error('The purchase response was incomplete.');
                    storage.removeItem(key);
                    return response.buy;
                } catch (error) {
                    // A structured Deriv rejection is definitive; network failures and incomplete responses are not.
                    if (error.derivRejected || (error?.msg_type === 'buy' && error?.error?.code && !/disconnect|connection|timeout/i.test(error.error.code))) {
                        storage.removeItem(key);
                        throw new Error(message(error));
                    }
                    throw new Error('Purchase status is uncertain. Check your Deriv portfolio before trying again.');
                } finally { buying = false; }
            },
        };
    }

    const DTRADER_ORIGIN = 'https://deriv-dtrader.vercel.app';
    // Credentials are read only when sending and never put in a URL or React state.
    function bridgeCredentials(apiBase, storage, session, now = () => Date.now()) {
        const account = connectedAccount(apiBase, storage, session, now);
        if (!account) return null;
        let token;
        const legacy = storage.getItem('authToken');
        if (legacy && legacy !== 'null' && legacy !== 'undefined') {
            try {
                const accounts = JSON.parse(storage.getItem('accountsList') || '{}');
                // Never send a token for a different selected account.
                token = typeof accounts[account.id] === 'string' && accounts[account.id] === legacy ? legacy : null;
            } catch { return null; }
        } else {
            try {
                const auth = JSON.parse(session.getItem('auth_info') || 'null');
                token = auth?.expires_at && now() < auth.expires_at ? auth.access_token : null;
            } catch { return null; }
        }
        if (typeof token !== 'string' || !token || token === 'null' || token === 'undefined') return null;
        return { token, loginid: account.id, currency: account.currency, demo: account.demo, api: account.api };
    }
    function sendBridgeAuth(frame, apiBase, storage, session, expectedAccount, now = () => Date.now()) {
        const auth = bridgeCredentials(apiBase, storage, session, now);
        if (!frame?.contentWindow || !auth || auth.loginid !== expectedAccount) return false;
        try {
            frame.contentWindow.postMessage({ type: 'DERIV_AUTH', token: auth.token, loginid: auth.loginid, currency: auth.currency }, DTRADER_ORIGIN);
            return true;
        } catch { return false; }
    }
    function isBridgeAuthRequest(event, frame) {
        return !!frame?.contentWindow && event.origin === DTRADER_ORIGIN && event.source === frame.contentWindow && event.data?.type === 'REQUEST_AUTH';
    }

    function createComponent(React, apiModule) {
        const h = React.createElement;
        const { useState, useRef, useEffect, useCallback } = React;
        function LocalDTrader() {
            const base = apiModule.api_base;
            const controller = useRef(null);
            if (!controller.current) controller.current = createTradeController(base, localStorage, () => Date.now(), sessionStorage);
            const [account, setAccount] = useState(null), [markets, setMarkets] = useState([]);
            const [symbol, setSymbol] = useState(''), [amount, setAmount] = useState('1'), [duration, setDuration] = useState('5');
            const [tick, setTick] = useState(null), [history, setHistory] = useState([]), [balance, setBalance] = useState(null);
            const [quote, setQuote] = useState(null), [pending, setPending] = useState(''), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
            const [contract, setContract] = useState(null), [result, setResult] = useState(null);
            const version = useRef(0), alive = useRef(true), busy = useRef(false);
            const resetQuote = useCallback(() => { version.current++; controller.current.invalidate(); setQuote(null); setError(''); }, []);
            useEffect(() => {
                alive.current = true;
                let last = '';
                const update = () => {
                    const current = connectedAccount(base, localStorage, sessionStorage);
                    setUncertain(!!current && controller.current.hasPending(current.id));
                    const signature = current ? `${current.id}:${current.currency}:${current.demo}` : '';
                    if (signature !== last || (current && current.api !== update.api)) {
                        last = signature; update.api = current?.api;
                        resetQuote(); setAccount(current); setBalance(null); setMarkets([]); setSymbol(''); setTick(null); setHistory([]); setResult(null); setContract(null);
                    }
                };
                update();
                const interval = setInterval(update, 1000);
                window.addEventListener('deriv:account-switch', update);
                window.addEventListener('storage', update);
                return () => { alive.current = false; version.current++; controller.current.invalidate(); clearInterval(interval); window.removeEventListener('deriv:account-switch', update); window.removeEventListener('storage', update); };
            }, [base, resetQuote]);
            useEffect(() => {
                if (!account) return;
                let active = true;
                (async () => {
                    try {
                        const [symbols, balances] = await Promise.all([withTimeout(account.api.send({ active_symbols: 'brief' }), REQUEST_TIMEOUT_MS), withTimeout(account.api.send({ balance: 1 }), REQUEST_TIMEOUT_MS)]);
                        checked(symbols); checked(balances);
                        if (!active) return;
                        const list = (symbols.active_symbols || []).filter(item => item.symbol && item.display_name && item.exchange_is_open !== 0 && item.exchange_is_open !== false && !item.is_trading_suspended);
                        list.sort((a, b) => a.display_name.localeCompare(b.display_name));
                        setMarkets(list);
                        setSymbol(list.find(item => item.symbol === 'R_100')?.symbol || list[0]?.symbol || '');
                        if (balances.balance?.balance != null) setBalance({ amount: balances.balance.balance, currency: balances.balance.currency || account.currency });
                        if (!list.length) setError('No markets are currently available for this account.');
                    } catch (e) { if (active) setError(message(e)); }
                })();
                return () => { active = false; };
            }, [account]);
            useEffect(() => {
                if (!account || !symbol) return;
                let active = true, subscriptionId = null;
                setTick(null); setHistory([]);
                const listener = account.api.onMessage().subscribe(event => {
                    const data = event.data;
                    if (!active || data?.error) return;
                    if (data.msg_type === 'tick' && data.tick?.symbol === symbol) {
                        const price = Number(data.tick.quote);
                        if (Number.isFinite(price)) { setTick(data.tick); setHistory(old => [...old, price].slice(-48)); }
                    }
                    if (data.msg_type === 'balance' && data.balance?.balance != null && (!data.balance.loginid || data.balance.loginid === account.id))
                        setBalance({ amount: data.balance.balance, currency: data.balance.currency || account.currency });
                });
                account.api.send({ ticks: symbol, subscribe: 1 }).then(response => {
                    checked(response);
                    subscriptionId = response?.subscription?.id;
                    if (!active && subscriptionId) account.api.send({ forget: subscriptionId }).catch(() => {});
                }).catch(e => { if (active) setError(message(e)); });
                return () => { active = false; listener?.unsubscribe?.(); if (subscriptionId) account.api.send({ forget: subscriptionId }).catch(() => {}); };
            }, [account, symbol]);
            useEffect(() => {
                if (!account || !contract) return;
                let active = true, timer;
                const refresh = async () => {
                    try {
                        const data = checked(await account.api.send({ proposal_open_contract: 1, contract_id: contract }));
                        if (!active) return;
                        if (data.proposal_open_contract) {
                            setResult(data.proposal_open_contract);
                            if (data.proposal_open_contract.is_sold || data.proposal_open_contract.status === 'sold' || ['won', 'lost'].includes(data.proposal_open_contract.status)) return;
                        }
                        timer = setTimeout(refresh, 5000);
                    } catch (e) { if (active) setError(`Unable to update contract: ${message(e)}. Check your Deriv portfolio.`); }
                };
                refresh();
                return () => { active = false; clearTimeout(timer); };
            }, [account, contract]);
            const requestQuote = async type => {
                if (busy.current) return;
                busy.current = true; resetQuote(); setPending('quote');
                const requestVersion = version.current;
                try {
                    const value = await controller.current.getQuote({ symbol, amount, duration, contractType: type });
                    if (alive.current && requestVersion === version.current) setQuote(value);
                } catch (e) { if (alive.current && requestVersion === version.current) setError(message(e)); }
                finally { busy.current = false; if (alive.current) setPending(''); }
            };
            const purchase = async () => {
                if (!quote || busy.current) return;
                busy.current = true; setPending('buy'); setError('');
                const purchaseVersion = version.current, purchaseAccount = quote.account.id;
                try {
                    const bought = await controller.current.buy(quote);
                    if (alive.current) {
                        setQuote(null);
                        if (purchaseVersion !== version.current) {
                            setError(`A purchase was submitted for ${purchaseAccount} (contract #${bought.contract_id}). Check that account's Deriv portfolio.`);
                        } else {
                            setContract(bought.contract_id);
                            setResult({ contract_id: bought.contract_id, buy_price: bought.buy_price, status: 'open' });
                        }
                    }
                } catch (e) { if (alive.current) { setQuote(null); setError(`${message(e)}${purchaseVersion !== version.current ? ` Account: ${purchaseAccount}.` : ''}`); } }
                finally {
                    busy.current = false;
                    if (alive.current) {
                        setPending('');
                        const activeId = localStorage.getItem('active_loginid');
                        setUncertain(controller.current.hasPending(activeId));
                    }
                }
            };
            const clearUncertain = () => {
                if (!window.confirm('Have you checked this account’s Deriv portfolio for the previous purchase? Only clear this warning after checking.')) return;
                try { controller.current.acknowledgePending(); setUncertain(false); setError(''); }
                catch (e) { setError(message(e)); }
            };
            const money = (value, currency) => `${currency || ''} ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 20 })}`;
            const chart = history.length > 1 ? (() => { const min = Math.min(...history), max = Math.max(...history), span = max - min || 1; return history.map((price, i) => `${i * 100 / (history.length - 1)},${92 - ((price - min) / span) * 84}`).join(' '); })() : '';
            const field = (label, control) => h('label', { className: 'dt-field' }, h('span', null, label), control);
            return h('div', { className: 'dt-page' },
                h('header', { className: 'dt-heading' }, h('div', null, h('div', { className: 'dt-eyebrow' }, 'DYLAN TRADES / MANUAL TRADING'), h('h1', null, 'DTrader'), h('p', null, 'Trade directly with your connected Deriv account.')), h('span', { className: `dt-status ${account ? 'is-online' : ''}` }, account ? '● Connected' : '○ Connecting')),
                !account ? h('div', { className: 'dt-empty', role: 'status' }, 'Connect or switch to a Deriv account and wait for the connection. If your session expired, sign in again.') :
                h(React.Fragment, null,
                    h('div', { className: `dt-account ${account.demo ? 'is-demo' : 'is-real'}` }, h('div', null, h('span', null, account.demo ? 'DEMO ACCOUNT' : 'REAL ACCOUNT'), h('strong', null, account.id)), h('div', { className: 'dt-account-balance' }, h('span', null, 'DERIV BALANCE'), h('strong', null, balance ? money(balance.amount, balance.currency) : 'Loading…'))),
                    h('p', { className: 'dt-risk' }, account.demo ? 'Demo trades use virtual funds. Check the account selector before switching to real funds.' : 'Real account: purchases use real money and can result in losses.'),
                    h('div', { className: 'dt-grid' },
                        h('section', { className: 'dt-card dt-market' }, h('div', { className: 'dt-card-top' }, h('div', null, h('div', { className: 'dt-eyebrow' }, 'LIVE MARKET'), h('h2', null, markets.find(m => m.symbol === symbol)?.display_name || 'Select a market')), h('span', { className: 'dt-live' }, '● LIVE')), h('div', { className: 'dt-price' }, tick ? Number(tick.quote).toLocaleString(undefined, { minimumFractionDigits: Math.min(Math.max(Number(tick.pip_size) || 0, 0), 10), maximumFractionDigits: Math.min(Math.max(Number(tick.pip_size) || 5, 0), 10) }) : 'Waiting for tick…'), h('div', { className: 'dt-chart', 'aria-label': 'Recent live price movement' }, chart ? h('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true }, h('polyline', { points: chart, fill: 'none', stroke: 'currentColor', strokeWidth: '1.2', vectorEffect: 'non-scaling-stroke' })) : h('span', null, 'Live chart builds as prices arrive')), h('p', { className: 'dt-footnote' }, 'Price updates are provided by Deriv.')),
                        h('section', { className: 'dt-card dt-ticket' }, h('div', { className: 'dt-eyebrow' }, 'TRADE TICKET'), h('h2', null, 'Set up your trade'),
                            field('Market', h('select', { value: symbol, disabled: !!pending || !markets.length, onChange: e => { resetQuote(); setSymbol(e.target.value); } }, markets.map(m => h('option', { key: m.symbol, value: m.symbol }, m.display_name)))),
                            h('div', { className: 'dt-field-row' }, field(`Stake (${account.currency})`, h('input', { type: 'number', min: '0.01', step: 'any', value: amount, disabled: !!pending, onChange: e => { resetQuote(); setAmount(e.target.value); } })), field('Duration (ticks)', h('input', { type: 'number', min: '1', max: '10', step: '1', value: duration, disabled: !!pending, onChange: e => { resetQuote(); setDuration(e.target.value); } }))),
                            h('p', { className: 'dt-footnote' }, 'Choose a direction to request a quote. No trade is placed until you confirm.'),
                            uncertain && h('div', { className: 'dt-error', role: 'alert' }, h('p', null, 'A previous purchase may have been submitted. Check this account’s Deriv portfolio before placing another trade.'), h('button', { type: 'button', disabled: !!pending, className: 'dt-clear-warning', onClick: clearUncertain }, 'I checked the portfolio')),
                            h('div', { className: 'dt-directions' }, h('button', { type: 'button', disabled: !!pending || !symbol || uncertain, className: 'dt-rise', onClick: () => requestQuote('CALL') }, '↗  Rise'), h('button', { type: 'button', disabled: !!pending || !symbol || uncertain, className: 'dt-fall', onClick: () => requestQuote('PUT') }, '↘  Fall')),
                            pending === 'quote' && h('p', { role: 'status' }, 'Getting a quote from Deriv…'),
                            quote && h('div', { className: 'dt-quote' }, h('div', { className: 'dt-eyebrow' }, 'REVIEW YOUR QUOTE'), h('strong', null, `${quote.contractType === 'CALL' ? 'Rise' : 'Fall'} · ${quote.duration} ticks`), h('p', null, quote.description), h('div', { className: 'dt-quote-row' }, h('span', null, 'Purchase price'), h('strong', null, money(quote.price, quote.account.currency))), h('div', { className: 'dt-quote-row' }, h('span', null, 'Potential payout'), h('strong', null, money(quote.payout, quote.account.currency))), h('small', null, 'Quote expires after 15 seconds. The purchase is sent to the account shown above.'), h('button', { type: 'button', className: 'dt-buy', disabled: !!pending, onClick: purchase }, pending === 'buy' ? 'Submitting…' : `Confirm purchase · ${money(quote.price, quote.account.currency)}`)),
                            error && h('p', { className: 'dt-error', role: 'alert' }, error))),
                    result && h('section', { className: 'dt-card dt-result', 'aria-live': 'polite' }, h('div', { className: 'dt-eyebrow' }, 'LATEST CONTRACT'), h('h2', null, result.status === 'won' ? 'Won' : result.status === 'lost' ? 'Lost' : result.is_sold ? 'Closed' : 'Open'), h('p', null, `Contract #${result.contract_id || contract}`), result.profit != null && h('p', null, `Profit / loss: ${money(result.profit, account.currency)}`), h('p', { className: 'dt-footnote' }, 'Check your Deriv portfolio for full contract details.'))));
        }
        return function DTrader() {
            const [showLocal, setShowLocal] = useState(false);
            const [sharing, setSharing] = useState(false);
            const [bridgeAccount, setBridgeAccount] = useState(null);
            const [bridgeError, setBridgeError] = useState('');
            const frameRef = useRef(null), retries = useRef([]), last = useRef(null), serial = useRef(0);
            const base = apiModule.api_base;
            const clearRetries = () => { retries.current.forEach(clearTimeout); retries.current = []; };
            useEffect(() => {
                if (!sharing || showLocal) { last.current = null; setBridgeAccount(null); return; }
                const update = () => {
                    const next = bridgeCredentials(base, localStorage, sessionStorage);
                    const previous = last.current;
                    if ((!next && previous) || (next && (!previous || next.loginid !== previous.loginid || next.token !== previous.token || next.api !== previous.api || next.currency !== previous.currency))) {
                        clearRetries();
                        setBridgeError('');
                        last.current = next;
                        setBridgeAccount(next ? { id: next.loginid, currency: next.currency, demo: next.demo, key: ++serial.current } : null);
                    }
                };
                update();
                const interval = setInterval(update, 500);
                window.addEventListener('deriv:account-switch', update);
                window.addEventListener('storage', update);
                return () => { clearInterval(interval); clearRetries(); last.current = null; window.removeEventListener('deriv:account-switch', update); window.removeEventListener('storage', update); };
            }, [sharing, showLocal, base]);
            useEffect(() => {
                if (!sharing || showLocal || !bridgeAccount) return;
                const receive = event => {
                    if (isBridgeAuthRequest(event, frameRef.current)) sendBridgeAuth(frameRef.current, base, localStorage, sessionStorage, bridgeAccount.id);
                    else if (event.origin === DTRADER_ORIGIN && event.source === frameRef.current?.contentWindow && event.data?.type === 'INVALID_TOKEN') setBridgeError('DTrader reported that the token is invalid. Sign in again and reconnect your account.');
                };
                window.addEventListener('message', receive);
                return () => window.removeEventListener('message', receive);
            }, [sharing, showLocal, bridgeAccount, base]);
            const frameLoaded = () => {
                clearRetries();
                if (!sharing || !bridgeAccount) return;
                // The child may set up its message listener shortly after its load event.
                [0, 500, 1500, 3000].forEach(delay => retries.current.push(setTimeout(() => {
                    sendBridgeAuth(frameRef.current, base, localStorage, sessionStorage, bridgeAccount.id);
                }, delay)));
            };
            const toggleSharing = () => {
                if (sharing) { clearRetries(); setBridgeError(''); setSharing(false); return; }
                if (window.confirm('Share your Deriv trading token with deriv-dtrader.vercel.app? Its operator may use the token to trade on accounts it authorizes and may retain it after you sign out of Dylan Trades. Only continue if you trust this service.')) setSharing(true);
            };
            return h('section', { className: 'dt-external' },
                h('div', { className: 'dt-external-bar' },
                    h('div', null,
                        h('h1', null, 'DTrader'),
                        h('p', null, showLocal
                            ? 'Use the Dylan Trades Rise/Fall ticket with your connected account.'
                            : 'Hosted by deriv-dtrader.vercel.app. Check the account shown inside DTrader before trading.')),
                    h('div', { className: 'dt-external-actions' },
                        !showLocal && h('button', { type: 'button', onClick: toggleSharing }, sharing ? 'Stop sharing account' : 'Connect Dylan Trades account'),
                        h('button', { type: 'button', onClick: () => setShowLocal(!showLocal) }, showLocal ? 'Show DTrader' : 'Use simple trading ticket'),
                        h('a', { href: DTRADER_ORIGIN + '/', target: '_blank', rel: 'noopener noreferrer' }, 'Open DTrader in a new tab ↗'))),
                showLocal ? h(LocalDTrader) : h(React.Fragment, null,
                    h('p', { className: 'dt-embed-note', role: 'status' }, sharing
                        ? bridgeAccount ? `Sharing is enabled for ${bridgeAccount.demo ? 'demo' : 'real or unverified'} account ${bridgeAccount.id}. Verify the same account and balance inside DTrader before trading. Stopping sharing or signing out here may not sign you out there.` : 'Waiting for your selected Deriv account to connect. Sign in or reconnect before sharing.'
                        : 'Your account is not shared unless you choose Connect. The external service may retain an earlier session; always verify its account before trading. If it does not load, open it in a new tab.'),
                    bridgeError && h('p', { className: 'dt-embed-note', role: 'alert' }, bridgeError),
                    (!sharing || bridgeAccount) && h('iframe', {
                        key: sharing ? `connected-${bridgeAccount.key}` : 'independent',
                        ref: frameRef,
                        className: 'dt-external-frame',
                        title: 'DTrader trading platform',
                        src: DTRADER_ORIGIN + '/',
                        referrerPolicy: 'no-referrer',
                        allow: 'clipboard-write',
                        loading: 'lazy',
                        onLoad: frameLoaded,
                    })));
        };
    }
    return { createComponent, createTradeController, connectedAccount, bridgeCredentials, sendBridgeAuth, isBridgeAuthRequest, QUOTE_LIFETIME_MS };
});
