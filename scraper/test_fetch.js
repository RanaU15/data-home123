const fs = require('fs');

async function testFetch() {
    const cookieStr = fs.readFileSync('scraper/facebook-cookies.json', 'utf8');
    const cookies = JSON.parse(cookieStr);
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const url = "https://mbasic.facebook.com/groups/644861357496091/posts/1397504602231759/";
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
            'Cookie': cookieHeader,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });

    const text = await response.text();
    fs.writeFileSync('fetch_mbasic.html', text);
    console.log("Status:", response.status);
    console.log("Dumped to fetch_mbasic.html");
}
testFetch().catch(console.error);
