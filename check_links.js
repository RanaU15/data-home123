const fs = require('fs');
const html = fs.readFileSync('debug_card_1783659900485.html', 'utf8');
const links = html.match(/href="([^"]+)"/g);
if (links) {
    links.forEach(l => console.log(l));
} else {
    console.log("No links found");
}
