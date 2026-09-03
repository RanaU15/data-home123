const PocketBase = require('pocketbase').default;
const http = require('http');

const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);

async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    let testUser;
    try {
        testUser = await pb.collection('users').create({
            email: 'test_frontend_blank@example.com',
            password: 'password123',
            passwordConfirm: 'password123',
            name: 'Test Blank',
            emailVisibility: true
        });
    } catch (e) {
        testUser = await pb.collection('users').getFirstListItem("email='test_frontend_blank@example.com'");
    }

    await pb.collection('users').authWithPassword('test_frontend_blank@example.com', 'password123');
    const cookie = pb.authStore.exportToCookie({ httpOnly: false });
    const match = cookie.match(/pb_auth=([^;]+)/);
    const authVal = match ? match[1] : '';

    console.log("Cookie extracted. Fetching /alerts/create ...");

    http.get('http://localhost:4321/alerts/create', {
        headers: { Cookie: 'pb_auth=' + authVal }
    }, (res) => {
        console.log('Status Code:', res.statusCode);
        console.log('Headers:', res.headers);
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => console.log('Response Length:', data.length, '\nBody snippet:', data.substring(0, 500)));
    }).on('error', console.error);
}

run().catch(console.error);
