// Application state
let state = {
    posts: [],
    total: 0,
    page: 1,
    limit: 9,
    totalPages: 1,
    search: "",
    group: "All",
    date: "",
    source: "Connecting..."
};

// DOM Elements
const sourceBadge = document.getElementById("sourceBadge");
const sourceText = document.getElementById("sourceText");
const statTotalPosts = document.getElementById("statTotalPosts");
const statTotalLikes = document.getElementById("statTotalLikes");
const statTotalComments = document.getElementById("statTotalComments");
const statTotalShares = document.getElementById("statTotalShares");
const searchInput = document.getElementById("searchInput");
const groupFilter = document.getElementById("groupFilter");
const dateFilter = document.getElementById("dateFilter");
const resetFiltersBtn = document.getElementById("resetFiltersBtn");
const postsGrid = document.getElementById("postsGrid");
const currentPageEl = document.getElementById("currentPage");
const totalPagesEl = document.getElementById("totalPages");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const paginationNumbers = document.getElementById("paginationNumbers");
const imageModal = document.getElementById("imageModal");
const modalImage = document.getElementById("modalImage");
const closeModalBtn = document.getElementById("closeModalBtn");

// Initialize Lucide Icons
lucide.createIcons();

// Fetch posts and analytics from API
async function fetchPosts() {
    postsGrid.innerHTML = `
        <div class="loading-state">
            <i data-lucide="loader-2" class="spinner"></i>
            <p>Loading posts from database...</p>
        </div>
    `;
    lucide.createIcons();

    try {
        const queryParams = new URLSearchParams({
            page: state.page,
            limit: state.limit,
            search: state.search,
            group: state.group,
            date: state.date
        });

        const res = await fetch(`/api/posts?${queryParams.toString()}`);
        const data = await res.json();

        if (data.error) {
            throw new Error(data.error);
        }

        state.posts = data.posts;
        state.total = data.total;
        state.page = data.page;
        state.totalPages = data.totalPages || 1;
        state.source = data.source;

        updateUI(data.analytics);
    } catch (err) {
        console.error("Error fetching posts:", err);
        postsGrid.innerHTML = `
            <div class="empty-state">
                <i data-lucide="alert-circle" style="width: 48px; height: 48px; color: #ef4444; margin-bottom: 16px;"></i>
                <h3>Error loading posts</h3>
                <p>${err.message}</p>
            </div>
        `;
        lucide.createIcons();
    }
}

// Update UI elements
function updateUI(analytics) {
    // Update source badge
    sourceText.innerText = state.source;
    if (state.source.includes("SQLite")) {
        sourceBadge.classList.add("sqlite");
    } else {
        sourceBadge.classList.remove("sqlite");
    }

    // Update analytics stats
    if (analytics) {
        statTotalPosts.innerText = analytics.totalPosts.toLocaleString();
        statTotalLikes.innerText = analytics.totalLikes.toLocaleString();
        statTotalComments.innerText = analytics.totalComments.toLocaleString();
        statTotalShares.innerText = analytics.totalShares.toLocaleString();
    }

    // Update pagination text
    currentPageEl.innerText = state.page;
    totalPagesEl.innerText = state.totalPages;

    // Update pagination buttons
    prevPageBtn.disabled = state.page <= 1;
    nextPageBtn.disabled = state.page >= state.totalPages;

    // Render pagination numbers
    renderPaginationNumbers();

    // Render posts
    renderPosts();
}

function renderPaginationNumbers() {
    paginationNumbers.innerHTML = "";
    for (let i = 1; i <= state.totalPages; i++) {
        const btn = document.createElement("div");
        btn.className = `page-num ${i === state.page ? 'active' : ''}`;
        btn.innerText = i;
        btn.addEventListener("click", () => {
            if (state.page !== i) {
                state.page = i;
                fetchPosts();
            }
        });
        paginationNumbers.appendChild(btn);
    }
}

function renderPosts() {
    if (state.posts.length === 0) {
        postsGrid.innerHTML = `
            <div class="empty-state">
                <i data-lucide="inbox" style="width: 48px; height: 48px; margin-bottom: 16px;"></i>
                <h3>No posts found</h3>
                <p>Try adjusting your search or filter criteria.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    postsGrid.innerHTML = "";

    state.posts.forEach(post => {
        const card = document.createElement("div");
        card.className = "post-card glass-card";

        // Generate media images HTML
        let mediaHtml = "";
        if (post.images && post.images.length > 0) {
            mediaHtml = `<div class="post-media">`;
            post.images.forEach(img => {
                // Ensure correct image path
                const imgSrc = img.startsWith("images/") ? `/${img}` : `/images/${img.replace("images/", "")}`;
                mediaHtml += `<img src="${imgSrc}" class="media-img" alt="Post image" data-full="${imgSrc}">`;
            });
            mediaHtml += `</div>`;
        } else if (post.screenshot) {
            const screenSrc = post.screenshot.startsWith("images/") ? `/${post.screenshot}` : `/images/${post.screenshot.replace("images/", "")}`;
            mediaHtml = `
                <div class="post-media">
                    <img src="${screenSrc}" class="media-img" alt="Post screenshot" data-full="${screenSrc}">
                </div>
            `;
        }

        const dateFormatted = post.post_date || post.date || "Recent";

        card.innerHTML = `
            <div>
                <div class="post-header">
                    <div class="post-author-info">
                        <span class="post-author">${escapeHtml(post.author || "Unknown Author")}</span>
                        <span class="post-group">${escapeHtml(post.group_name || "Facebook Group")}</span>
                    </div>
                    <span class="post-date">${escapeHtml(dateFormatted)}</span>
                </div>
                <div class="post-body">${escapeHtml(post.body || "")}</div>
                ${mediaHtml}
            </div>
            <div class="post-footer">
                <div class="post-stats">
                    <div class="stat-item">
                        <i data-lucide="thumbs-up"></i>
                        <span>${post.likes || 0}</span>
                    </div>
                    <div class="stat-item">
                        <i data-lucide="message-square"></i>
                        <span>${post.comments || 0}</span>
                    </div>
                    <div class="stat-item">
                        <i data-lucide="share-2"></i>
                        <span>${post.shares || 0}</span>
                    </div>
                </div>
                <a href="${post.permalink}" target="_blank" rel="noopener noreferrer" class="external-link">
                    <span>View on FB</span>
                    <i data-lucide="external-link"></i>
                </a>
            </div>
        `;

        postsGrid.appendChild(card);
    });

    lucide.createIcons();

    // Attach modal click events
    document.querySelectorAll(".media-img").forEach(img => {
        img.addEventListener("click", (e) => {
            modalImage.src = e.target.getAttribute("data-full");
            imageModal.classList.add("active");
        });
    });
}

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}

// Event Listeners
let searchTimeout;
searchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        state.search = e.target.value;
        state.page = 1;
        fetchPosts();
    }, 400);
});

groupFilter.addEventListener("change", (e) => {
    state.group = e.target.value;
    state.page = 1;
    fetchPosts();
});

dateFilter.addEventListener("change", (e) => {
    state.date = e.target.value;
    state.page = 1;
    fetchPosts();
});

resetFiltersBtn.addEventListener("click", () => {
    searchInput.value = "";
    groupFilter.value = "All";
    dateFilter.value = "";
    state.search = "";
    state.group = "All";
    state.date = "";
    state.page = 1;
    fetchPosts();
});

prevPageBtn.addEventListener("click", () => {
    if (state.page > 1) {
        state.page--;
        fetchPosts();
    }
});

nextPageBtn.addEventListener("click", () => {
    if (state.page < state.totalPages) {
        state.page++;
        fetchPosts();
    }
});

closeModalBtn.addEventListener("click", () => {
    imageModal.classList.remove("active");
});

imageModal.addEventListener("click", (e) => {
    if (e.target === imageModal || e.target.classList.contains("modal-backdrop")) {
        imageModal.classList.remove("active");
    }
});

// Initial fetch
fetchPosts();
