const http = require('http');
const fs = require('fs');
const path = require('path');
const tokenExchange = require('./api/oauth/token');

const PORT = 8080;
const SIMULATION_ACCOUNT_IDS = new Set(['ROT91160344', 'ROT91181979']);
const SIMULATION_STARTING_BALANCE = 500;
const simulationAccounts = new Map();

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.cur': 'application/octet-stream',
};

function getSimulationAccount(accountId) {
    if (!simulationAccounts.has(accountId)) {
        simulationAccounts.set(accountId, {
            accountId,
            balance: SIMULATION_STARTING_BALANCE,
            trades: [],
        });
    }

    return simulationAccounts.get(accountId);
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

function handleSimulationApi(req, res, url) {
    if (!url.startsWith('/api/simulation')) return false;

    const accountId = req.headers['x-account-id'];
    if (!SIMULATION_ACCOUNT_IDS.has(accountId)) {
        sendJson(res, 403, { error: 'Simulation is not available for this account.' });
        return true;
    }

    const account = getSimulationAccount(accountId);
    if (req.method === 'GET' && url === '/api/simulation') {
        sendJson(res, 200, account);
        return true;
    }

    if (req.method === 'POST' && url === '/api/simulation/reset') {
        account.balance = SIMULATION_STARTING_BALANCE;
        account.trades = [];
        sendJson(res, 200, account);
        return true;
    }

    if (req.method === 'POST' && url === '/api/simulation/trade') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try {
                const trade = JSON.parse(body || '{}');
                const amount = Number(trade.amount);
                const profit = Number(trade.profit || 0);
                if (!Number.isFinite(amount) || amount <= 0 || amount > account.balance) {
                    sendJson(res, 400, { error: 'Trade amount must be positive and within the simulation balance.' });
                    return;
                }
                if (!Number.isFinite(profit)) {
                    sendJson(res, 400, { error: 'Trade profit must be a valid number.' });
                    return;
                }

                account.balance = Number((account.balance - amount + profit).toFixed(2));
                account.trades.push({
                    id: `simulation-${Date.now()}`,
                    amount,
                    profit,
                    result: trade.result === 'win' ? 'win' : 'loss',
                    createdAt: new Date().toISOString(),
                });
                sendJson(res, 200, account);
            } catch {
                sendJson(res, 400, { error: 'Invalid simulation trade data.' });
            }
        });
        return true;
    }

    sendJson(res, 404, { error: 'Simulation endpoint not found.' });
    return true;
}

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url.split('?')[0]}`);
    
    let url = req.url.split('?')[0];

    if (url === '/api/oauth/token') return void tokenExchange(req, res);
    if (handleSimulationApi(req, res, url)) return;
    
    // Normalize URL paths to filesystem paths
    let filePath = '';
    if (url === '/' || url === '/index.html' || url === '/callback') {
        filePath = path.join(__dirname, 'index.html');
    } else if (url.startsWith('/static/js/')) {
        const fileName = url.substring('/static/js/'.length);
        filePath = path.join(__dirname, 'scripts', fileName);
    } else if (url.startsWith('/static/css/')) {
        const fileName = url.substring('/static/css/'.length);
        filePath = path.join(__dirname, 'styles', fileName);
    } else if (url.startsWith('/static/media/')) {
        const fileName = url.substring('/static/media/'.length);
        filePath = path.join(__dirname, 'images', fileName);
    } else if (url.startsWith('/images/')) {
        const fileName = url.substring('/images/'.length);
        filePath = path.join(__dirname, 'images', fileName);
    } else {
        // Fallback: look in root, scripts, styles, images
        filePath = path.join(__dirname, url);
    }
    
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // Check in other directories as fallback
            const baseName = path.basename(url);
            const fallbackPaths = [
                path.join(__dirname, 'scripts', baseName),
                path.join(__dirname, 'styles', baseName),
                path.join(__dirname, 'images', baseName)
            ];
            
            let found = false;
            for (const fp of fallbackPaths) {
                if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
                    filePath = fp;
                    found = true;
                    break;
                }
            }
            
            if (!found) {
                console.log(`Not found: ${req.url} (resolved to: ${filePath})`);
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
                return;
            }
        }
        
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
