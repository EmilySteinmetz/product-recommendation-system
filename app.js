const searchInput = document.querySelector("#search-input");
const productGrid = document.querySelector("#product-grid");
const noResults = document.querySelector("#no-results");
const accountNote = document.querySelector("#account-note");
const savedProductGrid = document.querySelector("#saved-product-grid");
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
let sessionPromise = Promise.resolve();
let searchSequence = 0;
let toastTimeout;
let searchOffers = [];
let loadedRetailers = [];
let searchMessage = "";
const demoAccountsKey = "goodfind.demo.accounts.v1";
const demoSessionKey = "goodfind.demo.session.v1";
const savedProductsKey = "goodfind.saved-products.v1";

class ApiUnavailableError extends Error {}

const retailerNames = ["Best Buy", "Amazon", "Target", "Walmart"];
const demoCatalog = [
  {
    name: "Cloudtone Wireless Headphones",
    description: "Soft over-ear cushions, noise reduction, and up to 30 hours of sample battery life.",
    category: "Headphones",
    keywords: ["headphone", "headphones", "audio", "wireless", "bluetooth"],
    images: [
      "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=480&q=80",
      "https://images.unsplash.com/photo-1484704849700-f032a568e944?auto=format&fit=crop&w=480&q=80",
      "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=480&q=80",
      "https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=480&q=80"
    ],
    offers: [
      { price: 79.99, rating: 4.7, reviewCount: 1842, purchaseCount: 320 },
      { price: 74.5, rating: 4.3, reviewCount: 965, purchaseCount: 1100 },
      { price: 89.99, rating: 4.5, reviewCount: 427, purchaseCount: 85 },
      { price: 68.88, rating: 4.1, reviewCount: 2310, purchaseCount: 640 }
    ]
  },
  {
    name: "Trailview 4K Digital Camera",
    description: "A compact sample camera with a flip screen, image stabilization, and 4K video.",
    category: "Cameras",
    keywords: ["camera", "cameras", "photography", "digital", "4k"],
    images: [
      "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=480&q=80",
      "https://images.unsplash.com/photo-1502920917128-1aa500764cbd?auto=format&fit=crop&w=480&q=80",
      "https://images.unsplash.com/photo-1471341971476-ae15ff5dd4ea?auto=format&fit=crop&w=480&q=80",
      "https://images.unsplash.com/photo-1502982720700-bfff97f2ecac?auto=format&fit=crop&w=480&q=80"
    ],
    offers: [
      { price: 429, rating: 4.6, reviewCount: 618, purchaseCount: 74 },
      { price: 399.95, rating: 4.2, reviewCount: 2104, purchaseCount: 280 },
      { price: 449.99, rating: 4.8, reviewCount: 193, purchaseCount: 38 },
      { price: 379, rating: 3.9, reviewCount: 847, purchaseCount: 156 }
    ]
  }
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

function readStoredJson(storage, key, fallback) {
  let value;
  try {
    value = storage.getItem(key);
  } catch (error) {
    showToast(`Browser storage is unavailable: ${error.message}`);
    return fallback;
  }
  if (value === null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    showToast("Stored demo data could not be read. You can continue, but that data may need to be recreated.");
    return fallback;
  }
}

function writeStoredJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    showToast(`Could not save demo data in this browser: ${error.message}`);
    return false;
  }
}

function normalizedEmail(email) {
  return email.trim().toLocaleLowerCase();
}

function getDemoAccounts() {
  const accounts = readStoredJson(localStorage, demoAccountsKey, []);
  if (!Array.isArray(accounts)) {
    showToast("Stored demo account data is invalid. Create an account again to continue.");
    return [];
  }
  return accounts.filter((account) => (
    account && typeof account.email === "string" && typeof account.name === "string"
  ));
}

function getSavedProducts(email = currentUser?.email) {
  if (!email) return [];
  const savedByAccount = readStoredJson(localStorage, savedProductsKey, {});
  if (!savedByAccount || typeof savedByAccount !== "object" || Array.isArray(savedByAccount)) {
    showToast("Stored saved-product data is invalid. New saves will be stored separately.");
    return [];
  }
  const saved = savedByAccount[normalizedEmail(email)];
  return Array.isArray(saved) ? saved.filter((offer) => offer && typeof offer.name === "string") : [];
}

function offerKey(offer) {
  return `${offer.retailer}::${offer.name}::${offer.url}`;
}

function isOfferSaved(offer) {
  if (!currentUser) return false;
  return getSavedProducts().some((saved) => offerKey(saved) === offerKey(offer));
}

async function readApiJson(response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw new ApiUnavailableError("This site is running without the Goodfind API.");
  }
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiUnavailableError("The Goodfind API returned an invalid response.");
    }
    throw error;
  }
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
  const products = demoCatalog.filter((product) => terms.some((term) => (
    product.keywords.some((keyword) => keyword.includes(term) || term.includes(keyword))
  )));
  return products.flatMap((product) => retailerNames.map((retailer, index) => {
    const offer = product.offers[index];
    return {
      name: product.name,
      description: product.description,
      category: product.category,
      image: product.images[index],
      retailer,
      price: offer.price,
      rating: offer.rating,
      reviewCount: offer.reviewCount,
      purchaseCount: offer.purchaseCount,
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
    const saved = isOfferSaved(offer);
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
            <p class="comparison-description">${escapeHtml(offer.description ?? "")}</p>
            <span class="offer-badge">${staticDemoMode ? "SAMPLE DEMO DATA" : "LIVE RETAILER LISTING"}</span>
          </div>
          <button class="save-product-button" type="button" data-save-key="${escapeHtml(offerKey(offer))}" aria-pressed="${saved}">${saved ? "Saved ✓" : "Save product +"}</button>
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

function renderSavedProducts() {
  if (!currentUser) return;
  const saved = getSavedProducts();
  savedProductGrid.innerHTML = saved.map((offer) => {
    const retailerLink = safeRetailerUrl(offer.retailer, offer.url);
    const priceText = offer.price === null ? "Check retailer" : new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD"
    }).format(offer.price);
    const ratingText = offer.rating === null ? "Not reported" : `<span class="rating-star">★</span> ${offer.rating.toFixed(1)} <small>/ 5</small>`;
    return `
      <article class="comparison-card">
        <div class="comparison-product">
            <div class="comparison-image">${typeof offer.image === "string" && offer.image.startsWith("https://") ? `<img src="${escapeHtml(offer.image)}" alt="" loading="lazy">` : `<span class="product-placeholder" aria-hidden="true">✳</span>`}</div>
          <div class="comparison-product-copy">
            <span class="product-category">${escapeHtml(offer.category)}</span>
            <h3>${escapeHtml(offer.name)}</h3>
            <p class="comparison-description">${escapeHtml(offer.description ?? "")}</p>
            <span class="offer-badge">${offer.demo ? "SAMPLE DEMO DATA" : "SAVED LISTING"}</span>
          </div>
          <button class="save-product-button" type="button" data-save-key="${escapeHtml(offerKey(offer))}" aria-pressed="true">Remove saved</button>
        </div>
        <div class="offer-details">
          <div class="retailer-name"><span class="retailer-mark">${escapeHtml(offer.retailer.slice(0, 1))}</span><strong>${escapeHtml(offer.retailer)}</strong></div>
          <div class="offer-metric offer-price"><span>${offer.demo ? "Sample price" : "Listed price"}</span><strong>${priceText}</strong></div>
          <div class="offer-metric"><span>Rating</span><strong>${ratingText}</strong></div>
          <div class="offer-metric"><span>Reviews</span><strong>${formatCount(offer.reviewCount)}</strong></div>
          <div class="offer-metric"><span>Purchases</span><strong>${escapeHtml(offer.purchaseLabel ?? formatCount(offer.purchaseCount))}</strong></div>
          <a class="retailer-link" href="${escapeHtml(retailerLink)}" target="_blank" rel="noopener noreferrer">Search at ${escapeHtml(offer.retailer)} <span aria-hidden="true">↗</span></a>
        </div>
      </article>`;
  }).join("");
  document.querySelector("#saved-products-empty").hidden = saved.length !== 0;
  savedProductGrid.hidden = saved.length === 0;
  document.querySelector("#saved-products-note").textContent = staticDemoMode
    ? "Simulated account data and saved products are stored only in this browser. This is not secure authentication."
    : "Saved products are stored in this browser for this account.";
}

function saveOffer(offer) {
  if (!currentUser) {
    openAccount();
    document.querySelector("#account-message").textContent = "Create an account or sign in to save products. Guests can keep searching without an account.";
    return;
  }
  const savedByAccount = readStoredJson(localStorage, savedProductsKey, {});
  if (!savedByAccount || typeof savedByAccount !== "object" || Array.isArray(savedByAccount)) {
    showToast("Saved-product data is invalid. Your product was not saved.");
    return;
  }
  const email = normalizedEmail(currentUser.email);
  const accountSaved = Array.isArray(savedByAccount[email]) ? savedByAccount[email] : [];
  const key = offerKey(offer);
  const existingIndex = accountSaved.findIndex((saved) => offerKey(saved) === key);
  if (existingIndex >= 0) {
    accountSaved.splice(existingIndex, 1);
  } else {
    accountSaved.push({
      name: offer.name,
      category: offer.category,
      description: offer.description,
      image: offer.image,
      retailer: offer.retailer,
      price: offer.price,
      rating: offer.rating,
      reviewCount: offer.reviewCount,
      purchaseCount: offer.purchaseCount,
      purchaseLabel: offer.purchaseLabel,
      url: offer.url,
      demo: staticDemoMode
    });
  }
  savedByAccount[email] = accountSaved;
  if (!writeStoredJson(localStorage, savedProductsKey, savedByAccount)) return;
  renderResults(searchOffers, searchMessage);
  if (!document.querySelector("#saved-products-section").hidden) renderSavedProducts();
  updateAccountButton();
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
  if (!currentUser) {
    const activeEmail = readStoredJson(sessionStorage, demoSessionKey, "");
    if (typeof activeEmail === "string") {
      const account = getDemoAccounts().find((savedAccount) => savedAccount.email === activeEmail);
      currentUser = account ? { ...account, simulated: true } : null;
    }
  }
  document.querySelector("#account-password").autocomplete = "off";
  updateAccountButton();
  accountNote.textContent = "Simulated demo accounts are stored in this browser. Passwords are not saved or verified; never use a real password.";
  document.querySelector(".data-disclaimer").textContent = "Demonstration sample data only — prices, ratings, reviews, and purchase counts are fictional and are not current retailer offers. Retailer links open each store's search page. Search and comparison are available without an account.";
  document.querySelector("#saved-products-open").title = "View products saved to this browser demo account";
  if (currentUser) renderSavedProducts();
  setStatus("GitHub Pages uses fictional demonstration data. Search and compare as a guest.", "demo");
}

function renderDemoResults(sequence, query) {
  if (sequence !== searchSequence) return;
  searchOffers = demoOffersForQuery(query);
  loadedRetailers = retailerNames;
  searchMessage = searchOffers.length
    ? "Demonstration sample data only. Product images are examples, and the names, prices, ratings, reviews, and purchase counts are fictional. Retailer links open each store's search page."
    : "This demo includes sample headphones and cameras. Try searching for headphones or cameras.";
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
    if (sequence !== searchSequence) return;
    if (response.status === 404) {
      activateDemoMode();
      renderDemoResults(sequence, searchQuery);
      return;
    }
    const result = await readApiJson(response);
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
    if (error instanceof ApiUnavailableError || error instanceof TypeError) {
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
  document.querySelector("#account-password").autocomplete = staticDemoMode
    ? "off"
    : registering ? "new-password" : "current-password";
}

function updateAccountButton() {
  const button = document.querySelector("#account-open");
  document.querySelector("#account-label").textContent = currentUser ? currentUser.name : "Sign in";
  button.title = currentUser ? "Account options" : "Sign in or create an account";
  document.querySelector("#account-logout").hidden = !currentUser;
  document.querySelector("#continue-as-guest").hidden = Boolean(currentUser);
  const savedButton = document.querySelector("#saved-products-open");
  savedButton.hidden = !currentUser;
  if (currentUser) {
    const count = getSavedProducts().length;
    savedButton.textContent = count ? `Saved products (${count})` : "Saved products";
  }
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
  document.querySelector('#account-form input[name="email"]').focus();
}

function completeDemoAccountAction(form) {
  const email = normalizedEmail(form.elements.email.value);
  const password = form.elements.password.value;
  const message = document.querySelector("#account-message");
  if (password.length < 8) {
    message.textContent = "Use a demo password with at least 8 characters.";
    return;
  }

  const accounts = getDemoAccounts();
  let account;
  if (accountMode === "register") {
    if (accounts.some((existing) => existing.email === email)) {
      message.textContent = "A demo account already exists for this email. Sign in instead.";
      return;
    }
    account = { email, name: form.elements.name.value.trim() };
    if (!writeStoredJson(localStorage, demoAccountsKey, [...accounts, account])) {
      message.textContent = "The demo account could not be stored in this browser.";
      return;
    }
  } else {
    account = accounts.find((existing) => existing.email === email);
    if (!account) {
      message.textContent = "No demo account was found for this email. Create an account first.";
      return;
    }
  }

  currentUser = { ...account, simulated: true };
  writeStoredJson(sessionStorage, demoSessionKey, email);
  form.elements.password.value = "";
  updateAccountButton();
  closeAccount();
  if (searchOffers.length) renderResults(searchOffers, searchMessage);
  renderSavedProducts();
  showToast(accountMode === "register" ? "Demo account created. No password was stored." : "Signed in to the local demo account.");
}

function openSavedProducts() {
  if (!currentUser) return;
  renderSavedProducts();
  document.querySelector("#saved-products-section").hidden = false;
  document.querySelector("#saved-products-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleSaveButton(event) {
  const button = event.target.closest("[data-save-key]");
  if (!button) return;
  const key = button.dataset.saveKey;
  const offer = [...searchOffers, ...getSavedProducts()].find((item) => offerKey(item) === key);
  if (offer) saveOffer(offer);
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
    const result = await readApiJson(response);
    currentUser = result.user;
    accountNote.textContent = "Your account is managed by the Goodfind server. Passwords are never sent to retailers.";
    updateAccountButton();
  } catch (error) {
    if (error instanceof ApiUnavailableError || error instanceof TypeError) {
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
  await sessionPromise;
  if (!form.reportValidity()) return;
  if (staticDemoMode) {
    completeDemoAccountAction(form);
    return;
  }
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
    const result = await readApiJson(response);
    if (!response.ok) throw new Error(result.error || "Account request failed.");
    currentUser = result.user;
    updateAccountButton();
    closeAccount();
    showToast(accountMode === "register" ? "Account created. You can start comparing." : "You're signed in. Search is ready.");
    if (searchInput.value.trim()) await loadResults();
  } catch (error) {
    if (error instanceof ApiUnavailableError || error instanceof TypeError) {
      activateDemoMode();
      completeDemoAccountAction(form);
      return;
    }
    document.querySelector("#account-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#account-logout").addEventListener("click", async () => {
  if (staticDemoMode || currentUser?.simulated) {
    try {
      sessionStorage.removeItem(demoSessionKey);
    } catch (error) {
      showToast(`Could not clear the demo session: ${error.message}`);
    }
    currentUser = null;
    updateAccountButton();
    document.querySelector("#saved-products-section").hidden = true;
    closeAccount();
    showToast("Signed out of the demo account. Your saved products remain in this browser.");
    return;
  }
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error("Sign out failed. Please try again.");
    currentUser = null;
    updateAccountButton();
    document.querySelector("#saved-products-section").hidden = true;
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

productGrid.addEventListener("click", handleSaveButton);
savedProductGrid.addEventListener("click", handleSaveButton);
document.querySelector("#saved-products-open").addEventListener("click", openSavedProducts);
document.querySelector("#saved-products-close").addEventListener("click", () => {
  document.querySelector("#saved-products-section").hidden = true;
  document.querySelector("#results").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector("#account-modal").classList.contains("is-open")) closeAccount();
});

if (staticDemoMode) activateDemoMode();
displayEmpty("Start with a product search.", "Enter a product to search retailer listings. You can compare as a guest or sign in for an account. Nothing is pre-filled with sample offers.");
sessionPromise = refreshSession();
