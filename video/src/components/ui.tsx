import React from 'react'
import { AbsoluteFill, CanvasImage, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { Audio } from '@remotion/media'
import { C, MONO, clamp, glide, settle, snap } from '../theme'
import { Words, wordsDuration } from './Words'

export type Rect = [number, number, number, number] // x, y, w, h as fractions of the image
export type Key = { f: number; r: Rect }

/** Frame-driven camera over a screenshot: interpolates a focus rectangle
 *  between keyframes and fits it to the viewport. Children are positioned in
 *  the image's natural pixels, so overlays move with the zoom. */
export const Camera: React.FC<{ src: string; iw: number; ih: number; w: number; h: number; keys: Key[]; children?: React.ReactNode }> =
  ({ src, iw, ih, w, h, keys, children }) => {
    const frame = useCurrentFrame()
    const { fps } = useVideoConfig()
    const fs = keys.map((k) => k.f)
    const r = [0, 1, 2, 3].map((i) => keys.length === 1 ? keys[0].r[i]
      : interpolate(frame, fs, keys.map((k) => k.r[i]), { ...clamp, easing: glide })) as Rect
    const s = Math.min(w / (r[2] * iw), h / (r[3] * ih))
    return (
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: C.bg }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, width: iw, height: ih, transformOrigin: '0 0',
          translate: `${w / 2 - (r[0] + r[2] / 2) * iw * s}px ${h / 2 - (r[1] + r[3] / 2) * ih * s}px`,
          scale: s,
        }}>
          <CanvasImage src={staticFile(src)} width={iw} height={ih} premountFor={fps} style={{ width: iw, height: ih, display: 'block' }} />
          {children}
        </div>
      </div>
    )
  }

export const VIEW_W = 1312
export const VIEW_H = 780
/** Screenshots are 2× captures of a 1440-wide browser. */
export const DESK = { iw: 2880, ih: 1800 }
export const THREAD = { iw: 2880, ih: 4600 }
export const FULL: Rect = [0, 0, 1, 0.951]

/** A desktop browser window. */
export const Browser: React.FC<{ url: string; children: React.ReactNode; top?: number }> = ({ url, children, top = 222 }) => (
  <div style={{
    position: 'absolute', left: (1920 - VIEW_W) / 2, top, width: VIEW_W, height: VIEW_H + 40, borderRadius: 18, overflow: 'hidden',
    background: '#fff', boxShadow: '0 40px 100px rgba(20,20,20,.18), 0 4px 14px rgba(20,20,20,.08)', border: `1px solid ${C.line}`,
  }}>
    <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: `1px solid ${C.line}`, background: '#fbfbf9' }}>
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />)}
      <div style={{ margin: '0 auto', fontFamily: MONO, fontSize: 15, color: C.muted, background: '#efefeb', borderRadius: 8, padding: '4px 60px' }}>{url}</div>
    </div>
    <div style={{ position: 'absolute', top: 40, left: 0, right: 0, bottom: 0 }}>{children}</div>
  </div>
)

/** Two cameras, cross-dissolving at `at`. */
export const Swap: React.FC<{ at: number; a: React.ReactNode; b: React.ReactNode }> = ({ at, a, b }) => {
  const frame = useCurrentFrame()
  return (
    <>
      <div style={{ position: 'absolute', inset: 0 }}>{a}</div>
      <div style={{ position: 'absolute', inset: 0, opacity: interpolate(frame, [at, at + 12], [0, 1], clamp) }}>{b}</div>
    </>
  )
}

/** Pulsing ring around a region, in image pixels. */
export const Ring: React.FC<{ x: number; y: number; w: number; h: number; from: number; radius?: number }> = ({ x, y, w, h, from, radius = 16 }) => {
  const frame = useCurrentFrame()
  return (
    <div style={{
      position: 'absolute', left: x - 10, top: y - 10, width: w + 20, height: h + 20, borderRadius: radius, border: `6px solid ${C.blue}`,
      boxShadow: '0 0 0 12px rgba(26,107,240,.16)',
      opacity: interpolate(frame, [from, from + 6], [0, 1], clamp),
      scale: interpolate(frame, [from, from + 14], [1.08, 1], { ...clamp, easing: snap }) + 0.012 * Math.sin(Math.max(0, frame - from - 14) / 5),
    }} />
  )
}

/** iPhone frame around a full-screen capture (1170×2532). */
export const PHONE_W = 418
export const PHONE_H = PHONE_W * 2532 / 1170
export const Phone: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{
    position: 'absolute', width: PHONE_W + 28, height: PHONE_H + 28, borderRadius: 72, background: '#111', padding: 14,
    boxShadow: '0 50px 110px rgba(20,20,20,.3), inset 0 0 0 2px #333', ...style,
  }}>
    <div style={{ position: 'relative', width: PHONE_W, height: PHONE_H, borderRadius: 58, overflow: 'hidden', background: '#fff' }}>
      {children}
      <div style={{ position: 'absolute', top: 11, left: '50%', marginLeft: -62, width: 124, height: 36, borderRadius: 20, background: '#000' }} />
    </div>
  </div>
)

export const Logo: React.FC<{ size: number; color?: string }> = ({ size, color = C.ink }) => (
  <div style={{ fontFamily: MONO, fontSize: size, fontWeight: 500, color, letterSpacing: '-0.02em' }}>
    collective<span style={{ color: C.blue }}>.email</span>
  </div>
)

/** A slow-drifting blue glow, so light scenes have depth. */
export const Glow: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', width: 1500, height: 1500, borderRadius: 750, left: 900, top: -500,
        background: 'radial-gradient(circle, rgba(26,107,240,.13), rgba(26,107,240,0) 62%)',
        translate: `${-frame * 1.4}px ${frame * 0.8}px`,
      }} />
      <div style={{
        position: 'absolute', width: 1200, height: 1200, borderRadius: 600, left: -500, top: 300,
        background: 'radial-gradient(circle, rgba(26,107,240,.07), rgba(26,107,240,0) 62%)',
        translate: `${frame * 1.1}px ${-frame * 0.5}px`,
      }} />
    </AbsoluteFill>
  )
}

export const Sfx: React.FC<{ name: 'whoosh' | 'mouse-click' | 'ding' | 'switch'; from?: number; volume?: number }> = ({ name, from = 0, volume = 0.5 }) => {
  const { fps } = useVideoConfig()
  return <Audio src={staticFile(`sfx/${name}.wav`)} from={from} premountFor={fps} volume={volume} />
}

/**
 * A feature scene: the title lands word by word, big and centred; then it
 * shrinks to the top (or to the left column) as the product rises in.
 */
export const Feature: React.FC<{
  title: string
  layout?: 'top' | 'left'
  children: React.ReactNode
}> = ({ title, layout = 'top', children }) => {
  const frame = useCurrentFrame()
  const at = wordsDuration(title) + 8 // the title has landed and been read
  const move = { ...clamp, easing: snap }
  // long titles wrap to three lines: shrink them further so they clear the window
  const long = title.split(/\s+/).length > 8
  const to = layout === 'top' ? { x: 0, y: long ? -420 : -415, s: long ? 0.42 : 0.5 } : { x: -400, y: -90, s: 0.6 }
  return (
    <AbsoluteFill>
      <Glow />
      <Sfx name="whoosh" volume={0.35} />
      <AbsoluteFill style={{
        alignItems: 'center', justifyContent: 'center',
        translate: interpolate(frame, [at, at + 22], ['0px 0px', `${to.x}px ${to.y}px`], move),
      }}>
        <div style={{ maxWidth: layout === 'top' ? 1800 : 1560, textAlign: 'center', scale: interpolate(frame, [at, at + 22], [1, to.s], move) }}>
          <Words text={title} start={2} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{
        translate: interpolate(frame, [at + 2, at + 30], ['0px 1000px', '0px 0px'], { ...clamp, easing: settle }),
        rotate: interpolate(frame, [at + 2, at + 30], ['3deg', '0deg'], { ...clamp, easing: settle }),
      }}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

/** When the product appears in a Feature scene (for timing inside it). */
export const featureUiAt = (title: string) => wordsDuration(title) + 8 + 20
