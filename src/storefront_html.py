"""Small HTML tree and redirect policy shared by the read-only storefront clients."""
from html.parser import HTMLParser
from urllib.request import HTTPRedirectHandler

VOID = set("area base br col embed hr img input link meta param source track wbr".split())


class Element:
    def __init__(self, tag, attrs):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def text(self, omit_buttons=False):
        if (self.tag in {"script", "style", "template", "noscript"} or "hidden" in self.attrs
                or self.attrs.get("aria-hidden") == "true" or (omit_buttons and self.tag == "button")):
            return ""
        parts = (c if isinstance(c, str) else c.text(omit_buttons) for c in self.children)
        return " ".join(" ".join(parts).split())

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.walk()


class Document(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = Element("", [])
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse_listing(html):
    """Return the root and its descendants in document order for offline parsers."""
    doc = Document()
    doc.feed(html)
    doc.close()
    return list(doc.root.walk())


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
