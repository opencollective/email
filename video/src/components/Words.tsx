import React from 'react'
import { interpolate, interpolateColors, useCurrentFrame } from 'remotion'
import { C, SANS, clamp, snap } from '../theme'

type Props = {
  /** Words appear one by one; wrap the punchline in *asterisks* to mark it. */
  text: string
  /** frame the first word lands */
  start?: number
  /** frames between words */
  stagger?: number
  size?: number
  color?: string
  style?: React.CSSProperties
}

/** Number of frames a line takes to fully land, marker included. */
export const wordsDuration = (text: string, stagger = 4) => text.replace(/\*/g, '').split(/\s+/).length * stagger + 22

/** Kinetic headline: each word punches in (big → its size, blurred → sharp,
 *  from below), then a blue marker sweeps behind the punchline and turns it
 *  white. */
export const Words: React.FC<Props> = ({ text, start = 0, stagger = 4, size = 120, color = C.ink, style }) => {
  const frame = useCurrentFrame()
  const segments = text.split('*').map((s, i) => ({ words: s.trim().split(/\s+/).filter(Boolean), accent: i % 2 === 1 }))
  const total = segments.reduce((n, s) => n + s.words.length, 0)
  const markAt = start + total * stagger + 4
  let index = 0

  const word = (w: string, accent: boolean) => {
    const at = start + index++ * stagger
    return (
      <span key={`${w}-${index}`} style={{
        display: 'inline-block',
        marginRight: '0.24em',
        opacity: interpolate(frame, [at, at + 5], [0, 1], clamp),
        translate: interpolate(frame, [at, at + 12], ['0px 0.35em', '0px 0em'], { ...clamp, easing: snap }),
        scale: interpolate(frame, [at, at + 12], [1.45, 1], { ...clamp, easing: snap }),
        filter: `blur(${interpolate(frame, [at, at + 9], [14, 0], clamp)}px)`,
        color: accent ? interpolateColors(frame, [markAt + 2, markAt + 8], [C.blue, '#fff']) : color,
      }}>{w}</span>
    )
  }

  return (
    <div style={{ fontFamily: SANS, fontSize: size, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1.06, color, textWrap: 'balance', ...style }}>
      {segments.map((s, i) => s.accent ? (
        <span key={i} style={{ position: 'relative', display: 'inline-block', marginRight: '0.24em' }}>
          <span style={{
            position: 'absolute', left: '-0.12em', right: '-0.12em', top: '0.06em', bottom: '-0.02em', borderRadius: '0.14em', background: C.blue,
            transformOrigin: 'left center',
            scale: `${interpolate(frame, [markAt, markAt + 10], [0, 1], { ...clamp, easing: snap })} 1`,
          }} />
          <span style={{ position: 'relative', display: 'inline-block', marginRight: '-0.24em' }}>{s.words.map((w) => word(w, true))}</span>
        </span>
      ) : s.words.map((w) => word(w, false)))}
    </div>
  )
}
