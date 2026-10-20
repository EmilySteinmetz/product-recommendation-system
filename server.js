import { createServer } from "node:http";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = resolve(process.env.GOODFIND_DATA_DIR ?? resolve(root, "data"));
await mkdir(dataDirectory, { recursive: true });

const database = new DatabaseSync(resolve(dataDirectory, "goodfind.sqlite"));
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);

const bestBuySearchUrl = (query) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(query)}`;
const amazonSearchUrl = (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
const retailerSearchUrls = {
  "Best Buy": bestBuySearchUrl,
  Amazon: amazonSearchUrl,
  Target: (query) => `https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`,
  Walmart: (query) => `https://www.walmart.com/search?q=${encodeURIComponent(query)}`,
  Nike: (query) => `https://www.nike.com/w?q=${encodeURIComponent(query)}`
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const searchCache = new Map();
const authAttempts = new Map();
const robotsCache = new Map();
let searchAttempts = new Map();

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(body));
}

function cookieValue(request, name) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sessionCookie(token, request, maxAge = 7 * 24 * 60 * 60) {
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `goodfind_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function sessionUser(request) {
  const token = cookieValue(request, "goodfind_session");
  if (!token) return null;
  const row = database.prepare(`
    SELECT users.id, users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(digest(token), Date.now());
  return row ?? null;
}

async function readJson(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Send request data as JSON.");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12_000) {
      const error = new Error("Request is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function allowSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function checkRateLimit(request, response, map, keyPrefix, maximum, intervalMs) {
  const key = `${keyPrefix}:${request.socket.remoteAddress ?? "unknown"}`;
  const now = Date.now();
  const attempts = (map.get(key) ?? []).filter((timestamp) => now - timestamp < intervalMs);
  if (attempts.length >= maximum) {
    sendJson(response, 429, { error: "Too many requests. Please wait a moment and try again." }, {
      "Retry-After": String(Math.ceil(intervalMs / 1000))
    });
    return false;
  }
  attempts.push(now);
  map.set(key, attempts);
  return true;
}

async function handleAuth(request, response, pathname) {
  if (!allowSameOrigin(request)) {
    sendJson(response, 403, { error: "Cross-origin account requests are not allowed." });
    return;
  }

  if (pathname === "/api/auth/me" && request.method === "GET") {
    sendJson(response, 200, { user: sessionUser(request) });
    return;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token = cookieValue(request, "goodfind_session");
    if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
    sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", request, 0) });
    return;
  }

  if (!["/api/auth/register", "/api/auth/login"].includes(pathname) || request.method !== "POST") {
    sendJson(response, 404, { error: "Account endpoint not found." });
    return;
  }
  if (!checkRateLimit(request, response, authAttempts, "auth", 10, 10 * 60 * 1000)) return;

  const body = await readJson(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    sendJson(response, 400, { error: "Enter a valid email address." });
    return;
  }
  if (password.length < 8 || password.length > 200) {
    sendJson(response, 400, { error: "Password must be between 8 and 200 characters." });
    return;
  }

  let user;
  if (pathname.endsWith("/register")) {
    if (name.length < 1 || name.length > 80) {
      sendJson(response, 400, { error: "Enter a name between 1 and 80 characters." });
      return;
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = await scrypt(password, salt, 64);
    try {
      const result = database.prepare(
        "INSERT INTO users (name, email, password_salt, password_hash) VALUES (?, ?, ?, ?)"
      ).run(name, email, salt, passwordHash.toString("hex"));
      user = { id: Number(result.lastInsertRowid), name, email };
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendJson(response, 409, { error: "An account with that email already exists. Sign in instead." });
        return;
      }
      throw error;
    }
  } else {
    const stored = database.prepare(
      "SELECT id, name, email, password_salt, password_hash FROM users WHERE email = ?"
    ).get(email);
    const salt = stored?.password_salt ?? randomBytes(16).toString("hex");
    const passwordHash = await scrypt(password, salt, 64);
    const storedHash = Buffer.from(stored?.password_hash ?? "0".repeat(128), "hex");
    if (!stored || !timingSafeEqual(passwordHash, storedHash)) {
      sendJson(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    user = { id: stored.id, name: stored.name, email: stored.email };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    digest(token), user.id, expiresAt
  );
  sendJson(response, pathname.endsWith("/register") ? 201 : 200, { user }, {
    "Set-Cookie": sessionCookie(token, request)
  });
}

async function getRobotsPolicy(host) {
  const cached = robotsCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.parser;
  const response = await fetch(`https://${host}/robots.txt`, {
    headers: { "User-Agent": "GoodfindComparison/1.0" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`${host} robots.txt returned HTTP ${response.status}.`);
  const content = await response.text();
  const policy = {
    parser: robotsParser(`https://${host}/robots.txt`, content),
    expiresAt: Date.now() + 60 * 60 * 1000
  };
  robotsCache.set(host, policy);
  return policy.parser;
}

function extractBestBuyOffers(html) {
  const $ = cheerio.load(html);
  const offers = [];
  $("li.product-list-item").each((_, element) => {
    const card = $(element);
    const titleElement = card.find("h3.product-title").first();
    const name = titleElement.attr("title")?.trim() || titleElement.text().replace(/\s+/g, " ").trim();
    const href = titleElement.closest("a").attr("href");
    if (!name || !href) return;

    let productUrl;
    try {
      productUrl = new URL(href, "https://www.bestbuy.com");
      if (productUrl.protocol !== "https:" || !productUrl.hostname.endsWith("bestbuy.com")) return;
    } catch {
      return;
    }

    const text = card.text().replace(/\s+/g, " ").trim();
    const ratingMatch = text.match(/Rating\s+([0-5](?:\.\d+)?)\s+out of 5 stars with\s+([\d,]+)\s+reviews/i);
    const priceMatch = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
    const image = card.find("img").first().attr("src") || card.find("img").first().attr("data-src") || "";

    offers.push({
      id: productUrl.pathname.split("/").filter(Boolean).at(-1),
      retailer: "Best Buy",
      name,
      category: "Retailer search result",
      url: productUrl.href,
      image,
      price: priceMatch ? Number(priceMatch[1].replaceAll(",", "")) : null,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      reviewCount: ratingMatch ? Number(ratingMatch[2].replaceAll(",", "")) : null,
      purchaseCount: null
    });
  });
  return offers;
}

async function searchBestBuy(query) {
  const url = bestBuySearchUrl(query);
  const policy = await getRobotsPolicy("www.bestbuy.com");
  if (!policy.isAllowed(url, "GoodfindComparison")) {
    const error = new Error("Best Buy robots.txt does not allow this search URL.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": "GoodfindComparison/1.0 (+local product comparison prototype)",
      Accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Best Buy search returned HTTP ${response.status}.`);
  const html = await response.text();
  if (html.length > 5_000_000) throw new Error("Best Buy returned an unexpectedly large search page.");
  return extractBestBuyOffers(html);
}

function parseCompactCount(value) {
  const match = value.match(/^([\d,.]+)\s*([KM])?$/i);
  if (!match) return null;
  const magnitude = match[2]?.toUpperCase() === "M" ? 1_000_000
    : match[2]?.toUpperCase() === "K" ? 1_000 : 1;
  return Math.round(Number(match[1].replaceAll(",", "")) * magnitude);
}

function extractAmazonOffers(html) {
  const $ = cheerio.load(html);
  const offers = [];
  $("[data-component-type='s-search-result'][data-asin]").each((_, element) => {
    const card = $(element);
    const asin = card.attr("data-asin")?.trim();
    const name = card.find("h2").first().text().replace(/\s+/g, " ").trim();
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin) || !name || /^(results|more results|recently bought and rated)$/i.test(name)) return;

    const text = card.text().replace(/\s+/g, " ").trim();
    const priceText = card.find(".a-price .a-offscreen").filter((_, price) => {
      return !$(price).closest(".a-text-price").length;
    }).first().text();
    const priceMatch = priceText.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
    const ratingText = card.find(".a-icon-alt").first().text();
    const ratingMatch = ratingText.match(/([0-5](?:\.\d+)?)\s+out of 5 stars/i);
    const reviewText = card.find("a[href*='#customerReviews']").map((_, link) => $(link).text()).get().join(" ");
    const reviewMatch = `${reviewText} ${text}`.match(/\(([\d,.]+[KM]?)\)/i);
    const purchaseMatch = text.match(/([\d,.]+[KM]?)\+?\s+bought in past month/i);
    const image = card.find("img.s-image").first().attr("src") ?? "";

    offers.push({
      id: asin,
      retailer: "Amazon",
      name,
      category: "Retailer search result",
      url: `https://www.amazon.com/dp/${asin}`,
      image,
      price: priceMatch ? Number(priceMatch[1].replaceAll(",", "")) : null,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      reviewCount: reviewMatch ? parseCompactCount(reviewMatch[1]) : null,
      purchaseCount: purchaseMatch ? parseCompactCount(purchaseMatch[1]) : null,
      purchaseLabel: purchaseMatch?.[0] ?? null
    });
  });
  return offers;
}

async function searchAmazon(query) {
  const url = amazonSearchUrl(query);
  const policy = await getRobotsPolicy("www.amazon.com");
  if (!policy.isAllowed(url, "GoodfindComparison")) {
    const error = new Error("Amazon robots.txt does not allow this search URL.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; GoodfindComparison/1.0; +http://127.0.0.1:3000)",
      Accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Amazon search returned HTTP ${response.status}.`);
  const html = await response.text();
  if (html.length > 5_000_000) throw new Error("Amazon returned an unexpectedly large search page.");
  if (/robot check|captcha|enter the characters you see below/i.test(html.slice(0, 25_000))) {
    throw new Error("Amazon did not return readable search results. Open the store's search page instead.");
  }
  return extractAmazonOffers(html);
}

async function handleSearch(request, response, url) {
  if (!sessionUser(request)) {
    sendJson(response, 401, { error: "Sign in before searching for products." });
    return;
  }
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length < 2 || query.length > 120) {
    sendJson(response, 400, { error: "Search terms must be between 2 and 120 characters." });
    return;
  }
  if (!checkRateLimit(request, response, searchAttempts, "search", 20, 60_000)) return;

  const retailer = url.searchParams.get("retailer") ?? "all";
  if (!["all", "Amazon", "Target", "Walmart", "Best Buy"].includes(retailer)) {
    sendJson(response, 400, { error: "Choose one of the listed retailers." });
    return;
  }
  if (["Target", "Walmart"].includes(retailer)) {
    sendJson(response, 200, {
      query,
      retailer,
      offers: [],
      providers: [],
      searchedAt: new Date().toISOString(),
      message: `${retailer} listings are not extracted by this prototype. Open its official search results to check current listings.`,
      retailerUrl: retailerSearchUrls[retailer]?.(query) ?? null
    });
    return;
  }

  const cacheKey = `${retailer}:${query.toLocaleLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    sendJson(response, 200, cached.body, { "X-Data-Source": "cache" });
    return;
  }

  try {
    const providers = retailer === "all" ? ["Amazon", "Best Buy"] : [retailer];
    const results = await Promise.allSettled(providers.map((provider) => (
      provider === "Amazon" ? searchAmazon(query) : searchBestBuy(query)
    )));
    const offers = [];
    const sourceErrors = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        offers.push(...result.value);
      } else {
        sourceErrors.push(`${providers[index]}: ${result.reason.message}`);
      }
    });
    if (results.every((result) => result.status === "rejected")) {
      sendJson(response, 502, {
        error: `Could not retrieve live results. ${sourceErrors.join(" ")}`,
        retailerUrl: retailerSearchUrls[retailer === "all" ? "Best Buy" : retailer](query)
      });
      return;
    }
    const availableProviders = providers.filter((_, index) => results[index].status === "fulfilled");
    const body = {
      query,
      retailer,
      source: `Live ${availableProviders.join(" and ")} search page${availableProviders.length === 1 ? "" : "s"}`,
      searchedAt: new Date().toISOString(),
      offers,
      providers: availableProviders,
      errors: sourceErrors,
      message: `${offers.length ? `Live listing details were read from ${availableProviders.join(" and ")}.` : "No readable product listings were returned."} Prices, ratings, reviews, and purchase counts appear only when published in a returned store listing.${sourceErrors.length ? ` Partial results: ${sourceErrors.join(" ")}` : ""}`,
      retailerUrl: retailerSearchUrls[retailer === "all" ? "Best Buy" : retailer](query)
    };
    searchCache.set(cacheKey, { body, expiresAt: Date.now() + 60_000 });
    sendJson(response, 200, body, { "X-Data-Source": "retailer" });
  } catch (error) {
    sendJson(response, error.status ?? 502, {
      error: `Could not retrieve live Best Buy results: ${error.message}`,
      retailerUrl: bestBuySearchUrl(query)
    });
  }
}

async function serveStatic(request, response, pathname) {
  const publicFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/styles.css", "styles.css"],
    ["/app.js", "app.js"]
  ]);
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const fileName = publicFiles.get(requestedPath);
  if (!fileName) {
    response.writeHead(404).end("Not found");
    return;
  }
  const filePath = resolve(root, fileName);
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      response.writeHead(404).end("Not found");
      return;
    }
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok", service: "Goodfind comparison server" });
    } else if (url.pathname.startsWith("/api/auth/")) {
      await handleAuth(request, response, url.pathname);
    } else if (url.pathname === "/api/search" && request.method === "GET") {
      await handleSearch(request, response, url);
    } else if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response, url.pathname);
    } else {
      sendJson(response, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendJson(response, error.status ?? 500, { error: error.status ? error.message : "The server could not complete the request." });
  }
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Goodfind is running at http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
