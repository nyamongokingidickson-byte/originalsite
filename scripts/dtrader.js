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
                const types = ['CALL', 'PUT', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'];
                if (!input.symbol || !types.includes(input.contractType) || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(duration) || duration < 1 || duration > 10)
                    throw new Error('Choose a market, enter a positive stake and a duration between 1 and 10 ticks.');
                const needsPrediction = ['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(input.contractType);
                const prediction = String(input.prediction ?? '');
                if (needsPrediction && !/^[0-9]$/.test(prediction)) throw new Error('Choose a prediction digit from 0 to 9.');
                const request = { proposal: 1, amount, basis: 'stake', contract_type: input.contractType, currency: account.currency, duration, duration_unit: 't', symbol: input.symbol };
                if (needsPrediction) request.barrier = prediction;
                const response = checked(await withTimeout(account.api.send(request), timeoutMs));
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

    function createComponent(React, apiModule) {
        const h = React.createElement;
        const { useState, useRef, useEffect, useCallback } = React;
        function LocalDTrader() {
            const base = apiModule.api_base;
            const controller = useRef(null);
            if (!controller.current) controller.current = createTradeController(base, localStorage, () => Date.now(), sessionStorage);
            const [account, setAccount] = useState(null), [marketApi, setMarketApi] = useState(null), [markets, setMarkets] = useState([]);
            const [symbol, setSymbol] = useState(''), [amount, setAmount] = useState('1'), [duration, setDuration] = useState('5');
            const [family, setFamily] = useState('rise'), [prediction, setPrediction] = useState('5');
            const [positions, setPositions] = useState(null), [portfolioError, setPortfolioError] = useState('');
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
                    const nextMarketApi = base.api?.connection?.readyState === 1 ? base.api : null;
                    setMarketApi(previous => previous === nextMarketApi ? previous : nextMarketApi);
                    setUncertain(!!current && controller.current.hasPending(current.id));
                    const signature = current ? `${current.id}:${current.currency}:${current.demo}` : '';
                    if (signature !== last || (current && current.api !== update.api)) {
                        last = signature; update.api = current?.api;
                        resetQuote(); setAccount(current); setBalance(null); setResult(null); setContract(null); setPositions(null); setPortfolioError('');
                    }
                };
                update();
                const interval = setInterval(update, 1000);
                window.addEventListener('deriv:account-switch', update);
                window.addEventListener('storage', update);
                return () => { alive.current = false; version.current++; controller.current.invalidate(); clearInterval(interval); window.removeEventListener('deriv:account-switch', update); window.removeEventListener('storage', update); };
            }, [base, resetQuote]);
            // Public market data can load before sign-in; trading still requires the selected authenticated account.
            useEffect(() => {
                if (!marketApi) { setMarkets([]); setSymbol(''); setTick(null); setHistory([]); return; }
                let active = true;
                withTimeout(marketApi.send({ active_symbols: 'brief' }), REQUEST_TIMEOUT_MS).then(symbols => {
                    checked(symbols);
                    if (!active) return;
                    const list = (symbols.active_symbols || []).filter(item => item.symbol && item.display_name && item.exchange_is_open !== 0 && item.exchange_is_open !== false && !item.is_trading_suspended);
                    list.sort((a, b) => a.display_name.localeCompare(b.display_name));
                    setMarkets(list);
                    setSymbol(previous => list.some(item => item.symbol === previous) ? previous : (list.find(item => item.symbol === 'R_100')?.symbol || list[0]?.symbol || ''));
                    if (!list.length) setError('No markets are currently available.');
                }).catch(e => { if (active) setError(`Unable to load markets: ${message(e)}`); });
                return () => { active = false; };
            }, [marketApi]);
            useEffect(() => {
                if (!account) return;
                let active = true;
                const listener = account.api.onMessage().subscribe(event => {
                    const data = event.data;
                    if (active && data?.msg_type === 'balance' && data.balance?.balance != null && (!data.balance.loginid || data.balance.loginid === account.id))
                        setBalance({ amount: data.balance.balance, currency: data.balance.currency || account.currency });
                });
                withTimeout(account.api.send({ balance: 1 }), REQUEST_TIMEOUT_MS).then(balances => {
                    checked(balances);
                    if (active && balances.balance?.balance != null) setBalance({ amount: balances.balance.balance, currency: balances.balance.currency || account.currency });
                }).catch(e => { if (active) setError(`Unable to load balance: ${message(e)}`); });
                return () => { active = false; listener?.unsubscribe?.(); };
            }, [account]);
            useEffect(() => {
                if (!marketApi || !symbol) return;
                let active = true, subscriptionId = null;
                setTick(null); setHistory([]);
                const listener = marketApi.onMessage().subscribe(event => {
                    const data = event.data;
                    if (!active || data?.error) return;
                    if (data.msg_type === 'tick' && data.tick?.symbol === symbol) {
                        const price = Number(data.tick.quote);
                        if (Number.isFinite(price)) { setTick(data.tick); setHistory(old => [...old, price].slice(-48)); }
                    }
                });
                withTimeout(marketApi.send({ ticks_history: symbol, count: 48, end: 'latest', style: 'ticks' }), REQUEST_TIMEOUT_MS).then(response => {
                    checked(response);
                    const prices = (response.history?.prices || []).map(Number).filter(Number.isFinite);
                    if (active && prices.length) setHistory(current => [...prices, ...current].slice(-48));
                }).catch(() => {});
                marketApi.send({ ticks: symbol, subscribe: 1 }).then(response => {
                    checked(response);
                    subscriptionId = response?.subscription?.id;
                    if (!active && subscriptionId) marketApi.send({ forget: subscriptionId }).catch(() => {});
                }).catch(e => { if (active) setError(message(e)); });
                return () => { active = false; listener?.unsubscribe?.(); if (subscriptionId) marketApi.send({ forget: subscriptionId }).catch(() => {}); };
            }, [marketApi, symbol]);
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
            useEffect(() => {
                if (!account) return;
                let active = true, timer;
                const refresh = async () => {
                    try {
                        const data = checked(await withTimeout(account.api.send({ portfolio: 1 }), REQUEST_TIMEOUT_MS));
                        if (!Array.isArray(data.portfolio?.contracts)) throw new Error('Deriv returned an incomplete portfolio.');
                        if (active) { setPositions(data.portfolio.contracts); setPortfolioError(''); }
                    } catch (e) { if (active) setPortfolioError(`Unable to load positions: ${message(e)}`); }
                    if (active) timer = setTimeout(refresh, 15000);
                };
                refresh();
                return () => { active = false; clearTimeout(timer); };
            }, [account, contract]);
            const choices = {
                rise: [['CALL', 'Rise'], ['PUT', 'Fall']],
                even: [['DIGITEVEN', 'Even'], ['DIGITODD', 'Odd']],
                match: [['DIGITMATCH', 'Matches'], ['DIGITDIFF', 'Differs']],
                over: [['DIGITOVER', 'Over'], ['DIGITUNDER', 'Under']],
            };
            const needsPrediction = family === 'match' || family === 'over';
            const requestQuote = async type => {
                if (busy.current) return;
                busy.current = true; resetQuote(); setPending('quote');
                const requestVersion = version.current;
                try {
                    const value = await controller.current.getQuote({ symbol, amount, duration, contractType: type, prediction });
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
                h('header', { className: 'dt-heading' }, h('div', null, h('div', { className: 'dt-eyebrow' }, 'DYLAN TRADES / MANUAL TRADING'), h('h1', null, 'DTrader'), h('p', null, 'Trade directly with your connected Deriv account.')), h('span', { className: `dt-status ${account ? 'is-online' : ''}` }, account ? '● Connected' : marketApi ? '○ Sign in to trade' : '○ Connecting')),
                h(React.Fragment, null,
                    account ? h('div', { className: `dt-account ${account.demo ? 'is-demo' : 'is-real'}` }, h('div', null, h('span', null, account.demo ? 'DEMO ACCOUNT' : 'REAL OR UNVERIFIED ACCOUNT'), h('strong', null, account.id)), h('div', { className: 'dt-account-balance' }, h('span', null, 'DERIV BALANCE'), h('strong', null, balance ? money(balance.amount, balance.currency) : 'Loading…'))) : h('div', { className: 'dt-empty', role: 'status' }, 'Sign in to your Deriv account to trade and view your balance. Market data can be viewed without signing in.'),
                    h('p', { className: 'dt-risk' }, !account ? 'Trading requires an authenticated Deriv account.' : account.demo ? 'Demo trades use virtual funds. Check the account selector before switching to real funds.' : 'Real account: purchases use real money and can result in losses.'),
                    h('div', { className: 'dt-grid' },
                        h('section', { className: 'dt-card dt-market' }, h('div', { className: 'dt-card-top' }, h('div', null, h('div', { className: 'dt-eyebrow' }, 'LIVE MARKET'), h('h2', null, markets.find(m => m.symbol === symbol)?.display_name || 'Select a market')), h('span', { className: tick ? 'dt-live' : 'dt-status' }, tick ? '● LIVE' : '○ Connecting')), h('div', { className: 'dt-price' }, tick ? Number(tick.quote).toLocaleString(undefined, { minimumFractionDigits: Math.min(Math.max(Number(tick.pip_size) || 0, 0), 10), maximumFractionDigits: Math.min(Math.max(Number(tick.pip_size) || 5, 0), 10) }) : 'Waiting for tick…'), h('div', { className: 'dt-chart', 'aria-label': 'Recent live price movement' }, chart ? h('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true }, h('polyline', { points: chart, fill: 'none', stroke: 'currentColor', strokeWidth: '1.2', vectorEffect: 'non-scaling-stroke' })) : h('span', null, 'Live chart builds as prices arrive')), h('p', { className: 'dt-footnote' }, 'Price updates are provided by Deriv.')),
                        h('section', { className: 'dt-card dt-ticket' }, h('div', { className: 'dt-eyebrow' }, 'TRADE TICKET'), h('h2', null, 'Set up your trade'),
                            field('Market', h('select', { value: symbol, disabled: !!pending || !markets.length, onChange: e => { resetQuote(); setSymbol(e.target.value); } }, markets.map(m => h('option', { key: m.symbol, value: m.symbol }, m.display_name)))),
                            field('Contract', h('select', { value: family, disabled: !!pending, onChange: e => { resetQuote(); setFamily(e.target.value); } }, h('option', { value: 'rise' }, 'Rise / Fall'), h('option', { value: 'even' }, 'Even / Odd'), h('option', { value: 'match' }, 'Matches / Differs'), h('option', { value: 'over' }, 'Over / Under'))),
                            needsPrediction && field('Prediction', h('select', { value: prediction, disabled: !!pending, onChange: e => { resetQuote(); setPrediction(e.target.value); } }, Array.from({ length: 10 }, (_, i) => h('option', { key: i, value: String(i) }, String(i))))),
                            h('div', { className: 'dt-field-row' }, field(account ? `Stake (${account.currency})` : 'Stake',  h('input', { type: 'number', min: '0.01', step: 'any', value: amount, disabled: !!pending, onChange: e => { resetQuote(); setAmount(e.target.value); } })), field('Duration (ticks)', h('input', { type: 'number', min: '1', max: '10', step: '1', value: duration, disabled: !!pending, onChange: e => { resetQuote(); setDuration(e.target.value); } }))),
                            h('p', { className: 'dt-footnote' }, 'Choose a direction to request a quote. No trade is placed until you confirm.'),
                            uncertain && h('div', { className: 'dt-error', role: 'alert' }, h('p', null, 'A previous purchase may have been submitted. Check this account’s Deriv portfolio before placing another trade.'), h('button', { type: 'button', disabled: !!pending, className: 'dt-clear-warning', onClick: clearUncertain }, 'I checked the portfolio')),
                            h('div', { className: 'dt-directions' }, choices[family].map(([type, label], index) => h('button', { key: type, type: 'button', disabled: !account || !!pending || !symbol || uncertain, className: index === 0 ? 'dt-rise' : 'dt-fall', onClick: () => requestQuote(type) }, label))),
                            pending === 'quote' && h('p', { role: 'status' }, 'Getting a quote from Deriv…'),
                            quote && h('div', { className: 'dt-quote' }, h('div', { className: 'dt-eyebrow' }, 'REVIEW YOUR QUOTE'), h('strong', null, `${Object.values(choices).flat().find(([type]) => type === quote.contractType)?.[1] || quote.contractType} · ${quote.duration} ticks`), h('p', null, quote.description), h('div', { className: 'dt-quote-row' }, h('span', null, 'Purchase price'), h('strong', null, money(quote.price, quote.account.currency))), h('div', { className: 'dt-quote-row' }, h('span', null, 'Potential payout'), h('strong', null, money(quote.payout, quote.account.currency))), h('small', null, 'Quote expires after 15 seconds. The purchase is sent to the account shown above.'), h('button', { type: 'button', className: 'dt-buy', disabled: !!pending, onClick: purchase }, pending === 'buy' ? 'Submitting…' : `Confirm purchase · ${money(quote.price, quote.account.currency)}`)),
                            error && h('p', { className: 'dt-error', role: 'alert' }, error))),
                    account && result && h('section', { className: 'dt-card dt-result', 'aria-live': 'polite' }, h('div', { className: 'dt-eyebrow' }, 'LATEST CONTRACT'), h('h2', null, result.status === 'won' ? 'Won' : result.status === 'lost' ? 'Lost' : result.is_sold ? 'Closed' : 'Open'), h('p', null, `Contract #${result.contract_id || contract}`), result.profit != null && h('p', null, `Profit / loss: ${money(result.profit, account.currency)}`), h('p', { className: 'dt-footnote' }, 'Check your Deriv portfolio for full contract details.')),
                    h('section', { className: 'dt-card dt-positions', 'aria-live': 'polite' }, h('div', { className: 'dt-eyebrow' }, 'DERIV PORTFOLIO'), h('h2', null, 'Open positions'), !account ? h('p', { className: 'dt-footnote' }, 'Sign in to view your open positions.') : portfolioError ? h('p', { className: 'dt-error', role: 'alert' }, portfolioError) : positions === null ? h('p', { className: 'dt-footnote' }, 'Loading positions…') : positions.length ? h('ul', null, positions.map(position => h('li', { key: position.contract_id }, h('strong', null, `#${position.contract_id}`), h('span', null, position.longcode || position.symbol || position.contract_type || 'Open contract'), position.buy_price != null && h('span', null, `Buy price: ${money(position.buy_price, position.currency || account.currency)}`)))) : h('p', { className: 'dt-footnote' }, 'No open positions.'))));
        }
        return LocalDTrader;
    }
    return { createComponent, createTradeController, connectedAccount, QUOTE_LIFETIME_MS };
});
