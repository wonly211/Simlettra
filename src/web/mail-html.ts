import DOMPurify from 'dompurify'

const FORBIDDEN_TAGS = [
  'audio',
  'base',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'input',
  'link',
  'meta',
  'object',
  'script',
  'select',
  'source',
  'style',
  'textarea',
  'video',
]

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function createSafeEmailDocument(html: string, allowRemoteImages: boolean): string {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['formaction', 'ping', 'srcdoc', 'srcset', 'style'],
  })
  const document = new DOMParser().parseFromString(sanitized, 'text/html')

  for (const anchor of document.querySelectorAll('a')) {
    const href = anchor.getAttribute('href')
    if (!href || !hasSafeLinkProtocol(href)) {
      anchor.removeAttribute('href')
      anchor.removeAttribute('target')
      continue
    }
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer')
  }

  for (const image of document.querySelectorAll('img')) {
    const source = image.getAttribute('src')?.trim() ?? ''
    if (!isAllowedImageSource(source, allowRemoteImages)) image.removeAttribute('src')
    image.removeAttribute('srcset')
    image.setAttribute('loading', 'lazy')
    image.setAttribute('referrerpolicy', 'no-referrer')
  }

  const imagePolicy = allowRemoteImages ? 'img-src data: https:' : 'img-src data:'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${imagePolicy}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
<style>
:root { color-scheme: light; }
body { margin: 0; padding: 18px; color: #202624; background: #ffffff; font: 15px/1.65 system-ui, sans-serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; border-collapse: collapse; }
pre { white-space: pre-wrap; }
blockquote { margin-inline: 0; padding-inline-start: 14px; border-inline-start: 3px solid #c8d2ce; }
a { color: #0c6654; }
</style>
</head>
<body>${document.body.innerHTML}</body>
</html>`
}

export function sanitizeDraftHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a',
      'b',
      'blockquote',
      'br',
      'div',
      'em',
      'h1',
      'h2',
      'h3',
      'i',
      'li',
      'ol',
      'p',
      'pre',
      'span',
      'strong',
      'u',
      'ul',
    ],
    ALLOWED_ATTR: ['href'],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ['style'],
  })
}

function hasSafeLinkProtocol(value: string): boolean {
  if (!/^(?:https?:\/\/|mailto:)/iu.test(value)) return false
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

function isAllowedImageSource(value: string, allowRemoteImages: boolean): boolean {
  if (value.startsWith('data:image/')) return true
  if (!allowRemoteImages) return false
  if (!/^https:\/\//iu.test(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
