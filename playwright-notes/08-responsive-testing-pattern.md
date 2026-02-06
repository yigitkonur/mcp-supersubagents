# 08: Responsive Testing Pattern

## Resize Command

```bash
playwright-cli resize <width> <height>
```

This resizes the browser viewport, NOT the window. Content reflows immediately.

## Standard Breakpoints

```bash
# Mobile
playwright-cli resize 375 667     # iPhone SE / small mobile
playwright-cli resize 390 844     # iPhone 14
playwright-cli resize 412 915     # Pixel 7

# Tablet
playwright-cli resize 768 1024    # iPad portrait
playwright-cli resize 1024 768    # iPad landscape

# Desktop
playwright-cli resize 1280 720    # Standard laptop
playwright-cli resize 1440 900    # Large laptop
playwright-cli resize 1920 1080   # Full HD monitor
```

## The Responsive Test Flow

```bash
# Desktop first
playwright-cli resize 1280 720
playwright-cli screenshot --filename=home-desktop-1280.png
playwright-cli snapshot    # check element layout

# Tablet
playwright-cli resize 768 1024
playwright-cli screenshot --filename=home-tablet-768.png
playwright-cli snapshot    # elements may have changed layout

# Mobile
playwright-cli resize 375 667
playwright-cli screenshot --filename=home-mobile-375.png
playwright-cli snapshot    # mobile nav probably replaces desktop nav
```

## What to Check at Each Breakpoint

### 1. Overflow detection (the killer check)
```bash
playwright-cli eval "() => { const body = document.body; return { bodyScrollWidth: body.scrollWidth, viewportWidth: window.innerWidth, hasHorizontalScroll: body.scrollWidth > window.innerWidth }; }"
```
If `hasHorizontalScroll` is true at mobile, there's a responsive bug.

### 2. Find the offending element
```bash
playwright-cli eval "() => [...document.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth && el.clientWidth > 0).map(el => ({ tag: el.tagName, class: el.className.substring(0,60), scrollW: el.scrollWidth, clientW: el.clientWidth })).slice(0, 5)"
```

### 3. Navigation state
At mobile widths, navbars typically collapse to hamburger menus. Check if the menu button is visible:
```bash
playwright-cli snapshot    # look for button "Menu" or similar
```

### 4. Images and media
Check if images overflow their containers at narrow viewports.

## GOTCHA: Resize Does Not Trigger `load` Event

Resize only changes the viewport. It does NOT re-navigate. This means:
- CSS media queries respond immediately
- JavaScript `resize` event fires
- But no new network requests (unless lazy-loading triggers)
- Console messages from the original load persist

## Reset to Desktop After Testing

Always restore to a standard viewport when done with responsive testing:
```bash
playwright-cli resize 1280 720
```

## Key Insight for Agent Steering

Tell the agent: "Test at 375, 768, and 1280 minimum. At each breakpoint, screenshot + check for horizontal overflow with eval. The biggest responsive bug is horizontal scroll — detect it with `body.scrollWidth > window.innerWidth`."
