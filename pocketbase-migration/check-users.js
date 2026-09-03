require("dotenv").config();

const { Client } = require("pg");

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;

async function main() {
    console.log("==============================================");
    console.log(" Supabase User Check");
    console.log("==============================================");

    const client = new Client({
        connectionString: SUPABASE_DB_URL,
        ssl: {
            rejectUnauthorized: false,
        },
    });

    await client.connect();

    console.log("Supabase connected.");

    const result = await client.query(`
    SELECT
      id,
      email,
      email_confirmed_at,
      created_at,
      updated_at,
      last_sign_in_at
    FROM auth.users
    ORDER BY created_at;
  `);

    console.log(`\nFound ${result.rows.length} users.\n`);

    for (const [index, user] of result.rows.entries()) {
        console.log(
            `${index + 1}. ${user.email}`
        );
        console.log(`   ID: ${user.id}`);
        console.log(`   Email confirmed: ${!!user.email_confirmed_at}`);
        console.log(`   Created: ${user.created_at}`);
        console.log(`   Last login: ${user.last_sign_in_at || "Never"}`);
        console.log("");
    }

    await client.end();

    console.log("==============================================");
    console.log("CHECK COMPLETE");
    console.log("==============================================");
}

main().catch((error) => {
    console.error("\n❌ ERROR");
    console.error(error);
    process.exit(1);
});