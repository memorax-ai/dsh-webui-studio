function escapesRoot(selector: string): boolean {
  const suffix = selector.slice(1)
  let bracketDepth = 0
  let parenthesisDepth = 0
  let quote = ''
  for (let index = 0; index < suffix.length; index += 1) {
    const character = suffix[index]!
    if (quote !== '') {
      if (character === quote && suffix[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '[') { bracketDepth += 1; continue }
    if (character === ']') { bracketDepth -= 1; continue }
    if (character === '(') { parenthesisDepth += 1; continue }
    if (character === ')') { parenthesisDepth -= 1; continue }
    if (bracketDepth !== 0 || parenthesisDepth !== 0) continue
    if (character === '+' || character === '~') return true
    if (character === '>') return false
    if (/\s/.test(character)) {
      while (/\s/.test(suffix[index + 1] ?? '')) index += 1
      return suffix[index + 1] === '+' || suffix[index + 1] === '~'
    }
  }
  return false
}

export function compileElementStyleSelector(selector: string, scope: string): string {
  if (!selector.startsWith('&') || selector.indexOf('&', 1) !== -1 || /[{},;]/.test(selector)
    || escapesRoot(selector)) {
    throw new Error('Element CSS selectors must contain one leading & and stay within its subtree')
  }
  return scope + selector.slice(1)
}
