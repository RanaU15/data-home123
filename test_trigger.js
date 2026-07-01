const https = require('https');

const data = JSON.stringify({ triggered_by: 'manual-test' });

const options = {
  hostname: '3d5529978a9c45.lhr.life',
  port: 443,
  path: '/trigger-scrape',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Scraper-Token': '382fa699337c8caf16fafc9a35ed186ffa7c19127a2a0a7f1c03e44bb6111ee7',
    'Content-Length': data.length
  }
};

const req = https.request(options, res => {
  console.log(`statusCode: ${res.statusCode}`);
  res.on('data', d => {
    process.stdout.write(d);
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(data);
req.end();
