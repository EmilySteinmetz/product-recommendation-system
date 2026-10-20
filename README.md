# Goodfind

Goodfind is a local product-comparison website. Product search and comparison are available to guests; creating an account or signing in is optional. It also has live retailer search, rating/review/purchase filters, and links to retailer listings.

## Run locally

Requirements: Node.js 22.5 or newer.

```sh
npm install
npm run open:chrome
```

This starts the local server if needed and opens Goodfind in Google Chrome at <http://127.0.0.1:3000>. To start the server without opening Chrome, use `npm start` and visit that address yourself.

Account passwords are hashed and stored in `data/goodfind.sqlite`. Account sessions use an HTTP-only cookie and expire after seven days. The `data/` directory is ignored by Git.

## Live retailer data

The app checks Amazon's and Best Buy's `robots.txt` before requesting their public search pages. It extracts only fields present in the returned listings, including product title, price, rating, review count, and Amazon's published recent-purchase label where available. Missing fields remain unavailable. Search results are cached for one minute. "All retailers" searches both live sources. The retailer selector can choose either live source independently. Rating, review, purchase-count, and sort filters operate locally on the retrieved results instead of repeating retailer requests.

Target and Walmart searches open on their official websites rather than being scraped. This prototype does not bypass retailer access controls. Retailer prices and availability can change, so confirm details on the retailer page before purchasing.

## Publish with Render

The included `render.yaml` configures a Node web service and a persistent disk for account data. In Render, create a new Blueprint from this repository and apply the `goodfind` service configuration. Render requires a paid service plan for persistent disks. Once deployment finishes, use the `onrender.com` URL Render provides; the browser layout and app assets are served from the same site.

The service binds to Render's public network interface, serves the health check at `/api/health`, and uses HTTPS cookies behind Render's TLS proxy. The SQLite database lives on the persistent disk at `/var/data`. Keep one service instance so all requests use the same SQLite database. Back up the disk regularly; the disk is the only copy of account data.

The app is a prototype, not a hardened production commerce service. Before public use, review the hosting plan and operational needs, and secure approved retailer data access. Retailer prices and availability can change, so confirm details on the retailer page before purchasing.
