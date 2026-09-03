require("dotenv").config();

const PocketBase = require("pocketbase").default;
const { Client } = require("pg");

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

if (
    !SUPABASE_DB_URL ||
    !POCKETBASE_URL ||
    !PB_ADMIN_EMAIL ||
    !PB_ADMIN_PASSWORD
) {
    console.error("Missing required environment variables.");
    console.error(`
Required:

SUPABASE_DB_URL
POCKETBASE_URL
PB_ADMIN_EMAIL
PB_ADMIN_PASSWORD
`);
    process.exit(1);
}

const TARGETS = [
    {
        schema: "auth",
        table: "users",
        pbName: "users",
        type: "auth",
    },
    {
        schema: "public",
        table: "alerts",
        pbName: "alerts",
        type: "base",
    },
    {
        schema: "public",
        table: "group_sync_6mo",
        pbName: "group_sync_6mo",
        type: "base",
    },
    {
        schema: "public",
        table: "notifications",
        pbName: "notifications",
        type: "base",
    },
    {
        schema: "public",
        table: "posts",
        pbName: "posts",
        type: "base",
    },
    {
        schema: "public",
        table: "profiles",
        pbName: "profiles",
        type: "base",
    },
];

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function mapPostgresType(column) {
    const type = column.data_type;
    const udt = column.udt_name;

    // Boolean
    if (type === "boolean") {
        return {
            type: "bool",
            options: {},
        };
    }

    // Integer / numeric / decimal / floating
    if (
        [
            "smallint",
            "integer",
            "bigint",
            "numeric",
            "decimal",
            "real",
            "double precision",
        ].includes(type)
    ) {
        return {
            type: "number",
            options: {},
        };
    }

    // Dates / timestamps
    if (
        type === "date" ||
        type === "timestamp without time zone" ||
        type === "timestamp with time zone"
    ) {
        return {
            type: "date",
            options: {},
        };
    }

    // JSON
    if (type === "json" || type === "jsonb") {
        return {
            type: "json",
            options: {},
        };
    }

    // Arrays
    if (type === "ARRAY" || String(udt).startsWith("_")) {
        return {
            type: "json",
            options: {},
        };
    }

    // UUID / varchar / text / char / enum / inet / etc.
    return {
        type: "text",
        options: {},
    };
}

async function getColumns(pg, schema, table) {
    const result = await pg.query(
        `
    SELECT
      c.column_name,
      c.data_type,
      c.udt_name,
      c.is_nullable,
      c.column_default,
      c.character_maximum_length,
      c.numeric_precision,
      c.numeric_scale,
      c.ordinal_position
    FROM information_schema.columns c
    WHERE c.table_schema = $1
      AND c.table_name = $2
    ORDER BY c.ordinal_position
    `,
        [schema, table]
    );

    return result.rows;
}

async function getPrimaryKey(pg, schema, table) {
    const result = await pg.query(
        `
    SELECT
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = $1
      AND tc.table_name = $2
    ORDER BY kcu.ordinal_position
    `,
        [schema, table]
    );

    return result.rows.map((r) => r.column_name);
}

async function getForeignKeys(pg) {
    const result = await pg.query(`
    SELECT
      tc.table_schema,
      tc.table_name,
      kcu.column_name,
      ccu.table_schema AS referenced_schema,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column,
      tc.constraint_name
    FROM information_schema.table_constraints AS tc

    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name

    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.constraint_schema = tc.constraint_schema

    WHERE tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_schema, tc.table_name, kcu.column_name
  `);

    return result.rows;
}

async function getExistingCollection(pb, name) {
    try {
        return await pb.collections.getFirstListItem(
            `name="${name.replace(/"/g, '\\"')}"`
        );
    } catch {
        return null;
    }
}

async function deleteCollectionIfExists(pb, name) {
    const existing = await getExistingCollection(pb, name);

    if (!existing) {
        return;
    }

    console.log(`Collection already exists: ${name}`);
    console.log(`Keeping existing collection.`);
}

function makeSafeFieldName(columnName, foreignKey = false) {
    if (!foreignKey) {
        return columnName;
    }

    /*
     * Example:
     *
     * Supabase:
     * user_id
     *
     * PocketBase:
     * user
     *
     * This makes PocketBase relations easier to use.
     */

    if (columnName.endsWith("_id")) {
        const name = columnName.slice(0, -3);

        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            return name;
        }
    }

    return columnName;
}

async function main() {
    console.log("==============================================");
    console.log(" Supabase -> PocketBase Schema Creator");
    console.log("==============================================");
    console.log("");

    // --------------------------------------------------
    // Connect to Supabase PostgreSQL
    // --------------------------------------------------

    const pg = new Client({
        connectionString: SUPABASE_DB_URL,
        ssl: {
            rejectUnauthorized: false,
        },
    });

    console.log("Connecting to Supabase PostgreSQL...");

    await pg.connect();

    console.log("Supabase connected.");
    console.log("");

    // --------------------------------------------------
    // Connect to PocketBase
    // --------------------------------------------------

    const pb = new PocketBase(POCKETBASE_URL);

    console.log(`Connecting to PocketBase: ${POCKETBASE_URL}`);

    await pb
        .collection("_superusers")
        .authWithPassword(PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD);

    console.log("PocketBase superuser authenticated.");
    console.log("");

    // --------------------------------------------------
    // Read Supabase schema
    // --------------------------------------------------

    const schemaData = {};

    for (const target of TARGETS) {
        console.log(
            `Reading ${target.schema}.${target.table}...`
        );

        const columns = await getColumns(
            pg,
            target.schema,
            target.table
        );

        if (columns.length === 0) {
            throw new Error(
                `Table not found: ${target.schema}.${target.table}`
            );
        }

        const primaryKey = await getPrimaryKey(
            pg,
            target.schema,
            target.table
        );

        schemaData[`${target.schema}.${target.table}`] = {
            ...target,
            columns,
            primaryKey,
        };

        console.log(
            `  Found ${columns.length} columns`
        );
    }

    console.log("");

    // --------------------------------------------------
    // Read ALL foreign keys
    // --------------------------------------------------

    console.log("Reading foreign key relationships...");

    const foreignKeys = await getForeignKeys(pg);

    console.log(
        `Found ${foreignKeys.length} foreign key relationships.`
    );

    console.log("");

    // --------------------------------------------------
    // Build collection lookup
    // --------------------------------------------------

    const collectionMap = {};

    for (const target of TARGETS) {
        collectionMap[
            `${target.schema}.${target.table}`
        ] = target.pbName;
    }

    // --------------------------------------------------
    // STEP A
    // Create all collections WITHOUT relations
    // --------------------------------------------------

    console.log("==============================================");
    console.log("STEP A - Creating collections");
    console.log("==============================================");

    for (const target of TARGETS) {
        const key = `${target.schema}.${target.table}`;

        const tableData = schemaData[key];

        console.log("");
        console.log(
            `Creating ${target.type} collection: ${target.pbName}`
        );

        const existing = await getExistingCollection(
            pb,
            target.pbName
        );

        if (existing) {
            console.log(
                `  Already exists -> ${existing.id}`
            );

            collectionMap[key] = existing.id;

            continue;
        }

        const fields = [];

        /*
         * PocketBase auth collections already contain:
         *
         * id
         * email
         * emailVisibility
         * verified
         * password
         * tokenKey
         *
         * So don't recreate those system fields.
         */

        for (const column of tableData.columns) {
            const columnName = column.column_name;

            if (
                target.type === "auth" &&
                [
                    "id",
                    "email",
                    "email_confirmed_at",
                    "encrypted_password",
                    "aud",
                    "role",
                    "confirmation_token",
                    "recovery_token",
                    "email_change_token_new",
                    "email_change",
                    "email_change_token_current",
                    "reauthentication_token",
                    "is_super_admin",
                    "banned_until",
                    "deleted_at",
                    "invited_at",
                    "confirmed_at",
                    "phone",
                    "phone_confirmed_at",
                    "last_sign_in_at",
                    "raw_app_meta_data",
                    "raw_user_meta_data",
                    "created_at",
                    "updated_at",
                    "instance_id",
                    "confirmation_sent_at",
                    "recovery_sent_at",
                    "email_change_sent_at",
                    "phone_change",
                    "phone_change_token",
                    "phone_change_sent_at",
                    "email_change_confirm_status",
                    "is_sso_user",
                    "is_anonymous",
                ].includes(columnName)
            ) {
                continue;
            }

            /*
             * Don't recreate primary key "id" for base collections.
             * PocketBase provides its own id.
             */

            if (
                target.type === "base" &&
                columnName === "id"
            ) {
                continue;
            }

            const mapped = mapPostgresType(column);

            const field = {
                name: columnName,
                type: mapped.type,
            };

            /*
             * JSON is optional.
             * Other fields are created without required=true
             * because Supabase may contain NULL values.
             */

            if (mapped.type === "text") {
                field.max = 0;
            }

            fields.push(field);
        }

        const payload = {
            name: target.pbName,
            type: target.type,
            fields,
        };

        if (target.type === "auth") {
            payload.passwordAuth = {
                enabled: true,
                identityFields: ["email"],
            };
        }

        const created = await pb.collections.create(payload);

        collectionMap[key] = created.id;

        console.log(
            `  Created: ${created.name} (${created.id})`
        );
    }

    console.log("");

    // --------------------------------------------------
    // STEP B
    // Add relations
    // --------------------------------------------------

    console.log("==============================================");
    console.log("STEP B - Creating relations");
    console.log("==============================================");

    /*
     * Group FKs by source table.
     */

    const fkByTable = {};

    for (const fk of foreignKeys) {
        const sourceKey =
            `${fk.table_schema}.${fk.table_name}`;

        const targetKey =
            `${fk.referenced_schema}.${fk.referenced_table}`;

        /*
         * Only create relations for our 6 collections.
         */

        if (
            !collectionMap[sourceKey] ||
            !collectionMap[targetKey]
        ) {
            continue;
        }

        if (!fkByTable[sourceKey]) {
            fkByTable[sourceKey] = [];
        }

        fkByTable[sourceKey].push(fk);
    }

    for (const target of TARGETS) {
        const sourceKey =
            `${target.schema}.${target.table}`;

        const fks = fkByTable[sourceKey] || [];

        if (fks.length === 0) {
            console.log(
                `No relations for ${target.pbName}`
            );

            continue;
        }

        const collection = await pb.collections.getOne(
            collectionMap[sourceKey]
        );

        const existingFields = collection.fields || [];

        const newFields = [...existingFields];

        for (const fk of fks) {
            const targetKey =
                `${fk.referenced_schema}.${fk.referenced_table}`;

            const targetCollectionId =
                collectionMap[targetKey];

            const relationName =
                makeSafeFieldName(
                    fk.column_name,
                    true
                );

            /*
             * If the field already exists, remove it.
             * This is necessary because the original field was
             * initially created as text.
             */

            const filtered = newFields.filter(
                (field) =>
                    field.name !== fk.column_name &&
                    field.name !== relationName
            );

            newFields.length = 0;
            newFields.push(...filtered);

            newFields.push({
                name: relationName,
                type: "relation",
                collectionId: targetCollectionId,
                required: false,
                presentable: false,
                cascadeDelete: false,
                minSelect: 0,
                maxSelect: 1,
            });

            console.log(
                `  ${sourceKey}.${fk.column_name} -> ${targetKey}.${fk.referenced_column}`
            );
        }

        /*
         * Update the collection.
         */

        await pb.collections.update(
            collection.id,
            {
                fields: newFields,
            }
        );

        console.log(
            `Updated relations: ${target.pbName}`
        );
    }

    // --------------------------------------------------
    // Summary
    // --------------------------------------------------

    console.log("");
    console.log("==============================================");
    console.log("SCHEMA CREATION COMPLETE");
    console.log("==============================================");

    for (const target of TARGETS) {
        const key =
            `${target.schema}.${target.table}`;

        console.log(
            `${target.schema}.${target.table} -> ${target.pbName} -> ${collectionMap[key]}`
        );
    }

    console.log("");
    console.log("IMPORTANT:");
    console.log("No records were migrated.");
    console.log("No Supabase data was modified.");
    console.log("No Supabase files/images were migrated.");
    console.log("");
    console.log(
        "Next step will be migrating records after verifying this schema."
    );

    await pg.end();
}

main().catch(async (error) => {
    console.error("");
    console.error("==============================================");
    console.error("ERROR");
    console.error("==============================================");
    console.error(error);

    process.exit(1);
});