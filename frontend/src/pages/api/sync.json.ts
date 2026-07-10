export const GET = async () => {
  const now = new Date();
  
  // The production scheduler (Cloudflare cron) runs at 00 and 30 minutes past the hour.
  const lastSync = new Date(now);
  if (now.getMinutes() >= 30) {
    lastSync.setMinutes(30, 0, 0);
  } else {
    lastSync.setMinutes(0, 0, 0);
  }
  
  const nextSync = new Date(lastSync);
  nextSync.setMinutes(lastSync.getMinutes() + 30);
  
  return new Response(JSON.stringify({
    last_sync_utc: lastSync.toISOString(),
    next_sync_utc: nextSync.toISOString()
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
};
