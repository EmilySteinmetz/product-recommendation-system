# Goodfind

Goodfind is a local product-comparison website. It has persistent accounts, live retailer search, product comparisons, rating/review/purchase filters, and links to retailer listings.

## Run locally

Requirements: Node.js 22.5 or newer.

```sh
npm install
npm start
```

Open <http://127.0.0.1:3000>.

Account passwords are hashed and stored in `data/goodfind.sqlite`. Account sessions use an HTTP-only cookie and expire after seven days. The `data/` directory is ignored by Git.

## Live retailer data

The app checks Amazon's and Best Buy's `robots.txt` before requesting their public search pages. It extracts only fields present in the returned listings, including product title, price, rating, review count, and Amazon's published recent-purchase label where available. Missing fields remain unavailable. Search results are cached for one minute. "All retailers" searches both live sources. The retailer selector can choose either live source independently. Rating, review, purchase-count, and sort filters operate locally on the retrieved results instead of repeating retailer requests.

Target and Walmart searches open on their official websites rather than being scraped. This prototype does not bypass retailer access controls. Retailer prices and availability can change, so confirm details on the retailer page before purchasing.

This is a local prototype, not a deployed public service. Public production use needs hosting, HTTPS, operational monitoring, and data access approved for each retailer.
