/**
 * shareLink hands a link to the system share sheet where there is one (phones,
 * installed PWAs) and copies it otherwise. 'cancelled' is the user closing the
 * sheet, which is no failure.
 */
export async function shareLink(url: string, title?: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ url, title })
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      /* refused for another reason: copy instead */
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed'
}

// copyText puts text on the clipboard and reports whether it got there. The
// Clipboard API exists only in a secure context, so an instance opened over
// plain http by IP has none; there the old copy command still works from a
// click, through a textarea that is selected for the moment of the copy.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* refused: try the old way */
    }
  }
  // the button keeps the keyboard focus once the textarea is gone
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    back?.focus()
  }
}
