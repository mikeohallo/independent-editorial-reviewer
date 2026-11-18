"""Clicks Allow on the reviewer's consent page in a real Chromium, and checks the
browser actually arrives back at claude.ai with a code (the form-action bug that
blocked Drover's and the status site's first sign-ins). Also saves screenshots of
the page at phone and desktop widths.

Run: python3 test/browser/consent_browser.py   (after `npm run test:runtime` built the bundle)
Needs Playwright with Chromium. Serves on 127.0.0.1:8443 and maps the reviewer's host to it; every other host fails to resolve.
"""
import json, os, subprocess, sys, pathlib
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(os.environ.get('SCREENSHOT_DIR', '/tmp/reviewer-consent'))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get('PORT', '8443'))

server = subprocess.Popen(['node', 'test/browser/serve.mjs', str(PORT)], cwd=ROOT, stdout=subprocess.PIPE, text=True)
try:
    info = json.loads(server.stdout.readline())
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[f'--host-resolver-rules=MAP reviewer.mikeohalloran.au 127.0.0.1:{PORT}, MAP * ~NOTFOUND', '--ignore-certificate-errors', '--no-proxy-server'])
        arrived = {}
        for width, height, name in [(390, 844, 'phone'), (1366, 900, 'desktop')]:
            for scheme in ['light', 'dark']:
                ctx = browser.new_context(viewport={'width': width, 'height': height}, color_scheme=scheme, ignore_https_errors=True,
                                          extra_http_headers={'Cf-Access-Jwt-Assertion': info['jwt']})
                page = ctx.new_page()
                errors = []
                page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
                page.goto(info['authorize'])
                assert 'Connect Claude to the editorial reviewer' in page.content(), page.content()[:500]
                scroll_w = page.evaluate('document.documentElement.scrollWidth')
                assert scroll_w <= width, f'horizontal scroll at {width}px: {scroll_w}'
                page.screenshot(path=str(OUT / f'consent-{name}-{scheme}.png'), full_page=True)
                if name == 'phone' and scheme == 'light':
                    # Every other host fails to resolve, so nothing reaches the real claude.ai; the
                    # browser's own request for the callback is what proves Allow wasn't blocked.
                    with page.expect_request(lambda r: r.url.startswith('https://claude.ai/api/mcp/auth_callback'), timeout=10000) as req:
                        page.click('button[value=approve]')
                    arrived['url'] = req.value.url
                    q = parse_qs(urlparse(arrived['url']).query)
                    assert q.get('state') == ['browser-1'], arrived
                    assert q.get('code'), arrived
                    assert not [e for e in errors if 'Content Security Policy' in e], errors
                ctx.close()
        browser.close()
    print('PASS: Allow in a real browser reached claude.ai with a code; screenshots in', OUT)
finally:
    server.terminate()
    server.wait(timeout=10)
