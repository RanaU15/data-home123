const NotificationService = require('./backend/services/NotificationService');
const pbClient = require('./scraper/pocketbase');
async function run() {
    const pb = await pbClient.getPb();
    await NotificationService.processPendingBatches(pb);
}
run().catch(console.error);
