const productName = 'AIOps 运维平台'
const rename = value => value.replace(/DeepSeek Harness/giu, productName).replace(/DeepSeek/giu, 'AIOps')

function replaceCopy(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    const parent = root.parentElement
    if (!parent || /^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/u.test(parent.tagName)) return
    const updated = rename(root.nodeValue || '')
    if (updated !== root.nodeValue) root.nodeValue = updated
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return
  const element = root.nodeType === Node.ELEMENT_NODE ? root : null
  if (element) {
    if (/^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/u.test(element.tagName)) return
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      const value = element.getAttribute(attr)
      if (value && rename(value) !== value) element.setAttribute(attr, rename(value))
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (/^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/u.test(node.tagName)) continue
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        const value = node.getAttribute(attr)
        if (value && rename(value) !== value) node.setAttribute(attr, rename(value))
      }
    } else if (!/^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/u.test(node.parentElement?.tagName || '')) {
      const updated = rename(node.nodeValue || '')
      if (updated !== node.nodeValue) node.nodeValue = updated
    }
  }
}

function setTitle() {
  const title = document.querySelector('title')
  if (!title) return
  const current = title.textContent || ''
  const updated = rename(current)
  if (updated !== current) title.textContent = updated
}

function dismissUnusedKeyPrompt() {
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!dialog.textContent?.includes('添加一个 API Key 开始使用')) continue
    const later = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === '稍后配置')
    later?.click()
  }
}

const pending = new Set()
let frame = 0
function queue(node) {
  pending.add(node)
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    for (const item of pending) replaceCopy(item)
    pending.clear()
    setTitle()
    dismissUnusedKeyPrompt()
  })
}

queue(document.body)
const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    if (mutation.type === 'characterData') queue(mutation.target)
    else for (const node of mutation.addedNodes) queue(node)
  }
})
observer.observe(document.body, { subtree: true, childList: true, characterData: true })
const title = document.querySelector('title')
if (title) observer.observe(title, { childList: true, characterData: true, subtree: true })
