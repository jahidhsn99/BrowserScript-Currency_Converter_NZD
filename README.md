# Currency Converter (Tampermonkey Userscript)

A Tampermonkey userscript that scans any webpage for prices in foreign currencies and adds a small, clickable conversion badge next to them — using live exchange rates, not a static table.

Built originally to convert everything to NZD while browsing overseas ecommerce sites, but the target currency is configurable, so it works for any base currency.

![example badge](https://img.shields.io/badge/example-%E2%89%88%20NZ%2456.49-blue?style=flat-square)

## Features

- **Automatic detection** of currency symbols (`$`, `€`, `£`, `¥`, `₹`, `₩`, `NZ$`, `A$`, `C$`, `HK$`, `S$`, `R$`) and ISO codes (`USD`, `EUR`, `CAD`, `AUD`, …) anywhere in page text.
- **Live exchange rates** from [open.er-api.com](https://www.exchangerate-api.com/) (free, no API key), cached for an hour so it isn't re-fetching on every page load.
- **Smart handling of ambiguous `$`**:
  - If the page also spells out a code nearby (e.g. `$24.99 CAD`), that's used directly.
  - Otherwise it guesses from the site's domain TLD (`.au` → AUD, `.ca` → CAD, `.sg` → SGD, `.hk` → HKD, `.nz` → NZD, else USD) and flags the guess in the tooltip so you know it's not 100% certain.
- **Duplicate-conversion guard** — if a site already shows its own localized price next to the original (common on SaaS pricing pages), the script won't pile a second, differently-calculated conversion on top of it.
- **Rich hover tooltip** on every badge showing:
  - The detected source currency and original amount
  - The exact exchange rate used (`1 USD = 1.7123 NZD`)
  - When the rates were last fetched, with a staleness warning if >24h old
  - A warning if the currency was guessed rather than explicitly stated
- **Click to copy** the converted amount to your clipboard.
- **Configurable target currency** — defaults to NZD but can be switched to any of ~27 supported currencies via an in-page settings panel.
- **Per-site disable** — turn the script off for a specific domain without disabling it everywhere.
- **Dark mode aware** — badge styling adapts to `prefers-color-scheme`.
- **Works on dynamic/SPA pages** — a `MutationObserver` re-scans content as it loads in (infinite scroll, client-side routing, etc.), not just on initial page load.
- **Handles both number formats** — `1,299.00` (US-style) and `1.299,00` (European-style) are both parsed correctly.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Firefox, Edge, Safari, Brave all supported).
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Delete the boilerplate and paste in the contents of [`currency-to-nzd.user.js`](./currency-to-nzd.user.js).
4. Save (Ctrl+S / Cmd+S). The script runs automatically on every page you visit (`@match *://*/*`).

Alternatively, if this repo is hosted with the raw file publicly accessible, Tampermonkey can install it directly from a raw GitHub URL and will offer to auto-update when you push new versions (see [Updating](#updating-the-hosted-version) below).

## Usage

Just browse normally. Any price on the page in a currency other than your target currency gets a small pill-shaped badge next to it, e.g.:

```
$24.99 CAD  [≈ NZ$28.65]
```

- **Hover** the badge to see the source currency, original amount, exact rate used, and rate freshness.
- **Click** the badge to copy the converted number to your clipboard.

### Tampermonkey menu commands

Click the Tampermonkey icon in your browser toolbar, then the script name, to access:

| Command | What it does |
|---|---|
| 🟢/⚪ Currency conversion: ON/OFF | Globally enable/disable the script |
| 🚫/✅ Disable/Re-enable on `<current site>` | Turn the script off just for the site you're currently on |
| ⚙️ Settings | Opens a dialog to change target currency and toggle flag icons |
| 🔄 Refresh exchange rates now | Clears the cached rates and forces a fresh fetch |

## Configuration

Open **⚙️ Settings** from the Tampermonkey menu to change:

- **Convert prices to** — target currency (defaults to NZD). Supports USD, AUD, CAD, GBP, EUR, JPY, CNY, INR, KRW, CHF, SEK, NOK, DKK, MXN, ZAR, HKD, SGD, THB, AED, PHP, IDR, MYR, VND, BRL, PLN, TRY, ILS, NZD.
- **Show country flags on badges** — off by default, since flag emoji don't render correctly on some systems (notably older Windows builds show them as literal two-letter codes, e.g. "NZ" instead of 🇳🇿). Turn on if your OS renders emoji flags properly.

Settings are stored via Tampermonkey's `GM_setValue`/`GM_getValue`, so they persist across sessions and page reloads, and apply globally across all sites (except per-site disables).

## How it works (architecture)

1. **Rate fetching** (`loadRates`) — checks a local cache (`GM_getValue`) first; if it's missing or older than an hour, fetches fresh rates from `open.er-api.com` (base currency USD, so all conversions go `source → USD → target`). Falls back to a stale cache if the network request fails.
2. **DOM scanning** (`scan` / `processTextNode`) — walks all text nodes in the page (skipping `<script>`, `<style>`, inputs, etc.), and runs a single combined regex against each one to find currency symbols/codes next to numbers.
3. **Currency resolution** — for each match, resolves an explicit symbol/code, or for ambiguous `$`, checks for a trailing code (`$24.99 CAD`) before falling back to a domain-based guess.
4. **Conversion & rendering** (`makeBadge`) — computes the converted amount, builds a styled badge with a hover tooltip, and inserts it right after the original price text (the original text is left untouched).
5. **Live updates** (`observeMutations`) — a debounced `MutationObserver` re-runs the scan whenever new content is added to the page, so infinite-scroll and SPA navigation are handled without a page reload.

## Known limitations

- Number parsing is a best-effort heuristic; extremely unusual formats (e.g. mixed grouping within one number) may parse incorrectly.
- Ambiguous currency symbols like a bare `kr` (SEK/NOK/DKK) aren't handled — only explicit ISO codes are recognized for those currencies.
- The domain-based guess for bare `$` is a heuristic, not a guarantee — always check the hover tooltip if you're relying on the number for something important.
- Relies on a free, keyless exchange rate API (`open.er-api.com`) which updates once daily, not truly real-time to the second.
- Runs on every page (`@match *://*/*`), which has some performance cost on very text-heavy pages; use the per-site disable if you notice slowdown on a specific site.

## Contributing / Extending

Pull requests welcome. Some natural extensions:
- Support for more currency symbols (e.g. ₺, ₪, ₫ as symbols rather than requiring the ISO code)
- A currency-picker badge (right-click to override a wrongly-guessed currency)
- An options page instead of the injected dialog, for a more native Tampermonkey settings experience
- Support for cryptocurrency prices

## License

MIT — do whatever you like with it.
