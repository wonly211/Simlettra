import { readFile } from 'node:fs/promises'
import { parse } from 'vue/compiler-sfc'

const SOURCE_FILE = 'src/web/SimlettraApp.vue'
const source = await readFile(SOURCE_FILE, 'utf8')
const parsed = parse(source, { filename: SOURCE_FILE })

if (parsed.errors.length > 0) {
  throw new Error(`Vue 模板解析失败：${parsed.errors.map(String).join('；')}`)
}

const template = parsed.descriptor.template
if (!template?.ast) throw new Error('Vue 文件缺少可检查的模板')

const elements = []
collectElements(template.ast, [], elements)

const staticIds = new Set(
  elements.map(({ node }) => staticAttribute(node, 'id')).filter((value) => value !== null),
)
const labelTargets = new Set(
  elements
    .filter(({ node }) => node.tag === 'label')
    .map(({ node }) => staticAttribute(node, 'for'))
    .filter((value) => value !== null),
)
const failures = []

for (const { node, ancestors } of elements) {
  const location = `${SOURCE_FILE}:${template.loc.start.line + node.loc.start.line - 1}`

  if (node.tag === 'button') {
    if (!hasProperty(node, 'type')) failures.push(`${location} 按钮缺少 type`)
    if (!hasAccessibleName(node)) failures.push(`${location} 按钮缺少可访问名称`)
  }

  if (node.tag === 'a') {
    if (!hasAccessibleName(node)) failures.push(`${location} 链接缺少可访问名称`)
    if (staticAttribute(node, 'target') === '_blank' && !staticAttribute(node, 'rel')) {
      failures.push(`${location} 新窗口链接缺少 rel`)
    }
  }

  if (['input', 'select', 'textarea'].includes(node.tag)) {
    const hiddenInput = node.tag === 'input' && staticAttribute(node, 'type') === 'hidden'
    if (!hiddenInput && !hasFormControlName(node, ancestors, labelTargets)) {
      failures.push(`${location} 表单控件缺少 label、aria-label 或 aria-labelledby`)
    }
  }

  if (!isNativeInteractiveElement(node) && hasClickHandler(node)) {
    failures.push(`${location} 非原生交互元素使用点击事件`)
  }

  const tabindex = staticAttribute(node, 'tabindex')
  if (tabindex !== null && Number(tabindex) > 0) {
    failures.push(`${location} 使用了正数 tabindex=${tabindex}`)
  }

  const labelledBy = staticAttribute(node, 'aria-labelledby')
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/u)) {
      if (!staticIds.has(id)) failures.push(`${location} aria-labelledby 引用了不存在的 ${id}`)
    }
  }
}

if (failures.length > 0) {
  throw new Error(`网页控件可访问性自检失败：\n${failures.join('\n')}`)
}

const controlCount = elements.filter(({ node }) =>
  ['button', 'a', 'input', 'select', 'textarea'].includes(node.tag),
).length

console.log(
  `网页控件可访问性自检通过：检查 ${elements.length} 个模板元素、${controlCount} 个原生交互控件。`,
)

function collectElements(node, ancestors, result) {
  if (node?.type === 1) {
    result.push({ node, ancestors })
    for (const child of node.children ?? []) {
      collectElements(child, [...ancestors, node], result)
    }
    return
  }

  if (!Array.isArray(node?.children)) return
  for (const child of node.children) collectElements(child, ancestors, result)
}

function staticAttribute(node, name) {
  const property = node.props.find((item) => item.type === 6 && item.name === name)
  return property?.value?.content ?? null
}

function hasProperty(node, name) {
  return node.props.some(
    (item) =>
      (item.type === 6 && item.name === name) ||
      (item.type === 7 && item.arg?.type === 4 && item.arg.content === name),
  )
}

function hasNonEmptyProperty(node, name) {
  return node.props.some((item) => {
    if (item.type === 6 && item.name === name) return Boolean(item.value?.content.trim())
    return item.type === 7 && item.arg?.type === 4 && item.arg.content === name
  })
}

function hasAccessibleName(node) {
  return (
    hasNonEmptyProperty(node, 'aria-label') ||
    hasNonEmptyProperty(node, 'aria-labelledby') ||
    hasNamedDescendant(node) ||
    Boolean(staticAttribute(node, 'value'))
  )
}

function hasNamedDescendant(node) {
  const pending = [...(node.children ?? [])]
  while (pending.length > 0) {
    const child = pending.shift()
    if (child.type === 2 && child.content.trim()) return true
    if (child.type === 5) return true
    if (child.type === 1) pending.push(...(child.children ?? []))
  }
  return false
}

function hasFormControlName(node, ancestors, labelTargets) {
  if (ancestors.some((ancestor) => ancestor.tag === 'label')) return true
  if (hasNonEmptyProperty(node, 'aria-label') || hasNonEmptyProperty(node, 'aria-labelledby')) {
    return true
  }
  const id = staticAttribute(node, 'id')
  return id !== null && labelTargets.has(id)
}

function isNativeInteractiveElement(node) {
  return ['button', 'a', 'input', 'select', 'textarea', 'form'].includes(node.tag)
}

function hasClickHandler(node) {
  return node.props.some(
    (item) =>
      item.type === 7 && item.name === 'on' && item.arg?.type === 4 && item.arg.content === 'click',
  )
}
