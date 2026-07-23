const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

module.exports = {
  appName: process.env.COMPANY_NAME || "Facebook Data Inspector",
  
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:4321",
  
  supportEmail: process.env.SUPPORT_EMAIL || "",
  
  companyName: process.env.COMPANY_NAME || "Facebook Data Inspector"
};
