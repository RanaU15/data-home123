const PocketBase = require("pocketbase/cjs");
const { createClient } = require("@supabase/supabase-js");

try {
    process.loadEnvFile(".env");
} catch { }

const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    "https://gimjsxpwteluwiopcrqq.supabase.co";

const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

const PB_URL =
    process.env.PB_URL ||
    "https://pbflat.formics.io";

const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;

if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
}

if (!PB_EMAIL || !PB_PASSWORD) {
    throw new Error("Missing PB_EMAIL or PB_PASSWORD");
}

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
);

const pb = new PocketBase(PB_URL);

// Important when using multiple requests
pb.autoCancellation(false);

const EXPECTED = {
    users: 4,
    profiles: 4,
    posts: 4148,
    notifications: 39,
    alerts: 4,
    group_sync_6mo: 0,
};

let errors = 0;

function ok(message) {
    console.log(`✓ ${message}`);
}

function warn(message) {
    console.log(`⚠ ${message}`);
}

function fail(message) {
    console.log(`✗ ${message}`);
    errors++;
}

async function pbCount(collection, filter = "") {
    const result = await pb.collection(collection).getList(1, 1, {
        filter,
        fields: "id",
    });

    return result.totalItems;
}

async function supabaseCount(table) {
    const { count, error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });

    if (error) {
        throw new Error(`${table}: ${error.message}`);
    }

    return count || 0;
}

async function getAllPB(collection, fields) {
    const records = [];

    let page = 1;
    const perPage = 500;

    while (true) {
        const result = await pb.collection(collection).getList(
            page,
            perPage,
            {
                fields,
            }
        );

        records.push(...result.items);

        if (page >= result.totalPages) {
            break;
        }

        page++;
    }

    return records;
}

async function verifyCollection(name, expected) {
    const actual = await pbCount(name);

    if (actual === expected) {
        ok(`${name}: ${actual} records`);
    } else {
        fail(`${name}: expected ${expected}, found ${actual}`);
    }
}

async function verifySupabaseCounts() {
    console.log("\n========================================");
    console.log("SUPABASE SOURCE COUNTS");
    console.log("========================================");

    for (const [table, expected] of Object.entries(EXPECTED)) {
        try {
            const actual = await supabaseCount(table);

            if (actual === expected) {
                ok(`${table}: ${actual}`);
            } else {
                fail(`${table}: expected ${expected}, found ${actual}`);
            }
        } catch (err) {
            fail(err.message);
        }
    }
}

async function verifyPocketBaseCounts() {
    console.log("\n========================================");
    console.log("POCKETBASE COUNTS");
    console.log("========================================");

    for (const [collection, expected] of Object.entries(EXPECTED)) {
        try {
            await verifyCollection(collection, expected);
        } catch (err) {
            fail(`${collection}: ${err.message}`);
        }
    }
}

async function verifySupabaseIds() {
    console.log("\n========================================");
    console.log("SUPABASE ID CHECKS");
    console.log("========================================");

    const collections = [
        "users",
        "profiles",
        "alerts",
        "notifications",
        "posts",
    ];

    for (const collection of collections) {
        try {
            const total = await pbCount(collection);
            const withSupabaseId = await pbCount(
                collection,
                'supabase_id != ""'
            );

            if (total === withSupabaseId) {
                ok(`${collection}: all ${total} records have supabase_id`);
            } else {
                fail(
                    `${collection}: ${total - withSupabaseId} records missing supabase_id`
                );
            }
        } catch (err) {
            fail(`${collection}: ${err.message}`);
        }
    }
}

async function verifyProfiles() {
    console.log("\n========================================");
    console.log("PROFILE → USER RELATIONS");
    console.log("========================================");

    const profiles = await getAllPB(
        "profiles",
        "id,supabase_id,user"
    );

    let valid = 0;
    let missing = 0;

    for (const profile of profiles) {
        if (!profile.user) {
            fail(`Profile ${profile.id} has no user relation`);
            missing++;
            continue;
        }

        try {
            await pb.collection("users").getOne(profile.user, {
                fields: "id",
            });

            valid++;
        } catch {
            fail(
                `Profile ${profile.id} points to missing user ${profile.user}`
            );
            missing++;
        }
    }

    if (missing === 0) {
        ok(`All ${valid} profiles have valid user relations`);
    }
}

async function verifyAlerts() {
    console.log("\n========================================");
    console.log("ALERT → PROFILE RELATIONS");
    console.log("========================================");

    const alerts = await getAllPB(
        "alerts",
        "id,supabase_id,user,user_id"
    );

    let valid = 0;

    for (const alert of alerts) {
        if (!alert.user) {
            fail(`Alert ${alert.id} has no user relation`);
            continue;
        }

        try {
            await pb.collection("profiles").getOne(alert.user, {
                fields: "id",
            });

            valid++;
        } catch {
            fail(
                `Alert ${alert.id} points to missing profile ${alert.user}`
            );
        }
    }

    if (valid === alerts.length) {
        ok(`All ${valid} alerts have valid profile relations`);
    }
}

async function verifyNotifications() {
    console.log("\n========================================");
    console.log("NOTIFICATION RELATIONS");
    console.log("========================================");

    const notifications = await getAllPB(
        "notifications",
        "id,supabase_id,user,alert,post"
    );

    let userOK = 0;
    let alertOK = 0;
    let postOK = 0;

    for (const notification of notifications) {
        if (notification.user) {
            try {
                await pb.collection("profiles").getOne(
                    notification.user,
                    { fields: "id" }
                );
                userOK++;
            } catch {
                fail(
                    `Notification ${notification.id}: invalid user relation`
                );
            }
        }

        if (notification.alert) {
            try {
                await pb.collection("alerts").getOne(
                    notification.alert,
                    { fields: "id" }
                );
                alertOK++;
            } catch {
                fail(
                    `Notification ${notification.id}: invalid alert relation`
                );
            }
        }

        if (notification.post) {
            try {
                await pb.collection("posts").getOne(
                    notification.post,
                    { fields: "id" }
                );
                postOK++;
            } catch {
                fail(
                    `Notification ${notification.id}: invalid post relation`
                );
            }
        }
    }

    ok(`Notifications checked: ${notifications.length}`);
    ok(`Valid user relations: ${userOK}`);
    ok(`Valid alert relations: ${alertOK}`);
    ok(`Valid post relations: ${postOK}`);
}

async function verifyMedia() {
    console.log("\n========================================");
    console.log("MEDIA VERIFICATION");
    console.log("========================================");

    const posts = await getAllPB(
        "posts",
        "id,supabase_id,migrated_images,migrated_videos,migrated_video_thumbnails"
    );

    let postsWithImages = 0;
    let postsWithVideos = 0;
    let postsWithThumbnails = 0;

    let imageFiles = 0;
    let videoFiles = 0;
    let thumbnailFiles = 0;

    let brokenFiles = 0;

    let sampleImage = null;
    let sampleVideo = null;
    let sampleThumbnail = null;

    for (const post of posts) {
        const images = post.migrated_images || [];
        const videos = post.migrated_videos || [];
        const thumbnails = post.migrated_video_thumbnails || [];

        if (images.length > 0) {
            postsWithImages++;
            imageFiles += images.length;

            if (!sampleImage) {
                sampleImage = {
                    postId: post.id,
                    file: images[0],
                };
            }
        }

        if (videos.length > 0) {
            postsWithVideos++;
            videoFiles += videos.length;

            if (!sampleVideo) {
                sampleVideo = {
                    postId: post.id,
                    file: videos[0],
                };
            }
        }

        if (thumbnails.length > 0) {
            postsWithThumbnails++;
            thumbnailFiles += thumbnails.length;

            if (!sampleThumbnail) {
                sampleThumbnail = {
                    postId: post.id,
                    file: thumbnails[0],
                };
            }
        }
    }

    console.log(`Posts with images: ${postsWithImages}`);
    console.log(`Image files: ${imageFiles}`);

    console.log(`Posts with videos: ${postsWithVideos}`);
    console.log(`Video files: ${videoFiles}`);

    console.log(`Posts with thumbnails: ${postsWithThumbnails}`);
    console.log(`Thumbnail files: ${thumbnailFiles}`);

    const totalMedia =
        imageFiles +
        videoFiles +
        thumbnailFiles;

    console.log(`Total attached media: ${totalMedia}`);

    if (sampleImage) {
        const url =
            `${PB_URL}/api/files/posts/` +
            `${sampleImage.postId}/` +
            `${encodeURIComponent(sampleImage.file)}`;

        console.log("\nSample image:");
        console.log(url);

        try {
            const response = await fetch(url);

            if (response.ok) {
                ok(`Sample image accessible: HTTP ${response.status}`);
            } else {
                fail(
                    `Sample image failed: HTTP ${response.status}`
                );
                brokenFiles++;
            }
        } catch (err) {
            fail(`Sample image request failed: ${err.message}`);
            brokenFiles++;
        }
    }

    if (sampleVideo) {
        const url =
            `${PB_URL}/api/files/posts/` +
            `${sampleVideo.postId}/` +
            `${encodeURIComponent(sampleVideo.file)}`;

        console.log("\nSample video:");
        console.log(url);

        try {
            const response = await fetch(url);

            if (response.ok) {
                ok(`Sample video accessible: HTTP ${response.status}`);
            } else {
                fail(
                    `Sample video failed: HTTP ${response.status}`
                );
                brokenFiles++;
            }
        } catch (err) {
            fail(`Sample video request failed: ${err.message}`);
            brokenFiles++;
        }
    }

    if (sampleThumbnail) {
        const url =
            `${PB_URL}/api/files/posts/` +
            `${sampleThumbnail.postId}/` +
            `${encodeURIComponent(sampleThumbnail.file)}`;

        console.log("\nSample thumbnail:");
        console.log(url);

        try {
            const response = await fetch(url);

            if (response.ok) {
                ok(
                    `Sample thumbnail accessible: HTTP ${response.status}`
                );
            } else {
                fail(
                    `Sample thumbnail failed: HTTP ${response.status}`
                );
                brokenFiles++;
            }
        } catch (err) {
            fail(
                `Sample thumbnail request failed: ${err.message}`
            );
            brokenFiles++;
        }
    }

    if (brokenFiles === 0) {
        ok("Sample media URLs are accessible");
    }
}

async function main() {
    console.log("========================================");
    console.log("POCKETBASE FINAL MIGRATION VERIFICATION");
    console.log("========================================");

    console.log(`PocketBase: ${PB_URL}`);
    console.log(`Supabase: ${SUPABASE_URL}`);

    console.log("\nAuthenticating PocketBase...");

    await pb.collection("_superusers").authWithPassword(
        PB_EMAIL,
        PB_PASSWORD
    );

    ok("PocketBase authentication successful");

    await verifySupabaseCounts();
    await verifyPocketBaseCounts();
    await verifySupabaseIds();
    await verifyProfiles();
    await verifyAlerts();
    await verifyNotifications();
    await verifyMedia();

    console.log("\n========================================");
    console.log("FINAL RESULT");
    console.log("========================================");

    if (errors === 0) {
        console.log("🎉 VERIFICATION PASSED");
        console.log("All checked data and sample media are valid.");
    } else {
        console.log(`⚠ VERIFICATION FINISHED WITH ${errors} ISSUE(S)`);
        console.log("Review the errors above before switching the app.");
    }

    console.log("========================================");
}

main().catch((err) => {
    console.error("\nVERIFICATION FAILED");
    console.error(err);
    process.exit(1);
});



