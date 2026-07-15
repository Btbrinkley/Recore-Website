# ReCore Technology Website

Public marketing website for ReCore Technology, a founder-led project building modular monitoring and control systems for vehicles, equipment, farms, and remote assets. Sentinel is the first product line: battery voltage and temperature monitoring, currently in prototype and field-testing.

## Status

This is a static, mostly-static marketing site. It is currently in prototype and field-testing stage, same as the Sentinel hardware it describes. No login, no live Firestore access, and no Firebase credentials are included in this site.

## Structure

```
index.html          Home
sentinel.html       Sentinel product page
platform.html       Platform / broader modular vision
development.html    Development & Engineering journal
about.html          About & Contact
404.html            Custom not-found page
css/styles.css      Shared stylesheet (colors, layout, components, responsive rules)
js/main.js          Mobile nav toggle + footer year
assets/favicon.svg  ReCore logo mark (favicon)
robots.txt          Search engine crawl rules
```

There is no build step. Every page is plain, semantic HTML that references the shared stylesheet and script directly.

## Local preview

Since this is a static site, you can preview it by opening `index.html` directly in a browser, or by serving the folder with any static file server, for example:

```
npx serve .
```

## Deploying to Cloudflare Pages

**Build command:** none (leave blank)
**Build output directory:** `/` (repository root)

Steps:

1. In the Cloudflare dashboard, go to Workers & Pages, then create a new Pages project connected to this GitHub repository.
2. Framework preset: None.
3. Build command: leave blank.
4. Build output directory: `/`.
5. Deploy. Cloudflare Pages will serve the static files directly, including `404.html` for unmatched routes.
6. If a custom domain is already configured for this project in Cloudflare, attach it to the new deployment under the project's Custom Domains tab.

## Content notes

- Copy on this site distinguishes what is working today, what is being field-tested, and what is planned. Planned features are explicitly labeled and should not be described as shipping.
- No pricing, release dates, certifications, patents, or customer/investor quotes are included, since none currently exist.
- The Contact section on the About page currently points to this GitHub repository, since no dedicated public contact email exists in the project yet. Add a real contact method before wider launch if one becomes available.
# Recore-Website
Website for Recore products
