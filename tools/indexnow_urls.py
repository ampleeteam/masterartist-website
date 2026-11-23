"""Turn changed blog files (from `git diff --name-only`, on stdin) into the page URLs to send to IndexNow.

Used by .github/workflows/blog.yml. blog.html and blog/index.html are the blog index at /blog/;
blog/<slug>/index.html and blog/<slug>.html are /blog/<slug>/.
"""
import sys

urls, seen = [], set()
for line in sys.stdin:
    p = line.strip()
    if p in ("blog.html", "blog/index.html"):
        url = "https://masterartist.co/blog/"
    elif p.startswith("blog/") and p.endswith("/index.html"):
        url = "https://masterartist.co/" + p[:-len("index.html")]
    elif p.startswith("blog/") and p.endswith(".html"):
        url = "https://masterartist.co/blog/" + p[len("blog/"):-len(".html")] + "/"
    else:
        continue
    if url not in seen:
        seen.add(url)
        urls.append(url)
print("\n".join(urls))
