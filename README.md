# Goodfind

Goodfind is a product-comparison website. Product search and comparison are available to guests; creating an account or signing in is optional. It supports retailer, rating, review, and purchase filters, sorting, and links to retailer searches.

## Run locally

Requirements: Node.js 22.5 or newer.

```sh
npm install
npm run open:chrome
```

This starts the local server if needed and opens Goodfind in Google Chrome at <http://127.0.0.1:3000>. To start the server without opening Chrome, use `npm start` and visit that address yourself.

Account passwords are hashed and stored in `data/goodfind.sqlite`. Account sessions use an HTTP-only cookie and expire after seven days. The `data/` directory is ignored by Git.

## GitHub Pages demo

Publish the repository root with GitHub Pages from the repository's **Settings → Pages**. GitHub Pages serves static files and cannot run the Node server. API requests such as `/api/search` and `/api/auth/me` therefore return a not-found page or HTML instead of JSON; the app detects this, including on custom domains, and switches to sample demonstration listings. Search, retailer comparisons, filters, and sorting work without an account. The demo listings and all displayed prices, ratings, review counts, and purchase counts are fictional, not live retailer data. Retailer links open the store's search page for the entered query.

GitHub Pages also offers simulated demo accounts. The demo stores only the account email/name in `localStorage`, the active demo email in `sessionStorage`, and saved product details in `localStorage`. It never stores or verifies passwords: any password meeting the form's minimum length works for an already registered demo email. Do not use a real password or treat this as secure authentication. Saved products are only available in the same browser. The sample catalog is limited to headphones and cameras; images are illustrative and all product descriptions and retailer metrics are fictional. Real account authentication remains available through the Node server.

## Live retailer data

When the Node server is running, the app checks Amazon's and Best Buy's `robots.txt` before requesting their public search pages. It extracts only fields present in returned listings, including product title, price, rating, review count, and Amazon's published recent-purchase label where available. Missing fields remain unavailable. Search results are cached for one minute. "All retailers" searches both live sources. Target and Walmart searches open their official websites rather than being scraped. Rating, review, purchase-count, and sort filters operate locally on retrieved results. This prototype does not bypass retailer access controls; confirm current prices and availability with the retailer.

## Publish with Render

The included `render.yaml` configures a Node web service and a persistent disk for account data. In Render, create a new Blueprint from this repository and apply the `goodfind` service configuration. Render requires a paid service plan for persistent disks. Once deployment finishes, use the `onrender.com` URL Render provides; the browser layout and app assets are served from the same site.

The service binds to Render's public network interface, serves the health check at `/api/health`, and uses HTTPS cookies behind Render's TLS proxy. The SQLite database lives on the persistent disk at `/var/data`. Keep one service instance so all requests use the same SQLite database. Back up the disk regularly; the disk is the only copy of account data.

The app is a prototype, not a hardened production commerce service. Before public use, review the hosting plan and operational needs, and secure approved retailer data access. Retailer prices and availability can change, so confirm details on the retailer page before purchasing.
