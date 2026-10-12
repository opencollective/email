import { loadFont } from '@remotion/fonts'
import { Easing, staticFile } from 'remotion'

// Loaded once, from public/fonts; loadFont holds the render until they're ready,
// so no frame is ever captured in a fallback font. Every scene imports this
// module, so each one also previews correctly on its own.
for (const w of ['400', '500', '600', '700', '800']) {
  loadFont({ family: 'Inter', url: staticFile(`fonts/inter-latin-${w}-normal.woff2`), weight: w })
}
for (const w of ['400', '500']) {
  loadFont({ family: 'JetBrains Mono', url: staticFile(`fonts/jetbrains-mono-latin-${w}-normal.woff2`), weight: w })
}

export const C = {
  bg: '#f6f6f3',
  ink: '#111316',
  night: '#0d0f13',
  muted: '#6b7280',
  blue: '#1a6bf0',
  line: '#e4e4df',
}
export const SANS = 'Inter, sans-serif'
export const MONO = '"JetBrains Mono", monospace'

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
/** Camera moves: slow in, slow out. */
export const glide = Easing.bezier(0.65, 0, 0.35, 1)
/** Things arriving: fast, then settle. */
export const snap = Easing.bezier(0.16, 1, 0.3, 1)
export const settle = Easing.spring({ damping: 200 })
export const bounce = Easing.spring({ damping: 12 })
