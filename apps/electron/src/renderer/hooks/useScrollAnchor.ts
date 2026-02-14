/**
 * useScrollAnchor
 *
 * Shared hook for scroll-to-bottom anchoring in scrollable message/activity
 * feeds. Tracks scroll direction so that layout shifts from new content
 * don't falsely re-anchor the viewport when the user has scrolled up.
 *
 * Fixes REQ-001: Scroll snapping back to bottom in agent team views.
 */

import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react'

interface UseScrollAnchorOptions {
  /** Dependency that triggers auto-scroll check (e.g. items.length) */
  contentLength: number
  /** Reset anchor on this key change (e.g. teammate switch, filter change) */
  resetKey?: string
  /** Distance-from-bottom threshold in px (default: 150) */
  threshold?: number
}

interface UseScrollAnchorResult {
  viewportRef: React.RefObject<HTMLDivElement>
  endRef: React.RefObject<HTMLDivElement>
  /** True when user has explicitly scrolled away from the bottom */
  isScrolledUp: boolean
  /** Programmatically scroll to the bottom and re-anchor */
  scrollToBottom: () => void
}

export function useScrollAnchor({
  contentLength,
  resetKey,
  threshold = 150,
}: UseScrollAnchorOptions): UseScrollAnchorResult {
  const viewportRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // Internal refs — avoid re-renders on every scroll event
  const isAtBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const userScrolledUpRef = useRef(false)
  const skipAutoScrollUntilRef = useRef(0)

  // Exposed state for UI (e.g. "jump to bottom" indicator)
  const [isScrolledUp, setIsScrolledUp] = useState(false)

  // Stable callback for imperative scroll-to-bottom
  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    userScrolledUpRef.current = false
    isAtBottomRef.current = true
    setIsScrolledUp(false)
  }, [])

  // ── Reset on key change (teammate switch, filter change) ──────────
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'end' })
    isAtBottomRef.current = true
    userScrolledUpRef.current = false
    lastScrollTopRef.current = 0
    setIsScrolledUp(false)
    skipAutoScrollUntilRef.current = Date.now() + 500
  }, [resetKey])

  // ── Track scroll direction + position ─────────────────────────────
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const scrollingDown = scrollTop > lastScrollTopRef.current
      lastScrollTopRef.current = scrollTop

      // User explicitly scrolled UP past the threshold — mark as "scrolled away"
      if (!scrollingDown && distanceFromBottom > threshold) {
        if (!userScrolledUpRef.current) {
          userScrolledUpRef.current = true
          setIsScrolledUp(true)
        }
      }

      // User scrolled DOWN back to near the bottom — re-anchor
      if (scrollingDown && distanceFromBottom < threshold) {
        if (userScrolledUpRef.current) {
          userScrolledUpRef.current = false
          setIsScrolledUp(false)
        }
      }

      isAtBottomRef.current = distanceFromBottom < threshold
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [threshold])

  // ── Auto-scroll on new content (only when anchored) ───────────────
  useEffect(() => {
    // Don't auto-scroll if user has intentionally scrolled up
    if (userScrolledUpRef.current) return
    // Don't auto-scroll if not near the bottom
    if (!isAtBottomRef.current) return
    // Grace period after reset to avoid fighting the layout-effect scroll
    if (Date.now() < skipAutoScrollUntilRef.current) return

    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [contentLength])

  return { viewportRef, endRef, isScrolledUp, scrollToBottom }
}
