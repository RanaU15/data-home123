const http = require('http');
const { runScrapeCycle } = require("./scraper");

const PORT = process.env.PORT || 3001;
const SECRET_TOKEN = process.env.SCRAPER_SECRET_TOKEN || "";

let isRunning = false;
let lastRun = null;
let lastSuccess = null;
let lastError = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Helpers
  const jsonResponse = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && url.pathname === '/health') {
    return jsonResponse(200, {
      status: "ok",
      isRunning,
      lastRun,
      lastSuccess,
      lastError,
      uptime: process.uptime()
    });
  }

  if (req.method === 'POST' && url.pathname === '/trigger-scrape') {
    const token = req.headers['x-scraper-token'];
    if (SECRET_TOKEN && token !== SECRET_TOKEN) {
      console.warn(`[Trigger Server] Unauthorized scrape attempt. Token mismatch.`);
      return jsonResponse(401, { error: "Unauthorized", message: "Invalid X-Scraper-Token" });
    }

    if (isRunning) {
      console.warn(`[Trigger Server] Scrape already running. Rejecting trigger.`);
      return jsonResponse(409, { error: "Conflict", message: "Scraper is already running" });
    }

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let parsedBody = {};
      try {
        if (body) parsedBody = JSON.parse(body);
      } catch (e) {
        console.warn(`[Trigger Server] Failed to parse request body: ${e.message}`);
      }

      console.log(`[Trigger Server] Scrape triggered by: ${parsedBody.triggered_by || 'unknown'}`);
      
      // Respond immediately (202 Accepted)
      jsonResponse(202, { message: "Scrape process initiated in background" });

      // Run in background
      isRunning = true;
      lastRun = new Date().toISOString();

      runScrapeCycle()
        .then(() => {
          console.log(`[Trigger Server] Scrape cycle completed successfully.`);
          lastSuccess = new Date().toISOString();
          lastError = null;
        })
        .catch(err => {
          console.error(`[Trigger Server] Scrape cycle failed:`, err);
          lastError = { message: err.message, at: new Date().toISOString() };
        })
        .finally(() => {
          isRunning = false;
        });
    });
    return;
  }

  return jsonResponse(404, { error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`[Trigger Server] Listening on port ${PORT}`);
  console.log(`[Trigger Server] Ensure SCRAPER_SECRET_TOKEN environment variable is set.`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Trigger Server] Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});
process.on('SIGTERM', () => {
  console.log('[Trigger Server] Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});
