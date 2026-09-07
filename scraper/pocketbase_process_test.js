const process = require('process');

const startTime = new Date().toISOString();

console.log("========================================");
console.log("POCKETBASE NODE PROCESS TEST");
console.log("========================================");
console.log(`Node executable: ${process.execPath}`);
console.log(`Working directory: ${process.cwd()}`);
console.log(`Node version: ${process.version}`);
console.log(`Started: ${startTime}`);
console.log("Status: External Node process executed successfully");
console.log(`Completed: ${new Date().toISOString()}`);
console.log("========================================");

process.exit(0);
