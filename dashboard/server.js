require("dotenv").config();
const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { supabase } = require("../supabase");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public directory and images directory
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "../images")));

// API endpoint to fetch posts (from Supabase directly, fallback to SQLite if Supabase not configured)
app.get("/api/posts", async (req, res) => {
    const { search, group, date, page = 1, limit = 9 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    if (supabase) {
        try {
            let query = supabase.from("posts").select("*", { count: "exact" });

            if (group && group !== "All") {
                query = query.eq("group_name", group);
            }
            if (search) {
                query = query.ilike("body", `%${search}%`);
            }
            if (date) {
                query = query.ilike("scraped_at", `%${date}%`);
            }

            // Latest posts ordering
            query = query.order("scraped_at", { ascending: false });
            query = query.range(offset, offset + parseInt(limit) - 1);

            const { data, count, error } = await query;

            if (error) {
                throw error;
            }

            // Also get analytics data
            const { data: allData } = await supabase.from("posts").select("group_name, likes, comments, shares");
            let totalLikes = 0;
            let totalComments = 0;
            let totalShares = 0;
            let groupCounts = {};

            if (allData) {
                allData.forEach(p => {
                    totalLikes += p.likes || 0;
                    totalComments += p.comments || 0;
                    totalShares += p.shares || 0;
                    groupCounts[p.group_name] = (groupCounts[p.group_name] || 0) + 1;
                });
            }

            return res.json({
                source: "Supabase",
                posts: data,
                total: count || 0,
                page: parseInt(page),
                totalPages: Math.ceil((count || 0) / parseInt(limit)),
                analytics: {
                    totalPosts: allData ? allData.length : count,
                    totalLikes,
                    totalComments,
                    totalShares,
                    groupCounts
                }
            });
        } catch (err) {
            console.error("Supabase query error, falling back to SQLite:", err.message);
            // Fallback to SQLite below
        }
    }

    // Fallback to SQLite database if Supabase is not configured or errors out
    const dbPath = path.join(__dirname, "../posts.db");
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            return res.status(500).json({ error: "Failed to connect to SQLite database." });
        }
    });

    let sql = "SELECT * FROM posts WHERE 1=1";
    let countSql = "SELECT COUNT(*) as count FROM posts WHERE 1=1";
    let params = [];
    let countParams = [];

    if (group && group !== "All") {
        sql += " AND group_name = ?";
        countSql += " AND group_name = ?";
        params.push(group);
        countParams.push(group);
    }
    if (search) {
        sql += " AND body LIKE ?";
        countSql += " AND body LIKE ?";
        params.push(`%${search}%`);
        countParams.push(`%${search}%`);
    }
    if (date) {
        sql += " AND scraped_at LIKE ?";
        countSql += " AND scraped_at LIKE ?";
        params.push(`%${date}%`);
        countParams.push(`%${date}%`);
    }

    sql += " ORDER BY scraped_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), offset);

    db.get(countSql, countParams, (err, countRow) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: err.message });
        }
        const total = countRow ? countRow.count : 0;

        db.all(sql, params, (err, rows) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: err.message });
            }

            // Parse images JSON string from SQLite
            const cleanedRows = rows.map(row => ({
                ...row,
                images: row.images ? JSON.parse(row.images) : []
            }));

            // Get analytics from SQLite
            db.all("SELECT group_name, likes, comments, shares FROM posts", [], (err, allRows) => {
                db.close();
                let totalLikes = 0;
                let totalComments = 0;
                let totalShares = 0;
                let groupCounts = {};

                if (allRows) {
                    allRows.forEach(p => {
                        totalLikes += parseInt(p.likes) || 0;
                        totalComments += parseInt(p.comments) || 0;
                        totalShares += parseInt(p.shares) || 0;
                        groupCounts[p.group_name] = (groupCounts[p.group_name] || 0) + 1;
                    });
                }

                return res.json({
                    source: "SQLite (Local Cache)",
                    posts: cleanedRows,
                    total: total,
                    page: parseInt(page),
                    totalPages: Math.ceil(total / parseInt(limit)),
                    analytics: {
                        totalPosts: allRows ? allRows.length : total,
                        totalLikes,
                        totalComments,
                        totalShares,
                        groupCounts
                    }
                });
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Dashboard Server running on http://localhost:${PORT}`);
    console.log(`📊 Querying Supabase directly (with fallback to local SQLite cache).`);
});
