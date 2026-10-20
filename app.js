const searchInput = document.querySelector("#search-input");
const productGrid = document.querySelector("#product-grid");
const noResults = document.querySelector("#no-results");
const accountNote = document.querySelector("#account-note");
const filters = {
  retailer: document.querySelector("#retailer-filter"),
  rating: document.querySelector("#rating-filter"),
  reviews: document.querySelector("#reviews-filter"),
  purchases: document.querySelector("#purchases-filter"),
  sort: document.querySelector("#sort-select")
};

let searchQuery = "";
let accountMode = "login";
let currentUser = null;
let staticDemoMode = location.protocol === "file:" || location.hostname.toLowerCase().endsWith(".github.io");
let searchSequence = 0;
let toastTimeout;
let searchOffers = [];
let loadedRetailers = [];
let searchMessage = "";

const retailerNames = ["Best Buy", "Amazon", "Target", "Walmart"];
const demoCatalog = [
  { name: "Wireless over-ear headphones", category: "Audio", keywords: ["wireless", "headphones", "audio", "bluetooth"], price: 79.99, rating: 4.4, reviews: 3260, purchases: 1400 },
  { name: "Insulated stainless-steel water bottle", category: "Home & kitchen", keywords: ["water", "bottle", "insulated", "kitchen"], price: 24.99, rating: 4.6, reviews: 2180, purchases: 1100 },
  { name: "Programmable drip coffee maker", category: "Home & kitchen", keywords: ["coffee", "maker", "kitchen", "appliance"], price: 54.99, rating: 4.2, reviews: 1540, purchases: 900 },
  { name: "Everyday cotton T-shirt", category: "Clothing", keywords: ["clothes", "clothing", "shirt", "apparel", "cotton"], price: 18.99, rating: 4.1, reviews: 890, purchases: 600 },
  { name: "Cordless power drill", category: "Tools", keywords: ["machinery", "drill", "tool", "power"], price: 99.99, rating: 4.5, reviews: 2760, purchases: 1300 },
  { name: "Over-the-counter pain relief tablets", category: "Health & wellness", keywords: ["medicine", "health", "pain", "relief", "tablets"], price: 11.99, rating: 4.3, reviews: 740, purchases: 500 },
  { name: "Lightweight everyday laptop", category: "Computers", keywords: ["laptop", "computer", "electronics"], price: 649.99, rating: 4.4, reviews: 1320, purchases: 700 }
];
const countFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function formatCount(value) {
  return value === null || value === undefined ? "Not reported" : countFormat.format(value);
}

function retailerUrl(retailer, query) {
  const term = encodeURIComponent(query);
  const urls = {
    "Best Buy": `https://www.bestbuy.com/site/searchpage.jsp?st=${term}`,
    Amazon: `https://www.amazon.com/s?k=${term}`,
    Target: `https://www.target.com/s?searchTerm=${term}`,
    Walmart: `https://www.walmart.com/search?q=${term}`
  };
  return urls[retailer] ?? "";
}

function demoOffersForQuery(query) {
  const terms = query.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
  let products = demoCatalog.filter((product) => terms.some((term) => (
    product.keywords.some((keyword) => keyword.includes(term) || term.includes(keyword))
  )));
  if (!products.length) {
    products = [{
      name: `Sample ${query}`,
      category: "Demonstration product",
      price: 39.99,
      rating: 4.2,
      reviews: 320,
      purchases: 180
    }];
  }

  return products.flatMap((product) => retailerNames.map((retailer, index) => {
    const price = Math.max(4.99, product.price * (1 + (index - 1.5) * 0.07));
    return {
      name: product.name,
      category: product.category,
      retailer,
      price: Math.round(price * 100) / 100,
      rating: Math.max(3.5, Math.min(5, product.rating + (1 - index) * 0.1)),
      reviewCount: Math.max(25, product.reviews + (index - 1) * 140),
      purchaseCount: Math.max(20, product.purchases + (1 - index) * 100),
      url: retailerUrl(retailer, query)
    };
  }));
}

function safeRetailerUrl(retailer, value) {
  try {
    const url = new URL(value);
    const hosts = {
      Amazon: "www.amazon.com",
      "Best Buy": "www.bestbuy.com",
      Target: "www.target.com",
      Walmart: "www.walmart.com"
    };
    return url.protocol === "https:" && url.hostname === hosts[retailer] ? url.href : retailerUrl(retailer, searchQuery);
  } catch {
    return retailerUrl(retailer, searchQuery);
  }
}

function setStatus(message, state = "ready") {
  const status = document.querySelector("#connection-status");
  status.textContent = {
    loading: "SEARCHING",
    error: "SEARCH ISSUE",
    external: "RETAILER SITE",
    demo: "SAMPLE DEMO",
    ready: "LIVE SEARCH"
  }[state];
  status.dataset.state = state;
  document.querySelector("#source-note").textContent = message;
}

function displayEmpty(title, message, link) {
  noResults.hidden = false;
  productGrid.hidden = true;
  document.querySelector("#empty-title").textContent = title;
  document.querySelector("#empty-message").textContent = message;
  const existingLink = noResults.querySelector(".empty-retailer-link");
  existingLink?.remove();
  if (link) {
    const anchor = document.createElement("a");
    anchor.className = "button button-dark empty-retailer-link";
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = `Open ${filters.retailer.value === "all" ? "Best Buy" : filters.retailer.value} results`;
    noResults.append(anchor);
  }
}

function renderRetailerSearchLinks() {
  const wrapper = document.querySelector("#retailer-search-links");
  const buttons = document.querySelector("#retailer-search-buttons");
  const query = searchQuery.trim();
  if (!query) {
    wrapper.hidden = true;
    buttons.innerHTML = "";
    return;
  }
  const selected = filters.retailer.value === "all" ? retailerNames : [filters.retailer.value];
  buttons.innerHTML = selected.map((retailer) => {
    const url = retailerUrl(retailer, query);
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(retailer)} <span aria-hidden="true">↗</span></a>`;
  }).join("");
  wrapper.hidden = false;
}

function renderResults(offers, message = "") {
  const minimumRating = Number(filters.rating.value);
  const minimumReviews = Number(filters.reviews.value);
  const minimumPurchases = Number(filters.purchases.value);
  const matches = offers.filter((offer) => {
    if (filters.retailer.value !== "all" && offer.retailer !== filters.retailer.value) return false;
    if (minimumRating && (offer.rating === null || offer.rating < minimumRating)) return false;
    if (minimumReviews && (offer.reviewCount === null || offer.reviewCount < minimumReviews)) return false;
    if (minimumPurchases && (offer.purchaseCount === null || offer.purchaseCount < minimumPurchases)) return false;
    return true;
  });

  const sortValue = filters.sort.value;
  matches.sort((a, b) => {
    if (sortValue === "price") return (a.price ?? Infinity) - (b.price ?? Infinity);
    if (sortValue === "rating") return (b.rating ?? -1) - (a.rating ?? -1);
    if (sortValue === "reviews") return (b.reviewCount ?? -1) - (a.reviewCount ?? -1);
    if (sortValue === "popular") return (b.purchaseCount ?? -1) - (a.purchaseCount ?? -1);
    return (b.rating ?? -1) - (a.rating ?? -1) || (b.reviewCount ?? -1) - (a.reviewCount ?? -1);
  });

  productGrid.innerHTML = matches.map((offer) => {
    const imageUrl = typeof offer.image === "string" && offer.image.startsWith("https://") ? offer.image : "";
    const retailerLink = safeRetailerUrl(offer.retailer, offer.url);
    const priceText = offer.price === null ? "Check retailer" : new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD"
    }).format(offer.price);
    const ratingText = offer.rating === null ? "Not reported" : `<span class="rating-star">★</span> ${offer.rating.toFixed(1)} <small>/ 5</small>`;
    return `
      <article class="comparison-card">
        <div class="comparison-product">
          <div class="comparison-image">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : `<span class="product-placeholder" aria-hidden="true">✳</span>`}</div>
          <div class="comparison-product-copy">
            <span class="product-category">${escapeHtml(offer.category)}</span>
            <h3>${escapeHtml(offer.name)}</h3>
            <span class="offer-badge">${staticDemoMode ? "SAMPLE DEMO DATA" : "LIVE RETAILER LISTING"}</span>
          </div>
        </div>
        <div class="offer-details">
          <div class="retailer-name"><span class="retailer-mark">${escapeHtml(offer.retailer.slice(0, 1))}</span><strong>${escapeHtml(offer.retailer)}</strong></div>
          <div class="offer-metric offer-price"><span>${staticDemoMode ? "Sample price" : "Listed price"}</span><strong>${priceText}</strong></div>
          <div class="offer-metric"><span>Rating</span><strong>${ratingText}</strong></div>
          <div class="offer-metric"><span>Reviews</span><strong>${formatCount(offer.reviewCount)}</strong></div>
          <div class="offer-metric"><span>Purchases</span><strong>${escapeHtml(offer.purchaseLabel ?? formatCount(offer.purchaseCount))}</strong></div>
          <a class="retailer-link" href="${escapeHtml(retailerLink)}" target="_blank" rel="noopener noreferrer">${staticDemoMode ? "Search at" : "View listing at"} ${escapeHtml(offer.retailer)} <span aria-hidden="true">↗</span></a>
        </div>
      </article>`;
  }).join("");

  productGrid.hidden = matches.length === 0;
  noResults.hidden = matches.length !== 0;
  document.querySelector("#result-count").textContent = `${matches.length} ${matches.length === 1 ? "listing" : "listings"}`;
  document.querySelector("#result-label").textContent = searchQuery ? `Results for “${searchQuery}”` : "Search a product to compare listings";
  if (!matches.length) {
    const externalRetailer = !staticDemoMode && (filters.retailer.value === "Target" || filters.retailer.value === "Walmart");
    const selectedOffers = filters.retailer.value === "all"
      ? offers
      : offers.filter((offer) => offer.retailer === filters.retailer.value);
    const unavailableFilters = [];
    if (minimumRating && selectedOffers.length && selectedOffers.every((offer) => offer.rating === null)) unavailableFilters.push("ratings");
    if (minimumReviews && selectedOffers.length && selectedOffers.every((offer) => offer.reviewCount === null)) unavailableFilters.push("review counts");
    if (minimumPurchases && selectedOffers.length && selectedOffers.every((offer) => offer.purchaseCount === null)) unavailableFilters.push("recent purchase counts");
    const unavailableMessage = unavailableFilters.length
      ? `This retailer did not publish ${unavailableFilters.join(" or ")} in these listings. Clear the corresponding filter to see the available results.`
      : null;
    displayEmpty(
      externalRetailer ? `${filters.retailer.value} results open on their website.` : "No listings matched those filters.",
      unavailableMessage || (externalRetailer
        ? "This retailer does not permit automated result extraction from this prototype. Open its official live search page instead."
        : message || "Try a different search or remove a filter. Missing retailer data is not estimated."),
      searchQuery ? retailerUrl(filters.retailer.value === "all" ? "Best Buy" : filters.retailer.value, searchQuery) : null
    );
  }
  renderRetailerSearchLinks();
}

function renderExternalRetailerSearch(retailer) {
  searchSequence++;
  const message = `${retailer} results are opened on the retailer's website; this prototype does not extract that store's listings.`;
  setStatus(message, "external");
  document.querySelector("#result-count").textContent = "Open live retailer search";
  document.querySelector("#result-label").textContent = `Search ${retailer} for “${searchQuery}”`;
  displayEmpty(`${retailer} search is ready.`, message, retailerUrl(retailer, searchQuery));
  renderRetailerSearchLinks();
}

function activateDemoMode() {
  staticDemoMode = true;
  currentUser = null;
  updateAccountButton();
  accountNote.textContent = "Accounts need the Goodfind server. Search and compare are available here as a guest.";
  document.querySelector(".data-disclaimer").textContent = "Demonstration sample data only — prices, ratings, reviews, and purchase counts are fictional and are not current retailer offers. Retailer links open each store's search page. Search and comparison are available without an account.";
  setStatus("GitHub Pages uses fictional demonstration data. Search and compare as a guest.", "demo");
}

function renderDemoResults(sequence, query) {
  if (sequence !== searchSequence) return;
  searchOffers = demoOffersForQuery(query);
  loadedRetailers = retailerNames;
  searchMessage = "Demonstration sample data only. These listings and figures are fictional and are not current retailer offers. Retailer links open each store's search page.";
  setStatus(searchMessage, "demo");
  renderResults(searchOffers, searchMessage);
}

async function loadResults() {
  searchSequence++;
  const previousQuery = searchQuery;
  searchQuery = searchInput.value.trim();
  if (!searchQuery) {
    searchOffers = [];
    loadedRetailers = [];
    searchMessage = "";
    productGrid.innerHTML = "";
    productGrid.hidden = true;
    document.querySelector("#result-count").textContent = "Waiting for search";
    document.querySelector("#result-label").textContent = "Search a product to compare listings";
    displayEmpty("Start with a product search.", "Enter a product to search retailer listings. You can compare as a guest or sign in for an account. Nothing is pre-filled with sample offers.");
    renderRetailerSearchLinks();
    return;
  }
  if (searchQuery !== previousQuery) {
    searchOffers = [];
    loadedRetailers = [];
    searchMessage = "";
  }
  const sequence = searchSequence;
  const retailer = filters.retailer.value;
  if (staticDemoMode) {
    renderDemoResults(sequence, searchQuery);
    return;
  }
  if (retailer === "Target" || retailer === "Walmart") {
    renderExternalRetailerSearch(retailer);
    return;
  }
  setStatus("Fetching current search results. Retailer response time may vary.", "loading");
  productGrid.hidden = true;
  noResults.hidden = true;
  document.querySelector("#result-count").textContent = "Searching…";
  document.querySelector("#result-label").textContent = `Results for “${searchQuery}”`;
  renderRetailerSearchLinks();

  try {
    const params = new URLSearchParams({ q: searchQuery, retailer });
    const response = await fetch(`/api/search?${params}`);
    if (response.status === 404) {
      activateDemoMode();
      renderDemoResults(sequence, searchQuery);
      return;
    }
    const result = await response.json();
    if (sequence !== searchSequence) return;
    if (!response.ok) throw new Error(result.error || "Search could not be completed.");

    searchOffers = result.offers;
    loadedRetailers = result.providers ?? [];
    searchMessage = result.message;
    setStatus(result.message, "ready");
    renderResults(searchOffers, searchMessage);
    if (!result.offers.length && result.retailerUrl) {
      const link = noResults.querySelector(".empty-retailer-link");
      if (link) link.href = result.retailerUrl;
    }
  } catch (error) {
    if (sequence !== searchSequence) return;
    if (error instanceof TypeError) {
      activateDemoMode();
      renderDemoResults(sequence, searchQuery);
      return;
    }
    setStatus(error.message, "error");
    document.querySelector("#result-count").textContent = "Search unavailable";
    displayEmpty("Live search could not be completed.", error.message, retailerUrl(retailer === "all" ? "Best Buy" : retailer, searchQuery));
    renderRetailerSearchLinks();
  }
}

function setAccountMode(mode) {
  accountMode = mode;
  const registering = mode === "register";
  document.querySelector("#login-tab").classList.toggle("selected", !registering);
  document.querySelector("#register-tab").classList.toggle("selected", registering);
  document.querySelector("#login-tab").setAttribute("aria-selected", String(!registering));
  document.querySelector("#register-tab").setAttribute("aria-selected", String(registering));
  document.querySelector("#name-field").hidden = !registering;
  document.querySelector("#name-field input").required = registering;
  document.querySelector("#account-title").textContent = registering ? "Create your account." : "Welcome back.";
  document.querySelector("#account-submit").innerHTML = `${registering ? "Create account" : "Sign in"} <span aria-hidden="true">→</span>`;
  document.querySelector("#account-message").textContent = "";
  document.querySelector("#account-password").autocomplete = registering ? "new-password" : "current-password";
}

function updateAccountButton() {
  const button = document.querySelector("#account-open");
  document.querySelector("#account-label").textContent = currentUser ? currentUser.name : "Sign in";
  button.title = currentUser ? "Account options" : "Sign in or create an account";
  document.querySelector("#account-logout").hidden = !currentUser;
}

function closeAccount() {
  const accountModal = document.querySelector("#account-modal");
  accountModal.classList.remove("is-open");
  accountModal.setAttribute("aria-hidden", "true");
  document.querySelector("#overlay").classList.remove("is-visible");
  document.body.classList.remove("modal-open");
  window.setTimeout(() => { document.querySelector("#overlay").hidden = true; }, 250);
}

function openAccount() {
  const accountModal = document.querySelector("#account-modal");
  document.querySelector("#account-form").reset();
  setAccountMode("login");
  document.querySelector("#overlay").hidden = false;
  requestAnimationFrame(() => document.querySelector("#overlay").classList.add("is-visible"));
  document.body.classList.add("modal-open");
  accountModal.classList.add("is-open");
  accountModal.setAttribute("aria-hidden", "false");
  document.querySelector("#account-form input").focus();
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("is-visible"), 3000);
}

async function refreshSession() {
  if (staticDemoMode) {
    activateDemoMode();
    return;
  }
  try {
    const response = await fetch("/api/auth/me");
    if (response.status === 404) {
      activateDemoMode();
      return;
    }
    if (!response.ok) throw new Error("Could not check account session.");
    const result = await response.json();
    currentUser = result.user;
    updateAccountButton();
  } catch (error) {
    if (error instanceof TypeError) {
      activateDemoMode();
      return;
    }
    setStatus(error.message, "error");
  }
}

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadResults();
  document.querySelector("#results").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelectorAll("[data-query]").forEach((button) => {
  button.addEventListener("click", () => {
    searchInput.value = button.dataset.query;
    loadResults();
    document.querySelector("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

filters.retailer.addEventListener("change", () => {
  if (!searchQuery) return;
  if (staticDemoMode) {
    setStatus(searchMessage, "demo");
    renderResults(searchOffers, searchMessage);
    return;
  }
  const retailer = filters.retailer.value;
  if (retailer === "Target" || retailer === "Walmart") {
    renderExternalRetailerSearch(retailer);
  } else if ((retailer === "all" && loadedRetailers.includes("Amazon") && loadedRetailers.includes("Best Buy"))
    || loadedRetailers.includes(retailer)) {
    setStatus(searchMessage);
    renderResults(searchOffers, searchMessage);
  } else {
    loadResults();
  }
});

[filters.rating, filters.reviews, filters.purchases, filters.sort].forEach((filter) => {
  filter.addEventListener("change", () => {
    if (searchQuery && (staticDemoMode || (filters.retailer.value !== "Target" && filters.retailer.value !== "Walmart"))) {
      renderResults(searchOffers, searchMessage);
    }
  });
});

document.querySelector("#reset-filters").addEventListener("click", () => {
  searchInput.value = "";
  searchQuery = "";
  Object.values(filters).forEach((filter) => { filter.selectedIndex = 0; });
  loadResults();
});

document.querySelector("#account-open").addEventListener("click", openAccount);
document.querySelector("#account-close").addEventListener("click", closeAccount);
document.querySelector("#overlay").addEventListener("click", closeAccount);
document.querySelector("#continue-as-guest").addEventListener("click", closeAccount);
document.querySelectorAll(".account-tab").forEach((tab) => {
  tab.addEventListener("click", () => setAccountMode(tab.dataset.mode));
});

document.querySelector("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (staticDemoMode) {
    document.querySelector("#account-message").textContent = "Accounts are unavailable in this static demo. You can search and compare as a guest.";
    return;
  }
  if (!form.reportValidity()) return;
  const button = document.querySelector("#account-submit");
  button.disabled = true;
  document.querySelector("#account-message").textContent = "Checking your account…";
  try {
    const response = await fetch(`/api/auth/${accountMode === "register" ? "register" : "login"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.elements.name.value.trim(),
        email: form.elements.email.value.trim(),
        password: form.elements.password.value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Account request failed.");
    currentUser = result.user;
    updateAccountButton();
    closeAccount();
    showToast(accountMode === "register" ? "Account created. You can start comparing." : "You're signed in. Search is ready.");
    if (searchInput.value.trim()) await loadResults();
  } catch (error) {
    document.querySelector("#account-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#account-logout").addEventListener("click", async () => {
  if (staticDemoMode) return;
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error("Sign out failed. Please try again.");
    currentUser = null;
    updateAccountButton();
    closeAccount();
    searchSequence++;
    searchInput.value = "";
    searchQuery = "";
    Object.values(filters).forEach((filter) => { filter.selectedIndex = 0; });
    productGrid.innerHTML = "";
    productGrid.hidden = true;
    searchOffers = [];
    loadedRetailers = [];
    searchMessage = "";
    document.querySelector("#result-count").textContent = "Waiting for search";
    document.querySelector("#result-label").textContent = "Search a product to compare listings";
    displayEmpty("Start with a product search.", "Enter a product to search retailer listings. You can continue as a guest or sign in for an account.");
    renderRetailerSearchLinks();
    showToast("You're signed out.");
  } catch (error) {
    document.querySelector("#account-message").textContent = error.message;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector("#account-modal").classList.contains("is-open")) closeAccount();
});

if (staticDemoMode) activateDemoMode();
displayEmpty("Start with a product search.", "Enter a product to search retailer listings. You can compare as a guest or sign in for an account. Nothing is pre-filled with sample offers.");
refreshSession();
