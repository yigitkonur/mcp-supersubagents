# 16: Complete Testing Workflow — The Ideal Agent Flow

## Phase 0: Setup (run once)

```bash
# Check playwright-cli exists
which playwright-cli || npm install -g @playwright/cli@latest

# Install browser if needed (detect from first `open` failure)
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true npx playwright install chromium

# Configure session
playwright-cli session-stop 2>/dev/null
playwright-cli config --browser=chromium
```

## Phase 1: Initial Reconnaissance

```bash
# Open the page
playwright-cli open https://target-url.com

# Immediate health check
playwright-cli console error                    # JS errors?
playwright-cli network                          # 4xx/5xx requests?
playwright-cli screenshot --filename=initial-desktop.png
```

Read the console and network log files. Document any issues found.

## Phase 2: Desktop Review

```bash
playwright-cli resize 1280 720
playwright-cli snapshot                          # understand page structure

# Screenshot the viewport
playwright-cli screenshot --filename=desktop-fold-1.png

# Scroll through the page
playwright-cli mousewheel 0 700
playwright-cli screenshot --filename=desktop-fold-2.png
playwright-cli mousewheel 0 700
playwright-cli screenshot --filename=desktop-fold-3.png

# Check for overflow
playwright-cli eval "() => ({ hasHScroll: document.body.scrollWidth > window.innerWidth })"

# Inspect key elements
playwright-cli eval "() => { const h1 = document.querySelector('h1'); const s = getComputedStyle(h1); return { text: h1.textContent, fontSize: s.fontSize, color: s.color }; }"
```

## Phase 3: Responsive Testing

```bash
# Mobile
playwright-cli resize 375 667
playwright-cli screenshot --filename=mobile-375.png
playwright-cli eval "() => ({ hasHScroll: document.body.scrollWidth > window.innerWidth, scrollW: document.body.scrollWidth })"

# Tablet
playwright-cli resize 768 1024
playwright-cli screenshot --filename=tablet-768.png
playwright-cli eval "() => ({ hasHScroll: document.body.scrollWidth > window.innerWidth })"

# Reset
playwright-cli resize 1280 720
```

## Phase 4: Subpage Navigation

```bash
# Navigate to key subpages (from links found in snapshot)
playwright-cli open https://target-url.com/about
playwright-cli console error
playwright-cli screenshot --filename=about-desktop.png

playwright-cli open https://target-url.com/contact
playwright-cli console error
playwright-cli screenshot --filename=contact-desktop.png
```

## Phase 5: Interaction Testing (if forms/CTAs)

```bash
playwright-cli open https://target-url.com/contact
playwright-cli snapshot                    # find form refs
playwright-cli fill e5 "test@example.com"
playwright-cli fill e6 "Test message"
playwright-cli click e7                    # submit
playwright-cli snapshot                    # check result
playwright-cli screenshot --filename=form-submitted.png
```

## Phase 6: Cleanup

```bash
playwright-cli session-stop-all
```

## Evidence File Structure

```
.playwright-cli/
├── initial-desktop.png
├── desktop-fold-1.png
├── desktop-fold-2.png
├── desktop-fold-3.png
├── mobile-375.png
├── tablet-768.png
├── about-desktop.png
├── contact-desktop.png
└── form-submitted.png
```

## Key Insight for Agent Steering

This workflow is the backbone of the super-tester prompt. The agent should follow this exact sequence: setup → recon → desktop → responsive → subpages → interactions → cleanup. Each phase produces evidence files.
